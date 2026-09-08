import assert from "node:assert/strict";
import test from "node:test";
import { commitScopedTransition, stageScopedPatch, stageScopedTransition } from "../lib/transition.ts";
import type { AcceptedTransition } from "../lib/history.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import { advanceTemporalState, createTemporalState, readTemporalState } from "../lib/temporal.ts";
import { parseScopeStream, serializeScopeStream } from "../lib/durable.ts";
import { emptyState, type ScopedStates } from "../lib/state.ts";
import { loadCwdState, loadGlobalState, loadSessionMaterialization, loadSessionState } from "./temporal-fixture.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { commitTerminal, harness, scopedTerminalComment, start, terminalComment } from "./harness.ts";

function states(): ScopedStates {
	return { global: emptyState(), cwd: emptyState(), session: emptyState() };
}

function snapshot() {
	const result = emptySnapshot(true);
	result.meta.bootstrap = true;
	return result;
}

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

test("normalizes artifact replacements and runtime freshness after finalized-response reconciliation", () => {
	const state = states();
	const source = { path: "/knowledge/source.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", hash: `sha256:${"c".repeat(64)}` };
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
		accepted.scopes[scope] = parseScopeStream(bytes.checkpoint, bytes.patches, scope, identity)!;
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
	const stage = stageScopedPatch(state, { scope: "session", patch: { working: { checkpoint: "verified" } } }, [], "origin");
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

test("rejects stale state and identical values at a different active causal boundary", () => {
	const current = snapshot();
	const state = states();
	const origin = createTemporalState(state, "origin");
	const fork = createTemporalState(state, "other-origin");
	assert.deepEqual(readTemporalState(origin), readTemporalState(fork));
	const stage = stageScopedPatch(state, { scope: "session", patch: { working: { accepted: true } } }, [], origin.lineage.at(-1)!.id);
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("cross-lineage publication"), fork.lineage.at(-1)!.id), /causal basis changed/);
	state.session.working.changed = true;
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("stale publication"), origin.lineage.at(-1)!.id), /session scope changed after response validation/);
	assert.equal(current.meta.step, 0);
});

test("validates acquired artifact and Skill outputs before staging trusted freshness", () => {
	const state = states();
	const source = { path: "/knowledge/changed.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", hash: `sha256:${"a".repeat(64)}` };
	assert.throws(() => stageScopedPatch(state, { scope: "session", patch: { artifacts: { "/a.md": { description: "Missing freshness" } } } }, [], "origin"), /must have a sha256/);
	assert.throws(() => stageScopedTransition(state, { transitions: [], response: "Missing" }, [], "origin", [source]), /global compiler output/);
	assert.throws(() => stageScopedPatch(state, { scope: "cwd", patch: {} }, [skill], "origin"), /missing: \/skills\/demo\/SKILL\.md/);
	const stage = stageScopedTransition(state, { transitions: [
		{ scope: "global", patch: { artifacts: { [source.path]: { description: "Guidance" } } } },
		{ scope: "cwd", patch: { artifacts: { [skill.path]: { description: "Skill", kind: "skill", compilation: { route: "demo" } } } } },
	], response: "Compiled" }, [skill], "origin", [source]);
	assert.deepEqual(stage.nextStates.global.artifacts[source.path], { description: "Guidance", hash: source.hash, compiler: "artifact-v1" });
	assert.deepEqual(stage.nextStates.cwd.artifacts[skill.path], { description: "Skill", kind: "skill", compilation: { route: "demo" }, hash: skill.hash, compiler: "skill-artifact-v1" });
	assert.throws(() => stageScopedTransition(state, { transitions: [
		{ scope: "global", patch: { artifacts: { [source.path]: { description: "Forged", hash: source.hash } } } },
	], response: "Rejected" }, [], "origin", [source]), /cannot set runtime-owned/);
	assert.throws(() => stageScopedPatch(state, { scope: "session", patch: { contract: { compiled_skills: { legacy: true } } } }, [], "origin"), /contract\.compiled_skills is retired/);
});

test("session-only transitions persist only the current temporal session layer", async () => {
	const h = harness({ cwd: "/tmp/state-flow-session-only-transition" });
	await start(h);
	const before = loadCwdState(h.ctx.cwd, h.repositoryRoot);
	commitTerminal(h, { branch: "only" }, { next: "continue" });
	assert.deepEqual(loadGlobalState(h.repositoryRoot), emptyState());
	assert.deepEqual(loadCwdState(h.ctx.cwd, h.repositoryRoot), before);
	const session = loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot)!;
	assert.deepEqual(session.state, { ...emptyState(), contract: { branch: "only" }, working: { next: "continue" }, response: "Done" });
	assert.deepEqual(session.recentTransitions[0]!.transitions, [{ scope: "session", patch: { contract: { branch: "only" }, working: { next: "continue" }, response: "Done" } }]);
});

test("commits global, CWD, and session patches through one terminal transition", async () => {
	const h = harness({ cwd: "/tmp/state-flow-scoped-transition" });
	await start(h);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${scopedTerminalComment([
		{ scope: "global", patch: { contract: { shared: "all projects" } } },
		{ scope: "cwd", patch: { contract: { project: "local" } } },
		{ scope: "session", patch: { working: { next: "continue" } } },
	])}\n\nScoped.` }] };
	const result = h.handlers.get("message_end")!({ message }, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(loadGlobalState(h.repositoryRoot)!.contract.shared, "all projects");
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot)!.contract.project, "local");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), working: { next: "continue" }, response: "Scoped." });
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
});

test("commits and hides one useful terminal patch after the tool loop", async () => {
	const h = harness();
	await start(h);
	const result = commitTerminal(h, { goal: "Inspect project", compiled_rules: { read_once: true } }, { verified: { readme: true }, next: "run tests" }, "Inspection complete.");
	assert.equal(result.message.content[0].text, "Inspection complete.");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "Inspection complete.");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#1</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"goal": "Inspect project"/);
	assert.match(h.notifications.at(-1)!, /"next": "run tests"/);
});

test("accepts unchanged memory without invented bookkeeping and rejects materialized null", async () => {
	const h = harness();
	const started = await start(h);
	assert.match(started.systemPrompt, /Never invent memory changes/);
	commitTerminal(h, {}, {}, "Done");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), response: "Done" });
	commitTerminal(h, { mode: "test" }, { move: "e2-e4", result: "pending" });
	commitTerminal(h, {}, { move: null, result: "ok" });
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working, { result: "ok" });
	const rejected = h.handlers.get("message_end")!({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${terminalComment({}, { cells: ["pawn", null] })}\n\nDone` }] } }, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.resolveSnapshot().meta.validation!.error, /Materialized state cannot contain null/);
});
