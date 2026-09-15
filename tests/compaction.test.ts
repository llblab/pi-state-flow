import assert from "node:assert/strict";
import test from "node:test";
import {
	STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS,
	STATE_FLOW_COMPACTION_SUMMARY,
	hasCompactionSizedTranscript,
	planStateFlowCompaction,
	shouldRequestStateFlowCompaction,
	stateFlowCompactionResult,
} from "../lib/compaction.ts";
import { harness, start } from "./harness.ts";

function entries(options: { foreign?: boolean; retainedForeign?: boolean; terminal?: "stop" | "aborted" } = {}) {
	return [
		{ id: "user-old", type: "message", message: { role: "user", content: "Earlier iteration" } },
		{ id: "assistant-old", type: "message", message: { role: "assistant", content: [], stopReason: "stop" } },
		...(options.foreign ? [{ id: "foreign", type: "custom", customType: "foreign-policy" }] : []),
		{ id: "user-latest", type: "message", message: { role: "user", content: "Latest iteration" } },
		...(options.retainedForeign ? [{ id: "foreign-retained", type: "custom", customType: "foreign-policy" }] : []),
		{ id: "checkpoint", type: "custom", customType: "state-flow-snapshot" },
		{ id: "assistant", type: "message", message: { role: "assistant", content: [], stopReason: options.terminal ?? "stop" } },
		{ id: "leaf", type: "custom", customType: "state-flow-snapshot" },
	];
}

const revision = "a".repeat(40);

function makeTranscriptCompactable(h: ReturnType<typeof harness>): void {
	h.entries.push({ type: "message", message: { role: "user", content: "x".repeat(96_000), timestamp: Date.now() - 2 } });
	h.entries.push({ type: "message", message: { role: "assistant", content: "Earlier answer", stopReason: "stop", timestamp: Date.now() - 1 } });
}

