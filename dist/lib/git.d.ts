/** Await a coherent capture; hosts without cancellation may refuse contention instead of hanging Abort. */
export declare function backupCurrentStateFlowFiles(repositoryRoot: string, signal?: AbortSignal, waitForLock?: boolean): Promise<string | undefined>;
/** Skip overlapping pushes; the next accepted turn can push the latest HEAD. */
export declare function startStateFlowBackupPush(repositoryRoot: string, onFailure: (error: unknown) => void, onSuccess?: () => void): boolean;
/** Resolve only after the push process has closed (including timeout termination). */
export declare function awaitInFlightBackupPushes(repositoryRoot: string): Promise<void>;
/** Push the current backup commit to its explicitly configured branch remote without blocking settlement. */
export declare function pushCurrentStateFlowBackup(repositoryRoot: string): Promise<{
    commit: string;
    remote: string;
    ref: string;
} | undefined>;
