import { parseRetainedPiCheckpoint, readCheckpointMode, type InactiveMode, type StateFlowMode } from "./snapshot.ts";

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
	preserveContext?: true;
	/** A same-owner failed mode change remains a write fence until a later accepted checkpoint. */
	persistenceError?: string;
	/** The inactive mode selected by that failed change; legacy markers omit it. */
	mode?: InactiveMode;
	/** Native-only Off choice; canonical runtime mode is deliberately not updated. */
	memoryDeferred?: true;
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

/** Read native mode policy only; semantic checkpoint validity remains the recovery owner's concern. */
export function findBranchPolicy(
	branch: readonly BranchEntry[], sessionId: string | undefined, stopEntryType: string | undefined, inactiveMode: InactiveMode,
): { mode: StateFlowMode; persistenceError?: string } | undefined {
	let stopReset = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
				const mode = readCheckpointMode(entry.data, inactiveMode);
				if (mode !== undefined) return { mode };
				const data = entry.data as { disabled?: unknown; mode?: unknown; enabled?: unknown } | undefined;
				if (data?.disabled === true && !Object.hasOwn(data, "mode") && !Object.hasOwn(data, "enabled")) return { mode: inactiveMode };
			} else if (stopEntryType !== undefined && entry.customType === stopEntryType) {
				const data = entry.data as PassiveStopBoundary & { owner?: unknown; reset?: unknown } | undefined;
				if (!data || stopReset || (sessionId === undefined ? typeof data.owner !== "string" || !data.owner.trim() : data.owner !== sessionId)) continue;
				if (data.reset === true) { stopReset = true; continue; }
				if (Number.isSafeInteger(data.at) && data.at >= 0 && data.memoryDeferred === true && data.mode === "off") {
					return { mode: "off", ...(typeof data.persistenceError === "string" && data.persistenceError.trim() ? { persistenceError: data.persistenceError } : {}) };
				}
				if (Number.isSafeInteger(data.at) && data.at >= 0 && typeof data.persistenceError === "string" && data.persistenceError.trim()) {
					return { mode: data.mode === "off" || data.mode === "passive" ? data.mode : inactiveMode, persistenceError: data.persistenceError };
				}
			}
		} catch {
			// Malformed native policy cannot prevent another explicit retained choice from being read.
		}
	}
	return undefined;
}

/** Native policy bookkeeping retains an unacquired fork across extension reloads. */
export function hasPendingFork(branch: readonly BranchEntry[], sessionId: string, entryType: string): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== entryType) continue;
			const data = entry.data as { owner?: unknown; reset?: unknown; forkPending?: unknown } | undefined;
			if (data?.owner !== sessionId) continue;
			if (data.reset === true) return false;
			if (data.forkPending === true) return true;
		} catch {
			// Unrelated native entries grant no fork authority.
		}
	}
	return false;
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

/** Native conversation after the latest valid checkpoint may contain uncompiled work, not a new semantic authority. */
export function hasUncheckpointedConversation(branch: readonly BranchEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type === "message") {
				const role = entry.message?.role;
				if (role === "user" || role === "assistant" || role === "toolResult") return true;
			}
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
				parseRetainedPiCheckpoint(entry.data);
				return false;
			}
		} catch {
			// Malformed entries cannot prove that pending input was checkpointed.
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
	let checkpointSeen = false;
	for (const entry of [...branch].reverse()) {
		try {
			if (entry?.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
				parseRetainedPiCheckpoint(entry.data);
				checkpointSeen = true;
				continue;
			}
			if (entry.customType !== entryType) continue;
			const { at, from, reset, owner, preserveContext, persistenceError, mode } = (entry.data as { at?: unknown; from?: unknown; reset?: unknown; owner?: unknown; preserveContext?: unknown; persistenceError?: unknown; mode?: unknown } | undefined) ?? {};
			if (reset === true && owner === sessionId) return undefined;
			if (owner !== undefined && owner !== sessionId) continue;
			if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) return {
				at,
				...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
				...(preserveContext === true ? { preserveContext: true } : {}),
				...(!checkpointSeen && owner === sessionId && typeof persistenceError === "string" && persistenceError.trim().length > 0 ? { persistenceError } : {}),
				...(mode === "passive" || mode === "off" ? { mode } : {}),
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
