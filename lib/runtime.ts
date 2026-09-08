import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { parseScopeStream, sessionRuntimePaths, temporalScopePaths } from "./durable.ts";
import { adoptFileStateToGit, initializeGitRepository, isLocalGitRepository, captureTemporalGitBase, loadLegacyStatesAtRevision, loadTemporalRevision, migrateHashedCwdAtHead, migrateHashedLayoutAtHead, migrateLegacyStorageToGit, publishTemporalStateToGit, type TemporalGitBase } from "./git.ts";
import { captureTemporalFileBase, detectGitCapability, initializeFileStore, loadTemporalFileRevision, migrateLegacyStorageToFiles, publishTemporalStateToFiles } from "./storage.ts";
import { type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { hashJson } from "./json.ts";
import { hasCwdMaterialization } from "./migration.ts";
import { RevisionUnavailableError, createSessionRuntime, isFileRevision, parseSessionRuntime, resolveFileSessionRuntime, resolveSessionRuntime, type Snapshot } from "./snapshot.ts";
import { emptyState, type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";
import { adoptTemporalStreams, advanceTemporalState, createTemporalState, readTemporalState, validateTemporalState, type TemporalState } from "./temporal.ts";

const SCOPES = ["global", "cwd", "session"] as const;
export type RuntimePublication = ReturnType<typeof publishTemporalStateToGit> & { revision?: string };

/** Immutable target validation is independent of acquiring the live publication basis. */
export function inspectRuntimeRevision(cwd: string, sessionId: string, root: string, revision: string, sessionKey = sessionId) {
	const loaded = loadTemporalRevision(cwd, sessionId, root, revision, sessionKey);
	if (!loaded.runtime) throw new Error("Linked State Flow revision has no session runtime");
	const resolved = resolveSessionRuntime(loaded.runtime.document, loaded.runtime.revision);
	if (!loaded.scopes.global || !loaded.scopes.cwd || !loaded.scopes.session) throw new Error("Incomplete temporal scope cohort");
	const view = { lineage: resolved.lineage, scopes: { global: loaded.scopes.global, cwd: loaded.scopes.cwd, session: loaded.scopes.session } };
	validateTemporalState(view);
	return { runtime: loaded.runtime, resolved, view, ...(loaded.legacyLayout ? { legacyLayout: true as const } : {}) };
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
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionKey: string;
	readonly root: string;
	constructor(cwd: string, sessionId: string, root: string, sessionKey = sessionId) {
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.sessionKey = sessionKey;
		this.root = root;
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
		const result = adoptFileStateToGit(this.cwd, this.sessionId, this.root, snapshot.meta.durableBase, snapshot, this.sessionKey);
		const savedRuntime = hashJson(createSessionRuntime(snapshot, this.cwd, this.sessionId, result.view.lineage));
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

	restore(revision: string, legacySnapshot?: Snapshot): Snapshot {
		const inspected = inspectSnapshotRevision(this.cwd, this.sessionId, this.root, revision, legacySnapshot, this.sessionKey);
		if (inspected.file) {
			const savedRuntime = hashJson(createSessionRuntime(inspected.snapshot, this.cwd, this.sessionId, inspected.file.view.lineage, "files"));
			this.view = inspected.file.view;
			this.base = inspected.file.base;
			this.backend = "files";
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
		this.semanticRevision = semanticRevision;
		this.savedRuntime = savedRuntime;
		return resolved.snapshot;
	}

	initialize(snapshot: Snapshot, allowCreateCwd: boolean, expectedShared?: Pick<ScopedStates, "global" | "cwd">, newSessionOrigin = false): RuntimePublication | undefined {
		if (!allowCreateCwd && !hasCwdMaterialization(this.cwd, this.root)) return undefined;
		const backend = this.backend ?? (detectGitCapability() === "git" && lstatSync(join(this.root, ".git"), { throwIfNoEntry: false }) ? "git" : "files");
		if (backend === "git") {
			migrateHashedCwdAtHead(this.cwd, this.root);
			migrateLegacyStorageToGit(this.cwd, this.sessionId, this.root, this.sessionKey);
		}
		else {
			if (allowCreateCwd) initializeFileStore(this.root);
			migrateLegacyStorageToFiles(this.cwd, this.sessionId, this.root, this.sessionKey);
		}
		const base: TemporalGitBase = backend === "git" ? captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey) : captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey);
		const files = new Map(base.files.map((file) => [file.path, file.content]));
		const streams = Object.fromEntries(SCOPES.map((scope) => {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			return [scope, parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined)];
		})) as Record<StateScope, TemporalState["scopes"][StateScope] | undefined>;
		if (!streams.cwd && !allowCreateCwd) return undefined;
		const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
		const existingRuntime = parseSessionRuntime(files.get(paths.config), files.get(paths.meta), this.cwd, this.sessionId);
		if (existingRuntime && !snapshot.legacySession && !newSessionOrigin) throw new Error("Existing session runtime requires a branch revision pointer");
		// Explicit start before any branch runtime is a new origin, never inheritance of a later session layer.
		if (snapshot.legacySession || newSessionOrigin) streams.session = undefined;
		const fresh = createTemporalState({ global: emptyState(), cwd: emptyState(), session: snapshot.legacySession?.state ?? emptyState() }, randomUUID());
		const candidate = new TemporalRuntime(this.cwd, this.sessionId, this.root, this.sessionKey);
		candidate.backend = backend;
		candidate.base = base;
		candidate.view = adoptTemporalStreams({ global: streams.global ?? fresh.scopes.global, cwd: streams.cwd ?? fresh.scopes.cwd, session: streams.session ?? fresh.scopes.session }, `${base.head ?? "unborn"}:${randomUUID()}`);
		if (expectedShared && (["global", "cwd"] as const).some((scope) => hashJson(candidate.read(0, scope)) !== hashJson(expectedShared[scope]))) {
			throw new Error("Legacy branch shared scopes diverged from the selected revision; migration cannot overwrite them");
		}
		const publication = candidate.publish(snapshot, true);
		this.view = candidate.view;
		this.base = candidate.base;
		this.backend = backend;
		this.semanticRevision = candidate.semanticRevision;
		this.savedRuntime = candidate.savedRuntime;
		return publication;
	}

	publish(snapshot: Snapshot, semantic = false, accepted?: AcceptedTransition): RuntimePublication | undefined {
		if (!this.view || !this.base) throw new Error("State Flow temporal publication is unavailable; restore or initialize before accepting a transition");
		const next = accepted ? advanceTemporalState(this.view, accepted.transitions, accepted.id) : this.view;
		const runtime = createSessionRuntime(snapshot, this.cwd, this.sessionId, next.lineage, this.backend === "files" ? "files" : "unconfirmed");
		const fingerprint = hashJson(runtime);
		if (!semantic && fingerprint === this.savedRuntime) return undefined;
		if (semantic && this.semanticRevision) {
			// Session files may branch; shared scopes may not be silently merged or rewound.
			const live = new Map(this.base.files.map((file) => [file.path, file.content]));
			for (const scope of ["global", "cwd"] as const) {
				const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
				const stream = parseScopeStream(live.get(paths.checkpoint), live.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined);
				if (hashJson(stream) !== hashJson(this.view.scopes[scope])) throw new Error("State Flow cannot publish this restored branch because its global or CWD scope changed concurrently after the linked revision");
			}
		}
		if (this.backend === "files") {
			runtime.meta.temporalRevision = "self";
			const result = publishTemporalStateToFiles(this.cwd, this.sessionId, next, semantic ? SCOPES : [], this.base, this.root, runtime, this.sessionKey);
			this.base = result.base;
			this.view = next;
			this.savedRuntime = fingerprint;
			this.semanticRevision = result.revision;
			return { base: result.base, revision: result.revision };
		}
		if (!semantic) {
			const current = captureTemporalGitBase(this.cwd, this.sessionId, this.root, this.sessionKey);
			const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
			for (const path of [paths.config, paths.meta]) {
				if (current.files.find((file) => file.path === path)?.identity !== this.base.files.find((file) => file.path === path)?.identity) {
					throw new Error("Temporal State Flow runtime changed concurrently");
				}
			}
			this.base = current;
		}
		runtime.meta.temporalRevision = semantic ? "self" : this.semanticRevision!;
		const result = publishTemporalStateToGit(this.cwd, this.sessionId, next, semantic ? SCOPES : [], this.base, this.root, runtime, this.sessionKey);
		this.base = result.base;
		this.view = next;
		this.savedRuntime = fingerprint;
		if (semantic && result.commit) this.semanticRevision = result.commit;
		return result;
	}
}
