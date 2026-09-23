import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, Type, type Context, type ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type AgentBeforeSettleEvent, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER, type ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { STATE_FLOW_COMPACTION_SUMMARY } from "../lib/compaction.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { emptyState, projectStateForModel, type MaterializedState } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { hashSkillSource, SKILL_ARTIFACT_COMPILER } from "../lib/skills.ts";
import {
	cwdScopePaths,
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

test("real Pi self-heals a wholly absent CWD pair during response reconciliation without resurrecting it", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	let session = await fixture.createSession("new");
	t.after(() => session.dispose());
	fixture.faux.setResponses(scopedResponses([{ scope: "cwd", patch: { working: { must_not_resurrect: "old-cwd-value" } } }], "Seeded CWD answer."));
	await session.prompt("Seed CWD state");
	const paths = temporalScopePaths(fixture.cwd, session.sessionId, "cwd", fixture.repositoryRoot, nativeSessionKey(session));
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
	fixture.faux.setResponses(unchangedResponses("Recovered ordinary answer."));
	await session.prompt("Answer after the complete live CWD pair disappeared");
	assert.equal(fixture.notifications.some((message) => /Live State Flow cwd scope storage is incomplete/.test(message)), false);
	assert.equal(fixture.readState(session).response, "Recovered ordinary answer.");
	assert.equal(fixture.readState(session, 0, "cwd").working.must_not_resurrect, undefined);
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
	fixture.faux.setResponses(sessionResponses({ working: { continuedAfterRepair: true } }, "Continued after repair."));
	await session.prompt("Continue with a session patch");
	assert.equal(fixture.readState(session).working.continuedAfterRepair, true);
	const file = session.sessionFile!;
	await session.reload();
	assert.equal(fixture.readState(session).working.must_not_resurrect, undefined);
	assert.equal(fixture.readState(session).working.continuedAfterRepair, true);
	session.dispose();
	session = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	assert.equal(fixture.readState(session).response, "Continued after repair.");
	assert.equal(fixture.readState(session).working.must_not_resurrect, undefined);
	assert.equal(fixture.readState(session).working.continuedAfterRepair, true);
});

for (const limit of [0, 1]) test(`real Pi reload applies historyLimit ${limit} without losing accepted state`, { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	for (let index = 1; index <= 3; index++) {
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("patch_state", {
				global: { working: { index } }, cwd: { working: { index } }, session: { working: { index } },
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage(`Accepted ${index}`),
		]);
		await session.prompt(`Retain iteration ${index}`);
	}
	const scopes = ["global", "cwd", "session"] as const;
	const before = scopes.map((scope) => fixture.readState(session, 0, scope));
	const step = latestSnapshot(session).meta.step;
	const config = join(fixture.repositoryRoot, "config.json");
	writeFileSync(config, JSON.stringify({ autoStart: true, historyLimit: limit }));
	await session.reload();
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(latestSnapshot(session).meta.step, step);
	assert.deepEqual(scopes.map((scope) => fixture.readState(session, 0, scope)), before);
	const tails = () => scopes.map((scope) => readFileSync(temporalScopePaths(fixture.cwd, session.sessionId, scope, fixture.repositoryRoot, nativeSessionKey(session)).patches, "utf8"));
	const constrained = tails();
	assert.ok(constrained.every((tail) => tail.split("\n").filter(Boolean).length <= limit));
	writeFileSync(config, JSON.stringify({ autoStart: true, historyLimit: 12 }));
	await session.reload();
	assert.deepEqual(tails(), constrained);
	assert.deepEqual(scopes.map((scope) => fixture.readState(session, 0, scope)), before);
	assert.throws(() => fixture.readState(session, 1), /predates the proven temporal origin/);
	fixture.faux.setResponses(sessionResponses({ working: { continued: true } }, "Accepted after retention change"));
	await session.prompt("Continue after changing retention");
	assert.equal(latestSnapshot(session).meta.step, step + 2);
	assert.deepEqual(fixture.readState(session, 2, "session"), before[2]);
	assert.throws(() => fixture.readState(session, 3), /predates the proven temporal origin/);
});

test("real Pi retains large state and accepted answers across reload, resume and a large specification", { timeout: 40_000 }, async (t) => {
	const fixture = await realPiFixture(t, {});
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
	for (const lifecycle of ["reload", "resume"] as const) {
		if (lifecycle === "reload") await session.reload();
		else {
			session.dispose();
			session = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
		}
		assert.equal(session.sessionFile, file);
		assert.deepEqual(fixture.readState(session), expected);
	}
	fixture.faux.setResponses(scopedResponses([{ scope: "session", patch: { working: { resumed: true } } }], "Large resume accepted"));
	const specification = `Large specification: ${payload}`;
	await session.prompt(specification);
	assert.equal(fixture.readState(session).response, "Large resume accepted");
	assert.equal(fixture.readState(session).working.payload, payload);
	assert.equal(fixture.readState(session).working.resumed, true);
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.equal(latestSnapshot(session).meta.specification, undefined);
	assert.equal(fixture.readState(session, 1).response, "Large state accepted");
});

test("real Pi restoration preserves current scoped state without requiring Git tree reads", { timeout: 40_000 }, async (t) => {
	const fixture = await realPiFixture(t, {});
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
			assert.ok(reads.size <= (enabled ? 1 : 2), "Canonical restoration must not require Git tree reads");
			for (const [object, count] of reads) assert.equal(count, 1, `${lifecycle} redundantly read ${object}`);
			assert.equal(latestSnapshot(session).meta.step, 8);
			assert.equal(session.getActiveToolNames().includes("patch_state"), enabled);
			for (const [index, scope] of scopes.entries()) assert.deepEqual(fixture.readState(session, 0, scope), expected[0][index]);
		}
	}
});

function scopedResponses(transitions: Array<{ scope: "session" | "cwd" | "global"; patch: JsonObject }>, answer: string) {
	return [
		fauxAssistantMessage(
			fauxToolCall("patch_state", { ...Object.fromEntries(transitions.map(({ scope, patch }) => [scope, patch])) }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(answer),
	];
}

function sessionResponses(patch: JsonObject, answer: string) {
	return scopedResponses([{ scope: "session", patch }], answer);
}

function unchangedResponses(answer: string) {
	return [fauxAssistantMessage(answer)];
}

function durableSession(fixture: RealPiFixture, session: any) {
	return loadSessionState(
		fixture.cwd,
		session.sessionManager.getSessionId(),
		fixture.repositoryRoot,
		nativeSessionKey(session),
	)!;
}

test("real Pi forks selected private memory over current shared scopes and reloads the child origin", { timeout: 40_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true });
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
	const selectedSession = f.readState(parent, 0, "session");
	const sourcePaths = temporalScopePaths(f.cwd, parent.sessionId, "session", f.repositoryRoot, nativeSessionKey(parent));
	const selectedStream = {
		checkpoint: readFileSync(sourcePaths.checkpoint, "utf8"),
		patches: readFileSync(sourcePaths.patches, "utf8"),
	};
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
	for (const scope of [undefined, "global", "cwd", "session"] as const) assert.throws(() => f.readState(child, 1, scope), /origin/);
	const forkState = f.readState(child);
	await child.reload();
	assert.deepEqual(f.readState(child), forkState);
	assert.deepEqual(bytes(), protectedBytes);
});

for (const operation of ["restore", "fork"] as const) test(`real Pi ${operation} reacquires evidence for an older private artifact without changing its semantics early`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const runtime = await f.createRuntime();
	t.after(() => runtime.dispose());
	let session = runtime.session;
	const source = join(f.cwd, "registered.txt");
	writeFileSync(source, "Version one source");
	const read = () => fauxAssistantMessage(fauxToolCall("read", { path: source }), { stopReason: "toolUse" });
	const compile = (description: string) => fauxAssistantMessage(fauxToolCall("patch_state", {
		session: { artifacts: { [source]: { description } } },
	}), { stopReason: "toolUse" });
	const provenance = () => JSON.parse(readFileSync(temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session)).meta, "utf8")).artifacts;
	const projection = (context: any) => {
		const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.find((block: any) => block.type === "text" && block.text.startsWith("State Flow runtime context"))?.text;
		assert.ok(text);
		return JSON.parse(text.slice(text.indexOf("\n") + 1));
	};
	f.faux.setResponses([compile("Version one"), read(), compile("Version one"), fauxAssistantMessage("Compiled version one.")]);
	await session.prompt("Register and compile the private artifact");
	const selected = snapshots(session).at(-1)!;
	assert.ok(provenance()[source]?.sourceFingerprint);
	writeFileSync(source, "Version two has different source bytes");
	f.faux.setResponses([read(), compile("Version two"), fauxAssistantMessage("Compiled version two.")]);
	await session.prompt("Compile the changed source");
	assert.equal(f.readState(session, 0, "session").artifacts[source]?.description, "Version two");
	const currentEvidence = provenance()[source];
	const parent = session;
	const parentFiles = captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
	if (operation === "fork") {
		await runtime.fork(selected.id, { position: "at" });
		session = runtime.session;
		assert.deepEqual(captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)), parentFiles);
	} else {
		await session.navigateTree(selected.id, { summarize: false });
	}
	assert.equal(f.readState(session, 0, "session").artifacts[source]?.description, "Version one");
	assert.equal(provenance()[source], undefined, "newer evidence must not certify the older artifact value");
	await session.reload();
	assert.equal(provenance()[source], undefined);
	f.faux.setResponses([
		(context) => {
			const projected = projection(context);
			assert.deepEqual(projected.state.artifacts[source], { description: "Version one" });
			assert.deepEqual(projected.artifact_invalidations, [{ path: source, scope: "session", reason: "invalid-metadata" }]);
			return read();
		},
		compile("Version two"),
		fauxAssistantMessage("Recompiled against the current source."),
	]);
	await session.prompt("Reconcile missing compilation evidence");
	assert.deepEqual(provenance()[source], currentEvidence);
	assert.equal(f.readState(session, 0, "session").artifacts[source]?.description, "Version two");
	await session.reload();
	f.faux.setResponses([(context) => {
		assert.equal(projection(context).artifact_invalidations, undefined);
		return fauxAssistantMessage("Current evidence retained.");
	}]);
	await session.prompt("Use the current compilation without another read");
	assert.deepEqual(provenance()[source], currentEvidence);
});

test("real Pi fork refuses inherited pre-origin pointers without resetting existing child storage", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: false });
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
	const f = await realPiFixture(t, { autoStart: true });
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

