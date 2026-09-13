import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { STATE_FLOW_COMPACTION_SUMMARY } from "../lib/compaction.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { resolveGitPushDestination } from "../lib/git.ts";
import { acquirePublicationWorkerLease, loadPublicationQueue, publicationQueuePath, savePublicationQueue } from "../lib/publication.ts";
import { interceptGitPushes } from "./push-fixture.ts";
import { serializeScopeStream, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { emptyState, type MaterializedState } from "../lib/state.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { hashSkillSource, SKILL_ARTIFACT_COMPILER } from "../lib/skills.ts";
import {
	cwdScopePaths,
	durablePaths,
	initializeCwdState,
	loadCwdMaterialization,
	loadCwdProvenance,
	loadCwdState,
	loadGlobalMaterialization,
	loadGlobalProvenance,
	loadGlobalState,
	loadSessionMaterialization,
	loadSessionState,
	writeGlobalState,
} from "./temporal-fixture.ts";
import {
	resolvedSnapshot as latestSnapshot,
	realPiFixture,
	nativeSessionKey,
	runGit,
	snapshots,
	type RealPiFixture,
} from "./pi-harness.ts";

test("real Pi retains large state and accepted answers across reload, resume and a large specification", { timeout: 40_000 }, async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "off" });
	let session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	const payload = "λ🧭".repeat(196_608);
	fixture.faux.setResponses(scopedResponses([{ scope: "session", patch: { working: { payload } } }], "Large state accepted"));
	await session.prompt("Retain the large payload");
	assert.equal(fixture.readState(session).response, "Large state accepted");
	const selected = latestSnapshot(session);
	const expected = fixture.readState(session);
	assert.equal(selected.meta.step, 2);
	const file = session.sessionFile!;
	const leaf = session.sessionManager.getLeafId();
	for (const lifecycle of ["reload", "resume"] as const) {
		if (lifecycle === "reload") await session.reload();
		else {
			session.dispose();
			session = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
		}
		assert.equal(session.sessionFile, file);
		assert.equal(session.sessionManager.getLeafId(), leaf);
		assert.equal(latestSnapshot(session).meta.durableBase, selected.meta.durableBase);
		assert.deepEqual(fixture.readState(session), expected);
		assert.equal(fixture.readState(session, 1).working.payload, payload);
	}
	fixture.faux.setResponses(scopedResponses([{ scope: "session", patch: { working: { resumed: true } } }], "Large resume accepted"));
	const specification = `Large specification: ${payload}`;
	await session.prompt(specification);
	assert.equal(fixture.readState(session).response, "Large resume accepted");
	assert.equal(fixture.readState(session).working.payload, payload);
	assert.equal(fixture.readState(session).working.resumed, true);
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.equal(latestSnapshot(session).meta.specification, specification);
	assert.equal(fixture.readState(session, 1).response, "Large state accepted");
});

test("real Pi restoration reads each selected Git tree once across reload and resume", { timeout: 40_000 }, async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "off" });
	let session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	for (let counter = 1; counter <= 4; counter++) {
		fixture.faux.setResponses(scopedResponses([
			{ scope: "global", patch: { working: { globalCounter: counter } } },
			{ scope: "cwd", patch: { working: { cwdCounter: counter } } },
			{ scope: "session", patch: { working: { sessionCounter: counter } } },
		], `Accepted ${counter}`));
		await session.prompt(`Retain boundary ${counter}`);
	}
	const scopes = [undefined, "global", "cwd", "session"] as const;
	const expected = Array.from({ length: 8 }, (_, offset) => scopes.map((scope) => fixture.readState(session, offset, scope)));
	const spawn = childProcess.spawnSync;
	const reads = new Map<string, number>();
	let recording = false;
	t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => {
		const argv = args[1] as string[];
		if (recording && args[0] === "git" && argv[1] === fixture.repositoryRoot && argv[2] === "ls-tree") {
			reads.set(argv[4], (reads.get(argv[4]) ?? 0) + 1);
		}
		return spawn(...args);
	}) as typeof spawn);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	for (const enabled of [true, false]) {
		if (!enabled) await session.prompt("/state-flow-stop");
		const selected = latestSnapshot(session);
		for (const lifecycle of ["reload", "resume"]) {
			reads.clear();
			recording = true;
			try {
				if (lifecycle === "reload") await session.reload();
				else {
					const file = session.sessionFile!;
					session.dispose();
					session = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
				}
			} finally { recording = false; }
			assert.equal(reads.size, enabled ? 1 : 2, "Read the selected cohort, including the semantic revision behind a config-only Stop");
			for (const [object, count] of reads) assert.equal(count, 1, `${lifecycle} redundantly read ${object}`);
			assert.equal(latestSnapshot(session).meta.durableBase, selected.meta.durableBase);
			assert.equal(latestSnapshot(session).meta.step, 8);
			assert.equal(session.getActiveToolNames().includes("patch_state"), enabled);
			for (let offset = 0; offset < 8; offset++) {
				for (const [index, scope] of scopes.entries()) assert.deepEqual(fixture.readState(session, offset, scope), expected[offset][index]);
			}
		}
	}
});

for (const lifecycle of ["quit", "reload"] as const) {
	test(`real Pi ${lifecycle} terminates the owned push before releasing its lease and never relaunches the old worker`, { timeout: 20_000 }, async (t) => {
		const fixture = await realPiFixture(t, { remotePublication: "turn-end" });
		const pushes = interceptGitPushes(t);
		const session = await fixture.createSession();
		t.after(() => session.dispose());
		await session.prompt("/state-flow-start");
		assert.equal(pushes.length, 1);
		const first = pushes[0];
		await first.ready;
		const path = publicationQueuePath(resolveGitPushDestination(fixture.repositoryRoot)!);
		assert.equal(acquirePublicationWorkerLease(path), undefined);
		const selected = latestSnapshot(session);
		const selectedState = fixture.readState(session);
		const previous = loadPublicationQueue(path)!;
		runGit(fixture.repositoryRoot, "commit", "--allow-empty", "-m", "newer queued target");
		const target = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
		const newer = { ...previous, target, status: "pending" as const };
		savePublicationQueue(path, newer, previous);
		const queueBytes = readFileSync(path);

		if (lifecycle === "reload") await session.reload();
		else await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(first.child.signalCode, "SIGKILL", "Shutdown returned while its push child was still running");
		assert.equal(fixture.notifications.some((message) => /push cleanup is unconfirmed/.test(message)), false);
		assert.equal(first.requested.detached, process.platform !== "win32");
		assert.equal(first.requested.terminalPrompt, "0");
		assert.equal(first.requested.interactive, "never");
		assert.deepEqual(readFileSync(path), queueBytes, "Teardown must not acknowledge or fail a newer queued target");
		assert.deepEqual(fixture.readState(session), selectedState);
		assert.equal(latestSnapshot(session).meta.step, selected.meta.step);
		assert.equal(latestSnapshot(session).meta.durableBase, selected.meta.durableBase);
		assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), target);

		if (lifecycle === "quit") {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(pushes.length, 1, "The stopped generation must not relaunch a pending newer target");
			assert.equal(existsSync(`${path}.worker.lock`), false);
			const nextLease = acquirePublicationWorkerLease(path);
			assert.ok(nextLease);
			nextLease.release();
			return;
		}
		assert.equal(pushes.length, 2, "Only the replacement generation may resume the durable queue");
		const replacement = pushes[1];
		await replacement.ready;
		assert.equal(replacement.requested.args.at(-1), `${target}:${newer.destination.ref}`);
		assert.equal(acquirePublicationWorkerLease(path), undefined);
		replacement.child.stdin.end("0");
		await replacement.closed;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(loadPublicationQueue(path), undefined);
		assert.equal(existsSync(`${path}.worker.lock`), false);
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(pushes.length, 2);
	});
}

