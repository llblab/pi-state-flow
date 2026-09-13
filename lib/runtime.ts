import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { parseScopeProvenance, parseScopeStream, sessionRuntimePaths, temporalScopePaths, type SessionAddress } from "./durable.ts";
import { parseArtifactProvenanceRegistry, pruneArtifactProvenance, type ArtifactProvenance, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { adoptFileStateToGit, initializeGitRepository, isLocalGitRepository, captureTemporalGitBase, loadLegacyStatesAtRevision, loadTemporalRevision, migrateHashedCwdAtHead, migrateHashedLayoutAtHead, migrateLegacyStorageToGit, publishTemporalStateToGit, type TemporalGitBase } from "./git.ts";
import { captureTemporalFileBase, detectGitCapability, initializeFileStore, loadTemporalFileRevision, migrateLegacyStorageToFiles, publishTemporalStateToFiles, type TemporalFileBase } from "./storage.ts";
import { type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { hashJson, sameJson } from "./json.ts";
import { hasCwdMaterialization, hasLegacyStateSources } from "./migration.ts";
import { RevisionUnavailableError, createSessionRuntime, isFileRevision, parseSessionRuntime, resolveFileSessionRuntime, resolveSessionRuntime, type Snapshot } from "./snapshot.ts";
import { emptyState, type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";
import { adoptTemporalStreams, advanceTemporalState, createTemporalState, readTemporalState, validateTemporalState, type ScopeStream, type TemporalState } from "./temporal.ts";

const SCOPES = ["global", "cwd", "session"] as const;
const SHARED_SCOPES = ["global", "cwd"] as const;
export type RuntimePublication = ReturnType<typeof publishTemporalStateToGit> & { revision?: string };

interface SessionCopy {
	stream: ScopeStream;
	provenance: ArtifactProvenanceRegistry;
	backend: "git" | "files";
}

function emptyProvenance(): Record<StateScope, ArtifactProvenanceRegistry> {
	return { global: {}, cwd: {}, session: {} };
}

function scopeLabel(scope: StateScope): string {
	return scope === "cwd" ? "CWD" : scope;
}

/** Precise fail-closed conflict for a shared scope this transition actually overwrites. */
function targetScopeConflict(scopes: readonly StateScope[]): Error {
	const labels = scopes.map(scopeLabel);
	if (labels.length === 1) {
		return new Error(`State Flow cannot publish the ${labels[0]} patch because the live ${labels[0]} state advanced after this transition's selected basis. Refresh or reconcile the target scope before retrying.`);
	}
	return new Error(`State Flow cannot publish the ${labels.join(" and ")} patches because the live ${labels.join(" and ")} states advanced after this transition's selected basis. Refresh or reconcile the target scopes before retrying.`);
}

export class MissingSessionRuntimeError extends Error {
	constructor() { super("Linked State Flow revision has no session runtime"); }
}

/** Immutable target validation is independent of acquiring the live publication basis. */
export function inspectRuntimeRevision(cwd: string, sessionId: string, root: string, revision: string, sessionKey = sessionId) {
	const loaded = loadTemporalRevision(cwd, sessionId, root, revision, sessionKey);
	if (!loaded.runtime) throw new MissingSessionRuntimeError();
	const resolved = resolveSessionRuntime(loaded.runtime.document, loaded.runtime.revision);
	if (!loaded.scopes.global || !loaded.scopes.cwd || !loaded.scopes.session) throw new Error("Incomplete temporal scope cohort");
	const view = { lineage: resolved.lineage, scopes: { global: loaded.scopes.global, cwd: loaded.scopes.cwd, session: loaded.scopes.session } };
	validateTemporalState(view);
	return { runtime: loaded.runtime, resolved, view, provenance: loaded.provenance, ...(loaded.legacyLayout ? { legacyLayout: true as const } : {}) };
}

/** Both checkpoint generations validate their immutable target before any live migration/publication. */
export function inspectSnapshotRevision(cwd: string, sessionId: string, root: string, revision: string, legacySnapshot?: Snapshot, sessionKey = sessionId) {
	if (isFileRevision(revision)) {
		const file = loadTemporalFileRevision(cwd, sessionId, root, revision, sessionKey);
		return { snapshot: resolveFileSessionRuntime(file.runtime, revision), file };
	}
	if (detectGitCapability() === "files") throw new RevisionUnavailableError("Git is unavailable; cannot restore a Git-linked revision");
	try {
		const temporal = inspectRuntimeRevision(cwd, sessionId, root, revision, sessionKey);
		return { snapshot: temporal.resolved.snapshot, temporal };
	} catch (error) {
		if (!legacySnapshot || !(error instanceof Error) || !error.message.includes("Historical legacy storage requires explicit migration")) throw error;
		const historical = loadLegacyStatesAtRevision(cwd, sessionId, root, revision, sessionKey);
		const snapshot = structuredClone(legacySnapshot);
		if (historical.session !== undefined) snapshot.legacySession = { state: historical.session };
		return { snapshot, shared: { global: historical.global ?? emptyState(), cwd: historical.cwd ?? emptyState() } };
	}
}

/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export class TemporalRuntime {
	view: TemporalState | undefined;
	private base: TemporalGitBase | undefined;
	private semanticRevision: string | undefined;
	private savedRuntime: string | undefined;
	private backend: "git" | "files" | undefined;
	private provenanceByScope: Record<StateScope, ArtifactProvenanceRegistry> = emptyProvenance();
	readonly cwd: string;
	private readonly session: SessionAddress;
	readonly root: string;
	constructor(cwd: string, session: string | SessionAddress, root: string, sessionKey?: string) {
		this.cwd = cwd;
		this.session = Object.freeze(typeof session === "string" ? { id: session, key: sessionKey ?? session } : { ...session });
		this.root = root;
	}

	get sessionId(): string { return this.session.id; }
	get sessionKey(): string { return this.session.key; }

	/** Runtime-owned artifact freshness evidence for one scope; never model-visible state. */
	artifactProvenance(scope: StateScope): ArtifactProvenanceRegistry {
		return structuredClone(this.provenanceByScope[scope]);
	}

	/** Explicit start owns directory/repository creation; reads never call this. */
	prepare(): void {
		const backend = detectGitCapability();
		if (backend === "git") initializeGitRepository(this.root);
		else initializeFileStore(this.root);
		this.backend = backend;
	}

	/** Explicit start can upgrade a proven file cohort; failed adoption leaves the cache in file mode. */
	promote(snapshot: Snapshot): RuntimePublication | undefined {
		if (this.backend !== "files" || !this.view || detectGitCapability() === "files") return undefined;
		if (!snapshot.meta.durableBase || snapshot.meta.durableBase !== this.semanticRevision) throw new Error("Git adoption requires the selected file revision");
		const pushRemote = (snapshot.meta.remotePublication?.mode ?? "transition") === "transition";
		const result = adoptFileStateToGit(this.cwd, this.sessionId, this.root, snapshot.meta.durableBase, snapshot, this.sessionKey, pushRemote);
		this.provenanceByScope = structuredClone(result.provenance);
		const savedRuntime = hashJson(createSessionRuntime(snapshot, this.cwd, this.sessionId, result.view.lineage, "unconfirmed", this.provenanceByScope.session));
		this.view = result.view;
		this.base = result.base;
		this.backend = "git";
		this.semanticRevision = result.revision;
		this.savedRuntime = savedRuntime;
		return result;
	}

	read(offset = 0, scope?: StateScope): MaterializedState {
		if (!this.view) throw new Error("State Flow temporal runtime is unavailable");
		return readTemporalState(this.view, offset, scope);
	}

	states(): ScopedStates {
		return { global: this.read(0, "global"), cwd: this.read(0, "cwd"), session: this.read(0, "session") };
	}

	causalBasis(): string {
		if (!this.view) throw new Error("State Flow temporal runtime is unavailable");
		return this.view.lineage.at(-1)!.id;
	}

	recent(): RecentTransitionWindow {
		const result: RecentTransitionWindow = [];
		for (const boundary of this.view?.lineage.slice(1) ?? []) {
			const transitions = SCOPES.flatMap((scope) => {
				const record = this.view!.scopes[scope].patches.find(({ transition }) => transition.id === boundary.id);
				return record ? [{ scope, patch: structuredClone(record.patch) }] : [];
			});
			if (transitions.length) result.push({ id: boundary.id, at: boundary.position, transitions });
		}
		return result;
	}

	/** Validate selection without installing state; only a matching immutable Git inspection is reusable. */
	prepareRestore(revision: string, legacySnapshot?: Snapshot): { snapshot: Snapshot; restore: () => Snapshot } {
		const inspected = inspectSnapshotRevision(this.cwd, this.sessionId, this.root, revision, legacySnapshot, this.sessionKey);
		const selected = inspected.snapshot.meta.durableBase ?? revision;
		let consumed = false;
		return {
			snapshot: structuredClone(inspected.snapshot),
			restore: () => {
				if (consumed) throw new Error("Prepared State Flow restore was already consumed");
				consumed = true;
				// File cohorts can expire; legacy migration and owner redirection keep their fresh-read path.
				return inspected.temporal && selected === revision
					? this.restoreInspected(revision, inspected)
					: this.restore(selected, inspected.snapshot);
			},
		};
	}

	/** Copy only a proven source session stream; shared streams come from the child's fresh live basis. */
	prepareFork(source: SessionAddress, revision: string): { snapshot: Snapshot; fork: () => { snapshot: Snapshot; publication: RuntimePublication } } {
		const parent = Object.freeze({ ...source });
		if (parent.id === this.sessionId || parent.key === this.sessionKey) throw new Error("State Flow fork requires a distinct session identity and key");
		const inspect = () => inspectSnapshotRevision(this.cwd, parent.id, this.root, revision, undefined, parent.key);
		const inspected = inspect();
		const snapshot: Snapshot = {
			config: structuredClone(inspected.snapshot.config),
			meta: {
				step: 0,
				...(inspected.snapshot.meta.bootstrap === undefined ? {} : { bootstrap: inspected.snapshot.meta.bootstrap }),
				...(inspected.snapshot.meta.remotePublication === undefined ? {} : { remotePublication: structuredClone(inspected.snapshot.meta.remotePublication) }),
			},
		};
		let consumed = false;
		return {
			snapshot: { ...structuredClone(snapshot), meta: { ...structuredClone(snapshot.meta), durableBase: revision } },
			fork: () => {
				if (consumed) throw new Error("Prepared State Flow fork was already consumed");
				consumed = true;
				if (this.view) throw new Error("State Flow fork target already has session storage");
				// Unlike immutable Git input, a file-only source must still match its complete cohort.
				const current = inspected.file ? inspect() : inspected;
				const selected = current.temporal ?? current.file;
				if (!selected) throw new Error("State Flow fork requires a temporal session stream");
				const publication = this.initializeOrigin(snapshot, { allowCreateCwd: false, copy: {
					stream: selected.view.scopes.session,
					provenance: selected.provenance.session,
					backend: current.file ? "files" : "git",
				} });
				const ownedRevision = publication?.revision ?? publication?.commit;
				if (!publication || !ownedRevision) throw new Error("State Flow fork requires existing shared scope storage");
				return { snapshot: { ...structuredClone(snapshot), meta: { ...structuredClone(snapshot.meta), durableBase: ownedRevision } }, publication };
			},
		};
	}

	restore(revision: string, legacySnapshot?: Snapshot): Snapshot {
		return this.restoreInspected(revision, inspectSnapshotRevision(this.cwd, this.sessionId, this.root, revision, legacySnapshot, this.sessionKey));
	}

	private restoreInspected(revision: string, inspected: ReturnType<typeof inspectSnapshotRevision>): Snapshot {
		if (inspected.file) {
			const savedRuntime = hashJson(createSessionRuntime(inspected.snapshot, this.cwd, this.sessionId, inspected.file.view.lineage, "files", inspected.file.provenance.session));
			this.view = inspected.file.view;
			this.base = inspected.file.base;
			this.backend = "files";
			this.provenanceByScope = structuredClone(inspected.file.provenance);
			this.semanticRevision = revision;
			this.savedRuntime = savedRuntime;
			return inspected.snapshot;
		}
		if (!inspected.temporal) {
			const migrated = inspected.snapshot;
			const publication = this.initialize(migrated, true, inspected.shared);
			if (publication?.commit) migrated.meta.durableBase = publication.commit;
			if (publication?.push?.status === "pending") migrated.meta.pendingPublication = { commit: publication.push.commit, error: publication.push.error ?? "Unconfirmed publication" };
			else delete migrated.meta.pendingPublication;
			delete migrated.legacySession;
			return migrated;
		}
		const loaded = inspected.temporal;
		const { resolved, view } = loaded;
		let base = captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey);
		const reference = loaded.runtime.document.meta.temporalRevision;
		let semanticRevision = reference === undefined || reference === "self" ? loaded.runtime.revision : reference;
		let publicationTarget = resolved.publicationTarget;
		let migrationPush;
		if (loaded.legacyLayout && base.head) {
			const liveRevision = base.head;
			const migration = migrateHashedLayoutAtHead(this.cwd, this.sessionId, this.root, liveRevision, this.sessionKey);
			if (migration?.commit) {
				base = migration.base;
				if (liveRevision === revision) {
					semanticRevision = migration.commit;
					publicationTarget = migration.commit;
					migrationPush = migration.push;
				}
			} else {
				migrateHashedCwdAtHead(this.cwd, this.root);
				base = captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey);
			}
		}
		resolved.snapshot.meta.durableBase = publicationTarget;
		const savedRuntime = hashJson(createSessionRuntime(resolved.snapshot, this.cwd, this.sessionId, view.lineage));
		resolved.snapshot.meta.pendingPublication = { commit: publicationTarget, error: "Durable publication intent is unconfirmed" };
		if (migrationPush?.status === "pending") {
			resolved.snapshot.meta.pendingPublication = { commit: migrationPush.commit, error: migrationPush.error ?? "Unconfirmed publication" };
		} else if (migrationPush !== undefined) {
			delete resolved.snapshot.meta.pendingPublication;
		} else {
			try {
				if (isLocalGitRepository(this.root)) delete resolved.snapshot.meta.pendingPublication;
			} catch {
				// Invalid remote/branch configuration retains unconfirmed publication for explicit retry.
			}
		}
		this.view = view;
		this.base = base;
		this.backend = "git";
		this.provenanceByScope = structuredClone(loaded.provenance);
		this.semanticRevision = semanticRevision;
		this.savedRuntime = savedRuntime;
		return resolved.snapshot;
	}

	initialize(snapshot: Snapshot, allowCreateCwd: boolean, expectedShared?: Pick<ScopedStates, "global" | "cwd">, newSessionOrigin = false): RuntimePublication | undefined {
		return this.initializeOrigin(snapshot, { allowCreateCwd, expectedShared, newSessionOrigin });
	}

	private initializeOrigin(snapshot: Snapshot, options: {
		allowCreateCwd: boolean;
		expectedShared?: Pick<ScopedStates, "global" | "cwd">;
		newSessionOrigin?: boolean;
		copy?: SessionCopy;
	}): RuntimePublication | undefined {
		const { allowCreateCwd, expectedShared, newSessionOrigin = false, copy } = options;
		const hasCwd = hasCwdMaterialization(this.cwd, this.root);
		if (!allowCreateCwd && !hasCwd) return undefined;
		const backend = copy?.backend ?? this.backend ?? (detectGitCapability() === "git" && lstatSync(join(this.root, ".git"), { throwIfNoEntry: false }) ? "git" : "files");
		if (!copy && backend === "git") {
			if (!hasCwd) migrateHashedCwdAtHead(this.cwd, this.root);
			if (hasLegacyStateSources(this.cwd, this.sessionId, this.root, this.sessionKey)) {
				migrateLegacyStorageToGit(this.cwd, this.sessionId, this.root, this.sessionKey);
			}
		}
		else if (!copy) {
			if (allowCreateCwd) initializeFileStore(this.root);
			if (hasLegacyStateSources(this.cwd, this.sessionId, this.root, this.sessionKey)) {
				migrateLegacyStorageToFiles(this.cwd, this.sessionId, this.root, this.sessionKey);
			}
		}
		const base: TemporalGitBase = backend === "git" ? captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey) : captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey);
		const files = new Map(base.files.map((file) => [file.path, file.content]));
		if (copy) {
			const session = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
			const owned = [session.checkpoint, session.patches, session.meta, join(session.directory, "config.json"), join(session.directory, "state.json")];
			const occupied = owned.some((path) => files.get(path) !== undefined);
			const historical = !occupied && backend === "git" && base.head ? loadTemporalRevision(this.cwd, this.sessionId, this.root, base.head, this.sessionKey) : undefined;
			if (occupied || historical?.runtime || historical?.scopes.session) {
				throw new Error("State Flow fork target already has session storage");
			}
		}
		if (SCOPES.some((scope) => {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			return files.get(join(paths.directory, "state.json")) !== undefined;
		})) throw new Error("Legacy State Flow storage changed during initialization; retry migration from a fresh basis");
		const streams = Object.fromEntries(SCOPES.map((scope) => {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			return [scope, parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined)];
		})) as Record<StateScope, TemporalState["scopes"][StateScope] | undefined>;
		if (!streams.cwd && !allowCreateCwd) return undefined;
		if (copy && !streams.global) throw new Error("State Flow fork requires existing shared scope storage");
		const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
		const existingRuntime = parseSessionRuntime(files.get(paths.config), files.get(paths.meta), this.cwd, this.sessionId);
		if (existingRuntime && !snapshot.legacySession && !newSessionOrigin) throw new Error("Existing session runtime requires a branch revision pointer");
		// Explicit start before any branch runtime is a new origin, never inheritance of a later session layer.
		if (snapshot.legacySession || newSessionOrigin) streams.session = undefined;
		if (copy) streams.session = copy.stream;
		const fresh = createTemporalState({ global: emptyState(), cwd: emptyState(), session: snapshot.legacySession?.state ?? emptyState() }, randomUUID());
		const candidate = new TemporalRuntime(this.cwd, this.session, this.root);
		candidate.backend = backend;
		candidate.base = base;
		candidate.view = adoptTemporalStreams({ global: streams.global ?? fresh.scopes.global, cwd: streams.cwd ?? fresh.scopes.cwd, session: streams.session ?? fresh.scopes.session }, `${base.head ?? "unborn"}:${randomUUID()}`);
		const globalMeta = temporalScopePaths(this.cwd, this.sessionId, "global", this.root, this.sessionKey).meta;
		const cwdMeta = temporalScopePaths(this.cwd, this.sessionId, "cwd", this.root, this.sessionKey).meta;
		candidate.provenanceByScope = {
			global: parseScopeProvenance(files.get(globalMeta), globalMeta),
			cwd: parseScopeProvenance(files.get(cwdMeta), cwdMeta),
			session: copy ? structuredClone(copy.provenance) : streams.session === undefined ? {} : parseArtifactProvenanceRegistry(existingRuntime?.meta.artifacts, "State Flow session artifact provenance"),
		};
		if (expectedShared && (["global", "cwd"] as const).some((scope) => !sameJson(candidate.read(0, scope), expectedShared[scope]))) {
			throw new Error("Legacy branch shared scopes diverged from the selected revision; migration cannot overwrite them");
		}
		const publication = copy ? candidate.publishForkOrigin(snapshot) : candidate.publish(snapshot, true);
		this.view = candidate.view;
		this.base = candidate.base;
		this.backend = backend;
		this.provenanceByScope = structuredClone(candidate.provenanceByScope);
		this.semanticRevision = candidate.semanticRevision;
		this.savedRuntime = candidate.savedRuntime;
		return publication;
	}

	/** Initial copy owns only the new session files, without pruning or rewriting shared provenance. */
	private publishForkOrigin(snapshot: Snapshot): RuntimePublication {
		const runtime = createSessionRuntime(snapshot, this.cwd, this.sessionId, this.view!.lineage, this.backend === "files" ? "files" : "unconfirmed", this.provenanceByScope.session);
		const result = this.backend === "files"
			? publishTemporalStateToFiles(this.cwd, this.sessionId, this.view!, ["session"], this.base!, this.root, runtime, this.sessionKey, this.provenanceByScope)
			: publishTemporalStateToGit(this.cwd, this.sessionId, this.view!, ["session"], this.base!, this.root, runtime, this.sessionKey, (snapshot.meta.remotePublication?.mode ?? "transition") === "transition", this.provenanceByScope);
		const publication: RuntimePublication = result;
		this.base = publication.base;
		this.semanticRevision = publication.revision ?? publication.commit;
		this.savedRuntime = hashJson(runtime);
		return publication;
	}

	/**
	 * Reconcile untouched shared-scope drift against the current proven live basis.
	 *
	 * A restored branch can lag behind live global/CWD state. Untouched shared scopes adopt
	 * the current live streams at a fresh origin; a shared scope the accepted transition
	 * actually changes remains a fail-closed write conflict. Divergence in non-adoptable
	 * session or runtime files also fails closed under the existing race rule.
	 */
	private reconcileSharedDrift(changedScopes: ReadonlySet<StateScope>): {
		view: TemporalState;
		base: TemporalGitBase | TemporalFileBase;
		provenance: Record<StateScope, ArtifactProvenanceRegistry>;
	} {
		const captured = this.backend === "files"
			? captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey)
			: captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey);
		const liveFiles = new Map(captured.files.map((file) => [file.path, file]));
		const adoptable = new Set<string>();
		for (const scope of SHARED_SCOPES) {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			adoptable.add(paths.checkpoint);
			adoptable.add(paths.patches);
			adoptable.add(paths.meta);
		}
		for (const file of this.base!.files) {
			if (adoptable.has(file.path)) continue;
			const current = liveFiles.get(file.path);
			if (current === undefined || current.identity !== file.identity) {
				throw new Error("Temporal State Flow base or scope identity changed concurrently");
			}
		}
		const provenance = structuredClone(this.provenanceByScope);
		const adopted = new Map<StateScope, ScopeStream>();
		const targets: StateScope[] = [];
		for (const scope of SHARED_SCOPES) {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			const stream = parseScopeStream(liveFiles.get(paths.checkpoint)?.content, liveFiles.get(paths.patches)?.content, scope, scope === "cwd" ? this.cwd : undefined);
			if (stream === undefined) throw new Error(`Live State Flow ${scope} scope storage is incomplete`);
			const liveProvenance = parseScopeProvenance(liveFiles.get(paths.meta)?.content, paths.meta);
			const streamDrifted = !sameJson(stream, this.view!.scopes[scope]);
			const provenanceDrifted = !sameJson(liveProvenance, this.provenanceByScope[scope]);
			if (!streamDrifted && !provenanceDrifted) continue;
			if (changedScopes.has(scope)) {
				targets.push(scope);
				continue;
			}
			provenance[scope] = liveProvenance;
			if (streamDrifted) adopted.set(scope, stream);
		}
		if (targets.length > 0) throw targetScopeConflict(targets);
		if (adopted.size === 0) return { view: this.view!, base: captured, provenance };
		const streams = {
			global: adopted.get("global") ?? structuredClone(this.view!.scopes.global),
			cwd: adopted.get("cwd") ?? structuredClone(this.view!.scopes.cwd),
			session: structuredClone(this.view!.scopes.session),
		};
		const head = "head" in captured ? captured.head : undefined;
		return {
			view: adoptTemporalStreams(streams, `${head ?? "unborn"}:reconcile:${randomUUID()}`),
			base: captured,
			provenance,
		};
	}

	publish(
		snapshot: Snapshot,
		semantic = false,
		accepted?: AcceptedTransition,
		options: { pushRemote?: boolean; provenance?: Partial<Record<StateScope, Record<string, ArtifactProvenance>>> } = {},
	): RuntimePublication | undefined {
		if (!this.view || !this.base) throw new Error("State Flow temporal publication is unavailable; restore or initialize before accepting a transition");
		// Activation and terminal policy: only the legacy transition mode publishes synchronously.
		const pushRemote = options.pushRemote ?? (snapshot.meta.remotePublication?.mode ?? "transition") === "transition";
		const provenanceScopes = SCOPES.filter((scope) => Object.entries(options.provenance?.[scope] ?? {})
			.some(([path, entry]) => this.provenanceByScope[scope][path] === undefined
				|| !sameJson(this.provenanceByScope[scope][path], entry)));
		let basis = this.view;
		let base: TemporalGitBase | TemporalFileBase = this.base;
		let basisProvenance = this.provenanceByScope;
		if ((semantic || provenanceScopes.length > 0) && this.semanticRevision) {
			const changedScopes = new Set<StateScope>([
				...(accepted?.transitions ?? []).map(({ scope }) => scope),
				...provenanceScopes,
			]);
			const reconciled = this.reconcileSharedDrift(changedScopes);
			basis = reconciled.view;
			base = reconciled.base;
			basisProvenance = reconciled.provenance;
		}
		const next = accepted ? advanceTemporalState(basis, accepted.transitions, accepted.id) : basis;
		const nextProvenance = structuredClone(basisProvenance);
		for (const scope of SCOPES) {
			const updates = options.provenance?.[scope];
			if (updates) for (const [path, entry] of Object.entries(updates)) nextProvenance[scope][path] = structuredClone(entry);
		}
		for (const scope of SCOPES) {
			nextProvenance[scope] = pruneArtifactProvenance(nextProvenance[scope], readTemporalState(next, 0, scope).artifacts);
		}
		const provenanceChanged = !sameJson(nextProvenance, this.provenanceByScope);
		const scopedWrite = semantic || provenanceChanged;
		const runtime = createSessionRuntime(snapshot, this.cwd, this.sessionId, next.lineage, this.backend === "files" ? "files" : "unconfirmed", nextProvenance.session);
		const fingerprint = hashJson(runtime);
		if (!semantic && fingerprint === this.savedRuntime && !provenanceChanged) return undefined;
		if (this.backend === "files") {
			runtime.meta.temporalRevision = "self";
			const result = publishTemporalStateToFiles(this.cwd, this.sessionId, next, semantic ? SCOPES : [], base, this.root, runtime, this.sessionKey, nextProvenance);
			this.base = result.base;
			this.view = next;
			this.provenanceByScope = nextProvenance;
			this.savedRuntime = fingerprint;
			this.semanticRevision = result.revision;
			return { base: result.base, revision: result.revision };
		}
		if (!scopedWrite) {
			const current = captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey);
			const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
			for (const path of [paths.config, paths.meta]) {
				if (current.files.find((file) => file.path === path)?.identity !== base.files.find((file) => file.path === path)?.identity) {
					throw new Error("Temporal State Flow runtime changed concurrently");
				}
			}
			base = current;
		}
		runtime.meta.temporalRevision = scopedWrite ? "self" : this.semanticRevision!;
		const result = publishTemporalStateToGit(
			this.cwd, this.sessionId, next, semantic ? SCOPES : provenanceChanged ? provenanceScopes : [], base, this.root, runtime, this.sessionKey,
			pushRemote,
			nextProvenance,
		);
		this.base = result.base;
		this.view = next;
		this.provenanceByScope = nextProvenance;
		this.savedRuntime = fingerprint;
		if (scopedWrite && result.commit) this.semanticRevision = result.commit;
		return result;
	}
}
