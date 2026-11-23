import { DEFAULT_SCOPE_SELECTION } from "./selection.ts";
import { PublicationBusyError, TransientStorageAcquisitionError } from "./storage.ts";
import { prepareRetainedPolicyMigration, parseRetainedPiCheckpoint, migrationFailure, type InactiveMode, type RetainedBoundaryCheckpoint, type RetainedPiCheckpoint, type Snapshot, type StateFlowMode } from "./snapshot.ts";

export type RetainedCheckpointSelection =
	| { kind: "boundary"; checkpoint: RetainedBoundaryCheckpoint; skipped: string[] }
	| { kind: "pre-runtime"; mode: InactiveMode; skipped: string[] }
	| { kind: "unavailable"; snapshot: Snapshot; skipped: string[] };

/** Select the newest supported retained-boundary checkpoint or pre-runtime mode; unsupported pointers fail closed. */
export function selectRetainedCheckpoint(candidates: readonly unknown[], inactiveMode: InactiveMode = "passive"): RetainedCheckpointSelection {
	const skipped: string[] = [];
	for (const candidate of candidates) {
		let retained: RetainedPiCheckpoint;
		try {
			if (typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "revision")) {
				return { kind: "unavailable", snapshot: migrationFailure({}, "Snapshot restoration failed: revision-pointer checkpoints are unsupported", inactiveMode), skipped };
			}
			retained = typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "version")
				? prepareRetainedPolicyMigration(candidate, DEFAULT_SCOPE_SELECTION, inactiveMode).checkpoint
				: parseRetainedPiCheckpoint(candidate, inactiveMode);
		} catch (error) {
			skipped.push(`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		return "boundary" in retained ? { kind: "boundary", checkpoint: retained, skipped } : { kind: "pre-runtime", mode: retained.mode, skipped };
	}
	return {
		kind: "unavailable",
		snapshot: migrationFailure({}, skipped[0] ?? "Snapshot restoration failed: no supported checkpoint", inactiveMode),
		skipped,
	};
}

/** Withdraw a caller's join without cancelling independently owned recovery or mode persistence. */
export function waitForRecovery<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		const finish = (settle: () => void) => {
			signal.removeEventListener("abort", aborted);
			if (signal.aborted) reject(signal.reason);
			else settle();
		};
		// Observe the operation even when already cancelled: its later rejection still has an owner.
		operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
	});
}

export function isTransientCurrentAcquisition(error: unknown): boolean {
	return error instanceof PublicationBusyError || error instanceof TransientStorageAcquisitionError;
}

interface ActiveRetrySource {
	readonly checkpoint: RetainedBoundaryCheckpoint;
	readonly preserveUncompiledHistory: boolean;
	readonly current: () => boolean;
}

/** A volatile prompt-bound opportunity, never a native marker, file receipt, or origin grant. */
export class ActiveAcquisitionRetry {
	#eligible?: { blocked: Snapshot; source: ActiveRetrySource };
	#reported?: string;

	retain(blocked: Snapshot, cause: unknown, source: ActiveRetrySource): void {
		this.#eligible = isTransientCurrentAcquisition(cause) ? { blocked, source } : undefined;
	}

	get(blocked: Snapshot): ActiveRetrySource | undefined {
		const candidate = this.#eligible;
		return candidate?.blocked === blocked && candidate.source.current() ? candidate.source : undefined;
	}

	shouldReport(reason: string): boolean {
		if (this.#reported === reason) return false;
		this.#reported = reason;
		return true;
	}

	clear(): void { this.#eligible = this.#reported = undefined; }
}

/** A selected boundary that cannot be resolved stays unavailable; callers never fall through to older evidence. */
export function selectedBoundaryFailure(cause: string, mode: StateFlowMode = "passive"): Snapshot {
	return migrationFailure({}, `Snapshot restoration failed: ${cause}`, mode);
}
