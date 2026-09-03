import assert from "node:assert/strict";
import test from "node:test";
import { discoverSnapshotData, hasPriorConversation, latestSnapshotData, snapshotDataNewestFirst, SNAPSHOT_ENTRY_TYPE } from "../lib/session.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("selects the latest snapshot from the active branch", () => {
	const first = { enabled: true, step: 1 };
	const latest = { enabled: true, step: 2 };
	const branch = [
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: first },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: latest },
	];
	assert.equal(latestSnapshotData(branch), latest);
	assert.deepEqual(snapshotDataNewestFirst(branch), [latest, first]);
});

test("does not leak snapshots across an empty or unrelated branch", () => {
	assert.equal(latestSnapshotData([]), undefined);
	assert.equal(latestSnapshotData([{ type: "custom", customType: "other", data: true }]), undefined);
});

test("detects only model-context conversation roles", () => {
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "user" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "assistant" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "toolResult" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "bashExecution" } }]), false);
	assert.equal(hasPriorConversation([{ type: "custom", customType: "other" }]), false);
});

test("contains hostile branch entries and continues snapshot discovery", () => {
	const hostile = Object.defineProperty({}, "type", {
		get() { throw new Error("hostile entry"); },
	});
	const valid = { enabled: true, step: 2 };
	const discovery = discoverSnapshotData([
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: valid },
		hostile,
	]);
	assert.deepEqual(discovery.candidates, [valid]);
	assert.deepEqual(discovery.errors, ["hostile entry"]);
	assert.doesNotThrow(() => hasPriorConversation([hostile]));
});

test("restores State Flow from the active branch after tree navigation", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { branch: "abandoned" }, { next: "old" });
	h.entries.splice(0, h.entries.length, {
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Branch request",
			state: {
				contract: { branch: "active" },
				working: { next: "new" },
				response: "Branch response",
			},
			step: 4,
		},
	});
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#4</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"branch": "active"/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"branch": "abandoned"/);

	h.entries.splice(0, h.entries.length);
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /State Flow disabled; iteration #0/);
});
