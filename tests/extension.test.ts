import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { withStorageTransaction } from "../lib/storage.ts";
import { StateFlowDiagnosticWriter } from "../lib/logging.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import test, { type TestContext } from "node:test";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { captureTemporalFileBases, cwdScopeKey, getDurableRepositoryRoot, sessionRuntimePaths, sessionStorageKey, temporalScopePaths } from "../lib/durable.ts";
import { hashArtifactSource } from "../lib/artifact.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { emptyState } from "../lib/state.ts";
import { writeCwdState, writeGlobalState } from "./storage-fixture.ts";
import { commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

test("lifecycle and write-fence diagnostics retain causes and filenames under long spaced storage paths", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-diagnostic-storage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = join(root, ...Array<string>(14).fill("nested store directory"));
	mkdirSync(repositoryRoot, { recursive: true });
	const h = harness({ repositoryRoot, initializeRepository: false, passiveTools: true });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const checkpoint = join(repositoryRoot, "checkpoint.json");
	mkdirSync(checkpoint);
	const notices = h.notifications.length;
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.equal(h.notifications.length, notices + 1, "Start reports one final failure, not a duplicate restoration warning");
	const failure = h.notifications.at(-1)!;
	assert.match(failure, /^State Flow Start failed:/);
	assert.match(failure, /not a regular file/);
	assert.match(failure, /checkpoint\.json/);
	assert.ok(failure.length <= 220 && !failure.includes("\n"));
	assert.equal(h.entries.length, 0);
	// Remove only the deliberately malformed fixture, never a production store.
	rmSync(checkpoint, { recursive: true });
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot);
	const before = files();
	mkdirSync(join(repositoryRoot, ".state-flow-publication.lock"));
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const stopped = h.notifications.at(-1)!;
	assert.match(stopped, /^State Flow disabled; memory writes paused:/);
	assert.match(stopped, /publication lock is unavailable/);
	assert.match(stopped, /EEXIST: file already exists/);
	assert.match(stopped, /\.state-flow-publication\.lock/);
	assert.ok(stopped.length <= 220 && !stopped.includes("\n"));
	await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { unsafe: true } } }, undefined, undefined, h.ctx), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /^\nMemory writes paused after Stop:/);
		assert.match(error.message, /EEXIST: file already exists/);
		assert.match(error.message, /\.state-flow-publication\.lock/);
		assert.match(error.message, /use \/state-flow-start$/);
		assert.ok(error.message.length <= 221);
		return true;
	});
	assert.deepEqual(files(), before);
	assert.equal(h.statuses.at(-1), undefined);
});

test("fresh explicit start is local-only; ordinary startup/status and old pointers never create storage", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-fresh-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const repositoryRoot = getDurableRepositoryRoot();
	const unrelatedRoot = join(agentDir, "unrelated");
	assert.equal(repositoryRoot, join(agentDir, "state-flow"));
	mkdirSync(unrelatedRoot);
	const source = join(unrelatedRoot, "unrelated.md");
	const bytes = Buffer.from([0xff, 0x61, 0x0a]);
	writeFileSync(source, bytes);
	const h = harness({ repositoryRoot, initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.equal(existsSync(repositoryRoot), false);
	// Fixture-only identity is configured by the caller, never by the initializer.
	const config = join(agentDir, "gitconfig");
	writeFileSync(config, '[user]\n name = State Flow Tests\n email = state-flow@example.invalid\n');
	const oldConfig = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = config;
	t.after(() => { if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig; });
	execFileSync("git", ["init", unrelatedRoot], { stdio: "ignore" });
	const git = (...args: string[]) => execFileSync("git", ["-C", unrelatedRoot, ...args], { encoding: "utf8" }).trim();
	writeFileSync(join(unrelatedRoot, "checkpoint.json"), "unrelated owned-name witness");
	git("add", ".");
	git("commit", "-m", "source fixture");
	const sourceHead = git("rev-parse", "HEAD");
	writeFileSync(join(unrelatedRoot, "staged.txt"), "staged witness");
	git("add", "staged.txt");
	const sourceIndex = readFileSync(join(unrelatedRoot, ".git", "index"));
	await start(h);
	assert.equal(git("rev-parse", "HEAD"), sourceHead);
	assert.deepEqual(readFileSync(join(unrelatedRoot, ".git", "index")), sourceIndex);
	assert.equal(readFileSync(join(unrelatedRoot, "checkpoint.json"), "utf8"), "unrelated owned-name witness");
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.notifications.some((message) => /push is pending/.test(message)), false);
	const context = h.handlers.get("context")!({ messages: [user("Inspect", 1)] }, h.ctx);
	const contextText = context.messages
		.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
		.map((block: any) => block.text)
		.find((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
	assert.ok(contextText);
	assert.equal(JSON.parse(contextText.slice(contextText.indexOf("\n") + 1)).artifact_invalidations, undefined);
	// Source identity and runtime bookkeeping never reach ordinary model context.
	assert.equal(contextText.includes(hashArtifactSource(bytes)), false);
	assert.deepEqual(readFileSync(source), bytes);
	writeFileSync(join(repositoryRoot, "store-only.md"), "not a Knowledge source");
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.doesNotMatch(h.notifications.at(-1)!, /store-only\.md/);
	assert.doesNotMatch(h.notifications.at(-1)!, /unrelated\.md/);
	const custom = harness({ repositoryRoot: join(agentDir, "custom-store"), initializeRepository: false });
	await start(custom);
	await custom.commands.get("state-flow-status").handler("", custom.ctx);
	assert.doesNotMatch(custom.notifications.at(-1)!, /unrelated\.md/);
	assert.equal(existsSync(join(custom.repositoryRoot, "checkpoint.json")), true);
	const checkpoint = structuredClone(h.entries.at(-1));
	const resumed = harness({ repositoryRoot, initializeRepository: false });
	resumed.entries.push(checkpoint);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	await resumed.commands.get("state-flow-status").handler("", resumed.ctx);
	assert.doesNotMatch(resumed.notifications.at(-1)!, /Publication: pending/);
	const missingRoot = join(agentDir, "new-store");
	const old = harness({ repositoryRoot: missingRoot, initializeRepository: false });
	old.entries.push(checkpoint);
	await old.handlers.get("session_start")!({ reason: "resume" }, old.ctx);
	await old.commands.get("state-flow-start").handler("", old.ctx);
	assert.equal(existsSync(missingRoot), false);
	assert.deepEqual(old.entries, [checkpoint]);
	assert.match(old.notifications.at(-1)!, /Current State Flow session storage is unavailable/);
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
	assert.deepEqual(JSON.parse(readFileSync(join(expectedCwd, "meta.json"), "utf8")).owner, { cwd });
	assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(expectedCwd, "checkpoint.json"), "utf8")), "owner"), false);
	const runtime = sessionRuntimePaths(cwd, sessionId, root, key);
	assert.equal(JSON.parse(readFileSync(runtime.runtime, "utf8")).identity.sessionId, sessionId);
	assert.equal(JSON.parse(readFileSync(runtime.runtime, "utf8")).identity.cwd, cwd);
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
	const patchState = h.tools.get("patch_state")!;
	assert.equal(patchState.executionMode, "sequential");
	assert.match(patchState.description, /one or more global, cwd, or session patches/);
	assert.match(patchState.promptGuidelines.join("\n"), /ordinary answers need no finalization call/);
	assert.doesNotMatch(patchState.promptGuidelines.join("\n"), /final:true|terminal-eligible/);
	assert.deepEqual([...h.commands.keys()], ["state-flow-start", "state-flow-status", "state-flow-stop"]);
});
test("passive bootstrap and tools are independently configurable and passive patches do not start an episode", async () => {
	for (const [passiveBootstrap, passiveTools] of [[false, false], [true, false], [false, true], [true, true]] as const) {
		const seed = harness({ passiveBootstrap: false, passiveTools: false });
		await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
		await start(seed);
		await seed.tools.get("patch_state")!.execute("seed", { cwd: {
			working: { shared: "durable" },
			intents: { release: { action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" } } },
			lazy: { releasePlan: { steps: ["validate"] } },
		} }, undefined, undefined, seed.ctx);
		await seed.commands.get("state-flow-stop")!.handler("", seed.ctx);
		const h = harness({ repositoryRoot: seed.repositoryRoot, cwd: seed.ctx.cwd, sessionId: `passive-${passiveBootstrap}-${passiveTools}`, initializeRepository: false, passiveBootstrap, passiveTools });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), passiveTools);
		const bootstrapResult = h.beforeAgentStart("ordinary");
		assert.equal(bootstrapResult.handlerResult, undefined);
		assert.equal(bootstrapResult.systemPrompt.includes("State Flow passive memory is available"), passiveBootstrap);
		const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
		assert.equal(projected !== undefined, passiveBootstrap);
		if (passiveBootstrap) {
			assert.match(JSON.stringify(projected), /durable/);
			assert.match(JSON.stringify(projected), /Validate release/);
			assert.doesNotMatch(JSON.stringify(projected), /\"steps\":\[\"validate\"\]/);
		}
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const beforeStop = files();
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		assert.deepEqual(files(), beforeStop, "pre-runtime Stop never publishes the passive view");
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(files(), beforeStop);
		assert.equal(h.activeTools.includes("patch_state"), passiveTools);
		if (passiveTools) {
			const read = await h.tools.get("read_state")!.execute("read", { path: "working.shared" });
			assert.match(read.content[0].text, /durable/);
			const intent = await h.tools.get("read_state")!.execute("intent", { path: "intents.release" });
			assert.match(intent.content[0].text, /cwd\.lazy\.releasePlan/);
			await h.tools.get("patch_state")!.execute("write", { session: { intents: { local: "Continue locally" } } }, undefined, undefined, h.ctx);
			assert.equal(h.resolveSnapshot().config.enabled, false);
			assert.equal(h.compactRequests.length, 0);
			assert.equal(h.resolveSnapshot().meta.step, 1);
			const local = await h.tools.get("read_state")!.execute("local-intent", { path: "session.intents.local" });
			assert.match(local.content[0].text, /Continue locally/);
		}
	}
});

for (const scope of ["global", "cwd"] as const) test(`first passive patch_state adopts another session's untouched ${scope} update`, async () => {
	const seed = harness();
	await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
	await start(seed);
	const h = harness({ repositoryRoot: seed.repositoryRoot, cwd: seed.ctx.cwd, sessionId: `passive-drift-${scope}`, initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await seed.tools.get("patch_state")!.execute("neighbor", {
		[scope]: { working: { neighbor: "shared update" } },
		session: { working: { private: "neighbor only" } },
	}, undefined, undefined, seed.ctx);
	const files = () => captureTemporalFileBases(seed.ctx.cwd, seed.ctx.sessionManager.getSessionId(), seed.repositoryRoot);
	const winner = files();
	await h.tools.get("patch_state")!.execute("first-passive", { session: { working: { mine: "private update" } } }, undefined, undefined, h.ctx);
	const read = await h.tools.get("read_state")!.execute("accepted", { paths: [`${scope}.working`, "session.working"] });
	assert.deepEqual(JSON.parse(read.content[0].text).value, [{ neighbor: "shared update" }, { mine: "private update" }]);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.compactRequests.length, 0);
	assert.deepEqual(files(), winner);
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	const restored = await h.tools.get("read_state")!.execute("restored", { paths: [`${scope}.working`, "session.working"] });
	assert.deepEqual(restored.content, read.content);
});

for (const activate of ["start", "passive-patch"] as const) {
	test(`pre-runtime Stop preserves global-only memory before ${activate} establishes session state`, async () => {
		const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true });
		writeGlobalState({ ...emptyState(), working: { shared: "global" } }, h.repositoryRoot);
		const id = h.ctx.sessionManager.getSessionId();
		const files = () => captureTemporalFileBases(h.ctx.cwd, id, h.repositoryRoot);
		const before = files();
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.readState(0, "global").working.shared, "global");
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		assert.deepEqual(files(), before);
		assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, id, "cwd", h.repositoryRoot).directory), false);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(files(), before);
		assert.equal(h.readState(0, "global").working.shared, "global");
		if (activate === "start") await h.commands.get("state-flow-start").handler("", h.ctx);
		await h.tools.get("patch_state")!.execute("local", { session: { working: { local: "retained" } } }, undefined, undefined, h.ctx);
		assert.equal(h.resolveSnapshot().config.enabled, activate === "start");
		assert.equal(h.resolveSnapshot().meta.step, 1);
		assert.ok("boundary" in h.entries.at(-1).data);
		const semanticPaths = (["global", "cwd", "session"] as const).flatMap((scope) => {
			const paths = temporalScopePaths(h.ctx.cwd, id, scope, h.repositoryRoot);
			return [paths.checkpoint, paths.patches, paths.meta];
		});
		const semanticBytes = semanticPaths.map((path) => readFileSync(path));
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.ok("boundary" in h.entries.at(-1).data, "an accepted session no longer uses the pre-runtime marker");
		assert.deepEqual(semanticPaths.map((path) => readFileSync(path)), semanticBytes);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.equal(h.readState(0, "session").working.local, "retained");
		assert.equal(h.resolveSnapshot().config.enabled, false);
		assert.equal(h.resolveSnapshot().meta.step, 1);
		assert.equal(h.compactRequests.length, 0);
		assert.equal(existsSync(join(h.repositoryRoot, ".git")), false);
	});
}

