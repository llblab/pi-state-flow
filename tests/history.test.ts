import assert from "node:assert/strict";
import test from "node:test";
import { createAcceptedTransition, projectRecentTransitionsWithLimit, validateRecentTransition, type RecentTransition } from "../lib/history.ts";
import { emptyState, type ScopedStates } from "../lib/state.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";

function recent(id: string, at: number, scope: "global" | "cwd" | "session" = "session"): RecentTransition {
	return { id, at, transitions: [{ scope, patch: { working: { id } } }] };
}

test("accepted cohort is exact replay without a clock, full states, or identity for no-ops", () => {
	const current: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	current.session.working = { removed: true, nested: { keep: true, old: true } };
	const next = structuredClone(current);
	next.session.working = { nested: { keep: true, added: 1 } };
	next.session.response = "Done";
	next.cwd.contract = { reusable: true };
	const cohort = createAcceptedTransition(current, next, "accepted");
	assert.deepEqual(Object.keys(cohort!).sort(), ["id", "transitions"]);
	assert.equal(cohort!.id, "accepted");
	assert.deepEqual(cohort!.transitions.map(({ scope }) => scope), ["cwd", "session"]);
	for (const { scope, patch } of cohort!.transitions) assert.deepEqual(applyPatch(current[scope], patch as JsonObject), next[scope]);
	assert.equal(createAcceptedTransition(current, current), undefined);
	cohort!.transitions[0]!.patch.contract!.reusable = false;
	assert.equal(next.cwd.contract.reusable, true);
});

test("compact history preserves supplied lineage order and configured per-scope projection budget", () => {
	// Lexical IDs and position values intentionally disagree with array order: neither sorts lineage.
	const lineage = [recent("z", 99, "global"), recent("y", 10, "cwd"), recent("x", 1), recent("a", 0)];
	assert.deepEqual(projectRecentTransitionsWithLimit(1, lineage).map(({ id }) => id), ["z", "y", "a"]);
	assert.deepEqual(projectRecentTransitionsWithLimit(0, lineage), []);
	assert.deepEqual(projectRecentTransitionsWithLimit(7, lineage), lineage);
	for (const limit of [-1, 8, 0.5]) assert.throws(() => projectRecentTransitionsWithLimit(limit, lineage), /integer from 0 to 7/);
	const cohort = { id: "cohort", at: 100, transitions: [recent("unused", 0, "global").transitions[0]!, recent("unused", 0).transitions[0]!] };
	const projected = projectRecentTransitionsWithLimit(1, [...lineage, cohort]);
	assert.deepEqual(projected.map(({ id }) => id), ["y", "cohort"]);
	assert.deepEqual(projected.at(-1)!.transitions.map(({ scope }) => scope), ["global", "session"]);
	projected.at(-1)!.transitions[0]!.patch.working!.id = "mutated";
	assert.equal(cohort.transitions[0]!.patch.working!.id, "unused");
});

test("replay patch validation rejects invalid identities, envelopes, scopes, and fields", () => {
	assert.doesNotThrow(() => validateRecentTransition(recent("valid", 0)));
	for (const value of [
		{ ...recent("valid", 0), extra: true }, { ...recent("valid", 0), id: "" },
		{ ...recent("valid", 0), at: -1 }, { ...recent("valid", 0), transitions: [] },
		{ id: "bad", at: 0, transitions: [{ scope: "unknown", patch: {} }] },
		{ id: "bad", at: 0, transitions: [{ scope: "cwd", patch: { response: "forbidden" } }] },
		{ id: "bad", at: 0, transitions: [{ scope: "session", patch: { config: {} } }] },
		{ id: "bad", at: 0, transitions: [{ scope: "session", patch: { working: [] } }] },
		{ id: "bad", at: 0, transitions: [...recent("x", 0).transitions, ...recent("y", 1).transitions] },
	]) assert.throws(() => validateRecentTransition(value));
});
