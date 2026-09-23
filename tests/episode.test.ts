import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTemporalFileBases } from "../lib/durable.ts";
import test from "node:test";
import { completeRun, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "../lib/episode.ts";
import { awaitInFlightBackupPushes } from "../lib/git.ts";
import { stateFlowLogPath } from "../lib/logging.ts";
import { loadCwdState, loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start } from "./harness.ts";

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous backup replication");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("accepted turns defer canonical-file backup and replication until agent_before_settle", async () => {
	const h = harness();
	await start(h);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await commitTerminal(h, {}, { settled: true }, "Settled answer");
	assert.equal(head(), before, "turn_end accepts canonical files without creating a Git commit");
	h.handlers.get("agent_before_settle")!({}, h.ctx);
	const backedUp = head();
	assert.notEqual(backedUp, before);
	const remote = execFileSync("git", ["-C", h.repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
	await waitFor(() => execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim() === backedUp);
	h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(head(), backedUp, "notification-only settlement does not repeat backup work");
});

test("session shutdown awaits a slow failing push without post-shutdown writes or warnings", async () => {
	const h = harness();
	await start(h);
	const entered = join(h.repositoryRoot, "push-entered");
	const release = join(h.repositoryRoot, "push-release");
	const hook = join(h.repositoryRoot, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'entered\\n' > ${JSON.stringify(entered)}\nwhile [ ! -e ${JSON.stringify(release)} ]; do sleep 0.02; done\nexit 1\n`);
	chmodSync(hook, 0o755);
	await commitTerminal(h, {}, { accepted: 1 }, "Accepted answer");
	h.handlers.get("agent_before_settle")!({}, h.ctx);
	await waitFor(() => existsSync(entered));
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const remote = execFileSync("git", ["-C", h.repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
	const remoteHead = execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	const warnings = [...h.notifications];
	let settled = false;
	const shutdown = Promise.resolve(h.handlers.get("session_shutdown")!({}, h.ctx)).then(() => { settled = true; });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(settled, false);
	writeFileSync(release, "go\n");
	await shutdown;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteHead);
	assert.deepEqual(h.notifications, warnings);
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

test("missing Git commit identity cannot reject or roll back accepted canonical state", async () => {
	const h = harness({ initializeRepository: false });
	const isolated = mkdtempSync(join(tmpdir(), "state-flow-no-git-identity-"));
	const previous = process.env.GIT_CONFIG_GLOBAL;
	try {
		const config = join(isolated, "config");
		writeFileSync(config, "");
		process.env.GIT_CONFIG_GLOBAL = config;
		execFileSync("git", ["-C", h.repositoryRoot, "init", "-b", "main"], { stdio: "ignore" });
		assert.throws(() => execFileSync("git", ["-C", h.repositoryRoot, "config", "--get", "user.name"], { stdio: "ignore" }));
		assert.throws(() => execFileSync("git", ["-C", h.repositoryRoot, "config", "--get", "user.email"], { stdio: "ignore" }));
		await start(h);
		await commitTerminal(h, {}, { accepted: true }, "Accepted without Git identity");
		const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		assert.ok(files.some((file) => file.bytes !== undefined));
		assert.equal(loadSessionState(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot)?.response, "Accepted without Git identity");
		assert.equal(h.handlers.get("agent_before_settle")!({}, h.ctx), undefined);
		const warnings = h.notifications.filter((message) => message.includes("accepted canonical state; Git backup failed"));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Git command failed \(commit-tree /);
		assert.throws(() => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" }));
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
		assert.equal(h.readState().response, "Accepted without Git identity");
	} finally {
		if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previous;
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("repeated server push failures warn once, retain local details, and reset after recovery", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-push-logs-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const h = harness({ agentDir });
	await start(h);
	const remote = execFileSync("git", ["-C", h.repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
	const hook = join(h.repositoryRoot, ".git", "hooks", "pre-push");
	const reject = () => {
		writeFileSync(hook, "#!/bin/sh\nprintf 'server temporarily unavailable\\nserver request id: retry-123\\n' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
	};
	const logPath = stateFlowLogPath(h.agentDir);
	const details = () => readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const warnings = () => h.notifications.filter((message) => message.includes("Git backup push failed"));
	reject();
	for (const attempt of [1, 2]) {
		await commitTerminal(h, {}, { accepted: attempt }, `Accepted ${attempt}`);
		h.handlers.get("agent_before_settle")!({}, h.ctx);
		await awaitInFlightBackupPushes(h.repositoryRoot);
		assert.equal(h.readState().response, `Accepted ${attempt}`);
		assert.equal(warnings().length, 1);
		assert.doesNotMatch(warnings()[0], /server temporarily unavailable|retry-123/);
		assert.equal(details().length, attempt);
		assert.match(details().at(-1).error, /server temporarily unavailable\nserver request id: retry-123/);
	}
	assert.match(warnings()[0], /state is saved locally.*Details: .*logs\.jsonl.*later accepted turn retries/);
	unlinkSync(hook);
	await commitTerminal(h, {}, { accepted: 3 }, "Recovered");
	h.handlers.get("agent_before_settle")!({}, h.ctx);
	await awaitInFlightBackupPushes(h.repositoryRoot);
	const head = execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), head);
	assert.equal(h.readState().response, "Recovered");
	assert.equal(warnings().length, 1);
	reject();
	await commitTerminal(h, {}, { accepted: 4 }, "Accepted after recovery");
	h.handlers.get("agent_before_settle")!({}, h.ctx);
	await awaitInFlightBackupPushes(h.repositoryRoot);
	assert.equal(warnings().length, 2, "a new failure after recovery warns again");
	assert.equal(details().length, 3);
	assert.equal(h.readState().response, "Accepted after recovery");
	assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), head);
});

test("push failure remains diagnosable when the local log path overlaps the store", async () => {
	const h = harness();
	await start(h);
	const hook = join(h.repositoryRoot, ".git", "hooks", "pre-push");
	writeFileSync(hook, "#!/bin/sh\nprintf 'temporary server failure\\n' >&2\nexit 1\n");
	chmodSync(hook, 0o755);
	for (const attempt of [1, 2]) {
		await commitTerminal(h, {}, { accepted: attempt }, `Accepted ${attempt}`);
		h.handlers.get("agent_before_settle")!({}, h.ctx);
		await awaitInFlightBackupPushes(h.repositoryRoot);
	}
	assert.equal(existsSync(stateFlowLogPath(h.agentDir)), false);
	const warnings = h.notifications.filter((message) => message.includes("Git backup push failed"));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /local diagnostics unavailable: Git backup push failed.*temporary server failure/s);
	assert.equal(h.readState().response, "Accepted 2");
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
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), semantic);
});