for (const replacement of ["new", "resume", "fork"] as const) {
	test(`real Pi ${replacement} replacement closes its outgoing publisher before invalidation and preserves accepted history`, { timeout: 30_000 }, async (t) => {
		const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "turn-end" });
		const pushes = interceptGitPushes(t);
		const runtime = await fixture.createRuntime();
		t.after(() => { runtime.setBeforeSessionInvalidate(undefined); return runtime.dispose(); });
		const outgoing = runtime.session;
		assert.equal(outgoing.getActiveToolNames().includes("patch_state"), true);
		assert.equal(pushes.length, 1);
		const first = pushes[0];
		await first.ready;
		fixture.faux.setResponses(scopedResponses([
			{ scope: "global", patch: { contract: { shared: "Retained globally" } } },
			{ scope: "cwd", patch: { contract: { project: "Retained for this CWD" } } },
			{ scope: "session", patch: { working: { private: "Only the outgoing session" } } },
		], "Outgoing answer accepted."));
		await outgoing.prompt("Outgoing accepted request");
		const selected = latestSnapshot(outgoing);
		const state = fixture.readState(outgoing);
		const sessionState = fixture.readState(outgoing, 0, "session");
		assert.equal(selected.meta.step, 2);
		assert.equal(state.response, "Outgoing answer accepted.");
		const sessionFile = outgoing.sessionFile!;
		const leaf = outgoing.sessionManager.getLeafId();
		const key = nativeSessionKey(outgoing);
		const paths = temporalScopePaths(fixture.cwd, outgoing.sessionId, "session", fixture.repositoryRoot, key);
		const originalFiles = [sessionFile, paths.checkpoint, paths.patches, paths.meta,
			sessionRuntimePaths(fixture.cwd, outgoing.sessionId, fixture.repositoryRoot, key).config]
			.map((path) => ({ path, bytes: readFileSync(path) }));
		const queuePath = publicationQueuePath(resolveGitPushDestination(fixture.repositoryRoot)!);
		const queued = loadPublicationQueue(queuePath)!;
		assert.equal(queued.target, selected.meta.durableBase);
		assert.notEqual(first.requested.args.at(-1)!.split(":")[0], queued.target, "accepted work must supersede the still-running activation push");
		assert.equal(pushes.length, 1);
		const queueBytes = readFileSync(queuePath);
		const oldRunner = outgoing.extensionRunner;
		const emit = t.mock.method(oldRunner, "emit");
		let invalidations = 0;
		runtime.setBeforeSessionInvalidate(() => {
			invalidations++;
			assert.equal(runtime.session, outgoing);
			assert.equal(first.child.signalCode, "SIGKILL", "replacement reached invalidation before the owned push exited");
			assert.deepEqual(readFileSync(queuePath), queueBytes, "outgoing teardown must not acknowledge or fail the newer target");
			const available = acquirePublicationWorkerLease(queuePath);
			assert.ok(available, "owned child exit must precede lease handoff");
			available.release();
		});
		const request = outgoing.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
		const switched = replacement === "new" ? await runtime.newSession()
			: replacement === "resume" ? await runtime.switchSession(sessionFile)
			: await runtime.fork(request.id);
		assert.equal(switched.cancelled, false);
		assert.equal(invalidations, 1);
		runtime.setBeforeSessionInvalidate(undefined);
		const next = runtime.session;
		assert.notEqual(next, outgoing);
		assert.deepEqual(emit.mock.calls.map(({ arguments: [event] }) => event).filter((event) => event.type === "session_shutdown"), [
			{ type: "session_shutdown", reason: replacement, targetSessionFile: next.sessionFile },
		]);
		for (const { path, bytes } of originalFiles) assert.deepEqual(readFileSync(path), bytes, `replacement changed ${path}`);
		assert.equal(outgoing.sessionManager.getLeafId(), leaf);
		assert.deepEqual(loadSessionState(fixture.cwd, outgoing.sessionId, fixture.repositoryRoot, key), sessionState);
		const cold = new TemporalRuntime(fixture.cwd, outgoing.sessionId, fixture.repositoryRoot, key);
		assert.equal(cold.restore(selected.meta.durableBase!).meta.step, 2);
		assert.deepEqual(cold.read(), state);
		if (replacement === "new") {
			assert.notEqual(next.sessionId, outgoing.sessionId);
			assert.notEqual(next.sessionFile, sessionFile);
			assert.deepEqual(fixture.readState(next, 0, "session"), emptyState());
			assert.equal(fixture.readState(next).contract.shared, "Retained globally");
			assert.equal(fixture.readState(next).contract.project, "Retained for this CWD");
			assert.equal(latestSnapshot(next).meta.step, 0);
		} else if (replacement === "fork") {
			assert.notEqual(next.sessionId, outgoing.sessionId);
			assert.equal(next.sessionManager.getHeader()?.parentSession, sessionFile);
			assert.equal(next.getActiveToolNames().includes("patch_state"), true);
			// Forking before the first user selects the empty private origin, not the accepted future.
			assert.deepEqual(fixture.readState(next, 0, "session"), emptyState());
			assert.equal(fixture.readState(next).contract.shared, "Retained globally");
			assert.equal(fixture.readState(next).contract.project, "Retained for this CWD");
			assert.equal(latestSnapshot(next).meta.step, 0);
			runGit(fixture.repositoryRoot, "merge-base", "--is-ancestor", queued.target, latestSnapshot(next).meta.durableBase!);
		}
		if (replacement === "resume") {
			assert.equal(next.sessionId, outgoing.sessionId);
			assert.equal(next.sessionFile, sessionFile);
			assert.equal(next.sessionManager.getLeafId(), leaf);
			assert.deepEqual(fixture.readState(next), state);
			assert.equal(latestSnapshot(next).meta.step, 2);
		}
		assert.equal(pushes.length, 2, "only the replacement's enabled generation may restart publication");
		const successor = pushes[1];
		await successor.ready;
		const pending = loadPublicationQueue(queuePath)!;
		assert.equal(pending.target, latestSnapshot(next).meta.durableBase);
		assert.equal(successor.requested.args.at(-1), `${pending.target}:${pending.destination.ref}`);
		assert.equal(acquirePublicationWorkerLease(queuePath), undefined);
		const pendingBytes = readFileSync(queuePath);
		await oldRunner.emit({ type: "agent_settled" });
		assert.equal(pushes.length, 2);
		assert.deepEqual(readFileSync(queuePath), pendingBytes);
		successor.child.stdin.end("0");
		await successor.closed;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(loadPublicationQueue(queuePath), undefined);
		assert.equal(existsSync(`${queuePath}.worker.lock`), false);
		for (const { path, bytes } of originalFiles) assert.deepEqual(readFileSync(path), bytes);
		await oldRunner.emit({ type: "agent_settled" });
		assert.equal(pushes.length, 2);
		assert.equal(fixture.notifications.some((message) => /push cleanup is unconfirmed/.test(message)), false);
	});
}

function scopedResponses(transitions: Array<{ scope: "session" | "cwd" | "global"; patch: unknown }>, answer: string) {
	return [
		fauxAssistantMessage(
			fauxToolCall("patch_state", { ...Object.fromEntries(transitions.map(({ scope, patch }) => [scope, patch])), final: true }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(answer),
	];
}

function sessionResponses(patch: unknown, answer: string) {
	return scopedResponses([{ scope: "session", patch }], answer);
}

function unchangedResponses(answer: string) {
	return [
		fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage(answer),
	];
}

function durableSession(fixture: RealPiFixture, session: any) {
	return loadSessionState(
		fixture.cwd,
		session.sessionManager.getSessionId(),
		fixture.repositoryRoot,
		nativeSessionKey(session),
	)!;
}

test("real Pi forks selected private memory over current shared scopes and resumes child-owned history", { timeout: 40_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const runtime = await f.createRuntime();
	t.after(() => runtime.dispose());
	const parent = runtime.session;
	f.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { sharedGlobal: "old" } } },
		{ scope: "cwd", patch: { working: { sharedCwd: "old" } } },
		{ scope: "session", patch: { working: { private: "selected" } } },
	], "Selected parent answer"));
	await parent.prompt("Selected parent request");
	const point = parent.sessionManager.getLeafId()!;
	const prefix = SessionManager.open(parent.sessionFile!).getBranch(point);
	const selectedRevision = latestSnapshot(parent).meta.durableBase!;
	const source = new TemporalRuntime(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
	source.restore(selectedRevision);
	const selectedSession = source.read(0, "session");
	const selectedStream = serializeScopeStream(source.view!.scopes.session, "session");
	f.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { sharedGlobal: "current" } } },
		{ scope: "cwd", patch: { working: { sharedCwd: "current" } } },
		{ scope: "session", patch: { working: { private: "parent future" } } },
	], "Later parent answer"));
	await parent.prompt("Parent future must not be copied");
	const files = [parent.sessionFile!, sessionRuntimePaths(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)).config,
		...(["global", "cwd", "session"] as const).flatMap((scope) => {
			const paths = temporalScopePaths(f.cwd, parent.sessionId, scope, f.repositoryRoot, nativeSessionKey(parent));
			return [paths.checkpoint, paths.patches, paths.meta];
		})];
	const bytes = () => files.map((path) => existsSync(path) ? readFileSync(path) : undefined);
	const protectedBytes = bytes();
	assert.equal((await runtime.fork(point, { position: "at" })).cancelled, false);
	let child = runtime.session;
	const childId = child.sessionId;
	assert.notEqual(childId, parent.sessionId);
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(f.readState(child, 0, "session"), selectedSession);
	assert.equal(f.readState(child).working.sharedGlobal, "current");
	assert.equal(f.readState(child).working.sharedCwd, "current");
	assert.deepEqual(child.sessionManager.getEntries().filter((entry) => prefix.some(({ id }) => id === entry.id)), prefix);
	assert.deepEqual(bytes(), protectedBytes);
	const paths = temporalScopePaths(f.cwd, childId, "session", f.repositoryRoot, nativeSessionKey(child));
	assert.equal(readFileSync(paths.checkpoint, "utf8"), selectedStream.checkpoint);
	assert.equal(readFileSync(paths.patches, "utf8"), selectedStream.patches);
	assert.equal(latestSnapshot(child).meta.step, 0);
	assert.notEqual(latestSnapshot(child).meta.durableBase, selectedRevision);
	for (const scope of [undefined, "global", "cwd", "session"] as const) assert.throws(() => f.readState(child, 1, scope), /origin/);
	const forkState = f.readState(child);
	await child.reload();
	assert.deepEqual(f.readState(child), forkState);
	assert.equal((await runtime.switchSession(child.sessionFile!)).cancelled, false);
	child = runtime.session;
	assert.equal(child.sessionId, childId);
	assert.deepEqual(f.readState(child), forkState);
	f.faux.setResponses(sessionResponses({ working: { childOnly: true } }, "Child accepted"));
	await child.prompt("Continue only the child");
	assert.equal(f.readState(child).working.childOnly, true);
	assert.equal(f.readState(child).response, "Child accepted");
	assert.equal(latestSnapshot(child).meta.step, 2);
	assert.deepEqual(f.readState(child, 2, "session"), selectedSession);
	assert.throws(() => f.readState(child, 3), /origin/);
	assert.deepEqual(bytes(), protectedBytes);
	const cold = new TemporalRuntime(f.cwd, childId, f.repositoryRoot, nativeSessionKey(child));
	cold.restore(latestSnapshot(child).meta.durableBase!);
	assert.deepEqual(cold.read(), f.readState(child));
});

test("real Pi fork refuses inherited pre-origin pointers without resetting existing child storage", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: false, remotePublication: "off" });
	const runtime = await f.createRuntime();
	t.after(() => runtime.dispose());
	const parent = runtime.session;
	await parent.prompt("/state-flow-stop"); // An older ordinary-disabled marker is not a child reset permission.
	await parent.prompt("/state-flow-start");
	f.faux.setResponses(sessionResponses({ working: { retained: "private" } }, "Parent answer"));
	await parent.prompt("Parent request");
	const inheritedPoint = parent.sessionManager.getLeafId()!;
	await runtime.fork(inheritedPoint, { position: "at" });
	const child = runtime.session;
	const ownedPoint = child.sessionManager.getLeafId()!;
	const selected = f.readState(child);
	const paths = temporalScopePaths(f.cwd, child.sessionId, "session", f.repositoryRoot, nativeSessionKey(child));
	const files = [paths.checkpoint, paths.patches, paths.meta, sessionRuntimePaths(f.cwd, child.sessionId, f.repositoryRoot, nativeSessionKey(child)).config];
	const before = files.map((path) => readFileSync(path));
	const head = runGit(f.repositoryRoot, "rev-parse", "HEAD");
	await child.navigateTree(inheritedPoint, { summarize: false });
	assert.equal(child.getActiveToolNames().includes("patch_state"), false);
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), false, "inherited checkpoints must not fall through to a reset marker");
	assert.equal(runGit(f.repositoryRoot, "rev-parse", "HEAD"), head);
	assert.deepEqual(files.map((path) => readFileSync(path)), before);
	await child.navigateTree(ownedPoint, { summarize: false });
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(f.readState(child), selected);
});

