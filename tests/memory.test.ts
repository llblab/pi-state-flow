import assert from "node:assert/strict";
import test from "node:test";
import { inspectMemoryPromotions, retainedMemoryScopes } from "../lib/memory.ts";
import { emptyState } from "../lib/state.ts";

test("classifies flexible external promotion pointers without importing destination schemas", () => {
	const state = {
		...emptyState(),
		working: { memory_promotions: {
			pending: { status: "pending", owner: "knowledge", pointer: "MEMORY.md#candidate" },
			accepted: { status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "abc123", extra: { adapter: "opaque" } },
			failed: { status: "failed", owner: "knowledge", error: "write rejected" },
			unknown: { status: "unknown", owner: "host-memory" },
		} },
	};
	assert.deepEqual(inspectMemoryPromotions(state), [
		{ id: "accepted", status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "abc123" },
		{ id: "failed", status: "failed", owner: "knowledge", error: "write rejected" },
		{ id: "pending", status: "pending", owner: "knowledge", pointer: "MEMORY.md#candidate" },
		{ id: "unknown", status: "unknown", owner: "host-memory" },
	]);
});

test("fails accepted records closed when destination evidence is incomplete", () => {
	const state = { ...emptyState(), working: { memory_promotions: {
		missingRevision: { status: "accepted", owner: "knowledge", pointer: "MEMORY.md" },
		missingOwner: { status: "pending" },
		malformed: "attempted",
	} } };
	const entries = inspectMemoryPromotions(state);
	assert.equal(entries.every(({ status }) => status === "invalid"), true);
	assert.match(entries.find(({ id }) => id === "missingRevision")!.error!, /requires pointer and revision/);
});

test("reports memory-bearing scopes without counting promotion bookkeeping as retained knowledge", () => {
	assert.deepEqual(retainedMemoryScopes({
		global: { ...emptyState(), working: { memory_promotions: { pending: { status: "pending" } } } },
		cwd: { ...emptyState(), contract: { project: true } },
		session: emptyState(),
	}), { global: false, cwd: true, session: false });
});
