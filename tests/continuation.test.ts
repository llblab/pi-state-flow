import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	buildContinuationCandidates,
	discoverNativeSessionHeaders,
	inspectStateFlowContinuationProvenance,
	readNativeSessionHeader,
	recommendContinuationFromProvenance,
	resolveContinuationStartup,
	type ContinuationCandidateProvenance,
	type ContinuationHostContext,
	type ContinuationProjectIdentity,
	type ContinuationSessionCandidate,
} from "../lib/continuation.ts";
import { captureTemporalFileBases, resolveSessionAddress, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { createSessionRuntime, emptySnapshot } from "../lib/snapshot.ts";
import { advanceTemporalState } from "../lib/temporal.ts";
import { realPiFixture } from "./pi-harness.ts";

const context: ContinuationHostContext = {
	cwd: "/workspace/project",
	agentDir: "/profile/agent",
	sessionDir: "/profile/sessions/project",
	transport: "local",
};

const identity: ContinuationProjectIdentity = {
	profile: "/profile/agent", cwd: "/workspace/project", gitCommonDir: "/repo/.git",
	worktree: "/workspace/project", branch: "main", transport: "local",
};

function candidate(overrides: Partial<ContinuationSessionCandidate> = {}): ContinuationSessionCandidate {
	return {
		sessionFile: "/sessions/current.jsonl", sessionId: "current",
		lastActivity: "2026-09-08T10:00:00.000Z", reason: "native header and State Flow runtime",
		profile: identity.profile, cwd: identity.cwd, gitCommonDir: identity.gitCommonDir,
		worktree: identity.worktree, branch: identity.branch, transport: identity.transport,
		lifecycle: "open", stateFlow: { enabled: true, restorable: true }, ...overrides,
	};
}

test("recommends only the latest exact identity with enabled restorable State Flow", () => {
	const old = candidate({ sessionFile: "/sessions/old.jsonl", sessionId: "old", lastActivity: "2026-09-08T09:00:00.000Z" });
	const latest = candidate();
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, latest]), {
		action: "resume", sessionFile: latest.sessionFile, sessionId: latest.sessionId, reason: "latest-enabled-state-flow",
	});
});

test("a latest disabled or unrestorable session fails closed without selecting an older candidate", () => {
	const old = candidate({ sessionFile: "/sessions/old.jsonl", sessionId: "old", lastActivity: "2026-09-08T09:00:00.000Z" });
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, candidate({ stateFlow: { enabled: false, restorable: true } })]), {
		action: "new", reason: "last-not-state-flow",
	});
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, candidate({ stateFlow: { enabled: true, restorable: false } })]), {
		action: "new", reason: "ineligible",
	});
});

test("rejects profile, path, worktree, branch, transport, lifecycle, and opt-out mismatches", () => {
	const mismatches: Partial<ContinuationSessionCandidate>[] = [
		{ profile: "/other/profile" }, { cwd: "/workspace/alias" }, { gitCommonDir: "/other/.git" },
		{ worktree: "/other/worktree" }, { branch: "feature" }, { transport: "telegram" },
		{ lifecycle: "closed" }, { lifecycle: "archived" }, { doNotAutoResume: true },
	];
	for (const mismatch of mismatches) {
		assert.deepEqual(recommendContinuationFromProvenance(identity, [candidate(mismatch)]), { action: "new", reason: "none" });
	}
});

test("equally recent eligible candidates produce an explicit stable choice", () => {
	const a = candidate({ sessionFile: "/sessions/a.jsonl", sessionId: "a" });
	const b = candidate({ sessionFile: "/sessions/b.jsonl", sessionId: "b" });
	assert.deepEqual(recommendContinuationFromProvenance(identity, [b, a]), {
		action: "choose", reason: "ambiguous", candidates: [
		{ sessionFile: a.sessionFile, sessionId: "a", lastActivity: a.lastActivity, reason: "equally recent enabled State Flow session" },
		{ sessionFile: b.sessionFile, sessionId: "b", lastActivity: b.lastActivity, reason: "equally recent enabled State Flow session" },
	],
	});
});

