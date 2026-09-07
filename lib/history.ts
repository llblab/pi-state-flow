import { randomUUID } from "node:crypto";
import { hashJson, isJsonValue, isObject, validatePatch, type JsonObject } from "./json.ts";
import type { ScopePatch, ScopedStates, StateScope } from "./state.ts";

export const RECENT_TRANSITION_LIMIT = 7;

export interface RecentScopePatch {
	scope: StateScope;
	patch: ScopePatch & { response?: string };
}

/** Exact accepted replay cohort; temporal runtime owns its causal boundary. */
export interface AcceptedTransition {
	id: string;
	transitions: RecentScopePatch[];
}

/** Compact lineage projection; at is a branch-local position, not a clock. */
export interface RecentTransition extends AcceptedTransition {
	at: number;
}

export type RecentTransitionWindow = RecentTransition[];
const SCOPES = new Set<StateScope>(["global", "cwd", "session"]);
const PATCH_KEYS = new Set(["artifacts", "contract", "working", "response"]);

/** Normalize accepted replacements into recursive-merge replay, including removals. */
function replayPatch(before: JsonObject, after: JsonObject): JsonObject {
	const entries: Array<[string, JsonObject[string]]> = [];
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (!Object.hasOwn(after, key)) {
			entries.push([key, null]);
			continue;
		}
		if (Object.hasOwn(before, key) && hashJson(before[key]) === hashJson(after[key])) continue;
		const previous = before[key];
		const next = after[key]!;
		entries.push([key, isObject(previous) && isObject(next) ? replayPatch(previous, next) : structuredClone(next)]);
	}
	return Object.fromEntries(entries);
}

function validateScopedPatch(value: unknown): asserts value is RecentScopePatch {
	if (!isObject(value) || Object.keys(value).sort().join(",") !== "patch,scope") {
		throw new Error('Recent State Flow transition entries must contain exactly "scope" and "patch"');
	}
	if (typeof value.scope !== "string" || !SCOPES.has(value.scope as StateScope)) {
		throw new Error(`Recent State Flow transition has an unknown scope: ${String(value.scope)}`);
	}
	validatePatch(value.patch);
	for (const [key, field] of Object.entries(value.patch)) {
		if (!PATCH_KEYS.has(key) || (key === "response"
			? value.scope !== "session" || typeof field !== "string" : !isObject(field))) {
			throw new Error("Recent State Flow patches may contain object-valued artifacts, contract, and working plus a session response string");
		}
	}
}

export function validateRecentTransition(value: unknown): asserts value is RecentTransition {
	if (!isObject(value) || Object.keys(value).sort().join(",") !== "at,id,transitions") throw new Error("Recent State Flow transition has an invalid envelope");
	if (typeof value.id !== "string" || value.id.length === 0) throw new Error("Recent State Flow transition must have a non-empty id");
	if (!Number.isSafeInteger(value.at) || (value.at as number) < 0) throw new Error("Recent State Flow transition must have a safe non-negative position");
	if (!Array.isArray(value.transitions) || value.transitions.length === 0 || !isJsonValue(value.transitions)) throw new Error("Recent State Flow transition must contain semantic patches");
	const seen = new Set<StateScope>();
	for (const transition of value.transitions) {
		validateScopedPatch(transition);
		if (seen.has(transition.scope)) throw new Error(`Duplicate recent State Flow transition scope: ${transition.scope}`);
		seen.add(transition.scope);
	}
}

export function createAcceptedTransition(currentStates: ScopedStates, nextStates: ScopedStates, id?: string): AcceptedTransition | undefined {
	const transitions: RecentScopePatch[] = [];
	for (const scope of SCOPES) {
		const patch = replayPatch(currentStates[scope], nextStates[scope]);
		if (Object.keys(patch).length > 0) transitions.push({ scope, patch });
	}
	if (transitions.length === 0) return undefined;
	return { id: id ?? randomUUID(), transitions };
}

/** Preserve the configured per-scope budget, filtering in selected-lineage order. */
export function projectRecentTransitionsWithLimit(limit: number, lineage: readonly RecentTransition[]): RecentTransitionWindow {
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > RECENT_TRANSITION_LIMIT) {
		throw new Error(`Recent State Flow transition limit must be an integer from 0 to ${RECENT_TRANSITION_LIMIT}`);
	}
	const remaining = { global: limit, cwd: limit, session: limit };
	const result: RecentTransitionWindow = [];
	for (let index = lineage.length - 1; index >= 0; index--) {
		const record = lineage[index]!;
		const transitions = record.transitions.filter(({ scope }) => remaining[scope]-- > 0);
		if (transitions.length) result.push({ ...record, transitions });
	}
	return structuredClone(result.reverse());
}
