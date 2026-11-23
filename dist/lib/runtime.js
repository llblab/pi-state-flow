import { lstatSync } from "node:fs";
import { classifyScopeStream, sessionRuntimePaths, temporalScopePaths } from "./durable.js";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.js";
import { isObject, sameJson } from "./json.js";
import { captureScopeSelection } from "./selection.js";
import { RevisionUnavailableError, retainedBoundaryCheckpoint, captureLifecycleSnapshot } from "./snapshot.js";
import { assertTemporalFileBase, captureSelectedModuleAdditions, captureSelectedProvenanceUpdates, temporalFileContents, initializeFileStore, withStorageTransaction } from "./storage.js";
import { readTemporalScopes, readTemporalState, readTemporalView, selectTemporalState } from "./temporal.js";
function selectedModules(view) {
    return Object.fromEntries(view.selection.filter(scope => view.scopes[scope]?.modules !== undefined)
        .map(scope => [scope, structuredClone(view.scopes[scope].modules)]));
}
function selectedRunSnapshot(cohort) {
    const source = cohort.lifecycle.runtime;
    const meta = { step: source.meta.step, ...Object.fromEntries(["specification", "bootstrap", "validation"]
            .filter((key) => Object.hasOwn(source.meta, key)).map((key) => [key, source.meta[key]])) };
    return captureLifecycleSnapshot({ config: { mode: source.config.mode }, meta });
}
/** Detached replay inputs; excluded patch bodies must not be touched even for a rejected raw replay. */
function captureSelectedReplay(accepted, selection) {
    if (accepted === undefined)
        return undefined;
    if (!isObject(accepted) || !Array.isArray(accepted.transitions))
        throw new Error("Invalid selected runtime replay");
    for (const item of accepted.transitions)
        if (!isObject(item) || !selection.includes(item.scope))
            throw new Error("Selected runtime replay contains an excluded owner");
    return structuredClone(accepted);
}
function scopeLabel(scope) {
    return scope === "cwd" ? "CWD" : scope;
}
/** Precise fail-closed conflict for a shared scope this transition actually overwrites. */
function targetScopeConflict(scopes) {
    const labels = scopes.map(scopeLabel);
    if (labels.length === 1) {
        return new Error(`State Flow cannot publish the ${labels[0]} patch because the live ${labels[0]} state advanced after this transition's selected basis. Refresh or reconcile the target scope before retrying.`);
    }
    return new Error(`State Flow cannot publish the ${labels.join(" and ")} patches because the live ${labels.join(" and ")} states advanced after this transition's selected basis. Refresh or reconcile the target scopes before retrying.`);
}
/** A replay target disappeared; reconcile it through current acceptance before retrying. */
export class SharedScopeRemovalConflictError extends Error {
    scopes;
    constructor(scopes) {
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
    memory;
    acceptedCurrentMemory = false;
    observedSessionAuthority = false;
    observedPrivateSemantics = false;
    cwd;
    session;
    root;
    historyLimit;
    constructor(cwd, session, root, sessionKey, historyLimit = DEFAULT_HISTORY_LIMIT) {
        this.cwd = cwd;
        this.session = Object.freeze(typeof session === "string" ? { id: session, key: sessionKey ?? session } : { ...session });
        this.root = root;
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > MAX_HISTORY_LIMIT)
            throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
        this.historyLimit = historyLimit;
    }
    get sessionId() { return this.session.id; }
    get sessionKey() { return this.session.key; }
    /** Revoke cache-dependent leases without forgetting known owner or acquisition evidence. */
    clearCache() {
        this.memory = undefined;
    }
    rememberSessionAuthority(base) {
        const privatePaths = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
        const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
        const privateFiles = new Set([privatePaths.checkpoint, privatePaths.patches, privatePaths.meta]);
        for (const file of base.files)
            if (file.identity !== "missing") {
                if (privateFiles.has(file.path))
                    this.observedPrivateSemantics = true;
                if (privateFiles.has(file.path) || file.path === paths.config || file.path === paths.runtime)
                    this.observedSessionAuthority = true;
            }
    }
    /** Only owned durable acceptance calls this; returned receipts and read-only candidates are not installers. */
    installSelected(cohort) {
        this.memory = { kind: "selected", cohort: structuredClone(cohort) };
        this.acceptedCurrentMemory = true;
    }
    installObserved(observation) {
        this.memory = { kind: "observed", observation: structuredClone(observation) };
    }
    observationGuard(revalidateNativePolicy, signal) {
        const memory = this.memory;
        return () => {
            signal?.throwIfAborted();
            if (this.acceptedCurrentMemory)
                throw new Error("Accepted State Flow memory requires current acceptance, not observation");
            if (this.memory !== memory)
                throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
            if (typeof revalidateNativePolicy !== "function")
                throw new Error("Selected observation requires independent native policy authority");
            revalidateNativePolicy();
        };
    }
    selectedReadCache() {
        if (this.memory?.kind === "selected")
            return this.memory.cohort;
        if (this.memory?.kind === "observed")
            return this.memory.observation;
        return undefined;
    }
    /** Detached read-only selected values; never accepted run fields or a publication/acquisition basis. */
    observedSelectedView() {
        return this.memory?.kind === "observed" ? structuredClone(this.memory.observation.view) : undefined;
    }
    /** Shared owners proven absent by a completed read-only observation; no empty streams are synthesized. */
    observedAbsentSharedScopes() {
        if (this.memory?.kind !== "observed")
            return [];
        const { selection, view } = this.memory.observation;
        return selection.filter(scope => scope !== "session" && !view?.selection.includes(scope));
    }
    /** Explicit shared inspection before acquisition; missing owners stay unavailable rather than becoming empty streams. */
    async refreshSelectedShared(selection, revalidateNativePolicy, signal) {
        const wanted = captureScopeSelection(selection);
        if (wanted.includes("session"))
            throw new Error("Shared State Flow observation cannot select Session");
        const assertAuthority = this.observationGuard(revalidateNativePolicy, signal);
        const install = (observation) => {
            assertAuthority();
            this.installObserved(observation);
            return observation.view !== undefined;
        };
        assertAuthority();
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            return install({ selection: wanted, provenance: {} });
        return withStorageTransaction(this.root, storage => {
            assertAuthority();
            return install(storage.observeSelectedShared(this.cwd, wanted, this.root));
        }, signal);
    }
    /** Header-only disposition data; never semantic observation, acceptance, or acquisition permission. */
    async inspectSelectedLifecycle(selection, revalidateNativePolicy, signal) {
        const wanted = captureScopeSelection(selection);
        const memory = this.memory;
        const check = () => {
            signal?.throwIfAborted();
            if (this.memory !== memory)
                throw new Error("State Flow attachment selection changed");
            revalidateNativePolicy();
        };
        check();
        if (!lstatSync(this.root, { throwIfNoEntry: false })) {
            if (this.observedSessionAuthority)
                throw new RevisionUnavailableError("Known selected session authority is unavailable");
            return undefined;
        }
        return withStorageTransaction(this.root, storage => {
            check();
            const lifecycle = storage.inspectSelectedLifecycle(this.cwd, this.sessionId, wanted, this.root, this.sessionKey);
            check();
            if (!lifecycle) {
                if (this.observedSessionAuthority)
                    throw new RevisionUnavailableError("Known selected session authority is unavailable");
                return undefined;
            }
            if (this.observedPrivateSemantics && lifecycle.runtime.meta.privateAcquisition !== "acquired")
                throw new Error("Known acquired State Flow private authority cannot be downgraded");
            this.observedSessionAuthority = true;
            if (lifecycle.runtime.meta.privateAcquisition === "acquired")
                this.observedPrivateSemantics = true;
            return { selection: captureScopeSelection(lifecycle.runtime.config.scopes), privateAcquisition: lifecycle.runtime.meta.privateAcquisition,
                snapshot: selectedRunSnapshot({ lifecycle }) };
        }, signal);
    }
    /** Native bookmarks never decide whether current canonical authority exists. */
    async hasSelectedCurrentAuthority(selection, revalidateNativePolicy, signal) {
        return await this.inspectSelectedLifecycle(selection, revalidateNativePolicy, signal) !== undefined;
    }
    /** Fenced inactive restoration/operator inspection: source proof only, without conversion or durable acceptance. */
    async refreshSelectedCurrent(selection, revalidateNativePolicy, signal) {
        const wanted = captureScopeSelection(selection);
        const assertAuthority = this.observationGuard(revalidateNativePolicy, signal);
        assertAuthority();
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            throw new RevisionUnavailableError("Selected current session storage is unavailable");
        return withStorageTransaction(this.root, storage => {
            assertAuthority();
            const current = storage.prepareSelectedCurrent(this.cwd, this.sessionId, wanted, this.historyLimit, this.root, this.sessionKey);
            if (this.observedPrivateSemantics && current.lifecycle.runtime.meta.privateAcquisition !== "acquired")
                throw new Error("Known acquired State Flow private authority cannot be downgraded");
            // Current acceptance can plan absent shared owners; observation must not expose those planned empty streams.
            const present = wanted.filter(scope => {
                const path = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).checkpoint;
                return current.basis.files.some(file => file.path === path && file.identity !== "missing");
            });
            const observation = { selection: wanted,
                provenance: Object.fromEntries(present.map(scope => [scope, current.provenance[scope]])),
                ...(present.length === 0 ? {} : { view: selectTemporalState(current.view, captureScopeSelection(present), this.historyLimit) }), };
            const snapshot = selectedRunSnapshot(current);
            assertAuthority();
            this.rememberSessionAuthority(current.basis);
            if (current.lifecycle.runtime.meta.privateAcquisition === "acquired")
                this.observedPrivateSemantics = true;
            this.installObserved(observation);
            return snapshot;
        }, signal);
    }
    /** Detached accepted selected values only, never a file receipt or publication capability. */
    selectedView() {
        return this.memory?.kind === "selected" ? structuredClone(this.memory.cohort.view) : undefined;
    }
    /** Accepted run fields only; local policy and pending native prompts remain the adapter's responsibility. */
    selectedSnapshot() {
        if (this.memory?.kind !== "selected")
            throw new Error("Selected State Flow runtime is unavailable");
        return selectedRunSnapshot(this.memory.cohort);
    }
    /** Native bookkeeping may change mode, never invent accepted run fields or a semantic boundary. */
    retainedSelectedCheckpoint(mode) {
        const memory = this.memory;
        if (memory?.kind !== "selected")
            throw new Error("Selected State Flow runtime is unavailable");
        const snapshot = selectedRunSnapshot(memory.cohort);
        if (mode !== undefined)
            snapshot.config.mode = mode;
        return { ...retainedBoundaryCheckpoint(snapshot, memory.cohort.view.lineage.at(-1).id), version: 2, scopes: captureScopeSelection(memory.cohort.view.selection) };
    }
    /** Read-only cache identity lease; no source acquisition, storage receipt or publication authority. */
    captureSelectedReadBasis() {
        const memory = this.memory;
        if (!this.selectedReadCache()?.view)
            throw new Error("Selected State Flow runtime is unavailable");
        return () => { if (this.memory !== memory)
            throw new Error("State Flow module context content basis changed"); };
    }
    /** Exact present owners for the existing selected staging engine; no defaulted disabled scopes. */
    selectedStates(offset = 0) {
        const view = this.selectedReadCache()?.view;
        if (!view)
            throw new Error("Selected State Flow runtime is unavailable");
        return { selection: captureScopeSelection(view.selection), states: readTemporalScopes(view, offset, this.historyLimit) };
    }
    /** Runtime-owned artifact compilation evidence for one scope; never model-visible state. */
    artifactProvenance(scope) {
        const selected = this.selectedReadCache();
        if (!selected?.view)
            throw new Error(`State Flow ${scope} scope is excluded or unavailable`);
        if (!selected.view.selection.includes(scope))
            throw new Error(`State Flow ${scope} scope is excluded`);
        return structuredClone(selected.provenance[scope]);
    }
    read(offset = 0, scope) {
        const view = this.selectedReadCache()?.view;
        if (!view)
            throw new Error("State Flow temporal runtime is unavailable");
        return readTemporalState(view, offset, scope, this.historyLimit);
    }
    readView(offset = 0, scope) {
        const view = this.selectedReadCache()?.view;
        if (!view)
            throw new Error("State Flow temporal runtime is unavailable");
        return readTemporalView(view, offset, scope, this.historyLimit);
    }
    causalBasis() {
        const view = this.selectedReadCache()?.view;
        if (!view)
            throw new Error("State Flow temporal runtime is unavailable");
        return view.lineage.at(-1).id;
    }
    recent() {
        const view = this.selectedReadCache()?.view;
        if (!view)
            return [];
        const result = [];
        for (const boundary of view.lineage.slice(1)) {
            const transitions = view.selection.flatMap((scope) => {
                const record = view.scopes[scope].patches.find(({ transition }) => transition.id === boundary.id);
                return record ? [{ scope, patch: structuredClone(record.patch) }] : [];
            });
            if (transitions.length)
                result.push({ id: boundary.id, at: boundary.position, transitions });
        }
        return result;
    }
    /** Authored under exclusion against validated live selected values; use the existing selected staging/commit engine. */
    async withSelectedPatchTransaction(action, revalidateNativePolicy, signal, capturedTargets = []) {
        return this.withSelectedPublicationTransaction(action, "current", revalidateNativePolicy, signal, capturedTargets);
    }
    /** Mode-only Passive persistence: exact accepted sources, no current-origin adoption or caller-authored run fields. */
    async persistSelectedPassive(revalidateNativePolicy, signal) {
        const memory = this.memory;
        if (memory?.kind !== "selected")
            throw new Error("Selected State Flow runtime is unavailable");
        const assertAuthority = () => {
            signal?.throwIfAborted();
            if (this.memory !== memory)
                throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
            if (typeof revalidateNativePolicy !== "function")
                throw new Error("Selected Passive persistence requires independent native policy authority");
            revalidateNativePolicy();
        };
        assertAuthority();
        return withStorageTransaction(this.root, storage => {
            assertAuthority();
            const publication = storage.persistSelectedPassive(this.cwd, this.sessionId, memory.cohort, this.root, this.sessionKey);
            if (publication.changed)
                this.installSelected(publication.cohort);
            return publication;
        }, signal);
    }
    /** Precomputed replay remains tied to its accepted cache; changed selected shared targets conflict before publication. */
    async publishSelected(snapshot, accepted, revalidateNativePolicy, options = {}) {
        if (this.memory?.kind !== "selected")
            throw new Error("Selected State Flow runtime is unavailable");
        const provenance = captureSelectedProvenanceUpdates(options.provenance, this.memory.cohort.view.selection);
        const replay = captureSelectedReplay(accepted, this.memory.cohort.view.selection);
        const additions = captureSelectedModuleAdditions(options.moduleAdditions, this.memory.cohort.view.selection);
        const lifecycle = captureLifecycleSnapshot(snapshot);
        return this.withSelectedPublicationTransaction(transaction => transaction.publish(lifecycle, replay, provenance, additions), "replay", revalidateNativePolicy, options.signal);
    }
    async withSelectedPublicationTransaction(action, kind, revalidateNativePolicy, signal, capturedTargets = []) {
        const memory = this.memory;
        if (memory?.kind !== "selected")
            throw new Error("Selected State Flow runtime is unavailable");
        const selection = captureScopeSelection(memory.cohort.view.selection);
        const targets = capturedTargets.length ? captureScopeSelection(capturedTargets) : undefined;
        if (targets?.some(scope => !selection.includes(scope)))
            throw new Error("Captured State Flow write target is excluded");
        const assertAuthority = () => {
            signal?.throwIfAborted();
            if (this.memory !== memory)
                throw new Error("Selected State Flow runtime selection or acceptance changed concurrently");
            if (typeof revalidateNativePolicy !== "function")
                throw new Error("Selected semantic transaction requires independent native policy authority");
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
            assertTemporalFileBase({ files: memory.cohort.basis.files.filter(file => !sharedPaths.has(file.path)) }, { files: current.basis.files.filter(file => !sharedPaths.has(file.path)) });
            if (!sameJson(memory.cohort.presence, current.presence))
                throw new Error("Selected State Flow presence dependencies changed concurrently");
            if (targets)
                this.assertSelectedReplayTargets(memory.cohort, current, undefined, undefined, undefined, targets);
            let consumed = false;
            let published = false;
            const result = action(Object.freeze({
                selection, states: readTemporalScopes(current.view, 0, this.historyLimit), modules: selectedModules(current.view), snapshot: selectedRunSnapshot(current),
                causalBasis: current.view.lineage.at(-1).id, provenance: structuredClone(current.provenance),
                publish: (snapshot, accepted, requestedProvenance, requestedModules) => {
                    if (consumed)
                        throw new Error("Selected semantic transaction publication was already consumed");
                    consumed = true;
                    assertAuthority();
                    const provenance = captureSelectedProvenanceUpdates(requestedProvenance, selection);
                    const transition = captureSelectedReplay(accepted, selection);
                    const moduleAdditions = captureSelectedModuleAdditions(requestedModules, selection);
                    if (kind === "replay")
                        this.assertSelectedReplayTargets(memory.cohort, current, transition, provenance, moduleAdditions);
                    const publication = storage.acceptSelectedCurrent(this.cwd, this.sessionId, { selection, historyLimit: this.historyLimit, lifecycle: captureLifecycleSnapshot(snapshot), transition, provenance, moduleAdditions }, current, this.root, this.sessionKey);
                    this.installSelected(publication.cohort);
                    published = true;
                    return publication;
                },
            }));
            if (!published)
                throw new Error("Selected semantic transaction requires one synchronous publication");
            return result;
        }, signal);
    }
    assertSelectedReplayTargets(base, current, transition, provenance, additions, capturedTargets = []) {
        const targets = new Set([...capturedTargets, ...(transition?.transitions.map(item => item.scope) ?? []), ...Object.keys(provenance ?? {}), ...Object.keys(additions ?? {})]);
        const files = temporalFileContents(current.basis);
        const changed = [], removed = [];
        for (const scope of base.view.selection.filter(scope => scope !== "session" && targets.has(scope))) {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            const live = classifyScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta));
            if (live.kind === "absent") {
                removed.push(scope);
                continue;
            }
            if (!sameJson(live.stream, base.view.scopes[scope]) || !sameJson(current.provenance[scope], base.provenance[scope]))
                changed.push(scope);
        }
        if (removed.length > 0)
            throw new SharedScopeRemovalConflictError(removed);
        if (changed.length > 0)
            throw targetScopeConflict(changed);
    }
    /** New-session shared-only acceptance; caller rechecks native origin authority after waiting. */
    async withSelectedSharedOriginTransaction(selection, snapshot, action, signal, allowCreateOrigin = false) {
        return this.withSelectedOriginAcceptance({ kind: "shared-new", selection, snapshot, historyLimit: this.historyLimit }, action, signal, allowCreateOrigin);
    }
    /** Child-owned deferred marker only; no parent locator or parent memory is acquired here. */
    async withSelectedDeferredForkTransaction(selection, lifecycle, action, signal, allowDeferFork = false, modeAtPublication) {
        if (!lifecycle || Object.keys(lifecycle).some((key) => key !== "mode" && key !== "bootstrap")
            || (lifecycle.bootstrap !== undefined && lifecycle.bootstrap !== true))
            throw new Error("Invalid selected fork lifecycle");
        if (modeAtPublication !== undefined && typeof modeAtPublication !== "function")
            throw new Error("Invalid selected fork mode sampler");
        const snapshot = { config: { mode: lifecycle.mode }, meta: { step: 0, ...(lifecycle.bootstrap ? { bootstrap: true } : {}) } };
        // Sample mode only; callers cannot replace the fresh child run fields through this hook.
        const author = modeAtPublication ? (basis, publish) => {
            const mode = modeAtPublication();
            signal?.throwIfAborted();
            publish({ config: { mode }, meta: basis.snapshot.meta });
        } : undefined;
        return this.withSelectedOriginAcceptance({ kind: "shared-deferred", selection, snapshot, historyLimit: this.historyLimit, author }, action, signal, allowDeferFork);
    }
    /** Explicit first private acquisition, never deferred-parent recovery or repair of lost acquired state. */
    async withSelectedSessionAcquisitionTransaction(request, action, signal, allowAcquirePrivate = false) {
        return this.withSelectedOriginAcceptance(request, action, signal, allowAcquirePrivate);
    }
    /** Stage first lifecycle/semantic authoring into one origin acceptance, never an empty publication followed by a patch. */
    async withSelectedFirstPatchTransaction(selection, snapshot, action, revalidateNativePolicy, signal, allowCreateOrigin = false) {
        const memory = this.memory;
        const check = () => {
            signal?.throwIfAborted();
            if (!allowCreateOrigin)
                throw new Error("Selected first authoring requires explicit native origin authority");
            if (this.memory !== memory)
                throw new Error("Selected first authoring selection changed concurrently");
            revalidateNativePolicy();
        };
        check();
        const wanted = captureScopeSelection(selection);
        let result;
        const author = (basis, publish) => {
            check();
            result = action(Object.freeze({
                selection: captureScopeSelection(basis.view.selection), states: readTemporalScopes(basis.view, 0, this.historyLimit), modules: selectedModules(basis.view),
                snapshot: basis.snapshot, causalBasis: basis.view.lineage.at(-1).id, provenance: basis.provenance,
                publish: (next, transition, provenance, moduleAdditions) => {
                    check();
                    return publish(next, transition, provenance, captureSelectedModuleAdditions(moduleAdditions, wanted));
                },
            }));
        };
        await this.withSelectedOriginAcceptance({ kind: wanted.includes("session") ? "new" : "shared-new", selection: wanted, snapshot, historyLimit: this.historyLimit, author }, publish => { check(); publish(); }, signal, allowCreateOrigin);
        return result;
    }
    /** Same-session current acceptance/authoring; native policy checks are synchronous under exclusion. */
    async withSelectedCurrentTransaction(selection, action, revalidateNativePolicy, signal) {
        const wanted = captureScopeSelection(selection);
        const historyLimit = this.historyLimit;
        const assertAuthority = () => {
            signal?.throwIfAborted();
            if (typeof revalidateNativePolicy !== "function")
                throw new Error("Selected current acceptance requires independent native policy authority");
            if (historyLimit !== this.historyLimit)
                throw new Error("Selected current history policy changed concurrently");
            revalidateNativePolicy();
        };
        assertAuthority();
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            throw new RevisionUnavailableError("Selected current session storage is unavailable");
        return withStorageTransaction(this.root, (storage) => {
            assertAuthority();
            const base = storage.prepareSelectedCurrent(this.cwd, this.sessionId, wanted, historyLimit, this.root, this.sessionKey);
            this.rememberSessionAuthority(base.basis);
            if (this.observedPrivateSemantics && base.lifecycle.runtime.meta.privateAcquisition !== "acquired")
                throw new Error("Known acquired State Flow private authority cannot be downgraded");
            this.observedSessionAuthority = true;
            if (base.lifecycle.runtime.meta.privateAcquisition === "acquired")
                this.observedPrivateSemantics = true;
            const current = selectedRunSnapshot(base);
            let consumed = false, published = false, authorActive = true;
            const publish = (snapshot, accepted, requestedProvenance, requestedModules) => {
                if (!authorActive)
                    throw new Error("Selected current authoring has ended");
                if (consumed)
                    throw new Error("Selected current acceptance publication was already consumed");
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
                const result = action(current, snapshot => publish(snapshot), Object.freeze({
                    selection: wanted, states: readTemporalScopes(base.view, 0, historyLimit), modules: selectedModules(base.view), snapshot: structuredClone(current),
                    causalBasis: base.view.lineage.at(-1).id, provenance: structuredClone(base.provenance), publish,
                }));
                if (!published)
                    throw new Error("Selected current acceptance requires one synchronous publication");
                return result;
            }
            finally {
                authorActive = false;
            }
        }, signal);
    }
    /** Prepare may read persisted native identity outside exclusion; recheck must use in-memory native policy only. */
    async withSelectedForkCopyTransaction(request, action, revalidateDirectParent, signal) {
        return this.withSelectedOriginAcceptance(request, action, signal, true, revalidateDirectParent);
    }
    async withSelectedOriginAcceptance(request, action, signal, allowed, revalidateDirectParent) {
        if (!["shared-new", "shared-deferred", "new", "unacquired", "fork-new", "fork-deferred"].includes(request.kind))
            throw new Error("Invalid selected origin admission kind");
        const kind = request.kind;
        const historyLimit = request.historyLimit;
        const wanted = captureScopeSelection(request.selection);
        const lifecycle = captureLifecycleSnapshot(request.snapshot);
        const requestedAuthor = request.author;
        const base = kind === "unacquired" || kind === "fork-deferred" ? structuredClone(request.base) : undefined;
        const copying = kind === "fork-new" || kind === "fork-deferred";
        const source = copying ? Object.freeze({ ...request.source }) : undefined;
        const acquiring = kind === "new" || kind === "unacquired" || copying;
        const install = (accepted) => {
            this.observedSessionAuthority = true;
            if (acquiring)
                this.observedPrivateSemantics = true;
            this.installSelected(accepted.cohort);
        };
        const author = requestedAuthor ? (basis, publish) => requestedAuthor(basis, (snapshot, transition, provenance, moduleAdditions) => {
            const accepted = publish(snapshot, transition, provenance, captureSelectedModuleAdditions(moduleAdditions, wanted));
            install(accepted);
            return accepted;
        }) : undefined;
        const assertAuthority = (phase = "recheck") => {
            signal?.throwIfAborted();
            if (!allowed)
                throw new Error(acquiring ? "Selected private acquisition requires explicit native authority" : kind === "shared-deferred" ? "Selected fork deferral requires explicit native fork authority" : "Selected State Flow shared origin requires explicit new-session authority");
            if (wanted.includes("session") !== acquiring)
                throw new Error(acquiring ? "Selected private acquisition requires Session" : "Selected shared origin cannot acquire Session");
            if (lifecycle.config.mode === "off")
                throw new Error("Off cannot initialize State Flow memory");
            if (historyLimit !== this.historyLimit)
                throw new Error("Selected origin history policy does not match its runtime");
            if (copying) {
                if (!source || typeof source.id !== "string" || typeof source.key !== "string" || source.id === this.sessionId || source.key === this.sessionKey)
                    throw new Error("Selected fork requires a distinct direct parent");
                if (typeof revalidateDirectParent !== "function")
                    throw new Error("Selected fork copy requires independent native direct-parent authority");
                revalidateDirectParent(source, phase);
            }
            if (kind === "unacquired" || kind === "fork-deferred") {
                if (this.observedPrivateSemantics)
                    throw new Error("Known acquired State Flow private memory cannot become an empty origin");
            }
            else if (this.observedSessionAuthority) {
                throw new Error("Known State Flow session requires current-memory acceptance, not a new origin");
            }
        };
        assertAuthority("prepare");
        if (kind === "unacquired" || copying) {
            if (!lstatSync(this.root, { throwIfNoEntry: false }))
                throw new RevisionUnavailableError("Selected private acquisition source storage is unavailable");
        }
        else
            initializeFileStore(this.root);
        return withStorageTransaction(this.root, (storage) => {
            assertAuthority();
            let consumed = false;
            let published = false;
            const result = action(() => {
                if (consumed)
                    throw new Error("Selected State Flow origin publication was already consumed");
                consumed = true;
                assertAuthority();
                const input = { selection: wanted, snapshot: lifecycle, historyLimit: this.historyLimit, ...(author ? { author } : {}) };
                const accepted = kind === "shared-new"
                    ? storage.initializeSelectedSharedOrigin(this.cwd, this.sessionId, input, this.root, this.sessionKey)
                    : kind === "shared-deferred" ? storage.deferSelectedFork(this.cwd, this.sessionId, input, this.root, this.sessionKey)
                        : copying ? storage.copySelectedFork(this.cwd, this.sessionId, kind === "fork-new" ? { ...input, kind, source: source } : { ...input, kind: "fork-deferred", source: source, base: base }, this.root, this.sessionKey)
                            : storage.acquireSelectedSession(this.cwd, this.sessionId, kind === "new" ? { ...input, kind: "new" } : { ...input, kind: "unacquired", base: base }, this.root, this.sessionKey);
                if (!author)
                    install(accepted);
                published = true;
                return accepted;
            });
            if (!published)
                throw new Error("Selected State Flow origin requires one synchronous publication");
            return result;
        }, signal);
    }
}