test("consults advisory State Flow discovery only for an ordinary default launch", async () => {
	let calls = 0;
	const recommendation = await resolveContinuationStartup(context, { kind: "default" }, (input) => {
		calls++;
		assert.equal(Object.isFrozen(input), true);
		assert.deepEqual(input, context);
		return { action: "resume", sessionFile: "/sessions/exact.jsonl", sessionId: "session-id", reason: "latest-enabled-state-flow" };
	});
	assert.equal(calls, 1);
	assert.deepEqual(recommendation, {
		action: "resume", sessionFile: "/sessions/exact.jsonl", sessionId: "session-id", reason: "latest-enabled-state-flow",
	});
});

test("explicit new and exact resume remain authoritative without running discovery", async () => {
	const forbidden = () => { throw new Error("discovery must not run"); };
	assert.deepEqual(await resolveContinuationStartup(context, { kind: "new" }, forbidden), {
		action: "new", reason: "explicit-new",
	});
	assert.deepEqual(await resolveContinuationStartup(context, {
		kind: "resume-exact", sessionFile: "/sessions/chosen.jsonl", sessionId: "chosen",
	}, forbidden), {
		action: "resume", sessionFile: "/sessions/chosen.jsonl", sessionId: "chosen", reason: "explicit-resume",
	});
});

test("native picker, continue-recent, and no-session modes bypass State Flow recommendation", async () => {
	const forbidden = () => { throw new Error("discovery must not run"); };
	for (const [intent, mode] of [
		[{ kind: "native-picker" }, "picker"],
		[{ kind: "continue-recent" }, "continue-recent"],
		[{ kind: "no-session" }, "no-session"],
	] as const) {
		assert.deepEqual(await resolveContinuationStartup(context, intent, forbidden), { action: "native", mode });
	}
});

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-continuation-discovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	return { root, sessions };
}

function writeSession(path: string, id: string, cwd: string, body = "{not valid transcript json") {
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-08T10:00:00.000Z", cwd })}\n${body}\n`);
}

test("reads only the native header contract and does not parse transcript bodies", (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "one.jsonl");
	writeSession(file, "one", f.root);
	const before = readFileSync(file);
	const header = readNativeSessionHeader(file);
	assert.equal(header.id, "one");
	assert.equal(header.cwd, f.root);
	assert.deepEqual(readFileSync(file), before);
});

test("native header reads reject non-regular files and symlinked parent locators", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "parent.jsonl");
	writeSession(file, "parent", f.root);
	const before = readFileSync(file);
	const alias = join(f.root, "alias.jsonl");
	const directory = join(f.root, "alias-dir");
	symlinkSync(file, alias);
	symlinkSync(f.sessions, directory, "dir");
	for (const path of [f.sessions, alias, join(directory, "parent.jsonl")]) assert.throws(() => readNativeSessionHeader(path), /regular canonical file/);
	const fifo = join(f.sessions, "fifo.jsonl");
	execFileSync("mkfifo", [fifo]);
	assert.throws(() => readNativeSessionHeader(fifo), /regular canonical file/);
	assert.deepEqual(readFileSync(file), before);
});

test("discovers deterministic JSONL headers, isolates malformed files, and mutates no bytes", (t) => {
	const f = fixture(t);
	writeSession(join(f.sessions, "b.jsonl"), "b", f.root);
	writeSession(join(f.sessions, "a.jsonl"), "a", f.root);
	writeFileSync(join(f.sessions, "broken.jsonl"), "not-json\nprivate transcript");
	writeFileSync(join(f.sessions, "ignored.txt"), "ignored");
	const before = new Map(["a.jsonl", "b.jsonl", "broken.jsonl", "ignored.txt"].map((name) => {
		const path = join(f.sessions, name);
		return [name, { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }];
	}));
	const result = discoverNativeSessionHeaders(f.sessions);
	assert.deepEqual(result.headers.map(({ id }) => id), ["a", "b"]);
	assert.deepEqual(result.invalid.map(({ file }) => file), [join(f.sessions, "broken.jsonl")]);
	for (const [name, snapshot] of before) {
		const path = join(f.sessions, name);
		assert.deepEqual(readFileSync(path), snapshot.bytes);
		assert.equal(statSync(path).mtimeMs, snapshot.mtime);
	}
});

