import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as sourceFacilityFixture from "./source-facility-fixture.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactAcquisitionState, ArtifactReadTracker, decideArtifactAcquisition, missingArtifactRemovals, validateArtifactReadEvidence, SOURCE_CHANGED_HINT } from "../lib/acquisition.ts";
import { compileArtifact, hashArtifactSource, inspectRegisteredArtifactPaths, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { emptyState } from "../lib/state.ts";

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

test("acquisition state owns invalidations, hints and read candidates for the selected scopes", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-acquisition-state-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const changed = join(root, "changed.md");
	const fresh = join(root, "fresh.md");
	const skill = join(root, "SKILL.md");
	const missing = join(root, "missing.md");
	for (const path of [changed, fresh, skill]) writeFileSync(path, "v1");
	const observed = inspectRegisteredArtifactPaths([changed])[0]!;
	assert.equal(observed.kind, "present");
	const compiled = compileArtifact({
		source: { path: changed, scope: "cwd", hash: hashArtifactSource("v1"), sourceFingerprint: observed.kind === "present" ? observed.fingerprint : undefined },
		compiler: ORDINARY_ARTIFACT_COMPILER,
		output: { description: "Changed" },
	});
	writeFileSync(changed, "v2 longer");
	const states = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	states.global.artifacts = { [fresh]: { description: "Shadowed" } };
	states.cwd.artifacts = { [changed]: compiled.semantic, [missing]: { description: "Gone" } };
	states.session.artifacts = { [fresh]: { description: "Fresh" }, [skill]: { description: "Skill", kind: "skill" } };
	const provenance = { global: {}, cwd: { [changed]: compiled.provenance }, session: {} };
	const acquisition = new ArtifactAcquisitionState();
	acquisition.refresh(states, (scope) => provenance[scope]);
	assert.deepEqual(acquisition.hints, { [changed]: SOURCE_CHANGED_HINT });
	assert.deepEqual(acquisition.invalidations.map(({ path, scope, reason }) => [path, scope, reason]), [
		[changed, "cwd", "source-changed"],
		[fresh, "session", acquisition.invalidations.find(({ path }) => path === fresh)!.reason],
	], "skills and missing sources are not ordinary invalidations; the narrowest owner wins");
	acquisition.reads.recordStart("read-1", "read", { path: changed });
	acquisition.reads.recordEnd("read-1", "read", false);
	assert.deepEqual([...acquisition.reads.successful.keys()], [changed], "candidates follow the plan");
	acquisition.acceptAcquired();
	assert.deepEqual(acquisition.invalidations.map(({ path }) => path), [fresh]);
	assert.equal(acquisition.reads.successful.size, 0);
	acquisition.reads.recordStart("read-2", "read", { path: changed });
	acquisition.reads.recordEnd("read-2", "read", false);
	assert.equal(acquisition.reads.successful.size, 0, "accepted paths are no longer candidates");
	acquisition.clearInvalidations();
	assert.deepEqual(acquisition.invalidations, []);
	assert.deepEqual(acquisition.hints, { [changed]: SOURCE_CHANGED_HINT }, "hints survive until refresh or reset");
	acquisition.reset();
	assert.deepEqual(acquisition.hints, {});
	assert.deepEqual(missingArtifactRemovals(states), { cwd: { artifacts: { [missing]: null } } });
});

