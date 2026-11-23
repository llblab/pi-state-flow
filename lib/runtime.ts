import { lstatSync } from "node:fs";
import type { ArtifactProvenanceRegistry } from "./artifact.ts";
import { classifyScopeStream, sessionRuntimePaths, temporalScopePaths, type SessionAddress } from "./durable.ts";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { isObject, sameJson } from "./json.ts";
import { captureScopeSelection, type ScopeSelection } from "./selection.ts";
import { RevisionUnavailableError, retainedBoundaryCheckpoint, captureLifecycleSnapshot, type SelectedRetainedPiCheckpoint, type Snapshot, type StateFlowMode, type PrivateAcquisition } from "./snapshot.ts";
import type { MaterializedState, SemanticState, ScopeStateValues, StateScope } from "./state.ts";
import { assertTemporalFileBase, captureSelectedModuleAdditions, captureSelectedProvenanceUpdates, temporalFileContents, assertStorageDirectory, initializeFileStore, withStorageTransaction, type TemporalFileBase, type SelectedFilePublication, type SelectedOriginRequest, type SelectedSessionAcquisitionRequest, type SelectedForkCopyRequest, type SelectedFileCohort, type SelectedModuleAdditions, type SelectedProvenanceUpdates, type SelectedReadObservation } from "./storage.ts";
import { readTemporalScopes, readTemporalState, readTemporalView, selectTemporalState, type SelectedTemporalState } from "./temporal.ts";

export interface SelectedRuntimePatchTransaction {
	readonly selection: ScopeSelection;
	readonly states: ScopeStateValues;
	readonly modules?: SelectedModuleAdditions;
	readonly snapshot: Snapshot;
	readonly causalBasis: string;
	readonly provenance: SelectedProvenanceUpdates;
	publish(snapshot: Snapshot, accepted?: AcceptedTransition, provenance?: SelectedProvenanceUpdates, moduleAdditions?: SelectedModuleAdditions): SelectedFilePublication;
}

export interface SelectedLifecycleInspection {
	readonly selection: ScopeSelection;
	readonly privateAcquisition: PrivateAcquisition;
	readonly snapshot: Snapshot;
}

function selectedModules(view: SelectedTemporalState): SelectedModuleAdditions {
	return Object.fromEntries(view.selection.filter(scope => view.scopes[scope]?.modules !== undefined)
		.map(scope => [scope, structuredClone(view.scopes[scope]!.modules!)]));
}

function selectedRunSnapshot(cohort: Pick<SelectedFileCohort, "lifecycle">): Snapshot {
	const source = cohort.lifecycle.runtime;
	const meta = { step: source.meta.step, ...Object.fromEntries(["specification", "bootstrap", "validation"]
		.filter((key) => Object.hasOwn(source.meta, key)).map((key) => [key, source.meta[key]])) };
	return captureLifecycleSnapshot({ config: { mode: source.config.mode }, meta });
}

/** Detached replay inputs; excluded patch bodies must not be touched even for a rejected raw replay. */
function captureSelectedReplay(accepted: AcceptedTransition | undefined, selection: ScopeSelection): AcceptedTransition | undefined {
	if (accepted === undefined) return undefined;
	if (!isObject(accepted) || !Array.isArray(accepted.transitions)) throw new Error("Invalid selected runtime replay");
	for (const item of accepted.transitions) if (!isObject(item) || !selection.includes(item.scope as StateScope)) throw new Error("Selected runtime replay contains an excluded owner");
	return structuredClone(accepted);
}

/** Child policy recorded by the native fork; memory always comes from the parent's current files. */
export interface ForkLifecycle {
	mode: StateFlowMode;
	bootstrap?: true;
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

/** A replay target disappeared; reconcile it through current acceptance before retrying. */
export class SharedScopeRemovalConflictError extends Error {
	readonly scopes: readonly StateScope[];
	constructor(scopes: readonly StateScope[]) {
		const labels = scopes.map(scopeLabel);
		super(labels.length === 1
			? `State Flow cannot publish the ${labels[0]} patch because the live ${labels[0]} scope was removed after this transition's selected basis. Refresh or reconcile the target scope before retrying.`
			: `State Flow cannot publish the ${labels.join(" and ")} patches because the live ${labels.join(" and ")} scopes were removed after this transition's selected basis. Refresh or reconcile the target scopes before retrying.`);
		this.name = "SharedScopeRemovalConflictError";
		this.scopes = Object.freeze([...scopes]);
	}
}

/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export class TemporalRuntime {
	private memory: { kind: "selected"; cohort: SelectedFileCohort }
		| { kind: "observed"; observation: SelectedReadObservation } | undefined;
	private acceptedCurrentMemory = false;
	private observedSessionAuthority = false;
	private privateAcquisitionEvidence?: PrivateAcquisition | "absent";
	readonly cwd: string;
	private readonly session: SessionAddress;
	readonly root: string;
	readonly historyLimit: number;
	constructor(cwd: string, session: string | SessionAddress, root: string, sessionKey?: string, historyLimit = DEFAULT_HISTORY_LIMIT) {
		this.cwd = cwd;
		this.session = Object.freeze(typeof session === "string" ? { id: session, key: sessionKey ?? session } : { ...session });
		this.root = root;
		if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > MAX_HISTORY_LIMIT) throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
		this.historyLimit = historyLimit;
	}

