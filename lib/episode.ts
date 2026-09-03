import { emptyState } from "./state.ts";
import type { Snapshot } from "./snapshot.ts";

export function startEpisode(bootstrap: boolean): Snapshot {
	return { enabled: true, state: emptyState(), step: 0, bootstrap };
}

export function stopEpisode(): Snapshot {
	return { enabled: false, state: emptyState(), step: 0 };
}

/** Apply one user-run boundary while preserving the materialized state. */
export function prepareRun(snapshot: Snapshot, prompt: string, isRetry: boolean): boolean {
	if (snapshot.specification === undefined) {
		snapshot.specification = prompt;
		return true;
	}
	if (isRetry) return false;
	snapshot.specification = prompt;
	snapshot.validation = undefined;
	return true;
}

/** Clear only transient validation metadata; never disable or reset the episode. */
export function abandonValidation(snapshot: Snapshot): boolean {
	if (snapshot.validation === undefined) return false;
	snapshot.validation = undefined;
	return true;
}