test("real Pi stopped fork copies memory but never inherits the parent's passive projection across reload", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const runtime = await f.createRuntime();
	t.after(() => runtime.dispose());
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { inherited: true } }, "Parent retained"));
	await parent.prompt("Parent request");
	await parent.prompt("/state-flow-stop");
	const state = f.readState(parent, 0, "session");
	const before = readFileSync(parent.sessionFile!);
	assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
	const child = runtime.session;
	assert.equal(child.getActiveToolNames().includes("patch_state"), false);
	assert.deepEqual(f.readState(child, 0, "session"), state);
	assert.equal(latestSnapshot(child).config.enabled, false);
	await child.reload();
	let input = "";
	f.faux.setResponses([(context) => { input = JSON.stringify(context.messages); return fauxAssistantMessage("Ordinary child answer"); }]);
	await child.prompt("Ordinary child request");
	assert.doesNotMatch(input, /State Flow exit handoff/);
	assert.match(input, /Parent request/);
	assert.deepEqual(f.readState(child, 0, "session"), state);
	assert.deepEqual(readFileSync(parent.sessionFile!), before);
});

for (const invalid of ["identity", "cwd"] as const) test(`real Pi fork rejects ${invalid} parent evidence without fallback and retries the exact source on Start`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const runtime = await f.createRuntime();
	t.after(() => { runtime.setBeforeSessionInvalidate(undefined); return runtime.dispose(); });
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { mustSurvive: true } }, "Selected source"));
	await parent.prompt("Selected source request");
	const source = latestSnapshot(parent).meta.durableBase!;
	const state = f.readState(parent, 0, "session");
	const file = parent.sessionFile!;
	const before = readFileSync(file, "utf8");
	const newline = before.indexOf("\n");
	const header = JSON.parse(before.slice(0, newline));
	if (invalid === "identity") header.id = "wrong-parent";
	else header.cwd = join(f.root, "other-project");
	const head = runGit(f.repositoryRoot, "rev-parse", "HEAD");
	runtime.setBeforeSessionInvalidate(() => writeFileSync(file, JSON.stringify(header) + before.slice(newline)));
	assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
	runtime.setBeforeSessionInvalidate(undefined);
	const child = runtime.session;
	assert.equal(child.getActiveToolNames().includes("patch_state"), false);
	assert.throws(() => f.readState(child), /unavailable/);
	assert.match(f.notifications.at(-1)!, /identity mismatch/);
	assert.equal(runGit(f.repositoryRoot, "rev-parse", "HEAD"), head);
	assert.deepEqual(snapshots(child).at(-1)!.data, { revision: source });
	const entries = structuredClone(child.sessionManager.getEntries());
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), false);
	assert.deepEqual(child.sessionManager.getEntries(), entries);
	assert.equal(runGit(f.repositoryRoot, "rev-parse", "HEAD"), head);
	writeFileSync(file, before);
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(f.readState(child, 0, "session"), state);
	assert.notEqual(latestSnapshot(child).meta.durableBase, source);
	assert.deepEqual(readFileSync(file, "utf8"), before);
});

for (const bootstrap of [false, true]) test(`real Pi mid-tool Stop retains the active trajectory through tree, reload, resume, and restart (${bootstrap ? "bootstrap" : "ordinary"} run)`, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: !bootstrap, remotePublication: "off" });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	await session.sendCustomMessage({ customType: "foreign-policy", content: "PERSISTENT-FOREIGN-POLICY", display: false }, { triggerTurn: false });
	fixture.faux.setResponses(bootstrap ? [fauxAssistantMessage("Earlier answer.")] : unchangedResponses("Earlier answer."));
	await session.prompt("COMPLETED-RAW-REQUEST");
	if (bootstrap) await session.prompt("/state-flow-start");
	const frozen = fixture.readState(session);
	const step = latestSnapshot(session).meta.step;
	for (const name of ["early", "late"]) writeFileSync(join(fixture.cwd, `${name}.txt`), `${name.toUpperCase()}-TOOL-EVIDENCE`);
	let stop: Promise<void> | undefined;
	let stopError: unknown;
	let stoppedWhileBusy = false;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "tool_execution_start" || event.toolCallId !== "late-read") return;
		stoppedWhileBusy = !session.isIdle;
		stop = session.prompt("/state-flow-stop").catch((error) => { stopError = error; });
	});
	t.after(unsubscribe);
	const inputs: unknown[] = [];
	fixture.faux.setResponses([
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path: "early.txt" }, { id: "early-read" }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path: "late.txt" }, { id: "late-read" }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage("Finished after Stop."); },
	]);
	await session.prompt("ACTIVE-RAW-REQUEST");
	assert.ok(stop);
	await stop;
	assert.equal(stopError, undefined);
	assert.equal(stoppedWhileBusy, true);
	assert.equal(inputs.length, 3);
	const assertContinuation = (context: any) => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /State Flow exit handoff/);
		assert.match(text, /ACTIVE-RAW-REQUEST/);
		assert.match(text, /EARLY-TOOL-EVIDENCE/);
		assert.match(text, /LATE-TOOL-EVIDENCE/);
		assert.match(text, /PERSISTENT-FOREIGN-POLICY/);
		assert.doesNotMatch(text, /COMPLETED-RAW-REQUEST|ABANDONED-FUTURE/);
		const calls = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === "toolCall").map((block: any) => block.id);
		const results = context.messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId);
		assert.deepEqual(calls, ["early-read", "late-read"]);
		assert.deepEqual(results, calls);
	};
	assertContinuation(inputs[2]);
	assert.deepEqual(fixture.readState(session), frozen);
	assert.equal(latestSnapshot(session).meta.step, step);
	assert.equal(latestSnapshot(session).config.enabled, false);
	const branch = session.sessionManager.getBranch();
	const marker = branch.findIndex((entry) => entry.type === "custom" && entry.customType === "state-flow-passive-stop");
	const early = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "early-read");
	const late = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "late-read");
	assert.ok(early >= 0 && early < marker && marker < late, "native results straddle the Stop marker");
	assert.match(JSON.stringify(branch), /COMPLETED-RAW-REQUEST/, "completed native history remains inspectable");
	assert.match(JSON.stringify(branch), /ACTIVE-RAW-REQUEST/, "active native history remains inspectable");
	const selectedLeaf = session.sessionManager.getLeafId()!;
	fixture.faux.setResponses([fauxAssistantMessage("Abandoned answer.")]);
	await session.prompt("ABANDONED-FUTURE");
	await session.navigateTree(selectedLeaf, { summarize: false });
	await session.reload();
	let reloadedInput: unknown;
	fixture.faux.setResponses([(context) => { reloadedInput = context; return fauxAssistantMessage("Continued selected branch."); }]);
	await session.prompt("Continue after tree and reload");
	assertContinuation(reloadedInput);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	let resumedInput: unknown;
	fixture.faux.setResponses([(context) => { resumedInput = context; return fauxAssistantMessage("Continued after cold resume."); }]);
	await resumed.prompt("Continue after resume");
	assertContinuation(resumedInput);
	assert.deepEqual(fixture.readState(resumed), frozen);
	await resumed.prompt("/state-flow-start");
	await resumed.reload();
	let restartInput: unknown;
	fixture.faux.setResponses([
		(context) => { restartInput = context; return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }); },
		fauxAssistantMessage("Restarted."),
	]);
	await resumed.prompt("Migrate the retained continuation");
	assertContinuation(restartInput);
	assert.match(JSON.stringify(restartInput), /State Flow runtime context/);
	let nextInput: unknown;
	fixture.faux.setResponses([
		(context) => { nextInput = context; return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }); },
		fauxAssistantMessage("Next run."),
	]);
	await resumed.prompt("Next active request");
	assert.doesNotMatch(JSON.stringify(nextInput), /exit handoff|ACTIVE-RAW-REQUEST|TOOL-EVIDENCE|COMPLETED-RAW-REQUEST|ABANDONED-FUTURE/);
});

test("real Pi threshold compaction preserves partial tool work before the first State Flow patch", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, {
		autoStart: true, remotePublication: "off", contextWindow: 4_000,
		compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 500 },
	});
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	fixture.faux.setResponses(sessionResponses({ working: { earlier: true } }, "Earlier accepted run."));
	await session.prompt("Establish compactable completed history");
	const evidence = join(fixture.cwd, "partial.txt");
	writeFileSync(evidence, "PARTIAL-TOOL-EVIDENCE\n");
	let continuedContext = "";
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: evidence }, { id: "partial-read" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Native summary retains PARTIAL-TOOL-EVIDENCE before any State Flow patch."),
		(context) => {
			continuedContext = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { continuedAfterThreshold: true } }, final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Accepted after native threshold compaction."),
	]);
	await session.prompt(`LONG-PARTIAL-REQUEST:${"x".repeat(20_000)}`);
	const compaction = session.sessionManager.getEntries().find((entry) => entry.type === "compaction");
	assert.ok(compaction);
	assert.equal(compaction.fromHook, false, "State Flow must not customize native threshold compaction");
	assert.match(compaction.summary, /PARTIAL-TOOL-EVIDENCE/);
	assert.match(continuedContext, /PARTIAL-TOOL-EVIDENCE/);
	assert.equal(fixture.readState(session).working.continuedAfterThreshold, true);
	assert.equal(latestSnapshot(session).meta.step, 4);
});

test("real Pi compacts accepted State Flow history without another model call and resumes from the same full session", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	let session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const id = session.sessionId;
	const file = session.sessionFile!;
	const calls = fixture.faux.state.callCount;
	fixture.faux.setResponses(sessionResponses({ working: { retainedAcrossCompaction: true } }, "Accepted before compaction."));
	await session.prompt(`LONG-COMPLETED-REQUEST:${"x".repeat(90_000)}`);
	for (let attempt = 0; attempt < 100 && !session.sessionManager.getEntries().some((entry) => entry.type === "compaction"); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(fixture.faux.state.callCount - calls, 2, "State Flow compaction must not request a model summary");
	const all = session.sessionManager.getEntries();
	const compaction = all.find((entry) => entry.type === "compaction");
	assert.ok(compaction && compaction.fromHook === true);
	assert.equal(compaction.summary, STATE_FLOW_COMPACTION_SUMMARY);
	assert.equal((compaction.details as any).owner, "state-flow");
	assert.equal((compaction.details as any).revision, latestSnapshot(session).meta.durableBase);
	assert.equal((compaction.details as any).step, latestSnapshot(session).meta.step);
	const active = session.sessionManager.buildContextEntries();
	assert.ok(active.length < all.length);
	assert.equal(active.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes("LONG-COMPLETED-REQUEST")), false);
	assert.equal(active.some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message).includes("Accepted before compaction")), true);
	assert.equal(all.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes("LONG-COMPLETED-REQUEST")), true, "full append-only history remains inspectable");
	assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, all.length + 1, "JSONL retains its header and every native entry");
	const state = fixture.readState(session);
	assert.equal(state.working.retainedAcrossCompaction, true);
	await session.reload();
	assert.equal(session.sessionId, id);
	assert.deepEqual(fixture.readState(session), state);
	assert.ok(session.sessionManager.buildContextEntries().length < session.sessionManager.getEntries().length);
	session.dispose();
	session = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	assert.equal(session.sessionId, id);
	assert.deepEqual(fixture.readState(session), state);
	assert.ok(session.sessionManager.buildContextEntries().length < session.sessionManager.getEntries().length);
});

