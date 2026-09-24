import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, Type, type Context, type ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type AgentBeforeSettleEvent, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER, type ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { STATE_FLOW_COMPACTION_SUMMARY } from "../lib/compaction.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { temporalScopeRevisions } from "../lib/temporal.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { emptyState, projectStateForModel, type MaterializedState } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { awaitInFlightBackupPushes } from "../lib/git.ts";
import { withStorageTransaction } from "../lib/storage.ts";
import { stateFlowLogPath } from "../lib/logging.ts";
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

for (const control of ["stop", "start"] as const) test(`real Pi ${control} keeps local mode off while awaiting a partial foreign publication without private leakage`, { timeout: 20_000 }, async (t) => {
	let child: ReturnType<typeof childProcess.spawn> | undefined;
	let closed: ReturnType<typeof once> | undefined;
	let stopping: Promise<void> | undefined;
	t.after(async () => {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await closed;
		await stopping?.catch(() => undefined);
	});
	const f = await realPiFixture(t, { initializeRepository: false, autoStart: true });
	const session = await f.createSession("new");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { private: "LOCAL-PRIVATE" } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Previous answer"),
	]);
	await session.prompt("Retain this private memory");
	if (control === "start") await session.prompt("/state-flow-stop");
	const cached = f.readState(session);
	const previous = latestSnapshot(session);
	const count = snapshots(session).length;
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const lifecycle = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const semantic = () => files().filter(({ path }) => path !== lifecycle.config && path !== lifecycle.runtime);
	const ready = join(f.root, "stop-writer-ready");
	const release = join(f.root, "stop-writer-release");
	child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
		import { temporalScopePaths } from ${JSON.stringify(new URL("../lib/durable.ts", import.meta.url).href)};
		import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
		import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
		const { root, cwd, ready, release } = JSON.parse(process.argv[1]);
		const pauseAt = temporalScopePaths(cwd, "peer", "global", root).patches;
		const rename = fs.renameSync;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (to !== pauseAt) return;
			fs.writeFileSync(ready, "partial");
			const deadline = Date.now() + 15_000;
			while (!fs.existsSync(release)) {
				if (Date.now() > deadline) throw new Error("Stop fixture gate expired");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		};
		syncBuiltinESMExports();
		await new TemporalRuntime(cwd, "peer", root).withPatchTransaction((tx) => {
			const stage = stageAtomicScopePatches(tx.states, {
				global: { working: { globalPeer: "FOREIGN-G" } },
				cwd: { working: { cwdPeer: "FOREIGN-C" } },
				session: { working: { private: "FOREIGN-PRIVATE-SECRET" } },
			}, [], tx.causalBasis);
			commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted), tx.causalBasis);
		});
	`, JSON.stringify({ root: f.repositoryRoot, cwd: f.cwd, ready, release })], { stdio: ["ignore", "ignore", "inherit"] });
	closed = once(child, "close");
	// Process/SDK startup competes with the full suite; the separate 2.2-second held-owner witness is unchanged.
	const deadline = Date.now() + 10_000;
	while (!existsSync(ready)) {
		if (Date.now() > deadline || child.exitCode !== null) assert.fail(`foreign ${control} fixture writer did not reach its gate (exit ${child.exitCode})`);
		await delay(10);
	}
	const partial = files();
	let ended = false;
	stopping = session.prompt(`/state-flow-${control}`).then(() => { ended = true; });
	await delay(2_200);
	assert.equal(ended, false);
	assert.equal(f.statuses.at(-1), undefined);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	assert.deepEqual(files(), partial);
	assert.deepEqual(f.readState(session), cached);
	assert.equal(snapshots(session).length, count);
	assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	writeFileSync(release, "continue");
	assert.equal((await closed)[0], 0);
	const foreign = semantic();
	await stopping;
	assert.deepEqual(semantic(), foreign, "this mode change preserves accepted semantic and provenance bytes");
	assert.equal(latestSnapshot(session).config.enabled, control === "start");
	assert.equal(latestSnapshot(session).meta.step, previous.meta.step);
	assert.equal(snapshots(session).length, count + 1);
	assert.deepEqual(f.readState(session).working, { globalPeer: "FOREIGN-G", cwdPeer: "FOREIGN-C", private: "LOCAL-PRIVATE" });
	assert.deepEqual(f.readState(session, 0, "session").working, { private: "LOCAL-PRIVATE" });
	assert.equal(f.notifications.some((notice) => /paused|(?:Start|Stop).*failed/.test(notice)), false);
	f.faux.setResponses([(context) => {
		const text = JSON.stringify(context.messages);
		for (const value of ["FOREIGN-G", "FOREIGN-C", "LOCAL-PRIVATE"]) assert.ok(text.includes(value), value);
		assert.equal(text.includes("FOREIGN-PRIVATE-SECRET"), false);
		return fauxAssistantMessage("Accepted mode change is visible");
	}]);
	await session.prompt("Continue with the accepted memory");
});

test("real Pi Abort cancels an in-run Start without waiting for the canonical owner or another provider call", { timeout: 15_000 }, async (t) => {
	let entered!: () => void;
	const reached = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let holder: Promise<unknown> | undefined;
	let prompt: Promise<void> | undefined;
	let starting: Promise<void> | undefined;
	let abortNative: (() => Promise<void>) | undefined;
	t.after(async () => { release(); await abortNative?.(); await holder; await Promise.allSettled([prompt, starting]); });
	let nativeSignal: AbortSignal | undefined;
	const f = await realPiFixture(t, {
		initializeRepository: false, autoStart: true, tools: ["read", "patch_state", "read_state", "await_native_abort"],
		extensions: [{ name: "native-start-boundary", factory: (pi) => {
			pi.registerTool({
				name: "await_native_abort", label: "Await native Abort", description: "Isolated lifecycle witness", parameters: Type.Object({}),
				async execute(_id, _params, signal) {
					nativeSignal = signal;
					entered();
					await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
					return { content: [{ type: "text", text: "Native wait cancelled" }], details: {} };
				},
			});
		} }],
	});
	const session = await f.createSession("new");
	abortNative = () => session.abort();
	assert.ok(session.getActiveToolNames().includes("await_native_abort"));
	f.faux.setResponses([fauxAssistantMessage("Previous accepted answer")]);
	await session.prompt("Keep this answer");
	await session.prompt("/state-flow-stop");
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const before = files();
	const entries = snapshots(session).length;
	holder = withStorageTransaction(f.repositoryRoot, () => gate);
	let calls = 0;
	f.faux.setResponses([() => { calls += 1; return fauxAssistantMessage(fauxToolCall("await_native_abort", {}), { stopReason: "toolUse" }); }]);
	prompt = session.prompt("Retain this uncompiled request after Abort");
	await reached;
	assert.ok(nativeSignal && !nativeSignal.aborted);
	starting = session.prompt("/state-flow-start");
	await delay(40);
	await Promise.race([session.abort(), delay(1_000).then(() => assert.fail("native Abort waited for Start's file owner"))]);
	await Promise.all([prompt, starting]);
	assert.equal(nativeSignal.aborted, true);
	assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	assert.deepEqual(files(), before);
	assert.equal(snapshots(session).length, entries);
	assert.match(JSON.stringify(session.sessionManager.getBranch()), /Retain this uncompiled request after Abort/);
	assert.equal(calls, 1);
	assert.equal(f.statuses.at(-1), undefined);
	assert.match(f.notifications.at(-1)!, /Start failed/);
	release(); await holder;
	await delay(40);
	assert.deepEqual(files(), before, "an aborted activation never revives when the lock becomes free");
	assert.equal(calls, 1);
});

for (const outcome of ["accept", "cancel"] as const) test(`real Pi production preparation ${outcome}s beside a partial foreign publication before inference`, { timeout: 30_000 }, async (t) => {
	let child: ReturnType<typeof childProcess.spawn> | undefined;
	let closed: ReturnType<typeof once> | undefined;
	let prompt: Promise<void> | undefined;
	t.after(async () => {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await closed;
		await prompt?.catch(() => undefined);
	});
	let beforeSeen = false;
	let beforeSignal: AbortSignal | undefined;
	const f = await realPiFixture(t, {
		initializeRepository: false, autoStart: true,
		extensions: [{ name: "observe-native-preparation", factory: (pi) => {
			pi.on("before_agent_start", (_event, ctx) => { beforeSeen = true; beforeSignal = ctx.signal; });
		} }],
	});
	const session = await f.createSession("new");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { private: "LOCAL-PRIVATE" } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Previous answer"),
	]);
	await session.prompt("Establish accepted memory");
	beforeSeen = false;
	const cached = f.readState(session);
	const previous = latestSnapshot(session);
	const checkpointCount = snapshots(session).length;
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const privateDirectory = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session)).directory;
	const privateFiles = files().filter(({ path }) => path.startsWith(privateDirectory));
	assert.equal(privateFiles.length, 5);
	const ready = join(f.root, "preparation-writer-ready");
	const release = join(f.root, "preparation-writer-release");
	const missing = join(f.cwd, "shared-missing.txt");
	const returned = join(f.cwd, "returned-during-wait.txt");
	child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
		import { temporalScopePaths } from ${JSON.stringify(new URL("../lib/durable.ts", import.meta.url).href)};
		import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
		import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
		const { root, cwd, ready, release, missing, returned } = JSON.parse(process.argv[1]);
		const pauseAt = temporalScopePaths(cwd, "peer", "global", root).patches;
		const rename = fs.renameSync;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (to !== pauseAt) return;
			fs.writeFileSync(ready, "partial");
			const deadline = Date.now() + 20_000;
			while (!fs.existsSync(release)) {
				if (Date.now() > deadline) throw new Error("preparation fixture gate expired");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		};
		syncBuiltinESMExports();
		await new TemporalRuntime(cwd, "peer", root).withPatchTransaction((tx) => {
			const stage = stageAtomicScopePatches(tx.states, {
				global: { working: { globalPeer: "FOREIGN-G" }, artifacts: { [missing]: { description: "Missing global registration" } } },
				cwd: { working: { cwdPeer: "FOREIGN-C" }, artifacts: {
					[missing]: { description: "Missing CWD registration" }, [returned]: { description: "Keep the returned source" },
				} },
				session: { working: { secret: "FOREIGN-PRIVATE-SECRET" } },
			}, [], tx.causalBasis);
			const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
			commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted, {
				global: { [missing]: evidence }, cwd: { [missing]: evidence },
			}), tx.causalBasis);
		});
	`, JSON.stringify({ root: f.repositoryRoot, cwd: f.cwd, ready, release, missing, returned })], { stdio: ["ignore", "ignore", "inherit"] });
	closed = once(child, "close");
	const deadline = Date.now() + 5_000;
	while (!existsSync(ready)) {
		if (Date.now() > deadline || child.exitCode !== null) assert.fail("foreign writer did not pause mid-cohort");
		await delay(10);
	}
	const partial = files();
	const inputs: Context[] = [];
	f.faux.setResponses([async (context) => {
		inputs.push(context);
		assert.equal(latestSnapshot(session).meta.specification, "Prepare against current memory");
		assert.equal(latestSnapshot(session).meta.step, previous.meta.step + 1);
		assert.equal(snapshots(session).length, checkpointCount + 1, "lifecycle and maintenance share one checkpoint");
		const current = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		await current.refreshCurrentMemory();
		assert.deepEqual(temporalScopeRevisions(current.view!), { global: 2, cwd: 2, session: 2 });
		return fauxAssistantMessage("Prepared answer");
	}]);
	prompt = session.prompt("Prepare against current memory");
	await delay(2_200);
	assert.equal(beforeSeen, true);
	assert.equal(beforeSignal, undefined);
	assert.equal(inputs.length, 0, "no provider may read the partial cohort or the older cache");
	assert.deepEqual(files(), partial);
	assert.deepEqual(f.readState(session), cached);
	assert.equal(snapshots(session).length, checkpointCount);
	assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	if (outcome === "cancel") {
		await session.abort();
		await prompt;
		assert.deepEqual(files(), partial, "native Abort returns while the independent owner still holds exclusion");
		assert.equal(inputs.length, 0);
	}
	writeFileSync(returned, "Source returned before locked validation");
	writeFileSync(release, "continue");
	assert.equal((await closed)[0], 0);
	await prompt;
	assert.equal(f.notifications.some((notice) => /preparation failed|lock is unavailable/.test(notice)), false);
	if (outcome === "cancel") {
		assert.deepEqual(files().filter(({ path }) => path.startsWith(privateDirectory)), privateFiles);
		assert.deepEqual(f.readState(session), cached);
		assert.equal(snapshots(session).length, checkpointCount);
		assert.equal(inputs.length, 0, "releasing the owner cannot revive canceled inference");
		await session.reload();
		assert.equal(latestSnapshot(session).meta.bootstrap, true, "native input survives even though canceled preparation wrote no checkpoint");
		assert.equal(latestSnapshot(session).meta.specification, undefined);
		await session.prompt("/state-flow-stop");
		const file = session.sessionFile!;
		session.dispose();
		const resumed = await f.createSession("resume", SessionManager.open(file, f.sessionDir));
		f.faux.setResponses([(context) => {
			assert.match(JSON.stringify(context.messages), /State Flow exit handoff/);
			assert.match(JSON.stringify(context.messages), /Prepare against current memory/);
			return fauxAssistantMessage("Uncompiled input retained");
		}]);
		await resumed.prompt("Continue after canceled preparation, reload and Stop");
		return;
	}
	assert.equal(inputs.length, 1);
	const input = inputs[0];
	assert.ok(input);
	const projected = JSON.stringify(input.messages);
	for (const value of ["FOREIGN-G", "FOREIGN-C", "LOCAL-PRIVATE"]) assert.ok(projected.includes(value), value);
	assert.equal(projected.includes("FOREIGN-PRIVATE-SECRET"), false);
	for (const scope of ["global", "cwd"] as const) assert.equal(f.readState(session, 0, scope).artifacts[missing], undefined);
	assert.equal(f.readState(session, 0, "cwd").artifacts[returned]?.description, "Keep the returned source");
	assert.equal(loadGlobalProvenance(f.repositoryRoot)[missing], undefined);
	assert.equal(loadCwdProvenance(f.cwd, f.repositoryRoot)[missing], undefined);
	assert.equal(f.readState(session).response, "Prepared answer");
});