test("inspects exact canonical provenance and fails malformed runtime closed", async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const originalPath = process.env.PATH;
	process.env.PATH = f.root;
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	try {
		f.faux.setResponses([fauxAssistantMessage("File provenance established.")]);
		await session.prompt("Establish file continuation provenance");
	} finally {
		process.env.PATH = originalPath;
	}
	const header = readNativeSessionHeader(session.sessionManager.getSessionFile()!);
	const good = await inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(good.stateFlow, { enabled: true, restorable: true });
	assert.match(good.reason, /canonical session lineage is valid beside current shared streams/);
	const address = resolveSessionAddress(header.file, header.id, header.timestamp);
	const meta = sessionRuntimePaths(header.cwd, header.id, f.repositoryRoot, address.key).meta;
	const other = new TemporalRuntime(header.cwd, "other", f.repositoryRoot);
	const snapshot = emptySnapshot(true);
	other.initialize(snapshot, true);
	const before = other.states();
	const next = structuredClone(before);
	next.session.working.owner = "other";
	snapshot.meta.step++;
	other.publish(snapshot, true, createAcceptedTransition(before, next));
	const ownPaths = temporalScopePaths(header.cwd, header.id, "session", f.repositoryRoot, address.key);
	const otherPaths = temporalScopePaths(header.cwd, "other", "session", f.repositoryRoot);
	for (const key of ["checkpoint", "patches", "meta"] as const) writeFileSync(ownPaths[key], readFileSync(otherPaths[key]));
	const mixedFiles = captureTemporalFileBases(header.cwd, header.id, f.repositoryRoot, address.key);
	const mixed = await inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(mixed.stateFlow, { enabled: true, restorable: false });
	assert.match(mixed.reason, /Conflicting State Flow temporal lineage/);
	assert.deepEqual(captureTemporalFileBases(header.cwd, header.id, f.repositoryRoot, address.key), mixedFiles);
	writeFileSync(meta, "{broken\n");
	const brokenBytes = readFileSync(meta);
	const broken = await inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(broken.stateFlow, { enabled: true, restorable: false });
	assert.match(broken.reason, /ineligible/);
	assert.deepEqual(readFileSync(meta), brokenBytes);
});

for (const scope of ["global", "cwd"] as const) for (const limit of [0, 7]) {
	test(`continuation accepts independent ${scope} drift beside session lineage at limit ${limit}`, async (t) => {
		const f = fixture(t);
		const root = join(f.root, "store");
		const a = new TemporalRuntime(f.root, "a", root, undefined, limit);
		const snapshot = emptySnapshot(true);
		a.initialize(snapshot, true);
		let before = a.states();
		let next = structuredClone(before);
		next.session.working.owner = "A";
		snapshot.meta.step++;
		a.publish(snapshot, true, createAcceptedTransition(before, next));
		before = a.states();
		next = structuredClone(before);
		next[scope].working.shared = "A";
		snapshot.meta.step++;
		a.publish(snapshot, true, createAcceptedTransition(before, next));
		const checkpoint = a.retainedCheckpoint(snapshot);
		assert.ok("boundary" in checkpoint);
		const b = new TemporalRuntime(f.root, "b", root, undefined, limit);
		const other = emptySnapshot(true);
		b.initialize(other, true);
		before = b.states();
		next = structuredClone(before);
		next[scope].working.shared = "B";
		other.meta.step++;
		b.publish(other, true, createAcceptedTransition(before, next));
		const file = join(f.sessions, "a.jsonl");
		writeSession(file, "a", f.root);
		const header = readNativeSessionHeader(file);
		const files = captureTemporalFileBases(f.root, "a", root);
		const inspected = await inspectStateFlowContinuationProvenance(header, root);
		assert.deepEqual(captureTemporalFileBases(f.root, "a", root), files, "inspection cannot publish or repair");
		assert.deepEqual(inspected.stateFlow, { enabled: true, restorable: true }, inspected.reason);
		const restored = new TemporalRuntime(f.root, "a", root, undefined, limit);
		restored.restoreBoundary(checkpoint);
		assert.deepEqual(restored.read(0, "session").working, { owner: "A" });
		assert.deepEqual(restored.read(0, scope).working, { shared: "B" });
	});
}