test("real Pi preserves branch-local state through compaction, tree navigation, stop, and restart", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());

	assert.equal(fixture.statuses.at(-1), undefined);
	assert.equal(snapshots(session).length, 0);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	const key = nativeSessionKey(session);
	assert.equal(key, basename(session.sessionManager.getSessionFile()!, ".jsonl"));
	assert.equal(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, key).directory,
		join(fixture.repositoryRoot, `--${fixture.cwd.slice(1).replaceAll("/", "-")}--`, key));
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), "2");
	// turn-end activation commits locally first; the asynchronous worker replicates them afterwards.
	const activationDestination = resolveGitPushDestination(fixture.repositoryRoot)!;
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(publicationQueuePath(activationDestination)); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(runGit(fixture.remote, "rev-list", "--count", "refs/heads/main"), "2");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(latestSnapshot(session).config, { enabled: true });
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ autoStart: true }));
	const nextSession = await fixture.createSession("new");
	assert.equal(latestSnapshot(nextSession).config.enabled, true);
	assert.equal(nextSession.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(nextSession).meta.step, 0);
	nextSession.dispose();

	fixture.faux.setResponses(sessionResponses({
		contract: { constraint: "preserve branch causality" },
		working: { nextCheck: "inspect active branch" },
	}, "Base branch saved."));
	await session.prompt("Create the base checkpoint");
	const base = snapshots(session).at(-1)!;
	assert.equal(latestSnapshot(session, base.data).meta.step, 2);

	fixture.faux.setResponses([fauxAssistantMessage("Compacted State Flow integration history.")]);
	const compacted = await session.compact("Keep the State Flow checkpoint");
	assert.match(compacted.summary, /Compacted State Flow integration history/);
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), true);

	fixture.faux.setResponses(sessionResponses({
		working: { branch: "future", nextCheck: "return to base" },
	}, "Future branch saved."));
	await session.prompt("Advance the future branch");
	await session.prompt("/state-flow-stop");
	const stopped = snapshots(session).at(-1)!;
	assert.equal(latestSnapshot(session, stopped.data).config.enabled, false);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(session, stopped.data).meta.step, 4);
	assert.equal(Object.hasOwn(stopped.data, "state"), false);
	assert.equal(durableSession(fixture, session).working.branch, "future");

	await session.navigateTree(base.id, { summarize: false });
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 2);

	await session.navigateTree(stopped.id, { summarize: false });
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	assert.equal(durableSession(fixture, session).contract.constraint, "preserve branch causality");
	assert.equal(durableSession(fixture, session).working.branch, "future");

	const sessionFile = session.sessionFile!;
	session.dispose();
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	assert.equal(latestSnapshot(restarted).config.enabled, false);
	assert.equal(restarted.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(restarted).meta.step, 4);
	assert.equal(durableSession(fixture, restarted).working.nextCheck, "return to base");
});

test("real Pi can restart an early disabled marker as a new origin while preserving shared streams and later branch history", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-stop");
	const marker = snapshots(session).at(-1)!;
	assert.deepEqual(marker.data, { disabled: true });
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { sharedGlobal: "keep" } } },
		{ scope: "cwd", patch: { working: { sharedCwd: "keep" } } },
		{ scope: "session", patch: { working: { laterPrivate: "keep in cold history" } } },
	], "Later branch"));
	await session.prompt("Save later branch");
	const later = snapshots(session).at(-1)!;
	const shared = ["global", "cwd"].flatMap((scope) => {
		const pair = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), scope as "global" | "cwd", fixture.repositoryRoot);
		return [pair.checkpoint, pair.patches].map((path) => ({ path, bytes: readFileSync(path) }));
	});
	await session.navigateTree(marker.id, { summarize: false });
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 0);
	assert.deepEqual(fixture.readState(session, 0, "session"), { artifacts: {}, contract: {}, working: {}, response: "" });
	assert.equal(fixture.readState(session).working.sharedGlobal, "keep");
	assert.equal(fixture.readState(session).working.sharedCwd, "keep");
	assert.throws(() => fixture.readState(session, 1), /predates the proven temporal origin/);
	for (const { path, bytes } of shared) assert.deepEqual(readFileSync(path), bytes);
	await session.navigateTree(later.id, { summarize: false });
	assert.equal(fixture.readState(session).working.laterPrivate, "keep in cold history");
});

test("real Pi isolates same-CWD sessions and retains seven patches per scope", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	await first.prompt("/state-flow-start");
	const firstId = first.sessionManager.getSessionId();
	const firstKey = nativeSessionKey(first);
	fixture.faux.setResponses(Array.from({ length: 9 }, (_, index) => scopedResponses([
		{ scope: "global", patch: { working: { globalIndex: index } } },
		{ scope: "cwd", patch: { working: { cwdIndex: index } } },
		{ scope: "session", patch: { working: { owner: "first", sessionIndex: index } } },
	], `Iteration ${index}.`)).flat());
	for (let index = 0; index < 9; index++) await first.prompt(`Iteration ${index}`);

	const sharedPaths = ["checkpoint.json", "patches.jsonl", ...["checkpoint.json", "patches.jsonl"].map((name) => join(cwdScopePaths(fixture.cwd, fixture.repositoryRoot).directory, name))];
	const sharedBefore = sharedPaths.map((path) => readFileSync(path.startsWith("/") ? path : join(fixture.repositoryRoot, path)));
	const second = await fixture.createSession("new");
	t.after(() => second.dispose());
	assert.deepEqual(sharedPaths.map((path) => readFileSync(path.startsWith("/") ? path : join(fixture.repositoryRoot, path))), sharedBefore);
	assert.throws(() => fixture.readState(second, 1), /predates the proven temporal origin/);
	const secondId = second.sessionManager.getSessionId();
	const secondKey = nativeSessionKey(second);
	assert.notEqual(firstId, secondId);
	assert.equal(loadSessionState(fixture.cwd, firstId, fixture.repositoryRoot, firstKey)!.working.owner, "first");
	assert.deepEqual(loadSessionState(fixture.cwd, secondId, fixture.repositoryRoot, secondKey), {
		artifacts: {}, contract: {}, working: {}, response: "",
	});
	for (const [scope, materialization] of [
		["global", loadGlobalMaterialization(fixture.repositoryRoot)],
		["cwd", loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)],
		["session", loadSessionMaterialization(fixture.cwd, firstId, fixture.repositoryRoot, firstKey)],
	] as const) {
		assert.equal(materialization!.recentTransitions.length, 7);
		assert.ok(materialization!.recentTransitions.every(({ transitions }) =>
			transitions.length === 1 && transitions[0]!.scope === scope));
	}
	for (const { data } of snapshots(first)) {
		assert.deepEqual(Object.keys(data), ["revision"]);
		assert.match((data as { revision: string }).revision, /^[0-9a-f]{40}$/);
	}
});

test("real Pi preserves the primary answer while the fallback supplies patch_state", async (t) => {
	const fixture = await realPiFixture(t, { tokensPerSecond: 2_000 });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");

	fixture.faux.setResponses([
		fauxAssistantMessage("Preserved draft."),
		...sessionResponses({ working: { accepted: "after-resolution" } }, "Fallback chatter."),
	]);
	await session.prompt("Exercise resolution continuation");
	assert.equal(fixture.faux.state.callCount, 3);
	assert.equal(durableSession(fixture, session).working.accepted, "after-resolution");
	assert.equal(durableSession(fixture, session).response, "Preserved draft.");
	assert.equal(session.getLastAssistantText(), undefined, "the fallback turn is suppressed");
});

test("real Pi keeps the preserved answer after the fallback budget", async (t) => {
	const fixture = await realPiFixture(t, { tokensPerSecond: 2_000 });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");

	fixture.notifications.length = 0;
	fixture.faux.setResponses([
		fauxAssistantMessage("Preserved answer."),
		fauxAssistantMessage("Fallback one."),
		fauxAssistantMessage("Fallback two."),
	]);
	await session.prompt("Exhaust the fallback budget");
	assert.equal(fixture.faux.state.callCount, 3);
	assert.equal(durableSession(fixture, session).response, "Preserved answer.");
	assert.equal(session.getLastAssistantText(), undefined, "fallback turns never become the response");
	assert.equal(fixture.notifications.filter((message) => /no final:true patch arrived after 2 fallback turns/.test(message)).length, 1);
});

test("real Pi patch diagnostics are opt-in and accepted answers are not logged", async (t) => {
	const fixture = await realPiFixture(t);
	const logPath = join(fixture.agentDir, "tmp", "state-flow", "logs.jsonl");
	const disabled = await fixture.createSession();
	t.after(() => disabled.dispose());
	await disabled.prompt("/state-flow-start");
	fixture.faux.setResponses(sessionResponses({ working: { disabledRun: "accepted" } }, "No diagnostics."));
	await disabled.prompt("Complete without diagnostics");
	assert.equal(existsSync(logPath), false);

	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ logging: true }));
	const logged = await fixture.createSession();
	t.after(() => logged.dispose());
	await logged.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage("Logged unresolved draft."),
		fauxAssistantMessage(fauxToolCall("patch_state", { final: false }), { stopReason: "toolUse" }),
		...sessionResponses({ working: { loggedRun: "accepted" } }, "Accepted."),
	]);
	await logged.prompt("Recover from invalid patch arguments");
	const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.length, 3);
	assert.equal(records[0].category, "terminal-pending");
	assert.deepEqual(records[0].content, [{ type: "text", text: "Logged unresolved draft." }]);
	assert.equal(records[0].resolutionAttempt, 0);
	assert.equal(records[0].terminalEligible, false);
	assert.equal(records[1].category, "invalid-patch");
	assert.match(records[1].error, /final must be exactly true/);
	assert.deepEqual(records[1].input, { final: false });
	assert.equal(records[1].tool, "patch_state");
	assert.equal(typeof records[1].toolCallId, "string");
	assert.equal(records[1].terminalEligible, false);
	assert.equal(records[2].category, "finalization");
	assert.deepEqual(records[2].content, [{ type: "text", text: "Accepted." }]);
	assert.equal(records[2].terminalEligible, true);
	assert.equal(durableSession(fixture, logged).working.loggedRun, "accepted");
	assert.equal(durableSession(fixture, logged).response, "Logged unresolved draft.");
});