test("real Pi aborts before the provider when atomic inference preparation fails, without losing accepted memory", { timeout: 20_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, autoStart: true });
	const session = await f.createSession("new");
	f.faux.setResponses([fauxAssistantMessage("Previous answer")]);
	await session.prompt("Previously accepted request");
	const previous = latestSnapshot(session);
	const cached = f.readState(session);
	const checkpointCount = snapshots(session).length;
	const missing = join(f.cwd, "missing-before-failed-preparation.txt");
	writeGlobalState({ ...emptyState(), working: { foreign: true }, artifacts: { [missing]: { description: "Retain on failure" } } }, f.repositoryRoot);
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const before = files();
	const path = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)).runtime;
	let providerCalls = 0;
	f.faux.setResponses([() => { providerCalls++; return fauxAssistantMessage("Must not be requested"); }]);
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (to === path) throw new Error("injected native preparation failure");
		rename(from, to);
	};
	syncBuiltinESMExports();
	try { await session.prompt("Abort rather than infer from rejected preparation"); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(providerCalls, 0, "throwing from context alone would not prevent Pi from calling the provider");
	assert.deepEqual(files(), before);
	assert.deepEqual(f.readState(session), cached);
	assert.deepEqual(latestSnapshot(session), previous);
	assert.equal(snapshots(session).length, checkpointCount);
	assert.match(f.notifications.at(-1)!, /inference preparation failed:.*injected native preparation failure/);
	await session.abort();
	f.faux.setResponses([fauxAssistantMessage("Recovered")]);
	await session.prompt("Retry with valid publication");
	assert.equal(f.readState(session).working.foreign, true);
	assert.equal(f.readState(session).artifacts[missing], undefined);
	assert.equal(f.readState(session).response, "Recovered");
});

for (const reload of [false, true]) test(`real Pi retains interrupted boundary-continuation evidence at idle Stop${reload ? " after reload" : ""}`, async (t) => {
	let continued = false;
	const f = await realPiFixture(t, {
		initializeRepository: false, autoStart: true,
		extensions: [{ name: "interruptible-boundary-continuation", factory: (pi) => {
			pi.on("turn_end", (event) => {
				if (continued || event.outcome !== "completed") return;
				continued = true;
				return { entries: [...event.entries, { type: "custom_message" as const, customType: "continued-work", content: "CONTINUED-WORK", display: false }], continue: true };
			});
		} }],
	});
	const session = await f.createSession("new");
	writeFileSync(join(f.cwd, "continued.txt"), "UNCOMPILED-TOOL-EVIDENCE");
	f.faux.setResponses([
		fauxAssistantMessage("Accepted before continuing"),
		fauxAssistantMessage(fauxToolCall("read", { path: "continued.txt" }, { id: "continued-read" }), { stopReason: "toolUse" }),
		fauxAssistantMessage([], { stopReason: "aborted" }),
	]);
	await session.prompt("Original request");
	assert.equal(latestSnapshot(session).meta.specification, undefined, "boundary continuation does not invent a run specification");
	if (reload) await session.reload();
	await session.prompt("/state-flow-stop");
	f.faux.setResponses([(context) => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /State Flow exit handoff/);
		assert.match(text, /CONTINUED-WORK/);
		assert.match(text, /UNCOMPILED-TOOL-EVIDENCE/);
		assert.match(text, /continued-read/);
		return fauxAssistantMessage("No repeated read needed");
	}]);
	await session.prompt("Continue after the interrupted boundary");
	assert.equal(f.readState(session).response, "Accepted before continuing");
});

