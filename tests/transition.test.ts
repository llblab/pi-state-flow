import assert from "node:assert/strict";
import test from "node:test";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition } from "../lib/transition.ts";
import type { AcceptedTransition } from "../lib/history.ts";
import { ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import { advanceTemporalState, createTemporalState, readTemporalState } from "../lib/temporal.ts";
import { parseScopeStream, serializeScopeMetadata, serializeScopeStream } from "../lib/durable.ts";
import { emptyState, type AtomicScopePatches, type ScopedStates } from "../lib/state.ts";
import { loadCwdState, loadGlobalState, loadSessionMaterialization, loadSessionState } from "./temporal-fixture.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { commitScopedTerminal, commitTerminal, harness, start } from "./harness.ts";

function states(): ScopedStates {
	return { global: emptyState(), cwd: emptyState(), session: emptyState() };
}

function snapshot() {
	const result = emptySnapshot(true);
	result.meta.bootstrap = true;
	return result;
}

test("stages every canonical scope combination as one atomic transition", () => {
	const combinations = [
		["global"],
		["cwd"],
		["session"],
		["global", "cwd"],
		["global", "session"],
		["cwd", "session"],
		["global", "cwd", "session"],
	] as const;
	for (const scopes of combinations) {
		const current = snapshot();
		const state = states();
		const patches: AtomicScopePatches = {};
		for (const scope of scopes) patches[scope] = { working: { [scope]: true } };
		const stage = stageAtomicScopePatches(state, patches, [], "origin");
		let accepted: AcceptedTransition | undefined;
		let publications = 0;
		commitScopedTransition(current, state, stage, (cohort) => {
			publications += 1;
			accepted = cohort;
		}, "origin", { finalizeRun: false });
		assert.equal(publications, 1);
		assert.equal(current.meta.step, 1);
		assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), scopes);
		assert.ok(accepted!.id.length > 0);
		for (const scope of scopes) assert.equal(state[scope].working[scope], true);
	}
});

for (const owner of ["global", "cwd", "session"] as const) test(`ordinary artifact compilation is bound to its observed ${owner} owner`, () => {
	const current = states();
	for (const scope of ["global", "cwd", "session"] as const) current[scope].working.marker = scope;
	const path = "/registered.txt";
	current[owner].artifacts[path] = { description: "Prior value", obsolete: true };
	const before = structuredClone(current);
	const sourceFingerprint = { size: 5, mtimeNs: "10" };
	const read = { path, scope: owner, sourceFingerprint, reason: "source-changed" as const };
	for (const wrong of ["global", "cwd", "session"] as const) {
		if (wrong === owner) continue;
		assert.throws(() => stageAtomicScopePatches(current, { [wrong]: { artifacts: { [path]: { description: "Wrong owner" } } } }, [], "basis", [read]), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(`${owner}.artifacts[${JSON.stringify(path)}]`), error.message);
			return true;
		});
		assert.deepEqual(current, before);
	}
	const stage = stageAtomicScopePatches(current, { [owner]: { artifacts: { [path]: { description: "Refreshed" } } } }, [], "basis", [read]);
	for (const scope of ["global", "cwd", "session"] as const) {
		if (scope === owner) {
			assert.deepEqual(stage.nextStates[scope].artifacts[path], { description: "Refreshed" });
			assert.deepEqual(stage.provenanceUpdates[scope], { [path]: { sourceFingerprint, compilerRevision: ORDINARY_ARTIFACT_COMPILER } });
		} else {
			assert.deepEqual(stage.nextStates[scope], before[scope]);
			assert.deepEqual(stage.provenanceUpdates[scope], {});
		}
	}
	assert.deepEqual(current, before);
});

test("stages intent lifecycle updates as ordinary atomic semantic transitions", () => {
	const state = states();
	const selected = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" } } } },
	}, [], "origin");
	assert.deepEqual(selected.nextStates.cwd.intents.release, {
		action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" },
	});
	const fulfilled = stageAtomicScopePatches(selected.nextStates, {
		cwd: { intents: { release: null }, working: { release: "validated" } },
	}, [], "origin");
	assert.equal(Object.hasOwn(fulfilled.nextStates.cwd.intents, "release"), false);
	assert.equal(fulfilled.nextStates.cwd.working.release, "validated");
	assert.throws(() => stageAtomicScopePatches(state, {
		cwd: { intents: "invalid" as unknown as JsonObject },
	}, [], "origin"), /field intents must be a JSON object/);
});

