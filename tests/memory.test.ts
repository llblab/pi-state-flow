import assert from "node:assert/strict";
import test from "node:test";
import { retainedMemoryScopes } from "../lib/memory.ts";
import { emptyState } from "../lib/state.ts";

test("reports memory-bearing scopes without reserving promotion bookkeeping", () => {
	assert.deepEqual(retainedMemoryScopes({
		global: { ...emptyState(), tactics: { memory_promotions: { ordinaryUserData: true } } },
		cwd: { ...emptyState(), strategy: { project: true } },
		session: emptyState(),
	}), { global: true, cwd: true, session: false });
});
