import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ArtifactAcquisitionState, missingArtifactRemovals } from "./acquisition.ts";
import { inspectRegisteredArtifactPaths, sameArtifactSourceFingerprint } from "./artifact.ts";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, StateFlowCompactionRequests } from "./compaction.ts";
import { inactiveModeFor, loadStateFlowConfig } from "./config.ts";
import { ContextProjection, contextView, createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, projectSystemProtocol, runtimeContextHead, syntheticUser, type PassiveContinuation } from "./context.ts";
import { readNativeSessionHeader } from "./continuation.ts";
import {
  cwdScopeKey,
  resolveSessionAddress,
  sessionScopeKey,
  type SessionAddress,
} from "./durable.ts";
import { completeRun, deactivateEpisode, prepareRun, resumeEpisode, startEpisode } from "./episode.ts";
import { awaitInFlightBackupPushes, backupCurrentStateFlowFiles, SettledTurnBackup, startStateFlowBackupPush } from "./git.ts";
import { projectRecentTransitionsWithLimit } from "./history.ts";
import { isObject, presentationJson, sameJson } from "./json.ts";
import { StateFlowDiagnosticWriter, stateFlowLogPath, type DiagnosticExtras, type StateFlowDiagnosticCategory } from "./logging.ts";
import { assistantToolCallCount, conciseDiagnostic, diagnosticText, finalizedAssistantResponse, formatPatchStateArguments, PASSIVE_MEMORY_PROTOCOL, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.ts";
import { OwnedOperationSlot, RenewableLifetime, type OwnedOperation } from "./operation.ts";
import { readProjectedState, readStatePath } from "./query.ts";
import { selectedBoundaryFailure, selectRetainedCheckpoint, waitForRecovery } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { discoverSnapshotData, findAssistantToolBatch, findBranchPolicy, findPassiveStopBoundary, hasPendingFork, hasPriorConversation, hasUncheckpointedConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { hasCompiledSkillArtifact, hashSkillSource, registeredSkillResolver, SkillReadTracker, type SuccessfulSkillRead } from "./skills.ts";
import { HistoryBoundaryExpiredError, emptySnapshot, migrationFailure, preRuntimeCheckpoint, type InactiveMode, type RetainedBoundaryCheckpoint, type RetainedPiCheckpoint, type Snapshot, type StateFlowMode } from "./snapshot.ts";
import { emptyState, projectStateForModel, type AtomicScopePatches, type SemanticState, type ModelState, type ScopedStates, type StateScope } from "./state.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type StatusDiagnostics } from "./status.ts";
import { PublicationBusyError } from "./storage.ts";
import { createStateFlowTelegramAdapter, type StateFlowTelegramControlResult, type StateFlowTelegramInspection, type StateFlowTelegramLoader, type StateFlowTelegramScope } from "./telegram.ts";
import { temporalScopeRevisions, type ScopeRevisions } from "./temporal.ts";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition } from "./transition.ts";

export interface StateFlowExtensionOptions {
	agentDir?: string;
	repositoryRoot?: string;
	onRuntime?: (accessor: { read(offset?: number, scope?: StateScope): ModelState }) => void;
	telegram?: { load?: StateFlowTelegramLoader };
	/** Test/SDK override of the default mode for new sessions; repository config remains the Pi default. */
	mode?: StateFlowMode;
}

export { formatPatchStateArguments };

export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";

interface InferencePreparation extends OwnedOperation {
	readonly controller: AbortController;
	readonly prompt?: string;
	accepted?: boolean;
	operation?: Promise<void>;
}

interface BranchRestoration extends OwnedOperation {
	readonly controller: AbortController;
	/** Memory acceptance is independent of the requested session mode. */
	awaitingAcceptance: boolean;
	requestedMode?: InactiveMode;
	operation?: Promise<void>;
}

interface ModeOperation extends OwnedOperation {
	operation?: Promise<StateFlowTelegramControlResult>;
}

interface InactivePersistence extends ModeOperation {
	/** The native mode marker is recorded; later inactive choices start a new persistence. */
	published?: boolean;
}

type BranchSelection =
	| { kind: "settled" }
	| { kind: "current"; mode: InactiveMode }
	| { kind: "restore"; checkpoint: RetainedBoundaryCheckpoint }
	| { kind: "fork"; checkpoint: RetainedBoundaryCheckpoint; source: SessionAddress }
	| { kind: "auto-start" };

export default function stateFlowExtension(pi: ExtensionAPI, options: StateFlowExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const loadedConfig = loadStateFlowConfig(agentDir, options.repositoryRoot);
	const config = options.mode === undefined ? loadedConfig
		: { ...loadedConfig, mode: options.mode, inactiveMode: inactiveModeFor(options.mode) };
	let snapshot: Snapshot = emptySnapshot(config.inactiveMode);
	let scopeStates: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let effectiveState: SemanticState = {};
	let branchStartsWithoutRuntime = false;
	let selectedHistoryExpired = false;
	let modePersistenceError: string | undefined;
	/** One pending inactive-mode persistence; later inactive choices coalesce until it publishes. */
	const inactivePersistence = new OwnedOperationSlot<InactivePersistence>();
	const startActivation = new OwnedOperationSlot<ModeOperation>();
	let forkInitialization = false;
	const branchRestoration = new OwnedOperationSlot<BranchRestoration>();
	let deferredBranch: { reason: unknown; owner: string; cwd: string } | undefined;
	const responseReconciliation = new OwnedOperationSlot<OwnedOperation>();
	const sharedInspectionLifetime = new RenewableLifetime();
	const memoryToolLifetime = new RenewableLifetime();
	let completedRunAccepted = false;
	const compactionRequests = new StateFlowCompactionRequests();
	let passiveContinuation: PassiveContinuation | undefined;
	let bootstrapContinuation: PassiveContinuation | undefined;
	const contextProjection = new ContextProjection();
	const inferencePreparation = new OwnedOperationSlot<InferencePreparation>();
	let runAnchorTimestamp: number | undefined;
	let runtime: TemporalRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let rehydrationPhase: RehydrationPhase | undefined;
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

	function sessionAddress(ctx: ExtensionContext): SessionAddress {
		return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
	}

	/** Native session identity captured before an await; any change supersedes the waiting operation. */
	function sessionIdentity(ctx: ExtensionContext): () => boolean {
		const cwd = ctx.cwd;
		const owner = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		const timestamp = ctx.sessionManager.getHeader()?.timestamp;
		return () => ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
			&& ctx.sessionManager.getHeader()?.timestamp === timestamp;
	}

	function notifyProblem(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
		ctx.ui.notify(conciseDiagnostic(message), level);
	}

	function notifyActiveContext(message: string): void {
		try {
			if (activeContext) notifyProblem(activeContext, message, "warning");
		} catch {
			// An asynchronous push attempt can outlive the Pi context that launched it.
		}
	}

	function createRuntime(ctx: ExtensionContext): TemporalRuntime {
		return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot, undefined, config.historyLimit);
	}

	function projectModelState(state: SemanticState): SemanticState {
		return projectStateForModel(state, acquisition.hints);
	}

	function assertSelectedBranchAvailable(): void {
		if (snapshot.meta.validation?.attempt === 0) {
			throw new Error(`State Flow selected branch is unavailable: ${snapshot.meta.validation.error}`);
		}
	}

	options.onRuntime?.({ read: (offset, scope) => {
		if (scope === "session") assertSelectedBranchAvailable();
		if (!runtime) throw new Error("State Flow temporal runtime is unavailable");
		const { lazy: _lazy, ...defaults } = emptyState();
		return { ...defaults, ...projectModelState(runtime.readView(offset, scope)) };
	} });

	function assertPublicationAvailable(): void {
		assertSelectedBranchAvailable();
		if (modePersistenceError) throw new Error(`Memory writes paused after mode change: ${modePersistenceError}; use /state-flow-active`);
	}

	function isActive(): boolean {
		return snapshot.config.mode === "active";
	}

	/** An unavailable or pending active selection keeps the configured inactive policy, never an invented one. */
	function inactiveSelection(mode: StateFlowMode): InactiveMode {
		return mode === "active" ? config.inactiveMode : mode;
	}

	function appendCheckpoint(): void {
		const checkpoint = branchStartsWithoutRuntime ? preRuntimeCheckpoint(snapshot.config.mode)
			: runtime?.view ? runtime.retainedCheckpoint(snapshot) : undefined;
		if (!checkpoint) throw new Error("State Flow cannot checkpoint an unproven branch; restore a valid checkpoint first");
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
		if ("boundary" in checkpoint) branchStartsWithoutRuntime = false;
	}

	function scopeRevisions(): ScopeRevisions {
		return runtime?.view
			? temporalScopeRevisions(runtime.view)
			: { global: 0, cwd: 0, session: 0 };
	}

	function updateUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, scopeRevisions(), (color, text) => ctx.ui.theme.fg(color, text)));
	}

	function cancelSharedInspections(): void {
		sharedInspectionLifetime.renew(new Error("State Flow inspection was cancelled; select the scope again"));
	}

	function clearRunTransient(): void {
		inferencePreparation.cancel();
		responseReconciliation.cancel();
		cancelSharedInspections();
		completedRunAccepted = false;
		backup.clearTurn();
		compactionRequests.clear();
		skillReads.clear();
		artifactReads.clear();
	}

	function deferInferencePreparation(prompt?: string): void {
		inferencePreparation.cancel();
		inferencePreparation.claim({ controller: new AbortController(), prompt });
		acquisition.clearInvalidations();
	}

	function refreshArtifactHints(): void {
		if (runtime?.view) acquisition.refresh(scopeStates, (scope) => runtime!.artifactProvenance(scope));
		else acquisition.reset();
	}

	function installScopeStates(): void {
		scopeStates = runtime?.view ? runtime.states() : { global: emptyState(), cwd: emptyState(), session: emptyState() };
		effectiveState = runtime?.view ? runtime.readView() : {};
	}

	/** Active and passive expose both memory tools; Off exposes neither. */
	function memoryToolsAvailable(): boolean {
		return snapshot.config.mode !== "off";
	}

	/** Passive memory context needs a loaded view; Off and Active never inject it. */
	function passiveMemoryAvailable(): boolean {
		return snapshot.config.mode === "passive" && runtime?.view !== undefined;
	}

	async function inspectTelegramState(scope: StateFlowTelegramScope): Promise<StateFlowTelegramInspection> {
		if (!activeContext || shuttingDown) throw new Error("State Flow is not attached to an active session yet");
		const ctx = activeContext;
		const owner = sessionAddress(ctx).key;
		const cwd = ctx.cwd;
		const off = snapshot.config.mode === "off";
		const privateScope = scope === "session" || scope === "effective";
		if (!off && privateScope) assertSelectedBranchAvailable();
		// Off operator reads are disposable: they confer no selected-branch/cache authority.
		const selected = off ? createRuntime(ctx) : runtime ??= createRuntime(ctx);
		const signal = sharedInspectionLifetime.signal;
		let privateAvailable = true;
		if (off && privateScope) privateAvailable = await selected.refreshCurrentMemory(signal) !== undefined;
		else if (!selected.view || (scope !== "session" && !modePersistenceError)) await selected.refreshShared(signal);
		signal.throwIfAborted();
		if (activeContext !== ctx || ctx.cwd !== cwd || sessionAddress(ctx).key !== owner || (!off && runtime !== selected)) {
			throw new Error("State Flow inspection selection changed; select the scope again");
		}
		if (!privateAvailable) throw new Error("Current State Flow session memory is unavailable");
		if (!off && privateScope) assertSelectedBranchAvailable();
		if (!selected.view) throw new Error("State Flow temporal runtime is unavailable");
		if (!off) installScopeStates();
		const state = selected.readView(0, scope === "effective" ? undefined : scope);
		return { state: { ...projectModelState(state), ...(state.lazy === undefined ? {} : { lazy: structuredClone(state.lazy) }) }, revisions: temporalScopeRevisions(selected.view), signal };
	}

	function syncStateFlowTools(): void {
		const active = pi.getActiveTools();
		const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
		const available = memoryToolsAvailable();
		if (owned.every((name) => active.includes(name) === available)) return;
		pi.setActiveTools(available
			? [...new Set([...active, ...owned])]
			: active.filter((name) => !owned.includes(name)));
	}

	/** Accepted canonical publication establishes runtime authority and makes the settled-turn Git backup due. */
	function recordPublication(): void {
		// A passive view is not runtime authority; only accepted canonical publication establishes it.
		branchStartsWithoutRuntime = false;
		backup.markPublished();
	}

	function skillReadIsCurrent(read: SuccessfulSkillRead): boolean {
		return read.hash !== undefined && runtime?.view !== undefined && hasCompiledSkillArtifact(
			scopeStates[read.scope].artifacts,
			runtime.artifactProvenance(read.scope)[read.path],
			read.path,
			read.hash,
		);
	}

	function dropCurrentSkillReads(): void {
		for (const read of skillReads.successful.values()) {
			if (skillReadIsCurrent(read)) skillReads.delete(read.path);
		}
	}

	function skillAcquisitionHint(read: SuccessfulSkillRead): string | undefined {
		if (read.hash === undefined || skillReadIsCurrent(read)) return undefined;
		const target = `${read.scope}.artifacts[${JSON.stringify(read.path)}]`;
		return `State Flow acquisition: this registered Skill belongs at ${target}. If durable compiled guidance is useful, include a non-empty description, kind:"skill", and compilation object there. Unrelated semantic patches do not need to include it.`;
	}

	function clearAcceptedAcquisitions(acquiredArtifactPaths?: ReadonlySet<string>): void {
		acquisition.acceptAcquired(acquiredArtifactPaths);
		dropCurrentSkillReads();
	}

	async function prepareInference(pending: InferencePreparation, selected: TemporalRuntime | undefined, ctx: ExtensionContext, operationSignal: AbortSignal): Promise<void> {
		const signal = AbortSignal.any([pending.controller.signal, operationSignal]);
		try {
			if (!selected?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			await selected.withPatchTransaction((transaction) => {
				signal.throwIfAborted();
				if (runtime !== selected || !inferencePreparation.owns(pending) || !isActive() || shuttingDown) {
					throw new Error("State Flow inference selection changed while awaiting publication");
				}
				assertPublicationAvailable();
				const nextSnapshot = structuredClone(snapshot);
				const rotatesRun = pending.prompt !== undefined && nextSnapshot.meta.specification !== undefined;
				if (pending.prompt !== undefined) prepareRun(nextSnapshot, pending.prompt);
				// Exact-path metadata validation belongs to the locked current head, including newly adopted registrations.
				const removals = missingArtifactRemovals(transaction.states);
				let publication: RuntimePublication | undefined;
				if (Object.keys(removals).length > 0) {
					const stage = stageAtomicScopePatches(transaction.states, removals, [], transaction.causalBasis);
					commitScopedTransition(nextSnapshot, transaction.states, stage, (transition, next) => {
						publication = transaction.publish(next, transition);
						pending.accepted = true;
					}, transaction.causalBasis, { finalizeRun: false });
				} else {
					publication = transaction.publish(nextSnapshot);
					pending.accepted = true;
				}
				snapshot = nextSnapshot;
				installScopeStates();
				if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap") rehydrationPhase = "step";
				if (publication?.changed) recordPublication();
				if (pending.prompt !== undefined || publication?.changed) appendCheckpoint();
				if (Object.keys(removals).length > 0) clearAcceptedAcquisitions();
				updateUi(ctx);
			}, signal);
		} catch (error) {
			if (signal.aborted || runtime !== selected || !inferencePreparation.owns(pending) || shuttingDown) return;
			// Pi reports context-hook exceptions and continues. Abort through its public port rather than infer from stale preparation.
			ctx.abort();
			const cause = diagnosticText(error);
			recordDiagnostic(cause, "publication-conflict", ctx);
			notifyProblem(ctx, pending.accepted
				? `State Flow preparation saved; lifecycle update failed: ${cause}`
				: `State Flow inference preparation failed: ${cause}`, "error");
		}
	}


	function statusDiagnostics(ctx: ExtensionContext): StatusDiagnostics {
		const cwd = ctx.cwd;
		const view = runtime?.view;
		const diagnosticRecent = runtime?.recent() ?? [];
		const durableStateError = snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error
			: view ? undefined : "no temporal runtime is selected on this branch";

		const staleArtifacts: StatusDiagnostics["staleArtifacts"] = durableStateError === undefined
			? acquisition.invalidations.map(({ path, scope, reason }) => ({ scope: scope ?? "global", path, reason }))
			: [];
		const session = sessionAddress(ctx);
		return {
			repositoryRoot,
			cwdScopeKey: cwdScopeKey(cwd),
			sessionScopeKey: sessionScopeKey(session.key),
			scopeStates,
			effectiveState,
			recent: diagnosticRecent,
			historyLimit: config.historyLimit,
			...(view === undefined ? {} : { temporal: {
				head: structuredClone(view.lineage.at(-1)!),
				historyDepth: view.lineage.length - 1,
				tailCounts: { global: view.scopes.global.patches.length, cwd: view.scopes.cwd.patches.length, session: view.scopes.session.patches.length },
				revisions: temporalScopeRevisions(view),
			} }),
			staleArtifacts,
			...(durableStateError === undefined ? {} : { durableStateError }),
			...(modePersistenceError === undefined ? {} : { publicationError: modePersistenceError }),
		};
	}

	function forkSource(ctx: ExtensionContext): SessionAddress {
		const file = ctx.sessionManager.getHeader()?.parentSession;
		if (typeof file !== "string" || !isAbsolute(file)) throw new Error("State Flow fork requires a persisted native parent session");
		const parent = readNativeSessionHeader(file);
		if (parent.cwd !== resolve(ctx.cwd)) throw new Error("State Flow fork parent CWD identity mismatch");
		return resolveSessionAddress(parent.file, parent.id, parent.timestamp);
	}

	/** Select the active native branch under one owned restoration lifetime; only current accepted work installs memory. */
	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown, notifyRecovery = true, startOwner?: AbortController, requestedMode?: InactiveMode): Promise<void> {
		contextProjection.reset();
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
		if (!startOwner) {
			let mode: StateFlowMode = config.inactiveMode;
			let adoptDefault = false;
			let withoutRuntime = false;
			let persistenceError: string | undefined;
			let pendingFork = false;
			try {
				const branch = ctx.sessionManager.getBranch();
				const discovery = discoverSnapshotData(branch);
				withoutRuntime = discovery.candidates.length === 0 && discovery.errors.length === 0;
				adoptDefault = withoutRuntime && isNewSession(sessionStartReason, branch);
				pendingFork = hasPendingFork(branch, ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
				const inherited = sessionStartReason === "fork" || pendingFork;
				const policy = findBranchPolicy(branch, inherited ? undefined : ctx.sessionManager.getSessionId(),
					inherited || retainsPhysicalSessionProjection(sessionStartReason) ? PASSIVE_STOP_ENTRY_TYPE : undefined, config.inactiveMode);
				mode = policy?.mode ?? (adoptDefault ? config.mode : config.inactiveMode);
				persistenceError = inherited
					? findBranchPolicy(branch, ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE, config.inactiveMode)?.persistenceError
					: policy?.persistenceError;
			} catch {
				// Off needs only policy; unavailable native evidence grants no memory authority.
			}
			if (mode === "off") {
				backup.cancel();
				const owner = sessionAddress(ctx).key;
				const reason = pendingFork || (deferredBranch?.owner === owner && deferredBranch.cwd === ctx.cwd && deferredBranch.reason === "fork"
					&& retainsPhysicalSessionProjection(sessionStartReason)) ? "fork" : sessionStartReason;
				if (reason === "fork" && !pendingFork) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { owner: ctx.sessionManager.getSessionId(), forkPending: true });
				deferredBranch = { reason, owner, cwd: ctx.cwd };
				runtime = undefined;
				snapshot = emptySnapshot("off");
				branchStartsWithoutRuntime = withoutRuntime;
				selectedHistoryExpired = false;
				modePersistenceError = persistenceError;
				forkInitialization = reason === "fork";
				installScopeStates();
				acquisition.reset();
				if (adoptDefault) appendCheckpoint();
				syncStateFlowTools();
				updateUi(ctx);
				return Promise.resolve();
			}
			if (pendingFork) sessionStartReason = "fork";
		}
		deferredBranch = undefined;
		runtime = createRuntime(ctx);
		installScopeStates();
		branchStartsWithoutRuntime = false;
		selectedHistoryExpired = false;
		forkInitialization = sessionStartReason === "fork";
		let selection: BranchSelection = { kind: "settled" };
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
			} else {
				const discovery = discoverSnapshotData(branch);
				const selected = selectRetainedCheckpoint(discovery.candidates, config.inactiveMode);
				skipped = discovery.errors.length + selected.skipped.length;
				branchStartsWithoutRuntime = selected.kind === "pre-runtime" || (discovery.candidates.length === 0 && discovery.errors.length === 0);
				if (discovery.candidates.length === 0 && discovery.errors.length > 0) {
					snapshot = migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`, config.inactiveMode);
				} else if (selected.kind === "boundary" && forkInitialization) {
					try {
						// Native parent acquisition stays outside canonical exclusion.
						const source = forkSource(ctx);
						const sourceFence = findPassiveStopBoundary(branch, source.id, PASSIVE_STOP_ENTRY_TYPE);
						selection = { kind: "fork", source, checkpoint: sourceFence?.persistenceError !== undefined
							? { ...selected.checkpoint, mode: sourceFence.mode ?? config.inactiveMode } : selected.checkpoint };
					} catch (error) {
						snapshot = selectedBoundaryFailure(diagnosticText(error), inactiveSelection(selected.checkpoint.mode));
					}
				} else if (selected.kind === "boundary") {
					selection = { kind: "restore", checkpoint: selected.checkpoint };
				} else if (selected.kind === "pre-runtime") {
					snapshot = emptySnapshot(selected.mode);
				} else if (discovery.candidates.length > 0) {
					snapshot = selected.snapshot;
				} else if (isNewSession(sessionStartReason, branch)) {
					// The repository mode is only a default for genuinely new sessions.
					if (config.mode === "active") selection = { kind: "auto-start" };
					else {
						snapshot = emptySnapshot(config.mode);
						// Adopt the default once without initializing semantic storage.
						appendCheckpoint();
					}
				} else {
					snapshot = emptySnapshot(config.inactiveMode);
				}
			}
		} catch (error) {
			selection = { kind: "settled" };
			snapshot = selectedBoundaryFailure(diagnosticText(error), config.inactiveMode);
		}
		// Pending selection grants neither private reads nor publication until its acceptance installs memory.
		if (selection.kind !== "settled") {
			snapshot = migrationFailure({}, "State Flow branch restoration is pending", selection.kind === "current" ? selection.mode
				: selection.kind === "auto-start" ? config.inactiveMode : inactiveSelection(selection.checkpoint.mode));
		}
		if (requestedMode) snapshot = deactivateEpisode(snapshot, requestedMode);
		const pending: BranchRestoration = {
			controller: new AbortController(),
			awaitingAcceptance: selection.kind !== "settled" && selection.kind !== "current",
			...(requestedMode === undefined ? {} : { requestedMode }),
		};
		branchRestoration.claim(pending);
		// attachBranch releases its own ownership; settlement only drains it for shutdown.
		return branchRestoration.track(pending, attachBranch(ctx, pending, selection, sessionStartReason, notifyRecovery, skipped), false);
	}

	async function attachBranch(
		ctx: ExtensionContext, pending: BranchRestoration, selection: BranchSelection,
		reason: unknown, notifyRecovery: boolean, skipped: number,
	): Promise<void> {
		const placeholder = runtime;
		let selected = runtime;
		const owner = ctx.sessionManager.getSessionId();
		const sameSession = sessionIdentity(ctx);
		const signal = AbortSignal.any([pending.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		const isCurrent = () => branchRestoration.owns(pending) && !pending.controller.signal.aborted && !shuttingDown && runtime === selected
			&& sameSession();
		const assertCurrent = () => {
			signal.throwIfAborted();
			if (!isCurrent()) throw new Error("State Flow branch selection changed while awaiting publication");
		};
		let accepted = false;
		// Install accepted memory before native writes; later ancillary failures cannot revert or replay it.
		const accept = (candidate: TemporalRuntime, next: Snapshot, nativeWrites: () => void): void => {
			accepted = true;
			pending.awaitingAcceptance = false;
			runtime = selected = candidate;
			snapshot = next;
			installScopeStates();
			recordPublication();
			let failure: unknown;
			try { nativeWrites(); } catch (error) { failure = error; }
			settleSelection(ctx, reason, notifyRecovery, skipped, true);
			if (failure !== undefined) throw failure;
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
						if (current) runtime = selected = candidate;
						snapshot = current ? deactivateEpisode(current, pending.requestedMode ?? selection.mode)
							: migrationFailure({}, "Current State Flow session memory is unavailable", pending.requestedMode ?? selection.mode);
						installScopeStates();
					} else if (selection.kind === "restore") {
						await candidate.withRestoreTransaction(selection.checkpoint, (restored, publish) => {
							assertCurrent();
							// Canceled preparation or boundary continuation may have no specification. Retain uncompiled native context.
							if (restored.config.mode === "active" && restored.meta.specification === undefined
								&& retainsPhysicalSessionProjection(reason) && hasUncheckpointedConversation(ctx.sessionManager.getBranch())) restored.meta.bootstrap = true;
							const next = pending.requestedMode ? deactivateEpisode(restored, pending.requestedMode) : restored;
							publish(next);
							accept(candidate, next, appendCheckpoint);
						}, signal);
					} else if (selection.kind === "fork") {
						await candidate.withForkTransaction(selection.source, selection.checkpoint, (child, publish) => {
							assertCurrent();
							// Mode is selected independently of creating the child's private memory.
							const next = pending.requestedMode ? deactivateEpisode(child, pending.requestedMode) : child;
							publish(next);
							forkInitialization = false;
							accept(candidate, next, () => {
								pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { reset: true, owner });
								appendCheckpoint();
							});
						}, signal);
					} else {
						await candidate.withStartTransaction((current, publish) => {
							assertCurrent();
							// Truly new branch authority is rechecked after waiting; existing memory needs its own selection.
							const branch = ctx.sessionManager.getBranch();
							const discovery = discoverSnapshotData(branch);
							if (current || discovery.candidates.length > 0 || discovery.errors.length > 0) throw new Error("Existing session runtime requires retained-boundary restoration");
							const activated = startEpisode(hasPriorConversation(branch));
							const next = pending.requestedMode ? deactivateEpisode(activated, pending.requestedMode) : activated;
							publish(next);
							accept(candidate, next, appendCheckpoint);
						}, signal, true);
					}
				} catch (error) {
					if (accepted) {
						if (isCurrent()) notifyProblem(ctx, `State Flow memory restored; lifecycle update failed: ${diagnosticText(error)}`, "warning");
						return;
					}
					if (!isCurrent()) return;
					if (error instanceof HistoryBoundaryExpiredError) selectedHistoryExpired = true;
					snapshot = selectedBoundaryFailure(diagnosticText(error), snapshot.config.mode === "active" ? config.inactiveMode : snapshot.config.mode);
					installScopeStates();
				} finally {
					pending.awaitingAcceptance = false;
				}
				if (accepted) return;
			}
			settleSelection(ctx, reason, notifyRecovery, skipped, selected !== placeholder);
			if (snapshot.config.mode !== "passive" || runtime?.view) return;
			const passive = await loadPassiveView(ctx, signal, isCurrent, notifyRecovery);
			if (passive === undefined) return;
			assertCurrent();
			// An intervening passive patch or inspection owns its newer cache, even on the same physical branch.
			if (runtime?.view) return;
			runtime = selected = passive;
			installScopeStates();
			updateUi(ctx);
		} catch (error) {
			// Host failures before acceptance leave the selection unavailable, never invented empty memory.
			if (accepted || !isCurrent()) return;
			snapshot = selectedBoundaryFailure(diagnosticText(error), snapshot.config.mode === "active" ? config.inactiveMode : snapshot.config.mode);
			installScopeStates();
		} finally {
			pending.awaitingAcceptance = false;
			branchRestoration.release(pending);
		}
	}

	/** Load current shared memory for passive projection without initializing or publishing it. */
	async function loadPassiveView(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean, notify: boolean): Promise<TemporalRuntime | undefined> {
		const passive = createRuntime(ctx);
		try {
			await passive.refreshShared(signal);
		} catch (error) {
			if (isCurrent() && !signal.aborted && notify && !modePersistenceError) notifyProblem(ctx, `State Flow passive memory is unavailable: ${diagnosticText(error)}`, "warning");
			return undefined;
		}
		return passive;
	}

	function selectedContinuation(ctx: ExtensionContext, reason: unknown): PassiveContinuation | undefined {
		if (!retainsPhysicalSessionProjection(reason) || !runtime?.view) return undefined;
		const boundary = findPassiveStopBoundary(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
		return boundary === undefined ? undefined : createPassiveContinuation(
			projectModelState(effectiveState), boundary.at, boundary.from, boundary.preserveContext,
		);
	}

	function settleSelection(ctx: ExtensionContext, reason: unknown, notifyRecovery: boolean, skipped: number, selectedMemory: boolean): void {
		const failure = !isActive() && snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error : undefined;
		if (failure !== undefined && notifyRecovery && !modePersistenceError) {
			if (selectedHistoryExpired) notifyProblem(ctx, "State Flow history is outside the retained temporal window; /state-flow-active can use current session memory.", "warning");
			else notifyProblem(ctx, `State Flow restore failed: ${failure}`, "error");
		}
		const continuation = selectedMemory ? selectedContinuation(ctx, reason) : undefined;
		if (continuation !== undefined) {
			if (!isActive()) passiveContinuation = continuation;
			else if (snapshot.meta.bootstrap) bootstrapContinuation = continuation;
		}
		if (notifyRecovery && isActive() && skipped > 0) {
			notifyProblem(ctx, `State Flow skipped ${skipped} malformed snapshot(s); restored the last valid one.`, "warning");
		}
		if (isActive()) deferInferencePreparation();
		syncStateFlowTools();
		updateUi(ctx);
	}

	function recordDiagnostic(error: string, category: StateFlowDiagnosticCategory, ctx: ExtensionContext, extras: DiagnosticExtras = {}): void {
		diagnosticWriter.record(sessionAddress(ctx).id, ctx.cwd, error, category, extras);
	}

	pi.registerTool({
		name: READ_STATE_TOOL_NAME,
		label: "Read State",
		description: "Read exact State Flow values or historical semantic patches with one path or an ordered path list. Unscoped semantic paths read the effective overlay; effective makes that overlay explicit, while global, cwd, and session select ownership. Array selectors support zero-based indices and half-open [start..end] ranges. Projection value returns semantic data; keys returns minimal structure; patch intersects the selected path at its boundary. Path object keys must be ASCII identifiers ([A-Za-z_$][A-Za-z0-9_$-]*); non-ASCII keys cannot be addressed.",
		promptSnippet: "Read exact state values, structures, or historical semantic patches",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "One semantic path; unscoped paths use effective, explicit roots may use effective/global/cwd/session and historical [N], and arrays support half-open [start..end] ranges" })),
			paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Ordered query paths evaluated as one all-or-error read" })),
			projection: Type.Optional(StringEnum(["value", "keys", "patch"] as const, { description: "Value snapshot by default, structural keys with minimal meta, or the selected historical semantic patch" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal) {
			try {
				type ReadDetails = { path?: string; paths?: string[]; projection?: string; transitionId?: string };
				if (!memoryToolsAvailable()) throw new Error("State Flow tools are off for this session");
				if (signal?.aborted) throw new Error("State Flow read was aborted");
				if (!runtime?.view) throw new Error("State Flow temporal runtime is unavailable");
				if (params.path === undefined && params.paths === undefined) throw new Error("read_state requires path or paths");
				if (params.path !== undefined && params.paths !== undefined) throw new Error("read_state accepts path or paths, not both");
				{
					const paths = params.paths ?? [params.path!];
					if (paths.some((path) => /^session(?:\.|\[|$)/.test(path))) assertSelectedBranchAvailable();
					if (paths.length === 1 && /^(?:global|cwd|session)\.patches(?:\[\d+\])?$/.test(paths[0]!)) {
						if (params.projection !== undefined && params.projection !== "value") throw new Error("Scope patch paths support only the value projection");
						const result = readStatePath(runtime.view, paths[0]!, config.historyLimit);
						if (!("patch" in result)) throw new Error("Expected a scope patch path");
						return {
							content: [{ type: "text", text: `\n${JSON.stringify({ patch: result.patch })}` }],
							details: { path: paths[0], transitionId: result.boundary.id } as ReadDetails,
						};
					}
					const result = readProjectedState(runtime.view, paths, params.projection, config.historyLimit);
					return {
						content: [{ type: "text", text: `\n${JSON.stringify(result)}` }],
						details: { ...(params.path === undefined ? { paths } : { path: params.path }), projection: params.projection ?? "value" } as ReadDetails,
					};
				}
			} catch (error) {
				throw separatedFailure(error);
			}
		},
	});

	pi.registerTool({
		name: PATCH_STATE_TOOL_NAME,
		label: "Patch State",
		description: "The sole State Flow semantic mutation protocol. Supply one or more global, cwd, or session patches; all supplied scopes commit atomically. This call must be the only State Flow barrier in its assistant response. Deleting an intent also deletes same-scope working/lazy keys its {\"$ref\"} values own unless another intent refs them. Name keys in ASCII ([A-Za-z_$][A-Za-z0-9_$-]*) so read paths and refs resolve; values may use any language.",
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
		renderCall(args, theme, context) {
			const title = theme.fg("toolTitle", theme.bold(PATCH_STATE_TOOL_NAME));
			if (!config.showSuccessfulPatches && !context.isError) return new Text(title, 0, 0);
			return new Text(`${title}\n${separatedOutput(theme.fg("dim", formatPatchStateArguments(args)))}`, 0, 0);
		},
		renderResult(result) {
			const text = result.content.find((block) => block.type === "text")?.text ?? "";
			return new Text(separatedOutput(text), 0, 0);
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			signal = signal ? AbortSignal.any([signal, memoryToolLifetime.signal]) : memoryToolLifetime.signal;
			try {
				if (!memoryToolsAvailable()) throw new Error("State Flow tools are off for this session");
				assertPublicationAvailable();
				if (signal?.aborted) throw new Error("State Flow patch was aborted before materialization");
				if (!isObject(params)) throw new Error("patch_state requires an object");
				params = structuredClone(params);
				const allowed = new Set(["global", "cwd", "session"]);
				for (const key of Object.keys(params)) {
					if (!allowed.has(key)) throw new Error(`patch_state does not accept field ${key}`);
				}
				const patches: AtomicScopePatches = {};
				for (const scope of ["global", "cwd", "session"] as const) {
					if (!Object.hasOwn(params, scope)) continue;
					const patch = params[scope];
					if (!isObject(patch)) throw new Error(`patch_state ${scope} must be a semantic patch object`);
					if (Object.keys(patch).length === 0) throw new Error(`patch_state ${scope} cannot be empty; omit it when unchanged`);
					patches[scope] = patch;
				}
				const scopes = Object.keys(patches) as StateScope[];
				if (scopes.length === 0) throw new Error("patch_state requires at least one scope patch");
				const selected = runtime ??= createRuntime(ctx);
				const acquiredArtifacts = structuredClone([...artifactReads.successful.values()]);
				const acquiredSkills = structuredClone([...skillReads.successful.values()]);
				const previousEffective = effectiveState;
				return await selected.withPatchTransaction((transaction) => {
					if (runtime !== selected) throw new Error("State Flow session selection changed while awaiting publication");
					if (!memoryToolsAvailable()) throw new Error("State Flow tools are off for this session");
					assertPublicationAvailable();
					for (const acquired of acquiredArtifacts) {
						const observation = inspectRegisteredArtifactPaths([acquired.path])[0];
						if (acquired.sourceFingerprint === undefined || observation?.kind !== "present"
							|| !sameArtifactSourceFingerprint(acquired.sourceFingerprint, observation.fingerprint)) {
							throw new Error(`Artifact source changed after acquisition: ${acquired.path}`);
						}
					}
					const stage = stageAtomicScopePatches(transaction.states, patches, acquiredSkills, transaction.causalBasis, acquiredArtifacts);
					const changed = (["global", "cwd", "session"] as const).some((scope) =>
						!sameJson(transaction.states[scope], stage.nextStates[scope])
						|| Object.entries(stage.provenanceUpdates[scope]).some(([path, evidence]) =>
							!Object.hasOwn(transaction.provenance[scope], path) || !sameJson(transaction.provenance[scope][path], evidence)));
					const nextSnapshot = structuredClone(snapshot);
					let publication: RuntimePublication | undefined;
					commitScopedTransition(nextSnapshot, transaction.states, stage, (accepted, next) => {
						publication = transaction.publish(next, accepted, stage.provenanceUpdates);
					}, transaction.causalBasis, { finalizeRun: false });
					snapshot = nextSnapshot;
					installScopeStates();
					if (publication?.changed) {
						recordPublication();
						appendCheckpoint();
					}
					clearAcceptedAcquisitions(new Set(acquiredArtifacts.map(({ path }) => path)));
					updateUi(ctx);
					const updates = contextProjection.acceptPatch(previousEffective, effectiveState, patches, acquisition.hints, stage.cascades);
					const acknowledgement = changed
						? `\nState materialized atomically at ${scopes.join("+")} scope${scopes.length === 1 ? "" : "s"}.`
						: "\nState already current.";
					return { content: [
						{ type: "text" as const, text: acknowledgement },
						...(updates ? [{ type: "text" as const, text: `\n${presentationJson({ state_updates: updates })}` }] : []),
					], details: { scopes, step: snapshot.meta.step, changed } };
				}, signal);
			} catch (error) {
				let attempted: unknown;
				try { attempted = structuredClone(params); } catch { attempted = undefined; }
				const cause = diagnosticText(error);
				if (!signal.aborted && memoryToolsAvailable()) recordDiagnostic(cause, /concurrently|advanced/.test(cause) ? "publication-conflict" : "invalid-patch", ctx, {
					input: attempted,
					tool: PATCH_STATE_TOOL_NAME,
					toolCallId,
				});
				throw separatedFailure(error);
			}
		},
	});

	function startStateFlow(ctx: ExtensionContext): Promise<StateFlowTelegramControlResult> {
		if (shuttingDown) return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
		if (startActivation.current?.operation) return startActivation.current.operation;
		telegramStartPending = false;
		if (activeContext && !branchRestoration.current && isActive()) {
			return Promise.resolve({ ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal });
		}
		const pending = startActivation.claim({ controller: new AbortController() });
		return startActivation.track(pending, runStart(ctx, pending.controller));
	}

	/** Await restoration-owned attachment and exact-source fork recovery before current-head activation. */
	async function runStart(ctx: ExtensionContext, pending: AbortController): Promise<StateFlowTelegramControlResult> {
		const sameSession = sessionIdentity(ctx);
		const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
		const isOwner = () => startActivation.current?.controller === pending && !signal.aborted && !shuttingDown && sameSession();
		const superseded = (): StateFlowTelegramControlResult => {
			pending.abort();
			return { ok: false, message: "State Flow activation was superseded", signal: pending.signal };
		};
		try {
			if (deferredBranch?.reason === "fork") await waitForRecovery(restoreActiveBranch(ctx, "fork", false, pending), signal);
			else if (!activeContext) await waitForRecovery(restoreActiveBranch(ctx, undefined, false, pending), signal);
			else if (branchRestoration.current?.operation) await waitForRecovery(branchRestoration.current.operation, signal);
			if (!isOwner()) return superseded();
			if (isActive()) return { ok: true, message: "State Flow is already active", signal: sharedInspectionLifetime.signal };
			if (forkInitialization) {
				// Withdraw this join on cancellation without revoking the independently owned mode persistence.
				const stopping = inactivePersistence.current?.operation;
				if (stopping) await waitForRecovery(stopping, signal);
				if (!isOwner()) return superseded();
				await waitForRecovery(restoreActiveBranch(ctx, "fork", false, pending), signal);
				if (!isOwner()) return superseded();
				assertSelectedBranchAvailable();
			}
			return activateCurrentState(ctx, pending);
		} catch (error) {
			if (!isOwner()) return superseded();
			const message = conciseDiagnostic(`State Flow activation failed: ${diagnosticText(error)}`);
			notifyProblem(ctx, message, "error");
			return { ok: false, message, signal: AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]) };
		}
	}

	async function activateCurrentState(ctx: ExtensionContext, pending: AbortController): Promise<StateFlowTelegramControlResult> {
		let selected = runtime;
		const owner = ctx.sessionManager.getSessionId();
		const sameSession = sessionIdentity(ctx);
		const initiallyActive = isActive();
		let accepted = false;
		let receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
		const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
		const isCurrent = () => startActivation.current?.controller === pending && !signal.aborted && runtime === selected && !shuttingDown
			&& sameSession() && isActive() === (accepted || initiallyActive);
		const superseded = (): StateFlowTelegramControlResult => {
			pending.abort();
			return { ok: false, message: "State Flow activation was superseded", signal: pending.signal };
		};
		try {
			const activation = createRuntime(ctx);
			const deferred = deferredBranch;
			if (deferred) {
				const discovery = discoverSnapshotData(ctx.sessionManager.getBranch());
				const retained = selectRetainedCheckpoint(discovery.candidates, config.inactiveMode);
				branchStartsWithoutRuntime = retained.kind === "pre-runtime" || (discovery.candidates.length === 0 && discovery.errors.length === 0);
			}
			// Off activation owns one cancellable current-head publication, not an independent read-only restore.
			const result = await activation.withStartTransaction((current, publish) => {
				signal.throwIfAborted();
				if (!isCurrent()) throw new Error("State Flow activation selection changed while awaiting publication");
				if (!current && !branchStartsWithoutRuntime) throw new Error(snapshot.meta.validation?.error ?? "Current State Flow session memory is unavailable");
				const boundary = deferred && retainsPhysicalSessionProjection(deferred.reason)
					? findPassiveStopBoundary(ctx.sessionManager.getBranch(), owner, PASSIVE_STOP_ENTRY_TYPE) : undefined;
				const bootstrap = hasPriorConversation(ctx.sessionManager.getBranch()) || passiveContinuation !== undefined || boundary !== undefined;
				const activated = current ? resumeEpisode(current, bootstrap) : startEpisode(bootstrap);
				const recoveredCurrent = selectedHistoryExpired;
				publish(activated);
				accepted = true;
				inactivePersistence.cancel();
				runtime = selected = activation;
				snapshot = activated;
				activeContext = ctx;
				selectedHistoryExpired = false;
				modePersistenceError = undefined;
				installScopeStates();
				const continuation = passiveContinuation ?? bootstrapContinuation ?? (deferred ? selectedContinuation(ctx, deferred.reason) : undefined);
				deferredBranch = undefined;
				clearRunTransient();
				contextProjection.reset();
				passiveContinuation = undefined;
				bootstrapContinuation = snapshot.meta.bootstrap ? continuation : undefined;
				deferInferencePreparation();
				receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
				recordPublication();
				syncStateFlowTools();
				updateUi(ctx);
				if (forkInitialization) {
					forkInitialization = false;
					pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { reset: true, owner });
				}
				appendCheckpoint();
				ctx.ui.notify(
					recoveredCurrent
						? "State Flow active from current session memory; unavailable historical state was not restored."
						: snapshot.meta.bootstrap
							? "State Flow active. The next complete agent run will migrate active context into state."
							: "State Flow active. The next prompt starts a stateful agent run.",
					"info",
				);
				return { ok: true, message: "State Flow active", signal: receipt };
			}, signal, branchStartsWithoutRuntime);
			return isCurrent() ? result : superseded();
		} catch (error) {
			if (!isCurrent()) return superseded();
			const message = conciseDiagnostic(`${accepted ? "State Flow active; lifecycle update failed" : "State Flow activation failed"}: ${diagnosticText(error)}`);
			notifyProblem(ctx, message, accepted ? "warning" : "error");
			return { ok: accepted, message, signal: receipt };
		}
	}

	const MODE_COMMAND_DESCRIPTIONS: Record<StateFlowMode, string> = {
		active: "Make State Flow active on the current session branch",
		passive: "Use passive State Flow memory on the current session branch",
		off: "Turn State Flow tools and context off on the current session branch",
	};

	/** Terminal commands and Telegram controls share these lifecycle owners. */
	function selectMode(ctx: ExtensionContext, mode: StateFlowMode): Promise<StateFlowTelegramControlResult> {
		return mode === "active" ? startStateFlow(ctx) : deactivateStateFlow(ctx, mode);
	}

	for (const mode of ["active", "passive", "off"] as const) {
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
	function applyInactiveMode(ctx: ExtensionContext, mode: InactiveMode): void {
		snapshot = deactivateEpisode(snapshot, mode);
		clearRunTransient();
		syncStateFlowTools();
		updateUi(ctx);
	}

	function deactivateStateFlow(ctx: ExtensionContext, mode: InactiveMode): Promise<StateFlowTelegramControlResult> {
		if (shuttingDown) return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
		if (mode === "off") return selectOff(ctx);
		startActivation.cancel();
		telegramStartPending = false;
		const persisting = inactivePersistence.current;
		if (persisting?.operation && !persisting.published) {
			// Pending inactive choices coalesce: acceptance persists whichever inactive mode is current then.
			if (snapshot.config.mode !== mode) applyInactiveMode(ctx, mode);
			return persisting.operation;
		}
		if (!activeContext) void restoreActiveBranch(ctx, undefined, false);
		const restoring = branchRestoration.current;
		// Read-only recovery also retains the latest policy; its native write fence is updated below.
		if (restoring) restoring.requestedMode = mode;
		if (restoring?.awaitingAcceptance) {
			// Passive keeps independently owned restoration; Off withdraws it through selectOff.
			applyInactiveMode(ctx, mode);
			return Promise.resolve({ ok: true, message: `State Flow ${mode}; memory restoration continues` });
		}
		if (snapshot.config.mode === mode) {
			const retained = selectRetainedCheckpoint(discoverSnapshotData(ctx.sessionManager.getBranch()).candidates, config.inactiveMode);
			const recordedMode = retained.kind === "pre-runtime" ? retained.mode : retained.kind === "boundary" ? retained.checkpoint.mode : undefined;
			if (modePersistenceError || recordedMode === mode) return Promise.resolve({ ok: true, message: `State Flow is already ${mode}` });
		}
		inactivePersistence.cancel();
		const pending = inactivePersistence.claim({ controller: new AbortController() });
		return inactivePersistence.track(pending, deferredBranch && mode === "passive" && !branchStartsWithoutRuntime
			? acquirePassiveMode(ctx, pending, deferredBranch.reason)
			: persistInactiveMode(ctx, pending, mode));
	}

	/** Off owns cancellation and native policy only; no canonical transaction or semantic handoff. */
	function selectOff(ctx: ExtensionContext): Promise<StateFlowTelegramControlResult> {
		const address = sessionAddress(ctx);
		const owner = ctx.sessionManager.getSessionId();
		const branch = ctx.sessionManager.getBranch();
		const selected = runtime;
		const sameOwner = selected?.sessionKey === address.key && selected.cwd === ctx.cwd;
		const forkRecorded = hasPendingFork(branch, owner, PASSIVE_STOP_ENTRY_TYPE);
		const pendingFork = forkRecorded || (sameOwner && forkInitialization) || (deferredBranch?.owner === address.key && deferredBranch.cwd === ctx.cwd && deferredBranch.reason === "fork");
		const policy = findBranchPolicy(branch, owner, PASSIVE_STOP_ENTRY_TYPE, config.inactiveMode);
		const sameDeferred = deferredBranch?.owner === address.key && deferredBranch.cwd === ctx.cwd;
		const current = sameOwner || sameDeferred ? snapshot : emptySnapshot("off");
		if (!sameOwner && !sameDeferred) modePersistenceError = policy?.persistenceError;
		const alreadyOff = current.config.mode === "off" && policy?.mode === "off";
		const incoming = sameOwner || sameDeferred ? current.meta.bootstrap ? bootstrapContinuation : passiveContinuation : undefined;
		const unfinished = current.meta.specification !== undefined || (inferencePreparation.current?.prompt !== undefined && !inferencePreparation.current.accepted)
			|| (isActive() && hasUncheckpointedConversation(branch));
		const at = incoming?.startedAt ?? Date.now();
		const from = incoming ? incoming.activeRunStartedAt : (sameOwner || sameDeferred) && (!ctx.isIdle() || unfinished) ? runAnchorTimestamp : undefined;
		const preserveContext = modePersistenceError !== undefined || (incoming ? incoming.preserveContext : current.meta.bootstrap === true || (unfinished && from === undefined));
		const discovery = discoverSnapshotData(branch);
		const preRuntime = (sameOwner && branchStartsWithoutRuntime) || (discovery.candidates.length === 0 && discovery.errors.length === 0);
		let checkpoint: RetainedPiCheckpoint | undefined;
		try {
			checkpoint = !modePersistenceError && current.meta.validation?.attempt !== 0
				? preRuntime ? preRuntimeCheckpoint("off") : sameOwner && selected?.view ? selected.retainedCheckpoint(deactivateEpisode(current, "off")) : undefined
				: undefined;
		} catch {
			// An unusable cached bookmark cannot prevent native Off policy or authorize replacement memory.
		}
		startActivation.cancel();
		branchRestoration.cancel();
		inactivePersistence.cancel();
		backup.cancel();
		memoryToolLifetime.renew();
		clearRunTransient();
		contextProjection.reset();
		telegramStartPending = false;
		bootstrapContinuation = undefined;
		passiveContinuation = undefined;
		acquisition.reset();
		runtime = undefined;
		snapshot = emptySnapshot("off");
		selectedHistoryExpired = false;
		branchStartsWithoutRuntime = preRuntime;
		forkInitialization = pendingFork;
		deferredBranch = { owner: address.key, cwd: ctx.cwd, reason: pendingFork ? "fork" : undefined };
		activeContext = ctx;
		installScopeStates();
		syncStateFlowTools();
		updateUi(ctx);
		try {
			if (!alreadyOff || (pendingFork && !forkRecorded)) {
				if (!checkpoint || !preRuntime || pendingFork || preserveContext || from !== undefined || modePersistenceError) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
					owner, at, mode: "off", memoryDeferred: true,
					...(from === undefined ? {} : { from }),
					...(preserveContext ? { preserveContext: true } : {}),
					...(pendingFork ? { forkPending: true } : {}),
					...(modePersistenceError === undefined ? {} : { persistenceError: modePersistenceError }),
				});
				if (checkpoint) pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
			}
			return Promise.resolve({ ok: true, message: alreadyOff ? "State Flow is already off" : "State Flow off" });
		} catch (error) {
			const message = conciseDiagnostic(`State Flow off; native mode recording failed: ${diagnosticText(error)}`);
			notifyProblem(ctx, message, "error");
			return Promise.resolve({ ok: false, message });
		}
	}

	async function acquirePassiveMode(ctx: ExtensionContext, pending: InactivePersistence, reason: unknown): Promise<StateFlowTelegramControlResult> {
		await restoreActiveBranch(ctx, reason, true, pending.controller, "passive");
		if (!inactivePersistence.owns(pending) || pending.controller.signal.aborted || shuttingDown) {
			return { ok: false, message: "State Flow mode change was superseded" };
		}
		return persistInactiveMode(ctx, pending, "passive");
	}

	async function persistInactiveMode(ctx: ExtensionContext, pending: InactivePersistence, mode: InactiveMode): Promise<StateFlowTelegramControlResult> {
		let selected = runtime;
		const owner = ctx.sessionManager.getSessionId();
		const current = snapshot;
		const wasActive = current.config.mode === "active";
		let unfinished = current.meta.specification !== undefined
			|| (inferencePreparation.current?.prompt !== undefined && !inferencePreparation.current.accepted);
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
		const isCurrent = () => inactivePersistence.owns(pending) && runtime === selected
			&& !shuttingDown && ctx.sessionManager.getSessionId() === owner && !isActive();
		const superseded = (): StateFlowTelegramControlResult => ({ ok: false, message: "State Flow mode change was superseded" });
		const freezeHandoff = (): PassiveContinuation | undefined => {
			contextProjection.reset();
			const handoff = (wasActive || modePersistenceError) && selected?.view && current.meta.validation?.attempt !== 0
				? createPassiveContinuation(
					projectModelState(effectiveState),
					incomingBoundary?.startedAt ?? stoppedAt,
					incomingBoundary ? incomingBoundary.activeRunStartedAt : !idle || unfinished ? anchor : undefined,
					modePersistenceError !== undefined || (incomingBoundary ? incomingBoundary.preserveContext : current.meta.bootstrap === true || (unfinished && anchor === undefined)),
				)
				: undefined;
			// Repeated Passive choices keep the already selected continuation boundary.
			passiveContinuation = handoff ?? (!wasActive ? passiveContinuation : undefined);
			return handoff;
		};
		const complete = (): StateFlowTelegramControlResult => {
			pending.published = true;
			const exitHandoff = freezeHandoff();
			const selectedMode = snapshot.config.mode;
			if (exitHandoff || modePersistenceError) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
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
			acquisition.clearInvalidations();
			assertPublicationAvailable();
			const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
			if (branchStartsWithoutRuntime || !selected?.view) {
				// A pre-runtime choice is native-only; Passive then loads shared memory without initializing storage.
				const result = complete();
				if (snapshot.config.mode !== "passive" || runtime?.view) return result;
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
				if (!isCurrent()) throw new Error("State Flow mode selection changed while awaiting publication");
				assertPublicationAvailable();
				const next = structuredClone(snapshot);
				publish(next);
				accepted = true;
				snapshot = next;
				installScopeStates();
				recordPublication();
				return complete();
			}, signal);
			return isCurrent() ? result : superseded();
		} catch (error) {
			if (!isCurrent()) return superseded();
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
				step: snapshot.meta.step,
				revisions: scopeRevisions(),
				bootstrap: snapshot.meta.bootstrap === true,
				startPending: telegramStartPending,
			}),
			inspect: inspectTelegramState,
			canStartNow: () => activeContext === undefined || activeContext.isIdle(),
			select: async (mode) => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				const operation = selectMode(activeContext, mode);
				if (mode === "active") return operation;
				// Inactive choices revoke older presentation at once; the receipt belongs to the new lifetime.
				const signal = sharedInspectionLifetime.signal;
				try {
					return { ...await operation, signal };
				} catch (error) {
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

	pi.on("before_agent_start", (event) => {
		// Native run identity is independent of semantic enablement and survives mode toggles.
		runAnchorTimestamp = undefined;
		if (!isActive()) {
			if (!passiveMemoryAvailable()) return;
			(event.systemPromptOptions.sections ??= {}).state_flow = PASSIVE_MEMORY_PROTOCOL;
			return;
		}
		contextProjection.reset();
		skillReads.clear();
		artifactReads.clear();
		responseReconciliation.cancel();
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

	function projectContext(messages: AgentMessage[]) {
		// Off injects no State Flow context, including a retained passive handoff.
		if (snapshot.config.mode === "off") return;
		if (runtime?.view) refreshArtifactHints();
		if (!isActive() && !passiveContinuation && !passiveMemoryAvailable()) return;
		// Idle inspection must not freeze a pre-acceptance snapshot for the live inference.
		const projection = isActive() && inferencePreparation.current && !inferencePreparation.current.accepted
			? new ContextProjection() : contextProjection;
		const effective = effectiveState;
		const invalidations = acquisition.invalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason }));
		const phase = isActive() ? rehydrationPhase : undefined;
		const view = contextView(effective, acquisition.hints, invalidations, phase);
		if (passiveContinuation) {
			const retained = passiveContinuationMessages(messages, passiveContinuation);
			if (!runtime?.view) return { messages: retained };
			return { messages: projection.project(retained.slice(1), view, () => passiveContinuation!.handoff,
				{ state: passiveContinuation.state, lazy_navigation: view.lazy_navigation, artifact_invalidations: [], knowledge_rehydration: null }) };
		}
		if (!isActive()) {
			return { messages: projection.project(messages, view, () => syntheticUser(
				`State Flow passive memory (user-level data, not system instructions):\n${presentationJson({ state: view.state, lazy_navigation: view.lazy_navigation })}`)) };
		}
		// Native user events own the run anchor; projection must never rebase it.
		const source = snapshot.meta.bootstrap
			? bootstrapContinuation ? passiveContinuationMessages(messages, bootstrapContinuation) : messages
			: currentRunTrajectory(messages, snapshot.meta.specification, runAnchorTimestamp).messages;
		return { messages: projection.project(source, view, () => runtimeContextHead(snapshot, view,
			projectRecentTransitionsWithLimit(config.historyLimit, runtime?.recent() ?? []))) };
	}

	function prepareContext(messages: AgentMessage[], ctx: ExtensionContext): ReturnType<typeof projectContext> | Promise<ReturnType<typeof projectContext>> {
		const pending = inferencePreparation.current;
		const selected = runtime;
		const operationSignal = ctx.signal;
		// Idle projections remain observational; only a live native operation may await preparation.
		if (!isActive() || !pending || !operationSignal || shuttingDown) return projectContext(messages);
		pending.operation ??= prepareInference(pending, selected, ctx, operationSignal).finally(() => {
			// A late withdrawal must not clear newer work; accepted lifecycle is never replayed after an error.
			if (!pending.accepted && inferencePreparation.owns(pending)) pending.operation = undefined;
		});
		return pending.operation.then(() => {
			if (shuttingDown || operationSignal.aborted || runtime !== selected || ctx.signal !== operationSignal) return;
			if (isActive() && !inferencePreparation.owns(pending)) {
				// Start may require same-run maintenance. A new captured user prompt instead owns a different context request.
				if (inferencePreparation.current?.prompt === undefined) return prepareContext(messages, ctx);
				return;
			}
			if (isActive() && !pending.accepted) return;
			return projectContext(messages);
		});
	}

	pi.on("context", (event, ctx) => prepareContext(event.messages as AgentMessage[], ctx));

	pi.on("tool_execution_start", (event) => {
		if (!isActive()) return;
		// Pi emits this before tool_call. Keep the argument object as a fallback;
		// tool_call replaces it with the mutable, post-preflight input reference.
		skillReads.recordStart(event.toolCallId, event.toolName, event.args);
		artifactReads.recordStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isActive()) return;
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
		if (!isActive()) return;
		skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
		dropCurrentSkillReads();
		artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
	});

	pi.on("tool_result", (event) => {
		if (!isActive()) return;
		const read = skillReads.recordResult(event.toolName, event.input, event.isError);
		if (!read) return;
		dropCurrentSkillReads();
		const hint = skillAcquisitionHint(read);
		if (!hint) return;
		return { content: [...event.content, { type: "text", text: `\n${hint}` }] };
	});

	pi.on("message_end", (event, ctx): any => {
		// Observe actual user events even while disabled; Start/Stop cannot invent or erase them.
		if (event.message.role === "user" && runAnchorTimestamp === undefined) runAnchorTimestamp = event.message.timestamp;
		if (shuttingDown || !isActive()) return;
		if (event.message.role !== "assistant") return;
		responseReconciliation.cancel();
		const message = event.message as unknown as { role: "assistant"; stopReason?: string; content?: unknown };
		if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse") return;
		if (message.stopReason === "length" || message.stopReason === "error") {
			recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content });
			return;
		}
		responseReconciliation.claim({ controller: new AbortController() });
	});

	pi.on("turn_end", async (event, ctx) => {
		if (shuttingDown) return;
		const pending = responseReconciliation.current;
		if (!isActive() || !pending) {
			updateUi(ctx);
			return;
		}
		const selected = runtime;
		const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
		let responseCommitted = false;
		try {
			const response = finalizedAssistantResponse(event.message);
			if (!selected?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			await selected.withPatchTransaction((transaction) => {
				signal.throwIfAborted();
				if (runtime !== selected || !responseReconciliation.owns(pending) || !isActive()) {
					throw new Error("State Flow response selection changed while awaiting publication");
				}
				assertPublicationAvailable();
				const wasBootstrap = snapshot.meta.bootstrap === true;
				const nextSnapshot = structuredClone(snapshot);
				const stage = stageScopedTransition(transaction.states, { transitions: [], response }, [], transaction.causalBasis);
				completeRun(nextSnapshot);
				let publication: RuntimePublication | undefined;
				commitScopedTransition(nextSnapshot, transaction.states, stage, (accepted, next) => {
					publication = transaction.publish(next, accepted);
				}, transaction.causalBasis, { finalizeRun: true });
				snapshot = nextSnapshot;
				installScopeStates();
				responseCommitted = true;
				contextProjection.reset();
				if (publication?.changed) recordPublication();
				appendCheckpoint();
				clearAcceptedAcquisitions();
				bootstrapContinuation = undefined;
				rehydrationPhase = "step";
				completedRunAccepted = !wasBootstrap;
				backup.markTurnAccepted();
				updateUi(ctx);
			}, signal);
		} catch (error) {
			// Superseded completion owns neither the new lifecycle nor its diagnostics/UI.
			if (signal.aborted || runtime !== selected || !responseReconciliation.owns(pending)) return;
			const cause = diagnosticText(error);
			recordDiagnostic(cause, "finalization", ctx);
			notifyProblem(ctx, responseCommitted
				? `State Flow response saved; lifecycle update failed: ${cause}`
				: `State Flow response reconciliation failed: ${cause}`, "error");
		} finally {
			responseReconciliation.release(pending);
		}
	});

	pi.on("session_before_compact", (event) => {
		const result = compactionRequests.resolve(event, !shuttingDown && isActive());
		if (result === undefined || "cancel" in result) return result;
		return { compaction: result };
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		if (shuttingDown || !memoryToolsAvailable() || !backup.takeSettledTurn()) return;
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
				if (signal.aborted || snapshot.config.mode === "off") return;
				startStateFlowBackupPush(repositoryRoot, (error) => {
					if (shuttingDown || lifetime.aborted || snapshot.config.mode === "off") return;
					const message = diagnosticText(error);
					const recorded = diagnosticWriter.recordBackupPushFailure(pushSessionId, pushCwd, message);
					if (!backup.claimPushFailureNotice()) return;
					notifyActiveContext(recorded
						? `State Flow Git backup push failed; state is saved locally. Details: ${stateFlowLogPath(agentDir)}. A later accepted turn retries.`
						: `State Flow Git backup push failed; local diagnostics unavailable: ${message}`);
				}, () => backup.resetPushFailureNotice(), lifetime);
			}
		} catch (error) {
			if (signal.aborted || runtime !== selected) return;
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
			|| compactionRequests.inFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !runtime?.view
			|| !shouldRequestStateFlowCompaction(ctx.getContextUsage())) return;
		completedRunAccepted = false;
		const entries = ctx.sessionManager.buildContextEntries();
		if (!hasCompactionSizedTranscript(entries)) return;
		const plan = planStateFlowCompaction(entries, runtime.causalBasis(), snapshot.meta.step, runAnchorTimestamp);
		if (!plan) return;
		const marker = compactionRequests.begin(plan);
		// Pi dispatches deferred companion prompts after all settled handlers return.
		await new Promise<void>((resolve) => {
			const finished = () => {
				compactionRequests.finish(marker);
				resolve();
			};
			ctx.compact({ customInstructions: marker, onComplete: finished, onError: finished });
		});
	});

	pi.on("session_compact", () => { contextProjection.reset(); });

	pi.on("session_start", async (event, ctx) => {
		runAnchorTimestamp = undefined;
		rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
		await restoreActiveBranch(ctx, event.reason);
		if (!shuttingDown) void telegram.ensure();
	});
	pi.on("session_tree", async (_event, ctx) => {
		runAnchorTimestamp = undefined;
		await restoreActiveBranch(ctx);
	});
	pi.on("session_shutdown", async (_event, _ctx) => {
		shuttingDown = true;
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
