import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ArtifactReadTracker } from "./acquisition.ts";
import {
  classifyArtifactCompilationNeed,
  inspectRegisteredArtifactPaths,
  ORDINARY_ARTIFACT_COMPILER,
  sameArtifactSourceFingerprint,
  type ArtifactInvalidationRequest,
} from "./artifact.ts";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, stateFlowCompactionResult, type StateFlowCompactionPlan } from "./compaction.ts";
import { loadStateFlowConfig } from "./config.ts";
import { ContextProjection, contextView, createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, projectSystemProtocol, runtimeContextHead, syntheticUser, type PassiveContinuation } from "./context.ts";
import { readNativeSessionHeader } from "./continuation.ts";
import {
  cwdScopeKey,
  resolveSessionAddress,
  sessionScopeKey,
  type SessionAddress,
} from "./durable.ts";
import { completeRun, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "./episode.ts";
import { awaitInFlightBackupPushes, backupCurrentStateFlowFiles, startStateFlowBackupPush } from "./git.ts";
import { projectRecentTransitionsWithLimit } from "./history.ts";
import { isObject, presentationJson, sameJson, type JsonObject } from "./json.ts";
import { StateFlowDiagnosticWriter, stateFlowLogPath, type DiagnosticExtras, type StateFlowDiagnosticCategory } from "./logging.ts";
import { assistantToolCallCount, conciseDiagnostic, diagnosticText, finalizedAssistantResponse, formatPatchStateArguments, PASSIVE_MEMORY_PROTOCOL, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.ts";
import { readProjectedState, readStatePath } from "./query.ts";
import { selectedBoundaryFailure, selectRetainedCheckpoint, waitForRecovery } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { discoverSnapshotData, findAssistantToolBatch, findPassiveStopBoundary, hasPriorConversation, hasUncheckpointedConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { hasCompiledSkillArtifact, hashSkillSource, registeredSkillResolver, SkillReadTracker, type SuccessfulSkillRead } from "./skills.ts";
import { HistoryBoundaryExpiredError, emptySnapshot, migrationFailure, type RetainedBoundaryCheckpoint, type Snapshot } from "./snapshot.ts";
import { emptyState, overlayStates, projectStateForModel, type AtomicScopePatches, type MaterializedState, type ModelState, type ScopedStates, type StateScope } from "./state.ts";
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
	/** Test/SDK capability override; repository config remains the Pi default. */
	passive?: { bootstrap?: boolean; tools?: boolean };
}

export { formatPatchStateArguments };

export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";

interface InferencePreparation {
	readonly controller: AbortController;
	readonly prompt?: string;
	accepted?: boolean;
	operation?: Promise<void>;
}

interface BranchRestoration {
	readonly controller: AbortController;
	/** Memory acceptance is independent of the requested active/passive policy. */
	awaitingAcceptance: boolean;
	passiveRequested?: boolean;
	operation?: Promise<void>;
}

type BranchSelection =
	| { kind: "settled" }
	| { kind: "current" }
	| { kind: "restore"; checkpoint: RetainedBoundaryCheckpoint }
	| { kind: "fork"; checkpoint: RetainedBoundaryCheckpoint; source: SessionAddress }
	| { kind: "auto-start" };

export default function stateFlowExtension(pi: ExtensionAPI, options: StateFlowExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const loadedConfig = loadStateFlowConfig(agentDir, options.repositoryRoot);
	const config = {
		...loadedConfig,
		passiveBootstrap: options.passive?.bootstrap ?? loadedConfig.passiveBootstrap,
		passiveTools: options.passive?.tools ?? loadedConfig.passiveTools,
	};
	let snapshot: Snapshot = emptySnapshot();
	let scopeStates: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let branchStartsWithoutRuntime = false;
	let selectedHistoryExpired = false;
	let stopPersistenceError: string | undefined;
	let stopPersistence: { controller: AbortController; operation?: Promise<StateFlowTelegramControlResult> } | undefined;
	let startActivation: { controller: AbortController; operation?: Promise<StateFlowTelegramControlResult> } | undefined;
	let forkInitialization = false;
	let branchRestoration: BranchRestoration | undefined;
	const restorationOperations = new Set<Promise<void>>();
	let responseReconciliation: AbortController | undefined;
	let sharedInspectionLifetime = new AbortController();
	let completedRunAccepted = false;
	let turnAcceptedForBackup = false;
	let compactionPlan: StateFlowCompactionPlan | undefined;
	let compactionInFlight = false;
	let compactionStopped = false;
	const compactionMarker = `state-flow-boundary:${randomUUID()}`;
	let passiveContinuation: PassiveContinuation | undefined;
	let bootstrapContinuation: PassiveContinuation | undefined;
	const contextProjection = new ContextProjection();
	let inferencePreparation: InferencePreparation | undefined;
	let runAnchorTimestamp: number | undefined;
	let runtime: TemporalRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let rehydrationPhase: RehydrationPhase | undefined;
	const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
	const diagnosticWriter = new StateFlowDiagnosticWriter(config.logging, stateFlowLogPath(agentDir), repositoryRoot, (message) => notifyActiveContext(message));
	let backupPending = false;
	const backupLifetime = new AbortController();
	const backupOperations = new Set<Promise<string | undefined>>();
	let shuttingDown = false;
	let pushFailureNotified = false;
	const skillReads = new SkillReadTracker(hashSkillSource, (path) => activeContext
		? registeredSkillResolver(activeContext.cwd, pi.getCommands())(path)
		: undefined);
	const artifactReads = new ArtifactReadTracker();
	let artifactInvalidations: ArtifactInvalidationRequest[] = [];
	let artifactHints: Record<string, string> = {};
	const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";
	let telegramStartPending = false;

	function sessionAddress(ctx: ExtensionContext): SessionAddress {
		return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
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

	function projectModelState(state: MaterializedState): ModelState {
		return projectStateForModel(state, artifactHints);
	}

	function assertSelectedBranchAvailable(): void {
		if (snapshot.meta.validation?.attempt === 0) {
			throw new Error(`State Flow selected branch is unavailable: ${snapshot.meta.validation.error}`);
		}
	}

	options.onRuntime?.({ read: (offset, scope) => {
		if (scope === "session") assertSelectedBranchAvailable();
		if (!runtime) throw new Error("State Flow temporal runtime is unavailable");
		return projectModelState(runtime.read(offset, scope));
	} });

	function assertPublicationAvailable(): void {
		assertSelectedBranchAvailable();
		if (stopPersistenceError) throw new Error(`Memory writes paused after Stop: ${stopPersistenceError}; use /state-flow-start`);
	}

	function appendCheckpoint(): void {
		const checkpoint = branchStartsWithoutRuntime ? { disabled: true } : runtime?.retainedCheckpoint(snapshot) ?? { disabled: true };
		if ("disabled" in checkpoint && !branchStartsWithoutRuntime) {
			throw new Error("State Flow cannot checkpoint an unproven branch as ordinary disabled; restore a valid checkpoint first");
		}
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

	function cancelStopPersistence(): Promise<StateFlowTelegramControlResult> | undefined {
		const pending = stopPersistence;
		pending?.controller.abort();
		stopPersistence = undefined;
		return pending?.operation;
	}

	function cancelStartActivation(): Promise<StateFlowTelegramControlResult> | undefined {
		const pending = startActivation;
		pending?.controller.abort();
		startActivation = undefined;
		return pending?.operation;
	}

	function cancelBranchRestoration(): Promise<void> | undefined {
		const pending = branchRestoration;
		pending?.controller.abort();
		branchRestoration = undefined;
		return pending?.operation;
	}

	function cancelResponseReconciliation(): void {
		responseReconciliation?.abort();
		responseReconciliation = undefined;
	}

	function cancelSharedInspections(): void {
		sharedInspectionLifetime.abort(new Error("State Flow inspection was cancelled; select the scope again"));
		sharedInspectionLifetime = new AbortController();
	}

	function cancelInferencePreparation(): void {
		inferencePreparation?.controller.abort();
		inferencePreparation = undefined;
	}

	function clearRunTransient(): void {
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

	function deferInferencePreparation(prompt?: string): void {
		cancelInferencePreparation();
		inferencePreparation = { controller: new AbortController(), prompt };
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
	}

	function refreshArtifactHints(): void {
		if (!runtime?.view) {
			artifactHints = {};
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			return;
		}
		const paths = new Set<string>();
		for (const scope of ["global", "cwd", "session"] as const) for (const path of Object.keys(scopeStates[scope].artifacts)) paths.add(path);
		const observations = new Map(inspectRegisteredArtifactPaths(paths).map((observation) => [observation.path, observation]));
		const nextHints: Record<string, string> = {};
		const nextInvalidations = new Map<string, ArtifactInvalidationRequest>();
		for (const scope of ["global", "cwd", "session"] as const) {
			const provenance = runtime.artifactProvenance(scope);
			for (const [path, metadata] of Object.entries(scopeStates[scope].artifacts)) {
				delete nextHints[path];
				nextInvalidations.delete(path);
				if (metadata.kind === "skill") continue;
				const observed = observations.get(path);
				if (observed?.kind !== "present") continue;
				const need = classifyArtifactCompilationNeed({ path, scope, sourceFingerprint: observed.fingerprint }, metadata, ORDINARY_ARTIFACT_COMPILER, false, provenance[path]);
				if (need.kind !== "requires-compilation") continue;
				if (need.reason === "source-changed") nextHints[path] = SOURCE_CHANGED_HINT;
				nextInvalidations.set(path, { path, scope, reason: need.reason });
			}
		}
		artifactHints = nextHints;
		artifactInvalidations = [...nextInvalidations.values()].sort((left, right) => left.path.localeCompare(right.path));
		artifactReads.setCandidates(artifactInvalidations);
	}

	function missingArtifactRemovals(states: ScopedStates): AtomicScopePatches {
		const owners = new Map<string, StateScope[]>();
		for (const scope of ["global", "cwd", "session"] as const) for (const path of Object.keys(states[scope].artifacts)) {
			owners.set(path, [...owners.get(path) ?? [], scope]);
		}
		const removals: AtomicScopePatches = {};
		for (const observation of inspectRegisteredArtifactPaths(owners.keys())) {
			if (observation.kind !== "missing") continue;
			for (const scope of owners.get(observation.path) ?? []) {
				const artifacts = (removals[scope]?.artifacts ?? {}) as JsonObject;
				removals[scope] = { ...(removals[scope] ?? {}), artifacts: { ...artifacts, [observation.path]: null } };
			}
		}
		return removals;
	}


	function installScopeStates(): void {
		scopeStates = runtime?.view ? runtime.states() : { global: emptyState(), cwd: emptyState(), session: emptyState() };
	}

	function passiveToolsAvailable(): boolean {
		return snapshot.config.enabled || config.passiveTools;
	}

	async function inspectTelegramState(scope: StateFlowTelegramScope): Promise<StateFlowTelegramInspection> {
		if (!activeContext || shuttingDown) throw new Error("State Flow is not attached to an active session yet");
		if (scope === "session" || scope === "effective") assertSelectedBranchAvailable();
		const selected = runtime ??= createRuntime(activeContext);
		const signal = sharedInspectionLifetime.signal;
		if (!selected.view || (scope !== "session" && !stopPersistenceError)) await selected.refreshShared(signal);
		signal.throwIfAborted();
		if (runtime !== selected) throw new Error("State Flow inspection selection changed; select the scope again");
		if (scope === "session" || scope === "effective") assertSelectedBranchAvailable();
		if (!selected.view) throw new Error("State Flow temporal runtime is unavailable");
		installScopeStates();
		const state = scope === "effective"
			? overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)
			: scopeStates[scope];
		return { state: { ...projectModelState(state), lazy: structuredClone(state.lazy) }, revisions: scopeRevisions(), signal };
	}

	function syncStateFlowTools(): void {
		const active = pi.getActiveTools();
		const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
		const available = passiveToolsAvailable();
		if (owned.every((name) => active.includes(name) === available)) return;
		pi.setActiveTools(available
			? [...new Set([...active, ...owned])]
			: active.filter((name) => !owned.includes(name)));
	}

	function recordPublication(_publication: RuntimePublication, _ctx: ExtensionContext): void {
		// A passive view is not runtime authority; only accepted canonical publication establishes it.
		branchStartsWithoutRuntime = false;
		backupPending = true;
	}

	/** Record accepted lifecycle persistence; Git backup is scheduled only after an accepted turn settles. */
	function recordPolicyPublication(publication: RuntimePublication | undefined, ctx: ExtensionContext): void {
		if (publication) recordPublication(publication, ctx);
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

	function clearAcceptedAcquisitions(acquiredArtifactPaths = new Set(artifactReads.successful.keys())): void {
		artifactInvalidations = artifactInvalidations.filter(({ path }) => !acquiredArtifactPaths.has(path));
		artifactReads.setCandidates(artifactInvalidations);
		dropCurrentSkillReads();
		artifactReads.clear();
	}

	async function prepareInference(pending: InferencePreparation, selected: TemporalRuntime | undefined, ctx: ExtensionContext, operationSignal: AbortSignal): Promise<void> {
		const signal = AbortSignal.any([pending.controller.signal, operationSignal]);
		try {
			if (!selected?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			await selected.withPatchTransaction((transaction) => {
				signal.throwIfAborted();
				if (runtime !== selected || inferencePreparation !== pending || !snapshot.config.enabled || shuttingDown) {
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
				if (publication?.changed) recordPublication(publication, ctx);
				if (pending.prompt !== undefined || publication?.changed) appendCheckpoint();
				if (Object.keys(removals).length > 0) clearAcceptedAcquisitions();
				updateUi(ctx);
			}, signal);
		} catch (error) {
			if (signal.aborted || runtime !== selected || inferencePreparation !== pending || shuttingDown) return;
			// Pi reports context-hook exceptions and continues. Abort through its public port rather than infer from stale preparation.
			ctx.abort();
			const cause = diagnosticText(error);
			recordDiagnostic(cause, "publication-conflict", ctx);
			notifyProblem(ctx, pending.accepted
				? `State Flow preparation saved; lifecycle update failed: ${cause}`
				: `State Flow inference preparation failed: ${cause}`, "error");
		}
	}


	function currentRehydrationPhase(): RehydrationPhase | undefined {
		return rehydrationPhase;
	}

	function statusDiagnostics(ctx: ExtensionContext): StatusDiagnostics {
		const cwd = ctx.cwd;
		const diagnosticStates = scopeStates;
		const view = runtime?.view;
		const diagnosticRecent = runtime?.recent() ?? [];
		const durableStateError = snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error
			: view ? undefined : "no temporal runtime is selected on this branch";

		const staleArtifacts: StatusDiagnostics["staleArtifacts"] = durableStateError === undefined
			? artifactInvalidations.map(({ path, scope, reason }) => ({ scope: scope ?? "global", path, reason }))
			: [];
		const session = sessionAddress(ctx);
		return {
			repositoryRoot,
			cwdScopeKey: cwdScopeKey(cwd),
			sessionScopeKey: sessionScopeKey(session.key),
			scopeStates: diagnosticStates,
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
			...(stopPersistenceError === undefined ? {} : { publicationError: stopPersistenceError }),
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
	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown, notifyRecovery = true, startOwner?: AbortController): Promise<void> {
		contextProjection.reset();
		cancelBranchRestoration();
		// Start-owned attachment/fork recovery keeps its owner; only accepted Start cancels Stop.
		if (!startOwner) {
			cancelStartActivation();
			cancelStopPersistence();
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
		let selection: BranchSelection = { kind: "settled" };
		let skipped = 0;
		try {
			const branch = ctx.sessionManager.getBranch();
			const fence = retainsPhysicalSessionProjection(sessionStartReason)
				? findPassiveStopBoundary(branch, ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE)?.persistenceError
				: undefined;
			stopPersistenceError = fence ?? (startOwner ? stopPersistenceError : undefined);
			if (fence) {
				// The native Stop owns policy only: read proven memory, never replay or publish a stale selection.
				selection = { kind: "current" };
			} else {
				const discovery = discoverSnapshotData(branch);
				const selected = selectRetainedCheckpoint(discovery.candidates);
				skipped = discovery.errors.length + selected.skipped.length;
				branchStartsWithoutRuntime = selected.kind === "disabled" || (discovery.candidates.length === 0 && discovery.errors.length === 0);
				if (discovery.candidates.length === 0 && discovery.errors.length > 0) {
					snapshot = migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`);
				} else if (selected.kind === "boundary" && forkInitialization) {
					try {
						// Native parent acquisition stays outside canonical exclusion.
						const source = forkSource(ctx);
						const sourceStopped = findPassiveStopBoundary(branch, source.id, PASSIVE_STOP_ENTRY_TYPE)?.persistenceError !== undefined;
						selection = { kind: "fork", source, checkpoint: sourceStopped ? { ...selected.checkpoint, enabled: false } : selected.checkpoint };
					} catch (error) {
						snapshot = selectedBoundaryFailure(diagnosticText(error));
					}
				} else if (selected.kind === "boundary") {
					selection = { kind: "restore", checkpoint: selected.checkpoint };
				} else if (discovery.candidates.length > 0) {
					snapshot = selected.kind === "disabled" ? emptySnapshot() : selected.snapshot;
				} else if (config.autoStart && isNewSession(sessionStartReason, branch)) {
					selection = { kind: "auto-start" };
				} else {
					snapshot = emptySnapshot();
				}
			}
		} catch (error) {
			selection = { kind: "settled" };
			snapshot = selectedBoundaryFailure(diagnosticText(error));
		}
		// Pending selection grants neither private reads nor publication until its acceptance installs memory.
		if (selection.kind !== "settled") snapshot = migrationFailure({}, "State Flow branch restoration is pending");
		const pending: BranchRestoration = {
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

	async function attachBranch(
		ctx: ExtensionContext, pending: BranchRestoration, selection: BranchSelection,
		reason: unknown, notifyRecovery: boolean, skipped: number,
	): Promise<void> {
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
			if (!isCurrent()) throw new Error("State Flow branch selection changed while awaiting publication");
		};
		let accepted = false;
		// Install accepted memory before native writes; later ancillary failures cannot revert or replay it.
		const accept = (candidate: TemporalRuntime, next: Snapshot, publication: RuntimePublication, nativeWrites: () => void): void => {
			accepted = true;
			pending.awaitingAcceptance = false;
			runtime = selected = candidate;
			snapshot = next;
			installScopeStates();
			recordPolicyPublication(publication, ctx);
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
						snapshot = current ?? migrationFailure({}, "Current State Flow session memory is unavailable");
						installScopeStates();
					} else if (selection.kind === "restore") {
						await candidate.withRestoreTransaction(selection.checkpoint, (restored, publish) => {
							assertCurrent();
							// Canceled preparation or boundary continuation may have no specification. Retain uncompiled native context.
							if (restored.config.enabled && restored.meta.specification === undefined
								&& retainsPhysicalSessionProjection(reason) && hasUncheckpointedConversation(ctx.sessionManager.getBranch())) restored.meta.bootstrap = true;
							const next = pending.passiveRequested ? stopEpisode(restored) : restored;
							accept(candidate, next, publish(next), appendCheckpoint);
						}, signal);
					} else if (selection.kind === "fork") {
						await candidate.withForkTransaction(selection.source, selection.checkpoint, (child, publish) => {
							assertCurrent();
							// Mode is selected independently of creating the child's private memory.
							const next = pending.passiveRequested ? stopEpisode(child) : child;
							const publication = publish(next);
							forkInitialization = false;
							accept(candidate, next, publication, () => {
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
							const next = pending.passiveRequested ? stopEpisode(activated) : activated;
							accept(candidate, next, publish(next), appendCheckpoint);
						}, signal, true);
					}
				} catch (error) {
					if (accepted) {
						if (isCurrent()) notifyProblem(ctx, `State Flow memory restored; lifecycle update failed: ${diagnosticText(error)}`, "warning");
						return;
					}
					if (!isCurrent()) return;
					if (error instanceof HistoryBoundaryExpiredError) selectedHistoryExpired = true;
					snapshot = selectedBoundaryFailure(diagnosticText(error));
					installScopeStates();
				} finally {
					pending.awaitingAcceptance = false;
				}
				if (accepted) return;
			}
			settleSelection(ctx, reason, notifyRecovery, skipped, selected !== placeholder);
			if (snapshot.config.enabled || !(config.passiveBootstrap || config.passiveTools) || runtime?.view) return;
			const passive = createRuntime(ctx);
			const priorView = selected?.view;
			try {
				await passive.refreshShared(signal);
			} catch (error) {
				if (isCurrent() && !signal.aborted && notifyRecovery && !stopPersistenceError) notifyProblem(ctx, `State Flow passive memory is unavailable: ${diagnosticText(error)}`, "warning");
				return;
			}
			assertCurrent();
			// An intervening passive patch or inspection owns its newer cache, even on the same physical branch.
			if (selected?.view !== priorView) return;
			runtime = selected = passive;
			installScopeStates();
			updateUi(ctx);
		} catch (error) {
			// Host failures before acceptance leave the selection unavailable, never invented empty memory.
			if (accepted || !isCurrent()) return;
			snapshot = selectedBoundaryFailure(diagnosticText(error));
			installScopeStates();
		} finally {
			pending.awaitingAcceptance = false;
			if (branchRestoration === pending) branchRestoration = undefined;
		}
	}

	function settleSelection(ctx: ExtensionContext, reason: unknown, notifyRecovery: boolean, skipped: number, selectedMemory: boolean): void {
		const failure = !snapshot.config.enabled && snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error : undefined;
		if (failure !== undefined && notifyRecovery && !stopPersistenceError) {
			if (selectedHistoryExpired) notifyProblem(ctx, "State Flow history is outside the retained temporal window; /state-flow-start can use current session memory.", "warning");
			else notifyProblem(ctx, `State Flow restore failed: ${failure}`, "error");
		}
		if (selectedMemory && retainsPhysicalSessionProjection(reason) && runtime?.view) {
			const boundary = findPassiveStopBoundary(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
			if (boundary !== undefined) {
				const continuation = createPassiveContinuation(
					projectModelState(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
					boundary.at,
					boundary.from,
					boundary.preserveContext,
				);
				if (!snapshot.config.enabled) passiveContinuation = continuation;
				else if (snapshot.meta.bootstrap) bootstrapContinuation = continuation;
			}
		}
		if (notifyRecovery && snapshot.config.enabled && skipped > 0) {
			notifyProblem(ctx, `State Flow skipped ${skipped} malformed snapshot(s); restored the last valid one.`, "warning");
		}
		if (snapshot.config.enabled) deferInferencePreparation();
		syncStateFlowTools();
		updateUi(ctx);
	}

	function recordDiagnostic(error: string, category: StateFlowDiagnosticCategory, ctx: ExtensionContext, extras: DiagnosticExtras = {}): void {
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
			projection: Type.Optional(StringEnum(["value", "keys", "patch"] as const, { description: "Value snapshot by default, structural keys with minimal meta, or the selected historical semantic patch" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal) {
			try {
				type ReadDetails = { path?: string; paths?: string[]; projection?: string; transitionId?: string };
				if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
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
			if (context.isError) return new Text(separatedOutput(text), 0, 0);
			if (isPartial || !config.showSuccessfulPatches) return new Text(text, 0, 0);
			return new Text(separatedOutput(theme.fg("dim", formatPatchStateArguments(context.args))), 0, 0);
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
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
				const previousEffective = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
				return await selected.withPatchTransaction((transaction) => {
					if (runtime !== selected) throw new Error("State Flow session selection changed while awaiting publication");
					if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
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
						recordPublication(publication, ctx);
						appendCheckpoint();
					}
					clearAcceptedAcquisitions(new Set(acquiredArtifacts.map(({ path }) => path)));
					updateUi(ctx);
					const updates = contextProjection.acceptPatch(previousEffective, overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session), patches, artifactHints);
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
				recordDiagnostic(cause, /concurrently|advanced/.test(cause) ? "publication-conflict" : "invalid-patch", ctx, {
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
		if (startActivation?.operation) return startActivation.operation;
		telegramStartPending = false;
		if (activeContext && !branchRestoration && snapshot.config.enabled) {
			return Promise.resolve({ ok: true, message: "State Flow is already enabled", signal: sharedInspectionLifetime.signal });
		}
		const pending: NonNullable<typeof startActivation> = { controller: new AbortController() };
		startActivation = pending;
		const operation = runStart(ctx, pending.controller);
		pending.operation = operation;
		const finished = () => { if (startActivation === pending) startActivation = undefined; };
		void operation.then(finished, finished);
		return operation;
	}

	/** Await restoration-owned attachment and exact-source fork recovery before current-head activation. */
	async function runStart(ctx: ExtensionContext, pending: AbortController): Promise<StateFlowTelegramControlResult> {
		const owner = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		const file = ctx.sessionManager.getSessionFile();
		const timestamp = ctx.sessionManager.getHeader()?.timestamp;
		const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
		const isOwner = () => startActivation?.controller === pending && !signal.aborted && !shuttingDown
			&& ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
			&& ctx.sessionManager.getHeader()?.timestamp === timestamp;
		const superseded = (): StateFlowTelegramControlResult => {
			pending.abort();
			return { ok: false, message: "State Flow Start was superseded", signal: pending.signal };
		};
		try {
			if (!activeContext) await waitForRecovery(restoreActiveBranch(ctx, undefined, false, pending), signal);
			else if (branchRestoration?.operation) await waitForRecovery(branchRestoration.operation, signal);
			if (!isOwner()) return superseded();
			if (snapshot.config.enabled) return { ok: true, message: "State Flow is already enabled", signal: sharedInspectionLifetime.signal };
			if (forkInitialization) {
				// Withdraw this join on cancellation without revoking the independently owned Stop.
				const stopping = stopPersistence?.operation;
				if (stopping) await waitForRecovery(stopping, signal);
				if (!isOwner()) return superseded();
				await waitForRecovery(restoreActiveBranch(ctx, "fork", false, pending), signal);
				if (!isOwner()) return superseded();
				assertSelectedBranchAvailable();
			}
			return activateCurrentState(ctx, pending);
		} catch (error) {
			if (!isOwner()) return superseded();
			const message = conciseDiagnostic(`State Flow Start failed: ${diagnosticText(error)}`);
			notifyProblem(ctx, message, "error");
			return { ok: false, message, signal: AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]) };
		}
	}

	async function activateCurrentState(ctx: ExtensionContext, pending: AbortController): Promise<StateFlowTelegramControlResult> {
		let selected = runtime;
		const owner = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		const file = ctx.sessionManager.getSessionFile();
		const timestamp = ctx.sessionManager.getHeader()?.timestamp;
		const initiallyEnabled = snapshot.config.enabled;
		let accepted = false;
		let receipt = AbortSignal.any([pending.signal, sharedInspectionLifetime.signal]);
		const isCurrent = () => startActivation?.controller === pending && runtime === selected && !shuttingDown
			&& ctx.cwd === cwd && ctx.sessionManager.getSessionId() === owner && ctx.sessionManager.getSessionFile() === file
			&& ctx.sessionManager.getHeader()?.timestamp === timestamp && snapshot.config.enabled === (accepted || initiallyEnabled);
		const superseded = (): StateFlowTelegramControlResult => {
			pending.abort();
			return { ok: false, message: "State Flow Start was superseded", signal: pending.signal };
		};
		try {
			const activation = createRuntime(ctx);
			const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
			const result = await activation.withStartTransaction((current, publish) => {
				signal.throwIfAborted();
				if (!isCurrent()) throw new Error("State Flow Start selection changed while awaiting publication");
				if (!current && !branchStartsWithoutRuntime) throw new Error(snapshot.meta.validation?.error ?? "Current State Flow session memory is unavailable");
				const continuation = passiveContinuation ?? bootstrapContinuation;
				const bootstrap = hasPriorConversation(ctx.sessionManager.getBranch()) || passiveContinuation !== undefined;
				const activated = current ? resumeEpisode(current, bootstrap) : startEpisode(bootstrap);
				const recoveredCurrent = selectedHistoryExpired;
				const publication = publish(activated);
				accepted = true;
				cancelStopPersistence();
				runtime = selected = activation;
				snapshot = activated;
				activeContext = ctx;
				selectedHistoryExpired = false;
				stopPersistenceError = undefined;
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
				ctx.ui.notify(
					recoveredCurrent
						? "State Flow enabled from current session memory; unavailable historical state was not restored."
						: snapshot.meta.bootstrap
							? "State Flow enabled. The next complete agent run will migrate active context into state."
							: "State Flow enabled. The next prompt starts a stateful agent run.",
					"info",
				);
				return { ok: true, message: "State Flow enabled", signal: receipt };
			}, signal, branchStartsWithoutRuntime);
			return isCurrent() ? result : superseded();
		} catch (error) {
			if (!isCurrent()) return superseded();
			const message = conciseDiagnostic(`${accepted ? "State Flow enabled; lifecycle update failed" : "State Flow Start failed"}: ${diagnosticText(error)}`);
			notifyProblem(ctx, message, accepted ? "warning" : "error");
			return { ok: accepted, message, signal: receipt };
		}
	}

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			await startStateFlow(ctx);
		},
	});

	pi.registerCommand("state-flow-status", {
		description: "Show State Flow runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
		},
	});

	function stopStateFlow(ctx: ExtensionContext): Promise<StateFlowTelegramControlResult> {
		cancelStartActivation();
		if (shuttingDown) return Promise.resolve({ ok: false, message: "State Flow is shutting down" });
		if (stopPersistence?.operation) return stopPersistence.operation;
		if (!activeContext) void restoreActiveBranch(ctx, undefined, false);
		const restoring = branchRestoration;
		if (restoring?.awaitingAcceptance) {
			// Stop changes policy without cancelling memory restoration or initialization.
			restoring.passiveRequested = true;
			snapshot = stopEpisode(snapshot);
			clearRunTransient();
			syncStateFlowTools();
			updateUi(ctx);
			return Promise.resolve({ ok: true, message: "State Flow disabled; memory restoration continues" });
		}
		const pending: NonNullable<typeof stopPersistence> = { controller: new AbortController() };
		stopPersistence = pending;
		const operation = persistStoppedState(ctx, pending.controller);
		pending.operation = operation;
		const finished = () => { if (stopPersistence === pending) stopPersistence = undefined; };
		void operation.then(finished, finished);
		return operation;
	}

	async function persistStoppedState(ctx: ExtensionContext, pending: AbortController): Promise<StateFlowTelegramControlResult> {
		telegramStartPending = false;
		const selected = runtime;
		const owner = ctx.sessionManager.getSessionId();
		const current = snapshot;
		let unfinished = current.meta.specification !== undefined
			|| (inferencePreparation?.prompt !== undefined && !inferencePreparation.accepted);
		snapshot = stopEpisode(current);
		clearRunTransient();
		syncStateFlowTools();
		updateUi(ctx);
		if (stopPersistenceError) return { ok: true, message: "State Flow disabled; memory writes remain paused" };
		const stoppedAt = Date.now();
		const incomingBoundary = current.meta.bootstrap ? bootstrapContinuation : undefined;
		const anchor = runAnchorTimestamp;
		const idle = ctx.isIdle();
		const isCurrent = () => stopPersistence?.controller === pending && runtime === selected
			&& !shuttingDown && ctx.sessionManager.getSessionId() === owner && !snapshot.config.enabled;
		const superseded = (): StateFlowTelegramControlResult => ({ ok: false, message: "State Flow Stop was superseded" });
		const freezeHandoff = (): PassiveContinuation | undefined => {
			contextProjection.reset();
			const handoff = (current.config.enabled || stopPersistenceError) && selected?.view && current.meta.validation?.attempt !== 0
				? createPassiveContinuation(
					projectModelState(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
					incomingBoundary?.startedAt ?? stoppedAt,
					incomingBoundary ? incomingBoundary.activeRunStartedAt : !idle || unfinished ? anchor : undefined,
					stopPersistenceError !== undefined || (incomingBoundary ? incomingBoundary.preserveContext : current.meta.bootstrap === true || (unfinished && anchor === undefined)),
				)
				: undefined;
			passiveContinuation = handoff ?? (!current.config.enabled ? passiveContinuation : undefined);
			return handoff;
		};
		const complete = (): StateFlowTelegramControlResult => {
			const exitHandoff = freezeHandoff();
			if (exitHandoff || stopPersistenceError) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
				at: exitHandoff?.startedAt ?? stoppedAt,
				...(exitHandoff?.activeRunStartedAt === undefined ? {} : { from: exitHandoff.activeRunStartedAt }),
				...(exitHandoff?.preserveContext || stopPersistenceError ? { preserveContext: true } : {}),
				...(stopPersistenceError === undefined ? {} : { owner, persistenceError: stopPersistenceError }),
			});
			if (!stopPersistenceError) {
				appendCheckpoint();
				return { ok: true, message: "State Flow disabled" };
			}
			const message = conciseDiagnostic(`State Flow disabled; memory writes paused: ${stopPersistenceError}`);
			notifyProblem(ctx, message, "warning");
			return { ok: true, message };
		};
		let accepted = false;
		try {
			unfinished ||= current.config.enabled && hasUncheckpointedConversation(ctx.sessionManager.getBranch());
			// Projection changes before any wait; capture the old run's boundary before later native input can replace it.
			freezeHandoff();
			bootstrapContinuation = undefined;
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			assertPublicationAvailable();
			if (branchStartsWithoutRuntime || !selected?.view) return complete();
			const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
			const result = await selected.withLifecycleTransaction((publish) => {
				signal.throwIfAborted();
				if (!isCurrent()) throw new Error("State Flow Stop selection changed while awaiting publication");
				assertPublicationAvailable();
				const stopped = stopEpisode(snapshot);
				const publication = publish(stopped);
				accepted = true;
				snapshot = stopped;
				installScopeStates();
				recordPolicyPublication(publication, ctx);
				return complete();
			}, signal);
			return isCurrent() ? result : superseded();
		} catch (error) {
			if (!isCurrent()) return superseded();
			const cause = diagnosticText(error);
			if (accepted) {
				const message = conciseDiagnostic(`State Flow disabled; lifecycle update failed: ${cause}`);
				notifyProblem(ctx, message, "warning");
				return { ok: true, message };
			}
			stopPersistenceError = cause.trim() ? cause : "Canonical State Flow persistence failed";
			bootstrapContinuation = undefined;
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			return complete();
		}
	}

	pi.registerCommand("state-flow-stop", {
		description: "Stop State Flow on the current session branch",
		handler: async (_args, ctx) => {
			await stopStateFlow(ctx);
		},
	});

	const telegram = createStateFlowTelegramAdapter({
		...(options.telegram?.load === undefined ? {} : { load: options.telegram.load }),
		port: {
			snapshot: () => ({
				enabled: snapshot.config.enabled,
				step: snapshot.meta.step,
				revisions: scopeRevisions(),
				bootstrap: snapshot.meta.bootstrap === true,
				startPending: telegramStartPending,
			}),
			inspect: inspectTelegramState,
			canStartNow: () => activeContext === undefined || activeContext.isIdle(),
			start: () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				return startStateFlow(activeContext);
			},
			stop: async () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				const operation = stopStateFlow(activeContext);
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
				cancelStartActivation();
			},
		},
	});
	void telegram.ensure();

	pi.on("before_agent_start", (event) => {
		// Native run identity is independent of semantic enablement and survives mode toggles.
		runAnchorTimestamp = undefined;
		if (!snapshot.config.enabled) {
			if (!config.passiveBootstrap || !runtime?.view) return;
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
		const protocol = snapshot.config.enabled ? stateFlowProtocol(snapshot.meta.bootstrap === true)
			: config.passiveBootstrap && runtime?.view ? PASSIVE_MEMORY_PROTOCOL : undefined;
		return { messages: projectSystemProtocol(event.messages, protocol) };
	});

	function projectContext(messages: AgentMessage[]) {
		if (runtime?.view) refreshArtifactHints();
		if (!snapshot.config.enabled && !passiveContinuation && (!config.passiveBootstrap || !runtime?.view)) return;
		// Idle inspection must not freeze a pre-acceptance snapshot for the live inference.
		const projection = snapshot.config.enabled && inferencePreparation && !inferencePreparation.accepted
			? new ContextProjection() : contextProjection;
		const effective = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
		const invalidations = artifactInvalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason }));
		const phase = snapshot.config.enabled ? currentRehydrationPhase() : undefined;
		const view = contextView(effective, artifactHints, invalidations, phase);
		if (passiveContinuation) {
			const retained = passiveContinuationMessages(messages, passiveContinuation);
			if (!runtime?.view) return { messages: retained };
			return { messages: projection.project(retained.slice(1), view, () => passiveContinuation!.handoff,
				{ state: passiveContinuation.state, lazy_navigation: view.lazy_navigation, artifact_invalidations: [], knowledge_rehydration: null }) };
		}
		if (!snapshot.config.enabled) {
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
		const pending = inferencePreparation;
		const selected = runtime;
		const operationSignal = ctx.signal;
		// Idle projections remain observational; only a live native operation may await preparation.
		if (!snapshot.config.enabled || !pending || !operationSignal || shuttingDown) return projectContext(messages);
		pending.operation ??= prepareInference(pending, selected, ctx, operationSignal).finally(() => {
			// A late withdrawal must not clear newer work; accepted lifecycle is never replayed after an error.
			if (!pending.accepted && inferencePreparation === pending) pending.operation = undefined;
		});
		return pending.operation.then(() => {
			if (shuttingDown || operationSignal.aborted || runtime !== selected || ctx.signal !== operationSignal) return;
			if (snapshot.config.enabled && inferencePreparation !== pending) {
				// Start may require same-run maintenance. A new captured user prompt instead owns a different context request.
				if (inferencePreparation?.prompt === undefined) return prepareContext(messages, ctx);
				return;
			}
			if (snapshot.config.enabled && !pending.accepted) return;
			return projectContext(messages);
		});
	}

	pi.on("context", (event, ctx) => prepareContext(event.messages as AgentMessage[], ctx));

	pi.on("tool_execution_start", (event) => {
		if (!snapshot.config.enabled) return;
		// Pi emits this before tool_call. Keep the argument object as a fallback;
		// tool_call replaces it with the mutable, post-preflight input reference.
		skillReads.recordStart(event.toolCallId, event.toolName, event.args);
		artifactReads.recordStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!snapshot.config.enabled) return;
		const batch = findAssistantToolBatch(ctx.sessionManager, event.toolCallId);
		const patchCalls = batch?.filter((name) => name === PATCH_STATE_TOOL_NAME).length ?? 0;
		if (patchCalls > 0) {
			if (patchCalls !== 1) {
				return {
					block: true,
					reason: "A State Flow barrier response must contain exactly one patch_state call",
				};
			}
			if (event.toolName !== PATCH_STATE_TOOL_NAME) {
				return {
					block: true,
					reason: "Blocked by the patch_state barrier; reconsider this action after State Flow rematerializes context",
				};
			}
		}
		skillReads.recordCall(event.toolCallId, event.toolName, event.input);
		artifactReads.recordCall(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_execution_end", (event) => {
		if (!snapshot.config.enabled) return;
		skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
		dropCurrentSkillReads();
		artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
	});

	pi.on("tool_result", (event) => {
		if (!snapshot.config.enabled) return;
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
		if (shuttingDown || !snapshot.config.enabled) return;
		if (event.message.role !== "assistant") return;
		cancelResponseReconciliation();
		const message = event.message as unknown as { role: "assistant"; stopReason?: string; content?: unknown };
		if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse") return;
		if (message.stopReason === "length" || message.stopReason === "error") {
			recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content });
			return;
		}
		responseReconciliation = new AbortController();
	});

	pi.on("turn_end", async (event, ctx) => {
		if (shuttingDown) return;
		const pending = responseReconciliation;
		if (!snapshot.config.enabled || !pending) {
			updateUi(ctx);
			return;
		}
		const selected = runtime;
		const signal = ctx.signal ? AbortSignal.any([pending.signal, ctx.signal]) : pending.signal;
		let responseCommitted = false;
		try {
			const response = finalizedAssistantResponse(event.message);
			if (!selected?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			await selected.withPatchTransaction((transaction) => {
				signal.throwIfAborted();
				if (runtime !== selected || responseReconciliation !== pending || !snapshot.config.enabled) {
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
				if (publication?.changed) recordPublication(publication, ctx);
				appendCheckpoint();
				clearAcceptedAcquisitions();
				bootstrapContinuation = undefined;
				rehydrationPhase = "step";
				completedRunAccepted = !wasBootstrap;
				turnAcceptedForBackup = true;
				updateUi(ctx);
			}, signal);
		} catch (error) {
			// Superseded completion owns neither the new lifecycle nor its diagnostics/UI.
			if (signal.aborted || runtime !== selected || responseReconciliation !== pending) return;
			const cause = diagnosticText(error);
			recordDiagnostic(cause, "finalization", ctx);
			notifyProblem(ctx, responseCommitted
				? `State Flow response saved; lifecycle update failed: ${cause}`
				: `State Flow response reconciliation failed: ${cause}`, "error");
		} finally {
			if (responseReconciliation === pending) responseReconciliation = undefined;
		}
	});

	pi.on("session_before_compact", (event) => {
		if (!compactionPlan) return;
		if (compactionStopped && event.reason === "manual" && event.customInstructions === compactionMarker) return { cancel: true };
		const result = stateFlowCompactionResult(compactionPlan, compactionMarker, event);
		if (result === undefined || "cancel" in result) return result;
		return { compaction: result };
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		if (shuttingDown || !turnAcceptedForBackup) return;
		turnAcceptedForBackup = false;
		if (!backupPending) return;
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
				try { await operation; }
				finally { backupOperations.delete(operation); }
				if (signal.aborted) return;
				startStateFlowBackupPush(repositoryRoot, (error) => {
					if (shuttingDown) return;
					const message = diagnosticText(error);
					const recorded = diagnosticWriter.recordBackupPushFailure(pushSessionId, pushCwd, message);
					if (pushFailureNotified) return;
					pushFailureNotified = true;
					notifyActiveContext(recorded
						? `State Flow Git backup push failed; state is saved locally. Details: ${stateFlowLogPath(agentDir)}. A later accepted turn retries.`
						: `State Flow Git backup push failed; local diagnostics unavailable: ${message}`);
				}, () => { pushFailureNotified = false; });
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
		if (telegramStartPending && !snapshot.config.enabled) {
			telegramStartPending = false;
			await startStateFlow(ctx);
			return;
		}
		if (!completedRunAccepted || compactionStopped || !snapshot.config.enabled || snapshot.meta.bootstrap
			|| compactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !runtime?.view
			|| !shouldRequestStateFlowCompaction(ctx.getContextUsage())) return;
		completedRunAccepted = false;
		const entries = ctx.sessionManager.buildContextEntries();
		if (!hasCompactionSizedTranscript(entries)) return;
		const plan = planStateFlowCompaction(entries, runtime.causalBasis(), snapshot.meta.step, runAnchorTimestamp);
		if (!plan) return;
		compactionPlan = plan;
		compactionInFlight = true;
		// Pi dispatches deferred companion prompts after all settled handlers return.
		await new Promise<void>((resolve) => {
			const finished = () => { compactionPlan = undefined; compactionInFlight = false; resolve(); };
			ctx.compact({ customInstructions: compactionMarker, onComplete: finished, onError: finished });
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
		contextProjection.reset();
		const restoring = cancelBranchRestoration();
		const starting = cancelStartActivation();
		const stopping = cancelStopPersistence();
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
