import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadStateFlowConfig } from "../lib/config.ts";
import stateFlowExtension from "../lib/extension.ts";
import { commitTerminal, harness } from "./harness.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const repositoryRoot = join(agentDir, "state-flow");
	mkdirSync(repositoryRoot, { recursive: true });
	const path = join(repositoryRoot, "config.json");
	return { root, agentDir, repositoryRoot, path, write: (value: unknown) => writeFileSync(path, JSON.stringify(value)) };
}

test("configuration is optional, read-only, and lives at the global repository root", (t) => {
	const f = fixture(t);
	assert.deepEqual(loadStateFlowConfig(f.agentDir), {
		directory: f.repositoryRoot, autoStart: false, passiveBootstrap: true, passiveTools: true, logging: false, showSuccessfulPatches: true,
	});
	assert.equal(existsSync(f.path), false);
	for (const value of [
		{ autoStart: true }, { passiveBootstrap: false, passiveTools: false }, { remotePublication: "off" as const }, { logging: true, showSuccessfulPatches: false },
	]) {
		f.write(value);
		const bytes = readFileSync(f.path);
		assert.deepEqual(loadStateFlowConfig(f.agentDir), {
			directory: f.repositoryRoot,
			autoStart: value.autoStart === true,
			passiveBootstrap: value.passiveBootstrap !== false,
			passiveTools: value.passiveTools !== false,
			logging: value.logging === true,
			showSuccessfulPatches: value.showSuccessfulPatches !== false,
			...(value.remotePublication === undefined ? {} : { remotePublication: value.remotePublication }),
		});
		assert.deepEqual(readFileSync(f.path), bytes);
	}
});

test("invalid configuration fails before extension registration or state writes, including broken links", (t) => {
	const f = fixture(t);
	const untouched = new Proxy({}, { get() { assert.fail("invalid configuration must fail before registration"); } });
	for (const value of [null, [], true, { directory: "../elsewhere" }, { autoStart: "true" }, { autoStart: null }, { passiveBootstrap: "true" }, { passiveTools: null }, { enabled: true },
		{ memoryOwner: "none" }, { memoryOwner: true }, { globalMemory: "false" }, { globalMemory: null },
		{ remotePublication: "async" }, { remotePublication: true },
		{ logging: "true" }, { logging: 1 }, { logging: null },
		{ showSuccessfulPatches: "true" }, { showSuccessfulPatches: 1 }, { showSuccessfulPatches: null }]) {
		f.write(value);
		assert.throws(() => stateFlowExtension(untouched as any, { agentDir: f.agentDir }), /State Flow/);
		assert.equal(existsSync(join(f.repositoryRoot, "checkpoint.json")), false);
	}
	writeFileSync(f.path, "{broken");
	assert.throws(() => loadStateFlowConfig(f.agentDir), /Cannot read State Flow configuration/);
	rmSync(f.path);
	symlinkSync(join(f.root, "missing.json"), f.path);
	assert.throws(() => loadStateFlowConfig(f.agentDir), /Cannot read State Flow configuration/);
});

test("load-time auto-start controls new sessions, not resumed branch mode", async (t) => {
	const f = fixture(t);
	f.write({ autoStart: true });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const options = { agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "first" };
	const h = harness(options);
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.repositoryRoot, f.repositoryRoot);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	h.handlers.get("before_agent_start")!({ prompt: "Automatic", systemPrompt: "base" }, h.ctx);
	await commitTerminal(h, {}, { retained: true });
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const stopped = structuredClone(h.entries);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { autoStart: true });
	const resumed = harness(options);
	resumed.entries.push(...stopped);
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.equal(resumed.readState().working.retained, true);
	f.write({ autoStart: false });
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

test("SDK storage override selects its own repository-global configuration without redirecting sources", (t) => {
	const f = fixture(t);
	const override = join(f.root, "override");
	mkdirSync(override);
	writeFileSync(join(override, "config.json"), JSON.stringify({ autoStart: true }));
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	mkdirSync(join(f.agentDir, "knowledge"));
	writeFileSync(join(f.agentDir, "knowledge", "source.md"), "source bytes");
	const h = harness({ agentDir: f.agentDir, repositoryRoot: override, useDefaultKnowledgeRoot: true, initializeRepository: false });
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	h.handlers.get("before_agent_start")!({ prompt: "Sources", systemPrompt: "base" }, h.ctx);
	const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.ok(JSON.stringify(projected).includes(join(f.agentDir, "knowledge", "source.md")));
	assert.deepEqual(JSON.parse(readFileSync(join(override, "config.json"), "utf8")), { autoStart: true });
	assert.equal(existsSync(f.path), false);
});