for (const passive of [false, true]) for (const invalid of ["identity", "cwd"] as const) test(`real Pi fork rejects ${invalid} parent evidence without fallback and retries the exact source on Start (passive=${passive})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, passiveBootstrap: passive, passiveTools: passive });
	const runtime = await f.createRuntime();
	t.after(() => { runtime.setBeforeSessionInvalidate(undefined); return runtime.dispose(); });
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { mustSurvive: true } }, "Selected source"));
	await parent.prompt("Selected source request");
	const sourceCheckpoint = structuredClone(snapshots(parent).at(-1)!.data);
	const state = f.readState(parent, 0, "session");
	const file = parent.sessionFile!;
	const before = readFileSync(file, "utf8");
	const newline = before.indexOf("\n");
	const header = JSON.parse(before.slice(0, newline));
	if (invalid === "identity") header.id = "wrong-parent";
	else header.cwd = join(f.root, "other-project");
	runtime.setBeforeSessionInvalidate(() => writeFileSync(file, JSON.stringify(header) + before.slice(newline)));
	assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
	runtime.setBeforeSessionInvalidate(undefined);
	const child = runtime.session;
	assert.equal(child.getActiveToolNames().includes("patch_state"), passive);
	assert.throws(() => f.readState(child, 0, "session"), /unavailable/);
	assert.match(f.notifications.at(-1)!, /identity mismatch/);
	assert.deepEqual(snapshots(child).at(-1)!.data, sourceCheckpoint);
	const entries = structuredClone(child.sessionManager.getEntries());
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), passive);
	assert.deepEqual(child.sessionManager.getEntries(), entries);
	writeFileSync(file, before);
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(f.readState(child, 0, "session"), state);
	assert.notDeepEqual(snapshots(child).at(-1)!.data, sourceCheckpoint);
	assert.deepEqual(readFileSync(file, "utf8"), before);
});

for (const scope of ["global", "cwd"] as const) for (const lifecycle of ["Stop", "next request"] as const) test(`real Pi ${lifecycle} adopts foreign ${scope} state without lifecycle semantic writes`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses(sessionResponses({ working: { private: "retained" } }, "Own accepted answer"));
	await session.prompt("Seed private state");
	const privateState = f.readState(session, 0, "session");
	const step = latestSnapshot(session).meta.step;
	const b = new TemporalRuntime(f.cwd, "other-session", f.repositoryRoot);
	const snapshot = emptySnapshot(true);
	b.initialize(snapshot, true);
	const before = b.states();
	const next = structuredClone(before);
	const foreign = `FOREIGN-${scope}-${lifecycle}`;
	next[scope].working.foreign = foreign;
	snapshot.meta.step++;
	b.publish(snapshot, true, createAcceptedTransition(before, next));
	const paths = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const protectedFiles = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session))
		.filter(({ path }) => path !== paths.config && path !== paths.runtime);
	const retained = protectedFiles();
	if (lifecycle === "Stop") {
		await session.prompt("/state-flow-stop");
		assert.equal(latestSnapshot(session).config.enabled, false);
		assert.equal(latestSnapshot(session).meta.step, step);
		assert.deepEqual(protectedFiles(), retained);
	}
	const observations: Array<{ input: string; step: number; files: ReturnType<typeof protectedFiles> }> = [];
	f.faux.setResponses([(context) => {
		observations.push({ input: JSON.stringify(context.messages), step: latestSnapshot(session).meta.step, files: protectedFiles() });
		return fauxAssistantMessage("Next answer");
	}]);
	await session.prompt("Continue after the independent writer");
	assert.equal(observations.length, 1);
	assert.ok(observations[0]!.input.includes(foreign), "the projected context must use the accepted shared adoption");
	assert.equal(observations[0]!.step, step, "run preparation and Stop must not add a semantic transition");
	assert.deepEqual(observations[0]!.files, retained);
	assert.equal(f.readState(session, 0, scope).working.foreign, foreign);
	assert.equal(latestSnapshot(session).meta.step, step + (lifecycle === "Stop" ? 0 : 1));
	if (lifecycle === "Stop") {
		assert.deepEqual(f.readState(session, 0, "session"), privateState);
		await session.reload();
		assert.equal(latestSnapshot(session).config.enabled, false);
		assert.equal(f.readState(session, 0, scope).working.foreign, foreign);
		assert.deepEqual(f.readState(session, 0, "session"), privateState);
	}
});

test("real Pi maintains newly adopted registered artifacts before the first inference", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses(unchangedResponses("Own accepted answer"));
	await session.prompt("Seed the session");
	const step = latestSnapshot(session).meta.step;
	const b = new TemporalRuntime(f.cwd, "other-session", f.repositoryRoot);
	const snapshot = emptySnapshot(true);
	b.initialize(snapshot, true);
	const source = join(f.cwd, "removed-source.txt");
	writeFileSync(source, "Temporary source");
	const before = b.states();
	const next = structuredClone(before);
	next.global.artifacts[source] = { description: "Foreign registration" };
	snapshot.meta.step++;
	b.publish(snapshot, true, createAcceptedTransition(before, next));
	rmSync(source);
	const observations: Array<{ step: number; artifacts: unknown }> = [];
	f.faux.setResponses([() => {
		observations.push({ step: latestSnapshot(session).meta.step, artifacts: f.readState(session, 0, "global").artifacts });
		return fauxAssistantMessage("Reconciled answer");
	}]);
	await session.prompt("Use the newly shared memory");
	assert.deepEqual(observations, [{ step: step + 1, artifacts: {} }], "only proven-missing maintenance, not lifecycle adoption, advances the step before inference");
	assert.equal(latestSnapshot(session).meta.step, step + 2);
});

for (const bootstrap of [false, true]) test(`real Pi mid-tool Stop retains the active trajectory through tree, reload, resume, and restart (${bootstrap ? "bootstrap" : "ordinary"} run)`, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: !bootstrap });
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
		(context) => { restartInput = context; return fauxAssistantMessage("Restarted."); },
	]);
	await resumed.prompt("Migrate the retained continuation");
	assertContinuation(restartInput);
	assert.match(JSON.stringify(restartInput), /State Flow runtime context/);
	let nextInput: unknown;
	fixture.faux.setResponses([
		(context) => { nextInput = context; return fauxAssistantMessage("Next run."); },
	]);
	await resumed.prompt("Next active request");
	assert.doesNotMatch(JSON.stringify(nextInput), /exit handoff|ACTIVE-RAW-REQUEST|TOOL-EVIDENCE|COMPLETED-RAW-REQUEST|ABANDONED-FUTURE/);
});

for (const stopDuringTool of [false, true]) test(`real Pi retains a native split-turn continuation through late tools (Stop=${stopDuringTool})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, {
		autoStart: true, initializeRepository: false, contextWindow: 4_000,
		compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 500 },
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	writeFileSync(join(f.cwd, "early.txt"), `EARLY-TOOL-EVIDENCE\n${"e".repeat(6000)}`);
	writeFileSync(join(f.cwd, "late.txt"), "LATE-TOOL-EVIDENCE\n");
	const frozen = f.readState(session);
	const step = latestSnapshot(session).meta.step;
	const inputs: Context[] = [];
	let summaries = 0;
	let stop: Promise<void> | undefined;
	let stopError: unknown;
	let stoppedWhileBusy = false;
	t.after(session.subscribe((event) => {
		if (!stopDuringTool || event.type !== "tool_execution_start" || event.toolCallId !== "late-read") return;
		stoppedWhileBusy = !session.isIdle;
		stop = session.prompt("/state-flow-stop").catch((error) => { stopError = error; });
	}));
	const respond = async (context: Context) => {
		if (context.messages.some((message) => message.role === "system" && getSystemMessageText(message).startsWith("You are a context summarization assistant."))) {
			summaries++;
			return fauxAssistantMessage("NATIVE-PREFIX-SUMMARY: preserve the original objective and unfinished read work.");
		}
		inputs.push(context);
		if (inputs.length === 1) return fauxAssistantMessage(fauxToolCall("read", { path: "early.txt" }, { id: "early-read" }), { stopReason: "toolUse" });
		if (inputs.length === 2) {
			// Isolate Stop after one real split-turn compaction, not repeated budget checks.
			session.setAutoCompactionEnabled(false);
			await session.sendCustomMessage({ customType: "foreign-split-context", content: "FOREIGN-SPLIT-CONTEXT", display: false }, { triggerTurn: false });
			return fauxAssistantMessage(fauxToolCall("read", { path: "late.txt" }, { id: "late-read" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Finished after the late read.");
	};
	f.faux.setResponses(Array(8).fill(respond));
	await session.prompt(`ORIGINAL-SPLIT-REQUEST:${"x".repeat(20_000)}`);
	if (stop) await stop;
	assert.equal(stopError, undefined);
	assert.equal(inputs.length, 3);
	assert.equal(summaries, 1);
	assert.equal(f.faux.state.callCount, 4);
	const all = session.sessionManager.getEntries();
	const compactions = all.filter((entry) => entry.type === "compaction");
	assert.equal(compactions.length, 1);
	assert.equal(compactions[0]!.fromHook, false);
	const kept = all.find((entry) => entry.id === compactions[0]!.firstKeptEntryId);
	assert.ok(kept?.type === "message" && kept.message.role === "assistant", "the native compaction must split the current turn");
	const original = all.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("ORIGINAL-SPLIT-REQUEST:"));
	assert.ok(original);
	assert.equal(session.sessionManager.buildContextEntries().some((entry) => entry.id === original.id), false);
	assert.deepEqual(all.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read")
		.map((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId, entry.message.isError] : undefined), [["early-read", false], ["late-read", false]]);
	for (const marker of ["NATIVE-PREFIX-SUMMARY", "EARLY-TOOL-EVIDENCE"]) assert.ok(JSON.stringify(inputs[1]!.messages).includes(marker), marker);
	const assertContinuation = (context: Context, handoff = stopDuringTool) => {
		const text = JSON.stringify(context.messages);
		for (const marker of ["NATIVE-PREFIX-SUMMARY", "EARLY-TOOL-EVIDENCE", "LATE-TOOL-EVIDENCE", "FOREIGN-SPLIT-CONTEXT"]) assert.ok(text.includes(marker), marker);
		const calls = context.messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id) : []);
		const results = context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
		assert.deepEqual(calls, ["early-read", "late-read"]);
		assert.deepEqual(results, calls);
		assert.equal(text.includes("State Flow exit handoff"), handoff);
		if (handoff) assert.doesNotMatch(text, /ORIGINAL-SPLIT-REQUEST|ABANDONED-SPLIT-FUTURE/, "never resurrect raw entries outside Pi's selected projection");
	};
	assertContinuation(inputs[2]!);
	if (!stopDuringTool) return;
	assert.ok(stop);
	assert.equal(stoppedWhileBusy, true);
	const assertFrozen = () => {
		assert.deepEqual(f.readState(session), frozen);
		assert.equal(latestSnapshot(session).meta.step, step);
		assert.equal(latestSnapshot(session).config.enabled, false);
	};
	assertFrozen();
	const branch = session.sessionManager.getBranch();
	const marker = branch.findIndex((entry) => entry.type === "custom" && entry.customType === "state-flow-passive-stop");
	const early = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "early-read");
	const late = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "late-read");
	assert.ok(early < marker && marker < late && early >= 0, "successful tool results straddle Stop");
	const file = session.sessionFile!;
	const trace = readFileSync(file, "utf8");
	for (const text of ["ORIGINAL-SPLIT-REQUEST:", "NATIVE-PREFIX-SUMMARY", "EARLY-TOOL-EVIDENCE", "LATE-TOOL-EVIDENCE"]) assert.ok(trace.includes(text));
	const selected = session.sessionManager.getLeafId()!;
	f.faux.setResponses([fauxAssistantMessage("Abandoned response.")]);
	await session.prompt("ABANDONED-SPLIT-FUTURE");
	await session.navigateTree(selected, { summarize: false });
	await session.reload();
	session.setAutoCompactionEnabled(false);
	let reloadedInput: Context | undefined;
	f.faux.setResponses([(context) => { reloadedInput = context; return fauxAssistantMessage("Continued after tree and reload."); }]);
	await session.prompt("Continue the selected split turn");
	assertContinuation(reloadedInput!);
	assertFrozen();
	assert.ok(readFileSync(file, "utf8").startsWith(trace));
	session.dispose();
	const resumed = await f.createSession("resume", SessionManager.open(file, f.sessionDir));
	t.after(() => resumed.dispose());
	resumed.setAutoCompactionEnabled(false);
	let resumedInput: Context | undefined;
	f.faux.setResponses([(context) => { resumedInput = context; return fauxAssistantMessage("Continued after cold resume."); }]);
	await resumed.prompt("Continue after cold resume");
	assertContinuation(resumedInput!);
	assert.deepEqual(f.readState(resumed), frozen);
	assert.equal(latestSnapshot(resumed).meta.step, step);
	await resumed.prompt("/state-flow-start");
	let restartedInput: Context | undefined;
	f.faux.setResponses([(context) => { restartedInput = context; return fauxAssistantMessage("Accepted the bootstrap continuation."); }]);
	await resumed.prompt("Adopt the retained split-turn work");
	assertContinuation(restartedInput!);
	assert.match(JSON.stringify(restartedInput!.messages), /State Flow runtime context/);
	let nextInput: Context | undefined;
	f.faux.setResponses([(context) => { nextInput = context; return fauxAssistantMessage("Next accepted run."); }]);
	await resumed.prompt("Next active request");
	assert.doesNotMatch(JSON.stringify(nextInput!.messages), /exit handoff|NATIVE-PREFIX-SUMMARY|TOOL-EVIDENCE|ORIGINAL-SPLIT-REQUEST|ABANDONED-SPLIT-FUTURE/);
	assert.match(JSON.stringify(nextInput!.messages), /FOREIGN-SPLIT-CONTEXT/, "foreign custom context stays persistent after the bootstrap run");
});

