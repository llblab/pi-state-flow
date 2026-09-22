import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactReadTracker, decideArtifactAcquisition } from "../lib/acquisition.ts";

const hash = `sha256:${"a".repeat(64)}`;
const source = { path: "/knowledge/guide.md", hash };

function metadata(extra: Record<string, unknown> = {}) {
	return {
		description: "Routes work to the guide",
		hash,
		compiler: "artifact-v1",
		...extra,
	};
}

test("reads a known description-only artifact when exact source content is needed", () => {
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "exact-source",
	}), { kind: "read-source", reason: "exact-source" });
});

test("uses a sufficient materialized compilation without routine rereading", () => {
	const compiled = metadata({ compilation: { constraints: ["Preserve source ownership"] } });
	assert.deepEqual(decideArtifactAcquisition(source, compiled, "artifact-v1", {
		intent: "routine",
		materializedSufficient: true,
	}), { kind: "use-materialized", reason: "no-concrete-need" });
	assert.deepEqual(decideArtifactAcquisition(source, compiled, "artifact-v1", {
		intent: "relevant-gap",
		materializedSufficient: true,
	}), { kind: "use-materialized", reason: "materialized-sufficient" });
});

test("requires rereading when the observed source hash changed", () => {
	const changed = { ...source, hash: `sha256:${"b".repeat(64)}` };
	assert.deepEqual(decideArtifactAcquisition(changed, metadata(), "artifact-v1", {
		intent: "routine",
	}), { kind: "read-source", reason: "source-changed" });
});

test("fingerprint invalidation overrides materialized sufficiency across acquisition intents", () => {
	const source = { path: "/registered.txt", sourceFingerprint: { size: 5, mtimeNs: "10" } };
	const semantic = { description: "Retained compilation" };
	for (const intent of ["routine", "new-session", "relevant-gap"] as const) {
		for (const [provenance, reason] of [
			[{ sourceFingerprint: { size: 6, mtimeNs: "10" } }, "source-changed"],
			[undefined, "invalid-metadata"],
			[{ sourceFingerprint: { size: 5, mtimeNs: "bad" } }, "invalid-metadata"],
		] as const) assert.deepEqual(decideArtifactAcquisition(source, semantic, "artifact-v1", { intent, materializedSufficient: true, provenance }), { kind: "read-source", reason });
		assert.deepEqual(decideArtifactAcquisition(source, semantic, "artifact-v1", {
			intent, materializedSufficient: true, provenance: { sourceFingerprint: source.sourceFingerprint },
		}), { kind: "use-materialized", reason: intent === "relevant-gap" ? "materialized-sufficient" : "no-concrete-need" });
	}
});

test("does not treat a new session alone as a reason to reread", () => {
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "new-session",
	}), { kind: "use-materialized", reason: "no-concrete-need" });
});

test("allows exact edits to read an indexed source", () => {
	assert.deepEqual(decideArtifactAcquisition(source, metadata({
		compilation: { complete: true },
	}), "artifact-v1", {
		intent: "exact-edit",
		materializedSufficient: true,
	}), { kind: "read-source", reason: "exact-edit" });
});

test("reads only for an actual materialized gap or explicit reconciliation need", () => {
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "relevant-gap",
	}), { kind: "read-source", reason: "materialized-gap" });
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "contradiction-or-failure",
	}), { kind: "read-source", reason: "contradiction-or-failure" });
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "explicit-request",
	}), { kind: "read-source", reason: "explicit-request" });
});

test("allows only an explicitly selected maintenance read", () => {
	assert.deepEqual(decideArtifactAcquisition(source, metadata(), "artifact-v1", {
		intent: "maintenance",
	}), { kind: "read-source", reason: "maintenance" });
});

test("accepts only successful exact-path reads whose source fingerprint stays stable", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-acquisition-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "source.md");
	writeFileSync(path, "stable");
	const candidate = { path, scope: "session" as const, hash, reason: "source-changed" as const };
	const tracker = new ArtifactReadTracker();
	tracker.setCandidates([candidate]);
	tracker.recordStart("failed", "read", { path });
	tracker.recordEnd("failed", "read", true);
	tracker.recordStart("unrelated", "read", { path: join(root, "other.md") });
	tracker.recordEnd("unrelated", "read", false);
	tracker.recordStart("raced", "read", { path });
	writeFileSync(path, "changed during read");
	tracker.recordEnd("raced", "read", false);
	assert.equal(tracker.successful.size, 0);
	tracker.recordCall("stable", "read", { path });
	tracker.recordEnd("stable", "read", false);
	const accepted = tracker.successful.get(path);
	assert.deepEqual(accepted && { path: accepted.path, scope: accepted.scope, reason: accepted.reason }, { path, scope: "session", reason: "source-changed" });
	assert.match(accepted?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
	assert.equal(accepted?.sourceFingerprint?.size, 19);
	tracker.clear();
	assert.equal(tracker.successful.size, 0);
});

test("required compilation overrides otherwise sufficient materialized state", () => {
	for (const [stored, compiler, explicitRefresh, reason] of [
		[undefined, "artifact-v1", false, "new"],
		[{ description: "invalid", hash: "sha256:invalid" }, "artifact-v1", false, "invalid-metadata"],
		[metadata(), "artifact-v2", false, "compiler-changed"],
		[metadata(), "artifact-v1", true, "explicit-refresh"],
	] as const) {
		assert.deepEqual(decideArtifactAcquisition(source, stored, compiler, {
			intent: "new-session",
			materializedSufficient: true,
			explicitRefresh,
		}), { kind: "read-source", reason });
	}
});