test("model-facing intent behavior distinguishes possibilities, commitments, handoffs, supersession, and fulfillment", () => {
	let state = states();
	state = stageAtomicScopePatches(state, {
		cwd: { working: { possibleAction: "Benchmark later" }, lazy: { plan: { steps: ["validate", "publish"] } } },
	}, [], "origin").nextStates;
	assert.equal(Object.hasOwn(state.cwd.intents, "possibleAction"), false);

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Validate", plan: { $ref: "cwd.lazy.plan" } } } },
	}, [], "origin").nextStates;
	state = stageAtomicScopePatches(state, {
		cwd: { working: { implementation: "complete; validation pending" } },
	}, [], "origin").nextStates;
	assert.deepEqual(state.cwd.intents.release, { action: "Validate", plan: { $ref: "cwd.lazy.plan" } });

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Publish after validation", plan: { $ref: "cwd.lazy.plan" } }, rejectedAlternative: null } },
	}, [], "origin").nextStates;
	assert.equal(Object.hasOwn(state.cwd.intents, "rejectedAlternative"), false);
	assert.equal((state.cwd.intents.release as JsonObject).action, "Publish after validation");

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: null }, working: { release: "published" } },
	}, [], "origin").nextStates;
	assert.equal(Object.hasOwn(state.cwd.intents, "release"), false);
	assert.equal(state.cwd.working.release, "published");
	assert.deepEqual(state.cwd.lazy, { plan: { steps: ["validate", "publish"] } });
});

test("unknown patch keys report the exact quoted key and intent-first allowed fields", () => {
	const current = states();
	const before = structuredClone(current);
	for (const scope of ["global", "cwd", "session"] as const) {
		for (const key of ["beacon.contract", "contrcat", "notes", "quoted\"key\n", "response"]) {
			const patch = { [key]: {} };
			const expected = `Unknown State Flow patch key ${JSON.stringify(key)}; expected one of: intents, contract, working, artifacts, lazy`;
			assert.throws(() => stageAtomicScopePatches(current, { [scope]: patch }, [], "origin"), { message: expected });
			assert.throws(() => stageScopedTransition(current, { transitions: [{ scope, patch }], response: "Answer" }, [], "origin"), { message: expected });
			assert.deepEqual(current, before);
		}
		const stage = stageAtomicScopePatches(current, { [scope]: {
			intents: { next: "Verify the release" }, contract: { project: { rule: true } },
			working: { checked: true }, artifacts: {}, lazy: { detail: "On demand" },
		} }, [], "origin");
		assert.deepEqual(stage.nextStates[scope].contract.project, { rule: true });
		assert.equal(stage.nextStates[scope].intents.next, "Verify the release");
	}
});

test("rejects an invalid member without mutating any scope in the atomic cohort", () => {
	const state = states();
	const before = structuredClone(state);
	assert.throws(() => stageAtomicScopePatches(state, {
		global: { working: { accepted: true } },
		cwd: { working: { invalid: [null] } },
	}, [], "origin"), /Materialized state cannot contain null/);
	assert.deepEqual(state, before);
	assert.throws(() => stageAtomicScopePatches(state, { other: {} } as AtomicScopePatches, [], "origin"), /Unknown atomic State Flow scope/);
});

