import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { abandonValidation, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "../lib/episode.ts";
import { loadCwdState, loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("starts, resumes, and stops branch-local episodes without discarding state", () => {
	const started = startEpisode(true);
	assert.deepEqual(started, {
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 0, bootstrap: true },
	});
	started.meta.step = 3;
	const stopped = stopEpisode(started);
	assert.deepEqual(stopped, {
		config: { enabled: false, transitionWindow: 7 },
		meta: { step: 3, bootstrap: true },
	});
	assert.deepEqual(resumeEpisode(stopped, false), { ...stopped, config: { enabled: true, transitionWindow: 7 } });
});

test("rotates specifications only at non-retry run boundaries", () => {
	const snapshot = startEpisode(false);
	assert.equal(prepareRun(snapshot, "first", false), true);
	snapshot.meta.validation = { attempt: 1, error: "invalid", instruction: "retry" };
	assert.equal(prepareRun(snapshot, "retry payload", true), false);
	assert.equal(snapshot.meta.specification, "first");
	assert.equal(snapshot.meta.validation.attempt, 1);
	assert.equal(prepareRun(snapshot, "second", false), true);
	assert.equal(snapshot.meta.specification, "second");
	assert.equal(snapshot.meta.validation, undefined);
});

test("abandons validation without disabling or clearing config", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.validation = { attempt: 2, error: "invalid", instruction: "retry" };
	assert.equal(abandonValidation(snapshot), true);
	assert.equal(abandonValidation(snapshot), false);
	assert.equal(snapshot.config.enabled, true);
});

test("does not demand a terminal handoff from an aborted response", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(result, undefined);
	assert.equal(h.sentMessages.length, 0);
	assert.equal(h.resolveSnapshot().meta.step, 0);
});
test("abandons an interrupted validation retry before the next user run", async () => {
	const h = harness();
	await start(h, "Old request");
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	assert.equal(h.sentMessages.length, 1);
	assert.equal(h.resolveSnapshot().meta.validation!.attempt, 1);

	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(h.resolveSnapshot().meta.validation, undefined);
	const next = h.handlers.get("before_agent_start")!({ prompt: "New request", systemPrompt: "base" }, h.ctx);
	assert.doesNotMatch(next.systemPrompt, /Old request|New request/);
	assert.equal(h.resolveSnapshot().meta.specification, "New request");
});
test("start creates the CWD activation marker and stop preserves branch state", async () => {
	const h = harness({ cwd: "/tmp/state-flow-episode" });
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot), undefined);
	await start(h);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.deepEqual(loadCwdState(h.ctx.cwd, h.repositoryRoot), {
		artifacts: {},
		contract: {},
		working: {},
		response: "",
	});
	commitTerminal(h, { goal: "x" }, { next: "y" });
	const committed = h.resolveSnapshot();
	const semantic = structuredClone(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot));
	const head = execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	assert.deepEqual(h.resolveSnapshot(), {
		...committed,
		config: { enabled: false, transitionWindow: 7 },
		meta: { ...committed.meta, durableBase: h.entries.at(-1)!.data.revision },
	});
	assert.deepEqual(Object.keys(h.entries.at(-1)!.data), ["revision"]);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), semantic);
	assert.notEqual(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});