	get sessionId(): string { return this.session.id; }
	get sessionKey(): string { return this.session.key; }

	/** Revoke cache-dependent leases without forgetting known owner or acquisition evidence. */
	clearCache(): void {
		this.memory = undefined;
	}

	private rememberSessionAuthority(base: TemporalFileBase): void {
		const privatePaths = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
		const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
		const privateFiles = new Set([privatePaths.checkpoint, privatePaths.patches, privatePaths.meta]);
		for (const file of base.files) if (file.identity !== "missing") {
			if (privateFiles.has(file.path)) this.privateAcquisitionEvidence = "acquired";
			if (privateFiles.has(file.path) || file.path === paths.config || file.path === paths.runtime) this.observedSessionAuthority = true;
		}
	}

	/** Only owned durable acceptance calls this; returned receipts and read-only candidates are not installers. */
	private installSelected(cohort: SelectedFileCohort): void {
		this.privateAcquisitionEvidence = cohort.lifecycle.runtime.meta.privateAcquisition;
		this.memory = { kind: "selected", cohort: structuredClone(cohort) };
		this.acceptedCurrentMemory = true;
	}

	private installObserved(observation: SelectedReadObservation): void {
		this.memory = { kind: "observed", observation: structuredClone(observation) };
	}

	private observationGuard(revalidateNativePolicy: () => void, signal?: AbortSignal): () => void {
		const memory = this.memory;
		return () => {
			signal?.throwIfAborted();
			if (this.acceptedCurrentMemory) throw new Error("Accepted State Flow memory requires current acceptance, not observation");
			if (this.memory !== memory) throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
			if (typeof revalidateNativePolicy !== "function") throw new Error("Selected observation requires independent native policy authority");
			revalidateNativePolicy();
		};
	}

	private selectedReadCache(): Pick<SelectedReadObservation, "view" | "provenance"> | undefined {
		if (this.memory?.kind === "selected") return this.memory.cohort;
		if (this.memory?.kind === "observed") return this.memory.observation;
		return undefined;
	}

	/** Last admitted lifecycle evidence for presentation only; future operations still check current files. */
	observedPrivateAcquisition(): PrivateAcquisition | "absent" | undefined { return this.privateAcquisitionEvidence; }

	/** Detached read-only selected values; never accepted run fields or a publication/acquisition basis. */
	observedSelectedView(): SelectedTemporalState | undefined {
		return this.memory?.kind === "observed" ? structuredClone(this.memory.observation.view) : undefined;
	}

	/** Shared owners proven absent by a completed read-only observation; no empty streams are synthesized. */
	observedAbsentSharedScopes(): StateScope[] {
		if (this.memory?.kind !== "observed") return [];
		const { selection, view } = this.memory.observation;
		return selection.filter(scope => scope !== "session" && !view?.selection.includes(scope));
	}

	/** Explicit shared inspection before acquisition; missing owners stay unavailable rather than becoming empty streams. */
	async refreshSelectedShared(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal, requireUnacquiredPrivate = false): Promise<boolean> {
		const wanted = captureScopeSelection(selection);
		if (wanted.includes("session")) throw new Error("Shared State Flow observation cannot select Session");
		const assertAuthority = this.observationGuard(revalidateNativePolicy, signal);
		const install = (observation: SelectedReadObservation): boolean => {
			assertAuthority();
			this.installObserved(observation);
			return observation.view !== undefined;
		};
		assertAuthority();
		assertStorageDirectory(this.root);
		if (!lstatSync(this.root, { throwIfNoEntry: false })) {
			const present = install({ selection: wanted, provenance: {} });
			if (requireUnacquiredPrivate) this.privateAcquisitionEvidence = "absent";
			return present;
		}
		return withStorageTransaction(this.root, storage => {
			assertAuthority();
			const lifecycle = requireUnacquiredPrivate ? storage.inspectSelectedLifecycle(this.cwd, this.sessionId, wanted, this.root, this.sessionKey) : undefined;
			if (lifecycle && lifecycle.runtime.meta.privateAcquisition !== "unacquired") {
				throw new RevisionUnavailableError("State Flow Effective memory requires current acquired or deferred Session proof");
			}
			const present = install(storage.observeSelectedShared(this.cwd, wanted, this.root));
			if (requireUnacquiredPrivate) this.privateAcquisitionEvidence = lifecycle?.runtime.meta.privateAcquisition ?? "absent";
			return present;
		}, signal);
	}

