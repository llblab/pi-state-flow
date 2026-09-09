import { execFile } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantToolCallCount, finalizedAssistantResponse, parseTerminalPatch, stateFlowProtocol, stripStateComments } from "./terminal.ts";
import { currentRunTrajectory, runtimeContextMessage, VALIDATION_MESSAGE_TYPE, withoutPrivateValidation } from "./context.ts";
import { ArtifactReadTracker } from "./acquisition.ts";
import { loadStateFlowConfig } from "./config.ts";
import { resolve } from "node:path";
import { SkillReadTracker } from "./skills.ts";
import { emptySnapshot, migrationFailure, persistableSnapshot, type Snapshot } from "./snapshot.ts";
import { inspectSnapshotRevision, TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { emptyState, overlayStates, type MaterializedState, type ScopePatch, type ScopedStates, type StateScope } from "./state.ts";
import { commitScopedTransition, stageScopedPatch, stageScopedTransition, type StagedScopedTransition } from "./transition.ts";
import { MAX_VALIDATION_RETRIES, nextValidation } from "./validation.ts";
import { discoverSnapshotData, hasPriorConversation, isNewSession, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type PendingPublicationDiagnostic, type StatusDiagnostics } from "./status.ts";
import { abandonValidation, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "./episode.ts";
import { recoverSnapshot } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { resolveRemotePublicationPolicy, serializeRemotePublicationPolicyDocument } from "./publication.ts";
import { coalescePublicationTarget, createPublicationQueue, type PublicationQueueState } from "./publication.ts";
import { acquirePublicationWorkerLease, loadPublicationQueue, publicationQueuePath, removePublicationQueue, savePublicationQueue } from "./publication.ts";
import { runPublicationWorker } from "./publication.ts";
import { getKnowledgeRoot, GlobalMarkdownDiscovery } from "./discovery.ts";
import {
	cwdScopeKey,
	resolveSessionAddress,
	sessionScopeKey,
	type SessionAddress,
} from "./durable.ts";
import { projectRecentTransitionsWithLimit } from "./history.ts";
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

export default function stateFlowExtension(pi: ExtensionAPI, options: StateFlowExtensionOptions = {}): void {
	const config = loadStateFlowConfig(options.agentDir);
	let snapshot: Snapshot = emptySnapshot();
	let scopeStates: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let branchHasSnapshot = false;
	let branchStartsWithoutRuntime = false;
	let stagedFinal: StagedScopedTransition | undefined;
	let retryQueued = false;
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
	const globalMarkdown = new GlobalMarkdownDiscovery(options.knowledgeRoot ?? getKnowledgeRoot(options.agentDir));
	let artifactInvalidations: ArtifactInvalidationRequest[] = [];

	function sessionAddress(ctx: ExtensionContext): SessionAddress {
		return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
	}

	function createRuntime(ctx: ExtensionContext): TemporalRuntime {
		return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot);
	}

	options.onRuntime?.({ read: (offset, scope) => {
		if (!runtime) throw new Error("State Flow temporal runtime is unavailable");
		return runtime.read(offset, scope);
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
		stagedFinal = undefined;
		retryQueued = false;
		runAnchorTimestamp = undefined;
		skillReads.clear();
		artifactReads.clear();
	}

	function refreshArtifactInvalidations(ctx: ExtensionContext): void {
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
			);
			artifactInvalidations = structuredClone(plan.requiresCompilation);
			if (plan.removed.length > 0) {
				const removals = Object.fromEntries(plan.removed.map((path) => [path, null]));
				const stage = stageScopedPatch(
					scopeStates,
					{ scope: "global", patch: { artifacts: removals } },
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

	function commitStage(stage: StagedScopedTransition, ctx: ExtensionContext, finalizeRun: boolean): boolean {
		const acquiredArtifactPaths = new Set(artifactReads.successful.keys());
		const committed = commitScopedTransition(snapshot, scopeStates, stage, (accepted, nextSnapshot) => {
			if (!runtime?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
			const mode = nextSnapshot.meta.remotePublication?.mode ?? "transition";
			const publication = runtime.publish(nextSnapshot, accepted !== undefined, accepted, { pushRemote: mode === "transition" });
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
			if (loadPublicationQueue(path)?.status === "pending") launchPublicationWorker();
		});
	}

	function retryPendingPush(ctx: ExtensionContext): void {
		if (pendingPublication === undefined || !runtime?.view) return;
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
			retryQueued,
			...(publicationQueue === undefined ? {} : { publicationQueue }),
			...(publicationQueueError === undefined ? {} : { publicationQueueError }),
		};
	}

	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown): void {
		clearRunTransient();
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
					if (publication) recordPublication(publication, ctx);
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
				if (initialization) recordPublication(initialization, ctx);
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
		syncStateFlowTools();
		updateUi(ctx);
	}

	function abandonRun(ctx: ExtensionContext): void {
		const changed = abandonValidation(snapshot);
		clearRunTransient();
		if (changed) persist();
		updateUi(ctx);
	}

	function queueTerminalRegeneration(error: string, ctx: ExtensionContext): void {
		const decision = nextValidation(snapshot.meta.validation, error);
		if (decision.kind === "retry") {
			snapshot.meta.validation = decision.feedback;
			persist();
			retryQueued = true;
			pi.sendMessage({
				customType: VALIDATION_MESSAGE_TYPE,
				content: `State Flow rejected the terminal response (attempt ${decision.feedback.attempt}/${MAX_VALIDATION_RETRIES}). ${decision.feedback.instruction}`,
				display: false,
			}, { deliverAs: "steer", triggerTurn: true });
			return;
		}
		retryQueued = false;
		snapshot.meta.validation = undefined;
		skillReads.clear();
		artifactReads.clear();
		persist();
		ctx.ui.notify(`State Flow remains enabled after ${MAX_VALIDATION_RETRIES} automatic regeneration attempts; the last committed state was preserved: ${decision.error}`, "error");
	}

	function rejectTerminal(message: { role: "assistant"; content?: unknown }, error: string, ctx: ExtensionContext) {
		queueTerminalRegeneration(error, ctx);
		return {
			message: {
				...message,
				role: "assistant" as const,
				content: [],
			},
		};
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
			if (!snapshot.config.enabled) throw new Error("State Flow is disabled on this session branch");
			if (signal?.aborted) throw new Error("State Flow read was aborted");
			if (!runtime?.view) throw new Error("State Flow temporal runtime is unavailable");
			const { offset = 0, scope = "effective" } = params;
			const state = runtime.read(offset, scope === "effective" ? undefined : scope);
			const boundary = runtime.view.lineage.at(-1 - offset)!;
			return {
				content: [{ type: "text", text: JSON.stringify({ offset, scope, boundary, state }) }],
				details: { offset, scope, transitionId: boundary.id },
			};
		},
	});

	pi.registerTool({
		name: PATCH_STATE_TOOL_NAME,
		label: "Patch State",
		description: "Materialize established future-relevant semantic state at a session, CWD, or global barrier, including a necessary write-and-verify step during explicitly requested curation. Do not use for scratchpad, narration, routine progress, or speculative churn. This call must be the only State Flow barrier in its assistant response; sibling tool calls are blocked and reconsidered after rematerialization.",
		promptSnippet: "Materialize established future-relevant state as an immediate inference barrier",
		promptGuidelines: [
			"Use patch_state when established future-relevant information would face meaningful loss or recovery risk if delayed until terminal reconciliation, or for a necessary write-and-verify step in explicitly requested curation.",
			"Call patch_state alone in an assistant response; choose subsequent actions only after its compact acknowledgement and rematerialized State Flow context.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			scope: StringEnum(["session", "cwd", "global"] as const),
			patch: Type.Record(Type.String(), Type.Unknown()),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!snapshot.config.enabled) throw new Error("State Flow is disabled on this session branch");
			if (signal?.aborted) throw new Error("State Flow patch was aborted before materialization");
			const transition = { scope: params.scope as StateScope, patch: params.patch as ScopePatch };
			const stage = stageScopedPatch(
				scopeStates,
				transition,
				skillReads.successful.values(),
				runtime!.causalBasis(),
				artifactReads.successful.values(),
			);
			commitStage(stage, ctx, false);
			updateUi(ctx);
			const publication = pendingPublication === undefined ? "" : "; durable publication pending";
			return {
				content: [{ type: "text", text: `\nState materialized at ${params.scope} scope${publication}.` }],
				details: { scope: params.scope, step: snapshot.meta.step },
			};
		},
	});

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			if (!activeContext) restoreActiveBranch(ctx);
			const previousSnapshot = structuredClone(snapshot);
			try {
				if (!runtime?.view && !snapshot.meta.durableBase && !branchStartsWithoutRuntime) {
					throw new Error("Selected branch revision is unavailable; restore its original Git history before starting State Flow");
				}
				const branch = ctx.sessionManager.getBranch();
				activeContext = ctx;
				runtime ??= createRuntime(ctx);
				if (branchStartsWithoutRuntime) runtime.prepare();
				const bootstrap = (!branchHasSnapshot || !snapshot.config.enabled)
					&& hasPriorConversation(branch);
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
				if (publication) recordPublication(publication, ctx);
				installScopeStates();
				delete snapshot.legacySession;
				clearRunTransient();
				refreshArtifactInvalidations(ctx);
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
			const stopped = stopEpisode(current);
			const publication = selected?.view ? selected.publish(stopped) : undefined;
			if (selected !== runtime) {
				runtime = selected;
				installScopeStates();
			}
			snapshot = stopped;
			if (publication) recordPublication(publication, ctx);
			branchHasSnapshot = true;
			clearRunTransient();
			syncStateFlowTools();
			persist();
			updateUi(ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!snapshot.config.enabled) return;
		if (!retryQueued) {
			skillReads.clear();
			artifactReads.clear();
		}
		const rotatesRun = snapshot.meta.specification !== undefined && !retryQueued;
		if (rotatesRun) rehydrationPhase = "step";
		if (prepareRun(snapshot, event.prompt, retryQueued)) {
			if (rotatesRun) runAnchorTimestamp = undefined;
			persist();
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${stateFlowProtocol(snapshot.meta.bootstrap === true)}`,
		};
	});

	pi.on("context", (event) => {
		if (!snapshot.config.enabled || snapshot.meta.specification === undefined) return;
		const effectiveState = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
		const recentTransitions = projectRecentTransitionsWithLimit(
			snapshot.config.transitionWindow,
			runtime?.recent() ?? [],
		);
		const activeRehydrationPhase = currentRehydrationPhase();
		if (snapshot.meta.bootstrap) {
			const messages = withoutPrivateValidation(event.messages as AgentMessage[]);
			return { messages: [runtimeContextMessage(snapshot, effectiveState, recentTransitions, artifactInvalidations, activeRehydrationPhase), ...messages] };
		}
		const trajectory = currentRunTrajectory(
			event.messages as AgentMessage[],
			snapshot.meta.specification,
			runAnchorTimestamp,
		);
		runAnchorTimestamp = trajectory.anchorTimestamp;
		return {
			messages: [
				runtimeContextMessage(snapshot, effectiveState, recentTransitions, artifactInvalidations, activeRehydrationPhase),
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
		stagedFinal = undefined;
		const message = event.message as unknown as { role: "assistant"; stopReason?: string; content?: unknown };
		if (message.stopReason === "aborted") {
			abandonRun(ctx);
			return;
		}
		if (message.stopReason === "length" || message.stopReason === "error") {
			return rejectTerminal(message, `Assistant response ended with ${message.stopReason}`, ctx);
		}
		if (assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse") {
			retryQueued = snapshot.meta.validation !== undefined;
			const cleaned = stripStateComments(message.content);
			return cleaned.changed
				? { message: { ...message, role: "assistant" as const, content: cleaned.content } }
				: undefined;
		}
		try {
			const parsed = parseTerminalPatch(message.content);
			stagedFinal = stageScopedTransition(
				scopeStates,
				parsed.transition,
				skillReads.successful.values(),
				runtime!.causalBasis(),
				artifactReads.successful.values(),
			);
			retryQueued = false;
			return { message: { ...message, role: "assistant" as const, content: parsed.responseContent } };
		} catch (error) {
			return rejectTerminal(message, error instanceof Error ? error.message : String(error), ctx);
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!snapshot.config.enabled || !stagedFinal) {
			updateUi(ctx);
			return;
		}
		try {
			stagedFinal.nextStates.session.response = finalizedAssistantResponse(event.message);
			commitStage(stagedFinal, ctx, true);
			enqueueTurnPublication();
			if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
		} catch (error) {
			queueTerminalRegeneration(error instanceof Error ? error.message : String(error), ctx);
		}
		stagedFinal = undefined;
		updateUi(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (snapshot.config.enabled && retryQueued) abandonRun(ctx);
		if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
	});

	pi.on("session_start", (event, ctx) => {
		rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
		restoreActiveBranch(ctx, event.reason);
		refreshArtifactInvalidations(ctx);
		retryPendingPush(ctx);
		if (snapshot.meta.remotePublication?.mode === "turn-end") launchPublicationWorker();
		updateUi(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreActiveBranch(ctx);
		refreshArtifactInvalidations(ctx);
	});
}
