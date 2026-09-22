import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
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
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	await resumed.commands.get("state-flow-status").handler("", resumed.ctx);
	assert.doesNotMatch(resumed.notifications.at(-1)!, /Publication: pending/);
	const missingRoot = join(agentDir, "new-store");
	const old = harness({ repositoryRoot: missingRoot, initializeRepository: false });
	old.entries.push(checkpoint);
	old.handlers.get("session_start")!({ reason: "resume" }, old.ctx);
	await old.commands.get("state-flow-start").handler("", old.ctx);
	assert.equal(existsSync(missingRoot), false);
	assert.deepEqual(old.entries, [checkpoint]);
	assert.match(old.notifications.at(-1)!, /canonical files/);
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
		seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
		await start(seed);
		await seed.tools.get("patch_state")!.execute("seed", { cwd: {
			working: { shared: "durable" },
			intents: { release: { action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" } } },
			lazy: { releasePlan: { steps: ["validate"] } },
		} }, undefined, undefined, seed.ctx);
		await seed.commands.get("state-flow-stop")!.handler("", seed.ctx);
		const h = harness({ repositoryRoot: seed.repositoryRoot, cwd: seed.ctx.cwd, sessionId: `passive-${passiveBootstrap}-${passiveTools}`, initializeRepository: false, passiveBootstrap, passiveTools });
		h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
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
		h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
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

for (const activate of ["start", "passive-patch"] as const) {
	test(`pre-runtime Stop preserves global-only memory before ${activate} establishes session state`, async () => {
		const h = harness({ initializeRepository: false, passiveBootstrap: true, passiveTools: true });
		writeGlobalState({ ...emptyState(), working: { shared: "global" } }, h.repositoryRoot);
		const id = h.ctx.sessionManager.getSessionId();
		const files = () => captureTemporalFileBases(h.ctx.cwd, id, h.repositoryRoot);
		const before = files();
		h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.readState(0, "global").working.shared, "global");
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		assert.deepEqual(files(), before);
		assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, id, "cwd", h.repositoryRoot).directory), false);
		h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
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
		h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
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
		h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.match(h.notifications.at(-1)!, /passive memory is unavailable/);
		await h.commands.get("state-flow-stop").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		assert.deepEqual(files(), before);
		await h.commands.get("state-flow-start").handler("", h.ctx);
		if (invalid === "cwd-without-global") {
			assert.equal(h.resolveSnapshot().config.enabled, true, "explicit Start may initialize a wholly absent global scope");
			assert.equal(h.readState(0, "cwd").working.project, "retained");
		} else {
			assert.match(h.notifications.at(-1)!, /could not initialize/);
			assert.deepEqual(files(), before);
			assert.deepEqual(h.entries.at(-1).data, { disabled: true });
		}
	});
}

test("failed branch restoration keeps passive shared reads without authorizing private reads or writes", async () => {
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
		h.handlers.get("session_tree")!({}, h.ctx);
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
		await assert.rejects(h.commands.get("state-flow-stop").handler("", h.ctx), /selected branch is unavailable/);
		await h.commands.get("state-flow-start").handler("", h.ctx);
		assert.match(h.notifications.at(-1)!, /selected branch is unavailable/);
		await h.commands.get("state-flow-status").handler("", h.ctx);
		assert.match(h.notifications.at(-1)!, /Temporal materialization unavailable:.*outside the retained temporal window/);
		assert.deepEqual(files(), before, "refused lifecycle and model writes must preserve every canonical file");
		assert.deepEqual(h.entries, retained, "failed selections must not publish substitute Pi checkpoints");
		h.ctx.sessionManager.getBranch = () => retained;
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.readState(0, "session").working.private, 9);
		await patch.execute("continued", { session: { working: { continued: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").working.continued, true);
	}
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
	h.beforeAgentStart("Observe removals");
	for (const [scope, path] of Object.entries(paths) as ["global" | "cwd" | "session", string][]) {
		assert.equal(h.readState(0, scope).artifacts[path], undefined);
	}
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
			message: "Reconcile the verified current values that reference this path.",
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
	h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.resolveSnapshot().meta.step, 0);
});

test("ordinary direct and tool-followed answers complete without a finalization inference", async () => {
	for (const withTool of [false, true]) {
		const h = harness();
		await start(h, withTool ? "Use a tool then answer" : "Answer directly");
		if (withTool) {
			h.handlers.get("message_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
			h.handlers.get("turn_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
		}
		const message = finalMessage(withTool ? "Tool-informed answer." : "Direct answer.");
		h.handlers.get("message_end")!({ message }, h.ctx);
		h.handlers.get("turn_end")!({ message }, h.ctx);
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
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.deepEqual(h.readState().working, { first: true, second: true });
	assert.equal(h.readState().response, "Both changes are retained.");
	assert.equal(h.sentMessages.length, 0);
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
	h.handlers.get("turn_end")!({ message: finalMessage("Still pending.") }, h.ctx);
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

test("length and provider-error endings never become accepted responses", async () => {
	for (const stopReason of ["length", "error"]) {
		const h = harness();
		await start(h, `Stop reason ${stopReason}`);
		const message = { ...finalMessage("Incomplete output."), stopReason };
		assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
		h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, "");
		assert.equal(h.sentMessages.length, 0);
	}
});

test("accepts only canonical materially changing atomic scope patches", async () => {
	const h = harness();
	await start(h, "Resolve me");
	const execute = (input: unknown) => h.tools.get("patch_state")!.execute("invalid", input, undefined, undefined, h.ctx);
	for (const input of [null, [], {}, { final: false }, { unchanged: true },
		{ scope: "session", patch: { working: { value: true } } }, { session: {} },
		{ session: { working: { value: true } }, extra: "forbidden" }, { global: null }]) await assert.rejects(execute(input));
	await execute({ session: { working: { value: true } } });
	const message = finalMessage("Resolved directly.");
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Resolved directly.");
});

test("stop removes State Flow semantics while retaining a bounded passive continuation", async () => {
	const h = harness();
	await start(h, "Establish bounded state");
	await h.tools.get("patch_state")!.execute("state", { session: { working: { continuation: "keep this" } } }, undefined, undefined, h.ctx);
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
		h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
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
	const protocol = h.beforeAgentStart("Restart State Flow");
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
	h.handlers.get("turn_end")!({ message: final }, h.ctx);
	h.beforeAgentStart("Later");
	const later = h.handlers.get("context")!({ messages: [user("Later", afterStop + 3)] }, h.ctx);
	assert.match(later.messages[0].content[0].text, /State Flow runtime context/);
	assert.doesNotMatch(JSON.stringify(later.messages), /exit handoff/);
});
