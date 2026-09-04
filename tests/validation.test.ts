import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VALIDATION_RETRIES, nextValidation } from "../lib/validation.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("advances bounded validation retries deterministically", () => {
	let feedback;
	for (let attempt = 1; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
		const decision = nextValidation(feedback, "invalid terminal");
		assert.equal(decision.kind, "retry");
		if (decision.kind !== "retry") assert.fail("retry expected");
		assert.equal(decision.feedback.attempt, attempt);
		assert.match(decision.feedback.instruction, /Regenerate only the terminal commit/);
		feedback = decision.feedback;
	}
	assert.deepEqual(nextValidation(feedback, "still invalid"), {
		kind: "exhausted",
		error: "still invalid",
	});
});

test("does not mutate prior validation feedback", () => {
	const previous = { attempt: 1, error: "old", instruction: "old" };
	nextValidation(previous, "new");
	assert.deepEqual(previous, { attempt: 1, error: "old", instruction: "old" });
});

test("keeps validation attempt accounting across tool-bearing retry turns", async () => {
	const h = harness();
	await start(h);
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	h.handlers.get("message_end")!({ message: toolAssistant("read-during-retry") }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow still-invalid -->" }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 2);
});
test("regenerates when a later handler removes the finalized response", async () => {
	const h = harness();
	await start(h);
	const staged = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nOriginal response` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: { ...staged.message, content: [] } }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	assert.equal(h.entries.at(-1)!.data.step, 0);
	assert.equal(h.sentMessages.length, 1);

	h.handlers.get("message_end")!({ message: toolAssistant("retry-tool") }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	const recovered = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Recovered response" }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: recovered.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 1);
	assert.equal(h.entries.at(-1)!.data.validation, undefined);
	assert.equal(h.entries.at(-1)!.data.state.response, "Recovered response");
});
test("regenerates invalid terminal responses without automatically disabling after the retry limit", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { durable: true }, { pending: "next" });
	const committed = structuredClone(h.entries.at(-1)!.data.state);
	for (let attempt = 0; attempt < 4; attempt++) {
		const rejected = h.handlers.get("message_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
		}, h.ctx);
		assert.deepEqual(rejected.message.content, []);
		h.handlers.get("turn_end")!({}, h.ctx);
	}
	assert.equal(h.sentMessages.length, 3);
	assert.match(h.notifications.at(-1)!, /remains enabled after 3 automatic regeneration attempts/);
	assert.equal(h.entries.at(-1)!.data.enabled, true);
	assert.equal(h.entries.at(-1)!.data.validation, undefined);
	assert.deepEqual(h.entries.at(-1)!.data.state, committed);
});
