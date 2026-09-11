import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, isStateDocument, overlayStates, updateMaterializedArtifacts } from "../lib/state.ts";

function state(contract: Record<string, any> = {}) {
	return { artifacts: {}, contract, working: {}, response: "" };
}

test("creates isolated state documents with the exact public shape", () => {
	const first = emptyState();
	first.contract.changed = true;
	assert.deepEqual(emptyState(), { artifacts: {}, contract: {}, working: {}, response: "" });
});

test("accepts only exact materialized state documents with valid artifacts", () => {
	const artifact = {
		description: "Artifact index",
		hash: `sha256:${"a".repeat(64)}`,
		compiler: "artifact-v1",
	};
	assert.equal(isStateDocument({ artifacts: { "/a.md": artifact }, contract: {}, working: {}, response: "done" }), true);
	assert.equal(isStateDocument({ contract: {}, working: {}, response: "done" }), false);
	// Semantic-only artifacts are usable; missing provenance is not corrupt state.
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "Semantic only" } }, contract: {}, working: {}, response: "done" }), true);
	assert.equal(isStateDocument({ artifacts: { "/a.md": { description: "" } }, contract: {}, working: {}, response: "done" }), false);
	assert.equal(isStateDocument({ artifacts: {}, contract: {}, working: {}, response: "done", extra: true }), false);
});

test("overlays global, CWD, and session state recursively with session precedence", () => {
	const global = state({ policy: { source: "global", retained: true } });
	const cwd = state({ policy: { source: "cwd", project: true } });
	const session = state({ policy: { source: "session" } });
	assert.deepEqual(overlayStates(global, cwd, session).contract, {
		policy: { source: "session", retained: true, project: true },
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
		response: "",
	});
	assert.deepEqual(global, {
		artifacts: {},
		contract: { policy: "preserve" },
		working: {},
		response: "",
	});
});
