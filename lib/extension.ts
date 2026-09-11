import { execFile } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assistantToolCallCount, finalizedAssistantResponse, stateFlowProtocol } from "./terminal.ts";
import { createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, runtimeContextMessage, VALIDATION_MESSAGE_TYPE, withoutPrivateValidation, type PassiveContinuation } from "./context.ts";
import { ArtifactReadTracker } from "./acquisition.ts";
import { loadStateFlowConfig } from "./config.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SkillReadTracker } from "./skills.ts";
import { emptySnapshot, migrationFailure, persistableSnapshot, type Snapshot } from "./snapshot.ts";
import { inspectSnapshotRevision, TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { emptyState, overlayStates, projectStateForModel, type AtomicScopePatches, type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition, validateFinalEligibility, type StagedScopedTransition } from "./transition.ts";
import { discoverSnapshotData, hasPriorConversation, isNewSession, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type PendingPublicationDiagnostic, type StatusDiagnostics } from "./status.ts";
import { prepareRun, resumeEpisode, startEpisode, stopEpisode } from "./episode.ts";
import { recoverSnapshot } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { resolveRemotePublicationPolicy, serializeRemotePublicationPolicyDocument } from "./publication.ts";
import { coalescePublicationTarget, createPublicationQueue, type PublicationQueueState } from "./publication.ts";
import { acquirePublicationWorkerLease, loadPublicationQueue, publicationQueuePath, removePublicationQueue, savePublicationQueue } from "./publication.ts";
import { runPublicationWorker } from "./publication.ts";
import { getKnowledgeRoot, GlobalMarkdownDiscovery } from "./discovery.ts";
import { isObject, sameJson } from "./json.ts";
import {
	cwdScopeKey,
	resolveSessionAddress,
	sessionScopeKey,
	type SessionAddress,
} from "./durable.ts";
import { projectRecentTransitionsWithLimit, RECENT_TRANSITION_LIMIT } from "./history.ts";
import { appendStateFlowDiagnostic, projectDiagnosticContent, stateFlowLogPath, type StateFlowDiagnosticCategory } from "./logging.ts";
import { isGitCommitAncestor, pushGitCommit, resolveGitPushDestination } from "./git.ts";
import {
	ORDINARY_ARTIFACT_COMPILER,
	planArtifactInvalidation,
	type ArtifactInvalidationRequest,
} from "./artifact.ts";

export interface StateFlowExtensionOptions {
	agentDir?: string;
	repositoryRoot?: string;
	knowledgeRoot?: string;
	onRuntime?: (accessor: { read(offset?: number, scope?: StateScope): MaterializedState }) => void;
}

export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
export const MAX_RESOLUTION_ATTEMPTS = 3;
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";

/** Keep a failed tool invocation visually separated from its rendered error without changing error semantics. */
function separatedFailure(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`\n${message}`, error instanceof Error ? { cause: error } : undefined);
}

