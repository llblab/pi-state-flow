import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { loadStateFlowConfig } from "../lib/config.ts";
import stateFlowExtension from "../lib/extension.ts";
import { commitTerminal, harness } from "./harness.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const path = join(agentDir, "state-flow.json");
	return { root, agentDir, path, write: (value: unknown) => writeFileSync(path, JSON.stringify(value)) };
}

test("configuration is optional, read-only and resolves storage independently of its own fixed location", (t) => {
	const f = fixture(t);
	assert.deepEqual(loadStateFlowConfig(f.agentDir), { directory: join(f.agentDir, "state-flow"), autoStart: false });
	assert.equal(existsSync(f.path), false);
	assert.equal(existsSync(join(f.agentDir, "state-flow")), false);
	for (const [directory, expected] of [
		[undefined, join(f.agentDir, "state-flow")], ["../debug store", join(f.root, "debug store")],
		[join(f.root, "absolute"), join(f.root, "absolute")], ["~/debug", join(homedir(), "debug")], ["~", homedir()],
	] as const) {
		f.write({ ...(directory === undefined ? {} : { directory }), autoStart: true });
		const bytes = readFileSync(f.path);
		assert.deepEqual(loadStateFlowConfig(f.agentDir), { directory: resolve(expected), autoStart: true });
		assert.deepEqual(readFileSync(f.path), bytes);
	}
	f.write({});
	assert.equal(loadStateFlowConfig(f.agentDir).autoStart, false);
});

test("invalid configuration fails before extension registration or state writes, including broken links", (t) => {
	const f = fixture(t);
	const untouched = new Proxy({}, { get() { assert.fail("invalid configuration must fail before registration"); } });
	for (const value of [null, [], true, { autoStart: "true" }, { autoStart: null }, { enabled: true },
		{ directory: "" }, { directory: " " }, { directory: 7 }, { directory: null }, { directory: "a\0b" }, { directory: "~someone/store" }]) {
		f.write(value);
		assert.throws(() => stateFlowExtension(untouched as any, { agentDir: f.agentDir }), /State Flow/);
		assert.equal(existsSync(join(f.agentDir, "state-flow")), false);
	}
	writeFileSync(f.path, "{broken");
	assert.throws(() => loadStateFlowConfig(f.agentDir), /Cannot read State Flow configuration/);
	rmSync(f.path);
	symlinkSync(join(f.root, "missing.json"), f.path);
	assert.throws(() => loadStateFlowConfig(f.agentDir), /Cannot read State Flow configuration/);
});

test("configured paths and load-time auto-start control new sessions, not resumed branch mode", async (t) => {
	const f = fixture(t);
	f.write({ directory: "../custom-state", autoStart: true });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const options = { agentDir: f.agentDir, repositoryRoot: join(f.root, "unused"), useConfiguredDirectory: true,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "first" };
	const h = harness(options);
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.repositoryRoot, join(f.root, "custom-state"));
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	assert.equal(existsSync(join(f.root, "unused")), false);
	assert.equal(existsSync(join(f.agentDir, "state-flow")), false);
	assert.equal(existsSync(join(h.repositoryRoot, ".git")), false);
	h.handlers.get("before_agent_start")!({ prompt: "Automatic", systemPrompt: "base" }, h.ctx);
	commitTerminal(h, {}, { retained: true });
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const stopped = structuredClone(h.entries);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { directory: "../custom-state", autoStart: true });
	const resumed = harness(options);
	resumed.entries.push(...stopped);
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.equal(resumed.readState().working.retained, true);
	f.write({ directory: "../custom-state", autoStart: false });
	// An existing registration retains its settings until reload, even for another new session.
	h.entries.splice(0);
	h.ctx.sessionManager.getSessionId = () => "before-reload";
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	const reloaded = harness({ ...options, sessionId: "after-reload" });
	reloaded.handlers.get("session_start")!({ reason: "new" }, reloaded.ctx);
	assert.equal(reloaded.activeTools.includes("patch_state"), false);
	assert.equal(reloaded.entries.length, 0);
});

test("SDK storage override wins without redirecting sources or rewriting configuration", (t) => {
	const f = fixture(t);
	f.write({ directory: "../configured", autoStart: true });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	mkdirSync(join(f.agentDir, "knowledge"));
	writeFileSync(join(f.agentDir, "knowledge", "source.md"), "source bytes");
	const h = harness({ agentDir: f.agentDir, repositoryRoot: join(f.root, "override"), useDefaultKnowledgeRoot: true, initializeRepository: false });
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	assert.equal(existsSync(join(f.root, "configured")), false);
	h.handlers.get("before_agent_start")!({ prompt: "Sources", systemPrompt: "base" }, h.ctx);
	const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.ok(JSON.stringify(projected).includes(join(f.agentDir, "knowledge", "source.md")));
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { directory: "../configured", autoStart: true });
});