async function acceptRun(h: ReturnType<typeof harness>, label: string): Promise<void> {
	const timestamp = Date.now();
	h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: label }], timestamp } });
	await h.tools.get("patch_state").execute(`terminal-${label}`, { session: { working: { [label]: true } }, final: true }, undefined, undefined, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Accepted ${label}` }], timestamp: timestamp + 1 };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.entries.push({ type: "message", message });
	h.handlers.get("turn_end")!({ message }, h.ctx);
	h.handlers.get("agent_settled")!({}, h.ctx);
}

test("uses context-token usage as the early-compaction readiness signal", () => {
	assert.equal(shouldRequestStateFlowCompaction(undefined), false);
	assert.equal(shouldRequestStateFlowCompaction({ tokens: null }), false);
	assert.equal(shouldRequestStateFlowCompaction({ tokens: STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS - 1 }), false);
	assert.equal(shouldRequestStateFlowCompaction({ tokens: STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS }), true);
});

test("requires enough persisted transcript for native compaction, not only high total context usage", () => {
	assert.equal(hasCompactionSizedTranscript(entries()), false);
	const large = entries();
	(large[0] as any).message.content = "x".repeat(96_000);
	assert.equal(hasCompactionSizedTranscript(large), true);
});

test("retains the complete latest accepted user iteration", () => {
	const plan = planStateFlowCompaction(entries(), revision, 12);
	assert.deepEqual(plan, {
		leafId: "leaf",
		firstKeptEntryId: "user-latest",
		details: { version: 1, owner: "state-flow", revision, step: 12 },
	});
	assert.equal(planStateFlowCompaction(entries({ terminal: "aborted" }), revision, 12), undefined);
	assert.equal(planStateFlowCompaction(entries(), "invalid", 12), undefined);
});

test("refuses to hide foreign custom context only when it precedes the retained iteration", () => {
	assert.equal(planStateFlowCompaction(entries({ foreign: true }), revision, 12), undefined);
	assert.equal(planStateFlowCompaction(entries({ retainedForeign: true }), revision, 12)?.firstKeptEntryId, "user-latest");
});

test("customizes only its private manual request and cancels stale or aborted plans", () => {
	const active = entries();
	const plan = planStateFlowCompaction(active, revision, 12)!;
	const marker = "private-generation-marker";
	const event = {
		reason: "manual" as const,
		customInstructions: marker,
		branchEntries: active,
		preparation: { tokensBefore: 21_000 },
		signal: new AbortController().signal,
	};
	assert.deepEqual(stateFlowCompactionResult(plan, marker, event), {
		summary: STATE_FLOW_COMPACTION_SUMMARY,
		firstKeptEntryId: "user-latest",
		tokensBefore: 21_000,
		details: plan.details,
	});
	assert.equal(stateFlowCompactionResult(plan, marker, { ...event, reason: "threshold" }), undefined);
	assert.equal(stateFlowCompactionResult(plan, marker, { ...event, customInstructions: "user request" }), undefined);
	assert.deepEqual(stateFlowCompactionResult(plan, marker, { ...event, branchEntries: [...active, { id: "new-leaf", type: "message" }] }), { cancel: true });
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(stateFlowCompactionResult(plan, marker, { ...event, signal: controller.signal }), { cancel: true });
});

test("requests one owned compaction only after token-ready accepted non-bootstrap work settles", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Bootstrap");
	makeTranscriptCompactable(h);
	const timestamp = Date.now();
	h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "Latest request" }], timestamp } });
	await h.tools.get("patch_state").execute("terminal", { session: { working: { compacted: true } }, final: true }, undefined, undefined, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted" }], timestamp: timestamp + 1 };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.entries.push({ type: "message", message }); // Native persistence occurs after message_end and before turn_end.
	h.handlers.get("turn_end")!({ message }, h.ctx);
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.compactRequests.length, 1);
	const request = h.compactRequests[0];
	assert.match(request.customInstructions, /^state-flow-boundary:/);
	const branchEntries = h.ctx.sessionManager.buildContextEntries();
	const result = h.handlers.get("session_before_compact")!({
		reason: "manual", customInstructions: request.customInstructions, branchEntries,
		preparation: { tokensBefore: 25_000 }, signal: new AbortController().signal,
	}, h.ctx);
	assert.equal(result.compaction.summary, STATE_FLOW_COMPACTION_SUMMARY);
	assert.equal(result.compaction.firstKeptEntryId, branchEntries.findLast((entry: any) => entry.message?.role === "user").id);
	assert.equal(result.compaction.details.owner, "state-flow");
	assert.match(result.compaction.details.revision, /^[0-9a-f]{40,64}$/);
	assert.equal(h.readState().working.compacted, true);
	request.onComplete({});
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.compactRequests.length, 1, "settlement cannot compact the same accepted run twice");
});

test("short or unknown context remains uncompacted without invoking Pi", async () => {
	for (const contextTokens of [STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS - 1, null] as const) {
		const h = harness({ remotePublication: "off", contextTokens });
		await start(h, "Short");
		await acceptRun(h, "short");
		assert.equal(h.compactRequests.length, 0);
	}
});

test("benign native preparation refusal releases ownership for a later accepted run", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "First");
	makeTranscriptCompactable(h);
	await acceptRun(h, "first");
	assert.equal(h.compactRequests.length, 1);
	h.compactRequests[0].onError(new Error("Nothing to compact (session too small)"));
	await h.handlers.get("before_agent_start")!({ prompt: "Second", systemPrompt: "base" }, h.ctx);
	await acceptRun(h, "second");
	assert.equal(h.compactRequests.length, 2);
	assert.equal(h.compactRequests[1].customInstructions, h.compactRequests[0].customInstructions);
});

test("shutdown fences an admitted compaction before its native hook and later settlement", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Shutdown");
	makeTranscriptCompactable(h);
	await acceptRun(h, "shutdown");
	assert.equal(h.compactRequests.length, 1);
	const request = h.compactRequests[0];
	await h.handlers.get("session_shutdown")!({}, h.ctx);
	const event = {
		reason: "manual" as const,
		customInstructions: request.customInstructions,
		branchEntries: h.ctx.sessionManager.buildContextEntries(),
		preparation: { tokensBefore: 25_000 },
		signal: new AbortController().signal,
	};
	assert.deepEqual(h.handlers.get("session_before_compact")!(event, h.ctx), { cancel: true });
	request.onError(new Error("Compaction cancelled"));
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.compactRequests.length, 1);
});

test("does not request compaction for queued work or a prefix containing foreign custom context", async () => {
	for (const blocked of ["queued", "foreign"] as const) {
		const h = harness({ remotePublication: "off" });
		await start(h, "Bootstrap");
		const timestamp = Date.now();
		if (blocked === "foreign") h.entries.push({ type: "custom", customType: "foreign-policy", data: { retained: true } });
		h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "Latest request" }], timestamp } });
		await h.tools.get("patch_state").execute("terminal", { final: true }, undefined, undefined, h.ctx);
		const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted" }], timestamp: timestamp + 1 };
		h.handlers.get("message_end")!({ message }, h.ctx);
		h.entries.push({ type: "message", message });
		h.handlers.get("turn_end")!({ message }, h.ctx);
		if (blocked === "queued") h.ctx.hasPendingMessages = () => true;
		h.handlers.get("agent_settled")!({}, h.ctx);
		assert.equal(h.compactRequests.length, 0, blocked);
	}
});
