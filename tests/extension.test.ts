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
import { MAX_FALLBACK_ATTEMPTS } from "../lib/extension.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

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
	const contextText = context.messages
		.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
		.map((block: any) => block.text)
		.find((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
	assert.ok(contextText);
	assert.deepEqual(JSON.parse(contextText.slice(contextText.indexOf("\n") + 1)).artifact_invalidations, [{
		path: source,
		reason: "new",
	}]);
	// Source identity and runtime bookkeeping never reach ordinary model context.
	assert.equal(contextText.includes(hashArtifactSource(bytes)), false);
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

test("explicit activation defers artifact discovery until the next enabled inference", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-deferred-discovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const knowledgeRoot = join(root, "knowledge");
	mkdirSync(knowledgeRoot);
	const repositoryRoot = join(root, "store");
	mkdirSync(repositoryRoot);
	const h = harness({ repositoryRoot, knowledgeRoot });
	await h.commands.get("state-flow-start").handler("", h.ctx);
	const lateSource = join(knowledgeRoot, "late.md");
	writeFileSync(lateSource, "Created after the activation command returned.\n");

	h.handlers.get("before_agent_start")!({ prompt: "Use current knowledge", systemPrompt: "base" }, h.ctx);
	const projected = h.handlers.get("context")!({ messages: [user("Use current knowledge", Date.now())] }, h.ctx);
	assert.match(JSON.stringify(projected.messages), new RegExp(lateSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(JSON.stringify(projected.messages), /\\\"reason\\\":\\\"new\\\"/);
});

test("final-only resolution cannot bypass an acquired invalidated artifact", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-artifact-resolution-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const knowledgeRoot = join(root, "knowledge");
	mkdirSync(knowledgeRoot);
	const source = join(knowledgeRoot, "routing.md");
	writeFileSync(source, "Routing source.\n");
	const repositoryRoot = join(root, "store");
	mkdirSync(repositoryRoot);
	const h = harness({ repositoryRoot, knowledgeRoot });
	await start(h, "Acquire routing");
	const input = { path: source };
	h.handlers.get("tool_call")!({ toolCallId: "artifact-read", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "artifact-read", toolName: "read", result: {}, isError: false }, h.ctx);
	await assert.rejects(
		h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx),
		/Every successfully read invalidated artifact must have a global compiler output/,
	);
	await h.tools.get("patch_state")!.execute("compile", {
		global: { artifacts: { [source]: { description: "Routing source" } } }, final: true,
	}, undefined, undefined, h.ctx);
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
		await h.tools.get("patch_state").execute("patch", { [scope]: { working: { shared: value } } }, undefined, undefined, h.ctx);
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

test("global memory is always available while State Flow is enabled", async () => {
	const h = harness();
	const started = await start(h, "Durable preference");
	assert.match(started.systemPrompt, /State Flow owns durable memory while enabled/);
	const accepted = await h.tools.get("patch_state")!.execute(
		"global-memory", { global: { working: { preference: "compact" } } }, undefined, undefined, h.ctx,
	);
	assert.equal(accepted.content[0].text, "\nState materialized atomically at global scope.");
	assert.equal(h.readState(0, "global").working.preference, "compact");
});

test("patch_state commits global, CWD, and session as one model-facing atomic barrier", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Atomic scope cohort");
	const beforeStep = h.resolveSnapshot().meta.step;
	const result = await h.tools.get("patch_state")!.execute("atomic", {
		global: { contract: { shared: "global" } },
		cwd: { working: { project: "cwd" } },
		session: { working: { continuation: "session" } },
	}, undefined, undefined, h.ctx);
	assert.deepEqual(result.details.scopes, ["global", "cwd", "session"]);
	assert.equal(h.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(h.readState(0, "global").contract.shared, "global");
	assert.equal(h.readState(0, "cwd").working.project, "cwd");
	assert.equal(h.readState(0, "session").working.continuation, "session");
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Still pending.") }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message: finalMessage("Still pending.") }, h.ctx);
	assert.equal(h.readState().response, "Still pending.");
});

test("patch_state materializes session state before the next inference and response reconciliation", async () => {
	const h = harness();
	await start(h, "Long-running task");
	const patchState = h.tools.get("patch_state")!;
	const result = await patchState.execute(
		"patch-1",
		{ session: { working: { verified: "intermediate" } }, final: true },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(result.content[0].text, "\nState materialized atomically at session scope.");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "");

	const projected = h.handlers.get("context")!({ messages: [user("Long-running task", 1)] }, h.ctx);
	assert.equal(projected.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context")).length, 1);
	assert.match(projected.messages[0].content[0].text, /"verified":"intermediate"/);

	const terminal = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete." }] };
	assert.equal(h.handlers.get("message_end")!({ message: terminal }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message: terminal }, h.ctx);
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
				{ type: "toolCall", id: "patch-1", name: "patch_state", arguments: { session: { working: { next: true } } } },
			],
		},
	});
	const gate = h.handlers.get("tool_call")!;
	assert.match(gate({ toolCallId: "history-1", toolName: "read_state", input: { offset: 1 } }, h.ctx).reason, /barrier/);
	assert.match(gate({ toolCallId: "bash-1", toolName: "bash", input: { command: "echo stale" } }, h.ctx).reason, /barrier/);
	assert.equal(gate({ toolCallId: "patch-1", toolName: "patch_state", input: { session: { working: { next: true } } } }, h.ctx), undefined);

	h.entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "patch-2", name: "patch_state", arguments: { session: { working: { first: true } } } },
				{ type: "toolCall", id: "patch-3", name: "patch_state", arguments: { cwd: { working: { second: true } } } },
			],
		},
	});
	assert.match(gate({ toolCallId: "patch-2", toolName: "patch_state", input: {} }, h.ctx).reason, /exactly one/);
});

