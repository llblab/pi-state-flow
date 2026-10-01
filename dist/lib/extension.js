import { StringEnum, Type } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ArtifactReadTracker } from "./acquisition.js";
import { classifyArtifactCompilationNeed, inspectRegisteredArtifactPaths, ORDINARY_ARTIFACT_COMPILER, sameArtifactSourceFingerprint, } from "./artifact.js";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, stateFlowCompactionResult } from "./compaction.js";
import { inactiveModeFor, loadStateFlowConfig } from "./config.js";
import { ContextProjection, contextView, createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, projectSystemProtocol, runtimeContextHead, syntheticUser } from "./context.js";
import { readNativeSessionHeader } from "./continuation.js";
import { cwdScopeKey, resolveSessionAddress, sessionScopeKey, } from "./durable.js";
import { completeRun, deactivateEpisode, prepareRun, resumeEpisode, startEpisode } from "./episode.js";
import { awaitInFlightBackupPushes, backupCurrentStateFlowFiles, startStateFlowBackupPush } from "./git.js";
import { projectRecentTransitionsWithLimit } from "./history.js";
import { isObject, presentationJson, sameJson } from "./json.js";
import { StateFlowDiagnosticWriter, stateFlowLogPath } from "./logging.js";
import { assistantToolCallCount, conciseDiagnostic, diagnosticText, finalizedAssistantResponse, formatPatchStateArguments, PASSIVE_MEMORY_PROTOCOL, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.js";
import { readProjectedState, readStatePath } from "./query.js";
import { selectedBoundaryFailure, selectRetainedCheckpoint, waitForRecovery } from "./recovery.js";
import { TemporalRuntime } from "./runtime.js";
import { discoverSnapshotData, findAssistantToolBatch, findPassiveStopBoundary, hasPriorConversation, hasUncheckpointedConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.js";
import { hasCompiledSkillArtifact, hashSkillSource, registeredSkillResolver, SkillReadTracker } from "./skills.js";
import { HistoryBoundaryExpiredError, emptySnapshot, migrationFailure, preRuntimeCheckpoint } from "./snapshot.js";
import { emptyState, projectStateForModel } from "./state.js";
import { compactStatus, detailedStatus, STATUS_KEY } from "./status.js";
import { PublicationBusyError } from "./storage.js";
import { createStateFlowTelegramAdapter } from "./telegram.js";
import { temporalScopeRevisions } from "./temporal.js";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition } from "./transition.js";
export { formatPatchStateArguments };
export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";
export default function stateFlowExtension(pi, options = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    const loadedConfig = loadStateFlowConfig(agentDir, options.repositoryRoot);
    const config = options.mode === undefined ? loadedConfig
        : { ...loadedConfig, mode: options.mode, inactiveMode: inactiveModeFor(options.mode) };
    let snapshot = emptySnapshot(config.inactiveMode);
    let scopeStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
    let effectiveState = {};
    let branchStartsWithoutRuntime = false;
    let selectedHistoryExpired = false;
    let modePersistenceError;
    /** One pending inactive-mode persistence; later inactive choices coalesce until it publishes. */
    let inactivePersistence;
    let startActivation;
    let forkInitialization = false;
    let branchRestoration;
    const restorationOperations = new Set();
    let responseReconciliation;
    let sharedInspectionLifetime = new AbortController();
    let completedRunAccepted = false;
    let turnAcceptedForBackup = false;
    let compactionPlan;
    let compactionInFlight = false;
    let compactionStopped = false;
    const compactionMarker = `state-flow-boundary:${randomUUID()}`;
    let passiveContinuation;
    let bootstrapContinuation;
    const contextProjection = new ContextProjection();
    let inferencePreparation;
    let runAnchorTimestamp;
    let runtime;
    let activeContext;
    let rehydrationPhase;
    const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
    const diagnosticWriter = new StateFlowDiagnosticWriter(config.logging, stateFlowLogPath(agentDir), repositoryRoot, (message) => notifyActiveContext(message));
    let backupPending = false;
    const backupLifetime = new AbortController();
    const backupOperations = new Set();
    let shuttingDown = false;
    let pushFailureNotified = false;
    const skillReads = new SkillReadTracker(hashSkillSource, (path) => activeContext
        ? registeredSkillResolver(activeContext.cwd, pi.getCommands())(path)
        : undefined);
    const artifactReads = new ArtifactReadTracker();
    let artifactInvalidations = [];
    let artifactHints = {};
    const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";
    let telegramStartPending = false;
    function sessionAddress(ctx) {
        return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
    }
    function notifyProblem(ctx, message, level) {
        ctx.ui.notify(conciseDiagnostic(message), level);
    }
    function notifyActiveContext(message) {
        try {
            if (activeContext)
                notifyProblem(activeContext, message, "warning");
        }
        catch {
            // An asynchronous push attempt can outlive the Pi context that launched it.
        }
    }
    function createRuntime(ctx) {
        return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot, undefined, config.historyLimit);
    }
    function projectModelState(state) {
        return projectStateForModel(state, artifactHints);
    }
    function assertSelectedBranchAvailable() {
        if (snapshot.meta.validation?.attempt === 0) {
            throw new Error(`State Flow selected branch is unavailable: ${snapshot.meta.validation.error}`);
        }
    }
    options.onRuntime?.({ read: (offset, scope) => {
            if (scope === "session")
                assertSelectedBranchAvailable();
            if (!runtime)
                throw new Error("State Flow temporal runtime is unavailable");
            const { lazy: _lazy, ...defaults } = emptyState();
            return { ...defaults, ...projectModelState(runtime.readView(offset, scope)) };
        } });
    function assertPublicationAvailable() {
        assertSelectedBranchAvailable();
        if (modePersistenceError)
            throw new Error(`Memory writes paused after mode change: ${modePersistenceError}; use /state-flow-active`);
    }
    function isActive() {
        return snapshot.config.mode === "active";
    }
    /** An unavailable or pending active selection keeps the configured inactive policy, never an invented one. */
    function inactiveSelection(mode) {
        return mode === "active" ? config.inactiveMode : mode;
    }
    function appendCheckpoint() {
        const checkpoint = branchStartsWithoutRuntime ? preRuntimeCheckpoint(snapshot.config.mode)
            : runtime?.view ? runtime.retainedCheckpoint(snapshot) : undefined;
        if (!checkpoint)
            throw new Error("State Flow cannot checkpoint an unproven branch; restore a valid checkpoint first");
        pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
        if ("boundary" in checkpoint)
            branchStartsWithoutRuntime = false;
    }
    function scopeRevisions() {
        return runtime?.view
            ? temporalScopeRevisions(runtime.view)
            : { global: 0, cwd: 0, session: 0 };
    }
    function updateUi(ctx) {
        ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, scopeRevisions(), (color, text) => ctx.ui.theme.fg(color, text)));
    }
    function cancelInactivePersistence() {
        const pending = inactivePersistence;
        pending?.controller.abort();
        inactivePersistence = undefined;
        return pending?.operation;
    }
    function cancelStartActivation() {
        const pending = startActivation;
        pending?.controller.abort();
        startActivation = undefined;
        return pending?.operation;
    }
    function cancelBranchRestoration() {
        const pending = branchRestoration;
        pending?.controller.abort();
        branchRestoration = undefined;
        return pending?.operation;
    }
    function cancelResponseReconciliation() {
        responseReconciliation?.abort();
        responseReconciliation = undefined;
    }
    function cancelSharedInspections() {
        sharedInspectionLifetime.abort(new Error("State Flow inspection was cancelled; select the scope again"));
        sharedInspectionLifetime = new AbortController();
    }
    function cancelInferencePreparation() {
        inferencePreparation?.controller.abort();
        inferencePreparation = undefined;
    }
    function clearRunTransient() {
        cancelInferencePreparation();
        cancelResponseReconciliation();
        cancelSharedInspections();
        completedRunAccepted = false;
        turnAcceptedForBackup = false;
        compactionPlan = undefined;
        compactionInFlight = false;
        skillReads.clear();
        artifactReads.clear();
    }
    function deferInferencePreparation(prompt) {
        cancelInferencePreparation();
        inferencePreparation = { controller: new AbortController(), prompt };
        artifactInvalidations = [];
        artifactReads.setCandidates([]);
    }
    function refreshArtifactHints() {
        if (!runtime?.view) {
            artifactHints = {};
            artifactInvalidations = [];
            artifactReads.setCandidates([]);
            return;
        }
        const paths = new Set();
        for (const scope of ["global", "cwd", "session"])
            for (const path of Object.keys(scopeStates[scope].artifacts))
                paths.add(path);
        const observations = new Map(inspectRegisteredArtifactPaths(paths).map((observation) => [observation.path, observation]));
        const nextHints = {};
        const nextInvalidations = new Map();
        for (const scope of ["global", "cwd", "session"]) {
            const provenance = runtime.artifactProvenance(scope);
            for (const [path, metadata] of Object.entries(scopeStates[scope].artifacts)) {
                delete nextHints[path];
                nextInvalidations.delete(path);
                if (metadata.kind === "skill")
                    continue;
                const observed = observations.get(path);
                if (observed?.kind !== "present")
                    continue;
                const need = classifyArtifactCompilationNeed({ path, scope, sourceFingerprint: observed.fingerprint }, metadata, ORDINARY_ARTIFACT_COMPILER, false, provenance[path]);
                if (need.kind !== "requires-compilation")
                    continue;
                if (need.reason === "source-changed")
                    nextHints[path] = SOURCE_CHANGED_HINT;
                nextInvalidations.set(path, { path, scope, reason: need.reason });
            }
        }
        artifactHints = nextHints;
        artifactInvalidations = [...nextInvalidations.values()].sort((left, right) => left.path.localeCompare(right.path));
        artifactReads.setCandidates(artifactInvalidations);
    }
    function missingArtifactRemovals(states) {
        const owners = new Map();
        for (const scope of ["global", "cwd", "session"])
            for (const path of Object.keys(states[scope].artifacts ?? {})) {
                owners.set(path, [...owners.get(path) ?? [], scope]);
            }
        const removals = {};
        for (const observation of inspectRegisteredArtifactPaths(owners.keys())) {
            if (observation.kind !== "missing")
                continue;
            for (const scope of owners.get(observation.path) ?? []) {
                const artifacts = (removals[scope]?.artifacts ?? {});
                removals[scope] = { ...(removals[scope] ?? {}), artifacts: { ...artifacts, [observation.path]: null } };
            }
        }
        return removals;
    }
    function installScopeStates() {
        scopeStates = runtime?.view ? runtime.states() : { global: emptyState(), cwd: emptyState(), session: emptyState() };
        effectiveState = runtime?.view ? runtime.readView() : {};
    }
    /** Active and passive expose both memory tools; Off exposes neither. */
    function memoryToolsAvailable() {
        return snapshot.config.mode !== "off";
    }
    /** Passive memory context needs a loaded view; Off and Active never inject it. */
    function passiveMemoryAvailable() {
        return snapshot.config.mode === "passive" && runtime?.view !== undefined;
    }
    async function inspectTelegramState(scope) {
        if (!activeContext || shuttingDown)
            throw new Error("State Flow is not attached to an active session yet");
        if (scope === "session" || scope === "effective")
            assertSelectedBranchAvailable();
        const selected = runtime ??= createRuntime(activeContext);
        const signal = sharedInspectionLifetime.signal;
        if (!selected.view || (scope !== "session" && !modePersistenceError))
            await selected.refreshShared(signal);
        signal.throwIfAborted();
        if (runtime !== selected)
            throw new Error("State Flow inspection selection changed; select the scope again");
        if (scope === "session" || scope === "effective")
            assertSelectedBranchAvailable();
        if (!selected.view)
            throw new Error("State Flow temporal runtime is unavailable");
        installScopeStates();
        const state = scope === "effective" ? effectiveState : selected.readView(0, scope);
        return { state: { ...projectModelState(state), ...(state.lazy === undefined ? {} : { lazy: structuredClone(state.lazy) }) }, revisions: scopeRevisions(), signal };
    }
    function syncStateFlowTools() {
        const active = pi.getActiveTools();
        const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
        const available = memoryToolsAvailable();
        if (owned.every((name) => active.includes(name) === available))
            return;
        pi.setActiveTools(available
            ? [...new Set([...active, ...owned])]
            : active.filter((name) => !owned.includes(name)));
    }
    function recordPublication(_publication, _ctx) {
        // A passive view is not runtime authority; only accepted canonical publication establishes it.
        branchStartsWithoutRuntime = false;
        backupPending = true;
    }
    /** Record accepted lifecycle persistence; Git backup is scheduled only after an accepted turn settles. */
    function recordPolicyPublication(publication, ctx) {
        if (publication)
            recordPublication(publication, ctx);
    }
    function skillReadIsCurrent(read) {
        return read.hash !== undefined && runtime?.view !== undefined && hasCompiledSkillArtifact(scopeStates[read.scope].artifacts, runtime.artifactProvenance(read.scope)[read.path], read.path, read.hash);
    }
    function dropCurrentSkillReads() {
        for (const read of skillReads.successful.values()) {
            if (skillReadIsCurrent(read))
                skillReads.delete(read.path);
        }
    }
    function skillAcquisitionHint(read) {
        if (read.hash === undefined || skillReadIsCurrent(read))
            return undefined;
        const target = `${read.scope}.artifacts[${JSON.stringify(read.path)}]`;
        return `State Flow acquisition: this registered Skill belongs at ${target}. If durable compiled guidance is useful, include a non-empty description, kind:"skill", and compilation object there. Unrelated semantic patches do not need to include it.`;
    }
    function clearAcceptedAcquisitions(acquiredArtifactPaths = new Set(artifactReads.successful.keys())) {
        artifactInvalidations = artifactInvalidations.filter(({ path }) => !acquiredArtifactPaths.has(path));
        artifactReads.setCandidates(artifactInvalidations);
        dropCurrentSkillReads();
        artifactReads.clear();
    }
    async function prepareInference(pending, selected, ctx, operationSignal) {
        const signal = AbortSignal.any([pending.controller.signal, operationSignal]);
        try {
            if (!selected?.view)
                throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
            await selected.withPatchTransaction((transaction) => {
                signal.throwIfAborted();
                if (runtime !== selected || inferencePreparation !== pending || !isActive() || shuttingDown) {
                    throw new Error("State Flow inference selection changed while awaiting publication");
                }
                assertPublicationAvailable();
                const nextSnapshot = structuredClone(snapshot);
                const rotatesRun = pending.prompt !== undefined && nextSnapshot.meta.specification !== undefined;
                if (pending.prompt !== undefined)
                    prepareRun(nextSnapshot, pending.prompt);
                // Exact-path metadata validation belongs to the locked current head, including newly adopted registrations.
                const removals = missingArtifactRemovals(transaction.states);
                let publication;
                if (Object.keys(removals).length > 0) {
                    const stage = stageAtomicScopePatches(transaction.states, removals, [], transaction.causalBasis);
                    commitScopedTransition(nextSnapshot, transaction.states, stage, (transition, next) => {
                        publication = transaction.publish(next, transition);
                        pending.accepted = true;
                    }, transaction.causalBasis, { finalizeRun: false });
                }
                else {
                    publication = transaction.publish(nextSnapshot);
                    pending.accepted = true;
                }
                snapshot = nextSnapshot;
                installScopeStates();
                if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap")
                    rehydrationPhase = "step";
                if (publication?.changed)
                    recordPublication(publication, ctx);
                if (pending.prompt !== undefined || publication?.changed)
                    appendCheckpoint();
                if (Object.keys(removals).length > 0)
                    clearAcceptedAcquisitions();
                updateUi(ctx);
            }, signal);
        }
        catch (error) {
            if (signal.aborted || runtime !== selected || inferencePreparation !== pending || shuttingDown)
                return;
            // Pi reports context-hook exceptions and continues. Abort through its public port rather than infer from stale preparation.
            ctx.abort();
            const cause = diagnosticText(error);
            recordDiagnostic(cause, "publication-conflict", ctx);
            notifyProblem(ctx, pending.accepted
                ? `State Flow preparation saved; lifecycle update failed: ${cause}`
                : `State Flow inference preparation failed: ${cause}`, "error");
        }
    }
    function currentRehydrationPhase() {
        return rehydrationPhase;
    }
    function statusDiagnostics(ctx) {
        const cwd = ctx.cwd;
        const diagnosticStates = scopeStates;
        const view = runtime?.view;
        const diagnosticRecent = runtime?.recent() ?? [];
        const durableStateError = snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error
            : view ? undefined : "no temporal runtime is selected on this branch";
        const staleArtifacts = durableStateError === undefined
            ? artifactInvalidations.map(({ path, scope, reason }) => ({ scope: scope ?? "global", path, reason }))
            : [];
        const session = sessionAddress(ctx);
        return {
            repositoryRoot,
            cwdScopeKey: cwdScopeKey(cwd),
            sessionScopeKey: sessionScopeKey(session.key),
            scopeStates: diagnosticStates,
            effectiveState,
            recent: diagnosticRecent,
            historyLimit: config.historyLimit,
            ...(view === undefined ? {} : { temporal: {
                    head: structuredClone(view.lineage.at(-1)),
                    historyDepth: view.lineage.length - 1,
                    tailCounts: { global: view.scopes.global.patches.length, cwd: view.scopes.cwd.patches.length, session: view.scopes.session.patches.length },
                    revisions: temporalScopeRevisions(view),
                } }),
            staleArtifacts,
            ...(durableStateError === undefined ? {} : { durableStateError }),
            ...(modePersistenceError === undefined ? {} : { publicationError: modePersistenceError }),
        };
    }
    function forkSource(ctx) {
        const file = ctx.sessionManager.getHeader()?.parentSession;
        if (typeof file !== "string" || !isAbsolute(file))
            throw new Error("State Flow fork requires a persisted native parent session");
        const parent = readNativeSessionHeader(file);
        if (parent.cwd !== resolve(ctx.cwd))
            throw new Error("State Flow fork parent CWD identity mismatch");
        return resolveSessionAddress(parent.file, parent.id, parent.timestamp);
    }
    /** Select the active native branch under one owned restoration lifetime; only current accepted work installs memory. */
    function restoreActiveBranch(ctx, sessionStartReason, notifyRecovery = true, startOwner) {
        contextProjection.reset();
        cancelBranchRestoration();
        // Start-owned attachment/fork recovery keeps its owner; only accepted Start cancels Stop.
        if (!startOwner) {
            cancelStartActivation();
            cancelInactivePersistence();
        }
        clearRunTransient();
        passiveContinuation = undefined;
        bootstrapContinuation = undefined;
        artifactInvalidations = [];
        artifactReads.setCandidates([]);
        telegramStartPending = false;
        activeContext = ctx;
        runtime = createRuntime(ctx);
        installScopeStates();
        branchStartsWithoutRuntime = false;
        selectedHistoryExpired = false;
        forkInitialization = sessionStartReason === "fork";
        let selection = { kind: "settled" };
        let skipped = 0;
        try {
            const branch = ctx.sessionManager.getBranch();
            const fence = retainsPhysicalSessionProjection(sessionStartReason)
                ? findPassiveStopBoundary(branch, ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE)
                : undefined;
            modePersistenceError = fence?.persistenceError ?? (startOwner ? modePersistenceError : undefined);
            if (fence?.persistenceError) {
                // The native marker owns policy only: read proven memory, never replay or publish a stale selection.
                selection = { kind: "current", mode: fence.mode ?? config.inactiveMode };
            }
            else {
                const discovery = discoverSnapshotData(branch);
                const selected = selectRetainedCheckpoint(discovery.candidates, config.inactiveMode);
                skipped = discovery.errors.length + selected.skipped.length;
                branchStartsWithoutRuntime = selected.kind === "pre-runtime" || (discovery.candidates.length === 0 && discovery.errors.length === 0);
                if (discovery.candidates.length === 0 && discovery.errors.length > 0) {
                    snapshot = migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`, config.inactiveMode);
                }
                else if (selected.kind === "boundary" && forkInitialization) {
                    try {
                        // Native parent acquisition stays outside canonical exclusion.
                        const source = forkSource(ctx);
                        const sourceFence = findPassiveStopBoundary(branch, source.id, PASSIVE_STOP_ENTRY_TYPE);
                        selection = { kind: "fork", source, checkpoint: sourceFence?.persistenceError !== undefined
                                ? { ...selected.checkpoint, mode: sourceFence.mode ?? config.inactiveMode } : selected.checkpoint };
                    }
                    catch (error) {
                        snapshot = selectedBoundaryFailure(diagnosticText(error), inactiveSelection(selected.checkpoint.mode));
                    }
                }
                else if (selected.kind === "boundary") {
                    selection = { kind: "restore", checkpoint: selected.checkpoint };
                }
                else if (selected.kind === "pre-runtime") {
                    snapshot = emptySnapshot(selected.mode);
                }
                else if (discovery.candidates.length > 0) {
                    snapshot = selected.snapshot;
                }
                else if (isNewSession(sessionStartReason, branch)) {
                    // The repository mode is only a default for genuinely new sessions.
                    if (config.mode === "active")
                        selection = { kind: "auto-start" };
                    else {
                        snapshot = emptySnapshot(config.mode);
                        // Adopt the default once without initializing semantic storage.
                        appendCheckpoint();
                    }
                }
                else {
                    snapshot = emptySnapshot(config.inactiveMode);
                }
            }
        }
        catch (error) {
            selection = { kind: "settled" };
            snapshot = selectedBoundaryFailure(diagnosticText(error), config.inactiveMode);
        }
        // Pending selection grants neither private reads nor publication until its acceptance installs memory.
        if (selection.kind !== "settled") {
            snapshot = migrationFailure({}, "State Flow branch restoration is pending", selection.kind === "current" ? selection.mode
                : selection.kind === "auto-start" ? config.inactiveMode : inactiveSelection(selection.checkpoint.mode));
        }
        const pending = {
            controller: new AbortController(),
            awaitingAcceptance: selection.kind !== "settled" && selection.kind !== "current",
        };
        branchRestoration = pending;
        const operation = attachBranch(ctx, pending, selection, sessionStartReason, notifyRecovery, skipped);
        pending.operation = operation;
        restorationOperations.add(operation);
        const finished = () => { restorationOperations.delete(operation); };
        void operation.then(finished, finished);
        return operation;
    }
    async function attachBranch(ctx, pending, selection, reason, notifyRecovery, skipped) {
        const placeholder = runtime;
        let selected = runtime;
        const owner = ctx.sessionManager.getSessionId();
        const cwd = ctx.cwd;
        const file = ctx.sessionManager.getSessionFile();
        const timestamp = ctx.sessionManager.getHeader()?.timestamp;
        const signal = AbortSignal.any([pending.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
        const isCurrent = () => branchRestoration === pending && !pending.controller.signal.aborted && !shuttingDown && runtime === selected
            && ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
            && ctx.sessionManager.getHeader()?.timestamp === timestamp;
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (!isCurrent())
                throw new Error("State Flow branch selection changed while awaiting publication");
        };
        let accepted = false;
        // Install accepted memory before native writes; later ancillary failures cannot revert or replay it.
        const accept = (candidate, next, publication, nativeWrites) => {
            accepted = true;
            pending.awaitingAcceptance = false;
            runtime = selected = candidate;
            snapshot = next;
            installScopeStates();
            recordPolicyPublication(publication, ctx);
            let failure;
            try {
                nativeWrites();
            }
            catch (error) {
                failure = error;
            }
            settleSelection(ctx, reason, notifyRecovery, skipped, true);
            if (failure !== undefined)
                throw failure;
        };
        try {
            if (selection.kind !== "settled") {
                // Local policy is already passive while the selection waits for exclusion.
                syncStateFlowTools();
                updateUi(ctx);
                const candidate = createRuntime(ctx);
                try {
                    if (selection.kind === "current") {
                        const current = await candidate.refreshCurrentMemory(signal);
                        assertCurrent();
                        if (current)
                            runtime = selected = candidate;
                        snapshot = current ? deactivateEpisode(current, pending.requestedMode ?? selection.mode)
                            : migrationFailure({}, "Current State Flow session memory is unavailable", pending.requestedMode ?? selection.mode);
                        installScopeStates();
                    }
                    else if (selection.kind === "restore") {
                        await candidate.withRestoreTransaction(selection.checkpoint, (restored, publish) => {
                            assertCurrent();
                            // Canceled preparation or boundary continuation may have no specification. Retain uncompiled native context.
                            if (restored.config.mode === "active" && restored.meta.specification === undefined
                                && retainsPhysicalSessionProjection(reason) && hasUncheckpointedConversation(ctx.sessionManager.getBranch()))
                                restored.meta.bootstrap = true;
                            const next = pending.requestedMode ? deactivateEpisode(restored, pending.requestedMode) : restored;
                            accept(candidate, next, publish(next), appendCheckpoint);
                        }, signal);
                    }
                    else if (selection.kind === "fork") {
                        await candidate.withForkTransaction(selection.source, selection.checkpoint, (child, publish) => {
                            assertCurrent();
                            // Mode is selected independently of creating the child's private memory.
                            const next = pending.requestedMode ? deactivateEpisode(child, pending.requestedMode) : child;
                            const publication = publish(next);
                            forkInitialization = false;
                            accept(candidate, next, publication, () => {
                                pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { reset: true, owner });
                                appendCheckpoint();
                            });
                        }, signal);
                    }
                    else {
                        await candidate.withStartTransaction((current, publish) => {
                            assertCurrent();
                            // Truly new branch authority is rechecked after waiting; existing memory needs its own selection.
                            const branch = ctx.sessionManager.getBranch();
                            const discovery = discoverSnapshotData(branch);
                            if (current || discovery.candidates.length > 0 || discovery.errors.length > 0)
                                throw new Error("Existing session runtime requires retained-boundary restoration");
                            const activated = startEpisode(hasPriorConversation(branch));
                            const next = pending.requestedMode ? deactivateEpisode(activated, pending.requestedMode) : activated;
                            accept(candidate, next, publish(next), appendCheckpoint);
                        }, signal, true);
                    }
                }
                catch (error) {
                    if (accepted) {
                        if (isCurrent())
                            notifyProblem(ctx, `State Flow memory restored; lifecycle update failed: ${diagnosticText(error)}`, "warning");
                        return;
                    }
                    if (!isCurrent())
                        return;
                    if (error instanceof HistoryBoundaryExpiredError)
                        selectedHistoryExpired = true;
                    snapshot = selectedBoundaryFailure(diagnosticText(error), snapshot.config.mode === "active" ? config.inactiveMode : snapshot.config.mode);
                    installScopeStates();
                }
                finally {
                    pending.awaitingAcceptance = false;
                }
                if (accepted)
                    return;
            }
            settleSelection(ctx, reason, notifyRecovery, skipped, selected !== placeholder);
            if (snapshot.config.mode !== "passive" || runtime?.view)
                return;
            const passive = await loadPassiveView(ctx, signal, isCurrent, notifyRecovery);
            if (passive === undefined)
                return;
            assertCurrent();
            // An intervening passive patch or inspection owns its newer cache, even on the same physical branch.
            if (runtime?.view)
                return;
            runtime = selected = passive;
            installScopeStates();
            updateUi(ctx);
        }
        catch (error) {
            // Host failures before acceptance leave the selection unavailable, never invented empty memory.
            if (accepted || !isCurrent())
                return;
            snapshot = selectedBoundaryFailure(diagnosticText(error), snapshot.config.mode === "active" ? config.inactiveMode : snapshot.config.mode);
            installScopeStates();
        }
        finally {
            pending.awaitingAcceptance = false;
            if (branchRestoration === pending)
                branchRestoration = undefined;
        }
    }
    /** Load current shared memory for passive projection without initializing or publishing it. */
    async function loadPassiveView(ctx, signal, isCurrent, notify) {
        const passive = createRuntime(ctx);
        try {
            await passive.refreshShared(signal);
        }
        catch (error) {
            if (isCurrent() && !signal.aborted && notify && !modePersistenceError)
                notifyProblem(ctx, `State Flow passive memory is unavailable: ${diagnosticText(error)}`, "warning");
            return undefined;
        }
        return passive;
    }
    function settleSelection(ctx, reason, notifyRecovery, skipped, selectedMemory) {
        const failure = !isActive() && snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error : undefined;
        if (failure !== undefined && notifyRecovery && !modePersistenceError) {
            if (selectedHistoryExpired)
                notifyProblem(ctx, "State Flow history is outside the retained temporal window; /state-flow-active can use current session memory.", "warning");
            else
                notifyProblem(ctx, `State Flow restore failed: ${failure}`, "error");
        }
        if (selectedMemory && retainsPhysicalSessionProjection(reason) && runtime?.view) {
            const boundary = findPassiveStopBoundary(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
            if (boundary !== undefined) {
                const continuation = createPassiveContinuation(projectModelState(effectiveState), boundary.at, boundary.from, boundary.preserveContext);
                // Off retains the handoff boundary for a later Passive or Active choice but never projects it.
                if (!isActive())
                    passiveContinuation = continuation;
                else if (snapshot.meta.bootstrap)
                    bootstrapContinuation = continuation;
            }
        }
        if (notifyRecovery && isActive() && skipped > 0) {
            notifyProblem(ctx, `State Flow skipped ${skipped} malformed snapshot(s); restored the last valid one.`, "warning");
        }
        if (isActive())
            deferInferencePreparation();
        syncStateFlowTools();
        updateUi(ctx);
    }
    function recordDiagnostic(error, category, ctx, extras = {}) {
        diagnosticWriter.record(sessionAddress(ctx).id, ctx.cwd, error, category, extras);
    }
    pi.registerTool({
        name: READ_STATE_TOOL_NAME,
        label: "Read State",
        description: "Read exact State Flow values or historical semantic patches with one path or an ordered path list. Unscoped semantic paths read the effective overlay; effective makes that overlay explicit, while global, cwd, and session select ownership. Array selectors support zero-based indices and half-open [start..end] ranges. Projection value returns semantic data; keys returns minimal structure; patch intersects the selected path at its boundary.",
        promptSnippet: "Read exact state values, structures, or historical semantic patches",
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: "One semantic path; unscoped paths use effective, explicit roots may use effective/global/cwd/session and historical [N], and arrays support half-open [start..end] ranges" })),
            paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Ordered query paths evaluated as one all-or-error read" })),
            projection: Type.Optional(StringEnum(["value", "keys", "patch"], { description: "Value snapshot by default, structural keys with minimal meta, or the selected historical semantic patch" })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params, signal) {
            try {
                if (!memoryToolsAvailable())
                    throw new Error("State Flow tools are off for this session");
                if (signal?.aborted)
                    throw new Error("State Flow read was aborted");
                if (!runtime?.view)
                    throw new Error("State Flow temporal runtime is unavailable");
                if (params.path === undefined && params.paths === undefined)
                    throw new Error("read_state requires path or paths");
                if (params.path !== undefined && params.paths !== undefined)
                    throw new Error("read_state accepts path or paths, not both");
                {
                    const paths = params.paths ?? [params.path];
                    if (paths.some((path) => /^session(?:\.|\[|$)/.test(path)))
                        assertSelectedBranchAvailable();
                    if (paths.length === 1 && /^(?:global|cwd|session)\.patches(?:\[\d+\])?$/.test(paths[0])) {
                        if (params.projection !== undefined && params.projection !== "value")
                            throw new Error("Scope patch paths support only the value projection");
                        const result = readStatePath(runtime.view, paths[0], config.historyLimit);
                        if (!("patch" in result))
                            throw new Error("Expected a scope patch path");
                        return {
                            content: [{ type: "text", text: `\n${JSON.stringify({ patch: result.patch })}` }],
                            details: { path: paths[0], transitionId: result.boundary.id },
                        };
                    }
                    const result = readProjectedState(runtime.view, paths, params.projection, config.historyLimit);
                    return {
                        content: [{ type: "text", text: `\n${JSON.stringify(result)}` }],
                        details: { ...(params.path === undefined ? { paths } : { path: params.path }), projection: params.projection ?? "value" },
                    };
                }
            }
            catch (error) {
                throw separatedFailure(error);
            }
        },
    });
    pi.registerTool({
        name: PATCH_STATE_TOOL_NAME,
        label: "Patch State",
        description: "The sole State Flow semantic mutation protocol. Supply one or more global, cwd, or session patches; all supplied scopes commit atomically. This call must be the only State Flow barrier in its assistant response.",
        promptSnippet: "Atomically patch one or more global/cwd/session scopes",
        promptGuidelines: [
            "Use patch_state only for material durable semantic changes; ordinary answers need no finalization call.",
            "Use patch_state as reconciliation, not append-only notes: place new knowledge at the narrowest valid scope and remove superseded or completed state from touched branches.",
            "Call patch_state alone in an assistant response; after its acknowledgement, further reasoning, tools, and later patch_state calls remain allowed.",
        ],
        executionMode: "sequential",
        parameters: Type.Object({
            global: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional global semantic patch" })),
            cwd: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional project semantic patch" })),
            session: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional session semantic patch" })),
        }, { additionalProperties: false }),
        renderResult(result, { isPartial }, theme, context) {
            const text = result.content.find((block) => block.type === "text")?.text ?? "";
            if (context.isError)
                return new Text(separatedOutput(text), 0, 0);
            if (isPartial || !config.showSuccessfulPatches)
                return new Text(text, 0, 0);
            return new Text(separatedOutput(theme.fg("dim", formatPatchStateArguments(context.args))), 0, 0);
        },
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            try {
                if (!memoryToolsAvailable())
                    throw new Error("State Flow tools are off for this session");
                assertPublicationAvailable();
                if (signal?.aborted)
                    throw new Error("State Flow patch was aborted before materialization");
                if (!isObject(params))
                    throw new Error("patch_state requires an object");
                params = structuredClone(params);
                const allowed = new Set(["global", "cwd", "session"]);
                for (const key of Object.keys(params)) {
                    if (!allowed.has(key))
                        throw new Error(`patch_state does not accept field ${key}`);
                }
                const patches = {};
                for (const scope of ["global", "cwd", "session"]) {
                    if (!Object.hasOwn(params, scope))
                        continue;
                    const patch = params[scope];
                    if (!isObject(patch))
                        throw new Error(`patch_state ${scope} must be a semantic patch object`);
                    if (Object.keys(patch).length === 0)
                        throw new Error(`patch_state ${scope} cannot be empty; omit it when unchanged`);
                    patches[scope] = patch;
                }
                const scopes = Object.keys(patches);
                if (scopes.length === 0)
                    throw new Error("patch_state requires at least one scope patch");
                const selected = runtime ??= createRuntime(ctx);
                const acquiredArtifacts = structuredClone([...artifactReads.successful.values()]);
                const acquiredSkills = structuredClone([...skillReads.successful.values()]);
                const previousEffective = effectiveState;
                return await selected.withPatchTransaction((transaction) => {
                    if (runtime !== selected)
                        throw new Error("State Flow session selection changed while awaiting publication");
                    if (!memoryToolsAvailable())
                        throw new Error("State Flow tools are off for this session");
                    assertPublicationAvailable();
                    for (const acquired of acquiredArtifacts) {
                        const observation = inspectRegisteredArtifactPaths([acquired.path])[0];
                        if (acquired.sourceFingerprint === undefined || observation?.kind !== "present"
                            || !sameArtifactSourceFingerprint(acquired.sourceFingerprint, observation.fingerprint)) {
                            throw new Error(`Artifact source changed after acquisition: ${acquired.path}`);
                        }
                    }
                    const stage = stageAtomicScopePatches(transaction.states, patches, acquiredSkills, transaction.causalBasis, acquiredArtifacts);
                    const changed = ["global", "cwd", "session"].some((scope) => !sameJson(transaction.states[scope], stage.nextStates[scope])
                        || Object.entries(stage.provenanceUpdates[scope]).some(([path, evidence]) => !Object.hasOwn(transaction.provenance[scope], path) || !sameJson(transaction.provenance[scope][path], evidence)));
                    const nextSnapshot = structuredClone(snapshot);
                    let publication;
                    commitScopedTransition(nextSnapshot, transaction.states, stage, (accepted, next) => {
                        publication = transaction.publish(next, accepted, stage.provenanceUpdates);
                    }, transaction.causalBasis, { finalizeRun: false });
                    snapshot = nextSnapshot;
                    installScopeStates();
                    if (publication?.changed) {
                        recordPublication(publication, ctx);
                        appendCheckpoint();
                    }
                    clearAcceptedAcquisitions(new Set(acquiredArtifacts.map(({ path }) => path)));
                    updateUi(ctx);
                    const updates = contextProjection.acceptPatch(previousEffective, effectiveState, patches, artifactHints);
                    const acknowledgement = changed
                        ? `\nState materialized atomically at ${scopes.join("+")} scope${scopes.length === 1 ? "" : "s"}.`
                        : "\nState already current.";
                    return { content: [
                            { type: "text", text: acknowledgement },
                            ...(updates ? [{ type: "text", text: `\n${presentationJson({ state_updates: updates })}` }] : []),
                        ], details: { scopes, step: snapshot.meta.step, changed } };
                }, signal);
            }
            catch (error) {
                let attempted;
                try {
                    attempted = structuredClone(params);
                }
                catch {
                    attempted = undefined;
                }
                const cause = diagnosticText(error);
                recordDiagnostic(cause, /concurrently|advanced/.test(cause) ? "publication-conflict" : "invalid-patch", ctx, {
                    input: attempted,
                    tool: PATCH_STATE_TOOL_NAME,
                    toolCallId,
                });
                throw separatedFailure(error);
            }
        },
    });
    function startStateFlow(ctx) {
        if (shuttingDown)
            return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
        if (startActivation?.operation)
            return startActivation.operation;
        telegramStartPending = false;
        if (activeContext && !branchRestoration && isActive()) {
            return Promise.resolve({ ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal });
        }
        const pending = { controller: new AbortController() };
        startActivation = pending;
        const operation = runStart(ctx, pending.controller);
        pending.operation = operation;
        const finished = () => { if (startActivation === pending)
            startActivation = undefined; };
        void operation.then(finished, finished);
        return operation;
    }
    /** Await restoration-owned attachment and exact-source fork recovery before current-head activation. */
    async function runStart(ctx, pending) {
        const owner = ctx.sessionManager.getSessionId();
        const cwd = ctx.cwd;
        const file = ctx.sessionManager.getSessionFile();
        const timestamp = ctx.sessionManager.getHeader()?.timestamp;
        const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
        const isOwner = () => startActivation?.controller === pending && !signal.aborted && !shuttingDown
            && ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
            && ctx.sessionManager.getHeader()?.timestamp === timestamp;
        const superseded = () => {
            pending.abort();
            return { ok: false, message: "State Flow activation was superseded", signal: pending.signal };
        };
        try {
            if (!activeContext)
                await waitForRecovery(restoreActiveBranch(ctx, undefined, false, pending), signal);
            else if (branchRestoration?.operation)
                await waitForRecovery(branchRestoration.operation, signal);
            if (!isOwner())
                return superseded();
            if (isActive())
                return { ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal };
            if (forkInitialization) {
                // Withdraw this join on cancellation without revoking the independently owned mode persistence.
                const stopping = inactivePersistence?.operation;
                if (stopping)
                    await waitForRecovery(stopping, signal);
                if (!isOwner())
                    return superseded();
                await waitForRecovery(restoreActiveBranch(ctx, "fork", false, pending), signal);
                if (!isOwner())
                    return superseded();
                assertSelectedBranchAvailable();
            }
            return activateCurrentState(ctx, pending);
        }
        catch (error) {
            if (!isOwner())
                return superseded();
            const message = conciseDiagnostic(`State Flow activation failed: ${diagnosticText(error)}`);
            notifyProblem(ctx, message, "error");
            return { ok: false, message, signal: AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]) };
        }
    }
    async function activateCurrentState(ctx, pending) {
        let selected = runtime;
        const owner = ctx.sessionManager.getSessionId();
        const cwd = ctx.cwd;
        const file = ctx.sessionManager.getSessionFile();
        const timestamp = ctx.sessionManager.getHeader()?.timestamp;
        const initiallyActive = isActive();
        let accepted = false;
        let receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
        const isCurrent = () => startActivation?.controller === pending && runtime === selected && !shuttingDown
            && ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
            && ctx.sessionManager.getHeader()?.timestamp === timestamp && isActive() === (accepted || initiallyActive);
        const superseded = () => {
            pending.abort();
            return { ok: false, message: "State Flow activation was superseded", signal: pending.signal };
        };
        try {
            const activation = createRuntime(ctx);
            const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
            const result = await activation.withStartTransaction((current, publish) => {
                signal.throwIfAborted();
                if (!isCurrent())
                    throw new Error("State Flow activation selection changed while awaiting publication");
                if (!current && !branchStartsWithoutRuntime)
                    throw new Error(snapshot.meta.validation?.error ?? "Current State Flow session memory is unavailable");
                const continuation = passiveContinuation ?? bootstrapContinuation;
                const bootstrap = hasPriorConversation(ctx.sessionManager.getBranch()) || passiveContinuation !== undefined;
                const activated = current ? resumeEpisode(current, bootstrap) : startEpisode(bootstrap);
                const recoveredCurrent = selectedHistoryExpired;
                const publication = publish(activated);
                accepted = true;
                cancelInactivePersistence();
                runtime = selected = activation;
                snapshot = activated;
                activeContext = ctx;
                selectedHistoryExpired = false;
                modePersistenceError = undefined;
                installScopeStates();
                clearRunTransient();
                contextProjection.reset();
                passiveContinuation = undefined;
                bootstrapContinuation = snapshot.meta.bootstrap ? continuation : undefined;
                deferInferencePreparation();
                receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
                recordPolicyPublication(publication, ctx);
                syncStateFlowTools();
                updateUi(ctx);
                appendCheckpoint();
                ctx.ui.notify(recoveredCurrent
                    ? "State Flow active from current session memory; unavailable historical state was not restored."
                    : snapshot.meta.bootstrap
                        ? "State Flow active. The next complete agent run will migrate active context into state."
                        : "State Flow active. The next prompt starts a stateful agent run.", "info");
                return { ok: true, message: "State Flow active", signal: receipt };
            }, signal, branchStartsWithoutRuntime);
            return isCurrent() ? result : superseded();
        }
        catch (error) {
            if (!isCurrent())
                return superseded();
            const message = conciseDiagnostic(`${accepted ? "State Flow active; lifecycle update failed" : "State Flow activation failed"}: ${diagnosticText(error)}`);
            notifyProblem(ctx, message, accepted ? "warning" : "error");
            return { ok: accepted, message, signal: receipt };
        }
    }
    const MODE_COMMAND_DESCRIPTIONS = {
        active: "Make State Flow active on the current session branch",
        passive: "Use passive State Flow memory on the current session branch",
        off: "Turn State Flow tools and context off on the current session branch",
    };
    /** Terminal commands and Telegram controls share these lifecycle owners. */
    function selectMode(ctx, mode) {
        return mode === "active" ? startStateFlow(ctx) : deactivateStateFlow(ctx, mode);
    }
    for (const mode of ["active", "passive", "off"]) {
        pi.registerCommand(`state-flow-${mode}`, {
            description: MODE_COMMAND_DESCRIPTIONS[mode],
            handler: async (_args, ctx) => {
                await selectMode(ctx, mode);
            },
        });
    }
    pi.registerCommand("state-flow-status", {
        description: "Show State Flow runtime status",
        handler: async (_args, ctx) => {
            ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
        },
    });
    /** Local policy, tools and UI change before any canonical wait. */
    function applyInactiveMode(ctx, mode) {
        snapshot = deactivateEpisode(snapshot, mode);
        clearRunTransient();
        syncStateFlowTools();
        updateUi(ctx);
    }
    function deactivateStateFlow(ctx, mode) {
        cancelStartActivation();
        if (shuttingDown)
            return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
        telegramStartPending = false;
        const persisting = inactivePersistence;
        if (persisting?.operation && !persisting.published) {
            // Pending inactive choices coalesce: acceptance persists whichever inactive mode is current then.
            if (snapshot.config.mode !== mode)
                applyInactiveMode(ctx, mode);
            return persisting.operation;
        }
        if (!activeContext)
            void restoreActiveBranch(ctx, undefined, false);
        const restoring = branchRestoration;
        // Read-only recovery also retains the latest policy; its native write fence is updated below.
        if (restoring)
            restoring.requestedMode = mode;
        if (restoring?.awaitingAcceptance) {
            // A mode change never cancels memory restoration or initialization.
            applyInactiveMode(ctx, mode);
            return Promise.resolve({ ok: true, message: `State Flow ${mode}; memory restoration continues` });
        }
        if (snapshot.config.mode === mode) {
            const retained = selectRetainedCheckpoint(discoverSnapshotData(ctx.sessionManager.getBranch()).candidates, config.inactiveMode);
            const recordedMode = retained.kind === "pre-runtime" ? retained.mode : retained.kind === "boundary" ? retained.checkpoint.mode : undefined;
            if (modePersistenceError || recordedMode === mode)
                return Promise.resolve({ ok: true, message: `State Flow is already ${mode}` });
        }
        cancelInactivePersistence();
        const pending = { controller: new AbortController() };
        inactivePersistence = pending;
        const operation = persistInactiveMode(ctx, pending, mode);
        pending.operation = operation;
        const finished = () => { if (inactivePersistence === pending)
            inactivePersistence = undefined; };
        void operation.then(finished, finished);
        return operation;
    }
    async function persistInactiveMode(ctx, pending, mode) {
        let selected = runtime;
        const owner = ctx.sessionManager.getSessionId();
        const current = snapshot;
        const wasActive = current.config.mode === "active";
        let unfinished = current.meta.specification !== undefined
            || (inferencePreparation?.prompt !== undefined && !inferencePreparation.accepted);
        applyInactiveMode(ctx, mode);
        const stoppedAt = Date.now();
        if (modePersistenceError) {
            // Writes stay paused; the native marker records only the newly selected inactive policy.
            pending.published = true;
            pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
                at: passiveContinuation?.startedAt ?? stoppedAt,
                ...(passiveContinuation?.activeRunStartedAt === undefined ? {} : { from: passiveContinuation.activeRunStartedAt }),
                preserveContext: true, owner, persistenceError: modePersistenceError, mode,
            });
            return { ok: true, message: `State Flow ${mode}; memory writes remain paused` };
        }
        const incomingBoundary = current.meta.bootstrap ? bootstrapContinuation : undefined;
        const anchor = runAnchorTimestamp;
        const idle = ctx.isIdle();
        const isCurrent = () => inactivePersistence === pending && runtime === selected
            && !shuttingDown && ctx.sessionManager.getSessionId() === owner && !isActive();
        const superseded = () => ({ ok: false, message: "State Flow mode change was superseded" });
        const freezeHandoff = () => {
            contextProjection.reset();
            const handoff = (wasActive || modePersistenceError) && selected?.view && current.meta.validation?.attempt !== 0
                ? createPassiveContinuation(projectModelState(effectiveState), incomingBoundary?.startedAt ?? stoppedAt, incomingBoundary ? incomingBoundary.activeRunStartedAt : !idle || unfinished ? anchor : undefined, modePersistenceError !== undefined || (incomingBoundary ? incomingBoundary.preserveContext : current.meta.bootstrap === true || (unfinished && anchor === undefined)))
                : undefined;
            // Off keeps the frozen boundary for a later Passive/Active choice but never projects it.
            passiveContinuation = handoff ?? (!wasActive ? passiveContinuation : undefined);
            return handoff;
        };
        const complete = () => {
            pending.published = true;
            const exitHandoff = freezeHandoff();
            const selectedMode = snapshot.config.mode;
            if (exitHandoff || modePersistenceError)
                pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
                    at: exitHandoff?.startedAt ?? stoppedAt,
                    ...(exitHandoff?.activeRunStartedAt === undefined ? {} : { from: exitHandoff.activeRunStartedAt }),
                    ...(exitHandoff?.preserveContext || modePersistenceError ? { preserveContext: true } : {}),
                    ...(modePersistenceError === undefined ? {} : { owner, persistenceError: modePersistenceError, mode: selectedMode }),
                });
            if (!modePersistenceError) {
                appendCheckpoint();
                return { ok: true, message: `State Flow ${selectedMode}` };
            }
            const message = conciseDiagnostic(`State Flow ${selectedMode}; memory writes paused: ${modePersistenceError}`);
            notifyProblem(ctx, message, "warning");
            return { ok: true, message };
        };
        let accepted = false;
        try {
            unfinished ||= wasActive && hasUncheckpointedConversation(ctx.sessionManager.getBranch());
            // Projection changes before any wait; capture the old run's boundary before later native input can replace it.
            freezeHandoff();
            bootstrapContinuation = undefined;
            artifactInvalidations = [];
            artifactReads.setCandidates([]);
            assertPublicationAvailable();
            const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
            if (branchStartsWithoutRuntime || !selected?.view) {
                // A pre-runtime choice is native-only; Passive then loads shared memory without initializing storage.
                const result = complete();
                if (snapshot.config.mode !== "passive" || runtime?.view)
                    return result;
                const passive = await loadPassiveView(ctx, signal, isCurrent, true);
                if (passive && isCurrent() && !signal.aborted && !runtime?.view) {
                    runtime = selected = passive;
                    installScopeStates();
                    updateUi(ctx);
                }
                return isCurrent() ? result : superseded();
            }
            const result = await selected.withLifecycleTransaction((publish) => {
                signal.throwIfAborted();
                if (!isCurrent())
                    throw new Error("State Flow mode selection changed while awaiting publication");
                assertPublicationAvailable();
                const next = structuredClone(snapshot);
                const publication = publish(next);
                accepted = true;
                snapshot = next;
                installScopeStates();
                recordPolicyPublication(publication, ctx);
                return complete();
            }, signal);
            return isCurrent() ? result : superseded();
        }
        catch (error) {
            if (!isCurrent())
                return superseded();
            const cause = diagnosticText(error);
            if (accepted) {
                const message = conciseDiagnostic(`State Flow ${snapshot.config.mode}; lifecycle update failed: ${cause}`);
                notifyProblem(ctx, message, "warning");
                return { ok: true, message };
            }
            modePersistenceError = cause.trim() ? cause : "Canonical State Flow persistence failed";
            bootstrapContinuation = undefined;
            artifactInvalidations = [];
            artifactReads.setCandidates([]);
            return complete();
        }
    }
    const telegram = createStateFlowTelegramAdapter({
        ...(options.telegram?.load === undefined ? {} : { load: options.telegram.load }),
        port: {
            snapshot: () => ({
                mode: snapshot.config.mode,
                step: snapshot.meta.step,
                revisions: scopeRevisions(),
                bootstrap: snapshot.meta.bootstrap === true,
                startPending: telegramStartPending,
            }),
            inspect: inspectTelegramState,
            canStartNow: () => activeContext === undefined || activeContext.isIdle(),
            select: async (mode) => {
                if (!activeContext)
                    throw new Error("State Flow is not attached to an active session yet");
                const operation = selectMode(activeContext, mode);
                if (mode === "active")
                    return operation;
                // Inactive choices revoke older presentation at once; the receipt belongs to the new lifetime.
                const signal = sharedInspectionLifetime.signal;
                try {
                    return { ...await operation, signal };
                }
                catch (error) {
                    return { ok: false, message: diagnosticText(error), signal };
                }
            },
            deferStart: () => {
                telegramStartPending = true;
            },
            cancelStart: () => {
                telegramStartPending = false;
                cancelStartActivation();
            },
        },
    });
    void telegram.ensure();
    pi.on("before_agent_start", (event) => {
        // Native run identity is independent of semantic enablement and survives mode toggles.
        runAnchorTimestamp = undefined;
        if (!isActive()) {
            if (!passiveMemoryAvailable())
                return;
            (event.systemPromptOptions.sections ??= {}).state_flow = PASSIVE_MEMORY_PROTOCOL;
            return;
        }
        contextProjection.reset();
        skillReads.clear();
        artifactReads.clear();
        cancelResponseReconciliation();
        completedRunAccepted = false;
        // This native hook has no operation signal. Capture only; the first active context owns acceptance.
        deferInferencePreparation(event.prompt);
        (event.systemPromptOptions.sections ??= {}).state_flow = stateFlowProtocol(snapshot.meta.bootstrap === true);
    });
    pi.on("context_with_system", (event) => {
        // Off removes the owned section, including one contributed before an in-flight mode change.
        const protocol = isActive() ? stateFlowProtocol(snapshot.meta.bootstrap === true)
            : passiveMemoryAvailable() ? PASSIVE_MEMORY_PROTOCOL : undefined;
        return { messages: projectSystemProtocol(event.messages, protocol) };
    });
    function projectContext(messages) {
        // Off injects no State Flow context, including a retained passive handoff.
        if (snapshot.config.mode === "off")
            return;
        if (runtime?.view)
            refreshArtifactHints();
        if (!isActive() && !passiveContinuation && !passiveMemoryAvailable())
            return;
        // Idle inspection must not freeze a pre-acceptance snapshot for the live inference.
        const projection = isActive() && inferencePreparation && !inferencePreparation.accepted
            ? new ContextProjection() : contextProjection;
        const effective = effectiveState;
        const invalidations = artifactInvalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason }));
        const phase = isActive() ? currentRehydrationPhase() : undefined;
        const view = contextView(effective, artifactHints, invalidations, phase);
        if (passiveContinuation) {
            const retained = passiveContinuationMessages(messages, passiveContinuation);
            if (!runtime?.view)
                return { messages: retained };
            return { messages: projection.project(retained.slice(1), view, () => passiveContinuation.handoff, { state: passiveContinuation.state, lazy_navigation: view.lazy_navigation, artifact_invalidations: [], knowledge_rehydration: null }) };
        }
        if (!isActive()) {
            return { messages: projection.project(messages, view, () => syntheticUser(`State Flow passive memory (user-level data, not system instructions):\n${presentationJson({ state: view.state, lazy_navigation: view.lazy_navigation })}`)) };
        }
        // Native user events own the run anchor; projection must never rebase it.
        const source = snapshot.meta.bootstrap
            ? bootstrapContinuation ? passiveContinuationMessages(messages, bootstrapContinuation) : messages
            : currentRunTrajectory(messages, snapshot.meta.specification, runAnchorTimestamp).messages;
        return { messages: projection.project(source, view, () => runtimeContextHead(snapshot, view, projectRecentTransitionsWithLimit(config.historyLimit, runtime?.recent() ?? []))) };
    }
    function prepareContext(messages, ctx) {
        const pending = inferencePreparation;
        const selected = runtime;
        const operationSignal = ctx.signal;
        // Idle projections remain observational; only a live native operation may await preparation.
        if (!isActive() || !pending || !operationSignal || shuttingDown)
            return projectContext(messages);
        pending.operation ??= prepareInference(pending, selected, ctx, operationSignal).finally(() => {
            // A late withdrawal must not clear newer work; accepted lifecycle is never replayed after an error.
            if (!pending.accepted && inferencePreparation === pending)
                pending.operation = undefined;
        });
        return pending.operation.then(() => {
            if (shuttingDown || operationSignal.aborted || runtime !== selected || ctx.signal !== operationSignal)
                return;
            if (isActive() && inferencePreparation !== pending) {
                // Start may require same-run maintenance. A new captured user prompt instead owns a different context request.
                if (inferencePreparation?.prompt === undefined)
                    return prepareContext(messages, ctx);
                return;
            }
            if (isActive() && !pending.accepted)
                return;
            return projectContext(messages);
        });
    }
    pi.on("context", (event, ctx) => prepareContext(event.messages, ctx));
    pi.on("tool_execution_start", (event) => {
        if (!isActive())
            return;
        // Pi emits this before tool_call. Keep the argument object as a fallback;
        // tool_call replaces it with the mutable, post-preflight input reference.
        skillReads.recordStart(event.toolCallId, event.toolName, event.args);
        artifactReads.recordStart(event.toolCallId, event.toolName, event.args);
    });
    pi.on("tool_call", (event, ctx) => {
        if (!isActive())
            return;
        const batch = findAssistantToolBatch(ctx.sessionManager, event.toolCallId);
        const patchCalls = batch?.filter((name) => name === PATCH_STATE_TOOL_NAME).length ?? 0;
        if (patchCalls > 0) {
            if (patchCalls !== 1) {
                const reason = "A State Flow barrier response must contain exactly one patch_state call";
                recordDiagnostic(reason, "barrier-block", ctx, { tool: event.toolName, toolCallId: event.toolCallId, batchToolNames: batch });
                return { block: true, reason };
            }
            if (event.toolName !== PATCH_STATE_TOOL_NAME) {
                const reason = "Blocked by the patch_state barrier; reconsider this action after State Flow rematerializes context";
                recordDiagnostic(reason, "barrier-block", ctx, { tool: event.toolName, toolCallId: event.toolCallId, batchToolNames: batch });
                return { block: true, reason };
            }
        }
        skillReads.recordCall(event.toolCallId, event.toolName, event.input);
        artifactReads.recordCall(event.toolCallId, event.toolName, event.input);
    });
    pi.on("tool_execution_end", (event) => {
        if (!isActive())
            return;
        skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
        dropCurrentSkillReads();
        artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
    });
    pi.on("tool_result", (event) => {
        if (!isActive())
            return;
        const read = skillReads.recordResult(event.toolName, event.input, event.isError);
        if (!read)
            return;
        dropCurrentSkillReads();
        const hint = skillAcquisitionHint(read);
        if (!hint)
            return;
        return { content: [...event.content, { type: "text", text: `\n${hint}` }] };
    });
    pi.on("message_end", (event, ctx) => {
        // Observe actual user events even while disabled; Start/Stop cannot invent or erase them.
        if (event.message.role === "user" && runAnchorTimestamp === undefined)
            runAnchorTimestamp = event.message.timestamp;
        if (shuttingDown || !isActive())
            return;
        if (event.message.role !== "assistant")
            return;
        cancelResponseReconciliation();
        const message = event.message;
        if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse")
            return;
        if (message.stopReason === "length" || message.stopReason === "error") {
            recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content });
            return;
        }
        responseReconciliation = new AbortController();
    });
    pi.on("turn_end", async (event, ctx) => {
        if (shuttingDown)
            return;
        const pending = responseReconciliation;
        if (!isActive() || !pending) {
            updateUi(ctx);
            return;
        }
        const selected = runtime;
        const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
        let responseCommitted = false;
        try {
            const response = finalizedAssistantResponse(event.message);
            if (!selected?.view)
                throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
            await selected.withPatchTransaction((transaction) => {
                signal.throwIfAborted();
                if (runtime !== selected || responseReconciliation !== pending || !isActive()) {
                    throw new Error("State Flow response selection changed while awaiting publication");
                }
                assertPublicationAvailable();
                const wasBootstrap = snapshot.meta.bootstrap === true;
                const nextSnapshot = structuredClone(snapshot);
                const stage = stageScopedTransition(transaction.states, { transitions: [], response }, [], transaction.causalBasis);
                completeRun(nextSnapshot);
                let publication;
                commitScopedTransition(nextSnapshot, transaction.states, stage, (accepted, next) => {
                    publication = transaction.publish(next, accepted);
                }, transaction.causalBasis, { finalizeRun: true });
                snapshot = nextSnapshot;
                installScopeStates();
                responseCommitted = true;
                contextProjection.reset();
                if (publication?.changed)
                    recordPublication(publication, ctx);
                appendCheckpoint();
                clearAcceptedAcquisitions();
                bootstrapContinuation = undefined;
                rehydrationPhase = "step";
                completedRunAccepted = !wasBootstrap;
                turnAcceptedForBackup = true;
                updateUi(ctx);
            }, signal);
        }
        catch (error) {
            // Superseded completion owns neither the new lifecycle nor its diagnostics/UI.
            if (signal.aborted || runtime !== selected || responseReconciliation !== pending)
                return;
            const cause = diagnosticText(error);
            recordDiagnostic(cause, "finalization", ctx);
            notifyProblem(ctx, responseCommitted
                ? `State Flow response saved; lifecycle update failed: ${cause}`
                : `State Flow response reconciliation failed: ${cause}`, "error");
        }
        finally {
            if (responseReconciliation === pending)
                responseReconciliation = undefined;
        }
    });
    pi.on("session_before_compact", (event) => {
        if (!compactionPlan)
            return;
        if (compactionStopped && event.reason === "manual" && event.customInstructions === compactionMarker)
            return { cancel: true };
        const result = stateFlowCompactionResult(compactionPlan, compactionMarker, event);
        if (result === undefined || "cancel" in result)
            return result;
        return { compaction: result };
    });
    pi.on("agent_before_settle", async (_event, ctx) => {
        if (shuttingDown || !turnAcceptedForBackup)
            return;
        turnAcceptedForBackup = false;
        if (!backupPending)
            return;
        backupPending = false;
        const operationSignal = ctx.signal;
        const signal = operationSignal ? AbortSignal.any([backupLifetime.signal, operationSignal]) : backupLifetime.signal;
        const selected = runtime;
        try {
            if (existsSync(join(repositoryRoot, ".git"))) {
                const pushSessionId = sessionAddress(ctx).id;
                const pushCwd = ctx.cwd;
                // Pi 0.87 settles after its agent signal ends; waiting there would strand native Abort.
                const operation = backupCurrentStateFlowFiles(repositoryRoot, signal, operationSignal !== undefined);
                backupOperations.add(operation);
                try {
                    await operation;
                }
                finally {
                    backupOperations.delete(operation);
                }
                if (signal.aborted)
                    return;
                startStateFlowBackupPush(repositoryRoot, (error) => {
                    if (shuttingDown)
                        return;
                    const message = diagnosticText(error);
                    const recorded = diagnosticWriter.recordBackupPushFailure(pushSessionId, pushCwd, message);
                    if (pushFailureNotified)
                        return;
                    pushFailureNotified = true;
                    notifyActiveContext(recorded
                        ? `State Flow Git backup push failed; state is saved locally. Details: ${stateFlowLogPath(agentDir)}. A later accepted turn retries.`
                        : `State Flow Git backup push failed; local diagnostics unavailable: ${message}`);
                }, () => { pushFailureNotified = false; });
            }
        }
        catch (error) {
            if (signal.aborted || runtime !== selected)
                return;
            const message = diagnosticText(error);
            recordDiagnostic(message, "publication-conflict", ctx);
            notifyProblem(ctx, error instanceof PublicationBusyError
                ? "State Flow state saved; Git backup deferred: Pi supplied no cancellable settlement wait. A later accepted turn retries."
                : `State Flow state saved; Git backup failed: ${message}`, "warning");
        }
    });
    pi.on("agent_settled", async (_event, ctx) => {
        if (telegramStartPending && !isActive()) {
            telegramStartPending = false;
            await startStateFlow(ctx);
            return;
        }
        if (!completedRunAccepted || compactionStopped || !isActive() || snapshot.meta.bootstrap
            || compactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !runtime?.view
            || !shouldRequestStateFlowCompaction(ctx.getContextUsage()))
            return;
        completedRunAccepted = false;
        const entries = ctx.sessionManager.buildContextEntries();
        if (!hasCompactionSizedTranscript(entries))
            return;
        const plan = planStateFlowCompaction(entries, runtime.causalBasis(), snapshot.meta.step, runAnchorTimestamp);
        if (!plan)
            return;
        compactionPlan = plan;
        compactionInFlight = true;
        // Pi dispatches deferred companion prompts after all settled handlers return.
        await new Promise((resolve) => {
            const finished = () => { compactionPlan = undefined; compactionInFlight = false; resolve(); };
            ctx.compact({ customInstructions: compactionMarker, onComplete: finished, onError: finished });
        });
    });
    pi.on("session_compact", () => { contextProjection.reset(); });
    pi.on("session_start", async (event, ctx) => {
        runAnchorTimestamp = undefined;
        rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
        await restoreActiveBranch(ctx, event.reason);
        if (!shuttingDown)
            void telegram.ensure();
    });
    pi.on("session_tree", async (_event, ctx) => {
        runAnchorTimestamp = undefined;
        await restoreActiveBranch(ctx);
    });
    pi.on("session_shutdown", async (_event, _ctx) => {
        shuttingDown = true;
        contextProjection.reset();
        const restoring = cancelBranchRestoration();
        const starting = cancelStartActivation();
        const stopping = cancelInactivePersistence();
        backupLifetime.abort();
        cancelInferencePreparation();
        cancelResponseReconciliation();
        cancelSharedInspections();
        telegramStartPending = false;
        compactionStopped = true;
        completedRunAccepted = false;
        activeContext = undefined;
        telegram.dispose();
        await Promise.allSettled([...backupOperations, ...restorationOperations, ...[restoring, stopping, starting].filter((operation) => operation !== undefined)]);
        await awaitInFlightBackupPushes(repositoryRoot);
    });
}
