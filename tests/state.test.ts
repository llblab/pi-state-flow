import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, isStateDocument } from "../lib/state.ts";

test("creates isolated state documents with the exact public shape", () => {
	const first = emptyState();
	first.contract.changed = true;
	assert.deepEqual(emptyState(), { contract: {}, working: {}, response: "" });
});

test("accepts only exact materialized state documents", () => {
	assert.equal(isStateDocument({ contract: {}, working: {}, response: "done" }), true);
	assert.equal(isStateDocument({ contract: {}, working: {} }), false);
	assert.equal(isStateDocument({ contract: {}, working: {}, response: "done", extra: true }), false);
});