test("real Pi edited-context accounting discards stale provider usage", { timeout: 15_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false, contextWindow: 4_000 });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses([fauxAssistantMessage("Accepted before usage edit.")]);
	await session.prompt("RAW-USAGE-PREFIX ".repeat(800));
	const before = session.getContextUsage();
	assert.ok(before && before.tokens !== null && before.tokens > 4_000);
	const userEntry = session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(userEntry);
	const trace = readFileSync(session.sessionFile!);
	const step = latestSnapshot(session).meta.step;
	session.sessionManager.appendContextEdit(userEntry.id, { content: "EDITED-USAGE-SOURCE" });
	const after = session.getContextUsage();
	assert.ok(after && after.tokens !== null && after.tokens < 3_500, "native usage follows edited projection, not the prior provider's large count");
	assert.equal(f.readState(session).response, "Accepted before usage edit.");
	assert.equal(latestSnapshot(session).meta.step, step);
	session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 500 } });
	let input: Context | undefined;
	const calls = f.faux.state.callCount;
	f.faux.setResponses([(context) => { input = context; return fauxAssistantMessage("Accepted after usage edit."); }]);
	await session.prompt("Continue after native context edit");
	assert.equal(f.faux.state.callCount, calls + 1, "stale usage must not cause a phantom summary or recovery call");
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
	assert.doesNotMatch(JSON.stringify(input!.messages), /RAW-USAGE-PREFIX/);
	assert.ok(readFileSync(session.sessionFile!).subarray(0, trace.length).equals(trace));
	assert.equal(f.readState(session).response, "Accepted after usage edit.");
	assert.equal(latestSnapshot(session).meta.step, step + 1);
	assert.equal(f.notifications.length, 0);
});

for (const pressure of [false, true, "refused"] as const) test(`real Pi settled dispatch preserves deferred companion work (pressure=${pressure})`, { timeout: 15_000 }, async (t) => {
	let armed = false;
	let queued = false;
	let observed = false;
	let tokensBeforeSettled = 0;
	const order: string[] = [];
	const f = await realPiFixture(t, {
		autoStart: true, initializeRepository: false, contextWindow: 400_000,
		extensions: [{ name: "sdk-settled-dispatch", factory: (pi) => {
			pi.on("before_agent_start", (event) => { if (event.prompt === "DEFERRED-AFTER-SETTLED") order.push("deferred-start"); });
			pi.on("session_before_compact", () => { if (pressure === "refused") return { cancel: true }; });
			pi.on("agent_before_settle", (_event, ctx) => { if (armed && !queued) tokensBeforeSettled = ctx.getContextUsage()?.tokens ?? 0; });
			pi.on("agent_settled", () => {
				if (!armed || queued) return;
				queued = true;
				order.push("queue");
				pi.sendUserMessage("DEFERRED-AFTER-SETTLED");
			});
			pi.on("agent_settled", async () => {
				if (!armed || observed) return;
				await Promise.resolve();
				observed = true;
				order.push("last-observer");
			});
		} }],
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses([fauxAssistantMessage("Seed settled history.")]);
	await session.prompt("Seed an older accepted run");
	const step = latestSnapshot(session).meta.step;
	const inputs: Context[] = [];
	armed = true;
	f.faux.setResponses([
		(context) => { inputs.push(context); return fauxAssistantMessage("Accepted before deferred work."); },
		(context) => { inputs.push(context); order.push("deferred-provider"); return fauxAssistantMessage("Deferred work accepted."); },
	]);
	await session.prompt(`Main settled request ${"PRESSURE-HISTORY ".repeat(pressure ? 8_000 : 1)}`);
	await session.waitForIdle();
	assert.equal(tokensBeforeSettled >= 24_000, pressure !== false, "the pressure case crosses the owned-compaction admission threshold");
	const compactions = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
	assert.deepEqual(compactions.map((entry) => entry.fromHook), pressure === true ? [true] : []);
	for (const entry of compactions) assert.equal(entry.summary, STATE_FLOW_COMPACTION_SUMMARY);
	assert.deepEqual(order, ["queue", "last-observer", "deferred-start", "deferred-provider"]);
	assert.equal(inputs.length, 2, "companion follow-up is neither preempted nor duplicated");
	assert.match(JSON.stringify(inputs[1]!.messages), /DEFERRED-AFTER-SETTLED/);
	assert.match(JSON.stringify(inputs[1]!.messages), /Accepted before deferred work\./);
	assert.deepEqual(getCurrentTools(inputs[1]!.messages).map((tool) => tool.name).sort(), ["patch_state", "read", "read_state"], "prompt filtering and owned compaction retain actual tool declarations");
	assert.match(getSystemMessageText(getCurrentSystemMessage(inputs[1]!.messages)!), /State Flow is enabled/);
	assert.equal(f.readState(session).response, "Deferred work accepted.");
	assert.equal(latestSnapshot(session).meta.step, step + 2);
	assert.equal(latestSnapshot(session).meta.specification, undefined);
	assert.equal(f.notifications.length, 0);
});

for (const recovery of ["retry", "length", "overflow"] as const) test(`real Pi recovery omits failed attempts without accepting them (${recovery})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, {
		autoStart: true, initializeRepository: false, contextWindow: 32_000,
		compaction: { enabled: recovery !== "retry", keepRecentTokens: 500, reserveTokens: 2_000 },
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	if (recovery === "retry") session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } });
	f.faux.setResponses(sessionResponses({ working: { recoveryBasis: "durable" } }, "Accepted recovery basis."));
	await session.prompt(`Seed recovery history ${"OLD-RECOVERY-HISTORY ".repeat(600)}`);
	const step = latestSnapshot(session).meta.step;
	const trace = readFileSync(session.sessionFile!);
	const recoveryEvents: unknown[] = [];
	session.subscribe((event) => { if (event.type === "compaction_end" || event.type === "auto_retry_end") recoveryEvents.push(event); });
	let codingCalls = 0;
	let summaryCalls = 0;
	let recoveredInput: Context | undefined;
	const marker = `UNACCEPTED-${recovery.toUpperCase()}-ATTEMPT`;
	const respond = (context: Context) => {
		assert.equal(f.readState(session).response, "Accepted recovery basis.");
		assert.equal(latestSnapshot(session).meta.step, step, "failed attempts and native summaries do not advance semantic history");
		if (context.messages.some((message) => message.role === "system" && getSystemMessageText(message).startsWith("You are a context summarization assistant."))) {
			summaryCalls++;
			assert.equal(JSON.stringify(context.messages).includes(marker), false);
			return fauxAssistantMessage("RECOVERY-SUMMARY: preserve the durable recovery basis and current request.");
		}
		codingCalls++;
		if (codingCalls === 1) return fauxAssistantMessage(marker, recovery === "length" ? { stopReason: "length" } : { stopReason: "error", errorMessage: recovery === "retry" ? "503 Service Unavailable" : "maximum context length exceeded" });
		recoveredInput = context;
		return fauxAssistantMessage("Recovered accepted answer.");
	};
	f.faux.setResponses([respond, respond, respond, respond]);
	await session.prompt(`Recover using the accepted memory basis ${"CURRENT-RECOVERY ".repeat(200)}`);
	assert.equal(codingCalls, 2, `only Pi's one recovery continuation is needed: ${JSON.stringify(recoveryEvents)}`);
	assert.equal(summaryCalls, recovery === "retry" ? 0 : 2, "native split-turn recovery summarizes history and turn prefix separately");
	assert.ok(recoveredInput);
	assert.equal(JSON.stringify(recoveredInput.messages).includes(marker), false);
	assert.match(JSON.stringify(recoveredInput.messages), /Accepted recovery basis\.|durable/);
	const branch = session.sessionManager.getBranch();
	const failed = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes(marker));
	assert.ok(failed, "the failed assistant is retained in raw history");
	assert.ok(branch.some((entry) => entry.type === "context_edit" && entry.targetId === failed.id && entry.replacement === null), "Pi persists the omission rather than mutating its live message array only");
	assert.equal(branch.filter((entry) => entry.type === "compaction").length, recovery === "retry" ? 0 : 1);
	assert.ok(readFileSync(session.sessionFile!).subarray(0, trace.length).equals(trace));
	assert.equal(f.readState(session).response, "Recovered accepted answer.");
	assert.equal(f.readState(session).working.recoveryBasis, "durable");
	assert.equal(latestSnapshot(session).meta.step, step + 1);
	await session.reload();
	assert.equal(JSON.stringify(session.sessionManager.buildSessionContext().messages).includes(marker), false);
	assert.equal(f.readState(session).response, "Recovered accepted answer.");
	assert.equal(f.notifications.length, 0);
});

for (const mode of ["captured", "midrun", "repeated"] as const) for (const passive of [false, true]) test(`real Pi preserves native run identity across mode toggles (${mode}, passive=${passive})`, async (t) => {
	let session: Awaited<ReturnType<RealPiFixture["createSession"]>>;
	let reads = 0;
	const count = mode === "repeated" ? 4 : 2;
	const f = await realPiFixture(t, {
		autoStart: mode === "captured", initializeRepository: false, passiveBootstrap: passive, passiveTools: false,
		extensions: [{ name: "native-anchor-toggles", factory: (pi) => {
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "read") return;
				reads++;
				if (reads % 2 === 0) await session.prompt("/state-flow-stop");
				else if (mode !== "captured") await session.prompt("/state-flow-start");
			});
		} }],
	});
	session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses([fauxAssistantMessage("Earlier answer.")]);
	await session.prompt("R15-OLDER-REQUEST");
	const paths = Array.from({ length: count }, (_, i) => join(f.cwd, `r15-${i}.txt`));
	paths.forEach((path, i) => writeFileSync(path, `R15-READ-${i}`));
	const inputs: Context[] = [];
	f.faux.setResponses([
		...paths.map((path) => (context: Context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }); }),
		(context) => { inputs.push(context); return fauxAssistantMessage("Stopped-run answer."); },
	]);
	await session.prompt("R15-CURRENT-REQUEST");
	assert.equal(reads, count);
	assert.equal(inputs.length, count + 1);
	for (let index = 2; index <= count; index += 2) {
		const text = JSON.stringify(inputs[index]!.messages);
		assert.match(text, /R15-CURRENT-REQUEST/);
		assert.doesNotMatch(text, /R15-OLDER-REQUEST/, "disabled user runs must rotate the native anchor too");
		for (let read = 0; read < index; read++) assert.ok(text.includes(`R15-READ-${read}`));
	}
	const branch = session.sessionManager.getBranch();
	const original = branch.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("R15-CURRENT-REQUEST"));
	assert.ok(original?.type === "message");
	const stops = branch.filter((entry) => entry.type === "custom" && entry.customType === "state-flow-passive-stop");
	assert.equal(stops.length, count / 2);
	for (const entry of stops) {
		assert.ok(entry.type === "custom");
		assert.equal((entry.data as { from: number }).from, original.message.timestamp, "persist the actual observed native anchor, not a guessed boundary");
	}
	const frozenState = structuredClone(f.readState(session));
	const trace = readFileSync(session.sessionFile!);
	await session.reload();
	let afterReload: Context | undefined;
	f.faux.setResponses([(context) => { afterReload = context; return fauxAssistantMessage("Post-reload answer."); }]);
	await session.prompt("R15-FOLLOWUP");
	const restored = JSON.stringify(afterReload!.messages);
	assert.match(restored, /R15-CURRENT-REQUEST/);
	for (let read = 0; read < count; read++) assert.ok(restored.includes(`R15-READ-${read}`));
	assert.deepEqual(f.readState(session), frozenState);
	assert.ok(readFileSync(session.sessionFile!).subarray(0, trace.length).equals(trace));
	assert.ok(f.notifications.every((message) => message.startsWith("State Flow enabled.")));
});

