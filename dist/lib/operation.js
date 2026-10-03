// Domain: one cancellable lifecycle owner slot shared by Start, inactive-mode persistence,
// branch restoration, inference preparation and response reconciliation.
/**
 * At most one current owner per lifecycle concern. A newer claim supersedes by
 * explicit cancellation, and identity-guarded release prevents a late
 * completion from clearing newer work.
 */
export class OwnedOperationSlot {
    #current;
    #inflight = new Set();
    /** The current owner, if any. */
    get current() { return this.#current; }
    /** True while `entry` still owns the slot. */
    owns(entry) { return this.#current === entry; }
    /** Install a new owner; callers cancel a previous owner explicitly when supersession requires it. */
    claim(entry) {
        this.#current = entry;
        return entry;
    }
    /** Abort and forget the current owner; returns its operation for optional awaiting. */
    cancel() {
        const entry = this.#current;
        entry?.controller.abort();
        this.#current = undefined;
        return entry?.operation;
    }
    /** Forget `entry` only if it still owns the slot. */
    release(entry) {
        if (this.#current === entry)
            this.#current = undefined;
    }
    /** Attach `operation` to `entry` and remember it until it settles, optionally releasing ownership then. */
    track(entry, operation, releaseOnSettle = true) {
        entry.operation = operation;
        this.#inflight.add(operation);
        const settle = () => {
            this.#inflight.delete(operation);
            if (releaseOnSettle)
                this.release(entry);
        };
        void operation.then(settle, settle);
        return operation;
    }
    /** Tracked operations not yet settled, including superseded ones. */
    get inflight() { return [...this.#inflight]; }
}
/** A renewable cancellation lifetime: ending it aborts every holder of the current signal. */
export class RenewableLifetime {
    #controller = new AbortController();
    /** Signal of the current lifetime. */
    get signal() { return this.#controller.signal; }
    /** Abort current holders and open a fresh lifetime. */
    renew(reason) {
        this.#controller.abort(reason);
        this.#controller = new AbortController();
    }
    /** Abort current holders without opening a new lifetime (shutdown). */
    end(reason) { this.#controller.abort(reason); }
}
