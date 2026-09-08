import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdScopeKey, getDurableRepositoryRoot, sessionRuntimePaths, sessionStorageKey, temporalScopePaths } from "../lib/durable.ts";
import { getKnowledgeRoot } from "../lib/discovery.ts";
import { hashArtifactSource } from "../lib/artifact.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("fresh explicit start is local-only; ordinary startup/status and old pointers never create storage", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-fresh-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const repositoryRoot = getDurableRepositoryRoot();
	const knowledgeRoot = getKnowledgeRoot();
	assert.equal(repositoryRoot, join(agentDir, "state-flow"));
	assert.equal(knowledgeRoot, join(agentDir, "knowledge"));
	mkdirSync(knowledgeRoot);
	const source = join(knowledgeRoot, "unrelated.md");
	const bytes = Buffer.from([0xff, 0x61, 0x0a]);
	writeFileSync(source, bytes);
	const h = harness({ repositoryRoot, useDefaultKnowledgeRoot: true, initializeRepository: false });
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.equal(existsSync(repositoryRoot), false);
	// Fixture-only identity is configured by the caller, never by the initializer.
	const config = join(agentDir, "gitconfig");
	writeFileSync(config, '[user]\n name = State Flow Tests\n email = state-flow@example.invalid\n');
	const oldConfig = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = config;
	t.after(() => { if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig; });
	execFileSync("git", ["init", knowledgeRoot], { stdio: "ignore" });
	const git = (...args: string[]) => execFileSync("git", ["-C", knowledgeRoot, ...args], { encoding: "utf8" }).trim();
	writeFileSync(join(knowledgeRoot, "checkpoint.json"), "unrelated owned-name witness");
	git("add", ".");
	git("commit", "-m", "source fixture");
	const sourceHead = git("rev-parse", "HEAD");
	writeFileSync(join(knowledgeRoot, "staged.txt"), "staged witness");
	git("add", "staged.txt");
	const sourceIndex = readFileSync(join(knowledgeRoot, ".git", "index"));
	await start(h);
	assert.equal(git("rev-parse", "HEAD"), sourceHead);
	assert.deepEqual(readFileSync(join(knowledgeRoot, ".git", "index")), sourceIndex);
	assert.equal(readFileSync(join(knowledgeRoot, "checkpoint.json"), "utf8"), "unrelated owned-name witness");
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.notifications.some((message) => /push is pending/.test(message)), false);
	const context = h.handlers.get("context")!({ messages: [user("Inspect", 1)] }, h.ctx);
	assert.ok(JSON.stringify(context).includes(hashArtifactSource(bytes)));
	assert.deepEqual(readFileSync(source), bytes);
	writeFileSync(join(repositoryRoot, "store-only.md"), "not a Knowledge source");
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.doesNotMatch(h.notifications.at(-1)!, /store-only\.md/);
	assert.match(h.notifications.at(-1)!, /unrelated\.md/);
	const custom = harness({ repositoryRoot: join(agentDir, "custom-store"), useDefaultKnowledgeRoot: true, initializeRepository: false });
	await start(custom);
	await custom.commands.get("state-flow-status").handler("", custom.ctx);
	assert.match(custom.notifications.at(-1)!, /unrelated\.md/);
	assert.equal(existsSync(join(custom.repositoryRoot, "checkpoint.json")), true);
	const checkpoint = structuredClone(h.entries.at(-1));
	const resumed = harness({ repositoryRoot, knowledgeRoot, initializeRepository: false });
	resumed.entries.push(checkpoint);
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	await resumed.commands.get("state-flow-status").handler("", resumed.ctx);
	assert.doesNotMatch(resumed.notifications.at(-1)!, /Publication: pending/);
	const missingRoot = join(agentDir, "new-store");
	const old = harness({ repositoryRoot: missingRoot, knowledgeRoot, initializeRepository: false });
	old.entries.push(checkpoint);
	old.handlers.get("session_start")!({ reason: "resume" }, old.ctx);
	await old.commands.get("state-flow-start").handler("", old.ctx);
	assert.equal(existsSync(missingRoot), false);
	assert.deepEqual(old.entries, [checkpoint]);
	assert.match(old.notifications.at(-1)!, /original Git history/);
});

