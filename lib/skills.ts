import { isObject, type JsonObject } from "./json.ts";

function hasContent(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (isObject(value)) return Object.keys(value).length > 0;
	return value !== undefined && value !== null;
}

export function hasCompiledSkill(contract: JsonObject, source: string): boolean {
	if (!isObject(contract.compiled_skills)) return false;
	return hasContent(contract.compiled_skills[source]);
}

export function skillPathFromRead(toolName: unknown, args: unknown): string | undefined {
	if (toolName !== "read" || !isObject(args) || typeof args.path !== "string") return undefined;
	return /(^|[\\/])SKILL\.md$/.test(args.path) ? args.path : undefined;
}

interface PendingRead {
	toolName: string;
	args: unknown;
}

/** Correlates Pi's mutable tool lifecycle without exposing runtime event objects. */
export class SkillReadTracker {
	readonly successful = new Set<string>();
	readonly #pending = new Map<string, PendingRead>();

	clear(): void {
		this.successful.clear();
		this.#pending.clear();
	}

	recordStart(toolCallId: string, toolName: string, args: unknown): void {
		this.#record(toolCallId, toolName, args);
	}

	recordCall(toolCallId: string, toolName: string, input: unknown): void {
		this.#record(toolCallId, toolName, input);
	}

	recordEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const pending = this.#pending.get(toolCallId);
		this.#pending.delete(toolCallId);
		if (isError || !pending || toolName !== pending.toolName) return;
		const source = skillPathFromRead(pending.toolName, pending.args);
		if (source) this.successful.add(source);
	}

	#record(toolCallId: string, toolName: string, args: unknown): void {
		if (toolName !== "read") {
			this.#pending.delete(toolCallId);
			return;
		}
		this.#pending.set(toolCallId, { toolName, args });
	}
}
