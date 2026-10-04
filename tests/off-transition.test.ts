import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { awaitInFlightBackupPushes } from "../lib/git.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureTemporalFileBases, resolveSessionAddress, sessionRuntimePaths } from "../lib/durable.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { findBranchPolicy } from "../lib/session.ts";
import { withStorageTransaction } from "../lib/storage.ts";
import { commitScopedTransition, stageAtomicScopePatches } from "../lib/transition.ts";
import { commitTerminal, harness, start } from "./harness.ts";
import { withoutStoreIO } from "./store-io-spy.ts";

async function holdStore(t: TestContext, root: string) {
	let entered!: () => void, unlock!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { unlock = resolve; });
	const operation = withStorageTransaction(root, async () => { entered(); await gate; });
	t.after(async () => { unlock(); await operation; });
	await ready;
	return async () => { unlock(); await operation; };
}

function policy(h: ReturnType<typeof harness>) {
	return findBranchPolicy(h.entries, h.ctx.sessionManager.getSessionId(), "state-flow-passive-stop", "off");
}

for (const fault of ["healthy", "locked", "malformed", "peer-advanced", "cached-bookmark"] as const) test(`Off selects native policy without touching ${fault} canonical memory`, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { retained: "ACCEPTED" });
	const paths = sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
	if (fault === "locked") mkdirSync(lock);
	if (fault === "malformed") writeFileSync(paths.runtime, "malformed runtime");
	if (fault === "cached-bookmark") t.mock.method(TemporalRuntime.prototype, "retainedCheckpoint", () => { throw new Error("Unusable cached counter"); });
	if (fault === "peer-advanced") {
		const peer = harness({ initializeRepository: false, cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot });
		peer.entries.push(...structuredClone(h.entries));
		await peer.handlers.get("session_start")!({ reason: "resume" }, peer.ctx);
		await peer.tools.get("patch_state")!.execute("peer", { session: { working: { retained: "PEER" } } }, undefined, undefined, peer.ctx);
	}
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const notices = [...h.notifications];
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		const entryCount = h.entries.length;
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		assert.equal(h.entries.length, entryCount, "repeated Off must be native-inert too");
	});
	assert.deepEqual(files(), before);
	assert.deepEqual(h.notifications, notices, "Off neither validates memory nor emits recovery warnings");
	assert.deepEqual(policy(h), { mode: "off" });
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.throws(() => h.readState(), /temporal runtime is unavailable/);
	assert.deepEqual(JSON.parse(readFileSync(paths.config, "utf8")), { mode: "active" }, "native Off need not rewrite canonical runtime policy");
	if (fault === "locked") rmSync(lock, { recursive: true });
	if (fault === "peer-advanced") {
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal(h.readState(0, "session").working.retained, "PEER");
	}
});

test("Off cannot carry a former physical owner's cache or write fence into another owner", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { retained: "OLD-OWNER" });
	const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
	mkdirSync(lock);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	rmSync(lock, { recursive: true });
	assert.ok(h.entries.at(-1)!.data.persistenceError);
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	h.ctx.sessionManager.getSessionId = () => "different-owner";
	await withoutStoreIO(t, h.repositoryRoot, async () => { await h.commands.get("state-flow-off")!.handler("", h.ctx); });
	assert.deepEqual(policy(h), { mode: "off" });
	assert.deepEqual(files(), before);
	assert.equal(h.entries.at(-1)!.data.owner, "different-owner");
	assert.equal(h.entries.at(-1)!.data.persistenceError, undefined);
});