export default function stateFlowExtension(pi: ExtensionAPI, options: StateFlowExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const config = loadStateFlowConfig(agentDir);
	let snapshot: Snapshot = emptySnapshot();
	let scopeStates: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let branchHasSnapshot = false;
	let branchStartsWithoutRuntime = false;
	let terminalEligible = false;
	let terminalDraftIntercepted = false;
	let resolutionAttempts = 0;
	let resolutionFailureReported = false;
	let responseAwaitingReconciliation = false;
	let passiveContinuation: PassiveContinuation | undefined;
	let bootstrapContinuation: PassiveContinuation | undefined;
	let artifactRefreshPending = false;
	let runAnchorTimestamp: number | undefined;
	let runtime: TemporalRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingPublication: PendingPublicationDiagnostic | undefined;
	let rehydrationPhase: RehydrationPhase | undefined;
	let turnPublicationTarget: string | undefined;
	const activePublicationWorkers = new Set<string>();
	const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
	const skillReads = new SkillReadTracker();
	const artifactReads = new ArtifactReadTracker();
	const globalMarkdown = new GlobalMarkdownDiscovery(options.knowledgeRoot ?? getKnowledgeRoot(agentDir));
	let artifactInvalidations: ArtifactInvalidationRequest[] = [];
	let loggingWarningReported = false;

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
		terminalDraftIntercepted = false;
		resolutionAttempts = 0;
		resolutionFailureReported = false;
		responseAwaitingReconciliation = false;
		runAnchorTimestamp = undefined;
		skillReads.clear();
		artifactReads.clear();
	}

	function passiveStopTimestamp(ctx: ExtensionContext): number | undefined {
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			try {
				if (entry?.type !== "custom" || entry.customType !== PASSIVE_STOP_ENTRY_TYPE) continue;
				const at = (entry.data as { at?: unknown } | undefined)?.at;
				if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) return at;
			} catch {
				// A hostile unrelated branch entry cannot manufacture or suppress a valid marker.
			}
		}
		return undefined;
	}

	function retainsPhysicalSessionProjection(reason: unknown): boolean {
		return reason === undefined || reason === "startup" || reason === "reload" || reason === "resume";
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
			const discovery = globalMarkdown.refresh();
			const plan = planArtifactInvalidation(
				discovery.sources,
				scopeStates.global.artifacts,
				ORDINARY_ARTIFACT_COMPILER,
				{},
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

	function syncStateFlowTools(): void {
		const active = pi.getActiveTools();
		const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
		if (owned.every((name) => active.includes(name) === snapshot.config.enabled)) return;
		pi.setActiveTools(snapshot.config.enabled
			? [...new Set([...active, ...owned])]
			: active.filter((name) => !owned.includes(name)));
	}

	function assistantToolBatch(ctx: ExtensionContext, toolCallId: string): string[] | undefined {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
			if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
			const calls = entry.message.content.filter((block): block is { type: "toolCall"; id: string; name: string } => {
				return typeof block === "object" && block !== null
					&& (block as { type?: unknown }).type === "toolCall"
					&& typeof (block as { id?: unknown }).id === "string"
					&& typeof (block as { name?: unknown }).name === "string";
			});
			if (calls.some(({ id }) => id === toolCallId)) return calls.map(({ name }) => name);
		}
		return undefined;
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
			launchPublicationWorker();
		} catch (error) {
			ctx.ui.notify(
				`State Flow accepted the local commit; remote publication is deferred: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function commitStage(stage: StagedScopedTransition, ctx: ExtensionContext, finalizeRun: boolean): boolean {
		const acquiredArtifactPaths = new Set(artifactReads.successful.keys());
		const committed = commitScopedTransition(snapshot, scopeStates, stage, (accepted, nextSnapshot) => {
			if (!runtime?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			const mode = nextSnapshot.meta.remotePublication?.mode ?? "transition";
			const publication = runtime.publish(nextSnapshot, accepted !== undefined, accepted, {
				pushRemote: mode === "transition",
				provenance: stage.provenanceUpdates,
			});
			if (publication?.commit && mode === "turn-end") turnPublicationTarget = publication.commit;
			if (publication) recordPublication(publication, ctx);
		}, runtime!.causalBasis(), { finalizeRun });
		if (!committed) return false;
		installScopeStates();
		artifactInvalidations = artifactInvalidations.filter(({ path }) => !acquiredArtifactPaths.has(path));
		artifactReads.setCandidates(artifactInvalidations);
		skillReads.clear();
		artifactReads.clear();
		persist();
		return true;
	}

	function enqueueTurnPublication(): void {
		const target = turnPublicationTarget;
		turnPublicationTarget = undefined;
		if (!target) return;
		const destination = resolveGitPushDestination(repositoryRoot);
		if (!destination) return;
		const path = publicationQueuePath(destination);
		const previous = loadPublicationQueue(path);
		const next = previous
			? coalescePublicationTarget(previous, destination, target, (ancestor, descendant) => isGitCommitAncestor(repositoryRoot, ancestor, descendant))
			: createPublicationQueue(destination, target);
		savePublicationQueue(path, next, previous);
	}

	function launchPublicationWorker(): void {
		let destination: ReturnType<typeof resolveGitPushDestination>;
		try {
			destination = resolveGitPushDestination(repositoryRoot);
		} catch (error) {
			if (error instanceof Error && /ENOENT/.test(error.message)) return;
			throw error;
		}
		if (!destination) return;
		const path = publicationQueuePath(destination);
		if (activePublicationWorkers.has(path)) return;
		let queued: PublicationQueueState | undefined;
		let lease: ReturnType<typeof acquirePublicationWorkerLease>;
		try {
			queued = loadPublicationQueue(path);
			if (!queued) return;
			lease = acquirePublicationWorkerLease(path);
		} catch {
			return;
		}
		if (!lease) return;
		activePublicationWorkers.add(path);
		void runPublicationWorker(
			queued,
			({ target }) => new Promise<void>((resolve, reject) => {
				execFile("git", ["-C", repositoryRoot, "push", destination.remote, `${target}:${destination.ref}`], {
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
				}, (error) => error ? reject(error) : resolve());
			}),
			() => loadPublicationQueue(path) ?? queued,
			(ancestor, descendant) => isGitCommitAncestor(repositoryRoot, ancestor, descendant),
		).then((result) => {
			const current = loadPublicationQueue(path);
			if (!current) return;
			if (result.next === undefined) {
				if (current.target === result.attempted.target) removePublicationQueue(path, current);
				return;
			}
			if (current.target === result.attempted.target || result.next.target === current.target) {
				savePublicationQueue(path, result.next, current);
			}
		}).catch(() => {
			// Queue/CAS truth remains durable; status and a later activation expose retry.
		}).finally(() => {
			activePublicationWorkers.delete(path);
			lease.release();
			try {
				if (loadPublicationQueue(path)?.status === "pending") launchPublicationWorker();
			} catch {
				// Malformed queue persistence stays inert until an explicit retry or repair.
			}
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
					launchPublicationWorker();
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
				const discovery = globalMarkdown.refresh();
				const plan = planArtifactInvalidation(
					discovery.sources,
					diagnosticStates.global.artifacts,
					ORDINARY_ARTIFACT_COMPILER,
					{},
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

	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown): void {
		clearRunTransient();
		passiveContinuation = undefined;
		bootstrapContinuation = undefined;
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = false;
		activeContext = ctx;
		const session = sessionAddress(ctx);
		runtime = new TemporalRuntime(ctx.cwd, session, repositoryRoot);
		installScopeStates();
		pendingPublication = undefined;
		branchHasSnapshot = false;
		branchStartsWithoutRuntime = false;
		try {
			const branch = ctx.sessionManager.getBranch();
			const discovery = discoverSnapshotData(branch);
			const recovery = recoverSnapshot(discovery.candidates, (revision, legacy) =>
				inspectSnapshotRevision(ctx.cwd, session.id, repositoryRoot, revision, legacy, session.key).snapshot);
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
					snapshot = runtime.restore(selectedRevision, snapshot);
					if (snapshot.meta.durableBase !== selectedRevision) persist();
				} else if (branchHasSnapshot && snapshot.config.enabled) {
					const publication = runtime.initialize(snapshot, true);
					recordPolicyPublication(publication, ctx);
					delete snapshot.legacySession;
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
			const stoppedAt = passiveStopTimestamp(ctx);
			if (stoppedAt !== undefined) {
				const continuation = createPassiveContinuation(
					projectStateForModel(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
					stoppedAt,
				);
				if (!snapshot.config.enabled) passiveContinuation = continuation;
				else if (snapshot.meta.bootstrap) bootstrapContinuation = continuation;
			}
		}
		if (snapshot.config.enabled) deferArtifactRefresh();
		syncStateFlowTools();
		updateUi(ctx);
	}

	interface DiagnosticExtras {
		content?: unknown;
		input?: unknown;
		tool?: string;
		toolCallId?: string;
		resolutionAttempt?: number;
		terminalEligible?: boolean;
	}

	function recordDiagnostic(error: string, category: StateFlowDiagnosticCategory, ctx: ExtensionContext, extras: DiagnosticExtras = {}): void {
		if (!config.logging) return;
		try {
			const path = stateFlowLogPath(agentDir);
			const fromRepository = relative(repositoryRoot, path);
			if (fromRepository === "" || (!isAbsolute(fromRepository) && fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`))) {
				throw new Error("diagnostic path overlaps the State Flow repository");
			}
			appendStateFlowDiagnostic(path, {
				at: new Date().toISOString(),
				sessionId: sessionAddress(ctx).id,
				cwd: resolve(ctx.cwd),
				category,
				error,
				...(extras.content === undefined ? {} : { content: projectDiagnosticContent(extras.content) }),
				...(extras.input === undefined ? {} : { input: extras.input }),
				...(extras.tool === undefined ? {} : { tool: extras.tool }),
				...(extras.toolCallId === undefined ? {} : { toolCallId: extras.toolCallId }),
				...(extras.resolutionAttempt === undefined ? {} : { resolutionAttempt: extras.resolutionAttempt }),
				...(extras.terminalEligible === undefined ? {} : { terminalEligible: extras.terminalEligible }),
			});
		} catch (failure) {
			if (loggingWarningReported) return;
			loggingWarningReported = true;
			ctx.ui.notify(`State Flow could not write diagnostics: ${failure instanceof Error ? failure.message : String(failure)}`, "warning");
		}
	}

	function continueForResolution(): void {
		terminalDraftIntercepted = true;
		pi.sendMessage({
			customType: VALIDATION_MESSAGE_TYPE,
			content: "Before completing this turn, make the State Flow iteration terminal-eligible. Call patch_state with any durable scope changes and final:true, or call patch_state with {\"final\":true} when no semantic update is needed. Then provide the final answer normally.",
			display: false,
		}, { deliverAs: "steer", triggerTurn: true });
	}

	/** Accept a terminal draft once the resolution budget is exhausted; a user-visible answer is never discarded. */
	function acceptUnresolvedDraft(ctx: ExtensionContext, message: { content?: unknown }): void {
		terminalDraftIntercepted = false;
		responseAwaitingReconciliation = true;
		if (resolutionFailureReported) return;
		resolutionFailureReported = true;
		recordDiagnostic(`Terminal draft accepted after the resolution budget was exhausted (attempt ${resolutionAttempts}/${MAX_RESOLUTION_ATTEMPTS})`, "finalization", ctx, {
			content: message.content,
			resolutionAttempt: resolutionAttempts,
			terminalEligible,
		});
		ctx.ui.notify(`State Flow accepted the final draft after ${MAX_RESOLUTION_ATTEMPTS} terminal attempts; unresolved state obligations may remain.`, "warning");
	}

	pi.registerTool({
		name: READ_STATE_TOOL_NAME,
		label: "Read State",
		description: "Read one effective or scoped State Flow materialization at offset 0–7 in the active causal lineage. Read-only and lazy; unavailable pre-origin history is an error. Use only for a concrete historical or scope-specific gap, not routine rereading of current context.",
		promptSnippet: "Read one cached effective/global/CWD/session state at temporal offset 0–7",
		parameters: Type.Object({
			offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 7, description: "Accepted transitions before current state; defaults to 0" })),
			scope: Type.Optional(StringEnum(["effective", "global", "cwd", "session"] as const, { description: "Projection at that same boundary; defaults to effective" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal) {
			try {
				if (!snapshot.config.enabled) throw new Error("State Flow is disabled on this session branch");
				if (signal?.aborted) throw new Error("State Flow read was aborted");
				if (!runtime?.view) throw new Error("State Flow temporal runtime is unavailable");
				const { offset = 0, scope = "effective" } = params;
				const state = runtime.read(offset, scope === "effective" ? undefined : scope);
				const boundary = runtime.view.lineage.at(-1 - offset)!;
				return {
					content: [{ type: "text", text: `\n${JSON.stringify({ offset, scope, boundary, state: projectStateForModel(state) })}` }],
					details: { offset, scope, transitionId: boundary.id },
				};
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
			"Call patch_state alone in an assistant response; after its acknowledgement, further reasoning, tools, and later patch_state calls remain allowed.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			global: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional global semantic patch" })),
			cwd: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional project semantic patch" })),
			session: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional session semantic patch" })),
			final: Type.Optional(Type.Boolean({ description: "Set exactly true to permit this iteration to finish at a later turn_end" })),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (!snapshot.config.enabled) throw new Error("State Flow is disabled on this session branch");
				if (signal?.aborted) throw new Error("State Flow patch was aborted before materialization");
				if (!isObject(params)) throw new Error("patch_state requires an object");
				const allowed = new Set(["global", "cwd", "session", "final"]);
				for (const key of Object.keys(params)) {
					if (!allowed.has(key)) throw new Error(`patch_state does not accept field ${key}`);
				}
				if (Object.hasOwn(params, "final") && params.final !== true) throw new Error("patch_state final must be exactly true when supplied");
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
					if (params.final !== true) throw new Error('patch_state requires at least one scope patch or {"final":true}');
					validateFinalEligibility(scopeStates, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
					terminalEligible = true;
					terminalDraftIntercepted = false;
					return { content: [{ type: "text", text: "\nState iteration is terminal-eligible." }], details: { final: true } };
				}
				const stage = stageAtomicScopePatches(scopeStates, patches, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
				const semanticChange = (["global", "cwd", "session"] as const).some((scope) => !sameJson(scopeStates[scope], stage.nextStates[scope]));
				const provenanceChange = Object.values(stage.provenanceUpdates).some((updates) => Object.keys(updates).length > 0);
				if (!semanticChange && !provenanceChange) throw new Error('patch_state scope patches must materially update state or required provenance; omit them and use {"final":true} when unchanged');
				commitStage(stage, ctx, false);
				if (params.final === true) {
					terminalEligible = true;
					terminalDraftIntercepted = false;
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
					resolutionAttempt: resolutionAttempts,
					terminalEligible,
				});
				throw separatedFailure(error);
			}
		},
	});

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			if (!activeContext) restoreActiveBranch(ctx);
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
				const bootstrap = (!branchHasSnapshot || !snapshot.config.enabled)
					&& (hasPriorConversation(branch) || previousPassiveContinuation !== undefined);
				if (!runtime.view && snapshot.meta.durableBase) {
					snapshot = runtime.restore(snapshot.meta.durableBase, snapshot);
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
				delete snapshot.legacySession;
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
			} catch (error) {
				snapshot = previousSnapshot;
				passiveContinuation = previousPassiveContinuation;
				bootstrapContinuation = previousBootstrapContinuation;
				artifactRefreshPending = previousArtifactRefreshPending;
				artifactInvalidations = previousArtifactInvalidations;
				artifactReads.setCandidates(artifactInvalidations);
				syncStateFlowTools();
				ctx.ui.notify(
					`State Flow could not initialize CWD state: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("state-flow-status", {
		description: "Show State Flow runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
		},
	});

	pi.registerCommand("state-flow-stop", {
		description: "Stop State Flow on the current session branch",
		handler: async (_args, ctx) => {
			if (!activeContext) restoreActiveBranch(ctx);
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
			if (exitHandoff) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { at: stoppedAt });
			syncStateFlowTools();
			persist();
			updateUi(ctx);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!snapshot.config.enabled) return;
		skillReads.clear();
		artifactReads.clear();
		if (artifactRefreshPending) refreshArtifactInvalidations(ctx);
		terminalEligible = false;
		terminalDraftIntercepted = false;
		resolutionAttempts = 0;
		resolutionFailureReported = false;
		responseAwaitingReconciliation = false;
		const rotatesRun = snapshot.meta.specification !== undefined;
		if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap") rehydrationPhase = "step";
		if (prepareRun(snapshot, event.prompt)) {
			if (rotatesRun) runAnchorTimestamp = undefined;
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
		if (!snapshot.config.enabled || snapshot.meta.specification === undefined) return;
		const effectiveState = projectStateForModel(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session));
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
			return { messages: [runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, terminalDraftIntercepted), ...messages] };
		}
		const trajectory = currentRunTrajectory(
			event.messages as AgentMessage[],
			snapshot.meta.specification,
			runAnchorTimestamp,
		);
		runAnchorTimestamp = trajectory.anchorTimestamp;
		return {
			messages: [
				runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, terminalDraftIntercepted),
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
		const batch = assistantToolBatch(ctx, event.toolCallId);
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
		if (!snapshot.config.enabled || event.message.role !== "assistant") return;
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
		if (!terminalEligible) {
			resolutionAttempts = Math.min(MAX_RESOLUTION_ATTEMPTS, resolutionAttempts + 1);
			if (resolutionAttempts < MAX_RESOLUTION_ATTEMPTS) {
				responseAwaitingReconciliation = false;
				terminalDraftIntercepted = true;
				recordDiagnostic(`Terminal draft intercepted before State Flow eligibility (attempt ${resolutionAttempts}/${MAX_RESOLUTION_ATTEMPTS})`, "terminal-pending", ctx, {
					content: message.content,
					resolutionAttempt: resolutionAttempts,
					terminalEligible,
				});
				continueForResolution();
				return { message: { ...message, role: "assistant" as const, content: [] } };
			}
			acceptUnresolvedDraft(ctx, message);
			return;
		}
		try {
			validateFinalEligibility(scopeStates, skillReads.successful.values(), runtime!.causalBasis(), artifactReads.successful.values());
		} catch (error) {
			resolutionAttempts = Math.min(MAX_RESOLUTION_ATTEMPTS, resolutionAttempts + 1);
			if (resolutionAttempts < MAX_RESOLUTION_ATTEMPTS) {
				responseAwaitingReconciliation = false;
				terminalDraftIntercepted = true;
				recordDiagnostic(error instanceof Error ? error.message : String(error), "terminal-pending", ctx, { content: message.content, terminalEligible, resolutionAttempt: resolutionAttempts });
				continueForResolution();
				return { message: { ...message, role: "assistant" as const, content: [] } };
			}
			acceptUnresolvedDraft(ctx, message);
			return;
		}
		responseAwaitingReconciliation = true;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!snapshot.config.enabled || !responseAwaitingReconciliation) {
			updateUi(ctx);
			return;
		}
		try {
			const response = finalizedAssistantResponse(event.message);
			const stage = stageScopedTransition(scopeStates, { transitions: [], response }, [], runtime!.causalBasis());
			commitStage(stage, ctx, true);
			bootstrapContinuation = undefined;
			rehydrationPhase = "step";
			enqueueTurnPublication();
			if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
		} catch (error) {
			recordDiagnostic(error instanceof Error ? error.message : String(error), "finalization", ctx);
			ctx.ui.notify(`State Flow could not reconcile the final response: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			responseAwaitingReconciliation = false;
			terminalDraftIntercepted = false;
		}
		updateUi(ctx);
	});

	pi.on("agent_settled", (_event, _ctx) => {
		if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
	});

	pi.on("session_start", (event, ctx) => {
		rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
		restoreActiveBranch(ctx, event.reason);
		retryPendingPush(ctx);
		if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
		updateUi(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreActiveBranch(ctx);
	});
}
