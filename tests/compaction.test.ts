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

const runAnchorTimestamp = 10;

function entries(options: { foreign?: boolean; retainedForeign?: boolean; foreignType?: "custom" | "custom_message"; steering?: boolean; terminal?: "stop" | "aborted" } = {}) {
	return [
		{ id: "user-old", type: "message", message: { role: "user", content: "Earlier iteration", timestamp: 1 } },
		{ id: "assistant-old", type: "message", message: { role: "assistant", content: [], stopReason: "stop", timestamp: 2 } },
		...(options.foreign ? [{ id: "foreign", type: options.foreignType ?? "custom", customType: "foreign-policy" }] : []),
		{ id: "user-latest", type: "message", message: { role: "user", content: "Latest iteration", timestamp: runAnchorTimestamp } },
		...(options.retainedForeign ? [{ id: "foreign-retained", type: options.foreignType ?? "custom", customType: "foreign-policy" }] : []),
		...(options.steering ? [
			{ id: "tool-call", type: "message", message: { role: "assistant", content: [], stopReason: "toolUse", timestamp: 11 } },
			{ id: "tool-result", type: "message", message: { role: "toolResult", content: [], timestamp: 12 } },
			{ id: "steer-one", type: "message", message: { role: "user", content: "First refinement", timestamp: 13 } },
			{ id: "steer-two", type: "message", message: { role: "user", content: "Second refinement", timestamp: 14 } },
		] : []),
		{ id: "checkpoint", type: "custom", customType: "state-flow-snapshot" },
		{ id: "assistant", type: "message", message: { role: "assistant", content: [], stopReason: options.terminal ?? "stop", timestamp: 15 } },
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
	const request = { role: "user", content: [{ type: "text", text: label }], timestamp };
	h.handlers.get("message_end")!({ message: request }, h.ctx);
	h.entries.push({ type: "message", message: request });
	await h.tools.get("patch_state").execute(`terminal-${label}`, { session: { working: { [label]: true } } }, undefined, undefined, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Accepted ${label}` }], timestamp: timestamp + 1 };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.entries.push({ type: "message", message });
	await h.handlers.get("turn_end")!({ message }, h.ctx);
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

test("retains the complete latest accepted user iteration instead of using native retain-none", () => {
	const plan = planStateFlowCompaction(entries(), revision, 12, runAnchorTimestamp);
	assert.deepEqual(plan, {
		leafId: "leaf",
		firstKeptEntryId: "user-latest",
		details: { version: 1, owner: "state-flow", boundary: revision, step: 12 },
	});
	assert.notEqual(plan?.firstKeptEntryId, null, "the latest exact user/assistant exchange remains model-visible");
	assert.equal(planStateFlowCompaction(entries({ terminal: "aborted" }), revision, 12, runAnchorTimestamp), undefined);
	assert.equal(planStateFlowCompaction(entries(), "", 12, runAnchorTimestamp), undefined);
});

for (const foreignType of ["custom", "custom_message"] as const) {
	test(`refuses to hide foreign ${foreignType} context only before the retained iteration`, () => {
		assert.equal(planStateFlowCompaction(entries({ foreign: true, foreignType }), revision, 12, runAnchorTimestamp), undefined);
		assert.equal(planStateFlowCompaction(entries({ retainedForeign: true, foreignType }), revision, 12, runAnchorTimestamp)?.firstKeptEntryId, "user-latest");
	});
}

for (const retainedForeign of [false, true]) {
	test(`compaction retains the run anchor across steering and tool results (foreign=${retainedForeign})`, () => {
		const active = entries({ steering: true, retainedForeign, foreignType: "custom_message" });
		const before = structuredClone(active);
		const plan = planStateFlowCompaction(active, revision, 12, runAnchorTimestamp);
		assert.equal(plan?.firstKeptEntryId, "user-latest");
		assert.deepEqual(active, before);
	});
}

test("compaction refuses absent, ambiguous, or unfinished run anchors instead of guessing", () => {
	for (const anchor of [undefined, NaN, Infinity, 999]) {
		assert.equal(planStateFlowCompaction(entries(), revision, 12, anchor), undefined);
	}
	const ambiguous = entries();
	ambiguous.unshift({ id: "duplicate-time", type: "message", message: { role: "user", content: "Another request", timestamp: runAnchorTimestamp } });
	assert.equal(planStateFlowCompaction(ambiguous, revision, 12, runAnchorTimestamp), undefined);
	const unfinished = entries();
	unfinished.push({ id: "pending-user", type: "message", message: { role: "user", content: "Unanswered", timestamp: 20 } });
	assert.equal(planStateFlowCompaction(unfinished, revision, 12, 20), undefined);
	const notUser = entries();
	notUser.find((entry) => entry.id === "user-latest")!.message!.role = "toolResult";
	assert.equal(planStateFlowCompaction(notUser, revision, 12, runAnchorTimestamp), undefined);
});

test("customizes only its private manual request and cancels stale or aborted plans", () => {
	const active = entries();
	const plan = planStateFlowCompaction(active, revision, 12, runAnchorTimestamp)!;
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
	const h = harness();
	await start(h, "Bootstrap");
	makeTranscriptCompactable(h);
	const timestamp = Date.now();
	const requestMessage = { role: "user", content: [{ type: "text", text: "Latest request" }], timestamp };
	h.handlers.get("message_end")!({ message: requestMessage }, h.ctx);
	h.entries.push({ type: "message", message: requestMessage });
	await h.tools.get("patch_state").execute("terminal", { session: { working: { compacted: true } } }, undefined, undefined, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted" }], timestamp: timestamp + 1 };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.entries.push({ type: "message", message }); // Native persistence occurs after message_end and before turn_end.
	await h.handlers.get("turn_end")!({ message }, h.ctx);
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
	assert.equal(typeof result.compaction.details.boundary, "string");
	assert.ok(result.compaction.details.boundary.length > 0);
	assert.equal(h.readState().working.compacted, true);
	request.onComplete({});
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.compactRequests.length, 1, "settlement cannot compact the same accepted run twice");
});

test("short or unknown context remains uncompacted without invoking Pi", async () => {
	for (const contextTokens of [STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS - 1, null] as const) {
		const h = harness({ contextTokens });
		await start(h, "Short");
		await acceptRun(h, "short");
		assert.equal(h.compactRequests.length, 0);
	}
});

for (const boundary of ["missing", "ambiguous", "unobserved"] as const) {
	test(`context projection cannot rebase the ${boundary} native run anchor onto steering`, async () => {
		const h = harness({ initializeRepository: false });
		await start(h, "Original request");
		makeTranscriptCompactable(h);
		const original = { role: "user", content: [{ type: "text", text: "Original request" }], timestamp: 10 };
		if (boundary !== "unobserved") h.handlers.get("message_end")!({ message: original }, h.ctx);
		if (boundary !== "missing") h.entries.push({ type: "message", message: original });
		if (boundary === "ambiguous") h.entries.push({ type: "message", message: { ...original, content: [{ type: "text", text: "Different user at the same timestamp" }] } });
		for (const timestamp of [20, 21]) {
			const steering = { role: "user", content: [{ type: "text", text: `Steering ${timestamp}` }], timestamp };
			if (boundary !== "unobserved") h.handlers.get("message_end")!({ message: steering }, h.ctx);
			h.entries.push({ type: "message", message: steering });
			const messages = h.entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
			const projected = h.handlers.get("context")!({ messages }, h.ctx);
			if (boundary !== "unobserved") {
				const retained: unknown[] = projected.messages.slice(1);
				assert.equal(retained.length, messages.length, "an uncertain boundary retains available context");
				assert.ok(retained.every((entry, index) => entry === messages[index]), "retain native message identity and order");
			}
		}
		const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted without guessing a boundary" }], timestamp: 30 };
		h.handlers.get("message_end")!({ message: answer }, h.ctx);
		h.entries.push({ type: "message", message: answer });
		await h.handlers.get("turn_end")!({ message: answer }, h.ctx);
		h.handlers.get("agent_settled")!({}, h.ctx);
		assert.equal(h.readState().response, "Accepted without guessing a boundary");
		assert.equal(h.compactRequests.length, 0, "projection must not promote a fallback timestamp to lifecycle authority");
	});
}

test("native session boundaries invalidate observed run capture without projection reacquisition", async () => {
	for (const boundary of [undefined, "session_tree", "session_start"] as const) {
		const h = harness({ initializeRepository: false });
		await start(h, "Original request");
		makeTranscriptCompactable(h);
		const request = { role: "user", content: "Original request", timestamp: 10 };
		h.handlers.get("message_end")!({ message: request }, h.ctx);
		h.entries.push({ type: "message", message: request });
		if (boundary) await h.handlers.get(boundary)!({ reason: "resume" }, h.ctx);
		h.handlers.get("context")!({ messages: h.entries.filter((entry) => entry.type === "message").map((entry) => entry.message) }, h.ctx);
		const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted after selection" }], timestamp: 20 };
		h.handlers.get("message_end")!({ message: answer }, h.ctx);
		h.entries.push({ type: "message", message: answer });
		await h.handlers.get("turn_end")!({ message: answer }, h.ctx);
		const settling = h.handlers.get("agent_settled")!({}, h.ctx);
		assert.equal(h.compactRequests.length, boundary === undefined ? 1 : 0, boundary ?? "unchanged native run");
		h.compactRequests.at(-1)?.onComplete({});
		await settling;
	}
});

test("benign native preparation refusal releases ownership for a later accepted run", async () => {
	const h = harness();
	await start(h, "First");
	makeTranscriptCompactable(h);
	await acceptRun(h, "first");
	assert.equal(h.compactRequests.length, 1);
	h.compactRequests[0].onError(new Error("Nothing to compact (session too small)"));
	await h.beginRun("Second");
	await acceptRun(h, "second");
	assert.equal(h.compactRequests.length, 2);
	assert.equal(h.compactRequests[1].customInstructions, h.compactRequests[0].customInstructions);
});

test("shutdown fences an admitted compaction before its native hook and later settlement", async () => {
	const h = harness();
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
		const h = harness();
		await start(h, "Bootstrap");
		makeTranscriptCompactable(h);
		const timestamp = Date.now();
		if (blocked === "foreign") h.entries.push({ type: "custom", customType: "foreign-policy", data: { retained: true } });
		const request = { role: "user", content: [{ type: "text", text: "Latest request" }], timestamp };
		h.handlers.get("message_end")!({ message: request }, h.ctx);
		h.entries.push({ type: "message", message: request });
		const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted" }], timestamp: timestamp + 1 };
		h.handlers.get("message_end")!({ message }, h.ctx);
		h.entries.push({ type: "message", message });
		await h.handlers.get("turn_end")!({ message }, h.ctx);
		if (blocked === "queued") h.ctx.hasPendingMessages = () => true;
		h.handlers.get("agent_settled")!({}, h.ctx);
		assert.equal(h.compactRequests.length, 0, blocked);
	}
});
