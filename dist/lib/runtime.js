import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { classifyScopeStream, hasCwdMaterialization, parseScopeProvenance, parseScopeStream, sessionRuntimePaths, temporalScopePaths } from "./durable.js";
import { pruneArtifactProvenance } from "./artifact.js";
import { assertTemporalFileBase, captureTemporalFileBase, initializeFileStore, publishTemporalStateToFiles, withStorageTransaction } from "./storage.js";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.js";
import { hashJson, sameJson } from "./json.js";
import { HistoryBoundaryExpiredError, RevisionUnavailableError, createSessionRuntime, parseSessionRuntime, retainedBoundaryCheckpoint } from "./snapshot.js";
import { emptyState } from "./state.js";
import { adoptTemporalStreams, advanceTemporalState, constrainTemporalState, createTemporalState, readTemporalState, selectScopeStreamAtBoundary, validateScopeLineage } from "./temporal.js";
const SCOPES = ["global", "cwd", "session"];
const SHARED_SCOPES = ["global", "cwd"];
function emptyProvenance() {
    return { global: {}, cwd: {}, session: {} };
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
/** A targeted removed scope was deliberately adopted as empty before refusing the stale semantic patch. */
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
/** Disappearance invalidates a selected write target even though untouched scopes can adopt empty reality. */
function removedTargetScopeConflict(scopes) {
    return new SharedScopeRemovalConflictError(scopes);
}
function freshEmptyScopeStream(scope, origin, historyLimit) {
    return createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, origin, historyLimit).scopes[scope];
}
/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export class TemporalRuntime {
    view;
    base;
    semanticRevision;
    savedRuntime;
    transaction;
    restoredOriginPending = false;
    provenanceByScope = emptyProvenance();
    /** Shared scopes whose wholly absent live basis was accepted after one stale-target refusal. */
    absentSharedScopes = new Set();
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
    /** Runtime-owned artifact compilation evidence for one scope; never model-visible state. */
    artifactProvenance(scope) {
        return structuredClone(this.provenanceByScope[scope]);
    }
    /** Read canonical shared memory without creating, migrating, or publishing storage. */
    loadPassive() {
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            return false;
        return this.loadPassiveBase(captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey));
    }
    loadPassiveBase(base) {
        const files = new Map(base.files.map((file) => [file.path, file.content]));
        const shared = Object.fromEntries(SHARED_SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            return [scope, parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta))];
        }));
        if (!shared.global && !shared.cwd)
            return false;
        if (!shared.global)
            throw new Error("Incomplete passive State Flow shared storage: CWD state exists without global state");
        const fresh = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, randomUUID(), this.historyLimit);
        // Global memory is valid before this CWD has ever materialized its own scope.
        const view = adoptTemporalStreams({ global: shared.global, cwd: shared.cwd ?? fresh.scopes.cwd, session: fresh.scopes.session }, `passive:files:${randomUUID()}`, this.historyLimit);
        const provenance = {
            global: parseScopeProvenance(files.get(temporalScopePaths(this.cwd, this.sessionId, "global", this.root, this.sessionKey).meta), "State Flow global metadata"),
            cwd: parseScopeProvenance(files.get(temporalScopePaths(this.cwd, this.sessionId, "cwd", this.root, this.sessionKey).meta), "State Flow CWD metadata"),
            session: {},
        };
        this.view = view;
        this.base = base;
        this.provenanceByScope = provenance;
        this.semanticRevision = undefined;
        this.savedRuntime = undefined;
        this.restoredOriginPending = false;
        this.absentSharedScopes.clear();
        return true;
    }
    /** Select canonical file acceptance even when Git is available; backup remains a later concern. */
    prepareCanonical() {
        initializeFileStore(this.root);
    }
    /** Canonical preparation is the default; Git backup is a later independent concern. */
    prepare() {
        this.prepareCanonical();
    }
    read(offset = 0, scope) {
        if (!this.view)
            throw new Error("State Flow temporal runtime is unavailable");
        return readTemporalState(this.view, offset, scope, this.historyLimit);
    }
    states() {
        return { global: this.read(0, "global"), cwd: this.read(0, "cwd"), session: this.read(0, "session") };
    }
    causalBasis() {
        if (!this.view)
            throw new Error("State Flow temporal runtime is unavailable");
        return this.view.lineage.at(-1).id;
    }
    /** Encode Pi lifecycle state against the current retained semantic boundary. */
    retainedCheckpoint(snapshot) {
        if (!this.view)
            return { disabled: true };
        return retainedBoundaryCheckpoint(snapshot, this.causalBasis());
    }
    usesCanonicalFiles() {
        return true;
    }
    recent() {
        const result = [];
        for (const boundary of this.view?.lineage.slice(1) ?? []) {
            const transitions = SCOPES.flatMap((scope) => {
                const record = this.view.scopes[scope].patches.find(({ transition }) => transition.id === boundary.id);
                return record ? [{ scope, patch: structuredClone(record.patch) }] : [];
            });
            if (transitions.length)
                result.push({ id: boundary.id, at: boundary.position, transitions });
        }
        return result;
    }
    /** Prepare a retained session boundary from current canonical files; shared scopes remain live. */
    prepareBoundaryRestore(checkpoint) {
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            throw new RevisionUnavailableError("Selected State Flow boundary storage is unavailable");
        return this.prepareBoundaryRestoreBase(checkpoint, captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey));
    }
    prepareBoundaryRestoreBase(checkpoint, base) {
        const files = new Map(base.files.map((file) => [file.path, file.content]));
        const scopes = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta));
            if (!stream)
                throw new RevisionUnavailableError(`State Flow ${scopeLabel(scope)} scope is unavailable for retained-boundary restoration`);
            return [scope, stream];
        }));
        const runtimePaths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
        const document = parseSessionRuntime(files.get(runtimePaths.config), files.get(runtimePaths.runtime), this.cwd, this.sessionId);
        if (!document)
            throw new RevisionUnavailableError("State Flow session runtime is unavailable for retained-boundary restoration");
        // The codecs validate persisted retention against the format maximum, not the new operator limit.
        validateScopeLineage(scopes.session, "session", document.meta.lineage, MAX_HISTORY_LIMIT);
        const boundary = document.meta.lineage.slice(-(this.historyLimit + 1)).find(({ id }) => id === checkpoint.boundary);
        if (!boundary)
            throw new HistoryBoundaryExpiredError("Selected State Flow history boundary is outside the retained temporal window");
        const selectedSession = selectScopeStreamAtBoundary(scopes.session, "session", boundary, MAX_HISTORY_LIMIT);
        const view = adoptTemporalStreams({
            global: scopes.global,
            cwd: scopes.cwd,
            session: selectedSession,
        }, `restore:${checkpoint.boundary}:${randomUUID()}`, this.historyLimit);
        const snapshot = {
            config: { enabled: checkpoint.enabled },
            meta: {
                step: checkpoint.step,
                ...(checkpoint.bootstrap === true ? { bootstrap: true } : {}),
                ...(checkpoint.specification === undefined ? {} : { specification: checkpoint.specification }),
            },
        };
        const provenance = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            const parsed = parseScopeProvenance(files.get(paths.meta), paths.meta);
            const retained = pruneArtifactProvenance(parsed, readTemporalState(view, 0, scope, this.historyLimit).artifacts);
            if (scope === "session") {
                // Live evidence cannot prove an earlier artifact version, even after a change-away-and-back.
                for (const record of scopes.session.patches) {
                    if (record.transition.position <= boundary.position)
                        continue;
                    for (const path of Object.keys(record.patch.artifacts ?? {}))
                        delete retained[path];
                }
            }
            return [scope, retained];
        }));
        let consumed = false;
        return {
            snapshot: structuredClone(snapshot),
            restore: () => {
                if (consumed)
                    throw new Error("Prepared State Flow restore was already consumed");
                consumed = true;
                this.view = view;
                this.base = base;
                this.provenanceByScope = provenance;
                this.semanticRevision = undefined;
                this.savedRuntime = hashJson(createSessionRuntime(snapshot, this.cwd, this.sessionId, view.lineage, provenance.session));
                this.restoredOriginPending = true;
                this.absentSharedScopes.clear();
                return structuredClone(snapshot);
            },
        };
    }
    /** Restore and canonically accept one retained boundary as a single lifecycle operation. */
    restoreBoundary(checkpoint) {
        const prepared = this.prepareBoundaryRestore(checkpoint);
        const snapshot = prepared.restore();
        return { snapshot, publication: this.acceptRestoredOrigin(snapshot) };
    }
    /** Await a coherent read-only recovery view; this neither activates policy nor accepts publication authority. */
    async refreshCurrentMemory(signal) {
        signal?.throwIfAborted();
        if (!lstatSync(this.root, { throwIfNoEntry: false }))
            return undefined;
        return withStorageTransaction(this.root, (storage) => {
            const base = storage.capture(this.cwd, this.sessionId, this.root, this.sessionKey);
            signal?.throwIfAborted();
            return this.loadCurrentMemoryBase(base);
        }, signal);
    }
    loadCurrentMemoryBase(base) {
        const files = new Map(base.files.map((file) => [file.path, file.content]));
        const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
        const session = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
        if ([paths.config, paths.runtime, session.checkpoint, session.patches, session.meta].every((path) => files.get(path) === undefined))
            return undefined;
        const document = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), this.cwd, this.sessionId);
        if (!document)
            throw new RevisionUnavailableError("Current State Flow session runtime is unavailable");
        const origin = `start:${randomUUID()}`;
        const scopes = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta));
            if (!stream && scope === "session")
                throw new RevisionUnavailableError("Current State Flow session memory is unavailable");
            return [scope, stream ?? freshEmptyScopeStream(scope, origin, this.historyLimit)];
        }));
        validateScopeLineage(scopes.session, "session", document.meta.lineage, MAX_HISTORY_LIMIT);
        let view;
        try {
            view = constrainTemporalState({ scopes, lineage: document.meta.lineage }, this.historyLimit);
        }
        catch {
            // Independently validated live shared streams can belong to another writer's lineage.
            view = adoptTemporalStreams(scopes, origin, this.historyLimit);
        }
        const provenance = Object.fromEntries(SCOPES.map((scope) => {
            const meta = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).meta;
            return [scope, parseScopeProvenance(files.get(meta), meta)];
        }));
        const snapshot = {
            config: { enabled: false },
            meta: { step: document.meta.step, ...(document.meta.bootstrap === true ? { bootstrap: true } : {}) },
        };
        this.view = view;
        this.base = base;
        this.provenanceByScope = provenance;
        this.semanticRevision = undefined;
        this.savedRuntime = undefined;
        this.restoredOriginPending = false;
        this.absentSharedScopes.clear();
        return snapshot;
    }
    /** Copy one retained source-session boundary over the child's current shared scopes. */
    prepareBoundaryFork(source, checkpoint) {
        const parent = Object.freeze({ ...source });
        if (parent.id === this.sessionId || parent.key === this.sessionKey)
            throw new Error("State Flow fork requires a distinct session identity and key");
        const sourceRuntime = new TemporalRuntime(this.cwd, parent, this.root, undefined, this.historyLimit);
        const prepared = sourceRuntime.prepareBoundaryRestore(checkpoint);
        prepared.restore();
        const snapshot = {
            config: structuredClone(prepared.snapshot.config),
            meta: {
                step: 0,
                ...(prepared.snapshot.meta.bootstrap === undefined ? {} : { bootstrap: prepared.snapshot.meta.bootstrap }),
            },
        };
        let consumed = false;
        return {
            snapshot: structuredClone(snapshot),
            fork: () => {
                if (consumed)
                    throw new Error("Prepared State Flow fork was already consumed");
                consumed = true;
                if (this.view)
                    throw new Error("State Flow fork target already has session storage");
                const publication = this.initializeOrigin(snapshot, { allowCreateCwd: false, copy: {
                        stream: sourceRuntime.view.scopes.session,
                        provenance: sourceRuntime.artifactProvenance("session"),
                    } });
                if (!publication?.revision)
                    throw new Error("State Flow fork requires existing shared scope storage");
                return { snapshot: structuredClone(snapshot), publication };
            },
        };
    }
    initialize(snapshot, allowCreateCwd, expectedShared, newSessionOrigin = false) {
        return this.initializeOrigin(snapshot, { allowCreateCwd, expectedShared, newSessionOrigin });
    }
    initializeOrigin(snapshot, options) {
        const { allowCreateCwd, expectedShared, newSessionOrigin = false, copy } = options;
        const hasCwd = hasCwdMaterialization(this.cwd, this.root);
        if (!allowCreateCwd && !hasCwd)
            return undefined;
        if (!copy && allowCreateCwd)
            initializeFileStore(this.root);
        const base = captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey);
        const files = new Map(base.files.map((file) => [file.path, file.content]));
        if (copy) {
            const session = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
            const owned = [session.checkpoint, session.patches, session.meta, join(session.directory, "config.json"), join(session.directory, "runtime.json"), join(session.directory, "state.json")];
            const occupied = owned.some((path) => files.get(path) !== undefined);
            if (occupied) {
                throw new Error("State Flow fork target already has session storage");
            }
        }
        if (SCOPES.some((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            return lstatSync(join(paths.directory, "state.json"), { throwIfNoEntry: false }) !== undefined;
        }))
            throw new Error("Unsupported State Flow storage exists; preserve or convert it before initialization");
        const streams = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            return [scope, parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta))];
        }));
        if (!streams.cwd && !allowCreateCwd)
            return undefined;
        if (copy && !streams.global)
            throw new Error("State Flow fork requires existing shared scope storage");
        const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
        const existingRuntime = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), this.cwd, this.sessionId);
        if (existingRuntime && !newSessionOrigin)
            throw new Error("Existing session runtime requires retained-boundary restoration");
        // A pre-runtime branch may establish an empty origin, never import a later session layer.
        if (newSessionOrigin)
            streams.session = undefined;
        if (copy)
            streams.session = copy.stream;
        const fresh = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, randomUUID(), this.historyLimit);
        const candidate = new TemporalRuntime(this.cwd, this.session, this.root, undefined, this.historyLimit);
        candidate.base = base;
        candidate.view = adoptTemporalStreams({ global: streams.global ?? fresh.scopes.global, cwd: streams.cwd ?? fresh.scopes.cwd, session: streams.session ?? fresh.scopes.session }, `files:${randomUUID()}`, this.historyLimit);
        const globalMeta = temporalScopePaths(this.cwd, this.sessionId, "global", this.root, this.sessionKey).meta;
        const cwdMeta = temporalScopePaths(this.cwd, this.sessionId, "cwd", this.root, this.sessionKey).meta;
        candidate.provenanceByScope = {
            global: parseScopeProvenance(files.get(globalMeta), globalMeta),
            cwd: parseScopeProvenance(files.get(cwdMeta), cwdMeta),
            session: copy ? structuredClone(copy.provenance) : streams.session === undefined ? {} : parseScopeProvenance(files.get(paths.meta), paths.meta),
        };
        if (expectedShared && ["global", "cwd"].some((scope) => !sameJson(candidate.read(0, scope), expectedShared[scope]))) {
            throw new Error("Selected branch shared scopes diverged from the live revision");
        }
        const publication = copy ? candidate.publishForkOrigin(snapshot) : candidate.publish(snapshot, true);
        this.view = candidate.view;
        this.base = candidate.base;
        this.provenanceByScope = structuredClone(candidate.provenanceByScope);
        this.semanticRevision = candidate.semanticRevision;
        this.savedRuntime = candidate.savedRuntime;
        this.absentSharedScopes.clear();
        return publication;
    }
    /** Copy the private origin and apply configured retention folding, preserving live shared values/provenance. */
    publishForkOrigin(snapshot) {
        const runtime = createSessionRuntime(snapshot, this.cwd, this.sessionId, this.view.lineage, this.provenanceByScope.session);
        const publication = (this.transaction?.publish ?? publishTemporalStateToFiles)(this.cwd, this.sessionId, this.view, SCOPES, this.base, this.root, runtime, this.sessionKey, this.provenanceByScope);
        this.base = publication.base;
        this.semanticRevision = publication.revision;
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
    reconcileSharedDrift(changedScopes, current) {
        const captured = current ?? captureTemporalFileBase(this.cwd, this.sessionId, this.root, this.sessionKey);
        const liveFiles = new Map(captured.files.map((file) => [file.path, file]));
        const priorFiles = new Map(this.base.files.map((file) => [file.path, file]));
        const adoptable = new Set();
        for (const scope of SHARED_SCOPES) {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            adoptable.add(paths.checkpoint);
            adoptable.add(paths.patches);
            adoptable.add(paths.meta);
        }
        for (const file of this.base.files) {
            if (adoptable.has(file.path))
                continue;
            const current = liveFiles.get(file.path);
            if (current === undefined || current.identity !== file.identity) {
                throw new Error("Temporal State Flow base or scope identity changed concurrently");
            }
        }
        const provenance = structuredClone(this.provenanceByScope);
        const adopted = new Map();
        const targets = [];
        const removedTargets = [];
        const absentScopes = [];
        const reconciliation = `files:reconcile:${randomUUID()}`;
        for (const scope of SHARED_SCOPES) {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            // A cached reader may fold wider live tails without owning a semantic write.
            if ([paths.checkpoint, paths.patches, paths.meta].every((path) => liveFiles.get(path)?.identity === priorFiles.get(path)?.identity))
                continue;
            const presence = classifyScopeStream(liveFiles.get(paths.checkpoint)?.content, liveFiles.get(paths.patches)?.content, scope, scope === "cwd" ? this.cwd : undefined, liveFiles.get(paths.meta)?.content);
            if (presence.kind === "absent") {
                absentScopes.push(scope);
                provenance[scope] = {};
                if (changedScopes.has(scope) && !this.absentSharedScopes.has(scope))
                    removedTargets.push(scope);
                if (!this.absentSharedScopes.has(scope)) {
                    adopted.set(scope, freshEmptyScopeStream(scope, `${reconciliation}:${scope}:absent`, this.historyLimit));
                }
                continue;
            }
            const stream = presence.stream;
            const liveProvenance = parseScopeProvenance(liveFiles.get(paths.meta)?.content, paths.meta);
            const streamDrifted = !sameJson(stream, this.view.scopes[scope]);
            const provenanceDrifted = !sameJson(liveProvenance, this.provenanceByScope[scope]);
            if (!streamDrifted && !provenanceDrifted)
                continue;
            if (changedScopes.has(scope)) {
                targets.push(scope);
                continue;
            }
            provenance[scope] = liveProvenance;
            if (streamDrifted)
                adopted.set(scope, stream);
        }
        const reconciledView = () => adopted.size === 0 ? this.view : adoptTemporalStreams({
            global: adopted.get("global") ?? structuredClone(this.view.scopes.global),
            cwd: adopted.get("cwd") ?? structuredClone(this.view.scopes.cwd),
            session: structuredClone(this.view.scopes.session),
        }, reconciliation, this.historyLimit);
        if (removedTargets.length > 0) {
            this.view = reconciledView();
            this.base = captured;
            this.provenanceByScope = provenance;
            for (const scope of absentScopes)
                this.absentSharedScopes.add(scope);
            throw removedTargetScopeConflict(removedTargets);
        }
        if (targets.length > 0)
            throw targetScopeConflict(targets);
        return { view: reconciledView(), base: captured, provenance };
    }
    /** Await coherent shared inspection, lazily loading an empty private view only when none is selected. */
    async refreshShared(signal) {
        signal?.throwIfAborted();
        if (!this.view && !lstatSync(this.root, { throwIfNoEntry: false }))
            return false;
        return withStorageTransaction(this.root, (storage) => {
            const current = storage.capture(this.cwd, this.sessionId, this.root, this.sessionKey);
            if (!this.view)
                return this.loadPassiveBase(current);
            if (!this.base)
                throw new Error("State Flow shared refresh requires a selected temporal runtime");
            const before = this.view;
            const reconciled = this.reconcileSharedDrift(new Set(), current);
            this.view = reconciled.view;
            this.base = reconciled.base;
            this.provenanceByScope = reconciled.provenance;
            return before !== this.view;
        }, signal);
    }
    /** Prepare current shared state while retaining the exact accepted private publication basis. */
    publicationCandidate(storage, current) {
        if (this.restoredOriginPending)
            throw new RevisionUnavailableError("State Flow restored origin must be accepted before patching memory");
        current ??= storage.capture(this.cwd, this.sessionId, this.root, this.sessionKey);
        const candidate = new TemporalRuntime(this.cwd, this.session, this.root, undefined, this.historyLimit);
        candidate.transaction = storage;
        if (this.semanticRevision && this.view && this.base) {
            candidate.view = this.view;
            candidate.base = this.base;
            candidate.provenanceByScope = this.provenanceByScope;
            const reconciled = candidate.reconcileSharedDrift(new Set(), current);
            candidate.view = reconciled.view;
            candidate.base = reconciled.base;
            candidate.provenanceByScope = reconciled.provenance;
            return candidate;
        }
        const files = new Map(current.files.map((file) => [file.path, file.content]));
        const paths = sessionRuntimePaths(this.cwd, this.sessionId, this.root, this.sessionKey);
        const session = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
        if ([paths.config, paths.runtime, session.checkpoint, session.patches, session.meta].some((path) => files.get(path) !== undefined)) {
            const document = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), this.cwd, this.sessionId);
            const stream = parseScopeStream(files.get(session.checkpoint), files.get(session.patches), "session", undefined, files.get(session.meta));
            if (!document || !stream)
                throw new RevisionUnavailableError("Current State Flow session memory is incomplete");
            validateScopeLineage(stream, "session", document.meta.lineage, MAX_HISTORY_LIMIT);
            throw new RevisionUnavailableError("Existing State Flow session memory is not selected; select an accepted boundary or use /state-flow-start");
        }
        const origin = `patch:${randomUUID()}`;
        const streams = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            return [scope, parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? this.cwd : undefined, files.get(paths.meta)) ?? freshEmptyScopeStream(scope, `${origin}:empty`, this.historyLimit)];
        }));
        candidate.view = adoptTemporalStreams(streams, origin, this.historyLimit);
        candidate.base = current;
        candidate.provenanceByScope = Object.fromEntries(SCOPES.map((scope) => {
            const paths = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey);
            // Absent semantic pairs cannot confer compilation evidence on a new registration.
            return [scope, files.get(paths.checkpoint) === undefined ? {} : parseScopeProvenance(files.get(paths.meta), paths.meta)];
        }));
        return candidate;
    }
    /** Stage and accept synchronously inside an awaited lock; expose neither selection nor raw storage operations. */
    async withPatchTransaction(action, signal) {
        return this.withPublicationTransaction((candidate, publish) => action({
            states: candidate.states(),
            causalBasis: candidate.causalBasis(),
            provenance: structuredClone(candidate.provenanceByScope),
            publish,
        }), { kind: "patch" }, signal);
    }
    /** Activate current owned memory; the caller must authorize a wholly absent private origin after waiting. */
    async withStartTransaction(action, signal, allowCreateOrigin = false) {
        return this.withPublicationTransaction((_candidate, publish, current) => action(current, (snapshot) => publish(snapshot)), { kind: "start", allowCreateOrigin }, signal);
    }
    /** Select one retained private boundary beside current shared streams, then accept only after caller policy is rechecked. */
    async withRestoreTransaction(checkpoint, action, signal) {
        signal?.throwIfAborted();
        return this.withPublicationTransaction((_candidate, publish, selected) => action(selected, (snapshot) => publish(snapshot)), { kind: "restore", checkpoint: structuredClone(checkpoint) }, signal);
    }
    /** Copy exact retained parent authority into an unoccupied child; the caller rechecks native selection after waiting. */
    async withForkTransaction(source, checkpoint, action, signal) {
        signal?.throwIfAborted();
        return this.withPublicationTransaction((_candidate, publish, selected) => action(selected, (snapshot) => publish(snapshot)), { kind: "fork", source: { ...source }, checkpoint: structuredClone(checkpoint) }, signal);
    }
    prepareForkCandidate(storage, source, checkpoint) {
        const sourceBase = storage.capture(this.cwd, source.id, this.root, source.key);
        const parent = new TemporalRuntime(this.cwd, source, this.root, undefined, this.historyLimit);
        const selected = parent.prepareBoundaryRestoreBase(checkpoint, sourceBase).restore();
        const base = storage.capture(this.cwd, this.sessionId, this.root, this.sessionKey);
        const files = new Map(base.files.map((file) => [file.path, file.content]));
        const paths = temporalScopePaths(this.cwd, this.sessionId, "session", this.root, this.sessionKey);
        if ([paths.checkpoint, paths.patches, paths.meta, join(paths.directory, "config.json"), join(paths.directory, "runtime.json")].some((path) => files.get(path) !== undefined)) {
            throw new Error("State Flow fork target already has session storage");
        }
        if (SCOPES.some((scope) => lstatSync(join(temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).directory, "state.json"), { throwIfNoEntry: false }))) {
            throw new Error("Unsupported State Flow storage exists; preserve or convert it before initialization");
        }
        const candidate = new TemporalRuntime(this.cwd, this.session, this.root, undefined, this.historyLimit);
        candidate.transaction = storage;
        candidate.base = base;
        candidate.view = adoptTemporalStreams(parent.view.scopes, `files:${randomUUID()}`, this.historyLimit);
        candidate.provenanceByScope = { ...parent.provenanceByScope };
        for (const scope of SHARED_SCOPES) {
            const meta = temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).meta;
            candidate.provenanceByScope[scope] = parseScopeProvenance(files.get(meta), meta);
        }
        return {
            candidate,
            current: { config: selected.config, meta: { step: 0, ...(selected.meta.bootstrap === undefined ? {} : { bootstrap: selected.meta.bootstrap }) } },
            assertSource: () => assertTemporalFileBase(sourceBase, storage.capture(this.cwd, source.id, this.root, source.key)),
        };
    }
    /** Recheck caller policy after waiting, then accept only config/runtime over an already accepted private basis. */
    async withLifecycleTransaction(action, signal) {
        return this.withPublicationTransaction((_candidate, publish) => action((snapshot) => publish(snapshot)), { kind: "lifecycle" }, signal);
    }
    async withPublicationTransaction(action, selection, signal) {
        const { kind } = selection;
        const allowCreateOrigin = selection.kind === "start" && selection.allowCreateOrigin;
        const semantic = kind !== "lifecycle";
        const assertAuthority = () => {
            if (selection.kind === "fork") {
                if (selection.source.id === this.sessionId || selection.source.key === this.sessionKey)
                    throw new Error("State Flow fork requires a distinct session identity and key");
                if (this.view)
                    throw new Error("State Flow fork target already has session storage");
            }
            if (!semantic && (!this.semanticRevision || !this.view || !this.base || this.restoredOriginPending)) {
                throw new Error("State Flow lifecycle transaction requires an accepted runtime");
            }
        };
        signal?.throwIfAborted();
        assertAuthority();
        if (kind === "patch" || allowCreateOrigin)
            initializeFileStore(this.root);
        if ((kind === "start" || kind === "restore" || kind === "fork") && !lstatSync(this.root, { throwIfNoEntry: false })) {
            throw new RevisionUnavailableError(kind !== "start" ? "Selected State Flow boundary storage is unavailable" : "Current State Flow session storage is unavailable");
        }
        return withStorageTransaction(this.root, (storage) => {
            assertAuthority();
            let current;
            let candidate;
            let assertSource;
            if (selection.kind === "fork") {
                ({ candidate, current, assertSource } = this.prepareForkCandidate(storage, selection.source, selection.checkpoint));
            }
            else if (selection.kind === "restore" || selection.kind === "start") {
                candidate = new TemporalRuntime(this.cwd, this.session, this.root, undefined, this.historyLimit);
                candidate.transaction = storage;
                const base = storage.capture(this.cwd, this.sessionId, this.root, this.sessionKey);
                current = selection.kind === "restore"
                    ? candidate.prepareBoundaryRestoreBase(selection.checkpoint, base).restore()
                    : candidate.loadCurrentMemoryBase(base);
                if (!current) {
                    if (!allowCreateOrigin)
                        throw new RevisionUnavailableError("Current State Flow session memory is unavailable");
                    if (SCOPES.some((scope) => lstatSync(join(temporalScopePaths(this.cwd, this.sessionId, scope, this.root, this.sessionKey).directory, "state.json"), { throwIfNoEntry: false }))) {
                        throw new Error("Unsupported State Flow storage exists; preserve or convert it before initialization");
                    }
                    candidate = candidate.publicationCandidate(storage, base);
                }
            }
            else
                candidate = this.publicationCandidate(storage);
            let consumed = false;
            let published = false;
            const result = action(candidate, (snapshot, accepted, provenance) => {
                if (consumed)
                    throw new Error(`State Flow ${kind} transaction publication was already consumed`);
                consumed = true;
                signal?.throwIfAborted();
                assertSource?.();
                // Patch preparation without semantic work preserves complete accepted cohorts; selection accepts origins with configured folding.
                // New authority or wholly absent shared pairs still need normal atomic initialization; partial evidence already failed.
                const writeSemantic = semantic && (kind === "start" || kind === "restore" || kind === "fork" || accepted !== undefined || !this.semanticRevision
                    || SCOPES.some((scope) => Object.keys(provenance?.[scope] ?? {}).length > 0)
                    || candidate.base.files.some((file) => file.content === undefined));
                // Every capability acceptance validates its captured cohort, including semantic no-ops.
                const publication = kind === "fork" ? candidate.publishForkOrigin(snapshot) : candidate.publish(snapshot, writeSemantic, accepted, { provenance });
                if (!publication)
                    throw new Error(`State Flow ${kind} transaction produced no canonical publication`);
                this.view = candidate.view;
                this.base = candidate.base;
                this.provenanceByScope = candidate.provenanceByScope;
                this.semanticRevision = candidate.semanticRevision;
                this.savedRuntime = candidate.savedRuntime;
                this.restoredOriginPending = false;
                this.absentSharedScopes.clear();
                published = true;
                return publication;
            }, current);
            if (!published)
                throw new Error(`State Flow ${kind} transaction requires one synchronous publication`);
            return result;
        }, signal);
    }
    /** Canonically accept a prepared retained-boundary origin before lifecycle-only persistence. */
    acceptRestoredOrigin(snapshot) {
        if (!this.restoredOriginPending)
            throw new Error("State Flow has no prepared restored origin to accept");
        const publication = this.publish(snapshot, true);
        if (!publication)
            throw new Error("State Flow restored origin produced no canonical publication");
        this.restoredOriginPending = false;
        return publication;
    }
    publish(snapshot, semantic = false, accepted, options = {}) {
        if (!this.view || !this.base)
            throw new Error("State Flow temporal publication is unavailable; restore or initialize before accepting a transition");
        if (this.restoredOriginPending && !semantic)
            throw new Error("State Flow restored origin must be accepted before runtime-only persistence");
        // Explicit evidence updates still own a scope CAS, even if they equal the stale cache.
        const provenanceScopes = SCOPES.filter((scope) => Object.keys(options.provenance?.[scope] ?? {}).length > 0);
        const runtimeOnly = !semantic && accepted === undefined && provenanceScopes.length === 0;
        let basis = this.view;
        let base = this.base;
        let basisProvenance = this.provenanceByScope;
        // A transaction already selected its current basis under exclusion; raw replay callers still guard their older basis.
        if (!this.transaction && (this.semanticRevision || accepted !== undefined || provenanceScopes.length > 0)) {
            const changedScopes = new Set([
                ...(accepted?.transitions ?? []).map(({ scope }) => scope),
                ...provenanceScopes,
            ]);
            const reconciled = this.reconcileSharedDrift(changedScopes);
            basis = reconciled.view;
            base = reconciled.base;
            basisProvenance = reconciled.provenance;
        }
        const next = accepted ? advanceTemporalState(basis, accepted.transitions, accepted.id, this.historyLimit) : basis;
        const nextProvenance = structuredClone(basisProvenance);
        for (const scope of SCOPES) {
            const updates = options.provenance?.[scope];
            if (updates)
                for (const [path, entry] of Object.entries(updates))
                    nextProvenance[scope][path] = structuredClone(entry);
        }
        if (!runtimeOnly)
            for (const scope of SCOPES) {
                nextProvenance[scope] = pruneArtifactProvenance(nextProvenance[scope], readTemporalState(next, 0, scope, this.historyLimit).artifacts);
            }
        const provenanceChanged = !sameJson(nextProvenance, this.provenanceByScope);
        const runtime = createSessionRuntime(snapshot, this.cwd, this.sessionId, next.lineage, nextProvenance.session);
        const fingerprint = hashJson(runtime);
        if (!semantic && fingerprint === this.savedRuntime && !provenanceChanged)
            return undefined;
        const result = (this.transaction?.publish ?? publishTemporalStateToFiles)(this.cwd, this.sessionId, next, runtimeOnly ? [] : SCOPES, base, this.root, runtime, this.sessionKey, runtimeOnly ? undefined : nextProvenance, runtimeOnly);
        this.base = result.base;
        this.view = next;
        this.provenanceByScope = nextProvenance;
        this.savedRuntime = fingerprint;
        this.semanticRevision = result.revision;
        if (semantic)
            this.absentSharedScopes.clear();
        return result;
    }
}
