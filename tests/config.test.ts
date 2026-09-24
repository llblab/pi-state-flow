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
		directory: f.repositoryRoot, autoStart: false, passiveBootstrap: true, passiveTools: true, logging: false, showSuccessfulPatches: true, historyLimit: 7,
	});
	assert.equal(existsSync(f.path), false);
	for (const value of [
		{ autoStart: true }, { passiveBootstrap: false, passiveTools: false }, { logging: true, showSuccessfulPatches: false }, { historyLimit: 0 }, { historyLimit: 12 },
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
			historyLimit: value.historyLimit ?? 7,
		});
		assert.deepEqual(readFileSync(f.path), bytes);
	}
});

test("invalid configuration fails before extension registration or state writes, including broken links", (t) => {
	const f = fixture(t);
	const untouched = new Proxy({}, { get() { assert.fail("invalid configuration must fail before registration"); } });
	for (const value of [null, [], true, { directory: "../elsewhere" }, { autoStart: "true" }, { autoStart: null }, { passiveBootstrap: "true" }, { passiveTools: null }, { enabled: true },
		{ memoryOwner: "none" }, { memoryOwner: true }, { globalMemory: "false" }, { globalMemory: null },
		{ remotePublication: "off" }, { remotePublication: "turn-end" }, { remotePublication: "async" }, { remotePublication: "transition" }, { remotePublication: true },
		{ logging: "true" }, { logging: 1 }, { logging: null },
		{ showSuccessfulPatches: "true" }, { showSuccessfulPatches: 1 }, { showSuccessfulPatches: null },
		{ historyLimit: -1 }, { historyLimit: 101 }, { historyLimit: 1.5 }, { historyLimit: "7" }]) {
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
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.repositoryRoot, f.repositoryRoot);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	await h.beginRun("Automatic");
	await commitTerminal(h, {}, { retained: true });
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const stopped = structuredClone(h.entries);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { autoStart: true });
	const resumed = harness(options);
	resumed.entries.push(...stopped);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.equal(resumed.readState().working.retained, true);
	f.write({ autoStart: false });
	// An existing registration retains its settings until reload, even for another new session.
	h.entries.splice(0);
	h.ctx.sessionManager.getSessionId = () => "before-reload";
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	const reloaded = harness({ ...options, sessionId: "after-reload" });
	await reloaded.handlers.get("session_start")!({ reason: "new" }, reloaded.ctx);
	assert.equal(reloaded.activeTools.includes("patch_state"), false);
	assert.equal(reloaded.entries.length, 0);
});

test("configured historyLimit controls runtime folding and historical reads", async (t) => {
	const f = fixture(t);
	f.write({ autoStart: true, historyLimit: 3 });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "limited" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	for (let index = 1; index <= 5; index++) {
		await h.beginRun(`Iteration ${index}`);
		await commitTerminal(h, {}, { index }, `Answer ${index}`);
	}
	assert.equal(h.readState(3).working.index, 4);
	assert.throws(() => h.readState(4), /integer from 0 to 3/);
});

for (const historyLimit of [0, 1, 7, 12]) test(`scope patch-history reads honor configured historyLimit ${historyLimit}`, async (t) => {
	const f = fixture(t);
	f.write({ autoStart: true, historyLimit });
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "patch-history" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.beginRun("Build retained history");
	for (let index = 1; index <= historyLimit + 1; index++) {
		await h.tools.get("patch_state")!.execute(`patch-${index}`, {
			global: { working: { index } }, cwd: { working: { index } }, session: { working: { index } },
		}, undefined, undefined, h.ctx);
	}
	const entries = h.entries.length;
	const read = async (params: { path: string } | { paths: string[] }) => {
		const result = await h.tools.get("read_state")!.execute("read", params, undefined, undefined, h.ctx);
		return JSON.parse(result.content[0].text);
	};
	for (const scope of ["global", "cwd", "session"]) {
		assert.equal((await read({ path: `${scope}[${historyLimit}].working.index` })).value, 1);
		for (const offset of new Set([0, 7, 8, historyLimit - 1].filter((index) => index >= 0 && index < historyLimit))) {
			const path = `${scope}.patches[${offset}]`;
			const expected = { patch: { working: { index: historyLimit + 1 - offset } } };
			assert.deepEqual(await read({ path }), expected);
			assert.deepEqual(await read({ paths: [path] }), expected);
		}
		if (historyLimit > 0) assert.equal((await read({ path: `${scope}.patches` })).patch.working.index, historyLimit + 1);
		await assert.rejects(read({ path: `${scope}.patches[${historyLimit}]` }), /predates retained hot history/);
		await assert.rejects(read({ path: `${scope}.patches[${historyLimit + 1}]` }), new RegExp(`integer from 0 to ${historyLimit}`));
	}
	assert.equal(h.entries.length, entries, "historical observation must not publish another checkpoint");
});

test("historyLimit zero retains only current state through runtime publication", async (t) => {
	const f = fixture(t);
	f.write({ autoStart: true, historyLimit: 0 });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "current-only" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	for (let index = 1; index <= 2; index++) {
		await h.beginRun(`Iteration ${index}`);
		await commitTerminal(h, {}, { index }, `Answer ${index}`);
	}
	assert.equal(h.readState(0).working.index, 2);
	assert.equal(h.readState(0).response, "Answer 2");
	assert.throws(() => h.readState(1), /integer from 0 to 0/);
});

test("SDK storage override selects its own repository-global configuration without scanning adjacent sources", async (t) => {
	const f = fixture(t);
	const override = join(f.root, "override");
	mkdirSync(override);
	writeFileSync(join(override, "config.json"), JSON.stringify({ autoStart: true }));
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const adjacentSource = join(f.agentDir, "unregistered-source.md");
	writeFileSync(adjacentSource, "source bytes");
	const h = harness({ agentDir: f.agentDir, repositoryRoot: override, initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	h.beforeAgentStart("Sources");
	const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.equal(JSON.stringify(projected).includes(adjacentSource), false);
	assert.deepEqual(JSON.parse(readFileSync(join(override, "config.json"), "utf8")), { autoStart: true });
	assert.equal(existsSync(f.path), false);
});