{
	const { scopes, selections, fixture, selectedStates } = sourceFacilityFixture;

	test("acquisition and missing-source maintenance observe only exact selected owners for every subset, with no fallback or excluded body access", (t) => {
		for (const selection of selections) {
			const f = fixture(t), acquisition = new ArtifactAcquisitionState();
			const states = selectedStates(selection, f.paths);
			const stat = fs.lstatSync; const observed: string[] = [], registries: string[] = [];
			fs.lstatSync = ((path: fs.PathLike, ...args: any[]) => { observed.push(String(path)); return (stat as any)(path, ...args); }) as typeof fs.lstatSync; syncBuiltinESMExports();
			try {
				acquisition.refresh(states, scope => { assert.ok(selection.includes(scope)); registries.push(scope); return {}; }, selection);
				assert.deepEqual(observed.sort(), selection.map(scope => f.paths[scope]).sort());
				assert.deepEqual(registries.sort(), [...selection].sort());
				assert.deepEqual(acquisition.invalidations.map(item => item.scope).sort(), [...selection].sort());
				observed.length = 0;
				assert.deepEqual(missingArtifactRemovals(states, selection), {});
				assert.deepEqual(observed.sort(), selection.map(scope => f.paths[scope]).sort());
			} finally { fs.lstatSync = stat; syncBuiltinESMExports(); }
			for (const excluded of scopes.filter(scope => !selection.includes(scope))) {
				const extra = Object.defineProperty({ ...states }, excluded, { enumerable: true, get: () => assert.fail("excluded state getter") });
				assert.throws(() => acquisition.refresh(extra, () => assert.fail(), selection), /match their owners exactly/);
				assert.throws(() => missingArtifactRemovals(extra, selection), /match their owners exactly/);
			}
			const missing = join(f.sources, "registered-missing.txt");
			const absent = Object.fromEntries(selection.map(scope => [scope, { artifacts: { [missing]: { description: "missing" } } }]));
			assert.deepEqual(missingArtifactRemovals(absent, selection), Object.fromEntries(selection.map(scope => [scope, { artifacts: { [missing]: null } }])));
			const link = join(f.sources, "registered-symlink.txt"); symlinkSync(f.paths.global, link);
			const unavailable = Object.fromEntries(selection.map(scope => [scope, { artifacts: { [link]: { description: "unavailable" } } }]));
			assert.deepEqual(missingArtifactRemovals(unavailable, selection), {});
		}
		for (const policy of [[], ["cwd", "cwd"], ["unknown"]]) assert.throws(() => missingArtifactRemovals({}, policy as any), /scopes/);
		assert.throws(() => new ArtifactAcquisitionState().refresh({ cwd: {} }, () => ({})), /match their owners exactly/, "legacy omission is all-three, not inferred subset");
	});

	test("effective selected ownership masks broader ordinary artifacts before observation; Skill-only paths trigger no automatic source observation", (t) => {
		const f = fixture(t), acquisition = new ArtifactAcquisitionState();
		const states = { global: { artifacts: { [f.paths.global]: { description: "broad" } } }, cwd: { artifacts: { [f.paths.global]: { description: "Skill", kind: "skill" } } } };
		const stat = fs.lstatSync;
		fs.lstatSync = (() => { throw new Error("masked/Skill source must not be observed"); }) as typeof fs.lstatSync; syncBuiltinESMExports();
		try {
			acquisition.refresh(states, () => assert.fail("no effective ordinary owner"), ["global", "cwd"]);
			assert.deepEqual(acquisition.invalidations, []); assert.deepEqual(acquisition.hints, {});
		} finally { fs.lstatSync = stat; syncBuiltinESMExports(); }
		const ordinary = new ArtifactAcquisitionState();
		ordinary.refresh({ cwd: { artifacts: { [f.paths.global]: { description: "narrow" } } } }, scope => { assert.equal(scope, "cwd"); return {}; }, ["cwd"]);
		assert.equal(ordinary.invalidations[0]!.scope, "cwd");
	});

	test("ordinary read correlation excludes disabled candidates before getters and refuses stale owner, executed-path and fingerprint correlations", (t) => {
		const f = fixture(t), tracker = new ArtifactReadTracker();
		const excluded = { scope: "global" as const, reason: "source-changed" as const, get path(): string { return assert.fail("disabled candidate path"); }, get sourceFingerprint(): never { return assert.fail("disabled candidate fingerprint"); } };
		const candidate = { path: f.paths.cwd, scope: "cwd" as const, reason: "source-changed" as const };
		tracker.setCandidates([excluded, candidate], ["cwd"]);
		tracker.setCandidates([{ ...candidate, hash: undefined, sourceFingerprint: undefined }], ["cwd"]);
		tracker.recordStart("stable", "read", { path: f.paths.cwd }); tracker.recordEnd("stable", "read", false);
		assert.equal(tracker.successful.get(f.paths.cwd)!.scope, "cwd");
		tracker.setCandidates([{ ...candidate, reason: "explicit-refresh" }], ["cwd"]); assert.equal(tracker.successful.size, 0);
		tracker.setCandidates([candidate], ["cwd"]);
		tracker.recordStart("old", "read", { path: f.paths.cwd });
		tracker.setCandidates([], ["session"]); tracker.setCandidates([candidate], ["cwd"]);
		tracker.recordEnd("old", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.recordStart("plan-aba", "read", { path: f.paths.cwd });
		tracker.setCandidates([], ["cwd"]); tracker.setCandidates([candidate], ["cwd"]);
		tracker.recordEnd("plan-aba", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.setCandidates([], ["cwd"]); tracker.recordStart("unregistered-start", "read", { path: f.paths.cwd });
		tracker.setCandidates([candidate], ["cwd"]); tracker.recordEnd("unregistered-start", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.setCandidates([{ ...candidate, scope: "global" }]); tracker.recordStart("rescope", "read", { path: f.paths.cwd });
		tracker.setCandidates([candidate]); tracker.recordEnd("rescope", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.recordStart("changed", "read", { path: f.paths.cwd }); writeFileSync(f.paths.cwd, "changed to a much longer source");
		tracker.recordEnd("changed", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.setCandidates([candidate, { ...candidate, path: f.paths.session }], ["cwd"]);
		const args = { path: f.paths.cwd }; tracker.recordCall("mutated", "read", args); args.path = f.paths.session;
		tracker.recordEnd("mutated", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.recordStart("actual", "read", { path: f.paths.session }); tracker.recordEnd("actual", "read", false);
		assert.ok(tracker.successful.has(f.paths.session));
		validateArtifactReadEvidence(tracker.successful.values(), ["cwd"]);
		writeFileSync(f.paths.session, "changed again after read completion");
		assert.throws(() => validateArtifactReadEvidence(tracker.successful.values(), ["cwd"]), /changed after acquisition/);
		validateArtifactReadEvidence([{ scope: "global", reason: "source-changed", get path(): never { return assert.fail("disabled validation path"); } }], ["cwd"]);
	});
}