for (const outcome of ["accept", "cancel"] as const) test(`real Pi context provides a cancellable lifecycle boundary: ${outcome}`, { timeout: 20_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let holder: Promise<void> | undefined;
	let prompt: Promise<void> | undefined;
	t.after(async () => { release(); await holder; await prompt?.catch(() => undefined); });
	let runtime!: TemporalRuntime;
	let beforeSeen = false;
	let beforeSignal: AbortSignal | undefined;
	let contextSignal: AbortSignal | undefined;
	let waiting = false;
	let failure: unknown;
	let providerCalls = 0;
	const snapshot = emptySnapshot(true);
	const specification = "Prepare lifecycle before inference";
	// A host-capability probe, not State Flow's production caller cutover.
	const f = await realPiFixture(t, {
		initializeRepository: false, stateFlow: false,
		extensions: [{ name: "lifecycle-boundary-probe", factory: (pi) => {
			pi.on("before_agent_start", (_event, ctx) => { beforeSeen = true; beforeSignal = ctx.signal; });
			pi.on("context", async (event, ctx) => {
				contextSignal = ctx.signal;
				waiting = true;
				try {
					await runtime.withLifecycleTransaction((publish) => publish({ ...snapshot, meta: { ...snapshot.meta, specification } }), contextSignal);
				} catch (error) {
					failure = error;
					if (!contextSignal?.aborted) throw error;
				}
				return { messages: event.messages };
			});
		} }],
	});
	const session = await f.createSession("new");
	runtime = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	runtime.initialize(snapshot, true);
	const cached = structuredClone(runtime.view);
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	const before = files();
	const paths = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	f.faux.setResponses([(input) => {
		providerCalls++;
		assert.equal(JSON.parse(readFileSync(paths.runtime, "utf8")).specification, specification);
		assert.equal(JSON.stringify(input.messages).includes(specification), true);
		return fauxAssistantMessage("Lifecycle was accepted before inference");
	}]);
	holder = withStorageTransaction(f.repositoryRoot, () => gate);
	let ended = false;
	prompt = session.prompt(specification).then(() => { ended = true; });
	const deadline = Date.now() + 6_000;
	while (!waiting) {
		if (Date.now() > deadline) assert.fail("native context did not reach the lifecycle transaction");
		await delay(10);
	}
	assert.equal(beforeSeen, true);
	assert.equal(beforeSignal, undefined, "SDK 0.87 has no agent abort signal before_agent_start");
	assert.ok(contextSignal, "context runs inside the active native abort lifetime");
	await delay(outcome === "accept" ? 2_200 : 60);
	assert.equal(ended, false);
	assert.equal(providerCalls, 0);
	assert.deepEqual(files(), before);
	assert.deepEqual(runtime.view, cached);
	if (outcome === "cancel") {
		await session.abort();
		await prompt;
		assert.equal(contextSignal.aborted, true);
		assert.equal((failure as Error)?.name, "AbortError");
		assert.deepEqual(files(), before);
		assert.deepEqual(runtime.view, cached);
		assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	}
	release();
	await holder;
	await prompt;
	assert.equal(providerCalls, outcome === "accept" ? 1 : 0);
	if (outcome === "accept") {
		assert.equal(failure, undefined);
		assert.deepEqual(files().filter(({ path }) => path !== paths.config && path !== paths.runtime), before.filter(({ path }) => path !== paths.config && path !== paths.runtime));
		assert.deepEqual(runtime.view, cached);
	} else assert.deepEqual(files(), before, "releasing the owner cannot revive the canceled publication");
});

for (const outcome of ["accept", "cancel"] as const) test(`real Pi awaits foreign publication and ${outcome === "accept" ? "exposes the accepted current head to its next provider" : "cancels waiting without changing canonical memory"}`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, autoStart: true });
	const session = await f.createSession("new");
	const ready = join(f.root, "foreign-ready");
	const release = join(f.root, "foreign-release");
	let child: ReturnType<typeof childProcess.spawn> | undefined;
	let closed: ReturnType<typeof once> | undefined;
	t.after(() => { if (child?.exitCode === null) child.kill("SIGKILL"); });
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	let before: ReturnType<typeof files> | undefined;
	let input: Context | undefined;
	let started = false;
	let ended = false;
	t.after(session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "patch_state") started = true;
		if (event.type === "tool_execution_end" && event.toolName === "patch_state") ended = true;
	}));
	f.faux.setResponses([
		async () => {
			before = files();
			child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
				import fs from "node:fs";
				import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
				import { withStorageTransaction } from ${JSON.stringify(new URL("../lib/storage.ts", import.meta.url).href)};
				import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
				import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
				const { root, cwd, ready, release, outcome } = JSON.parse(process.argv[1]);
				function wait() {
					fs.writeFileSync(ready, "locked");
					const until = Date.now() + 20_000;
					while (!fs.existsSync(release)) {
						if (Date.now() > until) throw new Error("foreign fixture gate expired");
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					}
				}
				if (outcome === "cancel") await withStorageTransaction(root, wait);
				else await new TemporalRuntime(cwd, "foreign", root).withPatchTransaction((tx) => {
					wait();
					const stage = stageAtomicScopePatches(tx.states, {
						global: { working: { globalPeer: "FOREIGN-G" } }, cwd: { working: { cwdPeer: "FOREIGN-C" } },
						session: { working: { peer: "FOREIGN-PRIVATE-SECRET" } },
					}, [], tx.causalBasis);
					commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted, stage.provenanceUpdates), tx.causalBasis);
				});
			`, JSON.stringify({ root: f.repositoryRoot, cwd: f.cwd, ready, release, outcome })], { stdio: ["ignore", "ignore", "inherit"] });
			closed = once(child, "close");
			const deadline = Date.now() + 5_000;
			while (!existsSync(ready)) {
				if (Date.now() > deadline || child.exitCode !== null) throw new Error("foreign writer did not acquire storage");
				await delay(10);
			}
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				global: { working: { globalLocal: "LOCAL-G" } }, cwd: { working: { cwdLocal: "LOCAL-C" } }, session: { working: { private: "LOCAL-PRIVATE" } },
			}), { stopReason: "toolUse" });
		},
		async (context) => {
			input = context;
			const current = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			await current.refreshCurrentMemory();
			assert.deepEqual(temporalScopeRevisions(current.view!), { global: 2, cwd: 2, session: 1 });
			return fauxAssistantMessage("Accepted memory is available.");
		},
	]);
	const prompt = session.prompt("Preserve current shared memory and my private update");
	const deadline = Date.now() + 8_000;
	while (!started) {
		if (Date.now() > deadline) assert.fail("native patch did not start");
		await delay(10);
	}
	await delay(outcome === "accept" ? 2_200 : 80);
	assert.equal(ended, false, "native patch is still waiting, not an ordinary contention failure");
	assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8").trim(), String(child!.pid));
	if (outcome === "cancel") {
		await session.abort();
		await prompt;
		assert.deepEqual(files(), before);
		assert.equal(f.readState(session, 0, "session").working.private, undefined);
		assert.equal(input, undefined);
	}
	writeFileSync(release, "continue");
	assert.equal((await closed!)[0], 0);
	if (outcome === "cancel") return;
	await prompt;
	assert.ok(input);
	const projected = JSON.stringify(input.messages);
	for (const value of ["FOREIGN-G", "FOREIGN-C", "LOCAL-G", "LOCAL-C", "LOCAL-PRIVATE"]) assert.ok(projected.includes(value), value);
	assert.equal(projected.includes("FOREIGN-PRIVATE-SECRET"), false);
	assert.deepEqual(f.readState(session, 0, "global").working, { globalPeer: "FOREIGN-G", globalLocal: "LOCAL-G" });
	assert.deepEqual(f.readState(session, 0, "cwd").working, { cwdPeer: "FOREIGN-C", cwdLocal: "LOCAL-C" });
	assert.deepEqual(f.readState(session, 0, "session").working, { private: "LOCAL-PRIVATE" });
	const results = session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state");
	assert.equal(results.length, 1);
	assert.ok(results[0]?.type === "message" && results[0].message.role === "toolResult" && !results[0].message.isError);
});

for (const outcome of ["accept", "cancel"] as const) test(`real Pi awaits response publication and ${outcome === "accept" ? "continues with accepted current memory" : "honors native abort without losing the unfinished run"}`, { timeout: 30_000 }, async (t) => {
	const answer = "Answer waiting for canonical acceptance";
	let continued = false;
	const f = await realPiFixture(t, {
		initializeRepository: false, autoStart: true,
		extensions: [{ name: "after-response-acceptance", factory: (pi) => {
			pi.on("turn_end", (event) => {
				if (outcome !== "accept" || continued || event.outcome !== "completed" || event.message.role !== "assistant"
					|| !event.message.content.some((part) => part.type === "text" && part.text === answer)) return;
				assert.equal(f.readState(session).response, answer, "later boundary handlers run only after canonical acceptance");
				continued = true;
				return { entries: [...event.entries, { type: "custom_message" as const, customType: "after-response", content: "Observe accepted response memory", display: false }], continue: true };
			});
		} }],
	});
	const session = await f.createSession("new");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { private: "LOCAL-PRIVATE" } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Previously accepted answer"),
	]);
	await session.prompt("Establish private memory");
	const ready = join(f.root, "response-writer-ready");
	const release = join(f.root, "response-writer-release");
	let child: ReturnType<typeof childProcess.spawn> | undefined;
	let closed: ReturnType<typeof once> | undefined;
	t.after(() => { if (child?.exitCode === null) child.kill("SIGKILL"); });
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	let before: ReturnType<typeof files> | undefined;
	let input: Context | undefined;
	let started = false;
	let ended = false;
	t.after(session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant"
			&& event.message.content.some((part) => part.type === "text" && part.text === answer)) started = true;
	}));
	f.faux.setResponses([
		async () => {
			before = files();
			child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
				import fs from "node:fs";
				import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
				import { withStorageTransaction } from ${JSON.stringify(new URL("../lib/storage.ts", import.meta.url).href)};
				import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
				import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
				const { root, cwd, ready, release, outcome } = JSON.parse(process.argv[1]);
				function wait() {
					fs.writeFileSync(ready, "locked");
					const deadline = Date.now() + 20_000;
					while (!fs.existsSync(release)) {
						if (Date.now() > deadline) throw new Error("response writer fixture expired");
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					}
				}
				if (outcome === "cancel") await withStorageTransaction(root, wait);
				else await new TemporalRuntime(cwd, "foreign", root).withPatchTransaction((tx) => {
					wait();
					const stage = stageAtomicScopePatches(tx.states, {
						global: { working: { globalPeer: "FOREIGN-G" } }, cwd: { working: { cwdPeer: "FOREIGN-C" } },
						session: { working: { secret: "FOREIGN-PRIVATE-SECRET" } },
					}, [], tx.causalBasis);
					commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted), tx.causalBasis);
				});
			`, JSON.stringify({ root: f.repositoryRoot, cwd: f.cwd, ready, release, outcome })], { stdio: ["ignore", "ignore", "inherit"] });
			closed = once(child, "close");
			const deadline = Date.now() + 5_000;
			while (!existsSync(ready)) {
				if (Date.now() > deadline || child.exitCode !== null) throw new Error("foreign response writer did not acquire storage");
				await delay(10);
			}
			return fauxAssistantMessage(answer);
		},
		async (context) => {
			input = context;
			const current = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			await current.refreshCurrentMemory();
			assert.deepEqual(temporalScopeRevisions(current.view!), { global: 1, cwd: 1, session: 3 });
			assert.equal(latestSnapshot(session).meta.specification, undefined);
			return fauxAssistantMessage("Continued after accepted response");
		},
	]);
	const prompt = session.prompt("Reconcile this accepted response").then(() => { ended = true; });
	const deadline = Date.now() + 8_000;
	while (!started) {
		if (Date.now() > deadline) assert.fail("native final answer did not reach reconciliation");
		await delay(10);
	}
	await delay(outcome === "accept" ? 2_200 : 80);
	assert.equal(ended, false, "Pi awaits acceptance rather than surfacing ordinary contention");
	assert.deepEqual(files(), before, "waiting does not complete lifecycle or alter accepted state");
	assert.equal(f.readState(session).response, "Previously accepted answer");
	assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8").trim(), String(child!.pid));
	if (outcome === "cancel") {
		await session.abort();
		await prompt;
		assert.deepEqual(files(), before);
		assert.equal(f.readState(session).response, "Previously accepted answer");
		assert.equal(input, undefined);
		assert.equal(continued, false);
	}
	writeFileSync(release, "continue");
	assert.equal((await closed!)[0], 0);
	if (outcome === "cancel") {
		assert.equal(latestSnapshot(session).meta.specification, "Reconcile this accepted response");
	} else {
		await prompt;
		assert.equal(continued, true, JSON.stringify(f.notifications));
		assert.ok(input);
		const projected = JSON.stringify(input.messages);
		for (const value of [answer, "FOREIGN-G", "FOREIGN-C", "LOCAL-PRIVATE"]) assert.ok(projected.includes(value), value);
		assert.equal(projected.includes("FOREIGN-PRIVATE-SECRET"), false);
		assert.equal(f.readState(session).response, "Continued after accepted response");
		assert.equal(continued, true);
	}
	assert.equal(f.notifications.some((notice) => /reconciliation failed|lock is unavailable/.test(notice)), false);
});