test("patch_state tolerates shared-scope drift while preserving the session layer", async () => {
	const a = harness({ remotePublication: "off" });
	await start(a, "Session A");
	await a.tools.get("patch_state")!.execute("a-initial", { session: { working: { owner: "A" } } }, undefined, undefined, a.ctx);
	const b = harness({
		repositoryRoot: a.repositoryRoot,
		cwd: a.ctx.cwd,
		sessionId: "harness-session-b",
		remotePublication: "off",
		initializeRepository: false,
	});
	await start(b, "Session B");
	await b.tools.get("patch_state")!.execute("b-global", { global: { working: { globalFromB: true } } }, undefined, undefined, b.ctx);
	const beforeStep = a.resolveSnapshot().meta.step;
	const result = await a.tools.get("patch_state")!.execute("a-session", { session: { working: { continued: true } } }, undefined, undefined, a.ctx);
	assert.equal(result.content[0].text, "\nState materialized atomically at session scope.");
	assert.equal(a.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(a.readState(0, "session").working.owner, "A");
	assert.equal(a.readState(0, "session").working.continued, true);
	assert.equal(a.readState(0, "global").working.globalFromB, true);
	assert.equal(JSON.stringify(a.sentMessages).includes("cannot publish"), false);
});


function finalMessage(text: string) {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}

test("a primary draft without eligibility is preserved as the response and final-only fallback resolution keeps it", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "No durable work");
	const primary = h.handlers.get("message_end")!({ message: finalMessage("Preserved answer.") }, h.ctx);
	assert.equal(primary, undefined, "the primary draft is never intercepted");
	assert.equal(h.sentMessages.length, 1, "the fallback steer starts the resolution turn");
	h.handlers.get("turn_end")!({ message: finalMessage("Preserved answer.") }, h.ctx);
	assert.equal(h.readState().response, "Preserved answer.");

	const beforeStep = h.resolveSnapshot().meta.step;
	const resolution = await h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx);
	assert.deepEqual(resolution.details, { final: true });
	assert.equal(h.resolveSnapshot().meta.step, beforeStep);
	const fallback = h.handlers.get("message_end")!({ message: finalMessage("Fallback text.") }, h.ctx);
	assert.deepEqual(fallback.message.content, [], "fallback messages never become the response");
	assert.equal(h.sentMessages.length, 1, "the resolved fallback needs no further steering");
	h.handlers.get("turn_end")!({ message: fallback.message }, h.ctx);
	assert.equal(h.readState().response, "Preserved answer.");
	assert.equal(h.resolveSnapshot().meta.step, 1);
});

