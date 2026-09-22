import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, isStateDocument, overlayStates, projectStateForModel, updateMaterializedArtifacts } from "../lib/state.ts";

function state(contract: Record<string, any> = {}) {
	return { artifacts: {}, contract, working: {}, intents: {}, response: "", lazy: {} };
}

test("creates isolated state documents with the exact public shape", () => {
	const first = emptyState();
	first.contract.changed = true;
	assert.deepEqual(emptyState(), { intents: {}, contract: {}, working: {}, artifacts: {}, response: "", lazy: {} });
});

test("materialized and model-facing states preserve intentional intent-first plane order", () => {
	assert.deepEqual(Object.keys(emptyState()), ["intents", "contract", "working", "artifacts", "response", "lazy"]);
	assert.deepEqual(Object.keys(projectStateForModel({ ...emptyState(), lazy: { plan: true } })), [
		"intents", "contract", "working", "artifacts", "response",
	]);
});

test("adds deterministic runtime hints only to model artifact projection", () => {
	const canonical = { ...emptyState(), artifacts: { "/a.md": { description: "A" } } };
	assert.deepEqual(projectStateForModel(canonical, { "/a.md": ["z guidance", "a guidance", "z guidance"], "/missing.md": "ignored" }).artifacts, {
		"/a.md": { description: "A", hint: "a guidance\nz guidance" },
	});
	assert.deepEqual(canonical.artifacts, { "/a.md": { description: "A" } });
});

test("accepts only exact materialized state documents with valid artifacts", () => {
	const artifact = {
		description: "Artifact index",
		hash: `sha256:${"a".repeat(64)}`,
		compiler: "artifact-v1",
	};
	assert.equal(isStateDocument({ artifacts: { "/a.md": artifact }, contract: {}, working: {}, intents: {}, response: "done", lazy: {} }), true);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, intents: "invalid", response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, intents: {}, response: "done" }), false);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, intents: {}, response: "done", lazy: [] }), false);
	// Semantic-only artifacts are usable; missing provenance is not corrupt state.
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "Semantic only" } }, contract: {}, working: {}, intents: {}, response: "done", lazy: {} }), true);
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "" } }, contract: {}, working: {}, intents: {}, response: "done", lazy: {} }), false);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, intents: {}, response: "done", lazy: {}, extra: true }), false);
});

test("overlays global, CWD, and session state recursively with session precedence", () => {
	const global = state({ policy: { source: "global", retained: true } });
	const cwd = state({ policy: { source: "cwd", project: true } });
	const session = state({ policy: { source: "session" } });
	assert.deepEqual(overlayStates(global, cwd, session).contract, {
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
	delete session.contract.mode;
	assert.equal(overlayStates(global, cwd, session).contract.mode, "cwd");
});

test("atomically updates artifact metadata with its materialized scope", () => {
	const global = emptyState();
	global.contract.policy = "preserve";
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
		contract: { policy: "preserve" },
		working: {},
		intents: {},
		response: "",
		lazy: {},
	});
	assert.deepEqual(global, {
		artifacts: {},
		contract: { policy: "preserve" },
		working: {},
		intents: {},
		response: "",
		lazy: {},
	});
});
