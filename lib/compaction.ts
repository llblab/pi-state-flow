import type { CompactionResult } from "@earendil-works/pi-coding-agent";

export const STATE_FLOW_COMPACTION_SUMMARY = "State Flow accepted the completed work before this boundary. Current memory is restored from its durable revision and projected separately; use the retained native entries for subsequent work.";
export const STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES = 80_000;

export interface StateFlowCompactionDetails {
	version: 1;
	owner: "state-flow";
	revision: string;
	step: number;
}

export interface StateFlowCompactionPlan {
	leafId: string;
	firstKeptEntryId: string;
	details: StateFlowCompactionDetails;
}

type ActiveEntry = {
	id?: unknown;
	type?: unknown;
	customType?: unknown;
	message?: { role?: unknown; stopReason?: unknown };
};

function stateFlowEntry(entry: ActiveEntry): boolean {
	return entry.type === "custom"
		&& typeof entry.customType === "string"
		&& entry.customType.startsWith("state-flow-");
}

/** Select one completed native boundary without hiding foreign extension context. */
export function planStateFlowCompaction(
	entries: readonly ActiveEntry[],
	revision: string,
	step: number,
): StateFlowCompactionPlan | undefined {
	if (!/^[0-9a-f]{40,64}$/.test(revision) && !/^file:[0-9a-f]{64}$/.test(revision)) return undefined;
	if (!Number.isSafeInteger(step) || step < 0 || entries.length === 0) return undefined;
	if (Buffer.byteLength(JSON.stringify(entries), "utf8") < STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES) return undefined;
	const keep = entries.findLastIndex((entry) => entry.type === "message"
		&& entry.message?.role === "assistant"
		&& entry.message.stopReason !== "aborted"
		&& entry.message.stopReason !== "error"
		&& entry.message.stopReason !== "length");
	if (keep < 0) return undefined;
	if (entries.slice(0, keep).some((entry) => entry.type === "custom" && !stateFlowEntry(entry))) return undefined;
	const firstKeptEntryId = entries[keep]?.id;
	const leafId = entries.at(-1)?.id;
	if (typeof firstKeptEntryId !== "string" || typeof leafId !== "string") return undefined;
	return { leafId, firstKeptEntryId, details: { version: 1, owner: "state-flow", revision, step } };
}

/** Customize only the extension-owned manual request and only while its planned leaf remains selected. */
export function stateFlowCompactionResult(
	plan: StateFlowCompactionPlan,
	marker: string,
	event: {
		reason: "manual" | "threshold" | "overflow";
		customInstructions?: string;
		branchEntries: readonly ActiveEntry[];
		preparation: { tokensBefore: number };
		signal: AbortSignal;
	},
): CompactionResult<StateFlowCompactionDetails> | { cancel: true } | undefined {
	if (event.reason !== "manual" || event.customInstructions !== marker) return undefined;
	if (event.signal.aborted || event.branchEntries.at(-1)?.id !== plan.leafId) return { cancel: true };
	return {
		summary: STATE_FLOW_COMPACTION_SUMMARY,
		firstKeptEntryId: plan.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: structuredClone(plan.details),
	};
}