test("real Pi diagnostic write failure leaves resolution and accepted state untouched", async (t) => {
	const fixture = await realPiFixture(t);
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ logging: true }));
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	writeFileSync(join(fixture.agentDir, "tmp"), "blocked");
	const beforeFailure = fixture.notifications.length;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { final: false }), { stopReason: "toolUse" }),
		...sessionResponses({ working: { ioFailureRun: "recovered" } }, "Recovered despite diagnostics."),
	]);
	await session.prompt("Recover while diagnostics cannot be written");
	assert.equal(durableSession(fixture, session).working.ioFailureRun, "recovered");
	const warnings = fixture.notifications.slice(beforeFailure).filter((message) => message.includes("could not write diagnostics"));
	assert.equal(warnings.length, 1);
});

test("real Pi patch_state barriers rematerialize every scope before the next inference", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");

	const clone = globalThis.structuredClone;
	let contextCopies: number | undefined;
	const contextCopyCounts: number[] = [];
	t.mock.method(globalThis, "structuredClone", <T>(value: T, options?: Parameters<typeof clone>[1]): T => {
		const candidate = value as Partial<MaterializedState> | null | undefined;
		if (contextCopies !== undefined && candidate?.working?.sessionCheckpoint === "verified"
			&& candidate.artifacts !== undefined && typeof candidate.response === "string") contextCopies++;
		return clone(value, options);
	});
	const emitContext = session.extensionRunner.emitContext.bind(session.extensionRunner);
	t.mock.method(session.extensionRunner, "emitContext", async (...args: Parameters<typeof emitContext>) => {
		assert.equal(contextCopies, undefined);
		contextCopies = 0;
		try { return await emitContext(...args); }
		finally { contextCopyCounts.push(contextCopies); contextCopies = undefined; }
	});

	function runtime(context: any): any {
		const projections = context.messages
			.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.filter((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.equal(projections.length, 1, "each inference receives exactly one current State Flow projection");
		return JSON.parse(projections[0].slice(projections[0].indexOf("\n") + 1));
	}

	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", {
			session: { working: { sessionCheckpoint: "verified" } },
		}), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(runtime(context).state.working.sessionCheckpoint, "verified");
			assert.equal(fixture.readState(session, 1).working.sessionCheckpoint, undefined);
			assert.equal(fixture.readState(session, 0, "session").working.sessionCheckpoint, "verified");
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				cwd: { contract: { projectDecision: "retained" } },
			}), { stopReason: "toolUse" });
		},
		(context) => {
			const state = runtime(context).state;
			assert.equal(state.working.sessionCheckpoint, "verified");
			assert.equal(state.contract.projectDecision, "retained");
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				global: { contract: { sharedDecision: "retained" } }, final: true,
			}), { stopReason: "toolUse" });
		},
		(context) => {
			const state = runtime(context).state;
			assert.equal(state.working.sessionCheckpoint, "verified");
			assert.equal(state.contract.projectDecision, "retained");
			assert.equal(state.contract.sharedDecision, "retained");
			return fauxAssistantMessage("Barrier run complete.");
		},
	]);
	await session.prompt("Materialize several established checkpoints");
	assert.equal(fixture.faux.state.callCount, 4);
	assert.deepEqual(contextCopyCounts, [0, 1, 1, 1], "each post-barrier native context copies the full overlay once");
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.equal(durableSession(fixture, session).working.sessionCheckpoint, "verified");
	assert.equal(durableSession(fixture, session).response, "Barrier run complete.");
	assert.equal(fixture.readState(session, 1).response, "");
	assert.throws(() => fixture.readState(session, 8), /0 to 7/);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.contract.projectDecision, "retained");
	assert.equal(loadGlobalState(fixture.repositoryRoot)!.contract.sharedDecision, "retained");
	assert.deepEqual(
		snapshots(session).map(({ data }) => latestSnapshot(session, data).meta.step).filter((step, index, all) => index === 0 || step !== all[index - 1]),
		[0, 1, 2, 3, 4],
	);
	const beforeNoop = loadSessionMaterialization(fixture.cwd, session.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(session));
	fixture.faux.setResponses(unchangedResponses("Barrier run complete."));
	await session.prompt("Confirm the same complete state");
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.deepEqual(loadSessionMaterialization(fixture.cwd, session.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(session)), beforeNoop);
});

test("real Pi reads prior scoped state lazily after a barrier and rejects offset eight without a transition", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("read_state"), true);
	fixture.faux.setResponses(sessionResponses({ working: { version: "old" } }, "Baseline."));
	await session.prompt("Save the baseline");
	let beforeReads: string;
	let checkpointCount: number;
	function projection(context: any) {
		const messages = context.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context"));
		assert.equal(messages.length, 1);
		const text = messages[0].content[0].text;
		return JSON.parse(text.slice(text.indexOf("\n") + 1));
	}
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { version: "new" } }, final: true }), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(projection(context).state.working.version, "new");
			beforeReads = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
			checkpointCount = snapshots(session).length;
			return fauxAssistantMessage(fauxToolCall("read_state", { offset: 1, scope: "session" }, { id: "history-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "history-read") as any;
			assert.equal(result.isError, false);
			assert.match(result.content[0].text, /^\n\{"offset":1/);
			const historical = JSON.parse(result.content[0].text);
			assert.equal(historical.offset, 1);
			assert.equal(historical.scope, "session");
			assert.equal(historical.state.working.version, "old");
			assert.equal(historical.state.response, "Baseline.");
			assert.equal(projection(context).state.working.version, "new");
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeReads);
			assert.equal(snapshots(session).length, checkpointCount);
			assert.equal(latestSnapshot(session).meta.step, 2);
			return fauxAssistantMessage(fauxToolCall("read_state", { offset: 8 }, { id: "unavailable-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "unavailable-read") as any;
			assert.equal(result.isError, true);
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeReads);
			assert.equal(snapshots(session).length, checkpointCount);
			return fauxAssistantMessage("History checked.");
		},
	]);
	await session.prompt("Advance state, then inspect its predecessor");
	assert.equal(latestSnapshot(session).meta.step, 3, "only baseline, barrier and terminal response advance history");
	assert.equal(fixture.readState(session).working.version, "new");
	assert.equal(fixture.readState(session, 1).response, "Baseline.");
	fixture.faux.setResponses([
		(context) => {
			assert.equal(context.messages.some((message: any) => message.role === "toolResult" && message.toolCallId === "history-read"), false);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Next run."),
	]);
	await session.prompt("Begin a separate run without replaying old tool context");
	const retained = session.sessionManager.getEntries().find((entry) => entry.type === "message"
		&& entry.message.role === "toolResult" && entry.message.toolCallId === "history-read");
	assert.ok(retained?.type === "message" && retained.message.role === "toolResult");
	const content = retained.message.content[0];
	assert.ok(content?.type === "text");
	assert.equal(JSON.parse(content.text).state.working.version, "old", "full native trace survives model-context projection");
	const beforeStatus = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await session.prompt("/state-flow-status");
	assert.match(fixture.notifications.at(-1)!, /Hot history: offsets 0\.\.4; maximum depth 7/);
	assert.match(fixture.notifications.at(-1)!, /Retained patch tails: global 0; CWD 0; session 4/);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeStatus);
});

test("real Pi executes only patch_state when a response also proposes a sibling tool", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	const inFlight = new Set<string>();
	let started = 0;
	let ended = 0;
	let toolBranchReads = 0;
	const getBranch = session.sessionManager.getBranch.bind(session.sessionManager);
	t.mock.method(session.sessionManager, "getBranch", (...args: Parameters<typeof getBranch>) => {
		if (inFlight.size > 0) toolBranchReads++;
		return getBranch(...args);
	});
	t.after(session.subscribe((event) => {
		if (event.type === "tool_execution_start") { inFlight.add(event.toolCallId); started++; }
		if (event.type === "tool_execution_end") { inFlight.delete(event.toolCallId); ended++; }
	}));
	fixture.faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("read", { path: join(fixture.cwd, "must-not-run.md") }, { id: "blocked-read" }),
			fauxToolCall("read_state", { offset: 0 }, { id: "blocked-history" }),
			fauxToolCall("patch_state", {
				session: { working: { barrier: "accepted" } }, final: true,
			}, { id: "accepted-patch" }),
		], { stopReason: "toolUse" }),
		(context) => {
			const results = context.messages.filter((message: any) => message.role === "toolResult") as any[];
			assert.equal(results.length, 3);
			assert.equal(results[0].toolCallId, "blocked-read");
			assert.equal(results[0].isError, true);
			assert.match(results[0].content[0].text, /patch_state barrier/);
			assert.equal(results[1].toolCallId, "blocked-history");
			assert.equal(results[1].isError, true);
			assert.match(results[1].content[0].text, /patch_state barrier/);
			assert.equal(results[2].toolCallId, "accepted-patch");
			assert.equal(results[2].isError, false);
			assert.match(results[2].content[0].text, /State materialized atomically at session scope/);
			return fauxAssistantMessage("Barrier enforced.");
		},
	]);
	await session.prompt("Patch and then reconsider any other action");
	assert.equal(latestSnapshot(session).meta.step, 2);
	assert.equal(durableSession(fixture, session).working.barrier, "accepted");
	assert.equal(durableSession(fixture, session).response, "Barrier enforced.");
	assert.deepEqual([started, ended, inFlight.size], [3, 3, 0]);
	assert.equal(toolBranchReads, 0, "native preflight/execution must not rebuild completed branch history");
});

test("real Pi keeps a malformed patch_state failure separated from the invocation", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	const beforeHead = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	const beforeStep = latestSnapshot(session).meta.step;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { invalid: [null] } } }, { id: "malformed-patch" }), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "malformed-patch") as any;
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /^\nMaterialized state cannot contain null/);
			assert.equal(latestSnapshot(session).meta.step, beforeStep);
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeHead);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Malformed patch rejected without state change."),
	]);
	await session.prompt("Attempt a malformed patch");
});