test("the preserved answer stands after two fallback turns without final:true", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Bound fallback attempts");
	await assert.rejects(
		h.tools.get("patch_state")!.execute("invalid", { final: false }, undefined, undefined, h.ctx),
		/final must be exactly true/,
	);
	assert.equal(h.sentMessages.length, 0, "failed patch calls do not consume fallback attempts");
	const primary = h.handlers.get("message_end")!({ message: finalMessage("Primary answer.") }, h.ctx);
	assert.equal(primary, undefined);
	h.handlers.get("turn_end")!({ message: finalMessage("Primary answer.") }, h.ctx);
	assert.equal(h.readState().response, "Primary answer.");
	for (let attempt = 1; attempt <= MAX_FALLBACK_ATTEMPTS; attempt++) {
		const fallback = h.handlers.get("message_end")!({ message: finalMessage(`Fallback ${attempt}`) }, h.ctx);
		assert.deepEqual(fallback.message.content, []);
		h.handlers.get("turn_end")!({ message: fallback.message }, h.ctx);
	}
	assert.equal(h.sentMessages.length, MAX_FALLBACK_ATTEMPTS, "each fallback turn consumes at most one steering message");
	assert.equal(h.notifications.filter((message) => /no final:true patch arrived after 2 fallback turns/.test(message)).length, 1);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.readState().response, "Primary answer.");
	assert.equal(h.resolveSnapshot().meta.step, 1);
});

test("fallback resolution state resets with the next enabled iteration", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "First iteration");
	h.handlers.get("message_end")!({ message: finalMessage("First primary") }, h.ctx);
	h.handlers.get("turn_end")!({ message: finalMessage("First primary") }, h.ctx);
	for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
		const fallback = h.handlers.get("message_end")!({ message: finalMessage(`First fallback ${attempt}`) }, h.ctx);
		h.handlers.get("turn_end")!({ message: fallback.message }, h.ctx);
	}
	assert.equal(h.sentMessages.length, MAX_FALLBACK_ATTEMPTS);
	h.handlers.get("before_agent_start")!({ prompt: "Next iteration", systemPrompt: "base" }, h.ctx);
	h.handlers.get("message_end")!({ message: finalMessage("Next primary") }, h.ctx);
	assert.equal(h.sentMessages.length, MAX_FALLBACK_ATTEMPTS + 1, "the next iteration starts a fresh fallback resolution");
});

test("an atomic fallback patch applies while the preserved answer stands", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Remember this");
	const primary = h.handlers.get("message_end")!({ message: finalMessage("Preserved draft.") }, h.ctx);
	assert.equal(primary, undefined);
	h.handlers.get("turn_end")!({ message: finalMessage("Preserved draft.") }, h.ctx);
	await h.tools.get("patch_state")!.execute("patch", { session: { working: { next: "ship" } }, final: true }, undefined, undefined, h.ctx);
	const fallback = h.handlers.get("message_end")!({ message: finalMessage("Fallback text.") }, h.ctx);
	assert.deepEqual(fallback.message.content, []);
	h.handlers.get("turn_end")!({ message: fallback.message }, h.ctx);
	assert.equal(h.readState().working.next, "ship");
	assert.equal(h.readState().response, "Preserved draft.");
});

test("a failed later patch does not revoke terminal eligibility", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Two decisions");
	await h.tools.get("patch_state")!.execute("accepted", { session: { working: { first: true } }, final: true }, undefined, undefined, h.ctx);
	await assert.rejects(
		h.tools.get("patch_state")!.execute("failed", { session: { working: { first: true } } }, undefined, undefined, h.ctx),
		/must materially update state or required provenance/,
	);
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Still final.") }, h.ctx), undefined);
});

test("a host-rejected patch_state call does not revoke terminal eligibility", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Host validation");
	await h.tools.get("patch_state")!.execute("accepted", { session: { working: { first: true } }, final: true }, undefined, undefined, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "schema-failure", toolName: "patch_state", isError: true }, h.ctx);
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Still final.") }, h.ctx), undefined);
});

test("length and provider-error endings never become accepted responses", async () => {
	for (const stopReason of ["length", "error"]) {
		const h = harness({ remotePublication: "off" });
		await start(h, `Stop reason ${stopReason}`);
		await h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx);
		const message = { ...finalMessage("Incomplete output."), stopReason };
		assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
		h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, "");
		assert.equal(h.sentMessages.length, 0);
	}
});

