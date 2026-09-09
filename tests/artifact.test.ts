import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyArtifactFreshness,
	hashArtifactSource,
	isArtifactHash,
	isArtifactMetadata,
	isArtifactRegistry,
	planArtifactInvalidation,
	selectArtifactsByTags,
	updateArtifactRegistry,
	validateArtifactMetadata,
	validateArtifactRegistry,
} from "../lib/artifact.ts";

const hash = `sha256:${"a".repeat(64)}`;

function metadata(extra: Record<string, unknown> = {}) {
	return {
		description: "Routes requests to the relevant source",
		hash,
		compiler: "artifact-v1",
		...extra,
	};
}

test("creates and validates the canonical artifact hash representation", () => {
	assert.equal(hashArtifactSource("artifact"), "sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c");
	assert.equal(isArtifactHash(hash), true);
	assert.equal(isArtifactHash("a".repeat(64)), false);
	assert.equal(isArtifactHash(`sha256:${"A".repeat(64)}`), false);
	assert.equal(isArtifactHash(`sha256:${"a".repeat(63)}`), false);
});

test("accepts minimum metadata and forward-compatible unknown fields", () => {
	const value = metadata({
		compiled_at: "2026-03-12T12:00:00.000Z",
		compilation: { route: "artifact" },
		kind: "skill",
		tags: ["architecture", "memory"],
		future_policy: { refresh: ["hash", "compiler"] },
	});
	assert.equal(isArtifactMetadata(value), true);
	assert.doesNotThrow(() => validateArtifactMetadata(value, "/knowledge/a.md"));
});

test("rejects missing or malformed minimum metadata", () => {
	assert.equal(isArtifactMetadata({ hash, compiler: "artifact-v1" }), false);
	assert.equal(isArtifactMetadata(metadata({ description: "  " })), false);
	assert.equal(isArtifactMetadata(metadata({ hash: "sha256:invalid" })), false);
	assert.equal(isArtifactMetadata(metadata({ compiler: "" })), false);
	assert.throws(
		() => validateArtifactMetadata(metadata({ description: "" }), "/knowledge/a.md"),
		/non-empty description/,
	);
});

test("validates path-keyed registries without inventing artifact IDs", () => {
	const registry = {
		"/knowledge/a.md": metadata(),
		"knowledge/nested/b.md": metadata({ description: "Nested source" }),
	};
	assert.equal(isArtifactRegistry(registry), true);
	assert.doesNotThrow(() => validateArtifactRegistry(registry));
	assert.equal(isArtifactRegistry({ "": metadata() }), false);
	assert.equal(isArtifactRegistry({ "/knowledge/a.md": { description: "Incomplete" } }), false);
});

test("selects artifacts by validated tags without authorizing source acquisition", () => {
	const registry = {
		"/z.md": metadata({ tags: ["memory", "architecture"] }),
		"/a.md": metadata({ tags: ["memory", "operations"] }),
		"/untagged.md": metadata(),
	};
	assert.deepEqual(selectArtifactsByTags(registry, ["memory"]), ["/a.md", "/z.md"]);
	assert.deepEqual(selectArtifactsByTags(registry, ["memory", "architecture"]), ["/z.md"]);
	assert.deepEqual(selectArtifactsByTags(registry, ["architecture", "operations"], "any"), ["/a.md", "/z.md"]);
	assert.throws(() => selectArtifactsByTags(registry, []), /one or more/);
});

test("rejects invalid known optional metadata while leaving unknown metadata open", () => {
	assert.equal(isArtifactMetadata(metadata({ compiled_at: 7 })), false);
	assert.equal(isArtifactMetadata(metadata({ compilation: "summary" })), false);
	assert.equal(isArtifactMetadata(metadata({ kind: "" })), false);
	assert.equal(isArtifactMetadata(metadata({ tags: "memory" })), false);
	assert.equal(isArtifactMetadata(metadata({ tags: ["memory", ""] })), false);
	assert.equal(isArtifactMetadata(metadata({ tags: ["memory", "memory"] })), false);
	assert.equal(isArtifactMetadata(metadata({ future_scalar: true })), true);
	assert.equal(isArtifactMetadata(metadata({ future_null: null })), false);
});

