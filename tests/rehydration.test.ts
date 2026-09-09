import assert from "node:assert/strict";
import test from "node:test";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { planKnowledgeRehydration, type RehydrationRoute } from "../lib/rehydration.ts";

function route(path: string, overrides: Partial<RehydrationRoute> = {}): RehydrationRoute {
	const hash = hashArtifactSource(path);
	return {
		scope: "global",
		source: { path, hash },
		metadata: { description: `Route for ${path}`, hash, compiler: ORDINARY_ARTIFACT_COMPILER },
		compiler: ORDINARY_ARTIFACT_COMPILER,
		intent: "routine",
		sourceBytes: 100,
		...overrides,
	};
}

test("resume bootstrap stays materialized-first and selects only concrete or stale reads", () => {
	const plan = planKnowledgeRehydration("resume-bootstrap", [
		route("/knowledge/sufficient.md"),
		route("/knowledge/gap.md", { intent: "relevant-gap", materializedSufficient: false }),
		route("/knowledge/stale.md", { source: { path: "/knowledge/stale.md", hash: hashArtifactSource("new") } }),
	], { maxReads: 3 });
	assert.deepEqual(plan.materialized, ["/knowledge/sufficient.md"]);
	assert.deepEqual(plan.reads.map(({ path, reason }) => [path, reason]), [
		["/knowledge/gap.md", "materialized-gap"],
		["/knowledge/stale.md", "source-changed"],
	]);
});

test("new bootstrap never imports another session route", () => {
	const plan = planKnowledgeRehydration("new-bootstrap", [
		route("/knowledge/global.md", { intent: "relevant-gap", materializedSufficient: false }),
		route("/session/private.md", { scope: "session", intent: "explicit-request" }),
	], { maxReads: 2 });
	assert.deepEqual(plan.reads.map(({ path }) => path), ["/knowledge/global.md"]);
	assert.deepEqual(plan.deferred, [{ path: "/session/private.md", reason: "new-session-scope" }]);
});

test("step-level rehydration is deterministic, bounded, and performs no source I/O", () => {
	const routes = [
		route("/z.md", { intent: "exact-edit", sourceBytes: 20 }),
		route("/a.md", { intent: "contradiction-or-failure", sourceBytes: 20 }),
		route("/b.md", { intent: "explicit-request", sourceBytes: 80 }),
	];
	const before = structuredClone(routes);
	const plan = planKnowledgeRehydration("step", routes, { maxReads: 2, maxSourceBytes: 50 });
	assert.deepEqual(plan.reads, [
		{ scope: "global", path: "/a.md", hash: hashArtifactSource("/a.md"), reason: "contradiction-or-failure" },
		{ scope: "global", path: "/z.md", hash: hashArtifactSource("/z.md"), reason: "exact-edit" },
	]);
	assert.deepEqual(plan.deferred, [{ path: "/b.md", reason: "source-byte-limit" }]);
	assert.deepEqual(routes, before);
});