for (const outcome of ["accept", "busy"] as const) test(`real Pi ${outcome === "accept" ? "settles only after the local backup commit" : "defers unabortable backup contention without undoing its accepted answer"}`, { timeout: 20_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let owner: Promise<void> | undefined;
	let prompt: Promise<void> | undefined;
	t.after(async () => { release(); await owner; await prompt?.catch(() => undefined); });
	let locked = false;
	let laterBoundary = false;
	let repairRequested = false;
	let acceptedFiles: ReturnType<typeof captureTemporalFileBases> | undefined;
	const answer = "Answer accepted before optional backup";
	const f = await realPiFixture(t, {
		autoStart: true,
		extensions: [{ name: "awaited-backup-boundary", factory: (pi) => {
			pi.on("turn_end", (event) => {
				if (locked || event.outcome !== "completed" || event.message.role !== "assistant") return;
				assert.equal(f.readState(session).response, answer);
				assert.equal(latestSnapshot(session).meta.specification, undefined);
				acceptedFiles = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
				locked = true;
				if (outcome === "busy") owner = withStorageTransaction(f.repositoryRoot, () => gate);
			});
			pi.on("agent_before_settle", (_event, ctx) => {
				laterBoundary = true;
				if (outcome === "busy") assert.equal(ctx.signal, undefined, "SDK 0.87 has no native abort signal at settlement");
				if (outcome === "accept") assert.notEqual(runGit(f.repositoryRoot, "rev-parse", "HEAD"), head, "later handlers observe the completed local backup");
			});
		} }],
	});
	const session = await f.createSession("new");
	const head = runGit(f.repositoryRoot, "rev-parse", "HEAD");
	f.faux.setResponses([fauxAssistantMessage(answer), () => { repairRequested = true; return fauxAssistantMessage("No repair should be requested"); }]);
	let settled = false;
	prompt = session.prompt("Accept the answer, then back it up").then(() => { settled = true; });
	const deadline = Date.now() + 6_000;
	while (!locked) {
		if (Date.now() > deadline) assert.fail("accepted turn did not reach the backup gate");
		await delay(10);
	}
	await prompt;
	assert.equal(settled, true);
	assert.equal(laterBoundary, true, "later settlement handlers observe a finished commit or explicit deferral");
	assert.equal(f.readState(session).response, answer);
	if (outcome === "busy") {
		await session.abort();
		await prompt;
		assert.equal(runGit(f.repositoryRoot, "rev-parse", "HEAD"), head);
		assert.equal(readFileSync(join(f.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	}
	release();
	await owner;
	await prompt;
	assert.equal(f.readState(session).response, answer);
	assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), acceptedFiles);
	assert.equal(latestSnapshot(session).meta.specification, undefined);
	assert.equal(repairRequested, false);
	assert.equal(existsSync(join(f.repositoryRoot, ".git", "state-flow-backup.lock")), false);
	assert.equal(f.notifications.some((notice) => /Git backup failed|lock is unavailable/.test(notice)), false);
	assert.equal(f.notifications.filter((notice) => /Git backup deferred.*no cancellable settlement wait/.test(notice)).length, outcome === "busy" ? 1 : 0);
});

for (const scope of ["global", "cwd", "session"] as const) test(`real Pi transports actionable long-path diagnostics and accepts an exact-target correction (${scope})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false });
	writeFileSync(join(f.repositoryRoot, "config.json"), JSON.stringify({ autoStart: true, logging: true }));
	const session = await f.createSession("new");
	const path = join(f.cwd, "long directory/".repeat(60), "knowledge.json");
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	let before: ReturnType<typeof files> | undefined;
	let afterRejection: ReturnType<typeof files> | undefined;
	let nextInput: Context | undefined;
	const attempted = { [scope]: { working: { diagnosticProbe: true }, artifacts: { [path]: {} } } };
	f.faux.setResponses([
		() => {
			before = files();
			return fauxAssistantMessage(fauxToolCall("patch_state", attempted), { stopReason: "toolUse" });
		},
		(context) => {
			nextInput = context;
			afterRejection = files();
			return fauxAssistantMessage(fauxToolCall("patch_state", { [scope]: { working: { diagnosticProbe: true }, artifacts: { [path]: { description: "Corrected artifact" } } } }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Corrected without changing the target."),
	]);
	await session.prompt("Remember the artifact, correcting any validation error");
	assert.ok(before && afterRejection);
	assert.deepEqual(afterRejection, before, "diagnostic rendering cannot accept any part of the rejected patch");
	const rejected = session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state" && entry.message.isError);
	assert.ok(rejected?.type === "message" && rejected.message.role === "toolResult");
	const text = rejected.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	assert.match(text, /^\nArtifact metadata at /);
	assert.equal(text.slice(1).includes("\n"), false);
	assert.ok(text.length <= 221);
	assert.ok(text.includes(`${scope}.artifacts[`));
	assert.match(text, /knowledge\.json/);
	assert.match(text, /must have a non-empty description$/);
	assert.deepEqual(rejected.message.details, {}, "Pi does not carry the original Error.cause in tool details");
	assert.deepEqual(nextInput!.messages.findLast((message) => message.role === "toolResult" && message.toolName === "patch_state")?.content, rejected.message.content);
	assert.equal(f.readState(session, 0, scope).artifacts[path]?.description, "Corrected artifact");
	assert.equal(f.readState(session, 0, scope).working.diagnosticProbe, true);
	const record = JSON.parse(readFileSync(stateFlowLogPath(f.agentDir), "utf8").trim());
	assert.equal(record.toolCallId, rejected.message.toolCallId);
	assert.deepEqual(record.input, attempted);
	assert.ok(record.error.includes(JSON.stringify(path)), "opt-in diagnostics keep the complete target, not its display abbreviation");
});

test("real Pi transports nested publication causes as text without requiring Error.cause", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false });
	writeFileSync(join(f.repositoryRoot, "config.json"), JSON.stringify({ autoStart: true, logging: true }));
	const session = await f.createSession("new");
	const path = join(f.repositoryRoot, "long directory/".repeat(40), "runtime.json");
	const cause = new Error(`EACCES: permission denied, open '${path}'`);
	const failure = new Error("Canonical memory publication failed", { cause });
	let armed = false;
	const publish = TemporalRuntime.prototype.publish;
	t.mock.method(TemporalRuntime.prototype, "publish", function (this: TemporalRuntime, ...args: Parameters<typeof publish>) {
		if (armed && args[2] !== undefined) { armed = false; throw failure; }
		return publish.apply(this, args);
	});
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	let before: ReturnType<typeof files> | undefined;
	let after: ReturnType<typeof files> | undefined;
	let nextInput: Context | undefined;
	f.faux.setResponses([
		() => { armed = true; before = files(); return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { diagnosticFault: true } } }), { stopReason: "toolUse" }); },
		(context) => { nextInput = context; after = files(); return fauxAssistantMessage("The memory write failed; ordinary conversation continues."); },
	]);
	await session.prompt("Attempt a memory update");
	assert.ok(before && after);
	assert.deepEqual(after, before);
	assert.equal(f.readState(session).working.diagnosticFault, undefined);
	const rejected = session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state" && entry.message.isError);
	assert.ok(rejected?.type === "message" && rejected.message.role === "toolResult");
	const text = rejected.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	assert.match(text, /^\nCanonical memory publication failed: EACCES: permission denied/);
	assert.match(text, /runtime\.json/);
	assert.ok(text.length <= 221);
	assert.deepEqual(rejected.message.details, {});
	assert.deepEqual(nextInput!.messages.findLast((message) => message.role === "toolResult" && message.toolName === "patch_state")?.content, rejected.message.content);
	const record = JSON.parse(readFileSync(stateFlowLogPath(f.agentDir), "utf8").trim());
	assert.ok(record.error.includes(cause.message));
});

test("real Pi starts State Flow in an ordinary conversation after reload", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: false, passiveBootstrap: true, passiveTools: true, initializeRepository: false });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	for (let index = 1; index <= 4; index++) {
		f.faux.setResponses([fauxAssistantMessage(`Ordinary answer ${index}`)]);
		await session.prompt(`Ordinary question ${index}`);
	}
	assert.equal(snapshots(session).length, 0);
	await session.reload();
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(latestSnapshot(session).meta.bootstrap, true);
	let bootstrapInput: Context | undefined;
	f.faux.setResponses([(context) => {
		bootstrapInput = context;
		return fauxAssistantMessage("Bootstrap completed.");
	}]);
	await session.prompt("Compile the prior conversation");
	assert.match(JSON.stringify(bootstrapInput!.messages), /Ordinary question 1/);
	assert.match(JSON.stringify(bootstrapInput!.messages), /Ordinary answer 4/);
	assert.equal(f.readState(session).response, "Bootstrap completed.");
});

for (const fault of ["concurrent", "locked"] as const) test(`real Pi failed Stop stays passive through late tools, tree, reload and resume (${fault})`, { timeout: 30_000 }, async (t) => {
	let session: Awaited<ReturnType<RealPiFixture["createSession"]>>;
	let armed = false;
	let stopped = false;
	let canonical: ReturnType<typeof captureTemporalFileBases>;
	const inputs: Context[] = [];
	const f = await realPiFixture(t, {
		initializeRepository: false, autoStart: true, passiveBootstrap: true, passiveTools: true,
		extensions: [{ name: "stop-failure", factory: (pi) => {
			pi.on("tool_result", async (event) => {
				if (!armed || event.toolName !== "read") return;
				armed = false;
				if (fault === "concurrent") {
					const peer = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
					const snapshot = (await peer.refreshCurrentMemory())!;
					const before = peer.states();
					const next = structuredClone(before);
					next.session.working.peer = "accepted";
					snapshot.config.enabled = true;
					snapshot.meta.step++;
					peer.publish(snapshot, true, createAcceptedTransition(before, next));
				}
				canonical = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
				const lock = join(f.repositoryRoot, ".state-flow-publication.lock");
				if (fault === "locked") mkdirSync(lock);
				try {
					await session.prompt("/state-flow-stop");
					stopped = true;
				} finally {
					if (fault === "locked") rmSync(lock, { recursive: true });
				}
			});
		} }],
	});
	session = await f.createSession("new");
	f.faux.setResponses(sessionResponses({ working: { private: "retained" } }, "Compiled memory"));
	await session.prompt("Establish private memory");
	const trace = readFileSync(session.sessionFile!);
	const source = join(f.cwd, "trajectory.txt");
	writeFileSync(source, "READ_RESULT_TO_RETAIN");
	armed = true;
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: source }), { stopReason: "toolUse" }),
		(context) => { inputs.push(context); return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { unsafe: true } } }), { stopReason: "toolUse" }); },
		(context) => { inputs.push(context); return fauxAssistantMessage("Ordinary answer after Stop"); },
	]);
	await session.prompt("UNCOMPILED_REQUEST: retain the complete read trajectory");
	assert.equal(stopped, true);
	assert.equal(inputs.length, 2);
	assert.match(JSON.stringify(inputs[0]!.messages), /UNCOMPILED_REQUEST/);
	assert.match(JSON.stringify(inputs[0]!.messages), /READ_RESULT_TO_RETAIN/);
	const handoff = inputs[0]!.messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("State Flow exit handoff"));
	assert.match(JSON.stringify(handoff), /private.*retained/);
	assert.doesNotMatch(JSON.stringify(inputs[0]!.messages), /State Flow is enabled/);
	const rejected = session.sessionManager.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state");
	assert.ok(rejected?.type === "message" && rejected.message.role === "toolResult" && rejected.message.isError);
	assert.match(JSON.stringify(rejected.message.content), /paused after Stop/);
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
	assert.deepEqual(files(), canonical!);
	assert.deepEqual(readFileSync(session.sessionFile!).subarray(0, trace.length), trace);
	const stoppedLeaf = session.sessionManager.getLeafId()!;
	f.faux.setResponses([fauxAssistantMessage("Later passive answer")]);
	await session.prompt("Another ordinary request");
	await session.navigateTree(stoppedLeaf, { summarize: false });
	assert.deepEqual(files(), canonical!, "tree restoration must not publish an older private selection");
	await session.reload();
	assert.deepEqual(files(), canonical!);
	const file = session.sessionFile!;
	session.dispose();
	session = await f.createSession("resume", SessionManager.open(file));
	assert.deepEqual(files(), canonical!, "cold resume remains read-only despite canonical enabled=true");
	assert.equal(f.readState(session, 0, "session").working.private, "retained");
	if (fault === "concurrent") assert.equal(f.readState(session, 0, "session").working.peer, "accepted");
	let continued: Context | undefined;
	f.faux.setResponses([(context) => { continued = context; return fauxAssistantMessage("Still ordinary"); }]);
	await session.prompt("Continue without active State Flow");
	assert.match(JSON.stringify(continued!.messages), /UNCOMPILED_REQUEST/);
	assert.match(JSON.stringify(continued!.messages), /READ_RESULT_TO_RETAIN/);
	assert.doesNotMatch(JSON.stringify(continued!.messages), /State Flow is enabled/);
	assert.deepEqual(files(), canonical!);
	await session.prompt("/state-flow-status");
	assert.match(f.notifications.at(-1)!, /branch mode=inactive/);
	assert.match(f.notifications.at(-1)!, /Memory writes paused after Stop/);
	await session.prompt("/state-flow-start");
	f.faux.setResponses(sessionResponses({ working: { restarted: true } }, "Accepted after explicit Start"));
	await session.prompt("Compile retained context and continue");
	assert.equal(f.readState(session, 0, "session").working.restarted, true);
	assert.equal(f.readState(session, 0, "session").working.private, "retained");
	if (fault === "concurrent") assert.equal(f.readState(session, 0, "session").working.peer, "accepted");
});

test("real Pi forks a failed-Stop source as disabled without inheriting its write fence", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, autoStart: true, passiveBootstrap: true, passiveTools: true });
	const runtime = await f.createRuntime("new");
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { inherited: "retained" } }, "Parent answer"));
	await parent.prompt("Remember parent memory");
	const files = () => captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
	const before = files();
	const lock = join(f.repositoryRoot, ".state-flow-publication.lock");
	mkdirSync(lock);
	try { await parent.prompt("/state-flow-stop"); } finally { rmSync(lock, { recursive: true }); }
	assert.deepEqual(files(), before);
	assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
	const child = runtime.session;
	assert.equal(latestSnapshot(child).config.enabled, false);
	assert.equal(f.readState(child, 0, "session").working.inherited, "retained");
	await child.reload();
	f.faux.setResponses(sessionResponses({ working: { child: true } }, "Passive child answer"));
	await child.prompt("Patch child memory while passive");
	assert.equal(f.readState(child, 0, "session").working.child, true);
	assert.equal(latestSnapshot(child).config.enabled, false);
	assert.deepEqual(files(), before, "child activation policy cannot repair or overwrite its parent's canonical files");
});

for (const priorActive of [false, true]) test(`real Pi repeated Start/Stop preserves uncompiled conversation and its prior boundary (${priorActive ? "restart" : "first activation"})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { initializeRepository: false, passiveBootstrap: true, passiveTools: true });
	const session = await f.createSession("new");
	if (priorActive) {
		await session.prompt("/state-flow-start");
		f.faux.setResponses(sessionResponses({ working: { established: true } }, "Established memory."));
		await session.prompt("ALREADY_COMPILED_CONVERSATION");
		await session.prompt("/state-flow-stop");
	}
	f.faux.setResponses([fauxAssistantMessage("Ordinary requirement acknowledged.")]);
	await session.prompt("UNCOMPILED_REQUIREMENT: use a violet interface.");
	const before = structuredClone(session.sessionManager.getEntries());
	for (let cycle = 0; cycle < 2; cycle++) {
		await session.prompt("/state-flow-start");
		assert.equal(latestSnapshot(session).meta.bootstrap, true);
		await session.prompt("/state-flow-stop");
		await session.reload();
	}
	assert.deepEqual(session.sessionManager.getEntries().slice(0, before.length), before, "mode changes preserve the native trace");
	let passiveInput: Context | undefined;
	f.faux.setResponses([(context) => { passiveInput = context; return fauxAssistantMessage("Continuing normally."); }]);
	await session.prompt("Continue without losing the earlier requirement");
	assert.match(JSON.stringify(passiveInput!.messages), /UNCOMPILED_REQUIREMENT/);
	assert.doesNotMatch(JSON.stringify(passiveInput!.messages), /ALREADY_COMPILED_CONVERSATION/);
	await session.prompt("/state-flow-start");
	let bootstrapInput: Context | undefined;
	f.faux.setResponses([
		(context) => {
			bootstrapInput = context;
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { interface: "violet" } } }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Requirement compiled."),
	]);
	await session.prompt("Compile and continue");
	assert.match(JSON.stringify(bootstrapInput!.messages), /UNCOMPILED_REQUIREMENT/);
	assert.notEqual(latestSnapshot(session).meta.bootstrap, true);
	let laterInput: Context | undefined;
	f.faux.setResponses([(context) => { laterInput = context; return fauxAssistantMessage("Continued from memory."); }]);
	await session.prompt("Use the saved interface");
	assert.doesNotMatch(JSON.stringify(laterInput!.messages), /UNCOMPILED_REQUIREMENT|ALREADY_COMPILED_CONVERSATION/);
	assert.equal(f.readState(session).working.interface, "violet");
});

