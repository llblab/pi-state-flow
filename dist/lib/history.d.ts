import type { ScopePatch, ScopedStates, StateScope } from "./state.ts";
export declare const DEFAULT_HISTORY_LIMIT = 7;
export declare const MAX_HISTORY_LIMIT = 100;
export interface RecentScopePatch {
    scope: StateScope;
    patch: ScopePatch & {
        response?: string;
    };
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
export declare function validateRecentTransition(value: unknown): asserts value is RecentTransition;
export declare function createAcceptedTransition(currentStates: ScopedStates, nextStates: ScopedStates, id?: string): AcceptedTransition | undefined;
/** Preserve the configured per-scope budget, filtering in selected-lineage order. */
export declare function projectRecentTransitionsWithLimit(limit: number, lineage: readonly RecentTransition[]): RecentTransitionWindow;