for (const invalid of ["cwd-without-global", "malformed-global", "incomplete-global"] as const) {
	test(`pre-runtime Stop leaves ${invalid} storage untouched`, async () => {
		const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true });
		if (invalid === "cwd-without-global") writeCwdState(h.ctx.cwd, { ...emptyState(), working: { project: "retained" } }, h.repositoryRoot);
		else {
			const checkpoint = writeGlobalState(emptyState(), h.repositoryRoot);
			if (invalid === "malformed-global") writeFileSync(checkpoint, "{broken\n");
			else rmSync(temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "global", h.repositoryRoot).patches);
		}
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const before = files();
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.match(h.notifications.at(-1)!, /passive memory is unavailable/);
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		assert.deepEqual(files(), before);
		await h.commands.get("state-flow-start").handler("", h.ctx);
		if (invalid === "cwd-without-global") {
			assert.equal(h.resolveSnapshot().config.enabled, true, "explicit Start may initialize a wholly absent global scope");
			assert.equal(h.readState(0, "cwd").working.project, "retained");
		} else {
			assert.match(h.notifications.at(-1)!, /Start failed/);
			assert.deepEqual(files(), before);
			assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		}
	});
}

test("restarting a long ordinary session without State Flow checkpoints bootstraps from native conversation", async () => {
	const seed = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
	await seed.tools.get("patch_state")!.execute("shared", { cwd: { working: { shared: "retained" } } }, undefined, undefined, seed.ctx);
	const h = harness({ repositoryRoot: seed.repositoryRoot, sessionId: "ordinary-restarted", initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	h.entries.push({ type: "message", message: user("Long conversation before the extension was enabled", 1) });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.readState(0, "cwd").working.shared, "retained");
	assert.deepEqual(h.readState(0, "session").working, {});
	assert.match((await h.beginRun("Compile this conversation")).systemPrompt, /State Flow is enabled/);
});

test("expired passive boundary adopts current shared state and retains the session step", async () => {
	const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true, sessionId: "ordinary-session" });
	h.entries.push({ type: "message", message: user("A long ordinary conversation", 1) });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	for (let index = 1; index <= 9; index++) {
		await h.tools.get("patch_state")!.execute(`passive-${index}`, { cwd: { working: { shared: index } } }, undefined, undefined, h.ctx);
	}
	const expired = structuredClone(h.entries.slice(0, 2));
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const resumed = harness({ repositoryRoot: h.repositoryRoot, initializeRepository: false, passiveBootstrap: true, passiveTools: true, sessionId: "ordinary-session" });
	resumed.entries.push(...expired);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.match(resumed.notifications.at(-1)!, /history is outside.*use current session memory/);
	assert.deepEqual(files(), before, "failed restoration must not publish a substitute checkpoint");
	await resumed.commands.get("state-flow-start")!.handler("", resumed.ctx);
	assert.equal(resumed.resolveSnapshot().config.enabled, true);
	assert.equal(resumed.resolveSnapshot().meta.step, 9);
	assert.equal(resumed.resolveSnapshot().meta.bootstrap, true);
	assert.deepEqual(resumed.readState(0, "session").working, {});
	assert.equal(resumed.readState(0, "session").response, "");
	assert.equal(resumed.readState(0, "cwd").working.shared, 9);
	assert.equal(resumed.notifications.at(-1), "State Flow enabled from current session memory; unavailable historical state was not restored.");
	const active = structuredClone(resumed.entries);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.resolveSnapshot().config.enabled, true);
	assert.equal(resumed.entries.length, active.length + 1, "normal restoration appends its own retained checkpoint");
	assert.deepEqual(resumed.readState(0, "session").working, {});
	assert.equal(resumed.readState(0, "cwd").working.shared, 9);
});

test("expired passive selection adopts nonempty private memory instead of resetting it", async () => {
	const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true, sessionId: "private-passive" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	for (let index = 1; index <= 9; index++) {
		await h.tools.get("patch_state")!.execute(`private-${index}`, { session: { working: { private: index } } }, undefined, undefined, h.ctx);
	}
	const expired = structuredClone(h.entries.slice(0, 1));
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const resumed = harness({ repositoryRoot: h.repositoryRoot, initializeRepository: false, passiveBootstrap: true, passiveTools: true, sessionId: "private-passive" });
	resumed.entries.push(...expired);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.deepEqual(files(), before);
	assert.throws(() => resumed.readState(0, "session"), /selected branch is unavailable/);
	await resumed.commands.get("state-flow-start")!.handler("", resumed.ctx);
	assert.equal(resumed.resolveSnapshot().config.enabled, true);
	assert.equal(resumed.resolveSnapshot().meta.step, 9);
	assert.equal(resumed.readState(0, "session").working.private, 9);
	assert.equal(resumed.notifications.at(-1), "State Flow enabled from current session memory; unavailable historical state was not restored.");
	await resumed.tools.get("patch_state")!.execute("after-start", { session: { working: { afterStart: true } } }, undefined, undefined, resumed.ctx);
	assert.deepEqual(resumed.readState(0, "session").working, { private: 9, afterStart: true });
	assert.equal(resumed.resolveSnapshot().meta.step, 10);
});