test("real Pi initializes wholly absent CWD files before inference without resurrecting them", { timeout: 30_000 }, async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	let session = await fixture.createSession("new");
	t.after(() => session.dispose());
	fixture.faux.setResponses(scopedResponses([{ scope: "cwd", patch: { working: { must_not_resurrect: "old-cwd-value" } } }], "Seeded CWD answer."));
	await session.prompt("Seed CWD state");
	const paths = temporalScopePaths(fixture.cwd, session.sessionId, "cwd", fixture.repositoryRoot, nativeSessionKey(session));
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
	fixture.faux.setResponses([(context) => {
		assert.equal(fixture.readState(session, 0, "cwd").working.must_not_resurrect, undefined);
		assert.equal(existsSync(paths.checkpoint), true);
		assert.equal(existsSync(paths.patches), true);
		assert.doesNotMatch(JSON.stringify(context.messages), /old-cwd-value/);
		return fauxAssistantMessage("Recovered ordinary answer.");
	}]);
	await session.prompt("Answer after the complete live CWD pair disappeared");
	assert.equal(fixture.notifications.some((message) => /Live State Flow cwd scope storage is incomplete/.test(message)), false);
	assert.equal(fixture.readState(session).response, "Recovered ordinary answer.", fixture.notifications.join("\n"));
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

for (const operation of ["tree", "fork"] as const) test(`real Pi ${operation} selection awaits a held publisher and the next provider sees only the selected private memory`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const runtime = await f.createRuntime();
	t.after(() => runtime.dispose());
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { private: "SELECTED-PRIVATE" } }, "Selected answer"));
	await parent.prompt("Selected request");
	const point = parent.sessionManager.getLeafId()!;
	f.faux.setResponses(sessionResponses({ working: { private: "LATER-PRIVATE" } }, "Later answer"));
	await parent.prompt("Later request");
	const parentFiles = captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
	let entered!: () => void;
	let release!: () => void;
	const holding = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; });
	t.after(async () => { release(); await holder; });
	await holding;
	let ended = false;
	const selecting = (operation === "tree"
		? parent.navigateTree(point, { summarize: false })
		: runtime.fork(point, { position: "at" })).then(() => { ended = true; });
	await delay(200);
	assert.equal(ended, false, "the native lifecycle awaits owned restoration under exclusion");
	if (operation === "tree") {
		assert.throws(() => f.readState(parent, 0, "session"), /restoration is pending/);
		assert.equal(parent.getActiveToolNames().includes("patch_state"), false);
	}
	release();
	await holder;
	await selecting;
	const session = runtime.session;
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(f.readState(session, 0, "session").working.private, "SELECTED-PRIVATE");
	if (operation === "fork") {
		assert.notEqual(session.sessionId, parent.sessionId);
		assert.equal(latestSnapshot(session).meta.step, 0);
		assert.deepEqual(captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent))
			.filter(({ path }) => path.includes(nativeSessionKey(parent))), parentFiles.filter(({ path }) => path.includes(nativeSessionKey(parent))), "fork never rewrites parent-private files");
	}
	let input = "";
	f.faux.setResponses([(context) => { input = JSON.stringify(context.messages); return fauxAssistantMessage("Next answer"); }]);
	await session.prompt("Next request");
	assert.match(input, /SELECTED-PRIVATE/);
	assert.doesNotMatch(input, /LATER-PRIVATE/);
	assert.equal(f.readState(session, 0, "session").working.private, "SELECTED-PRIVATE");
});

