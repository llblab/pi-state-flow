import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalJson } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";

export const VALIDATION_MESSAGE_TYPE = "state-flow-validation";

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

export function runtimeContextMessage(snapshot: Snapshot): AgentMessage {
	if (snapshot.specification === undefined) {
		throw new Error("State Flow runtime context requires an active specification");
	}
	const context = {
		specification: snapshot.specification,
		state: snapshot.state,
		...(snapshot.validation === undefined ? {} : { validation_feedback: snapshot.validation }),
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
