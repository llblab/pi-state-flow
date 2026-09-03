import assert from "node:assert/strict";
import test from "node:test";
import { recoverSnapshot } from "../lib/recovery.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("restores the newest valid snapshot", () => {
	const latest = {
		enabled: true,
		state: { contract: { version: "latest" }, working: {}, response: "Done" },
		step: 2,
	};
	const result = recoverSnapshot([latest]);
	assert.equal(result.snapshot.state.contract.version, "latest");
	assert.deepEqual(result.skipped, []);
});

test("falls back past malformed newer snapshots without resetting the episode", () => {
	const malformed = {
		enabled: true,
		state: { contract: {}, working: { invalid: Number.NaN }, response: "bad" },
		step: 3,
	};
	const previous = {
		enabled: true,
		state: { contract: { durable: true }, working: { next: "continue" }, response: "Good" },
		step: 2,
	};
	const result = recoverSnapshot([malformed, previous]);
	assert.equal(result.snapshot.enabled, true);
	assert.equal(result.snapshot.step, 2);
	assert.deepEqual(result.snapshot.state, previous.state);
	assert.deepEqual(result.skipped, ["Restored state contains non-JSON data"]);
});

test("fails closed only when no valid snapshot remains", () => {
	const result = recoverSnapshot([{ enabled: true, state: { contract: {}, working: {}, response: 7 } }]);
	assert.equal(result.snapshot.enabled, false);
	assert.equal(result.skipped.length, 1);
	assert.match(result.snapshot.validation?.error ?? "", /invalid materialized-state schema|Legacy state/);
});

test("recovers an older valid active-branch snapshot when the newest is malformed", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: { durable: true }, working: { next: "continue" }, response: "Good" },
			step: 2,
		},
	}, {
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: { invalid: Number.NaN }, response: "Bad" },
			step: 3,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /recovered the previous valid snapshot/);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"durable": true/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"invalid"/);
});
test("recovers through a hostile newer branch entry", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: { durable: true }, working: {}, response: "Good" },
			step: 2,
		},
	}, Object.defineProperty({}, "type", {
		get() { throw new Error("hostile newer entry"); },
	}));
	assert.doesNotThrow(() => h.handlers.get("session_start")!({}, h.ctx));
	assert.match(h.notifications.at(-1)!, /recovered the previous valid snapshot/);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
});
test("fails closed when malformed snapshot objects are cyclic or throw during inspection", () => {
	for (const state of [
		(() => {
			const cyclic: any = { contract: {}, working: {}, response: "Previous" };
			cyclic.working.self = cyclic;
			return cyclic;
		})(),
		Object.defineProperty({}, "contract", {
			enumerable: true,
			get() { throw new Error("hostile getter"); },
		}),
	]) {
		const h = harness();
		h.entries.push({
			type: "custom",
			customType: "state-flow-snapshot",
			data: { enabled: true, state, step: 1 },
		});
		assert.doesNotThrow(() => h.handlers.get("session_start")!({}, h.ctx));
		assert.match(h.notifications.at(-1)!, /State Flow restored disabled/);
		assert.equal(h.statuses.at(-1), undefined);
	}

	const hostileBranch = harness();
	hostileBranch.entries.push(Object.defineProperty({}, "type", {
		enumerable: true,
		get() { throw new Error("hostile branch entry"); },
	}));
	assert.doesNotThrow(() => hostileBranch.handlers.get("session_start")!({}, hostileBranch.ctx));
	assert.match(hostileBranch.notifications.at(-1)!, /Snapshot restoration failed: hostile branch entry/);
});