for (const mode of ["stop", "passive-stop", "start", "boundary-stop"] as const) test(`real Pi refreshes protocol within the same run (${mode})`, async (t) => {
	let session: Awaited<ReturnType<RealPiFixture["createSession"]>>;
	let changed = false;
	let starts = 0;
	const f = await realPiFixture(t, {
		autoStart: mode !== "start", initializeRepository: false,
		passiveBootstrap: mode === "passive-stop", passiveTools: false,
		extensions: [{ name: "sdk-midrun-mode", factory: (pi) => {
			pi.on("before_agent_start", (event) => {
				starts++;
				(event.systemPromptOptions.sections ??= {}).foreign_mode = "FOREIGN-MODE-CONTEXT";
			});
			pi.on("tool_result", async (event) => {
				if (mode === "boundary-stop" || changed || event.toolName !== "read") return;
				changed = true;
				await session.prompt(mode === "start" ? "/state-flow-start" : "/state-flow-stop");
			});
			pi.on("agent_before_settle", async (event) => {
				if (mode !== "boundary-stop" || changed || event.outcome !== "completed") return;
				changed = true;
				await session.prompt("/state-flow-stop");
				return { continue: true, entries: [{ type: "custom_message", customType: "mode-followup", content: "CONTINUE-AFTER-BOUNDARY-STOP", display: false }] };
			});
		} }],
	});
	session = await f.createSession("new");
	t.after(() => session.dispose());
	const path = join(f.cwd, "mode-evidence.txt");
	writeFileSync(path, "MODE-READ-EVIDENCE");
	const inputs: Context[] = [];
	f.faux.setResponses([
		(context) => {
			inputs.push(context);
			return mode === "boundary-stop" ? fauxAssistantMessage("Before boundary Stop.") : fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" });
		},
		(context) => { inputs.push(context); return fauxAssistantMessage("After mode change."); },
	]);
	await session.prompt("UNTRUSTED-MIDRUN-SPEC");
	assert.equal(changed, true);
	assert.equal(starts, 1, "mode refresh cannot invent another user run");
	assert.equal(inputs.length, 2);
	const first = getSystemMessageText(getCurrentSystemMessage(inputs[0]!.messages)!);
	const next = getSystemMessageText(getCurrentSystemMessage(inputs[1]!.messages)!);
	assert.equal(first.includes("State Flow is enabled"), mode !== "start");
	assert.equal(next.includes("State Flow is enabled"), mode === "start");
	assert.equal(next.includes("State Flow passive memory is available"), mode === "passive-stop");
	assert.match(next, /FOREIGN-MODE-CONTEXT/);
	assert.doesNotMatch(next, /UNTRUSTED-MIDRUN-SPEC/);
	assert.deepEqual(getCurrentTools(inputs[1]!.messages).map((tool) => tool.name).sort(), mode === "start" ? ["patch_state", "read", "read_state"] : ["read"]);
	assert.match(JSON.stringify(inputs[1]!.messages), mode === "boundary-stop" ? /CONTINUE-AFTER-BOUNDARY-STOP/ : /MODE-READ-EVIDENCE/);
	assert.equal(latestSnapshot(session).config.enabled, mode === "start");
	assert.equal(f.readState(session).response, mode === "start" ? "After mode change." : mode === "boundary-stop" ? "Before boundary Stop." : "");
	const rawSystems = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "system");
	assert.equal(JSON.stringify(rawSystems).includes("State Flow is enabled"), mode !== "start", "request projection does not rewrite earlier native system frames");
});

for (const mode of ["enabled", "passive", "disabled", "forced"] as const) test(`real Pi structured prompt composes with context hooks (${mode})`, async (t) => {
	const conversationSystemPresence: boolean[] = [];
	const fullSystemPresence: boolean[] = [];
	const stateFlowForcedPrompt: boolean[] = [];
	const f = await realPiFixture(t, {
		autoStart: mode !== "disabled", initializeRepository: false,
		passiveBootstrap: mode === "passive", passiveTools: mode !== "disabled",
		extensions: [{ name: "sdk-system-context", factory: (pi) => {
			pi.on("before_agent_start", (event) => {
				stateFlowForcedPrompt.push(event.systemPromptOptions.forceSystemPrompt !== undefined);
				(event.systemPromptOptions.sections ??= {}).companion_before = "COMPANION-BEFORE-PROMPT";
				if (mode === "forced") return { systemPrompt: "EXPLICIT-FOREIGN-FORCED-PROMPT" };
			});
			pi.on("context", (event) => {
				conversationSystemPresence.push(event.messages.some((message) => message.role === "system"));
			});
			pi.on("context_with_system", (event) => {
				const system = getCurrentSystemMessage(event.messages);
				fullSystemPresence.push(system !== undefined);
				if (!system) return;
				return { messages: [{ ...system, sections: { ...system.sections, companion_context: "COMPANION-PER-REQUEST" } }, ...event.messages.filter((message) => message.role !== "system")] };
			});
		} }],
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	if (mode === "passive") await session.prompt("/state-flow-stop");
	const path = join(f.cwd, "system-hooks.txt");
	writeFileSync(path, "HOOK-READ-EVIDENCE");
	const inputs: Context[] = [];
	f.faux.setResponses([
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage("System hooks accepted."); },
	]);
	await session.prompt("UNTRUSTED-SPEC-SYSTEM-HOOK");
	assert.equal(inputs.length, 2);
	for (const input of inputs) {
		const system = getCurrentSystemMessage(input.messages);
		assert.ok(system);
		const text = getSystemMessageText(system);
		assert.doesNotMatch(text, /UNTRUSTED-SPEC-SYSTEM-HOOK/);
		if (mode === "forced") assert.equal(text, "EXPLICIT-FOREIGN-FORCED-PROMPT", "explicit foreign forced prompts keep native precedence");
		else {
			assert.match(text, /COMPANION-BEFORE-PROMPT/);
			assert.match(text, /COMPANION-PER-REQUEST/);
			assert.equal(text.includes("State Flow is enabled"), mode === "enabled");
			assert.equal(text.includes("State Flow passive memory is available"), mode === "passive");
		}
		assert.deepEqual(getCurrentTools(input.messages).map((tool) => tool.name).sort(), mode === "disabled" ? ["read"] : ["patch_state", "read", "read_state"]);
	}
	assert.deepEqual(stateFlowForcedPrompt, [false]);
	assert.deepEqual(conversationSystemPresence, [false, false]);
	assert.deepEqual(fullSystemPresence, [true, true]);
	assert.match(JSON.stringify(inputs[1]!.messages), /HOOK-READ-EVIDENCE/);
	if (mode === "enabled" || mode === "forced") assert.equal(f.readState(session).response, "System hooks accepted.");
	if (mode === "enabled") {
		await session.prompt("/state-flow-stop");
		let lifecycleInput: Context | undefined;
		f.faux.setResponses([(context) => { lifecycleInput = context; return fauxAssistantMessage("Paused answer."); }]);
		await session.prompt("Continue with State Flow stopped");
		const stoppedSystem = getCurrentSystemMessage(lifecycleInput!.messages)!;
		assert.equal(stoppedSystem.sections?.state_flow, undefined, "native section diffs remove the old active protocol");
		assert.doesNotMatch(getSystemMessageText(stoppedSystem), /State Flow is enabled|State Flow passive memory is available/);
		assert.match(getSystemMessageText(stoppedSystem), /COMPANION-PER-REQUEST/);
		assert.equal(f.readState(session).response, "System hooks accepted.", "disabled inference does not reconcile semantic response");
		await session.prompt("/state-flow-start");
		f.faux.setResponses([(context) => { lifecycleInput = context; return fauxAssistantMessage("Restarted answer."); }]);
		await session.prompt("Restart structured protocol");
		const restartedSystem = getCurrentSystemMessage(lifecycleInput!.messages)!;
		assert.match(restartedSystem.sections?.state_flow ?? "", /State Flow is enabled/);
		assert.equal((getSystemMessageText(restartedSystem).match(/State Flow is enabled/g) ?? []).length, 1);
		assert.deepEqual(stateFlowForcedPrompt, [false, false, false]);
	}
});

test("real Pi context edits remain canonical through tools, tree selection and reload", { timeout: 30_000 }, async (t) => {
	let session: Awaited<ReturnType<RealPiFixture["createSession"]>>;
	let editedRead = false;
	const f = await realPiFixture(t, {
		autoStart: false, initializeRepository: false,
		extensions: [{ name: "sdk-context-edits", factory: (pi) => {
			pi.on("turn_end", (event) => {
				if (editedRead || !event.toolResults.some((result) => result.toolName === "read")) return;
				const entry = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read");
				assert.ok(entry?.type === "message");
				session.sessionManager.appendContextEdit(entry.id, { content: [{ type: "text", text: "EDITED-TOOL-RESULT" }] });
				editedRead = true;
			});
		} }],
	});
	session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses([fauxAssistantMessage("RAW-HISTORY-ANSWER")]);
	await session.prompt("RAW-HISTORY-USER");
	await session.sendCustomMessage({ customType: "foreign-omitted", content: "RAW-FOREIGN-OMIT", display: false }, { triggerTurn: false });
	const rawBranch = session.sessionManager.getBranch();
	const oldUser = rawBranch.find((entry) => entry.type === "message" && entry.message.role === "user");
	const oldAnswer = rawBranch.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	const foreign = rawBranch.find((entry) => entry.type === "custom_message" && entry.customType === "foreign-omitted");
	assert.ok(oldUser && oldAnswer && foreign);
	const originalLeaf = session.sessionManager.appendCustomEntry("context-edit-origin", {});
	const originalTrace = readFileSync(session.sessionFile!);
	session.sessionManager.appendContextEdit(oldUser.id, { content: "EDITED-HISTORY-USER" });
	session.sessionManager.appendContextEdit(oldAnswer.id, null);
	session.sessionManager.appendContextEdit(foreign.id, null);
	await session.prompt("/state-flow-start");
	const path = join(f.cwd, "native-context-edit.txt");
	writeFileSync(path, "RAW-TOOL-RESULT");
	const inputs: Context[] = [];
	f.faux.setResponses([
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { independentMemory: "durable" } } }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage("Edited context accepted."); },
	]);
	await session.prompt("Inspect canonical edited history");
	assert.equal(inputs.length, 3);
	for (const input of inputs) {
		assert.match(JSON.stringify(input.messages), /EDITED-HISTORY-USER/);
		assert.doesNotMatch(JSON.stringify(input.messages), /RAW-HISTORY-USER|RAW-HISTORY-ANSWER|RAW-FOREIGN-OMIT/);
	}
	assert.equal(editedRead, true);
	assert.match(JSON.stringify(inputs[2]!.messages), /EDITED-TOOL-RESULT/);
	assert.doesNotMatch(JSON.stringify(inputs[2]!.messages), /RAW-TOOL-RESULT/);
	assert.equal(f.readState(session).working.independentMemory, "durable");
	assert.equal(f.readState(session).response, "Edited context accepted.");
	assert.ok(readFileSync(session.sessionFile!).subarray(0, originalTrace.length).equals(originalTrace), "context edits only append; raw history remains intact");
	const acceptedLeaf = session.sessionManager.getLeafId()!;
	const paths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
	const semantics = () => [readFileSync(paths.checkpoint, "utf8"), readFileSync(paths.patches, "utf8")];
	const acceptedSemantics = semantics();
	await session.navigateTree(originalLeaf, { summarize: false });
	const originalProjection = JSON.stringify(session.sessionManager.buildSessionContext().messages);
	assert.match(originalProjection, /RAW-HISTORY-USER/);
	assert.match(originalProjection, /RAW-HISTORY-ANSWER/);
	assert.match(originalProjection, /RAW-FOREIGN-OMIT/);
	assert.doesNotMatch(originalProjection, /EDITED-HISTORY-USER|EDITED-TOOL-RESULT/);
	assert.deepEqual(semantics(), acceptedSemantics, "selecting a pre-runtime branch does not overwrite accepted semantic files");
	await session.navigateTree(acceptedLeaf, { summarize: false });
	await session.reload();
	const editedProjection = JSON.stringify(session.sessionManager.buildSessionContext().messages);
	assert.match(editedProjection, /EDITED-HISTORY-USER/);
	assert.match(editedProjection, /EDITED-TOOL-RESULT/);
	assert.doesNotMatch(editedProjection, /RAW-HISTORY-USER|RAW-HISTORY-ANSWER|RAW-FOREIGN-OMIT|RAW-TOOL-RESULT/);
	assert.equal(f.readState(session).working.independentMemory, "durable");
	assert.equal(f.readState(session).response, "Edited context accepted.");
	assert.deepEqual(f.notifications, ["State Flow enabled. The next complete agent run will migrate active context into state."]);
});

