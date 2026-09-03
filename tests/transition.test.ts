import assert from "node:assert/strict";
import test from "node:test";
import { stageTransition, commitTransition } from "../lib/transition.ts";
import { emptyState } from "../lib/state.ts";
import type { Snapshot } from "../lib/snapshot.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

function snapshot(): Snapshot {
	return { enabled: true, state: emptyState(), step: 0, bootstrap: true };
}

test("stages and commits an atomic state transition", () => {
	const current = snapshot();
	const stage = stageTransition(current.state, {
		contract: { goal: "ship" },
		working: { next: "test" },
		response: "Done",
	}, []);
	assert.equal(commitTransition(current, stage), true);
	assert.equal(commitTransition(current, stage), false);
	assert.deepEqual(current, {
		enabled: true,
		state: { contract: { goal: "ship" }, working: { next: "test" }, response: "Done" },
		step: 1,
		bootstrap: false,
		validation: undefined,
	});
});

test("rejects stale compare-and-swap stages", () => {
	const current = snapshot();
	const stage = stageTransition(current.state, emptyState(), []);
	current.state.working.changed = true;
	assert.throws(() => commitTransition(current, stage), /State changed after response validation/);
});

test("requires compilations for successful Skill reads before staging", () => {
	const source = "/skills/demo/SKILL.md";
	assert.throws(
		() => stageTransition(emptyState(), emptyState(), [source]),
		/missing: \/skills\/demo\/SKILL\.md/,
	);
	assert.doesNotThrow(() => stageTransition(emptyState(), {
		contract: { compiled_skills: { [source]: { route: "demo" } } },
		working: {},
		response: "Done",
	}, [source]));
});

test("commits and hides one useful terminal patch after the tool loop", async () => {
	const h = harness();
	await start(h);
	const result = commitTerminal(
		h,
		{ goal: "Inspect project", compiled_rules: { read_once: true } },
		{ verified: { readme: true }, next: "run tests" },
		"Inspection complete.",
	);
	assert.equal(result.message.content[0].text, "Inspection complete.");
	const snapshot = h.entries.at(-1)!.data;
	assert.equal(snapshot.step, 1);
	assert.deepEqual(snapshot.state, {
		contract: { goal: "Inspect project", compiled_rules: { read_once: true } },
		working: { verified: { readme: true }, next: "run tests" },
		response: "Inspection complete.",
	});
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#1</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /iteration #1;[\s\S]*validation attempts 0\.\n\n\{/);
	assert.match(h.notifications.at(-1)!, /"goal": "Inspect project"/);
	assert.match(h.notifications.at(-1)!, /"next": "run tests"/);
	assert.match(h.notifications.at(-1)!, /"response": "Inspection complete\."/);
});
test("accepts unchanged contract and working memory when the run produced no durable information", async () => {
	const h = harness();
	const started = await start(h);
	assert.match(started.systemPrompt, /SKILL COMPILATION/);
	assert.match(started.systemPrompt, /After a successful SKILL\.md read/);
	assert.match(started.systemPrompt, /contract\.compiled_skills\[exact read path\]/);
	assert.match(started.systemPrompt, /MUST NOT reread for recall or routine activation/);
	assert.match(started.systemPrompt, /Mere possibility of change is not evidence/);
	assert.match(started.systemPrompt, /MEMORY OPTIMIZATION/);
	assert.match(started.systemPrompt, /Never invent a change; use \{\} when nothing future-relevant changed/);
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nDone` }],
		},
	}, h.ctx);
	assert.equal(result.message.content[0].text, "Done");
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 1);
	assert.deepEqual(h.entries.at(-1)!.data.state, { contract: {}, working: {}, response: "Done" });
});
test("uses nested null as deletion and rejects materialized null data", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { mode: "test" }, { move: "e2-e4", result: "pending" });
	commitTerminal(h, {}, { move: null, result: "ok" });
	assert.deepEqual(h.entries.at(-1)!.data.state, {
		contract: { mode: "test" },
		working: { result: "ok" },
		response: "Done",
	});
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, { cells: ["pawn", null] })}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /Materialized state cannot contain null/);
});
