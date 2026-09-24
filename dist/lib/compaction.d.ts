import type { CompactionResult } from "@earendil-works/pi-coding-agent";
export declare const STATE_FLOW_COMPACTION_SUMMARY = "State Flow accepted the completed work before this boundary. Current memory is restored from its retained semantic boundary and projected separately; use the retained native entries for subsequent work.";
/** A modest margin above Pi's default 20k retained suffix absorbs estimation drift. */
export declare const STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS = 24000;
export interface StateFlowCompactionDetails {
    version: 1;
    owner: "state-flow";
    boundary: string;
    step: number;
}
export interface StateFlowCompactionPlan {
    leafId: string;
    firstKeptEntryId: string;
    details: StateFlowCompactionDetails;
}
type ActiveEntry = {
    id?: unknown;
    type?: unknown;
    customType?: unknown;
    message?: {
        role?: unknown;
        stopReason?: unknown;
        content?: unknown;
        timestamp?: unknown;
    };
};
export declare function shouldRequestStateFlowCompaction(usage: {
    tokens: number | null;
} | undefined): boolean;
/**
 * Pi's public usage includes the system prompt, while native compaction can only
 * shorten persisted messages. Avoid requesting a visibly failing manual
 * compaction when that transcript is still below the useful-history floor.
 */
export declare function hasCompactionSizedTranscript(entries: readonly ActiveEntry[]): boolean;
/** Retain the complete latest accepted user iteration without hiding foreign extension context. */
export declare function planStateFlowCompaction(entries: readonly ActiveEntry[], boundary: string, step: number, runAnchorTimestamp: number | undefined): StateFlowCompactionPlan | undefined;
/** Customize only the extension-owned manual request and only while its planned leaf remains selected. */
export declare function stateFlowCompactionResult(plan: StateFlowCompactionPlan, marker: string, event: {
    reason: "manual" | "threshold" | "overflow";
    customInstructions?: string;
    branchEntries: readonly ActiveEntry[];
    preparation: {
        tokensBefore: number;
    };
    signal: AbortSignal;
}): CompactionResult<StateFlowCompactionDetails> | {
    cancel: true;
} | undefined;
export {};
