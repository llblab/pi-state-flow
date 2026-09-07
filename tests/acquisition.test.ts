import assert from "node:assert/strict";
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

test("correlates only successful exact-path reads with current invalidation candidates", () => {
	const tracker = new ArtifactReadTracker();
	tracker.setCandidates([{ ...source, reason: "source-changed" }]);
	tracker.recordStart("failed", "read", { path: source.path });
	tracker.recordEnd("failed", "read", true);
	tracker.recordStart("unrelated", "read", { path: "/knowledge/other.md" });
	tracker.recordEnd("unrelated", "read", false);
	const mutable = { path: "/knowledge/other.md" };
	tracker.recordStart("matched", "read", mutable);
	tracker.recordCall("matched", "read", mutable);
	mutable.path = source.path;
	tracker.recordEnd("matched", "read", false);
	assert.deepEqual([...tracker.successful.values()], [{ ...source, reason: "source-changed" }]);
	tracker.clear();
	assert.equal(tracker.successful.size, 0);
});

test("freshness invalidation overrides otherwise sufficient materialized state", () => {
	for (const [stored, compiler, explicitRefresh, reason] of [
		[undefined, "artifact-v1", false, "new"],
		[{ description: "invalid" }, "artifact-v1", false, "invalid-metadata"],
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