test("stages indexed array updates atomically across scopes and rejects one invalid index", () => {
	const state = states();
	state.global.working.memory = ["global-0", "global-1"];
	state.cwd.working.groups = [{ notes: ["cwd-0", "cwd-1"], keep: true }];
	const stage = stageAtomicScopePatches(state, {
		global: { working: { memory: { "[1]": "global-updated" } } },
		cwd: { working: { groups: { "[0]": { notes: { "[1]": "cwd-updated" } } } } },
	}, [], "origin");
	assert.deepEqual(stage.nextStates.global.working.memory, ["global-0", "global-updated"]);
	assert.deepEqual(stage.nextStates.cwd.working.groups, [{ notes: ["cwd-0", "cwd-updated"], keep: true }]);
	assert.throws(() => stageAtomicScopePatches(state, {
		global: { working: { memory: { "[0]": "would-change" } } },
		cwd: { working: { groups: { "[1]": { notes: [] } } } },
	}, [], "origin"), /array index \[1\] is out of bounds/);
	assert.deepEqual(state.global.working.memory, ["global-0", "global-1"]);
	assert.deepEqual(state.cwd.working.groups, [{ notes: ["cwd-0", "cwd-1"], keep: true }]);
});

test("stages object-root lazy planes without hydrating untouched scopes", () => {
	const state = states();
	const stage = stageAtomicScopePatches(state, {
		global: { lazy: { memory: ["first", "second"] } },
		cwd: { lazy: { count: 42 } },
	}, [], "origin");
	assert.deepEqual(stage.nextStates.global.lazy, { memory: ["first", "second"] });
	assert.deepEqual(stage.nextStates.cwd.lazy, { count: 42 });
	assert.deepEqual(stage.nextStates.session.lazy, {});
	for (const lazy of [null, 42, ["invalid"]]) {
		assert.throws(() => stageAtomicScopePatches(state, { session: { lazy } } as any, [], "origin"), /lazy must be a JSON object/);
	}
});

test("publishes one exact multi-scope replay cohort without explanatory windows or current-state DTOs", () => {
	const current = snapshot();
	const state = states();
	const view = createTemporalState(state, "origin");
	const stage = stageScopedTransition(state, {
		transitions: [
			{ scope: "global", patch: { contract: { shared: true } } },
			{ scope: "cwd", patch: { working: { project: "ready" } } },
			{ scope: "session", patch: { working: { next: "continue" } } },
		], response: "Done",
	}, [], "origin");
	let accepted: AcceptedTransition | undefined;
	assert.equal(commitScopedTransition(current, state, stage, (cohort) => { accepted = cohort; }, "origin"), true);
	assert.deepEqual(Object.keys(accepted!).sort(), ["id", "transitions"]);
	assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), ["global", "cwd", "session"]);
	const next = advanceTemporalState(view, accepted!.transitions, accepted!.id);
	for (const scope of ["global", "cwd", "session"] as const) {
		assert.deepEqual(readTemporalState(next, 0, scope), state[scope]);
		assert.equal(next.scopes[scope].patches[0]!.transition.id, accepted!.id);
	}
	assert.equal(current.meta.step, 1);
	const noOp = stageScopedTransition(state, { transitions: [{ scope: "global", patch: {} }], response: "Done" }, [], accepted!.id);
	commitScopedTransition(current, state, noOp, (cohort) => assert.equal(cohort, undefined), accepted!.id);
	assert.equal(current.meta.step, 1);
	assert.equal(current.meta.bootstrap, false);
});

