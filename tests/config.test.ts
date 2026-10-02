import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadStateFlowConfig } from "../lib/config.ts";
import { captureTemporalFileBases } from "../lib/durable.ts";
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
		directory: f.repositoryRoot, mode: "off", inactiveMode: "off", logging: false, showSuccessfulPatches: true, historyLimit: 7,
	});
	assert.equal(existsSync(f.path), false);
	for (const [value, mode, inactiveMode] of [
		[{ mode: "active" }, "active", "passive"], [{ mode: "passive" }, "passive", "passive"], [{ mode: "off" }, "off", "off"],
		[{ logging: true, showSuccessfulPatches: false }, "off", "off"], [{ historyLimit: 0 }, "off", "off"], [{ historyLimit: 12 }, "off", "off"],
	] as const) {
		f.write(value);
		const bytes = readFileSync(f.path);
		assert.deepEqual(loadStateFlowConfig(f.agentDir), {
			directory: f.repositoryRoot,
			mode,
			inactiveMode,
			logging: "logging" in value,
			showSuccessfulPatches: !("showSuccessfulPatches" in value),
			historyLimit: "historyLimit" in value ? value.historyLimit : 7,
		});
		assert.deepEqual(readFileSync(f.path), bytes);
	}
});

test("legacy autoStart/passive flags map read-only to the default mode; explicit mode is authoritative", (t) => {
	const f = fixture(t);
	for (const [value, mode, inactiveMode] of [
		[{}, "off", "off"],
		[{ autoStart: false }, "passive", "passive"],
		[{ autoStart: true }, "active", "passive"],
		[{ autoStart: true, passiveBootstrap: false, passiveTools: false }, "active", "off"],
		[{ passiveBootstrap: false, passiveTools: false }, "off", "off"],
		[{ passiveBootstrap: true, passiveTools: false }, "passive", "passive"],
		[{ passiveBootstrap: false, passiveTools: true }, "passive", "passive"],
		[{ passiveTools: false }, "passive", "passive"],
		[{ mode: "passive", autoStart: true }, "passive", "passive"],
		[{ mode: "active", passiveBootstrap: false, passiveTools: false }, "active", "passive"],
		[{ mode: "off", autoStart: true, passiveTools: true }, "off", "off"],
	] as const) {
		f.write(value);
		const bytes = readFileSync(f.path);
		const config = loadStateFlowConfig(f.agentDir);
		assert.deepEqual([config.mode, config.inactiveMode], [mode, inactiveMode], JSON.stringify(value));
		assert.deepEqual(readFileSync(f.path), bytes, "compatibility mapping never rewrites operator configuration");
	}
});

