import { RevisionUnavailableError, emptySnapshot, parsePiCheckpoint, migrationFailure, type Snapshot } from "./snapshot.ts";

export interface SnapshotRecovery {
	snapshot: Snapshot;
	skipped: string[];
	disabledMarker?: true;
}

/** Recover the newest supported pointer or disabled marker from the active branch. */
export function recoverSnapshot(candidates: readonly unknown[], resolveRevision?: (revision: string) => Snapshot): SnapshotRecovery {
	const skipped: string[] = [];
	for (const candidate of candidates) {
		let selectedRevision: string | undefined;
		try {
			const parsed = parsePiCheckpoint(candidate);
			if ("disabled" in parsed) return { snapshot: emptySnapshot(), skipped, disabledMarker: true };
			selectedRevision = parsed.revision;
			if (!resolveRevision) throw new Error("Checkpoint pointer requires immutable runtime resolution");
			return { snapshot: resolveRevision(parsed.revision), skipped };
		} catch (error) {
			if (selectedRevision && error instanceof RevisionUnavailableError) {
				return { snapshot: migrationFailure({ meta: { durableBase: selectedRevision } }, `Snapshot restoration failed: ${error.message}`), skipped };
			}
			skipped.push(`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		snapshot: migrationFailure({}, skipped[0] ?? "Snapshot restoration failed: no supported checkpoint"),
		skipped,
	};
}
