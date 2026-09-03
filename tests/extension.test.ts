import assert from "node:assert/strict";
import test from "node:test";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("registers no tools and exposes only argument-free lifecycle commands", () => {
	const h = harness();
	assert.equal(h.registeredTools, 0);
	assert.deepEqual([...h.commands.keys()], ["state-flow-start", "state-flow-status", "state-flow-stop"]);
});
test("lets tool-bearing responses run without comments or intermediate state commits", async () => {
	const h = harness();
	await start(h, "Investigate");
	const beforeEntries = h.entries.length;
	const response = h.handlers.get("message_end")!({ message: toolAssistant("read-1") }, h.ctx);
	assert.equal(response, undefined);
	h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.entries.at(-1)!.data.step, 0);
});
