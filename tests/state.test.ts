import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, isSemanticState, isStateDocument, overlayStates, projectSemanticState, projectStateForModel, updateMaterializedArtifacts, type SemanticState } from "../lib/state.ts";

function state(strategy: Record<string, any> = {}) {
	return { artifacts: {}, strategy, tactics: {}, intents: {}, response: "", lazy: {} };
}

test("creates isolated state documents with the exact public shape", () => {
	const first = emptyState();
	first.strategy.changed = true;
	assert.deepEqual(emptyState(), { intents: {}, strategy: {}, tactics: {}, artifacts: {}, response: "", lazy: {} });
});

test("retired roots reject across public views rather than disappearing, while nested keys remain ordinary data", () => {
	for (const plane of ["contract", "working"]) {
		const input = { [plane]: { retained: true } };
		const before = structuredClone(input);
		assert.equal(isSemanticState(input), false);
		assert.throws(() => projectSemanticState(input), /Retired State Flow semantic plane/);
		assert.throws(() => projectStateForModel(input), /Retired State Flow semantic plane/);
		assert.throws(() => overlayStates(input), /Retired State Flow semantic plane/);
		assert.deepEqual(input, before);
	}
	assert.deepEqual(projectSemanticState({ strategy: { contract: true, working: true } }), { strategy: { contract: true, working: true } });
});

test("materialized and model-facing states preserve intentional intent-first plane order", () => {
	assert.deepEqual(Object.keys(emptyState()), ["intents", "strategy", "tactics", "artifacts", "response", "lazy"]);
	assert.deepEqual(Object.keys(projectStateForModel({ ...emptyState(), intents: { task: "Continue" }, strategy: { rule: true }, tactics: { result: 1 }, artifacts: { "/a.md": { description: "A" } }, response: "Answer", lazy: { plan: true } })), [
		"intents", "strategy", "tactics", "artifacts", "response",
	]);
});

test("model projection hides legacy empty branches without changing exact semantic reads", () => {
	const stored: SemanticState = { tactics: { chain: { empty: {} }, keep: 1, items: [{ empty: {} }, {}] }, intents: {}, artifacts: {}, lazy: { empty: {} } };
	const before = structuredClone(stored);
	assert.deepEqual(projectStateForModel(stored), { tactics: { keep: 1, items: [{}, {}] } });
	assert.deepEqual(projectSemanticState(stored), before);
	assert.deepEqual(stored, before);
});

test("adds deterministic runtime hints only to model artifact projection", () => {
	const canonical = { ...emptyState(), artifacts: { "/a.md": { description: "A" } } };
	assert.deepEqual(projectStateForModel(canonical, { "/a.md": ["z guidance", "a guidance", "z guidance"], "/missing.md": "ignored" }).artifacts, {
		"/a.md": { description: "A", hint: "a guidance\nz guidance" },
	});
	assert.deepEqual(canonical.artifacts, { "/a.md": { description: "A" } });
});

test("materialized views have defaulted planes and retain additional semantic fields", () => {
	const artifact = {
		description: "Artifact index",
		hash: `sha256:${"a".repeat(64)}`,
		compiler: "artifact-v1",
	};
	assert.equal(isStateDocument({ artifacts: { "/a.md": artifact }, strategy: {}, tactics: {}, intents: {}, response: "done", lazy: {} }), true);
	assert.equal(isStateDocument({ artifacts: {}, strategy: {}, tactics: {}, response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, strategy: {}, tactics: {}, intents: "invalid", response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, strategy: {}, tactics: {}, intents: {}, response: "done" }), false);
	assert.equal(isStateDocument({ artifacts: {}, strategy: {}, tactics: {}, intents: {}, response: "done", lazy: [] }), false);
	// Semantic-only artifacts are usable; missing provenance is not corrupt state.
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "Semantic only" } }, strategy: {}, tactics: {}, intents: {}, response: "done", lazy: {} }), true);
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "" } }, strategy: {}, tactics: {}, intents: {}, response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, strategy: {}, tactics: {}, intents: {}, response: "done", lazy: {}, extra: true }), true);
});

test("stored semantic objects may omit any documented plane without losing present fields", () => {
	assert.equal(isSemanticState({}), true);
	assert.equal(isSemanticState({ extra: { retained: true } }), true);
	assert.deepEqual(overlayStates({ extra: { retained: true } }), { ...emptyState(), extra: { retained: true } });
	assert.equal(projectStateForModel({ extra: { retained: true }, lazy: { hidden: true }, response: "" }).extra, undefined);
	assert.deepEqual(projectStateForModel({ extra: { retained: true }, lazy: { hidden: true }, response: "" }), {});
	for (const field of Object.keys(emptyState())) {
		const sparse = emptyState();
		delete sparse[field];
		assert.equal(isSemanticState(sparse), true, field);
		assert.deepEqual(overlayStates(sparse), emptyState());
	}
	for (const invalid of [[], null, { lazy: [] }, { response: {} }, { artifacts: { bad: {} } }]) {
		assert.equal(isSemanticState(invalid), false);
	}
});

test("overlays global, CWD, and session state recursively with session precedence", () => {
	const global = state({ policy: { source: "global", retained: true } });
	const cwd = state({ policy: { source: "cwd", project: true } });
	const session = state({ policy: { source: "session" } });
	assert.deepEqual(overlayStates(global, cwd, session).strategy, {
		policy: { source: "session", retained: true, project: true },
	});
});

test("overlays intents recursively with session precedence", () => {
	const global = { ...state(), intents: { release: { action: "global", retained: true } } };
	const cwd = { ...state(), intents: { release: { action: "project", plan: { $ref: "cwd.lazy.plan" } } } };
	const session = { ...state(), intents: { release: { action: "validate" } } };
	assert.deepEqual(overlayStates(global, cwd, session).intents, {
		release: { action: "validate", retained: true, plan: { $ref: "cwd.lazy.plan" } },
	});
});

test("scope-local deletion reveals lower-scope values on the next overlay", () => {
	const global = state({ mode: "global" });
	const cwd = state({ mode: "cwd" });
	const session = state({ mode: "session" });
	delete session.strategy.mode;
	assert.equal(overlayStates(global, cwd, session).strategy.mode, "cwd");
});

test("atomically updates artifact metadata with its materialized scope", () => {
	const global = emptyState();
	global.strategy.policy = "preserve";
	const source = { path: "/knowledge/a.md", hash: `sha256:${"a".repeat(64)}` };
	const next = updateMaterializedArtifacts(global, [{
		source,
		compiler: "artifact-v1",
		output: { description: "Routes artifact requests", compiled_at: "2026-01-01T00:00:00.000Z" },
	}]);
	assert.deepEqual(next, {
		artifacts: {
			[source.path]: {
				description: "Routes artifact requests",
			},
		},
		strategy: { policy: "preserve" },
		tactics: {},
		intents: {},
		response: "",
		lazy: {},
	});
	assert.deepEqual(global, {
		artifacts: {},
		strategy: { policy: "preserve" },
		tactics: {},
		intents: {},
		response: "",
		lazy: {},
	});
});
