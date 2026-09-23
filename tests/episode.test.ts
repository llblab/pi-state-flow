import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureTemporalFileBases } from "../lib/durable.ts";
import test from "node:test";
import { completeRun, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "../lib/episode.ts";
import { loadCwdState, loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start } from "./harness.ts";

test("accepted turns defer canonical-file backup until agent_before_settle", async () => {
	const h = harness();
	await start(h);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await commitTerminal(h, {}, { settled: true }, "Settled answer");
	assert.equal(head(), before, "turn_end accepts canonical files without creating a Git commit");
	h.handlers.get("agent_before_settle")!({}, h.ctx);
	const backedUp = head();
	assert.notEqual(backedUp, before);
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(head(), backedUp, "notification-only settlement does not repeat backup work");
});

test("settled backup failure is diagnostic-only and is not retried without another accepted turn", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, {}, { accepted: true }, "Accepted answer");
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const snapshot = h.resolveSnapshot();
	const messages = h.sentMessages.length;
	const lock = join(h.repositoryRoot, ".git", "state-flow-backup.lock");
	writeFileSync(lock, "caller-owned interrupted backup\n");
	for (let attempt = 0; attempt < 2; attempt++) assert.equal(h.handlers.get("agent_before_settle")!({}, h.ctx), undefined);
	assert.equal(h.notifications.filter((message) => message.includes("accepted canonical state; Git backup failed")).length, 1);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.deepEqual(h.resolveSnapshot(), snapshot);
	assert.equal(h.readState().response, "Accepted answer");
	assert.equal(h.sentMessages.length, messages);
	assert.equal(readFileSync(lock, "utf8"), "caller-owned interrupted backup\n");
});

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
	completeRun(snapshot);
	assert.equal(snapshot.meta.specification, undefined);
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
test("a preserved unresolved draft becomes response and the next user run rotates specification", async () => {
	const h = harness();
	await start(h, "Old request");
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unresolved draft" }] };
	assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined, "the primary draft is preserved instead of intercepted");
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Unresolved draft");
	const next = h.beforeAgentStart("New request");
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
		intents: {},
		response: "",
		lazy: {},
	});
	await commitTerminal(h, { goal: "x" }, { next: "y" });
	const committed = h.resolveSnapshot();
	const semantic = structuredClone(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot));
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const stopped = h.resolveSnapshot();
	assert.equal(stopped.config.enabled, false);
	assert.equal(stopped.meta.step, committed.meta.step);
	const checkpoint = h.entries.at(-1)!.data;
	assert.equal(Object.hasOwn(checkpoint, "revision") || Object.hasOwn(checkpoint, "boundary"), true);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), semantic);
});