test("invalid configuration fails before extension registration or state writes, including broken links", (t) => {
	const f = fixture(t);
	const untouched = new Proxy({}, { get() { assert.fail("invalid configuration must fail before registration"); } });
	for (const value of [null, [], true, { directory: "../elsewhere" }, { autoStart: "true" }, { autoStart: null }, { passiveBootstrap: "true" }, { passiveTools: null }, { enabled: true },
		{ mode: "on" }, { mode: "Active" }, { mode: null }, { mode: true }, { passive: true },
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

test("load-time default mode controls new sessions, not resumed branch mode", async (t) => {
	const f = fixture(t);
	f.write({ mode: "active" });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const options = { agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured" as const,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "first" };
	const h = harness(options);
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.repositoryRoot, f.repositoryRoot);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	await h.beginRun("Automatic");
	await commitTerminal(h, {}, { retained: true });
	await h.commands.get("state-flow-off").handler("", h.ctx);
	const stopped = structuredClone(h.entries);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { mode: "active" });
	const resumed = harness(options);
	resumed.entries.push(...stopped);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.throws(() => resumed.readState(), /temporal runtime is unavailable/);
	f.write({ mode: "off" });
	// An existing registration retains its settings until reload, even for another new session.
	h.entries.splice(0);
	h.ctx.sessionManager.getSessionId = () => "before-reload";
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	const reloaded = harness({ ...options, sessionId: "after-reload" });
	await reloaded.handlers.get("session_start")!({ reason: "new" }, reloaded.ctx);
	assert.equal(reloaded.activeTools.includes("patch_state"), false);
	assert.deepEqual(reloaded.entries.map(({ data }) => data), [{ mode: "off" }]);
});

test("without configuration a new session defaults to Off without manufacturing storage", async (t) => {
	const f = fixture(t);
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured",
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "default-off" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.deepEqual(["read_state", "patch_state"].map((name) => h.activeTools.includes(name)), [false, false]);
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(h.entries.map(({ data }) => data), [{ mode: "off" }], "the inherited default becomes session-owned without semantic storage");
	assert.equal(existsSync(join(f.repositoryRoot, "checkpoint.json")), false);
	assert.equal(existsSync(f.path), false);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.deepEqual(["read_state", "patch_state"].map((name) => h.activeTools.includes(name)), [true, true]);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>passive</dim>");
	assert.equal(existsSync(join(f.repositoryRoot, "checkpoint.json")), false);
});

for (const reason of ["new", "resume"] as const) for (const mode of ["off", "passive"] as const) test(`pre-runtime ${mode} is retained independently of later defaults (${reason})`, async (t) => {
	const f = fixture(t);
	f.write({ mode });
	const options = { agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured" as const,
		initializeRepository: false, cwd: join(f.root, "project"), sessionId: "pre-runtime" };
	const h = harness(options);
	const files = () => captureTemporalFileBases(options.cwd, options.sessionId, f.repositoryRoot);
	const before = files();
	await h.handlers.get("session_start")!({ reason }, h.ctx);
	const inherited = h.entries.length;
	await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
	assert.equal(h.entries.length, reason === "new" ? inherited : inherited + 1, "first explicit choice is saved only when no mode was retained");
	assert.deepEqual(h.entries.at(-1)!.data, { mode });
	const selected = structuredClone(h.entries);
	await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
	assert.deepEqual(h.entries, selected, "repeated selection is inert");
	assert.deepEqual(files(), before, "mode selection must not initialize semantic storage");
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { mode }, "session commands never edit the default");
	f.write({ mode: "active" });
	const reloaded = harness(options);
	reloaded.entries.push(...selected);
	await reloaded.handlers.get("session_start")!({ reason: "reload" }, reloaded.ctx);
	assert.equal(reloaded.activeTools.includes("patch_state"), mode === "passive");
	assert.deepEqual(reloaded.entries, selected);
	assert.deepEqual(files(), before);
	const next = harness({ ...options, sessionId: "next-session" });
	await next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	assert.equal(next.resolveSnapshot().config.mode, "active", "the changed default applies to a new session only");
});

test("configured historyLimit controls runtime folding and historical reads", async (t) => {
	const f = fixture(t);
	f.write({ mode: "active", historyLimit: 3 });
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured",
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
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured",
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
	const h = harness({ agentDir: f.agentDir, repositoryRoot: f.repositoryRoot, useConfiguredDirectory: true, mode: "configured",
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
	writeFileSync(join(override, "config.json"), JSON.stringify({ mode: "active" }));
	const path = process.env.PATH;
	process.env.PATH = f.root;
	t.after(() => { process.env.PATH = path; });
	const adjacentSource = join(f.agentDir, "unregistered-source.md");
	writeFileSync(adjacentSource, "source bytes");
	const h = harness({ agentDir: f.agentDir, repositoryRoot: override, initializeRepository: false, mode: "configured" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), true);
	h.beforeAgentStart("Sources");
	const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.equal(JSON.stringify(projected).includes(adjacentSource), false);
	assert.deepEqual(JSON.parse(readFileSync(join(override, "config.json"), "utf8")), { mode: "active" });
	assert.equal(existsSync(f.path), false);
});
