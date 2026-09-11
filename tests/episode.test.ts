import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareRun, resumeEpisode, startEpisode, stopEpisode } from "../lib/episode.ts";
import { loadCwdState, loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start } from "./harness.ts";

test("starts, resumes, and stops branch-local episodes without discarding state", () => {
	const started = startEpisode(true);
	assert.deepEqual(started, {
		config: { enabled: true },
		meta: { step: 0, bootstrap: true },
	});
	started.meta.step = 3;
	const stopped = stopEpisode(started);
	assert.deepEqual(stopped, {
		config: { enabled: false },
		meta: { step: 3, bootstrap: true },
	});
	assert.deepEqual(resumeEpisode(stopped, false), { ...stopped, config: { enabled: true } });
});

test("rotates specifications at user-run boundaries", () => {
	const snapshot = startEpisode(false);
	assert.equal(prepareRun(snapshot, "first"), true);
	assert.equal(snapshot.meta.specification, "first");
	assert.equal(prepareRun(snapshot, "second"), true);
	assert.equal(snapshot.meta.specification, "second");
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
test("an interrupted unresolved draft never becomes response and the next user run rotates specification", async () => {
	const h = harness();
	await start(h, "Old request");
	const draft = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unresolved draft" }] },
	}, h.ctx);
	assert.deepEqual(draft.message.content, []);
	h.handlers.get("turn_end")!({ message: draft.message }, h.ctx);
	assert.equal(h.readState().response, "");
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
	await commitTerminal(h, { goal: "x" }, { next: "y" });
	const committed = h.resolveSnapshot();
	const semantic = structuredClone(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot));
	const head = execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	// The helper projects unpushed commits as pending; asynchronous publication timing is outside this episode test.
	const stopped = h.resolveSnapshot();
	assert.deepEqual(
		{ ...stopped, meta: { ...stopped.meta, pendingPublication: undefined } },
		{
			...committed,
			config: { enabled: false },
			meta: { ...committed.meta, durableBase: h.entries.at(-1)!.data.revision, pendingPublication: undefined },
		},
	);
	assert.deepEqual(Object.keys(h.entries.at(-1)!.data), ["revision"]);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), semantic);
	assert.notEqual(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});