for (const kind of ["restoration", "passive", "activation", "patch", "response", "preparation", "auto-start"] as const) test(`Off cancels ${kind} before lock release and late work cannot publish`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: kind === "auto-start" ? "active" : "off" });
	if (kind !== "auto-start") {
		await start(h);
		await commitTerminal(h, {}, { retained: "ACCEPTED" });
	}
	if (kind === "activation") await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const release = await holdStore(t, h.repositoryRoot);
	let operation: Promise<unknown>;
	if (kind === "restoration" || kind === "auto-start") operation = h.handlers.get("session_start")!({ reason: kind === "auto-start" ? "new" : "resume" }, h.ctx);
	else if (kind === "passive") operation = h.commands.get("state-flow-passive")!.handler("", h.ctx);
	else if (kind === "activation") operation = h.commands.get("state-flow-active")!.handler("", h.ctx);
	else if (kind === "patch") operation = h.tools.get("patch_state")!.execute("pending", { session: { working: { forbidden: true } } }, undefined, undefined, h.ctx);
	else if (kind === "preparation") {
		h.beforeAgentStart("Unaccepted specification");
		operation = h.inferenceContext();
	} else {
		const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unaccepted response" }] };
		h.handlers.get("message_end")!({ message }, h.ctx);
		operation = h.handlers.get("turn_end")!({ message }, h.ctx);
	}
	const settled = Promise.resolve(operation).then(() => undefined, () => undefined);
	await delay(40);
	const notices = [...h.notifications];
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		await Promise.race([settled, delay(500).then(() => assert.fail("Off still joins obsolete memory work"))]);
		await delay(40);
	});
	await release();
	await withoutStoreIO(t, h.repositoryRoot, async () => { await delay(40); });
	assert.deepEqual(files(), before, "no late callback may publish after Off");
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(policy(h), { mode: "off" });
	assert.equal(h.statuses.at(-1), undefined);
	assert.throws(() => h.readState(), /temporal runtime is unavailable/);
});

for (const next of ["passive", "abort-passive", "abort-active"] as const) for (const history of ["retained", "expired"] as const) test(`unaccepted Active from Off leaves current memory for ${next} (${history} checkpoint)`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { retained: "SELECTED-OLD" });
	const snapshot = h.resolveSnapshot();
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const peer = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
	await peer.withStartTransaction((current, publish) => { assert.ok(current); publish(current); });
	const advances = history === "expired" ? 9 : 1;
	for (let index = 1; index <= advances; index++) await peer.withPatchTransaction((tx) => {
		const stage = stageAtomicScopePatches(tx.states, { session: { working: { retained: `CURRENT-${index}` } } }, [], tx.causalBasis);
		commitScopedTransition(snapshot, tx.states, stage, (accepted, next) => tx.publish(next, accepted), tx.causalBasis);
	});
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files(), entries = structuredClone(h.entries), notices = [...h.notifications];
	const release = await holdStore(t, h.repositoryRoot);
	const controller = new AbortController();
	const starting = h.commands.get("state-flow-active")!.handler("", { ...h.ctx, signal: controller.signal });
	await delay(40);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries, "pending Active cannot replace the deferred native selection");
	let selected: Promise<unknown>;
	if (next === "passive") selected = h.commands.get("state-flow-passive")!.handler("", h.ctx);
	else {
		controller.abort();
		await starting;
		assert.deepEqual(files(), before);
		assert.deepEqual(h.entries, entries);
		assert.deepEqual(h.notifications, notices, "cancelled acquisition must not report a recovery failure");
		selected = h.commands.get(next === "abort-active" ? "state-flow-active" : "state-flow-passive")!.handler("", h.ctx);
	}
	await release();
	await starting;
	await selected;
	if (next === "abort-active") {
		assert.equal(h.readState(0, "session").working.retained, `CURRENT-${advances}`);
		assert.equal(policy(h)?.mode, "active");
	} else {
		// Memory is the current JSON state regardless of the deferred Pi step.
		assert.equal(h.readState(0, "session").working.retained, `CURRENT-${advances}`);
		assert.deepEqual(policy(h), { mode: "passive" });
		await h.tools.get("patch_state")!.execute("after-recovery", { session: { working: { writable: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").working.writable, true);
	}
	assert.equal(h.notifications.some((notice) => /branch restoration is pending/.test(notice)), false, "pending work is not a persistence failure");
});

test("cancelled Active after cold pre-runtime Off preserves native-only Passive and later origin creation", async (t) => {
	const h = harness({ initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files(), entries = structuredClone(h.entries);
	const release = await holdStore(t, h.repositoryRoot);
	const controller = new AbortController();
	const starting = h.commands.get("state-flow-active")!.handler("", { ...h.ctx, signal: controller.signal });
	controller.abort();
	await starting;
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, []);
	await release();
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.deepEqual(policy(h), { mode: "passive" });
	assert.deepEqual(files(), before, "Passive must not accept an origin from cancelled Active");
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.activeTools.includes("patch_state"), true);
});

test("Off cancels pending settled backup capture without reading or committing canonical files", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { retained: "ACCEPTED" });
	execFileSync("git", ["-C", h.repositoryRoot, "init", "-b", "main"], { stdio: "ignore" });
	const ctx = { ...h.ctx, signal: new AbortController().signal };
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files(), notices = [...h.notifications];
	const release = await holdStore(t, h.repositoryRoot);
	const operation = Promise.resolve(h.handlers.get("agent_before_settle")!({}, ctx));
	const mutex = join(h.repositoryRoot, ".git", "state-flow-backup.lock");
	assert.equal(readFileSync(mutex, "utf8"), `${process.pid}\n`);
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		await Promise.race([operation, delay(1_000).then(() => { throw new Error("Off did not cancel backup capture"); })]);
		await h.handlers.get("agent_before_settle")!({}, h.ctx);
	}, [mutex]);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.notifications, notices);
	assert.equal(existsSync(mutex), false, "cancellation releases only its already-owned backup mutex");
	assert.throws(() => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "--verify", "HEAD"], { stdio: "pipe" }), /Needed a single revision/, "no backup commit was accepted");
	await release();
});