test("real Pi reconciles unrelated Knowledge history and contains a simultaneous durable writer", async (t) => {
	const fixture = await realPiFixture(t);
	const first = await fixture.createSession();
	const second = await fixture.createSession();
	t.after(() => first.dispose());
	t.after(() => second.dispose());
	await first.prompt("/state-flow-start");
	await second.prompt("/state-flow-start");

	writeFileSync(join(fixture.repositoryRoot, "independent.md"), "Independent Knowledge history.\n");
	runGit(fixture.repositoryRoot, "add", "independent.md");
	runGit(fixture.repositoryRoot, "commit", "-m", "knowledge: independent advance");
	const knowledgeCommit = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");

	fixture.faux.setResponses(scopedResponses([{
		scope: "cwd",
		patch: { working: { writer: "first" } },
	}], "First writer committed."));
	await first.prompt("Commit after independent Knowledge history");
	const firstCommit = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	assert.equal(runGit(fixture.repositoryRoot, "merge-base", firstCommit, knowledgeCommit), knowledgeCommit);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "first");

	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", {
			cwd: { working: { writer: "second" } },
		}), { stopReason: "toolUse" }),
		...unchangedResponses("Second writer was rejected."),
	]);
	await second.prompt("Attempt a simultaneous durable transition");
	assert.equal(latestSnapshot(second).meta.step, 1);
	assert.equal(latestSnapshot(second).config.enabled, true);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "first");
	assert.equal(loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)!.recentTransitions.length, 1);
	const failed = second.sessionManager.getEntries().find((entry: any) => entry.type === "message"
		&& entry.message?.role === "toolResult" && entry.message?.toolName === "patch_state" && entry.message?.isError);
	assert.ok(failed);
});

test("real Pi retries a persisted pending push after restart without duplicating the transition", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	const missingRemote = join(fixture.root, "missing.git");
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", missingRemote);
	fixture.faux.setResponses(scopedResponses([{
		scope: "cwd",
		patch: { working: { publication: "accepted-locally" } },
	}], "Committed locally."));
	await session.prompt("Persist a durable transition");
	const accepted = latestSnapshot(session);
	const pendingCommit = accepted.meta.pendingPublication?.commit;
	assert.ok(pendingCommit);
	assert.equal(accepted.meta.step, 2);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), pendingCommit);
	const sessionFile = session.sessionFile!;
	const countBeforeRestart = runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD");
	session.dispose();

	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", fixture.remote);
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(latestSnapshot(restarted).meta.pendingPublication, undefined);
	assert.equal(latestSnapshot(restarted).meta.step, 2);
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/main"), pendingCommit);
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), countBeforeRestart);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.publication, "accepted-locally");
});

test("real Pi incrementally acquires only invalidated global Markdown and attaches trusted freshness", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const unchangedPath = join(fixture.agentDir, "knowledge", "unchanged.md");
	const changedPath = join(fixture.agentDir, "knowledge", "changed.md");
	writeFileSync(unchangedPath, "Unchanged routing guidance.\n");
	writeFileSync(changedPath, "Original routing guidance.\n");
	initializeCwdState(fixture.cwd, fixture.repositoryRoot);
	const metadata = (path: string, description: string) => ({
		description,
		hash: hashArtifactSource(readFileSync(path)),
		compiler: ORDINARY_ARTIFACT_COMPILER,
		compiled_at: "2026-01-01T00:00:00.000Z",
	});
	writeGlobalState({
		artifacts: {
			[unchangedPath]: metadata(unchangedPath, "Stable unchanged guidance"),
			[changedPath]: metadata(changedPath, "Original changed guidance"),
		},
		contract: {}, working: {}, response: "",
	}, fixture.repositoryRoot);
	const globalPaths = durablePaths(fixture.repositoryRoot);
	const cwdPaths = cwdScopePaths(fixture.cwd, fixture.repositoryRoot);
	runGit(
		fixture.repositoryRoot,
		"add",
		globalPaths.globalState,
		globalPaths.globalPatches,
		cwdPaths.state,
		cwdPaths.patches,
	);
	runGit(fixture.repositoryRoot, "commit", "-m", "state-flow: seed artifact registry");
	runGit(fixture.repositoryRoot, "push", "origin", "main");

	const runtime = (context: any) => {
		const text = context.messages
			.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.find((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.ok(text);
		return JSON.parse(text.slice(text.indexOf("\n") + 1));
	};

	let beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).knowledge_rehydration.phase, "new-bootstrap");
			assert.equal(runtime(context).artifact_invalidations, undefined);
			// Legacy embedded provenance is consumed for freshness but stripped from model projection.
			assert.deepEqual(runtime(context).state.artifacts[unchangedPath], { description: "Stable unchanged guidance" });
			assert.deepEqual(runtime(context).state.artifacts[changedPath], { description: "Original changed guidance" });
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Fresh artifacts reused without source acquisition."),
	]);
	const unchangedSession = await fixture.createSession("new");
	await unchangedSession.prompt("Use the materialized artifact index");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);
	unchangedSession.dispose();

	writeFileSync(changedPath, "Changed routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).knowledge_rehydration.phase, "new-bootstrap");
			assert.doesNotMatch(JSON.stringify(context.messages), /Changed routing guidance\./);
			assert.deepEqual(runtime(context).artifact_invalidations, [{
				path: changedPath,
				reason: "source-changed",
			}]);
			return fauxAssistantMessage(fauxToolCall("read", { path: changedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [changedPath]: { description: "Updated routing guidance" } } },
		}], "Changed artifact recompiled."),
	]);
	const changedSession = await fixture.createSession("new");
	await changedSession.prompt("Refresh invalidated artifacts");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	changedSession.dispose();
	const afterSourceChange = loadGlobalState(fixture.repositoryRoot)!;
	assert.deepEqual(afterSourceChange.artifacts[unchangedPath], metadata(unchangedPath, "Stable unchanged guidance"));
	assert.deepEqual(afterSourceChange.artifacts[changedPath], {
		description: "Updated routing guidance",
	});
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], {
		sourceHash: hashArtifactSource("Changed routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});

	const compilerStale = structuredClone(afterSourceChange);
	compilerStale.artifacts[unchangedPath]!.compiler = "artifact-v0";
	const compilerRuntime = new TemporalRuntime(fixture.cwd, changedSession.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(changedSession));
	const compilerSnapshot = compilerRuntime.restore(latestSnapshot(changedSession).meta.durableBase!);
	const compilerStates = compilerRuntime.states();
	const compilerNext = { ...compilerStates, global: compilerStale };
	compilerSnapshot.meta.step += 1;
	compilerRuntime.publish(compilerSnapshot, true, createAcceptedTransition(compilerStates, compilerNext));
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.deepEqual(runtime(context).artifact_invalidations, [{
				path: unchangedPath,
				reason: "compiler-changed",
			}]);
			return fauxAssistantMessage(fauxToolCall("read", { path: unchangedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [unchangedPath]: { description: "Recompiled unchanged guidance" } } },
		}], "Compiler-stale artifact recompiled."),
	]);
	const compilerSession = await fixture.createSession("new");
	t.after(() => compilerSession.dispose());
	await compilerSession.prompt("Apply the current artifact compiler");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	const afterCompilerChange = loadGlobalState(fixture.repositoryRoot)!;
	assert.deepEqual(afterCompilerChange.artifacts[unchangedPath], { description: "Recompiled unchanged guidance" });
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[unchangedPath], {
		sourceHash: hashArtifactSource("Unchanged routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});
	assert.deepEqual(afterCompilerChange.artifacts[changedPath], afterSourceChange.artifacts[changedPath]);

	// A semantically identical recompilation must still persist fresh provenance; otherwise the
	// artifact would re-invalidate forever without any semantic transition to carry the update.
	writeFileSync(changedPath, "Second routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.deepEqual(runtime(context).artifact_invalidations, [{ path: changedPath, reason: "source-changed" }]);
			return fauxAssistantMessage(fauxToolCall("read", { path: changedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [changedPath]: { description: "Updated routing guidance" } } },
		}], "Provenance-only recompilation."),
	]);
	const provenanceSession = await fixture.createSession("new");
	t.after(() => provenanceSession.dispose());
	await provenanceSession.prompt("Recompile with unchanged semantics");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	assert.deepEqual(loadGlobalState(fixture.repositoryRoot)!.artifacts[changedPath], { description: "Updated routing guidance" });
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], {
		sourceHash: hashArtifactSource("Second routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Provenance retained without reacquisition."),
	]);
	const provenanceFreshSession = await fixture.createSession("new");
	t.after(() => provenanceFreshSession.dispose());
	await provenanceFreshSession.prompt("Confirm provenance retained");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);

	// Removal is a deterministic runtime observation and needs no source-body read or model-authored compiler output.
	rmSync(changedPath);
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Removed artifact no longer projected."),
	]);
	const removalSession = await fixture.createSession("new");
	t.after(() => removalSession.dispose());
	await removalSession.prompt("Continue without the deleted source");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);
	assert.equal(loadGlobalState(fixture.repositoryRoot)!.artifacts[changedPath], undefined);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], undefined);
});

test("real Pi discovery preserves foreign artifacts and unavailable roots, then removes only proven missing Markdown after status and reload", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const root = join(fixture.agentDir, "knowledge");
	const owned = join(root, "owned.md");
	const foreign = [join(fixture.cwd, "external.txt"), join(fixture.cwd, "external.md"), join(root, "retained.txt"), join(root, "retained.MD")];
	for (const path of [owned, ...foreign]) writeFileSync(path, "Opaque source bytes.\n");
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: owned }), { stopReason: "toolUse" }),
		...scopedResponses([{ scope: "global", patch: { artifacts: Object.fromEntries([owned, ...foreign].map((path) => [path, { description: "Retained source routing" }])) } }], "Sources registered."),
	]);
	await session.prompt("Register owned and independent sources");
	const seeded = fixture.readState(session, 0, "global");
	const paths = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "global", fixture.repositoryRoot);
	const files = [paths.checkpoint, paths.patches, paths.meta];
	const bytes = files.map((path) => readFileSync(path));
	for (const available of [true, false]) {
		if (!available) renameSync(root, `${root}-unavailable`);
		await session.prompt("/state-flow-stop");
		await session.prompt("/state-flow-start");
		fixture.faux.setResponses(unchangedResponses("Reactivated without deleting independent sources."));
		await session.prompt("Reactivate source discovery");
		assert.deepEqual(fixture.readState(session, 0, "global"), seeded);
		assert.deepEqual(files.map((path) => readFileSync(path)), bytes);
		if (!available) {
			await session.prompt("/state-flow-status");
			assert.match(fixture.notifications.at(-1)!, /Artifact freshness unavailable: Knowledge root is unavailable/);
		}
	}
	renameSync(`${root}-unavailable`, root);
	rmSync(owned);
	const head = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await session.prompt("/state-flow-status");
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), head, "status is read-only");
	assert.equal(fixture.notifications.at(-1)!.match(/source-removed/g)?.length, 1);
	await session.reload();
	const beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses(unchangedResponses("Only the removed Markdown source was pruned."));
	await session.prompt("Apply the proven removal after reload");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2, "removal requires no model read or compilation");
	const expected = structuredClone(seeded);
	delete expected.artifacts[owned];
	assert.deepEqual(fixture.readState(session, 0, "global"), expected);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[owned], undefined);
});

