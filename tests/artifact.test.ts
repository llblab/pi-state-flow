import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyArtifactCompilationNeed,
	compileArtifact,
	hashArtifactSource,
	inspectRegisteredArtifactPaths,
	isArtifactHash,
	isArtifactMetadata,
	isArtifactRegistry,
	parseArtifactProvenanceRegistry,
	parseArtifactSourceFingerprint,
	projectArtifactForModel,
	sameArtifactSourceFingerprint,
	selectArtifactsByTags,
	serializeArtifactProvenanceRegistry,
	updateArtifactProvenance,
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
	// Semantic-only entries are usable; missing runtime provenance degrades compilation evidence, not state.
	assert.equal(isArtifactRegistry({ "/knowledge/a.md": { description: "Semantic only" } }), true);
	assert.equal(isArtifactRegistry({ "/knowledge/a.md": { description: "" } }), false);
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

test("classifies every legacy compilation signal without source-body acquisition", () => {
	const source = { path: "/knowledge/a.md", hash };
	assert.deepEqual(classifyArtifactCompilationNeed(source, undefined, "artifact-v1"), {
		kind: "requires-compilation", reason: "new",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, { description: "broken", hash: "sha256:invalid" }, "artifact-v1"), {
		kind: "requires-compilation", reason: "invalid-metadata",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, metadata({ hash: `sha256:${"b".repeat(64)}` }), "artifact-v1"), {
		kind: "requires-compilation", reason: "source-changed",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, metadata(), "artifact-v2"), {
		kind: "requires-compilation", reason: "compiler-changed",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, metadata(), "artifact-v1", true), {
		kind: "requires-compilation", reason: "explicit-refresh",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, metadata(), "artifact-v1"), { kind: "current" });
});

test("derives compilation requirements from retained runtime provenance", () => {
	const source = { path: "/knowledge/a.md", hash };
	const semanticOnly = { description: "Semantic only" };
	// Absent provenance is unavailable evidence: the artifact stays usable rather than corrupt.
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1"), { kind: "current" });
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1", false, { sourceHash: hash, compilerRevision: "artifact-v1" }), { kind: "current" });
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1", false, { sourceHash: `sha256:${"b".repeat(64)}` }), {
		kind: "requires-compilation", reason: "source-changed",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1", false, { compilerRevision: "artifact-v2" }), {
		kind: "requires-compilation", reason: "compiler-changed",
	});
	// Malformed present evidence fails closed only for the capability that depends on it.
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1", false, { sourceHash: 42 }), {
		kind: "requires-compilation", reason: "invalid-metadata",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, semanticOnly, "artifact-v1", false, { compilerRevision: "" }), {
		kind: "requires-compilation", reason: "invalid-metadata",
	});
	assert.deepEqual(classifyArtifactCompilationNeed(source, metadata(), "artifact-v1", false, { malformed: true }), {
		kind: "requires-compilation", reason: "invalid-metadata",
	});
});

test("fingerprint compilation decisions distinguish equal, changed, missing, and malformed evidence", () => {
	const source = { path: "/registered.txt", sourceFingerprint: { size: 5, mtimeNs: "10" } };
	const semantic = { description: "Retain this semantic value" };
	for (const [provenance, reason] of [
		[{ sourceFingerprint: { size: 5, mtimeNs: "10" } }, undefined],
		[{ sourceFingerprint: { size: 6, mtimeNs: "10" } }, "source-changed"],
		[{ sourceFingerprint: { size: 5, mtimeNs: "11" } }, "source-changed"],
		[undefined, "invalid-metadata"], [null, "invalid-metadata"], [42, "invalid-metadata"],
		[{}, "invalid-metadata"], [{ sourceHash: hash }, "invalid-metadata"],
		[{ sourceFingerprint: null }, "invalid-metadata"],
		[{ sourceFingerprint: { size: -1, mtimeNs: "10" } }, "invalid-metadata"],
		[{ sourceFingerprint: { size: 5, mtimeNs: "invalid" } }, "invalid-metadata"],
		[{ sourceFingerprint: { size: 5, mtimeNs: "10", extra: true } }, "invalid-metadata"],
		[{ sourceFingerprint: source.sourceFingerprint, malformed: true }, "invalid-metadata"],
		[{ sourceFingerprint: source.sourceFingerprint, compilerRevision: "artifact-v0" }, "compiler-changed"],
		[{ sourceFingerprint: source.sourceFingerprint, compilerRevision: "" }, "invalid-metadata"],
	] as const) {
		const before = structuredClone({ source, semantic, provenance });
		assert.deepEqual(classifyArtifactCompilationNeed(source, semantic, "artifact-v1", false, provenance),
			reason === undefined ? { kind: "current" } : { kind: "requires-compilation", reason });
		assert.deepEqual({ source, semantic, provenance }, before);
	}
	assert.deepEqual(classifyArtifactCompilationNeed(source, undefined, "artifact-v1"), { kind: "requires-compilation", reason: "new" });
	assert.deepEqual(classifyArtifactCompilationNeed(source, semantic, "artifact-v1", true, { sourceFingerprint: source.sourceFingerprint }),
		{ kind: "requires-compilation", reason: "explicit-refresh" });
});

