import assert from "node:assert/strict";
import test from "node:test";
import { migrateSnapshot } from "../lib/snapshot.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("migrates legacy two-part snapshots without runtime dependencies", () => {
	assert.deepEqual(migrateSnapshot({
		enabled: true,
		step: 2,
		state: { contract: { goal: "keep" }, working: { next: "continue" } },
	}), {
		enabled: true,
		specification: undefined,
		step: 2,
		validation: undefined,
		bootstrap: false,
		state: { contract: { goal: "keep" }, working: { next: "continue" }, response: "" },
	});
});

test("fails closed on materialized null", () => {
	const result = migrateSnapshot({
		enabled: true,
		state: { contract: {}, working: { invalid: null }, response: "old" },
	});
	assert.equal(result.enabled, false);
	assert.match(result.validation?.error ?? "", /null data/);
});

test("migrates an active two-field snapshot by adding an empty response", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Continue",
			state: { contract: { goal: "keep" }, working: { phase: "active" } },
			step: 2,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	const result = commitTerminal(h, {}, {}, "Migrated.");
	assert.equal(result.message.content[0].text, "Migrated.");
	assert.deepEqual(h.entries.at(-1)!.data.state, {
		contract: { goal: "keep" },
		working: { phase: "active" },
		response: "Migrated.",
	});
});
test("sanitizes malformed snapshot counters and validation feedback on restore", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Continue",
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.NaN,
			validation: { attempt: "many", error: 7, instruction: [] },
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /iteration #0;[\s\S]*validation attempts 0/);

	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
});
test("bounds restored counters before later increments", async () => {
	const malformed = harness();
	malformed.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.MAX_SAFE_INTEGER,
			validation: {
				attempt: Number.MAX_SAFE_INTEGER,
				error: "old",
				instruction: "old",
			},
		},
	});
	malformed.handlers.get("session_start")!({}, malformed.ctx);
	await malformed.commands.get("state-flow-status")!.handler("", malformed.ctx);
	assert.match(malformed.notifications.at(-1)!, /iteration #0;[\s\S]*validation attempts 0/);
	malformed.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, malformed.ctx);
	assert.equal(malformed.entries.at(-1)!.data.validation.attempt, 1);

	const boundary = harness();
	boundary.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.MAX_SAFE_INTEGER - 1,
		},
	});
	boundary.handlers.get("session_start")!({}, boundary.ctx);
	commitTerminal(boundary, {}, {}, "At boundary.");
	assert.equal(boundary.entries.at(-1)!.data.step, Number.MAX_SAFE_INTEGER);
	commitTerminal(boundary, {}, {}, "Past boundary.");
	assert.equal(boundary.entries.at(-1)!.data.step, Number.MAX_SAFE_INTEGER);
	assert.match(boundary.entries.at(-1)!.data.validation.error, /iteration counter is exhausted/);
});
test("disables restoration of non-JSON materialized state", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: { score: Number.NaN }, response: "Previous" },
			step: 3,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /restored disabled: Restored state contains non-JSON data/);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /State Flow disabled; iteration #3/);
	assert.match(h.notifications.at(-1)!, /"response": ""/);
});
test("does not reinterpret a malformed materialized state as legacy working memory", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous", unexpected: true },
			step: 2,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /invalid materialized-state schema/);
	assert.equal(h.statuses.at(-1), undefined);
});