test("normalizes artifact replacements and runtime compilation evidence after finalized-response reconciliation", () => {
	const state = states();
	const source = { path: "/knowledge/source.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", scope: "cwd" as const, hash: `sha256:${"c".repeat(64)}` };
	for (const [scope, path] of [["global", source.path], ["cwd", skill.path]] as const) {
		state[scope].artifacts[path] = {
			description: "Old compilation", hash: `sha256:${"a".repeat(64)}`, compiler: "old",
			compiled_at: "2026-01-01", obsolete: { nested: true }, compilation: { stale: true },
		};
	}
	const before = structuredClone(state);
	const view = createTemporalState(before, "origin");
	const stage = stageScopedTransition(state, {
		transitions: [
			{ scope: "global", patch: { artifacts: { [source.path]: { description: "New routing" } } } },
			{ scope: "cwd", patch: { artifacts: { [skill.path]: { description: "New Skill", kind: "skill", compilation: { route: "new" } } } } },
		], response: "Draft",
	}, [skill], "origin", [source]);
	stage.nextStates.session.response = "Final accepted answer";
	let cohort: AcceptedTransition | undefined;
	commitScopedTransition(snapshot(), state, stage, (accepted) => { cohort = accepted; }, "origin");
	for (const { scope, patch } of cohort!.transitions) assert.deepEqual(applyPatch(before[scope], patch as JsonObject), state[scope]);
	const accepted = advanceTemporalState(view, cohort!.transitions, cohort!.id);
	for (const scope of ["global", "cwd", "session"] as const) {
		const identity = scope === "cwd" ? "/project" : undefined;
		const bytes = serializeScopeStream(accepted.scopes[scope], scope, identity);
		accepted.scopes[scope] = parseScopeStream(bytes.checkpoint, bytes.patches, scope, identity,
			serializeScopeMetadata({}, accepted.scopes[scope], scope, identity))!;
		assert.deepEqual(readTemporalState(accepted, 0, scope), state[scope]);
		assert.deepEqual(readTemporalState(accepted, 1, scope), before[scope]);
		assert.equal(accepted.scopes[scope].patches[0]!.transition.id, cohort!.id);
	}
	assert.equal(state.global.artifacts[source.path]!.obsolete, undefined);
	assert.equal(state.global.artifacts[source.path]!.compilation, undefined);
	assert.deepEqual(state.cwd.artifacts[skill.path]!.compilation, { route: "new" });
	assert.equal(readTemporalState(accepted).response, "Final accepted answer");
});

test("finalized response controls no-op identity and step independently of lifecycle completion", () => {
	const current = snapshot();
	current.meta.step = Number.MAX_SAFE_INTEGER;
	const state = states();
	state.session.response = "Same";
	const stage = stageScopedTransition(state, { transitions: [], response: "Draft" }, [], "origin");
	stage.nextStates.session.response = "Same";
	commitScopedTransition(current, state, stage, (accepted) => assert.equal(accepted, undefined), "origin");
	assert.equal(current.meta.step, Number.MAX_SAFE_INTEGER);
	assert.equal(current.meta.bootstrap, false);
	assert.equal(commitScopedTransition(current, state, stage, () => assert.fail("duplicate publication"), "origin"), false);
	current.meta.step = 0;
	const changed = stageScopedTransition(state, { transitions: [], response: "Same" }, [], "origin");
	changed.nextStates.session.response = "Changed by later handler";
	commitScopedTransition(current, state, changed, (accepted) => assert.deepEqual(accepted!.transitions, [
		{ scope: "session", patch: { response: "Changed by later handler" } },
	]), "origin");
	assert.equal(current.meta.step, 1);
});

test("intermediate barriers preserve response/bootstrap and failed publication leaves staging retryable", () => {
	const current = snapshot();
	const state = states();
	state.session.response = "Previous answer";
	const before = structuredClone(state);
	const stage = stageAtomicScopePatches(state, { session: { working: { checkpoint: "verified" } } }, [], "origin");
	assert.throws(() => commitScopedTransition(current, state, stage, () => { throw new Error("publication failed"); }, "origin"), /publication failed/);
	assert.deepEqual(state, before);
	assert.equal(stage.committed, false);
	assert.equal(current.meta.step, 0);
	assert.equal(commitScopedTransition(current, state, stage, () => {}, "origin", { finalizeRun: false }), true);
	assert.equal(current.meta.bootstrap, true);
	assert.equal(state.session.response, "Previous answer");
	assert.equal(state.session.working.checkpoint, "verified");
	assert.equal(current.meta.step, 1);
});

test("staging copies each accepted cold scope once without redundant pre-clones", () => {
	const state = states();
	const scopes = ["global", "cwd", "session"] as const;
	for (const scope of scopes) state[scope].lazy.cold = `COLD-COW-${scope}`;
	const counts = { global: 0, cwd: 0, session: 0 };
	const clone = globalThis.structuredClone;
	globalThis.structuredClone = ((value: unknown, options?: any) => {
		const text = JSON.stringify(value);
		for (const scope of scopes) if (text?.includes(`COLD-COW-${scope}`)) counts[scope]++;
		return clone(value, options);
	}) as typeof structuredClone;
	let stage: ReturnType<typeof stageAtomicScopePatches>;
	try { stage = stageAtomicScopePatches(state, { session: { working: { changed: true } } }, [], "origin"); }
	finally { globalThis.structuredClone = clone; }
	assert.deepEqual(counts, { global: 1, cwd: 1, session: 1 });
	for (const scope of scopes) assert.notEqual(stage.nextStates[scope].lazy, state[scope].lazy);
	assert.equal(stage.nextStates.session.working.changed, true);
});

