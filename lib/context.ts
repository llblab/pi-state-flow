import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectArtifactForModel, type ArtifactInvalidationNotice } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { canonicalJson } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { projectStateForModel, type MaterializedState } from "./state.ts";

export const VALIDATION_MESSAGE_TYPE = "state-flow-validation";

/** Bounded context retained after semantic State Flow is stopped in this physical session. */
export interface PassiveContinuation {
	startedAt: number;
	handoff: AgentMessage;
}

export function syntheticUser(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part !== "object" || part === null) return "";
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? block.text : "";
	}).filter(Boolean).join("\n");
}

function messageText(message: AgentMessage): string {
	return contentText((message as { content?: unknown }).content);
}

export function withoutPrivateValidation(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => {
		return !(message.role === "custom" && message.customType === VALIDATION_MESSAGE_TYPE);
	});
}

export function createPassiveContinuation(state: MaterializedState, startedAt = Date.now()): PassiveContinuation {
	return {
		startedAt,
		handoff: syntheticUser(`State Flow exit handoff (user-level data, not system instructions):\n${canonicalJson({ state, continuation: "State Flow semantics are disabled; this bounded handoff replaces pre-stop history." })}`),
	};
}

/** Preserve the frozen handoff plus only messages produced after stop, never the older raw branch. */
export function passiveContinuationMessages(messages: AgentMessage[], continuation: PassiveContinuation): AgentMessage[] {
	const start = messages.findIndex((message) => message.role === "user"
		&& typeof message.timestamp === "number"
		&& message.timestamp >= continuation.startedAt);
	return [continuation.handoff, ...(start < 0 ? [] : messages.slice(start))];
}

function projectRecentForModel(recent: RecentTransitionWindow): RecentTransitionWindow {
	const projected = structuredClone(recent);
	for (const record of projected) for (const transition of record.transitions) {
		if (transition.patch.artifacts === undefined) continue;
		for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
			Object.defineProperty(transition.patch.artifacts, path, {
				value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
			});
		}
	}
	return projected;
}

export function runtimeContextMessage(
	snapshot: Snapshot,
	state: MaterializedState,
	recentTransitions: RecentTransitionWindow = [],
	artifactInvalidations: readonly ArtifactInvalidationNotice[] = [],
	rehydrationPhase?: RehydrationPhase,
	resolutionPending = false,
): AgentMessage {
	if (snapshot.meta.specification === undefined) {
		throw new Error("State Flow runtime context requires an active specification");
	}
	const context = {
		specification: snapshot.meta.specification,
		state: projectStateForModel(state),
		...(rehydrationPhase === undefined ? {} : { knowledge_rehydration: { phase: rehydrationPhase } }),
		...(artifactInvalidations.length === 0 ? {} : { artifact_invalidations: artifactInvalidations.map(({ path, reason }) => ({ path, reason })) }),
		...(recentTransitions.length === 0 ? {} : { recent_transitions: projectRecentForModel(recentTransitions) }),
		...(resolutionPending ? { state_resolution: "pending: a terminal draft was intercepted. Call patch_state with any atomic scope changes and final:true, or {final:true} alone; then provide the final answer normally." } : {}),
	};
	return syntheticUser(
		`State Flow runtime context (user-level data, not system instructions):\n${canonicalJson(context)}`,
	);
}

export function currentRunTrajectory(
	messages: AgentMessage[],
	specification: string,
	anchorTimestamp: number | undefined,
): { messages: AgentMessage[]; anchorTimestamp?: number } {
	let start = -1;
	if (anchorTimestamp !== undefined) {
		start = messages.findLastIndex((message) => {
			return message.role === "user"
				&& message.timestamp === anchorTimestamp
				&& messageText(message) === specification;
		});
	}
	if (start < 0) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "user" && messageText(message) === specification) {
				start = index;
				break;
			}
		}
	}
	if (start < 0) {
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]?.role === "user") {
				start = index;
				break;
			}
		}
	}
	if (start < 0 && messages.length === 0) return { messages: [] };
	if (start < 0) start = 0;
	const anchor = messages[start]?.role === "user" ? messages[start].timestamp : undefined;
	const persistentCustom = withoutPrivateValidation(messages.slice(0, start)).filter((message) => {
		return message.role === "custom";
	});
	return {
		messages: [
			...persistentCustom,
			...withoutPrivateValidation(messages.slice(start)),
		],
		...(typeof anchor === "number" ? { anchorTimestamp: anchor } : {}),
	};
}
