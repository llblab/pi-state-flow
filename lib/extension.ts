import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assistantToolCallCount, finalizedAssistantResponse, formatPatchStateArguments, normalizePatchStateArguments, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.ts";
import { createPassiveContinuation, currentRunTrajectory, lazyNavigationHint, passiveContinuationMessages, runtimeContextMessage, syntheticUser, VALIDATION_MESSAGE_TYPE, withoutPrivateValidation, type PassiveContinuation } from "./context.ts";
import { ArtifactReadTracker } from "./acquisition.ts";
import { loadStateFlowConfig } from "./config.ts";
import { createStateFlowTelegramAdapter, type StateFlowTelegramControlResult, type StateFlowTelegramLoader } from "./telegram.ts";
import { isAbsolute, resolve } from "node:path";
import { SkillReadTracker } from "./skills.ts";
import { emptySnapshot, migrationFailure, persistableSnapshot, RevisionUnavailableError, type Snapshot } from "./snapshot.ts";
import { readNativeSessionHeader } from "./continuation.ts";
import { MissingSessionRuntimeError, SharedScopeRemovalConflictError, TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { emptyState, overlayStates, projectStateForModel, type AtomicScopePatches, type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition, validateFinalEligibility, type StagedScopedTransition } from "./transition.ts";
import { discoverSnapshotData, findAssistantToolBatch, findPassiveStopBoundary, hasPriorConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type PendingPublicationDiagnostic, type StatusDiagnostics } from "./status.ts";
import { completeRun, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "./episode.ts";
import { recoverSnapshot } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { loadPublicationQueue, publicationQueuePath, PublicationWorkerController, resolveRemotePublicationPolicy, serializeRemotePublicationPolicyDocument, type PublicationQueueState } from "./publication.ts";
import { getKnowledgeRoot, GlobalMarkdownDiscovery } from "./discovery.ts";
import { canonicalJson, isObject, sameJson } from "./json.ts";
import { readProjectedState, readStatePath } from "./query.ts";
import {
	cwdScopeKey,
	resolveSessionAddress,
	sessionScopeKey,
	type SessionAddress,
} from "./durable.ts";
import { projectRecentTransitionsWithLimit, RECENT_TRANSITION_LIMIT } from "./history.ts";
import { StateFlowDiagnosticWriter, stateFlowLogPath, type DiagnosticExtras, type StateFlowDiagnosticCategory } from "./logging.ts";
import { isGitCommitAncestor, pushGitCommit, pushGitTarget, resolveGitPushDestination } from "./git.ts";
import {
	ORDINARY_ARTIFACT_COMPILER,
	planArtifactInvalidation,
	type ArtifactInvalidationRequest,
} from "./artifact.ts";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, stateFlowCompactionResult, type StateFlowCompactionPlan } from "./compaction.ts";

export interface StateFlowExtensionOptions {
	agentDir?: string;
	repositoryRoot?: string;
	knowledgeRoot?: string;
	onRuntime?: (accessor: { read(offset?: number, scope?: StateScope): MaterializedState }) => void;
	telegram?: { load?: StateFlowTelegramLoader };
	/** Test/SDK capability override; repository config remains the Pi default. */
	passive?: { bootstrap?: boolean; tools?: boolean };
}

export { formatPatchStateArguments, normalizePatchStateArguments };

export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
export const MAX_FALLBACK_ATTEMPTS: number = 2;
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";
const PUBLICATION_SHUTDOWN_WAIT_MS = 2_000;

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
	let branchHasSnapshot = false;
	let branchStartsWithoutRuntime = false;
	let forkInitialization = false;
	let terminalEligible = false;
	let resolutionPending = false;
	let fallbackAttempts = 0;
	let fallbackFailureReported = false;
	let responseAwaitingReconciliation = false;
	let completedRunAccepted = false;
	let compactionPlan: StateFlowCompactionPlan | undefined;
	let compactionInFlight = false;
	let compactionStopped = false;
	const compactionMarker = `state-flow-boundary:${randomUUID()}`;
	let passiveContinuation: PassiveContinuation | undefined;
	let bootstrapContinuation: PassiveContinuation | undefined;
	let artifactRefreshPending = false;
	let runAnchorTimestamp: number | undefined;
	let runtime: TemporalRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingPublication: PendingPublicationDiagnostic | undefined;
	let rehydrationPhase: RehydrationPhase | undefined;
	let turnPublicationTarget: string | undefined;
	let publicationShutdown: Promise<void> | undefined;
	const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
	const diagnosticWriter = new StateFlowDiagnosticWriter(config.logging, stateFlowLogPath(agentDir), repositoryRoot, (message) => activeContext?.ui.notify(message, "warning"));
	const publicationWorker = new PublicationWorkerController({
		resolveDestination: () => resolveGitPushDestination(repositoryRoot),
		isAncestor: (ancestor, descendant) => isGitCommitAncestor(repositoryRoot, ancestor, descendant),
		push: (destination, target, signal) => pushGitTarget(repositoryRoot, destination, target, signal),
		onDiverged: (dropped, target) => activeContext && recordDiagnostic(
			`Retired publication queue target ${dropped.target} after a journal lineage rewrite; retargeting to ${target}`,
			"publication-conflict", activeContext,
		),
	});
	const skillReads = new SkillReadTracker();
	const artifactReads = new ArtifactReadTracker();
	const globalMarkdown = new GlobalMarkdownDiscovery(options.knowledgeRoot ?? getKnowledgeRoot(agentDir));
	let artifactInvalidations: ArtifactInvalidationRequest[] = [];
	let telegramStartPending = false;

	function sessionAddress(ctx: ExtensionContext): SessionAddress {
		return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
	}

	function createRuntime(ctx: ExtensionContext): TemporalRuntime {
		return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot);
	}

	options.onRuntime?.({ read: (offset, scope) => {
		if (!runtime) throw new Error("State Flow temporal runtime is unavailable");
		return projectStateForModel(runtime.read(offset, scope));
	} });

	function persist(): void {
		const mode = snapshot.meta.remotePublication?.mode ?? "transition";
		const publication = runtime?.view ? runtime.publish(snapshot, false, undefined, { pushRemote: mode === "transition" }) : undefined;
		if (publication?.commit && mode === "turn-end") turnPublicationTarget = publication.commit;
		if (publication && activeContext) recordPublication(publication, activeContext);
		const checkpoint = persistableSnapshot(snapshot);
		if ("disabled" in checkpoint && !branchStartsWithoutRuntime) {
			throw new Error("State Flow cannot checkpoint an unproven branch as ordinary disabled; restore a valid checkpoint first");
		}
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
		if ("revision" in checkpoint) branchStartsWithoutRuntime = false;
	}

	function updateUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, (color, text) => ctx.ui.theme.fg(color, text)));
	}

	function setPendingPublication(value: PendingPublicationDiagnostic | undefined): void {
		pendingPublication = value === undefined ? undefined : structuredClone(value);
		if (value === undefined) delete snapshot.meta.pendingPublication;
		else snapshot.meta.pendingPublication = structuredClone(value);
	}

	function clearRunTransient(): void {
		terminalEligible = false;
		resolutionPending = false;
		fallbackAttempts = 0;
		fallbackFailureReported = false;
		responseAwaitingReconciliation = false;
		completedRunAccepted = false;
		compactionPlan = undefined;
		compactionInFlight = false;
		runAnchorTimestamp = undefined;
		skillReads.clear();
		artifactReads.clear();
	}

	function deferArtifactRefresh(): void {
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = true;
	}

	function refreshArtifactInvalidations(ctx: ExtensionContext): void {
		artifactRefreshPending = false;
		if (!snapshot.config.enabled) {
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			return;
		}
		try {
			const discovery = globalMarkdown.refresh(Object.keys(scopeStates.global.artifacts));
			const plan = planArtifactInvalidation(
				discovery.sources,
				scopeStates.global.artifacts,
				ORDINARY_ARTIFACT_COMPILER,
				{ removed: discovery.removed },
				runtime?.artifactProvenance("global") ?? {},
			);
			artifactInvalidations = structuredClone(plan.requiresCompilation);
			if (plan.removed.length > 0) {
				const removals = Object.fromEntries(plan.removed.map((path) => [path, null]));
				const stage = stageAtomicScopePatches(
					scopeStates,
					{ global: { artifacts: removals } },
					[],
					runtime!.causalBasis(),
				);
				commitStage(stage, ctx, false);
			}
			artifactReads.setCandidates(artifactInvalidations);
		} catch (error) {
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			ctx.ui.notify(
				`State Flow could not discover global Markdown sources: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function installScopeStates(): void {
		scopeStates = runtime?.view ? runtime.states() : { global: emptyState(), cwd: emptyState(), session: emptyState() };
	}

	function passiveToolsAvailable(): boolean {
		return snapshot.config.enabled || config.passiveTools;
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

	function recordPublication(publication: RuntimePublication, ctx: ExtensionContext): void {
		const revision = publication.revision ?? publication.commit;
		if (revision !== undefined) snapshot.meta.durableBase = revision;
		if (publication.push?.status === "pending") {
			setPendingPublication({
				commit: publication.push.commit,
				error: publication.push.error ?? "unknown push failure",
			});
			ctx.ui.notify(
				`State Flow accepted durable commit ${publication.push.commit.slice(0, 12)}, but push is pending: ${publication.push.error}`,
				"warning",
			);
		} else if (revision !== undefined) {
			setPendingPublication(undefined);
		}
	}

	/** Accept an activation or lifecycle commit locally; turn-end policy queues it for the asynchronous worker. */
	function recordPolicyPublication(publication: RuntimePublication | undefined, ctx: ExtensionContext): void {
		if (!publication) return;
		recordPublication(publication, ctx);
		const mode = snapshot.meta.remotePublication?.mode ?? "transition";
		const target = publication.commit ?? publication.revision;
		if (mode !== "turn-end" || target === undefined || !/^[0-9a-f]{40,64}$/.test(target)) return;
		turnPublicationTarget = target;
		try {
			enqueueTurnPublication();
			publicationWorker.launch();
		} catch (error) {
			ctx.ui.notify(
				`State Flow accepted the local commit; remote publication is deferred: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function commitStage(stage: StagedScopedTransition, ctx: ExtensionContext, finalizeRun: boolean): boolean {
		const acquiredArtifactPaths = new Set(artifactReads.successful.keys());
		let committed: boolean;
		try {
			committed = commitScopedTransition(snapshot, scopeStates, stage, (accepted, nextSnapshot) => {
				if (!runtime?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
				const mode = nextSnapshot.meta.remotePublication?.mode ?? "transition";
				const publication = runtime.publish(nextSnapshot, accepted !== undefined, accepted, {
					pushRemote: mode === "transition",
					provenance: stage.provenanceUpdates,
				});
				if (publication?.commit && mode === "turn-end") turnPublicationTarget = publication.commit;
				if (publication) recordPublication(publication, ctx);
			}, runtime!.causalBasis(), { finalizeRun });
		} catch (error) {
			if (error instanceof SharedScopeRemovalConflictError) installScopeStates();
			throw error;
		}
		if (!committed) return false;
		installScopeStates();
		// A preserved primary response commits mid-run; pending acquisition obligations must
		// still block final eligibility until the fallback turns resolve or expire.
		if (!(finalizeRun && resolutionPending)) {
			artifactInvalidations = artifactInvalidations.filter(({ path }) => !acquiredArtifactPaths.has(path));
			artifactReads.setCandidates(artifactInvalidations);
			skillReads.clear();
			artifactReads.clear();
		}
		persist();
		return true;
	}

	function enqueueTurnPublication(): void {
		const target = turnPublicationTarget;
		turnPublicationTarget = undefined;
		if (target) publicationWorker.enqueue(target);
	}

	function shutdownPublicationWorkers(ctx: ExtensionContext): Promise<void> {
		return publicationShutdown ??= publicationWorker.shutdown(PUBLICATION_SHUTDOWN_WAIT_MS).then((completed) => {
			if (!completed) ctx.ui.notify(`State Flow push cleanup is unconfirmed after ${PUBLICATION_SHUTDOWN_WAIT_MS}ms; worker leases remain held until child exit.`, "warning");
		});
	}

	function retryPendingPush(ctx: ExtensionContext): void {
		if (pendingPublication === undefined || !runtime?.view) return;
		const mode = snapshot.meta.remotePublication?.mode ?? "transition";
		if (mode !== "transition") {
			const target = pendingPublication.commit;
			setPendingPublication(undefined);
			if (mode === "turn-end") {
				turnPublicationTarget = target;
				try {
					enqueueTurnPublication();
					publicationWorker.launch();
				} catch (error) {
					ctx.ui.notify(`State Flow retained local state; asynchronous publication recovery is deferred: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}
			return;
		}
		const result = pushGitCommit(repositoryRoot, pendingPublication.commit);
		if (result.status !== "pending") {
			setPendingPublication(undefined);
			persist();
			ctx.ui.notify(result.status === "local"
				? `State Flow retained local-only durable commit ${result.commit.slice(0, 12)}; no remote configured.`
				: `State Flow pushed pending durable commit ${result.commit.slice(0, 12)}.`, "info");
		} else {
			setPendingPublication({ commit: result.commit, error: result.error ?? "unknown push failure" });
			persist();
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
		const durableStateError = view ? undefined
			: snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error : "no temporal runtime is selected on this branch";

		let staleArtifacts: StatusDiagnostics["staleArtifacts"] = [];
		let artifactFreshnessError: string | undefined;
		if (durableStateError !== undefined) {
			artifactFreshnessError = "durable global artifact registry is unavailable";
		} else {
			try {
				const discovery = globalMarkdown.refresh(Object.keys(diagnosticStates.global.artifacts));
				artifactFreshnessError = discovery.unavailable;
				const plan = planArtifactInvalidation(
					discovery.sources,
					diagnosticStates.global.artifacts,
					ORDINARY_ARTIFACT_COMPILER,
					{ removed: discovery.removed },
					runtime?.artifactProvenance("global") ?? {},
				);
				staleArtifacts = [
					...plan.requiresCompilation.map(({ path, reason }) => ({ scope: "global" as const, path, reason })),
					...plan.removed.map((path) => ({ scope: "global" as const, path, reason: "source-removed" as const })),
				];
			} catch (error) {
				artifactFreshnessError = error instanceof Error ? error.message : String(error);
			}
		}

		const session = sessionAddress(ctx);
		let publicationQueue: PublicationQueueState | undefined;
		let publicationQueueError: string | undefined;
		try {
			const destination = resolveGitPushDestination(repositoryRoot);
			publicationQueue = destination ? loadPublicationQueue(publicationQueuePath(destination)) : undefined;
		} catch (error) {
			publicationQueue = undefined;
			publicationQueueError = error instanceof Error ? error.message : String(error);
		}
		return {
			repositoryRoot,
			cwdScopeKey: cwdScopeKey(cwd),
			sessionScopeKey: sessionScopeKey(session.key),
			scopeStates: diagnosticStates,
			recent: diagnosticRecent,
			...(view === undefined ? {} : { temporal: {
				head: structuredClone(view.lineage.at(-1)!),
				historyDepth: view.lineage.length - 1,
				tailCounts: { global: view.scopes.global.patches.length, cwd: view.scopes.cwd.patches.length, session: view.scopes.session.patches.length },
			} }),
			staleArtifacts,
			...(artifactFreshnessError === undefined ? {} : { artifactFreshnessError }),
			...(durableStateError === undefined ? {} : { durableStateError }),
			...(pendingPublication === undefined ? {} : { pendingPublication }),
			...(publicationQueue === undefined ? {} : { publicationQueue }),
			...(publicationQueueError === undefined ? {} : { publicationQueueError }),
		};
	}

	function prepareBranchRestore(ctx: ExtensionContext, revision: string, legacy?: Snapshot): { snapshot: Snapshot; restore: () => Snapshot } {
		if (!forkInitialization) {
			try {
				return runtime!.prepareRestore(revision, legacy);
			} catch (error) {
				if (error instanceof MissingSessionRuntimeError && typeof ctx.sessionManager.getHeader()?.parentSession === "string") {
					throw new RevisionUnavailableError("State Flow checkpoint has no child-owned runtime; select a child checkpoint or resume the parent");
				}
				throw error;
			}
		}
		const file = ctx.sessionManager.getHeader()?.parentSession;
		if (typeof file !== "string" || !isAbsolute(file)) throw new Error("State Flow fork requires a persisted native parent session");
		const parent = readNativeSessionHeader(file);
		if (parent.cwd !== resolve(ctx.cwd)) throw new Error("State Flow fork parent CWD identity mismatch");
		const source = resolveSessionAddress(parent.file, parent.id, parent.timestamp);
		const prepared = runtime!.prepareFork(source, revision);
		return { snapshot: prepared.snapshot, restore: () => {
			const accepted = prepared.fork();
			snapshot = accepted.snapshot;
			recordPolicyPublication(accepted.publication, ctx);
			// Copied Stop markers belong to the parent, including after a child reload/resume.
			pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { reset: true, owner: ctx.sessionManager.getSessionId() });
			forkInitialization = false;
			return snapshot;
		} };
	}

	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown): void {
		clearRunTransient();
		passiveContinuation = undefined;
		bootstrapContinuation = undefined;
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = false;
		telegramStartPending = false;
		activeContext = ctx;
		const session = sessionAddress(ctx);
		runtime = new TemporalRuntime(ctx.cwd, session, repositoryRoot);
		installScopeStates();
		pendingPublication = undefined;
		branchHasSnapshot = false;
		branchStartsWithoutRuntime = false;
		forkInitialization = sessionStartReason === "fork";
		try {
			const branch = ctx.sessionManager.getBranch();
			const discovery = discoverSnapshotData(branch);
			let restoreSelected: (() => Snapshot) | undefined;
			const recovery = recoverSnapshot(discovery.candidates, (revision) => {
				try {
					const prepared = prepareBranchRestore(ctx, revision);
					restoreSelected = prepared.restore;
					return prepared.snapshot;
				} catch (error) {
					// A failed source proof never licenses an older/empty private copy.
					if (forkInitialization) throw new RevisionUnavailableError(`Cannot copy State Flow fork source: ${error instanceof Error ? error.message : String(error)}`);
					throw error;
				}
			});
			branchStartsWithoutRuntime = recovery.disabledMarker === true
				|| (discovery.candidates.length === 0 && discovery.errors.length === 0);
			const skipped = discovery.errors.length + recovery.skipped.length;
			branchHasSnapshot = recovery.skipped.length < discovery.candidates.length;
			if (discovery.candidates.length === 0 && discovery.errors.length > 0) {
				snapshot = migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`);
			} else if (discovery.candidates.length > 0) {
				snapshot = recovery.snapshot;
				if (branchHasSnapshot && snapshot.meta.durableBase) {
					const selectedRevision = snapshot.meta.durableBase;
					snapshot = restoreSelected ? restoreSelected() : prepareBranchRestore(ctx, selectedRevision, snapshot).restore();
					if (snapshot.meta.durableBase !== selectedRevision) persist();
				} else if (branchHasSnapshot && snapshot.config.enabled) {
					const publication = runtime.initialize(snapshot, true);
					recordPolicyPublication(publication, ctx);
				}
				installScopeStates();
			} else if (config.autoStart && isNewSession(sessionStartReason, branch)) {
				snapshot = startEpisode(hasPriorConversation(branch));
				snapshot.meta.remotePublication = serializeRemotePublicationPolicyDocument(
					resolveRemotePublicationPolicy(config.remotePublication, { legacyRuntime: false }),
				);
				runtime.prepare();
				const initialization = runtime.initialize(snapshot, true);
				recordPolicyPublication(initialization, ctx);
				if (!runtime.view) snapshot = emptySnapshot();
				installScopeStates();
				if (snapshot.config.enabled) {
					branchHasSnapshot = true;
					persist();
				}
			} else {
				snapshot = emptySnapshot();
				installScopeStates();
			}
			if (snapshot.config.enabled && skipped > 0) {
				ctx.ui.notify(`State Flow recovered the previous valid snapshot after skipping ${skipped} malformed newer snapshot(s).`, "warning");
			}
		} catch (error) {
			const failure = migrationFailure({}, `Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
			snapshot = {
				...snapshot,
				config: { ...snapshot.config, enabled: false },
				meta: { ...snapshot.meta, validation: failure.meta.validation },
			};
		}
		if (branchHasSnapshot && snapshot.meta.remotePublication === undefined) {
			snapshot.meta.remotePublication = serializeRemotePublicationPolicyDocument(
				resolveRemotePublicationPolicy(undefined, { legacyRuntime: true }),
			);
		}
		if (snapshot.config.enabled && snapshot.meta.remotePublication === undefined) {
			snapshot.meta.remotePublication = serializeRemotePublicationPolicyDocument(
				resolveRemotePublicationPolicy(undefined, { legacyRuntime: true }),
			);
		}
		pendingPublication = snapshot.meta.pendingPublication === undefined
			? undefined
			: structuredClone(snapshot.meta.pendingPublication);
		if (!snapshot.config.enabled && snapshot.meta.validation?.attempt === 0) {
			ctx.ui.notify(`State Flow restored disabled: ${snapshot.meta.validation.error}`, "error");
		}
		if (retainsPhysicalSessionProjection(sessionStartReason) && runtime?.view) {
			const boundary = findPassiveStopBoundary(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
			if (boundary !== undefined) {
				const continuation = createPassiveContinuation(
					projectStateForModel(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
					boundary.at,
					boundary.from,
				);
				if (!snapshot.config.enabled) passiveContinuation = continuation;
				else if (snapshot.meta.bootstrap) bootstrapContinuation = continuation;
			}
		}
		if (!snapshot.config.enabled && (config.passiveBootstrap || config.passiveTools) && !runtime?.view) {
			try {
				runtime?.loadPassive();
				installScopeStates();
			} catch (error) {
				ctx.ui.notify(`State Flow passive memory is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		if (snapshot.config.enabled) deferArtifactRefresh();
		syncStateFlowTools();
		updateUi(ctx);
	}

	function recordDiagnostic(error: string, category: StateFlowDiagnosticCategory, ctx: ExtensionContext, extras: DiagnosticExtras = {}): void {
		diagnosticWriter.record(sessionAddress(ctx).id, ctx.cwd, error, category, extras);
	}

	function continueFallbackResolution(lastWarning: boolean): void {
		resolutionPending = true;
		pi.sendMessage({
			customType: VALIDATION_MESSAGE_TYPE,
			content: lastWarning
				? "This is the last State Flow fallback turn. The iteration's answer is preserved and will not change. Apply the final:true patch now: call patch_state with any remaining durable scope changes and final:true, or with {\"final\":true} when nothing remains. Do not restate the answer."
				: "The iteration's answer is preserved as the final response; later turns cannot replace it. Apply the final:true patch: call patch_state with any durable scope changes from this iteration (including required artifact or Skill compilation) and final:true, or with {\"final\":true} when nothing remains to persist. Do not restate the answer.",
			display: false,
		}, { deliverAs: "steer", triggerTurn: true });
	}

	/** Preserve the primary answer as this iteration's response and steer bounded fallback turns whose only purpose is the final:true patch. */
	function beginFallbackResolution(ctx: ExtensionContext, message: { content?: unknown }, reason: string): void {
		responseAwaitingReconciliation = true;
		fallbackAttempts = 0;
		fallbackFailureReported = false;
		recordDiagnostic(`Preserved the terminal draft as the iteration response; fallback resolution started: ${reason}`, "terminal-pending", ctx, {
			content: message.content,
			resolutionAttempt: 0,
			terminalEligible,
		});
		continueFallbackResolution(MAX_FALLBACK_ATTEMPTS === 1);
	}

	/** Fallback turns never become the response; they exist only to supply the final:true patch. */
	function resolveFallbackTurn(ctx: ExtensionContext, message: { content?: unknown }): any {
		let resolved = terminalEligible;
		if (resolved) {
			try {
				validateFinalEligibility(scopeStates, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
			} catch (error) {
				resolved = false;
				recordDiagnostic(error instanceof Error ? error.message : String(error), "terminal-pending", ctx, {
					content: message.content,
					resolutionAttempt: fallbackAttempts,
					terminalEligible,
				});
			}
		}
		if (resolved) {
			resolutionPending = false;
			recordDiagnostic(`Fallback resolution obtained final:true after ${fallbackAttempts} fallback turn${fallbackAttempts === 1 ? "" : "s"}; the preserved answer stands`, "finalization", ctx, {
				content: message.content,
				resolutionAttempt: fallbackAttempts,
				terminalEligible,
			});
			return { message: { ...message, role: "assistant" as const, content: [] } };
		}
		fallbackAttempts = Math.min(MAX_FALLBACK_ATTEMPTS, fallbackAttempts + 1);
		if (fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
			recordDiagnostic(`Fallback turn ended without final:true (${fallbackAttempts}/${MAX_FALLBACK_ATTEMPTS})`, "terminal-pending", ctx, {
				content: message.content,
				resolutionAttempt: fallbackAttempts,
				terminalEligible,
			});
			continueFallbackResolution(fallbackAttempts + 1 >= MAX_FALLBACK_ATTEMPTS);
			return { message: { ...message, role: "assistant" as const, content: [] } };
		}
		resolutionPending = false;
		recordDiagnostic(`Fallback resolution exhausted without final:true (${fallbackAttempts}/${MAX_FALLBACK_ATTEMPTS}); the preserved response and current state remain`, "finalization", ctx, {
			content: message.content,
			resolutionAttempt: fallbackAttempts,
			terminalEligible,
		});
		if (!fallbackFailureReported) {
			fallbackFailureReported = true;
			ctx.ui.notify(`State Flow kept the preserved answer; no final:true patch arrived after ${MAX_FALLBACK_ATTEMPTS} fallback turns, so the iteration closed with its current state.`, "warning");
		}
		return { message: { ...message, role: "assistant" as const, content: [] } };
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
					if (paths.length === 1 && /^(?:global|cwd|session)\.patches(?:\[\d+\])?$/.test(paths[0]!)) {
						if (params.projection !== undefined && params.projection !== "value") throw new Error("Scope patch paths support only the value projection");
						const result = readStatePath(runtime.view, paths[0]!);
						if (!("patch" in result)) throw new Error("Expected a scope patch path");
						return {
							content: [{ type: "text", text: `\n${JSON.stringify({ patch: result.patch })}` }],
							details: { path: paths[0], transitionId: result.boundary.id } as ReadDetails,
						};
					}
					const result = readProjectedState(runtime.view, paths, params.projection);
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
		description: "The sole State Flow semantic mutation protocol. Supply any combination of global, cwd, and session patches; all supplied scopes commit atomically. Set final:true when the current iteration may finish at a later turn_end. final:true does not stop reasoning, tools, or later patch_state calls. Use {final:true} when no semantic update is needed. This call must be the only State Flow barrier in its assistant response.",
		promptSnippet: "Atomically patch global/cwd/session; final:true permits a later turn_end",
		promptGuidelines: [
			"Use patch_state for durable semantic changes. Before a final answer, make the iteration terminal-eligible with final:true, optionally alongside atomic global/cwd/session patches.",
			"Use patch_state as reconciliation, not append-only notes: place new knowledge at the narrowest valid scope and remove superseded or completed state from touched branches.",
			"Call patch_state alone in an assistant response; after its acknowledgement, further reasoning, tools, and later patch_state calls remain allowed.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			global: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional global semantic patch" })),
			cwd: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional project semantic patch" })),
			session: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional session semantic patch" })),
			final: Type.Optional(Type.Boolean({ description: "Set exactly true to permit this iteration to finish at a later turn_end" })),
		}, { additionalProperties: false }),
		prepareArguments: normalizePatchStateArguments,
		renderResult(result, { isPartial }, theme, context) {
			const text = result.content.find((block) => block.type === "text")?.text ?? "";
			if (context.isError) return new Text(separatedOutput(text), 0, 0);
			if (isPartial || !config.showSuccessfulPatches) return new Text(text, 0, 0);
			return new Text(separatedOutput(theme.fg("dim", formatPatchStateArguments(context.args))), 0, 0);
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
				if (signal?.aborted) throw new Error("State Flow patch was aborted before materialization");
				if (!isObject(params)) throw new Error("patch_state requires an object");
				const allowed = new Set(["global", "cwd", "session", "final"]);
				for (const key of Object.keys(params)) {
					if (!allowed.has(key)) throw new Error(`patch_state does not accept field ${key}`);
				}
				if (Object.hasOwn(params, "final") && typeof params.final !== "boolean") throw new Error("patch_state final must be a Boolean when supplied");
				const patches: AtomicScopePatches = {};
				for (const scope of ["global", "cwd", "session"] as const) {
					if (!Object.hasOwn(params, scope)) continue;
					const patch = params[scope];
					if (!isObject(patch)) throw new Error(`patch_state ${scope} must be a semantic patch object`);
					if (Object.keys(patch).length === 0) throw new Error(`patch_state ${scope} cannot be empty; omit it when unchanged`);
					patches[scope] = patch;
				}
				const scopes = Object.keys(patches) as StateScope[];
				if (scopes.length === 0) {
					if (params.final === false) {
						return { content: [{ type: "text", text: "\nState unchanged; iteration remains non-terminal." }], details: { final: false } };
					}
					if (params.final !== true) throw new Error('patch_state requires at least one scope patch or {"final":true}');
					if (!snapshot.config.enabled) return { content: [{ type: "text", text: "\nState unchanged; passive turns have no terminal barrier." }], details: { final: false } };
					validateFinalEligibility(scopeStates, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
					terminalEligible = true;
					return { content: [{ type: "text", text: "\nState iteration is terminal-eligible." }], details: { final: true } };
				}
				if (!runtime?.view) {
					runtime ??= createRuntime(ctx);
					runtime.prepare();
					const publication = runtime.initialize(snapshot, true, undefined, true);
					recordPolicyPublication(publication, ctx);
					installScopeStates();
					branchHasSnapshot = true;
				}
				runtime.migrateLegacyStorage();
				installScopeStates();
				const stage = stageAtomicScopePatches(scopeStates, patches, skillReads.successful.values(), runtime.causalBasis(), artifactReads.successful.values());
				const semanticChange = (["global", "cwd", "session"] as const).some((scope) => !sameJson(scopeStates[scope], stage.nextStates[scope]));
				const provenanceChange = Object.values(stage.provenanceUpdates).some((updates) => Object.keys(updates).length > 0);
				if (!semanticChange && !provenanceChange) throw new Error('patch_state scope patches must materially update state or required provenance; omit them and use {"final":true} when unchanged');
				commitStage(stage, ctx, false);
				if (params.final === true && snapshot.config.enabled) {
					terminalEligible = true;
				}
				updateUi(ctx);
				const publication = pendingPublication === undefined ? "" : "; durable publication pending";
				return { content: [{ type: "text", text: `\nState materialized atomically at ${scopes.join("+")} scope${scopes.length === 1 ? "" : "s"}${publication}.` }], details: { scopes, final: params.final === true, step: snapshot.meta.step } };
			} catch (error) {
				let attempted: unknown;
				try { attempted = structuredClone(params); } catch { attempted = undefined; }
				recordDiagnostic(error instanceof Error ? error.message : String(error), /concurrently|advanced/.test(String(error)) ? "publication-conflict" : "invalid-patch", ctx, {
					input: attempted,
					tool: PATCH_STATE_TOOL_NAME,
					toolCallId,
					resolutionAttempt: fallbackAttempts,
					terminalEligible,
				});
				throw separatedFailure(error);
			}
		},
	});

	function startStateFlow(ctx: ExtensionContext): StateFlowTelegramControlResult {
		if (!activeContext) restoreActiveBranch(ctx);
		telegramStartPending = false;
		const previousSnapshot = structuredClone(snapshot);
		const previousPassiveContinuation = passiveContinuation;
		const previousBootstrapContinuation = bootstrapContinuation;
		const previousArtifactRefreshPending = artifactRefreshPending;
		const previousArtifactInvalidations = structuredClone(artifactInvalidations);
		try {
			if (!runtime?.view && !snapshot.meta.durableBase && !branchStartsWithoutRuntime) {
				throw new Error("Selected branch revision is unavailable; restore its original Git history before starting State Flow");
			}
			const branch = ctx.sessionManager.getBranch();
			activeContext = ctx;
			runtime ??= createRuntime(ctx);
			if (branchStartsWithoutRuntime) runtime.prepare();
			runtime.migrateLegacyStorage();
			const bootstrap = (!branchHasSnapshot || !snapshot.config.enabled)
				&& (hasPriorConversation(branch) || previousPassiveContinuation !== undefined);
			if (!runtime.view && snapshot.meta.durableBase) {
				snapshot = prepareBranchRestore(ctx, snapshot.meta.durableBase, snapshot).restore();
				setPendingPublication(snapshot.meta.pendingPublication);
				branchHasSnapshot = true;
			}
			const existingBranch = branchHasSnapshot;
			snapshot = existingBranch
				? resumeEpisode(snapshot, bootstrap)
				: startEpisode(bootstrap);
			if (snapshot.meta.remotePublication === undefined) {
				snapshot.meta.remotePublication = serializeRemotePublicationPolicyDocument(
					resolveRemotePublicationPolicy(existingBranch ? undefined : config.remotePublication, { legacyRuntime: existingBranch }),
				);
			}
			branchHasSnapshot = true;
			const publication = runtime.view
				? runtime.promote(snapshot) ?? runtime.publish(snapshot)
				: runtime.initialize(snapshot, true, undefined, branchStartsWithoutRuntime);
			recordPolicyPublication(publication, ctx);
			installScopeStates();
			clearRunTransient();
			passiveContinuation = undefined;
			bootstrapContinuation = snapshot.meta.bootstrap
				? previousPassiveContinuation ?? previousBootstrapContinuation
				: undefined;
			deferArtifactRefresh();
			syncStateFlowTools();
			persist();
			updateUi(ctx);
			ctx.ui.notify(
				snapshot.meta.bootstrap
					? "State Flow enabled. The next complete agent run will migrate active context into state."
					: "State Flow enabled. The next prompt starts a stateful agent run.",
				"info",
			);
			return { ok: true, message: "State Flow enabled" };
		} catch (error) {
			snapshot = previousSnapshot;
			passiveContinuation = previousPassiveContinuation;
			bootstrapContinuation = previousBootstrapContinuation;
			artifactRefreshPending = previousArtifactRefreshPending;
			artifactInvalidations = previousArtifactInvalidations;
			artifactReads.setCandidates(artifactInvalidations);
			syncStateFlowTools();
			const message = `State Flow could not initialize CWD state: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(message, "error");
			return { ok: false, message };
		}
	}

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			startStateFlow(ctx);
		},
	});

	pi.registerCommand("state-flow-status", {
		description: "Show State Flow runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
		},
	});

	function stopStateFlow(ctx: ExtensionContext): StateFlowTelegramControlResult {
		if (!activeContext) restoreActiveBranch(ctx);
		telegramStartPending = false;
		let selected = runtime;
		let current = snapshot;
		if (!selected?.view && snapshot.meta.durableBase) {
			selected = createRuntime(ctx);
			current = selected.restore(snapshot.meta.durableBase, snapshot);
		}
		const stoppedAt = Date.now();
		const exitStates = selected?.view ? selected.states() : undefined;
		const exitHandoff = current.config.enabled && exitStates
			? createPassiveContinuation(
				projectStateForModel(overlayStates(exitStates.global, exitStates.cwd, exitStates.session)),
				stoppedAt,
				ctx.isIdle() ? undefined : runAnchorTimestamp,
			)
			: undefined;
		const retainedHandoff = exitHandoff ?? (!current.config.enabled ? passiveContinuation : undefined);
		const stopped = stopEpisode(current);
		const publication = selected?.view ? selected.publish(stopped) : undefined;
		if (selected !== runtime) {
			runtime = selected;
			installScopeStates();
		}
		snapshot = stopped;
		recordPolicyPublication(publication, ctx);
		branchHasSnapshot = true;
		clearRunTransient();
		passiveContinuation = retainedHandoff;
		bootstrapContinuation = undefined;
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = false;
		if (exitHandoff) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
			at: stoppedAt,
			...(exitHandoff.activeRunStartedAt === undefined ? {} : { from: exitHandoff.activeRunStartedAt }),
		});
		syncStateFlowTools();
		persist();
		updateUi(ctx);
		return { ok: true, message: "State Flow disabled" };
	}

	pi.registerCommand("state-flow-stop", {
		description: "Stop State Flow on the current session branch",
		handler: async (_args, ctx) => {
			stopStateFlow(ctx);
		},
	});

	const telegram = createStateFlowTelegramAdapter({
		...(options.telegram?.load === undefined ? {} : { load: options.telegram.load }),
		port: {
			snapshot: () => ({
				enabled: snapshot.config.enabled,
				step: snapshot.meta.step,
				bootstrap: snapshot.meta.bootstrap === true,
				startPending: telegramStartPending,
			}),
			state: (scope) => {
				const selected = scope === "effective"
					? overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)
					: scopeStates[scope];
				return {
					...projectStateForModel(selected),
					...(Object.hasOwn(selected, "lazy") ? { lazy: structuredClone(selected.lazy) } : {}),
				};
			},
			canStartNow: () => activeContext === undefined || activeContext.isIdle(),
			start: () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				return startStateFlow(activeContext);
			},
			stop: () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				try {
					return stopStateFlow(activeContext);
				} catch (error) {
					return { ok: false, message: error instanceof Error ? error.message : String(error) };
				}
			},
			deferStart: () => {
				telegramStartPending = true;
			},
			cancelStart: () => {
				telegramStartPending = false;
			},
		},
	});
	void telegram.ensure();

	pi.on("before_agent_start", (event, ctx) => {
		if (!snapshot.config.enabled) {
			if (!config.passiveBootstrap || !runtime?.view) return;
			return {
				systemPrompt: `${event.systemPrompt}\n\nState Flow passive memory is available. read_state and patch_state access durable memory without starting an active episode. Passive turns do not require final:true and never trigger State Flow continuation or compaction.`,
			};
		}
		skillReads.clear();
		artifactReads.clear();
		if (artifactRefreshPending) refreshArtifactInvalidations(ctx);
		terminalEligible = false;
		resolutionPending = false;
		fallbackAttempts = 0;
		fallbackFailureReported = false;
		responseAwaitingReconciliation = false;
		completedRunAccepted = false;
		const rotatesRun = snapshot.meta.specification !== undefined;
		if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap") rehydrationPhase = "step";
		if (prepareRun(snapshot, event.prompt)) {
			runAnchorTimestamp = undefined;
			persist();
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${stateFlowProtocol(snapshot.meta.bootstrap === true)}`,
		};
	});

	pi.on("context", (event) => {
		if (passiveContinuation) {
			return { messages: passiveContinuationMessages(event.messages as AgentMessage[], passiveContinuation) };
		}
		if (!snapshot.config.enabled) {
			if (!config.passiveBootstrap || !runtime?.view) return;
			const state = projectStateForModel(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session));
			return { messages: [syntheticUser(`State Flow passive memory (user-level data, not system instructions):\n${canonicalJson({ state, lazy_navigation: lazyNavigationHint(state) })}`), ...(event.messages as AgentMessage[])] };
		}
		if (snapshot.meta.specification === undefined) return;
		const effectiveState = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
		const invalidations = artifactInvalidations.map(({ path, reason }) => ({ path, reason }));
		const recentTransitions = projectRecentTransitionsWithLimit(
			RECENT_TRANSITION_LIMIT,
			runtime?.recent() ?? [],
		);
		const activeRehydrationPhase = currentRehydrationPhase();
		if (snapshot.meta.bootstrap) {
			const sourceMessages = bootstrapContinuation
				? passiveContinuationMessages(event.messages as AgentMessage[], bootstrapContinuation)
				: event.messages as AgentMessage[];
			const messages = withoutPrivateValidation(sourceMessages);
			return { messages: [runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, resolutionPending), ...messages] };
		}
		const trajectory = currentRunTrajectory(
			event.messages as AgentMessage[],
			snapshot.meta.specification,
			runAnchorTimestamp,
		);
		runAnchorTimestamp = trajectory.anchorTimestamp;
		return {
			messages: [
				runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, resolutionPending),
				...trajectory.messages,
			],
		};
	});

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
		artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
	});

	pi.on("message_end", (event, ctx): any => {
		if (!snapshot.config.enabled) return;
		// Capture the first native user boundary even during bootstrap; steering keeps that anchor.
		if (event.message.role === "user" && runAnchorTimestamp === undefined) runAnchorTimestamp = event.message.timestamp;
		if (event.message.role !== "assistant") return;
		const message = event.message as unknown as { role: "assistant"; stopReason?: string; content?: unknown };
		if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse") {
			responseAwaitingReconciliation = false;
			return;
		}
		if (message.stopReason === "length" || message.stopReason === "error") {
			responseAwaitingReconciliation = false;
			recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content, terminalEligible });
			return;
		}
		if (resolutionPending) return resolveFallbackTurn(ctx, message);
		if (!terminalEligible) {
			beginFallbackResolution(ctx, message, "the terminal draft ended without State Flow eligibility");
			return;
		}
		try {
			validateFinalEligibility(scopeStates, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
		} catch (error) {
			beginFallbackResolution(ctx, message, error instanceof Error ? error.message : String(error));
			return;
		}
		responseAwaitingReconciliation = true;
	});

	pi.on("turn_end", (event, ctx) => {
		const wasBootstrap = snapshot.meta.bootstrap === true;
		if (!snapshot.config.enabled || !responseAwaitingReconciliation) {
			updateUi(ctx);
			return;
		}
		let responseCommitted = false;
		const specification = snapshot.meta.specification;
		try {
			const response = finalizedAssistantResponse(event.message);
			const stage = stageScopedTransition(scopeStates, { transitions: [], response }, [], runtime!.causalBasis());
			completeRun(snapshot);
			commitStage(stage, ctx, true);
			responseCommitted = true;
			bootstrapContinuation = undefined;
			rehydrationPhase = "step";
			enqueueTurnPublication();
			if (snapshot.meta.remotePublication?.mode === "turn-end") publicationWorker.launch();
			completedRunAccepted = !wasBootstrap;
		} catch (error) {
			if (!responseCommitted && specification !== undefined) snapshot.meta.specification = specification;
			recordDiagnostic(error instanceof Error ? error.message : String(error), "finalization", ctx);
			ctx.ui.notify(responseCommitted
				? `State Flow committed the final response; remote publication is deferred: ${error instanceof Error ? error.message : String(error)}`
				: `State Flow could not reconcile the final response: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			responseAwaitingReconciliation = false;
		}
		updateUi(ctx);
	});

	pi.on("session_before_compact", (event) => {
		if (!compactionPlan) return;
		if (compactionStopped && event.reason === "manual" && event.customInstructions === compactionMarker) return { cancel: true };
		const result = stateFlowCompactionResult(compactionPlan, compactionMarker, event);
		if (result === undefined || "cancel" in result) return result;
		return { compaction: result };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (telegramStartPending && !snapshot.config.enabled) {
			telegramStartPending = false;
			startStateFlow(ctx);
		}
		if (snapshot.meta.remotePublication?.mode === "turn-end") publicationWorker.launch();
		if (!completedRunAccepted || compactionStopped || !snapshot.config.enabled || snapshot.meta.bootstrap || resolutionPending
			|| compactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !snapshot.meta.durableBase
			|| !shouldRequestStateFlowCompaction(ctx.getContextUsage())) return;
		completedRunAccepted = false;
		const entries = ctx.sessionManager.buildContextEntries();
		if (!hasCompactionSizedTranscript(entries)) return;
		const plan = planStateFlowCompaction(entries, snapshot.meta.durableBase, snapshot.meta.step);
		if (!plan) return;
		compactionPlan = plan;
		compactionInFlight = true;
		ctx.compact({
			customInstructions: compactionMarker,
			onComplete: () => { compactionPlan = undefined; compactionInFlight = false; },
			onError: () => { compactionPlan = undefined; compactionInFlight = false; },
		});
	});

	pi.on("session_start", (event, ctx) => {
		rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
		restoreActiveBranch(ctx, event.reason);
		retryPendingPush(ctx);
		if (snapshot.meta.remotePublication?.mode === "turn-end") publicationWorker.launch();
		updateUi(ctx);
		void telegram.ensure();
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreActiveBranch(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		telegramStartPending = false;
		compactionStopped = true;
		completedRunAccepted = false;
		telegram.dispose();
		return shutdownPublicationWorkers(ctx);
	});
}