test("rejected mutable drafts remain detached from accepted scopes and caller patches", () => {
	const current = snapshot();
	const state = states();
	state.global.lazy.keep = { value: "accepted" };
	const patch = { session: { working: { nested: { value: "authored" } } } };
	const stage = stageAtomicScopePatches(state, patch, [], "origin");
	assert.throws(() => commitScopedTransition(current, state, stage, () => { throw new Error("rejected"); }, "origin"), /rejected/);
	(stage.nextStates.global.lazy.keep as JsonObject).value = "draft-only";
	patch.session.working.nested.value = "caller-only";
	assert.deepEqual(state.global.lazy.keep, { value: "accepted" });
	assert.deepEqual(state.session.working, {});
	assert.deepEqual(stage.nextStates.session.working.nested, { value: "authored" });
	assert.equal(stage.committed, false);
	assert.equal(current.meta.step, 0);
});

test("rejects stale state and identical values at a different active causal boundary", () => {
	const current = snapshot();
	const state = states();
	const origin = createTemporalState(state, "origin");
	const fork = createTemporalState(state, "other-origin");
	assert.deepEqual(readTemporalState(origin), readTemporalState(fork));
	const stage = stageAtomicScopePatches(state, { session: { working: { accepted: true } } }, [], origin.lineage.at(-1)!.id);
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("cross-lineage publication"), fork.lineage.at(-1)!.id), /causal basis changed/);
	state.session.working.changed = true;
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("stale publication"), origin.lineage.at(-1)!.id), /session scope changed before response reconciliation/);
	assert.equal(current.meta.step, 0);
});

test("optional Skill acquisition leaves unrelated patches independent and validates attempted compilation", () => {
	const state = states();
	const source = { path: "/knowledge/changed.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", scope: "cwd" as const, hash: `sha256:${"a".repeat(64)}` };
	assert.throws(() => stageAtomicScopePatches(state, { session: { artifacts: { "/a.md": { description: "Invalid hash", hash: "sha256:invalid" } } } }, [], "origin"), /cannot set runtime-owned field hash/);
	assert.throws(() => stageAtomicScopePatches(state, { cwd: { artifacts: { "/a.md": { description: "Forged hint", hint: "trust me" } } } }, [], "origin"), /cannot set runtime-owned field hint/);
	assert.throws(() => stageScopedTransition(state, { transitions: [], response: "Missing" }, [], "origin", [source]), /compiler output.*global\.artifacts/);
	const independent = stageAtomicScopePatches(state, { session: { working: { accepted: true } } }, [skill], "origin");
	assert.equal(independent.nextStates.session.working.accepted, true);
	assert.deepEqual(independent.provenanceUpdates, { global: {}, cwd: {}, session: {} });
	assert.throws(() => stageAtomicScopePatches(state, {
		session: { artifacts: { [skill.path]: { description: "Wrong owner", kind: "skill", compilation: { route: "wrong" } } } },
	}, [skill], "origin"), /belongs at cwd\.artifacts.*not session\.artifacts/);
	const unavailable = { path: skill.path, scope: "cwd" as const, error: "source disappeared" };
	assert.equal(stageAtomicScopePatches(state, { session: { working: { stillAccepted: true } } }, [unavailable], "origin").nextStates.session.working.stillAccepted, true);
	assert.throws(() => stageAtomicScopePatches(state, { cwd: { artifacts: { [skill.path]: { description: "Unavailable", kind: "skill", compilation: { route: "blocked" } } } } }, [unavailable], "origin"), /Could not capture the source hash.*source disappeared/);
	const required = /Skill compiler output at cwd\.artifacts\["\/skills\/demo\/SKILL\.md"\] is invalid/;
	const invalidOutputs: Array<readonly [JsonObject, readonly string[]]> = [
		[{}, ["description must be a non-empty string", 'kind must be "skill"', "compilation must be a non-empty object"]],
		[{ description: "", compilation: {} }, ["description must be a non-empty string", 'kind must be "skill"', "compilation must be a non-empty object"]],
		[{ description: "Skill", kind: "document", compilation: {} }, ['kind must be "skill"', "compilation must be a non-empty object"]],
	];
	for (const [output, problems] of invalidOutputs) {
		const patch: AtomicScopePatches = { cwd: { artifacts: { [skill.path]: output } } };
		assert.throws(() => stageAtomicScopePatches(state, patch, [skill], "origin"), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, required);
			for (const problem of problems) assert.ok(error.message.includes(problem));
			assert.match(error.message, /"description":"What this Skill provides","kind":"skill","compilation":\{"rules":\[/);
			return true;
		});
	}
	const stage = stageAtomicScopePatches(state, {
		global: { artifacts: { [source.path]: { description: "Guidance" } } },
		cwd: { artifacts: { [skill.path]: { description: "Skill", kind: "skill", compilation: { route: "demo" } } } },
	}, [skill], "origin", [source]);
	assert.deepEqual(stage.nextStates.global.artifacts[source.path], { description: "Guidance" });
	assert.deepEqual(stage.provenanceUpdates.global[source.path], { sourceHash: source.hash, compilerRevision: "artifact-v1" });
	assert.deepEqual(stage.nextStates.cwd.artifacts[skill.path], { description: "Skill", kind: "skill", compilation: { route: "demo" } });
	assert.deepEqual(stage.provenanceUpdates.cwd[skill.path], { sourceHash: skill.hash, compilerRevision: "skill-artifact-v1" });
	assert.throws(() => stageScopedTransition(state, { transitions: [
		{ scope: "global", patch: { artifacts: { [source.path]: { description: "Forged", hash: source.hash } } } },
	], response: "Rejected" }, [], "origin", [source]), /cannot set runtime-owned/);
	assert.throws(() => stageAtomicScopePatches(state, { session: { contract: { compiled_skills: { legacy: true } } } }, [], "origin"), /contract\.compiled_skills is retired/);
});

