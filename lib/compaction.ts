import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type CompactionResult } from "@earendil-works/pi-coding-agent";

export const STATE_FLOW_COMPACTION_SUMMARY = "State Flow accepted the completed work before this boundary. Current memory is restored from its retained semantic boundary and projected separately; use the retained native entries for subsequent work.";
/** A modest margin above Pi's default 20k retained suffix absorbs estimation drift. */
export const STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS = 24_000;

export interface StateFlowCompactionDetails {
	version: 1;
	owner: "state-flow";
	boundary: string;
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
	message?: { role?: unknown; stopReason?: unknown; content?: unknown; timestamp?: unknown };
};

function stateFlowEntry(entry: ActiveEntry): boolean {
	return entry.type === "custom"
		&& typeof entry.customType === "string"
		&& entry.customType.startsWith("state-flow-");
}

export function shouldRequestStateFlowCompaction(usage: { tokens: number | null } | undefined): boolean {
	return typeof usage?.tokens === "number"
		&& Number.isFinite(usage.tokens)
		&& usage.tokens >= STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS;
}

/**
 * Pi's public usage includes the system prompt, while native compaction can only
 * shorten persisted messages. Avoid requesting a visibly failing manual
 * compaction when that transcript is still below the useful-history floor.
 */
export function hasCompactionSizedTranscript(entries: readonly ActiveEntry[]): boolean {
	let tokens = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || typeof entry.message?.role !== "string") continue;
		tokens += estimateTokens(entry.message as unknown as AgentMessage);
		if (tokens >= STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS) return true;
	}
	return false;
}

/** Retain the complete latest accepted user iteration without hiding foreign extension context. */
export function planStateFlowCompaction(
	entries: readonly ActiveEntry[],
	boundary: string,
	step: number,
	runAnchorTimestamp: number | undefined,
): StateFlowCompactionPlan | undefined {
	if (boundary.trim().length === 0 || typeof runAnchorTimestamp !== "number" || !Number.isFinite(runAnchorTimestamp)) return undefined;
	if (!Number.isSafeInteger(step) || step < 0 || entries.length === 0) return undefined;
	const terminal = entries.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "assistant");
	if (terminal < 0 || entries[terminal]?.message?.stopReason === "aborted"
		|| entries[terminal]?.message?.stopReason === "error"
		|| entries[terminal]?.message?.stopReason === "length") return undefined;
	// Steering is part of the same run; an absent or colliding timestamp cannot prove its first entry.
	const isRunAnchor = (entry: ActiveEntry) => entry.type === "message" && entry.message?.role === "user" && entry.message.timestamp === runAnchorTimestamp;
	const keep = entries.findIndex(isRunAnchor);
	if (keep < 0 || keep > terminal || entries.findLastIndex(isRunAnchor) !== keep) return undefined;
	if (entries.slice(0, keep).some((entry) => entry.type === "custom_message" || (entry.type === "custom" && !stateFlowEntry(entry)))) return undefined;
	const firstKeptEntryId = entries[keep]?.id;
	const leafId = entries.at(-1)?.id;
	if (typeof firstKeptEntryId !== "string" || typeof leafId !== "string") return undefined;
	return { leafId, firstKeptEntryId, details: { version: 1, owner: "state-flow", boundary, step } };
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

const STATE_FLOW_COMPACTION_MARKER_PREFIX = "state-flow-boundary:";

type CompactionEvent = Parameters<typeof stateFlowCompactionResult>[2];

/** Completed-history compaction request state owned by one extension instance. */
export class StateFlowCompactionRequests {
	#plan: StateFlowCompactionPlan | undefined;
	#marker: string | undefined;
	#inFlight = false;
	#stopped = false;
	readonly #prefix = `${STATE_FLOW_COMPACTION_MARKER_PREFIX}${randomUUID()}:`;

	get inFlight(): boolean { return this.#inFlight; }
	get stopped(): boolean { return this.#stopped; }

	/** Permanently refuse owned requests (shutdown). */
	stop(): void { this.#stopped = true; }

	/** Drop the run-local plan; a stale callback can no longer clear a newer one. */
	clear(): void {
		this.#plan = undefined;
		this.#inFlight = false;
	}

	/** Install a plan and return its unique per-request marker. */
	begin(plan: StateFlowCompactionPlan): string {
		this.#plan = plan;
		const marker = this.#marker = `${this.#prefix}${randomUUID()}`;
		this.#inFlight = true;
		return marker;
	}

	/** Native completion clears only its own request. */
	finish(marker: string): void {
		if (this.#marker === marker) this.clear();
	}

	/** Answer session_before_compact: foreign requests pass, stale or unpermitted owned ones cancel. */
	resolve(event: CompactionEvent, permitted: boolean): ReturnType<typeof stateFlowCompactionResult> {
		if (event.reason !== "manual" || !event.customInstructions?.startsWith(STATE_FLOW_COMPACTION_MARKER_PREFIX)) return undefined;
		const marker = this.#marker;
		if (!permitted || this.#stopped || !this.#plan || !marker || event.customInstructions !== marker) return { cancel: true };
		return stateFlowCompactionResult(this.#plan, marker, event);
	}
}
