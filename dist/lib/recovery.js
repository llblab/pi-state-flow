import { DEFAULT_SCOPE_SELECTION } from "./selection.js";
import { PublicationBusyError, TransientStorageAcquisitionError } from "./storage.js";
import { prepareRetainedPolicyMigration, parseRetainedPiCheckpoint, migrationFailure } from "./snapshot.js";
/** Select the newest supported retained-boundary checkpoint or pre-runtime mode; unsupported pointers fail closed. */
export function selectRetainedCheckpoint(candidates, inactiveMode = "passive") {
    const skipped = [];
    for (const candidate of candidates) {
        let retained;
        try {
            if (typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "revision")) {
                return { kind: "unavailable", snapshot: migrationFailure({}, "Snapshot restoration failed: revision-pointer checkpoints are unsupported", inactiveMode), skipped };
            }
            retained = typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "version")
                ? prepareRetainedPolicyMigration(candidate, DEFAULT_SCOPE_SELECTION, inactiveMode).checkpoint
                : parseRetainedPiCheckpoint(candidate, inactiveMode);
        }
        catch (error) {
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
export function waitForRecovery(operation, signal) {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        const finish = (settle) => {
            signal.removeEventListener("abort", aborted);
            if (signal.aborted)
                reject(signal.reason);
            else
                settle();
        };
        // Observe the operation even when already cancelled: its later rejection still has an owner.
        operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        if (signal.aborted)
            aborted();
        else
            signal.addEventListener("abort", aborted, { once: true });
    });
}
export function isTransientCurrentAcquisition(error) {
    return error instanceof PublicationBusyError || error instanceof TransientStorageAcquisitionError;
}
/** A volatile prompt-bound opportunity, never a native marker, file receipt, or origin grant. */
export class ActiveAcquisitionRetry {
    #eligible;
    #reported;
    retain(blocked, cause, source) {
        this.#eligible = isTransientCurrentAcquisition(cause) ? { blocked, source } : undefined;
    }
    get(blocked) {
        const candidate = this.#eligible;
        return candidate?.blocked === blocked && candidate.source.current() ? candidate.source : undefined;
    }
    shouldReport(reason) {
        if (this.#reported === reason)
            return false;
        this.#reported = reason;
        return true;
    }
    clear() { this.#eligible = this.#reported = undefined; }
}
/** A selected boundary that cannot be resolved stays unavailable; callers never fall through to older evidence. */
export function selectedBoundaryFailure(cause, mode = "passive") {
    return migrationFailure({}, `Snapshot restoration failed: ${cause}`, mode);
}