test("ordinary artifact compilation publishes semantics and fingerprint provenance to its exact owning scope", () => {
	const state = states();
	const reads = (["global", "cwd", "session"] as const).map((scope, index) => ({
		path: `/sources/${scope}.txt`,
		scope,
		reason: "source-changed" as const,
		sourceFingerprint: { size: index + 1, mtimeNs: String(index + 10) },
	}));
	const stage = stageAtomicScopePatches(state, Object.fromEntries(reads.map((read) => [read.scope, {
		artifacts: { [read.path]: { description: `${read.scope} source` } },
	}])), [], "origin", reads);
	for (const read of reads) {
		assert.deepEqual(stage.nextStates[read.scope].artifacts[read.path], { description: `${read.scope} source` });
		assert.deepEqual(stage.provenanceUpdates[read.scope][read.path], {
			sourceFingerprint: read.sourceFingerprint,
			compilerRevision: "artifact-v1",
		});
	}
});

test("every model scope rejects runtime-owned artifact fields without requiring an acquired source", () => {
	const state = states();
	const before = structuredClone(state);
	const fields = {
		hash: `sha256:${"a".repeat(64)}`, compiler: "artifact-v1", compiled_at: "2026-01-01",
		sourceHash: `sha256:${"a".repeat(64)}`, sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1", compiledAt: "2026-01-01", source_hash_verified: true,
		hint: "forged runtime guidance",
	};
	for (const scope of ["global", "cwd", "session"] as const) for (const [field, value] of Object.entries(fields)) for (const authored of [value, null]) {
		const patch = { artifacts: { "/source.md": { description: "Forged evidence", [field]: authored } } };
		assert.throws(() => stageAtomicScopePatches(state, { [scope]: patch }, [], "origin"), /cannot set runtime-owned field/);
		assert.throws(() => stageScopedTransition(state, { transitions: [{ scope, patch }], response: "Rejected" }, [], "origin"), /cannot set runtime-owned field/);
	}
	assert.deepEqual(state, before);
});

