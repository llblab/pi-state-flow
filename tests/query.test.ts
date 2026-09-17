import assert from "node:assert/strict";
import test from "node:test";
import { parseStateReadPath, readProjectedState, readStatePath, type StateReadResult } from "../lib/query.ts";
import { emptyState } from "../lib/state.ts";
import { advanceTemporalState, createTemporalState } from "../lib/temporal.ts";

function state(result: StateReadResult) {
	if (!("state" in result)) assert.fail("Expected a state result");
	return result.state;
}

test("current-as-zero projection roots resolve state on the shared causal lineage", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { value: "G1" } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { working: { value: "S2" } } }], "T2");
	assert.deepEqual(state(readStatePath(view, "effective")), state(readStatePath(view, "effective[0]")));
	assert.deepEqual(state(readStatePath(view, "global")), state(readStatePath(view, "global[0]")));
	assert.equal(state(readStatePath(view, "effective")).working.value, "S2");
	assert.equal(state(readStatePath(view, "global[1]")).working.value, "G1");
	assert.deepEqual(state(readStatePath(view, "session[1]")).working, {});
});

test("scope patch paths index accepted patches for that scope", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { first: true } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { working: { other: true } } }], "T2");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { second: true } } }], "T3");
	const latest = readStatePath(view, "global.patches");
	const latestIndexed = readStatePath(view, "global.patches[0]");
	assert.ok("patch" in latest && "patch" in latestIndexed);
	assert.deepEqual(latest.patch, latestIndexed.patch);
	assert.deepEqual(latest.boundary, latestIndexed.boundary);
	assert.equal(readStatePath(view, "global.patches[0]").boundary.id, "T3");
	assert.equal(readStatePath(view, "global.patches[1]").boundary.id, "T1");
	assert.throws(() => readStatePath(view, "cwd.patches"), /predates retained hot history/);
});

test("path grammar rejects ambiguous, unknown, and out-of-range forms", () => {
	for (const path of ["", "state", "state.effective", "effective.global", "global[1].patches", "global.patches[8]"]) {
		assert.throws(() => parseStateReadPath(path));
	}
	assert.deepEqual(parseStateReadPath("cwd.patches[7]"), { kind: "patch", path: "cwd.patches[7]", offset: 7, scope: "cwd" });
});