test("failed historical selection keeps publication fenced until explicit Start activates current memory", async () => {
	for (const [passiveBootstrap, passiveTools] of [[true, true], [false, true], [true, false], [false, false]] as const) {
		const h = harness({ initializeRepository: false, passiveBootstrap, passiveTools });
		await start(h);
		const expired = structuredClone(h.entries);
		const patch = h.tools.get("patch_state")!;
		for (let index = 1; index <= 9; index++) {
			await patch.execute(`seed-${index}`, {
				global: { working: { shared: "retained" } },
				session: { working: { private: index } },
			}, undefined, undefined, h.ctx);
		}
		const retained = structuredClone(h.entries);
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const before = files();
		h.ctx.sessionManager.getBranch = () => expired;
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.match(h.notifications.at(-1)!, /outside the retained temporal window/);
		assert.deepEqual(files(), before);
		if (passiveTools) {
			const shared = await h.tools.get("read_state")!.execute("shared", { path: "global.working.shared" });
			assert.deepEqual(JSON.parse(shared.content[0].text), { value: "retained" });
			await assert.rejects(h.tools.get("read_state")!.execute("private", { path: "session.working" }), /selected branch is unavailable/);
		}
		assert.throws(() => h.readState(0, "session"), /unavailable/);
		for (const scope of ["global", "cwd", "session"]) {
			await assert.rejects(patch.execute("refused", { [scope]: { working: { unsafe: true } } }, undefined, undefined, h.ctx), /selected branch is unavailable|tools are disabled/);
		}
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.equal(h.statuses.at(-1), undefined);
		assert.ok(h.entries.at(-1)!.data.persistenceError);
		await h.commands.get("state-flow-status").handler("", h.ctx);
		assert.match(h.notifications.at(-1)!, /Temporal materialization unavailable:.*outside the retained temporal window/);
		assert.deepEqual(files(), before, "refused model writes must preserve every canonical file");
		assert.deepEqual(h.entries.filter((entry) => entry.customType !== "state-flow-passive-stop"), retained, "a native failed-Stop policy never substitutes a semantic checkpoint");
		const noticesBeforeStart = h.notifications.length;
		await h.commands.get("state-flow-start").handler("", h.ctx);
		assert.equal(h.notifications.length, noticesBeforeStart + 1, "explicit activation reports only its final outcome");
		assert.match(h.notifications.at(-1)!, /enabled from current session memory/);
		assert.equal(h.resolveSnapshot().config.enabled, true);
		assert.equal(h.resolveSnapshot().meta.step, 9);
		assert.equal(h.readState(0, "session").working.private, 9);
		const semanticFiles = (cohort: ReturnType<typeof files>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));
		assert.deepEqual(semanticFiles(files()), semanticFiles(before), "activation never rewinds current private or shared semantics");
		h.ctx.sessionManager.getBranch = () => retained;
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.readState(0, "session").working.private, 9);
		await patch.execute("continued", { session: { working: { continued: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").working.continued, true);
	}
});

test("repeated Start during an active run is inert and cannot cancel accepted-response reconciliation", async () => {
	const h = harness({ initializeRepository: false });
	await start(h, "Current request");
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted in-flight answer" }] };
	h.handlers.get("message_end")!({ message }, h.ctx);
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.deepEqual(h.entries, entries);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Accepted in-flight answer");
});

test("removes proven-missing registered artifacts from every owning scope without directory discovery", async () => {
	const h = harness();
	await start(h);
	const paths = {
		global: join(h.repositoryRoot, "global-source.bin"),
		cwd: join(h.repositoryRoot, "cwd-source.txt"),
		session: join(h.repositoryRoot, "session-source.md"),
	} as const;
	for (const path of Object.values(paths)) writeFileSync(path, "registered source");
	await h.tools.get("patch_state")!.execute("register", {
		global: { artifacts: { [paths.global]: { description: "Global source" } } },
		cwd: { artifacts: { [paths.cwd]: { description: "CWD source" } } },
		session: { artifacts: { [paths.session]: { description: "Session source" } } },
	}, undefined, undefined, h.ctx);
	for (const path of Object.values(paths)) rmSync(path);
	await h.beginRun("Observe removals");
	for (const [scope, path] of Object.entries(paths) as ["global" | "cwd" | "session", string][]) {
		assert.equal(h.readState(0, scope).artifacts[path], undefined);
	}
});

test("automatic artifact cleanup updates revision status before a later scoped patch", async () => {
	const h = harness();
	await start(h);
	const source = join(h.repositoryRoot, "cwd-source.txt");
	writeFileSync(source, "registered source");
	await h.tools.get("patch_state")!.execute("register", {
		cwd: { artifacts: { [source]: { description: "CWD source" } } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C1/S0</dim>");
	rmSync(source);
	await h.beginRun("Observe removal");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C2/S0</dim>");
	await h.tools.get("patch_state")!.execute("session-only", {
		session: { working: { retained: true } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C2/S1</dim>");
});

test("State Flow tools follow branch enablement and history reads cannot run while disabled", async () => {
	const h = harness();
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
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
	await h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.activeTools.includes("read_state"), true);
	assert.equal(h.activeTools.includes("patch_state"), true);
	await assert.rejects(read.execute("aborted", {}, AbortSignal.abort()), /aborted/);
});

test("read_state lazily projects all hot historical paths and scopes without publication or Git calls", async () => {
	const h = harness();
	await start(h);
	const read = h.tools.get("read_state");
	await assert.rejects(read.execute("missing-path", {}, undefined), /requires path or paths/);
	await assert.rejects(read.execute("pre-origin", { path: "effective[1]" }, undefined), /predates the proven temporal origin/);
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
			for (const scope of ["effective", "global", "cwd", "session"]) {
				const path = `${scope}[${offset}]`;
				const result = await read.execute("history", { path }, undefined);
				const value = JSON.parse(result.content[0].text);
				const working = scope === "effective" ? { ...states.global, ...states.cwd, ...states.session } : states[scope];
				assert.deepEqual(value.value, { artifacts: {}, contract: {}, working, intents: {}, response: "" });
				assert.deepEqual(result.details, { path, projection: "value" });
			}
		}
		const currentPath = JSON.parse((await read.execute("path-current", { path: "effective" }, undefined)).content[0].text);
		assert.equal(currentPath.value.working.shared, "S8");
		assert.deepEqual(Object.keys(currentPath), ["value"]);
		const selectedValue = JSON.parse((await read.execute("path-value", { path: "effective.working.shared" }, undefined)).content[0].text);
		assert.deepEqual(selectedValue, { value: "S8" });
		const conciseValue = JSON.parse((await read.execute("concise-path", { path: "working.shared" }, undefined)).content[0].text);
		assert.deepEqual(conciseValue, selectedValue);
		const selectedKeys = JSON.parse((await read.execute("path-keys", { path: "effective.working", projection: "keys" }, undefined)).content[0].text);
		assert.deepEqual(selectedKeys, { meta: { type: "object", size: 1 }, keys: { shared: "string" } });
		const batch = JSON.parse((await read.execute("path-batch", { paths: ["global.working.shared", "cwd.working.shared"] }, undefined)).content[0].text);
		assert.deepEqual(batch, { value: ["G6", "C7"] });
		const selectedPatch = JSON.parse((await read.execute("projected-patch", { path: "global[2].working.shared", projection: "patch" }, undefined)).content[0].text);
		assert.deepEqual(selectedPatch, { patch: "G6" });
		const previousGlobalPatch = JSON.parse((await read.execute("path-patch", { path: "global.patches[1]" }, undefined)).content[0].text);
		assert.deepEqual(previousGlobalPatch, { patch: { working: { shared: "G1" } } });
		await assert.rejects(read.execute("double-path", { path: "working", paths: ["cwd.working"] }, undefined), /not both/);
		await assert.rejects(read.execute("projection-only", { projection: "keys" }, undefined), /requires path or paths/);
		for (const path of ["effective[-1]", "effective[8]", "effective[0.5]", "other.working"]) {
			await assert.rejects(read.execute("invalid", { path }, undefined));
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
	assert.equal(head(), before);
	assert.equal(h.entries.length, checkpointCount);
	assert.equal(h.resolveSnapshot().meta.step, 8);
});

test("read_state returns dangling-reference hints as top-level metadata beside a null sentinel value", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state").execute("seed-reference", {
		cwd: { working: { continuation: "Read `$cwd.lazy.missing` only when needed." } },
	}, undefined, undefined, h.ctx);
	const read = h.tools.get("read_state");
	const result = await read.execute("missing-reference", { path: "cwd.lazy.missing" }, undefined);
	assert.deepEqual(JSON.parse(result.content[0].text), {
		value: null,
		hint: [{
			type: "dangling-reference",
			message: "The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task.",
			paths: ["cwd.working.continuation"],
		}],
	});
	assert.deepEqual(result.details, { path: "cwd.lazy.missing", projection: "value" });
	await assert.rejects(
		read.execute("invented-reference", { path: "cwd.lazy.invented" }, undefined),
		(error: unknown) => error instanceof Error && !error.message.includes("hint"),
	);
});

test("lets ordinary tool-bearing responses run without comments or intermediate state commits", async () => {
	const h = harness();
	await start(h, "Investigate");
	const beforeEntries = h.entries.length;
	const response = h.handlers.get("message_end")!({ message: toolAssistant("read-1") }, h.ctx);
	assert.equal(response, undefined);
	await h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.resolveSnapshot().meta.step, 0);
});

test("ordinary direct and tool-followed answers complete without a finalization inference", async () => {
	for (const withTool of [false, true]) {
		const h = harness();
		await start(h, withTool ? "Use a tool then answer" : "Answer directly");
		if (withTool) {
			h.handlers.get("message_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
			await h.handlers.get("turn_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
		}
		const message = finalMessage(withTool ? "Tool-informed answer." : "Direct answer.");
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, withTool ? "Tool-informed answer." : "Direct answer.");
		assert.equal(h.sentMessages.length, 0, "completion must not schedule a repair inference");
	}
});

test("multiple patch barriers can precede one ordinary answer", async () => {
	const h = harness();
	await start(h, "Patch twice then answer");
	await h.tools.get("patch_state")!.execute("first", { session: { working: { first: true } } }, undefined, undefined, h.ctx);
	await h.tools.get("patch_state")!.execute("second", { session: { working: { second: true } } }, undefined, undefined, h.ctx);
	const message = finalMessage("Both changes are retained.");
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.deepEqual(h.readState().working, { first: true, second: true });
	assert.equal(h.readState().response, "Both changes are retained.");
	assert.equal(h.sentMessages.length, 0);
});

test("global memory is always available while State Flow is enabled", async () => {
	const h = harness();
	const started = await start(h, "Durable preference");
	assert.match(started.systemPrompt, /State Flow is enabled\. It owns durable memory\./);
	assert.match(started.systemPrompt, /global=established cross-project\/user\/environment knowledge/);
	const accepted = await h.tools.get("patch_state")!.execute(
		"global-memory", { global: { working: { preference: "compact" } } }, undefined, undefined, h.ctx,
	);
	assert.equal(accepted.content[0].text, "\nState materialized atomically at global scope.");
	assert.deepEqual(JSON.parse(accepted.content[1].text).state_updates.effective, [{ path: ["working", "preference"], value: "compact" }]);
	assert.equal(h.readState(0, "global").working.preference, "compact");
});

test("patch_state commits global, CWD, and session as one model-facing atomic barrier", async () => {
	const h = harness();
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
	await h.handlers.get("turn_end")!({ message: finalMessage("Still pending.") }, h.ctx);
	assert.equal(h.readState().response, "Still pending.");
});

test("patch_state materializes session state before the next inference and response reconciliation", async (t) => {
	const h = harness();
	await start(h, "Long-running task");
	const patchState = h.tools.get("patch_state")!;
	const result = await patchState.execute(
		"patch-1",
		{ session: { working: { verified: "intermediate" } } },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(result.content[0].text, "\nState materialized atomically at session scope.");
	assert.deepEqual(JSON.parse(result.content[1].text).state_updates.effective, [{ path: ["working", "verified"], value: "intermediate" }]);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "");
	const visibleArgs = {
		global: { working: { shared: true } },
		cwd: { working: { project: true } },
		session: {
			artifacts: { source: { description: "compiled" } },
			contract: { mode: "strict" },
			working: { verified: "intermediate" },
			response: null,
		},
	};
	const rendered = patchState.renderResult(
		result,
		{ expanded: false, isPartial: false },
		{ fg: (_color: string, text: string) => text } as any,
		{ args: visibleArgs, isError: false } as any,
	);
	const visibleText = rendered.render(1_000).map((line: string) => line.trimEnd()).join("\n");
	assert.ok(visibleText.startsWith("\n"), "successful patch JSON should follow the tool heading after one blank line");
	assert.doesNotMatch(visibleText, /State materialized|session scope/);
	assert.match(visibleText, /"global": \{[\s\S]+\n\n  "cwd": \{[\s\S]+\n\n  "session": \{/);
	assert.match(visibleText, /"artifacts": \{[\s\S]+\n\n    "contract": \{[\s\S]+\n\n    "working": \{[\s\S]+\n\n    "response": null/);
	assert.deepEqual(JSON.parse(visibleText), visibleArgs);
	const renderedError = patchState.renderResult(
		{ content: [{ type: "text", text: "WebSocket error" }] },
		{ expanded: false, isPartial: false },
		{ fg: (_color: string, text: string) => text } as any,
		{ args: visibleArgs, isError: true } as any,
	);
	const renderedErrorText = renderedError.render(1_000).map((line: string) => line.trimEnd()).join("\n");
	assert.equal(renderedErrorText, "\nWebSocket error");

	const hiddenAgentDir = mkdtempSync(join(tmpdir(), "state-flow-hidden-patches-"));
	t.after(() => rmSync(hiddenAgentDir, { recursive: true, force: true }));
	mkdirSync(join(hiddenAgentDir, "state-flow"));
	writeFileSync(join(hiddenAgentDir, "state-flow", "config.json"), JSON.stringify({ showSuccessfulPatches: false }));
	const hidden = harness({ agentDir: hiddenAgentDir, repositoryRoot: join(hiddenAgentDir, "state-flow") });
	await start(hidden, "Hide successful patch details");
	const hiddenPatch = hidden.tools.get("patch_state")!;
	const hiddenResult = await hiddenPatch.execute(
		"hidden-patch",
		{ session: { working: { secretFromToolRow: "hidden" } } },
		undefined,
		undefined,
		hidden.ctx,
	);
	const hiddenRendered = hiddenPatch.renderResult(
		hiddenResult,
		{ expanded: false, isPartial: false },
		{ fg: (_color: string, text: string) => text } as any,
		{ args: { session: { working: { secretFromToolRow: "hidden" } } }, isError: false } as any,
	);
	const hiddenText = hiddenRendered.render(120).join("\n");
	assert.match(hiddenText, /State materialized atomically at session scope\./);
	assert.doesNotMatch(hiddenText, /secretFromToolRow|"hidden"/);

	const acceptedResult = { role: "toolResult", toolCallId: "patch-1", toolName: "patch_state", content: result.content, timestamp: 2 };
	const projected = h.handlers.get("context")!({ messages: [user("Long-running task", 1), acceptedResult] }, h.ctx);
	assert.equal(projected.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context")).length, 1);
	assert.doesNotMatch(projected.messages[0].content[0].text, /"verified":"intermediate"/, "the head stays at iteration start");
	assert.equal(projected.messages.at(-1), acceptedResult, "accepted values reach the next inference in the native tail");

	const terminal = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete." }] };
	assert.equal(h.handlers.get("message_end")!({ message: terminal }, h.ctx), undefined);
	await h.handlers.get("turn_end")!({ message: terminal }, h.ctx);
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

test("tool preflight walks only the selected native suffix for matching calls, without rebuilding a branch", async (t) => {
	const h = harness();
	await start(h);
	const gate = h.handlers.get("tool_call")!;
	const observations: Array<{ pastRuns: number; branchEntries: number; visited: string[]; expected: string[] }> = [];
	for (const pastRuns of [0, 200]) {
		const manager = SessionManager.inMemory(h.ctx.cwd);
		for (let run = 0; run < pastRuns; run++) {
			manager.appendMessage(user(`Old request ${run}`, run * 2));
			manager.appendMessage(fauxAssistantMessage(`Old answer ${run}`));
		}
		const assistant = manager.appendMessage(fauxAssistantMessage([
			fauxToolCall("read", { path: "not-executed.txt" }, { id: "read-1" }),
			fauxToolCall("patch_state", {}, { id: "patch-1" }),
		], { stopReason: "toolUse" }));
		const custom = manager.appendCustomEntry("foreign-context", { retained: true });
		const result = manager.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Blocked sibling" }], isError: true, timestamp: Date.now() });
		const selected = manager.appendCustomEntry("foreign-after-result", { retained: true });
		const abandoned = manager.appendMessage(fauxAssistantMessage([
			fauxToolCall("patch_state", {}, { id: "patch-1" }),
			fauxToolCall("patch_state", {}, { id: "patch-2" }),
		], { stopReason: "toolUse" }));
		manager.branch(selected);
		const before = structuredClone(manager.getEntries());
		const branch = manager.getBranch.bind(manager);
		const leaf = manager.getLeafEntry.bind(manager);
		const entry = manager.getEntry.bind(manager);
		let branchEntries = 0;
		let visited: string[] = [];
		t.mock.method(manager, "getBranch", (...args: Parameters<typeof branch>) => {
			const path = branch(...args);
			branchEntries += path.length;
			return path;
		});
		t.mock.method(manager, "getLeafEntry", () => {
			const value = leaf();
			if (value) visited.push(value.id);
			return value;
		});
		t.mock.method(manager, "getEntry", (id: string) => {
			visited.push(id);
			return entry(id);
		});
		const ctx = { ...h.ctx, sessionManager: manager };
		for (const [toolCallId, toolName] of [["read-1", "read"], ["patch-1", "patch_state"]]) {
			branchEntries = 0;
			visited = [];
			const rejection = gate({ toolCallId, toolName, input: {} }, ctx);
			if (toolName === "read") assert.match(rejection.reason, /barrier/);
			else assert.equal(rejection, undefined);
			observations.push({ pastRuns, branchEntries, visited, expected: [selected, result, custom, assistant] });
		}
		manager.branch(abandoned);
		branchEntries = 0;
		visited = [];
		assert.match(gate({ toolCallId: "patch-1", toolName: "patch_state", input: {} }, ctx).reason, /exactly one/);
		observations.push({ pastRuns, branchEntries, visited, expected: [abandoned] });
		visited = [];
		assert.equal(gate({ toolCallId: "missing", toolName: "read", input: {} }, ctx), undefined);
		assert.equal(manager.getLeafId(), abandoned);
		assert.deepEqual(manager.getEntries(), before, "preflight must preserve the complete native tree, including the unselected branch");
	}
	assert.deepEqual(observations.map(({ pastRuns, branchEntries }) => ({ pastRuns, branchEntries })),
		[0, 0, 0, 200, 200, 200].map((pastRuns) => ({ pastRuns, branchEntries: 0 })), "preflight must not rebuild completed native history");
	for (const { visited, expected } of observations) assert.deepEqual(visited, expected, "stop at the nearest matching assistant without a stale branch/batch cache");
});

test("patch_state tolerates shared-scope drift while preserving the session layer", async () => {
	const a = harness();
	await start(a, "Session A");
	await a.tools.get("patch_state")!.execute("a-initial", { session: { working: { owner: "A" } } }, undefined, undefined, a.ctx);
	const b = harness({
		repositoryRoot: a.repositoryRoot,
		cwd: a.ctx.cwd,
		sessionId: "harness-session-b",
		initializeRepository: false,
	});
	await start(b, "Session B");
	await b.tools.get("patch_state")!.execute("b-global", { global: { working: { globalFromB: true } } }, undefined, undefined, b.ctx);
	const beforeStep = a.resolveSnapshot().meta.step;
	const result = await a.tools.get("patch_state")!.execute("a-session", { session: { working: { continued: true } } }, undefined, undefined, a.ctx);
	assert.deepEqual(JSON.parse(result.content[1].text).state_updates.effective, [
		{ path: ["working", "globalFromB"], value: true },
		{ path: ["working", "continued"], value: true },
	]);
	assert.equal(a.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(a.readState(0, "session").working.owner, "A");
	assert.equal(a.readState(0, "session").working.continued, true);
	assert.equal(a.readState(0, "global").working.globalFromB, true);
	assert.equal(JSON.stringify(a.sentMessages).includes("cannot publish"), false);
	await b.tools.get("patch_state")!.execute("b-drift", { global: { working: { globalFromB: "newer" } } }, undefined, undefined, b.ctx);
	const repeated = await a.tools.get("patch_state")!.execute("a-repeat", { session: { working: { continued: true } } }, undefined, undefined, a.ctx);
	assert.equal(repeated.details.changed, false, "adopting foreign memory is not a new authored change");
	assert.deepEqual(JSON.parse(repeated.content[1].text).state_updates.effective, [
		{ path: ["working", "globalFromB"], value: "newer" },
		{ path: ["working", "continued"], value: true },
	]);
});


function finalMessage(text: string) {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}

test("length and provider-error endings never become accepted responses", async () => {
	for (const stopReason of ["length", "error"]) {
		const h = harness();
		await start(h, `Stop reason ${stopReason}`);
		const message = { ...finalMessage("Incomplete output."), stopReason };
		assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, "");
		assert.equal(h.sentMessages.length, 0);
	}
});

async function holdResponseStorage(t: TestContext, root: string) {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(root, async () => { enter(); await gate; });
	t.after(async () => { release(); await holder; });
	await entered;
	return async () => { release(); await holder; };
}

test("inference preparation captures without writing, then accepts current maintenance and lifecycle once", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { private: "LOCAL" }, "Previous answer");
	const reappeared = join(h.repositoryRoot, "reappeared.txt");
	const missing = join(h.repositoryRoot, "new-shared-missing.txt");
	writeFileSync(reappeared, "source");
	await h.tools.get("patch_state")!.execute("register", { cwd: { artifacts: { [reappeared]: { description: "Keep if it returns" } } } }, undefined, undefined, h.ctx);
	rmSync(reappeared);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const previous = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	assert.match(h.beforeAgentStart("NEXT-SPEC").systemPrompt, /State Flow is enabled/);
	assert.deepEqual(h.entries, entries, "the signal-less native hook only captures the prompt and protocol");
	h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before, "idle projection cannot publish");
	let ended = false;
	const controller = new AbortController();
	const waiting = h.inferenceContext([user("NEXT-SPEC", 5)], controller).then((result) => { ended = true; return result; });
	const sameRun = h.inferenceContext([], controller);
	await delay(40);
	assert.equal(ended, false);
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.equal(ended, false, "already-active Start leaves the pending preparation intact");
	assert.deepEqual(h.readState(), cached);
	assert.deepEqual(h.entries, entries);
	// Complete a foreign cohort while holding exclusion. Neither its new registry nor source reappearance was in the old cache.
	writeGlobalState({ ...emptyState(), working: { globalPeer: "G" }, artifacts: { [missing]: { description: "Missing global source" } } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), working: { cwdPeer: "C" }, artifacts: {
		[missing]: { description: "Missing CWD source" }, [reappeared]: { description: "Newest retained registration" },
	} }, h.repositoryRoot);
	writeFileSync(reappeared, "returned while waiting");
	await release();
	const result = await waiting;
	await sameRun;
	assert.match(JSON.stringify(result), /NEXT-SPEC/);
	const preparedHead = JSON.parse(result.messages[0].content[0].text.split("\n")[1]);
	assert.equal(preparedHead.specification, "NEXT-SPEC", "idle inspection cannot freeze a head before preparation accepts");
	assert.deepEqual(preparedHead.state.working, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.deepEqual(h.readState().working, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.equal(h.readState().response, "Previous answer");
	for (const scope of ["global", "cwd"] as const) assert.equal(h.readState(0, scope).artifacts[missing], undefined);
	assert.equal(h.readState(0, "cwd").artifacts[reappeared]?.description, "Newest retained registration");
	assert.equal(h.resolveSnapshot().meta.specification, "NEXT-SPEC");
	assert.equal(h.resolveSnapshot().meta.step, previous.meta.step + 1, "maintenance, not preparation, advances the step");
	assert.equal(h.entries.length, entries.length + 1, "one acceptance replaces the former lifecycle plus maintenance writes");
	const accepted = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await h.inferenceContext();
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), accepted);
	assert.equal(h.entries.length, entries.length + 1);
});

for (const boundary of ["abort", "stop", "session_start", "session_tree", "session_shutdown"] as const) test(`inference preparation withdraws at ${boundary} without changing accepted memory or newer policy`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h);
	await commitTerminal(h, {}, { retained: true }, "Previous answer");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("Unaccepted request");
	const controller = new AbortController();
	const pending = h.inferenceContext([user("Unaccepted request", 2)], controller);
	let selection: Promise<unknown> | undefined;
	await delay(40);
	if (boundary === "abort") controller.abort();
	else if (boundary === "stop") {
		const cancellation = new AbortController();
		const stopping = h.commands.get("state-flow-stop")!.handler("", { ...h.ctx, signal: cancellation.signal });
		cancellation.abort();
		await stopping;
	}
	else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "another-session";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await Promise.race([pending, delay(1_000).then(() => assert.fail("obsolete preparation still waits"))]);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses);
	if (boundary === "stop") {
		assert.equal(h.statuses.at(-1), undefined);
		assert.ok(h.entries.at(-1)!.data.persistenceError);
		await assert.rejects(h.tools.get("patch_state")!.execute("late", { session: { working: { late: true } } }, undefined, undefined, h.ctx), /Memory writes paused after Stop/);
	}
});

for (const anchored of [true, false]) test(`idle Stop retains an aborted unaccepted run (${anchored ? "native anchor" : "conservative context"})`, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, {}, "Previous answer");
	const previous = user("COMPLETED-REQUEST", Date.now() - 100);
	const current = user("UNPREPARED-REQUEST", Date.now() - 10);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("UNPREPARED-REQUEST");
	if (anchored) h.handlers.get("message_end")!({ message: current }, h.ctx);
	const controller = new AbortController();
	const pending = h.inferenceContext([previous, current], controller);
	controller.abort();
	await pending;
	await release();
	assert.equal(h.resolveSnapshot().meta.specification, undefined, "the canceled run was never accepted");
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const projected = await h.inferenceContext([previous, current]);
	assert.match(JSON.stringify(projected), /UNPREPARED-REQUEST/);
	assert.equal(JSON.stringify(projected).includes("COMPLETED-REQUEST"), !anchored);
});

test("superseded preparation cannot consume a newer run waiting on the same owner", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("Obsolete request");
	const old = h.inferenceContext();
	h.beforeAgentStart("Current request");
	let ended = false;
	const current = h.inferenceContext().then((result) => { ended = true; return result; });
	assert.equal(await old, undefined, "an old context request cannot project or prepare a newer run");
	assert.equal(ended, false);
	await release();
	assert.match(JSON.stringify(await current), /Current request/);
	assert.equal(h.resolveSnapshot().meta.specification, "Current request");
	assert.equal(h.notifications.some((notice) => /preparation failed/.test(notice)), false);
});

test("failed preparation rolls back maintenance and lifecycle together, aborts inference and retains a retryable input", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Previous unfinished request");
	const snapshot = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	const missing = join(h.repositoryRoot, "foreign-missing.txt");
	writeGlobalState({ ...emptyState(), working: { foreign: true }, artifacts: { [missing]: { description: "Missing source" } } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (to === path) throw new Error("injected preparation publication failure");
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	const controller = new AbortController();
	h.beforeAgentStart("Keep this input pending");
	try { assert.equal(await h.inferenceContext([], controller), undefined); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(controller.signal.aborted, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached);
	assert.deepEqual(h.resolveSnapshot(), snapshot);
	assert.deepEqual(h.entries, entries);
	assert.match(h.notifications.at(-1)!, /inference preparation failed:.*injected preparation publication failure/);
	assert.equal(h.sentMessages.length, 0);
	await h.inferenceContext();
	assert.equal(h.resolveSnapshot().meta.specification, "Keep this input pending");
	assert.equal(h.readState().working.foreign, true);
	assert.equal(h.readState().artifacts[missing], undefined);
	assert.equal(h.entries.length, entries.length + 1);
});

test("post-acceptance preparation failure never replays an old specification over a completed run", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	h.beforeAgentStart("Accepted before UI failed");
	const notify = t.mock.method(h.ctx.ui, "setStatus", () => { throw new Error("injected preparation UI failure"); });
	const controller = new AbortController();
	await h.inferenceContext([], controller);
	notify.mock.restore();
	assert.equal(controller.signal.aborted, true);
	assert.equal(h.resolveSnapshot().meta.specification, "Accepted before UI failed");
	assert.match(h.notifications.at(-1)!, /preparation saved; lifecycle update failed:.*injected preparation UI failure/);
	await commitTerminal(h, {}, {}, "Accepted later answer");
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	assert.doesNotMatch(JSON.stringify(await h.inferenceContext()), /Accepted before UI failed/);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.deepEqual(h.entries, entries);
});

test("response reconciliation waits for current shared memory and accepts lifecycle once without another publication", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Finish this run");
	await h.tools.get("patch_state")!.execute("private", { session: { working: { owner: "local" } } }, undefined, undefined, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const message = finalMessage("Accepted answer");
	h.handlers.get("message_end")!({ message }, h.ctx);
	let ended = false;
	const pending = h.handlers.get("turn_end")!({ message }, h.ctx).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
	assert.equal(h.readState().response, "");
	assert.equal(h.entries.at(-1)!.data.specification, "Finish this run");
	// Fixture writes model the foreign owner's completed cohort before releasing exclusion.
	writeGlobalState({ ...emptyState(), working: { foreignGlobal: true } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), working: { foreignCwd: true } }, h.repositoryRoot);
	await release();
	await pending;
	assert.equal(h.readState().response, "Accepted answer");
	assert.deepEqual(h.readState().working, { foreignGlobal: true, foreignCwd: true, owner: "local" });
	assert.deepEqual(h.readState(0, "session").working, { owner: "local" });
	assert.equal(h.readState(1).response, "", "history uses the actual adopted predecessor");
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.resolveSnapshot().meta.bootstrap, undefined);
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(h.entries.length, entries.length + 1);
	assert.equal(h.notifications.some((notice) => /reconciliation failed|lock is unavailable/.test(notice)), false);
	const accepted = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), accepted);
	assert.equal(h.entries.length, entries.length + 1, "a consumed completion does not persist again");
});

