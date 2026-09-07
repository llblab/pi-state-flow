import { RevisionUnavailableError, emptySnapshot, parsePiCheckpoint, migrationFailure, type Snapshot } from "./snapshot.ts";

export interface SnapshotRecovery {
	snapshot: Snapshot;
	skipped: string[];
	disabledMarker?: true;
}

function failureMessage(snapshot: Snapshot): string | undefined {
	return !snapshot.config.enabled && snapshot.meta.validation?.attempt === 0
		? snapshot.meta.validation.error
		: undefined;
}

/** Recover the newest valid snapshot, falling back through the active branch. */
export function recoverSnapshot(candidates: readonly unknown[], resolveRevision?: (revision: string, legacy?: Snapshot) => Snapshot): SnapshotRecovery {
	const skipped: string[] = [];
	let newestFailure: Snapshot | undefined;
	for (const candidate of candidates) {
		let migrated: Snapshot;
		let selectedRevision: string | undefined;
		try {
			const parsed = parsePiCheckpoint(candidate);
			if ("revision" in parsed) {
				selectedRevision = parsed.revision;
				if (!resolveRevision) throw new Error("Checkpoint pointer requires immutable runtime resolution");
				return { snapshot: resolveRevision(parsed.revision), skipped };
			}
			if ("disabled" in parsed) return { snapshot: emptySnapshot(), skipped, disabledMarker: true };
			migrated = parsed;
			if (failureMessage(migrated) === undefined && migrated.meta.durableBase) {
				selectedRevision = migrated.meta.durableBase;
				if (!resolveRevision) throw new Error("Legacy checkpoint requires immutable runtime resolution");
				return { snapshot: resolveRevision(migrated.meta.durableBase, migrated), skipped };
			}
		} catch (error) {
			if (selectedRevision && error instanceof RevisionUnavailableError) {
				return { snapshot: migrationFailure({ meta: { durableBase: selectedRevision } }, `Snapshot restoration failed: ${error.message}`), skipped };
			}
			migrated = migrationFailure(
				{},
				`Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const failure = failureMessage(migrated);
		if (failure === undefined) return { snapshot: migrated, skipped };
		newestFailure ??= migrated;
		skipped.push(failure);
	}
	return {
		snapshot: newestFailure ?? emptySnapshot(),
		skipped,
	};
}
