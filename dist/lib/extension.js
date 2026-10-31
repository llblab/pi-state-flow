import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ArtifactAcquisitionState, missingArtifactRemovals } from "./acquisition.js";
import { inspectRegisteredArtifactPaths, sameArtifactSourceFingerprint } from "./artifact.js";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, StateFlowCompactionRequests } from "./compaction.js";
import { inactiveModeFor, loadStateFlowConfig } from "./config.js";
import { ContextProjection, contextView, createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, projectSystemProtocol, runtimeContextHead, passiveContextHead, moduleConversationSource, projectModuleContext } from "./context.js";
import { readNativeSessionHeader } from "./continuation.js";
import { cwdScopeKey, resolveSessionAddress, sessionScopeKey, } from "./durable.js";
import { completeRun, deactivateEpisode, prepareRun, resumeEpisode, startEpisode } from "./episode.js";
import { awaitInFlightBackupPushes, backupCurrentStateFlowFiles, SettledTurnBackup, startStateFlowBackupPush } from "./git.js";
import { projectRecentTransitionsWithLimit } from "./history.js";
import { isObject, presentationJson, sameJson } from "./json.js";
import { StateFlowDiagnosticWriter, stateFlowLogPath } from "./logging.js";
import { normalizeModelPatches, normalizeModelReadPath, projectModelReferences, projectModelArtifactTarget, projectModelMissingDeletion } from "./model-interface.js";
import { StateFlowModuleHost } from "./module-registry.js";
import { prepareModuleContext } from "./semantic-module.js";
import { assistantToolCallCount, conciseDiagnostic, diagnosticText, finalizedAssistantResponse, formatPatchStateArguments, passiveMemoryProtocol, RESPONSE_PATCH_GUIDELINE, SCOPE_PARTICIPATION_GUIDELINE, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.js";
import { OwnedOperationSlot, RenewableLifetime } from "./operation.js";
import { readProjectedState, readStatePath } from "./query.js";
import { selectedBoundaryFailure, selectRetainedCheckpoint, waitForRecovery } from "./recovery.js";
import { TemporalRuntime } from "./runtime.js";
import { prepareSelectedBranchPolicy, captureSelectedNativeMarker, NativeToolRequestCorrelation, SelectedPolicyLifetime, discoverSnapshotData, findAssistantToolBatch, hasPriorConversation, hasUncheckpointedConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.js";
import { hasCompiledSkillArtifact, hashSkillSource, registeredSkillResolver, SkillReadTracker } from "./skills.js";
import { emptySnapshot, isActiveRestorationBlocked, migrationFailure } from "./snapshot.js";
import { emptyState, projectStateForModel } from "./state.js";
import { compactStatus, detailedStatus, STATUS_KEY } from "./status.js";
import { PublicationBusyError, loadSelectedFileCohort } from "./storage.js";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, parseScopeSelectionArguments, scopeSelectionArgumentCompletions } from "./selection.js";
import { createStateFlowTelegramAdapter } from "./telegram.js";
import { readTemporalScopes, temporalScopeRevisions } from "./temporal.js";
import { commitSelectedTransition, stageSelectedScopePatches, stageSelectedScopedTransition } from "./transition.js";
export { formatPatchStateArguments };
export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";
const flatPatchParameters = Type.Object({
    intents: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    strategy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    tactics: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    artifacts: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    lazy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false, minProperties: 1 });
const scopedPatchParameters = Type.Object({
    global: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    cwd: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    session: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false, minProperties: 1 });
export default function stateFlowExtension(pi, options = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    const loadedConfig = loadStateFlowConfig(agentDir, options.repositoryRoot);
    const config = options.mode === undefined ? loadedConfig
        : { ...loadedConfig, mode: options.mode, inactiveMode: inactiveModeFor(options.mode) };
    let snapshot = emptySnapshot(config.inactiveMode);
    let scopeStates = {};
    let effectiveState = {};
    let branchStartsWithoutRuntime = false;
    let modePersistenceError;
    /** One pending inactive-mode persistence; later inactive choices coalesce until it publishes. */
    const inactivePersistence = new OwnedOperationSlot();
    const startActivation = new OwnedOperationSlot();
    let forkInitialization = false;
    const branchRestoration = new OwnedOperationSlot();
    let deferredBranch;
    const responseReconciliation = new OwnedOperationSlot();
    const sharedInspectionLifetime = new RenewableLifetime();
    const memoryToolLifetime = new RenewableLifetime();
    const requestPolicy = new SelectedPolicyLifetime();
    const nativeRequests = new NativeToolRequestCorrelation();
    const moduleHost = new StateFlowModuleHost();
    let guardAbortedOperation;
    let completedRunAccepted = false;
    const compactionRequests = new StateFlowCompactionRequests();
    let passiveContinuation;
    let bootstrapContinuation;
    const contextProjection = new ContextProjection();
    const inferencePreparation = new OwnedOperationSlot();
    let runAnchorTimestamp;
    let runtime;
    let activeContext;
    let rehydrationPhase;
    const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
    const diagnosticWriter = new StateFlowDiagnosticWriter(config.logging, stateFlowLogPath(agentDir), repositoryRoot, (message) => notifyActiveContext(message));
    const backup = new SettledTurnBackup();
    let shuttingDown = false;
    const skillReads = new SkillReadTracker(hashSkillSource, (path) => activeContext
        ? registeredSkillResolver(activeContext.cwd, pi.getCommands())(path)
        : undefined);
    const acquisition = new ArtifactAcquisitionState();
    const artifactReads = acquisition.reads;
    let telegramStartPending = false;
    function sessionAddress(ctx) {
        return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
    }
    /** Native session identity captured before an await; any change supersedes the waiting operation. */
    function sessionIdentity(ctx) {
        const cwd = ctx.cwd;
        const owner = ctx.sessionManager.getSessionId();
        const file = ctx.sessionManager.getSessionFile();
        const timestamp = ctx.sessionManager.getHeader()?.timestamp;
        return () => ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
            && ctx.sessionManager.getHeader()?.timestamp === timestamp;
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
    function modeOperationSignal(ctx, owned) {
        const ambient = ctx.signal;
        if (!ambient || guardAbortedOperation === ambient)
            return owned;
        if (!nativeRequests.ownsOperation(ambient))
            return AbortSignal.any([owned, ambient]);
        // User Abort still cancels in-run commands; only this guard's obsolete-model Abort is unrelated.
        const forwarded = new AbortController();
        const abort = () => { if (guardAbortedOperation !== ambient)
            forwarded.abort(ambient.reason); };
        if (ambient.aborted)
            abort();
        else
            ambient.addEventListener("abort", abort, { once: true, signal: owned });
        return AbortSignal.any([owned, forwarded.signal]);
    }
    function createRuntime(ctx) {
        return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot, undefined, config.historyLimit);
    }
    function projectModelState(state) {
        return projectStateForModel(state, acquisition.hints);
    }
    function assertSelectedBranchAvailable() {
        if (snapshot.meta.validation?.attempt === 0) {
            throw new Error(`State Flow selected branch is unavailable: ${snapshot.meta.validation.error}`);
        }
    }
    options.onRuntime?.({ read: (offset, scope) => {
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
    /** Active lifecycle work requires validated memory, not merely a selected Active policy. */
    function isActive() {
        return snapshot.config.mode === "active" && !isActiveRestorationBlocked(snapshot);
    }
    function readableView(selected = runtime) {
        return selected?.selectedView() ?? selected?.observedSelectedView();
    }
    function nativeScopeSelection(ctx = activeContext) {
        const policy = requestPolicy.policy;
        return ctx && policy?.owner === ctx.sessionManager.getSessionId() && policy.cwd === resolve(ctx.cwd)
            ? policy.scopes : config.scopes;
    }
    function appendNativeMarker(value, ctx = activeContext) {
        pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, captureSelectedNativeMarker({ version: 2,
            owner: ctx.sessionManager.getSessionId(), mode: snapshot.config.mode, scopes: nativeScopeSelection(ctx), ...value }));
    }
    function branchPolicy(ctx, reason, memoryRequired = true) {
        const branch = ctx.sessionManager.getBranch();
        const policy = prepareSelectedBranchPolicy(branch, { owner: ctx.sessionManager.getSessionId(), markerEntryType: PASSIVE_STOP_ENTRY_TYPE,
            defaults: { mode: isNewSession(reason, branch) ? config.mode : config.inactiveMode, scopes: config.scopes },
            inactiveMode: config.inactiveMode, fork: reason === "fork" });
        if (memoryRequired)
            captureScopeSelection(policy.scopes);
        return policy;
    }
    /** Failure-only denial evidence, never policy admission: inspect own known-epoch headers without getters or memory I/O. */
    function failedNativePolicyMode(ctx, reason) {
        const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
        try {
            const inherited = reason === "fork" || typeof ctx.sessionManager.getHeader()?.parentSession === "string";
            for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
                try {
                    if (own(entry, "type") !== "custom")
                        continue;
                    const type = own(entry, "customType"), data = own(entry, "data");
                    if ((type !== SNAPSHOT_ENTRY_TYPE && type !== PASSIVE_STOP_ENTRY_TYPE) || !isObject(data))
                        continue;
                    const epoch = Object.getOwnPropertyDescriptor(data, "version");
                    if (epoch && (!("value" in epoch) || epoch.value !== 2))
                        continue;
                    if (type === PASSIVE_STOP_ENTRY_TYPE && own(data, "owner") !== ctx.sessionManager.getSessionId() && !inherited)
                        continue;
                    const mode = own(data, "mode");
                    if (mode === "active" || mode === "passive" || mode === "off")
                        return mode;
                    if (!epoch && typeof own(data, "enabled") === "boolean")
                        return own(data, "enabled") ? "active" : config.inactiveMode;
                }
                catch { /* Unreadable headers grant no memory participation. */ }
            }
        }
        catch { /* No failure-only mode evidence. */ }
        return undefined;
    }
    function appendCheckpoint() {
        if (runtime?.selectedView()) {
            pi.appendEntry(SNAPSHOT_ENTRY_TYPE, runtime.retainedSelectedCheckpoint(snapshot.config.mode));
            branchStartsWithoutRuntime = false;
        }
        else if (branchStartsWithoutRuntime) {
            // A policy capture cannot turn read-only shared observation into accepted memory.
            appendNativeMarker({});
        }
        else
            throw new Error("State Flow cannot checkpoint an unproven branch; restore current memory first");
    }
    function scopeRevisions() {
        const view = readableView();
        return view ? temporalScopeRevisions(view) : {};
    }
    function updateUi(ctx) {
        ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, scopeRevisions(), (color, text) => ctx.ui.theme.fg(color, text)));
    }
    function cancelSharedInspections() {
        sharedInspectionLifetime.renew(new Error("State Flow inspection was cancelled; select the scope again"));
    }
    function clearRunTransient() {
        inferencePreparation.cancel();
        responseReconciliation.cancel();
        cancelSharedInspections();
        completedRunAccepted = false;
        backup.clearTurn();
        compactionRequests.clear();
        skillReads.clear();
        artifactReads.clear();
    }
    function deferInferencePreparation(prompt) {
        inferencePreparation.cancel();
        inferencePreparation.claim({ controller: new AbortController(), prompt });
        acquisition.clearInvalidations();
    }
    function refreshArtifactHints() {
        const view = readableView();
        if (view)
            acquisition.refresh(scopeStates, (scope) => runtime.artifactProvenance(scope), view.selection);
        else
            acquisition.reset();
    }
    function installScopeStates() {
        scopeStates = readableView() ? runtime.selectedStates().states : {};
        effectiveState = readableView() ? runtime.readView() : {};
    }
    /** Active and passive expose both memory tools; Off exposes neither. */
    function memoryToolsAvailable() {
        return snapshot.config.mode !== "off";
    }
    /** Passive memory context needs a loaded view; Off and Active never inject it. */
    function passiveMemoryAvailable() {
        return snapshot.config.mode === "passive" && readableView() !== undefined && snapshot.meta.validation?.attempt !== 0;
    }
    async function inspectTelegramState(scope) {
        if (!activeContext || shuttingDown)
            throw new Error("State Flow is not attached to an active session yet");
        const ctx = activeContext;
        const owner = sessionAddress(ctx).key;
        const cwd = ctx.cwd;
        const wanted = captureScopeSelection(nativeScopeSelection(ctx));
        if (scope === "effective" ? wanted.length < 2 : !wanted.includes(scope))
            throw new Error("State Flow inspection scope is not available in this selection");
        const inspected = captureScopeSelection(scope === "effective" ? wanted : [scope]);
        const off = snapshot.config.mode === "off";
        const privateScope = inspected.includes("session");
        if (!off && privateScope)
            assertSelectedBranchAvailable();
        // Off operator reads are disposable: they confer no selected-branch/cache authority.
        const selected = createRuntime(ctx);
        const signal = sharedInspectionLifetime.signal;
        const check = () => {
            signal.throwIfAborted();
            if (activeContext !== ctx || ctx.cwd !== cwd || sessionAddress(ctx).key !== owner || !sameJson(nativeScopeSelection(ctx), wanted))
                throw new Error("State Flow inspection selection changed; select the scope again");
        };
        if (privateScope && (off || !branchStartsWithoutRuntime || scope === "session")) {
            await selected.refreshSelectedCurrent(inspected, check, signal);
        }
        else
            await selected.refreshSelectedShared(captureScopeSelection(inspected.filter(owner => owner !== "session")), check, signal);
        check();
        const view = selected.observedSelectedView();
        if (!view)
            throw new Error("State Flow temporal runtime is unavailable");
        const state = selected.readView(0, scope === "effective" ? undefined : scope);
        return { state: { ...projectModelState(state), ...(state.lazy === undefined ? {} : { lazy: structuredClone(state.lazy) }) }, revisions: temporalScopeRevisions(view), signal };
    }
    function syncStateFlowTools(force = false) {
        if (activeContext && !shuttingDown) {
            const scopes = nativeScopeSelection(activeContext);
            requestPolicy.select({ cwd: activeContext.cwd, owner: activeContext.sessionManager.getSessionId(), mode: snapshot.config.mode, scopes });
            skillReads.select(scopes);
        }
        const available = memoryToolsAvailable();
        if (available && activeContext) {
            const external = moduleHost.captureIfBound()?.modules.filter(module => !module.immutable).map(module => module.id) ?? [];
            const flat = nativeScopeSelection(activeContext).length === 1;
            const desired = [...Object.keys(flatPatchParameters.properties), ...external];
            const sameFlatShape = flat && desired.join("|") === Object.keys(patchStateTool.parameters.properties).join("|");
            const parameters = !flat ? scopedPatchParameters : !external.length ? flatPatchParameters : sameFlatShape ? patchStateTool.parameters
                : Type.Object({ ...flatPatchParameters.properties, ...Object.fromEntries(external.map(id => [id, Type.Optional(Type.Record(Type.String(), Type.Unknown()))])) }, { additionalProperties: false, minProperties: 1 });
            // Cache only the desired shape on our unregistered template: host filtering can hide ToolInfo.
            // Every SDK registration is a fresh copy, preserving old response-wrapper declarations.
            if (force || patchStateTool.parameters !== parameters) {
                patchStateTool.parameters = parameters;
                pi.registerTool({ ...patchStateTool, ...(external.length ? {
                        promptGuidelines: [...(patchStateTool.promptGuidelines ?? []), `Registered mutable object planes: ${external.join(", ")}. Availability and matching retained schema/policy are revalidated at acceptance.`],
                    } : {}) });
            }
        }
        const active = pi.getActiveTools();
        const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
        if (owned.every((name) => active.includes(name) === available))
            return;
        pi.setActiveTools(available
            ? [...new Set([...active, ...owned])]
            : active.filter((name) => !owned.includes(name)));
    }
    /** Accepted canonical publication establishes runtime authority and makes the settled-turn Git backup due. */
    function recordPublication() {
        // A passive view is not runtime authority; only accepted canonical publication establishes it.
        branchStartsWithoutRuntime = false;
        backup.markPublished();
    }
    function skillReadIsCurrent(read) {
        return read.hash !== undefined && readableView()?.selection.includes(read.scope) === true && hasCompiledSkillArtifact(scopeStates[read.scope].artifacts ?? {}, runtime.artifactProvenance(read.scope)[read.path], read.path, read.hash);
    }
    function dropCurrentSkillReads() {
        for (const read of skillReads.successful.values()) {
            if (skillReadIsCurrent(read))
                skillReads.delete(read.path);
        }
    }
    function skillAcquisitionHint(read, wanted) {
        if (read.hash === undefined || skillReadIsCurrent(read))
            return undefined;
        const target = projectModelArtifactTarget(read.scope, read.path, wanted);
        return `State Flow acquisition: this registered Skill belongs at ${target}. If durable compiled guidance is useful, include a non-empty description, kind:"skill", and compilation object there. Unrelated semantic patches do not need to include it.`;
    }
    function clearAcceptedAcquisitions(acquiredArtifactPaths) {
        acquisition.acceptAcquired(acquiredArtifactPaths);
        dropCurrentSkillReads();
    }
    async function prepareInference(pending, selected, ctx, operationSignal, request, messages = []) {
        const signal = AbortSignal.any([pending.controller.signal, operationSignal, ...(request ? [request.signal] : [])]);
        const sameSession = sessionIdentity(ctx);
        const check = () => {
            request?.revalidate();
            if (ctx.signal !== operationSignal || !sameSession() || !currentNativeContextOwner(ctx))
                throw new Error("State Flow preparation context owner changed");
        };
        try {
            check();
            if (!selected?.selectedView())
                throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
            pending.modules = await capturePublicModules(messages, ctx, signal);
            pending.modules?.assertOriginal();
            const replacements = [];
            try {
                const proposals = await Promise.all((pending.modules?.bindings ?? []).filter(binding => binding.module.produce).map(async (binding) => {
                    const content = await binding.prepared.produce();
                    return content === undefined ? undefined : { scope: binding.scope, id: binding.module.id, content };
                }));
                replacements.push(...proposals.filter((item) => item !== undefined));
            }
            catch {
                throw new Error("State Flow registered module production failed");
            }
            pending.modules?.assertOriginal();
            await selected.withSelectedPatchTransaction((transaction) => {
                signal.throwIfAborted();
                check();
                if (runtime !== selected || !inferencePreparation.owns(pending) || !isActive() || shuttingDown) {
                    throw new Error("State Flow inference selection changed while awaiting publication");
                }
                assertPublicationAvailable();
                pending.modules?.assertOriginal();
                for (const binding of pending.modules?.bindings ?? []) {
                    if (!sameJson(transaction.states[binding.scope]?.[binding.module.id] ?? null, binding.content ?? null)
                        || !sameJson(transaction.modules?.[binding.scope]?.[binding.module.id] ?? null, binding.descriptor ?? null))
                        throw new Error("State Flow producer content or descriptor basis changed");
                }
                const nextSnapshot = structuredClone(snapshot);
                const rotatesRun = pending.prompt !== undefined && nextSnapshot.meta.specification !== undefined;
                if (pending.prompt !== undefined)
                    prepareRun(nextSnapshot, pending.prompt);
                // Exact-path metadata validation belongs to the locked current head, including newly adopted registrations.
                const removals = missingArtifactRemovals(transaction.states, transaction.selection);
                let publication;
                if (Object.keys(removals).length > 0 || replacements.length > 0) {
                    const stage = stageSelectedScopePatches(transaction, removals, [], transaction.causalBasis, [], pending.modules?.definitions, replacements);
                    commitSelectedTransition(nextSnapshot, transaction, stage, (transition, next) => {
                        pending.modules?.assertCurrent();
                        publication = transaction.publish(next, transition, stage.provenanceUpdates, stage.moduleAdditions);
                        pending.accepted = true;
                        pending.moduleAcceptance = selected.captureSelectedReadBasis();
                    }, transaction.causalBasis, { finalizeRun: false });
                }
                else {
                    pending.modules?.assertCurrent();
                    publication = transaction.publish(nextSnapshot);
                    pending.accepted = true;
                    pending.moduleAcceptance = selected.captureSelectedReadBasis();
                }
                snapshot = nextSnapshot;
                installScopeStates();
                if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap")
                    rehydrationPhase = "step";
                if (publication?.changed)
                    recordPublication();
                if (pending.prompt !== undefined || publication?.changed)
                    appendCheckpoint();
                if (Object.keys(removals).length > 0)
                    clearAcceptedAcquisitions();
                updateUi(ctx);
            }, () => {
                check();
                if (runtime !== selected || !inferencePreparation.owns(pending) || !isActive())
                    throw new Error("State Flow preparation superseded");
                pending.modules?.assertCurrent();
            }, signal, [...new Set(pending.modules?.bindings.map(binding => binding.scope) ?? [])]);
        }
        catch (error) {
            if (!pending.accepted)
                pending.modules?.cancel();
            if (signal.aborted || runtime !== selected || !inferencePreparation.owns(pending) || shuttingDown)
                return;
            try {
                check();
            }
            catch {
                return;
            }
            if (!contextRequestCurrent(request, ctx, operationSignal))
                return;
            // Pi reports context-hook exceptions and continues. Abort through its public port rather than infer from stale preparation.
            abortContext(ctx, operationSignal);
            const cause = diagnosticText(error);
            recordDiagnostic(cause, "publication-conflict", ctx);
            notifyProblem(ctx, pending.accepted
                ? `State Flow preparation saved; lifecycle update failed: ${cause}`
                : `State Flow inference preparation failed: ${cause}`, "error");
        }
    }
    function statusDiagnostics(ctx) {
        const cwd = ctx.cwd;
        const view = readableView();
        const diagnosticRecent = runtime?.recent() ?? [];
        const durableStateError = snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error
            : view ? undefined : "no temporal runtime is selected on this branch";
        const staleArtifacts = durableStateError === undefined
            ? acquisition.invalidations.map(({ path, scope, reason }) => ({ scope: scope ?? "global", path, reason }))
            : [];
        const session = sessionAddress(ctx);
        return {
            repositoryRoot,
            cwdScopeKey: cwdScopeKey(cwd),
            sessionScopeKey: sessionScopeKey(session.key),
            selection: view?.selection ?? nativeScopeSelection(ctx),
            requestedSelection: nativeScopeSelection(ctx),
            scopeStates,
            effectiveState,
            recent: diagnosticRecent,
            historyLimit: config.historyLimit,
            ...(view === undefined ? {} : { temporal: {
                    head: structuredClone(view.lineage.at(-1)),
                    historyDepth: view.lineage.length - 1,
                    tailCounts: Object.fromEntries(view.selection.map(scope => [scope, view.scopes[scope].patches.length])),
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
    function restoreActiveBranch(ctx, sessionStartReason, notifyRecovery = true, startOwner, requestedMode) {
        contextProjection.reset();
        requestPolicy.invalidate();
        memoryToolLifetime.renew();
        branchRestoration.cancel();
        // Start-owned attachment/fork recovery keeps its owner; only accepted Start cancels Stop.
        if (!startOwner) {
            startActivation.cancel();
            inactivePersistence.cancel();
        }
        clearRunTransient();
        passiveContinuation = undefined;
        bootstrapContinuation = undefined;
        acquisition.clearInvalidations();
        telegramStartPending = false;
        activeContext = ctx;
        let nativePolicy;
        try {
            nativePolicy = branchPolicy(ctx, sessionStartReason, false);
            requestPolicy.select({ cwd: ctx.cwd, owner: ctx.sessionManager.getSessionId(), mode: snapshot.config.mode, scopes: nativePolicy.scopes });
            // Freeze admitted policy before accepting any selected memory.
            // Policy-only capture grants no acquisition or semantic-boundary authority.
            if (nativePolicy.requiresCapture)
                pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, nativePolicy.capture);
            if (nativePolicy.mode !== "off")
                captureScopeSelection(nativePolicy.scopes);
        }
        catch (error) {
            runtime = undefined;
            branchStartsWithoutRuntime = false;
            modePersistenceError = diagnosticText(error);
            snapshot = selectedBoundaryFailure(modePersistenceError, nativePolicy?.mode ?? failedNativePolicyMode(ctx, sessionStartReason) ?? config.inactiveMode);
            installScopeStates();
            syncStateFlowTools();
            updateUi(ctx);
            return Promise.resolve();
        }
        if (!startOwner) {
            let mode = config.inactiveMode;
            let withoutRuntime = false;
            let persistenceError;
            let pendingFork = false;
            try {
                const branch = ctx.sessionManager.getBranch();
                const discovery = discoverSnapshotData(branch);
                withoutRuntime = discovery.candidates.length === 0 && discovery.errors.length === 0;
                pendingFork = nativePolicy.forkPending;
                mode = nativePolicy.mode;
                persistenceError = nativePolicy.persistenceError;
            }
            catch {
                // Off needs only policy; unavailable native evidence grants no memory authority.
            }
            if (mode === "off") {
                backup.cancel();
                const owner = sessionAddress(ctx).key;
                const reason = pendingFork || (deferredBranch?.owner === owner && deferredBranch.cwd === ctx.cwd && deferredBranch.reason === "fork"
                    && retainsPhysicalSessionProjection(sessionStartReason)) ? "fork" : sessionStartReason;
                if (reason === "fork" && !pendingFork)
                    appendNativeMarker({ mode: "off", forkPending: true });
                deferredBranch = { reason, owner, cwd: ctx.cwd };
                runtime = undefined;
                snapshot = emptySnapshot("off");
                branchStartsWithoutRuntime = withoutRuntime;
                modePersistenceError = persistenceError;
                forkInitialization = reason === "fork";
                installScopeStates();
                acquisition.reset();
                syncStateFlowTools();
                updateUi(ctx);
                return Promise.resolve();
            }
            if (pendingFork)
                sessionStartReason = "fork";
        }
        deferredBranch = undefined;
        runtime = createRuntime(ctx);
        installScopeStates();
        branchStartsWithoutRuntime = false;
        forkInitialization = sessionStartReason === "fork" || nativePolicy.forkPending;
        let selection = { kind: "settled" };
        let skipped = 0;
        try {
            const branch = ctx.sessionManager.getBranch();
            const fence = nativePolicy.stop;
            modePersistenceError = fence?.persistenceError ?? (startOwner ? modePersistenceError : undefined);
            if (forkInitialization) {
                // Pending copy authority is independent of whether ancillary Pi checkpoint appends succeeded.
                const selected = selectRetainedCheckpoint(discoverSnapshotData(branch).candidates, config.inactiveMode);
                selection = { kind: "fork", checkpoint: {
                        mode: requestedMode ?? (nativePolicy.mode === "off" && startOwner ? "passive" : nativePolicy.mode),
                        ...(selected.kind === "boundary" && selected.checkpoint.bootstrap ? { bootstrap: true } : {}),
                    } };
            }
            else if (fence?.persistenceError) {
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
                else if (selected.kind === "boundary") {
                    selection = { kind: "attach", checkpoint: { ...selected.checkpoint, mode: nativePolicy.mode } };
                }
                else if (selected.kind === "pre-runtime") {
                    snapshot = emptySnapshot(nativePolicy.mode);
                    if (nativePolicy.mode === "active")
                        selection = { kind: "auto-start" };
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
                        // The native policy was captured before memory acquisition.
                    }
                }
                else {
                    snapshot = emptySnapshot(nativePolicy.mode);
                    if (nativePolicy.mode === "active" && branchStartsWithoutRuntime)
                        selection = { kind: "auto-start" };
                }
            }
        }
        catch (error) {
            selection = { kind: "settled" };
            snapshot = selectedBoundaryFailure(diagnosticText(error), nativePolicy.mode);
        }
        const preRuntimeMode = requestedMode ?? snapshot.config.mode;
        if (selection.kind === "settled" && branchStartsWithoutRuntime && snapshot.meta.validation?.attempt !== 0 && preRuntimeMode !== "off") {
            selection = { kind: "pre-runtime", mode: preRuntimeMode };
        }
        // Retain selected policy while validation blocks memory authority and Active inference until acceptance.
        if (selection.kind !== "settled") {
            snapshot = migrationFailure({}, "State Flow branch restoration is pending", selection.kind === "current" ? selection.mode
                : selection.kind === "auto-start" ? "active" : selection.kind === "pre-runtime" ? selection.mode : selection.checkpoint.mode);
        }
        if (requestedMode)
            snapshot = deactivateEpisode(snapshot, requestedMode);
        const pending = {
            controller: new AbortController(),
            awaitingAcceptance: selection.kind !== "settled" && selection.kind !== "current",
            ...(requestedMode === undefined ? {} : { requestedMode }),
        };
        branchRestoration.claim(pending);
        // attachBranch releases its own ownership; settlement only drains it for shutdown.
        return branchRestoration.track(pending, attachBranch(ctx, pending, selection, sessionStartReason, notifyRecovery, skipped), false);
    }
    async function attachBranch(ctx, pending, selection, reason, notifyRecovery, skipped) {
        const placeholder = runtime;
        let selected = runtime;
        const wanted = nativeScopeSelection(ctx);
        const sameSession = sessionIdentity(ctx);
        const signal = modeOperationSignal(ctx, pending.controller.signal);
        const isCurrent = () => branchRestoration.owns(pending) && !pending.controller.signal.aborted && !shuttingDown && runtime === selected
            && sameSession() && sameJson(nativeScopeSelection(ctx), wanted);
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (!isCurrent())
                throw new Error("State Flow branch selection changed while awaiting publication");
        };
        let accepted = false;
        const failSelection = (error) => {
            const mode = pending.requestedMode ?? (selection.kind === "auto-start" ? "active"
                : selection.kind === "pre-runtime" ? selection.mode : selection.kind === "attach" || selection.kind === "fork" ? selection.checkpoint.mode : snapshot.config.mode);
            snapshot = selectedBoundaryFailure(diagnosticText(error), mode);
            installScopeStates();
        };
        // Install accepted memory before native writes; later ancillary failures cannot revert or replay it.
        const accept = (candidate, next, nativeWrites) => {
            accepted = true;
            pending.awaitingAcceptance = false;
            runtime = selected = candidate;
            snapshot = next;
            installScopeStates();
            recordPublication();
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
                // Selected policy is visible while memory remains unavailable during the exclusion wait.
                syncStateFlowTools();
                updateUi(ctx);
                const candidate = createRuntime(ctx);
                try {
                    if (selection.kind === "current") {
                        const current = await candidate.refreshSelectedCurrent(wanted, assertCurrent, signal);
                        assertCurrent();
                        runtime = selected = candidate;
                        snapshot = deactivateEpisode(current, pending.requestedMode ?? selection.mode);
                        installScopeStates();
                    }
                    else if (selection.kind === "attach") {
                        // A validated shared-only bookmark may precede a new requested Session selection.
                        const addsSession = wanted.includes("session") && "scopes" in selection.checkpoint
                            && !captureScopeSelection(selection.checkpoint.scopes).includes("session");
                        const disposition = addsSession ? await candidate.inspectSelectedLifecycle(wanted, assertCurrent, signal) : undefined;
                        assertCurrent();
                        if ((pending.requestedMode ?? selection.checkpoint.mode) === "passive" && disposition?.privateAcquisition === "unacquired") {
                            // Observation cannot turn the new policy or old bookmark into private acquisition.
                            const shared = wanted.filter(scope => scope !== "session");
                            if (shared.length)
                                await candidate.refreshSelectedShared(captureScopeSelection(shared), assertCurrent, signal);
                            assertCurrent();
                            runtime = selected = candidate;
                            snapshot = emptySnapshot(pending.requestedMode ?? "passive");
                            installScopeStates();
                        }
                        else {
                            // Memory is the current same-session files; the Pi checkpoint supplies only mode and run lifecycle.
                            await candidate.withSelectedCurrentTransaction(wanted, (current, publish) => {
                                assertCurrent();
                                if (!current)
                                    throw new Error("Current State Flow session memory is unavailable");
                                const { checkpoint } = selection;
                                const restored = { config: { mode: checkpoint.mode }, meta: {
                                        step: current.meta.step,
                                        ...(checkpoint.bootstrap ? { bootstrap: true } : {}),
                                        ...(checkpoint.specification === undefined ? {} : { specification: checkpoint.specification }),
                                    } };
                                // Canceled preparation or boundary continuation may have no specification. Retain uncompiled native context.
                                if (restored.config.mode === "active" && restored.meta.specification === undefined
                                    && retainsPhysicalSessionProjection(reason) && hasUncheckpointedConversation(ctx.sessionManager.getBranch()))
                                    restored.meta.bootstrap = true;
                                const next = pending.requestedMode ? deactivateEpisode(restored, pending.requestedMode) : restored;
                                publish(next);
                                accept(candidate, next, appendCheckpoint);
                            }, assertCurrent, signal);
                        }
                    }
                    else if (selection.kind === "fork") {
                        const disposition = await candidate.inspectSelectedLifecycle(wanted, assertCurrent, signal);
                        if (disposition && (!wanted.includes("session") || disposition.privateAcquisition === "acquired")) {
                            // Acquired child-current wins; a still-deferred shared child keeps its native pending fact.
                            await candidate.withSelectedCurrentTransaction(wanted, (current, publish) => {
                                assertCurrent();
                                const next = { ...current, config: { mode: pending.requestedMode ?? selection.checkpoint.mode } };
                                publish(next);
                                forkInitialization = false;
                                modePersistenceError = undefined;
                                accept(candidate, next, () => { if (disposition.privateAcquisition === "acquired")
                                    appendNativeMarker({ reset: true }); appendCheckpoint(); });
                            }, assertCurrent, signal);
                        }
                        else if (!wanted.includes("session")) {
                            // Admit selected shared owners only; no parent header/session data or private acquisition.
                            await candidate.withSelectedDeferredForkTransaction(wanted, { mode: pending.requestedMode ?? selection.checkpoint.mode,
                                ...(selection.checkpoint.bootstrap ? { bootstrap: true } : {}) }, publish => {
                                assertCurrent();
                                publish();
                                forkInitialization = false;
                                modePersistenceError = undefined;
                                accept(candidate, candidate.selectedSnapshot(), appendCheckpoint);
                            }, signal, true, () => { assertCurrent(); return pending.requestedMode ?? selection.checkpoint.mode; });
                        }
                        else {
                            if (disposition?.privateAcquisition === "unacquired")
                                throw new Error("Fork child has no deferred private-copy authority");
                            const base = disposition ? await loadSelectedFileCohort(ctx.cwd, candidate.sessionId, disposition.selection, candidate.root, candidate.sessionKey, signal) : undefined;
                            assertCurrent();
                            if (disposition && !base)
                                throw new Error("Deferred fork child authority disappeared");
                            // Direct-parent acquisition follows child classification and remains outside exclusion.
                            const source = forkSource(ctx), parentFile = ctx.sessionManager.getHeader()?.parentSession;
                            const next = { config: { mode: pending.requestedMode ?? selection.checkpoint.mode }, meta: disposition ? disposition.snapshot.meta : {
                                    step: 0, ...(selection.checkpoint.bootstrap ? { bootstrap: true } : {})
                                } };
                            await candidate.withSelectedForkCopyTransaction({ ...(base ? { kind: "fork-deferred", base } : { kind: "fork-new" }), source,
                                selection: wanted, snapshot: next, historyLimit: config.historyLimit,
                                author: (_basis, publish) => {
                                    assertCurrent();
                                    publish({ ...next, config: { mode: pending.requestedMode ?? selection.checkpoint.mode } });
                                } }, publish => {
                                assertCurrent();
                                publish();
                                forkInitialization = false;
                                modePersistenceError = undefined;
                                accept(candidate, candidate.selectedSnapshot(), () => { appendNativeMarker({ reset: true }); appendCheckpoint(); });
                            }, (selectedSource, phase) => {
                                assertCurrent();
                                if (ctx.sessionManager.getHeader()?.parentSession !== parentFile)
                                    throw new Error("Native fork parent changed");
                                if (phase === "prepare" && !sameJson(forkSource(ctx), selectedSource))
                                    throw new Error("Native direct parent mismatch");
                            }, signal);
                        }
                    }
                    else {
                        const mode = pending.requestedMode ?? (selection.kind === "pre-runtime" ? selection.mode : "active");
                        const disposition = await candidate.inspectSelectedLifecycle(wanted, assertCurrent, signal);
                        assertCurrent();
                        // A pre-runtime Passive choice may observe shared owners, not acquire an explicitly unacquired Session.
                        const observesUnacquired = (pending.requestedMode ?? mode) === "passive" && wanted.includes("session") && disposition?.privateAcquisition === "unacquired";
                        if (disposition && !observesUnacquired) {
                            await candidate.withSelectedCurrentTransaction(wanted, (current, publish) => {
                                assertCurrent();
                                const next = { ...current, config: { mode: pending.requestedMode ?? mode } };
                                publish(next);
                                accept(candidate, next, appendCheckpoint);
                            }, assertCurrent, signal);
                        }
                        else if (mode === "passive" || observesUnacquired) {
                            const shared = wanted.filter(scope => scope !== "session");
                            if (shared.length)
                                await candidate.refreshSelectedShared(captureScopeSelection(shared), assertCurrent, signal);
                            assertCurrent();
                            runtime = selected = candidate;
                            snapshot = emptySnapshot(pending.requestedMode ?? mode);
                            installScopeStates();
                        }
                        else {
                            const initial = startEpisode(hasPriorConversation(ctx.sessionManager.getBranch()));
                            await candidate.withSelectedFirstPatchTransaction(wanted, initial, transaction => {
                                assertCurrent();
                                if (!branchStartsWithoutRuntime || forkInitialization)
                                    throw new Error("Existing session or pending fork requires current-memory acceptance");
                                // Bind the newest independent mode inside the existing atomic origin/lifecycle staging engine.
                                const next = pending.requestedMode ? deactivateEpisode(initial, pending.requestedMode) : initial;
                                transaction.publish(next);
                                accept(candidate, next, appendCheckpoint);
                            }, assertCurrent, signal, true);
                        }
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
                    failSelection(error);
                }
                finally {
                    pending.awaitingAcceptance = false;
                }
                if (accepted)
                    return;
            }
            settleSelection(ctx, reason, notifyRecovery, skipped, selected !== placeholder);
            if (snapshot.config.mode === "off" || isActive() || readableView() || snapshot.meta.validation?.attempt === 0 || !branchStartsWithoutRuntime)
                return;
            // Only a proven pre-runtime Passive branch may observe shared owners without private acquisition.
            const passive = await loadPassiveView(ctx, signal, isCurrent, notifyRecovery);
            if (passive === undefined)
                return;
            assertCurrent();
            // An intervening passive patch or inspection owns its newer cache, even on the same physical branch.
            if (readableView())
                return;
            runtime = selected = passive;
            installScopeStates();
            updateUi(ctx);
        }
        catch (error) {
            // Host failures before acceptance leave the selection unavailable, never invented empty memory.
            if (accepted || !isCurrent())
                return;
            failSelection(error);
        }
        finally {
            pending.awaitingAcceptance = false;
            branchRestoration.release(pending);
        }
    }
    /** Load current shared memory for passive projection without initializing or publishing it. */
    async function loadPassiveView(ctx, signal, isCurrent, notify) {
        const wanted = nativeScopeSelection(ctx), shared = wanted.filter(scope => scope !== "session");
        if (!shared.length)
            return undefined;
        const passive = createRuntime(ctx);
        try {
            await passive.refreshSelectedShared(captureScopeSelection(shared), () => {
                if (!isCurrent() || !sameJson(nativeScopeSelection(ctx), wanted))
                    throw new Error("State Flow observation selection changed");
            }, signal);
        }
        catch (error) {
            if (isCurrent() && !signal.aborted && notify && !modePersistenceError)
                notifyProblem(ctx, `State Flow passive memory is unavailable: ${diagnosticText(error)}`, "warning");
            return undefined;
        }
        return passive;
    }
    function selectedContinuation(ctx, reason) {
        if (!retainsPhysicalSessionProjection(reason) || !readableView())
            return undefined;
        const boundary = branchPolicy(ctx).stop;
        return boundary === undefined ? undefined : createPassiveContinuation(projectModelState(effectiveState), boundary.at, boundary.from, boundary.preserveContext, nativeScopeSelection(ctx));
    }
    function settleSelection(ctx, reason, notifyRecovery, skipped, selectedMemory) {
        const failure = !isActive() && snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error : undefined;
        if (failure !== undefined && notifyRecovery && !modePersistenceError) {
            notifyProblem(ctx, `State Flow restore failed: ${failure}`, "error");
        }
        const continuation = selectedMemory ? selectedContinuation(ctx, reason) : undefined;
        if (continuation !== undefined) {
            if (!isActive())
                passiveContinuation = continuation;
            else if (snapshot.meta.bootstrap)
                bootstrapContinuation = continuation;
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
    function nativeToolAdmission(id, name, ctx) {
        if (nativeRequests.has(id))
            return nativeRequests.take(id, name);
        // Raw non-model domain invocations have no operation signal. Public SDK tool_call always gates.
        if (ctx?.signal || nativeRequests.active)
            throw new Error("State Flow tool batch has no current native request");
        return undefined;
    }
    function currentNativeTool(id, name, ctx) {
        try {
            if (nativeRequests.has(id))
                nativeRequests.check(id, name);
            else if (nativeRequests.active || ctx.signal !== undefined)
                return false;
            const policy = requestPolicy.policy, selected = runtime;
            return policy !== undefined && selected !== undefined && selected.sessionId === policy.owner
                && policy.owner === ctx.sessionManager.getSessionId() && policy.cwd === ctx.cwd && selected.cwd === ctx.cwd
                && selected.sessionKey === sessionAddress(ctx).key;
        }
        catch {
            return false;
        }
    }
    pi.registerTool({
        name: READ_STATE_TOOL_NAME,
        label: "Read State",
        description: "Read exact State Flow values or historical semantic patches with one path or an ordered path list. With one participating owner, semantic paths and structured references are scope-free, effective[N] selects that owner's historical boundary, and patches[N] selects its retained owner patch. With multiple owners, unscoped paths use the effective overlay and owner patch history requires an explicit owner. Optional global/cwd/session roots may address only participating available owners. Array selectors are zero-based indices or half-open [start..end] ranges, never temporal offsets inside a semantic value. Projection value returns data; keys returns minimal structure; patch intersects the selected path at its boundary. Path object keys must be ASCII identifiers ([A-Za-z_$][A-Za-z0-9_$-]*); non-ASCII keys cannot be addressed.",
        promptSnippet: "Read exact state values, structures, or historical semantic patches",
        promptGuidelines: [SCOPE_PARTICIPATION_GUIDELINE],
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: "One semantic path. One owner: flat planes, effective[N] history or retained patches[N]. Multiple owners: effective overlay or explicit participating owner; patch history needs owner.patches[N]. Nested array selectors stay ordinary indices/ranges." })),
            paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Ordered query paths evaluated as one all-or-error read" })),
            projection: Type.Optional(StringEnum(["value", "keys", "patch"], { description: "Value snapshot by default, structural keys with minimal meta, or the selected historical semantic patch" })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            try {
                const admission = nativeToolAdmission(toolCallId, READ_STATE_TOOL_NAME, ctx);
                admission?.revalidate();
                if (admission)
                    signal = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
                if (!memoryToolsAvailable())
                    throw new Error("State Flow tools are off for this session");
                if (signal?.aborted)
                    throw new Error("State Flow read was aborted");
                assertSelectedBranchAvailable();
                const selected = runtime;
                if (!selected)
                    throw new Error("State Flow temporal runtime is unavailable");
                const receipt = admission ?? requestPolicy.capture();
                const check = () => {
                    receipt.revalidate();
                    signal?.throwIfAborted();
                    if (!ctx || runtime !== selected || selected.sessionId !== receipt.policy.owner || receipt.policy.owner !== ctx.sessionManager.getSessionId() || receipt.policy.cwd !== ctx.cwd
                        || selected.cwd !== ctx.cwd || selected.sessionKey !== sessionAddress(ctx).key)
                        throw new Error("State Flow read selection owner changed");
                };
                check();
                const wanted = captureScopeSelection(receipt.policy.scopes);
                params = structuredClone(params);
                check();
                if (params.path === undefined && params.paths === undefined)
                    throw new Error("read_state requires path or paths");
                if (params.path !== undefined && params.paths !== undefined)
                    throw new Error("read_state accepts path or paths, not both");
                {
                    const requestedPaths = [...(params.paths ?? [params.path])];
                    const paths = requestedPaths.map(path => normalizeModelReadPath(path, wanted, config.historyLimit));
                    check();
                    const view = readableView(selected);
                    // Wanted policy was checked by normalization; an observational subset is not an exclusion.
                    for (const path of paths) {
                        const owner = /^(global|cwd|session)(?=\.|\[|$)/.exec(path)?.[1];
                        if (owner && !view?.selection.includes(owner))
                            throw new Error(`State Flow ${owner}: selected, unavailable`);
                    }
                    if (!view)
                        throw new Error("State Flow temporal runtime is unavailable");
                    check();
                    if (paths.some((path) => /^session(?:\.|\[|$)/.test(path)))
                        assertSelectedBranchAvailable();
                    if (paths.length === 1 && /^(?:global|cwd|session)\.patches(?:\[\d+\])?$/.test(paths[0])) {
                        if (params.projection !== undefined && params.projection !== "value")
                            throw new Error("Scope patch paths support only the value projection");
                        const result = readStatePath(view, paths[0], config.historyLimit);
                        if (!("patch" in result))
                            throw new Error("Expected a scope patch path");
                        const output = wanted.length === 1 ? projectModelReferences({ patch: result.patch }, wanted, wanted.flatMap(scope => Object.keys(view.scopes[scope]?.modules ?? {}))) : { patch: result.patch };
                        check();
                        return {
                            content: [{ type: "text", text: `\n${JSON.stringify(output)}` }],
                            details: { path: requestedPaths[0], transitionId: result.boundary.id },
                        };
                    }
                    const result = readProjectedState(view, paths, params.projection, config.historyLimit);
                    const output = wanted.length === 1 ? projectModelReferences(result, wanted, wanted.flatMap(scope => Object.keys(view.scopes[scope]?.modules ?? {}))) : result;
                    check();
                    return {
                        content: [{ type: "text", text: `\n${JSON.stringify(output)}` }],
                        details: { ...(params.path === undefined ? { paths: requestedPaths } : { path: requestedPaths[0] }), projection: params.projection ?? "value" },
                    };
                }
            }
            catch (error) {
                throw separatedFailure(error);
            }
        },
    });
    const patchStateTool = defineTool({
        name: PATCH_STATE_TOOL_NAME,
        label: "Patch State",
        description: "The sole State Flow semantic mutation protocol. With one participating owner, supply intents/strategy/tactics/artifacts/lazy planes directly, without an owner wrapper. With multiple owners, supply one or more global, cwd, or session patches for participating owners; all supplied owners commit atomically. This call must be the only State Flow barrier in its assistant response. Intent updates run first, then clear owned same-scope strategy/tactics/lazy keys unless a remaining or new intent refs them, then other fields apply. Later writes can recreate cleared paths without old fields. Name keys in ASCII ([A-Za-z_$][A-Za-z0-9_$-]*) so read paths and refs resolve; values may use any language.",
        promptSnippet: "Atomically patch participating semantic memory in its declared flat or multi-owner form",
        promptGuidelines: [
            RESPONSE_PATCH_GUIDELINE,
            SCOPE_PARTICIPATION_GUIDELINE,
            "Use patch_state only for material durable semantic changes; ordinary answers need no finalization call.",
            "Use patch_state as reconciliation, not append-only notes: place new knowledge at the narrowest valid scope and remove superseded or completed state from touched branches.",
            "Call patch_state alone in an assistant response; after its acknowledgement, further reasoning, tools, and later patch_state calls remain allowed.",
        ],
        executionMode: "sequential",
        parameters: config.scopes.length === 1 ? flatPatchParameters : scopedPatchParameters,
        renderCall(args, theme, context) {
            const title = theme.fg("toolTitle", theme.bold(PATCH_STATE_TOOL_NAME));
            if (!config.showSuccessfulPatches && !context.isError)
                return new Text(title, 0, 0);
            return new Text(`${title}\n${separatedOutput(theme.fg("dim", formatPatchStateArguments(args)))}`, 0, 0);
        },
        renderResult(result) {
            const text = result.content.find((block) => block.type === "text")?.text ?? "";
            return new Text(separatedOutput(text), 0, 0);
        },
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            signal = signal ? AbortSignal.any([signal, memoryToolLifetime.signal]) : memoryToolLifetime.signal;
            let admitted = false;
            try {
                const admission = nativeToolAdmission(toolCallId, PATCH_STATE_TOOL_NAME, ctx);
                admission?.revalidate();
                if (admission)
                    signal = AbortSignal.any([signal, admission.signal]);
                if (!memoryToolsAvailable())
                    throw new Error("State Flow tools are off for this session");
                assertPublicationAvailable();
                if (signal?.aborted)
                    throw new Error("State Flow patch was aborted before materialization");
                if (!ctx)
                    throw new Error("State Flow patch selection owner changed");
                const selected = runtime ??= createRuntime(ctx);
                const sameSession = sessionIdentity(ctx);
                const receipt = admission ?? requestPolicy.capture();
                const wanted = captureScopeSelection(receipt.policy.scopes);
                const catalog = moduleHost.captureIfBound();
                signal = AbortSignal.any([signal, receipt.signal, ...(catalog ? [catalog.signal] : [])]);
                const check = () => {
                    receipt.revalidate();
                    if (runtime !== selected || !sameSession() || selected.sessionId !== receipt.policy.owner || receipt.policy.owner !== ctx.sessionManager.getSessionId()
                        || receipt.policy.cwd !== ctx.cwd || selected.cwd !== ctx.cwd || selected.sessionKey !== sessionAddress(ctx).key)
                        throw new Error("State Flow patch selection owner changed");
                    assertPublicationAvailable();
                    catalog?.assertCurrent();
                };
                // Rehash and normalize only after caller admission, still before canonical exclusion.
                check();
                const excluded = isObject(params) && Object.keys(params).find(key => DEFAULT_SCOPE_SELECTION.includes(key) && !wanted.includes(key));
                if (excluded)
                    throw new Error(`State Flow ${excluded} patch scope is excluded`);
                params = structuredClone(params);
                check();
                admitted = true;
                const knownModules = [...new Set([...(catalog?.modules.map(module => module.id) ?? []),
                        ...wanted.flatMap(scope => Object.keys(readableView(selected)?.scopes[scope]?.modules ?? {}))])];
                const patches = normalizeModelPatches(params, wanted, knownModules);
                check();
                const scopes = Object.keys(patches);
                const firstAuthoring = selected.selectedView() === undefined;
                const acquiredArtifacts = structuredClone([...artifactReads.successful.values()]);
                const acquiredSkills = structuredClone([...skillReads.successful.values()]);
                const previousEffective = effectiveState;
                skillReads.validateCompilations(patches);
                const author = (transaction) => {
                    check();
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
                    const stage = stageSelectedScopePatches(transaction, patches, acquiredSkills, transaction.causalBasis, acquiredArtifacts, catalog?.modules);
                    const changed = transaction.selection.some((scope) => !sameJson(transaction.states[scope], stage.nextStates[scope])
                        || Object.entries(stage.provenanceUpdates[scope] ?? {}).some(([path, evidence]) => !Object.hasOwn(transaction.provenance[scope] ?? {}, path) || !sameJson(transaction.provenance[scope]?.[path], evidence)));
                    const nextSnapshot = structuredClone(firstAuthoring ? transaction.snapshot : snapshot);
                    let publication;
                    commitSelectedTransition(nextSnapshot, transaction, stage, (accepted, next) => {
                        catalog?.assertCurrent();
                        publication = transaction.publish(next, accepted, stage.provenanceUpdates, stage.moduleAdditions);
                    }, transaction.causalBasis, { finalizeRun: false });
                    snapshot = nextSnapshot;
                    installScopeStates();
                    if (publication?.changed) {
                        recordPublication();
                        appendCheckpoint();
                    }
                    clearAcceptedAcquisitions(new Set(acquiredArtifacts.map(({ path }) => path)));
                    updateUi(ctx);
                    const updates = contextProjection.acceptPatch(previousEffective, effectiveState, patches, acquisition.hints, stage.cascades, isActive(), wanted);
                    const acknowledgement = changed
                        ? `\nState materialized atomically at ${scopes.join("+")} scope${scopes.length === 1 ? "" : "s"}.`
                        : "\nState already current.";
                    return { content: [
                            { type: "text", text: acknowledgement + stage.missingDeletions.map(deletion => projectModelMissingDeletion(deletion, wanted)).map(({ path, unavailablePath }) => `\n\nHint: deletion skipped at ${path}; target absent. First unavailable component: ${unavailablePath}. Check the path if you expected an existing value.`).join("") },
                            ...(updates ? [{ type: "text", text: `\n${presentationJson({ state_updates: updates })}` }] : []),
                        ], details: { scopes, step: snapshot.meta.step, changed, missingDeletions: stage.missingDeletions } };
                };
                if (!firstAuthoring)
                    return await selected.withSelectedPatchTransaction(author, check, signal);
                check();
                const disposition = await selected.inspectSelectedLifecycle(wanted, check, signal);
                if (disposition && !wanted.includes("session")) {
                    return await selected.withSelectedCurrentTransaction(wanted, (_current, _publish, transaction) => author(Object.freeze({
                        ...transaction, snapshot: { ...transaction.snapshot, config: { mode: receipt.policy.mode } },
                    })), check, signal);
                }
                if (disposition) {
                    const acquire = () => {
                        check();
                        if (receipt.policy.mode === "off" || !wanted.includes("session") || disposition.privateAcquisition !== "unacquired"
                            || forkInitialization || branchPolicy(ctx).forkPending)
                            throw new Error("State Flow first mutation requires independent unacquired Session participation");
                    };
                    acquire();
                    const base = await loadSelectedFileCohort(ctx.cwd, selected.sessionId, disposition.selection, selected.root, selected.sessionKey, signal);
                    acquire();
                    if (!base)
                        throw new Error("Unacquired State Flow first mutation source disappeared");
                    let result;
                    return await selected.withSelectedSessionAcquisitionTransaction({ kind: "unacquired", base, selection: wanted,
                        snapshot: { ...disposition.snapshot, config: { mode: receipt.policy.mode } }, historyLimit: config.historyLimit,
                        author: (basis, publish) => {
                            acquire();
                            result = author(Object.freeze({ selection: wanted,
                                states: readTemporalScopes(basis.view, 0, config.historyLimit), snapshot: basis.snapshot,
                                modules: Object.fromEntries(wanted.filter(scope => basis.view.scopes[scope]?.modules !== undefined).map(scope => [scope, structuredClone(basis.view.scopes[scope].modules)])),
                                causalBasis: basis.view.lineage.at(-1).id, provenance: basis.provenance,
                                publish: (next, transition, provenance, additions) => { acquire(); return publish(next, transition, provenance, additions); } }));
                        } }, publish => { acquire(); publish(); return result; }, signal, true);
                }
                if (!branchStartsWithoutRuntime || forkInitialization || branchPolicy(ctx).forkPending)
                    throw new Error("State Flow first authoring requires native independent origin authority");
                return await selected.withSelectedFirstPatchTransaction(wanted, snapshot, author, () => {
                    check();
                    if (!branchStartsWithoutRuntime || forkInitialization || branchPolicy(ctx).forkPending)
                        throw new Error("State Flow origin authority changed");
                }, signal, true);
            }
            catch (error) {
                if (admitted && !signal.aborted && memoryToolsAvailable()) {
                    let attempted;
                    try {
                        attempted = structuredClone(params);
                    }
                    catch {
                        attempted = undefined;
                    }
                    const cause = diagnosticText(error);
                    recordDiagnostic(cause, /concurrently|advanced/.test(cause) ? "publication-conflict" : "invalid-patch", ctx, {
                        input: attempted, tool: PATCH_STATE_TOOL_NAME, toolCallId,
                    });
                }
                throw separatedFailure(error);
            }
        },
    });
    pi.registerTool({ ...patchStateTool });
    function startStateFlow(ctx, reselect = false) {
        if (shuttingDown)
            return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
        if (!reselect && startActivation.current?.operation)
            return startActivation.current.operation;
        telegramStartPending = false;
        if (!reselect && activeContext && !branchRestoration.current && isActive()) {
            return Promise.resolve({ ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal });
        }
        const pending = startActivation.claim({ controller: new AbortController() });
        return startActivation.track(pending, runStart(ctx, pending.controller, reselect));
    }
    /** Await restoration-owned attachment and exact-source fork recovery before current-head activation. */
    async function runStart(ctx, pending, reselect) {
        const sameSession = sessionIdentity(ctx);
        const signal = modeOperationSignal(ctx, pending.signal);
        const isOwner = () => startActivation.current?.controller === pending && !signal.aborted && !shuttingDown && sameSession();
        const superseded = () => {
            pending.abort();
            return { ok: false, message: "State Flow activation was superseded", signal: pending.signal };
        };
        try {
            if (reselect)
                await waitForRecovery(restoreActiveBranch(ctx, undefined, false, pending), signal);
            else if (deferredBranch?.reason === "fork")
                await waitForRecovery(restoreActiveBranch(ctx, "fork", false, pending), signal);
            else if (!activeContext)
                await waitForRecovery(restoreActiveBranch(ctx, undefined, false, pending), signal);
            else if (branchRestoration.current?.operation)
                await waitForRecovery(branchRestoration.current.operation, signal);
            if (!isOwner())
                return superseded();
            if (!reselect && isActive())
                return { ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal };
            if (forkInitialization) {
                // Withdraw this join on cancellation without revoking the independently owned mode persistence.
                const stopping = inactivePersistence.current?.operation;
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
    /** Explicit Active or Passive accepts validated current same-session memory without claiming unavailable history. */
    async function activateCurrentState(ctx, pending, mode = "active", owns = () => startActivation.current?.controller === pending) {
        let selected = runtime;
        const wanted = nativeScopeSelection(ctx);
        const sameSession = sessionIdentity(ctx);
        const policy = () => `${snapshot.config.mode}:${isActive()}`;
        const initialPolicy = policy();
        const acceptedPolicy = `${mode}:${mode === "active"}`;
        const active = mode === "active";
        let accepted = false;
        let receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
        const signal = modeOperationSignal(ctx, pending.signal);
        const isCurrent = () => owns() && !signal.aborted && runtime === selected && !shuttingDown
            && sameSession() && sameJson(nativeScopeSelection(ctx), wanted) && policy() === (accepted ? acceptedPolicy : initialPolicy);
        const superseded = () => {
            pending.abort();
            return { ok: false, message: active ? "State Flow activation was superseded" : "State Flow mode change was superseded", signal: pending.signal };
        };
        try {
            captureScopeSelection(wanted);
            const activation = createRuntime(ctx);
            const deferred = deferredBranch;
            if (deferred) {
                const discovery = discoverSnapshotData(ctx.sessionManager.getBranch());
                const retained = selectRetainedCheckpoint(discovery.candidates, config.inactiveMode);
                branchStartsWithoutRuntime = retained.kind === "pre-runtime" || (discovery.candidates.length === 0 && discovery.errors.length === 0);
            }
            // Off activation owns one cancellable current-head publication, not an independent read-only restore.
            const acceptActivation = (current, publish) => {
                signal.throwIfAborted();
                if (!isCurrent())
                    throw new Error("State Flow activation selection changed while awaiting publication");
                if (!current && (!active || !branchStartsWithoutRuntime))
                    throw new Error(snapshot.meta.validation?.error ?? "Current State Flow session memory is unavailable");
                const boundary = deferred && retainsPhysicalSessionProjection(deferred.reason)
                    ? branchPolicy(ctx).stop : undefined;
                const bootstrap = hasPriorConversation(ctx.sessionManager.getBranch()) || passiveContinuation !== undefined || boundary !== undefined;
                const activated = !active ? deactivateEpisode(current, "passive")
                    : current ? resumeEpisode(current, bootstrap) : startEpisode(bootstrap);
                if (active) {
                    // Explicit Start accepts current memory, not the prior run's prompt or repair attempt.
                    delete activated.meta.specification;
                    delete activated.meta.validation;
                }
                const resumedWrites = modePersistenceError !== undefined;
                publish(activated);
                accepted = true;
                // Passive acceptance runs inside its own inactive-persistence owner.
                if (active)
                    inactivePersistence.cancel();
                runtime = selected = activation;
                snapshot = activated;
                activeContext = ctx;
                modePersistenceError = undefined;
                installScopeStates();
                const continuation = passiveContinuation ?? bootstrapContinuation ?? (deferred ? selectedContinuation(ctx, deferred.reason) : undefined);
                deferredBranch = undefined;
                clearRunTransient();
                contextProjection.reset();
                passiveContinuation = active ? undefined : continuation;
                bootstrapContinuation = active && snapshot.meta.bootstrap ? continuation : undefined;
                if (active)
                    deferInferencePreparation();
                receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
                recordPublication();
                syncStateFlowTools();
                updateUi(ctx);
                if (forkInitialization) {
                    forkInitialization = false;
                    appendNativeMarker({ reset: true });
                }
                appendCheckpoint();
                if (!active) {
                    if (resumedWrites)
                        ctx.ui.notify("State Flow passive; memory writes resumed from current session memory.", "info");
                    return { ok: true, message: "State Flow passive", signal: receipt };
                }
                ctx.ui.notify(snapshot.meta.bootstrap
                    ? "State Flow active. The next complete agent run will migrate active context into state."
                    : "State Flow active. The next prompt starts a stateful agent run.", "info");
                return { ok: true, message: "State Flow active", signal: receipt };
            };
            const check = () => { signal.throwIfAborted(); if (!isCurrent())
                throw new Error("State Flow activation superseded"); };
            let result;
            const sameRuntimeOwner = selected?.cwd === ctx.cwd && selected.sessionKey === activation.sessionKey;
            // Known accepted Session can only take current acceptance, even if its live header is later downgraded.
            const acceptedSession = sameRuntimeOwner && selected?.selectedView()?.selection.includes("session");
            const disposition = active && !acceptedSession ? await activation.inspectSelectedLifecycle(wanted, check, signal) : undefined;
            // Explicit Start owns the grant; header data only selects the existing acquisition route.
            if (active && wanted.includes("session") && disposition?.privateAcquisition === "unacquired") {
                if (forkInitialization || branchPolicy(ctx).forkPending)
                    throw new Error("Pending fork cannot use independent private acquisition");
                // Retain denial-only acquisition knowledge when an existing owner has cleared or excluded its cache.
                if (sameRuntimeOwner)
                    await selected.inspectSelectedLifecycle(wanted, check, signal);
                const base = await loadSelectedFileCohort(ctx.cwd, activation.sessionId, disposition.selection, activation.root, activation.sessionKey, signal);
                check();
                if (!base)
                    throw new Error("Unacquired State Flow source authority disappeared");
                let acquiredResult;
                result = await activation.withSelectedSessionAcquisitionTransaction({ kind: "unacquired", base, selection: wanted,
                    snapshot: { ...disposition.snapshot, config: { mode: "active" } }, historyLimit: config.historyLimit,
                    author: (basis, publish) => {
                        check();
                        if (forkInitialization || branchPolicy(ctx).forkPending)
                            throw new Error("Pending fork cannot use independent private acquisition");
                        acquiredResult = acceptActivation(basis.snapshot, activated => publish(activated));
                    } }, publish => { check(); publish(); return acquiredResult; }, signal, true);
            }
            else if (active && branchStartsWithoutRuntime && !acceptedSession && !disposition) {
                const next = startEpisode(hasPriorConversation(ctx.sessionManager.getBranch()) || passiveContinuation !== undefined);
                result = await activation.withSelectedFirstPatchTransaction(wanted, next, transaction => {
                    check();
                    if (!branchStartsWithoutRuntime || forkInitialization)
                        throw new Error("State Flow origin authority changed");
                    return acceptActivation(undefined, activated => transaction.publish(activated));
                }, check, signal, true);
            }
            else
                result = await activation.withSelectedCurrentTransaction(wanted, (current, publish) => acceptActivation(current, publish), check, signal);
            return isCurrent() ? result : superseded();
        }
        catch (error) {
            if (!isCurrent())
                return superseded();
            const message = conciseDiagnostic(`${accepted ? `State Flow ${mode}; lifecycle update failed` : active ? "State Flow activation failed" : "State Flow passive acceptance failed"}: ${diagnosticText(error)}`);
            // An unaccepted activation cannot replace retained lifecycle or poison an independent Stop.
            // Attachment owns required-proof unavailability; failed Passive acceptance reports through its caller's fence.
            if (active || accepted)
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
    function selectMode(ctx, mode, scopes) {
        if (!scopes || sameJson(scopes, nativeScopeSelection(ctx)))
            return mode === "active" ? startStateFlow(ctx) : deactivateStateFlow(ctx, mode);
        if (shuttingDown)
            return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
        if (mode === "off")
            return selectOff(ctx, scopes);
        // The native choice is DATA, never a private/fork acquisition or a fence reset.
        appendNativeMarker({ mode, scopes }, ctx);
        if (mode === "active") {
            // A different selection revokes old-scope persistence, not an independent same-scope Stop.
            inactivePersistence.cancel();
            return startStateFlow(ctx, true);
        }
        const sameSession = sessionIdentity(ctx);
        const restoring = restoreActiveBranch(ctx, undefined, true, undefined, "passive");
        const signal = branchRestoration.current?.controller.signal;
        return restoring.then(() => {
            if (signal?.aborted || !sameSession() || !sameJson(scopes, nativeScopeSelection(ctx)) || snapshot.config.mode !== "passive") {
                return { ok: false, message: "State Flow mode change was superseded" };
            }
            return { ok: snapshot.meta.validation?.attempt !== 0, message: snapshot.meta.validation?.error ?? "State Flow passive" };
        });
    }
    for (const mode of ["active", "passive", "off"]) {
        pi.registerCommand(`state-flow-${mode}`, {
            description: `${MODE_COMMAND_DESCRIPTIONS[mode]} [global cwd session]`,
            getArgumentCompletions: prefix => {
                const values = scopeSelectionArgumentCompletions(prefix);
                return values.length ? values.map(value => ({ value, label: value })) : null;
            },
            handler: async (args, ctx) => {
                const scopes = parseScopeSelectionArguments(args);
                await selectMode(ctx, mode, scopes);
            },
        });
    }
    pi.registerCommand("state-flow-status", {
        description: "Show State Flow runtime status",
        handler: async (_args, ctx) => {
            ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
        },
    });
    /** Unavailable selection or failed persistence needs current-memory acceptance, not a sticky Passive write fence. */
    function passiveRecoveryNeeded(mode) {
        return mode === "passive" && (modePersistenceError !== undefined || snapshot.meta.validation?.attempt === 0);
    }
    /** Local policy, tools and UI change before any canonical wait. */
    function applyInactiveMode(ctx, mode) {
        // Visibility changes before optional recovery waits; a frozen Active head must not survive Passive.
        if (snapshot.config.mode !== mode)
            contextProjection.reset();
        snapshot = deactivateEpisode(snapshot, mode);
        clearRunTransient();
        syncStateFlowTools();
        updateUi(ctx);
    }
    function deactivateStateFlow(ctx, mode) {
        if (shuttingDown)
            return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
        if (mode === "off")
            return selectOff(ctx);
        startActivation.cancel();
        telegramStartPending = false;
        const persisting = inactivePersistence.current;
        if (persisting?.operation && !persisting.published) {
            // Pending inactive choices coalesce: acceptance persists whichever inactive mode is current then.
            if (snapshot.config.mode !== mode)
                applyInactiveMode(ctx, mode);
            return persisting.operation;
        }
        if (!activeContext)
            void restoreActiveBranch(ctx, undefined, false);
        const restoring = branchRestoration.current;
        // Read-only recovery also retains the latest policy; its native write fence is updated below.
        if (restoring)
            restoring.requestedMode = mode;
        if (restoring?.awaitingAcceptance) {
            // Passive keeps independently owned restoration; Off withdraws it through selectOff.
            applyInactiveMode(ctx, mode);
            // A read-only observer may never write a checkpoint; retain the newer choice now.
            if (branchPolicy(ctx).mode !== mode)
                appendNativeMarker({ mode }, ctx);
            return Promise.resolve({ ok: true, message: `State Flow ${mode}; memory restoration continues` });
        }
        if (snapshot.config.mode === mode) {
            const recordedMode = branchPolicy(ctx).mode;
            if (!passiveRecoveryNeeded(mode) && (modePersistenceError || recordedMode === mode))
                return Promise.resolve({ ok: true, message: `State Flow is already ${mode}` });
        }
        inactivePersistence.cancel();
        const pending = inactivePersistence.claim({ controller: new AbortController() });
        return inactivePersistence.track(pending, deferredBranch && mode === "passive"
            ? acquirePassiveMode(ctx, pending, deferredBranch.reason)
            : persistInactiveMode(ctx, pending, mode));
    }
    /** Off owns cancellation and native policy only; no canonical transaction or semantic handoff. */
    function selectOff(ctx, scopes) {
        const address = sessionAddress(ctx);
        const owner = ctx.sessionManager.getSessionId();
        const branch = ctx.sessionManager.getBranch();
        const selected = runtime;
        const sameOwner = selected?.sessionKey === address.key && selected.cwd === ctx.cwd;
        let policy;
        try {
            policy = branchPolicy(ctx, undefined, false);
            requestPolicy.select({ cwd: ctx.cwd, owner, mode: snapshot.config.mode, scopes: scopes ?? policy.scopes });
        }
        catch { /* Explicit Off denies memory even when the prior policy cannot be admitted. */ }
        const forkRecorded = policy?.forkPending ?? false;
        const pendingFork = forkRecorded || (sameOwner && forkInitialization) || (deferredBranch?.owner === address.key && deferredBranch.cwd === ctx.cwd && deferredBranch.reason === "fork")
            || (!policy && typeof ctx.sessionManager.getHeader()?.parentSession === "string");
        const sameDeferred = deferredBranch?.owner === address.key && deferredBranch.cwd === ctx.cwd;
        const current = sameOwner || sameDeferred ? snapshot : emptySnapshot("off");
        if (!sameOwner && !sameDeferred)
            modePersistenceError = policy?.persistenceError;
        const alreadyOff = current.config.mode === "off" && policy?.mode === "off";
        const incoming = sameOwner || sameDeferred ? current.meta.bootstrap ? bootstrapContinuation : passiveContinuation : undefined;
        const unfinished = current.meta.specification !== undefined || (inferencePreparation.current?.prompt !== undefined && !inferencePreparation.current.accepted)
            || (isActive() && hasUncheckpointedConversation(branch));
        const at = incoming?.startedAt ?? Date.now();
        const from = incoming ? incoming.activeRunStartedAt : (sameOwner || sameDeferred) && (!ctx.isIdle() || unfinished) ? runAnchorTimestamp : undefined;
        const preserveContext = modePersistenceError !== undefined || (incoming ? incoming.preserveContext : current.meta.bootstrap === true || (unfinished && from === undefined));
        const discovery = discoverSnapshotData(branch);
        const preRuntime = (sameOwner && branchStartsWithoutRuntime) || (discovery.candidates.length === 0 && discovery.errors.length === 0);
        let checkpoint;
        try {
            checkpoint = !scopes && !modePersistenceError && current.meta.validation?.attempt !== 0
                ? sameOwner && selected?.selectedView() ? selected.retainedSelectedCheckpoint("off") : undefined
                : undefined;
        }
        catch {
            // An unusable cached bookmark cannot prevent native Off policy or authorize replacement memory.
        }
        startActivation.cancel();
        branchRestoration.cancel();
        inactivePersistence.cancel();
        backup.cancel();
        requestPolicy.invalidate();
        memoryToolLifetime.renew();
        clearRunTransient();
        contextProjection.reset();
        telegramStartPending = false;
        bootstrapContinuation = undefined;
        passiveContinuation = undefined;
        acquisition.reset();
        runtime = undefined;
        snapshot = emptySnapshot("off");
        branchStartsWithoutRuntime = preRuntime;
        forkInitialization = pendingFork;
        deferredBranch = { owner: address.key, cwd: ctx.cwd, reason: pendingFork ? "fork" : undefined };
        activeContext = ctx;
        if (scopes)
            requestPolicy.select({ cwd: ctx.cwd, owner, mode: "off", scopes });
        installScopeStates();
        syncStateFlowTools();
        updateUi(ctx);
        try {
            if (scopes || !alreadyOff || (pendingFork && !forkRecorded)) {
                if (!checkpoint || !preRuntime || pendingFork || preserveContext || from !== undefined || modePersistenceError)
                    appendNativeMarker({
                        owner, at, mode: "off", memoryDeferred: true,
                        ...(scopes === undefined ? {} : { scopes }),
                        ...(from === undefined ? {} : { from }),
                        ...(preserveContext ? { preserveContext: true } : {}),
                        ...(pendingFork ? { forkPending: true } : {}),
                        ...(modePersistenceError === undefined ? {} : { persistenceError: modePersistenceError }),
                    });
                if (checkpoint)
                    pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
            }
            return Promise.resolve({ ok: true, message: alreadyOff ? "State Flow is already off" : "State Flow off" });
        }
        catch (error) {
            const message = conciseDiagnostic(`State Flow off; native mode recording failed: ${diagnosticText(error)}`);
            notifyProblem(ctx, message, "error");
            return Promise.resolve({ ok: false, message });
        }
    }
    async function acquirePassiveMode(ctx, pending, reason) {
        await restoreActiveBranch(ctx, reason, true, pending.controller, "passive");
        if (!inactivePersistence.owns(pending) || pending.controller.signal.aborted || shuttingDown) {
            return { ok: false, message: "State Flow mode change was superseded" };
        }
        return persistInactiveMode(ctx, pending, "passive");
    }
    async function persistInactiveMode(ctx, pending, mode) {
        let selected = runtime;
        const owner = ctx.sessionManager.getSessionId();
        const current = snapshot;
        const wanted = captureScopeSelection(nativeScopeSelection(ctx));
        const wasActive = current.config.mode === "active";
        let unfinished = current.meta.specification !== undefined
            || (inferencePreparation.current?.prompt !== undefined && !inferencePreparation.current.accepted);
        const recoverPassive = passiveRecoveryNeeded(mode);
        applyInactiveMode(ctx, mode);
        const stoppedAt = Date.now();
        if (recoverPassive) {
            const superseded = () => ({ ok: false, message: "State Flow mode change was superseded" });
            const owns = () => inactivePersistence.owns(pending) && !pending.controller.signal.aborted && !shuttingDown;
            try {
                // Join pending read-only recovery so its installation cannot supersede this acceptance.
                const restoring = branchRestoration.current?.operation;
                if (restoring)
                    await waitForRecovery(restoring, pending.controller.signal);
            }
            catch {
                return superseded();
            }
            if (!owns())
                return superseded();
            // Passive is a stable mode: explicit selection accepts validated current memory instead of keeping a write fence.
            const recovered = await activateCurrentState(ctx, pending.controller, "passive", () => inactivePersistence.owns(pending));
            if (recovered.ok)
                pending.published = true;
            if (recovered.ok || !owns())
                return recovered;
            if (current.config.mode === mode && modePersistenceError) {
                // The existing native fence already records this policy; report why acceptance still failed.
                pending.published = true;
                const message = conciseDiagnostic(`State Flow passive; memory writes remain paused: ${recovered.message}`);
                notifyProblem(ctx, message, "warning");
                return { ok: true, message };
            }
            selected = runtime;
        }
        if (modePersistenceError) {
            // Writes stay paused; the native marker records only the newly selected inactive policy.
            pending.published = true;
            appendNativeMarker({
                at: passiveContinuation?.startedAt ?? stoppedAt,
                ...(passiveContinuation?.activeRunStartedAt === undefined ? {} : { from: passiveContinuation.activeRunStartedAt }),
                preserveContext: true, owner, persistenceError: modePersistenceError, mode,
            });
            return { ok: true, message: `State Flow ${mode}; memory writes remain paused` };
        }
        const incomingBoundary = current.meta.bootstrap ? bootstrapContinuation : undefined;
        const anchor = runAnchorTimestamp;
        const idle = ctx.isIdle();
        const isCurrent = () => inactivePersistence.owns(pending) && runtime === selected
            && !shuttingDown && ctx.sessionManager.getSessionId() === owner && !isActive();
        const superseded = () => ({ ok: false, message: "State Flow mode change was superseded" });
        const freezeHandoff = () => {
            contextProjection.reset();
            const handoff = (wasActive || modePersistenceError) && readableView(selected) && current.meta.validation?.attempt !== 0
                ? createPassiveContinuation(projectModelState(effectiveState), incomingBoundary?.startedAt ?? stoppedAt, incomingBoundary ? incomingBoundary.activeRunStartedAt : !idle || unfinished ? anchor : undefined, modePersistenceError !== undefined || (incomingBoundary ? incomingBoundary.preserveContext : current.meta.bootstrap === true || (unfinished && anchor === undefined)), wanted)
                : undefined;
            // Repeated Passive choices keep the already selected continuation boundary.
            passiveContinuation = handoff ?? (!wasActive ? passiveContinuation : undefined);
            return handoff;
        };
        const complete = () => {
            pending.published = true;
            const exitHandoff = freezeHandoff();
            const selectedMode = snapshot.config.mode;
            if (exitHandoff || modePersistenceError)
                appendNativeMarker({
                    at: exitHandoff?.startedAt ?? stoppedAt,
                    ...(exitHandoff?.activeRunStartedAt === undefined ? {} : { from: exitHandoff.activeRunStartedAt }),
                    ...(exitHandoff?.preserveContext || modePersistenceError ? { preserveContext: true } : {}),
                    ...(modePersistenceError === undefined ? {} : { owner, persistenceError: modePersistenceError, mode: selectedMode }),
                });
            if (!modePersistenceError) {
                appendCheckpoint();
                return { ok: true, message: `State Flow ${selectedMode}`, signal: sharedInspectionLifetime.signal };
            }
            const message = conciseDiagnostic(`State Flow ${selectedMode}; memory writes paused: ${modePersistenceError}`);
            notifyProblem(ctx, message, "warning");
            return { ok: true, message, signal: sharedInspectionLifetime.signal };
        };
        let accepted = false;
        try {
            unfinished ||= wasActive && hasUncheckpointedConversation(ctx.sessionManager.getBranch());
            // Projection changes before any wait; capture the old run's boundary before later native input can replace it.
            freezeHandoff();
            bootstrapContinuation = undefined;
            acquisition.clearInvalidations();
            assertPublicationAvailable();
            const signal = modeOperationSignal(ctx, pending.controller.signal);
            if (branchStartsWithoutRuntime || !selected?.selectedView()) {
                // A pre-runtime choice is native-only; Passive then loads shared memory without initializing storage.
                const result = complete();
                if (snapshot.config.mode !== "passive" || readableView())
                    return result;
                const passive = await loadPassiveView(ctx, signal, isCurrent, true);
                if (passive && isCurrent() && !signal.aborted && !readableView()) {
                    runtime = selected = passive;
                    installScopeStates();
                    updateUi(ctx);
                }
                return isCurrent() ? result : superseded();
            }
            await selected.persistSelectedPassive(() => {
                signal.throwIfAborted();
                if (!isCurrent())
                    throw new Error("State Flow mode selection changed while awaiting publication");
                assertPublicationAvailable();
            }, signal);
            accepted = true;
            installScopeStates();
            recordPublication();
            const result = complete();
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
            acquisition.clearInvalidations();
            return complete();
        }
    }
    const telegram = createStateFlowTelegramAdapter({
        ...(options.telegram?.load === undefined ? {} : { load: options.telegram.load }),
        port: {
            snapshot: () => ({
                mode: snapshot.config.mode,
                scopes: captureScopeSelection(nativeScopeSelection()),
                inferenceBlocked: isActiveRestorationBlocked(snapshot),
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
                // Native-only outcomes use the selected lifetime; async acceptance may renew and return its own receipt.
                const signal = sharedInspectionLifetime.signal;
                try {
                    const result = await operation;
                    return { ...result, signal: result.signal ?? signal };
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
                startActivation.cancel();
            },
        },
    });
    void telegram.ensure();
    function invalidateModuleModelContext(ctx) {
        if (!shuttingDown && snapshot.config.mode !== "off" && currentNativeContextOwner(ctx) && moduleHost.captureIfBound()?.modules.length)
            requestPolicy.invalidate();
    }
    pi.on("model_select", (event, ctx) => { if (event.previousModel !== event.model)
        invalidateModuleModelContext(ctx); });
    pi.on("thinking_level_select", (event, ctx) => { if (event.previousLevel !== event.level)
        invalidateModuleModelContext(ctx); });
    // turn_start/context/message_end are transport-independent; provider HTTP hooks are optional.
    pi.on("turn_start", (_event, ctx) => {
        if (shuttingDown)
            return;
        requestPolicy.select({ cwd: ctx.cwd, owner: ctx.sessionManager.getSessionId(), mode: snapshot.config.mode, scopes: nativeScopeSelection(ctx) });
        const catalog = snapshot.config.mode === "off" ? undefined : moduleHost.captureIfBound();
        const sameSession = sessionIdentity(ctx);
        nativeRequests.begin(snapshot.config.mode === "off" ? undefined : requestPolicy.capture(), ctx.signal, () => { catalog?.assertCurrent(); return sameSession(); }, catalog ? AbortSignal.any([requestPolicy.signal, catalog.signal]) : requestPolicy.signal);
    });
    pi.on("before_agent_start", (event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        // Native run identity is independent of semantic enablement and survives mode toggles.
        runAnchorTimestamp = undefined;
        if (!isActive()) {
            if (!passiveMemoryAvailable())
                return;
            (event.systemPromptOptions.sections ??= {}).state_flow = passiveMemoryProtocol(nativeScopeSelection(ctx));
            return;
        }
        contextProjection.reset();
        skillReads.clear();
        artifactReads.clear();
        responseReconciliation.cancel();
        completedRunAccepted = false;
        // This native hook has no operation signal. Capture only; the first active context owns acceptance.
        deferInferencePreparation(event.prompt);
        (event.systemPromptOptions.sections ??= {}).state_flow = stateFlowProtocol(snapshot.meta.bootstrap === true, nativeScopeSelection(ctx));
    });
    /** Never abort a replacement native operation through an obsolete ambient context. */
    function abortContext(ctx, operationSignal) {
        if (operationSignal && ctx.signal === operationSignal && !operationSignal.aborted
            && (!nativeRequests.active || nativeRequests.ownsOperation(operationSignal))) {
            if (nativeRequests.ownsOperation(operationSignal))
                guardAbortedOperation = operationSignal;
            ctx.abort();
        }
    }
    function contextRequest(ctx) {
        if (!ctx.signal || !nativeRequests.active)
            return undefined;
        if (!nativeRequests.ownsOperation(ctx.signal))
            throw new Error("State Flow context operation is no longer current");
        return nativeRequests.preparing();
    }
    function contextRequestCurrent(request, ctx, operationSignal) {
        try {
            request?.revalidate();
            return true;
        }
        catch {
            abortContext(ctx, operationSignal);
            return false;
        }
    }
    /** The post-context membrane must not turn failed Active preparation into raw-history fallback. */
    function providerContextCurrent(ctx) {
        const operationSignal = ctx.signal;
        try {
            const request = contextRequest(ctx);
            request?.revalidate();
            if (request && isActive() && inferencePreparation.current && !inferencePreparation.current.accepted)
                throw new Error("State Flow preparation was not accepted");
            return true;
        }
        catch {
            abortContext(ctx, operationSignal);
            return false;
        }
    }
    pi.on("context_with_system", (event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx) || !providerContextCurrent(ctx))
            return;
        // Off removes the owned section, including one contributed before an in-flight mode change.
        const protocol = isActive() ? stateFlowProtocol(snapshot.meta.bootstrap === true, nativeScopeSelection(ctx))
            : passiveMemoryAvailable() ? passiveMemoryProtocol(nativeScopeSelection(ctx)) : undefined;
        return { messages: projectSystemProtocol(event.messages, protocol) };
    });
    // Optional transport checkpoint: no payload/header inspection or transformation.
    pi.on("before_provider_request", (_event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        providerContextCurrent(ctx);
    });
    function projectContext(messages, modelScopes) {
        // Off injects no State Flow context, including a retained passive handoff.
        if (snapshot.config.mode === "off" || snapshot.meta.validation?.attempt === 0)
            return;
        if (readableView())
            refreshArtifactHints();
        if (!isActive() && !passiveContinuation && !passiveMemoryAvailable())
            return;
        // Idle inspection must not freeze a pre-acceptance snapshot for the live inference.
        const projection = isActive() && inferencePreparation.current && !inferencePreparation.current.accepted
            ? new ContextProjection() : contextProjection;
        const effective = effectiveState;
        const invalidations = acquisition.invalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason }));
        const phase = isActive() ? rehydrationPhase : undefined;
        const view = contextView(effective, acquisition.hints, invalidations, phase, isActive(), modelScopes);
        if (passiveContinuation) {
            const retained = passiveContinuationMessages(messages, passiveContinuation);
            if (!readableView())
                return { messages: retained };
            return { messages: projection.project(retained.slice(1), view, () => passiveContinuation.handoff, { state: passiveContinuation.state, lazy_navigation: view.lazy_navigation, artifact_invalidations: [], knowledge_rehydration: null, modelScopes }) };
        }
        if (!isActive()) {
            return { messages: projection.project(messages, view, () => passiveContextHead(view)) };
        }
        // Native user events own the run anchor; projection must never rebase it.
        const source = snapshot.meta.bootstrap
            ? bootstrapContinuation ? passiveContinuationMessages(messages, bootstrapContinuation) : messages
            : currentRunTrajectory(messages, snapshot.meta.specification, runAnchorTimestamp).messages;
        return { messages: projection.project(source, view, () => runtimeContextHead(snapshot, view, projectRecentTransitionsWithLimit(config.historyLimit, runtime?.recent() ?? []))) };
    }
    function prepareContext(messages, ctx) {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        const operationSignal = ctx.signal;
        let request;
        let modelScopes;
        try {
            request = contextRequest(ctx);
            request?.revalidate();
            modelScopes = captureScopeSelection(nativeScopeSelection(ctx));
        }
        catch {
            abortContext(ctx, operationSignal);
            return;
        }
        // Pi continues after hook errors; public Abort fences inference instead of exposing the native history fallback.
        if (isActiveRestorationBlocked(snapshot) && ctx.signal && !shuttingDown) {
            abortContext(ctx, operationSignal);
            notifyProblem(ctx, "State Flow inference blocked: Active memory restoration failed. Select a valid branch or use /state-flow-active for current memory; /state-flow-passive or /state-flow-off explicitly permits native context.", "error");
            return;
        }
        const pending = inferencePreparation.current;
        const selected = runtime;
        // Idle projections remain observational; accepted preparation is not replayed for another model turn.
        if (!isActive() || !pending || pending.accepted || !operationSignal || shuttingDown)
            return projectContext(messages, modelScopes);
        if (pending.operation && pending.request !== request) {
            abortContext(ctx, operationSignal);
            return;
        }
        pending.request = request;
        pending.operation ??= prepareInference(pending, selected, ctx, operationSignal, request, messages).finally(() => {
            // A late withdrawal must not clear newer work; accepted lifecycle is never replayed after an error.
            if (!pending.accepted && inferencePreparation.owns(pending))
                pending.operation = undefined;
        });
        return pending.operation.then(() => {
            if (!currentNativeContextOwner(ctx))
                return;
            if (!contextRequestCurrent(request, ctx, operationSignal))
                return;
            if (shuttingDown || operationSignal.aborted || runtime !== selected || ctx.signal !== operationSignal) {
                if (request)
                    abortContext(ctx, operationSignal);
                return;
            }
            if (isActive() && !inferencePreparation.owns(pending)) {
                // Start may require same-run maintenance. A new captured user prompt instead owns a different context request.
                if (inferencePreparation.current?.prompt === undefined)
                    return prepareContext(messages, ctx);
                if (request)
                    abortContext(ctx, operationSignal);
                return;
            }
            if (isActive() && !pending.accepted) {
                if (request)
                    abortContext(ctx, operationSignal);
                return;
            }
            return projectContext(messages, modelScopes);
        });
    }
    async function capturePublicModules(messages, ctx, ownedSignal) {
        if (snapshot.config.mode === "off" || !ctx.signal || !nativeRequests.active)
            return;
        const selected = runtime, view = readableView(selected), catalog = moduleHost.captureIfBound();
        if (!selected || !view || !catalog?.modules.length)
            return;
        const receipt = requestPolicy.capture(), sameSession = sessionIdentity(ctx), model = ctx.model, request = contextRequest(ctx);
        const operationSignal = ctx.signal, controller = new AbortController();
        const signal = AbortSignal.any([operationSignal, receipt.signal, catalog.signal, controller.signal, ...(ownedSignal ? [ownedSignal] : []), ...(request ? [request.signal] : [])]);
        const basis = selected.captureSelectedReadBasis();
        const check = () => {
            signal.throwIfAborted();
            receipt.revalidate();
            catalog.assertCurrent();
            if (shuttingDown || runtime !== selected || ctx.signal !== operationSignal || ctx.model !== model || !sameSession() || !currentNativeContextOwner(ctx))
                throw new Error("State Flow module context owner changed");
        };
        try {
            check();
            basis();
            const wanted = captureScopeSelection(receipt.policy.scopes);
            const source = wanted.includes("session") && view.selection.includes("session") ? moduleConversationSource(messages, runAnchorTimestamp) : { conversation: [] };
            const jobs = wanted.flatMap(scope => {
                if (!view.selection.includes(scope))
                    return [];
                const state = selected.readView(0, scope);
                return catalog.modules.flatMap(module => {
                    const descriptor = view.scopes[scope]?.modules?.[module.id];
                    if (descriptor && (descriptor.schemaVersion !== module.schemaVersion || descriptor.immutable !== module.immutable))
                        return [];
                    const content = state[module.id];
                    const frame = { mode: receipt.policy.mode, scope, ...(scope === "session" ? source : { conversation: [] }) };
                    return [prepareModuleContext(module, content, frame, signal, check).then(prepared => ({ module, scope, content, descriptor, prepared }))];
                });
            });
            const bindings = await Promise.all(jobs);
            const assertCurrent = () => { check(); for (const item of bindings)
                item.prepared.assertCurrent(); };
            const assertOriginal = () => { assertCurrent(); basis(); };
            assertOriginal();
            return { bindings, definitions: catalog.modules, conversation: source.conversation, assertCurrent, assertOriginal, cancel: () => controller.abort() };
        }
        catch {
            controller.abort();
            throw new Error("State Flow registered module input preparation failed");
        }
    }
    async function preparePublicContext(messages, projected, ctx) {
        if (!projected || snapshot.config.mode === "off" || !ctx.signal || !nativeRequests.active)
            return projected;
        const operationSignal = ctx.signal, sameSession = sessionIdentity(ctx), selected = runtime;
        let batch;
        try {
            const pending = inferencePreparation.current, request = contextRequest(ctx);
            const accepted = pending?.accepted && pending.request === request ? pending.modules : undefined;
            batch = accepted ?? await capturePublicModules(messages, ctx);
            if (!batch || !selected)
                return projected;
            if (!accepted)
                batch.assertOriginal();
            const current = batch, basis = accepted ? pending.moduleAcceptance : selected.captureSelectedReadBasis();
            const assertCurrent = () => { current.assertCurrent(); basis(); };
            assertCurrent();
            const contributions = current.bindings.map(({ module, scope, prepared }) => ({ id: module.id, scope,
                contributions: prepared.evaluate({ content: selected.readView(0, scope)[module.id] }) }));
            const result = projectModuleContext(projected.messages, messages, current.conversation, contributions);
            assertCurrent();
            nativeRequests.bindPreparedContext(assertCurrent);
            return { messages: result };
        }
        catch {
            batch?.cancel();
            abortContext(ctx, operationSignal);
            if (!shuttingDown && sameSession())
                notifyProblem(ctx, "State Flow registered module context is unavailable; the current inference was aborted without changing module memory", "error");
            return undefined;
        }
    }
    pi.on("context", (event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        const messages = event.messages;
        const projected = prepareContext(messages, ctx);
        if (snapshot.config.mode === "off" || !ctx.signal || !nativeRequests.active || !moduleHost.captureIfBound()?.modules.length)
            return projected;
        return Promise.resolve(projected).then(result => preparePublicContext(messages, result, ctx));
    });
    pi.on("tool_execution_start", (event, ctx) => {
        if (event.parentToolCallId) {
            try {
                nativeRequests.nested(event.toolCallId, event.toolName, event.parentToolCallId);
            }
            catch {
                return;
            }
        }
        if (!isActive() || !currentNativeTool(event.toolCallId, event.toolName, ctx))
            return;
        // Pi emits this before tool_call. Keep the argument object as a fallback;
        // tool_call replaces it with the mutable, post-preflight input reference.
        skillReads.recordStart(event.toolCallId, event.toolName, event.args);
        artifactReads.recordStart(event.toolCallId, event.toolName, event.args);
    });
    pi.on("tool_call", (event, ctx) => {
        const owned = event.toolName === PATCH_STATE_TOOL_NAME || event.toolName === READ_STATE_TOOL_NAME;
        if (event.parentToolCallId) {
            if (event.toolName === PATCH_STATE_TOOL_NAME && isActive())
                return { block: true, reason: "patch_state requires a direct native assistant barrier, not a nested call" };
            try {
                nativeRequests.nested(event.toolCallId, event.toolName, event.parentToolCallId);
            }
            catch {
                if (owned)
                    return { block: true, reason: "State Flow tool batch has no current native request" };
            }
        }
        if (owned) {
            try {
                nativeRequests.check(event.toolCallId, event.toolName);
            }
            catch {
                return { block: true, reason: "State Flow tool batch has no current native request" };
            }
        }
        if (!isActive() || !currentNativeTool(event.toolCallId, event.toolName, ctx))
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
    pi.on("tool_execution_end", (event, ctx) => {
        if (!isActive() || !currentNativeTool(event.toolCallId, event.toolName, ctx))
            return;
        skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
        dropCurrentSkillReads();
        artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
    });
    pi.on("tool_result", (event, ctx) => {
        if (!isActive() || !currentNativeTool(event.toolCallId, event.toolName, ctx))
            return;
        const read = skillReads.recordResult(event.toolName, event.input, event.isError);
        if (!read)
            return;
        dropCurrentSkillReads();
        const hint = skillAcquisitionHint(read, nativeScopeSelection(ctx));
        if (!hint)
            return;
        return { content: [...event.content, { type: "text", text: `\n${hint}` }] };
    });
    /** Native contributions and completions may not borrow another physical/native owner. */
    function currentNativeContextOwner(ctx) {
        try {
            const policy = requestPolicy.policy, selected = runtime;
            return policy !== undefined && activeContext !== undefined && policy.owner === ctx.sessionManager.getSessionId()
                && policy.cwd === ctx.cwd && sessionAddress(activeContext).key === sessionAddress(ctx).key
                && (selected === undefined || selected.sessionId === policy.owner && selected.cwd === ctx.cwd && selected.sessionKey === sessionAddress(ctx).key)
                && (!ctx.signal || !nativeRequests.active || nativeRequests.ownsOperation(ctx.signal));
        }
        catch {
            return false;
        }
    }
    pi.on("message_end", (event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        if (event.message.role === "assistant")
            nativeRequests.finalize((Array.isArray(event.message.content) ? event.message.content : [])
                .filter(block => block.type === "toolCall").map(block => ({ id: block.id, name: block.name })));
        // Observe actual user events even while disabled; Start/Stop cannot invent or erase them.
        if (event.message.role === "user" && runAnchorTimestamp === undefined)
            runAnchorTimestamp = event.message.timestamp;
        if (shuttingDown || !isActive())
            return;
        if (event.message.role !== "assistant")
            return;
        let request;
        try {
            request = ctx.signal || nativeRequests.active ? nativeRequests.current() : requestPolicy.capture();
        }
        catch {
            return;
        }
        const selected = runtime, sameSession = sessionIdentity(ctx), operationSignal = ctx.signal;
        const revalidate = () => {
            request.revalidate();
            if (runtime !== selected || ctx.signal !== operationSignal || !sameSession() || !currentNativeContextOwner(ctx))
                throw new Error("State Flow response selection owner changed");
        };
        try {
            revalidate();
        }
        catch {
            return;
        }
        responseReconciliation.cancel();
        const message = event.message;
        if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse")
            return;
        if (message.stopReason === "length" || message.stopReason === "error") {
            recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content });
            return;
        }
        responseReconciliation.claim({ controller: new AbortController(), request, operationSignal, revalidate });
    });
    pi.on("turn_end", async (event, ctx) => {
        if (shuttingDown || !currentNativeContextOwner(ctx))
            return;
        const pending = responseReconciliation.current;
        if (pending && pending.operationSignal !== ctx.signal)
            return;
        nativeRequests.end();
        if (!isActive() || !pending) {
            updateUi(ctx);
            return;
        }
        const selected = runtime, sameSession = sessionIdentity(ctx);
        const check = () => {
            pending.revalidate();
            if (ctx.signal !== pending.operationSignal || !sameSession() || !currentNativeContextOwner(ctx))
                throw new Error("State Flow response completion owner changed");
        };
        const signal = AbortSignal.any([pending.controller.signal, ...(ctx.signal ? [ctx.signal] : []), pending.request.signal]);
        let responseCommitted = false;
        try {
            check();
            const response = finalizedAssistantResponse(event.message);
            if (!selected?.selectedView())
                throw new Error("Temporal StateFlow runtime is unavailable; reload before publishing");
            await selected.withSelectedPatchTransaction((transaction) => {
                signal.throwIfAborted();
                check();
                if (runtime !== selected || !responseReconciliation.owns(pending) || !isActive()) {
                    throw new Error("State Flow response selection changed while awaiting publication");
                }
                assertPublicationAvailable();
                const wasBootstrap = snapshot.meta.bootstrap === true;
                const nextSnapshot = structuredClone(snapshot);
                const stage = stageSelectedScopedTransition(transaction, { transitions: [], response }, [], transaction.causalBasis);
                completeRun(nextSnapshot);
                let publication;
                commitSelectedTransition(nextSnapshot, transaction, stage, (accepted, next) => {
                    publication = transaction.publish(next, accepted);
                }, transaction.causalBasis, { finalizeRun: true });
                snapshot = nextSnapshot;
                installScopeStates();
                responseCommitted = true;
                contextProjection.reset();
                if (publication?.changed)
                    recordPublication();
                appendCheckpoint();
                clearAcceptedAcquisitions();
                bootstrapContinuation = undefined;
                rehydrationPhase = "step";
                completedRunAccepted = !wasBootstrap;
                backup.markTurnAccepted();
                updateUi(ctx);
            }, () => {
                check();
                if (runtime !== selected || !responseReconciliation.owns(pending) || !isActive())
                    throw new Error("State Flow response superseded");
            }, signal);
        }
        catch (error) {
            // Superseded completion owns neither the new lifecycle nor its diagnostics/UI.
            if (signal.aborted || runtime !== selected || !responseReconciliation.owns(pending))
                return;
            try {
                check();
            }
            catch {
                return;
            }
            const cause = diagnosticText(error);
            recordDiagnostic(cause, "finalization", ctx);
            notifyProblem(ctx, responseCommitted
                ? `State Flow response saved; lifecycle update failed: ${cause}`
                : `State Flow response reconciliation failed: ${cause}`, "error");
        }
        finally {
            responseReconciliation.release(pending);
        }
    });
    pi.on("session_before_compact", (event) => {
        const result = compactionRequests.resolve(event, !shuttingDown && isActive());
        if (result === undefined || "cancel" in result)
            return result;
        return { compaction: result };
    });
    pi.on("agent_before_settle", async (_event, ctx) => {
        if (shuttingDown || !memoryToolsAvailable() || !backup.takeSettledTurn())
            return;
        const operationSignal = ctx.signal;
        const lifetime = backup.lifetime;
        const signal = operationSignal ? AbortSignal.any([lifetime, operationSignal]) : lifetime;
        const selected = runtime;
        try {
            if (existsSync(join(repositoryRoot, ".git"))) {
                const pushSessionId = sessionAddress(ctx).id;
                const pushCwd = ctx.cwd;
                // Pi 0.87 settles after its agent signal ends; waiting there would strand native Abort.
                await backup.track(backupCurrentStateFlowFiles(repositoryRoot, signal, operationSignal !== undefined));
                if (signal.aborted || snapshot.config.mode === "off")
                    return;
                startStateFlowBackupPush(repositoryRoot, (error) => {
                    if (shuttingDown || lifetime.aborted || snapshot.config.mode === "off")
                        return;
                    const message = diagnosticText(error);
                    const recorded = diagnosticWriter.recordBackupPushFailure(pushSessionId, pushCwd, message);
                    if (!backup.claimPushFailureNotice())
                        return;
                    notifyActiveContext(recorded
                        ? `State Flow Git backup push failed; state is saved locally. Details: ${stateFlowLogPath(agentDir)}. A later accepted turn retries.`
                        : `State Flow Git backup push failed; local diagnostics unavailable: ${message}`);
                }, () => backup.resetPushFailureNotice(), lifetime);
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
        if (!completedRunAccepted || compactionRequests.stopped || !isActive() || snapshot.meta.bootstrap
            || compactionRequests.inFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !runtime?.selectedView()
            || !shouldRequestStateFlowCompaction(ctx.getContextUsage()))
            return;
        completedRunAccepted = false;
        const entries = ctx.sessionManager.buildContextEntries();
        if (!hasCompactionSizedTranscript(entries))
            return;
        const plan = planStateFlowCompaction(entries, runtime.causalBasis(), snapshot.meta.step, runAnchorTimestamp);
        if (!plan)
            return;
        const marker = compactionRequests.begin(plan);
        // Pi dispatches deferred companion prompts after all settled handlers return.
        await new Promise((resolve) => {
            const finished = () => {
                compactionRequests.finish(marker);
                resolve();
            };
            ctx.compact({ customInstructions: marker, onComplete: finished, onError: finished });
        });
    });
    pi.on("session_compact", () => { contextProjection.reset(); });
    pi.on("session_start", async (event, ctx) => {
        const sameSession = sessionIdentity(ctx);
        moduleHost.bind(ctx.sessionManager, () => { if (!sameSession())
            throw new Error("State Flow module host native owner changed"); });
        const refreshModules = (force = false) => {
            if (shuttingDown)
                return;
            const catalog = moduleHost.captureIfBound();
            if (!catalog || !sameSession())
                return;
            syncStateFlowTools(force || catalog.modules.length > 0);
            catalog.signal.addEventListener("abort", () => refreshModules(true), { once: true });
        };
        refreshModules();
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
        moduleHost.dispose();
        requestPolicy.end();
        nativeRequests.end();
        memoryToolLifetime.end();
        contextProjection.reset();
        const restoring = branchRestoration.cancel();
        const starting = startActivation.cancel();
        const stopping = inactivePersistence.cancel();
        backup.abort();
        inferencePreparation.cancel();
        responseReconciliation.cancel();
        cancelSharedInspections();
        telegramStartPending = false;
        compactionRequests.stop();
        completedRunAccepted = false;
        activeContext = undefined;
        telegram.dispose();
        await Promise.allSettled([...backup.operations, ...branchRestoration.inflight, ...[restoring, stopping, starting].filter((operation) => operation !== undefined)]);
        await awaitInFlightBackupPushes(repositoryRoot);
    });
}