test("projected reads return pure values, strict ranges, and minimal structural keys", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{
		scope: "cwd",
		patch: { working: { memory: ["zero", "one", { nested: true }], rule: "compact", enabled: true } },
	}], "T1");
	assert.deepEqual(readProjectedState(view, ["effective.working.memory[0:2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["working.memory[0:2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["working.memory[0..2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["working.memory[3:3]"]), { value: [] });
	assert.deepEqual(readProjectedState(view, ["working"]), readProjectedState(view, ["effective.working"]));
	assert.throws(() => readProjectedState(view, ["unknown.memory"]), /requires a semantic path/);
	assert.deepEqual(readProjectedState(view, ["cwd.working"], "keys"), {
		meta: { type: "object", size: 3 },
		keys: { memory: "array", rule: "string", enabled: "boolean" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.working.memory"], "keys"), {
		meta: { type: "array", length: 3 },
		keys: [],
	});
	assert.deepEqual(readProjectedState(view, ["cwd.working.rule"], "keys"), {
		meta: { type: "string", length: 7 },
		keys: [],
	});
	assert.throws(() => readProjectedState(view, ["cwd.working.memory[0:4]"]), /Range \[0:4\].*length 3/);
	assert.throws(() => readProjectedState(view, ["cwd.working.memory[2:1]"]), /Range \[2:1\].*length 3/);
	assert.throws(() => readProjectedState(view, ["cwd.working.memory[0.2]"]), /Invalid State Flow read path selector/);
	assert.throws(() => readProjectedState(view, ["cwd.working.missing"]), /does not exist/);
});

test("intents are hot, historical, scoped, patch-readable, and references remain explicit values", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { intents: { policy: "Finish current projects" } } }], "T1");
	view = advanceTemporalState(view, [{
		scope: "cwd",
		patch: {
			intents: { release: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } } },
			lazy: { releasePlan: { steps: ["validate", "publish"] } },
		},
	}], "T2");
	assert.deepEqual(state(readStatePath(view, "effective")).intents, {
		policy: "Finish current projects",
		release: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release"]), {
		value: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["intents.release"]), {
		value: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release"], "keys"), {
		meta: { type: "object", size: 2 }, keys: { action: "string", plan: "object" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release.plan"], "patch"), {
		patch: { $ref: "cwd.lazy.releasePlan" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].intents"]), { value: {} });
	assert.deepEqual(readProjectedState(view, ["cwd.lazy.releasePlan"]), {
		value: { steps: ["validate", "publish"] },
	});
});

test("lazy values remain absent from hot projection and readable through scoped and effective paths", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { lazy: { memory: ["global"], rules: { retained: true } } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "cwd", patch: { lazy: { memory: ["cwd"], rules: { project: true } } } }], "T2");
	view = advanceTemporalState(view, [{ scope: "session", patch: { lazy: { rules: { current: true } } } }], "T3");
	assert.equal(Object.hasOwn(state(readStatePath(view, "effective")), "lazy"), false);
	assert.deepEqual(readProjectedState(view, ["global.lazy.memory"]), { value: ["global"] });
	assert.deepEqual(readProjectedState(view, ["effective.lazy"]), {
		value: { memory: ["cwd"], rules: { retained: true, project: true, current: true } },
	});
	assert.deepEqual(readProjectedState(view, ["lazy.memory"]), { value: ["cwd"] });
	assert.deepEqual(readProjectedState(view, ["effective.lazy.rules"], "keys"), {
		meta: { type: "object", size: 3 },
		keys: { retained: "boolean", project: "boolean", current: "boolean" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].lazy.memory"]), { value: ["cwd"] });
});

test("patch projection intersects explicit and effective paths at one historical boundary", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { inherited: "G", removed: true } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "cwd", patch: { working: { memory: ["zero", "one"], rule: "first" } } }], "T2");
	view = advanceTemporalState(view, [
		{ scope: "global", patch: { working: { removed: null } } },
		{ scope: "cwd", patch: { working: { memory: ["zero", "corrected"], rule: "second" } } },
	], "T3");
	assert.deepEqual(readProjectedState(view, ["cwd.working.memory"], "patch"), { patch: ["zero", "corrected"] });
	assert.deepEqual(readProjectedState(view, ["cwd.working.memory[0:1]"], "patch"), { patch: ["zero"] });
	assert.deepEqual(readProjectedState(view, ["cwd.working.memory[0..1]"], "patch"), { patch: ["zero"] });
	assert.deepEqual(readProjectedState(view, ["cwd.working.missing"], "patch"), { patch: {} });
	assert.deepEqual(readProjectedState(view, ["global.working.removed"], "patch"), { patch: null });
	assert.deepEqual(readProjectedState(view, ["effective.working.rule", "effective.working.removed"], "patch"), {
		patch: ["second", null],
	});
	assert.deepEqual(readProjectedState(view, ["working.rule", "working.removed"], "patch"), {
		patch: ["second", null],
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].working.rule"], "patch"), { patch: "first" });
});

test("projected path batches preserve order and fail as one read", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "session", patch: { working: { first: "A", second: [1, 2] } } }], "T1");
	assert.deepEqual(readProjectedState(view, ["session.working.second[1]", "session.working.first"]), { value: [2, "A"] });
	assert.deepEqual(readProjectedState(view, ["session.working.second", "session.working"], "keys"), {
		meta: [{ type: "array", length: 2 }, { type: "object", size: 2 }],
		keys: [[], { first: "string", second: "array" }],
	});
	assert.throws(() => readProjectedState(view, ["session.working.first", "session.working.second[2]"]), /outside.*length 2/);
});