test("failed response publication retains the accepted cache, unfinished run and canonical bytes", async (t) => {
	const h = harness({ initializeRepository: false });
	h.entries.push({ type: "message", message: user("Uncompiled conversation", 1) });
	await start(h, "Keep this unfinished until acceptance");
	const snapshot = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	writeGlobalState({ ...emptyState(), working: { foreign: true } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === path) { failed = true; throw new Error("injected response publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	const message = finalMessage("Accept only with lifecycle");
	try {
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached, "failed publication cannot install even a valid shared adoption");
	assert.deepEqual(h.resolveSnapshot(), snapshot);
	assert.deepEqual(h.entries, entries);
	assert.match(h.notifications.at(-1)!, /response reconciliation failed:.*injected response publication failure/);
	assert.equal(h.sentMessages.length, 0);
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Accept only with lifecycle");
	assert.equal(h.readState().working.foreign, true);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.entries.length, entries.length + 1);
});

for (const boundary of ["stop", "session_start", "session_tree", "session_shutdown"] as const) test(`pending response withdraws at ${boundary} without publishing or restoring obsolete lifecycle`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h, "Abandoned completion");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let selection: Promise<unknown> | undefined;
	const message = finalMessage("Must not overwrite a new selection");
	h.handlers.get("message_end")!({ message }, h.ctx);
	let ended = false;
	const pending = h.handlers.get("turn_end")!({ message }, h.ctx).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	if (boundary === "stop") {
		const cancellation = new AbortController();
		const stopping = h.commands.get("state-flow-stop")!.handler("", { ...h.ctx, signal: cancellation.signal });
		assert.equal(h.statuses.at(-1), undefined, "Stop policy takes effect before canonical waiting");
		cancellation.abort();
		await stopping;
		assert.ok(h.entries.at(-1)!.data.persistenceError, "canceled Stop persistence fences writes without re-enabling mode");
	} else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "different-physical-session";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await Promise.race([pending, delay(1_000).then(() => assert.fail("obsolete response still waits for the owner"))]);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	if (boundary === "session_shutdown") {
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
	}
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses, "obsolete completion cannot update the selected UI");
	if (boundary === "stop") {
		assert.equal(h.readState().response, "");
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { stale: true } } }, undefined, undefined, h.ctx), /Memory writes paused after Stop/);
	}
});

