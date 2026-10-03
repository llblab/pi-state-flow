// Domain: one cancellable lifecycle owner slot shared by Start, inactive-mode persistence,
// branch restoration, inference preparation and response reconciliation.

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
export class OwnedOperationSlot<E extends OwnedOperation> {
	#current: E | undefined;
	readonly #inflight = new Set<Promise<unknown>>();

	/** The current owner, if any. */
	get current(): E | undefined { return this.#current; }

	/** True while `entry` still owns the slot. */
	owns(entry: E): boolean { return this.#current === entry; }

	/** Install a new owner; callers cancel a previous owner explicitly when supersession requires it. */
	claim(entry: E): E {
		this.#current = entry;
		return entry;
	}

	/** Abort and forget the current owner; returns its operation for optional awaiting. */
	cancel(): E["operation"] | undefined {
		const entry = this.#current;
		entry?.controller.abort();
		this.#current = undefined;
		return entry?.operation;
	}

	/** Forget `entry` only if it still owns the slot. */
	release(entry: E): void {
		if (this.#current === entry) this.#current = undefined;
	}

	/** Attach `operation` to `entry` and remember it until it settles, optionally releasing ownership then. */
	track<P extends NonNullable<E["operation"]>>(entry: E, operation: P, releaseOnSettle = true): P {
		entry.operation = operation;
		this.#inflight.add(operation);
		const settle = () => {
			this.#inflight.delete(operation);
			if (releaseOnSettle) this.release(entry);
		};
		void operation.then(settle, settle);
		return operation;
	}

	/** Tracked operations not yet settled, including superseded ones. */
	get inflight(): Promise<unknown>[] { return [...this.#inflight]; }
}

/** A renewable cancellation lifetime: ending it aborts every holder of the current signal. */
export class RenewableLifetime {
	#controller = new AbortController();

	/** Signal of the current lifetime. */
	get signal(): AbortSignal { return this.#controller.signal; }

	/** Abort current holders and open a fresh lifetime. */
	renew(reason?: unknown): void {
		this.#controller.abort(reason);
		this.#controller = new AbortController();
	}

	/** Abort current holders without opening a new lifetime (shutdown). */
	end(reason?: unknown): void { this.#controller.abort(reason); }
}
