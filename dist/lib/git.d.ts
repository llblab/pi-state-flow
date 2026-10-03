/** Await a coherent capture; hosts without cancellation may refuse contention instead of hanging Abort. */
export declare function backupCurrentStateFlowFiles(repositoryRoot: string, signal?: AbortSignal, waitForLock?: boolean): Promise<string | undefined>;
/** Skip overlapping pushes; the next accepted turn can push the latest HEAD. */
export declare function startStateFlowBackupPush(repositoryRoot: string, onFailure: (error: unknown) => void, onSuccess?: () => void, signal?: AbortSignal): boolean;
/** Resolve only after the push process has closed (including timeout termination). */
export declare function awaitInFlightBackupPushes(repositoryRoot: string): Promise<void>;
/** Push the current backup commit to its explicitly configured branch remote without blocking settlement. */
export declare function pushCurrentStateFlowBackup(repositoryRoot: string, signal?: AbortSignal): Promise<{
    commit: string;
    remote: string;
    ref: string;
} | undefined>;
/**
 * Settled-turn backup obligation owned by one extension instance: an accepted
 * publication makes a backup due, an accepted turn permits it at settlement,
 * and one lifetime cancels owned captures/pushes without touching accepted state.
 */
export declare class SettledTurnBackup {
    #private;
    /** An accepted canonical publication makes the next settled-turn backup due. */
    markPublished(): void;
    /** An accepted turn permits the due backup at its settlement. */
    markTurnAccepted(): void;
    /** Forget the current turn's permission without dropping a due backup. */
    clearTurn(): void;
    /** Consume the accepted-turn permission; true only when a backup is also due. */
    takeSettledTurn(): boolean;
    /** Lifetime signal for owned captures and pushes. */
    get lifetime(): AbortSignal;
    /** Cancel owned work and the due backup, then open a fresh lifetime. */
    cancel(): void;
    /** Cancel owned work for shutdown without opening a new lifetime. */
    abort(): void;
    /** Track one owned capture until it settles. */
    track<T>(operation: Promise<T>): Promise<T>;
    /** Owned captures still in flight. */
    get operations(): Promise<unknown>[];
    /** True once per failure streak; a successful push resets it. */
    claimPushFailureNotice(): boolean;
    resetPushFailureNotice(): void;
}
