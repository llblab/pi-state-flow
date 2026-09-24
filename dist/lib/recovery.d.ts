import { type RetainedBoundaryCheckpoint, type Snapshot } from "./snapshot.ts";
export type RetainedCheckpointSelection = {
    kind: "boundary";
    checkpoint: RetainedBoundaryCheckpoint;
    skipped: string[];
} | {
    kind: "disabled";
    skipped: string[];
} | {
    kind: "unavailable";
    snapshot: Snapshot;
    skipped: string[];
};
/** Select the newest supported retained-boundary checkpoint or disabled marker; unsupported pointers fail closed. */
export declare function selectRetainedCheckpoint(candidates: readonly unknown[]): RetainedCheckpointSelection;
/** Withdraw a caller's join without cancelling independently owned recovery or Stop persistence. */
export declare function waitForRecovery<T>(operation: Promise<T>, signal: AbortSignal): Promise<T>;
/** A selected boundary that cannot be resolved stays unavailable; callers never fall through to older evidence. */
export declare function selectedBoundaryFailure(cause: string): Snapshot;