test("fingerprint-only checks ignore unused legacy hashes while explicit hashes and Skills retain their contract", () => {
	const fingerprint = { size: 5, mtimeNs: "10" };
	assert.deepEqual(classifyArtifactCompilationNeed({ path: "/ordinary", sourceFingerprint: fingerprint }, metadata(), "artifact-v1", false,
		{ sourceFingerprint: fingerprint, sourceHash: "obsolete malformed hash" }), { kind: "current" });
	assert.deepEqual(classifyArtifactCompilationNeed({ path: "/ordinary", hash: `sha256:${"b".repeat(64)}`, sourceFingerprint: fingerprint }, metadata(), "artifact-v1", false,
		{ sourceFingerprint: fingerprint, sourceHash: hash }), { kind: "requires-compilation", reason: "source-changed" });
	const skill = { ...metadata(), kind: "skill", compiler: "skill-artifact-v1", compilation: { rule: "Preserve hash identity" } };
	const provenance = { sourceHash: hash, compilerRevision: "skill-artifact-v1", sourceFingerprint: { malformed: true } };
	assert.deepEqual(classifyArtifactCompilationNeed({ path: "/SKILL.md", hash }, skill, "skill-artifact-v1", false, provenance), { kind: "current" });
	assert.deepEqual(classifyArtifactCompilationNeed({ path: "/SKILL.md", hash: `sha256:${"b".repeat(64)}` }, skill, "skill-artifact-v1", false, provenance),
		{ kind: "requires-compilation", reason: "source-changed" });
});

test("classification and compilation reject malformed observed fingerprints", () => {
	for (const sourceFingerprint of [null, {}, { size: -1, mtimeNs: "1" }, { size: 1, mtimeNs: "bad" }]) {
		const source = { path: "/registered.txt", sourceFingerprint } as any;
		assert.throws(() => classifyArtifactCompilationNeed(source, metadata(), "artifact-v1"), /source fingerprint.*invalid/);
		assert.throws(() => compileArtifact({ source, compiler: "artifact-v1", output: { description: "Compiled" } }), /source fingerprint.*invalid/);
	}
});

test("parses, serializes, and projects retained provenance evidence", () => {
	const registry = parseArtifactProvenanceRegistry({
		"/knowledge/a.md": { sourceHash: hash, sourceFingerprint: { size: 12, mtimeNs: "123456789" }, compilerRevision: "artifact-v1", compiledAt: "2026-03-12T12:00:00.000Z" },
		"/knowledge/b.md": { sourceHash: 42, unknown: true },
		"/knowledge/c.md": { compilerRevision: "artifact-v1" },
	});
	assert.deepEqual(registry["/knowledge/a.md"], { sourceHash: hash, sourceFingerprint: { size: 12, mtimeNs: "123456789" }, compilerRevision: "artifact-v1", compiledAt: "2026-03-12T12:00:00.000Z" });
	assert.deepEqual(registry["/knowledge/b.md"], { malformed: true });
	assert.deepEqual(registry["/knowledge/c.md"], { compilerRevision: "artifact-v1" });
	assert.deepEqual(serializeArtifactProvenanceRegistry(registry), {
		"/knowledge/a.md": { sourceHash: hash, sourceFingerprint: { size: 12, mtimeNs: "123456789" }, compilerRevision: "artifact-v1", compiledAt: "2026-03-12T12:00:00.000Z" },
		"/knowledge/c.md": { compilerRevision: "artifact-v1" },
	});
	assert.deepEqual(projectArtifactForModel({
		description: "A", hash, compiler: "artifact-v1", compiled_at: "2026-01-01", source_hash_verified: false,
		sourceHash: hash, compilerRevision: "artifact-v2", compiledAt: "2026-02-02", compilation: { route: "a" },
	}), { description: "A", compilation: { route: "a" } });
});