	/** Header-only disposition data; never semantic observation, acceptance, or acquisition permission. */
	async inspectSelectedLifecycle(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<SelectedLifecycleInspection | undefined> {
		const wanted = captureScopeSelection(selection);
		const memory = this.memory;
		const check = () => {
			signal?.throwIfAborted();
			if (this.memory !== memory) throw new Error("State Flow attachment selection changed");
			revalidateNativePolicy();
		};
		check();
		assertStorageDirectory(this.root);
		if (!lstatSync(this.root, { throwIfNoEntry: false })) {
			if (this.observedSessionAuthority) throw new RevisionUnavailableError("Known selected session authority is unavailable");
			this.privateAcquisitionEvidence = "absent";
			return undefined;
		}
		return withStorageTransaction(this.root, storage => {
			check();
			const lifecycle = storage.inspectSelectedLifecycle(this.cwd, this.sessionId, wanted, this.root, this.sessionKey);
			check();
			if (!lifecycle) {
				if (this.observedSessionAuthority) throw new RevisionUnavailableError("Known selected session authority is unavailable");
				this.privateAcquisitionEvidence = "absent";
				return undefined;
			}
			if (this.privateAcquisitionEvidence === "acquired" && lifecycle.runtime.meta.privateAcquisition !== "acquired") throw new Error("Known acquired State Flow private authority cannot be downgraded");
			this.observedSessionAuthority = true;
			this.privateAcquisitionEvidence = lifecycle.runtime.meta.privateAcquisition;
			return { selection: captureScopeSelection(lifecycle.runtime.config.scopes), privateAcquisition: lifecycle.runtime.meta.privateAcquisition,
				snapshot: selectedRunSnapshot({ lifecycle }) };
		}, signal);
	}

	/** Native bookmarks never decide whether current canonical authority exists. */
	async hasSelectedCurrentAuthority(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<boolean> {
		return await this.inspectSelectedLifecycle(selection, revalidateNativePolicy, signal) !== undefined;
	}

	/** Fenced inactive restoration/operator inspection: source proof only, without conversion or durable acceptance. */
	async refreshSelectedCurrent(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<Snapshot> {
		const wanted = captureScopeSelection(selection);
		const assertAuthority = this.observationGuard(revalidateNativePolicy, signal);
		assertAuthority();
		if (!lstatSync(this.root, { throwIfNoEntry: false })) throw new RevisionUnavailableError("Selected current session storage is unavailable");
		return withStorageTransaction(this.root, storage => {
			assertAuthority();
			const current = storage.prepareSelectedCurrent(this.cwd, this.sessionId, wanted, this.historyLimit, this.root, this.sessionKey);
			if (this.privateAcquisitionEvidence === "acquired" && current.lifecycle.runtime.meta.privateAcquisition !== "acquired") throw new Error("Known acquired State Flow private authority cannot be downgraded");
			// Current acceptance can plan absent shared owners; observation must not expose those planned empty streams.
			const present = wanted.filter(scope => {
				const path = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).checkpoint;
				return current.basis.files.some(file => file.path === path && file.identity !== "missing");
			});
			const observation: SelectedReadObservation = { selection: wanted,
				provenance: Object.fromEntries(present.map(scope => [scope, current.provenance[scope]!])),
				...(present.length === 0 ? {} : { view: selectTemporalState(current.view, captureScopeSelection(present), this.historyLimit) }),
			};
			const snapshot = selectedRunSnapshot(current);
			assertAuthority();
			this.rememberSessionAuthority(current.basis);
			this.privateAcquisitionEvidence = current.lifecycle.runtime.meta.privateAcquisition;
			this.installObserved(observation);
			return snapshot;
		}, signal);
	}

	/** Detached accepted selected values only, never a file receipt or publication capability. */
	selectedView(): SelectedTemporalState | undefined {
		return this.memory?.kind === "selected" ? structuredClone(this.memory.cohort.view) : undefined;
	}

	/** Accepted run fields only; local policy and pending native prompts remain the adapter's responsibility. */
	selectedSnapshot(): Snapshot {
		if (this.memory?.kind !== "selected") throw new Error("Selected State Flow runtime is unavailable");
		return selectedRunSnapshot(this.memory.cohort);
	}

	/** Native bookkeeping may change mode, never invent accepted run fields or a semantic boundary. */
	retainedSelectedCheckpoint(mode?: StateFlowMode): SelectedRetainedPiCheckpoint {
		const memory = this.memory;
		if (memory?.kind !== "selected") throw new Error("Selected State Flow runtime is unavailable");
		const snapshot = selectedRunSnapshot(memory.cohort);
		if (mode !== undefined) snapshot.config.mode = mode;
		return { ...retainedBoundaryCheckpoint(snapshot, memory.cohort.view.lineage.at(-1)!.id), version: 2, scopes: captureScopeSelection(memory.cohort.view.selection) };
	}

	/** Read-only cache identity lease; no source acquisition, storage receipt or publication authority. */
	captureSelectedReadBasis(): () => void {
		const memory = this.memory;
		if (!this.selectedReadCache()?.view) throw new Error("Selected State Flow runtime is unavailable");
		return () => { if (this.memory !== memory) throw new Error("State Flow module context content basis changed"); };
	}

	/** Exact present owners for the existing selected staging engine; no defaulted disabled scopes. */
	selectedStates(offset = 0): { selection: ScopeSelection; states: ScopeStateValues } {
		const view = this.selectedReadCache()?.view;
		if (!view) throw new Error("Selected State Flow runtime is unavailable");
		return { selection: captureScopeSelection(view.selection), states: readTemporalScopes(view, offset, this.historyLimit) };
	}

	/** Runtime-owned artifact compilation evidence for one scope; never model-visible state. */
	artifactProvenance(scope: StateScope): ArtifactProvenanceRegistry {
		const selected = this.selectedReadCache();
		if (!selected?.view) throw new Error(`State Flow ${scope} scope is excluded or unavailable`);
		if (!selected.view.selection.includes(scope)) throw new Error(`State Flow ${scope} scope is excluded`);
		return structuredClone(selected.provenance[scope]!);
	}

	read(offset = 0, scope?: StateScope): MaterializedState {
		const view = this.selectedReadCache()?.view;
		if (!view) throw new Error("State Flow temporal runtime is unavailable");
		return readTemporalState(view, offset, scope, this.historyLimit);
	}

	readView(offset = 0, scope?: StateScope): SemanticState {
		const view = this.selectedReadCache()?.view;
		if (!view) throw new Error("State Flow temporal runtime is unavailable");
		return readTemporalView(view, offset, scope, this.historyLimit);
	}

	causalBasis(): string {
		const view = this.selectedReadCache()?.view;
		if (!view) throw new Error("State Flow temporal runtime is unavailable");
		return view.lineage.at(-1)!.id;
	}

	recent(): RecentTransitionWindow {
		const view = this.selectedReadCache()?.view;
		if (!view) return [];
		const result: RecentTransitionWindow = [];
		for (const boundary of view.lineage.slice(1)) {
			const transitions = view.selection.flatMap((scope) => {
				const record = view.scopes[scope]!.patches.find(({ transition }) => transition.id === boundary.id);
				return record ? [{ scope, patch: structuredClone(record.patch) }] : [];
			});
			if (transitions.length) result.push({ id: boundary.id, at: boundary.position, transitions });
		}
		return result;
	}

	/** Authored under exclusion against validated live selected values; use the existing selected staging/commit engine. */
	async withSelectedPatchTransaction<T>(
		action: (transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal, capturedTargets: readonly StateScope[] = [],
	): Promise<T> {
		return this.withSelectedPublicationTransaction(action, "current", revalidateNativePolicy, signal, capturedTargets);
	}

	/** Mode-only Passive persistence: exact accepted sources, no current-origin adoption or caller-authored run fields. */
	async persistSelectedPassive(revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<SelectedFilePublication> {
		const memory = this.memory;
		if (memory?.kind !== "selected") throw new Error("Selected State Flow runtime is unavailable");
		const assertAuthority = (): void => {
			signal?.throwIfAborted();
			if (this.memory !== memory) throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
			if (typeof revalidateNativePolicy !== "function") throw new Error("Selected Passive persistence requires independent native policy authority");
			revalidateNativePolicy();
		};
		assertAuthority();
		return withStorageTransaction(this.root, storage => {
			assertAuthority();
			const publication = storage.persistSelectedPassive(this.cwd, this.sessionId, memory.cohort, this.root, this.sessionKey);
			if (publication.changed) this.installSelected(publication.cohort);
			return publication;
		}, signal);
	}

	/** Precomputed replay remains tied to its accepted cache; changed selected shared targets conflict before publication. */
	async publishSelected(
		snapshot: Snapshot, accepted: AcceptedTransition | undefined, revalidateNativePolicy: () => void,
		options: { provenance?: SelectedProvenanceUpdates; moduleAdditions?: SelectedModuleAdditions; signal?: AbortSignal } = {},
	): Promise<SelectedFilePublication> {
		if (this.memory?.kind !== "selected") throw new Error("Selected State Flow runtime is unavailable");
		const provenance = captureSelectedProvenanceUpdates(options.provenance, this.memory.cohort.view.selection);
		const replay = captureSelectedReplay(accepted, this.memory.cohort.view.selection);
		const additions = captureSelectedModuleAdditions(options.moduleAdditions, this.memory.cohort.view.selection);
		const lifecycle = captureLifecycleSnapshot(snapshot);
		return this.withSelectedPublicationTransaction(transaction => transaction.publish(lifecycle, replay, provenance, additions), "replay", revalidateNativePolicy, options.signal);
	}

	private async withSelectedPublicationTransaction<T>(
		action: (transaction: SelectedRuntimePatchTransaction) => T, kind: "current" | "replay",
		revalidateNativePolicy: () => void, signal?: AbortSignal, capturedTargets: readonly StateScope[] = [],
	): Promise<T> {
		const memory = this.memory;
		if (memory?.kind !== "selected") throw new Error("Selected State Flow runtime is unavailable");
		const selection = captureScopeSelection(memory.cohort.view.selection);
		const targets = capturedTargets.length ? captureScopeSelection(capturedTargets) : undefined;
		if (targets?.some(scope => !selection.includes(scope))) throw new Error("Captured State Flow write target is excluded");
		const assertAuthority = (): void => {
			signal?.throwIfAborted();
			if (this.memory !== memory) throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
			if (typeof revalidateNativePolicy !== "function") throw new Error("Selected semantic transaction requires independent native policy authority");
			revalidateNativePolicy();
		};
		assertAuthority();
		return withStorageTransaction(this.root, storage => {
			assertAuthority();
			const current = storage.prepareSelectedCurrent(this.cwd, this.sessionId, selection, this.historyLimit, this.root, this.sessionKey);
			const sharedPaths = new Set(selection.filter(scope => scope !== "session").flatMap(scope => {
				const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
				return [paths.checkpoint, paths.patches, paths.meta];
			}));
			assertTemporalFileBase({ files: memory.cohort.basis.files.filter(file => !sharedPaths.has(file.path)) },
				{ files: current.basis.files.filter(file => !sharedPaths.has(file.path)) });
			if (!sameJson(memory.cohort.presence, current.presence)) throw new Error("Selected State Flow presence dependencies changed concurrently");
			if (targets) this.assertSelectedReplayTargets(memory.cohort, current, undefined, undefined, undefined, targets);
			let consumed = false;
			let published = false;
			const result = action(Object.freeze<SelectedRuntimePatchTransaction>({
				selection, states: readTemporalScopes(current.view, 0, this.historyLimit), modules: selectedModules(current.view), snapshot: selectedRunSnapshot(current),
				causalBasis: current.view.lineage.at(-1)!.id, provenance: structuredClone(current.provenance),
				publish: (snapshot, accepted, requestedProvenance, requestedModules) => {
					if (consumed) throw new Error("Selected semantic transaction publication was already consumed");
					consumed = true;
					assertAuthority();
					const provenance = captureSelectedProvenanceUpdates(requestedProvenance, selection);
					const transition = captureSelectedReplay(accepted, selection);
					const moduleAdditions = captureSelectedModuleAdditions(requestedModules, selection);
					if (kind === "replay") this.assertSelectedReplayTargets(memory.cohort, current, transition, provenance, moduleAdditions);
					const publication = storage.acceptSelectedCurrent(this.cwd, this.sessionId,
						{ selection, historyLimit: this.historyLimit, lifecycle: captureLifecycleSnapshot(snapshot), transition, provenance, moduleAdditions }, current, this.root, this.sessionKey);
					this.installSelected(publication.cohort);
					published = true;
					return publication;
				},
			}));
			if (!published) throw new Error("Selected semantic transaction requires one synchronous publication");
			return result;
		}, signal);
	}

	private assertSelectedReplayTargets(
		base: SelectedFileCohort, current: SelectedFileCohort, transition?: AcceptedTransition, provenance?: SelectedProvenanceUpdates, additions?: SelectedModuleAdditions, capturedTargets: readonly StateScope[] = [],
	): void {
		const targets = new Set([...capturedTargets, ...(transition?.transitions.map(item => item.scope) ?? []), ...Object.keys(provenance ?? {}) as StateScope[], ...Object.keys(additions ?? {}) as StateScope[]]);
		const files = temporalFileContents(current.basis);
		const changed: StateScope[] = [], removed: StateScope[] = [];
		for (const scope of base.view.selection.filter(scope => scope !== "session" && targets.has(scope))) {
			const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
			const live = classifyScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta));
			if (live.kind === "absent") { removed.push(scope); continue; }
			if (!sameJson(live.stream, base.view.scopes[scope]) || !sameJson(current.provenance[scope], base.provenance[scope])) changed.push(scope);
		}
		if (removed.length > 0) throw new SharedScopeRemovalConflictError(removed);
		if (changed.length > 0) throw targetScopeConflict(changed);
	}

	/** New-session shared-only acceptance; caller rechecks native origin authority after waiting. */
	async withSelectedSharedOriginTransaction<T>(
		selection: ScopeSelection, snapshot: Snapshot, action: (publish: () => SelectedFilePublication) => T,
		signal?: AbortSignal, allowCreateOrigin = false,
	): Promise<T> {
		return this.withSelectedOriginAcceptance({ kind: "shared-new", selection, snapshot, historyLimit: this.historyLimit }, action, signal, allowCreateOrigin);
	}

	/** Child-owned deferred marker only; no parent locator or parent memory is acquired here. */
	async withSelectedDeferredForkTransaction<T>(
		selection: ScopeSelection, lifecycle: ForkLifecycle, action: (publish: () => SelectedFilePublication) => T,
		signal?: AbortSignal, allowDeferFork = false, modeAtPublication?: () => StateFlowMode,
	): Promise<T> {
		if (!lifecycle || Object.keys(lifecycle).some((key) => key !== "mode" && key !== "bootstrap")
			|| (lifecycle.bootstrap !== undefined && lifecycle.bootstrap !== true)) throw new Error("Invalid selected fork lifecycle");
		if (modeAtPublication !== undefined && typeof modeAtPublication !== "function") throw new Error("Invalid selected fork mode sampler");
		const snapshot: Snapshot = { config: { mode: lifecycle.mode }, meta: { step: 0, ...(lifecycle.bootstrap ? { bootstrap: true } : {}) } };
		// Sample mode only; callers cannot replace the fresh child run fields through this hook.
		const author: SelectedOriginRequest["author"] = modeAtPublication ? (basis, publish) => {
			const mode = modeAtPublication();
			signal?.throwIfAborted();
			publish({ config: { mode }, meta: basis.snapshot.meta });
		} : undefined;
		return this.withSelectedOriginAcceptance({ kind: "shared-deferred", selection, snapshot, historyLimit: this.historyLimit, author }, action, signal, allowDeferFork);
	}

	/** Explicit first private acquisition, never deferred-parent recovery or repair of lost acquired state. */
	async withSelectedSessionAcquisitionTransaction<T>(
		request: SelectedSessionAcquisitionRequest, action: (publish: () => SelectedFilePublication) => T,
		signal?: AbortSignal, allowAcquirePrivate = false,
	): Promise<T> {
		return this.withSelectedOriginAcceptance(request, action, signal, allowAcquirePrivate);
	}

	/** Stage first lifecycle/semantic authoring into one origin acceptance, never an empty publication followed by a patch. */
	async withSelectedFirstPatchTransaction<T>(
		selection: ScopeSelection, snapshot: Snapshot, action: (transaction: SelectedRuntimePatchTransaction) => T,
		revalidateNativePolicy: () => void, signal?: AbortSignal, allowCreateOrigin = false,
	): Promise<T> {
		const memory = this.memory;
		const check = () => {
			signal?.throwIfAborted();
			if (!allowCreateOrigin) throw new Error("Selected first authoring requires explicit native origin authority");
			if (this.memory !== memory) throw new Error("Selected first authoring selection changed concurrently");
			revalidateNativePolicy();
		};
		check();
		const wanted = captureScopeSelection(selection);
		let result: T;
		const author: NonNullable<SelectedOriginRequest["author"]> = (basis, publish) => {
			check();
			result = action(Object.freeze<SelectedRuntimePatchTransaction>({
				selection: captureScopeSelection(basis.view.selection), states: readTemporalScopes(basis.view, 0, this.historyLimit), modules: selectedModules(basis.view),
				snapshot: basis.snapshot, causalBasis: basis.view.lineage.at(-1)!.id, provenance: basis.provenance,
				publish: (next, transition, provenance, moduleAdditions) => {
					check();
					return publish(next, transition, provenance, captureSelectedModuleAdditions(moduleAdditions, wanted));
				},
			}));
		};
		await this.withSelectedOriginAcceptance({ kind: wanted.includes("session") ? "new" : "shared-new", selection: wanted, snapshot, historyLimit: this.historyLimit, author },
			publish => { check(); publish(); }, signal, allowCreateOrigin);
		return result!;
	}

	/** Same-session current acceptance/authoring; native policy checks are synchronous under exclusion. */
	async withSelectedCurrentTransaction<T>(
		selection: ScopeSelection, action: (current: Snapshot,
			publish: (snapshot?: Snapshot) => SelectedFilePublication,
			transaction: SelectedRuntimePatchTransaction) => T,
		revalidateNativePolicy: () => void, signal?: AbortSignal, requiredPresent?: ScopeSelection,
	): Promise<T> {
		const wanted = captureScopeSelection(selection);
		const required = requiredPresent === undefined ? [] : captureScopeSelection(requiredPresent);
		if (required.some(scope => !wanted.includes(scope))) throw new Error("Current acceptance cannot prove an excluded recovery owner");
		const historyLimit = this.historyLimit;
		const assertAuthority = (): void => {
			signal?.throwIfAborted();
			if (typeof revalidateNativePolicy !== "function") throw new Error("Selected current acceptance requires independent native policy authority");
			if (historyLimit !== this.historyLimit) throw new Error("Selected current history policy changed concurrently");
			revalidateNativePolicy();
		};
		assertAuthority();
		if (!lstatSync(this.root, { throwIfNoEntry: false })) throw new RevisionUnavailableError("Selected current session storage is unavailable");
		return withStorageTransaction(this.root, (storage) => {
			assertAuthority();
			const base = storage.prepareSelectedCurrent(this.cwd, this.sessionId, wanted, historyLimit, this.root, this.sessionKey);
			for (const scope of required) {
				const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
				if ([paths.checkpoint, paths.patches, paths.meta].some(path => !base.basis.files.some(file => file.path === path && file.identity !== "missing"))) {
					throw new RevisionUnavailableError(`State Flow ${scope} recovery requires a complete current cohort; missing files do not prove an accepted reset`);
				}
			}
			this.rememberSessionAuthority(base.basis);
			if (this.privateAcquisitionEvidence === "acquired" && base.lifecycle.runtime.meta.privateAcquisition !== "acquired") throw new Error("Known acquired State Flow private authority cannot be downgraded");
			this.observedSessionAuthority = true;
			this.privateAcquisitionEvidence = base.lifecycle.runtime.meta.privateAcquisition;
			const current = selectedRunSnapshot(base);
			let consumed = false, published = false, authorActive = true;
			const publish = (snapshot?: Snapshot, accepted?: AcceptedTransition, requestedProvenance?: SelectedProvenanceUpdates, requestedModules?: SelectedModuleAdditions): SelectedFilePublication => {
				if (!authorActive) throw new Error("Selected current authoring has ended");
				if (consumed) throw new Error("Selected current acceptance publication was already consumed");
				consumed = true;
				assertAuthority();
				const lifecycle = snapshot === undefined ? undefined : captureLifecycleSnapshot(snapshot);
				const transition = captureSelectedReplay(accepted, wanted);
				const provenance = captureSelectedProvenanceUpdates(requestedProvenance, wanted);
				const moduleAdditions = captureSelectedModuleAdditions(requestedModules, wanted);
				const publication = storage.acceptSelectedCurrent(this.cwd, this.sessionId, { selection: wanted, historyLimit, lifecycle, transition, provenance, moduleAdditions }, base, this.root, this.sessionKey);
				this.installSelected(publication.cohort);
				published = true;
				return publication;
			};
			try {
				const result = action(current, snapshot => publish(snapshot), Object.freeze<SelectedRuntimePatchTransaction>({
					selection: wanted, states: readTemporalScopes(base.view, 0, historyLimit), modules: selectedModules(base.view), snapshot: structuredClone(current),
					causalBasis: base.view.lineage.at(-1)!.id, provenance: structuredClone(base.provenance), publish,
				}));
				if (!published) throw new Error("Selected current acceptance requires one synchronous publication");
				return result;
			} finally { authorActive = false; }
		}, signal);
	}

	/** Prepare may read persisted native identity outside exclusion; recheck must use in-memory native policy only. */
	async withSelectedForkCopyTransaction<T>(
		request: SelectedForkCopyRequest, action: (publish: () => SelectedFilePublication) => T,
		revalidateDirectParent: (source: Readonly<SessionAddress>, phase: "prepare" | "recheck") => void, signal?: AbortSignal,
	): Promise<T> {
		return this.withSelectedOriginAcceptance(request, action, signal, true, revalidateDirectParent);
	}

	private async withSelectedOriginAcceptance<T>(
		request: SelectedSessionAcquisitionRequest | SelectedForkCopyRequest | (SelectedOriginRequest & { kind: "shared-new" | "shared-deferred" }),
		action: (publish: () => SelectedFilePublication) => T, signal: AbortSignal | undefined, allowed: boolean,
		revalidateDirectParent?: (source: Readonly<SessionAddress>, phase: "prepare" | "recheck") => void,
	): Promise<T> {
		if (!["shared-new", "shared-deferred", "new", "unacquired", "fork-new", "fork-deferred"].includes(request.kind)) throw new Error("Invalid selected origin admission kind");
		const kind = request.kind;
		const historyLimit = request.historyLimit;
		const wanted = captureScopeSelection(request.selection);
		const lifecycle = captureLifecycleSnapshot(request.snapshot);
		const requestedAuthor = request.author;
		const base = kind === "unacquired" || kind === "fork-deferred" ? structuredClone(request.base) : undefined;
		const copying = kind === "fork-new" || kind === "fork-deferred";
		const source = copying ? Object.freeze({ ...request.source }) : undefined;
		const acquiring = kind === "new" || kind === "unacquired" || copying;
		const install = (accepted: SelectedFilePublication) => {
			this.observedSessionAuthority = true;
			this.installSelected(accepted.cohort);
		};
		const author: SelectedOriginRequest["author"] = requestedAuthor ? (basis, publish) => requestedAuthor(basis, (snapshot, transition, provenance, moduleAdditions) => {
			const accepted = publish(snapshot, transition, provenance, captureSelectedModuleAdditions(moduleAdditions, wanted));
			install(accepted);
			return accepted;
		}) : undefined;
		const assertAuthority = (phase: "prepare" | "recheck" = "recheck"): void => {
			signal?.throwIfAborted();
			if (!allowed) throw new Error(acquiring ? "Selected private acquisition requires explicit native authority" : kind === "shared-deferred" ? "Selected fork deferral requires explicit native fork authority" : "Selected State Flow shared origin requires explicit new-session authority");
			if (wanted.includes("session") !== acquiring) throw new Error(acquiring ? "Selected private acquisition requires Session" : "Selected shared origin cannot acquire Session");
			if (lifecycle.config.mode === "off") throw new Error("Off cannot initialize State Flow memory");
			if (historyLimit !== this.historyLimit) throw new Error("Selected origin history policy does not match its runtime");
			if (copying) {
				if (!source || typeof source.id !== "string" || typeof source.key !== "string" || source.id === this.sessionId || source.key === this.sessionKey) throw new Error("Selected fork requires a distinct direct parent");
				if (typeof revalidateDirectParent !== "function") throw new Error("Selected fork copy requires independent native direct-parent authority");
				revalidateDirectParent(source, phase);
			}
			if (kind === "unacquired" || kind === "fork-deferred") {
				if (this.privateAcquisitionEvidence === "acquired") throw new Error("Known acquired State Flow private memory cannot become an empty origin");
			} else if (this.observedSessionAuthority) {
				throw new Error("Known State Flow session requires current-memory acceptance, not a new origin");
			}
		};
		assertAuthority("prepare");
		if (kind === "unacquired" || copying) {
			if (!lstatSync(this.root, { throwIfNoEntry: false })) throw new RevisionUnavailableError("Selected private acquisition source storage is unavailable");
		} else initializeFileStore(this.root);
		return withStorageTransaction(this.root, (storage) => {
			assertAuthority();
			let consumed = false;
			let published = false;
			const result = action(() => {
				if (consumed) throw new Error("Selected State Flow origin publication was already consumed");
				consumed = true;
				assertAuthority();
				const input = { selection: wanted, snapshot: lifecycle, historyLimit: this.historyLimit, ...(author ? { author } : {}) };
				const accepted = kind === "shared-new"
					? storage.initializeSelectedSharedOrigin(this.cwd, this.sessionId, input, this.root, this.sessionKey)
					: kind === "shared-deferred" ? storage.deferSelectedFork(this.cwd, this.sessionId, input, this.root, this.sessionKey)
					: copying ? storage.copySelectedFork(this.cwd, this.sessionId, kind === "fork-new" ? { ...input, kind, source: source! } : { ...input, kind: "fork-deferred", source: source!, base: base! }, this.root, this.sessionKey)
					: storage.acquireSelectedSession(this.cwd, this.sessionId, kind === "new" ? { ...input, kind: "new" } : { ...input, kind: "unacquired", base: base! }, this.root, this.sessionKey);
				if (!author) install(accepted);
				published = true;
				return accepted;
			});
			if (!published) throw new Error("Selected State Flow origin requires one synchronous publication");
			return result;
		}, signal);
	}
}
