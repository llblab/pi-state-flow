import assert from "node:assert/strict";
import test from "node:test";
import {
	STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES,
	STATE_FLOW_COMPACTION_SUMMARY,
	planStateFlowCompaction,
	stateFlowCompactionResult,
} from "../lib/compaction.ts";
import { harness, start } from "./harness.ts";

function entries(options: { foreign?: boolean; terminal?: "stop" | "aborted" } = {}) {
	return [
		{ id: "user-old", type: "message", message: { role: "user", content: "x".repeat(STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES) } },
		...(options.foreign ? [{ id: "foreign", type: "custom", customType: "foreign-policy" }] : []),
		{ id: "checkpoint", type: "custom", customType: "state-flow-snapshot" },
		{ id: "assistant", type: "message", message: { role: "assistant", stopReason: options.terminal ?? "stop" } },
		{ id: "leaf", type: "custom", customType: "state-flow-snapshot" },
	];
}

const revision = "a".repeat(40);

async function acceptLargeRun(h: ReturnType<typeof harness>, label: string): Promise<void> {
	const timestamp = Date.now();
	h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `${label}:${"x".repeat(STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES)}` }], timestamp } });
	await h.tools.get("patch_state").execute(`terminal-${label}`, { session: { working: { [label]: true } }, final: true }, undefined, undefined, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Accepted ${label}` }], timestamp: timestamp + 1 };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.entries.push({ type: "message", message });
	h.handlers.get("turn_end")!({ message }, h.ctx);
	h.handlers.get("agent_settled")!({}, h.ctx);
}

test("plans a completed large-history boundary at the accepted assistant while retaining later owned entries", () => {
	const plan = planStateFlowCompaction(entries(), revision, 12);
	assert.deepEqual(plan, {
		leafId: "leaf",
		firstKeptEntryId: "assistant",
		details: { version: 1, owner: "state-flow", revision, step: 12 },
	});
	assert.equal(planStateFlowCompaction(entries().slice(2), revision, 12), undefined, "small active history stays native");
	assert.equal(planStateFlowCompaction(entries({ terminal: "aborted" }), revision, 12), undefined);
	assert.equal(planStateFlowCompaction(entries(), "invalid", 12), undefined);
});

test("refuses to hide foreign custom context from the active prefix", () => {
	assert.equal(planStateFlowCompaction(entries({ foreign: true }), revision, 12), undefined);
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
		firstKeptEntryId: "assistant",
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

test("requests one owned compaction only after a large accepted non-bootstrap run settles", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Bootstrap");
	const timestamp = Date.now();
	h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES) }], timestamp } });
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
	assert.equal(result.compaction.firstKeptEntryId, branchEntries.find((entry: any) => entry.message === message).id);
	assert.equal(result.compaction.details.owner, "state-flow");
	assert.match(result.compaction.details.revision, /^[0-9a-f]{40,64}$/);
	assert.equal(h.readState().working.compacted, true);
	request.onComplete({});
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.compactRequests.length, 1, "settlement cannot compact the same accepted run twice");
});

test("benign native preparation refusal releases ownership for a later accepted run", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "First");
	await acceptLargeRun(h, "first");
	assert.equal(h.compactRequests.length, 1);
	h.compactRequests[0].onError(new Error("Nothing to compact (session too small)"));
	await h.handlers.get("before_agent_start")!({ prompt: "Second", systemPrompt: "base" }, h.ctx);
	await acceptLargeRun(h, "second");
	assert.equal(h.compactRequests.length, 2);
	assert.equal(h.compactRequests[1].customInstructions, h.compactRequests[0].customInstructions);
});

test("shutdown fences an admitted compaction before its native hook and later settlement", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Shutdown");
	await acceptLargeRun(h, "shutdown");
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
		h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES) }], timestamp } });
		if (blocked === "foreign") h.entries.push({ type: "custom", customType: "foreign-policy", data: { retained: true } });
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