for (const boundary of ["turn_end", "agent_before_settle"] as const) test(`real Pi boundary continuation keeps accepted State Flow memory (${boundary})`, async (t) => {
	let requested = false;
	let boundaryValid = false;
	let beforeAgentStarts = 0;
	const f = await realPiFixture(t, {
		autoStart: true, initializeRepository: false,
		extensions: [{ name: "sdk-boundary-continuation", factory: (pi) => {
			pi.on("before_agent_start", () => { beforeAgentStarts++; });
			const continueOnce = (event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) => {
				if (requested || event.outcome !== "completed" || (event.type === "turn_end" && event.toolResults.length > 0)) return;
				requested = true;
				boundaryValid = Array.isArray(event.entries) && event.continue === false && typeof event.context.canContinue === "boolean"
					&& (event.type !== "turn_end" || (ctx.sessionManager.getEntry(event.messageEntryId)?.type === "message" && event.toolResultEntryIds.length === 0));
				return { entries: [...event.entries, { type: "custom_message" as const, customType: "sdk-boundary-request", content: "CONTINUE-WITH-ACCEPTED-MEMORY", display: false }], continue: true };
			};
			if (boundary === "turn_end") pi.on("turn_end", continueOnce);
			else pi.on("agent_before_settle", continueOnce);
		} }],
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const continuationInputs: Context[] = [];
	const continuationSpecifications: Array<string | undefined> = [];
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { marker: "ACCEPTED-MEMORY" } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("First accepted answer."),
		(context) => {
			continuationInputs.push(context);
			continuationSpecifications.push(latestSnapshot(session).meta.specification);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { continued: boundary } } }), { stopReason: "toolUse" });
		},
		(context) => {
			continuationInputs.push(context);
			continuationSpecifications.push(latestSnapshot(session).meta.specification);
			return fauxAssistantMessage("Final continued answer.");
		},
	]);
	await session.prompt("Establish memory, then honor the companion boundary.");
	assert.equal(boundaryValid, true);
	assert.equal(beforeAgentStarts, 1, "the native boundary continues without fabricating another user run");
	assert.deepEqual(continuationSpecifications, [undefined, undefined], "completed specification stays absent from retained runtime checkpoints");
	assert.equal(f.faux.state.callCount, 4, "one requested continuation adds no repair or duplicate provider turn");
	assert.equal(continuationInputs.length, 2);
	for (const [index, context] of continuationInputs.entries()) {
		const runtimeTexts = context.messages.flatMap((message) => message.role === "user"
			? typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : [])
			.filter((text) => text.startsWith("State Flow runtime context ("));
		assert.equal(runtimeTexts.length, 1, "every enabled boundary continuation needs exactly one current memory projection");
		const projected = JSON.parse(runtimeTexts[0]!.slice(runtimeTexts[0]!.indexOf("\n") + 1));
		assert.equal(projected.state.working.marker, "ACCEPTED-MEMORY");
		assert.equal(projected.state.working.continued, index === 0 ? undefined : boundary);
		assert.equal(projected.state.response, "First accepted answer.");
		assert.equal(Object.hasOwn(projected, "specification"), false, "completed specifications must not be resurrected for a context-only continuation");
		assert.match(JSON.stringify(context.messages), /CONTINUE-WITH-ACCEPTED-MEMORY/);
		assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name).sort(), ["patch_state", "read", "read_state"]);
	}
	assert.equal(f.readState(session).working.continued, boundary);
	assert.equal(f.readState(session).response, "Final continued answer.");
	assert.equal(latestSnapshot(session).meta.specification, undefined);
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.equal(f.notifications.length, 0);
	assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "sdk-boundary-request"));
});

test("real Pi threshold compaction preserves partial tool work before the first State Flow patch", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, {
		autoStart: true, contextWindow: 4_000,
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
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { continuedAfterThreshold: true } } }), { stopReason: "toolUse" });
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
	const fixture = await realPiFixture(t, { autoStart: true });
	let session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const id = session.sessionId;
	const file = session.sessionFile!;
	const calls = fixture.faux.state.callCount;
	fixture.faux.setResponses(sessionResponses({
		working: { retainedAcrossCompaction: true },
		intents: { current: "Finish validation after compaction" },
	}, "Accepted before compaction."));
	await session.prompt(`LONG-COMPLETED-REQUEST:${"x".repeat(110_000)}`);
	for (let attempt = 0; attempt < 100 && !session.sessionManager.getEntries().some((entry) => entry.type === "compaction"); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(fixture.faux.state.callCount - calls, 2, "State Flow compaction must not request a model summary");
	const all = session.sessionManager.getEntries();
	const compaction = all.find((entry) => entry.type === "compaction");
	assert.ok(compaction && compaction.fromHook === true);
	assert.equal(compaction.summary, STATE_FLOW_COMPACTION_SUMMARY);
	assert.equal((compaction.details as any).owner, "state-flow");
	assert.equal(typeof (compaction.details as any).boundary, "string");
	assert.ok((compaction.details as any).boundary.length > 0);
	assert.equal((compaction.details as any).step, latestSnapshot(session).meta.step);
	const active = session.sessionManager.buildContextEntries();
	assert.ok(active.length < all.length);
	assert.equal(active.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes("LONG-COMPLETED-REQUEST")), true, "the complete latest accepted iteration remains active");
	assert.equal(active.some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message).includes("Accepted before compaction")), true);
	assert.equal(all.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes("LONG-COMPLETED-REQUEST")), true, "full append-only history remains inspectable");
	assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, all.length + 1, "JSONL retains its header and every native entry");
	const state = fixture.readState(session);
	assert.equal(state.working.retainedAcrossCompaction, true);
	assert.equal(state.intents.current, "Finish validation after compaction");
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

function wideSyntheticImage(width = 3000, height = 10): ImageContent {
	const chunk = (name: string, data: Buffer) => {
		const tag = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
		return Buffer.concat([length, tag, data, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 255)]);
	const png = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0)),
	]);
	return { type: "image", mimeType: "image/png", data: png.toString("base64") };
}

for (const stateFlow of [false, true]) test(`real Pi applies image profiles only to newly admitted images (enabled=${stateFlow})`, { timeout: 30_000 }, async (t) => {
	const images = [wideSyntheticImage(), wideSyntheticImage(30, 3000)];
	const f = await realPiFixture(t, {
		autoStart: false, initializeRepository: false, stateFlow,
		tools: stateFlow ? ["read", "patch_state", "read_state", "profile_images"] : ["read", "profile_images"],
		models: [
			{ id: "large-profile", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 1800, maxHeight: 1200 } } } },
			{ id: "small-profile", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 900, maxHeight: 600 } } } },
		],
		extensions: [{ name: "generic-image-tool", factory: (pi) => {
			pi.registerTool({ name: "profile_images", label: "Profile images", description: "Return fixture images", parameters: Type.Object({}), execute: async () => ({ content: structuredClone(images), details: {} }) });
		} }],
	});
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const originalImages = structuredClone(images);
	const dimensions = (image: ImageContent) => {
		assert.equal(image.mimeType, "image/png");
		const bytes = Buffer.from(image.data, "base64");
		assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	};
	const userImages = (context: Context) => context.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content) ? message.content.filter((block): block is ImageContent => block.type === "image") : []);
	const paths = [join(f.cwd, "profile-wide.png"), join(f.cwd, "profile-tall.png")];
	for (let index = 0; index < paths.length; index++) writeFileSync(paths[index]!, Buffer.from(images[index]!.data, "base64"));
	let firstInput: Context | undefined;
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: paths[0] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("profile_images", {}), { stopReason: "toolUse" }),
		(context) => { firstInput = context; return fauxAssistantMessage("Large profile accepted."); },
	]);
	await session.prompt("Inspect large-profile input", { images });
	assert.deepEqual(userImages(firstInput!).map(dimensions), [[1800, 6], [12, 1200]]);
	const historicalPayloads = structuredClone(userImages(firstInput!));
	const historicalTools = structuredClone(firstInput!.messages.filter((message) => message.role === "toolResult"));
	assert.equal(historicalTools.length, 2);
	const originalUser = session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(originalUser);
	const historicalEntry = structuredClone(originalUser);
	const model = f.faux.getModel("small-profile");
	assert.ok(model);
	await session.setModel(model);
	if (stateFlow) await session.prompt("/state-flow-start");
	const inputs: Context[] = [];
	f.faux.setResponses([
		...(stateFlow ? [(context: Context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { imageProfiles: "historical large images retained; new small-profile images" } } }), { stopReason: "toolUse" }); }] : []),
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path: paths[0] }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("read", { path: paths[1] }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("profile_images", {}), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage("Small profile accepted."); },
	]);
	await session.prompt("Compare the retained images with new input and image reads", { images });
	assert.equal(inputs.length, stateFlow ? 5 : 4);
	for (const input of inputs) {
		assert.ok(getCurrentTools(input.messages).some((tool) => tool.name === "profile_images"));
		const admitted = userImages(input);
		assert.deepEqual(admitted.slice(0, 2), historicalPayloads, "switching to a smaller profile cannot rewrite cached historical image bytes");
		assert.deepEqual(admitted.map(dimensions), [[1800, 6], [12, 1200], [900, 3], [6, 600]]);
		assert.deepEqual(input.messages.filter((message) => message.role === "toolResult").slice(0, 2), historicalTools, "historical read and generic tool images keep their original payloads too");
	}
	const results = inputs.at(-1)!.messages.filter((message) => message.role === "toolResult").filter((message) => message.toolName === "read");
	assert.equal(results.length, 3);
	assert.ok(results.every((result) => !result.isError));
	const resultImages = results.flatMap((result) => result.content.filter((block): block is ImageContent => block.type === "image"));
	assert.deepEqual(resultImages.map(dimensions), [[1800, 6], [900, 3], [6, 600]], "only new image reads use the smaller model profile");
	const genericResult = inputs.at(-1)!.messages.findLast((message) => message.role === "toolResult" && message.toolName === "profile_images");
	assert.ok(genericResult?.role === "toolResult" && !genericResult.isError, JSON.stringify(genericResult));
	assert.deepEqual(genericResult.content.filter((block): block is ImageContent => block.type === "image").map(dimensions), [[900, 3], [6, 600]], "generic tool-result images also follow the current profile");
	assert.deepEqual(session.sessionManager.getEntry(originalUser.id), historicalEntry);
	assert.deepEqual(images, originalImages, "normalization does not mutate caller-owned image payloads");
	await session.reload();
	assert.deepEqual(session.sessionManager.getEntry(originalUser.id), historicalEntry);
	assert.deepEqual(session.sessionManager.buildSessionContext().messages.filter((message) => message.role === "toolResult").slice(0, 2).map((message) => message.content), historicalTools.map((message) => message.content));
	if (stateFlow) {
		assert.equal(f.readState(session).response, "Small profile accepted.");
		assert.match(String(f.readState(session).working.imageProfiles), /historical large images retained/);
	}
});

function steeringInputEvidence(context: Context): { image: boolean; readResult: boolean } {
	return {
		image: context.messages.some((entry) => entry.role === "user" && Array.isArray(entry.content) && entry.content.some((block) => block.type === "image")),
		readResult: context.messages.some((entry) => entry.role === "toolResult" && entry.toolName === "read" && JSON.stringify(entry.content).includes("STEERING-TOOL-EVIDENCE")),
	};
}