test("superseded response cannot clear a newer completion that is waiting on the same owner", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Current run");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const previous = finalMessage("Obsolete answer");
	h.handlers.get("message_end")!({ message: previous }, h.ctx);
	const obsolete = h.handlers.get("turn_end")!({ message: previous }, h.ctx);
	const current = finalMessage("Newest accepted answer");
	h.handlers.get("message_end")!({ message: current }, h.ctx);
	const pending = h.handlers.get("turn_end")!({ message: current }, h.ctx);
	await Promise.race([obsolete, delay(1_000).then(() => assert.fail("superseded response did not cancel"))]);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	await release();
	await pending;
	assert.equal(h.readState().response, "Newest accepted answer");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.notifications.some((notice) => /reconciliation failed/.test(notice)), false);
});

test("an empty accepted answer finalizes the run and stores an empty response", async () => {
	const h = harness();
	await start(h, "First run");
	const first = finalMessage("Previous answer");
	h.handlers.get("message_end")!({ message: first }, h.ctx);
	await h.handlers.get("turn_end")!({ message: first }, h.ctx);
	await h.beginRun("Update state without prose");
	await h.tools.get("patch_state")!.execute("update", {
		session: { working: { updated: true } },
	}, undefined, undefined, h.ctx);
	const empty = { ...finalMessage(""), content: [] };
	h.handlers.get("message_end")!({ message: empty }, h.ctx);
	await h.handlers.get("turn_end")!({ message: empty }, h.ctx);
	assert.equal(h.readState().working.updated, true);
	assert.equal(h.readState().response, "");
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.notifications.some((notice) => /could not reconcile the final response/i.test(notice)), false);
});

test("accepts canonical atomic scope patches and correct repeats without another checkpoint", async () => {
	const h = harness();
	await start(h, "Resolve me");
	const execute = (input: unknown) => h.tools.get("patch_state")!.execute("invalid", input, undefined, undefined, h.ctx);
	for (const input of [null, [], {}, { final: false }, { unchanged: true },
		{ scope: "session", patch: { working: { value: true } } }, { session: {} },
		{ session: { working: { value: true } }, extra: "forbidden" }, { global: null }]) await assert.rejects(execute(input));
	await execute({ session: { working: { value: true } } });
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const checkpointCount = h.entries.length;
	const result = await execute({ session: { working: { value: true, alreadyAbsent: null } } });
	assert.equal(result.details.changed, false);
	assert.equal(result.content[0].text, "\nState already current.");
	assert.deepEqual(JSON.parse(result.content[1].text).state_updates.effective, [
		{ path: ["working", "value"], value: true }, { path: ["working", "alreadyAbsent"], deleted: true },
	]);
	assert.equal(h.entries.length, checkpointCount);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	const message = finalMessage("Resolved directly.");
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Resolved directly.");
});

test("artifact freshness is rechecked after waiting, before accepting any part of a mixed patch", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Compile source");
	const source = join(h.repositoryRoot, "registered.txt");
	writeFileSync(source, "Before");
	const execute = (patch: unknown) => h.tools.get("patch_state")!.execute("compile", patch, undefined, undefined, h.ctx);
	await execute({ cwd: { artifacts: { [source]: { description: "Registered" } } } });
	h.handlers.get("context")!({ messages: [] }, h.ctx);
	h.handlers.get("tool_execution_start")!({ toolCallId: "read-source", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "read-source", toolName: "read", isError: false }, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const holder = withStorageTransaction(h.repositoryRoot, async () => { enter(); await gate; });
	await entered;
	let loggedInput: unknown;
	const record = StateFlowDiagnosticWriter.prototype.record;
	t.mock.method(StateFlowDiagnosticWriter.prototype, "record", function (this: StateFlowDiagnosticWriter, ...args: Parameters<typeof record>) {
		loggedInput = args[4]?.input;
		return record.apply(this, args);
	});
	const input = { global: { working: { rejected: true } }, cwd: { artifacts: { [source]: { description: "Stale compilation" } } } };
	const authored = structuredClone(input);
	const pending = execute(input);
	const rejected = assert.rejects(pending, /Artifact source changed after acquisition/);
	await delay(40);
	input.cwd.artifacts[source]!.description = "Caller mutation while waiting";
	writeFileSync(source, "Changed while the patch waited");
	release();
	await Promise.all([holder, rejected]);
	assert.deepEqual(loggedInput, authored, "diagnostics retain the same detached intent used for publication");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.equal(h.readState(0, "global").working.rejected, undefined);
	assert.deepEqual(h.readState(0, "cwd").artifacts[source], { description: "Registered" });
});

test("a rejected first passive patch leaves no empty canonical initialization or native checkpoint", async () => {
	const h = harness({ passiveTools: true, initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const entries = structuredClone(h.entries);
	const execute = (patch: unknown) => h.tools.get("patch_state")!.execute("first", patch, undefined, undefined, h.ctx);
	await assert.rejects(execute({ global: { working: { rejected: true } }, session: { artifacts: { invalid: {} } } }), /non-empty description/);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries);
	assert.throws(() => h.readState(0, "global"), /runtime is unavailable/, "a failed patch cannot install an unpublished empty view");
	await execute({ global: { working: { accepted: true } }, session: { working: { private: true } } });
	assert.equal(h.readState(0, "global").working.accepted, true);
	assert.equal(h.readState(0, "session").working.private, true);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.entries.length, entries.length + 1, "one accepted patch has one checkpoint, not a separately accepted empty origin");
});

test("Stop disables immediately, coalesces repeats and adopts current shared memory in one metadata-only acceptance", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Unfinished Stop request");
	await h.tools.get("patch_state")!.execute("private", { session: { working: { private: "LOCAL" } } }, undefined, undefined, h.ctx);
	const previous = h.resolveSnapshot();
	const entries = structuredClone(h.entries);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const lifecycle = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "withLifecycleTransaction");
	let ended = false;
	const stopping = h.commands.get("state-flow-stop")!.handler("", h.ctx).then(() => { ended = true; });
	const repeat = h.commands.get("state-flow-stop")!.handler("", h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("patch_state"), false);
	const raw = [user("Unfinished Stop request", 1), toolAssistant("late-tool")];
	const projected = h.handlers.get("context")!({ messages: raw }, h.ctx);
	assert.match(JSON.stringify(projected), /exit handoff/);
	assert.match(JSON.stringify(projected), /Unfinished Stop request/);
	assert.match(JSON.stringify(projected), /late-tool/);
	await delay(40);
	assert.equal(ended, false, "the event loop remains responsive while Stop awaits exclusion");
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries, "no checkpoint claims unaccepted persistence");
	writeGlobalState({ ...emptyState(), working: { globalPeer: "G" } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), working: { cwdPeer: "C" } }, h.repositoryRoot);
	const foreign = files();
	await release();
	await Promise.all([stopping, repeat]);
	assert.equal(publication.mock.calls.length, 1);
	assert.deepEqual(files().filter(({ path }) => path !== lifecycle.config && path !== lifecycle.runtime),
		foreign.filter(({ path }) => path !== lifecycle.config && path !== lifecycle.runtime));
	assert.deepEqual(h.readState().working, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.deepEqual(h.readState(0, "session").working, { private: "LOCAL" });
	assert.equal(h.resolveSnapshot().meta.step, previous.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, previous.meta.specification);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.entries.length, entries.length + 2, "one passive marker and one accepted boundary");
	assert.match(JSON.stringify(h.handlers.get("context")!({ messages: raw }, h.ctx)), /globalPeer/);
	assert.equal(h.notifications.some((notice) => /paused|Stop.*failed/.test(notice)), false);
});

test("Stop derives lifecycle after waiting instead of overwriting a newer same-instance passive patch", async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h, "Retain latest lifecycle");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const original = TemporalRuntime.prototype.withLifecycleTransaction;
	t.mock.method(TemporalRuntime.prototype, "withLifecycleTransaction", function (this: TemporalRuntime, ...args: Parameters<typeof original>) {
		return gate.then(() => original.apply(this, args));
	});
	const stopping = h.commands.get("state-flow-stop")!.handler("", h.ctx);
	await h.tools.get("patch_state")!.execute("passive", { session: { working: { acceptedWhileStopped: true } } }, undefined, undefined, h.ctx);
	const accepted = h.resolveSnapshot();
	release();
	await stopping;
	assert.equal(h.resolveSnapshot().meta.step, accepted.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, accepted.meta.specification);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.readState().working.acceptedWhileStopped, true);
});

for (const boundary of ["abort", "session_start", "session_tree", "session_shutdown", "start"] as const) test(`pending Stop withdraws at ${boundary} without overwriting newer policy or private authority`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h, "Stop this owner only");
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const cancellation = new AbortController();
	const stopping = h.commands.get("state-flow-stop")!.handler("", { ...h.ctx, signal: cancellation.signal });
	let selection: Promise<unknown> | undefined;
	await delay(40);
	assert.deepEqual(files(), before);
	if (boundary === "abort") cancellation.abort(new Error("Stop operation cancelled"));
	else if (boundary === "start") {
		await release();
		await h.commands.get("state-flow-start")!.handler("", h.ctx);
		assert.equal(h.resolveSnapshot().config.enabled, true);
	} else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "new-physical-owner";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	await Promise.race([stopping, delay(500).then(() => assert.fail("obsolete Stop still waits"))]);
	if (boundary !== "start") assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	const retained = files();
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	assert.deepEqual(files(), retained);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses);
	if (boundary !== "start") assert.deepEqual(files(), before);
	if (boundary === "abort") {
		assert.equal(h.statuses.at(-1), undefined);
		assert.match(h.entries.at(-1)!.data.persistenceError, /Stop operation cancelled/);
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { forbidden: true } } }, undefined, undefined, h.ctx), /Memory writes paused after Stop/);
	}
});