test("accepts only canonical atomic scope patches and final:true", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Resolve me");
	const execute = (input: unknown) => h.tools.get("patch_state")!.execute("invalid", input, undefined, undefined, h.ctx);
	for (const input of [
		null,
		[],
		{},
		{ final: false },
		{ unchanged: true },
		{ scope: "session", patch: { working: { value: true } } },
		{ session: {} },
		{ session: { working: { value: true } }, extra: "forbidden" },
		{ global: null },
	]) await assert.rejects(execute(input));

	const primary = h.handlers.get("message_end")!({ message: finalMessage("Still unresolved.") }, h.ctx);
	assert.equal(primary, undefined, "the unresolved draft is preserved instead of intercepted");
	h.handlers.get("turn_end")!({ message: finalMessage("Still unresolved.") }, h.ctx);
	assert.equal(h.readState().response, "Still unresolved.");
	await h.tools.get("patch_state")!.execute("valid", { final: true }, undefined, undefined, h.ctx);
	const fallback = h.handlers.get("message_end")!({ message: finalMessage("Resolved.") }, h.ctx);
	assert.deepEqual(fallback.message.content, [], "fallback messages stay out of the response");
	h.handlers.get("turn_end")!({ message: fallback.message }, h.ctx);
	assert.equal(h.readState().response, "Still unresolved.");
});

test("terminal eligibility remains latched through later tools, patches, and repeated final calls", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Latch terminal eligibility");
	const beforeStep = h.resolveSnapshot().meta.step;
	await h.tools.get("patch_state")!.execute("first-final", { final: true }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, beforeStep);
	h.handlers.get("message_end")!({ message: toolAssistant("later-read") }, h.ctx);
	await h.tools.get("patch_state")!.execute("later-patch", {
		session: { working: { afterFinal: true } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, beforeStep + 1);
	await h.tools.get("patch_state")!.execute("repeated-final", { final: true }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Latched.") }, h.ctx), undefined);
});

test("a new enabled iteration resets terminal eligibility", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "First iteration");
	await h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx);
	const first = finalMessage("First complete answer.");
	h.handlers.get("message_end")!({ message: first }, h.ctx);
	h.handlers.get("turn_end")!({ message: first }, h.ctx);
	h.handlers.get("before_agent_start")!({ prompt: "Second iteration", systemPrompt: "base" }, h.ctx);
	const primary = h.handlers.get("message_end")!({ message: finalMessage("Second unresolved draft.") }, h.ctx);
	assert.equal(primary, undefined, "the second iteration starts ineligible and preserves its draft");
	assert.equal(h.sentMessages.length, 1, "fallback resolution starts for the second iteration");
	assert.equal(h.readState().response, "First complete answer.");
	h.handlers.get("turn_end")!({ message: finalMessage("Second unresolved draft.") }, h.ctx);
	assert.equal(h.readState().response, "Second unresolved draft.");
});

test("one atomic final patch resolves simultaneous global artifact and CWD Skill obligations", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-mixed-obligations-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const knowledgeRoot = join(root, "knowledge");
	const skill = join(root, "skills", "mixed", "SKILL.md");
	mkdirSync(knowledgeRoot, { recursive: true });
	mkdirSync(join(root, "skills", "mixed"), { recursive: true });
	const artifact = join(knowledgeRoot, "routing.md");
	writeFileSync(artifact, "Routing guidance.\n");
	writeFileSync(skill, "# Mixed\n\nCompile with global knowledge.\n");
	const repositoryRoot = join(root, "store");
	mkdirSync(repositoryRoot);
	const h = harness({ repositoryRoot, knowledgeRoot, remotePublication: "off" });
	await start(h, "Acquire both sources");
	for (const [toolCallId, path] of [["artifact", artifact], ["skill", skill]]) {
		h.handlers.get("tool_call")!({ toolCallId, toolName: "read", input: { path } }, h.ctx);
		h.handlers.get("tool_execution_end")!({ toolCallId, toolName: "read", result: {}, isError: false }, h.ctx);
	}
	const result = await h.tools.get("patch_state")!.execute("compile-both", {
		global: { artifacts: { [artifact]: { description: "Global routing guidance" } } },
		cwd: { artifacts: { [skill]: {
			description: "Mixed-obligation Skill",
			kind: "skill",
			compilation: { route: "combine global and CWD compilation" },
		} } },
		final: true,
	}, undefined, undefined, h.ctx);
	assert.deepEqual(result.details, { scopes: ["global", "cwd"], final: true, step: 1 });
	assert.equal(h.readState(0, "global").artifacts[artifact]!.description, "Global routing guidance");
	assert.equal(h.readState(0, "cwd").artifacts[skill]!.kind, "skill");
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Both compiled.") }, h.ctx), undefined);
});