for (const stateFlow of [false, true]) test(`real Pi retains a normalized image and read evidence through steering without compaction (enabled=${stateFlow})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false, stateFlow });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const source = join(f.cwd, "steering-evidence.txt");
	writeFileSync(source, "STEERING-TOOL-EVIDENCE\n");
	const observed: ReturnType<typeof steeringInputEvidence>[] = [];
	f.faux.setResponses([
		async (context) => {
			observed.push(steeringInputEvidence(context));
			await session.steer("Refine the current request without discarding its image or evidence.");
			return fauxAssistantMessage(fauxToolCall("read", { path: source }), { stopReason: "toolUse" });
		},
		(context) => {
			observed.push(steeringInputEvidence(context));
			return fauxAssistantMessage("Finished the normalized image request.");
		},
	]);
	await session.prompt("Inspect the attached image and read the source.", { images: [wideSyntheticImage()] });
	assert.equal(f.faux.state.callCount, 2);
	assert.deepEqual(observed, [{ image: true, readResult: false }, { image: true, readResult: true }]);
	const entries = session.sessionManager.getEntries();
	assert.equal(entries.some((entry) => entry.type === "compaction"), false);
	assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("[Image: original 3000x10")), "the SDK must actually normalize the valid image");
	assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read" && !entry.message.isError));
});

for (const normalizedImage of [false, true]) test(`real Pi compaction retains the original run through steering, tool results, and foreign context (normalized image=${normalizedImage})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const file = session.sessionFile!;
	const source = join(f.cwd, "steering-evidence.txt");
	writeFileSync(source, "STEERING-TOOL-EVIDENCE\n");
	const original = `ORIGINAL-RUN-REQUEST:${"x".repeat(110_000)}`;
	const firstSteer = "FIRST-STEERING-REFINEMENT";
	const secondSteer = "SECOND-STEERING-REFINEMENT";
	const calls = f.faux.state.callCount;
	let prefixBeforeFinal = "";
	const observed: ReturnType<typeof steeringInputEvidence>[] = [];
	f.faux.setResponses([
		async (context) => {
			observed.push(steeringInputEvidence(context));
			await session.sendCustomMessage({ customType: "foreign-run-context", content: "FOREIGN-RUN-CONTEXT", display: false }, { triggerTurn: false });
			await session.steer(firstSteer);
			await session.steer(secondSteer);
			return fauxAssistantMessage(fauxToolCall("read", { path: source }, { id: "steering-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			observed.push(steeringInputEvidence(context));
			assert.match(JSON.stringify(context.messages), /ORIGINAL-RUN-REQUEST/);
			assert.match(JSON.stringify(context.messages), /FIRST-STEERING-REFINEMENT/);
			assert.match(JSON.stringify(context.messages), /FOREIGN-RUN-CONTEXT/);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { steeringRetained: true } } }), { stopReason: "toolUse" });
		},
		(context) => {
			observed.push(steeringInputEvidence(context));
			assert.match(JSON.stringify(context.messages), /SECOND-STEERING-REFINEMENT/);
			prefixBeforeFinal = readFileSync(file, "utf8");
			return fauxAssistantMessage("Accepted the complete steered run.");
		},
	]);
	await session.prompt(original, normalizedImage ? { images: [wideSyntheticImage()] } : undefined);
	assert.deepEqual(observed, [
		{ image: normalizedImage, readResult: false },
		{ image: normalizedImage, readResult: true },
		{ image: normalizedImage, readResult: true },
	]);
	for (let attempt = 0; attempt < 100 && !session.sessionManager.getEntries().some((entry) => entry.type === "compaction"); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(f.faux.state.callCount - calls, 3, "compaction must not add a model inference");
	const all = session.sessionManager.getEntries();
	const compaction = all.find((entry) => entry.type === "compaction");
	assert.ok(compaction && compaction.fromHook === true, "native compaction must actually happen");
	const request = all.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(original));
	assert.ok(request);
	if (normalizedImage) assert.ok(request.type === "message" && request.message.role === "user" && JSON.stringify(request.message.content).includes("[Image: original 3000x10"));
	assert.equal(compaction.firstKeptEntryId, request.id, "steering cannot replace the original run boundary");
	const retainedIds = all.slice(all.indexOf(request), all.indexOf(compaction))
		.filter((entry) => entry.type === "message" || entry.type === "custom_message").map((entry) => entry.id);
	assert.ok(all.some((entry) => entry.type === "custom_message" && entry.customType === "foreign-run-context"));
	assert.ok(all.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read" && JSON.stringify(entry.message.content).includes("STEERING-TOOL-EVIDENCE")));
	assert.ok(all.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(secondSteer)));
	const verifyRetained = () => {
		const active = session.sessionManager.buildContextEntries();
		const ids = new Set(active.map((entry) => entry.id));
		for (const id of retainedIds) assert.ok(ids.has(id), `the complete native run must retain ${id}`);
		assert.ok(active.length < session.sessionManager.getEntries().length);
	};
	verifyRetained();
	assert.ok(prefixBeforeFinal.length > 0);
	assert.equal(readFileSync(file, "utf8").startsWith(prefixBeforeFinal), true, "compaction never rewrites the trace prefix");
	assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, all.length + 1);
	const state = f.readState(session);
	assert.equal(state.working.steeringRetained, true);
	await session.reload();
	verifyRetained();
	assert.deepEqual(f.readState(session), state);
});

test("real Pi preserves branch-local state through compaction and rejects an expired sibling after fresh-origin navigation", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());

	assert.equal(fixture.statuses.at(-1), "state-flow #0");
	assert.equal(snapshots(session).length, 0);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	const key = nativeSessionKey(session);
	assert.equal(key, basename(session.sessionManager.getSessionFile()!, ".jsonl"));
	assert.equal(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, key).directory,
		join(fixture.repositoryRoot, `--${fixture.cwd.slice(1).replaceAll("/", "-")}--`, key));
	assert.equal(existsSync(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, key).checkpoint), true);
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(latestSnapshot(session).config, { enabled: true });
	writeFileSync(join(fixture.repositoryRoot, "config.json"), JSON.stringify({ autoStart: true }));
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
	try {
		assert.equal(latestSnapshot(session).config.enabled, false);
	} catch (error) {
		assert.match(error instanceof Error ? error.message : String(error), /outside the retained temporal window/);
	}
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
});

test("real Pi Stop preserves a global-only passive branch through reload, patch, and Start", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	writeGlobalState({ ...emptyState(), working: { shared: "global" } }, f.repositoryRoot);
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const before = files();
	await session.prompt("/state-flow-stop");
	assert.deepEqual(snapshots(session).at(-1)?.data, { disabled: true });
	await session.prompt("/state-flow-stop");
	await session.reload();
	assert.deepEqual(files(), before);
	assert.equal(f.readState(session, 0, "global").working.shared, "global");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	f.faux.setResponses(sessionResponses({ working: { local: "retained" } }, "Saved passively."));
	await session.prompt("Save session memory without starting an episode");
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.ok("boundary" in snapshots(session).at(-1)!.data);
	await session.reload();
	assert.equal(f.readState(session, 0, "session").working.local, "retained");
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	await session.prompt("/state-flow-stop");
	assert.ok("boundary" in snapshots(session).at(-1)!.data);
	await session.reload();
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(f.readState(session, 0, "session").working.local, "retained");
	assert.equal(existsSync(join(f.repositoryRoot, ".git")), false);
});

test("real Pi expired selection cannot reset private state through passive Start, Stop, patch, or reload", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	await session.prompt("/state-flow-stop");
	await session.prompt("/state-flow-start");
	const expired = snapshots(session).at(-1)!;
	for (let index = 1; index <= 5; index++) {
		f.faux.setResponses(scopedResponses([
			{ scope: "global", patch: { working: { shared: "retained" } } },
			{ scope: "session", patch: { working: { private: index } } },
		], `Answer ${index}`));
		await session.prompt(`Run ${index}`);
	}
	const retained = snapshots(session).at(-1)!;
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const before = files();
	await session.navigateTree(expired.id, { summarize: false });
	assert.match(f.notifications.at(-1)!, /outside the retained temporal window/);
	assert.equal(f.readState(session, 0, "global").working.shared, "retained");
	assert.throws(() => f.readState(session, 0, "session"), /selected branch is unavailable/);
	await session.prompt("/state-flow-start");
	assert.match(f.notifications.at(-1)!, /selected branch is unavailable/);
	assert.deepEqual(snapshots(session).at(-1), expired);
	await session.prompt("/state-flow-stop");
	assert.deepEqual(files(), before);
	assert.deepEqual(snapshots(session).at(-1), expired);
	await session.reload();
	assert.match(f.notifications.at(-1)!, /outside the retained temporal window/);
	assert.deepEqual(files(), before);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { global: { working: { unsafe: true } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("The selected private state remains unavailable."),
	]);
	await session.prompt("Try a passive patch after failed restoration");
	const rejected = session.sessionManager.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state");
	assert.ok(rejected?.type === "message" && rejected.message.role === "toolResult" && rejected.message.isError);
	assert.match(JSON.stringify(rejected.message.content), /selected branch is unavailable/);
	assert.deepEqual(snapshots(session).at(-1), expired);
	assert.deepEqual(files(), before, "passive tools and ordinary answers cannot publish an empty substitute session");
	await session.navigateTree(retained.id, { summarize: false });
	assert.equal(f.readState(session, 0, "session").working.private, 5);
	f.faux.setResponses(sessionResponses({ working: { continued: true } }, "Restored safely."));
	await session.prompt("Continue from the retained boundary");
	assert.equal(f.readState(session).working.continued, true);
});

test("real Pi refuses contradictory session files without passive substitution and retries the repaired selection", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	writeGlobalState({ ...emptyState(), working: { shared: "retained" } }, f.repositoryRoot);
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses(sessionResponses({ working: { owner: "A" } }, "Saved A."));
	await session.prompt("Remember session A");
	const selected = snapshots(session).at(-1)!;
	const a = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
	const original = (["checkpoint", "patches", "meta"] as const).map((key) => ({ path: a[key], bytes: readFileSync(a[key]) }));
	const b = new TemporalRuntime(f.cwd, "foreign-b", f.repositoryRoot);
	const other = emptySnapshot(true);
	b.initialize(other, true);
	const before = b.states();
	const next = structuredClone(before);
	next.session.working.owner = "B";
	other.meta.step++;
	b.publish(other, true, createAcceptedTransition(before, next));
	const bp = temporalScopePaths(f.cwd, "foreign-b", "session", f.repositoryRoot);
	for (const key of ["checkpoint", "patches", "meta"] as const) writeFileSync(a[key], readFileSync(bp[key]));
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const mixed = files();
	await session.reload();
	assert.ok(f.notifications.some((message) => /Conflicting State Flow temporal lineage/.test(message)));
	assert.equal(f.readState(session, 0, "global").working.shared, "retained");
	assert.throws(() => f.readState(session, 0, "session"), /selected branch is unavailable/);
	await session.prompt("/state-flow-start");
	await session.prompt("/state-flow-stop");
	assert.deepEqual(snapshots(session).at(-1), selected);
	assert.deepEqual(files(), mixed, "failed selection cannot publish a passive replacement");
	for (const { path, bytes } of original) writeFileSync(path, bytes);
	await session.prompt("/state-flow-start");
	assert.equal(f.readState(session, 0, "session").working.owner, "A");
	assert.equal(latestSnapshot(session).config.enabled, true);
});

test("real Pi can restart an early disabled marker as a new origin while preserving shared streams without fallback", async (t) => {
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
	assert.deepEqual(fixture.readState(session, 0, "session"), { artifacts: {}, contract: {}, working: {}, intents: {}, response: "" });
	assert.equal(fixture.readState(session).working.sharedGlobal, "keep");
	assert.equal(fixture.readState(session).working.sharedCwd, "keep");
	assert.throws(() => fixture.readState(session, 1), /predates the proven temporal origin/);
	for (const { path, bytes } of shared) assert.deepEqual(readFileSync(path), bytes);
	await session.navigateTree(later.id, { summarize: false });
	try {
		assert.equal(fixture.readState(session).working.laterPrivate, "keep in cold history");
	} catch (error) {
		assert.match(error instanceof Error ? error.message : String(error), /runtime is unavailable/);
	}
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
		artifacts: {}, contract: {}, working: {}, intents: {}, response: "", lazy: {},
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
		const keys = Object.keys(data).sort();
		assert.ok(keys.every((key) => ["boundary", "bootstrap", "enabled", "specification", "step"].includes(key)));
		assert.ok(["boundary", "enabled", "step"].every((key) => keys.includes(key)));
		assert.equal(typeof (data as any).boundary, "string");
	}
});

test("real Pi logs rejected patches but not accepted patches or answers", async (t) => {
	const fixture = await realPiFixture(t);
	const logPath = join(fixture.agentDir, "tmp", "state-flow", "logs.jsonl");
	const disabled = await fixture.createSession();
	t.after(() => disabled.dispose());
	await disabled.prompt("/state-flow-start");
	fixture.faux.setResponses(sessionResponses({ working: { disabledRun: "accepted" } }, "No diagnostics."));
	await disabled.prompt("Complete without diagnostics");
	assert.equal(existsSync(logPath), false);

	writeFileSync(join(fixture.repositoryRoot, "config.json"), JSON.stringify({ logging: true }));
	const logged = await fixture.createSession();
	t.after(() => logged.dispose());
	await logged.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: {} }, { id: "rejected" }), { stopReason: "toolUse" }),
		...sessionResponses({ working: { loggedRun: "accepted" } }, "Accepted."),
	]);
	await logged.prompt("Reject obsolete finalization then recover");
	const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.length, 1);
	assert.equal(records[0].category, "invalid-patch");
	assert.deepEqual(records[0].input, { session: {} });
	assert.equal(durableSession(fixture, logged).working.loggedRun, "accepted");
	assert.equal(durableSession(fixture, logged).response, "Accepted.");
});

