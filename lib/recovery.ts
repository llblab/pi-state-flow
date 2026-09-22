import { emptySnapshot, parseRetainedPiCheckpoint, migrationFailure, type RetainedBoundaryCheckpoint, type Snapshot } from "./snapshot.ts";

export interface SnapshotRecovery {
	snapshot: Snapshot;
	skipped: string[];
	disabledMarker?: true;
}

/** Recover the newest canonical retained-boundary checkpoint or disabled marker. */
export function recoverSnapshot(
	candidates: readonly unknown[],
	resolveBoundary?: (checkpoint: RetainedBoundaryCheckpoint) => Snapshot,
): SnapshotRecovery {
	const skipped: string[] = [];
	for (const candidate of candidates) {
		let selectedBoundary = false;
		try {
			if (typeof candidate === "object" && candidate !== null && Object.hasOwn(candidate, "revision")) {
				return { snapshot: migrationFailure({}, "Snapshot restoration failed: revision-pointer checkpoints are unsupported"), skipped };
			}
			const retained = parseRetainedPiCheckpoint(candidate);
			if ("disabled" in retained) return { snapshot: emptySnapshot(), skipped, disabledMarker: true };
			selectedBoundary = true;
			if (!resolveBoundary) throw new Error("Retained checkpoint requires temporal runtime resolution");
			return { snapshot: resolveBoundary(retained), skipped };
		} catch (error) {
			if (selectedBoundary) {
				return { snapshot: migrationFailure({}, `Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`), skipped };
			}
			skipped.push(`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		snapshot: migrationFailure({}, skipped[0] ?? "Snapshot restoration failed: no supported checkpoint"),
		skipped,
	};
}
