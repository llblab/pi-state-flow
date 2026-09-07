import { emptySnapshot, type Snapshot } from "./snapshot.ts";

export function startEpisode(bootstrap: boolean): Snapshot {
	const snapshot = emptySnapshot(true);
	if (bootstrap) snapshot.meta.bootstrap = true;
	return snapshot;
}

/** Re-enable a branch checkpoint without discarding its runtime config or provenance. */
export function resumeEpisode(snapshot: Snapshot, bootstrap: boolean): Snapshot {
	const next = structuredClone(snapshot);
	next.config.enabled = true;
	if (bootstrap) next.meta.bootstrap = true;
	return next;
}

/** Disable only this branch; durable defaults and session history remain intact. */
export function stopEpisode(snapshot: Snapshot): Snapshot {
	const next = structuredClone(snapshot);
	next.config.enabled = false;
	return next;
}

/** Apply one user-run boundary while preserving checkpoint-owned runtime state. */
export function prepareRun(snapshot: Snapshot, prompt: string, isRetry: boolean): boolean {
	if (snapshot.meta.specification === undefined) {
		snapshot.meta.specification = prompt;
		return true;
	}
	if (isRetry) return false;
	snapshot.meta.specification = prompt;
	snapshot.meta.validation = undefined;
	return true;
}

/** Clear only transient validation metadata; never disable or reset the episode. */
export function abandonValidation(snapshot: Snapshot): boolean {
	if (snapshot.meta.validation === undefined) return false;
	snapshot.meta.validation = undefined;
	return true;
}
