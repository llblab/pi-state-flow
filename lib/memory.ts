import { isObject } from "./json.ts";
import type { MaterializedState, ScopedStates, StateScope } from "./state.ts";

export const MEMORY_PROMOTIONS_KEY = "memory_promotions";
export const MEMORY_PROMOTION_STATUSES = ["pending", "accepted", "failed", "unknown"] as const;
export type MemoryPromotionStatus = typeof MEMORY_PROMOTION_STATUSES[number];

export interface MemoryPromotionDiagnostic {
	id: string;
	status: MemoryPromotionStatus | "invalid";
	owner?: string;
	pointer?: string;
	revision?: string;
	error?: string;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Inspect the generic State Flow promotion convention without importing an external owner's schema. */
export function inspectMemoryPromotions(globalState: MaterializedState): MemoryPromotionDiagnostic[] {
	const records = globalState.working[MEMORY_PROMOTIONS_KEY];
	if (records === undefined) return [];
	if (!isObject(records)) return [{ id: MEMORY_PROMOTIONS_KEY, status: "invalid", error: "promotion registry is not an object" }];
	return Object.entries(records).sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
		if (!isObject(value)) return { id, status: "invalid", error: "promotion record is not an object" };
		const owner = nonEmpty(value.owner);
		const pointer = nonEmpty(value.pointer);
		const revision = nonEmpty(value.revision);
		const error = nonEmpty(value.error);
		const status = typeof value.status === "string" && (MEMORY_PROMOTION_STATUSES as readonly string[]).includes(value.status)
			? value.status as MemoryPromotionStatus
			: undefined;
		if (!status || !owner) return { id, status: "invalid", ...(owner ? { owner } : {}), ...(pointer ? { pointer } : {}), ...(revision ? { revision } : {}), error: error ?? "promotion status/owner is invalid" };
		if (status === "accepted" && (!pointer || !revision)) return { id, status: "invalid", owner, ...(pointer ? { pointer } : {}), ...(revision ? { revision } : {}), error: "accepted promotion requires pointer and revision" };
		return { id, status, owner, ...(pointer ? { pointer } : {}), ...(revision ? { revision } : {}), ...(error ? { error } : {}) };
	});
}

function hasSemanticMemory(state: MaterializedState, ignorePromotions: boolean): boolean {
	if (Object.keys(state.contract).length > 0) return true;
	return Object.keys(state.working).some((key) => !ignorePromotions || key !== MEMORY_PROMOTIONS_KEY);
}

export function retainedMemoryScopes(states: ScopedStates): Record<StateScope, boolean> {
	return {
		global: hasSemanticMemory(states.global, true),
		cwd: hasSemanticMemory(states.cwd, false),
		session: hasSemanticMemory(states.session, false),
	};
}
