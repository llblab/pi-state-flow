import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureTemporalFileBases, sessionRuntimePaths } from "../lib/durable.ts";
import { commitTerminal, harness, start } from "./harness.ts";

import { withoutStoreIO } from "./store-io-spy.ts";

async function offBranch() {
	const source = harness({ initializeRepository: false });
	await start(source);
	await commitTerminal(source, {}, { retained: "PRIVATE" });
	await source.commands.get("state-flow-off")!.handler("", source.ctx);
	const resumed = harness({ initializeRepository: false, cwd: source.ctx.cwd, repositoryRoot: source.repositoryRoot });
	resumed.entries.push(...structuredClone(source.entries));
	return { source, resumed, files: () => captureTemporalFileBases(source.ctx.cwd, source.ctx.sessionManager.getSessionId(), source.repositoryRoot) };
}

test("new Off sessions and repeated reload/tree attachment perform no store I/O", async (t) => {
	const h = harness({ initializeRepository: false });
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		for (const reason of ["startup", "reload", "resume"]) await h.handlers.get("session_start")!({ reason }, h.ctx);
		await h.handlers.get("session_tree")!({}, h.ctx);
	});
	assert.deepEqual(h.entries.map(({ data }) => data), [{ mode: "off" }]);
	assert.deepEqual(h.notifications, []);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("read_state"), false);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "active");
});

for (const condition of ["retained", "expired", "malformed-store", "hostile-checkpoint"] as const) test(`resumed Off (${condition}) leaves memory untouched and suppresses recovery warnings`, async (t) => {
	const { source, resumed: h, files } = await offBranch();
	if (condition === "expired") h.entries.at(-1)!.data.boundary = "outside-retained-window";
	if (condition === "malformed-store") writeFileSync(sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot).runtime, "malformed runtime");
	if (condition === "hostile-checkpoint") h.entries.at(-1)!.data = {
		mode: "off",
		get boundary() { throw new Error("Semantic checkpoint inspected while Off"); },
		get step() { throw new Error("Semantic counter inspected while Off"); },
	};
	const before = files();
	await withoutStoreIO(t, source.repositoryRoot, async () => {
		for (const reason of ["resume", "reload", "startup"]) await h.handlers.get("session_start")!({ reason }, h.ctx);
		await h.handlers.get("session_tree")!({}, h.ctx);
	});
	assert.deepEqual(files(), before);
	assert.deepEqual(h.notifications, []);
	assert.equal(h.statuses.at(-1), undefined);
	assert.throws(() => h.readState(), /temporal runtime is unavailable/);
});

test("explicit Passive acquires the deferred retained boundary and persists its mode", async () => {
	const { resumed: h } = await offBranch();
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
	assert.equal(h.resolveSnapshot().config.mode, "passive");
	assert.equal(h.activeTools.includes("read_state"), true);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
	assert.equal(h.resolveSnapshot().config.mode, "passive");
});

test("explicit Active from a deferred Off branch does not rewind current private memory to an older valid boundary", async () => {
	const { source, resumed: h } = await offBranch();
	await source.commands.get("state-flow-active")!.handler("", source.ctx);
	await source.tools.get("patch_state")!.execute("new-current", { session: { working: { retained: "CURRENT" } } }, undefined, undefined, source.ctx);
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "CURRENT");
	assert.equal(h.resolveSnapshot().config.mode, "active");
});

test("a deferred old checkpoint never rewinds memory; explicit Passive or Active uses current same-session memory", async () => {
	const { resumed: h } = await offBranch();
	h.entries.at(-1)!.data.boundary = "outside-retained-window";
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.deepEqual(h.notifications, []);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
	assert.equal(h.resolveSnapshot().config.mode, "passive");
	await h.tools.get("patch_state")!.execute("passive", { session: { working: { passive: true } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
	assert.equal(h.resolveSnapshot().config.mode, "active");
});

test("fenced Off reload does not read memory; explicit Passive accepts current authority and clears its resolved fence", async (t) => {
	const { source, resumed: h, files } = await offBranch();
	await source.commands.get("state-flow-active")!.handler("", source.ctx);
	const lock = join(source.repositoryRoot, ".state-flow-publication.lock");
	mkdirSync(lock);
	await source.commands.get("state-flow-passive")!.handler("", source.ctx);
	await source.commands.get("state-flow-off")!.handler("", source.ctx);
	rmSync(lock, { recursive: true });
	h.entries.splice(0, h.entries.length, ...structuredClone(source.entries));
	const before = files();
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	});
	assert.deepEqual(h.notifications, []);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").working.retained, "PRIVATE");
	assert.equal(h.notifications.at(-1), "State Flow passive; memory writes resumed from current session memory.");
	const semantic = (cohort: ReturnType<typeof files>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));
	assert.deepEqual(semantic(files()), semantic(before), "acceptance never rewinds current semantics");
	assert.equal(h.entries.at(-1)!.data.mode, "passive");
	assert.equal(typeof h.entries.at(-1)!.data.boundary, "string");
	await h.tools.get("patch_state")!.execute("writable", { session: { working: { writable: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").working.writable, true);
});

for (const fenced of [false, true]) test(`Off defers fork acquisition across reload until explicit Passive (source fenced=${fenced})`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-off-fork-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd"), sessions = join(root, "sessions"), repositoryRoot = join(root, "store");
	for (const path of [cwd, sessions, repositoryRoot]) mkdirSync(path);
	const parentManager = SessionManager.create(cwd, sessions);
	const parent = harness({ cwd, repositoryRoot, initializeRepository: false, sessionId: parentManager.getSessionId(), sessionFile: parentManager.getSessionFile(), sessionTimestamp: parentManager.getHeader()!.timestamp });
	writeFileSync(parentManager.getSessionFile()!, `${JSON.stringify(parentManager.getHeader())}\n`);
	await start(parent);
	await commitTerminal(parent, {}, { retained: "PARENT" });
	const lock = join(repositoryRoot, ".state-flow-publication.lock");
	if (fenced) {
		mkdirSync(lock);
		await parent.commands.get("state-flow-passive")!.handler("", parent.ctx);
	}
	await parent.commands.get("state-flow-off")!.handler("", parent.ctx);
	if (fenced) rmSync(lock, { recursive: true });
	const manager = SessionManager.create(cwd, sessions);
	const header = { ...manager.getHeader()!, version: 3, parentSession: parentManager.getSessionFile()! };
	const childOptions = { cwd, repositoryRoot, initializeRepository: false, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionTimestamp: header.timestamp };
	let child = harness(childOptions);
	child.ctx.sessionManager.getHeader = () => header;
	child.entries.push(...structuredClone(parent.entries));
	await withoutStoreIO(t, root, async () => {
		await child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
		await child.handlers.get("session_start")!({ reason: "reload" }, child.ctx);
	});
	assert.deepEqual(child.notifications, []);
	// Recreate the extension, not merely its session hook, to prove durable deferred ownership.
	const entries = structuredClone(child.entries);
	child = harness(childOptions);
	child.ctx.sessionManager.getHeader = () => header;
	child.entries.push(...entries);
	await withoutStoreIO(t, root, async () => {
		await child.handlers.get("session_start")!({ reason: "startup" }, child.ctx);
	});
	await child.commands.get("state-flow-passive")!.handler("", child.ctx);
	assert.equal(child.readState(0, "session").working.retained, "PARENT");
	assert.equal(child.resolveSnapshot().config.mode, "passive");
});
