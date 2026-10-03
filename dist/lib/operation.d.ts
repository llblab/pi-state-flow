/** Minimal shape of a cancellable owned lifecycle operation. */
export interface OwnedOperation {
    readonly controller: AbortController;
    operation?: Promise<unknown>;
}
/**
 * At most one current owner per lifecycle concern. A newer claim supersedes by
 * explicit cancellation, and identity-guarded release prevents a late
 * completion from clearing newer work.
 */
export declare class OwnedOperationSlot<E extends OwnedOperation> {
    #private;
    /** The current owner, if any. */
    get current(): E | undefined;
    /** True while `entry` still owns the slot. */
    owns(entry: E): boolean;
    /** Install a new owner; callers cancel a previous owner explicitly when supersession requires it. */
    claim(entry: E): E;
    /** Abort and forget the current owner; returns its operation for optional awaiting. */
    cancel(): E["operation"] | undefined;
    /** Forget `entry` only if it still owns the slot. */
    release(entry: E): void;
    /** Attach `operation` to `entry` and remember it until it settles, optionally releasing ownership then. */
    track<P extends NonNullable<E["operation"]>>(entry: E, operation: P, releaseOnSettle?: boolean): P;
    /** Tracked operations not yet settled, including superseded ones. */
    get inflight(): Promise<unknown>[];
}
/** A renewable cancellation lifetime: ending it aborts every holder of the current signal. */
export declare class RenewableLifetime {
    #private;
    /** Signal of the current lifetime. */
    get signal(): AbortSignal;
    /** Abort current holders and open a fresh lifetime. */
    renew(reason?: unknown): void;
    /** Abort current holders without opening a new lifetime (shutdown). */
    end(reason?: unknown): void;
}