for (const restart of [false, true]) test(`public Pi child control during pending fork preserves independent memory (restart=${restart})`, { timeout: 30_000 }, async (t) => {
	let capture!: (session: AgentSession) => void;
	const created = new Promise<AgentSession>((resolve) => { capture = resolve; });
	const f = await realPiFixture(t, {
		autoStart: true, initializeRepository: false, passiveTools: true, passiveBootstrap: true,
		onSessionCreated: (session, event) => { if (event.reason === "fork") capture(session); },
	});
	const runtime = await f.createRuntime();
	const parent = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { private: "SELECTED-FORK-PRIVATE" } }, "Selected answer"));
	await parent.prompt("Selected request");
	const point = parent.sessionManager.getLeafId()!;
	f.faux.setResponses(sessionResponses({ working: { private: "LATER-PARENT-PRIVATE" } }, "Later answer"));
	await parent.prompt("Later request");
	const parentPrefix = sessionRuntimePaths(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)).config.slice(0, -"config.json".length);
	const parentFiles = () => captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)).filter(({ path }) => path.startsWith(parentPrefix));
	const before = parentFiles();
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(f.repositoryRoot, async () => { enter(); await gate; });
	await entered;
	let forked = false;
	const forking = runtime.fork(point, { position: "at" }).then((result) => { forked = true; return result; });
	let starting: Promise<void> | undefined;
	try {
		const child = await Promise.race([created, delay(5_000).then(() => { throw new Error("native fork factory did not expose its child"); })]);
		await delay(100);
		assert.throws(() => f.readState(child, 0, "session"), /restoration is pending/);
		await Promise.race([child.prompt("/state-flow-stop"), delay(1_000).then(() => assert.fail("Stop waited for child memory"))]);
		if (restart) starting = child.prompt("/state-flow-start");
		await delay(20);
		assert.equal(forked, false);
		assert.equal(f.statuses.at(-1), undefined);
		assert.deepEqual(parentFiles(), before);
	} finally { release(); await holder; }
	assert.equal((await forking).cancelled, false);
	await starting;
	const child = runtime.session;
	assert.notEqual(child.sessionId, parent.sessionId);
	assert.equal(latestSnapshot(child).config.enabled, restart);
	assert.equal(f.readState(child, 0, "session").working.private, "SELECTED-FORK-PRIVATE");
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	let input = "";
	f.faux.setResponses([(context) => {
		input = JSON.stringify(context.messages);
		return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { childOnly: true } } }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("Independent child answer")]);
	await child.prompt("Continue in the child");
	assert.match(input, /SELECTED-FORK-PRIVATE/);
	assert.doesNotMatch(input, /LATER-PARENT-PRIVATE/);
	assert.equal(f.readState(child, 0, "session").working.childOnly, true);
	assert.equal(latestSnapshot(child).config.enabled, restart);
	assert.deepEqual(parentFiles(), before);
});

