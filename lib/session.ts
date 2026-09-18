export const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";

interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown };
}

export interface SessionEntryLookup {
	getLeafEntry(): (BranchEntry & { id?: string; parentId?: string | null }) | undefined;
	getEntry(id: string): (BranchEntry & { id?: string; parentId?: string | null }) | undefined;
}

export interface PassiveStopBoundary {
	at: number;
	from?: number;
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

/** Auto-start eligibility is session identity/lifecycle, not the presence of CWD materialization. */
export function isNewSession(reason: unknown, branch: readonly BranchEntry[]): boolean {
	if (reason === "new") return true;
	return reason === "startup" && !hasPriorConversation(branch);
}

export function findAssistantToolBatch(session: SessionEntryLookup, toolCallId: string): string[] | undefined {
	for (let cursor = session.getLeafEntry(); cursor; cursor = cursor.parentId ? session.getEntry(cursor.parentId) : undefined) {
		if (cursor.type !== "message" || cursor.message?.role !== "assistant" || !Array.isArray((cursor.message as { content?: unknown }).content)) continue;
		const calls = (cursor.message as { content: unknown[] }).content.filter((block): block is { type: "toolCall"; id: string; name: string } => {
			return typeof block === "object" && block !== null
				&& (block as { type?: unknown }).type === "toolCall"
				&& typeof (block as { id?: unknown }).id === "string"
				&& typeof (block as { name?: unknown }).name === "string";
		});
		if (calls.some(({ id }) => id === toolCallId)) return calls.map(({ name }) => name);
	}
	return undefined;
}

export function findPassiveStopBoundary(branch: readonly BranchEntry[], sessionId: string, entryType: string): PassiveStopBoundary | undefined {
	for (const entry of [...branch].reverse()) {
		try {
			if (entry?.type !== "custom" || entry.customType !== entryType) continue;
			const { at, from, reset, owner } = (entry.data as { at?: unknown; from?: unknown; reset?: unknown; owner?: unknown } | undefined) ?? {};
			if (reset === true && owner === sessionId) return undefined;
			if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) return {
				at,
				...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
			};
		} catch {
			// A hostile unrelated branch entry cannot manufacture or suppress a valid marker.
		}
	}
	return undefined;
}

export function retainsPhysicalSessionProjection(reason: unknown): boolean {
	return reason === undefined || reason === "startup" || reason === "reload" || reason === "resume";
}