test("failed Start leaves an already pending Stop able to accept", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const stopping = h.commands.get("state-flow-stop")!.handler("", h.ctx);
	t.mock.method(TemporalRuntime.prototype, "withStartTransaction", async () => { throw new Error("injected Start rejection"); });
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Start failed: injected Start rejection/);
	assert.equal(h.statuses.at(-1), undefined);
	await release();
	await stopping;
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.entries.some((entry) => entry.data?.persistenceError !== undefined), false);
});

test("Start waits and coalesces repeats before adopting current memory and enabling tools", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Old unfinished request");
	await h.tools.get("patch_state")!.execute("seed", { session: { working: { private: "LOCAL" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const previous = h.resolveSnapshot();
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "withStartTransaction");
	let ended = false;
	const starting = h.commands.get("state-flow-start")!.handler("", h.ctx).then(() => { ended = true; });
	const repeat = h.commands.get("state-flow-start")!.handler("", h.ctx);
	await delay(40);
	assert.equal(ended, false);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.deepEqual(h.readState(), cached);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries);
	writeGlobalState({ ...emptyState(), working: { globalPeer: "G" } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), working: { cwdPeer: "C" } }, h.repositoryRoot);
	const semantic = files().filter(({ path }) => !/\/(config|runtime)\.json$/.test(path));
	await release();
	await Promise.all([starting, repeat]);
	assert.equal(publication.mock.calls.length, 1);
	assert.deepEqual(files().filter(({ path }) => !/\/(config|runtime)\.json$/.test(path)), semantic);
	assert.deepEqual(h.readState().working, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(h.resolveSnapshot().meta.step, previous.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.entries.length, entries.length + 1, "activation checkpoints once without a second persistence transaction");
	assert.equal(h.activeTools.includes("patch_state"), true);
});

test("Start derives current private lifecycle and bootstrap after waiting instead of restoring a stale snapshot", async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const original = TemporalRuntime.prototype.withStartTransaction;
	t.mock.method(TemporalRuntime.prototype, "withStartTransaction", function (this: TemporalRuntime, ...args: Parameters<typeof original>) {
		return gate.then(() => original.apply(this, args));
	});
	const starting = h.commands.get("state-flow-start")!.handler("", h.ctx);
	await h.tools.get("patch_state")!.execute("passive", { session: { working: { acceptedWhileWaiting: true } } }, undefined, undefined, h.ctx);
	const accepted = h.resolveSnapshot();
	h.entries.push({ type: "message", message: user("Conversation arriving during activation", 100) });
	release();
	await starting;
	assert.equal(h.resolveSnapshot().meta.step, accepted.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(h.readState().working.acceptedWhileWaiting, true);
});

for (const boundary of ["abort", "stop", "session_start", "session_tree", "session_shutdown"] as const) test(`pending Start withdraws at ${boundary} without reviving mode or rewriting private authority`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Keep unfinished native context");
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const cancellation = new AbortController();
	const starting = h.commands.get("state-flow-start")!.handler("", { ...h.ctx, signal: cancellation.signal });
	let stopping: Promise<void> | undefined;
	let selection: Promise<unknown> | undefined;
	await delay(40);
	if (boundary === "abort") cancellation.abort(new Error("Start operation cancelled"));
	else if (boundary === "stop") stopping = h.commands.get("state-flow-stop")!.handler("", h.ctx);
	else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "new-physical-owner";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	await Promise.race([starting, delay(500).then(() => assert.fail("obsolete Start still waits"))]);
	assert.deepEqual(files(), before);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	const notices = [...h.notifications];
	const entries = structuredClone(h.entries);
	await release();
	await stopping;
	await selection;
	await delay(40);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.notifications, notices);
	if (boundary !== "stop") assert.deepEqual(h.entries, entries);
	if (boundary === "abort") assert.match(h.notifications.at(-1)!, /Start failed:.*Start operation cancelled/);
});

test("Start rechecks the physical owner after waiting even without a selection event", async (t) => {
	const h = harness({ initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const starting = h.commands.get("state-flow-start")!.handler("", h.ctx);
	h.ctx.sessionManager.getSessionId = () => "different-owner";
	await release();
	await starting;
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	assert.equal(h.entries.length, 0);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.notifications.length, 0);
});

test("post-acceptance Start checkpoint failure retains enabled policy and cleared fences without replaying native writes", async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h, "Old specification must not return");
	const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
	mkdirSync(lock);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	rmSync(lock, { recursive: true });
	let appends = 0;
	Object.defineProperty(h.entries, "push", { configurable: true, value: () => { appends += 1; throw new Error("injected Start checkpoint failure"); } });
	try { await h.commands.get("state-flow-start")!.handler("", h.ctx); }
	finally { Reflect.deleteProperty(h.entries, "push"); }
	assert.equal(appends, 1);
	const paths = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).enabled, true);
	assert.equal(JSON.parse(readFileSync(paths.runtime, "utf8")).specification, undefined);
	assert.match(h.statuses.at(-1)!, /state-flow/);
	assert.match(h.notifications.at(-1)!, /enabled; lifecycle update failed: injected Start checkpoint failure/);
	await h.tools.get("patch_state")!.execute("accepted", { session: { working: { retainedEnabled: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.readState().working.retainedEnabled, true);
});

test("failed Stop publication rolls back lifecycle files without installing shared adoption", async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h);
	const cached = h.readState();
	writeGlobalState({ ...emptyState(), working: { foreign: "NOT-ACCEPTED-LOCALLY" } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === path) { failed = true; throw new Error("injected Stop publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	try { await h.commands.get("state-flow-stop")!.handler("", h.ctx); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached);
	assert.equal(h.statuses.at(-1), undefined);
	assert.match(h.notifications.at(-1)!, /disabled; memory writes paused:.*injected Stop publication failure/);
});

test("post-acceptance Stop checkpoint failure neither rolls back accepted mode nor repeats native writes", async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	await start(h);
	let appends = 0;
	Object.defineProperty(h.entries, "push", { configurable: true, value: () => { appends += 1; throw new Error("injected Stop checkpoint failure"); } });
	t.after(() => { Reflect.deleteProperty(h.entries, "push"); });
	try { await h.commands.get("state-flow-stop")!.handler("", h.ctx); }
	finally { Reflect.deleteProperty(h.entries, "push"); }
	assert.equal(appends, 1);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config;
	assert.equal(JSON.parse(readFileSync(path, "utf8")).enabled, false);
	assert.equal(h.statuses.at(-1), undefined);
	assert.match(h.notifications.at(-1)!, /disabled; lifecycle update failed:.*injected Stop checkpoint failure/);
	await h.tools.get("patch_state")!.execute("continue", { session: { working: { afterAcceptedStop: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.readState().working.afterAcceptedStop, true);
});

test("Stop failures leave mode off, retain context and memory, and fence writes through reload without touching canonical bytes", async () => {
	for (const fault of ["concurrent", "locked", "malformed"] as const) {
		for (const [passiveBootstrap, passiveTools] of [[false, false], [true, false], [false, true], [true, true]]) {
			const options = { initializeRepository: false, passiveBootstrap, passiveTools };
			const h = harness(options);
			await start(h, "Uncompiled request");
			await h.tools.get("patch_state")!.execute("accepted", { session: { working: { private: "retained" } } }, undefined, undefined, h.ctx);
			const paths = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			const originalRuntime = readFileSync(paths.runtime);
			const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
			const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			if (fault === "concurrent") {
				const peer = harness({ ...options, repositoryRoot: h.repositoryRoot });
				peer.entries.push(...structuredClone(h.entries));
				await peer.handlers.get("session_start")!({ reason: "resume" }, peer.ctx);
				await peer.tools.get("patch_state")!.execute("peer", { session: { working: { peer: "accepted" } } }, undefined, undefined, peer.ctx);
			} else if (fault === "malformed") writeFileSync(paths.runtime, "malformed runtime");
			const canonical = files();
			if (fault === "locked") mkdirSync(lock);
			const checkpointCount = h.entries.length;
			await h.commands.get("state-flow-stop")!.handler("", h.ctx);
			assert.equal(h.statuses.at(-1), undefined);
			assert.equal(h.activeTools.includes("patch_state"), passiveTools);
			assert.match(h.notifications.at(-1)!, /disabled; memory writes paused/);
			assert.equal(h.readState(0, "session").working.private, "retained", "a failed write never erases the accepted cache");
			assert.equal(h.entries.length, checkpointCount + 1);
			const marker = h.entries.at(-1)!;
			assert.equal(marker.customType, "state-flow-passive-stop");
			assert.equal(marker.data.owner, h.ctx.sessionManager.getSessionId());
			assert.equal(marker.data.preserveContext, true);
			assert.ok(marker.data.persistenceError);
			const messages = [user("Available older context", 1), user("Uncompiled request", 10), toolAssistant("late-read")];
			assert.deepEqual(h.handlers.get("context")!({ messages }, h.ctx).messages.slice(1), messages);
			assert.doesNotMatch(h.beforeAgentStart("Ordinary continuation").systemPrompt, /State Flow is enabled/);
			await assert.rejects(h.tools.get("patch_state")!.execute("refused", { session: { working: { unsafe: true } } }, undefined, undefined, h.ctx), /paused after Stop|tools are disabled/);
			if (fault !== "concurrent") {
				await h.commands.get("state-flow-start")!.handler("", h.ctx);
				assert.match(h.notifications.at(-1)!, /Start failed/);
			}
			await h.commands.get("state-flow-stop")!.handler("", h.ctx);
			assert.equal(h.entries.length, checkpointCount + 1, "repeated degraded Stop neither retries publication nor clears the fence");
			if (fault === "locked") rmSync(lock, { recursive: true });
			assert.deepEqual(files(), canonical);
			const resumed = harness({ ...options, repositoryRoot: h.repositoryRoot });
			resumed.entries.push(...structuredClone(h.entries));
			await resumed.handlers.get("session_start")!({ reason: "reload" }, resumed.ctx);
			assert.equal(resumed.statuses.at(-1), undefined);
			assert.equal(resumed.notifications.length, 0, "reload retains the diagnostic without repeating its warning");
			assert.deepEqual(files(), canonical, "reload must not restore/publish the older selected boundary over another writer");
			assert.equal(resumed.entries.length, h.entries.length);
			const projected = resumed.handlers.get("context")!({ messages }, resumed.ctx)?.messages ?? messages;
			assert.match(JSON.stringify(projected), /Uncompiled request/);
			assert.match(JSON.stringify(projected), /late-read/);
			if (fault !== "malformed") {
				assert.equal(resumed.readState(0, "session").working.private, "retained");
				if (fault === "concurrent") assert.equal(resumed.readState(0, "session").working.peer, "accepted");
			} else assert.throws(() => resumed.readState(0, "session"), /selected branch is unavailable/);
			await assert.rejects(resumed.tools.get("patch_state")!.execute("fenced", { session: { working: { unsafe: true } } }, undefined, undefined, resumed.ctx), /paused after Stop|selected branch is unavailable|tools are disabled/);
			assert.deepEqual(files(), canonical);
			if (fault === "malformed") writeFileSync(paths.runtime, originalRuntime);
			await resumed.commands.get("state-flow-start")!.handler("", resumed.ctx);
			assert.equal(resumed.resolveSnapshot().config.enabled, true);
			await resumed.tools.get("patch_state")!.execute("accepted-again", { session: { working: { afterStart: true } } }, undefined, undefined, resumed.ctx);
			assert.equal(resumed.readState(0, "session").working.afterStart, true);
			assert.equal(resumed.readState(0, "session").working.private, "retained");
		}
	}
});

test("stop removes State Flow semantics while retaining a bounded passive continuation", async () => {
	const h = harness();
	await start(h, "Establish bounded state");
	await commitTerminal(h, {}, { continuation: "keep this" }, "Context compiled.");
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);

	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.activeTools.includes("read_state"), false);
	assert.deepEqual(h.beforeAgentStart("Continue").systemPromptOptions.sections, {});

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
	const h = harness();
	await start(h, "Remember state");
	await commitTerminal(h, {}, { continuation: "reload" }, "Context compiled.");
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	for (const reason of ["reload", "startup", "resume", undefined]) {
		if (reason === undefined) await h.handlers.get("session_tree")!({}, h.ctx);
		else await h.handlers.get("session_start")!({ reason }, h.ctx);
		const projected = h.handlers.get("context")!({ messages: [
			user("Pre-stop history", 1),
			user("Continue", Date.now() + 1_000),
		] }, h.ctx);
		assert.match(projected.messages[0].content[0].text, /exit handoff/);
		assert.match(projected.messages[0].content[0].text, /reload/);
		assert.equal(projected.messages.length, 2);
	}

	for (const reason of ["new", "fork"]) {
		await h.handlers.get("session_start")!({ reason }, h.ctx);
		assert.equal(h.handlers.get("context")!({ messages: [user("Continue", Date.now() + 1_000)] }, h.ctx), undefined);
	}
});

test("idle Stop after interruption retains the unfinished run through reload, conservatively without an anchor", async () => {
	for (const captured of [false, true]) {
		const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true });
		await start(h, "Unfinished request");
		const old = user("Completed older request", 1);
		const current = user("Unfinished request", 10);
		const call = toolAssistant("unfinished-read");
		if (captured) h.handlers.get("message_end")!({ message: current }, h.ctx);
		h.handlers.get("message_end")!({ message: { role: "assistant", content: [], stopReason: "aborted" } }, h.ctx);
		await h.commands.get("state-flow-stop")!.handler("", h.ctx);
		const marker = h.entries.findLast((entry) => entry.customType === "state-flow-passive-stop")!.data;
		assert.equal(marker.from, captured ? 10 : undefined);
		assert.equal(marker.preserveContext, captured ? undefined : true);
		for (const reload of [false, true]) {
			if (reload) await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
			const projected = h.handlers.get("context")!({ messages: [old, current, call] }, h.ctx);
			assert.deepEqual(projected.messages.slice(1), captured ? [current, call] : [old, current, call]);
		}
	}
});

