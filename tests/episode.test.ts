import assert from "node:assert/strict";
import test from "node:test";
import { abandonValidation, prepareRun, startEpisode, stopEpisode } from "../lib/episode.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("starts and explicitly stops isolated episodes", () => {
	assert.deepEqual(startEpisode(true), {
		enabled: true,
		state: { contract: {}, working: {}, response: "" },
		step: 0,
		bootstrap: true,
	});
	assert.deepEqual(stopEpisode(), {
		enabled: false,
		state: { contract: {}, working: {}, response: "" },
		step: 0,
	});
});

test("rotates specifications only at non-retry run boundaries", () => {
	const snapshot = startEpisode(false);
	assert.equal(prepareRun(snapshot, "first", false), true);
	snapshot.validation = { attempt: 1, error: "invalid", instruction: "retry" };
	assert.equal(prepareRun(snapshot, "retry payload", true), false);
	assert.equal(snapshot.specification, "first");
	assert.equal(snapshot.validation.attempt, 1);
	assert.equal(prepareRun(snapshot, "second", false), true);
	assert.equal(snapshot.specification, "second");
	assert.equal(snapshot.validation, undefined);
});

test("abandons validation without disabling or clearing state", () => {
	const snapshot = startEpisode(false);
	snapshot.state.working.next = "continue";
	snapshot.validation = { attempt: 2, error: "invalid", instruction: "retry" };
	assert.equal(abandonValidation(snapshot), true);
	assert.equal(abandonValidation(snapshot), false);
	assert.equal(snapshot.enabled, true);
	assert.deepEqual(snapshot.state.working, { next: "continue" });
});

test("does not demand a terminal handoff from an aborted response", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(result, undefined);
	assert.equal(h.sentMessages.length, 0);
	assert.equal(h.entries.at(-1)!.data.step, 0);
});
test("abandons an interrupted validation retry before the next user run", async () => {
	const h = harness();
	await start(h, "Old request");
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	assert.equal(h.sentMessages.length, 1);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);

	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation, undefined);
	const next = h.handlers.get("before_agent_start")!({ prompt: "New request", systemPrompt: "base" }, h.ctx);
	assert.doesNotMatch(next.systemPrompt, /Old request|New request/);
	assert.equal(h.entries.at(-1)!.data.specification, "New request");
});
test("stop disables State Flow and clears the complete episode", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { goal: "x" }, { next: "y" });
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	assert.deepEqual(h.entries.at(-1)!.data, {
		enabled: false,
		state: { contract: {}, working: {}, response: "" },
		step: 0,
	});
	assert.equal(h.statuses.at(-1), undefined);
});