test("real Pi Stop during tree restoration preserves passive memory and next-provider context", { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false, passiveTools: true, passiveBootstrap: true });
	const runtime = await f.createRuntime();
	const session = runtime.session;
	f.faux.setResponses(sessionResponses({ working: { private: "SELECTED-PASSIVE-PRIVATE" } }, "Selected answer"));
	await session.prompt("Selected request");
	const point = session.sessionManager.getLeafId()!;
	f.faux.setResponses(sessionResponses({ working: { private: "LATER-PRIVATE" } }, "Later answer"));
	await session.prompt("Later request");
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(f.repositoryRoot, async () => { enter(); await gate; });
	await entered;
	let selected = false;
	const navigating = session.navigateTree(point, { summarize: false }).then(() => { selected = true; });
	try {
		await delay(100);
		assert.throws(() => f.readState(session, 0, "session"), /restoration is pending/);
		await Promise.race([session.prompt("/state-flow-stop"), delay(1_000).then(() => assert.fail("Stop blocked on tree restoration"))]);
		await delay(20);
		assert.equal(selected, false, "mode change must not cancel selected memory restoration");
		assert.equal(f.statuses.at(-1), undefined);
	} finally { release(); await holder; }
	await navigating;
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(f.readState(session, 0, "session").working.private, "SELECTED-PASSIVE-PRIVATE");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	let input = "";
	f.faux.setResponses([(context) => {
		input = JSON.stringify(context.messages);
		return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { passivePatch: true } } }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("Passive answer")]);
	await session.prompt("Continue passively");
	assert.match(input, /SELECTED-PASSIVE-PRIVATE/);
	assert.match(input, /Selected request/);
	assert.doesNotMatch(input, /LATER-PRIVATE/);
	assert.equal(f.readState(session, 0, "session").working.passivePatch, true);
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(f.notifications.some((notice) => /writes paused|cancelled by Stop/.test(notice)), false);
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

test("real Pi fork rejects inherited history but explicit Start preserves its current child-owned memory", { timeout: 30_000 }, async (t) => {
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
	f.faux.setResponses(sessionResponses({ working: { childOwned: true } }, "Child answer"));
	await child.prompt("Keep the child's own changes");
	const ownedPoint = child.sessionManager.getLeafId()!;
	const selected = f.readState(child);
	const paths = temporalScopePaths(f.cwd, child.sessionId, "session", f.repositoryRoot, nativeSessionKey(child));
	const files = [paths.checkpoint, paths.patches, paths.meta, sessionRuntimePaths(f.cwd, child.sessionId, f.repositoryRoot, nativeSessionKey(child)).config];
	const before = files.map((path) => readFileSync(path));
	const head = runGit(f.repositoryRoot, "rev-parse", "HEAD");
	await child.navigateTree(inheritedPoint, { summarize: false });
	assert.equal(child.getActiveToolNames().includes("patch_state"), false);
	await child.prompt("/state-flow-start");
	assert.equal(child.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(f.readState(child), selected, "activation uses the existing child's current memory, not an empty reset or a new parent copy");
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
		assert.equal(text.includes("COMPLETED-RAW-REQUEST"), bootstrap, "a bootstrap cannot discard conversation it has not compiled");
		assert.doesNotMatch(text, /ABANDONED-FUTURE/);
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
	assert.match(compactions[0]!.summary, /Turn Context \(split turn\)/, "the native compaction must split the current turn");
	// Pi also retains invisible metadata immediately before the cut. Preparation now checkpoints after the native user.
	const kept = all.slice(all.findIndex((entry) => entry.id === compactions[0]!.firstKeptEntryId)).find((entry) => entry.type === "message");
	assert.ok(kept?.type === "message" && kept.message.role === "assistant", "the first retained conversation entry is still the tool-bearing assistant");
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
		assert.equal(text.includes("R15-OLDER-REQUEST"), mode !== "captured", "mid-run activation retains uncompiled pre-bootstrap context independently of the run anchor");
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
		assert.equal((entry.data as { preserveContext?: boolean }).preserveContext === true, mode !== "captured");
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

	assert.equal(fixture.statuses.at(-1), undefined);
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

for (const mode of ["passive", "active", "interrupted"] as const) test(`real Pi activates current ${mode} memory after expired tree selection and reload`, { timeout: 30_000 }, async (t) => {
	let session: Awaited<ReturnType<RealPiFixture["createSession"]>>;
	let interrupted = false;
	const f = await realPiFixture(t, {
		initializeRepository: false, passiveBootstrap: true, passiveTools: true,
		extensions: [{ name: "interrupt-state-flow", factory: (pi) => {
			pi.on("tool_result", async (event) => {
				if (mode !== "interrupted" || interrupted || event.toolName !== "patch_state") return;
				interrupted = true;
				await session.prompt("/state-flow-stop");
			});
		} }],
	});
	session = await f.createSession("new");
	if (mode !== "passive") await session.prompt("/state-flow-start");
	let old: ReturnType<typeof snapshots>[number] | undefined;
	for (let index = 1; index <= 9; index++) {
		f.faux.setResponses(scopedResponses([{ scope: "session", patch: { working: { private: index } } }], `Answer ${index}`));
		await session.prompt(`Request ${index}`);
		if (index === 1) old = snapshots(session).at(-1)!;
	}
	const step = latestSnapshot(session).meta.step;
	assert.equal(latestSnapshot(session).config.enabled, mode === "active");
	assert.equal(latestSnapshot(session).meta.specification !== undefined, mode === "interrupted");
	assert.equal(f.readState(session, 0, "session").working.private, 9);
	await session.navigateTree(old!.id, { summarize: false });
	assert.match(f.notifications.at(-1)!, /outside the retained temporal window/);
	await session.reload();
	const paths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
	const privateBefore = readFileSync(paths.checkpoint, "utf8");
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(latestSnapshot(session).meta.step, step);
	assert.equal(latestSnapshot(session).meta.specification, undefined);
	assert.equal(f.readState(session, 0, "session").working.private, 9);
	assert.equal(readFileSync(paths.checkpoint, "utf8"), privateBefore, "activation must not discard private state");
	let nextInput: Context | undefined;
	f.faux.setResponses([(context) => { nextInput = context; return fauxAssistantMessage("Reconciled after activation."); }]);
	await session.prompt("Continue actively");
	const runtimeUser = nextInput!.messages.find((message) => message.role === "user"
		&& Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.startsWith("State Flow runtime context")));
	assert.ok(runtimeUser?.role === "user" && Array.isArray(runtimeUser.content));
	assert.match(runtimeUser.content.find((block) => block.type === "text")?.text ?? "", /"private":9/);
	assert.equal(f.readState(session).response, "Reconciled after activation.");
	await session.prompt("/state-flow-stop");
	await session.prompt("/state-flow-start");
	assert.equal(f.readState(session, 0, "session").working.private, 9);
});

test("real Pi expired selection fences passive publication until explicit current-memory activation", { timeout: 30_000 }, async (t) => {
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
	await session.prompt("/state-flow-stop");
	assert.deepEqual(files(), before);
	assert.deepEqual(snapshots(session).at(-1), expired);
	const notices = f.notifications.length;
	await session.reload();
	assert.equal(f.notifications.length, notices, "degraded Stop does not repeat restoration warnings");
	assert.equal(f.readState(session, 0, "session").working.private, 5);
	assert.deepEqual(files(), before);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { global: { working: { unsafe: true } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("The selected private state remains unavailable."),
	]);
	await session.prompt("Try a passive patch after failed restoration");
	const rejected = session.sessionManager.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "patch_state");
	assert.ok(rejected?.type === "message" && rejected.message.role === "toolResult" && rejected.message.isError);
	assert.match(JSON.stringify(rejected.message.content), /paused after Stop/);
	assert.deepEqual(snapshots(session).at(-1), expired);
	assert.deepEqual(files(), before, "passive tools and ordinary answers cannot publish an empty substitute session");
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(f.readState(session, 0, "session").working.private, 5);
	assert.match(f.notifications.at(-1)!, /State Flow enabled/);
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
	const notices = f.notifications.length;
	await session.prompt("/state-flow-start");
	assert.equal(f.notifications.length, notices + 1, "a refused activation emits only one final error");
	assert.match(f.notifications.at(-1)!, /Start failed.*Conflicting State Flow temporal lineage/);
	assert.doesNotMatch(f.notifications.at(-1)!, /\n/);
	assert.ok(f.notifications.at(-1)!.length <= 220);
	await session.prompt("/state-flow-stop");
	assert.deepEqual(snapshots(session).at(-1), selected);
	assert.deepEqual(files(), mixed, "failed selection cannot publish a passive replacement");
	for (const { path, bytes } of original) writeFileSync(path, bytes);
	await session.prompt("/state-flow-start");
	assert.equal(f.readState(session, 0, "session").working.owner, "A");
	assert.equal(latestSnapshot(session).config.enabled, true);
});

test("real Pi explicit Start on a pre-runtime selection retains current same-session memory and shared streams", async (t) => {
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
		{ scope: "session", patch: { working: { laterPrivate: "retained current memory" } } },
	], "Later branch"));
	await session.prompt("Save later branch");
	const later = snapshots(session).at(-1)!;
	const acceptedStep = latestSnapshot(session).meta.step;
	const privateState = fixture.readState(session, 0, "session");
	const priorState = fixture.readState(session, 1);
	const shared = ["global", "cwd"].flatMap((scope) => {
		const pair = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), scope as "global" | "cwd", fixture.repositoryRoot);
		return [pair.checkpoint, pair.patches].map((path) => ({ path, bytes: readFileSync(path) }));
	});
	await session.navigateTree(marker.id, { summarize: false });
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, acceptedStep);
	assert.deepEqual(fixture.readState(session, 0, "session"), privateState);
	assert.equal(fixture.readState(session).working.sharedGlobal, "keep");
	assert.equal(fixture.readState(session).working.sharedCwd, "keep");
	assert.deepEqual(fixture.readState(session, 1), priorState);
	for (const { path, bytes } of shared) assert.deepEqual(readFileSync(path), bytes);
	await session.navigateTree(later.id, { summarize: false });
	assert.equal(fixture.readState(session).working.laterPrivate, "retained current memory");
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