test("Off owns asynchronous push cancellation independently of the completed agent operation", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { retained: "ACCEPTED" });
	const git = (...args: string[]) => execFileSync("git", ["-C", h.repositoryRoot, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "State Flow Test");
	git("config", "user.email", "state-flow@example.invalid");
	git("remote", "add", "origin", "https://do-not-contact.invalid/store.git");
	git("config", "branch.main.remote", "origin");
	git("config", "branch.main.merge", "refs/heads/main");
	const operation = new AbortController();
	const ctx = { ...h.ctx, signal: operation.signal };
	const child: any = Object.assign(new EventEmitter(), { pid: Number.MAX_SAFE_INTEGER, exitCode: null, signalCode: null, stderr: new PassThrough() });
	const kills: number[] = [];
	const terminate = (pid: number) => {
		kills.push(pid);
		child.signalCode = "SIGKILL";
		child.emit("exit", null, "SIGKILL");
		child.emit("close", null, "SIGKILL");
		return true;
	};
	child.kill = () => terminate(child.pid);
	t.after(async () => { child.emit("close", 0); await awaitInFlightBackupPushes(h.repositoryRoot); syncBuiltinESMExports(); });
	t.mock.method(process, "kill", terminate);
	let pushes = 0;
	t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
		assert.equal(command, "git");
		assert.ok(args.includes("push"));
		pushes++;
		return child;
	});
	syncBuiltinESMExports();
	await h.handlers.get("agent_before_settle")!({}, ctx);
	assert.equal(pushes, 1);
	const head = git("rev-parse", "HEAD");
	const before = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), notices = [...h.notifications];
	operation.abort();
	assert.deepEqual(kills, [], "a completed operation cannot revoke the independent admitted push");
	await withoutStoreIO(t, h.repositoryRoot, async () => {
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		assert.equal(kills.length, 1, "Off terminates exactly its admitted child");
		assert.equal(Math.abs(kills[0]!), child.pid);
		await awaitInFlightBackupPushes(h.repositoryRoot);
	});
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	assert.equal(git("rev-parse", "HEAD"), head, "an already accepted local backup is not rolled back");
	assert.deepEqual(h.notifications, notices, "cancelled push reporting is silent");
});