test("real Pi rejects no-read freshness forgery atomically and accepts a corrected model patch", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const source = join(fixture.cwd, "unacquired.txt");
	writeFileSync(source, "Unacquired source.\n");
	const before = fixture.readState(session);
	let rejectedResult: any;
	let rejectedState: unknown;
	let rejectedStep: number | undefined;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", {
			global: { artifacts: { [source]: { description: "Forged freshness", hash: hashArtifactSource("Unacquired source.\n"), compiler: ORDINARY_ARTIFACT_COMPILER } } },
			cwd: { working: { mustNotCommit: true } },
			final: true,
		}, { id: "forged" }), { stopReason: "toolUse" }),
		(context) => {
			rejectedResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "forged");
			rejectedState = fixture.readState(session);
			rejectedStep = latestSnapshot(session).meta.step;
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { corrected: true } }, final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Corrected without forging evidence."),
	]);
	await session.prompt("Reject forged freshness and continue");
	assert.equal(rejectedResult?.isError, true);
	assert.match(JSON.stringify(rejectedResult.content), /cannot set runtime-owned provenance/);
	assert.deepEqual(rejectedState, before);
	assert.equal(rejectedStep, 0);
	assert.equal(fixture.readState(session, 0, "global").artifacts[source], undefined);
	assert.equal(fixture.readState(session, 0, "cwd").working.mustNotCommit, undefined);
	assert.equal(fixture.readState(session, 0, "session").working.corrected, true);
	assert.equal(latestSnapshot(session).meta.step, 2);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[source], undefined);
});

test("a fresh real Pi agent continues from compact state and a runtime-compiled Skill artifact", async (t) => {
	const fixture = await realPiFixture(t);
	const skill = join(fixture.cwd, "skills", "continuation", "SKILL.md");
	mkdirSync(join(fixture.cwd, "skills", "continuation"), { recursive: true });
	writeFileSync(skill, "# Continuation\n\nPreserve the next discriminating check.\n\nSOURCE-BODY-ONLY-MARKER\n", { flag: "wx" });
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: skill }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("patch_state", {
			cwd: {
				artifacts: {
					[skill]: {
						description: "Continuation rules for evidence-preserving handoffs",
						kind: "skill",
						compilation: {
							routing: "Use for resumed continuation checks",
							constraints: ["Preserve the next discriminating check"],
						},
					},
				},
			},
		}), { stopReason: "toolUse" }),
		...scopedResponses([{
			scope: "session",
			patch: {
				contract: {
					activeConstraint: "never discard unresolved evidence",
					rejectedApproach: { name: "guessing", reconsiderWhen: "new evidence exists" },
				},
				working: {
					unresolved: "whether the resumed source changed",
					nextCheck: "compare the retained source hash",
				},
			},
		}], "Skill compiled."),
	]);
	await session.prompt("OLD-CONVERSATION-MARKER acquire the continuation Skill");
	const compiled = loadCwdState(fixture.cwd, fixture.repositoryRoot)!.artifacts[skill];
	const compiledProvenance = loadCwdProvenance(fixture.cwd, fixture.repositoryRoot)[skill]!;
	assert.equal(compiledProvenance.sourceHash, hashSkillSource(skill));
	assert.equal(compiledProvenance.compilerRevision, SKILL_ARTIFACT_COMPILER);
	assert.equal(compiled.compilation?.routing, "Use for resumed continuation checks");
	const sessionFile = session.sessionFile!;
	session.dispose();

	let observedContext = "";
	fixture.faux.setResponses([
		(context) => {
			observedContext = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Continuation context verified."),
	]);
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	await restarted.prompt("Continue from retained state");
	assert.match(observedContext, /never discard unresolved evidence/);
	assert.match(observedContext, /guessing/);
	assert.match(observedContext, /whether the resumed source changed/);
	assert.match(observedContext, /compare the retained source hash/);
	assert.match(observedContext, /Continuation rules for evidence-preserving handoffs/);
	assert.match(observedContext, /Use for resumed continuation checks/);
	assert.doesNotMatch(observedContext, new RegExp(compiledProvenance.sourceHash));
	assert.doesNotMatch(observedContext, /SOURCE-BODY-ONLY-MARKER/);
	assert.doesNotMatch(observedContext, /OLD-CONVERSATION-MARKER/);
});

test("real Pi old tree branch stop and resume preserve selected semantics without rewinding shared files", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	const owned = runGit(fixture.repositoryRoot, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
	assert.equal(owned.length, 8);
	assert.equal(owned.filter((path) => path.endsWith("checkpoint.json")).length, 3);
	assert.equal(owned.filter((path) => path.endsWith("patches.jsonl")).length, 3);
	assert.equal(owned.some((path) => path.endsWith("state.json")), false);
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { branch: "old" } } },
		{ scope: "session", patch: { working: { selected: "old" } } },
	], "Old answer"));
	await session.prompt("Old state");
	const old = snapshots(session).at(-1)!;
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { branch: "new" } } },
		{ scope: "session", patch: { working: { selected: "new" } } },
	], "New answer"));
	await session.prompt("New state");
	const before = owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path)));
	await session.navigateTree(old.id, { summarize: false });
	assert.equal(fixture.readState(session).working.selected, "old");
	await session.prompt("/state-flow-stop");
	const stopped = latestSnapshot(session);
	assert.equal(stopped.meta.step, 2);
	const after = owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path)));
	assert.deepEqual(after, before);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(latestSnapshot(resumed).config.enabled, false);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	let passiveContext = "";
	fixture.faux.setResponses([(context) => {
		passiveContext = JSON.stringify(context.messages);
		return fauxAssistantMessage("Disabled continuation remained ordinary.");
	}]);
	await resumed.prompt("Continue while State Flow is stopped");
	assert.match(passiveContext, /State Flow exit handoff/);
	assert.match(passiveContext, /Continue while State Flow is stopped/);
	assert.doesNotMatch(passiveContext, /Old state|New state/);
	assert.equal(fixture.readState(resumed).working.selected, "old");
	assert.equal(fixture.readState(resumed).working.branch, "old");
	assert.equal(fixture.readState(resumed, 1).response, "");
	assert.deepEqual(owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path))), before);
});

test("real Pi persists without Git, resumes its file cohort and adopts Git without a semantic step", async (t) => {
	const fixture = await realPiFixture(t, { initializeRepository: false });
	const spawn = childProcess.spawnSync;
	let probes = 0;
	childProcess.spawnSync = ((command: string, args: string[]) => {
		assert.equal(command, "git");
		assert.deepEqual(args, ["--version"], "no repository operation is permitted without Git");
		probes++;
		return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) };
	}) as unknown as typeof spawn;
	syncBuiltinESMExports();
	t.after(() => { childProcess.spawnSync = spawn; syncBuiltinESMExports(); });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	const fileKey = nativeSessionKey(session);
	assert.equal(existsSync(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, fileKey).directory), true);
	assert.doesNotMatch(fileKey, /-[a-f0-9]{64}$/);
	const current = (context: any) => {
		const texts = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text).filter((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.equal(texts.length, 1);
		return JSON.parse(texts[0].slice(texts[0].indexOf("\n") + 1)).state;
	};
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { cwd: { working: { fileCwd: "visible" } } }), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(current(context).working.fileCwd, "visible");
			assert.equal(fixture.readState(session, 1, "cwd").working.fileCwd, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { fileSession: "visible" } }, final: true }), { stopReason: "toolUse" });
		},
		(context) => {
			assert.equal(current(context).working.fileSession, "visible");
			return fauxAssistantMessage("File-only final answer.");
		},
	]);
	await session.prompt("Persist without Git");
	assert.equal(latestSnapshot(session).meta.step, 3);
	assert.match(latestSnapshot(session).meta.durableBase!, /^file:[0-9a-f]{64}$/);
	assert.equal(latestSnapshot(session).meta.pendingPublication, undefined);
	assert.equal(fixture.readState(session).response, "File-only final answer.");
	assert.equal(fixture.readState(session, 1).response, "");
	const beforeReads = probes;
	fixture.readState(session, 2, "cwd");
	assert.equal(probes, beforeReads);
	const before = [0, 1, 2, 3].map((offset) => fixture.readState(session, offset));
	await session.prompt("/state-flow-stop");
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(latestSnapshot(session).meta.step, 3);
	assert.equal(existsSync(join(fixture.repositoryRoot, ".git")), false);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	assert.equal(resumed.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	assert.deepEqual([0, 1, 2, 3].map((offset) => fixture.readState(resumed, offset)), before);
	assert.equal(fixture.notifications.some((message) => /push.*pending|could not initialize/i.test(message)), false);
	childProcess.spawnSync = spawn;
	syncBuiltinESMExports();
	const identity = { GIT_AUTHOR_NAME: "State Flow Tests", GIT_AUTHOR_EMAIL: "state-flow@example.invalid", GIT_COMMITTER_NAME: "State Flow Tests", GIT_COMMITTER_EMAIL: "state-flow@example.invalid" };
	const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
	Object.assign(process.env, identity);
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
	childProcess.execFileSync("git", ["init", "-b", "main", fixture.repositoryRoot], { stdio: "ignore" });
	childProcess.execFileSync("git", ["init", "--bare", fixture.remote], { stdio: "ignore" });
	runGit(fixture.repositoryRoot, "remote", "add", "origin", fixture.remote);
	runGit(fixture.repositoryRoot, "config", "branch.main.remote", "origin");
	runGit(fixture.repositoryRoot, "config", "branch.main.merge", "refs/heads/main");
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	await resumed.prompt("/state-flow-start");
	assert.equal(resumed.getActiveToolNames().includes("patch_state"), true);
	const adopted = latestSnapshot(resumed);
	assert.match(adopted.meta.durableBase!, /^[0-9a-f]{40}$/);
	assert.equal(adopted.meta.step, 3);
	assert.equal(adopted.meta.pendingPublication?.commit, adopted.meta.durableBase);
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), "1");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const adoptionQueue = publicationQueuePath(destination);
	assert.ok(loadPublicationQueue(adoptionQueue), "file-to-Git activation queues remote publication instead of waiting for it");
	assert.notEqual(childProcess.spawnSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).status, 0);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(adoptionQueue); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(adoptionQueue), undefined);
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/main"), adopted.meta.durableBase);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	assert.deepEqual([0, 1, 2, 3].map((offset) => fixture.readState(resumed, offset)), before);
	const cold = new TemporalRuntime(fixture.cwd, resumed.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(resumed));
	cold.restore(adopted.meta.durableBase!);
	assert.deepEqual([0, 1, 2, 3].map((offset) => cold.read(offset)), before);
	// Subsequent semantic publication uses the already configured remote normally.
	fixture.faux.setResponses(unchangedResponses("Git-backed answer."));
	await resumed.prompt("Continue after adoption");
	assert.equal(latestSnapshot(resumed).meta.step, 4);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(adoptionQueue); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await resumed.prompt("/state-flow-status");
	assert.match(fixture.notifications.at(-1)!, /Publication: idle/);
	assert.equal(fixture.readState(resumed).response, "Git-backed answer.");
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/" + runGit(fixture.repositoryRoot, "branch", "--show-current")), latestSnapshot(resumed).meta.durableBase);
});