test("live storage paths mirror Pi CWD and session file names without appended hashes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-native-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = "/home/llb/Repos/deos";
	const sessionId = "01a07d75-d380-72ad-84f6-e83040c93368";
	const sessionFile = `/home/llb/.pi/agent/sessions/--home-llb-Repos-deos--/2026-09-07T20-01-08-993Z_${sessionId}.jsonl`;
	const h = harness({ repositoryRoot: root, cwd, sessionId, sessionFile });
	await start(h);
	const key = sessionStorageKey(sessionFile, sessionId);
	const expectedCwd = join(root, "--home-llb-Repos-deos--");
	const expectedSession = join(expectedCwd, key);
	assert.equal(cwdScopeKey(cwd), "--home-llb-Repos-deos--");
	assert.equal(temporalScopePaths(cwd, sessionId, "cwd", root, key).directory, expectedCwd);
	assert.equal(temporalScopePaths(cwd, sessionId, "session", root, key).directory, expectedSession);
	assert.equal(existsSync(join(expectedSession, "checkpoint.json")), true);
	assert.equal(existsSync(join(expectedSession, "patches.jsonl")), true);
	assert.deepEqual(JSON.parse(readFileSync(join(expectedCwd, "checkpoint.json"), "utf8")).owner, { cwd });
	const runtime = sessionRuntimePaths(cwd, sessionId, root, key);
	assert.equal(JSON.parse(readFileSync(runtime.meta, "utf8")).identity.sessionId, sessionId);
	assert.equal(JSON.parse(readFileSync(runtime.meta, "utf8")).identity.cwd, cwd);
	assert.equal(execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).includes("-" + "a".repeat(64)), false);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, new RegExp(`Scope keys: CWD --home-llb-Repos-deos--; session ${key}`));
	const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
	const metaBytes = readFileSync(runtime.meta);
	const foreign = harness({ repositoryRoot: root, cwd, sessionId: "foreign-session", sessionFile, initializeRepository: false });
	await start(foreign);
	assert.equal(foreign.activeTools.includes("patch_state"), false);
	assert.match(foreign.notifications.at(-1)!, /scope identity mismatch/);
	assert.deepEqual(readFileSync(runtime.meta), metaBytes);
	assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});

test("registers patch_state plus read-only read_state and exposes the lifecycle commands", () => {
	const h = harness();
	assert.equal(h.registeredTools, 2);
	assert.deepEqual([...h.tools.keys()].sort(), ["patch_state", "read_state"]);
	assert.equal(h.tools.get("patch_state")!.executionMode, "sequential");
	assert.deepEqual([...h.commands.keys()], ["state-flow-start", "state-flow-status", "state-flow-stop"]);
});
test("State Flow tools follow branch enablement and history reads cannot run while disabled", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.deepEqual(h.activeTools, ["read", "bash"]);
	const read = h.tools.get("read_state");
	await assert.rejects(read.execute("disabled", {}, undefined), /disabled/);
	await start(h);
	assert.deepEqual([...h.activeTools].sort(), ["bash", "patch_state", "read", "read_state"]);
	const enabled = structuredClone(h.entries);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.deepEqual(h.activeTools, ["read", "bash"]);
	await assert.rejects(read.execute("disabled-again", {}, undefined), /disabled/);
	h.ctx.sessionManager.getBranch = () => enabled;
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.activeTools.includes("read_state"), true);
	assert.equal(h.activeTools.includes("patch_state"), true);
	await assert.rejects(read.execute("aborted", {}, AbortSignal.abort()), /aborted/);
});

