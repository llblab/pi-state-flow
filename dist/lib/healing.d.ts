import { type ScopeSelection } from "./selection.ts";
import type { StateScope } from "./state.ts";
/** Quarantine evidence of an attempt; only an accepted reset makes the scope wholly absent. */
export interface RecoveryEvidence {
    scope: StateScope;
    reason: string;
    cause: Error;
    quarantine: string;
}
/** Healing outcome; `lifecycleAbsent` means this session owns no lifecycle after healing. */
export interface HealResult {
    healed: RecoveryEvidence[];
    lifecycleAbsent: boolean;
}
type HealAttemptOutcome = {
    effect: "none" | "restored";
    evidence: readonly RecoveryEvidence[];
} | {
    effect: "incomplete";
    evidence: readonly RecoveryEvidence[];
    unresolved: readonly {
        scope: StateScope;
        paths: readonly string[];
    }[];
} | {
    effect: "reset";
    result: HealResult;
};
/** A later failure cannot erase the captured outcome or authorize another reset. */
export declare class HealExecutionError extends Error {
    readonly outcome: HealAttemptOutcome;
    constructor(outcome: HealAttemptOutcome, cause: unknown);
}
export interface HealRequest {
    cwd: string;
    sessionId: string;
    sessionKey: string;
    selection: ScopeSelection;
    historyLimit: number;
    root: string;
    /** Current native operation, if the request has a native owner. */
    assertCurrent?: () => void;
    /** Native owner's required pending receipt, after evidence verification and before mutation. */
    recordAttempt?: (evidence: readonly RecoveryEvidence[]) => void;
    /** Wall-clock source for deterministic tests. */
    now?: () => Date;
}
/** Never waits behind a live writer: a busy store is being used, so healing defers to a later attempt. */
export declare function healSelectedStore(request: HealRequest, signal?: AbortSignal): Promise<HealResult>;
export interface RecoveryIncident {
    id: string;
    scopes: ScopeSelection;
    fact: "attempted" | "none" | "restored" | "incomplete" | "reset" | "missing";
    /** Delivery can end without resolving the filesystem safety evidence. */
    acknowledged?: true;
}
export declare function unresolvedRecovery(incident: RecoveryIncident): boolean;
export declare function recoveryIncidentText({ scopes, fact }: RecoveryIncident): string;
export declare function describeHealedScopes(healed: readonly RecoveryEvidence[]): string;
export {};