test("stop removes State Flow semantics while retaining a bounded passive continuation", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Establish bounded state");
	await h.tools.get("patch_state")!.execute("state", { session: { working: { continuation: "keep this" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);

	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.activeTools.includes("read_state"), false);
	assert.equal(h.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: "base" }, h.ctx), undefined);

	const projected = h.handlers.get("context")!({ messages: [
		user("Ancient raw history that must stay hidden", 1),
		{ role: "assistant", content: [{ type: "text", text: "Ancient response" }], timestamp: 2 },
		user("Continue with X", Date.now() + 1_000),
	] });
	assert.equal(projected.messages.length, 2);
	assert.match(projected.messages[0].content[0].text, /State Flow exit handoff/);
	assert.match(projected.messages[0].content[0].text, /keep this/);
	assert.equal(projected.messages[1].content[0].text, "Continue with X");
	assert.doesNotMatch(JSON.stringify(projected.messages), /Ancient raw history/);
});

test("reload, startup, resume, and tree restoration preserve only the same physical session handoff", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Remember state");
	await h.tools.get("patch_state")!.execute("state", { session: { working: { continuation: "reload" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	for (const reason of ["reload", "startup", "resume", undefined]) {
		if (reason === undefined) h.handlers.get("session_tree")!({}, h.ctx);
		else h.handlers.get("session_start")!({ reason }, h.ctx);
		const projected = h.handlers.get("context")!({ messages: [
			user("Pre-stop history", 1),
			user("Continue", Date.now() + 1_000),
		] }, h.ctx);
		assert.match(projected.messages[0].content[0].text, /exit handoff/);
		assert.match(projected.messages[0].content[0].text, /reload/);
		assert.equal(projected.messages.length, 2);
	}

	for (const reason of ["new", "fork"]) {
		h.handlers.get("session_start")!({ reason }, h.ctx);
		assert.equal(h.handlers.get("context")!({ messages: [user("Continue", Date.now() + 1_000)] }, h.ctx), undefined);
	}
});

test("repeated stop retains one passive handoff without adding another marker", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Remember state");
	await h.tools.get("patch_state")!.execute("state", { session: { working: { continuation: "repeat" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const markerCount = h.entries.filter((entry) => entry.customType === "state-flow-passive-stop").length;
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	assert.equal(h.entries.filter((entry) => entry.customType === "state-flow-passive-stop").length, markerCount);
	const projected = h.handlers.get("context")!({ messages: [user("Continue", Date.now() + 1_000)] }, h.ctx);
	assert.match(projected.messages[0].content[0].text, /repeat/);
});

test("start uses the passive boundary for one active bootstrap instead of resurrecting raw history", async () => {
	const h = harness({ remotePublication: "off" });
	await start(h, "Remember state");
	await h.tools.get("patch_state")!.execute("state", { session: { working: { continuation: "restart" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const frozenResponse = h.readState().response;
	const oldMessages = Array.from({ length: 200 }, (_, index) => user(`OLD-${index}`, index + 1));
	const afterStop = Date.now() + 1_000;
	const postStopAnswer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Post-stop answer" }], timestamp: afterStop + 1 };
	const postStopMessages = [
		user("Post-stop question", afterStop),
		postStopAnswer,
		user("Restart State Flow", afterStop + 2),
	];
	assert.equal(h.handlers.get("message_end")!({ message: postStopAnswer }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message: postStopAnswer }, h.ctx);
	assert.equal(h.readState().response, frozenResponse);

	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	const protocol = h.handlers.get("before_agent_start")!({ prompt: "Restart State Flow", systemPrompt: "base" }, h.ctx);
	assert.match(protocol.systemPrompt, /State Flow is enabled/);
	const projected = h.handlers.get("context")!({ messages: [...oldMessages, ...postStopMessages] }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.match(projected.messages[0].content[0].text, /State Flow runtime context/);
	assert.match(projected.messages[1].content[0].text, /State Flow exit handoff/);
	assert.match(JSON.stringify(projected.messages), /Post-stop question/);
	assert.match(JSON.stringify(projected.messages), /Post-stop answer/);
	assert.doesNotMatch(JSON.stringify(projected.messages), /OLD-/);

	await h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx);
	const final = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Active again." }] };
	h.handlers.get("message_end")!({ message: final }, h.ctx);
	h.handlers.get("turn_end")!({ message: final }, h.ctx);
	const later = h.handlers.get("context")!({ messages: [user("Later", afterStop + 3)] }, h.ctx);
	assert.match(later.messages[0].content[0].text, /State Flow runtime context/);
	assert.doesNotMatch(JSON.stringify(later.messages), /exit handoff/);
});