test("read_state lazily projects all hot offsets and scopes at one boundary without publication or Git calls", async () => {
	const h = harness();
	await start(h);
	const read = h.tools.get("read_state");
	await assert.rejects(read.execute("pre-origin", { offset: 1 }, undefined), /predates the proven temporal origin/);
	const expected: Record<string, Record<string, string>> = { global: {}, cwd: {}, session: {} };
	const history = [structuredClone(expected)];
	const changes = [["global", "G1"], ["cwd", "C2"], ["session", "S3"], ["session", null],
		["cwd", null], ["global", "G6"], ["cwd", "C7"], ["session", "S8"]] as const;
	for (const [scope, value] of changes) {
		await h.tools.get("patch_state").execute("patch", { scope, patch: { working: { shared: value } } }, undefined, undefined, h.ctx);
		if (value === null) delete expected[scope]!.shared;
		else expected[scope]!.shared = value;
		history.push(structuredClone(expected));
	}
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	const checkpointCount = h.entries.length;
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (() => { throw new Error("History read queried a process"); }) as typeof spawn;
	syncBuiltinESMExports();
	try {
		for (let offset = 0; offset <= 7; offset++) {
			const states = history[history.length - 1 - offset]!;
			const boundaries = [];
			for (const scope of ["effective", "global", "cwd", "session"]) {
				const result = await read.execute("history", { offset, scope }, undefined);
				const value = JSON.parse(result.content[0].text);
				const working = scope === "effective" ? { ...states.global, ...states.cwd, ...states.session } : states[scope];
				assert.deepEqual(value.state, { artifacts: {}, contract: {}, working, response: "" });
				assert.equal(value.offset, offset);
				assert.equal(value.scope, scope);
				assert.deepEqual(result.details, { offset, scope, transitionId: value.boundary.id });
				assert.deepEqual(Object.keys(value).sort(), ["boundary", "offset", "scope", "state"]);
				boundaries.push(value.boundary);
			}
			for (const boundary of boundaries) assert.deepEqual(boundary, boundaries[0]);
		}
		assert.equal(JSON.parse((await read.execute("default", {}, undefined)).content[0].text).state.working.shared, "S8");
		assert.equal(JSON.parse((await read.execute("global-default", { scope: "global" }, undefined)).content[0].text).state.working.shared, "G6");
		for (const offset of [-1, 0.5, 8, null, "1"]) await assert.rejects(read.execute("invalid", { offset }, undefined), /0 to 7/);
		for (const scope of [null, "other"]) await assert.rejects(read.execute("invalid-scope", { scope }, undefined), /Unknown temporal scope/);
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
	assert.equal(head(), before);
	assert.equal(h.entries.length, checkpointCount);
	assert.equal(h.resolveSnapshot().meta.step, 8);
});

test("lets ordinary tool-bearing responses run without comments or intermediate state commits", async () => {
	const h = harness();
	await start(h, "Investigate");
	const beforeEntries = h.entries.length;
	const response = h.handlers.get("message_end")!({ message: toolAssistant("read-1") }, h.ctx);
	assert.equal(response, undefined);
	h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.resolveSnapshot().meta.step, 0);
});

test("patch_state materializes session state before the next inference and terminal reconciliation remains required", async () => {
	const h = harness();
	await start(h, "Long-running task");
	const patchState = h.tools.get("patch_state")!;
	const result = await patchState.execute(
		"patch-1",
		{ scope: "session", patch: { working: { verified: "intermediate" } } },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(result.content[0].text, "State materialized at session scope.");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "");

	const projected = h.handlers.get("context")!({ messages: [user("Long-running task", 1)] }, h.ctx);
	assert.equal(projected.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context")).length, 1);
	assert.match(projected.messages[0].content[0].text, /"verified":"intermediate"/);

	const terminal = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete." }] },
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: terminal.message }, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "Complete.");
});

test("patch_state is the only tool allowed to execute from its assistant response", async () => {
	const h = harness();
	await start(h, "Barrier task");
	h.entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "history-1", name: "read_state", arguments: { offset: 1 } },
				{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "echo stale" } },
				{ type: "toolCall", id: "patch-1", name: "patch_state", arguments: { scope: "session", patch: {} } },
			],
		},
	});
	const gate = h.handlers.get("tool_call")!;
	assert.match(gate({ toolCallId: "history-1", toolName: "read_state", input: { offset: 1 } }, h.ctx).reason, /barrier/);
	assert.match(gate({ toolCallId: "bash-1", toolName: "bash", input: { command: "echo stale" } }, h.ctx).reason, /barrier/);
	assert.equal(gate({ toolCallId: "patch-1", toolName: "patch_state", input: { scope: "session", patch: {} } }, h.ctx), undefined);

	h.entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "patch-2", name: "patch_state", arguments: { scope: "session", patch: {} } },
				{ type: "toolCall", id: "patch-3", name: "patch_state", arguments: { scope: "cwd", patch: {} } },
			],
		},
	});
	assert.match(gate({ toolCallId: "patch-2", toolName: "patch_state", input: {} }, h.ctx).reason, /exactly one/);
});
