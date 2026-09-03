export const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";

interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown };
}

export interface SnapshotDiscovery {
	candidates: unknown[];
	errors: string[];
}

/** Enumerate active-branch snapshots newest-first while containing hostile entries. */
export function discoverSnapshotData(branch: readonly BranchEntry[]): SnapshotDiscovery {
	const candidates: unknown[] = [];
	const errors: string[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) candidates.push(entry.data);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { candidates, errors };
}

export function snapshotDataNewestFirst(branch: readonly BranchEntry[]): unknown[] {
	return discoverSnapshotData(branch).candidates;
}

export function latestSnapshotData(branch: readonly BranchEntry[]): unknown {
	return snapshotDataNewestFirst(branch)[0];
}

export function hasPriorConversation(branch: readonly BranchEntry[]): boolean {
	for (const entry of branch) {
		try {
			if (entry.type !== "message") continue;
			const role = entry.message?.role;
			if (role === "user" || role === "assistant" || role === "toolResult") return true;
		} catch {
			// A hostile unrelated entry must not prevent explicit episode startup.
		}
	}
	return false;
}