test("legacy provenance remains readable while semantic edits, nested metadata, and whole-artifact deletion stay valid", () => {
	const state = states();
	const legacy = { description: "Legacy routing", hash: `sha256:${"a".repeat(64)}`, compiler: "artifact-v1", compiled_at: "2026-01-01" };
	for (const scope of ["global", "cwd", "session"] as const) state[scope].artifacts["/legacy.md"] = structuredClone(legacy);
	for (const scope of ["global", "cwd", "session"] as const) {
		const semantic = { description: "Edited routing", compilation: { hash: "domain data", compiler: "domain compiler" }, future_policy: { compiledAt: "semantic nested data" } };
		const edited = stageAtomicScopePatches(state, { [scope]: { artifacts: { "/legacy.md": semantic } } }, [], "origin");
		assert.deepEqual(edited.nextStates[scope].artifacts["/legacy.md"], { ...legacy, ...semantic });
		assert.deepEqual(edited.provenanceUpdates, { global: {}, cwd: {}, session: {} });
		const deleted = stageAtomicScopePatches(state, { [scope]: { artifacts: { "/legacy.md": null } } }, [], "origin");
		assert.equal(deleted.nextStates[scope].artifacts["/legacy.md"], undefined);
		assert.deepEqual(state[scope].artifacts["/legacy.md"], legacy);
	}
});

test("session-only transitions persist only the current temporal session layer", async () => {
	const h = harness({ cwd: "/tmp/state-flow-session-only-transition" });
	await start(h);
	const before = loadCwdState(h.ctx.cwd, h.repositoryRoot);
	await commitTerminal(h, { branch: "only" }, { next: "continue" });
	assert.deepEqual(loadGlobalState(h.repositoryRoot), emptyState());
	assert.deepEqual(loadCwdState(h.ctx.cwd, h.repositoryRoot), before);
	const session = loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot)!;
	assert.deepEqual(session.state, { ...emptyState(), contract: { branch: "only" }, working: { next: "continue" }, response: "Done" });
	assert.deepEqual(session.recentTransitions.map(({ transitions }) => transitions), [
		[{ scope: "session", patch: { contract: { branch: "only" }, working: { next: "continue" } } }],
		[{ scope: "session", patch: { response: "Done" } }],
	]);
});

test("commits global, CWD, and session patches through one atomic model barrier", async () => {
	const h = harness({ cwd: "/tmp/state-flow-scoped-transition" });
	await start(h);
	await commitScopedTerminal(h, [
		{ scope: "global", patch: { contract: { shared: "all projects" } } },
		{ scope: "cwd", patch: { contract: { project: "local" } } },
		{ scope: "session", patch: { working: { next: "continue" } } },
	], "Scoped.");
	assert.equal(loadGlobalState(h.repositoryRoot)!.contract.shared, "all projects");
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot)!.contract.project, "local");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), working: { next: "continue" }, response: "Scoped." });
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
});

test("commits and hides one useful terminal patch after the tool loop", async () => {
	const h = harness();
	await start(h);
	const result = await commitTerminal(h, { goal: "Inspect project", compiled_rules: { read_once: true } }, { verified: { readme: true }, next: "run tests" }, "Inspection complete.");
	assert.equal(result.message.content[0].text, "Inspection complete.");
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "Inspection complete.");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"goal": "Inspect project"/);
	assert.match(h.notifications.at(-1)!, /"next": "run tests"/);
});

test("accepts ordinary terminal answers without invented bookkeeping and rejects materialized null", async () => {
	const h = harness();
	const started = await start(h);
	assert.match(started.systemPrompt, /never invent memory changes/i);
	await commitTerminal(h, {}, {}, "Done");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), response: "Done" });
	await commitTerminal(h, { mode: "test" }, { move: "e2-e4", result: "pending" });
	await commitTerminal(h, {}, { move: null, result: "ok" });
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working, { result: "ok" });
	await assert.rejects(
		h.tools.get("patch_state")!.execute("null", { session: { working: { cells: ["pawn", null] } } }, undefined, undefined, h.ctx),
		/Materialized state cannot contain null/,
	);
});
