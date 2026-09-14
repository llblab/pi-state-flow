import assert from "node:assert/strict";
import test from "node:test";
import { parseStateReadPath, readStatePath, type StateReadResult } from "../lib/query.ts";
import { emptyState } from "../lib/state.ts";
import { advanceTemporalState, createTemporalState } from "../lib/temporal.ts";

function state(result: StateReadResult) {
	if (!("state" in result)) assert.fail("Expected a state result");
	return result.state;
}

test("current-as-zero path aliases resolve state on the shared causal lineage", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { value: "G1" } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { working: { value: "S2" } } }], "T2");
	assert.deepEqual(state(readStatePath(view, "state")), state(readStatePath(view, "state[0]")));
	assert.deepEqual(state(readStatePath(view, "state.global")), state(readStatePath(view, "state.global[0]")));
	assert.equal(state(readStatePath(view, "state")).working.value, "S2");
	assert.equal(state(readStatePath(view, "state.global[1]")).working.value, "G1");
	assert.deepEqual(state(readStatePath(view, "state.session[1]")).working, {});
});

test("scope patch paths index accepted patches for that scope", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { first: true } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { working: { other: true } } }], "T2");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { second: true } } }], "T3");
	const latest = readStatePath(view, "state.global.patches");
	const latestIndexed = readStatePath(view, "state.global.patches[0]");
	assert.ok("patch" in latest && "patch" in latestIndexed);
	assert.deepEqual(latest.patch, latestIndexed.patch);
	assert.deepEqual(latest.boundary, latestIndexed.boundary);
	assert.equal(readStatePath(view, "state.global.patches[0]").boundary.id, "T3");
	assert.equal(readStatePath(view, "state.global.patches[1]").boundary.id, "T1");
	assert.throws(() => readStatePath(view, "state.cwd.patches"), /predates retained hot history/);
});

test("path grammar rejects ambiguous, unknown, and out-of-range forms", () => {
	for (const path of ["", "global", "state.effective", "state[0].global", "state.global[1].patches", "state.global.patches[8]"]) {
		assert.throws(() => parseStateReadPath(path));
	}
	assert.deepEqual(parseStateReadPath("state.cwd.patches[7]"), { kind: "patch", path: "state.cwd.patches[7]", offset: 7, scope: "cwd" });
});