test("Off cancels pending fork copying and a cold Passive selection later acquires only the selected source", { timeout: 5_000 }, async (t) => {
	const parent = harness({ initializeRepository: false });
	const cwd = parent.ctx.cwd, repositoryRoot = parent.repositoryRoot;
	const sessions = join(repositoryRoot, "native-sessions");
	mkdirSync(sessions);
	const manager = SessionManager.create(cwd, sessions);
	const header = manager.getHeader()!;
	const source = harness({ cwd, repositoryRoot, initializeRepository: false, sessionId: header.id, sessionFile: manager.getSessionFile(), sessionTimestamp: header.timestamp });
	writeFileSync(manager.getSessionFile()!, `${JSON.stringify(header)}\n`);
	await start(source);
	await commitTerminal(source, {}, { retained: "SELECTED-PARENT" });
	const childManager = SessionManager.create(cwd, sessions);
	const childHeader = { ...childManager.getHeader()!, version: 3, parentSession: manager.getSessionFile()! };
	const options = { cwd, repositoryRoot, initializeRepository: false, sessionId: childHeader.id, sessionFile: childManager.getSessionFile(), sessionTimestamp: childHeader.timestamp };
	let child = harness(options);
	child.ctx.sessionManager.getHeader = () => childHeader;
	child.entries.push(...structuredClone(source.entries));
	const childKey = resolveSessionAddress(childManager.getSessionFile(), childHeader.id, childHeader.timestamp).key;
	const childFiles = () => captureTemporalFileBases(cwd, childHeader.id, repositoryRoot, childKey);
	// Canonical parent bytes also include shared scopes; child cancellation cannot alter any of them.
	const parentKey = resolveSessionAddress(manager.getSessionFile(), header.id, header.timestamp).key;
	const parentFiles = () => captureTemporalFileBases(cwd, header.id, repositoryRoot, parentKey);
	const before = parentFiles(), beforeChild = childFiles();
	const release = await holdStore(t, repositoryRoot);
	const copying = Promise.resolve(child.handlers.get("session_start")!({ reason: "fork" }, child.ctx));
	await delay(40);
	await withoutStoreIO(t, repositoryRoot, async () => {
		await child.commands.get("state-flow-off")!.handler("", child.ctx);
		await Promise.race([copying, delay(500).then(() => assert.fail("Off did not cancel its fork"))]);
	});
	await release();
	assert.deepEqual(parentFiles(), before);
	assert.deepEqual(childFiles(), beforeChild);
	assert.ok(child.entries.some((entry) => entry.data?.forkPending === true));
	const entries = structuredClone(child.entries);
	child = harness(options);
	child.ctx.sessionManager.getHeader = () => childHeader;
	child.entries.push(...entries);
	await withoutStoreIO(t, repositoryRoot, async () => { await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx); });
	await child.commands.get("state-flow-passive")!.handler("", child.ctx);
	assert.equal(child.readState(0, "session").working.retained, "SELECTED-PARENT");
	assert.deepEqual(parentFiles(), before);
	// A later unacquired child may own its own failure fence; it must not be confused with a parent's fence.
	const fencedManager = SessionManager.create(cwd, sessions);
	const fencedHeader = { ...fencedManager.getHeader()!, version: 3, parentSession: manager.getSessionFile()! };
	const fencedOptions = { cwd, repositoryRoot, initializeRepository: false, sessionId: fencedHeader.id, sessionFile: fencedManager.getSessionFile(), sessionTimestamp: fencedHeader.timestamp };
	let fenced = harness(fencedOptions);
	fenced.ctx.sessionManager.getHeader = () => fencedHeader;
	fenced.entries.push(...structuredClone(source.entries));
	await fenced.commands.get("state-flow-off")!.handler("", fenced.ctx);
	await fenced.handlers.get("session_start")!({ reason: "fork" }, fenced.ctx);
	for (let index = 0; index < 9; index++) {
		await source.tools.get("patch_state")!.execute(`expire-${index}`, { session: { working: { index } } }, undefined, undefined, source.ctx);
	}
	await fenced.commands.get("state-flow-passive")!.handler("", fenced.ctx);
	// The fork copies the parent's current memory; an old fork step cannot fence the child.
	assert.equal(fenced.readState(0, "session").working.index, 8);
	await fenced.commands.get("state-flow-off")!.handler("", fenced.ctx);
	const fencedEntries = structuredClone(fenced.entries);
	fenced = harness(fencedOptions);
	fenced.ctx.sessionManager.getHeader = () => fencedHeader;
	fenced.entries.push(...fencedEntries);
	await withoutStoreIO(t, repositoryRoot, async () => {
		await fenced.handlers.get("session_start")!({ reason: "resume" }, fenced.ctx);
		assert.deepEqual(fenced.notifications, []);
		await fenced.commands.get("state-flow-status")!.handler("", fenced.ctx);
	});
	assert.doesNotMatch(fenced.notifications.at(-1)!, /Memory writes paused after mode change/);
});