test("real Pi diagnostic write failure leaves resolution and accepted state untouched", async (t) => {
	const fixture = await realPiFixture(t);
	writeFileSync(join(fixture.repositoryRoot, "config.json"), JSON.stringify({ logging: true }));
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	writeFileSync(join(fixture.agentDir, "tmp"), "blocked");
	const beforeFailure = fixture.notifications.length;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: {} }), { stopReason: "toolUse" }),
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
				global: { contract: { sharedDecision: "retained" } },
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

test("real Pi reads prior scoped state lazily after a barrier and rejects path offset eight without a transition", async (t) => {
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
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { version: "new" } } }), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(projection(context).state.working.version, "new");
			beforeReads = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
			checkpointCount = snapshots(session).length;
			return fauxAssistantMessage(fauxToolCall("read_state", { path: "session[1]" }, { id: "history-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "history-read") as any;
			assert.equal(result.isError, false);
			assert.match(result.content[0].text, /^\n\{"value":/);
			const historical = JSON.parse(result.content[0].text);
			assert.equal(historical.value.working.version, "old");
			assert.equal(historical.value.response, "Baseline.");
			assert.equal(projection(context).state.working.version, "new");
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeReads);
			assert.equal(snapshots(session).length, checkpointCount);
			assert.equal(latestSnapshot(session).meta.step, 2);
			return fauxAssistantMessage(fauxToolCall("read_state", { path: "effective[8]" }, { id: "unavailable-read" }), { stopReason: "toolUse" });
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
			return fauxAssistantMessage("Next run.");
		},
	]);
	await session.prompt("Begin a separate run without replaying old tool context");
	const retained = session.sessionManager.getEntries().find((entry) => entry.type === "message"
		&& entry.message.role === "toolResult" && entry.message.toolCallId === "history-read");
	assert.ok(retained?.type === "message" && retained.message.role === "toolResult");
	const content = retained.message.content[0];
	assert.ok(content?.type === "text");
	assert.equal(JSON.parse(content.text).value.working.version, "old", "full native trace survives model-context projection");
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
			fauxToolCall("read_state", { path: "effective" }, { id: "blocked-history" }),
			fauxToolCall("patch_state", {
				session: { working: { barrier: "accepted" } },
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
			return fauxAssistantMessage("Malformed patch rejected without state change.");
		},
	]);
	await session.prompt("Attempt a malformed patch");
});

test("real Pi reconciles unrelated Git history and refuses a shared write racing after inference", async (t) => {
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

	let observedWriter: unknown;
	fixture.faux.setResponses([
		(context) => {
			const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
				.find((block: any) => block.type === "text" && block.text.startsWith("State Flow runtime context"))?.text;
			observedWriter = text && JSON.parse(text.slice(text.indexOf("\n") + 1)).state.working.writer;
			// Before-prompt drift is now adopted; a genuine race must happen after model input selection.
			const competing = new TemporalRuntime(fixture.cwd, "racing-writer", fixture.repositoryRoot);
			const snapshot = emptySnapshot(true);
			competing.initialize(snapshot, true);
			const before = competing.states();
			const next = structuredClone(before);
			next.cwd.working.writer = "racing";
			snapshot.meta.step++;
			competing.publish(snapshot, true, createAcceptedTransition(before, next));
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				cwd: { working: { writer: "second" } },
			}, { id: "stale-cwd-write" }), { stopReason: "toolUse" });
		},
		...unchangedResponses("Second writer was rejected."),
	]);
	await second.prompt("Attempt a simultaneous durable transition");
	assert.equal(observedWriter, "first");
	assert.equal(latestSnapshot(second).meta.step, 1);
	assert.equal(latestSnapshot(second).config.enabled, true);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "racing");
	assert.equal(loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)!.recentTransitions.length, 2);
	const failed = second.sessionManager.getEntries().find((entry: any) => entry.type === "message"
		&& entry.message?.role === "toolResult" && entry.message?.toolCallId === "stale-cwd-write" && entry.message?.isError) as any;
	assert.ok(failed);
	assert.match(failed.message.content[0].text, /live CWD state advanced/);
});

for (const owner of ["global", "cwd", "session"] as const) test(`real Pi compiles an invalidated artifact only into its reported ${owner} scope`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	const source = join(f.cwd, "registered.txt");
	writeFileSync(source, "Version one");
	const read = () => fauxAssistantMessage(fauxToolCall("read", { path: source }), { stopReason: "toolUse" });
	const patch = (scope: typeof owner, output: JsonObject, id: string) => fauxAssistantMessage(fauxToolCall("patch_state", {
		[scope]: { artifacts: { [source]: output } },
	}, { id }), { stopReason: "toolUse" });
	const original = { description: "Original compilation", obsolete: true };
	f.faux.setResponses([patch(owner, original, "register"), read(), patch(owner, original, "compile-original"), fauxAssistantMessage("Original evidence accepted")]);
	await session.prompt("Register and compile the source");
	const step = latestSnapshot(session).meta.step;
	writeFileSync(source, "Version two has new source bytes");
	const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const own = temporalScopePaths(f.cwd, session.sessionId, owner, f.repositoryRoot, nativeSessionKey(session));
	const runtime = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const untouched = (files: typeof before) => files.filter(({ path }) => ![own.checkpoint, own.patches, own.meta, runtime.config, runtime.runtime].includes(path));
	const wrong = owner === "global" ? "cwd" : "global";
	const output = { description: "Version two compiled" };
	let protocol = "";
	let invalidations: unknown;
	let rejected: any;
	let rejectionFiles: typeof before = [];
	let readBasis: typeof before = [];
	let compiledFiles: typeof before = [];
	f.faux.setResponses([
		(context) => {
			protocol = context.messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
			const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
				.find((block: any) => block.type === "text" && block.text.startsWith("State Flow runtime context"))?.text;
			invalidations = text && JSON.parse(text.slice(text.indexOf("\n") + 1)).artifact_invalidations;
			readBasis = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			return read();
		},
		patch(wrong, output, "wrong-owner"),
		(context) => {
			rejected = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "wrong-owner");
			rejectionFiles = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			return patch(owner, output, "right-owner");
		},
		() => {
			compiledFiles = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			return fauxAssistantMessage("Correct scope compiled");
		},
	]);
	await session.prompt("Compile the changed artifact without moving its ownership");
	assert.match(protocol.split("\n").find((line) => line.startsWith("ARTIFACTS:"))!, /reported scope.*global\/cwd\/session/);
	assert.deepEqual(invalidations, [{ path: source, scope: owner, reason: "source-changed" }]);
	assert.equal(rejected?.isError, true);
	assert.ok(rejected.content[0].text.includes(`${owner}.artifacts[${JSON.stringify(source)}]`));
	assert.deepEqual(rejectionFiles, readBasis);
	assert.deepEqual(untouched(compiledFiles), untouched(before));
	assert.deepEqual(f.readState(session, 0, owner).artifacts[source], output);
	const evidence = JSON.parse(readFileSync(own.meta, "utf8")).artifacts[source];
	const stat = statSync(source, { bigint: true });
	assert.deepEqual(evidence, { sourceFingerprint: { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() }, compilerRevision: ORDINARY_ARTIFACT_COMPILER });
	assert.equal(latestSnapshot(session).meta.step, step + 2);
	for (const scope of ["global", "cwd", "session"] as const) if (scope !== owner) assert.equal(f.readState(session, 0, scope).artifacts[source], undefined);
	await session.reload();
	assert.deepEqual(f.readState(session, 0, owner).artifacts[source], output);
	assert.deepEqual(JSON.parse(readFileSync(own.meta, "utf8")).artifacts[source], evidence);
});

test("real Pi ordinary artifact invalidations share the public fingerprint classifier", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const seed = new TemporalRuntime(f.cwd, "seed", f.repositoryRoot);
	const snapshot = emptySnapshot(true);
	seed.initialize(snapshot, true);
	const before = seed.states();
	const next = structuredClone(before);
	const provenance: ArtifactProvenanceRegistry = {};
	const expected: Array<{ path: string; scope: string; reason: string }> = [];
	for (const name of ["current", "pre-epoch", "size", "mtime", "missing", "malformed", "compiler", "compiler-malformed", "obsolete-hash"]) {
		const path = join(f.cwd, `${name}.txt`);
		writeFileSync(path, "Current source");
		if (name === "pre-epoch") utimesSync(path, new Date(-1000), new Date(-1000));
		const stat = statSync(path, { bigint: true });
		const fingerprint = { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() };
		next.global.artifacts[path] = { description: `Retained ${name}` };
		provenance[path] = { sourceFingerprint: fingerprint, compilerRevision: ORDINARY_ARTIFACT_COMPILER };
		if (name === "size") provenance[path]!.sourceFingerprint = { ...fingerprint, size: fingerprint.size + 1 };
		if (name === "mtime") provenance[path]!.sourceFingerprint = { ...fingerprint, mtimeNs: (stat.mtimeNs + 1n).toString() };
		if (name === "missing") delete provenance[path]!.sourceFingerprint;
		if (name === "malformed") provenance[path]!.sourceFingerprint = { size: -1, mtimeNs: "invalid" };
		if (name === "compiler") provenance[path]!.compilerRevision = "artifact-v0";
		if (name === "compiler-malformed") provenance[path]!.compilerRevision = "";
		if (name === "obsolete-hash") provenance[path]!.sourceHash = "obsolete malformed hash";
		if (name !== "current" && name !== "pre-epoch" && name !== "obsolete-hash") expected.push({ path, scope: "global", reason:
			name === "size" || name === "mtime" ? "source-changed" : name === "compiler" ? "compiler-changed" : "invalid-metadata" });
	}
	const skill = join(f.cwd, "SKILL.md");
	writeFileSync(skill, "Skill source");
	next.global.artifacts[skill] = { description: "Shadowed ordinary entry" };
	next.cwd.artifacts[skill] = { description: "Keep Skill identity separate", kind: "skill", compilation: { rule: "Use hashes" } };
	snapshot.meta.step++;
	seed.publish(snapshot, true, createAcceptedTransition(before, next), { provenance: {
		global: provenance, cwd: { [skill]: { sourceHash: hashArtifactSource("Skill source"), compilerRevision: SKILL_ARTIFACT_COMPILER, sourceFingerprint: { size: -1, mtimeNs: "invalid" } } },
	} });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	let projected: any;
	f.faux.setResponses([(context) => {
		const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.find((block: any) => block.type === "text" && block.text.startsWith("State Flow runtime context"))?.text;
		projected = text && JSON.parse(text.slice(text.indexOf("\n") + 1));
		return fauxAssistantMessage("Retained values remain usable.");
	}]);
	await session.prompt("Inspect freshness without reading source bodies");
	assert.deepEqual(projected.artifact_invalidations, expected.sort((a, b) => a.path.localeCompare(b.path)));
	for (const [path, entry] of Object.entries(next.global.artifacts)) {
		if (path !== skill) {
			assert.equal(projected.state.artifacts[path].description, entry.description);
			assert.equal(typeof projected.state.artifacts[path].hint === "string", expected.some((item) => item.path === path && item.reason === "source-changed"));
		}
		assert.deepEqual(loadGlobalState(f.repositoryRoot)!.artifacts[path], entry);
	}
	assert.doesNotMatch(JSON.stringify(projected), /sourceFingerprint|compilerRevision|sha256:/);
	assert.deepEqual(projected.state.artifacts[skill], next.cwd.artifacts[skill]);
});

