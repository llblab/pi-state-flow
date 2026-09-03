import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantToolCallCount, finalizedAssistantResponse, parseTerminalPatch, stateFlowProtocol, stripStateComments } from "./terminal.ts";
import { currentRunTrajectory, runtimeContextMessage, VALIDATION_MESSAGE_TYPE, withoutPrivateValidation } from "./context.ts";
import { SkillReadTracker } from "./skills.ts";
import { migrationFailure, type Snapshot } from "./snapshot.ts";
import { emptyState } from "./state.ts";
import { commitTransition, stageTransition, type StagedTransition } from "./transition.ts";
import { MAX_VALIDATION_RETRIES, nextValidation } from "./validation.ts";
import { discoverSnapshotData, hasPriorConversation, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { compactStatus, detailedStatus, STATUS_KEY } from "./status.ts";
import { abandonValidation, prepareRun, startEpisode, stopEpisode } from "./episode.ts";
import { recoverSnapshot } from "./recovery.ts";

export default function stateFlowExtension(pi: ExtensionAPI): void {
	let snapshot: Snapshot = { enabled: false, state: emptyState(), step: 0 };
	let stagedFinal: StagedTransition | undefined;
	let retryQueued = false;
	let runAnchorTimestamp: number | undefined;
	const skillReads = new SkillReadTracker();

	function persist(): void {
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, structuredClone(snapshot));
	}

	function updateUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, (color, text) => ctx.ui.theme.fg(color, text)));
	}

	function clearRunTransient(): void {
		stagedFinal = undefined;
		retryQueued = false;
		runAnchorTimestamp = undefined;
		skillReads.clear();
	}

	function restoreActiveBranch(ctx: ExtensionContext): void {
		clearRunTransient();
		try {
			const discovery = discoverSnapshotData(ctx.sessionManager.getBranch());
			const recovery = recoverSnapshot(discovery.candidates);
			const skipped = discovery.errors.length + recovery.skipped.length;
			snapshot = discovery.candidates.length === 0 && discovery.errors.length > 0
				? migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`)
				: recovery.snapshot;
			if (snapshot.enabled && skipped > 0) {
				ctx.ui.notify(`State Flow recovered the previous valid snapshot after skipping ${skipped} malformed newer snapshot(s).`, "warning");
			}
		} catch (error) {
			snapshot = migrationFailure(
				{},
				`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!snapshot.enabled && snapshot.validation?.attempt === 0) {
			ctx.ui.notify(`State Flow restored disabled: ${snapshot.validation.error}`, "error");
		}
		updateUi(ctx);
	}

	function abandonRun(ctx: ExtensionContext): void {
		const changed = abandonValidation(snapshot);
		clearRunTransient();
		if (changed) persist();
		updateUi(ctx);
	}

	function queueTerminalRegeneration(error: string, ctx: ExtensionContext): void {
		const decision = nextValidation(snapshot.validation, error);
		if (decision.kind === "retry") {
			snapshot.validation = decision.feedback;
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
		snapshot.validation = undefined;
		skillReads.clear();
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

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			snapshot = startEpisode(hasPriorConversation(ctx.sessionManager.getBranch()));
			stagedFinal = undefined;
			retryQueued = false;
			runAnchorTimestamp = undefined;
			skillReads.clear();
			persist();
			updateUi(ctx);
			ctx.ui.notify(
				snapshot.bootstrap
					? "State Flow enabled. The next complete agent run will migrate active context into state."
					: "State Flow enabled. The next prompt starts a fresh stateful agent run.",
				"info",
			);
		},
	});

	pi.registerCommand("state-flow-status", {
		description: "Show State Flow runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(detailedStatus(snapshot), "info");
		},
	});

	pi.registerCommand("state-flow-stop", {
		description: "Stop State Flow and clear its complete episode",
		handler: async (_args, ctx) => {
			snapshot = stopEpisode();
			stagedFinal = undefined;
			retryQueued = false;
			runAnchorTimestamp = undefined;
			skillReads.clear();
			persist();
			updateUi(ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!snapshot.enabled) return;
		if (!retryQueued) {
			skillReads.clear();
		}
		const rotatesRun = snapshot.specification !== undefined && !retryQueued;
		if (prepareRun(snapshot, event.prompt, retryQueued)) {
			if (rotatesRun) runAnchorTimestamp = undefined;
			persist();
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${stateFlowProtocol(snapshot.bootstrap === true)}`,
		};
	});

	pi.on("context", (event) => {
		if (!snapshot.enabled || snapshot.specification === undefined) return;
		if (snapshot.bootstrap) {
			if (retryQueued) return;
			const messages = withoutPrivateValidation(event.messages as AgentMessage[]);
			return messages.length === event.messages.length ? undefined : { messages };
		}
		const trajectory = currentRunTrajectory(
			event.messages as AgentMessage[],
			snapshot.specification,
			runAnchorTimestamp,
		);
		runAnchorTimestamp = trajectory.anchorTimestamp;
		return { messages: [runtimeContextMessage(snapshot), ...trajectory.messages] };
	});

	pi.on("tool_execution_start", (event) => {
		if (!snapshot.enabled) return;
		// Pi emits this before tool_call. Keep the argument object as a fallback;
		// tool_call replaces it with the mutable, post-preflight input reference.
		skillReads.recordStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_call", (event) => {
		if (!snapshot.enabled) return;
		skillReads.recordCall(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_execution_end", (event) => {
		if (!snapshot.enabled) return;
		skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
	});

	pi.on("message_end", (event, ctx): any => {
		if (!snapshot.enabled || event.message.role !== "assistant") return;
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
			retryQueued = snapshot.validation !== undefined;
			const cleaned = stripStateComments(message.content);
			return cleaned.changed
				? { message: { ...message, role: "assistant" as const, content: cleaned.content } }
				: undefined;
		}
		try {
			const parsed = parseTerminalPatch(message.content);
			stagedFinal = stageTransition(snapshot.state, parsed.patch, skillReads.successful);
			retryQueued = false;
			return { message: { ...message, role: "assistant" as const, content: parsed.responseContent } };
		} catch (error) {
			return rejectTerminal(message, error instanceof Error ? error.message : String(error), ctx);
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!snapshot.enabled || !stagedFinal) {
			updateUi(ctx);
			return;
		}
		try {
			stagedFinal.nextState.response = finalizedAssistantResponse(event.message);
			if (commitTransition(snapshot, stagedFinal)) {
				skillReads.clear();
				persist();
			}
		} catch (error) {
			queueTerminalRegeneration(error instanceof Error ? error.message : String(error), ctx);
		}
		stagedFinal = undefined;
		updateUi(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (snapshot.enabled && retryQueued) abandonRun(ctx);
	});

	pi.on("session_start", (_event, ctx) => restoreActiveBranch(ctx));
	pi.on("session_tree", (_event, ctx) => restoreActiveBranch(ctx));
}