test("applies compiled metadata and removals as one immutable registry update", () => {
	const prior = {
		"/knowledge/old.md": metadata(),
		"/knowledge/keep.md": metadata({ description: "Keep" }),
	};
	const source = { path: "/knowledge/new.md", hash: `sha256:${"b".repeat(64)}`, sourceFingerprint: { size: 42, mtimeNs: "987654321" } };
	const compiled = [{
		source,
		compiler: "artifact-v2",
		output: {
			description: "New routing metadata",
			compiled_at: "2026-03-12T12:00:00.000Z",
			compilation: { route: "new" },
			future_policy: true,
		},
	}];
	const next = updateArtifactRegistry(prior, compiled, ["/knowledge/old.md"]);
	assert.deepEqual(next, {
		"/knowledge/keep.md": metadata({ description: "Keep" }),
		[source.path]: {
			description: "New routing metadata",
			compilation: { route: "new" },
			future_policy: true,
		},
	});
	assert.deepEqual(updateArtifactProvenance({}, compiled), {
		[source.path]: { sourceHash: source.hash, sourceFingerprint: source.sourceFingerprint, compilerRevision: "artifact-v2", compiledAt: "2026-03-12T12:00:00.000Z" },
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
	for (const field of ["sourceHash", "compilerRevision", "compiledAt", "source_hash_verified"]) {
		assert.throws(() => updateArtifactRegistry(prior, [{
			source: { path: "/knowledge/bad.md", hash }, compiler: "artifact-v1",
			output: { description: "Bad", [field]: "forged" } as any,
		}]), /cannot set runtime-owned provenance fields/);
	}
	assert.deepEqual(prior, { "/knowledge/keep.md": metadata() });
});

test("validates and compares retained source fingerprints", () => {
	const fingerprint = { size: 12, mtimeNs: "123" };
	assert.deepEqual(parseArtifactSourceFingerprint(fingerprint), fingerprint);
	const preEpoch = { size: 12, mtimeNs: "-1000000000" };
	assert.deepEqual(parseArtifactSourceFingerprint(preEpoch), preEpoch);
	assert.equal(sameArtifactSourceFingerprint(fingerprint, { ...fingerprint }), true);
	assert.equal(sameArtifactSourceFingerprint(fingerprint, { size: 13, mtimeNs: "123" }), false);
	for (const invalid of [null, {}, { size: -1, mtimeNs: "1" }, { size: 1, mtimeNs: "now" }, { size: 1, mtimeNs: "1", extra: true }]) {
		assert.equal(parseArtifactSourceFingerprint(invalid), undefined);
	}
});

test("inspects only exact registered artifact paths with size and mtime fingerprints", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-artifact-source-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const registered = join(root, "registered.bin");
	const unrelated = join(root, "unrelated.md");
	writeFileSync(registered, "first");
	writeFileSync(unrelated, "must not be discovered");
	const first = inspectRegisteredArtifactPaths([registered, registered]);
	assert.equal(first.length, 1);
	assert.equal(first[0]?.kind, "present");
	if (first[0]?.kind !== "present") return;
	assert.equal(first[0].fingerprint.size, 5);
	assert.match(first[0].fingerprint.mtimeNs, /^\d+$/);
	writeFileSync(registered, "second version");
	const second = inspectRegisteredArtifactPaths([registered]);
	assert.equal(second[0]?.kind, "present");
	if (second[0]?.kind !== "present") return;
	assert.notDeepEqual(second[0].fingerprint, first[0].fingerprint);
	assert.equal(second.some(({ path }) => path === unrelated), false);
});

test("distinguishes proven absence from unavailable artifact paths", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-artifact-source-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const missing = join(root, "missing.md");
	const directory = join(root, "directory");
	const target = join(root, "target.md");
	const link = join(root, "link.md");
	writeFileSync(target, "target");
	// A directory and symlink are unavailable evidence, not proof that their registered paths disappeared.
	mkdirSync(directory);
	symlinkSync(target, link);
	const observations = inspectRegisteredArtifactPaths([missing, directory, link, "relative.md"]);
	assert.deepEqual(Object.fromEntries(observations.map(({ path, kind }) => [path, kind])), {
		[directory]: "unavailable",
		[link]: "unavailable",
		[missing]: "missing",
		"relative.md": "unavailable",
	});
});