test("real Pi acquires only invalidated registered artifacts and attaches trusted compilation evidence", async (t) => {
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
		contract: {}, working: {}, intents: {}, response: "", lazy: {},
	}, fixture.repositoryRoot);
	const globalPaths = temporalScopePaths(fixture.cwd, "fixture", "global", fixture.repositoryRoot);
	const globalMeta = JSON.parse(readFileSync(globalPaths.meta, "utf8"));
	globalMeta.artifacts ??= {};
	for (const path of [unchangedPath, changedPath]) {
		globalMeta.artifacts[path] = {
			...(globalMeta.artifacts[path] ?? {}),
			sourceFingerprint: { size: statSync(path).size, mtimeNs: statSync(path, { bigint: true }).mtimeNs.toString() },
		};
	}
	writeFileSync(globalPaths.meta, `${JSON.stringify(globalMeta)}\n`);
	const cwdPaths = temporalScopePaths(fixture.cwd, "fixture", "cwd", fixture.repositoryRoot);
	runGit(
		fixture.repositoryRoot,
		"add",
		globalPaths.checkpoint,
		globalPaths.patches,
		globalPaths.meta,
		cwdPaths.checkpoint,
		cwdPaths.patches,
		cwdPaths.meta,
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
			// Legacy embedded provenance is consumed for compilation decisions but stripped from model projection.
			assert.deepEqual(runtime(context).state.artifacts[unchangedPath], { description: "Stable unchanged guidance" });
			assert.deepEqual(runtime(context).state.artifacts[changedPath], { description: "Original changed guidance" });
			return fauxAssistantMessage("Fresh artifacts reused without source acquisition.");
		},
	]);
	const unchangedSession = await fixture.createSession("new");
	await unchangedSession.prompt("Use the materialized artifact index");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 1);
	unchangedSession.dispose();

	writeFileSync(changedPath, "Changed routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).knowledge_rehydration.phase, "new-bootstrap");
			assert.doesNotMatch(JSON.stringify(context.messages), /Changed routing guidance\./);
			assert.deepEqual(runtime(context).artifact_invalidations, [{
				path: changedPath,
				scope: "global",
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
		sourceFingerprint: { size: statSync(changedPath).size, mtimeNs: statSync(changedPath, { bigint: true }).mtimeNs.toString() },
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});

	// A semantically identical recompilation must still persist fresh fingerprint provenance.
	writeFileSync(changedPath, "Second updated routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.deepEqual(runtime(context).artifact_invalidations, [{ path: changedPath, scope: "global", reason: "source-changed" }]);
			assert.equal(runtime(context).state.artifacts[changedPath].hint, "Source changed since this artifact was compiled. Read and recompile it before relying on it.");
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
		sourceFingerprint: { size: statSync(changedPath).size, mtimeNs: statSync(changedPath, { bigint: true }).mtimeNs.toString() },
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage("Provenance retained without reacquisition.");
		},
	]);
	const provenanceFreshSession = await fixture.createSession("new");
	t.after(() => provenanceFreshSession.dispose());
	await provenanceFreshSession.prompt("Confirm provenance retained");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 1);

	// Removal is a deterministic runtime observation and needs no source-body read or model-authored compiler output.
	rmSync(changedPath);
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage("Removed artifact no longer projected.");
		},
	]);
	const removalSession = await fixture.createSession("new");
	t.after(() => removalSession.dispose());
	await removalSession.prompt("Continue without the deleted source");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 1);
	assert.equal(loadGlobalState(fixture.repositoryRoot)!.artifacts[changedPath], undefined);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], undefined);
});

test("real Pi preserves registered artifacts across reactivation and removes an exact missing source after reload", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
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
	await session.prompt("/state-flow-stop");
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses(unchangedResponses("Reactivated without deleting registered sources."));
	await session.prompt("Reactivate artifact tracking");
	assert.deepEqual(fixture.readState(session, 0, "global"), seeded);
	assert.deepEqual(files.map((path) => readFileSync(path)), bytes);
	rmSync(owned);
	const head = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await session.prompt("/state-flow-status");
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), head, "status is read-only");
	assert.doesNotMatch(fixture.notifications.at(-1)!, /source-removed|Knowledge root|compilation evidence/i);
	await session.reload();
	const beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses(unchangedResponses("Only the removed Markdown source was pruned."));
	await session.prompt("Apply the proven removal after reload");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 1, "removal requires no model read, compilation, or finalization turn");
	const expected = structuredClone(seeded);
	delete expected.artifacts[owned];
	assert.deepEqual(fixture.readState(session, 0, "global"), expected);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[owned], undefined);
});

test("real Pi rejects no-read provenance forgery atomically and accepts a corrected model patch", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
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
			global: { artifacts: { [source]: { description: "Forged provenance", hash: hashArtifactSource("Unacquired source.\n"), compiler: ORDINARY_ARTIFACT_COMPILER } } },
			cwd: { working: { mustNotCommit: true } },
		}, { id: "forged" }), { stopReason: "toolUse" }),
		(context) => {
			rejectedResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "forged");
			rejectedState = fixture.readState(session);
			rejectedStep = latestSnapshot(session).meta.step;
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { corrected: true } } }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Corrected without forging evidence."),
	]);
	await session.prompt("Reject forged provenance and continue");
	assert.equal(rejectedResult?.isError, true);
	assert.match(JSON.stringify(rejectedResult.content), /cannot set runtime-owned field/);
	assert.deepEqual(rejectedState, before);
	assert.equal(rejectedStep, 0);
	assert.equal(fixture.readState(session, 0, "global").artifacts[source], undefined);
	assert.equal(fixture.readState(session, 0, "cwd").working.mustNotCommit, undefined);
	assert.equal(fixture.readState(session, 0, "session").working.corrected, true);
	assert.equal(latestSnapshot(session).meta.step, 2);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[source], undefined);
});

test("real Pi maps registered Skill source scope and leaves independent patches unblocked", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t);
	const registered = {
		global: fixture.registerSkill("user", "user-ax", "# User AX\n\nGlobal guidance."),
		cwd: fixture.registerSkill("project", "project-ax", "# Project AX\n\nProject guidance."),
		session: fixture.registerSkill("temporary", "temporary-ax", "# Temporary AX\n\nSession guidance."),
	};
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	const toolResultText = (context: Context, id: string) => JSON.stringify(context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === id)?.content);
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: registered.global }, { id: "read-user-skill" }), { stopReason: "toolUse" }),
		(context) => {
			assert.match(toolResultText(context, "read-user-skill"), /belongs at global\.artifacts/);
			return fauxAssistantMessage(fauxToolCall("read", { path: registered.cwd }, { id: "read-project-skill" }), { stopReason: "toolUse" });
		},
		(context) => {
			assert.match(toolResultText(context, "read-project-skill"), /belongs at cwd\.artifacts/);
			return fauxAssistantMessage(fauxToolCall("read", { path: registered.session }, { id: "read-temporary-skill" }), { stopReason: "toolUse" });
		},
		(context) => {
			assert.match(toolResultText(context, "read-temporary-skill"), /belongs at session\.artifacts/);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { independent: "accepted" } } }, { id: "independent-patch" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxToolCall("patch_state", {
			global: { artifacts: { [registered.global]: { description: "User guidance", kind: "skill", compilation: { scope: "global" } } } },
			cwd: { artifacts: { [registered.cwd]: { description: "Project guidance", kind: "skill", compilation: { scope: "cwd" } } } },
			session: { artifacts: { [registered.session]: { description: "Temporary guidance", kind: "skill", compilation: { scope: "session" } } } },
		}, { id: "compile-scoped-skills" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: registered.global }, { id: "reread-current-skill" }), { stopReason: "toolUse" }),
		(context) => {
			assert.doesNotMatch(toolResultText(context, "reread-current-skill"), /State Flow acquisition/);
			return fauxAssistantMessage("Scope-aware Skill acquisition accepted.");
		},
	]);
	await session.prompt("Exercise registered Skill acquisition");
	assert.equal(fixture.readState(session, 0, "session").working.independent, "accepted");
	for (const scope of ["global", "cwd", "session"] as const) {
		assert.equal(fixture.readState(session, 0, scope).artifacts[registered[scope]]!.compilation!.scope, scope);
		const paths = temporalScopePaths(fixture.cwd, session.sessionId, scope, fixture.repositoryRoot, nativeSessionKey(session));
		const provenance = JSON.parse(readFileSync(paths.meta, "utf8")).artifacts[registered[scope]];
		assert.equal(provenance.sourceHash, hashSkillSource(registered[scope]));
		assert.equal(provenance.compilerRevision, SKILL_ARTIFACT_COMPILER);
	}
});

test("a fresh real Pi agent continues from compact state and a runtime-compiled Skill artifact", async (t) => {
	const fixture = await realPiFixture(t);
	const skill = fixture.registerSkill("project", "continuation", "# Continuation\n\nPreserve the next discriminating check.\n\nSOURCE-BODY-ONLY-MARKER");
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
			return fauxAssistantMessage("Continuation context verified.");
		},
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
	const sessionPaths = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, nativeSessionKey(session));
	const globalPaths = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "global", fixture.repositoryRoot);
	const cwdPaths = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "cwd", fixture.repositoryRoot);
	const semanticFiles = [globalPaths.checkpoint, globalPaths.patches, cwdPaths.checkpoint, cwdPaths.patches, sessionPaths.checkpoint, sessionPaths.patches];
	assert.equal(semanticFiles.every((path) => existsSync(path)), true);
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
	await session.navigateTree(old.id, { summarize: false });
	assert.equal(fixture.readState(session).working.selected, "old");
	await session.prompt("/state-flow-stop");
	const stopped = latestSnapshot(session);
	assert.equal(stopped.meta.step, 2);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	assert.equal(latestSnapshot(resumed).config.enabled, false);
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
	assert.ok(["old", "new"].includes(fixture.readState(resumed).working.branch as string));
	try {
		assert.equal(fixture.readState(resumed, 1).response, "");
	} catch (error) {
		assert.match(error instanceof Error ? error.message : String(error), /predates the proven temporal origin/);
	}
	await resumed.prompt("/state-flow-start");
	assert.equal(resumed.getActiveToolNames().includes("patch_state"), true);
	assert.equal(fixture.readState(resumed).working.selected, "old");
	assert.equal(fixture.readState(resumed).working.branch, "new");
});

test("real Pi persists without Git, resumes retained boundaries, and later backs up without semantic Git adoption", async (t) => {
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
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { fileSession: "visible" } } }), { stopReason: "toolUse" });
		},
		(context) => {
			assert.equal(current(context).working.fileSession, "visible");
			return fauxAssistantMessage("File-only final answer.");
		},
	]);
	await session.prompt("Persist without Git");
	assert.equal(latestSnapshot(session).meta.step, 3);
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
	assert.deepEqual(fixture.readState(resumed), before[0]);
	assert.throws(() => fixture.readState(resumed, 1), /predates the proven temporal origin/);
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
	const restarted = latestSnapshot(resumed);
	assert.equal(restarted.meta.step, 3);
	assert.throws(() => runGit(fixture.repositoryRoot, "rev-parse", "HEAD"));
	assert.notEqual(childProcess.spawnSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).status, 0);
	fixture.faux.setResponses(unchangedResponses("Canonical answer."));
	await resumed.prompt("Continue with backup available");
	assert.equal(latestSnapshot(resumed).meta.step, 4);
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), "1");
	assert.equal(fixture.readState(resumed).response, "Canonical answer.");
	assert.deepEqual(fixture.readState(resumed, 1), before[0]);
	assert.notEqual(childProcess.spawnSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).status, 0);
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
	assert.equal(JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8")).identity.sessionId, manager.getSessionId());
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
	assert.deepEqual(fixture.readState(second, 0, "session"), { artifacts: {}, contract: {}, working: {}, intents: {}, response: "" });
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

test("real Pi activation stays local without a remote attempt", async (t) => {
	const fixture = await realPiFixture(t, {});
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(fixture.notifications.some((message) => /push is pending/.test(message)), false);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
});

test("real Pi canonical acceptance stays local without a remote attempt", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	fixture.faux.setResponses(unchangedResponses("Local-only by policy."));
	await session.prompt("Accept without remote replication");
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(fixture.readState(session).response, "Local-only by policy.");
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
			return fauxAssistantMessage("Resume bootstrap remained materialized-first.");
		},
	]);
	await resumed.prompt("Resume the exact continuation");
	fixture.faux.setResponses([
		(context) => {
			assert.equal(phase(context), "step");
			return fauxAssistantMessage("Later step used the same bounded route.");
		},
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
	writeFileSync(join(fixture.repositoryRoot, "config.json"), JSON.stringify({ autoStart: false }));
	const manual = await fixture.createSession("new");
	t.after(() => manual.dispose());
	assert.equal(manual.getActiveToolNames().includes("patch_state"), false);
	assert.equal(snapshots(manual).length, 0);
	const enabled = await fixture.createSession("resume", SessionManager.open(enabledFile, fixture.sessionDir));
	t.after(() => enabled.dispose());
	assert.equal(enabled.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(enabled).config.enabled, true);
	assert.deepEqual(JSON.parse(readFileSync(join(fixture.repositoryRoot, "config.json"), "utf8")), { autoStart: false });
});