test("real Pi preserves unrelated Git history and accepts a shared write against a head advanced after inference", async (t) => {
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
		...unchangedResponses("Second writer was accepted."),
	]);
	await second.prompt("Attempt a simultaneous durable transition");
	assert.equal(observedWriter, "first");
	assert.equal(latestSnapshot(second).meta.step, 2);
	assert.equal(latestSnapshot(second).config.enabled, true);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "second");
	assert.equal(loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)!.recentTransitions.length, 3);
	assert.equal(fixture.readState(second, 2, "cwd").working.writer, "racing", "the predecessor is the accepted current head, not model input");
	const accepted = second.sessionManager.getEntries().find((entry: any) => entry.type === "message"
		&& entry.message?.role === "toolResult" && entry.message?.toolCallId === "stale-cwd-write") as any;
	assert.ok(accepted && !accepted.message.isError);
	assert.match(accepted.message.content[0].text, /State materialized atomically/);
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

for (const scope of ["global", "cwd"] as const) for (const variant of ["duplicate", "competing", "invalid"] as const) test(`real Pi ${scope} Skill compilation respects an independent writer (${variant})`, { timeout: 30_000 }, async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const skill = f.registerSkill(scope === "global" ? "user" : "project", `race-${scope}`, "# Shared Skill\n\nRetain the exact source identity.");
	const session = await f.createSession("new");
	const card = { description: "Shared Skill", kind: "skill", compilation: { rule: "LOCAL-COMPILED" } };
	const peerCard = variant === "duplicate" ? card : { description: "Earlier compilation", kind: "skill", compilation: { rule: "PEER-COMPILED", obsolete: true }, obsolete: true };
	const paths = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, nativeSessionKey(session));
	const peerPrefix = sessionRuntimePaths(f.cwd, "skill-peer", f.repositoryRoot).config.slice(0, -"config.json".length);
	const peerFiles = () => captureTemporalFileBases(f.cwd, "skill-peer", f.repositoryRoot).filter(({ path }) => path.startsWith(peerPrefix));
	let peerBefore: ReturnType<typeof peerFiles> = [];
	let localBefore: ReturnType<typeof captureTemporalFileBases> = [];
	let sharedBefore: string[] = [];
	let revision = 0, step = 0;
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { private: "LOCAL-PRIVATE" } } }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: skill }, { id: "read-racing-skill" }), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "read-racing-skill");
			assert.match(JSON.stringify(result), new RegExp(`belongs at ${scope}\\.artifacts`));
			// An independent process accepts shared compilation after this agent acquired the source.
			childProcess.execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
				import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
				import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
				import { hashSkillSource } from ${JSON.stringify(new URL("../lib/skills.ts", import.meta.url).href)};
				import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
				const { cwd, root, scope, skill, card } = JSON.parse(process.argv[1]);
				await new TemporalRuntime(cwd, "skill-peer", root).withPatchTransaction((tx) => {
					const stage = stageAtomicScopePatches(tx.states, {
						[scope]: { artifacts: { [skill]: card }, working: { independentPeer: "KEEP-PEER-FIELD" } },
						session: { working: { private: "FOREIGN-PRIVATE-SECRET" } },
					}, [{ path: skill, scope, hash: hashSkillSource(skill) }], tx.causalBasis);
					commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted, stage.provenanceUpdates), tx.causalBasis, { finalizeRun: false });
				});
			`, JSON.stringify({ cwd: f.cwd, root: f.repositoryRoot, scope, skill, card: peerCard })], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
			peerBefore = peerFiles();
			localBefore = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			assert.equal(peerBefore.length, 5);
			sharedBefore = [paths.checkpoint, paths.patches, paths.meta].map((path) => readFileSync(path, "utf8"));
			revision = JSON.parse(sharedBefore[2]!).temporal.revision;
			step = latestSnapshot(session).meta.step;
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				[scope]: { artifacts: { [skill]: variant === "invalid" ? { ...card, compilation: {} } : card } },
				...(variant === "invalid" ? { session: { working: { mustNotAccept: true } } } : {}),
			}, { id: "compile-racing-skill" }), { stopReason: "toolUse" });
		},
		(context) => {
			const text = JSON.stringify(context.messages);
			assert.match(text, /LOCAL-PRIVATE/);
			assert.doesNotMatch(text, /FOREIGN-PRIVATE-SECRET/);
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "compile-racing-skill");
			if (variant === "invalid") {
				assert.equal((result as any)?.isError, true);
				assert.match(JSON.stringify(result), /compilation object must be non-empty/);
				assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), localBefore);
				assert.deepEqual(peerFiles(), peerBefore);
				assert.equal(f.readState(session, 0, "session").working.mustNotAccept, undefined);
				return fauxAssistantMessage("Rejected compilation left accepted memory intact.");
			}
			assert.match(text, /KEEP-PEER-FIELD/);
			assert.ok(result && !(result as any).isError);
			assert.deepEqual(f.readState(session, 0, scope).artifacts[skill], card, "a compilation replaces the complete artifact, not a stale merge");
			assert.equal(f.readState(session, 0, scope).working.independentPeer, "KEEP-PEER-FIELD");
			assert.equal(f.readState(session, 0, "session").working.private, "LOCAL-PRIVATE");
			const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
			assert.equal(meta.temporal.revision, revision + (variant === "competing" ? 1 : 0));
			assert.equal(latestSnapshot(session).meta.step, step + (variant === "competing" ? 1 : 0));
			assert.equal(meta.artifacts[skill].sourceHash, hashSkillSource(skill));
			assert.equal(meta.artifacts[skill].compilerRevision, SKILL_ARTIFACT_COMPILER);
			assert.deepEqual(peerFiles(), peerBefore, "local compilation never rewrites the other session's five private files");
			if (variant === "duplicate") {
				assert.match(JSON.stringify(result), /State already current/);
				assert.deepEqual([paths.checkpoint, paths.patches, paths.meta].map((path) => readFileSync(path, "utf8")), sharedBefore);
			}
			return fauxAssistantMessage("Shared Skill compilation verified.");
		},
	]);
	await session.prompt("Compile the registered Skill while another session publishes shared state");
	assert.deepEqual(peerFiles(), peerBefore);
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

test("real Pi canonical acceptance persists locally while replication settles asynchronously", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	fixture.faux.setResponses(unchangedResponses("Accepted locally."));
	await session.prompt("Accept and replicate asynchronously");
	assert.equal(fixture.readState(session).response, "Accepted locally.");
	const committed = childProcess.execFileSync("git", ["-C", fixture.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.notEqual(committed, remoteBefore);
	await awaitInFlightBackupPushes(fixture.repositoryRoot);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), committed);
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