test("idle Stop does not retain the last run anchor and legacy markers keep their cutoff on reload", async () => {
	const h = harness();
	await start(h, "Completed request");
	h.handlers.get("message_end")!({ message: user("Completed request", 1) }, h.ctx);
	await commitTerminal(h, {}, { done: true }, "Completed answer");
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const marker = h.entries.find((entry) => entry.customType === "state-flow-passive-stop")!;
	assert.deepEqual(marker.data, { at: marker.data.at });
	for (const data of [{ at: marker.data.at }, { at: marker.data.at, from: -1 }]) {
		marker.data = data;
		await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
		const projected = h.handlers.get("context")!({ messages: [
			user("Malformed older timestamp", -1),
			user("Completed request", 1),
			user("Later request", marker.data.at + 1),
		] }, h.ctx);
		assert.equal(projected.messages.length, 2);
		assert.equal(projected.messages[1].content[0].text, "Later request");
	}
});

test("repeated stop retains one passive handoff without adding another marker", async () => {
	const h = harness();
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
	const h = harness();
	await start(h, "Remember state");
	await commitTerminal(h, {}, { continuation: "restart" }, "Context compiled.");
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
	await h.handlers.get("turn_end")!({ message: postStopAnswer }, h.ctx);
	assert.equal(h.readState().response, frozenResponse);

	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	const protocol = await h.beginRun("Restart State Flow");
	assert.match(protocol.systemPrompt, /State Flow is enabled/);
	const projected = h.handlers.get("context")!({ messages: [...oldMessages, ...postStopMessages] }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.match(projected.messages[0].content[0].text, /State Flow runtime context/);
	assert.match(projected.messages[1].content[0].text, /State Flow exit handoff/);
	assert.match(JSON.stringify(projected.messages), /Post-stop question/);
	assert.match(JSON.stringify(projected.messages), /Post-stop answer/);
	assert.doesNotMatch(JSON.stringify(projected.messages), /OLD-/);

	const final = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Active again." }] };
	h.handlers.get("message_end")!({ message: final }, h.ctx);
	await h.handlers.get("turn_end")!({ message: final }, h.ctx);
	await h.beginRun("Later");
	const later = h.handlers.get("context")!({ messages: [user("Later", afterStop + 3)] }, h.ctx);
	assert.match(later.messages[0].content[0].text, /State Flow runtime context/);
	assert.doesNotMatch(JSON.stringify(later.messages), /exit handoff/);
});

async function restorableBranch(options: Parameters<typeof harness>[0] = {}) {
	const h = harness({ initializeRepository: false, passiveTools: true, ...options });
	await start(h);
	await commitTerminal(h, {}, { retained: "PRIVATE" }, "Accepted answer");
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	return { h, files, lock: join(h.repositoryRoot, ".state-flow-publication.lock") };
}

const semanticFiles = (cohort: ReturnType<typeof captureTemporalFileBases>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));

test("Start cancellation withdraws its join without cancelling independently owned restoration", { timeout: 5_000 }, async (t) => {
	const { h, files } = await restorableBranch();
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx)).then(() => { restored = true; });
	const controller = new AbortController();
	const starting = h.commands.get("state-flow-start")!.handler("", { ...h.ctx, signal: controller.signal });
	await delay(40);
	controller.abort();
	await Promise.race([starting, delay(500).then(() => assert.fail("cancelled Start still joins the storage wait"))]);
	assert.equal(restored, false, "cancelling the join must not cancel its independent owner");
	assert.deepEqual(files(), before);
	await release();
	await restoring;
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.deepEqual(semanticFiles(files()), semanticFiles(before));
});

test("Start cannot activate a different physical owner after joining restoration", async (t) => {
	const { h } = await restorableBranch();
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const other = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, cwd: h.ctx.cwd, sessionId: "other-owner" });
	await start(other);
	await other.commands.get("state-flow-stop")!.handler("", other.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, "other-owner", h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const restoring = h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	const starting = h.commands.get("state-flow-start")!.handler("", h.ctx);
	await delay(40);
	h.ctx.sessionManager.getSessionId = () => "other-owner";
	await release();
	await Promise.all([restoring, starting]);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "other-owner", h.repositoryRoot), before);
	assert.equal(h.statuses.at(-1), undefined);
});

test("shutdown drains superseded restoration operations as well as the current selection", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, passiveTools: true });
	const finish: Array<() => void> = [];
	t.mock.method(TemporalRuntime.prototype, "refreshShared", () => new Promise<boolean>((resolve) => { finish.push(() => resolve(false)); }));
	t.after(() => { for (const release of finish) release(); });
	const first = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	h.ctx.sessionManager.getSessionId = () => "replacement-owner";
	const second = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(finish.length, 2);
	let drained = false;
	const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx).then(() => { drained = true; });
	finish[1]!();
	await second;
	await delay(40);
	assert.equal(drained, false, "the superseded operation still belongs to shutdown");
	finish[0]!();
	await Promise.all([first, shutdown]);
	assert.equal(drained, true);
});

test("passive attachment never installs an old CWD after physical identity changes during its wait", async (t) => {
	const { h: owner } = await restorableBranch();
	await owner.tools.get("patch_state")!.execute("project", { cwd: { working: { project: "OLD-CWD" } } }, undefined, undefined, owner.ctx);
	const h = harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", passiveTools: true });
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const selecting = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(40);
	h.ctx.cwd = join(h.repositoryRoot, "different-project");
	const statuses = [...h.statuses];
	await release();
	await selecting;
	assert.throws(() => h.readState(0, "cwd"), /unavailable/);
	assert.deepEqual(h.statuses, statuses);
});

for (const kind of ["passive", "current"] as const) test(`late ${kind} recovery cancellation prevents host cache installation`, async (t) => {
	const { h: owner } = await restorableBranch();
	const h = kind === "current" ? owner : harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", passiveTools: true });
	if (kind === "current") h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: {
		at: Date.now(), owner: h.ctx.sessionManager.getSessionId(), persistenceError: "fixture Stop fence", preserveContext: true,
	} });
	const controller = new AbortController();
	const shared = TemporalRuntime.prototype.refreshShared;
	const current = TemporalRuntime.prototype.refreshCurrentMemory;
	t.mock.method(TemporalRuntime.prototype, kind === "passive" ? "refreshShared" : "refreshCurrentMemory", async function(this: TemporalRuntime, signal?: AbortSignal) {
		const result = await (kind === "passive" ? shared.call(this, signal) : current.call(this, signal));
		controller.abort(new Error("late recovery cancellation"));
		return result;
	});
	const files = captureTemporalFileBases(owner.ctx.cwd, owner.ctx.sessionManager.getSessionId(), owner.repositoryRoot);
	await h.handlers.get("session_start")!({ reason: "resume" }, { ...h.ctx, signal: controller.signal });
	assert.throws(() => h.readState(0, kind === "passive" ? "cwd" : "session"), /unavailable/);
	assert.deepEqual(captureTemporalFileBases(owner.ctx.cwd, owner.ctx.sessionManager.getSessionId(), owner.repositoryRoot), files);
});