test("continuation waits through a partial independent publication and propagates cancellation without a fallback decision", { timeout: 20_000 }, async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-continuation-wait-"));
	const root = join(parent, "store");
	const partial = join(parent, "partial");
	const release = join(parent, "release");
	const receipt = join(parent, "receipt.json");
	const lifetime = new AbortController();
	const cancellation = new AbortController();
	const operations: Promise<unknown>[] = [];
	let child: ReturnType<typeof spawn> | undefined;
	let closed: ReturnType<typeof once> | undefined;
	t.after(async () => {
		lifetime.abort();
		cancellation.abort();
		writeFileSync(release, "finish");
		if (child?.exitCode === null) child.kill("SIGKILL");
		await closed;
		await Promise.allSettled(operations);
		rmSync(parent, { recursive: true, force: true });
	});
	const local = new TemporalRuntime(parent, "a", root);
	const snapshot = emptySnapshot(true);
	local.initialize(snapshot, true);
	const file = join(parent, "a.jsonl");
	writeSession(file, "a", parent);
	const native = readFileSync(file);
	const header = readNativeSessionHeader(file);
	const view = advanceTemporalState(local.view!, (["global", "cwd", "session"] as const).map((scope) => ({ scope, patch: { working: { cohort: scope } } })), "current-cohort");
	snapshot.meta.step++;
	const runtime = createSessionRuntime(snapshot, parent, "a", view.lineage);
	child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { withStorageTransaction } from ${JSON.stringify(new URL("../lib/storage.ts", import.meta.url).href)};
		const { root, cwd, view, runtime, partial, release, receipt, pauseAt } = JSON.parse(process.argv[1]);
		const rename = fs.renameSync;
		let paused = false;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (paused || to !== pauseAt) return;
			paused = true;
			fs.writeFileSync(partial, "partial");
			const deadline = Date.now() + 15_000;
			while (!fs.existsSync(release)) {
				if (Date.now() > deadline) throw new Error("continuation publication fixture expired");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		};
		syncBuiltinESMExports();
		await withStorageTransaction(root, (tx) => {
			const result = tx.publish(cwd, "a", view, ["global", "cwd", "session"], tx.capture(cwd, "a", root), root, runtime);
			fs.writeFileSync(receipt, JSON.stringify(result.base.files.map(({ path, identity }) => ({ path, identity }))));
		});
	`, JSON.stringify({ root, cwd: parent, view, runtime, partial, release, receipt, pauseAt: temporalScopePaths(parent, "a", "session", root).patches })], { stdio: ["ignore", "ignore", "inherit"] });
	closed = once(child, "close");
	const deadline = Date.now() + 6_000;
	while (!existsSync(partial)) {
		if (Date.now() > deadline || child.exitCode !== null) assert.fail("writer did not reach its partial private-cohort gate");
		await delay(10);
	}
	const partialFiles = captureTemporalFileBases(parent, "a", root);
	const project = { ...identity, cwd: parent, worktree: parent };
	const recommend = (_context: Readonly<ContinuationHostContext>, signal?: AbortSignal) => buildContinuationCandidates([header], async (selected, signal) => ({
		...project, lifecycle: "open", ...await inspectStateFlowContinuationProvenance(selected, root, signal),
	}), signal).then((candidates) => recommendContinuationFromProvenance(project, candidates));
	const current = resolveContinuationStartup({ ...context, cwd: parent }, { kind: "default" }, recommend, lifetime.signal);
	const canceled = resolveContinuationStartup({ ...context, cwd: parent }, { kind: "default" }, recommend, cancellation.signal);
	const mutable = { ...header };
	const detached = inspectStateFlowContinuationProvenance(mutable, root, lifetime.signal);
	operations.push(current, canceled, detached);
	mutable.id = "not-a";
	mutable.cwd = "/another-project";
	mutable.file = join(parent, "not-a.jsonl");
	let settled = false;
	current.then(() => { settled = true; }, () => { settled = true; });
	await delay(2_200);
	assert.equal(settled, false, "a live owner cannot turn a partial read into an ineligible/new-session recommendation");
	const reason = new Error("startup selection superseded");
	cancellation.abort(reason);
	await assert.rejects(canceled, (error) => error === reason);
	assert.deepEqual(captureTemporalFileBases(parent, "a", root), partialFiles);
	assert.equal(readFileSync(join(root, ".state-flow-publication.lock"), "utf8"), `${child.pid}\n`);
	writeFileSync(release, "continue");
	assert.equal((await closed)[0], 0);
	assert.deepEqual(await current, { action: "resume", sessionFile: file, sessionId: "a", reason: "latest-enabled-state-flow" });
	assert.deepEqual((await detached).stateFlow, { enabled: true, restorable: true }, "a caller mutation cannot retarget a pending inspection");
	assert.deepEqual(captureTemporalFileBases(parent, "a", root).map(({ path, identity }) => ({ path, identity })), JSON.parse(readFileSync(receipt, "utf8")));
	assert.deepEqual(readFileSync(file), native);
	assert.equal(existsSync(join(root, ".state-flow-publication.lock")), false);
});

for (const mode of ["absent", "empty", "stopped", "orphaned", "malformed", "invalid-lock", "symlink"] as const) test(`continuation classifies ${mode} evidence without initialization or repair`, { skip: mode === "symlink" && process.platform === "win32" }, async (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "a.jsonl");
	writeSession(file, "a", f.root);
	const header = readNativeSessionHeader(file);
	const root = join(f.root, "store");
	const actual = mode === "symlink" ? join(f.root, "real-store") : root;
	if (mode === "empty") mkdirSync(root);
	else if (mode !== "absent") {
		const runtime = new TemporalRuntime(f.root, "a", actual);
		runtime.initialize(emptySnapshot(mode !== "stopped"), true);
		const paths = sessionRuntimePaths(f.root, "a", actual);
		if (mode === "orphaned") { rmSync(paths.config); rmSync(paths.runtime); }
		if (mode === "malformed") writeFileSync(paths.runtime, "not JSON\n");
		if (mode === "invalid-lock") writeFileSync(join(root, ".state-flow-publication.lock"), "interrupted owner\n");
		if (mode === "symlink") symlinkSync(actual, root, "dir");
	}
	const before = captureTemporalFileBases(f.root, "a", actual);
	const result = await inspectStateFlowContinuationProvenance(header, root);
	assert.deepEqual(result.stateFlow, ["absent", "empty", "stopped"].includes(mode)
		? { enabled: false, restorable: true } : { enabled: true, restorable: false });
	assert.deepEqual(captureTemporalFileBases(f.root, "a", actual), before);
	if (mode === "absent") assert.equal(existsSync(root), false);
	if (mode === "empty") assert.deepEqual(readdirSync(root), []);
	if (mode === "orphaned") assert.match(result.reason, /incomplete canonical session runtime/);
	if (mode === "invalid-lock") {
		assert.match(result.reason, /lock is unavailable.*EEXIST/);
		assert.equal(readFileSync(join(root, ".state-flow-publication.lock"), "utf8"), "interrupted owner\n");
	} else assert.equal(existsSync(join(actual, ".state-flow-publication.lock")), false);
});

test("asynchronous candidate building freezes the whole header cohort and detaches returned provenance", async (t) => {
	const f = fixture(t);
	for (const id of ["a", "b"]) writeSession(join(f.sessions, `${id}.jsonl`), id, f.root);
	const { headers } = discoverNativeSessionHeaders(f.sessions);
	const original = structuredClone(headers);
	const controller = new AbortController();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const calls: string[] = [];
	const provenance: ContinuationCandidateProvenance = candidate({ sessionFile: "/host-override.jsonl", sessionId: "host-override", cwd: "/host-override", lastActivity: "1900-01-01T00:00:00.000Z" });
	const pending = buildContinuationCandidates(headers, async (header, signal) => {
		assert.equal(Object.isFrozen(header), true);
		assert.equal(signal, controller.signal);
		calls.push(header.id);
		if (header.id === "a") { await gate; return provenance; }
		provenance.stateFlow.enabled = false;
		return undefined;
	}, controller.signal);
	headers[0].file = "/retargeted.jsonl";
	headers[1].id = "retargeted";
	headers.length = 0;
	release();
	const candidates = await pending;
	provenance.stateFlow.restorable = false;
	assert.deepEqual(calls, ["a", "b"]);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].sessionFile, original[0].file);
	assert.equal(candidates[0].sessionId, original[0].id);
	assert.equal(candidates[0].cwd, original[0].cwd);
	assert.equal(candidates[0].lastActivity, original[0].lastActivity);
	assert.deepEqual(candidates[0].stateFlow, { enabled: true, restorable: true });
});

test("startup cancellation rejects pre-aborted and late advisory results instead of selecting a session", async (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "a.jsonl");
	writeSession(file, "a", f.root);
	const header = readNativeSessionHeader(file);
	const controller = new AbortController();
	const reason = new Error("startup canceled");
	controller.abort(reason);
	const forbidden = () => assert.fail("a canceled request cannot inspect or recommend");
	await assert.rejects(buildContinuationCandidates([header], forbidden, controller.signal), (error) => error === reason);
	await assert.rejects(resolveContinuationStartup(context, { kind: "new" }, forbidden, controller.signal), (error) => error === reason);
	const root = join(f.root, "absent-store");
	await assert.rejects(inspectStateFlowContinuationProvenance(header, root, controller.signal), (error) => error === reason);
	assert.equal(existsSync(root), false);
	const late = new AbortController();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	let inspected = 0;
	const candidates = buildContinuationCandidates([header, header], async () => {
		inspected++;
		await gate;
		return { ...identity, lifecycle: "open", stateFlow: { enabled: true, restorable: true }, reason: "late" };
	}, late.signal);
	const selectedContext = { ...context };
	const startup = resolveContinuationStartup(selectedContext, { kind: "default" }, async (input, signal) => {
		assert.equal(Object.isFrozen(input), true);
		assert.equal(signal, late.signal);
		await gate;
		assert.equal(input.cwd, context.cwd);
		return { action: "resume", sessionFile: file, sessionId: "a", reason: "latest-enabled-state-flow" };
	}, late.signal);
	selectedContext.cwd = "/changed";
	late.abort(reason);
	release();
	await assert.rejects(candidates, (error) => error === reason);
	await assert.rejects(startup, (error) => error === reason);
	assert.equal(inspected, 1, "obsolete work cannot continue inspecting another candidate");
});

test("combines frozen headers with host-owned lifecycle and State Flow provenance", async (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "candidate.jsonl");
	writeSession(file, "candidate", f.root);
	const { headers } = discoverNativeSessionHeaders(f.sessions);
	const candidates = await buildContinuationCandidates(headers, (header) => {
		assert.equal(Object.isFrozen(header), true);
		return {
			profile: "/profile", gitCommonDir: "/repo/.git", worktree: f.root, branch: "main",
			transport: "local", lifecycle: "open", stateFlow: { enabled: true, restorable: true },
			reason: "validated header and exact State Flow cohort",
		};
	});
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].sessionFile, file);
	assert.equal(candidates[0].sessionId, "candidate");
	assert.equal(candidates[0].stateFlow.restorable, true);
});
