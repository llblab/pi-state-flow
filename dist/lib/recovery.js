import { parseRetainedPiCheckpoint, migrationFailure } from "./snapshot.js";
/** Select the newest supported retained-boundary checkpoint or disabled marker; unsupported pointers fail closed. */
export function selectRetainedCheckpoint(candidates) {
    const skipped = [];
    for (const candidate of candidates) {
        let retained;
        try {
            if (typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "revision")) {
                return { kind: "unavailable", snapshot: migrationFailure({}, "Snapshot restoration failed: revision-pointer checkpoints are unsupported"), skipped };
            }
            retained = parseRetainedPiCheckpoint(candidate);
        }
        catch (error) {
            skipped.push(`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        return "disabled" in retained ? { kind: "disabled", skipped } : { kind: "boundary", checkpoint: retained, skipped };
    }
    return {
        kind: "unavailable",
        snapshot: migrationFailure({}, skipped[0] ?? "Snapshot restoration failed: no supported checkpoint"),
        skipped,
    };
}
/** Withdraw a caller's join without cancelling independently owned recovery or Stop persistence. */
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
/** A selected boundary that cannot be resolved stays unavailable; callers never fall through to older evidence. */
export function selectedBoundaryFailure(cause) {
    return migrationFailure({}, `Snapshot restoration failed: ${cause}`);
}