test("passive attachment cannot replace a private patch accepted after its read", async (t) => {
	const { h: owner } = await restorableBranch();
	const h = harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", passiveTools: true });
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const read = TemporalRuntime.prototype.refreshShared;
	t.mock.method(TemporalRuntime.prototype, "refreshShared", async function(this: TemporalRuntime, signal?: AbortSignal) {
		const result = await read.call(this, signal);
		enter(); await gate;
		return result;
	});
	const selecting = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await entered;
	await h.tools.get("patch_state")!.execute("accepted-during-attachment", { session: { working: { retained: "NEW-PRIVATE" } } }, undefined, undefined, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	release(); await selecting;
	assert.equal(h.readState(0, "session").working.retained, "NEW-PRIVATE");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
});

for (const retry of [false, true]) for (const cold of [false, true]) for (const expired of [false, true]) test(`Stop selects passive policy without cancelling fork memory initialization (retry=${retry}, cold=${cold}, expired=${expired})`, async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "state-flow-interrupted-fork-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const cwd = join(fixture, "cwd"), sessions = join(fixture, "sessions"), repositoryRoot = join(fixture, "store");
	for (const directory of [cwd, sessions, repositoryRoot]) mkdirSync(directory);
	const parentManager = SessionManager.create(cwd, sessions);
	const parent = harness({ cwd, repositoryRoot, initializeRepository: false, sessionId: parentManager.getSessionId(), sessionFile: parentManager.getSessionFile(), sessionTimestamp: parentManager.getHeader()!.timestamp });
	writeFileSync(parentManager.getSessionFile()!, JSON.stringify(parentManager.getHeader()) + "\n");
	await start(parent);
	await parent.tools.get("patch_state")!.execute("parent-private", { session: { working: { private: "SELECTED-PRIVATE" } } }, undefined, undefined, parent.ctx);
	const manager = SessionManager.create(cwd, sessions);
	const header = { ...manager.getHeader()!, version: 3, parentSession: parentManager.getSessionFile()! };
	const childOptions = { cwd, repositoryRoot, initializeRepository: false, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionTimestamp: header.timestamp, passiveTools: true };
	let child = harness(childOptions);
	child.ctx.sessionManager.getHeader = () => header;
	child.entries.push(...structuredClone(parent.entries));
	if (expired) for (let index = 0; index < 9; index++) {
		await parent.tools.get("patch_state")!.execute(`advance-${index}`, { session: { working: { private: "LATER-PRIVATE", index } } }, undefined, undefined, parent.ctx);
	}
	if (retry) {
		child.ctx.sessionManager.getHeader = () => ({ ...header, parentSession: join(fixture, "missing-parent.jsonl") });
		await child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
		child.ctx.sessionManager.getHeader = () => header;
	}
	const parentKey = sessionStorageKey(parentManager.getSessionFile()!, parentManager.getSessionId(), parentManager.getHeader()!.timestamp);
	const before = captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey);
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(repositoryRoot, async () => { enter(); await gate; });
	let selecting: Promise<unknown> | undefined;
	let control: Promise<unknown> | undefined;
	let settled = false;
	const fork = TemporalRuntime.prototype.withForkTransaction;
	t.mock.method(TemporalRuntime.prototype, "withForkTransaction", function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["withForkTransaction"]>) {
		const operation = fork.call(this, ...args);
		selecting = operation.then(() => { settled = true; }, () => { settled = true; });
		return operation;
	});
	try {
		await entered;
		control = retry ? child.commands.get("state-flow-start")!.handler("", child.ctx) : child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
		await delay(0);
		assert.ok(selecting instanceof Promise);
		assert.throws(() => child.readState(0, "session"), /restoration is pending/);
		await Promise.race([child.commands.get("state-flow-stop")!.handler("", child.ctx), delay(1_000).then(() => assert.fail("Stop waited for fork acceptance"))]);
		await delay(30);
		assert.equal(settled, false, "Stop does not cancel the independent fork initializer");
		assert.equal(child.statuses.at(-1), undefined);
		assert.throws(() => child.readState(0, "session"), /restoration is pending/);
		assert.deepEqual(captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey), before);
	} finally { release(); await holder; await selecting; await control; }
	if (!expired) {
		assert.equal(child.resolveSnapshot().config.enabled, false);
		assert.equal(child.readState(0, "session").working.private, "SELECTED-PRIVATE");
		await child.tools.get("patch_state")!.execute("passive-child-private", { session: { working: { private: "CHILD-OWNED" } } }, undefined, undefined, child.ctx);
		assert.equal(child.resolveSnapshot().config.enabled, false, "passive patching does not enable active policy");
	}
	const reopenChild = async () => {
		await child.handlers.get("session_shutdown")!({}, child.ctx);
		// Persist the native trace, then open a new manager and a fresh extension instance.
		writeFileSync(manager.getSessionFile()!, [header, ...child.entries.map((entry, index) => ({ ...entry, id: String(index), parentId: index ? String(index - 1) : null, timestamp: header.timestamp }))].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const reopened = SessionManager.open(manager.getSessionFile()!);
		child = harness(childOptions);
		assert.equal(reopened.getHeader()!.version, header.version);
		child.ctx.sessionManager.getHeader = () => ({ ...reopened.getHeader()!, version: header.version });
		child.entries.push(...reopened.getBranch());
		await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
	};
	if (cold) await reopenChild();
	const parentFiles = captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey);
	const childKey = sessionStorageKey(manager.getSessionFile()!, manager.getSessionId(), header.timestamp);
	const unaccepted = captureTemporalFileBases(cwd, manager.getSessionId(), repositoryRoot, childKey);
	const traceLength = child.entries.length;
	await child.commands.get("state-flow-start")!.handler("", child.ctx);
	if (!expired) {
		assert.equal(child.readState(0, "session").working.private, "CHILD-OWNED");
		assert.match(child.notifications.at(-1)!, /^State Flow enabled/);
		await child.commands.get("state-flow-stop")!.handler("", child.ctx);
		await reopenChild();
		await child.commands.get("state-flow-start")!.handler("", child.ctx);
		assert.equal(child.readState(0, "session").working.private, "CHILD-OWNED", "an accepted child never recopies its parent after cold recovery");
	} else {
		assert.throws(() => child.readState(0, "session"), /unavailable/);
		assert.match(child.notifications.at(-1)!, /Start failed/);
		assert.match(child.notifications.at(-1)!, cold ? /Current State Flow session (?:storage|memory) is unavailable/ : /outside the retained temporal window/);
		assert.equal(child.entries.length, traceLength, "unavailable source history cannot produce a substitute checkpoint");
		assert.deepEqual(captureTemporalFileBases(cwd, manager.getSessionId(), repositoryRoot, childKey), unaccepted, "refusal cannot initialize or substitute private memory");
	}
	assert.deepEqual(captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey), parentFiles, "retry preserves parent-private and shared bytes");
});

test("native branch restoration awaits exclusion, fences pending authority and coalesces Start into one acceptance", async (t) => {
	const { h, files } = await restorableBranch();
	const state = h.readState();
	const before = files();
	const entries = h.entries.length;
	const notices = h.notifications.length;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx)).then(() => { restored = true; });
	const starts = [h.commands.get("state-flow-start")!.handler("", h.ctx), h.commands.get("state-flow-start")!.handler("", h.ctx)];
	await delay(40);
	assert.equal(restored, false);
	assert.equal(h.statuses.at(-1), undefined, "pending selection keeps local policy passive");
	assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	await assert.rejects(h.tools.get("patch_state")!.execute("pending", { session: { working: { early: true } } }, undefined, undefined, h.ctx), /restoration is pending/);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /restoration is pending/);
	assert.deepEqual(files(), before);
	assert.equal(h.entries.length, entries);
	await release();
	await restoring;
	await Promise.all(starts);
	assert.deepEqual(h.readState(), state);
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(h.entries.length, entries + 1, "restoration appends one accepted checkpoint; joined Starts stay inert");
	assert.equal(h.notifications.length, notices + 1, "only the explicit status request was reported");
	assert.match(h.statuses.at(-1)!, /state-flow/);
	assert.deepEqual(semanticFiles(files()), semanticFiles(before));
});

test("restoration derives uncompiled-context bootstrap after waiting and publishes it in the same acceptance", async (t) => {
	const { h } = await restorableBranch();
	const runtimePath = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx));
	await delay(20);
	// Native conversation that arrives after the checkpoint is observed after the wait, not at dispatch.
	h.entries.push({ type: "message", message: { role: "user", content: "UNCOMPILED", timestamp: 1 } });
	const rename = fs.renameSync;
	let runtimeWrites = 0;
	fs.renameSync = (from, to) => {
		if (to === runtimePath) runtimeWrites++;
		return rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	await release();
	await restoring;
	assert.equal(runtimeWrites, 1, "no second post-restore persistence call");
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
});

for (const replacement of ["session_start", "session_tree", "session_shutdown"] as const) test(`pending branch restoration withdraws at ${replacement} while exclusion is held`, { timeout: 5_000 }, async (t) => {
	const { h, files, lock } = await restorableBranch();
	const state = h.readState();
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const old = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx));
	await delay(20);
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	const next = Promise.resolve(h.handlers.get(replacement)!(replacement === "session_start" ? { reason: "resume" } : {}, h.ctx));
	await Promise.race([old, delay(1_000).then(() => assert.fail("obsolete restoration still waits"))]);
	if (replacement === "session_shutdown") await Promise.race([next, delay(1_000).then(() => assert.fail("shutdown did not drain restoration"))]);
	assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
	assert.deepEqual(h.entries, entries, "the obsolete restoration appends no checkpoint");
	assert.deepEqual(h.notifications, notices);
	await release();
	await next;
	await delay(20);
	assert.deepEqual(h.notifications, notices);
	if (replacement === "session_shutdown") {
		assert.deepEqual(h.entries, entries);
		assert.deepEqual(files(), before);
		return;
	}
	assert.equal(h.entries.length, entries.length + 1, "only the current selection accepts");
	assert.deepEqual(h.readState(), state);
});

for (const restart of [false, true]) for (const branch of ["boundary", "auto-start"] as const) test(`Stop preserves pending ${branch} memory acceptance (restart=${restart})`, { timeout: 5_000 }, async (t) => {
	const h = branch === "boundary"
		? (await restorableBranch()).h
		: harness({ initializeRepository: false, passiveTools: true, autoStart: true });
	const state = branch === "boundary" ? h.readState() : undefined;
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: branch === "boundary" ? "resume" : "new" }, h.ctx)).then(() => { restored = true; });
	await delay(20);
	const entries = h.entries.length;
	await Promise.race([h.commands.get("state-flow-stop")!.handler("", h.ctx), delay(1_000).then(() => assert.fail("Stop waited for attachment"))]);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	await delay(20);
	assert.equal(restored, false, "policy changes leave memory acceptance waiting for exclusion");
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.entries.length, entries, "Stop must not fabricate an error fence or replacement checkpoint");
	assert.deepEqual(files(), before);
	const starting = restart ? h.commands.get("state-flow-start")!.handler("", h.ctx) : undefined;
	await release();
	await restoring;
	await starting;
	assert.equal(h.resolveSnapshot().config.enabled, restart);
	if (branch === "boundary") assert.deepEqual(h.readState(), state);
	assert.equal(existsSync(sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config), true);
	assert.equal(h.notifications.some((message) => /writes paused|failed/.test(message)), false);
	await h.tools.get("patch_state")!.execute("mode-independent", { session: { working: { resumed: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").working.resumed, true);
	assert.equal(h.resolveSnapshot().config.enabled, restart);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.equal(h.readState(0, "session").working.resumed, true);
	assert.equal(h.resolveSnapshot().config.enabled, restart);
});

test("Stop withdraws Start-owned attachment without cancelling retained memory acceptance", async (t) => {
	const { h: source } = await restorableBranch();
	const state = source.readState();
	const h = harness({ initializeRepository: false, cwd: source.ctx.cwd, repositoryRoot: source.repositoryRoot, sessionId: source.ctx.sessionManager.getSessionId(), passiveTools: true });
	h.entries.push(...structuredClone(source.entries));
	const restore = TemporalRuntime.prototype.withRestoreTransaction;
	let recovered: Promise<unknown> | undefined;
	t.mock.method(TemporalRuntime.prototype, "withRestoreTransaction", function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["withRestoreTransaction"]>) {
		const operation = restore.call(this, ...args);
		recovered = operation.catch(() => undefined);
		return operation;
	});
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const starting = h.commands.get("state-flow-start")!.handler("", h.ctx);
	try {
		await delay(20);
		assert.ok(recovered);
		await h.commands.get("state-flow-stop")!.handler("", h.ctx);
		await Promise.race([starting, delay(1_000).then(() => assert.fail("cancelled Start still waits for attachment"))]);
		assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	} finally { await release(); await recovered; }
	assert.deepEqual(h.readState(), state);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	await h.tools.get("patch_state")!.execute("passive-after-attachment", { session: { working: { passive: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").working.passive, true);
});

test("failed-Stop reload awaits read-only current memory and keeps its write fence", { timeout: 5_000 }, async (t) => {
	const { h, files, lock } = await restorableBranch();
	const state = h.readState(0, "session");
	mkdirSync(lock);
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	rmSync(lock, { recursive: true });
	assert.ok(h.entries.at(-1)!.data.persistenceError);
	const before = files();
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let loaded = false;
	const reloading = Promise.resolve(h.handlers.get("session_start")!({ reason: "reload" }, h.ctx)).then(() => { loaded = true; });
	await delay(40);
	assert.equal(loaded, false);
	assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	// Stop is inert under the fence and does not revoke read-only recovery.
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	await release();
	await reloading;
	assert.deepEqual(h.readState(0, "session"), state);
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(files(), before, "read-only recovery never publishes");
	assert.deepEqual(h.entries, entries, "read-only recovery appends no checkpoint");
	await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { unsafe: true } } }, undefined, undefined, h.ctx), /Memory writes paused after Stop/);
});

test("auto-start initializes a truly new branch in one awaited acceptance", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, autoStart: true });
	const config = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let attached = false;
	const attaching = Promise.resolve(h.handlers.get("session_start")!({ reason: "new" }, h.ctx)).then(() => { attached = true; });
	await delay(40);
	assert.equal(attached, false);
	assert.equal(existsSync(config), false);
	assert.equal(h.entries.length, 0);
	await release();
	await attaching;
	assert.equal(existsSync(config), true);
	assert.equal(h.entries.length, 1);
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.match(h.statuses.at(-1)!, /state-flow/);
	assert.equal(h.activeTools.includes("patch_state"), true);
});

test("accepted restoration survives a native checkpoint failure without rollback or replay", async () => {
	const { h, files } = await restorableBranch({ passiveTools: false });
	const state = h.readState();
	const entries = h.entries.length;
	h.entries.push = () => { throw new Error("native trace unavailable"); };
	try {
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	} finally {
		delete (h.entries as { push?: unknown }).push;
	}
	assert.match(h.notifications.at(-1)!, /^State Flow memory restored; lifecycle update failed: native trace unavailable/);
	assert.equal(h.entries.length, entries);
	assert.deepEqual(h.readState(), state);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.match(h.statuses.at(-1)!, /state-flow/);
	const accepted = files();
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	assert.deepEqual(files(), accepted, "already-active Start neither replays nor republishes the restoration");
	await commitTerminal(h, {}, { after: true }, "Next answer");
	assert.deepEqual(h.readState(0, "session").working, { retained: "PRIVATE", after: true });
});
