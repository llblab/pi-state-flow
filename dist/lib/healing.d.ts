import { type ScopeSelection } from "./selection.ts";
import type { StateScope } from "./state.ts";
import { type StorageTransaction } from "./storage.ts";
/** One visible reset: the scope became wholly absent after its exact bytes were quarantined. */
export interface HealedScope {
    scope: StateScope;
    reason: string;
    quarantine: string;
}
/** Healing outcome; `lifecycleAbsent` means this session owns no lifecycle after healing. */
export interface HealResult {
    healed: HealedScope[];
    lifecycleAbsent: boolean;
}
export interface HealRequest {
    cwd: string;
    sessionId: string;
    sessionKey: string;
    selection: ScopeSelection;
    historyLimit: number;
    root: string;
    /** Wall-clock source for deterministic tests. */
    now?: () => Date;
}
/**
 * Only semantic decoding/validation failures are healable. Filesystem, lock, cancellation and
 * foreign-owner identity failures keep failing closed because resetting cannot fix them safely.
 */
export declare function isHealableCorruption(error: unknown): boolean;
/**
 * Converge the selected owners to a loadable store: decode each owner independently, then the
 * complete selected cohort. A broken owner is quarantined and becomes wholly absent, which the
 * normal lifecycle treats as empty memory. Healthy stores are never written.
 */
export declare function healSelectedStoreLocked(storage: StorageTransaction, request: HealRequest, signal?: AbortSignal): HealResult;
/** Never waits behind a live writer: a busy store is being used, so healing defers to a later attempt. */
export declare function healSelectedStore(request: HealRequest, signal?: AbortSignal): Promise<HealResult>;
/** One pending reset notice: projected to the model until an agent run settles after seeing it. */
export declare class HealNotice {
    #private;
    announce(message: string): void;
    /** Model-facing text for the current request, marking it as seen. */
    project(): string | undefined;
    /** A settled run that saw the notice consumes it; an unseen notice survives. */
    settle(): void;
}
export declare function describeHealedScopes(healed: readonly HealedScope[]): string;