test("classifies every freshness signal without source-body acquisition", () => {
	const source = { path: "/knowledge/a.md", hash };
	assert.deepEqual(classifyArtifactFreshness(source, undefined, "artifact-v1"), {
		kind: "requires-compilation", reason: "new",
	});
	assert.deepEqual(classifyArtifactFreshness(source, { description: "broken" }, "artifact-v1"), {
		kind: "requires-compilation", reason: "invalid-metadata",
	});
	assert.deepEqual(classifyArtifactFreshness(source, metadata({ hash: `sha256:${"b".repeat(64)}` }), "artifact-v1"), {
		kind: "requires-compilation", reason: "source-changed",
	});
	assert.deepEqual(classifyArtifactFreshness(source, metadata(), "artifact-v2"), {
		kind: "requires-compilation", reason: "compiler-changed",
	});
	assert.deepEqual(classifyArtifactFreshness(source, metadata(), "artifact-v1", true), {
		kind: "requires-compilation", reason: "explicit-refresh",
	});
	assert.deepEqual(classifyArtifactFreshness(source, metadata(), "artifact-v1"), { kind: "fresh" });
});

test("plans only stale acquisitions and deterministic removals", () => {
	const unchanged = { path: "/knowledge/unchanged.md", hash };
	const changed = { path: "/knowledge/changed.md", hash: `sha256:${"b".repeat(64)}` };
	const added = { path: "/knowledge/added.md", hash: `sha256:${"c".repeat(64)}` };
	const plan = planArtifactInvalidation(
		[unchanged, changed, added],
		{
			[unchanged.path]: metadata(),
			[changed.path]: metadata(),
			"/knowledge/removed.md": metadata(),
		},
		"artifact-v1",
		{ explicitRefresh: new Set([unchanged.path]) },
	);
	assert.deepEqual(plan, {
		fresh: [],
		requiresCompilation: [
			{ ...added, reason: "new" },
			{ ...changed, reason: "source-changed" },
			{ ...unchanged, reason: "explicit-refresh" },
		],
		removed: ["/knowledge/removed.md"],
	});
});

test("a compiler revision bump invalidates unchanged sources deterministically", () => {
	const source = { path: "/knowledge/a.md", hash };
	assert.deepEqual(planArtifactInvalidation([source], { [source.path]: metadata() }, "artifact-v2"), {
		fresh: [],
		requiresCompilation: [{ ...source, reason: "compiler-changed" }],
		removed: [],
	});
});

test("applies compiled metadata and removals as one immutable registry update", () => {
	const prior = {
		"/knowledge/old.md": metadata(),
		"/knowledge/keep.md": metadata({ description: "Keep" }),
	};
	const source = { path: "/knowledge/new.md", hash: `sha256:${"b".repeat(64)}` };
	const next = updateArtifactRegistry(prior, [{
		source,
		compiler: "artifact-v2",
		output: {
			description: "New routing metadata",
			compiled_at: "2026-03-12T12:00:00.000Z",
			compilation: { route: "new" },
			future_policy: true,
		},
	}], ["/knowledge/old.md"]);
	assert.deepEqual(next, {
		"/knowledge/keep.md": metadata({ description: "Keep" }),
		[source.path]: {
			description: "New routing metadata",
			compiled_at: "2026-03-12T12:00:00.000Z",
			compilation: { route: "new" },
			future_policy: true,
			hash: source.hash,
			compiler: "artifact-v2",
		},
	});
	assert.deepEqual(prior, {
		"/knowledge/old.md": metadata(),
		"/knowledge/keep.md": metadata({ description: "Keep" }),
	});
});

test("rejects an invalid atomic registry cohort without mutating prior state", () => {
	const prior = { "/knowledge/keep.md": metadata() };
	assert.throws(() => updateArtifactRegistry(prior, [{
		source: { path: "/knowledge/bad.md", hash },
		compiler: "artifact-v1",
		output: { description: "Bad", hash } as any,
	}], ["/knowledge/keep.md"]), /cannot set runtime-owned/);
	assert.deepEqual(prior, { "/knowledge/keep.md": metadata() });
});
