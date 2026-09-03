import { emptyState } from "./state.ts";
import { migrateSnapshot, migrationFailure, type Snapshot } from "./snapshot.ts";

export interface SnapshotRecovery {
	snapshot: Snapshot;
	skipped: string[];
}

function failureMessage(snapshot: Snapshot): string | undefined {
	return !snapshot.enabled && snapshot.validation?.attempt === 0
		? snapshot.validation.error
		: undefined;
}

/** Recover the newest valid snapshot, falling back through the active branch. */
export function recoverSnapshot(candidates: readonly unknown[]): SnapshotRecovery {
	const skipped: string[] = [];
	let newestFailure: Snapshot | undefined;
	for (const candidate of candidates) {
		let migrated: Snapshot;
		try {
			migrated = migrateSnapshot(candidate);
		} catch (error) {
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
		snapshot: newestFailure ?? { enabled: false, state: emptyState(), step: 0 },
		skipped,
	};
}