test("real Pi derives an in-memory session directory from the native header timestamp and UUID", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const manager = SessionManager.inMemory(fixture.cwd);
	const session = await fixture.createSession("new", manager);
	t.after(() => session.dispose());
	assert.equal(manager.getSessionFile(), undefined);
	const header = manager.getHeader()!;
	const key = `${header.timestamp.replace(/[:.]/g, "-")}_${manager.getSessionId()}`;
	assert.equal(nativeSessionKey(session), key);
	const directory = temporalScopePaths(fixture.cwd, manager.getSessionId(), "session", fixture.repositoryRoot, key).directory;
	assert.equal(existsSync(join(directory, "checkpoint.json")), true);
	assert.equal(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")).identity.sessionId, manager.getSessionId());
});

test("real Pi baseline memory crosses CWDs while project memory remains scoped", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { contract: { preference: "compact" } } },
		{ scope: "cwd", patch: { contract: { projectRule: "local-only" } } },
	], "Memory retained."));
	await first.prompt("Retain the established cross-project preference and project-only rule");
	assert.equal(fixture.readState(first, 0, "global").contract.preference, "compact");
	assert.equal(fixture.readState(first, 0, "cwd").contract.projectRule, "local-only");

	const otherCwd = join(fixture.root, "other-project");
	const second = await fixture.createSessionAt(otherCwd, "new");
	t.after(() => second.dispose());
	assert.equal(fixture.readState(second, 0, "global").contract.preference, "compact");
	assert.equal(fixture.readState(second, 0, "cwd").contract.projectRule, undefined);
	assert.deepEqual(fixture.readState(second, 0, "session"), { artifacts: {}, contract: {}, working: {}, response: "" });
});

test("real Pi preserves failed external promotion and recovers proven destination pointers", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	fixture.faux.setResponses(scopedResponses([{
		scope: "global",
		patch: { working: {
			durableCandidate: { preference: "compact" },
			memory_promotions: { preference: {
				status: "failed", owner: "knowledge", pointer: "MEMORY.md#preference", error: "write rejected",
			} },
		} },
	}], "Promotion remains recoverable."));
	await first.prompt("Attempt the external handoff without losing the accepted copy");

	const recovery = await fixture.createSessionAt(join(fixture.root, "promotion-recovery"), "new");
	t.after(() => recovery.dispose());
	assert.deepEqual(fixture.readState(recovery, 0, "global").working.durableCandidate, { preference: "compact" });
	assert.deepEqual((fixture.readState(recovery, 0, "global").working.memory_promotions as any).preference, {
		status: "failed", owner: "knowledge", pointer: "MEMORY.md#preference", error: "write rejected",
	});

	fixture.faux.setResponses(scopedResponses([{
		scope: "global",
		patch: { working: {
			durableCandidate: null,
			memory_promotions: { preference: {
				status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "accepted-revision", error: null,
			} },
		} },
	}], "External acceptance proven."));
	await recovery.prompt("Finalize only after proving destination acceptance");

	const verified = await fixture.createSessionAt(join(fixture.root, "promotion-verified"), "new");
	t.after(() => verified.dispose());
	const global = fixture.readState(verified, 0, "global");
	assert.equal(global.working.durableCandidate, undefined);
	assert.deepEqual((global.working.memory_promotions as any).preference, {
		status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "accepted-revision",
	});
});

test("real Pi turn-end policy queues the newest local target without pushing inline", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	fixture.faux.setResponses(unchangedResponses("Queued after local acceptance."));
	await session.prompt("Accept locally and queue remote publication");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queue = loadPublicationQueue(publicationQueuePath(destination));
	assert.ok(queue);
	assert.equal(queue.target, runGit(fixture.repositoryRoot, "rev-parse", "HEAD"));
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(publicationQueuePath(destination)); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), runGit(fixture.repositoryRoot, "rev-parse", "HEAD"));
});

test("real Pi concurrent sessions preserve a newer queued descendant while an older push is active", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	const second = await fixture.createSession("new");
	t.after(() => { first.dispose(); second.dispose(); });
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	fixture.faux.setResponses([
		...unchangedResponses("First local target."),
		...unchangedResponses("Second local target."),
	]);
	await first.prompt("Publish the older target");
	const older = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await second.prompt("Publish the newer target while the first worker is active");
	const newer = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	assert.notEqual(newer, older);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const path = publicationQueuePath(destination);
	assert.equal(loadPublicationQueue(path)?.target, newer);
	for (let attempt = 0; attempt < 60 && loadPublicationQueue(path); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(path), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), newer);
});

test("real Pi turn-end activation accepts locally without an inline remote push", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "turn-end" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	// An unreachable remote surfaces as a synchronous pending push whenever activation publishes inline.
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", join(fixture.root, "unreachable.git"));
	await session.prompt("/state-flow-start");
	const snapshot = latestSnapshot(session);
	assert.equal(snapshot.config.enabled, true);
	assert.equal(fixture.notifications.some((message) => /push is pending/.test(message)), false);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queue = loadPublicationQueue(publicationQueuePath(destination));
	assert.ok(queue, "the activation commit is queued for the asynchronous worker");
	assert.match(queue.target, /^[0-9a-f]{40,64}$/);
});

test("real Pi off activation stays local without queue or remote attempt", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "off" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(fixture.notifications.some((message) => /push is pending/.test(message)), false);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
});

test("real Pi transition activation preserves synchronous legacy publication", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "transition" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	await session.prompt("/state-flow-start");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.notEqual(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
});

test("real Pi off policy accepts locally without queue or remote attempt", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	fixture.faux.setResponses(unchangedResponses("Local-only by policy."));
	await session.prompt("Accept without remote replication");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(fixture.readState(session).response, "Local-only by policy.");
});

test("real Pi retries a failed durable queue after restart without duplicating local state", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	const file = session.sessionManager.getSessionFile()!;
	const missing = join(fixture.root, "replacement-remote.git");
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", missing);
	fixture.faux.setResponses(unchangedResponses("Locally durable while offline."));
	await session.prompt("Accept while remote publication is unavailable");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath)?.status !== "failed"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const failed = loadPublicationQueue(queuePath);
	assert.equal(failed?.status, "failed");
	assert.match(failed?.error ?? "", /git|repository|remote|exit/i);
	const head = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	const step = latestSnapshot(session).meta.step;
	session.dispose();

	childProcess.execFileSync("git", ["init", "--bare", missing], { stdio: "ignore" });
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	for (let attempt = 0; attempt < 60 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), head);
	assert.equal(latestSnapshot(resumed).meta.step, step);
	assert.equal(fixture.readState(resumed).response, "Locally durable while offline.");
	assert.equal(childProcess.execFileSync("git", ["--git-dir", missing, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), head);
});

test("real Pi projects resume bootstrap once and then uses step rehydration", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	fixture.faux.setResponses(unchangedResponses("Continuation established."));
	await first.prompt("Establish a resumable session");
	const file = first.sessionManager.getSessionFile()!;
	first.dispose();

	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	const phase = (context: any) => {
		const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.find((value: unknown) => typeof value === "string" && value.startsWith("State Flow runtime context"));
		assert.ok(text);
		return JSON.parse(text.slice(text.indexOf("\n") + 1)).knowledge_rehydration.phase;
	};
	fixture.faux.setResponses([
		(context) => {
			assert.equal(phase(context), "resume-bootstrap");
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Resume bootstrap remained materialized-first."),
	]);
	await resumed.prompt("Resume the exact continuation");
	fixture.faux.setResponses([
		(context) => {
			assert.equal(phase(context), "step");
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Later step used the same bounded route."),
	]);
	await resumed.prompt("Continue with a later step");
});

test("real Pi auto-start follows agent configuration without overriding resumed branch mode", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const path = process.env.PATH;
	process.env.PATH = fixture.root;
	t.after(() => { process.env.PATH = path; });
	const session = await fixture.createSession("startup");
	t.after(() => session.dispose());
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 0);
	assert.equal(existsSync(join(fixture.repositoryRoot, ".git")), false);
	fixture.faux.setResponses(unchangedResponses("Automatically persisted."));
	await session.prompt("Use automatic mode");
	await session.prompt("/state-flow-stop");
	const file = session.sessionFile!;
	session.dispose();
	const stopped = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => stopped.dispose());
	assert.equal(stopped.getActiveToolNames().includes("patch_state"), false);
	assert.equal(fixture.readState(stopped).response, "Automatically persisted.");
	const next = await fixture.createSession("new");
	assert.equal(next.getActiveToolNames().includes("patch_state"), true);
	assert.equal(fixture.readState(next).response, "");
	fixture.faux.setResponses(unchangedResponses("Second automatic session."));
	await next.prompt("Persist the second session");
	const enabledFile = next.sessionFile!;
	assert.equal(existsSync(enabledFile), true);
	next.dispose();
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ autoStart: false }));
	const manual = await fixture.createSession("new");
	t.after(() => manual.dispose());
	assert.equal(manual.getActiveToolNames().includes("patch_state"), false);
	assert.equal(snapshots(manual).length, 0);
	const enabled = await fixture.createSession("resume", SessionManager.open(enabledFile, fixture.sessionDir));
	t.after(() => enabled.dispose());
	assert.equal(enabled.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(enabled).config.enabled, true);
	assert.deepEqual(JSON.parse(readFileSync(join(fixture.agentDir, "state-flow.json"), "utf8")), { autoStart: false });
});
