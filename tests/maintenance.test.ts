import assert from "node:assert/strict";
import test from "node:test";
import { planArtifactInvalidation } from "../lib/artifact.ts";
import { planArtifactMaintenance } from "../lib/maintenance.ts";

const hash = `sha256:${"a".repeat(64)}`;
const now = "2026-03-16T00:00:00.000Z";

function source(path: string, bytes: number, sourceHash = hash) {
	return { path, hash: sourceHash, bytes };
}

function metadata(compiledAt?: string, extra: Record<string, unknown> = {}) {
	return {
		description: "Artifact routing description",
		hash,
		compiler: "artifact-v1",
		...(compiledAt === undefined ? {} : { compiled_at: compiledAt }),
		...extra,
	};
}

test("selects fresh long-lived artifacts oldest-first within strict read and byte budgets", () => {
	const sources = [
		source("/knowledge/newer.md", 4),
		source("/knowledge/oldest.md", 7),
		source("/knowledge/second.md", 6),
	];
	const registry = {
		"/knowledge/newer.md": metadata("2026-01-15T00:00:00.000Z"),
		"/knowledge/oldest.md": metadata("2025-01-01T00:00:00.000Z"),
		"/knowledge/second.md": metadata("2025-06-01T00:00:00.000Z"),
	};
	assert.deepEqual(planArtifactMaintenance(sources, registry, "artifact-v1", {
		now,
		minimumAgeMs: 0,
		maxReads: 2,
		maxSourceBytes: 11,
	}), {
		requiresCompilation: [
			{ path: "/knowledge/oldest.md", hash, reason: "maintenance", sourceBytes: 7 },
			{ path: "/knowledge/newer.md", hash, reason: "maintenance", sourceBytes: 4 },
		],
		deferred: [
			{ path: "/knowledge/second.md", hash, reason: "maintenance", sourceBytes: 6 },
		],
		budget: { maxReads: 2, maxSourceBytes: 11, usedReads: 2, usedSourceBytes: 11 },
	});
});

test("never admits a source that would exceed the remaining source-byte budget", () => {
	const plan = planArtifactMaintenance([
		source("/knowledge/oversized.md", 11),
		source("/knowledge/fits.md", 5),
	], {
		"/knowledge/oversized.md": metadata(),
		"/knowledge/fits.md": metadata(),
	}, "artifact-v1", {
		now,
		minimumAgeMs: 0,
		maxReads: 2,
		maxSourceBytes: 5,
	});
	assert.deepEqual(plan.requiresCompilation, [
		{ path: "/knowledge/fits.md", hash, reason: "maintenance", sourceBytes: 5 },
	]);
	assert.deepEqual(plan.deferred, [
		{ path: "/knowledge/oversized.md", hash, reason: "maintenance", sourceBytes: 11 },
	]);
	assert.equal(plan.budget.usedSourceBytes, 5);
});

test("leaves recent and correctness-invalidated artifacts to their primary policies", () => {
	const changedHash = `sha256:${"b".repeat(64)}`;
	const plan = planArtifactMaintenance([
		source("/knowledge/recent.md", 1),
		source("/knowledge/changed.md", 1, changedHash),
		source("/knowledge/new.md", 1),
	], {
		"/knowledge/recent.md": metadata("2026-03-15T12:00:00.000Z"),
		"/knowledge/changed.md": metadata("2025-01-01T00:00:00.000Z"),
	}, "artifact-v1", {
		now,
		minimumAgeMs: 24 * 60 * 60 * 1_000,
		maxReads: 3,
		maxSourceBytes: 3,
	});
	assert.deepEqual(plan.requiresCompilation, []);
	assert.deepEqual(plan.deferred, []);
});

test("treats missing or unparseable compilation times as oldest and breaks ties by path", () => {
	const plan = planArtifactMaintenance([
		source("/knowledge/z.md", 1),
		source("/knowledge/a.md", 1),
	], {
		"/knowledge/z.md": metadata(),
		"/knowledge/a.md": metadata("unknown"),
	}, "artifact-v1", {
		now,
		maxReads: 1,
		maxSourceBytes: 1,
	});
	assert.equal(plan.requiresCompilation[0]?.path, "/knowledge/a.md");
	assert.equal(plan.deferred[0]?.path, "/knowledge/z.md");
});

test("zero budgets disable a cycle and invalid options fail closed", () => {
	const sources = [source("/knowledge/a.md", 1)];
	const registry = { "/knowledge/a.md": metadata() };
	const plan = planArtifactMaintenance(sources, registry, "artifact-v1", {
		now,
		maxReads: 0,
		maxSourceBytes: 0,
	});
	assert.deepEqual(plan.requiresCompilation, []);
	assert.equal(plan.deferred.length, 1);
	assert.throws(() => planArtifactMaintenance(sources, registry, "artifact-v1", {
		now,
		maxReads: -1,
	}), /non-negative safe integer/);
	assert.throws(() => planArtifactMaintenance(sources, registry, "artifact-v1", {
		now: "invalid",
	}), /cycle time must be valid/);
});

test("planning is side-effect free and full rebuild stays explicit in invalidation", () => {
	const sources = Object.freeze([Object.freeze(source("/knowledge/a.md", 1))]);
	const registry = Object.freeze({
		"/knowledge/a.md": Object.freeze(metadata("2025-01-01T00:00:00.000Z")),
	});
	assert.doesNotThrow(() => planArtifactMaintenance(sources, registry, "artifact-v1", {
		now,
		minimumAgeMs: 0,
	}));
	assert.equal(registry["/knowledge/a.md"].description, "Artifact routing description");
	assert.deepEqual(
		planArtifactInvalidation(sources, registry, "artifact-v1", { explicitRefresh: true }).requiresCompilation,
		[{ path: "/knowledge/a.md", hash, reason: "explicit-refresh" }],
	);
});
