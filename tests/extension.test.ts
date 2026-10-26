import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { awaitInFlightBackupPushes } from "../lib/git.ts";
import { NativeToolRequestCorrelation, prepareSelectedBranchPolicy, SelectedPolicyLifetime, SNAPSHOT_ENTRY_TYPE, type SelectedPolicyRequest } from "../lib/session.ts";
import { commitSelectedTransition, stageSelectedScopePatches } from "../lib/transition.ts";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { withStorageTransaction, loadSelectedFileCohort } from "../lib/storage.ts";
import { StateFlowDiagnosticWriter, stateFlowLogPath } from "../lib/logging.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import test, { type TestContext } from "node:test";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import stateFlowExtension from "../index.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type Context, type ToolResultMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { captureTemporalFileBases, cwdScopeKey, getDurableRepositoryRoot, parseScopeStream, resolveSessionAddress, sessionRuntimePaths, sessionStorageKey, temporalScopePaths } from "../lib/durable.ts";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { applyPatch, isObject, type JsonObject, type JsonValue } from "../lib/json.ts";
import { projectModelReferences } from "../lib/model-interface.ts";
import { readTemporalView } from "../lib/temporal.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { ArtifactAcquisitionState } from "../lib/acquisition.ts";
import { SkillReadTracker, SKILL_ARTIFACT_COMPILER } from "../lib/skills.ts";
import { loadSessionState, nativePolicyMarker, assertNativeModeOnlyChange, assertTreePolicyCheckpoint } from "./temporal-fixture.ts";
import { emptyState, projectStateForRead, type ModelState, type StateScope } from "../lib/state.ts";
import { writeCwdState, writeGlobalState } from "./storage-fixture.ts";
import { commitTerminal, commitScopedTerminal, harness, start, toolAssistant, user } from "./harness.ts";
import { passiveMemoryProtocol, SCOPE_PARTICIPATION_GUIDELINE, stateFlowProtocol } from "../lib/protocol.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "../lib/selection.ts";
import type { StateFlowTelegramSectionModule, StateFlowTelegramView, StateFlowTelegramRichMessage, StateFlowTelegramModules, StateFlowTelegramCallbackContext } from "../lib/telegram.ts";
import { nativeSessionKey, realPiFixture, type RealPiFixture } from "./pi-harness.ts";
import { modelPatchArguments } from "./model-patch-fixture.ts";
import { withoutStoreIO } from "./store-io-spy.ts";
import { registerStateFlowModule, type StateFlowModule } from "../api/modules.ts";
import { publicNotesCompanion } from "./public-module-fixture.ts";

{
	const text = (message: ToolResultMessage) => message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	const observe = (context: Context, results: Map<string, ToolResultMessage>) => { for (const message of context.messages) if (message.role === "toolResult") results.set(message.toolCallId, message); };
	test("Passive distinguishes selected unavailable Session from excluded owners without acquiring on reads", { timeout: 30_000 }, async t => {
		for (const wanted of [["global", "cwd", "session"], ["session"], ["global", "cwd"]] as const) {
			const f = await realPiFixture(t, { initializeRepository: false }), seed = await f.createSession("new");
			const results = new Map<string, ToolResultMessage>();
			const run = async (session: AgentSession, name: string, args: JsonObject, id: string) => {
				f.faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }), context => { observe(context, results); return fauxAssistantMessage("Observed"); }]);
				await session.prompt(id); const result = results.get(id)!; assert.ok(result); return result;
			};
			await seed.prompt("/state-flow-passive global cwd");
			assert.notEqual((await run(seed, "patch_state", { global: { strategy: { privateSentinel: "SHARED_VALUE_NOT_A_PARTIAL_RESULT" } }, cwd: { strategy: { seed: true } } }, "seed-shared")).isError, true);
			const session = await f.createSession("new");
			await session.prompt(wanted.length === 3 ? "/state-flow-passive" : `/state-flow-passive ${wanted.join(" ")}`);
			const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			const hasSession = (wanted as readonly StateScope[]).includes("session");
			const error = hasSession ? /State Flow session: selected, unavailable/ : /Model read scope is excluded/;
			const reads: JsonObject[] = [{ path: "session" }, { path: "session.strategy" }];
			if (wanted.length === 3) reads.push({ paths: ["global.strategy", "session.strategy"] });
			for (const args of reads) {
				const result = await run(session, "read_state", args, `read-unavailable-${JSON.stringify(args)}`);
				assert.equal(result.isError, true); assert.match(text(result), error);
				assert.ok(!text(result).includes("SHARED_VALUE_NOT_A_PARTIAL_RESULT"));
				assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before, "read cannot initialize private memory or write canonical state");
			}
			if (hasSession) {
				const patch: JsonObject = wanted.length === 1 ? { strategy: { available: true } } : { session: { strategy: { available: true } } };
				assert.notEqual((await run(session, "patch_state", patch, "material-session-write")).isError, true);
				assert.deepEqual(JSON.parse(text(await run(session, "read_state", { path: "session.strategy" }, "read-after-accepted-acquisition"))), { value: { available: true } });
			}
		}
	});

	test("ordinary public consumers fork only current seventh-plane content from an older native point without parent mutation", { timeout: 30_000 }, async t => {
		for (const immutable of [false, true]) {
			let desired = 1;
			const companion = publicNotesCompanion({ immutable, context: () => [],
				...(immutable ? { captureInput: () => { const version = desired; return { value: { version }, assertCurrent() { assert.equal(desired, version); } }; }, produce: () => ({ note: `v${desired}`, nested: { empty: {} } }) } : {}),
			});
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "ordinary-forkable-companion", factory: companion.factory }] });
			const runtime = await f.createRuntime("new"), parent = runtime.session;
			await parent.prompt(`/state-flow-${immutable ? "active" : "passive"} session`);
			const settle = async (session: AgentSession) => {
				f.faux.setResponses(immutable ? [fauxAssistantMessage("Produced current semantic memory")]
					: [fauxAssistantMessage(fauxToolCall("patch_state", { x_public_notes: { note: `v${desired}`, nested: { empty: {} } } }, { id: "companion-write" }), { stopReason: "toolUse" }), fauxAssistantMessage("Authored current semantic memory")]);
				await session.prompt(`Accept companion version ${desired}`);
			};
			await settle(parent); const oldPoint = parent.sessionManager.getLeafId()!;
			desired = 2; await settle(parent);
			const before = captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
			const parentCurrent = (await loadSelectedFileCohort(f.cwd, parent.sessionId, ["session"], f.repositoryRoot, nativeSessionKey(parent)))!;
			const callbackCount = { ...companion.calls };
			assert.equal((await runtime.fork(oldPoint, { position: "at" })).cancelled, false);
			const child = runtime.session; assert.notEqual(child.sessionId, parent.sessionId);
			const copied = (await loadSelectedFileCohort(f.cwd, child.sessionId, ["session"], f.repositoryRoot, nativeSessionKey(child)))!;
			assert.ok(copied); assert.deepEqual(readTemporalView(copied.view, 0, "session", 7).x_public_notes, { note: "v2", nested: { empty: {} } });
			assert.deepEqual(copied.view.scopes.session!.modules, { x_public_notes: { schemaVersion: 1, immutable } });
			assert.equal(copied.view.scopes.session!.revision, parentCurrent.view.scopes.session!.revision);
			assert.equal(copied.view.lineage.length, 1); assert.throws(() => readTemporalView(copied.view, 1, "session", 7), /origin|history|boundary/);
			assert.deepEqual(companion.calls, callbackCount, "fork/descriptor retention does not execute module callbacks");
			assert.deepEqual(captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)), before);
			desired = 3; await settle(child); await child.reload();
			const reloaded = (await loadSelectedFileCohort(f.cwd, child.sessionId, ["session"], f.repositoryRoot, nativeSessionKey(child)))!;
			assert.deepEqual(readTemporalView(reloaded.view, 0, "session", 7).x_public_notes, { note: "v3", nested: { empty: {} } });
			assert.deepEqual(captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)), before, "child writes/reload cannot rewind or mutate current parent memory");
		}
	});

	test("ordinary public consumer absence preserves every retained boundary across folding, incompatible registration and cold reload", { timeout: 120_000 }, async t => {
		for (const selected of [["global"], ["cwd"], ["session"], ["global", "cwd", "session"]] as const) for (const limit of [0, 1, 7]) {
			let installed = true;
			const target = selected[0], contextCalls = new Map<StateScope, number>();
			const companion = publicNotesCompanion({ context: (_content, frame) => { contextCalls.set(frame.scope, (contextCalls.get(frame.scope) ?? 0) + 1); return [{ kind: "data", value: { note: "current projection only" } }]; } });
			const f = await realPiFixture(t, { mode: "configured", initializeRepository: false, extensions: [{ name: "optional-ordinary-companion", factory(pi) { if (installed) companion.factory(pi); } }] });
			writeFileSync(join(f.repositoryRoot, "config.json"), JSON.stringify({ mode: "passive", scopes: selected, historyLimit: limit }));
			const { session } = await f.createRuntime("new"), results = new Map<string, ToolResultMessage>();
			const execute = async (name: string, args: JsonObject, id: string) => {
				f.faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }), context => { observe(context, results); return fauxAssistantMessage("Settled"); }]);
				await session.prompt(id); const result = results.get(id)!; assert.ok(result); return result;
			};
			const opaque = JSON.parse('{"note":"v0","empty":{},"slots":[{},[],{"keep":{}}],"__proto__":{"constructor":{}},"utf8":"данные"}') as JsonObject;
			assert.notEqual((await execute("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: opaque } }), "first-public-value")).isError, true);
			const value = { ...opaque, note: "v1" };
			assert.notEqual((await execute("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: { note: "v1" } } }), "second-public-value")).isError, true);
			companion.unregister(session.sessionManager); installed = false;
			const counts = { ...companion.calls };
			for (let index = 0; index < limit + 3; index++) assert.notEqual((await execute("patch_state", modelPatchArguments(selected, { [target]: { tactics: { unrelated: index } } }), `opaque-core-${index}`)).isError, true);
			await session.reload();
			const current = (await loadSelectedFileCohort(f.cwd, session.sessionId, selected, f.repositoryRoot, nativeSessionKey(session)))!;
			assert.ok(current); assert.ok(current.view.scopes[target]!.checkpoint.through.position > 0, "fixture actually crossed a fold, not merely appended a tail");
			for (let offset = 0; offset < current.view.lineage.length; offset++) {
				assert.deepEqual(readTemporalView(current.view, offset, target, limit).x_public_notes, value, `${selected}/${limit}/${offset}`);
				assert.notEqual((await execute("read_state", { path: `${target}[${offset}].x_public_notes` }, `absent-history-${offset}`)).isError, true);
				assert.deepEqual(JSON.parse(text(results.get(`absent-history-${offset}`)!)), { value });
			}
			assert.deepEqual(companion.calls, counts, "uninstalled implementation cannot participate in reads, core writes, folding or reload");
			const targetContexts = contextCalls.get(target);
			for (const overrides of [{ schemaVersion: 2 }, { immutable: true }]) {
				companion.register(session.sessionManager, overrides);
				const path = selected.length === 1 ? "x_public_notes" : `${target}.x_public_notes`;
				assert.deepEqual(JSON.parse(text(await execute("read_state", { path }, "incompatible-raw-read"))), { value });
				assert.equal((await execute("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: { note: "refused" } } }), "incompatible-write")).isError, true);
			}
			assert.equal(contextCalls.get(target), targetContexts, "incompatible retained owner rejects before its context callback; unwritten other owners remain independently available");
			assert.equal(companion.calls.validate, counts.validate, "incompatible retained content never enters definition validators");
			installed = true; await session.reload();
			assert.deepEqual(JSON.parse(text(await execute("read_state", { path: `${target}.x_public_notes` }, "reinstalled-raw-read"))), { value });
			assert.notEqual((await execute("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: { note: "reinstalled" } } }), "reinstalled-write")).isError, true);
			const restored = (await loadSelectedFileCohort(f.cwd, session.sessionId, selected, f.repositoryRoot, nativeSessionKey(session)))!;
			assert.deepEqual(restored.view.scopes[target]!.modules, { x_public_notes: { schemaVersion: 1, immutable: false } });
			assert.deepEqual(readTemporalView(restored.view, 0, target, limit).x_public_notes, { ...value, note: "reinstalled" });
		}
	});

	test("public async producer proposals cannot survive original input, catalog, mode, model, selection or shared-content changes", { timeout: 60_000 }, async t => {
		for (const failure of ["input", "catalog", "scope-aba", "off", "abort", "model", "model-aba", "thinking-aba", "shared"] as const) {
			let epoch = 1, waiting = false, entered!: () => void, release!: () => void, providers = 0;
			const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			const companion = publicNotesCompanion({ immutable: true,
				captureInput: () => { const version = epoch; return { value: { version }, assertCurrent() { assert.equal(epoch, version, "producer input superseded"); } }; },
				async produce() { if (waiting) { entered(); await gate; } return { note: waiting ? "new proposal" : "old accepted" }; },
				context: () => [],
			});
			const f = await realPiFixture(t, { initializeRepository: false, models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }], extensions: [{ name: "public-original-basis-producer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-active cwd");
			f.faux.setResponses([fauxAssistantMessage("Seeded")]); await session.prompt("Seed original accepted producer content");
			waiting = true;
			f.faux.setResponses([() => { providers++; return fauxAssistantMessage("Must not infer from a stale producer"); }]);
			const pending = session.prompt("Compute against the original owned producer basis"); await ready;
			if (failure === "input") epoch++;
			if (failure === "catalog") companion.register(session.sessionManager);
			if (failure === "off") await session.prompt("/state-flow-off");
			if (failure === "abort") await session.abort();
			if (failure === "scope-aba") { await session.prompt("/state-flow-active global"); await session.prompt("/state-flow-active cwd"); }
			if (failure === "model" || failure === "model-aba") await session.setModel(f.faux.getModel("two")!);
			if (failure === "model-aba") await session.setModel(f.faux.getModel("one")!);
			if (failure === "thinking-aba") { const original = session.thinkingLevel; session.setThinkingLevel(original === "low" ? "high" : "low"); session.setThinkingLevel(original); }
			if (failure === "shared") {
				const peer = new TemporalRuntime(f.cwd, "legitimate-shared-peer", f.repositoryRoot);
				await peer.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), publish => publish(), undefined, true);
				await peer.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot, { id: "foreign-accepted-content", transitions: [{ scope: "cwd", patch: { x_public_notes: { note: "peer accepted" } } }] }), () => {});
			}
			if (failure === "catalog" || failure === "off" || failure === "scope-aba" || failure === "abort") { await pending; release(); }
			else { release(); await pending; }
			assert.equal(providers, 0, failure);
			const paths = temporalScopePaths(f.cwd, session.sessionId, "cwd", f.repositoryRoot, nativeSessionKey(session));
			const metadata = JSON.parse(readFileSync(paths.meta, "utf8"));
			const stream = parseScopeStream(readFileSync(paths.checkpoint, "utf8"), readFileSync(paths.patches, "utf8"), "cwd", f.cwd, readFileSync(paths.meta, "utf8"))!;
			const restored = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			await restored.refreshSelectedShared(["cwd"], () => {});
			const content = restored.readView(0, "cwd").x_public_notes; assert.ok(isObject(content));
			assert.equal(content.note, failure === "shared" ? "peer accepted" : "old accepted", failure);
			assert.ok(stream); assert.deepEqual(metadata.modules.x_public_notes, { schemaVersion: 1, immutable: true });
		}
	});

	test("public producer cohorts reject partial invalid output and retain accepted publication after late cancellation", { timeout: 30_000 }, async t => {
		for (const outcome of ["invalid", "accepted-abort"] as const) {
			let providers = 0, abort: (() => void) | undefined;
			const companion = publicNotesCompanion({ immutable: true,
				produce: (_content, frame): JsonObject => outcome === "invalid" && frame.scope === "session" ? { note: "bad", stored: null } : { note: "accepted" },
				context: content => { if (content?.note === "accepted") abort?.(); return []; },
			});
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-atomic-producer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-active global session");
			if (outcome === "accepted-abort") abort = () => { void session.abort(); };
			f.faux.setResponses([() => { providers++; return fauxAssistantMessage("Must remain fenced"); }]);
			await session.prompt("Publish one module cohort or none"); assert.equal(providers, 0);
			const restored = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)); await restored.refreshSelectedCurrent(["global", "session"], () => {});
			for (const scope of ["global", "session"] as const) {
				const content = restored.readView(0, scope).x_public_notes;
				if (outcome === "invalid") assert.equal(content, undefined, "one invalid result prevents every proposed scope");
				else assert.deepEqual(content, { note: "accepted" }, "late Abort cannot revoke accepted producer memory");
			}
		}
	});

	test("ordinary public immutable producers atomically replace all selected planes once per Active preparation and never run in Passive or Off", { timeout: 120_000 }, async t => {
		const owners = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) for (const mode of ["active", "passive", "off"] as const) {
			const selected = captureScopeSelection(owners.filter((_, bit) => mask & (1 << bit)));
			let generation = 1, calls = 0, inputs = 0;
			const infer = async (request: { tools: never[]; scope: StateScope; generation: number }, signal: AbortSignal) => {
				assert.deepEqual(request.tools, []); signal.throwIfAborted(); calls++;
				await withStorageTransaction(f.repositoryRoot, () => {}, signal);
				return request.generation === 4 ? undefined : request.generation === 3 ? {} : { note: `${request.generation}:${request.scope}`, ...(request.generation === 1 ? { obsolete: true } : {}) };
			};
			const companion = publicNotesCompanion({ immutable: true,
				captureInput: () => { inputs++; const captured = generation; return { value: { generation: captured }, assertCurrent() { assert.equal(generation, captured); } }; },
				async produce(_content, frame, signal) {
					if (frame.scope !== "session") { assert.deepEqual(frame.conversation, []); assert.equal(frame.prompt, undefined); }
					return infer({ tools: [], scope: frame.scope, generation: (frame.input as JsonObject).generation as number }, signal);
				},
				context: (content, frame) => [{ kind: "data", value: { marker: "ACCEPTED-PRODUCER-CONTEXT", note: content?.note ?? "absent", generation: (frame.input as JsonObject).generation!, scope: frame.scope } }],
			});
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-tool-less-producer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
			const metadata = (scope: StateScope) => JSON.parse(readFileSync(temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, nativeSessionKey(session)).meta, "utf8"));
			if (mode !== "active") {
				f.faux.setResponses([fauxAssistantMessage("No producer")]); await session.prompt("Do not infer automatically in inactive mode");
				assert.equal(calls, 0); assert.equal(companion.calls.produce, 0); if (mode === "off") { assert.equal(inputs, 0); assert.equal(companion.calls.context, 0); }
				continue;
			}
			const results = new Map<string, ToolResultMessage>();
			f.faux.setResponses([
				context => {
					assert.equal(calls, selected.length); assert.equal(inputs, selected.length, "context reuses original producer input, not reacquisition");
					for (const scope of selected) { assert.equal(metadata(scope).version, 4); assert.deepEqual(metadata(scope).modules.x_public_notes, { schemaVersion: 1, immutable: true }); }
					const rendered = JSON.stringify(context.messages); assert.match(rendered, /ACCEPTED-PRODUCER-CONTEXT/); for (const scope of selected) assert.ok(rendered.includes(`1:${scope}`));
					return fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selected, { [selected[0]]: { x_public_notes: { note: "manual forbidden" } } }), { id: "immutable-manual" }), { stopReason: "toolUse" });
				},
				context => { observe(context, results); return fauxAssistantMessage(fauxToolCall("read_state", { paths: selected.map(scope => `${scope}.x_public_notes`) }, { id: "producer-read" }), { stopReason: "toolUse" }); },
				context => { observe(context, results); return fauxAssistantMessage("Accepted produced memory"); },
			]);
			await session.prompt("Produce immutable semantic content");
			assert.equal(results.get("immutable-manual")!.isError, true); assert.notEqual(results.get("producer-read")!.isError, true, text(results.get("producer-read")!));
			assert.equal(calls, selected.length, "tool-loop turns do not rerun automatic production");
			const first = selected.map(scope => ({ note: `1:${scope}`, obsolete: true }));
			assert.deepEqual(JSON.parse(text(results.get("producer-read")!)), { value: selected.length === 1 ? first[0] : first });
			generation = 2;
			f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read_state", { paths: selected.map(scope => `${scope}[1].x_public_notes`) }, { id: "producer-history" }), { stopReason: "toolUse" }), context => { observe(context, results); return fauxAssistantMessage("Replacement settled"); }]);
			await session.prompt("Replace complete content without obsolete fields");
			assert.deepEqual(JSON.parse(text(results.get("producer-history")!)), { value: selected.length === 1 ? first[0] : first });
			const current = await loadSelectedFileCohort(f.cwd, session.sessionId, selected, f.repositoryRoot, nativeSessionKey(session)); assert.ok(current);
			for (const scope of selected) assert.deepEqual(readTemporalView(current.view, 0, scope, 7).x_public_notes, { note: `2:${scope}` });
			generation = 3; f.faux.setResponses([fauxAssistantMessage("Deletion settled")]); await session.prompt("Empty producer object clears only its content");
			const removed = await loadSelectedFileCohort(f.cwd, session.sessionId, selected, f.repositoryRoot, nativeSessionKey(session)); assert.ok(removed);
			for (const scope of selected) { assert.equal(readTemporalView(removed.view, 0, scope, 7).x_public_notes, undefined); assert.deepEqual(metadata(scope).modules.x_public_notes, { schemaVersion: 1, immutable: true }); }
			const revisions = selected.map(scope => metadata(scope).temporal.revision); generation = 4;
			f.faux.setResponses([() => { assert.deepEqual(selected.map(scope => metadata(scope).temporal.revision), revisions, "undefined proposal is not a semantic write"); return fauxAssistantMessage("No proposal"); }]);
			await session.prompt("Do not fabricate data for an undefined proposal"); assert.equal(calls, selected.length * 4);
		}
	});

	test("public captured input and completed conversation context execute through all selected SDK owners in Active and Passive", { timeout: 120_000 }, async t => {
		const owners = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) for (const mode of ["active", "passive"] as const) {
			const selected = captureScopeSelection(owners.filter((_, bit) => mask & (1 << bit)));
			let captures = 0, expectedEpoch = 1;
			const scopes = new Set<StateScope>();
			const companion = publicNotesCompanion({
				async captureInput(source, signal) {
					captures++; scopes.add(source.scope);
					assert.equal(source.mode, mode);
					assert.equal(Object.hasOwn(source, "sessionManager"), false);
					if (source.scope !== "session") { assert.deepEqual(source.conversation, []); assert.equal(source.prompt, undefined); }
					await withStorageTransaction(f.repositoryRoot, () => {}, signal);
					const epoch = expectedEpoch;
					return { value: { epoch }, assertCurrent() { assert.equal(expectedEpoch, epoch); } };
				},
				context(_content, source) {
					assert.deepEqual(source.input, { epoch: expectedEpoch });
					const data = { kind: "data" as const, value: { marker: "PUBLIC-MODULE-CONTEXT", mode, scope: source.scope } };
					if (source.scope !== "session") return [data];
					const lastUser = source.conversation.findLastIndex(message => message.role === "user");
					return [data, { kind: "conversation", indices: lastUser < 0 ? [] : Array.from({ length: source.conversation.length - lastUser }, (_, index) => lastUser + index) }];
				},
			});
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-input-context-consumer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
			f.faux.setResponses([fauxAssistantMessage("Older answer")]); await session.prompt("OLDER-NATIVE-NOT-IN-WINDOW");
			f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selected, { [selected[0]]: { tactics: { seed: true } } }), { id: "completed-module-unit" }), { stopReason: "toolUse" }), fauxAssistantMessage("Completed source unit")]);
			await session.prompt("LATEST-COMPLETED-SOURCE-RUN");
			let context: Context | undefined;
			const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			f.faux.setResponses([value => { context = value; return fauxAssistantMessage("Current context accepted"); }]);
			await session.prompt("CURRENT-MODULE-PROMPT");
			assert.ok(context, `${mode}/${selected}`); assert.ok(captures > 0); assert.deepEqual([...scopes].sort(), [...selected].sort());
			const data = context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("PUBLIC-MODULE-CONTEXT"));
			assert.equal(data.length, selected.length);
			assert.doesNotMatch(getSystemMessageText(getCurrentSystemMessage(context.messages)!), /PUBLIC-MODULE-CONTEXT/);
			if (selected.includes("session")) {
				const rendered = JSON.stringify(context.messages);
				assert.doesNotMatch(rendered, /OLDER-NATIVE-NOT-IN-WINDOW/); assert.match(rendered, /LATEST-COMPLETED-SOURCE-RUN/); assert.match(rendered, /CURRENT-MODULE-PROMPT/);
				assert.equal(context.messages.filter(message => message.role === "toolResult" && message.toolCallId === "completed-module-unit").length, 1);
				assert.equal(context.messages.filter(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "completed-module-unit")).length, 1);
			}
			const after = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			if (mode === "passive" || !selected.includes("session")) assert.deepEqual(after.filter(file => !/\/(?:config|runtime)\.json$/.test(file.path)), before.filter(file => !/\/(?:config|runtime)\.json$/.test(file.path)), "context-only observation creates no semantic module write");
		}
	});

	test("public input source mutation after context and cancellation during capture fence actual SDK inference without memory fallback", { timeout: 30_000 }, async t => {
		for (const failure of ["source", "catalog", "off"] as const) {
			let epoch = 1, mutate = false, entered!: () => void, release!: () => void, provider = 0;
			const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			const companion = publicNotesCompanion({ async captureInput() { const version = epoch; entered(); if (failure !== "source") await gate; return { value: { version }, assertCurrent() { assert.equal(epoch, version, "source changed"); } }; }, context: () => [{ kind: "data", value: { marker: "captured" } }] });
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-cancelable-input", factory: companion.factory }, { name: "late-native-source-mutation", factory(pi) { pi.on("context", () => { if (mutate && failure === "source") epoch++; }); } }] });
			const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-active session");
			mutate = true;
			f.faux.setResponses([() => { provider++; return fauxAssistantMessage("Must not infer from obsolete module input"); }]);
			const pending = session.prompt("Capture a cancellable public module input"); await ready;
			if (failure === "catalog") companion.register(session.sessionManager);
			if (failure === "off") await session.prompt("/state-flow-off");
			await pending; release(); await Promise.resolve();
			assert.equal(provider, 0, failure);
			const paths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
			assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).modules, undefined, "failed context never writes module metadata");
		}
	});

	test("ordinary public companion authors and reads a real seventh plane through every selected SDK tool grammar", { timeout: 120_000 }, async t => {
		const owners = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) for (const mode of ["active", "passive"] as const) {
			const selected = captureScopeSelection(owners.filter((_, bit) => mask & (1 << bit))), target = selected[0];
			const companion = publicNotesCompanion();
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-notes-consumer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new");
			await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
			const results = new Map<string, ToolResultMessage>();
			const root = selected.length === 1 ? "x_public_notes" : `${target}.x_public_notes`;
			const value = { note: "Привет", box: { empty: {}, values: [{}, []] }, link: { $ref: `${root}.box` } };
			let beforeInvalid: ReturnType<typeof captureTemporalFileBases> | undefined, afterInvalid: typeof beforeInvalid;
			const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			f.faux.setResponses([
				context => {
					const declaration = getCurrentTools(context.messages).find(tool => tool.name === "patch_state")!;
					if (selected.length === 1) assert.ok(Object.hasOwn((declaration.parameters as { properties: object }).properties, "x_public_notes"));
					return fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: value } }), { id: "module-first" }), { stopReason: "toolUse" });
				},
				context => { observe(context, results); beforeInvalid = files(); return fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: { note: 4 } } }), { id: "module-invalid" }), { stopReason: "toolUse" }); },
				context => { observe(context, results); afterInvalid = files(); return fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selected, { [target]: { x_public_notes: { extra: true } } }), { id: "module-partial" }), { stopReason: "toolUse" }); },
				context => { observe(context, results); return fauxAssistantMessage(fauxToolCall("read_state", { paths: [root, `${target}[1].x_public_notes`] }, { id: "module-read" }), { stopReason: "toolUse" }); },
				context => { observe(context, results); return fauxAssistantMessage("Accepted external memory"); },
			]);
			await session.prompt("Use the installed companion's semantic plane");
			for (const id of ["module-first", "module-partial", "module-read"]) { const result = results.get(id)!; assert.ok(result, `${mode}/${selected}/${id}`); assert.notEqual(result.isError, true, text(result)); }
			assert.equal(results.get("module-invalid")!.isError, true);
			assert.doesNotMatch(text(results.get("module-first")!), /"path":\["x_public_notes"\],"deleted":true/, "unprojected module content is not reported as deleted");
			assert.deepEqual(afterInvalid, beforeInvalid, "complete-result validation refusal publishes no bytes");
			assert.deepEqual(JSON.parse(text(results.get("module-read")!)), { value: [{ ...value, extra: true }, value] });
			const paths = temporalScopePaths(f.cwd, session.sessionId, target, f.repositoryRoot, nativeSessionKey(session));
			const metadata = JSON.parse(readFileSync(paths.meta, "utf8"));
			assert.equal(metadata.version, 4);
			assert.deepEqual(metadata.modules, { x_public_notes: { schemaVersion: 1, immutable: false } });
			assert.ok(companion.calls.context > 0, "registered available modules now receive real Active/Passive context frames");
		}
	});

	test("native model requests cannot acquire a newly registered or ABA-replaced module definition", { timeout: 30_000 }, async t => {
		for (const change of ["new", "replacement"] as const) {
			const companion = publicNotesCompanion();
			const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-notes-consumer", factory: companion.factory }] });
			const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-passive global cwd");
			if (change === "new") companion.unregister(session.sessionManager);
			const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			const before = files(), results = new Map<string, ToolResultMessage>();
			f.faux.setResponses([
				() => { companion.register(session.sessionManager); return fauxAssistantMessage(fauxToolCall("patch_state", { cwd: { x_public_notes: { note: "stale definition" } } }, { id: "stale-catalog" }), { stopReason: "toolUse" }); },
				context => { observe(context, results); return fauxAssistantMessage("Fresh continuation"); },
			]);
			await session.prompt("The original model request cannot adopt replacement module authority");
			const stale = results.get("stale-catalog")!; assert.ok(stale); assert.equal(stale.isError, true, text(stale));
			assert.deepEqual(files(), before); assert.equal(companion.calls.validate, 0, "stale provider calls reject before validation/source work");
			f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", { cwd: { x_public_notes: { note: "fresh definition" } } }, { id: "fresh-catalog" }), { stopReason: "toolUse" }), context => { observe(context, results); return fauxAssistantMessage("Fresh accepted"); }]);
			await session.prompt("A fresh native request captures the replacement catalog");
			assert.notEqual(results.get("fresh-catalog")!.isError, true, text(results.get("fresh-catalog")!));
		}
	});

	test("public companion absence, descriptor mismatch and immutable policy preserve raw seventh-plane reads across SDK reload", { timeout: 30_000 }, async t => {
		const companion = publicNotesCompanion();
		const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-notes-consumer", factory: companion.factory }] });
		const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-passive cwd");
		const results = new Map<string, ToolResultMessage>();
		const execute = async (name: string, args: JsonObject, id: string) => {
			f.faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }), context => { observe(context, results); return fauxAssistantMessage("Done"); }]);
			await session.prompt(id); const result = results.get(id)!; assert.ok(result, id); return result;
		};
		assert.notEqual((await execute("patch_state", { x_public_notes: { note: "retained", empty: {} } }, "first")).isError, true);
		companion.unregister(session.sessionManager);
		const calls = companion.calls.validate;
		assert.notEqual((await execute("patch_state", { tactics: { unrelated: true } }, "core-while-absent")).isError, true);
		assert.deepEqual(JSON.parse(text(await execute("read_state", { path: "x_public_notes" }, "raw-absent"))), { value: { note: "retained", empty: {} } });
		assert.equal(companion.calls.validate, calls, "raw reads/core writes do not call an absent implementation");
		assert.equal((await execute("patch_state", { x_public_notes: { note: "refused" } }, "write-absent")).isError, true);
		for (const overrides of [{ schemaVersion: 2 }, { immutable: true }]) {
			companion.register(session.sessionManager, overrides);
			assert.equal((await execute("patch_state", { x_public_notes: { note: "incompatible" } }, "write-mismatch")).isError, true);
			assert.deepEqual(JSON.parse(text(await execute("read_state", { path: "x_public_notes" }, "raw-mismatch"))), { value: { note: "retained", empty: {} } });
		}
		assert.equal(companion.calls.validate, calls, "unavailable/immutable registration rejects before validators");
		await session.reload();
		assert.deepEqual(JSON.parse(text(await execute("read_state", { path: "x_public_notes" }, "raw-reloaded"))), { value: { note: "retained", empty: {} } });
		assert.notEqual((await execute("patch_state", { x_public_notes: { note: "fresh" } }, "write-reloaded")).isError, true);
		assert.deepEqual(JSON.parse(text(await execute("read_state", { path: "x_public_notes" }, "raw-fresh"))), { value: { note: "fresh", empty: {} } });
	});
}

test("public module registration follows actual SDK native-host lifetime without activating Off memory", async t => {
	let registered = 0, retired = 0, called = 0;
	const module: StateFlowModule = { immutable: true, id: "x_companion_archive", apiVersion: 1, schemaVersion: 1,
		validate: (value): value is JsonObject => { called++; return isObject(value); }, context: () => { called++; return []; },
		produce: () => { called++; return {}; }, captureInput: () => { called++; return { value: {}, assertCurrent() {} }; } };
	const f = await realPiFixture(t, { mode: "off", initializeRepository: false, extensions: [{ name: "independent-module-consumer", factory: pi => {
		let unregister: (() => void) | undefined;
		pi.on("session_start", (_event, ctx) => { unregister = registerStateFlowModule(ctx.sessionManager, module); registered++; });
		pi.on("session_shutdown", () => { unregister?.(); retired++; });
	} }] });
	const first = await f.createRuntime("new"), second = await f.createRuntime("new");
	assert.equal(registered, 2);
	for (const runtime of [first, second]) {
		assert.throws(() => registerStateFlowModule(runtime.session.sessionManager, module), /already registered/);
		assert.equal(runtime.session.getActiveToolNames().includes("patch_state"), false);
		const manager = runtime.session.sessionManager;
		const key = resolveSessionAddress(manager.getSessionFile(), manager.getSessionId(), manager.getHeader()?.timestamp).key;
		for (const scope of ["global", "cwd", "session"] as const) {
			const paths = temporalScopePaths(f.cwd, manager.getSessionId(), scope, f.repositoryRoot, key);
			for (const path of [paths.checkpoint, paths.patches, paths.meta]) assert.equal(existsSync(path), false);
		}
	}
	await first.dispose();
	assert.equal(retired, 1);
	assert.throws(() => registerStateFlowModule(first.session.sessionManager, module), /host unavailable/);
	assert.throws(() => registerStateFlowModule(second.session.sessionManager, module), /already registered/);
	assert.equal(called, 0, "Off registration has no source capture, producer, validator or context effects");
});

{
	async function pendingActiveReselection(t: TestContext, scopes: ScopeSelection) {
		const f = await realPiFixture(t, { mode: "active", initializeRepository: false });
		const { session } = await f.createRuntime("new");
		f.faux.setResponses([fauxAssistantMessage("accepted before reselection")]);
		await session.prompt("Seed accepted Active memory before reselection");
		let entered!: () => void, release!: () => void, inspected!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const waiting = new Promise<void>(resolve => { inspected = resolve; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; });
		await ready;
		t.signal.addEventListener("abort", release, { once: true });
		const current = TemporalRuntime.prototype.withSelectedCurrentTransaction;
		let restoration: Promise<unknown> | undefined;
		const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction", function (this: TemporalRuntime, ...args: Parameters<typeof current>) {
			inspected();
			restoration = Reflect.apply(current, this, args);
			return restoration;
		});
		const selecting = session.prompt(`/state-flow-active ${scopes.join(" ")}`);
		let finished: Promise<unknown> | undefined;
		const finish = () => finished ??= (async () => {
			release();
			await holding;
			await selecting;
			return restoration?.then(() => undefined, error => error);
		})();
		try {
			await Promise.race([waiting, selecting.then(() => { throw new Error("Active reselection did not request current acceptance"); })]);
		} catch (error) {
			await finish();
			throw error;
		} finally {
			spy.mock.restore();
		}
		const contexts: Context[] = [];
		const answer = (context: Context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("answer after explicit admission"); };
		f.faux.setResponses([answer, answer]);
		return { f, session, contexts, finish };
	}

	const selections: ScopeSelection[] = [["cwd"], ["global", "cwd"], ["session"], ["cwd", "session"]];
	for (const scopes of selections) test(`native pending Active reselection fences inference until acceptance: ${scopes.join("+")}`, { timeout: 10000 }, async t => {
		const { f, session, contexts, finish } = await pendingActiveReselection(t, scopes);
		try {
			await session.prompt("Do not expose native fallback while requested Active memory waits");
			assert.equal(contexts.length, 0, "the provider must not run before requested current-memory acceptance");
			assert.ok(f.statuses.at(-1)?.includes("active (blocked)"));
			assert.throws(() => f.readState(session, 0, scopes[0]), /selected branch is unavailable/);
			assert.equal(await finish(), undefined, "guard Abort must not revoke the independently owned Active selection");
			assert.doesNotThrow(() => f.readState(session, 0, scopes[0]));
			await session.prompt("Run with the accepted requested memory");
			assert.equal(contexts.length, 1);
			const protocol = getCurrentSystemMessage(contexts[0]!.messages)?.sections?.state_flow;
			assert.equal(typeof protocol, "string", "accepted inference must contribute its State Flow protocol");
			assert.ok([false, true].some(bootstrap => protocol === `<state_flow>\n${stateFlowProtocol(bootstrap, scopes)}\n</state_flow>`), "accepted inference uses the requested scope protocol, not the old selection or raw fallback");
		} finally {
			await finish();
		}
	});

	for (const mode of ["passive", "off"] as const) test(`native pending Active reselection releases inference for explicit ${mode}`, { timeout: 10000 }, async t => {
		const { f, session, contexts, finish } = await pendingActiveReselection(t, ["cwd"]);
		try {
			await session.prompt("Fence this Active request before its memory is accepted");
			assert.equal(contexts.length, 0);
			await session.prompt(`/state-flow-${mode}`);
			await session.prompt(`Explicit ${mode} permits native inference while foreign exclusion remains held`);
			assert.equal(contexts.length, 1, "an independent inactive choice releases inference before the foreign lock");
			assert.equal(getCurrentSystemMessage(contexts[0]!.messages)?.sections?.state_flow, undefined);
			const names = getCurrentTools(contexts[0]!.messages).map(tool => tool.name);
			for (const name of ["read_state", "patch_state"]) assert.equal(names.includes(name), mode === "passive");
			const withdrawn = await finish();
			if (mode === "passive") {
				assert.equal(withdrawn, undefined, "Passive retains independently owned current acceptance");
				assert.doesNotThrow(() => f.readState(session, 0, "cwd"));
			} else {
				assert.ok(withdrawn, "Off cancels the old memory acceptance");
				assert.throws(() => f.readState(session), /unavailable/);
			}
			await session.prompt(`Remain ${mode} after the old selection has settled`);
			assert.equal(contexts.length, 2);
			if (mode === "off") assert.equal(getCurrentSystemMessage(contexts[1]!.messages)?.sections?.state_flow, undefined);
		} finally {
			await finish();
		}
	});
}

test("all public mode commands bind the same completion grammar and reject malformed input before any side effect", async () => {
	const cases: Array<[string, string[]]> = [
		["", ["global", "cwd", "session"]], ["s", ["session"]], ["cwd", ["cwd"]],
		["cwd ", ["cwd global", "cwd session"]], ["session g", ["session global"]],
		[" \tglobal\tc", ["global cwd"]], ["session cwd ", ["session cwd global"]],
		["global cwd session ", []], ["cwd cwd ", []], ["CWD ", []], ["--cwd", []], ["session cX", []],
	];
	const h = harness({ initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	for (const mode of ["active", "passive", "off"]) {
		const command = h.commands.get(`state-flow-${mode}`)!;
		for (const [prefix, expected] of cases) assert.deepEqual(command.getArgumentCompletions(prefix), expected.length ? expected.map(value => ({ value, label: value })) : null);
		const before = structuredClone(h.entries), status = [...h.statuses], tools = h.activeTools;
		for (const args of ["cwd cwd", "all", "CWD", "session,global", "--scopes session"]) {
			await assert.rejects(command.handler(args, h.ctx), /State Flow scopes/);
			assert.deepEqual(h.entries, before); assert.deepEqual(h.statuses, status); assert.deepEqual(h.activeTools, tools);
		}
	}
});

test("native composition uses captured default selection and one syntax grammar without granting subset activation", async () => {
	const h = harness({ initializeRepository: false, mode: "active" }); await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.tools.get("patch_state")!.execute("protocol-current-seed", { session: { tactics: { retained: true } } }, undefined, undefined, h.ctx);
	const active = { prompt: "Owned protocol", systemPromptOptions: { sections: {} as Record<string, string> } };
	h.handlers.get("before_agent_start")!(active, h.ctx); assert.equal(active.systemPromptOptions.sections.state_flow, stateFlowProtocol(false, DEFAULT_SCOPE_SELECTION));
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const passive = { prompt: "Owned Passive protocol", systemPromptOptions: { sections: {} as Record<string, string> } };
	h.handlers.get("before_agent_start")!(passive, h.ctx); assert.equal(passive.systemPromptOptions.sections.state_flow, passiveMemoryProtocol(DEFAULT_SCOPE_SELECTION));
	assert.deepEqual(Object.keys(h.tools.get("patch_state")!.parameters.properties), ["global", "cwd", "session"]);
	for (const name of ["read_state", "patch_state"]) assert.ok(h.tools.get(name)!.promptGuidelines.includes(SCOPE_PARTICIPATION_GUIDELINE));
});

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;
	const owners: StateScope[] = ['global', 'cwd', 'session'];
	const selections: StateScope[][] = [['global'], ['cwd'], ['session'], ['global', 'cwd'], ['global', 'session'], ['cwd', 'session'], owners];
	type Section = Parameters<StateFlowTelegramSectionModule['registerTelegramSection']>[0];
	for (const selected of selections) test(`native Telegram mode-only selection ${selected.join('+')}`, { timeout: 60000 }, async t => {
	  const registrations: Section[] = [];
	  const f = await realPiFixture(t, { mode: 'configured', initializeRepository: false, telegram: { load: async () => ({ sections: {
	    registerTelegramSection(section) { registrations.push(section); return () => {}; },
	  } }) } });
	  const config = `${f.repositoryRoot}/config.json`;
	  writeFileSync(config, JSON.stringify({ mode: 'off', scopes: selected }));
	  let defaults = readFileSync(config);
	  const { session } = await f.createRuntime('new');
	  const errors: unknown[] = [];
	  await session.bindExtensions({ onError: error => { errors.push(error); } });
	  await new Promise<void>(resolve => setImmediate(resolve));
	  assert.ok(registrations.length);
	  const initial = await registrations.at(-1)!.render({ callbackData: (a, p = '') => `${a}:${p}`, edit: async () => {}, openRich: async () => {}, answerCallback: async () => {} });
	  assert.deepEqual(initial.replyMarkup!.inline_keyboard.slice(1).flat().map(b => b.callback_data), [...selected, ...(selected.length > 1 ? ['effective'] : [])].map(o => `inspect:${o}`), 'fresh configured scope defaults drive the menu before memory acquisition');
	  const key = nativeSessionKey(session);
	  const runtimeConfig = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, key).config;
	  const triple = (scope: StateScope) => {
	    const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, key);
	    return [p.checkpoint, p.patches, p.meta].map(path => existsSync(path) ? readFileSync(path).toString('base64') : null);
	  };
	  const excluded = owners.filter(o => !selected.includes(o));
	  const excludedBefore = excluded.map(triple);
	  const assertExcluded = () => {
	    assert.deepEqual(excluded.map(triple), excludedBefore);
	    if (!selected.includes('session')) assert.ok(triple('session').every(v => v === null));
	  };
	  const status = async (mode: string) => {
	    await session.prompt('/state-flow-status');
	    assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${selected.join(', ')}`));
	    assert.ok(f.notifications.at(-1)?.includes(`Mode: ${mode}`));
	    assert.deepEqual(JSON.parse(readFileSync(runtimeConfig, 'utf8')).scopes, selected);
	    assert.deepEqual(readFileSync(config), defaults);
	    assertExcluded();
	  };
	  await session.prompt(`/state-flow-active ${[...selected].reverse().join(' ')}`);
	  await status('active');
	  const marker = (o: StateScope) => `telegram-${selected.join('-')}-${o}`;
	  let calls = 0;
	  const results: ToolResultMessage[] = [];
	  f.faux.setResponses([
	    () => { calls++; return answer(tool('patch_state', modelPatchArguments(selected, Object.fromEntries(selected.map(o => [o, { tactics: { [o]: marker(o) } }]))), { id: 'telegram-original-patch' }), { stopReason: 'toolUse' }); },
	    c => { calls++; results.push(...c.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolCallId === 'telegram-original-patch')); return answer('Initial selected answer'); },
	  ]);
	  await session.prompt('Write distinct selected owners');
	  assert.equal(calls, 2);
	  assert.equal(results.length, 1);
	  assert.notEqual(results[0].isError, true);
	  const assertValues = () => { for (const o of selected) assert.equal(f.readState(session, 0, o).tactics?.[o], marker(o)); };
	  assertValues();
	  assertExcluded();
	  const edits: StateFlowTelegramView[] = [], rich: StateFlowTelegramRichMessage[] = [], acknowledgments: Array<string | undefined> = [];
	  const context = {
	    callbackData: (action: string, payload = '') => `${action}:${payload}`,
	    edit: async (view: StateFlowTelegramView) => { edits.push(view); },
	    openRich: async (message: StateFlowTelegramRichMessage) => { rich.push(message); },
	    answerCallback: async (message?: string) => { acknowledgments.push(message); },
	  };
	  const section = async () => { await new Promise<void>(resolve => setImmediate(resolve)); assert.ok(registrations.length); return registrations.at(-1)!; };
	  const callback = async (action: string, payload: string) => {
	    const registered = await section();
	    assert.equal(await registered.handleCallback!({ ...context, action, payload }), 'handled');
	  };
	  for (const reload of [false, true]) {
	    if (reload) {
	      writeFileSync(config, JSON.stringify({ mode: 'off', scopes: selected.length === 3 ? ['cwd'] : excluded }));
	      defaults = readFileSync(config);
	      await session.reload();
	    }
	    for (const mode of ['passive', 'off', 'active'] as const) {
	      const before = owners.map(triple);
	      await callback(mode, excluded[0] ?? 'global');
	      await status(mode);
	      const registered = await section();
	      assert.equal(registered.getLabel?.(), `🌀 State Flow: ${mode}`);
	      const view = await registered.render(context);
	      const buttons = view.replyMarkup!.inline_keyboard;
	      assert.equal(buttons.flat().length, 3 + selected.length + (selected.length > 1 ? 1 : 0));
	      assert.deepEqual(buttons.slice(1).flat().map(b => b.callback_data), [...selected, ...(selected.length > 1 ? ['effective'] : [])].map(o => `inspect:${o}`));
	      for (const o of owners) assert.equal(view.text.includes(`<code>-</code> <code>${o}</code>:`), selected.includes(o));
	      assert.equal(view.text.includes('<code>-</code> <code>effective</code>:'), selected.length > 1);
	      assert.deepEqual(buttons[0].map(b => b.callback_data), ['off:', 'passive:', 'active:']);
	      assert.ok(buttons[0].find(b => b.callback_data === `${mode}:`)!.text.startsWith({ off: '🟣', passive: '🟡', active: '🟢' }[mode]));
	      if (mode !== 'active') assert.deepEqual(owners.map(triple), before, 'inactive mode controls cannot publish canonical memory');
	      if (mode !== 'off') assertValues();
	      if (mode === 'off') {
	        const inspectionBefore = owners.map(triple), count = rich.length;
	        await callback('inspect', selected[0]);
	        assert.equal(rich.length, count + 1, 'explicit selected-owner operator inspection succeeds in Off');
	        assert.ok(JSON.stringify(rich.at(-1)).includes(marker(selected[0])));
	        assert.deepEqual(owners.map(triple), inspectionBefore, 'Off disposable inspection cannot publish');
	      }
	      const deliveryBefore = owners.map(triple);
	      calls = 0;
	      let delivered: Context | undefined;
	      f.faux.setResponses([c => {
	        calls++; delivered = structuredClone(c);
	        return answer(`Completed ${mode} ${reload}`);
	      }]);
	      await session.prompt('Deliver an ordinary native response');
	      assert.equal(calls, 1); assert.ok(delivered);
	      const names = getCurrentTools(delivered.messages).map(v => v.name);
	      assert.ok(names.includes('read'), 'native default read remains available');
	      for (const name of ['patch_state', 'read_state']) assert.equal(names.includes(name), mode !== 'off');
	      if (mode === 'off') assert.equal(getCurrentSystemMessage(delivered.messages)?.sections?.state_flow, undefined);
	      if (mode !== 'active' || !selected.includes('session')) assert.deepEqual(owners.map(triple), deliveryBefore);
	      else assert.equal(f.readState(session).response, `Completed ${mode} ${reload}`);
	      assertExcluded();
	      if (mode !== 'off') assertValues();
	    }
	  }
	  // Model reads still obey selection; explicit operator inspection is a separate authority.
	  if (excluded.length) {
	    calls = 0;
	    const reads: ToolResultMessage[] = [];
	    f.faux.setResponses([
	      () => { calls++; return answer(tool('read_state', { path: excluded[0] }, { id: 'telegram-excluded-read' }), { stopReason: 'toolUse' }); },
	      c => { calls++; reads.push(...c.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolCallId === 'telegram-excluded-read')); return answer('Denied read finished'); },
	    ]);
	    await session.prompt('Attempt excluded model read');
	    assert.equal(calls, 2); assert.equal(reads.length, 1); assert.equal(reads[0].isError, true);
	  }
	  assertExcluded();
	  assert.ok(edits.length >= 6); assert.ok(acknowledgments.length >= 8);
	  assert.deepEqual(errors, []);
	});
}

test("native Telegram Effective reads only selected owners and Off inspection never installs or publishes memory", { timeout: 30_000 }, async t => {
	const registrations: Array<Parameters<StateFlowTelegramSectionModule["registerTelegramSection"]>[0]> = [];
	const f = await realPiFixture(t, { initializeRepository: false, telegram: { load: async () => ({ sections: {
		registerTelegramSection(section) { registrations.push(section); return () => {}; },
	} }) } });
	const { session } = await f.createRuntime("new");
	await session.prompt("/state-flow-active");
	const owners = ["global", "cwd", "session"] as const;
	let calls = 0;
	const results: ToolResultMessage[] = [];
	f.faux.setResponses([
		() => { calls++; return fauxAssistantMessage(fauxToolCall("patch_state", Object.fromEntries(owners.map(owner => [owner, { tactics: { [`${owner}_only`]: `MEMORY-${owner}` } }])), { id: "menu-owner-seed" }), { stopReason: "toolUse" }); },
		context => { calls++; results.push(...context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "menu-owner-seed")); return fauxAssistantMessage("MENU_SESSION_RESPONSE"); },
	]);
	await session.prompt("Create distinct memory in each owner for inspection");
	assert.equal(calls, 2); assert.equal(results.length, 1); assert.notEqual(results[0].isError, true);
	const key = nativeSessionKey(session);
	const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
	const before = files();
	for (let mask = 1; mask < 8; mask++) {
		const scopes = owners.filter((_, bit) => mask & (1 << bit));
		await session.prompt(`/state-flow-off ${scopes.join(" ")}`);
		const section = registrations.at(-1)!;
		const excludedPaths = new Set(owners.filter(owner => !scopes.includes(owner)).flatMap(owner => {
			const paths = temporalScopePaths(f.cwd, session.sessionId, owner, f.repositoryRoot, key);
			return [paths.checkpoint, paths.patches, paths.meta];
		}));
		const attempts: string[] = [], originalRead = fs.readFileSync, originalOpen = fs.openSync;
		const guard = (path: unknown) => { if (excludedPaths.has(String(path))) { attempts.push(String(path)); throw new Error("Excluded menu body read"); } };
		fs.readFileSync = ((...args: Parameters<typeof originalRead>) => { guard(args[0]); return originalRead(...args); }) as typeof originalRead;
		fs.openSync = ((...args: Parameters<typeof originalOpen>) => { guard(args[0]); return originalOpen(...args); }) as typeof originalOpen;
		syncBuiltinESMExports();
		try {
			for (const scope of [...owners, "effective"] as const) {
				const rich: StateFlowTelegramRichMessage[] = [], notices: Array<string | undefined> = [];
				const allowed = scope === "effective" ? scopes.length > 1 : scopes.includes(scope);
				assert.equal(await section.handleCallback!({ action: "inspect", payload: scope, callbackData: (a, p) => `${a}:${p ?? ""}`,
					answerCallback: async notice => { notices.push(notice); }, edit: async () => {}, openRich: async message => { rich.push(message); },
				}), "handled");
				assert.equal(rich.length, allowed ? 1 : 0);
				if (!allowed) { assert.match(notices[0]!, /excluded|at least two/); continue; }
				const serialized = JSON.stringify(rich[0]), included = scope === "effective" ? scopes : [scope];
				for (const owner of owners) assert.equal(serialized.includes(`MEMORY-${owner}`), included.includes(owner));
				assert.equal(serialized.includes("MENU_SESSION_RESPONSE"), included.includes("session"));
				const heading = rich[0].blocks[0];
				assert.equal(heading.type, "heading");
				if (heading.type !== "heading") throw new Error("Missing Rich heading");
				const revision = (heading.text as Array<{ text: string }>)[1].text;
				assert.match(revision, scope === "effective" ? new RegExp(`^${scopes.map(owner => `${owner[0]}\\d+`).join("")}$`) : /^#\d+$/);
			}
			assert.deepEqual(attempts, [], "selected-only inspection must not even attempt an excluded canonical body read");
		} finally { fs.readFileSync = originalRead; fs.openSync = originalOpen; syncBuiltinESMExports(); }
		assert.deepEqual(files(), before, "explicit Off inspection is read-only, including lifecycle and private files");
		assert.throws(() => f.readState(session), /temporal runtime is unavailable/, "disposable inspection must not install the extension runtime");
	}
	assert.equal(calls, 2, "inspection must not invoke a provider");
});

test("Passive response disappears immediately while Stop persistence is blocked", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, {}, { seed: true }, "LAST_ACTIVE_RESPONSE");
	await h.beginRun("Next Active request");
	const native = [user("Next Active request", Date.now())];
	const active = await h.handlers.get("context")!({ messages: native }, h.ctx);
	assert.match(JSON.stringify(active), /LAST_ACTIVE_RESPONSE/);
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(h.repositoryRoot, async () => { enter(); await gate; });
	let selecting: Promise<unknown> | undefined;
	try {
		await entered;
		selecting = h.commands.get("state-flow-passive")!.handler("", h.ctx);
		await delay(0);
		assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
		const passive = await h.handlers.get("context")!({ messages: native }, h.ctx);
		assert.match(JSON.stringify(passive), /State Flow (passive memory|exit handoff)/);
		assert.equal(JSON.stringify(passive).includes("LAST_ACTIVE_RESPONSE"), false);
		assert.equal(h.readState(0, "session").response, "LAST_ACTIVE_RESPONSE");
	} finally {
		release(); await holder; await selecting;
		await h.handlers.get("session_shutdown")!({}, h.ctx);
	}
});

test("lifecycle and write-fence diagnostics retain causes and filenames under long spaced storage paths", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-diagnostic-storage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = join(root, ...Array<string>(14).fill("nested store directory"));
	mkdirSync(repositoryRoot, { recursive: true });
	const h = harness({ repositoryRoot, initializeRepository: false, mode: "passive" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const checkpoint = join(repositoryRoot, "checkpoint.json");
	mkdirSync(checkpoint);
	const notices = h.notifications.length;
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.notifications.length, notices + 1, "Start reports one final failure, not a duplicate restoration warning");
	const failure = h.notifications.at(-1)!;
	assert.match(failure, /^State Flow activation failed:/);
	assert.match(failure, /not a regular file/);
	assert.match(failure, /checkpoint\.json/);
	assert.ok(failure.length <= 220 && !failure.includes("\n"));
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker(h.ctx.sessionManager.getSessionId(), "passive")]);
	// Remove only the deliberately malformed fixture, never a production store.
	rmSync(checkpoint, { recursive: true });
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot);
	const before = files();
	mkdirSync(join(repositoryRoot, ".state-flow-publication.lock"));
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const stopped = h.notifications.at(-1)!;
	assert.match(stopped, /^State Flow passive; memory writes paused:/);
	assert.match(stopped, /publication lock is unavailable/);
	assert.match(stopped, /EEXIST: file already exists/);
	assert.match(stopped, /\.state-flow-publication\.lock/);
	assert.ok(stopped.length <= 220 && !stopped.includes("\n"));
	await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /^\nMemory writes paused after mode change:/);
		assert.match(error.message, /EEXIST: file already exists/);
		assert.match(error.message, /\.state-flow-publication\.lock/);
		assert.match(error.message, /use \/state-flow-active$/);
		assert.ok(error.message.length <= 221);
		return true;
	});
	assert.deepEqual(files(), before);
	assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
});

test("fresh explicit start is local-only; ordinary startup/status and old pointers never create storage", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-fresh-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const repositoryRoot = getDurableRepositoryRoot();
	const unrelatedRoot = join(agentDir, "unrelated");
	assert.equal(repositoryRoot, join(agentDir, "state-flow"));
	mkdirSync(unrelatedRoot);
	const source = join(unrelatedRoot, "unrelated.md");
	const bytes = Buffer.from([0xff, 0x61, 0x0a]);
	writeFileSync(source, bytes);
	const h = harness({ repositoryRoot, initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.equal(existsSync(repositoryRoot), false);
	// Fixture-only identity is configured by the caller, never by the initializer.
	const config = join(agentDir, "gitconfig");
	writeFileSync(config, '[user]\n name = State Flow Tests\n email = state-flow@example.invalid\n');
	const oldConfig = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = config;
	t.after(() => { if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig; });
	execFileSync("git", ["init", unrelatedRoot], { stdio: "ignore" });
	const git = (...args: string[]) => execFileSync("git", ["-C", unrelatedRoot, ...args], { encoding: "utf8" }).trim();
	writeFileSync(join(unrelatedRoot, "checkpoint.json"), "unrelated owned-name witness");
	git("add", ".");
	git("commit", "-m", "source fixture");
	const sourceHead = git("rev-parse", "HEAD");
	writeFileSync(join(unrelatedRoot, "staged.txt"), "staged witness");
	git("add", "staged.txt");
	const sourceIndex = readFileSync(join(unrelatedRoot, ".git", "index"));
	await start(h);
	assert.equal(git("rev-parse", "HEAD"), sourceHead);
	assert.deepEqual(readFileSync(join(unrelatedRoot, ".git", "index")), sourceIndex);
	assert.equal(readFileSync(join(unrelatedRoot, "checkpoint.json"), "utf8"), "unrelated owned-name witness");
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.notifications.some((message) => /push is pending/.test(message)), false);
	const context = h.handlers.get("context")!({ messages: [user("Inspect", 1)] }, h.ctx);
	const contextText = context.messages
		.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
		.map((block: any) => block.text)
		.find((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
	assert.ok(contextText);
	assert.equal(JSON.parse(contextText.slice(contextText.indexOf("\n") + 1)).artifact_invalidations, undefined);
	// Source identity and runtime bookkeeping never reach ordinary model context.
	assert.equal(contextText.includes(hashArtifactSource(bytes)), false);
	assert.deepEqual(readFileSync(source), bytes);
	writeFileSync(join(repositoryRoot, "store-only.md"), "not a Knowledge source");
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.doesNotMatch(h.notifications.at(-1)!, /store-only\.md/);
	assert.doesNotMatch(h.notifications.at(-1)!, /unrelated\.md/);
	const custom = harness({ repositoryRoot: join(agentDir, "custom-store"), initializeRepository: false });
	await start(custom);
	await custom.commands.get("state-flow-status").handler("", custom.ctx);
	assert.doesNotMatch(custom.notifications.at(-1)!, /unrelated\.md/);
	assert.equal(existsSync(join(custom.repositoryRoot, "checkpoint.json")), true);
	const checkpoint = structuredClone(h.entries.at(-1));
	const resumed = harness({ repositoryRoot, initializeRepository: false });
	resumed.entries.push(checkpoint);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	await resumed.commands.get("state-flow-status").handler("", resumed.ctx);
	assert.doesNotMatch(resumed.notifications.at(-1)!, /Publication: pending/);
	const missingRoot = join(agentDir, "new-store");
	const old = harness({ repositoryRoot: missingRoot, initializeRepository: false });
	old.entries.push(checkpoint);
	await old.handlers.get("session_start")!({ reason: "resume" }, old.ctx);
	await old.commands.get("state-flow-active").handler("", old.ctx);
	assert.equal(existsSync(missingRoot), false);
	assert.deepEqual(old.entries, [checkpoint]);
	assert.match(old.notifications.at(-1)!, /Selected current session storage is unavailable/);
});

test("live storage paths mirror Pi CWD and session file names without appended hashes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-native-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = "/home/llb/Repos/deos";
	const sessionId = "01a07d75-d380-72ad-84f6-e83040c93368";
	const sessionFile = `/home/llb/.pi/agent/sessions/--home-llb-Repos-deos--/2026-09-07T20-01-08-993Z_${sessionId}.jsonl`;
	const h = harness({ repositoryRoot: root, cwd, sessionId, sessionFile });
	await start(h);
	const key = sessionStorageKey(sessionFile, sessionId);
	const expectedCwd = join(root, "--home-llb-Repos-deos--");
	const expectedSession = join(expectedCwd, key);
	assert.equal(cwdScopeKey(cwd), "--home-llb-Repos-deos--");
	assert.equal(temporalScopePaths(cwd, sessionId, "cwd", root, key).directory, expectedCwd);
	assert.equal(temporalScopePaths(cwd, sessionId, "session", root, key).directory, expectedSession);
	assert.equal(existsSync(join(expectedSession, "checkpoint.json")), true);
	assert.equal(existsSync(join(expectedSession, "patches.jsonl")), true);
	assert.deepEqual(JSON.parse(readFileSync(join(expectedCwd, "meta.json"), "utf8")).owner, { cwd });
	assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(expectedCwd, "checkpoint.json"), "utf8")), "owner"), false);
	const runtime = sessionRuntimePaths(cwd, sessionId, root, key);
	assert.equal(JSON.parse(readFileSync(runtime.runtime, "utf8")).identity.sessionId, sessionId);
	assert.equal(JSON.parse(readFileSync(runtime.runtime, "utf8")).identity.cwd, cwd);
	assert.equal(execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).includes("-" + "a".repeat(64)), false);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, new RegExp(`Scope keys: CWD --home-llb-Repos-deos--; session ${key}`));
	const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
	const metaBytes = readFileSync(runtime.meta);
	const foreign = harness({ repositoryRoot: root, cwd, sessionId: "foreign-session", sessionFile, initializeRepository: false });
	await start(foreign);
	assert.equal(foreign.activeTools.includes("patch_state"), false);
	assert.match(foreign.notifications.at(-1)!, /scope identity mismatch/);
	assert.deepEqual(readFileSync(runtime.meta), metaBytes);
	assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});

test("registers patch_state plus read-only read_state and exposes the lifecycle commands", () => {
	const h = harness();
	assert.equal(h.registeredTools, 2);
	assert.deepEqual([...h.tools.keys()].sort(), ["patch_state", "read_state"]);
	const patchState = h.tools.get("patch_state")!;
	assert.equal(patchState.executionMode, "sequential");
	assert.match(patchState.description, /one or more global, cwd, or session patches/);
	assert.match(patchState.promptGuidelines.join("\n"), /ordinary answers need no finalization call/);
	assert.match(patchState.promptGuidelines.join("\n"), /Never patch response in global, cwd or session, including clearing\/deleting it/);
	assert.match(patchState.promptGuidelines.join("\n"), /captures your final answer automatically in Active mode/);
	assert.match(patchState.promptGuidelines.join("\n"), /Call patch_state alone in an assistant response/);
	assert.match(patchState.description, /Intent updates run first, then clear owned same-scope strategy\/tactics\/lazy keys unless a remaining or new intent refs them, then other fields apply/);
	assert.match(patchState.description, /Name keys in ASCII/);
	assert.match(h.tools.get("read_state")!.description, /Path object keys must be ASCII identifiers/);
	assert.doesNotMatch(patchState.promptGuidelines.join("\n"), /final:true|terminal-eligible/);
	assert.deepEqual([...h.commands.keys()], ["state-flow-active", "state-flow-passive", "state-flow-off", "state-flow-status"]);
});
test("session mode controls passive tools and bootstrap together without starting an episode", async () => {
	for (const mode of ["off", "passive"] as const) {
		const passiveBootstrap = mode === "passive", passiveTools = mode === "passive";
		const seed = harness({ mode: "off" });
		await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
		await start(seed);
		await seed.tools.get("patch_state")!.execute("seed", { cwd: {
			tactics: { shared: "durable" },
			intents: { release: { action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" } } },
			lazy: { releasePlan: { steps: ["validate"] } },
		} }, undefined, undefined, seed.ctx);
		await seed.commands.get("state-flow-off")!.handler("", seed.ctx);
		const h = harness({ repositoryRoot: seed.repositoryRoot, cwd: seed.ctx.cwd, sessionId: `passive-${mode}`, initializeRepository: false, mode });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), passiveTools);
		const bootstrapResult = h.beforeAgentStart("ordinary");
		assert.equal(bootstrapResult.handlerResult, undefined);
		assert.equal(bootstrapResult.systemPrompt.includes("State Flow passive memory is available"), passiveBootstrap);
		const projected = h.handlers.get("context")!({ messages: [] }, h.ctx);
		assert.equal(projected !== undefined, passiveBootstrap);
		if (passiveBootstrap) {
			assert.match(JSON.stringify(projected), /durable/);
			assert.match(JSON.stringify(projected), /Validate release/);
			assert.doesNotMatch(JSON.stringify(projected), /\"steps\":\[\"validate\"\]/);
		}
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const beforeStop = files();
		await h.commands.get(`state-flow-${mode}`).handler("", h.ctx);
		await h.commands.get(`state-flow-${mode}`).handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, nativePolicyMarker(h.ctx.sessionManager.getSessionId(), mode));
		assert.deepEqual(files(), beforeStop, "pre-runtime Stop never publishes the passive view");
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(files(), beforeStop);
		assert.equal(h.activeTools.includes("patch_state"), passiveTools);
		if (passiveTools) {
			const read = await h.tools.get("read_state")!.execute("read", { path: "tactics.shared" }, undefined, undefined, h.ctx);
			assert.match(read.content[0].text, /durable/);
			const intent = await h.tools.get("read_state")!.execute("intent", { path: "intents.release" }, undefined, undefined, h.ctx);
			assert.match(intent.content[0].text, /cwd\.lazy\.releasePlan/);
			await h.tools.get("patch_state")!.execute("write", { session: { intents: { local: "Continue locally" } } }, undefined, undefined, h.ctx);
			assert.notEqual(h.resolveSnapshot().config.mode, "active");
			assert.equal(h.compactRequests.length, 0);
			assert.equal(h.resolveSnapshot().meta.step, 1);
			const local = await h.tools.get("read_state")!.execute("local-intent", { path: "session.intents.local" }, undefined, undefined, h.ctx);
			assert.match(local.content[0].text, /Continue locally/);
		}
	}
});

for (const scope of ["global", "cwd"] as const) test(`first passive patch_state adopts another session's untouched ${scope} update`, async () => {
	const seed = harness();
	await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
	await start(seed);
	const h = harness({ repositoryRoot: seed.repositoryRoot, cwd: seed.ctx.cwd, sessionId: `passive-drift-${scope}`, initializeRepository: false, mode: "passive" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await seed.tools.get("patch_state")!.execute("neighbor", {
		[scope]: { tactics: { neighbor: "shared update" } },
		session: { tactics: { private: "neighbor only" } },
	}, undefined, undefined, seed.ctx);
	const files = () => captureTemporalFileBases(seed.ctx.cwd, seed.ctx.sessionManager.getSessionId(), seed.repositoryRoot);
	const winner = files();
	await h.tools.get("patch_state")!.execute("first-passive", { session: { tactics: { mine: "private update" } } }, undefined, undefined, h.ctx);
	const read = await h.tools.get("read_state")!.execute("accepted", { paths: [`${scope}.tactics`, "session.tactics"] }, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(read.content[0].text).value, [{ neighbor: "shared update" }, { mine: "private update" }]);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.compactRequests.length, 0);
	assert.deepEqual(files(), winner);
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	const restored = await h.tools.get("read_state")!.execute("restored", { paths: [`${scope}.tactics`, "session.tactics"] }, undefined, undefined, h.ctx);
	assert.deepEqual(restored.content, read.content);
});

for (const activate of ["start", "passive-patch"] as const) {
	test(`pre-runtime Stop preserves global-only memory before ${activate} establishes session state`, async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		writeGlobalState({ ...emptyState(), tactics: { shared: "global" } }, h.repositoryRoot);
		const id = h.ctx.sessionManager.getSessionId();
		const files = () => captureTemporalFileBases(h.ctx.cwd, id, h.repositoryRoot);
		const before = files();
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.readState(0, "global").tactics.shared, "global");
		await h.commands.get("state-flow-passive").handler("", h.ctx);
		await h.commands.get("state-flow-passive").handler("", h.ctx);
		assert.deepEqual(h.entries.at(-1).data, nativePolicyMarker(id, "passive"));
		assert.deepEqual(files(), before);
		assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, id, "cwd", h.repositoryRoot).directory), false);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(files(), before);
		assert.equal(h.readState(0, "global").tactics.shared, "global");
		if (activate === "start") await h.commands.get("state-flow-active").handler("", h.ctx);
		await h.tools.get("patch_state")!.execute("local", { session: { tactics: { local: "retained" } } }, undefined, undefined, h.ctx);
		assert.equal(h.resolveSnapshot().config.mode === "active", activate === "start");
		assert.equal(h.resolveSnapshot().meta.step, 1);
		assert.ok("boundary" in h.entries.at(-1).data);
		const semanticPaths = (["global", "cwd", "session"] as const).flatMap((scope) => {
			const paths = temporalScopePaths(h.ctx.cwd, id, scope, h.repositoryRoot);
			return [paths.checkpoint, paths.patches, paths.meta];
		});
		const semanticBytes = semanticPaths.map((path) => readFileSync(path));
		await h.commands.get("state-flow-passive").handler("", h.ctx);
		assert.ok("boundary" in h.entries.at(-1).data, "an accepted session no longer uses the pre-runtime marker");
		assert.deepEqual(semanticPaths.map((path) => readFileSync(path)), semanticBytes);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.equal(h.readState(0, "session").tactics.local, "retained");
		assert.notEqual(h.resolveSnapshot().config.mode, "active");
		assert.equal(h.resolveSnapshot().meta.step, 1);
		assert.equal(h.compactRequests.length, 0);
		assert.equal(existsSync(join(h.repositoryRoot, ".git")), false);
	});
}

for (const invalid of ["cwd-without-global", "malformed-global", "incomplete-global"] as const) {
	test(`pre-runtime Stop leaves ${invalid} storage untouched`, async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		if (invalid === "cwd-without-global") writeCwdState(h.ctx.cwd, { ...emptyState(), tactics: { project: "retained" } }, h.repositoryRoot);
		else {
			const checkpoint = writeGlobalState(emptyState(), h.repositoryRoot);
			if (invalid === "malformed-global") writeFileSync(checkpoint, "{broken\n");
			else rmSync(temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "global", h.repositoryRoot).patches);
		}
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const before = files();
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		if (invalid === "cwd-without-global") {
			assert.equal(h.notifications.length, 0);
			assert.equal(h.readState(0, "cwd").tactics.project, "retained");
			assert.equal(existsSync(sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime), false);
		} else assert.match(h.notifications.at(-1)!, /Snapshot restoration failed:.*(invalid JSON|Incomplete selected State Flow global observation)/);
		await h.commands.get("state-flow-passive").handler("", h.ctx);
		const stopped = structuredClone(h.entries.at(-1).data);
		if (invalid === "cwd-without-global") assert.deepEqual(stopped, nativePolicyMarker(h.ctx.sessionManager.getSessionId(), "passive"));
		else {
			assert.match(stopped.persistenceError, /selected branch is unavailable/);
			assert.equal(stopped.preserveContext, true);
			assert.equal(typeof stopped.at, "number");
			assert.deepEqual(stopped, { ...nativePolicyMarker(h.ctx.sessionManager.getSessionId(), "passive"), at: stopped.at, preserveContext: true, persistenceError: stopped.persistenceError });
		}
		assert.deepEqual(files(), before);
		await h.commands.get("state-flow-active").handler("", h.ctx);
		if (invalid === "cwd-without-global") {
			assert.equal(h.resolveSnapshot().config.mode, "active", "explicit Start may initialize a wholly absent global scope");
			assert.equal(h.readState(0, "cwd").tactics.project, "retained");
		} else {
			assert.match(h.notifications.at(-1)!, /activation failed/);
			assert.deepEqual(files(), before);
			assert.deepEqual(h.entries.at(-1).data, stopped);
		}
	});
}

test("restarting a long ordinary session without State Flow checkpoints bootstraps from native conversation", async () => {
	const seed = harness({ initializeRepository: false, mode: "passive" });
	await seed.handlers.get("session_start")!({ reason: "new" }, seed.ctx);
	await seed.tools.get("patch_state")!.execute("shared", { cwd: { tactics: { shared: "retained" } } }, undefined, undefined, seed.ctx);
	const h = harness({ repositoryRoot: seed.repositoryRoot, sessionId: "ordinary-restarted", initializeRepository: false, mode: "passive" });
	h.entries.push({ type: "message", message: user("Long conversation before the extension was enabled", 1) });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.readState(0, "cwd").tactics.shared, "retained");
	assert.deepEqual(h.readState(0, "session").tactics, {});
	assert.match((await h.beginRun("Compile this conversation")).systemPrompt, /State Flow is enabled/);
});

test("an old passive checkpoint attaches current memory automatically and retains the session step", async () => {
	const h = harness({ initializeRepository: false, mode: "passive", sessionId: "ordinary-session" });
	h.entries.push({ type: "message", message: user("A long ordinary conversation", 1) });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	for (let index = 1; index <= 9; index++) {
		await h.tools.get("patch_state")!.execute(`passive-${index}`, { cwd: { tactics: { shared: index } } }, undefined, undefined, h.ctx);
	}
	const expired = structuredClone(h.entries.slice(0, 2));
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const resumed = harness({ repositoryRoot: h.repositoryRoot, initializeRepository: false, mode: "passive", sessionId: "ordinary-session" });
	resumed.entries.push(...expired);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.deepEqual(resumed.notifications, [], "an old Pi step is not a recovery failure");
	const semantic = (cohort: ReturnType<typeof files>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));
	assert.deepEqual(semantic(files()), semantic(before), "attachment never rewinds current semantics");
	assert.equal(resumed.resolveSnapshot().config.mode, "passive");
	assert.equal(resumed.resolveSnapshot().meta.step, 9);
	assert.equal(resumed.readState(0, "cwd").tactics.shared, 9);
	await resumed.tools.get("patch_state")!.execute("writable", { session: { tactics: { writable: true } } }, undefined, undefined, resumed.ctx);
	assert.equal(resumed.readState(0, "session").tactics.writable, true);
});

test("an old passive checkpoint adopts nonempty current private memory instead of resetting it", async () => {
	const h = harness({ initializeRepository: false, mode: "passive", sessionId: "private-passive" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	for (let index = 1; index <= 9; index++) {
		await h.tools.get("patch_state")!.execute(`private-${index}`, { session: { tactics: { private: index } } }, undefined, undefined, h.ctx);
	}
	const expired = structuredClone(h.entries.filter(({ data }) => typeof data?.boundary === "string").slice(0, 1));
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const resumed = harness({ repositoryRoot: h.repositoryRoot, initializeRepository: false, mode: "passive", sessionId: "private-passive" });
	resumed.entries.push(...expired);
	await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.readState(0, "session").tactics.private, 9);
	assert.ok(before.length > 0);
	await resumed.commands.get("state-flow-active")!.handler("", resumed.ctx);
	assert.equal(resumed.resolveSnapshot().config.mode, "active");
	assert.equal(resumed.resolveSnapshot().meta.step, 9);
	assert.equal(resumed.readState(0, "session").tactics.private, 9);
	await resumed.tools.get("patch_state")!.execute("after-start", { session: { tactics: { afterStart: true } } }, undefined, undefined, resumed.ctx);
	assert.deepEqual(resumed.readState(0, "session").tactics, { private: 9, afterStart: true });
	assert.equal(resumed.resolveSnapshot().meta.step, 10);
});

test("old Pi steps never block memory: tree navigation keeps current memory in every mode", async () => {
	for (const mode of ["active", "passive"] as const) {
		const h = harness({ initializeRepository: false, mode });
		await start(h);
		if (mode === "passive") await h.commands.get("state-flow-passive").handler("", h.ctx);
		const old = structuredClone(h.entries);
		for (let index = 1; index <= 9; index++) {
			await h.tools.get("patch_state")!.execute(`seed-${index}`, { session: { tactics: { private: index } } }, undefined, undefined, h.ctx);
		}
		const notices = h.notifications.length;
		h.ctx.sessionManager.getBranch = () => old;
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.notifications.length, notices, "an old Pi step is not a recovery failure");
		assert.equal(h.statuses.at(-1), `<accent>state-flow</accent> <dim>${mode}</dim>`);
		assert.equal(h.readState(0, "session").tactics.private, 9, "memory is the current JSON state, not the step's revision");
		const permitted = new AbortController();
		await h.inferenceContext([user("Continue", 100)], permitted);
		assert.equal(permitted.signal.aborted, false);
		await h.tools.get("patch_state")!.execute("continued", { session: { tactics: { continued: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").tactics.continued, true);
	}
});

test("unreadable current session memory visibly blocks Active; Passive retries and Off releases inference only", async () => {
	for (const recovery of ["passive", "off"] as const) {
		const h = harness({ initializeRepository: false, mode: "active" });
		await start(h);
		await h.tools.get("patch_state")!.execute("seed", { global: { tactics: { shared: "retained" } }, session: { tactics: { private: 1 } } }, undefined, undefined, h.ctx);
		const runtimePath = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
		const original = readFileSync(runtimePath);
		writeFileSync(runtimePath, "malformed runtime");
		const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const before = files();
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active (blocked)</dim>");
		assert.equal(h.activeTools.includes("patch_state"), true, "failed Active does not silently select Off");
		assert.equal(h.handlers.get("context")!({ messages: [user("Idle inspection", 99)] }, h.ctx), undefined, "unavailable memory never fabricates an idle projection");
		await h.commands.get("state-flow-status").handler("", h.ctx);
		assert.match(h.notifications.at(-1)!, /Mode: active\nSelected scopes: global, cwd, session\nInference blocked:/);
		const blocked = new AbortController();
		await h.inferenceContext([user("Do not send the raw history", 100)], blocked);
		assert.equal(blocked.signal.aborted, true);
		assert.match(h.notifications.at(-1)!, /inference blocked/);
		await assert.rejects(h.tools.get("read_state")!.execute("shared", { path: "global.tactics.shared" }), /selected branch is unavailable/, "failed current-private proof cannot authorize a shared-only model fallback");
		assert.throws(() => h.readState(0, "session"), /unavailable/);
		await assert.rejects(h.tools.get("patch_state")!.execute("refused", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), /selected branch is unavailable/);
		await h.commands.get(`state-flow-${recovery}`).handler("", h.ctx);
		if (recovery === "passive") assert.match(h.notifications.at(-1)!, /passive; memory writes paused:.*session policy contains invalid JSON/);
		const permitted = new AbortController();
		await h.inferenceContext([user("Explicit native context policy", 101)], permitted);
		assert.equal(permitted.signal.aborted, false, "an explicit inactive choice releases the inference fence");
		assert.deepEqual(files(), before, "unreadable memory is never replaced");
		writeFileSync(runtimePath, original);
		await h.commands.get(`state-flow-${recovery === "passive" ? "passive" : "active"}`).handler("", h.ctx);
		assert.equal(h.readState(0, "session").tactics.private, 1);
		await h.tools.get("patch_state")!.execute("repaired", { session: { tactics: { repaired: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").tactics.repaired, true);
	}
});

test("repeated Start during an active run is inert and cannot cancel accepted-response reconciliation", async () => {
	const h = harness({ initializeRepository: false });
	await start(h, "Current request");
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Accepted in-flight answer" }] };
	h.handlers.get("message_end")!({ message }, h.ctx);
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.deepEqual(h.entries, entries);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Accepted in-flight answer");
});

test("removes proven-missing registered artifacts from every owning scope without directory discovery", async () => {
	const h = harness();
	await start(h);
	const paths = {
		global: join(h.repositoryRoot, "global-source.bin"),
		cwd: join(h.repositoryRoot, "cwd-source.txt"),
		session: join(h.repositoryRoot, "session-source.md"),
	} as const;
	for (const path of Object.values(paths)) writeFileSync(path, "registered source");
	await h.tools.get("patch_state")!.execute("register", {
		global: { artifacts: { [paths.global]: { description: "Global source" } } },
		cwd: { artifacts: { [paths.cwd]: { description: "CWD source" } } },
		session: { artifacts: { [paths.session]: { description: "Session source" } } },
	}, undefined, undefined, h.ctx);
	for (const path of Object.values(paths)) rmSync(path);
	await h.beginRun("Observe removals");
	for (const [scope, path] of Object.entries(paths) as ["global" | "cwd" | "session", string][]) {
		assert.equal(h.readState(0, scope).artifacts[path], undefined);
	}
});

test("automatic artifact cleanup updates revision status before a later scoped patch", async () => {
	const h = harness();
	await start(h);
	const source = join(h.repositoryRoot, "cwd-source.txt");
	writeFileSync(source, "registered source");
	await h.tools.get("patch_state")!.execute("register", {
		cwd: { artifacts: { [source]: { description: "CWD source" } } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
	rmSync(source);
	await h.beginRun("Observe removal");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
	await h.tools.get("patch_state")!.execute("session-only", {
		session: { tactics: { retained: true } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
});

test("State Flow tools follow branch enablement and history reads cannot run while disabled", async () => {
	const h = harness();
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.deepEqual(h.activeTools, ["read", "bash"]);
	const read = h.tools.get("read_state");
	await assert.rejects(read.execute("disabled", {}, undefined), /tools are off/);
	await start(h);
	assert.deepEqual([...h.activeTools].sort(), ["bash", "patch_state", "read", "read_state"]);
	const enabled = structuredClone(h.entries);
	await h.commands.get("state-flow-off").handler("", h.ctx);
	assert.deepEqual(h.activeTools, ["read", "bash"]);
	await assert.rejects(read.execute("disabled-again", {}, undefined), /tools are off/);
	h.ctx.sessionManager.getBranch = () => enabled;
	await h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.activeTools.includes("read_state"), true);
	assert.equal(h.activeTools.includes("patch_state"), true);
	await assert.rejects(read.execute("aborted", {}, AbortSignal.abort()), /aborted/);
});

test("read_state lazily projects all hot historical paths and scopes without publication or Git calls", async () => {
	const h = harness();
	await start(h);
	const read = h.tools.get("read_state");
	await assert.rejects(read.execute("missing-path", {}, undefined, undefined, h.ctx), /requires path or paths/);
	await assert.rejects(read.execute("pre-origin", { path: "effective[1]" }, undefined, undefined, h.ctx), /predates the proven temporal origin/);
	const expected: Record<string, Record<string, string>> = { global: {}, cwd: {}, session: {} };
	const history = [structuredClone(expected)];
	const changes = [["global", "G1"], ["cwd", "C2"], ["session", "S3"], ["session", null],
		["cwd", null], ["global", "G6"], ["cwd", "C7"], ["session", "S8"]] as const;
	for (const [scope, value] of changes) {
		await h.tools.get("patch_state").execute("patch", { [scope]: { tactics: { shared: value } } }, undefined, undefined, h.ctx);
		if (value === null) delete expected[scope]!.shared;
		else expected[scope]!.shared = value;
		history.push(structuredClone(expected));
	}
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	const checkpointCount = h.entries.length;
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (() => { throw new Error("History read queried a process"); }) as typeof spawn;
	syncBuiltinESMExports();
	try {
		for (let offset = 0; offset <= 7; offset++) {
			const states = history[history.length - 1 - offset]!;
			for (const scope of ["effective", "global", "cwd", "session"]) {
				const path = `${scope}[${offset}]`;
				const result = await read.execute("history", { path }, undefined, undefined, h.ctx);
				const value = JSON.parse(result.content[0].text);
				const tactics = scope === "effective" ? { ...states.global, ...states.cwd, ...states.session } : states[scope];
				assert.deepEqual(value.value, Object.keys(tactics!).length > 0 ? { tactics } : {});
				assert.deepEqual(result.details, { path, projection: "value" });
			}
		}
		const currentPath = JSON.parse((await read.execute("path-current", { path: "effective" }, undefined, undefined, h.ctx)).content[0].text);
		assert.equal(currentPath.value.tactics.shared, "S8");
		assert.deepEqual(Object.keys(currentPath), ["value"]);
		const selectedValue = JSON.parse((await read.execute("path-value", { path: "effective.tactics.shared" }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(selectedValue, { value: "S8" });
		const conciseValue = JSON.parse((await read.execute("concise-path", { path: "tactics.shared" }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(conciseValue, selectedValue);
		const selectedKeys = JSON.parse((await read.execute("path-keys", { path: "effective.tactics", projection: "keys" }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(selectedKeys, { meta: { type: "object", size: 1 }, keys: { shared: "string" } });
		const batch = JSON.parse((await read.execute("path-batch", { paths: ["global.tactics.shared", "cwd.tactics.shared"] }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(batch, { value: ["G6", "C7"] });
		const selectedPatch = JSON.parse((await read.execute("projected-patch", { path: "global[2].tactics.shared", projection: "patch" }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(selectedPatch, { patch: "G6" });
		const previousGlobalPatch = JSON.parse((await read.execute("path-patch", { path: "global.patches[1]" }, undefined, undefined, h.ctx)).content[0].text);
		assert.deepEqual(previousGlobalPatch, { patch: { tactics: { shared: "G1" } } });
		await assert.rejects(read.execute("double-path", { path: "tactics", paths: ["cwd.tactics"] }, undefined, undefined, h.ctx), /not both/);
		await assert.rejects(read.execute("projection-only", { projection: "keys" }, undefined, undefined, h.ctx), /requires path or paths/);
		for (const path of ["effective[-1]", "effective[8]", "effective[0.5]", "other.tactics"]) {
			await assert.rejects(read.execute("invalid", { path }, undefined, undefined, h.ctx));
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
	assert.equal(head(), before);
	assert.equal(h.entries.length, checkpointCount);
	assert.equal(h.resolveSnapshot().meta.step, 8);
});

test("read_state returns dangling-reference hints as top-level metadata beside a null sentinel value", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state").execute("seed-reference", {
		cwd: { tactics: { continuation: "Read `$cwd.lazy.missing` only when needed." } },
	}, undefined, undefined, h.ctx);
	const read = h.tools.get("read_state");
	const result = await read.execute("missing-reference", { path: "cwd.lazy.missing" }, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(result.content[0].text), {
		value: null,
		hint: [{
			type: "dangling-reference",
			message: "The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task.",
			paths: ["cwd.tactics.continuation"],
		}],
	});
	assert.deepEqual(result.details, { path: "cwd.lazy.missing", projection: "value" });
	await assert.rejects(
		read.execute("invented-reference", { path: "cwd.lazy.invented" }, undefined, undefined, h.ctx),
		(error: unknown) => error instanceof Error && !error.message.includes("hint"),
	);
});

test("lets ordinary tool-bearing responses run without comments or intermediate state commits", async () => {
	const h = harness();
	await start(h, "Investigate");
	const beforeEntries = h.entries.length;
	const response = h.handlers.get("message_end")!({ message: toolAssistant("read-1") }, h.ctx);
	assert.equal(response, undefined);
	await h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.resolveSnapshot().meta.step, 0);
});

test("ordinary direct and tool-followed answers complete without a finalization inference", async () => {
	for (const withTool of [false, true]) {
		const h = harness();
		await start(h, withTool ? "Use a tool then answer" : "Answer directly");
		if (withTool) {
			h.handlers.get("message_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
			await h.handlers.get("turn_end")!({ message: toolAssistant("read-before-answer") }, h.ctx);
		}
		const message = finalMessage(withTool ? "Tool-informed answer." : "Direct answer.");
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, withTool ? "Tool-informed answer." : "Direct answer.");
		assert.equal(h.sentMessages.length, 0, "completion must not schedule a repair inference");
	}
});

test("multiple patch barriers can precede one ordinary answer", async () => {
	const h = harness();
	await start(h, "Patch twice then answer");
	await h.tools.get("patch_state")!.execute("first", { session: { tactics: { first: true } } }, undefined, undefined, h.ctx);
	await h.tools.get("patch_state")!.execute("second", { session: { tactics: { second: true } } }, undefined, undefined, h.ctx);
	const message = finalMessage("Both changes are retained.");
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.deepEqual(h.readState().tactics, { first: true, second: true });
	assert.equal(h.readState().response, "Both changes are retained.");
	assert.equal(h.sentMessages.length, 0);
});

test("global memory is always available while State Flow is enabled", async () => {
	const h = harness();
	const started = await start(h, "Durable preference");
	assert.match(started.systemPrompt, /State Flow is enabled\. It owns durable memory\./);
	assert.match(started.systemPrompt, /global=cross-project\/user\/environment knowledge/);
	const accepted = await h.tools.get("patch_state")!.execute(
		"global-memory", { global: { tactics: { preference: "compact" } } }, undefined, undefined, h.ctx,
	);
	assert.equal(accepted.content[0].text, "\nState materialized atomically at global scope.");
	assert.equal(accepted.content.length, 1, "predictable direct write needs no semantic echo");
	assert.equal(h.readState(0, "global").tactics.preference, "compact");
});

test("patch_state commits global, CWD, and session as one model-facing atomic barrier", async () => {
	const h = harness();
	await start(h, "Atomic scope cohort");
	const beforeStep = h.resolveSnapshot().meta.step;
	const result = await h.tools.get("patch_state")!.execute("atomic", {
		global: { strategy: { shared: "global" } },
		cwd: { tactics: { project: "cwd" } },
		session: { tactics: { continuation: "session" } },
	}, undefined, undefined, h.ctx);
	assert.deepEqual(result.details.scopes, ["global", "cwd", "session"]);
	assert.equal(result.content.length, 1, "disjoint multi-scope writes need no echo");
	assert.equal(h.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(h.readState(0, "global").strategy.shared, "global");
	assert.equal(h.readState(0, "cwd").tactics.project, "cwd");
	assert.equal(h.readState(0, "session").tactics.continuation, "session");
	assert.equal(h.handlers.get("message_end")!({ message: finalMessage("Still pending.") }, h.ctx), undefined);
	await h.handlers.get("turn_end")!({ message: finalMessage("Still pending.") }, h.ctx);
	assert.equal(h.readState().response, "Still pending.");
});

test("patch_state materializes session state before the next inference and response reconciliation", async () => {
	const h = harness();
	await start(h, "Long-running task");
	const patchState = h.tools.get("patch_state")!;
	const result = await patchState.execute(
		"patch-1",
		{ session: { tactics: { verified: "intermediate" } } },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(result.content[0].text, "\nState materialized atomically at session scope.");
	assert.equal(result.content.length, 1, "predictable direct write needs no semantic echo");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.tactics.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "");
	const acceptedResult = { role: "toolResult", toolCallId: "patch-1", toolName: "patch_state", content: result.content, timestamp: 2 };
	const projected = h.handlers.get("context")!({ messages: [user("Long-running task", 1), acceptedResult] }, h.ctx);
	assert.equal(projected.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context")).length, 1);
	assert.doesNotMatch(projected.messages[0].content[0].text, /"verified":"intermediate"/, "the head stays at iteration start");
	assert.equal(projected.messages.at(-1), acceptedResult, "accepted values reach the next inference in the native tail");

	const terminal = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete." }] };
	assert.equal(h.handlers.get("message_end")!({ message: terminal }, h.ctx), undefined);
	await h.handlers.get("turn_end")!({ message: terminal }, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.tactics.verified, "intermediate");
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "Complete.");
});

test("patch_state renders arguments once with separate changed, no-op and error results", async () => {
	const h = harness();
	await start(h, "Single patch display");
	const patchState = h.tools.get("patch_state")!;
	const args = {
		global: { tactics: { shared: true } },
		cwd: { tactics: { project: true } },
		session: { strategy: { mode: "strict" }, tactics: { visiblePatch: "intermediate" } },
	};
	const changed = await patchState.execute("display-change", args, undefined, undefined, h.ctx);
	const current = await patchState.execute("display-no-op", args, undefined, undefined, h.ctx);
	assert.equal(changed.details.changed, true);
	assert.equal(current.details.changed, false);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
	const context = { args, isError: false } as any;
	const call = patchState.renderCall(args, theme, context);
	const callText = call.render(1_000).map((line: string) => line.trimEnd()).join("\n");
	assert.ok(callText.startsWith("patch_state\n\n{"));
	assert.deepEqual(JSON.parse(callText.slice(callText.indexOf("\n") + 1)), args);
	assert.match(callText, /"global": \{[\s\S]+\n\n  "cwd": \{[\s\S]+\n\n  "session": \{/);
	assert.match(callText, /"strategy": \{[\s\S]+\n\n    "tactics": \{/);
	for (const result of [changed, current]) {
		const before = structuredClone(result);
		for (const expanded of [false, true]) {
			const rendered = patchState.renderResult(result, { expanded, isPartial: false }, theme, context);
			const text = rendered.render(1_000).map((line: string) => line.trimEnd()).join("\n");
			assert.equal(text, result.content[0].text);
			assert.doesNotMatch(text, /visiblePatch|"global"|"cwd"|"session"/);
			for (const width of [40, 80, 120]) {
				const row = [...call.render(width), ...rendered.render(width)].join("\n");
				assert.equal(row.split("visiblePatch").length - 1, 1);
			}
		}
		assert.deepEqual(result, before, "rendering must not change the model-facing receipt");
	}
	for (const [text, isPartial, isError] of [["Pending", true, false], ["WebSocket error", false, true]] as const) {
		const rendered = patchState.renderResult(
			{ content: [{ type: "text", text }, { type: "text", text: '\n{"state_updates":{"effective":[]}}' }] },
			{ expanded: true, isPartial }, theme, { ...context, isError },
		);
		assert.equal(rendered.render(1_000).map((line: string) => line.trimEnd()).join("\n"), `\n${text}`);
	}
});

test("patch_state suppresses call arguments when configured but retains rejected arguments", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-hidden-patches-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	mkdirSync(join(agentDir, "state-flow"));
	writeFileSync(join(agentDir, "state-flow", "config.json"), JSON.stringify({ showSuccessfulPatches: false }));
	const h = harness({ agentDir, repositoryRoot: join(agentDir, "state-flow") });
	await start(h, "Hide successful patch details");
	const patchState = h.tools.get("patch_state")!;
	const args = { session: { tactics: { hiddenPatch: "hidden" } } };
	const result = await patchState.execute("hidden-patch", args, undefined, undefined, h.ctx);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
	for (const expanded of [false, true]) {
		const context = { args, expanded, isError: false } as any;
		const call = patchState.renderCall(args, theme, context);
		assert.equal(call.render(120).map((line: string) => line.trimEnd()).join("\n"), "patch_state");
		const rendered = patchState.renderResult(result, { expanded, isPartial: false }, theme, context);
		const row = [...call.render(120), ...rendered.render(120)].join("\n");
		assert.match(row, /patch_state\s+State materialized atomically at session scope\./);
		assert.doesNotMatch(row, /hiddenPatch|"hidden"/);
	}
	const rejected = patchState.renderCall(args, theme, { args, isError: true } as any);
	assert.match(rejected.render(120).join("\n"), /hiddenPatch/);
});

test("patch_state is the only tool allowed to execute from its assistant response", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-barrier-integration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = join(root, "state-flow");
	mkdirSync(repositoryRoot);
	writeFileSync(join(repositoryRoot, "config.json"), JSON.stringify({ logging: true }));
	const h = harness({ agentDir: root, repositoryRoot });
	await start(h, "Barrier task");
	h.entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "history-1", name: "read_state", arguments: { offset: 1 } },
				{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "echo private sibling input" } },
				{ type: "toolCall", id: "patch-1", name: "patch_state", arguments: { session: { tactics: { next: true } } } },
				{ type: "thinking", thinking: "private reasoning body" },
			],
		},
	});
	h.handlers.get("turn_start")!({}, h.ctx);
	h.handlers.get("message_end")!({ message: h.entries.at(-1)!.message }, h.ctx);
	const gate = h.handlers.get("tool_call")!;
	assert.match(gate({ toolCallId: "history-1", toolName: "read_state", input: { offset: 1 } }, h.ctx).reason, /barrier/);
	assert.match(gate({ toolCallId: "bash-1", toolName: "bash", input: { command: "echo private sibling input" } }, h.ctx).reason, /barrier/);
	assert.equal(gate({ toolCallId: "patch-1", toolName: "patch_state", input: { session: { tactics: { next: true } } } }, h.ctx), undefined);

	h.entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "patch-2", name: "patch_state", arguments: { session: { tactics: { first: true } } } },
				{ type: "toolCall", id: "patch-3", name: "patch_state", arguments: { cwd: { tactics: { second: true } } } },
			],
		},
	});
	await h.handlers.get("turn_end")!({ message: toolAssistant("previous") }, h.ctx);
	h.handlers.get("turn_start")!({}, h.ctx);
	h.handlers.get("message_end")!({ message: h.entries.at(-1)!.message }, h.ctx);
	assert.match(gate({ toolCallId: "patch-2", toolName: "patch_state", input: {} }, h.ctx).reason, /exactly one/);
	assert.match(gate({ toolCallId: "patch-3", toolName: "patch_state", input: {} }, h.ctx).reason, /exactly one/);
	const path = stateFlowLogPath(root);
	const jsonl = readFileSync(path, "utf8");
	assert.doesNotMatch(jsonl, /private sibling input|private reasoning body|"input"|"content"/);
	const records = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
	const blockedSibling = "Blocked by the patch_state barrier; reconsider this action after State Flow rematerializes context";
	const multiplePatches = "A State Flow barrier response must contain exactly one patch_state call";
	assert.deepEqual(records.map(({ category, error, tool, toolCallId, batchToolNames }) => ({ category, error, tool, toolCallId, batchToolNames })), [
		{ category: "barrier-block", error: blockedSibling, tool: "read_state", toolCallId: "history-1", batchToolNames: ["read_state", "bash", "patch_state"] },
		{ category: "barrier-block", error: blockedSibling, tool: "bash", toolCallId: "bash-1", batchToolNames: ["read_state", "bash", "patch_state"] },
		{ category: "barrier-block", error: multiplePatches, tool: "patch_state", toolCallId: "patch-2", batchToolNames: ["patch_state", "patch_state"] },
		{ category: "barrier-block", error: multiplePatches, tool: "patch_state", toolCallId: "patch-3", batchToolNames: ["patch_state", "patch_state"] },
	]);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.match(gate({ toolCallId: "patch-3", toolName: "patch_state", input: {} }, h.ctx).reason, /no current native request/, "the old Active batch cannot become Passive work");
	await h.handlers.get("turn_end")!({ message: toolAssistant("previous") }, h.ctx);
	h.handlers.get("turn_start")!({}, h.ctx);
	h.handlers.get("message_end")!({ message: h.entries.findLast(entry => entry.type === "message")!.message }, h.ctx);
	assert.equal(gate({ toolCallId: "patch-3", toolName: "patch_state", input: {} }, h.ctx), undefined, "a fresh Passive batch has no patch barrier");
	assert.equal(readFileSync(path, "utf8"), jsonl, "Passive does not record barrier diagnostics");
});

test("patch barrier still blocks calls without opt-in logging", async () => {
	const h = harness();
	await start(h, "Barrier without diagnostics");
	h.entries.push({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "patch-1", name: "patch_state", arguments: {} },
		{ type: "toolCall", id: "patch-2", name: "patch_state", arguments: {} },
	] } });
	h.handlers.get("turn_start")!({}, h.ctx);
	h.handlers.get("message_end")!({ message: h.entries.at(-1)!.message }, h.ctx);
	const gate = h.handlers.get("tool_call")!;
	assert.match(gate({ toolCallId: "patch-1", toolName: "patch_state", input: {} }, h.ctx).reason, /exactly one/);
	assert.equal(existsSync(stateFlowLogPath(h.agentDir)), false);
});

test("tool preflight walks only the selected native suffix for matching calls, without rebuilding a branch", async (t) => {
	const observations: Array<{ pastRuns: number; branchEntries: number; visited: string[]; expected: string[] }> = [];
	for (const pastRuns of [0, 200]) {
		const manager = SessionManager.inMemory("/tmp");
		// Bind each runtime to the real fixture manager's immutable identity instead of transplanting a foreign manager into another owner's cache.
		const header = manager.getHeader()!;
		const h = harness({ cwd: header.cwd, sessionId: manager.getSessionId(), sessionTimestamp: header.timestamp });
		await start(h);
		const gate = h.handlers.get("tool_call")!;
		for (let run = 0; run < pastRuns; run++) {
			manager.appendMessage(user(`Old request ${run}`, run * 2));
			manager.appendMessage(fauxAssistantMessage(`Old answer ${run}`));
		}
		const assistant = manager.appendMessage(fauxAssistantMessage([
			fauxToolCall("read", { path: "not-executed.txt" }, { id: "read-1" }),
			fauxToolCall("patch_state", {}, { id: "patch-1" }),
		], { stopReason: "toolUse" }));
		const custom = manager.appendCustomEntry("foreign-context", { retained: true });
		const result = manager.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Blocked sibling" }], isError: true, timestamp: Date.now() });
		const selected = manager.appendCustomEntry("foreign-after-result", { retained: true });
		const abandoned = manager.appendMessage(fauxAssistantMessage([
			fauxToolCall("patch_state", {}, { id: "patch-1" }),
			fauxToolCall("patch_state", {}, { id: "patch-2" }),
		], { stopReason: "toolUse" }));
		manager.branch(selected);
		const before = structuredClone(manager.getEntries());
		const branch = manager.getBranch.bind(manager);
		const leaf = manager.getLeafEntry.bind(manager);
		const entry = manager.getEntry.bind(manager);
		let branchEntries = 0;
		let visited: string[] = [];
		t.mock.method(manager, "getBranch", (...args: Parameters<typeof branch>) => {
			const path = branch(...args);
			branchEntries += path.length;
			return path;
		});
		t.mock.method(manager, "getLeafEntry", () => {
			const value = leaf();
			if (value) visited.push(value.id);
			return value;
		});
		t.mock.method(manager, "getEntry", (id: string) => {
			visited.push(id);
			return entry(id);
		});
		const ctx = { ...h.ctx, sessionManager: manager };
		await h.handlers.get("turn_end")!({ message: toolAssistant("previous") }, ctx);
		h.handlers.get("turn_start")!({}, ctx);
		h.handlers.get("message_end")!({ message: (manager.getEntry(assistant) as any).message }, ctx);
		for (const [toolCallId, toolName] of [["read-1", "read"], ["patch-1", "patch_state"]]) {
			branchEntries = 0;
			visited = [];
			const rejection = gate({ toolCallId, toolName, input: {} }, ctx);
			if (toolName === "read") assert.match(rejection.reason, /barrier/);
			else assert.equal(rejection, undefined);
			observations.push({ pastRuns, branchEntries, visited, expected: [selected, result, custom, assistant] });
		}
		manager.branch(abandoned);
		visited = [];
		await h.handlers.get("turn_end")!({ message: toolAssistant("previous") }, ctx);
		h.handlers.get("turn_start")!({}, ctx);
		h.handlers.get("message_end")!({ message: (manager.getEntry(abandoned) as any).message }, ctx);
		branchEntries = 0;
		visited = [];
		assert.match(gate({ toolCallId: "patch-1", toolName: "patch_state", input: {} }, ctx).reason, /exactly one/);
		observations.push({ pastRuns, branchEntries, visited, expected: [abandoned] });
		visited = [];
		assert.equal(gate({ toolCallId: "missing", toolName: "read", input: {} }, ctx), undefined);
		assert.equal(manager.getLeafId(), abandoned);
		assert.deepEqual(manager.getEntries(), before, "preflight must preserve the complete native tree, including the unselected branch");
	}
	assert.deepEqual(observations.map(({ pastRuns, branchEntries }) => ({ pastRuns, branchEntries })),
		[0, 0, 0, 200, 200, 200].map((pastRuns) => ({ pastRuns, branchEntries: 0 })), "preflight must not rebuild completed native history");
	for (const { visited, expected } of observations) assert.deepEqual(visited, expected, "stop at the nearest matching assistant without a stale branch/batch cache");
});

test("patch_state tolerates shared-scope drift while preserving the session layer", async () => {
	const a = harness();
	await start(a, "Session A");
	await a.tools.get("patch_state")!.execute("a-initial", { session: { tactics: { owner: "A" } } }, undefined, undefined, a.ctx);
	const b = harness({
		repositoryRoot: a.repositoryRoot,
		cwd: a.ctx.cwd,
		sessionId: "harness-session-b",
		initializeRepository: false,
	});
	await start(b, "Session B");
	await b.tools.get("patch_state")!.execute("b-global", { global: { tactics: { globalFromB: true } } }, undefined, undefined, b.ctx);
	const beforeStep = a.resolveSnapshot().meta.step;
	const result = await a.tools.get("patch_state")!.execute("a-session", { session: { tactics: { continued: true } } }, undefined, undefined, a.ctx);
	assert.deepEqual(JSON.parse(result.content[1].text).state_updates.effective, [
		{ path: ["tactics", "globalFromB"], value: true },
	]);
	assert.equal(a.resolveSnapshot().meta.step, beforeStep + 1);
	assert.equal(a.readState(0, "session").tactics.owner, "A");
	assert.equal(a.readState(0, "session").tactics.continued, true);
	assert.equal(a.readState(0, "global").tactics.globalFromB, true);
	assert.equal(JSON.stringify(a.sentMessages).includes("cannot publish"), false);
	await b.tools.get("patch_state")!.execute("b-drift", { global: { tactics: { globalFromB: "newer" } } }, undefined, undefined, b.ctx);
	const repeated = await a.tools.get("patch_state")!.execute("a-repeat", { session: { tactics: { continued: true } } }, undefined, undefined, a.ctx);
	assert.equal(repeated.details.changed, false, "adopting foreign memory is not a new authored change");
	assert.deepEqual(JSON.parse(repeated.content[1].text).state_updates.effective, [
		{ path: ["tactics", "globalFromB"], value: "newer" },
	]);
});


function finalMessage(text: string) {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}

test("length and provider-error endings never become accepted responses", async () => {
	for (const stopReason of ["length", "error"]) {
		const h = harness();
		await start(h, `Stop reason ${stopReason}`);
		const message = { ...finalMessage("Incomplete output."), stopReason };
		assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
		assert.equal(h.readState().response, "");
		assert.equal(h.sentMessages.length, 0);
	}
});

async function holdResponseStorage(t: TestContext, root: string) {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(root, async () => { enter(); await gate; });
	t.after(async () => { release(); await holder; });
	await entered;
	return async () => { release(); await holder; };
}

test("inference preparation captures without writing, then accepts current maintenance and lifecycle once", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, { private: "LOCAL" }, "Previous answer");
	const reappeared = join(h.repositoryRoot, "reappeared.txt");
	const missing = join(h.repositoryRoot, "new-shared-missing.txt");
	writeFileSync(reappeared, "source");
	await h.tools.get("patch_state")!.execute("register", { cwd: { artifacts: { [reappeared]: { description: "Keep if it returns" } } } }, undefined, undefined, h.ctx);
	rmSync(reappeared);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const previous = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	assert.match(h.beforeAgentStart("NEXT-SPEC").systemPrompt, /State Flow is enabled/);
	assert.deepEqual(h.entries, entries, "the signal-less native hook only captures the prompt and protocol");
	h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before, "idle projection cannot publish");
	let ended = false;
	const controller = new AbortController();
	const waiting = h.inferenceContext([user("NEXT-SPEC", 5)], controller).then((result) => { ended = true; return result; });
	const sameRun = h.inferenceContext([], controller);
	await delay(40);
	assert.equal(ended, false);
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(ended, false, "already-active Start leaves the pending preparation intact");
	assert.deepEqual(h.readState(), cached);
	assert.deepEqual(h.entries, entries);
	// Complete a foreign cohort while holding exclusion. Neither its new registry nor source reappearance was in the old cache.
	writeGlobalState({ ...emptyState(), tactics: { globalPeer: "G" }, artifacts: { [missing]: { description: "Missing global source" } } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), tactics: { cwdPeer: "C" }, artifacts: {
		[missing]: { description: "Missing CWD source" }, [reappeared]: { description: "Newest retained registration" },
	} }, h.repositoryRoot);
	writeFileSync(reappeared, "returned while waiting");
	await release();
	const result = await waiting;
	await sameRun;
	assert.match(JSON.stringify(result), /NEXT-SPEC/);
	const preparedHead = JSON.parse(result.messages[0].content[0].text.split("\n")[1]);
	assert.equal(preparedHead.specification, "NEXT-SPEC", "idle inspection cannot freeze a head before preparation accepts");
	assert.deepEqual(preparedHead.state.tactics, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.deepEqual(h.readState().tactics, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.equal(h.readState().response, "Previous answer");
	for (const scope of ["global", "cwd"] as const) assert.equal(h.readState(0, scope).artifacts[missing], undefined);
	assert.equal(h.readState(0, "cwd").artifacts[reappeared]?.description, "Newest retained registration");
	assert.equal(h.resolveSnapshot().meta.specification, "NEXT-SPEC");
	assert.equal(h.resolveSnapshot().meta.step, previous.meta.step + 1, "maintenance, not preparation, advances the step");
	assert.equal(h.entries.length, entries.length + 1, "one acceptance replaces the former lifecycle plus maintenance writes");
	const accepted = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await h.inferenceContext();
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), accepted);
	assert.equal(h.entries.length, entries.length + 1);
});

for (const boundary of ["abort", "stop", "session_start", "session_tree", "session_shutdown"] as const) test(`inference preparation withdraws at ${boundary} without changing accepted memory or newer policy`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h);
	await commitTerminal(h, {}, { retained: true }, "Previous answer");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("Unaccepted request");
	const controller = new AbortController();
	const pending = h.inferenceContext([user("Unaccepted request", 2)], controller);
	let selection: Promise<unknown> | undefined;
	await delay(40);
	if (boundary === "abort") controller.abort();
	else if (boundary === "stop") {
		const cancellation = new AbortController();
		const stopping = h.commands.get("state-flow-passive")!.handler("", { ...h.ctx, signal: cancellation.signal });
		cancellation.abort();
		await stopping;
	}
	else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "another-session";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await Promise.race([pending, delay(1_000).then(() => assert.fail("obsolete preparation still waits"))]);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	const after = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	if (boundary === "session_tree") assertNativeModeOnlyChange(after, before, sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot).config, "passive");
	else assert.deepEqual(after, before);
	if (boundary === "session_tree") assertTreePolicyCheckpoint(h.entries, entries);
	else assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses);
	if (boundary === "stop") {
		assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
		assert.ok(h.entries.at(-1)!.data.persistenceError);
		await assert.rejects(h.tools.get("patch_state")!.execute("late", { session: { tactics: { late: true } } }, undefined, undefined, h.ctx), /Memory writes paused after mode change/);
	}
});

for (const anchored of [true, false]) test(`idle Stop retains an aborted unaccepted run (${anchored ? "native anchor" : "conservative context"})`, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await commitTerminal(h, {}, {}, "Previous answer");
	const previous = user("COMPLETED-REQUEST", Date.now() - 100);
	const current = user("UNPREPARED-REQUEST", Date.now() - 10);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("UNPREPARED-REQUEST");
	if (anchored) h.handlers.get("message_end")!({ message: current }, h.ctx);
	const controller = new AbortController();
	const pending = h.inferenceContext([previous, current], controller);
	controller.abort();
	await pending;
	await release();
	assert.equal(h.resolveSnapshot().meta.specification, undefined, "the canceled run was never accepted");
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const projected = await h.inferenceContext([previous, current]);
	assert.match(JSON.stringify(projected), /UNPREPARED-REQUEST/);
	assert.equal(JSON.stringify(projected).includes("COMPLETED-REQUEST"), !anchored);
});

test("superseded preparation cannot consume a newer run waiting on the same owner", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	h.beforeAgentStart("Obsolete request");
	const old = h.inferenceContext();
	h.beforeAgentStart("Current request");
	let ended = false;
	const current = h.inferenceContext().then((result) => { ended = true; return result; });
	assert.equal(await old, undefined, "an old context request cannot project or prepare a newer run");
	assert.equal(ended, false);
	await release();
	assert.match(JSON.stringify(await current), /Current request/);
	assert.equal(h.resolveSnapshot().meta.specification, "Current request");
	assert.equal(h.notifications.some((notice) => /preparation failed/.test(notice)), false);
});

test("failed preparation rolls back maintenance and lifecycle together, aborts inference and retains a retryable input", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Previous unfinished request");
	const snapshot = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	const missing = join(h.repositoryRoot, "foreign-missing.txt");
	writeGlobalState({ ...emptyState(), tactics: { foreign: true }, artifacts: { [missing]: { description: "Missing source" } } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (to === path) throw new Error("injected preparation publication failure");
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	const controller = new AbortController();
	h.beforeAgentStart("Keep this input pending");
	try { assert.equal(await h.inferenceContext([], controller), undefined); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(controller.signal.aborted, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached);
	assert.deepEqual(h.resolveSnapshot(), snapshot);
	assert.deepEqual(h.entries, entries);
	assert.match(h.notifications.at(-1)!, /inference preparation failed:.*injected preparation publication failure/);
	assert.equal(h.sentMessages.length, 0);
	await h.inferenceContext();
	assert.equal(h.resolveSnapshot().meta.specification, "Keep this input pending");
	assert.equal(h.readState().tactics.foreign, true);
	assert.equal(h.readState().artifacts[missing], undefined);
	assert.equal(h.entries.length, entries.length + 1);
});

test("post-acceptance preparation failure never replays an old specification over a completed run", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	h.beforeAgentStart("Accepted before UI failed");
	const notify = t.mock.method(h.ctx.ui, "setStatus", () => { throw new Error("injected preparation UI failure"); });
	const controller = new AbortController();
	await h.inferenceContext([], controller);
	notify.mock.restore();
	assert.equal(controller.signal.aborted, true);
	assert.equal(h.resolveSnapshot().meta.specification, "Accepted before UI failed");
	assert.match(h.notifications.at(-1)!, /preparation saved; lifecycle update failed:.*injected preparation UI failure/);
	await commitTerminal(h, {}, {}, "Accepted later answer");
	const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	assert.doesNotMatch(JSON.stringify(await h.inferenceContext()), /Accepted before UI failed/);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), files);
	assert.deepEqual(h.entries, entries);
});

test("response reconciliation waits for current shared memory and accepts lifecycle once without another publication", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Finish this run");
	await h.tools.get("patch_state")!.execute("private", { session: { tactics: { owner: "local" } } }, undefined, undefined, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const message = finalMessage("Accepted answer");
	h.handlers.get("message_end")!({ message }, h.ctx);
	let ended = false;
	const pending = h.handlers.get("turn_end")!({ message }, h.ctx).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
	assert.equal(h.readState().response, "");
	assert.equal(h.entries.at(-1)!.data.specification, "Finish this run");
	// Fixture writes model the foreign owner's completed cohort before releasing exclusion.
	writeGlobalState({ ...emptyState(), tactics: { foreignGlobal: true } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), tactics: { foreignCwd: true } }, h.repositoryRoot);
	await release();
	await pending;
	assert.equal(h.readState().response, "Accepted answer");
	assert.deepEqual(h.readState().tactics, { foreignGlobal: true, foreignCwd: true, owner: "local" });
	assert.deepEqual(h.readState(0, "session").tactics, { owner: "local" });
	assert.equal(h.readState(1).response, "", "history uses the actual adopted predecessor");
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.resolveSnapshot().meta.bootstrap, undefined);
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(h.entries.length, entries.length + 1);
	assert.equal(h.notifications.some((notice) => /reconciliation failed|lock is unavailable/.test(notice)), false);
	const accepted = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), accepted);
	assert.equal(h.entries.length, entries.length + 1, "a consumed completion does not persist again");
});

test("failed response publication retains the accepted cache, unfinished run and canonical bytes", async (t) => {
	const h = harness({ initializeRepository: false });
	h.entries.push({ type: "message", message: user("Uncompiled conversation", 1) });
	await start(h, "Keep this unfinished until acceptance");
	const snapshot = h.resolveSnapshot();
	const cached = h.readState();
	const entries = structuredClone(h.entries);
	writeGlobalState({ ...emptyState(), tactics: { foreign: true } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === path) { failed = true; throw new Error("injected response publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	const message = finalMessage("Accept only with lifecycle");
	try {
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached, "failed publication cannot install even a valid shared adoption");
	assert.deepEqual(h.resolveSnapshot(), snapshot);
	assert.deepEqual(h.entries, entries);
	assert.match(h.notifications.at(-1)!, /response reconciliation failed:.*injected response publication failure/);
	assert.equal(h.sentMessages.length, 0);
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Accept only with lifecycle");
	assert.equal(h.readState().tactics.foreign, true);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.entries.length, entries.length + 1);
});

for (const boundary of ["stop", "session_start", "session_tree", "session_shutdown"] as const) test(`pending response withdraws at ${boundary} without publishing or restoring obsolete lifecycle`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h, "Abandoned completion");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let selection: Promise<unknown> | undefined;
	const message = finalMessage("Must not overwrite a new selection");
	h.handlers.get("message_end")!({ message }, h.ctx);
	let ended = false;
	const pending = h.handlers.get("turn_end")!({ message }, h.ctx).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	if (boundary === "stop") {
		const cancellation = new AbortController();
		const stopping = h.commands.get("state-flow-passive")!.handler("", { ...h.ctx, signal: cancellation.signal });
		assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/, "Stop policy takes effect before canonical waiting");
		cancellation.abort();
		await stopping;
		assert.ok(h.entries.at(-1)!.data.persistenceError, "canceled Stop persistence fences writes without re-enabling mode");
	} else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "different-physical-session";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await Promise.race([pending, delay(1_000).then(() => assert.fail("obsolete response still waits for the owner"))]);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	if (boundary === "session_shutdown") {
		h.handlers.get("message_end")!({ message }, h.ctx);
		await h.handlers.get("turn_end")!({ message }, h.ctx);
	}
	const after = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	if (boundary === "session_tree") assertNativeModeOnlyChange(after, before, sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot).config, "passive");
	else assert.deepEqual(after, before);
	if (boundary === "session_tree") assertTreePolicyCheckpoint(h.entries, entries);
	else assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses, "obsolete completion cannot update the selected UI");
	if (boundary === "stop") {
		assert.equal(h.readState().response, "");
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { stale: true } } }, undefined, undefined, h.ctx), /Memory writes paused after mode change/);
	}
});

test("superseded response cannot clear a newer completion that is waiting on the same owner", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Current run");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const previous = finalMessage("Obsolete answer");
	h.handlers.get("message_end")!({ message: previous }, h.ctx);
	const obsolete = h.handlers.get("turn_end")!({ message: previous }, h.ctx);
	const current = finalMessage("Newest accepted answer");
	h.handlers.get("message_end")!({ message: current }, h.ctx);
	const pending = h.handlers.get("turn_end")!({ message: current }, h.ctx);
	await Promise.race([obsolete, delay(1_000).then(() => assert.fail("superseded response did not cancel"))]);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	await release();
	await pending;
	assert.equal(h.readState().response, "Newest accepted answer");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.notifications.some((notice) => /reconciliation failed/.test(notice)), false);
});

test("an empty accepted answer finalizes the run and stores an empty response", async () => {
	const h = harness();
	await start(h, "First run");
	const first = finalMessage("Previous answer");
	h.handlers.get("message_end")!({ message: first }, h.ctx);
	await h.handlers.get("turn_end")!({ message: first }, h.ctx);
	await h.beginRun("Update state without prose");
	await h.tools.get("patch_state")!.execute("update", {
		session: { tactics: { updated: true } },
	}, undefined, undefined, h.ctx);
	const empty = { ...finalMessage(""), content: [] };
	h.handlers.get("message_end")!({ message: empty }, h.ctx);
	await h.handlers.get("turn_end")!({ message: empty }, h.ctx);
	assert.equal(h.readState().tactics.updated, true);
	assert.equal(h.readState().response, "");
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.notifications.some((notice) => /could not reconcile the final response/i.test(notice)), false);
});

test("accepts canonical atomic scope patches, correct repeats and missing nested deletions without another checkpoint", async () => {
	const h = harness();
	await start(h, "Resolve me");
	const execute = (input: unknown) => h.tools.get("patch_state")!.execute("invalid", input, undefined, undefined, h.ctx);
	for (const input of [null, [], {}, { final: false }, { unchanged: true },
		{ scope: "session", patch: { tactics: { value: true } } }, { session: {} },
		{ session: { tactics: { value: true } }, extra: "forbidden" }, { global: null }]) await assert.rejects(execute(input));
	await execute({ session: { tactics: { value: true } } });
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const checkpointCount = h.entries.length;
	const result = await execute({ session: { tactics: { value: true, alreadyAbsent: null } } });
	assert.equal(result.details.changed, false);
	assert.match(result.content[0].text, /^\nState already current\.\n\nHint: deletion skipped at \/session\/tactics\/alreadyAbsent/);
	assert.deepEqual(result.details.missingDeletions, [{ path: "/session/tactics/alreadyAbsent", unavailablePath: "/session/tactics/alreadyAbsent" }]);
	assert.equal(result.content.length, 1, "diagnostics stay in the acknowledgement, without a semantic echo");
	const nested = await execute({
		global: { lazy: { missing: { child: null } } },
		cwd: { tactics: { missing: { nested: { leaf: null } } } },
		session: { tactics: { missing: { child: null } } },
	});
	assert.equal(nested.details.changed, false);
	assert.match(nested.content[0].text, /^\nState already current\./);
	assert.deepEqual(nested.details.missingDeletions, [
		{ path: "/global/lazy/missing/child", unavailablePath: "/global/lazy" },
		{ path: "/cwd/tactics/missing/nested/leaf", unavailablePath: "/cwd/tactics" },
		{ path: "/session/tactics/missing/child", unavailablePath: "/session/tactics/missing" },
	]);
	for (const hint of nested.details.missingDeletions) assert.ok(nested.content[0].text.includes(`First unavailable component: ${hint.unavailablePath}.`));
	assert.equal(h.entries.length, checkpointCount);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	const repeated = await execute({ session: { tactics: { value: true } } });
	assert.equal(repeated.content[0].text, "\nState already current.", "ordinary repeats stay quiet");
	assert.deepEqual(repeated.details.missingDeletions, []);
	const mixed = await execute({ cwd: { tactics: { kept: true, absent: null } }, session: { tactics: { value: null } } });
	assert.equal(mixed.details.changed, true);
	assert.match(mixed.content[0].text, /State materialized atomically/);
	assert.match(mixed.content[0].text, /Hint: deletion skipped at \/cwd\/tactics\/absent/);
	assert.deepEqual(mixed.details.missingDeletions, [{ path: "/cwd/tactics/absent", unavailablePath: "/cwd/tactics" }]);
	assert.equal(h.readState().tactics.kept, true);
	assert.equal(Object.hasOwn(h.readState().tactics, "value"), false);
	const message = finalMessage("Resolved directly.");
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Resolved directly.");
});

test("artifact freshness is rechecked after waiting, before accepting any part of a mixed patch", async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Compile source");
	const source = join(h.repositoryRoot, "registered.txt");
	writeFileSync(source, "Before");
	const execute = (patch: unknown) => h.tools.get("patch_state")!.execute("compile", patch, undefined, undefined, h.ctx);
	await execute({ cwd: { artifacts: { [source]: { description: "Registered" } } } });
	h.handlers.get("context")!({ messages: [] }, h.ctx);
	h.handlers.get("tool_execution_start")!({ toolCallId: "read-source", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "read-source", toolName: "read", isError: false }, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const holder = withStorageTransaction(h.repositoryRoot, async () => { enter(); await gate; });
	await entered;
	let loggedInput: unknown;
	const record = StateFlowDiagnosticWriter.prototype.record;
	t.mock.method(StateFlowDiagnosticWriter.prototype, "record", function (this: StateFlowDiagnosticWriter, ...args: Parameters<typeof record>) {
		loggedInput = args[4]?.input;
		return record.apply(this, args);
	});
	const input = { global: { tactics: { rejected: true } }, cwd: { artifacts: { [source]: { description: "Stale compilation" } } } };
	const authored = structuredClone(input);
	const pending = execute(input);
	const rejected = assert.rejects(pending, /Artifact source changed after acquisition/);
	await delay(40);
	input.cwd.artifacts[source]!.description = "Caller mutation while waiting";
	writeFileSync(source, "Changed while the patch waited");
	release();
	await Promise.all([holder, rejected]);
	assert.deepEqual(loggedInput, authored, "diagnostics retain the same detached intent used for publication");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.equal(h.readState(0, "global").tactics.rejected, undefined);
	assert.deepEqual(h.readState(0, "cwd").artifacts[source], { description: "Registered" });
});

test("a rejected first passive patch leaves no empty canonical initialization or native checkpoint", async () => {
	const h = harness({ mode: "passive", initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const entries = structuredClone(h.entries);
	const execute = (patch: unknown) => h.tools.get("patch_state")!.execute("first", patch, undefined, undefined, h.ctx);
	await assert.rejects(execute({ global: { tactics: { rejected: true } }, session: { artifacts: { invalid: { kind: "document" } } } }), /non-empty description/);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries);
	assert.throws(() => h.readState(0, "global"), /runtime is unavailable/, "a failed patch cannot install an unpublished empty view");
	await execute({ global: { tactics: { accepted: true } }, session: { tactics: { private: true } } });
	assert.equal(h.readState(0, "global").tactics.accepted, true);
	assert.equal(h.readState(0, "session").tactics.private, true);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.entries.length, entries.length + 1, "one accepted patch has one checkpoint, not a separately accepted empty origin");
});

for (const initialMode of ["passive"] as const) for (const mode of ["passive"] as const) test(`${initialMode} → ${mode} applies immediately and coalesces into one metadata-only acceptance`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Unfinished Stop request");
	await h.tools.get("patch_state")!.execute("private", { session: { tactics: { private: "LOCAL" } } }, undefined, undefined, h.ctx);
	const previous = h.resolveSnapshot();
	const entries = structuredClone(h.entries);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const lifecycle = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive");
	let ended = false;
	const stopping = h.commands.get(`state-flow-${initialMode}`)!.handler("", h.ctx).then(() => { ended = true; });
	assert.equal(h.activeTools.includes("patch_state"), initialMode === "passive");
	const repeat = h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>passive</dim>");
	assert.equal(h.activeTools.includes("patch_state"), mode === "passive");
	const raw = [user("Unfinished Stop request", 1), toolAssistant("late-tool")];
	const projected = h.handlers.get("context")!({ messages: raw }, h.ctx);
	assert.match(JSON.stringify(projected), /exit handoff/);
	assert.match(JSON.stringify(projected), /Unfinished Stop request/);
	assert.match(JSON.stringify(projected), /late-tool/);
	await delay(40);
	assert.equal(ended, false, "the event loop remains responsive while Stop awaits exclusion");
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries, "no checkpoint claims unaccepted persistence");
	writeGlobalState({ ...emptyState(), tactics: { globalPeer: "G" } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), tactics: { cwdPeer: "C" } }, h.repositoryRoot);
	const foreign = files();
	await release();
	await Promise.all([stopping, repeat]);
	assert.equal(publication.mock.calls.length, 1, JSON.stringify(h.notifications));
	assert.deepEqual(files(), foreign, "mode-only persistence refuses drift without adopting or publishing it");
	assert.deepEqual(h.readState().tactics, { private: "LOCAL" });
	assert.deepEqual(h.readState(0, "session").tactics, { private: "LOCAL" });
	const retainedRun = JSON.parse(readFileSync(lifecycle.runtime, "utf8"));
	assert.equal(retainedRun.step, previous.meta.step);
	assert.equal(retainedRun.specification, previous.meta.specification);
	assert.equal(h.entries.at(-1)!.data.mode, mode, "the latest inactive choice wins");
	assert.deepEqual(JSON.parse(readFileSync(lifecycle.config, "utf8")), { mode: "active", scopes: ["global", "cwd", "session"] });
	assert.equal(h.entries.length, entries.length + 1, "one native fence and no accepted semantic boundary");
	assert.match(h.entries.at(-1)!.data.persistenceError, /Conflicting State Flow temporal lineage/);
	const acceptedContext = h.handlers.get("context")!({ messages: raw }, h.ctx);
	assert.doesNotMatch(JSON.stringify(acceptedContext), /globalPeer|cwdPeer/);
	assert.match(h.notifications.at(-1)!, /memory writes paused/);
	await assert.rejects(h.tools.get("patch_state")!.execute("fenced-drift", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), /Memory writes paused after mode change/);
});

test("Stop derives lifecycle after waiting instead of overwriting a newer same-instance passive patch", async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h, "Retain latest lifecycle");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const original = TemporalRuntime.prototype.persistSelectedPassive;
	t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive", function (this: TemporalRuntime, ...args: Parameters<typeof original>) {
		return gate.then(() => original.apply(this, args));
	});
	const stopping = h.commands.get("state-flow-passive")!.handler("", h.ctx);
	await h.tools.get("patch_state")!.execute("passive", { session: { tactics: { acceptedWhileStopped: true } } }, undefined, undefined, h.ctx);
	const accepted = h.resolveSnapshot();
	release();
	await stopping;
	assert.equal(h.resolveSnapshot().meta.step, accepted.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, accepted.meta.specification);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.readState().tactics.acceptedWhileStopped, true);
});

for (const boundary of ["abort", "session_start", "session_tree", "session_shutdown", "start"] as const) test(`pending Stop withdraws at ${boundary} without overwriting newer policy or private authority`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h, "Stop this owner only");
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const cancellation = new AbortController();
	const stopping = h.commands.get("state-flow-passive")!.handler("", { ...h.ctx, signal: cancellation.signal });
	let selection: Promise<unknown> | undefined;
	await delay(40);
	assert.deepEqual(files(), before);
	if (boundary === "abort") cancellation.abort(new Error("Stop operation cancelled"));
	else if (boundary === "start") {
		await release();
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal(h.resolveSnapshot().config.mode, "active");
	} else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "new-physical-owner";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	await Promise.race([stopping, delay(500).then(() => assert.fail("obsolete Stop still waits"))]);
	if (boundary !== "start") assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	const retained = files();
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	await release();
	await selection;
	const statuses = [...h.statuses];
	await delay(40);
	if (boundary === "session_tree") assertNativeModeOnlyChange(files(), retained, sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot).config, "passive");
	else assert.deepEqual(files(), retained);
	if (boundary === "session_tree") assertTreePolicyCheckpoint(h.entries, entries);
	else assert.deepEqual(h.entries, entries);
	assert.deepEqual(h.notifications, notices);
	assert.deepEqual(h.statuses, statuses);
	if (boundary === "session_tree") assertNativeModeOnlyChange(files(), before, sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot).config, "passive");
	else if (boundary !== "start") assert.deepEqual(files(), before);
	if (boundary === "abort") {
		assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
		assert.match(h.entries.at(-1)!.data.persistenceError, /Stop operation cancelled/);
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { forbidden: true } } }, undefined, undefined, h.ctx), /Memory writes paused after mode change/);
	}
});

test("failed Start leaves an already pending Stop able to accept", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h);
	await h.tools.get("patch_state")!.execute("retained-before-start", { session: { tactics: { retained: true } } }, undefined, undefined, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const stopping = h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const activation = t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction", async () => { throw new Error("injected Start rejection"); });
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /activation failed: injected Start rejection/);
	assert.equal(activation.mock.calls.length, 1);
	assert.match(h.statuses.at(-1)!, /passive/);
	assert.equal(h.readState(0, "session").tactics.retained, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	await release();
	await stopping;
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.entries.some((entry) => entry.data?.persistenceError !== undefined), false, JSON.stringify(h.entries));
});

test("Start waits and coalesces repeats before adopting current memory and enabling tools", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Old unfinished request");
	await h.tools.get("patch_state")!.execute("seed", { session: { tactics: { private: "LOCAL" } } }, undefined, undefined, h.ctx);
	h.readState();
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const previous = h.resolveSnapshot();
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const entries = structuredClone(h.entries);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction");
	let ended = false;
	const starting = h.commands.get("state-flow-active")!.handler("", h.ctx).then(() => { ended = true; });
	const repeat = h.commands.get("state-flow-active")!.handler("", h.ctx);
	await delay(40);
	assert.equal(ended, false);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.throws(() => h.readState(), /unavailable|pending/);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries, entries);
	writeGlobalState({ ...emptyState(), tactics: { globalPeer: "G" } }, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, { ...emptyState(), tactics: { cwdPeer: "C" } }, h.repositoryRoot);
	const semantic = files().filter(({ path }) => !/\/(config|runtime)\.json$/.test(path));
	await release();
	await Promise.all([starting, repeat]);
	assert.equal(publication.mock.calls.length, 1);
	assert.deepEqual(files().filter(({ path }) => !/\/(config|runtime)\.json$/.test(path)), semantic);
	assert.deepEqual(h.readState().tactics, { globalPeer: "G", cwdPeer: "C", private: "LOCAL" });
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.step, previous.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.entries.length, entries.length + 1, "activation checkpoints once without a second persistence transaction");
	assert.equal(h.activeTools.includes("patch_state"), true);
});

test("Start derives current private lifecycle and bootstrap after waiting instead of restoring a stale snapshot", async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const original = TemporalRuntime.prototype.withSelectedCurrentTransaction;
	t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction", function (this: TemporalRuntime, ...args: Parameters<typeof original>) {
		return gate.then(() => original.apply(this, args));
	});
	const starting = h.commands.get("state-flow-active")!.handler("", h.ctx);
	await h.tools.get("patch_state")!.execute("passive", { session: { tactics: { acceptedWhileWaiting: true } } }, undefined, undefined, h.ctx);
	const accepted = h.resolveSnapshot();
	h.entries.push({ type: "message", message: user("Conversation arriving during activation", 100) });
	release();
	await starting;
	assert.equal(h.resolveSnapshot().meta.step, accepted.meta.step);
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.readState().tactics.acceptedWhileWaiting, true);
});

for (const boundary of ["abort", "stop", "session_start", "session_tree", "session_shutdown"] as const) test(`pending Start withdraws at ${boundary} without reviving mode or rewriting private authority`, { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false });
	await start(h, "Keep unfinished native context");
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const cancellation = new AbortController();
	const starting = h.commands.get("state-flow-active")!.handler("", { ...h.ctx, signal: cancellation.signal });
	let stopping: Promise<void> | undefined;
	let selection: Promise<unknown> | undefined;
	await delay(40);
	if (boundary === "abort") cancellation.abort(new Error("Start operation cancelled"));
	else if (boundary === "stop") stopping = h.commands.get("state-flow-off")!.handler("", h.ctx);
	else {
		if (boundary !== "session_shutdown") {
			h.ctx.sessionManager.getBranch = () => [];
			if (boundary === "session_start") h.ctx.sessionManager.getSessionId = () => "new-physical-owner";
		}
		selection = Promise.resolve(h.handlers.get(boundary)!({ reason: "new" }, h.ctx));
	}
	await Promise.race([starting, delay(500).then(() => assert.fail("obsolete Start still waits"))]);
	assert.deepEqual(files(), before);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	const notices = [...h.notifications];
	const entries = structuredClone(h.entries);
	await release();
	await stopping;
	await selection;
	await delay(40);
	assert.deepEqual(files(), before);
	assert.deepEqual(h.notifications, notices);
	if (boundary !== "stop") assert.deepEqual(h.entries, entries);
	if (boundary === "abort") assert.doesNotMatch(h.notifications.at(-1)!, /activation failed:.*Start operation cancelled/);
});

test("Start rechecks the physical owner after waiting even without a selection event", async (t) => {
	const h = harness({ initializeRepository: false });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const starting = h.commands.get("state-flow-active")!.handler("", h.ctx);
	h.ctx.sessionManager.getSessionId = () => "different-owner";
	await release();
	await starting;
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker("harness-session", "off")]);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.notifications.length, 0);
});

test("post-acceptance Start checkpoint failure retains enabled policy and cleared fences without replaying native writes", async () => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h, "Old specification must not return");
	const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
	mkdirSync(lock);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	rmSync(lock, { recursive: true });
	let appends = 0;
	Object.defineProperty(h.entries, "push", { configurable: true, value: () => { appends += 1; throw new Error("injected Start checkpoint failure"); } });
	try { await h.commands.get("state-flow-active")!.handler("", h.ctx); }
	finally { Reflect.deleteProperty(h.entries, "push"); }
	assert.equal(appends, 1);
	const paths = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).mode, "active");
	assert.equal(JSON.parse(readFileSync(paths.runtime, "utf8")).specification, undefined);
	assert.match(h.statuses.at(-1)!, /<dim>active<\/dim>/);
	assert.match(h.notifications.at(-1)!, /active; lifecycle update failed: injected Start checkpoint failure/);
	await h.tools.get("patch_state")!.execute("accepted", { session: { tactics: { retainedEnabled: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.specification, undefined);
	assert.equal(h.readState().tactics.retainedEnabled, true);
});

test("failed Stop publication rolls back lifecycle files without installing shared adoption", async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h);
	const cached = h.readState();
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config;
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === path) { failed = true; throw new Error("injected Stop publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	try { await h.commands.get("state-flow-passive")!.handler("", h.ctx); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.readState(), cached);
	assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
	assert.match(h.notifications.at(-1)!, /passive; memory writes paused:.*injected Stop publication failure/);
});

test("post-acceptance Stop checkpoint failure neither rolls back accepted mode nor repeats native writes", async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h);
	let appends = 0;
	Object.defineProperty(h.entries, "push", { configurable: true, value: () => { appends += 1; throw new Error("injected Stop checkpoint failure"); } });
	t.after(() => { Reflect.deleteProperty(h.entries, "push"); });
	try { await h.commands.get("state-flow-passive")!.handler("", h.ctx); }
	finally { Reflect.deleteProperty(h.entries, "push"); }
	assert.equal(appends, 1);
	const path = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config;
	assert.equal(JSON.parse(readFileSync(path, "utf8")).mode, "passive");
	assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
	assert.match(h.notifications.at(-1)!, /passive; lifecycle update failed:.*injected Stop checkpoint failure/);
	await h.tools.get("patch_state")!.execute("continue", { session: { tactics: { afterAcceptedStop: true } } }, undefined, undefined, h.ctx);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.readState().tactics.afterAcceptedStop, true);
});

test("Passive persistence failures retain context and memory and fence writes through reload without touching canonical bytes", async () => {
	for (const fault of ["concurrent", "locked", "malformed"] as const) {
		for (const mode of ["passive"] as const) {
			const passiveBootstrap = mode === "passive", passiveTools = mode === "passive";
			const options = { initializeRepository: false, mode };
			const h = harness(options);
			await start(h, "Uncompiled request");
			await h.tools.get("patch_state")!.execute("accepted", { session: { tactics: { private: "retained" } } }, undefined, undefined, h.ctx);
			const paths = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			const originalRuntime = readFileSync(paths.runtime);
			const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
			const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			if (fault === "concurrent") {
				const peer = harness({ ...options, repositoryRoot: h.repositoryRoot });
				peer.entries.push(...structuredClone(h.entries));
				await peer.handlers.get("session_start")!({ reason: "resume" }, peer.ctx);
				await peer.tools.get("patch_state")!.execute("peer", { session: { tactics: { peer: "accepted" } } }, undefined, undefined, peer.ctx);
			} else if (fault === "malformed") writeFileSync(paths.runtime, "malformed runtime");
			const canonical = files();
			if (fault === "locked") mkdirSync(lock);
			const checkpointCount = h.entries.length;
			await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
			assert.equal(h.statuses.at(-1), passiveBootstrap || passiveTools ? "<accent>state-flow</accent> <dim>passive</dim>" : undefined);
			assert.equal(h.activeTools.includes("patch_state"), passiveTools);
			assert.match(h.notifications.at(-1)!, /(?:off|passive); memory writes paused/);
			assert.equal(h.readState(0, "session").tactics.private, "retained", "a failed write never erases the accepted cache");
			assert.equal(h.entries.length, checkpointCount + 1);
			const marker = h.entries.at(-1)!;
			assert.equal(marker.customType, "state-flow-passive-stop");
			assert.equal(marker.data.owner, h.ctx.sessionManager.getSessionId());
			assert.equal(marker.data.preserveContext, true);
			assert.ok(marker.data.persistenceError);
			const messages = [user("Available older context", 1), user("Uncompiled request", 10), toolAssistant("late-read")];
			const immediateContext = h.handlers.get("context")!({ messages }, h.ctx);
			assert.deepEqual(immediateContext.messages.slice(1), messages);
			assert.doesNotMatch(h.beforeAgentStart("Ordinary continuation").systemPrompt, /State Flow is enabled/);
			await assert.rejects(h.tools.get("patch_state")!.execute("refused", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), /paused after mode change|tools are off/);
			if (fault !== "concurrent") {
				await h.commands.get("state-flow-active")!.handler("", h.ctx);
				assert.match(h.notifications.at(-1)!, /activation failed/);
			}
			if (fault !== "concurrent") {
				// Retrying acceptance cannot clear a fence while its cause remains, and adds no duplicate marker.
				await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
				assert.match(h.notifications.at(-1)!, /passive; memory writes remain paused/);
				assert.equal(h.entries.length, checkpointCount + 1, "repeated degraded selection appends no duplicate fence");
			}
			if (fault === "locked") rmSync(lock, { recursive: true });
			assert.deepEqual(files(), canonical);
			const resumed = harness({ ...options, repositoryRoot: h.repositoryRoot });
			resumed.entries.push(...structuredClone(h.entries));
			await resumed.handlers.get("session_start")!({ reason: "reload" }, resumed.ctx);
			if (passiveBootstrap || passiveTools) assert.match(resumed.statuses.at(-1)!, /<dim>passive<\/dim>/);
			else assert.equal(resumed.statuses.at(-1), undefined);
			assert.equal(resumed.notifications.length, 0, "reload retains the diagnostic without repeating its warning");
			assert.deepEqual(files(), canonical, "reload must not restore/publish the older selected boundary over another writer");
			assert.equal(resumed.entries.length, h.entries.length);
			const restoredContext = resumed.handlers.get("context")!({ messages }, resumed.ctx);
			const projected = restoredContext?.messages ?? messages;
			assert.match(JSON.stringify(projected), /Uncompiled request/);
			assert.match(JSON.stringify(projected), /late-read/);
			if (fault !== "malformed") {
				assert.equal(resumed.readState(0, "session").tactics.private, "retained");
				if (fault === "concurrent") assert.equal(resumed.readState(0, "session").tactics.peer, "accepted");
			} else assert.throws(() => resumed.readState(0, "session"), /selected branch is unavailable/);
			await assert.rejects(resumed.tools.get("patch_state")!.execute("fenced", { session: { tactics: { unsafe: true } } }, undefined, undefined, resumed.ctx), /paused after mode change|selected branch is unavailable|tools are off/);
			assert.deepEqual(files(), canonical);
			if (fault === "malformed") writeFileSync(paths.runtime, originalRuntime);
			await resumed.commands.get("state-flow-active")!.handler("", resumed.ctx);
			assert.equal(resumed.resolveSnapshot().config.mode, "active");
			await resumed.tools.get("patch_state")!.execute("accepted-again", { session: { tactics: { afterStart: true } } }, undefined, undefined, resumed.ctx);
			assert.equal(resumed.readState(0, "session").tactics.afterStart, true);
			assert.equal(resumed.readState(0, "session").tactics.private, "retained");
		}
	}
});

for (const fault of ["locked", "concurrent"] as const) test(`explicit Passive resumes writes after its persistence fault clears (fault=${fault})`, async () => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	await start(h, "Uncompiled request");
	await h.tools.get("patch_state")!.execute("accepted", { session: { tactics: { private: "retained" } } }, undefined, undefined, h.ctx);
	const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
	if (fault === "concurrent") {
		const peer = harness({ initializeRepository: false, mode: "passive", repositoryRoot: h.repositoryRoot });
		peer.entries.push(...structuredClone(h.entries));
		await peer.handlers.get("session_start")!({ reason: "resume" }, peer.ctx);
		await peer.tools.get("patch_state")!.execute("peer", { session: { tactics: { peer: "accepted" } } }, undefined, undefined, peer.ctx);
	} else mkdirSync(lock);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /passive; memory writes paused/);
	await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), /paused after mode change/);
	if (fault === "locked") rmSync(lock, { recursive: true });
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.equal(h.notifications.at(-1), "State Flow passive; memory writes resumed from current session memory.");
	assert.equal(h.resolveSnapshot().config.mode, "passive");
	await h.tools.get("patch_state")!.execute("resumed", { session: { tactics: { resumed: true } } }, undefined, undefined, h.ctx);
	assert.deepEqual(h.readState(0, "session").tactics, { private: "retained", ...(fault === "concurrent" ? { peer: "accepted" } : {}), resumed: true });
	const resumed = harness({ initializeRepository: false, mode: "passive", repositoryRoot: h.repositoryRoot });
	resumed.entries.push(...structuredClone(h.entries));
	await resumed.handlers.get("session_start")!({ reason: "reload" }, resumed.ctx);
	await resumed.tools.get("patch_state")!.execute("after-reload", { session: { tactics: { reloaded: true } } }, undefined, undefined, resumed.ctx);
	assert.equal(resumed.readState(0, "session").tactics.reloaded, true, "an accepted Passive checkpoint supersedes the old native fence");
});

test("stop removes State Flow semantics while retaining a bounded passive continuation", async () => {
	const h = harness();
	await start(h, "Establish bounded state");
	await commitTerminal(h, {}, { continuation: "keep this" }, "Context compiled.");
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);

	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.activeTools.includes("read_state"), true);
	assert.match(h.beforeAgentStart("Continue").systemPrompt, /State Flow passive memory is available/);

	const projected = h.handlers.get("context")!({ messages: [
		user("Ancient raw history that must stay hidden", 1),
		{ role: "assistant", content: [{ type: "text", text: "Ancient response" }], timestamp: 2 },
		user("Continue with X", Date.now() + 1_000),
	] });
	assert.equal(projected.messages.length, 2);
	assert.match(projected.messages[0].content[0].text, /State Flow exit handoff/);
	assert.match(projected.messages[0].content[0].text, /keep this/);
	assert.equal(projected.messages[1].content[0].text, "Continue with X");
	assert.doesNotMatch(JSON.stringify(projected.messages), /Ancient raw history/);
});

test("reload, startup, resume, and tree restoration preserve only the same physical session handoff", async () => {
	const h = harness();
	await start(h, "Remember state");
	await commitTerminal(h, {}, { continuation: "reload" }, "Context compiled.");
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	for (const reason of ["reload", "startup", "resume", undefined]) {
		if (reason === undefined) await h.handlers.get("session_tree")!({}, h.ctx);
		else await h.handlers.get("session_start")!({ reason }, h.ctx);
		const projected = h.handlers.get("context")!({ messages: [
			user("Pre-stop history", 1),
			user("Continue", Date.now() + 1_000),
		] }, h.ctx);
		assert.match(projected.messages[0].content[0].text, /exit handoff/);
		assert.match(projected.messages[0].content[0].text, /reload/);
		assert.equal(projected.messages.length, 2);
	}

	for (const reason of ["new", "fork"]) {
		await h.handlers.get("session_start")!({ reason }, h.ctx);
		const messages = [user("Continue", Date.now() + 1_000)];
		const projected = h.handlers.get("context")!({ messages }, h.ctx);
		assert.doesNotMatch(JSON.stringify(projected?.messages ?? messages), /State Flow exit handoff/, "a fresh branch may expose passive memory, but never an older frozen handoff");
	}
});

test("idle Stop after interruption retains the unfinished run through reload, conservatively without an anchor", async () => {
	for (const captured of [false, true]) {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await start(h, "Unfinished request");
		const old = user("Completed older request", 1);
		const current = user("Unfinished request", 10);
		const call = toolAssistant("unfinished-read");
		if (captured) h.handlers.get("message_end")!({ message: current }, h.ctx);
		h.handlers.get("message_end")!({ message: { role: "assistant", content: [], stopReason: "aborted" } }, h.ctx);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		const marker = h.entries.findLast((entry) => entry.customType === "state-flow-passive-stop")!.data;
		assert.equal(marker.from, captured ? 10 : undefined);
		assert.equal(marker.preserveContext, captured ? undefined : true);
		for (const reload of [false, true]) {
			if (reload) await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
			const projected = h.handlers.get("context")!({ messages: [old, current, call] }, h.ctx);
			assert.deepEqual(projected.messages.slice(1), captured ? [current, call] : [old, current, call]);
		}
	}
});

test("idle Stop does not retain the last run anchor and legacy markers keep their cutoff on reload", async () => {
	const h = harness();
	await start(h, "Completed request");
	h.handlers.get("message_end")!({ message: user("Completed request", 1) }, h.ctx);
	await commitTerminal(h, {}, { done: true }, "Completed answer");
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const marker = h.entries.findLast((entry) => entry.customType === "state-flow-passive-stop")!;
	assert.deepEqual(marker.data, { ...nativePolicyMarker("harness-session", "passive"), at: marker.data.at });
	for (const data of [{ at: marker.data.at }, { at: marker.data.at, from: -1 }]) {
		marker.data = data;
		await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
		const projected = h.handlers.get("context")!({ messages: [
			user("Malformed older timestamp", -1),
			user("Completed request", 1),
			user("Later request", marker.data.at + 1),
		] }, h.ctx);
		assert.equal(projected.messages.length, 2, JSON.stringify(data));
		assert.equal(projected.messages[1].content[0].text, "Later request");
	}
});

test("repeated stop retains one passive handoff without adding another marker", async () => {
	const h = harness();
	await start(h, "Remember state");
	await h.tools.get("patch_state")!.execute("state", { session: { tactics: { continuation: "repeat" } } }, undefined, undefined, h.ctx);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const markerCount = h.entries.filter((entry) => entry.customType === "state-flow-passive-stop").length;
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	assert.equal(h.entries.filter((entry) => entry.customType === "state-flow-passive-stop").length, markerCount);
	const projected = h.handlers.get("context")!({ messages: [user("Continue", Date.now() + 1_000)] }, h.ctx);
	assert.match(projected.messages[0].content[0].text, /repeat/);
});

test("start uses the passive boundary for one active bootstrap instead of resurrecting raw history", async () => {
	const h = harness();
	await start(h, "Remember state");
	await commitTerminal(h, {}, { continuation: "restart" }, "Context compiled.");
	const beforeOff = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const oldMessages = Array.from({ length: 200 }, (_, index) => user(`OLD-${index}`, index + 1));
	const afterStop = Date.now() + 1_000;
	const postStopAnswer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Post-stop answer" }], timestamp: afterStop + 1 };
	const postStopMessages = [
		user("Post-stop question", afterStop),
		postStopAnswer,
		user("Restart State Flow", afterStop + 2),
	];
	assert.equal(h.handlers.get("message_end")!({ message: postStopAnswer }, h.ctx), undefined);
	await h.handlers.get("turn_end")!({ message: postStopAnswer }, h.ctx);
	assert.throws(() => h.readState(), /temporal runtime is unavailable/);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), beforeOff);

	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	const protocol = await h.beginRun("Restart State Flow");
	assert.match(protocol.systemPrompt, /State Flow is enabled/);
	const projected = h.handlers.get("context")!({ messages: [...oldMessages, ...postStopMessages] }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.match(projected.messages[0].content[0].text, /State Flow runtime context/);
	assert.match(projected.messages[1].content[0].text, /State Flow exit handoff/);
	assert.match(JSON.stringify(projected.messages), /Post-stop question/);
	assert.match(JSON.stringify(projected.messages), /Post-stop answer/);
	assert.doesNotMatch(JSON.stringify(projected.messages), /OLD-/);

	const final = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Active again." }] };
	h.handlers.get("message_end")!({ message: final }, h.ctx);
	await h.handlers.get("turn_end")!({ message: final }, h.ctx);
	await h.beginRun("Later");
	const later = h.handlers.get("context")!({ messages: [user("Later", afterStop + 3)] }, h.ctx);
	assert.match(later.messages[0].content[0].text, /State Flow runtime context/);
	assert.doesNotMatch(JSON.stringify(later.messages), /exit handoff/);
});

async function restorableBranch(options: Parameters<typeof harness>[0] = {}) {
	const h = harness({ initializeRepository: false, mode: "passive", ...options });
	await start(h);
	await commitTerminal(h, {}, { retained: "PRIVATE" }, "Accepted answer");
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	return { h, files, lock: join(h.repositoryRoot, ".state-flow-publication.lock") };
}

const semanticFiles = (cohort: ReturnType<typeof captureTemporalFileBases>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));

test("Start cancellation withdraws its join without cancelling independently owned restoration", { timeout: 5_000 }, async (t) => {
	const { h, files } = await restorableBranch();
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx)).then(() => { restored = true; });
	const controller = new AbortController();
	const starting = h.commands.get("state-flow-active")!.handler("", { ...h.ctx, signal: controller.signal });
	await delay(40);
	controller.abort();
	await Promise.race([starting, delay(500).then(() => assert.fail("cancelled Start still joins the storage wait"))]);
	assert.equal(restored, false, "cancelling the join must not cancel its independent owner");
	assert.deepEqual(files(), before);
	await release();
	await restoring;
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.deepEqual(semanticFiles(files()), semanticFiles(before));
});

test("Start cannot activate a different physical owner after joining restoration", async (t) => {
	const { h } = await restorableBranch();
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const other = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, cwd: h.ctx.cwd, sessionId: "other-owner" });
	await start(other);
	await other.commands.get("state-flow-off")!.handler("", other.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, "other-owner", h.repositoryRoot);
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const restoring = h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	const starting = h.commands.get("state-flow-active")!.handler("", h.ctx);
	await delay(40);
	h.ctx.sessionManager.getSessionId = () => "other-owner";
	await release();
	await Promise.all([restoring, starting]);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "other-owner", h.repositoryRoot), before);
	assert.equal(h.statuses.at(-1), undefined, "a withdrawn Active request cannot restore policy over Off");
});

test("shutdown drains superseded restoration operations as well as the current selection", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: "passive" });
	const finish: Array<() => void> = [];
	t.mock.method(TemporalRuntime.prototype, "refreshSelectedShared", () => new Promise<boolean>((resolve) => { finish.push(() => resolve(false)); }));
	t.after(() => { for (const release of finish) release(); });
	const first = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(0);
	h.ctx.sessionManager.getSessionId = () => "replacement-owner";
	const second = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(0);
	assert.equal(finish.length, 2);
	let drained = false;
	const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx).then(() => { drained = true; });
	finish[1]!();
	await second;
	await delay(40);
	assert.equal(drained, false, "the superseded operation still belongs to shutdown");
	finish[0]!();
	await Promise.all([first, shutdown]);
	assert.equal(drained, true);
});

test("passive attachment never installs an old CWD after physical identity changes during its wait", async (t) => {
	const { h: owner } = await restorableBranch();
	await owner.tools.get("patch_state")!.execute("project", { cwd: { tactics: { project: "OLD-CWD" } } }, undefined, undefined, owner.ctx);
	const h = harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", mode: "passive" });
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const selecting = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(40);
	h.ctx.cwd = join(h.repositoryRoot, "different-project");
	const statuses = [...h.statuses];
	await release();
	await selecting;
	assert.throws(() => h.readState(0, "cwd"), /unavailable/);
	assert.deepEqual(h.statuses, statuses);
});

for (const kind of ["passive", "current"] as const) test(`late ${kind} recovery cancellation prevents host cache installation`, async (t) => {
	const { h: owner } = await restorableBranch();
	const h = kind === "current" ? owner : harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", mode: "passive" });
	if (kind === "current") h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: {
		at: Date.now(), owner: h.ctx.sessionManager.getSessionId(), persistenceError: "fixture Stop fence", preserveContext: true,
	} });
	const controller = new AbortController();
	const shared = TemporalRuntime.prototype.refreshSelectedShared;
	const current = TemporalRuntime.prototype.refreshSelectedCurrent;
	t.mock.method(TemporalRuntime.prototype, kind === "passive" ? "refreshSelectedShared" : "refreshSelectedCurrent", async function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["refreshSelectedShared"]>) {
		const result = await (kind === "passive" ? shared.call(this, ...args) : current.call(this, ...args));
		controller.abort(new Error("late recovery cancellation"));
		return result;
	});
	const files = captureTemporalFileBases(owner.ctx.cwd, owner.ctx.sessionManager.getSessionId(), owner.repositoryRoot);
	await h.handlers.get("session_start")!({ reason: "resume" }, { ...h.ctx, signal: controller.signal });
	assert.throws(() => h.readState(0, kind === "passive" ? "cwd" : "session"), /unavailable/);
	assert.deepEqual(captureTemporalFileBases(owner.ctx.cwd, owner.ctx.sessionManager.getSessionId(), owner.repositoryRoot), files);
});

test("pending Passive attachment fences local authoring and cannot replace a peer private acceptance after its read", async (t) => {
	const { h: owner } = await restorableBranch();
	const h = harness({ initializeRepository: false, repositoryRoot: owner.repositoryRoot, cwd: owner.ctx.cwd, sessionId: "passive-owner", mode: "passive" });
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const read = TemporalRuntime.prototype.refreshSelectedShared;
	let paused = false;
	t.mock.method(TemporalRuntime.prototype, "refreshSelectedShared", async function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["refreshSelectedShared"]>) {
		const result = await read.call(this, ...args);
		if (!paused) { paused = true; enter(); await gate; }
		return result;
	});
	const selecting = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await entered;
	const pending = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	await assert.rejects(h.tools.get("patch_state")!.execute("unadmitted-during-attachment", { session: { tactics: { forbidden: true } } }, undefined, undefined, h.ctx), /branch restoration is pending/);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), pending);
	// A separately admitted same-physical-session peer establishes the actual lost-update interleaving.
	const peer = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, cwd: h.ctx.cwd, sessionId: "passive-owner", mode: "passive" });
	await peer.handlers.get("session_start")!({ reason: "new" }, peer.ctx);
	await peer.tools.get("patch_state")!.execute("accepted-during-attachment", { session: { tactics: { retained: "NEW-PRIVATE" } } }, undefined, undefined, peer.ctx);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	release(); await selecting;
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.throws(() => h.readState(0, "session"), /excluded/, "read-only shared observation cannot fabricate accepted private authority");
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.equal(h.readState(0, "session").tactics.retained, "NEW-PRIVATE");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).filter(({ path }) => !/\/(config|runtime)\.json$/.test(path)), before.filter(({ path }) => !/\/(config|runtime)\.json$/.test(path)));
});

for (const retry of [false, true]) for (const cold of [false, true]) for (const expired of [false, true]) test(`Stop selects passive policy without cancelling fork memory initialization (retry=${retry}, cold=${cold}, expired=${expired})`, async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "state-flow-interrupted-fork-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const cwd = join(fixture, "cwd"), sessions = join(fixture, "sessions"), repositoryRoot = join(fixture, "store");
	for (const directory of [cwd, sessions, repositoryRoot]) mkdirSync(directory);
	const parentManager = SessionManager.create(cwd, sessions);
	const parent = harness({ cwd, repositoryRoot, initializeRepository: false, sessionId: parentManager.getSessionId(), sessionFile: parentManager.getSessionFile(), sessionTimestamp: parentManager.getHeader()!.timestamp });
	writeFileSync(parentManager.getSessionFile()!, JSON.stringify(parentManager.getHeader()) + "\n");
	await start(parent);
	await parent.tools.get("patch_state")!.execute("parent-private", { session: { tactics: { private: "SELECTED-PRIVATE" } } }, undefined, undefined, parent.ctx);
	const manager = SessionManager.create(cwd, sessions);
	const header = { ...manager.getHeader()!, version: 3, parentSession: parentManager.getSessionFile()! };
	const childOptions = { cwd, repositoryRoot, initializeRepository: false, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionTimestamp: header.timestamp, mode: "passive" as const };
	let child = harness(childOptions);
	child.ctx.sessionManager.getHeader = () => header;
	child.entries.push(...structuredClone(parent.entries));
	if (expired) for (let index = 0; index < 9; index++) {
		await parent.tools.get("patch_state")!.execute(`advance-${index}`, { session: { tactics: { private: "LATER-PRIVATE", index } } }, undefined, undefined, parent.ctx);
	}
	if (retry) {
		child.ctx.sessionManager.getHeader = () => ({ ...header, parentSession: join(fixture, "missing-parent.jsonl") });
		await child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
		child.ctx.sessionManager.getHeader = () => header;
	}
	const parentKey = sessionStorageKey(parentManager.getSessionFile()!, parentManager.getSessionId(), parentManager.getHeader()!.timestamp);
	const before = captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey);
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(repositoryRoot, async () => { enter(); await gate; });
	let selecting: Promise<unknown> | undefined;
	let control: Promise<unknown> | undefined;
	let settled = false;
	const fork = TemporalRuntime.prototype.withSelectedForkCopyTransaction;
	t.mock.method(TemporalRuntime.prototype, "withSelectedForkCopyTransaction", function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["withSelectedForkCopyTransaction"]>) {
		const operation = fork.call(this, ...args);
		selecting = operation.then(() => { settled = true; }, () => { settled = true; });
		return operation;
	});
	try {
		await entered;
		control = retry ? child.commands.get("state-flow-active")!.handler("", child.ctx) : child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
		await delay(0);
		assert.throws(() => child.readState(0, "session"), /restoration is pending/);
		await Promise.race([child.commands.get("state-flow-passive")!.handler("", child.ctx), delay(1_000).then(() => assert.fail("Stop waited for fork acceptance"))]);
		await delay(30);
		assert.equal(settled, false, "Stop does not cancel the independent fork initializer");
		assert.match(child.statuses.at(-1)!, /<dim>passive<\/dim>/);
		assert.throws(() => child.readState(0, "session"), /restoration is pending/);
		assert.deepEqual(captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey), before);
	} finally {
		release(); await holder; await control;
		// The fork reads current parent memory before its transaction starts; await the independent initializer.
		for (let waited = 0; !settled && waited < 2_000; waited += 5) await delay(5);
		await selecting;
	}
	// A fork copies the parent's current memory, independent of the native fork step.
	{
		assert.notEqual(child.resolveSnapshot().config.mode, "active");
		assert.equal(child.readState(0, "session").tactics.private, expired ? "LATER-PRIVATE" : "SELECTED-PRIVATE");
		await child.tools.get("patch_state")!.execute("passive-child-private", { session: { tactics: { private: "CHILD-OWNED" } } }, undefined, undefined, child.ctx);
		assert.notEqual(child.resolveSnapshot().config.mode, "active", "passive patching does not enable active policy");
	}
	const reopenChild = async () => {
		await child.handlers.get("session_shutdown")!({}, child.ctx);
		// Persist the native trace, then open a new manager and a fresh extension instance.
		writeFileSync(manager.getSessionFile()!, [header, ...child.entries.map((entry, index) => ({ ...entry, id: String(index), parentId: index ? String(index - 1) : null, timestamp: header.timestamp }))].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const reopened = SessionManager.open(manager.getSessionFile()!);
		child = harness(childOptions);
		assert.equal(reopened.getHeader()!.version, header.version);
		child.ctx.sessionManager.getHeader = () => ({ ...reopened.getHeader()!, version: header.version });
		child.entries.push(...reopened.getBranch());
		await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
	};
	if (cold) await reopenChild();
	const parentFiles = captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey);
	const childKey = sessionStorageKey(manager.getSessionFile()!, manager.getSessionId(), header.timestamp);
	const unaccepted = captureTemporalFileBases(cwd, manager.getSessionId(), repositoryRoot, childKey);
	const traceLength = child.entries.length;
	await child.commands.get("state-flow-active")!.handler("", child.ctx);
	assert.equal(child.readState(0, "session").tactics.private, "CHILD-OWNED");
	assert.match(child.notifications.at(-1)!, /^State Flow active/);
	await child.commands.get("state-flow-passive")!.handler("", child.ctx);
	await reopenChild();
	await child.commands.get("state-flow-active")!.handler("", child.ctx);
	assert.equal(child.readState(0, "session").tactics.private, "CHILD-OWNED", "an accepted child never recopies its parent after cold recovery");
	assert.ok(traceLength > 0 && unaccepted.length >= 0);
	assert.deepEqual(captureTemporalFileBases(cwd, parentManager.getSessionId(), repositoryRoot, parentKey), parentFiles, "retry preserves parent-private and shared bytes");
});

test("native branch restoration awaits exclusion, fences pending authority and coalesces Start into one acceptance", async (t) => {
	const { h, files } = await restorableBranch();
	const state = h.readState();
	const before = files();
	const entries = h.entries.length;
	const notices = h.notifications.length;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx)).then(() => { restored = true; });
	const starts = [h.commands.get("state-flow-active")!.handler("", h.ctx), h.commands.get("state-flow-active")!.handler("", h.ctx)];
	await delay(40);
	assert.equal(restored, false);
	assert.match(h.statuses.at(-1)!, /<dim>active \(blocked\)<\/dim>/, "pending selection retains Active policy without accepted memory");
	assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	await assert.rejects(h.tools.get("patch_state")!.execute("pending", { session: { tactics: { early: true } } }, undefined, undefined, h.ctx), /restoration is pending/);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /restoration is pending/);
	assert.deepEqual(files(), before);
	assert.equal(h.entries.length, entries);
	await release();
	await restoring;
	await Promise.all(starts);
	assert.deepEqual(h.readState(), state);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.entries.length, entries + 1, "restoration appends one accepted checkpoint; joined Starts stay inert");
	assert.equal(h.notifications.length, notices + 1, "only the explicit status request was reported");
	assert.match(h.statuses.at(-1)!, /<dim>active<\/dim>/);
	assert.deepEqual(semanticFiles(files()), semanticFiles(before));
});

test("restoration derives uncompiled-context bootstrap after waiting and publishes it in the same acceptance", async (t) => {
	const { h } = await restorableBranch();
	const runtimePath = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx));
	await delay(20);
	// Native conversation that arrives after the checkpoint is observed after the wait, not at dispatch.
	h.entries.push({ type: "message", message: { role: "user", content: "UNCOMPILED", timestamp: 1 } });
	const rename = fs.renameSync;
	let runtimeWrites = 0;
	fs.renameSync = (from, to) => {
		if (to === runtimePath) runtimeWrites++;
		return rename(from, to);
	};
	syncBuiltinESMExports();
	t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
	await release();
	await restoring;
	assert.equal(runtimeWrites, 1, "no second post-restore persistence call");
	assert.equal(h.resolveSnapshot().meta.bootstrap, true);
	assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
});

for (const replacement of ["session_start", "session_tree", "session_shutdown"] as const) test(`pending branch restoration withdraws at ${replacement} while exclusion is held`, { timeout: 5_000 }, async (t) => {
	const { h, files, lock } = await restorableBranch();
	const state = h.readState();
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const old = Promise.resolve(h.handlers.get("session_start")!({ reason: "resume" }, h.ctx));
	await delay(20);
	const entries = structuredClone(h.entries);
	const notices = [...h.notifications];
	const next = Promise.resolve(h.handlers.get(replacement)!(replacement === "session_start" ? { reason: "resume" } : {}, h.ctx));
	await Promise.race([old, delay(1_000).then(() => assert.fail("obsolete restoration still waits"))]);
	if (replacement === "session_shutdown") await Promise.race([next, delay(1_000).then(() => assert.fail("shutdown did not drain restoration"))]);
	assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
	assert.deepEqual(h.entries, entries, "the obsolete restoration appends no checkpoint");
	assert.deepEqual(h.notifications, notices);
	await release();
	await next;
	await delay(20);
	assert.deepEqual(h.notifications, notices);
	if (replacement === "session_shutdown") {
		assert.deepEqual(h.entries, entries);
		assert.deepEqual(files(), before);
		return;
	}
	assert.equal(h.entries.length, entries.length + 1, "only the current selection accepts");
	assert.deepEqual(h.readState(), state);
});

for (const restart of [false, true]) for (const branch of ["boundary", "auto-start"] as const) test(`Stop preserves pending ${branch} memory acceptance (restart=${restart})`, { timeout: 5_000 }, async (t) => {
	const h = branch === "boundary"
		? (await restorableBranch()).h
		: harness({ initializeRepository: false, mode: "active" });
	const state = branch === "boundary" ? h.readState() : undefined;
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let restored = false;
	const restoring = Promise.resolve(h.handlers.get("session_start")!({ reason: branch === "boundary" ? "resume" : "new" }, h.ctx)).then(() => { restored = true; });
	await delay(20);
	const entries = h.entries.length;
	await Promise.race([h.commands.get("state-flow-passive")!.handler("", h.ctx), delay(1_000).then(() => assert.fail("Stop waited for attachment"))]);
	await h.commands.get("state-flow-passive")!.handler("", h.ctx);
	await delay(20);
	assert.equal(restored, false, "policy changes leave memory acceptance waiting for exclusion");
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	assert.match(h.statuses.at(-1)!, /<dim>passive<\/dim>/);
	assert.deepEqual(h.entries.slice(entries), [{ type: "custom", customType: "state-flow-passive-stop", data: {
		version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "passive", scopes: ["global", "cwd", "session"],
	} }], "Stop records its newer policy once, without a fence, reset or accepted checkpoint");
	assert.deepEqual(files(), before);
	const starting = restart ? h.commands.get("state-flow-active")!.handler("", h.ctx) : undefined;
	await release();
	await restoring;
	await starting;
	assert.equal(h.resolveSnapshot().config.mode === "active", restart);
	if (branch === "boundary") assert.deepEqual(h.readState(), state);
	assert.equal(existsSync(sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config), true);
	assert.equal(h.notifications.some((message) => /writes paused|failed/.test(message)), false);
	await h.tools.get("patch_state")!.execute("mode-independent", { session: { tactics: { resumed: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").tactics.resumed, true);
	assert.equal(h.resolveSnapshot().config.mode === "active", restart);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.equal(h.readState(0, "session").tactics.resumed, true);
	assert.equal(h.resolveSnapshot().config.mode === "active", restart);
});

test("Stop withdraws Start-owned attachment without cancelling retained memory acceptance", async (t) => {
	const { h: source } = await restorableBranch();
	const state = source.readState();
	const h = harness({ initializeRepository: false, cwd: source.ctx.cwd, repositoryRoot: source.repositoryRoot, sessionId: source.ctx.sessionManager.getSessionId(), mode: "passive" });
	h.entries.push(...structuredClone(source.entries));
	// Track the independently owned current-memory attachment, not the superseding Start control.
	const restore = TemporalRuntime.prototype.withSelectedCurrentTransaction;
	let recovered: Promise<unknown> | undefined;
	t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction", function(this: TemporalRuntime, ...args: Parameters<TemporalRuntime["withSelectedCurrentTransaction"]>) {
		const operation = restore.call(this, ...args);
		recovered ??= operation.catch(() => undefined);
		return operation;
	});
	const release = await holdResponseStorage(t, h.repositoryRoot);
	const starting = h.commands.get("state-flow-active")!.handler("", h.ctx);
	try {
		await delay(20);
		assert.ok(recovered);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		await Promise.race([starting, delay(1_000).then(() => assert.fail("cancelled Start still waits for attachment"))]);
		assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	} finally { await release(); await recovered; }
	assert.deepEqual(h.readState(), state);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	await h.tools.get("patch_state")!.execute("passive-after-attachment", { session: { tactics: { passive: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").tactics.passive, true);
});

for (const initialMode of ["passive"] as const) for (const mode of ["off", "passive"] as const) test(`fenced reload preserves ${initialMode} → ${mode} with mode-owned recovery cancellation`, { timeout: 5_000 }, async (t) => {
	const { h, files, lock } = await restorableBranch();
	const state = h.readState(0, "session");
	mkdirSync(lock);
	await h.commands.get(`state-flow-${initialMode}`)!.handler("", h.ctx);
	rmSync(lock, { recursive: true });
	const fence = h.entries.at(-1)!.data.persistenceError;
	assert.ok(fence);
	const before = files();
	const entryCount = h.entries.length;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let loaded = false;
	const reloading = Promise.resolve(h.handlers.get("session_start")!({ reason: "reload" }, h.ctx)).then(() => { loaded = true; });
	await delay(40);
	assert.equal(loaded, false);
	assert.throws(() => h.readState(0, "session"), /restoration is pending/);
	if (mode === "passive") {
		// Explicit Passive joins the read-only recovery, then accepts current memory and clears the fence.
		const selecting = h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
		await delay(40);
		assert.equal(loaded, false, "Passive retains its independent memory read");
		await release();
		await reloading;
		await selecting;
		assert.equal(h.notifications.at(-1), "State Flow passive; memory writes resumed from current session memory.");
		assert.deepEqual(h.readState(0, "session"), state);
		assert.equal(typeof h.entries.at(-1)!.data.boundary, "string");
		for (const reload of [false, true]) {
			if (reload) await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
			assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>passive</dim>");
			await h.tools.get("patch_state")!.execute(`writable-${reload}`, { session: { tactics: { [`writable${reload}`]: true } } }, undefined, undefined, h.ctx);
		}
		return;
	}
	await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
	await reloading;
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(h.entries.length, entryCount + 1);
	assert.equal(h.entries.at(-1)!.data.mode, mode);
	assert.equal(h.entries.at(-1)!.data.persistenceError, fence);
	const entries = structuredClone(h.entries);
	await release();
	await reloading;
	for (const reload of [false, true]) {
		if (reload) await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
		assert.throws(() => h.readState(0, "session"), /temporal runtime is unavailable/);
		assert.equal(h.activeTools.includes("patch_state"), false);
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.handlers.get("context")!({ messages: [] }, h.ctx), undefined, "recovery must not resurrect State Flow context after Off");
		assert.equal(h.beforeAgentStart("Continue").systemPrompt.includes("State Flow passive memory is available"), false);
		assert.deepEqual(files(), before, "read-only recovery never publishes");
		assert.deepEqual(h.entries, entries, "recovery appends no checkpoint and retains the latest policy marker");
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { unsafe: true } } }, undefined, undefined, h.ctx), /tools are off/);
	}
});

test("auto-start initializes a truly new branch in one awaited acceptance", { timeout: 5_000 }, async (t) => {
	const h = harness({ initializeRepository: false, mode: "active" });
	const config = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).config;
	const release = await holdResponseStorage(t, h.repositoryRoot);
	let attached = false;
	const attaching = Promise.resolve(h.handlers.get("session_start")!({ reason: "new" }, h.ctx)).then(() => { attached = true; });
	await delay(40);
	assert.equal(attached, false);
	assert.equal(existsSync(config), false);
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker("harness-session", "active")], "policy capture does not claim a semantic boundary");
	await release();
	await attaching;
	assert.equal(existsSync(config), true);
	assert.equal(h.entries.length, 2);
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.match(h.statuses.at(-1)!, /<dim>active<\/dim>/);
	assert.equal(h.activeTools.includes("patch_state"), true);
});

test("accepted restoration survives a native checkpoint failure without rollback or replay", async () => {
	const { h, files } = await restorableBranch({ mode: "off" });
	const state = h.readState();
	const entries = h.entries.length;
	h.entries.push = () => { throw new Error("native trace unavailable"); };
	try {
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	} finally {
		delete (h.entries as { push?: unknown }).push;
	}
	assert.match(h.notifications.at(-1)!, /^State Flow memory restored; lifecycle update failed: native trace unavailable/);
	assert.equal(h.entries.length, entries);
	assert.deepEqual(h.readState(), state);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.match(h.statuses.at(-1)!, /<dim>active<\/dim>/);
	const accepted = files();
	await h.commands.get("state-flow-active")!.handler("", h.ctx);
	assert.deepEqual(files(), accepted, "already-active Start neither replays nor republishes the restoration");
	await commitTerminal(h, {}, { after: true }, "Next answer");
	assert.deepEqual(h.readState(0, "session").tactics, { retained: "PRIVATE", after: true });
});

{
	for (const mode of ["active", "passive"] as const) {
		test(`real Pi ${mode} sees automatic-response ownership on every new run`, async (t) => {
			const fixture = await realPiFixture(t, { initializeRepository: false, mode });
			const session = await fixture.createSession("new");
			let observed = 0;
			const observe = (context: Context) => {
				const system = getCurrentSystemMessage(context.messages);
				assert.ok(system);
				assert.match(getSystemMessageText(system), /Never patch response in global, cwd or session, including clearing\/deleting it/);
				assert.match(getSystemMessageText(system), /captures your final answer automatically in Active mode/);
				observed++;
			};
			fixture.faux.setResponses([
				(context) => { observe(context); return fauxAssistantMessage(fauxToolCall("patch_state", {
					session: { tactics: { seed: true } },
				}), { stopReason: "toolUse" }); },
				fauxAssistantMessage("Seeded"),
			]);
			await session.prompt("Seed memory");
			assert.equal(observed, 1, "the initial inference must see patch tool guidance even without passive memory");
			assert.equal(fixture.readState(session).response, mode === "active" ? "Seeded" : "");
			for (let run = 1; run <= 3; run++) {
				fixture.faux.setResponses([(context) => {
					observe(context);
					const protocol = getCurrentSystemMessage(context.messages)!.sections?.state_flow ?? "";
					if (mode === "active") assert.match(protocol, /response: read-only prior answer; never patch it in any scope/);
					else assert.match(protocol, /Never patch response in global, cwd or session/);
					return fauxAssistantMessage(`Answer ${run}`);
				}]);
				await session.prompt(`Iteration ${run}`);
				const terminal = session.messages.at(-1);
				assert.ok(terminal?.role === "assistant");
				assert.equal(terminal.stopReason, "stop", terminal.errorMessage ?? "response policy inference did not complete");
				assert.deepEqual(terminal.content, [{ type: "text", text: `Answer ${run}` }]);
				assert.equal(observed, run + 1, "provider assertions must not be swallowed");
				assert.equal(fixture.readState(session).response, mode === "active" ? `Answer ${run}` : "",
					"only Active mode automatically records answers; Passive response remains runtime-owned");
			}
		});
	}
}

{
	type Input = Pick<Context, "messages" | "systemPrompt">;
	function capture(context: Context): Input { return structuredClone({ messages: context.messages, systemPrompt: context.systemPrompt }); }
	function texts(input: Input) { return input.messages.flatMap(message => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []); }
	function head(input: Input) {
		const all = texts(input), memory = all.filter(text => text.startsWith("State Flow passive memory"));
		assert.equal(memory.length, 1, "one automatic Passive memory head");
		return { ...JSON.parse(memory[0]!.slice(memory[0]!.indexOf("\n") + 1)), projection: all.find(text => text.startsWith("State Flow projection: "))?.slice("State Flow projection: ".length) };
	}
	function key(session: AgentSession) { return resolveSessionAddress(session.sessionFile, session.sessionId, session.sessionManager.getHeader()?.timestamp).key; }
	function canonical(f: RealPiFixture, session: AgentSession) { return captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key(session)); }
	function metadata(f: RealPiFixture, session: AgentSession) { return JSON.parse(readFileSync(sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, key(session)).runtime, "utf8")); }
	async function seed(f: RealPiFixture, session: AgentSession, scopes: ScopeSelection, deferred = false) {
		const runtime = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, key(session));
		if (deferred) await runtime.withSelectedDeferredForkTransaction(scopes, { mode: "passive" }, publish => publish(), undefined, true);
		else await runtime.withSelectedSharedOriginTransaction(scopes, { config: { mode: "passive" }, meta: { step: 0 } }, publish => publish(), undefined, true);
		const sources = scopes.map(scope => join(f.cwd, `passive-${scope}-source.md`));
		sources.forEach(path => writeFileSync(path, "EXTERNAL_BODY_NOT_AUTOMATICALLY_ACQUIRED"));
		await runtime.withSelectedPatchTransaction(tx => tx.publish({ config: { mode: "passive" }, meta: {
			step: 4, specification: "OLD_LOWER_SOURCE_SPEC", bootstrap: true,
			validation: { attempt: 2, error: "prior check", instruction: "OLD_LOWER_SOURCE_REPAIR" },
		} }, { id: "passive-input-source", transitions: scopes.map((scope, i) => ({ scope, patch: {
			strategy: { [`input_${scope}`]: `SHARED_INPUT_${scope}` },
			artifacts: { [sources[i]!]: { description: `REGISTERED_CARD_${scope}` } },
			lazy: { [`private_${scope}`]: "LAZY_BODY_NOT_AUTOMATICALLY_PROJECTED" },
		} })) }), () => {});
		return sources;
	}
	async function noSourceBodyIO<T>(paths: string[], action: () => Promise<T>): Promise<T> {
		const forbidden = new Set(paths), attempts: string[] = [], open = fs.openSync, read = fs.readFileSync;
		const guard = (path: unknown) => { if (forbidden.has(String(path))) { attempts.push(String(path)); throw new Error("unexpected automatic external source body acquisition"); } };
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { guard(args[0]); return open(...args); }) as typeof fs.openSync;
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { guard(args[0]); return read(...args); }) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try { return await action(); }
		finally { fs.openSync = open; fs.readFileSync = read; syncBuiltinESMExports(); assert.deepEqual(attempts, [], "caught source I/O must not hide an acquisition attempt"); }
	}
	function assertInput(input: Input, scopes: ScopeSelection) {
		const parsed = head(input); assert.ok(parsed.projection);
		for (const scope of scopes) {
			assert.equal(parsed.state.strategy[`input_${scope}`], `SHARED_INPUT_${scope}`);
			assert.match(JSON.stringify(parsed.state.artifacts), new RegExp(`REGISTERED_CARD_${scope}`));
		}
		assert.match(JSON.stringify(input.messages.filter(message => message.role === "system")), /"state_flow":/);
		assert.doesNotMatch(JSON.stringify(input), /OLD_LOWER_SOURCE_SPEC|OLD_LOWER_SOURCE_REPAIR|EXTERNAL_BODY_NOT_AUTOMATICALLY_ACQUIRED|LAZY_BODY_NOT_AUTOMATICALLY_PROJECTED/);
		return parsed;
	}
	async function firstMutation(t: TestContext, f: RealPiFixture, session: AgentSession, scopes: ScopeSelection, before: ReturnType<typeof canonical>) {
		const inputs: Input[] = [], firstFiles: ReturnType<typeof canonical>[] = [], events: any[] = [];
		const unsubscribe = session.subscribe(event => { if (event.type === "tool_execution_end") events.push(event); }); t.after(unsubscribe);
		f.faux.setResponses([
			context => { inputs.push(capture(context)); firstFiles.push(canonical(f, session)); return fauxAssistantMessage(fauxToolCall("patch_state", { session: { tactics: { passive_input_patch: "FIRST_INPUT_PATCH_ACCEPTED" } } }, { id: "passive-input-first-mutation" }), { stopReason: "toolUse" }); },
			context => { inputs.push(capture(context)); return fauxAssistantMessage("Ordinary Passive answer is delivered, not stored as response"); },
		]);
		await session.prompt("FIRST_PASSIVE_INPUT_MUTATION");
		assert.equal(inputs.length, 2, "actual provider callbacks completed");
		assert.deepEqual(firstFiles, [before], "input observation cannot acquire private memory or publish source run fields");
		const initial = assertInput(inputs[0]!, scopes), later = assertInput(inputs[1]!, scopes);
		assert.equal(later.projection, initial.projection, "Passive mutation updates the current tail, not the frozen head");
		const patch = events.find(event => event.toolCallId === "passive-input-first-mutation"); assert.ok(patch && !patch.isError);
		const modelAck = inputs[1]!.messages.find(message => message.role === "toolResult" && message.toolCallId === "passive-input-first-mutation");
		assert.ok(modelAck?.role === "toolResult" && !modelAck.isError);
		assert.match(JSON.stringify(modelAck.content), /State materialized atomically/);
		// An exact authored Session leaf needs no redundant state_updates receipt; its native call + accepted acknowledgement remain visible.
		assert.match(JSON.stringify(inputs[1]), /FIRST_INPUT_PATCH_ACCEPTED/);
		assert.equal(f.readState(session).tactics.passive_input_patch, "FIRST_INPUT_PATCH_ACCEPTED");
		assert.equal(f.readState(session).response, "");
		const current = metadata(f, session); assert.equal(current.privateAcquisition, "acquired"); assert.equal(current.step, 5);
		assert.equal(current.specification, "OLD_LOWER_SOURCE_SPEC"); assert.equal(current.validation.instruction, "OLD_LOWER_SOURCE_REPAIR");
	}

	for (const scopes of [["global"], ["cwd"], ["global", "cwd"]] as const) {
		test(`real Pi Passive input sees lower shared ${scopes.join("+")} before first mutation when observed at mode entry`, { timeout: 20_000 }, async t => {
			const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }), session = await f.createSession("new"), owner = session.sessionId;
			f.faux.setResponses([fauxAssistantMessage("Ordinary Off conversation persists the physical owner")]); await session.prompt("OFF_BEFORE_PASSIVE_SOURCE");
			const sources = await seed(f, session, scopes), before = canonical(f, session);
			await noSourceBodyIO(sources, async () => {
				await session.prompt("/state-flow-passive"); assert.equal(session.sessionId, owner);
				assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "unacquired");
				await firstMutation(t, f, session, scopes, before);
			});
		});
		test(`real Pi late lower shared ${scopes.join("+")} source needs native reload observation before fresh Passive input`, { timeout: 20_000 }, async t => {
			const f = await realPiFixture(t, { initializeRepository: false, mode: "passive" }), session = await f.createSession("new"), owner = session.sessionId;
			let initial: Input | undefined;
			f.faux.setResponses([context => { initial = capture(context); return fauxAssistantMessage("Initial Passive ordinary answer"); }]); await session.prompt("PASSIVE_BEFORE_LOWER_SOURCE");
			assert.ok(initial);
			const sources = await seed(f, session, scopes), before = canonical(f, session);
			await noSourceBodyIO(sources, async () => {
				let late: Input | undefined;
				f.faux.setResponses([context => { late = capture(context); return fauxAssistantMessage("No implicit disk polling or private acceptance"); }]); await session.prompt("STILL_SAME_PASSIVE_OBSERVATION");
				assert.ok(late); assert.doesNotMatch(JSON.stringify(late), /SHARED_INPUT_|REGISTERED_CARD_/);
				assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "unacquired");
				await session.reload(); assert.equal(session.sessionId, owner);
				assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "unacquired");
				await firstMutation(t, f, session, scopes, before);
			});
		});
	}

	test("ordinary native Active restoration cannot borrow Passive shared observation or acquire unacquired Session", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }), session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("Persist owner")]); await session.prompt("OFF_BEFORE_ACTIVE_SOURCE");
		await seed(f, session, ["cwd"]); const before = canonical(f, session);
		session.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: session.sessionId, mode: "active", scopes: ["global", "cwd", "session"] });
		await session.reload();
		let calls = 0; f.faux.setResponses([() => { calls++; return fauxAssistantMessage("Must not reach provider"); }]);
		try { await session.prompt("ORDINARY_ACTIVE_MUST_NOT_ACQUIRE"); } catch (error) { assert.match(String(error), /abort|State Flow|cancel/i); }
		assert.equal(calls, 0); assert.ok(f.statuses.some(status => status?.includes("active (blocked)")));
		assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "unacquired");
	});

	test("pre-runtime Passive deferred source without native parent permission cannot become shared-only fallback", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }), session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("Persist owner")]); await session.prompt("OFF_BEFORE_DEFERRED_SOURCE");
		await seed(f, session, ["cwd"], true); const before = canonical(f, session);
		await session.prompt("/state-flow-passive");
		let input: Input | undefined; f.faux.setResponses([context => { input = capture(context); return fauxAssistantMessage("Ordinary native Passive context is still permitted"); }]);
		await session.prompt("NO_PRIVATE_FORK_PERMISSION");
		assert.ok(input); assert.equal(texts(input).filter(text => text.startsWith("State Flow passive memory")).length, 0);
		assert.doesNotMatch(JSON.stringify(input), /SHARED_INPUT_cwd|REGISTERED_CARD_cwd/);
		assert.throws(() => f.readState(session), /unavailable|private acquisition/);
		assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "deferred");
	});

	test("pre-runtime Passive acquired current with corrupt required private body cannot fall back to valid shared source", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }), session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("Persist owner")]); await session.prompt("OFF_BEFORE_REQUIRED_PRIVATE_SOURCE");
		// Explicit lower origin grant creates a real acquired cohort; native history still owns policy DATA only.
		const source = new TemporalRuntime(f.cwd, session.sessionId, f.repositoryRoot, key(session));
		await source.withSelectedFirstPatchTransaction(["global", "cwd", "session"], { config: { mode: "passive" }, meta: { step: 0 } }, tx => tx.publish(tx.snapshot), () => {}, undefined, true);
		await source.withSelectedPatchTransaction(tx => tx.publish({ config: { mode: "passive" }, meta: { step: 1 } }, { id: "required-private-source", transitions: [
			{ scope: "cwd", patch: { strategy: { requiredPrivateShared: "DO_NOT_FALL_BACK_TO_SHARED" } } },
			{ scope: "session", patch: { tactics: { required: true } } },
		] }), () => {});
		writeFileSync(temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, key(session)).checkpoint, "null\n");
		const before = canonical(f, session); await session.prompt("/state-flow-passive");
		let input: Input | undefined; f.faux.setResponses([context => { input = capture(context); return fauxAssistantMessage("Native context without State Flow fallback"); }]); await session.prompt("REQUIRED_PRIVATE_CORRUPTION");
		assert.ok(input); assert.equal(texts(input).filter(text => text.startsWith("State Flow passive memory")).length, 0);
		assert.doesNotMatch(JSON.stringify(input), /DO_NOT_FALL_BACK_TO_SHARED/);
		assert.throws(() => f.readState(session), /unavailable/);	assert.deepEqual(canonical(f, session), before); assert.equal(metadata(f, session).privateAcquisition, "acquired");
	});

	test("native handler newer Passive or Off owns the result across an unacquired header-inspection wait", async t => {
		for (const mode of ["passive", "off"] as const) {
			const h = harness({ initializeRepository: false, mode: "off" }); await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
			const storageKey = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId()).key;
			const source = new TemporalRuntime(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, storageKey);
			await source.withSelectedSharedOriginTransaction(["cwd"], { config: { mode: "passive" }, meta: { step: 0 } }, publish => publish(), undefined, true);
			await source.withSelectedPatchTransaction(tx => tx.publish({ config: { mode: "passive" }, meta: { step: 4 } },
				{ id: "late-passive-source", transitions: [{ scope: "cwd", patch: { strategy: { lateInput: "LIVE_PASSIVE_SHARED_INPUT" } } }] }), () => {});
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, storageKey);
			h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "active", scopes: ["global", "cwd", "session"] } });
			let enter!: () => void, release!: () => void;
			const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
			const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
			const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", async function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) {
				const result = await Reflect.apply(inspect, this, args); enter(); await held; return result;
			});
			const restoring = h.handlers.get("session_tree")!({}, h.ctx); let control: unknown;
			try { await entered; control = h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx); }
			finally { release(); }
			try { await Promise.all([restoring, control]); } finally { spy.mock.restore(); }
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, storageKey), before);
			if (mode === "passive") {
				assert.equal(h.readState(0, "cwd").strategy.lateInput, "LIVE_PASSIVE_SHARED_INPUT");
				const projected = await h.handlers.get("context")!({ messages: [] }, h.ctx);
				assert.match(JSON.stringify(projected), /LIVE_PASSIVE_SHARED_INPUT/);
				assert.equal(h.notifications.some(note => note.includes("requires explicit private acquisition")), false);
			} else assert.throws(() => h.readState(0, "cwd"), /unavailable|off/i);
		}
	});
}

{
	const sharedChoices: ScopeSelection[] = [["global"], ["cwd"], ["global", "cwd"]];
	const sessionChoices: ScopeSelection[] = [["session"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]];
	for (const previous of sharedChoices) for (const wanted of sessionChoices)
		test(`native Passive reselection ${previous.join("+")} to ${wanted.join("+")} observes without a Session grant, then first patch acquires`, { timeout: 20_000 }, async t => {
			const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
			fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes: previous }));
			const runtime = await f.createRuntime("new"), session = runtime.session;
			const results = new Map<string, ToolResultMessage>();
			const observe = (context: Context) => {
				for (const message of context.messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
			};
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(previous, Object.fromEntries(previous.map(scope => [scope, { tactics: { sharedOwner: scope } }]))), { id: "shared-source" }), { stopReason: "toolUse" }),
				context => { observe(context); return fauxAssistantMessage("Shared native memory accepted"); },
			]);
			await session.prompt("Create shared-only native memory");
			assert.ok(results.get("shared-source")); assert.notEqual(results.get("shared-source")!.isError, true);
			const key = nativeSessionKey(session), paths = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, key);
			const life = () => JSON.parse(fs.readFileSync(paths.runtime, "utf8"));
			assert.equal(life().privateAcquisition, "unacquired");
			const privatePaths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, key);
			const privateFiles = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta];
			assert.deepEqual(privateFiles.map(path => fs.existsSync(path)), [false, false, false]);
			const beforeRun = structuredClone(life());
			const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
			const before = files();
			const checkpoints = () => session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "state-flow-snapshot").length;
			const beforeCheckpoints = checkpoints();
			// Owned native-policy DATA adapter for the future public selector, not a private grant.
			session.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: session.sessionId, mode: "passive", scopes: wanted });
			await session.reload();
			assert.deepEqual(files(), before, "selection/observation cannot publish lifecycle or private semantics");
			assert.equal(checkpoints(), beforeCheckpoints, "read-only observation cannot invent an accepted boundary");
			assert.equal(life().privateAcquisition, "unacquired");
			const shared = wanted.filter(scope => scope !== "session" && previous.includes(scope));
			for (const scope of shared) assert.equal(f.readState(session, 0, scope).tactics.sharedOwner, scope);
			assert.throws(() => f.readState(session, 0, "session"), /unavailable|excluded/);
			let calls = 0;
			f.faux.setResponses([() => { calls++; return fauxAssistantMessage("Passive delivered answer without capture"); }]);
			await session.prompt("Observe the current selected shared inputs without a mutation");
			assert.equal(calls, 1);
			assert.deepEqual(files(), before, "ordinary Passive delivery cannot acquire or checkpoint the missing Session");
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(wanted, { session: { tactics: { acquiredByFirstPatch: true } } }), { id: "first-session" }), { stopReason: "toolUse" }),
				context => { observe(context); return fauxAssistantMessage("First Session patch accepted"); },
			]);
			await session.prompt("Explicitly author the first selected Session mutation");
			const result = results.get("first-session"); assert.ok(result); assert.notEqual(result.isError, true, JSON.stringify(result.content));
			assert.equal(f.readState(session, 0, "session").tactics.acquiredByFirstPatch, true);
			assert.equal(life().privateAcquisition, "acquired");
			assert.equal(life().step, beforeRun.step + 1);
			assert.equal(life().specification, beforeRun.specification);
			assert.deepEqual(JSON.parse(fs.readFileSync(paths.config, "utf8")).scopes, wanted);
			const excluded = previous.filter(scope => !wanted.includes(scope));
			const excludedPaths = new Set(excluded.flatMap(scope => {
				const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, key);
				return [p.checkpoint, p.patches, p.meta];
			}));
			assert.deepEqual(files().filter(file => excludedPaths.has(file.path)), before.filter(file => excludedPaths.has(file.path)), "first private mutation preserves now-excluded shared bytes");
		});

	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("reselection did not settle before exclusion release")), 3000);
		})]).finally(() => clearTimeout(timer));
	}
	for (const mode of ["passive", "off"] as const) test(`native late ${mode} wins Passive-reselection header wait without private acquisition`, { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes: ["cwd"] }));
		const runtime = await f.createRuntime("new"), session = runtime.session;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(["cwd"], { cwd: { tactics: { retained: true } } })), { stopReason: "toolUse" }),
			fauxAssistantMessage("Shared source accepted"),
		]);
		await session.prompt("Create the shared source");
		const key = nativeSessionKey(session), paths = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, key);
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
		const before = files();
		let release!: () => void, entered!: () => void, inspecting!: () => void;
		const acquired = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		const stage = new Promise<void>(resolve => { inspecting = resolve; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; });
		await acquired;
		let signal: AbortSignal | undefined;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) {
			signal = args[2]; inspecting(); return Reflect.apply(inspect, this, args);
		});
		session.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: session.sessionId, mode: "active", scopes: ["cwd", "session"] });
		const restoring = session.reload();
		try {
			await deadline(stage); spy.mock.restore();
			assert.ok(signal); assert.equal(signal.aborted, false);
			await deadline(session.prompt(`/state-flow-${mode}`));
			if (mode === "off") { await deadline(restoring); assert.equal(signal.aborted, true); }
			else assert.equal(signal.aborted, false, "independent newer Passive preserves the restoration owner");
			assert.deepEqual(files(), before);
		} finally { release(); await holding; await restoring; }
		assert.deepEqual(files(), before);
		assert.equal(JSON.parse(fs.readFileSync(paths.runtime, "utf8")).privateAcquisition, "unacquired");
		if (mode === "passive") assert.equal(f.readState(session, 0, "cwd").tactics.retained, true);
		await session.reload();
		assert.deepEqual(files(), before, "reload cannot reinterpret the completed mode choice as Active");
		if (mode === "passive") assert.equal(f.readState(session, 0, "cwd").tactics.retained, true);
		else assert.throws(() => f.readState(session, 0, "cwd"), /unavailable/);
	});
}

{
	const wanted: ScopeSelection = ["cwd", "session"];
	function files(f: RealPiFixture, s: AgentSession) { return captureTemporalFileBases(f.cwd, s.sessionId, f.repositoryRoot, nativeSessionKey(s)); }
	function life(f: RealPiFixture, s: AgentSession) { return JSON.parse(fs.readFileSync(sessionRuntimePaths(f.cwd, s.sessionId, f.repositoryRoot, nativeSessionKey(s)).runtime, "utf8")); }
	function privateAbsent(f: RealPiFixture, s: AgentSession) {
		const p = temporalScopePaths(f.cwd, s.sessionId, "session", f.repositoryRoot, nativeSessionKey(s));
		assert.deepEqual([p.checkpoint, p.patches, p.meta].map(path => fs.existsSync(path)), [false, false, false]);
	}
	function policy(s: AgentSession, scopes: ScopeSelection, extra: Record<string, unknown> = {}) {
		// Native policy DATA adapter only: neither a public selector nor a private grant.
		s.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: s.sessionId, mode: "passive", scopes, ...extra });
	}
	function checkpoints(s: AgentSession) { return s.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "state-flow-snapshot").length; }
	async function patch(f: RealPiFixture, s: AgentSession, scopes: ScopeSelection, id: string, selection: ScopeSelection = ["global", "cwd", "session"]) {
		const results: ToolResultMessage[] = [], inputs: Context[] = [];
		f.faux.setResponses([
			context => { inputs.push(structuredClone(context)); return fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(selection, Object.fromEntries(scopes.map(scope => [scope, { tactics: { denialMarker: id } }]))), { id }), { stopReason: "toolUse" }); },
			context => { inputs.push(structuredClone(context)); results.push(...context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === id)); return fauxAssistantMessage("Native ordinary answer"); },
		]);
		await s.prompt(`Native patch ${id}`);
		assert.equal(inputs.length, 2, "both actual provider callbacks completed");
		assert.equal(results.length, 1, "original native tool result delivered exactly once");
		return { result: results[0]!, inputs };
	}
	async function denied(f: RealPiFixture, s: AgentSession, disposition: string, absent: boolean) {
		const before = files(f, s), count = checkpoints(s), owner = s.sessionId;
		const { result, inputs } = await patch(f, s, ["session"], "REFUSED_PRIVATE_MUTATION");
		assert.equal(result.isError, true, JSON.stringify(result.content));
		assert.equal(s.sessionId, owner);
		assert.doesNotMatch(JSON.stringify(inputs), /State Flow (?:passive memory|runtime context|exit handoff)|State Flow projection:/);
		assert.throws(() => f.readState(s, 0, "session"), /unavailable|private|excluded|persist/i);
		assert.deepEqual(files(f, s), before, "refused native mutation preserves every canonical byte");
		assert.equal(checkpoints(s), count, "denial cannot append accepted native checkpoints");
		assert.equal(life(f, s).privateAcquisition, disposition);
		if (absent) privateAbsent(f, s);
	}

	test("native acquired current cannot borrow unacquired Passive observer after excluded checkpoint and private corruption", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes: ["global", "cwd", "session"] }));
		const s = (await f.createRuntime("new")).session;
		assert.notEqual((await patch(f, s, ["global", "cwd", "session"], "SHARED_SOURCE_SENTINEL")).result.isError, true);
		assert.equal(life(f, s).privateAcquisition, "acquired");
		policy(s, ["cwd"]); await s.reload();
		assert.equal(f.readState(s, 0, "cwd").tactics.denialMarker, "SHARED_SOURCE_SENTINEL");
		const accepted = checkpoints(s); assert.ok(accepted > 0);
		const last = s.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "state-flow-snapshot").at(-1);
		assert.ok(last?.type === "custom"); assert.match(JSON.stringify(last.data), /"scopes":\["cwd"\]/);
		fs.writeFileSync(temporalScopePaths(f.cwd, s.sessionId, "session", f.repositoryRoot, nativeSessionKey(s)).checkpoint, "null\n");
		const before = files(f, s);
		policy(s, wanted); await s.reload();
		assert.deepEqual(files(f, s), before); assert.equal(checkpoints(s), accepted);
		await denied(f, s, "acquired", false);
	});

	test("native deferred shared fork cannot invent parent Session permission on Passive expansion", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes: ["cwd"] }));
		const runtime = await f.createRuntime("new"), parent = runtime.session;
		assert.notEqual((await patch(f, parent, ["cwd"], "SHARED_SOURCE_SENTINEL", ["cwd"])).result.isError, true);
		assert.equal(life(f, parent).privateAcquisition, "unacquired"); privateAbsent(f, parent);
		const source = files(f, parent), parentFile = parent.sessionFile!;
		assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
		const child = runtime.session;
		assert.notEqual(child.sessionId, parent.sessionId);
		assert.equal(life(f, child).privateAcquisition, "deferred"); privateAbsent(f, child);
		const before = files(f, child), count = checkpoints(child), trace = fs.readFileSync(parentFile);
		policy(child, wanted, { forkPending: true }); await child.reload();
		assert.deepEqual(files(f, child), before); assert.equal(checkpoints(child), count);
		await denied(f, child, "deferred", true);
		assert.deepEqual(files(f, parent), source); assert.deepEqual(fs.readFileSync(parentFile), trace);
		assert.equal(life(f, parent).privateAcquisition, "unacquired"); privateAbsent(f, parent);
	});

	test("native owner Passive fence survives later Session policy without borrowing shared observation", { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes: ["cwd"] }));
		const s = (await f.createRuntime("new")).session;
		assert.notEqual((await patch(f, s, ["cwd"], "SHARED_SOURCE_SENTINEL", ["cwd"])).result.isError, true);
		assert.equal(life(f, s).privateAcquisition, "unacquired"); privateAbsent(f, s);
		const before = files(f, s), count = checkpoints(s);
		policy(s, ["cwd"], { at: 2, persistenceError: "DENIAL54_OWNER_FENCE" });
		policy(s, wanted); await s.reload();
		assert.deepEqual(files(f, s), before); assert.equal(checkpoints(s), count);
		await denied(f, s, "unacquired", true);
	});
}

{
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
		assert.deepEqual(h.entries.map(({ data }) => data), [{ version: 2, owner: "harness-session", mode: "off", scopes: DEFAULT_SCOPE_SELECTION }]);
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
		assert.throws(() => h.readState(), /temporal runtime is unavailable|State Flow selected branch is unavailable/);
	});

	test("explicit Passive acquires the deferred retained boundary and persists its mode", async () => {
		const { resumed: h } = await offBranch();
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
		assert.equal(h.resolveSnapshot().config.mode, "passive");
		assert.equal(h.activeTools.includes("read_state"), true);
		await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
		assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
		assert.equal(h.resolveSnapshot().config.mode, "passive");
	});

	test("explicit Active from a deferred Off branch does not rewind current private memory to an older valid boundary", async () => {
		const { source, resumed: h } = await offBranch();
		await source.commands.get("state-flow-active")!.handler("", source.ctx);
		await source.tools.get("patch_state")!.execute("new-current", { session: { tactics: { retained: "CURRENT" } } }, undefined, undefined, source.ctx);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal(h.readState(0, "session").tactics.retained, "CURRENT");
		assert.equal(h.resolveSnapshot().config.mode, "active");
	});

	test("a deferred old checkpoint never rewinds memory; explicit Passive or Active uses current same-session memory", async () => {
		const { resumed: h } = await offBranch();
		h.entries.at(-1)!.data.boundary = "outside-retained-window";
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(h.notifications, []);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
		assert.equal(h.resolveSnapshot().config.mode, "passive");
		await h.tools.get("patch_state")!.execute("passive", { session: { tactics: { passive: true } } }, undefined, undefined, h.ctx);
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
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
		assert.equal(h.readState(0, "session").tactics.retained, "PRIVATE");
		assert.equal(h.notifications.at(-1), "State Flow passive; memory writes resumed from current session memory.");
		const semantic = (cohort: ReturnType<typeof files>) => cohort.filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));
		assert.deepEqual(semantic(files()), semantic(before), "acceptance never rewinds current semantics");
		assert.equal(h.entries.at(-1)!.data.mode, "passive");
		assert.equal(typeof h.entries.at(-1)!.data.boundary, "string");
		await h.tools.get("patch_state")!.execute("writable", { session: { tactics: { writable: true } } }, undefined, undefined, h.ctx);
		assert.equal(h.readState(0, "session").tactics.writable, true);
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
		assert.equal(child.readState(0, "session").tactics.retained, "PARENT");
		assert.equal(child.resolveSnapshot().config.mode, "passive");
	});
}

{
	for (const logging of [false, true]) for (const attachment of ["new", "resume", "tree", "warm"] as const) {
		test(`automatic Off callbacks are memory-inert (logging=${logging}, attachment=${attachment})`, async (t) => {
			const root = mkdtempSync(join(tmpdir(), "state-flow-off-callbacks-"));
			t.after(() => rmSync(root, { recursive: true, force: true }));
			const agentDir = join(root, "agent"), repositoryRoot = join(root, "store");
			mkdirSync(repositoryRoot, { recursive: true });
			writeFileSync(join(repositoryRoot, "config.json"), JSON.stringify({ logging }));
			const options = { agentDir, repositoryRoot, initializeRepository: false };
			const source = harness(options);
			await start(source);
			await commitTerminal(source, {}, { private: "ACCEPTED" });
			const path = join(root, "SKILL.md");
			writeFileSync(path, "Source that Off must not hash or inspect");
			source.registerSkill(path);
			const read = { toolCallId: "queued-read", toolName: "read", args: { path }, input: { path }, isError: false };
			source.handlers.get("tool_execution_start")!(read, source.ctx);
			source.handlers.get("tool_call")!(read, source.ctx);
			await source.commands.get("state-flow-off")!.handler("", source.ctx);
			const h = attachment === "warm" ? source : harness({ ...options, ...(attachment === "new" ? { sessionId: "new-owner" } : {}) });
			if (attachment !== "new" && h !== source) h.entries.push(...structuredClone(source.entries));
			h.registerSkill(path);
			const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot);
			const notices = [...h.notifications];
			await withoutStoreIO(t, root, async () => {
				if (attachment === "tree") await h.handlers.get("session_tree")!({}, h.ctx);
				else if (attachment !== "warm") await h.handlers.get("session_start")!({ reason: attachment }, h.ctx);
				const entries = structuredClone(h.entries);
				const sections: Record<string, string> = {};
				h.handlers.get("before_agent_start")!({ prompt: "Ordinary Off chat", systemPromptOptions: { sections } }, h.ctx);
				assert.deepEqual(sections, {});
				const messages = [{ role: "user", content: "Keep native conversation", timestamp: 1 }];
				assert.equal(await h.handlers.get("context")!({ messages }, h.ctx), undefined);
				assert.deepEqual(h.handlers.get("context_with_system")!({ messages }, h.ctx).messages, messages);
				h.handlers.get("tool_execution_start")!(read, h.ctx);
				assert.equal(h.handlers.get("tool_call")!(read, h.ctx), undefined);
				h.handlers.get("tool_execution_end")!(read, h.ctx);
				assert.equal(h.handlers.get("tool_result")!({ ...read, content: [{ type: "text", text: "Read body" }] }, h.ctx), undefined);
				for (const stopReason of ["stop", "aborted", "error", "length", "toolUse"]) {
					const message = { role: "assistant", stopReason, content: [{ type: "text", text: "Ordinary answer" }] };
					h.handlers.get("message_end")!({ message }, h.ctx);
					await h.handlers.get("turn_end")!({ message }, h.ctx);
				}
				await assert.rejects(h.tools.get("read_state")!.execute("queued-memory-read", { path: "session.tactics.private" }), /tools are off/);
				await assert.rejects(h.tools.get("patch_state")!.execute("queued-memory-patch", { session: { tactics: { unexpected: true } } }, undefined, undefined, h.ctx), /tools are off/);
				assert.equal(h.handlers.get("session_before_compact")!({ reason: "manual", customInstructions: "ordinary user request" }, h.ctx), undefined);
				h.handlers.get("session_compact")!({}, h.ctx);
				await h.handlers.get("agent_before_settle")!({}, h.ctx);
				await h.handlers.get("agent_settled")!({}, h.ctx);
				assert.deepEqual(h.entries, entries);
				assert.equal(h.compactRequests.length, 0);
				assert.equal(h.activeTools.includes("read_state"), false);
				await h.handlers.get("session_shutdown")!({}, h.ctx);
			});
			assert.deepEqual(h.notifications, notices);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot), files);
		});
	}
}

{
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
		const selected = prepareSelectedBranchPolicy(h.entries, {
			owner: h.ctx.sessionManager.getSessionId(), markerEntryType: "state-flow-passive-stop",
			defaults: { mode: "off", scopes: ["global", "cwd", "session"] },
		});
		return { mode: selected.mode };
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
			await peer.tools.get("patch_state")!.execute("peer", { session: { tactics: { retained: "PEER" } } }, undefined, undefined, peer.ctx);
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
		assert.deepEqual(JSON.parse(readFileSync(paths.config, "utf8")), { mode: "active", scopes: ["global", "cwd", "session"] }, "native Off need not rewrite canonical runtime policy");
		if (fault === "locked") rmSync(lock, { recursive: true });
		if (fault === "peer-advanced") {
			await h.commands.get("state-flow-active")!.handler("", h.ctx);
			assert.equal(h.readState(0, "session").tactics.retained, "PEER");
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
		else if (kind === "patch") operation = h.tools.get("patch_state")!.execute("pending", { session: { tactics: { forbidden: true } } }, undefined, undefined, h.ctx);
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
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		const peer = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
		await peer.withSelectedCurrentTransaction(["global", "cwd", "session"], (_current, publish) => publish(), () => {});
		const advances = history === "expired" ? 9 : 1;
		for (let index = 1; index <= advances; index++) await peer.withSelectedPatchTransaction((tx) => {
			const stage = stageSelectedScopePatches(tx, { session: { tactics: { retained: `CURRENT-${index}` } } }, [], tx.causalBasis);
			commitSelectedTransition(tx.snapshot, tx, stage, (accepted, next) => tx.publish(next, accepted, stage.provenanceUpdates), tx.causalBasis);
		}, () => {});
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
			assert.equal(h.readState(0, "session").tactics.retained, `CURRENT-${advances}`);
			assert.equal(policy(h)?.mode, "active");
		} else {
			// Memory is the current JSON state regardless of the deferred Pi step.
			assert.equal(h.readState(0, "session").tactics.retained, `CURRENT-${advances}`);
			assert.deepEqual(policy(h), { mode: "passive" });
			await h.tools.get("patch_state")!.execute("after-recovery", { session: { tactics: { writable: true } } }, undefined, undefined, h.ctx);
			assert.equal(h.readState(0, "session").tactics.writable, true);
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
		assert.equal(child.readState(0, "session").tactics.retained, "SELECTED-PARENT");
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
			await source.tools.get("patch_state")!.execute(`expire-${index}`, { session: { tactics: { index } } }, undefined, undefined, source.ctx);
		}
		await fenced.commands.get("state-flow-passive")!.handler("", fenced.ctx);
		// The fork copies the parent's current memory; an old fork step cannot fence the child.
		assert.equal(fenced.readState(0, "session").tactics.index, 8);
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
}

{
	function assertPassiveProjection(context: Context) {
		let heads = 0;
		for (const message of context.messages) {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part.type !== "text") continue;
				if (message.role === "user" && /^State Flow (exit handoff|passive memory|context update) \(/.test(part.text)) {
					const payload = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1));
					if (payload.state) {
						heads++;
						assert.equal(Object.hasOwn(payload.state, "response"), false);
						assert.equal(payload.state.tactics.seed, true);
					}
					for (const entry of payload.state_updates?.effective ?? []) assert.notEqual(entry.path[0], "response");
				}
				if (message.role === "toolResult" && message.toolName === "patch_state" && part.text.trim().startsWith('{"state_updates"')) {
					for (const entry of JSON.parse(part.text).state_updates.effective) assert.notEqual(entry.path[0], "response");
				}
			}
		}
		assert.ok(heads > 0, "Passive must keep memory, not silently disable projection");
	}

	for (const entry of ["stop", "reload", "initial"] as const) {
		test(`real Pi Passive omits stored response across barriers and reactivation (${entry})`, async (t) => {
			const fixture = await realPiFixture(t, { initializeRepository: false, mode: entry === "initial" ? "passive" : "active" });
			if (entry === "initial") writeGlobalState({ ...emptyState(), response: "LAST_ACTIVE_RESPONSE", tactics: { seed: true } }, fixture.repositoryRoot);
			const session = await fixture.createSession("new");
			if (entry !== "initial") {
				fixture.faux.setResponses([
					fauxAssistantMessage(fauxToolCall("patch_state", { session: { tactics: { seed: true } } }), { stopReason: "toolUse" }),
					fauxAssistantMessage("LAST_ACTIVE_RESPONSE"),
				]);
				await session.prompt("Seed Active memory");
				await session.prompt("/state-flow-passive");
			}
			assert.equal(fixture.readState(session).response, "LAST_ACTIVE_RESPONSE");
			if (entry === "reload") await session.reload();
			let observed = 0;
			fixture.faux.setResponses([
				(context) => {
					assertPassiveProjection(context); observed++;
					return fauxAssistantMessage(fauxToolCall("patch_state", { session: { tactics: { passive: true } } }), { stopReason: "toolUse" });
				},
				(context) => {
					assertPassiveProjection(context); observed++;
					return fauxAssistantMessage(fauxToolCall("read_state", { path: "effective.response" }), { stopReason: "toolUse" });
				},
				(context) => {
					assertPassiveProjection(context); observed++;
					const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read_state");
					assert.ok(result?.role === "toolResult");
					assert.match(JSON.stringify(result.content), /LAST_ACTIVE_RESPONSE/, "explicit exact reads are not redacted");
					return fauxAssistantMessage("Passive answer");
				},
			]);
			await session.prompt("Continue in Passive");
			assert.equal(observed, 3, "provider assertions must not be swallowed");
			const passiveAnswer = session.messages.at(-1);
			assert.ok(passiveAnswer?.role === "assistant");
			assert.deepEqual(passiveAnswer.content, [{ type: "text", text: "Passive answer" }]);
			assert.equal(fixture.readState(session).response, "LAST_ACTIVE_RESPONSE", "projection never deletes canonical response");
			assert.equal(fixture.readState(session).tactics.passive, true);
			await session.prompt("/state-flow-active");
			let activeObserved = false;
			fixture.faux.setResponses([(context) => {
				const head = context.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
					? message.content.filter((part) => part.type === "text" && part.text.startsWith("State Flow runtime context")) : [])[0];
				assert.ok(head?.type === "text");
				const payload = JSON.parse(head.text.slice(head.text.indexOf("\n") + 1));
				assert.equal(payload.state.response, "LAST_ACTIVE_RESPONSE");
				activeObserved = true;
				return fauxAssistantMessage("Active again");
			}]);
			await session.prompt("Continue in Active");
			assert.equal(activeObserved, true);
			const activeAnswer = session.messages.at(-1);
			assert.ok(activeAnswer?.role === "assistant");
			assert.deepEqual(activeAnswer.content, [{ type: "text", text: "Active again" }]);
			assert.equal(fixture.readState(session).response, "Active again");
		});
	}
}

{
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native request did not settle while foreign exclusion remained held")), 5000); })]).finally(() => clearTimeout(timer));
	}

	for (const late of ["patch", "answer"] as const) test(`real Pi does not reinterpret an old ${late} under Active after an in-flight mode ABA`, async t => {
		let session!: AgentSession, changed = false;
		const sequence: string[] = [];
		const f = await realPiFixture(t, { initializeRepository: false, mode: "active", tools: ["read", "patch_state", "read_state"], extensions: [{ name: "native-order", factory(pi) {
			pi.on("turn_start", () => { sequence.push("turn_start"); });
			pi.on("context", () => { sequence.push("context"); });
			pi.on("message_end", event => { if (event.message.role === "assistant") sequence.push("assistant_end"); });
			pi.on("tool_execution_start", () => { sequence.push("tool_start"); });
			pi.on("tool_call", () => { sequence.push("tool_call"); });
		} }] });
		session = await f.createSession("new");
		const source = join(f.cwd, "foreign.txt"); writeFileSync(source, "FOREIGN TOOL STILL RUNS");
		f.faux.setResponses([async () => {
			await session.prompt("/state-flow-off"); await session.prompt("/state-flow-active"); changed = true;
			return late === "patch" ? fauxAssistantMessage([
				fauxToolCall("patch_state", { session: { strategy: { staleBatch: true } } }, { id: "late-owned" }),
				fauxToolCall("read", { path: source }, { id: "foreign-read" }),
			], { stopReason: "toolUse" }) : fauxAssistantMessage("STALE ANSWER MUST NOT CAPTURE");
		}, fauxAssistantMessage("Fresh native response")]);
		await deadline(session.prompt("Choose a request policy"));
		assert.equal(changed, true);
		assert.equal(f.readState(session, 0, "session").strategy.staleBatch, undefined);
		assert.notEqual(f.readState(session, 0, "session").response, "STALE ANSWER MUST NOT CAPTURE");
		assert.ok(sequence.indexOf("turn_start") < sequence.indexOf("context"));
		if (late === "patch") {
			const results = session.messages.filter(message => message.role === "toolResult");
			const stale = results.find(message => message.toolCallId === "late-owned")!;
			assert.equal(stale.isError, true); assert.match(JSON.stringify(stale.content), /no current native request/);
			assert.equal(results.find(message => message.toolCallId === "foreign-read")!.isError, false, "a stale State Flow barrier must not acquire authority over foreign tools");
			assert.ok(sequence.indexOf("assistant_end") < sequence.indexOf("tool_start"));
			assert.equal(f.readState(session, 0, "session").response, "Fresh native response");
		}
	});

	test("real Pi rechecks the original request after a later permission handler changes mode and never logs stale arguments", async t => {
		let session!: AgentSession, changed = false;
		const f = await realPiFixture(t, { initializeRepository: false, mode: "active", extensions: [{ name: "later-permission", factory(pi) {
			pi.on("tool_call", async event => {
				if (event.toolCallId !== "approved-then-stale") return;
				await session.prompt("/state-flow-off"); await session.prompt("/state-flow-active"); changed = true;
			});
		} }] });
		writeFileSync(join(f.repositoryRoot, "config.json"), JSON.stringify({ logging: true }));
		session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", { session: { strategy: { privateStaleArgument: true } } }, { id: "approved-then-stale" }), { stopReason: "toolUse" }), fauxAssistantMessage("Current response")]);
		await deadline(session.prompt("Wait for permission"));
		assert.equal(changed, true); assert.equal(f.readState(session, 0, "session").strategy.privateStaleArgument, undefined);
		const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "approved-then-stale");
		assert.ok(result?.role === "toolResult" && result.isError); assert.match(JSON.stringify(result.content), /no longer current|no current native request/);
		assert.equal(existsSync(stateFlowLogPath(f.agentDir)), false, "stale admission is rejected before argument/snapshot diagnostics");
	});

	for (const mode of ["active", "passive"] as const) test(`real Pi ${mode} nested reads/patches preserve explicit-parent proof and the mode-specific barrier`, async t => {
		let observed: { read: boolean; patch: boolean } | undefined;
		const f = await realPiFixture(t, { initializeRepository: false, mode, tools: ["nested-memory", "patch_state", "read_state"], extensions: [{ name: "nested-memory", factory(pi) {
			pi.registerTool({ name: "nested-memory", label: "Nested memory", description: "Fixture nested tool calls", parameters: Type.Object({}),
				async execute(_id, _args, signal, _update, ctx) {
					const read = await ctx.executeTool("read_state", { path: "strategy" }, { signal });
					const patch = await ctx.executeTool("patch_state", { session: { strategy: { nestedMutation: true } } }, { signal });
					observed = { read: !read.isError, patch: !patch.isError };
					return { content: [{ type: "text", text: "Nested results observed" }], details: undefined };
				},
			});
		} }] });
		const session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", { session: { strategy: { seed: true } } }), { stopReason: "toolUse" }), fauxAssistantMessage("Seed")]);
		await session.prompt("Seed memory");
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("nested-memory", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Nested complete")]);
		await session.prompt("Nested inspection");
		assert.deepEqual(observed, { read: true, patch: mode === "passive" }); assert.equal(f.readState(session, 0, "session").strategy.nestedMutation, mode === "passive" ? true : undefined);
	});

	test("real Pi patch wait withdraws before foreign lock release, then a fresh native batch accepts", async t => {
		let locked = false, waiting!: () => void, session!: AgentSession;
		const wait = new Promise<void>(resolve => { waiting = resolve; });
		let lock = "", basis: ReturnType<typeof captureTemporalFileBases> | undefined;
		const f = await realPiFixture(t, { initializeRepository: false, mode: "active", extensions: [{ name: "hold-native-patch", factory(pi) {
			pi.on("message_end", event => {
				if (event.message.role !== "assistant" || !event.message.content.some(block => block.type === "toolCall" && block.id === "held-patch")) return;
				basis = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
				writeFileSync(lock, `${process.pid}\n`); locked = true;
			});
		} }] });
		session = await f.createSession("new"); lock = join(f.repositoryRoot, ".state-flow-publication.lock");
		const open = fs.openSync;
		fs.openSync = ((path: fs.PathLike, flags: string | number, ...args: any[]) => {
			try { return (open as any)(path, flags, ...args); }
			finally { if (locked && path === lock && flags === "wx") { locked = false; waiting(); } }
		}) as typeof fs.openSync; syncBuiltinESMExports();
		let pending: Promise<void> | undefined;
		try {
			f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", { session: { strategy: { obsolete: true } } }, { id: "held-patch" }), { stopReason: "toolUse" }), fauxAssistantMessage("Continue natively under Off")]);
			pending = session.prompt("Wait to patch"); await deadline(wait);
			await session.prompt("/state-flow-off"); await deadline(pending);
			assert.equal(existsSync(lock), true);
			assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), basis);
			const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "held-patch");
			assert.ok(result?.role === "toolResult" && result.isError);
			assert.match(JSON.stringify(result.content), /abort|cancel|policy/i);
		} finally {
			fs.openSync = open; syncBuiltinESMExports(); if (existsSync(lock)) rmSync(lock); await pending;
		}
		await session.prompt("/state-flow-active");
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("patch_state", { session: { strategy: { fresh: true } } }, { id: "fresh-patch" }), { stopReason: "toolUse" }), fauxAssistantMessage("Accepted")]);
		await session.prompt("Fresh policy request");
		assert.equal(f.readState(session, 0, "session").strategy.obsolete, undefined); assert.equal(f.readState(session, 0, "session").strategy.fresh, true);
		assert.equal(readFileSync(session.sessionFile!, "utf8").includes("fresh-patch"), true);
	});
}

{
	function fixture(persisted = true) { return harness({ initializeRepository: false, mode: "passive", ...(persisted ? { sessionFile: "/tmp/native-query-owner.jsonl" } : {}), sessionTimestamp: "2026-10-24T00:00:00.000Z" }); }
	function address(h: ReturnType<typeof harness>) { return resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId(), h.ctx.sessionManager.getHeader()?.timestamp); }
	function files(h: ReturnType<typeof harness>) { return captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, address(h).key); }
	async function accepted(persisted = true) {
		const h = fixture(persisted); await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await h.tools.get("patch_state")!.execute("seed-query-owner", { cwd: { tactics: { sharedQuery: "OWNED_CWD_QUERY" } }, session: { tactics: { privateQuery: "OWNER_A_PRIVATE_V1" } } }, undefined, undefined, h.ctx);
		await h.tools.get("patch_state")!.execute("advance-query-owner", { session: { tactics: { privateQuery: "OWNER_A_PRIVATE_V2" } } }, undefined, undefined, h.ctx);
		return h;
	}
	function foreignContexts(h: ReturnType<typeof harness>) {
		return [
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "different-native-owner" } },
			{ ...h.ctx, cwd: join(h.repositoryRoot, "foreign-cwd") },
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => join(h.repositoryRoot, "foreign-native.jsonl") } },
		];
	}

	test("native queries reject foreign owner/CWD/storage-file keys before parameters or view materialization", async t => {
		const h = await accepted(), before = files(h), entries = structuredClone(h.entries);
		let views = 0, parameters = 0;
		for (const name of ["selectedView", "observedSelectedView"] as const) {
			const original = TemporalRuntime.prototype[name];
			t.mock.method(TemporalRuntime.prototype, name, function(this: TemporalRuntime) { views++; return Reflect.apply(original, this, []); });
		}
		const shapes = [
			{ path: "session.tactics.privateQuery" }, { path: "session[1].tactics.privateQuery" },
			{ paths: ["cwd.tactics.sharedQuery", "session.tactics.privateQuery"] },
			{ path: "session.tactics", projection: "keys" }, { path: "effective.tactics", projection: "patch" }, { path: "session.patches[0]" },
		];
		for (const ctx of foreignContexts(h)) {
			for (const params of shapes) await assert.rejects(h.tools.get("read_state")!.execute("foreign-context-query", params, undefined, undefined, ctx), /read selection owner changed/);
			const params = { get path() { parameters++; return "session.tactics.privateQuery"; } };
			await assert.rejects(h.tools.get("read_state")!.execute("foreign-parameter-query", params, undefined, undefined, ctx), /read selection owner changed/);
		}
		assert.equal(parameters, 0); assert.equal(views, 0);
		assert.deepEqual(files(h), before); assert.deepEqual(h.entries, entries);
	});

	test("in-memory native query identity binds immutable header timestamp before any parameter access", async () => {
		const h = await accepted(false), before = files(h); let parameters = 0;
		const foreign = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getHeader: () => ({ ...h.ctx.sessionManager.getHeader()!, timestamp: "2026-10-24T01:00:00.000Z" }) } };
		await assert.rejects(h.tools.get("read_state")!.execute("foreign-in-memory-query", { get path() { parameters++; return "session.tactics.privateQuery"; } }, undefined, undefined, foreign), /read selection owner changed/);
		assert.equal(parameters, 0); assert.deepEqual(files(h), before);
	});

	test("same-physical cloned native contexts retain exact current/historical/batch/keys/patch query paths without writes", async () => {
		const h = await accepted(), before = files(h), entries = structuredClone(h.entries), ctx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } };
		const read = (params: unknown) => h.tools.get("read_state")!.execute("owned-context-query", params, undefined, undefined, ctx);
		assert.match(JSON.stringify(await read({ path: "session.tactics.privateQuery" })), /OWNER_A_PRIVATE_V2/);
		const historical = JSON.stringify(await read({ path: "session[1].tactics.privateQuery" })); assert.match(historical, /OWNER_A_PRIVATE_V1/); assert.doesNotMatch(historical, /OWNER_A_PRIVATE_V2/);
		assert.match(JSON.stringify(await read({ paths: ["cwd.tactics.sharedQuery", "session.tactics.privateQuery"] })), /OWNED_CWD_QUERY/);
		assert.match(JSON.stringify(await read({ path: "session.tactics", projection: "keys" })), /privateQuery/);
		assert.match(JSON.stringify(await read({ path: "effective.tactics", projection: "patch" })), /OWNER_A_PRIVATE_V2/);
		assert.match(JSON.stringify(await read({ path: "session.patches[0]" })), /OWNER_A_PRIVATE_V2/);
		assert.deepEqual(files(h), before); assert.deepEqual(h.entries, entries);
	});

	test("finalized original native query receipt cannot be borrowed by foreign context or reused after refusal", async () => {
		const h = await accepted();
		h.handlers.get("turn_start")!({}, h.ctx);
		h.handlers.get("message_end")!({ message: { role: "assistant", content: [
			{ type: "toolCall", id: "foreign-original-query", name: "read_state" },
			{ type: "toolCall", id: "owned-original-query", name: "read_state" },
		] } }, h.ctx);
		const before = files(h), params = { path: "session.tactics.privateQuery" }, read = h.tools.get("read_state")!;
		await assert.rejects(read.execute("foreign-original-query", params, undefined, undefined, foreignContexts(h)[2]), /read selection owner changed/);
		await assert.rejects(read.execute("foreign-original-query", params, undefined, undefined, h.ctx), /native request|already|current/i);
		assert.match(JSON.stringify(await read.execute("owned-original-query", params, undefined, undefined, h.ctx)), /OWNER_A_PRIVATE_V2/);
		await assert.rejects(read.execute("owned-original-query", params, undefined, undefined, h.ctx), /native request|already|current/i);
		assert.deepEqual(files(h), before);
	});

	test("same-owner observed shared query remains read-only and cannot fabricate unavailable private memory", async () => {
		const h = fixture(), a = address(h), source = new TemporalRuntime(h.ctx.cwd, a, h.repositoryRoot);
		await source.withSelectedSharedOriginTransaction(["cwd"], { config: { mode: "passive" }, meta: { step: 0 } }, publish => publish(), undefined, true);
		await source.withSelectedPatchTransaction(tx => tx.publish({ config: { mode: "passive" }, meta: { step: 1 } }, { id: "observed-query-source", transitions: [{ scope: "cwd", patch: { tactics: { observedQuery: "READ_ONLY_OBSERVED_QUERY" } } }] }), () => {});
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const before = files(h), entries = structuredClone(h.entries), read = h.tools.get("read_state")!;
		assert.match(JSON.stringify(await read.execute("observed-query", { path: "cwd.tactics.observedQuery" }, undefined, undefined, h.ctx)), /READ_ONLY_OBSERVED_QUERY/);
		await assert.rejects(read.execute("unavailable-private-query", { path: "session.tactics" }, undefined, undefined, h.ctx), /excluded|selected|unavailable/i);
		await assert.rejects(read.execute("foreign-observed-query", { path: "cwd.tactics.observedQuery" }, undefined, undefined, foreignContexts(h)[0]), /read selection owner changed/);
		assert.deepEqual(files(h), before); assert.deepEqual(h.entries, entries);
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(h.ctx.cwd, source.sessionId, h.repositoryRoot, a.key).runtime, "utf8")).privateAcquisition, "unacquired");
	});

	test("cancelled and non-original signalled native queries reject before parameter access", async () => {
		const h = await accepted(), before = files(h), controller = new AbortController(); controller.abort(); let parameters = 0;
		const params = { get path() { parameters++; return "session.tactics.privateQuery"; } }, read = h.tools.get("read_state")!;
		await assert.rejects(read.execute("cancelled-query", params, controller.signal, undefined, h.ctx), /aborted/i);
		await assert.rejects(read.execute("unbound-model-query", params, undefined, undefined, { ...h.ctx, signal: new AbortController().signal }), /native request/i);
		await assert.rejects(read.execute("missing-native-context", params, undefined, undefined, undefined), /read selection owner changed/);
		assert.equal(parameters, 0); assert.deepEqual(files(h), before);
	});

	test("read-only query under a Passive write fence retains same-owner view without granting publication", async t => {
		const h = await accepted(); await h.commands.get("state-flow-active")!.handler("", h.ctx);
		t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive", () => { throw new Error("test query write fence"); });
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		assert.ok(h.entries.some(entry => entry.data?.persistenceError));
		const before = files(h), entries = structuredClone(h.entries);
		assert.match(JSON.stringify(await h.tools.get("read_state")!.execute("fenced-read", { path: "session.tactics.privateQuery" }, undefined, undefined, h.ctx)), /OWNER_A_PRIVATE_V2/);
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced-write", { session: { tactics: { forbidden: true } } }, undefined, undefined, h.ctx), /paused|fence/i);
		assert.deepEqual(files(h), before); assert.deepEqual(h.entries, entries);
	});

	for (const name of ["read_state", "patch_state"] as const) test(`new policy owner cannot borrow old runtime native identity through ${name} even at the same storage key`, async t => {
		const h = await accepted(), before = files(h);
		let batch!: NativeToolRequestCorrelation;
		const begin = NativeToolRequestCorrelation.prototype.begin;
		t.mock.method(NativeToolRequestCorrelation.prototype, "begin", function(this: NativeToolRequestCorrelation, ...args: Parameters<typeof begin>) { batch = this; return Reflect.apply(begin, this, args); });
		const other = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager,
			getSessionId: () => "new-policy-owner-B",
			getHeader: () => ({ ...h.ctx.sessionManager.getHeader()!, id: "new-policy-owner-B" }),
		} };
		// Native handler fault: new owner policy/receipt but restoration has not replaced the old runtime.
		// The storage file stem intentionally stays equal, so neither file-key nor policy/caller equality proves runtime ownership.
		h.handlers.get("turn_start")!({}, other);
		h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "rebound-owner-tool", name }] } }, other);
		assert.throws(() => batch.current(), /no current native request/);
		// Callback admission now refuses this earlier. Explicit lower-correlation adapter fault
		// keeps the independent callee guard exercised with real B policy/receipt and original ID.
		batch.finalize([{ id: "rebound-owner-tool", name }]);
		const params = name === "read_state" ? { path: "session.tactics.privateQuery" } : { session: { tactics: { privateQuery: "BORROWED_RUNTIME_OWNER" } } };
		await assert.rejects(h.tools.get(name)!.execute("rebound-owner-tool", params, undefined, undefined, other), /selection owner changed/);
		assert.deepEqual(files(h), before); assert.equal(h.readState(0, "session").tactics.privateQuery, "OWNER_A_PRIVATE_V2");
	});
}

{
	async function active() {
		const h = harness({ initializeRepository: false, mode: "active", sessionFile: "/tmp/native-response-owner.jsonl", sessionTimestamp: "2026-10-24T00:00:00.000Z" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx); return h;
	}
	function bytes(h: ReturnType<typeof harness>) {
		const a = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId(), h.ctx.sessionManager.getHeader()?.timestamp);
		return captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, a.key);
	}
	function foreign(h: ReturnType<typeof harness>) {
		return [
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "foreign-answer-owner" } },
			{ ...h.ctx, cwd: join(h.repositoryRoot, "foreign-answer-cwd") },
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/tmp/foreign-answer.jsonl" } },
		];
	}
	function answer(text: string) { return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }; }
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("response did not enter selected transaction")), 3000); })]).finally(() => clearTimeout(timer));
	}
	async function hold(t: TestContext, root: string) {
		mkdirSync(root, { recursive: true }); let entered!: () => void, release!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release()); const task = withStorageTransaction(root, async () => { entered(); await gate; }); await ready;
		return async () => { release(); await task; };
	}

	test("foreign ordinary assistant completion cannot publish or touch its message before physical owner admission", async t => {
		const h = await active(), before = bytes(h), entries = structuredClone(h.entries); let messages = 0, views = 0;
		const view = TemporalRuntime.prototype.selectedView;
		t.mock.method(TemporalRuntime.prototype, "selectedView", function(this: TemporalRuntime) { views++; return Reflect.apply(view, this, []); });
		for (const ctx of foreign(h)) {
			const event = { get message() { messages++; return answer("FOREIGN_ANSWER_MUST_NOT_PERSIST"); } };
			h.handlers.get("message_end")!(event, ctx); await h.handlers.get("turn_end")!(event, ctx);
		}
		assert.equal(messages, 0); assert.equal(views, 0); assert.deepEqual(bytes(h), before); assert.deepEqual(h.entries, entries);
	});

	test("foreign completion cannot cancel or spend rightful pending response; turn_end supplies the actual finalized answer", async () => {
		const h = await active(), before = bytes(h);
		h.handlers.get("message_end")!({ message: answer("PRE_HANDLER_ANSWER") }, h.ctx);
		for (const ctx of [...foreign(h), { ...h.ctx, signal: new AbortController().signal }]) {
			for (const message of [answer("FOREIGN_RESPONSE"), { ...answer("foreign tool batch"), stopReason: "toolUse" }, { ...answer("foreign error"), stopReason: "error" }]) h.handlers.get("message_end")!({ message }, ctx);
			await h.handlers.get("turn_end")!({ message: answer("FOREIGN_RESPONSE") }, ctx);
		}
		assert.deepEqual(bytes(h), before);
		await h.handlers.get("turn_end")!({ message: answer("FINAL_POST_HANDLER_ANSWER") }, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } });
		assert.equal(h.readState(0, "session").response, "FINAL_POST_HANDLER_ANSWER");
	});

	test("foreign message/turn ends cannot finalize or end the rightful original native tool batch", async () => {
		const h = await active(), ctx = { ...h.ctx, signal: new AbortController().signal };
		h.handlers.get("turn_start")!({}, ctx);
		for (const wrong of [...foreign(h).map(value => ({ ...value, signal: ctx.signal })), { ...ctx, signal: new AbortController().signal }]) {
			h.handlers.get("message_end")!({ message: answer("FOREIGN_NATIVE_COMPLETION") }, wrong);
			await h.handlers.get("turn_end")!({ message: answer("FOREIGN_NATIVE_COMPLETION") }, wrong);
		}
		h.handlers.get("message_end")!({ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "rightful-original-patch", name: "patch_state" }] } }, ctx);
		await h.tools.get("patch_state")!.execute("rightful-original-patch", { session: { tactics: { rightfulBatch: true } } }, undefined, undefined, ctx);
		assert.equal(h.readState(0, "session").tactics.rightfulBatch, true);
		await h.handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "toolUse", content: [] } }, ctx);
	});

	test("policy/caller rebind at the same storage key cannot borrow old runtime response ownership", async () => {
		const h = await active(), before = bytes(h), ctx = foreign(h)[0];
		h.handlers.get("turn_start")!({}, ctx);
		h.handlers.get("message_end")!({ message: answer("OWNER_B_CANNOT_PUBLISH_OWNER_A") }, ctx);
		await h.handlers.get("turn_end")!({ message: answer("OWNER_B_CANNOT_PUBLISH_OWNER_A") }, ctx);
		assert.deepEqual(bytes(h), before); assert.equal(h.readState(0, "session").response, "");
	});

	test("foreign message_end cannot cancel a rightful response already waiting for exclusion", async t => {
		const h = await active(), before = bytes(h), release = await hold(t, h.repositoryRoot);
		let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
		const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) { entered(); return Reflect.apply(patch, this, args); });
		h.handlers.get("message_end")!({ message: answer("OWNED_PENDING_RESPONSE") }, h.ctx);
		const pending = h.handlers.get("turn_end")!({ message: answer("RIGHTFUL_WAITING_RESPONSE") }, h.ctx); await deadline(ready);
		for (const ctx of foreign(h)) h.handlers.get("message_end")!({ message: answer("FOREIGN_CANNOT_CANCEL_PENDING") }, ctx);
		assert.deepEqual(bytes(h), before); await release(); await pending; spy.mock.restore();
		assert.equal(h.readState(0, "session").response, "RIGHTFUL_WAITING_RESPONSE");
	});

	test("response publication revalidates actual turn_end caller after exclusion wait without stale diagnostics", async t => {
		const h = await active(), before = bytes(h), notices = [...h.notifications], release = await hold(t, h.repositoryRoot);
		let owner = h.ctx.sessionManager.getSessionId();
		const ctx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => owner } };
		let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
		const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) { entered(); return Reflect.apply(patch, this, args); });
		h.handlers.get("message_end")!({ message: answer("ADMITTED_BEFORE_WAIT") }, h.ctx);
		const pending = h.handlers.get("turn_end")!({ message: answer("MUST_NOT_PERSIST_AFTER_CALLER_MOVES") }, ctx);
		await deadline(ready); owner = "different-turn-end-owner"; await release(); await pending; spy.mock.restore();
		assert.deepEqual(bytes(h), before); assert.deepEqual(h.notifications, notices);
		h.handlers.get("message_end")!({ message: answer("RECOVERED_OWN_RESPONSE") }, h.ctx);
		await h.handlers.get("turn_end")!({ message: answer("RECOVERED_OWN_RESPONSE") }, h.ctx);
		assert.equal(h.readState(0, "session").response, "RECOVERED_OWN_RESPONSE");
	});

	test("capture and actual end operation identity cannot move during exclusion even when A stays live", async t => {
		for (const moves of ["end", "capture"] as const) {
			const h = await active(), before = bytes(h), notices = [...h.notifications], release = await hold(t, h.repositoryRoot);
			const a = new AbortController(), b = new AbortController(); let captureSignal = a.signal, endSignal = a.signal;
			const capture = { ...h.ctx, get signal() { return captureSignal; } }, end = { ...h.ctx, get signal() { return endSignal; } };
			let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) { entered(); return Reflect.apply(patch, this, args); });
			h.handlers.get("turn_start")!({}, capture); h.handlers.get("message_end")!({ message: answer("CAPTURE_OPERATION_A") }, capture);
			const pending = h.handlers.get("turn_end")!({ message: answer("MOVED_END_OPERATION_MUST_NOT_PUBLISH") }, end); await deadline(ready);
			if (moves === "end") endSignal = b.signal; else captureSignal = b.signal;
			assert.equal(a.signal.aborted, false); assert.equal(b.signal.aborted, false);
			await release(); await pending; spy.mock.restore();
			assert.equal(h.readState(0, "session").response, "", `${moves} context moved to operation B without aborting A`);
			assert.deepEqual(bytes(h), before); assert.deepEqual(h.notifications, notices);
		}
	});

	test("same-owner Passive and Off ordinary answers do not replace accepted Active response or publish semantic data", async () => {
		for (const mode of ["passive", "off"] as const) {
			const h = await active(); h.handlers.get("message_end")!({ message: answer("ACCEPTED_ACTIVE_ANSWER") }, h.ctx);
			await h.handlers.get("turn_end")!({ message: answer("ACCEPTED_ACTIVE_ANSWER") }, h.ctx);
			await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx); const before = bytes(h);
			h.handlers.get("message_end")!({ message: answer("INACTIVE_ANSWER_MUST_NOT_PERSIST") }, h.ctx);
			await h.handlers.get("turn_end")!({ message: answer("INACTIVE_ANSWER_MUST_NOT_PERSIST") }, h.ctx);
			assert.deepEqual(bytes(h), before);
		}
	});
}

{
	async function seeded(mode: "active" | "passive" = "passive") {
		const h = harness({ initializeRepository: false, mode, sessionFile: "/tmp/native-input-owner.jsonl", sessionTimestamp: "2026-10-24T00:00:00.000Z" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await h.tools.get("patch_state")!.execute("input-owner-seed", { session: { tactics: { privateInput: "OWNER_A_PRIVATE_INPUT" }, lazy: { privateBody: "LAZY_BODY_NOT_AUTOMATIC_INPUT" } } }, undefined, undefined, h.ctx); return h;
	}
	function bytes(h: ReturnType<typeof harness>) {
		const a = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId(), h.ctx.sessionManager.getHeader()?.timestamp);
		return captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, a.key);
	}
	function foreign(h: ReturnType<typeof harness>) {
		return [
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "foreign-input-owner" } },
			{ ...h.ctx, cwd: join(h.repositoryRoot, "foreign-input-cwd") },
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/tmp/foreign-input-file.jsonl" } },
		];
	}
	function prompt(text: string) { return { prompt: text, systemPrompt: "native system", systemPromptOptions: {} }; }
	function messages() { return [{ role: "user", content: "Owned native input", timestamp: 1 }]; }
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("input did not enter selected preparation")), 3000); })]).finally(() => clearTimeout(timer));
	}
	async function hold(t: TestContext, root: string) {
		mkdirSync(root, { recursive: true }); let entered!: () => void, release!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release()); const task = withStorageTransaction(root, async () => { entered(); await gate; }); await ready;
		return async () => { release(); await task; };
	}

	test("foreign context cannot receive Session projection or touch input/view/source refresh before owner admission", async t => {
		const h = await seeded(), before = bytes(h), entries = structuredClone(h.entries); let input = 0, views = 0, refreshes = 0;
		const view = TemporalRuntime.prototype.selectedView, refresh = ArtifactAcquisitionState.prototype.refresh;
		t.mock.method(TemporalRuntime.prototype, "selectedView", function(this: TemporalRuntime) { views++; return Reflect.apply(view, this, []); });
		t.mock.method(ArtifactAcquisitionState.prototype, "refresh", function(this: ArtifactAcquisitionState, ...args: Parameters<typeof refresh>) { refreshes++; return Reflect.apply(refresh, this, args); });
		for (const ctx of foreign(h)) assert.equal(await h.handlers.get("context")!({ get messages() { input++; return messages(); } }, ctx), undefined);
		assert.equal(input, 0); assert.equal(views, 0); assert.equal(refreshes, 0); assert.deepEqual(bytes(h), before); assert.deepEqual(h.entries, entries);
	});

	test("frozen Stop handoff stays with its physical owner, and Off exposes no retained handoff", async () => {
		const h = await seeded("active"); await h.commands.get("state-flow-passive")!.handler("", h.ctx); const before = bytes(h);
		const own = await h.handlers.get("context")!({ messages: messages() }, h.ctx);
		assert.match(JSON.stringify(own), /OWNER_A_PRIVATE_INPUT/); assert.doesNotMatch(JSON.stringify(own), /LAZY_BODY_NOT_AUTOMATIC_INPUT/);
		for (const ctx of foreign(h)) assert.equal(await h.handlers.get("context")!({ messages: messages() }, ctx), undefined);
		assert.deepEqual(bytes(h), before);
		await h.commands.get("state-flow-off")!.handler("", h.ctx); const off = bytes(h);
		assert.equal(await h.handlers.get("context")!({ messages: messages() }, h.ctx), undefined); assert.deepEqual(bytes(h), off);
	});

	test("foreign before_agent_start cannot replace the rightful captured specification or mutate prompt sections", async () => {
		const h = await seeded("active"); h.handlers.get("before_agent_start")!(prompt("OWNED_SPECIFICATION"), h.ctx); let input = 0;
		for (const ctx of foreign(h)) h.handlers.get("before_agent_start")!({ get prompt() { input++; return "FOREIGN_SPECIFICATION"; }, get systemPromptOptions() { input++; return {}; } }, ctx);
		assert.equal(input, 0);
		const live = { ...h.ctx, signal: new AbortController().signal }; h.handlers.get("turn_start")!({}, live);
		await h.handlers.get("context")!({ messages: messages() }, live);
		const runtime = bytes(h).find(file => file.path.endsWith("/runtime.json"))!; assert.equal(JSON.parse(runtime.content!).specification, "OWNED_SPECIFICATION");
	});

	test("foreign system/transport context hooks skip payloads and abort while rightful original input still prepares", async () => {
		const h = await seeded("active"); let input = 0, aborts = 0;
		h.handlers.get("before_agent_start")!(prompt("ORIGINAL_INPUT_SPEC"), h.ctx);
		const live = { ...h.ctx, signal: new AbortController().signal, abort: () => { aborts++; } }; h.handlers.get("turn_start")!({}, live);
		for (const wrong of foreign(h)) {
			const ctx = { ...wrong, signal: live.signal, abort: live.abort };
			assert.equal(h.handlers.get("context_with_system")!({ get messages() { input++; return messages(); } }, ctx), undefined);
			h.handlers.get("before_provider_request")!({ get payload() { input++; return {}; } }, ctx);
		}
		assert.equal(input, 0); assert.equal(aborts, 0);
		const result = await h.handlers.get("context")!({ messages: messages() }, live); assert.match(JSON.stringify(result), /OWNER_A_PRIVATE_INPUT/);
		assert.equal(aborts, 0);
	});

	test("actual preparation caller and operation cannot move during exclusion or publish a stale specification", async t => {
		for (const moves of ["owner", "operation"] as const) {
			const h = await seeded("active"), before = bytes(h), notices = [...h.notifications], release = await hold(t, h.repositoryRoot);
			const a = new AbortController(), b = new AbortController(); let owner = h.ctx.sessionManager.getSessionId(), signal = a.signal, aborts = 0;
			const live = { ...h.ctx, signal: a.signal, abort: () => { aborts++; } };
			const actual = { ...h.ctx, get signal() { return signal; }, abort: live.abort, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => owner } };
			h.handlers.get("before_agent_start")!(prompt("OWNED_WAITING_SPEC"), h.ctx); h.handlers.get("turn_start")!({}, live);
			let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) { entered(); return Reflect.apply(patch, this, args); });
			const pending = h.handlers.get("context")!({ messages: messages() }, actual); await deadline(ready);
			if (moves === "owner") owner = "different-preparation-owner"; else signal = b.signal;
			await release(); assert.equal(await pending, undefined); spy.mock.restore();
			assert.deepEqual(bytes(h), before); assert.deepEqual(h.notifications, notices); assert.equal(a.signal.aborted, false); assert.equal(b.signal.aborted, false);
			// The next rightful post-context membrane must fence this unaccepted Active request,
			// rather than let a skipped foreign callback become native-history inference fallback.
			let system = 0; assert.equal(h.handlers.get("context_with_system")!({ get messages() { system++; return messages(); } }, live), undefined);
			assert.equal(system, 0); assert.ok(aborts > 0);
			await h.handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "toolUse", content: [] } }, live);
			const fresh = { ...h.ctx, signal: new AbortController().signal };
			h.handlers.get("before_agent_start")!(prompt("FRESH_OWNED_SPEC"), h.ctx); h.handlers.get("turn_start")!({}, fresh);
			assert.match(JSON.stringify(await h.handlers.get("context")!({ messages: messages() }, fresh)), /OWNER_A_PRIVATE_INPUT/);
		}
	});

	test("matching new policy/caller at the same file key cannot project the old runtime's private state", async () => {
		const h = await seeded(), before = bytes(h), ctx = foreign(h)[0]; let input = 0;
		h.handlers.get("turn_start")!({}, ctx);
		assert.equal(await h.handlers.get("context")!({ get messages() { input++; return messages(); } }, ctx), undefined);
		assert.equal(input, 0); assert.deepEqual(bytes(h), before);
	});

	test("same-physical cloned idle contexts retain read-only selected input and native user messages without publication", async () => {
		const h = await seeded(), before = bytes(h), entries = structuredClone(h.entries), input = messages(), original = structuredClone(input);
		const result = await h.handlers.get("context")!({ messages: input }, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } });
		assert.match(JSON.stringify(result), /OWNER_A_PRIVATE_INPUT/); assert.match(JSON.stringify(result), /Owned native input/); assert.doesNotMatch(JSON.stringify(result), /LAZY_BODY_NOT_AUTOMATIC_INPUT/);
		assert.deepEqual(input, original); assert.deepEqual(bytes(h), before); assert.deepEqual(h.entries, entries);
	});
}

{
	async function active() {
		const h = harness({ initializeRepository: false, mode: "active", sessionFile: "/tmp/native-source-owner.jsonl", sessionTimestamp: "2026-10-24T00:00:00.000Z" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const skill = join(h.repositoryRoot, "SKILL.md"), ordinary = join(h.repositoryRoot, "ordinary-source.md");
		writeFileSync(skill, "Owner A registered Skill body"); writeFileSync(ordinary, "Owner A ordinary source body"); h.registerSkill(skill, "project");
		await h.tools.get("patch_state")!.execute("register-ordinary-source", { cwd: { artifacts: { [ordinary]: { description: "Ordinary registered source" } } } }, undefined, undefined, h.ctx);
		return { h, skill, ordinary };
	}
	function files(h: Awaited<ReturnType<typeof active>>["h"]) {
		const key = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId(), h.ctx.sessionManager.getHeader()?.timestamp).key;
		return captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
	}
	function foreign(h: Awaited<ReturnType<typeof active>>["h"]) {
		return [
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "foreign-source-owner" } },
			{ ...h.ctx, cwd: join(h.repositoryRoot, "foreign-cwd") },
			{ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/tmp/foreign-source-context.jsonl" } },
		];
	}
	function noSourceIO<T>(paths: string[], action: () => T): T {
		const blocked = new Set(paths), attempts: string[] = [], saved = { lstatSync: fs.lstatSync, openSync: fs.openSync, readFileSync: fs.readFileSync };
		for (const name of Object.keys(saved) as Array<keyof typeof saved>) (fs as any)[name] = (...args: any[]) => {
			if (blocked.has(String(args[0]))) { attempts.push(`${name}:${String(args[0])}`); throw new Error("foreign source acquisition attempt"); }
			return Reflect.apply(saved[name], fs, args);
		};
		syncBuiltinESMExports();
		try { return action(); }
		finally { for (const name of Object.keys(saved) as Array<keyof typeof saved>) (fs as any)[name] = saved[name]; syncBuiltinESMExports(); assert.deepEqual(attempts, [], "caught hash/stat errors cannot hide attempts"); }
	}
	function finalized(h: Awaited<ReturnType<typeof active>>["h"], ids: string[]) {
		h.handlers.get("turn_start")!({}, h.ctx);
		h.handlers.get("message_end")!({ message: { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "read" })) } }, h.ctx);
	}

	test("foreign source callbacks with raw or original IDs ignore tool inputs before source work or hints", async () => {
		for (const original of [false, true]) {
			const { h, skill, ordinary } = await active();
			if (original) finalized(h, ["foreign-source-read"]);
			const before = files(h), entries = structuredClone(h.entries); let inputs = 0;
			noSourceIO([skill, ordinary], () => {
				for (const ctx of foreign(h)) {
					for (const [name, key] of [["tool_execution_start", "args"], ["tool_call", "input"], ["tool_result", "input"]] as const) {
						const event = { toolCallId: "foreign-source-read", toolName: "read", isError: false, content: [], get [key]() { inputs++; return { path: skill }; } };
						assert.equal(h.handlers.get(name)!(event, ctx), undefined);
					}
					h.handlers.get("tool_execution_end")!({ toolCallId: "foreign-source-read", toolName: "read", isError: false }, ctx);
				}
			});
			// Explicit native-handler fault: policy/caller rebind to B at the same file key must not borrow runtime A.
			const rebound = foreign(h)[0]; h.handlers.get("turn_start")!({}, rebound);
			h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "rebound-source-read", name: "read" }] } }, rebound);
			noSourceIO([skill, ordinary], () => assert.equal(h.handlers.get("tool_result")!({ toolCallId: "rebound-source-read", toolName: "read", isError: false, content: [], get input() { inputs++; return { path: skill }; } }, rebound), undefined));
			assert.equal(inputs, 0); assert.deepEqual(files(h), before); assert.deepEqual(h.entries, entries);
		}
	});

	test("foreign end cannot consume legitimate ordinary or Skill pending reads; owned end retains source evidence", async t => {
		let state!: ArtifactAcquisitionState, skills!: SkillReadTracker;
		const refresh = ArtifactAcquisitionState.prototype.refresh, clear = SkillReadTracker.prototype.clear;
		t.mock.method(ArtifactAcquisitionState.prototype, "refresh", function(this: ArtifactAcquisitionState, ...args: Parameters<typeof refresh>) { state = this; return Reflect.apply(refresh, this, args); });
		t.mock.method(SkillReadTracker.prototype, "clear", function(this: SkillReadTracker) { skills = this; return Reflect.apply(clear, this, []); });
		const { h, skill, ordinary } = await active(); await h.handlers.get("context")!({ messages: [] }, h.ctx); assert.ok(state); assert.ok(skills);
		finalized(h, ["owned-skill-source", "owned-ordinary-source"]);
		for (const [id, path] of [["owned-skill-source", skill], ["owned-ordinary-source", ordinary]]) {
			h.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "read", args: { path } }, h.ctx);
			h.handlers.get("tool_call")!({ toolCallId: id, toolName: "read", input: { path } }, h.ctx);
			noSourceIO([skill, ordinary], () => h.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "read", isError: false }, foreign(h)[0]));
			assert.equal(skills.successful.size, 0); assert.equal(state.reads.successful.size, 0);
		}
		// These are host-declared completion callbacks, not an actual SDK body-read/compilation witness.
		h.handlers.get("tool_execution_end")!({ toolCallId: "owned-ordinary-source", toolName: "read", isError: false }, h.ctx);
		assert.equal(state.reads.successful.get(ordinary)?.scope, "cwd");
		h.handlers.get("tool_execution_end")!({ toolCallId: "owned-skill-source", toolName: "read", isError: false }, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } });
		assert.match(skills.successful.get(skill)!.hash!, /^sha256:/);
		const result = h.handlers.get("tool_result")!({ toolCallId: "owned-skill-source", toolName: "read", input: { path: skill }, isError: false, content: [] }, h.ctx);
		assert.match(JSON.stringify(result), /belongs at cwd\.artifacts/);
	});

	test("native scope DATA ABA cannot revive old ordinary/Skill acquisition callbacks after equal-plan return", async t => {
		let state!: ArtifactAcquisitionState, skills!: SkillReadTracker;
		const refresh = ArtifactAcquisitionState.prototype.refresh, clear = SkillReadTracker.prototype.clear;
		t.mock.method(ArtifactAcquisitionState.prototype, "refresh", function(this: ArtifactAcquisitionState, ...args: Parameters<typeof refresh>) { state = this; return Reflect.apply(refresh, this, args); });
		t.mock.method(SkillReadTracker.prototype, "clear", function(this: SkillReadTracker) { skills = this; return Reflect.apply(clear, this, []); });
		const { h, skill, ordinary } = await active(); await h.handlers.get("context")!({ messages: [] }, h.ctx);
		for (const [id, path] of [["old-skill", skill], ["old-ordinary", ordinary]]) h.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "read", args: { path } }, h.ctx);
		for (const scopes of [["cwd"], ["global", "cwd", "session"]]) {
			h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "active", scopes } });
			await h.handlers.get("session_tree")!({}, h.ctx);
			if (scopes.length === 1) {
				assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>", "middle CWD selection is accepted, not a gate-denial shortcut");
				assert.throws(() => h.readState(0, "session"), /session scope is excluded/);
			}
		}
		await h.handlers.get("context")!({ messages: [] }, h.ctx); const before = files(h);
		noSourceIO([skill, ordinary], () => {
			for (const id of ["old-skill", "old-ordinary"]) h.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "read", isError: false }, h.ctx);
		});
		assert.equal(skills.successful.size, 0); assert.equal(state.reads.successful.size, 0); assert.deepEqual(files(h), before);
	});

	test("foreign ordinary tool callback remains independent of an owned patch barrier", async () => {
		const { h, skill } = await active();
		const message = { role: "assistant", content: [{ type: "toolCall", id: "owned-barrier", name: "patch_state" }, { type: "toolCall", id: "foreign-native-read", name: "read" }] };
		h.entries.push({ type: "message", message }); h.handlers.get("turn_start")!({}, h.ctx); h.handlers.get("message_end")!({ message }, h.ctx);
		const event = { toolCallId: "foreign-native-read", toolName: "read", input: { path: skill } };
		assert.equal(h.handlers.get("tool_call")!(event, foreign(h)[0]), undefined);
		assert.equal(h.handlers.get("tool_call")!(event, h.ctx)?.block, true, "the actual same-owner sibling still respects the barrier");
	});

	test("actual Passive sparse observation binds ordinary-source plan to available CWD view, not all-three defaults", { timeout: 20_000 }, async t => {
		const observations: Array<{ selection: unknown; states: string[]; provenance: string[] }> = [], refresh = ArtifactAcquisitionState.prototype.refresh;
		t.mock.method(ArtifactAcquisitionState.prototype, "refresh", function(this: ArtifactAcquisitionState, states: Parameters<typeof refresh>[0], provenance: Parameters<typeof refresh>[1], selection: Parameters<typeof refresh>[2]) {
			const record = { selection: selection && [...selection], states: Object.keys(states), provenance: [] as string[] }; observations.push(record);
			return Reflect.apply(refresh, this, [states, (scope: Parameters<typeof provenance>[0]) => { record.provenance.push(scope); return provenance(scope); }, selection]);
		});
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }), session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("Persist native owner")]); await session.prompt("BEFORE_SPARSE_ORDINARY_SOURCE");
		const a = resolveSessionAddress(session.sessionFile, session.sessionId, session.sessionManager.getHeader()?.timestamp), source = join(f.cwd, "sparse-ordinary.md"); writeFileSync(source, "EXTERNAL_BODY_NOT_ACQUIRED");
		const lower = new TemporalRuntime(f.cwd, a, f.repositoryRoot);
		await lower.withSelectedSharedOriginTransaction(["cwd"], { config: { mode: "passive" }, meta: { step: 0 } }, publish => publish(), undefined, true);
		await lower.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot, { id: "sparse-ordinary-input", transitions: [{ scope: "cwd", patch: { artifacts: { [source]: { description: "SPARSE_CWD_ARTIFACT_CARD" } } } }] }), () => {});
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, a.key); await session.prompt("/state-flow-passive");
		let input: Context["messages"] | undefined;
		f.faux.setResponses([context => { input = structuredClone(context.messages); return fauxAssistantMessage("No automatic source-body route"); }]);
		// Async SDK prompt is guarded by explicit wrappers below; assertion must run after all callbacks.
		const saved = { readFileSync: fs.readFileSync, openSync: fs.openSync }, attempts: string[] = [];
		for (const name of Object.keys(saved) as Array<keyof typeof saved>) (fs as any)[name] = (...args: any[]) => { if (String(args[0]) === source) { attempts.push(name); throw new Error("automatic source body read"); } return Reflect.apply(saved[name], fs, args); };
		syncBuiltinESMExports();
		try { await session.prompt("OBSERVE_SPARSE_ORDINARY_SOURCE"); } finally { for (const name of Object.keys(saved) as Array<keyof typeof saved>) (fs as any)[name] = saved[name]; syncBuiltinESMExports(); assert.deepEqual(attempts, []); }
		assert.ok(input); assert.match(JSON.stringify(input), /SPARSE_CWD_ARTIFACT_CARD/); assert.doesNotMatch(JSON.stringify(input), /EXTERNAL_BODY_NOT_ACQUIRED/);
		assert.ok(observations.length); for (const observed of observations) { assert.deepEqual(observed.selection, ["cwd"]); assert.deepEqual(observed.states, ["cwd"]); assert.deepEqual(observed.provenance, ["cwd"]); }
		assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, a.key), before);
	});

	test("compiler source rehash follows physical caller admission, while rightful acquired Skill evidence remains usable", async () => {
		const { h, skill } = await active();
		h.handlers.get("tool_execution_start")!({ toolCallId: "owned-compiler-read", toolName: "read", args: { path: skill } }, h.ctx);
		h.handlers.get("tool_execution_end")!({ toolCallId: "owned-compiler-read", toolName: "read", isError: false }, h.ctx);
		const params = { cwd: { artifacts: { [skill]: { description: "Owned compilation", kind: "skill", compilation: { rule: "owned compiler output" } } } } };
		const before = files(h), opens: string[] = [], open = fs.openSync;
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { if (String(args[0]) === skill) opens.push(skill); return open(...args); }) as typeof fs.openSync;
		syncBuiltinESMExports();
		try { for (const ctx of foreign(h)) await assert.rejects(h.tools.get("patch_state")!.execute("foreign-compiler", params, undefined, undefined, ctx), /selection owner changed/); }
		finally { fs.openSync = open; syncBuiltinESMExports(); }
		assert.deepEqual(opens, [], "foreign caller must be refused before owned source body rehash"); assert.deepEqual(files(h), before);
		await h.tools.get("patch_state")!.execute("rightful-compiler", params, undefined, undefined, h.ctx);
		assert.deepEqual(h.readState(0, "cwd").artifacts[skill].compilation, { rule: "owned compiler output" });
	});
}

{
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native scope owner did not withdraw before lock release")), 3000); })]).finally(() => clearTimeout(timer));
	}
	function address(h: ReturnType<typeof harness>) { return resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId(), h.ctx.sessionManager.getHeader()?.timestamp); }
	function bytes(h: ReturnType<typeof harness>) { return captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, address(h).key); }
	function marker(h: ReturnType<typeof harness>, mode: "active" | "passive" | "off", scopes: ScopeSelection) {
		h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: h.ctx.sessionManager.getSessionId(), mode, scopes: [...scopes] } });
	}
	function policyObserver(t: TestContext) {
		let current!: SelectedPolicyLifetime;
		const select = SelectedPolicyLifetime.prototype.select;
		t.mock.method(SelectedPolicyLifetime.prototype, "select", function(this: SelectedPolicyLifetime, ...args: Parameters<typeof select>) {
			const result = Reflect.apply(select, this, args); current = this; return result;
		});
		return () => current;
	}
	async function noCanonicalReads<T>(h: ReturnType<typeof harness>, action: () => Promise<T>): Promise<T> {
		const paths = new Set(bytes(h).map(file => file.path)), read = fs.readFileSync, open = fs.openSync, stat = fs.lstatSync, exists = fs.existsSync, attempted: string[] = [];
		const guard = (path: unknown, operation: string) => {
			if (paths.has(String(path))) { attempted.push(`${operation}:${String(path)}`); throw new Error(`canonical I/O before native admission/exclusion: ${String(path)}`); }
		};
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { guard(args[0], "read"); return read(...args); }) as typeof fs.readFileSync;
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { guard(args[0], "open"); return open(...args); }) as typeof fs.openSync;
		fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => { guard(args[0], "stat"); return stat(...args); }) as typeof fs.lstatSync;
		fs.existsSync = ((path: fs.PathLike) => { guard(path, "exists"); return exists(path); }) as typeof fs.existsSync;
		syncBuiltinESMExports();
		try { const result = await action(); assert.deepEqual(attempted, [], "native denial must not swallow forbidden canonical I/O attempts"); return result; }
		finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = stat; fs.existsSync = exists; syncBuiltinESMExports(); }
	}
	async function hold(t: TestContext, root: string) {
		mkdirSync(root, { recursive: true });
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		const task = withStorageTransaction(root, async () => { entered(); await gate; }); await waiting;
		return { release: async () => { release(); await task; }, path: join(root, ".state-flow-publication.lock") };
	}
	async function accepted() {
		const h = harness({ initializeRepository: false, mode: "active" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await h.tools.get("patch_state")!.execute("owned-seed", { session: { strategy: { owned: "retain" } } }, undefined, undefined, h.ctx);
		return h;
	}

	test("native same-mode scope A-B-A revokes an actual patch receipt before exclusion release and cannot revive it", async t => {
		const currentPolicy = policyObserver(t), h = await accepted();
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		const before = bytes(h), semantic = before.filter(file => !/\/(config|runtime)\.json$/.test(file.path));
		const lock = await hold(t, h.repositoryRoot);
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
		const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) { entered(); return Reflect.apply(patch, this, args); });
		let lease!: SelectedPolicyRequest;
		const capture = SelectedPolicyLifetime.prototype.capture;
		t.mock.method(SelectedPolicyLifetime.prototype, "capture", function(this: SelectedPolicyLifetime, ...args: Parameters<typeof capture>) { const result = Reflect.apply(capture, this, args); lease = result; return result; });
		const pending = assert.rejects(h.tools.get("patch_state")!.execute("old-scope-patch", { session: { tactics: { stale: true } } }, undefined, undefined, h.ctx));
		await deadline(waiting); const oldLease = lease;
		assert.deepEqual(oldLease.policy.scopes, DEFAULT_SCOPE_SELECTION); assert.equal(oldLease.policy.mode, "passive");
		let narrowed!: Promise<void>;
		await noCanonicalReads(h, async () => {
			marker(h, "passive", ["cwd"]); narrowed = h.handlers.get("session_tree")!({}, h.ctx);
			assert.equal(currentPolicy().policy!.mode, "passive"); assert.deepEqual(currentPolicy().policy!.scopes, ["cwd"]);
			assert.equal(oldLease.signal.aborted, true); assert.throws(oldLease.revalidate);
			await deadline(pending);
			assert.throws(() => h.readState(0, "session"), /unavailable|excluded|selected/i);
		});
		assert.equal(existsSync(lock.path), true); assert.deepEqual(bytes(h), before);
		const checkpoints = h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length;
		marker(h, "passive", DEFAULT_SCOPE_SELECTION);
		const restoring = h.handlers.get("session_tree")!({}, h.ctx);
		await deadline(narrowed);
		assert.deepEqual(currentPolicy().policy!.scopes, DEFAULT_SCOPE_SELECTION);
		assert.equal(oldLease.signal.aborted, true); assert.throws(oldLease.revalidate);
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, checkpoints);
		await lock.release(); await deadline(restoring); spy.mock.restore();
		assert.deepEqual(bytes(h).filter(file => !/\/(config|runtime)\.json$/.test(file.path)), semantic);
		assert.equal(h.readState(0, "session").strategy.owned, "retain"); assert.equal(h.readState(0, "session").tactics.stale, undefined);
	});

	test("scope-only Off policy changes across all six subsets cancel pending Start without memory IO or new acquisition", async t => {
		const currentPolicy = policyObserver(t);
		for (const scopes of [["global"], ["cwd"], ["session"], ["global", "cwd"], ["global", "session"], ["cwd", "session"]] as ScopeSelection[]) {
			const h = await accepted(); await h.commands.get("state-flow-off")!.handler("", h.ctx);
			const before = bytes(h), lock = await hold(t, h.repositoryRoot);
			let entered!: () => void, oldSignal!: AbortSignal;
			const waiting = new Promise<void>(resolve => { entered = resolve; });
			const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
			const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) { oldSignal = args[2]!; entered(); return Reflect.apply(inspect, this, args); });
			const starting = h.commands.get("state-flow-active")!.handler("", h.ctx);
			await deadline(waiting); spy.mock.restore();
			await noCanonicalReads(h, async () => {
				marker(h, "off", scopes); await h.handlers.get("session_tree")!({}, h.ctx);
				assert.equal(currentPolicy().policy!.mode, "off"); assert.deepEqual(currentPolicy().policy!.scopes, scopes);
				assert.equal(oldSignal.aborted, true); await deadline(starting);
				marker(h, "off", DEFAULT_SCOPE_SELECTION); await h.handlers.get("session_tree")!({}, h.ctx);
			});
			assert.equal(currentPolicy().policy!.mode, "off"); assert.deepEqual(currentPolicy().policy!.scopes, DEFAULT_SCOPE_SELECTION);
			assert.equal(oldSignal.aborted, true); assert.equal(existsSync(lock.path), true); assert.deepEqual(bytes(h), before);
			await lock.release(); await h.commands.get("state-flow-active")!.handler("", h.ctx);
			assert.equal(h.readState(0, "session").strategy.owned, "retain");
		}
	});

	test("scope-only native branch selection withdraws old restoration rather than reviving its equal-valued wanted selection", async t => {
		const currentPolicy = policyObserver(t), h = await accepted(), before = bytes(h), lock = await hold(t, h.repositoryRoot);
		const signals: AbortSignal[] = [];
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const accept = TemporalRuntime.prototype.withSelectedCurrentTransaction;
		t.mock.method(TemporalRuntime.prototype, "withSelectedCurrentTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof accept>) { signals.push(args[3]!); entered(); return Reflect.apply(accept, this, args); });
		const old = h.handlers.get("session_tree")!({}, h.ctx); await deadline(waiting);
		let narrowed!: Promise<void>;
		await noCanonicalReads(h, async () => {
			marker(h, "active", ["cwd"]); narrowed = h.handlers.get("session_tree")!({}, h.ctx);
			assert.equal(h.entries.at(-1).data.mode, "active", "native wanted mode remains Active");
			assert.equal(currentPolicy().policy!.mode, "active", "pending restoration retains selected policy, not accepted memory authority");
			assert.deepEqual(currentPolicy().policy!.scopes, ["cwd"]);
			assert.throws(() => h.readState(0, "cwd"), /restoration is pending/, "retained Active policy grants no selected memory");
			assert.equal(signals[0].aborted, true); await deadline(old);
			assert.throws(() => h.readState(0, "session"), /unavailable|excluded|selected/i);
		});
		assert.deepEqual(bytes(h), before); assert.equal(existsSync(lock.path), true);
		marker(h, "active", DEFAULT_SCOPE_SELECTION); const current = h.handlers.get("session_tree")!({}, h.ctx);
		await deadline(narrowed);
		assert.equal(signals[0].aborted, true); assert.equal(signals.length, 3);
		assert.equal(signals[1].aborted, true); assert.equal(signals[2].aborted, false);
		await lock.release(); await deadline(current);
		assert.equal(currentPolicy().policy!.mode, "active");
		assert.equal(h.readState(0, "session").strategy.owned, "retain");
	});

	test("native shared observation is canceled on scope ABA, while equal Passive preserves its own observation", async t => {
		const currentPolicy = policyObserver(t);
		for (const change of ["scope-aba", "equal-policy"] as const) {
			const h = harness({ initializeRepository: false, mode: "passive" });
			writeGlobalState({ ...emptyState(), strategy: { generation: "before" } }, h.repositoryRoot);
			const lock = join(h.repositoryRoot, ".state-flow-publication.lock"); t.after(() => rmSync(lock, { force: true }));
			let entered!: () => void, oldSignal!: AbortSignal, first = true;
			const waiting = new Promise<void>(resolve => { entered = resolve; });
			const observe = TemporalRuntime.prototype.refreshSelectedShared;
			const spy = t.mock.method(TemporalRuntime.prototype, "refreshSelectedShared", function(this: TemporalRuntime, ...args: Parameters<typeof observe>) {
				if (first) { first = false; oldSignal = args[2]!; writeFileSync(lock, `${process.pid}\n`); entered(); }
				return Reflect.apply(observe, this, args);
			});
			const original = h.handlers.get("session_start")!({ reason: "new" }, h.ctx); await deadline(waiting);
			let replacement: Promise<void> | undefined;
			if (change === "scope-aba") {
				let narrowed!: Promise<void>;
				await noCanonicalReads(h, async () => { marker(h, "passive", ["cwd"]); narrowed = h.handlers.get("session_tree")!({}, h.ctx); await deadline(original); });
				assert.equal(oldSignal.aborted, true); assert.deepEqual(currentPolicy().policy!.scopes, ["cwd"]);
				assert.throws(() => h.readState(0, "global"), /unavailable|excluded|selected/i);
				marker(h, "passive", DEFAULT_SCOPE_SELECTION); replacement = h.handlers.get("session_tree")!({}, h.ctx);
				await deadline(narrowed);
				assert.equal(oldSignal.aborted, true);
			} else {
				await h.commands.get("state-flow-passive")!.handler("", h.ctx);
				assert.equal(oldSignal.aborted, false);
			}
			writeGlobalState({ ...emptyState(), strategy: { generation: "after" } }, h.repositoryRoot);
			const peer = bytes(h); rmSync(lock); await deadline(replacement ?? original); spy.mock.restore();
			assert.deepEqual(bytes(h), peer); assert.equal(h.readState(0, "global").strategy.generation, "after");
			const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, address(h).key);
			const privatePaths = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot, address(h).key);
			assert.equal(existsSync(life.config), false); assert.equal(existsSync(life.runtime), false); assert.equal(existsSync(privatePaths.meta), false);
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
		}
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners: StateScope[] = ['global', 'cwd', 'session'];
	const selections: StateScope[][] = [['global'], ['cwd'], ['session'], ['global', 'cwd'], ['global', 'session'], ['cwd', 'session'], owners];
	const text = (m: AgentMessage): string => 'content' in m && Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : 'content' in m && typeof m.content === 'string' ? m.content : '';
	// These inspectors describe only the known JSON fixtures authored below.
	const tactics = (s: ModelState) => s.tactics as Record<string, { marker: string; phase: number }>;
	type ReadValue = { phase: number };
	type ReadEnvelope = { value: ReadValue; keys: Record<string, object>; patch: { tactics: Record<string, { phase: number }> } };
	for (const selected of selections) for (const mode of ['active', 'passive'] as const) test(`native seven core selected=${selected.join('+')} mode=${mode}`, { timeout: 60000 }, async t => {
	  const foreign = 'FOREIGN-CONTEXT-seven-core';
	  const f = await realPiFixture(t, { stateFlow: true, mode: 'configured', initializeRepository: false,
	    extensions: [{ name: 'seven-core-foreign', factory: pi => {
	      pi.on('context', event => ({ messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: foreign }], timestamp: 1 }] }));
	    } }],
	  });
	  const configure = (scopes: StateScope[]) => writeFileSync(f.repositoryRoot + '/config.json', JSON.stringify({ scopes, mode, historyLimit: 7 }));
	  configure(selected);
	  const runtime = await f.createRuntime('new'), session = runtime.session;
	  const key = () => resolveSessionAddress(session.sessionManager.getSessionFile(), session.sessionId, session.sessionManager.getHeader()?.timestamp).key;
	  const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key());
	  const semantic = (scope: StateScope): [string, string | null][] => {
	    const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, key());
	    return [p.checkpoint, p.patches, p.meta].map(path => [path, existsSync(path) ? readFileSync(path).toString('base64') : null]);
	  };
	  const beforeInitialStatus = files();
	  await session.prompt('/state-flow-status');
	  assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${selected.join(', ')}`), 'unloaded status reports captured policy, not an all-owner fallback');
	  assert.deepEqual(files(), beforeInitialStatus, 'status cannot acquire memory');
	  const excluded = owners.filter(o => !selected.includes(o));
	  const excludedBefore = Object.fromEntries(excluded.map(o => [o, semantic(o)]));
	  const assertExcluded = () => {
	    for (const o of excluded) {
	      assert.deepEqual(semantic(o), excludedBefore[o], `${o} excluded canonical triple unchanged`);
	      assert.throws(() => f.readState(session, 0, o), `${o} read fails closed`);
	    }
	    if (!selected.includes('session')) assert.ok(semantic('session').every(([, b]) => b === null), 'excluded Session semantic triple absent');
	  };
	  const results = new Map<string, ToolResultMessage>(), contexts: Context[] = [];
	  const observe = (c: Context) => {
	    contexts.push(structuredClone(c));
	    for (const m of c.messages) if (m.role === 'toolResult') results.set(m.toolCallId, structuredClone(m));
	  };
	  const call = (name: string, args: Parameters<typeof tool>[1], id: string, capture?: () => void): FauxResponseFactory => c => {
	    observe(c); capture?.();
	    return answer(tool(name, args, { id }), { stopReason: 'toolUse' });
	  };
	  const final = (value: string): FauxResponseFactory => c => { observe(c); return answer(value); };
	  const result = (id: string, error = false) => {
	    const r = results.get(id);
	    assert.ok(r, `native original-ID result ${id} observed`);
	    assert.equal(Boolean(r.isError), error, text(r));
	    return r;
	  };
	  const envelope = (id: string): ReadEnvelope => JSON.parse(text(result(id)));
	  const value = (id: string) => envelope(id).value;
	  const marker = `seven-${selected.join('-')}-${mode}`;
	  const patch = (phase: number) => Object.fromEntries(selected.map(o => [o, { tactics: { [o]: { marker, phase } }, lazy: { [o]: `LAZY-${marker}-${o}` } }]));
	  let afterFirstPatch: ReturnType<typeof semantic>[] | undefined;
	  f.faux.setResponses([call('patch_state', modelPatchArguments(selected, patch(1)), 'phase1'), c => { observe(c); afterFirstPatch = owners.map(semantic); return answer('ordinary final 1'); }]);
	  await session.prompt(`Native user ${marker}: remember selected owners`);
	  result('phase1');
	  for (const o of selected) assert.equal(tactics(f.readState(session, 0, o))[o].phase, 1);
	  if (mode === 'active' && selected.includes('session')) assert.equal(f.readState(session).response, 'ordinary final 1');
	  else {
	    assert.ok(!f.readState(session).response, 'ordinary answer not captured without Active Session');
	    assert.deepEqual(owners.map(semantic), afterFirstPatch, 'ordinary answer memory-inert without Active Session');
	  }
	  assertExcluded();
	  const target = selected.at(-1)! , point = session.sessionManager.getLeafId()!;
	  let beforeNoop: ReturnType<typeof files> | undefined, afterNoop: ReturnType<typeof files> | undefined, beforeReject: ReturnType<typeof files> | undefined, afterReject: ReturnType<typeof files> | undefined;
	  const steps: FauxResponseStep[] = [
	    call('patch_state', modelPatchArguments(selected, { [target]: { tactics: { [target]: { phase: 2 } } } }), 'phase2'),
	    call('read_state', { path: `${target}.tactics.${target}` }, 'current'),
	    call('read_state', { path: `${target}[1].tactics.${target}` }, 'history'),
	    call('read_state', { paths: [...selected.map(o => `${o}.tactics.${o}.marker`), `${target}.tactics.${target}.phase`] }, 'batch'),
	    call('read_state', { path: `${target}.tactics`, projection: 'keys' }, 'keys'),
	    call('read_state', { path: `${target}.patches[0]` }, 'patch'),
	    call('patch_state', modelPatchArguments(selected, { [target]: { tactics: { [target]: { phase: 2 } } } }), 'noop', () => { beforeNoop = files(); }),
	  ];
	  if (excluded.length) steps.push(
	    call('patch_state', { [target]: { tactics: { atomicLeak: true } }, [excluded[0]]: { tactics: { forbidden: marker } } }, 'mixed', () => { afterNoop = files(); beforeReject = files(); }),
	    call('read_state', { path: excluded[0] }, 'excluded', () => { afterReject = files(); }),
	  );
	  steps.push(c => { observe(c); if (!excluded.length) afterNoop = files(); return answer('ordinary final 2'); });
	  f.faux.setResponses(steps);
	  await session.prompt(`Native user ${marker}: inspect genuine causal previous boundary`);
	  result('phase2');
	  assert.equal(value('current').phase, 2);
	  assert.equal(value('history').phase, 1);
	  assert.deepEqual(value('batch'), [...selected.map(() => marker), 2]);
	  assert.ok(envelope('keys').keys[target]);
	  assert.equal(envelope('patch').patch.tactics[target].phase, 2);
	  result('noop');
	  assert.deepEqual(afterNoop, beforeNoop, 'noop exact canonical bytes');
	  if (excluded.length) {
	    result('mixed', true);
	    assert.ok(!text(result('excluded', true)).includes(marker), 'denied read contains no owner body');
	    assert.deepEqual(afterReject, beforeReject, 'mixed patch atomic rejection');
	    assert.equal(f.readState(session, 0, target).tactics?.atomicLeak, undefined);
	  }
	  assertExcluded();
	  for (const [index, c] of contexts.entries()) {
	    const section = getCurrentSystemMessage(c.messages)?.sections?.state_flow;
	    // An empty Passive store has no validated view before its first accepted patch.
	    if (mode === 'active' || index > 0) assert.ok(section, 'actual native State Flow system section');
	    if (section && selected.length !== 3) {
	      assert.ok(section.includes(`Participating owners: ${selected.join(' ')}.`), 'wanted canonical owners in actual system section');
	      if (!selected.includes('session')) assert.ok(section.includes('new answers are delivered, not stored or backfilled.'), 'Session-excluded response guidance');
	    }
	    assert.ok(c.messages.some(m => Array.isArray(m.content) && text(m).includes(foreign)), 'foreign context retained');
	    const heads = c.messages.filter(m => m.role === 'user').map(text).filter(s => /^State Flow (?:runtime context|passive memory)/.test(s));
	    for (const head of heads) assert.ok(!head.includes(`LAZY-${marker}`), 'lazy bodies omitted from automatic head');
	  }
	  assert.ok(session.messages.some(m => m.role === 'user' && text(m).includes(`Native user ${marker}`)), 'native user trace retained');
	  await session.reload();
	  assert.equal(tactics(f.readState(session, 0, target))[target].phase, 2);
	  const beforeStop = owners.map(semantic);
	  await session.prompt('/state-flow-passive');
	  let stoppedContext: Context | undefined;
	  f.faux.setResponses([c => { stoppedContext = structuredClone(c); return answer('Stopped ordinary answer'); }]);
	  await session.prompt('Use the selected current memory after Stop');
	  assert.deepEqual(owners.map(semantic), beforeStop, 'Passive/Stop ordinary answer never rewrites semantic memory');
	  assert.ok(stoppedContext, 'Stop provider context observed');
	  const stoppedHeads = stoppedContext.messages.flatMap(m => m.role === 'user' && Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'text' && /^State Flow (?:runtime context|passive memory|exit handoff)/.test(p.text));
	  assert.ok(stoppedHeads.length > 0, 'actual Stop/Passive contribution observed');
	  for (const m of stoppedHeads) {
	    assert.equal(m.type, 'text');
	    if (m.type !== 'text') throw new Error('Expected text head');
	    const body = m.text, projected: ModelState = JSON.parse(body.slice(body.indexOf('\n') + 1)).state;
	    for (const o of selected) assert.equal(tactics(projected)[o].marker, marker);
	    for (const o of excluded) assert.equal(projected.tactics?.[o], undefined, 'excluded owner absent from handoff/head');
	    assert.equal(projected.lazy, undefined, 'lazy bodies omitted from Stop/Passive contribution');
	  }
	  if (selected.length !== 3) assert.ok(getCurrentSystemMessage(stoppedContext.messages)?.sections?.state_flow?.includes(`Participating owners: ${selected.join(' ')}.`));
	  const beforeOff = owners.map(semantic);
	  await session.prompt('/state-flow-off');
	  await session.prompt('/state-flow-status');
	  assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${selected.join(', ')}`), 'Off status retains captured selection DATA without a view');
	  let offContext: Context | undefined;
	  f.faux.setResponses([c => { offContext = structuredClone(c); return answer('Off ordinary answer'); }]);
	  await session.prompt('Off ordinary read-free prompt');
	  await session.reload();
	  assert.deepEqual(owners.map(semantic), beforeOff, 'Off memory unchanged');
	  assert.ok(offContext, 'Off provider context observed');
	  assert.equal(getCurrentSystemMessage(offContext.messages)?.sections?.state_flow, undefined);
	  assert.ok(!offContext.messages.some(m => m.role === 'user' && Array.isArray(m.content) && /^State Flow (?:runtime context|passive memory)/.test(text(m))), 'Off has no fresh automatic head; prior native tool/user trace remains legal');
	  const offTools = getCurrentTools(offContext.messages).map(tool => tool.name);
	  assert.ok(!offTools.includes('patch_state') && !offTools.includes('read_state'));
	  configure(owners);
	  await session.prompt('/state-flow-passive');
	  await session.prompt('/state-flow-active');
	  if (mode === 'passive') await session.prompt('/state-flow-passive');
	  f.faux.setResponses([call('patch_state', modelPatchArguments(selected, { [target]: { tactics: { [target]: { phase: 3 } } } }), 'afterOff'), final('after Off ordinary')]);
	  await session.prompt('First selected mutation after Off');
	  result('afterOff');
	  assert.equal(tactics(f.readState(session, 0, target))[target].phase, 3);
	  assert.equal(tactics(f.readState(session, 0, target))[target].marker, marker);
	  assertExcluded();
	  await session.navigateTree(point, { summarize: false });
	  assert.equal(tactics(f.readState(session, 0, target))[target].phase, 3, 'old native point accepts CURRENT memory');
	  assertExcluded();
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners: StateScope[] = ["global", "cwd", "session"];
	const selections: StateScope[][] = [["global"], ["cwd"], ["session"], ["global", "cwd"], ["global", "session"], ["cwd", "session"], owners];
	function text(message: AgentMessage): string {
		if (!("content" in message)) return "";
		return typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	}
	type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
	function object(value: Json | undefined): { [key: string]: Json } {
		assert.ok(value && typeof value === "object" && !Array.isArray(value));
		return value;
	}
	function materialized(value: string): { [key: string]: Json } { return object(JSON.parse(value) as Json); }
	function ownerRecord<T>(make: (owner: StateScope, index: number) => T): Record<StateScope, T> {
		return Object.fromEntries(owners.map((owner, index) => [owner, make(owner, index)])) as Record<StateScope, T>;
	}
	type SourceEvent = { phase: string; operation: string; path: string };
	// Exact known paths only; record attempts before original I/O, including failures.
	function traceSources(paths: string[]) {
		const known = new Set(paths), events: SourceEvent[] = [], restore: (() => void)[] = [], descriptors = new Map<number, string>();
		let phase = "automatic";
		function record(operation: string, value: unknown): string | undefined {
			const path = typeof value === "number" ? descriptors.get(value) : value instanceof URL ? value.pathname : Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : undefined;
			if (path !== undefined && known.has(path)) events.push({ phase, operation, path });
			return path;
		}
		// Local casts preserve Node's overload surfaces; wrappers forward every argument unchanged
		// except open's callback, which records descriptor provenance before invoking its caller.
		function syncSpy<K extends "statSync" | "lstatSync" | "openSync" | "readFileSync" | "readSync" | "readvSync" | "fstatSync" | "accessSync" | "existsSync" | "realpathSync" | "closeSync">(name: K) {
			const original = fs[name];
			fs[name] = function(this: typeof fs, ...args: Parameters<typeof original>): ReturnType<typeof original> {
				const path = record(name, args[0]);
				const result = Reflect.apply(original, this, args) as ReturnType<typeof original>;
				if (name === "openSync" && path !== undefined && known.has(path)) descriptors.set(result as number, path);
				if (name === "closeSync") descriptors.delete(args[0] as number);
				return result;
			} as unknown as typeof original;
			restore.push(() => { fs[name] = original; });
		}
		for (const name of ["statSync", "lstatSync", "openSync", "readFileSync", "readSync", "readvSync", "fstatSync", "accessSync", "existsSync", "realpathSync", "closeSync"] as const) syncSpy(name);
		function callbackSpy<K extends "stat" | "lstat" | "open" | "readFile" | "read" | "readv" | "fstat" | "access" | "realpath" | "close">(name: K) {
			const original = fs[name];
			fs[name] = function(this: typeof fs, ...args: Parameters<typeof original>): ReturnType<typeof original> {
				const path = record(name, args[0]);
				if (name === "open" && path !== undefined && known.has(path)) {
					const openArgs = args as Parameters<typeof fs.open>;
					const callback = openArgs[openArgs.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void;
					const wrapped = (error: NodeJS.ErrnoException | null, fd: number) => { if (!error) descriptors.set(fd, path); callback(error, fd); };
					Reflect.set(args, args.length - 1, wrapped);
				}
				return Reflect.apply(original, this, args) as ReturnType<typeof original>;
			} as unknown as typeof original;
			restore.push(() => { fs[name] = original; });
		}
		for (const name of ["stat", "lstat", "open", "readFile", "read", "readv", "fstat", "access", "realpath", "close"] as const) callbackSpy(name);
		function promiseSpy<K extends "stat" | "lstat" | "open" | "readFile" | "access" | "realpath">(name: K) {
			const original = fs.promises[name];
			fs.promises[name] = async function(this: typeof fs.promises, ...args: Parameters<typeof original>) {
				const path = record(`promises.${name}`, args[0]);
				const result = await Reflect.apply(original, this, args) as Awaited<ReturnType<typeof original>>;
				if (name === "open" && path !== undefined && known.has(path)) {
					const handle = result as fs.promises.FileHandle;
					function handleSpy<M extends "read" | "readFile" | "readv" | "stat">(method: M) {
						const originalMethod = handle[method];
						handle[method] = function(this: fs.promises.FileHandle, ...inner: Parameters<typeof originalMethod>): ReturnType<typeof originalMethod> {
							record(`FileHandle.${method}`, path);
							return Reflect.apply(originalMethod, this, inner) as ReturnType<typeof originalMethod>;
						} as unknown as typeof originalMethod;
					}
					for (const method of ["read", "readFile", "readv", "stat"] as const) handleSpy(method);
				}
				return result;
			} as unknown as typeof original;
			restore.push(() => { fs.promises[name] = original; });
		}
		for (const name of ["stat", "lstat", "open", "readFile", "access", "realpath"] as const) promiseSpy(name);
		syncBuiltinESMExports();
		return { events, setPhase(value: string) { phase = value; }, restore() { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); } };
	}

	for (const selected of selections) test(`native seven facility selected=${selected.join("+")} Active route=user/project/temporary`, { timeout: 60000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		const routes = ["user", "project", "temporary"] as const;
		const skills = ownerRecord((owner, index) => f.registerSkill(routes[index], `facility-${owner}`, `# ${owner} Skill\n\nSKILL-SOURCE-ORIGINAL-${owner}`));
		const ordinary = ownerRecord(owner => `${f.cwd}/ordinary-${owner}.md`);
		for (const owner of owners) fs.writeFileSync(ordinary[owner], `ORDINARY-SOURCE-ORIGINAL-${owner}\n`);
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "active", scopes: owners }));
		const runtime = await f.createRuntime("new"), session = runtime.session;
		const paths = (owner: StateScope) => temporalScopePaths(f.cwd, session.sessionId, owner, f.repositoryRoot, nativeSessionKey(session));
		const triple = (owner: StateScope) => { const p = paths(owner); return [p.checkpoint, p.patches, p.meta].map(path => [path, fs.readFileSync(path).toString("base64")]); };
		const provenance = (owner: StateScope, path: string) => object(object(materialized(fs.readFileSync(paths(owner).meta, "utf8")).artifacts)[path]);
		const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>(), captures: Context[] = [];
		const observe = (context: Context) => { captures.push(structuredClone(context)); for (const message of context.messages) if (message.role === "toolResult") results.set(message.toolCallId, structuredClone(message)); };
		const call = (name: string, args: Parameters<typeof tool>[1], id: string) => (context: Context) => { observe(context); return answer(tool(name, args, { id }), { stopReason: "toolUse" }); };
		const final = (value: string) => (context: Context) => { observe(context); return answer(value); };
		const result = (id: string, error = false) => { const r = results.get(id); assert.ok(r, `actual native original-ID result ${id}`); assert.equal(Boolean(r.isError), error, text(r)); return r; };
		const skillCard = (owner: StateScope) => ({ description: `Compiled ${owner} Skill`, kind: "skill", compilation: { owner, routing: `Use ${owner} guidance` } });
		// Semantic/provenance origins come from native read/patch tools, not fixture metadata.
		f.faux.setResponses([
			...owners.map(owner => call("read", { path: skills[owner] }, `initial-skill-${owner}`)),
			call("patch_state", ownerRecord(owner => ({ artifacts: { [skills[owner]]: skillCard(owner), [ordinary[owner]]: { description: `Ordinary ${owner}` } }, tactics: { [`owner_${owner}`]: `OWNER-${owner}` }, lazy: { [`lazy_${owner}`]: `LAZY-BODY-${owner}` } })), "initial-register"),
			final("All three native owners registered"),
		]);
		await session.prompt("Read and compile all three registered native Skills and register exact ordinary paths");
		result("initial-register");
		for (const owner of owners) {
			assert.match(text(result(`initial-skill-${owner}`)), new RegExp(`belongs at ${owner}\\.artifacts`));
			assert.deepEqual(f.readState(session, 0, owner).artifacts?.[skills[owner]], skillCard(owner));
			assert.equal(provenance(owner, skills[owner]).sourceHash, hashArtifactSource(fs.readFileSync(skills[owner])));
			assert.equal(provenance(owner, skills[owner]).compilerRevision, SKILL_ARTIFACT_COMPILER);
		}
		f.faux.setResponses([
			...owners.map(owner => call("read", { path: ordinary[owner] }, `initial-ordinary-${owner}`)),
			call("patch_state", ownerRecord(owner => ({ artifacts: { [ordinary[owner]]: { description: `Ordinary compiled ${owner}` } } })), "compile-ordinary"), final("Ordinary native provenance compiled"),
		]);
		await session.prompt("Compile the three exact ordinary registered sources");
		result("compile-ordinary");
		for (const owner of owners) {
			result(`initial-ordinary-${owner}`);
			assert.equal(provenance(owner, ordinary[owner]).compilerRevision, ORDINARY_ARTIFACT_COMPILER);
			assert.ok(provenance(owner, ordinary[owner]).sourceFingerprint);
		}
		await session.prompt("/state-flow-off");
		// Native-policy DATA adapter, not public scope controls, approval, or acquisition authority.
		session.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: session.sessionId, mode: "off", scopes: selected });
		await session.reload();
		await session.prompt("/state-flow-active");
		const excluded = owners.filter(owner => !selected.includes(owner));
		const excludedBytes = new Map(excluded.map(owner => [owner, triple(owner)]));
		const beforeSelectedHashes = new Map(selected.map(owner => [owner, provenance(owner, skills[owner]).sourceHash]));
		for (const owner of owners) {
			fs.appendFileSync(skills[owner], `\nSKILL-SOURCE-CHANGED-${owner}\n`);
			fs.appendFileSync(ordinary[owner], `ORDINARY-SOURCE-CHANGED-${owner}\n`);
		}
		const trace = traceSources([...Object.values(skills), ...Object.values(ordinary)]);
		let automatic: SourceEvent[] = [], explicitEvents: SourceEvent[] = [], relocationEvents: SourceEvent[] = [], refreshEvents: SourceEvent[] = [];
		const start = captures.length;
		try {
			f.faux.setResponses([final("Automatic selected planning observed")]);
			await session.prompt("Use materialized selected state after exact source changes");
			automatic = structuredClone(trace.events);
			const phaseCaptures = captures.slice(start);
			assert.equal(phaseCaptures.length, 1, "provider actually reached exactly once");
			const context = phaseCaptures[0];
			const head = context.messages.find(message => message.role === "user" && text(message).startsWith("State Flow runtime context"));
			assert.ok(head && "content" in head, "actual JSON automatic head");
			assert.notEqual(typeof head.content, "string");
			const headText = typeof head.content === "string" ? head.content : head.content.find(part => part.type === "text" && part.text.startsWith("State Flow runtime context"));
			assert.ok(headText && typeof headText !== "string" && headText.type === "text");
			const view = materialized(headText.text.slice(headText.text.indexOf("\n") + 1));
			const state = object(view.state), tactics = object(state.tactics), artifacts = object(state.artifacts);
			assert.deepEqual(view.artifact_invalidations, selected.map(owner => ({ path: ordinary[owner], scope: owner, reason: "source-changed" })).sort((a, b) => a.path.localeCompare(b.path)));
			for (const owner of owners) {
				assert.equal(tactics[`owner_${owner}`], selected.includes(owner) ? `OWNER-${owner}` : undefined);
				assert.equal(Boolean(artifacts[skills[owner]]), selected.includes(owner));
				assert.ok(!JSON.stringify(view).includes(`LAZY-BODY-${owner}`));
				if (selected.includes(owner)) {
					assert.ok(automatic.some(event => event.path === ordinary[owner] && /stat/i.test(event.operation)), "selected ordinary source stat positive");
					const hint = object(artifacts[ordinary[owner]]).hint;
					assert.ok(typeof hint === "string");
					assert.match(hint, /Source changed/);
				} else assert.deepEqual(automatic.filter(event => event.path === skills[owner] || event.path === ordinary[owner]), [], `${owner} excluded known source callback I/O attempts zero`);
			}
			if (selected.length !== 3) {
				const section = getCurrentSystemMessage(context.messages)?.sections?.state_flow;
				assert.ok(typeof section === "string" && section.includes(`Participating owners: ${selected.join(" ")}.`));
			}
			trace.setPhase("excluded-native-read");
			const beforeExplicit = trace.events.length;
			let relocationStart: number | undefined;
			const excludedSteps = excluded.map(owner => call("read", { path: skills[owner] }, `excluded-read-${owner}`));
			if (excluded.length) excludedSteps.push(context => {
				observe(context); relocationStart = trace.events.length; trace.setPhase("relocation-attempt");
				return answer(tool("patch_state", modelPatchArguments(selected, { [selected[0]]: { artifacts: { [skills[excluded[0]]]: skillCard(excluded[0]) } } }), { id: "relocate-excluded" }), { stopReason: "toolUse" });
			});
			excludedSteps.push(final("Excluded read and relocation observed in one native loop"));
			f.faux.setResponses(excludedSteps);
			await session.prompt("Read excluded registered Skills and attempt relocation within the same native loop");
			explicitEvents = trace.events.slice(beforeExplicit, relocationStart);
			for (const owner of excluded) {
				const r = result(`excluded-read-${owner}`);
				assert.match(text(r), new RegExp(`SKILL-SOURCE-CHANGED-${owner}`));
				assert.doesNotMatch(text(r), /State Flow acquisition|belongs at/);
				assert.ok(explicitEvents.some(event => event.path === skills[owner] && /read|open/i.test(event.operation)), "native excluded read did real I/O");
			}
			if (excluded.length) {
				t.diagnostic(JSON.stringify({ selected, relocationResult: results.get("relocate-excluded") }));
				result("relocate-excluded", true);
				relocationEvents = trace.events.slice(relocationStart);
				assert.deepEqual(relocationEvents.filter(event => Object.values(skills).includes(event.path)), [], "excluded relocation performs no Skill source hashing I/O");
				assert.equal(f.readState(session, 0, selected[0]).artifacts?.[skills[excluded[0]]], undefined);
			}
			trace.setPhase("selected-native-refresh");
			const beforeRefresh = trace.events.length;
			f.faux.setResponses([
				...selected.map(owner => call("read", { path: skills[owner] }, `selected-reread-${owner}`)),
				call("patch_state", modelPatchArguments(selected, Object.fromEntries(selected.map(owner => [owner, { artifacts: { [skills[owner]]: skillCard(owner) } }]))), "rightful-refresh"), final("Rightful native selected compilation works"),
			]);
			await session.prompt("Read changed selected Skills and compile into rightful provenance-derived owners");
			result("rightful-refresh");
			refreshEvents = trace.events.slice(beforeRefresh);
			for (const owner of selected) {
				assert.ok(text(result(`selected-reread-${owner}`)).includes(`belongs at ${selected.length === 1 ? "" : owner + "."}artifacts[${JSON.stringify(skills[owner])}]`));
				assert.ok(refreshEvents.some(event => event.path === skills[owner] && event.operation === "openSync"), "actual State Flow selected hash opened source");
			}
		} finally { trace.restore(); }
		for (const owner of selected) {
			assert.equal(provenance(owner, skills[owner]).sourceHash, hashArtifactSource(fs.readFileSync(skills[owner])));
			assert.notEqual(provenance(owner, skills[owner]).sourceHash, beforeSelectedHashes.get(owner));
			assert.equal(provenance(owner, skills[owner]).compilerRevision, SKILL_ARTIFACT_COMPILER);
		}
		for (const owner of excluded) assert.deepEqual(triple(owner), excludedBytes.get(owner), `${owner} acquired-but-excluded canonical triple byte preserved`);
		for (const owner of owners) fs.unlinkSync(ordinary[owner]);
		const removalTrace = traceSources([...Object.values(skills), ...Object.values(ordinary)]);
		try {
			f.faux.setResponses([final("Selected exact missing source maintenance observed")]);
			await session.prompt("Observe exact registered ordinary source removal");
			for (const owner of selected) assert.equal(f.readState(session, 0, owner).artifacts?.[ordinary[owner]], undefined);
			for (const owner of excluded) {
				assert.deepEqual(removalTrace.events.filter(event => event.path === skills[owner] || event.path === ordinary[owner]), []);
				assert.deepEqual(triple(owner), excludedBytes.get(owner));
			}
		} finally { removalTrace.restore(); }
		t.diagnostic(JSON.stringify({ selected, nativeResults: [...results.keys()], automatic, explicitEvents, relocationEvents, refreshEvents }));
		// Generic maintenance uses presence/fingerprints; Skill content hashing is read-driven above.
		for (const owner of selected) assert.ok(automatic.some(event => event.path === skills[owner] && /stat/i.test(event.operation)), `selected Skill presence positive: ${owner}`);
	});
}

{
	type Mode = 'active' | 'passive';
	const ALL: ScopeSelection = ['global', 'cwd', 'session'];
	const SHARED: ScopeSelection[] = [['global'], ['cwd'], ['global', 'cwd']];
	const SEVEN: ScopeSelection[] = [...SHARED, ['session'], ['global', 'session'], ['cwd', 'session'], ALL];
	const config = (f: RealPiFixture, scopes: ScopeSelection, mode: Mode) => fs.writeFileSync(join(f.repositoryRoot, 'config.json'), JSON.stringify({ scopes, mode }));
	const scopePaths = (f: RealPiFixture, s: AgentSession, scope: StateScope) => temporalScopePaths(f.cwd, s.sessionId, scope, f.repositoryRoot, nativeSessionKey(s));
	const privateFiles = (f: RealPiFixture, s: AgentSession) => { const p = scopePaths(f, s, 'session'); return [p.checkpoint, p.patches, p.meta]; };
	const lifePaths = (f: RealPiFixture, s: AgentSession) => sessionRuntimePaths(f.cwd, s.sessionId, f.repositoryRoot, nativeSessionKey(s));
	const life = (f: RealPiFixture, s: AgentSession) => JSON.parse(fs.readFileSync(lifePaths(f, s).runtime, 'utf8'));
	const bytes = (paths: string[]) => paths.map(path => fs.existsSync(path) ? fs.readFileSync(path).toString('base64') : null);
	type NativePolicy = { owner?: string; forkPending?: boolean; scopes?: ScopeSelection; mode?: string };
	const pending = (s: AgentSession) => s.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'state-flow-passive-stop' && (e.data as NativePolicy).owner === s.sessionId && (e.data as NativePolicy).forkPending === true);
	const policy = (s: AgentSession) => {
	  const entry = s.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'state-flow-passive-stop').at(-1);
	  assert.ok(entry?.type === 'custom');
	  return entry.data as NativePolicy;
	};
	function assertNoPrivate(f: RealPiFixture, s: AgentSession) { assert.deepEqual(privateFiles(f, s).map(p => fs.existsSync(p)), [false, false, false]); }
	function policyAdapter(s: AgentSession, scopes: ScopeSelection, forkPending = false) {
	  // Native POLICY DATA only; public owned Start below must grant acquisition.
	  s.sessionManager.appendCustomEntry('state-flow-passive-stop', { version: 2, owner: s.sessionId, mode: 'off', scopes, ...(forkPending ? { forkPending: true } : {}) });
	}
	function watchedPaths(f: RealPiFixture, ...sessions: AgentSession[]) {
	  return new Set(sessions.flatMap(s => [...ALL.flatMap(scope => {
	    const p = scopePaths(f, s, scope); return [p.checkpoint, p.patches, p.meta];
	  }), ...Object.values(lifePaths(f, s))]));
	}
	type IOOptions = { parentFile: string; privatePaths?: string[]; canonicalPaths?: Set<string>; sessionDir: string };
	type IORecord = { op: string; path: string; parentPrivate: boolean; canonical: boolean; ownedParentHeader: boolean; ownedDiscovery: boolean; stack: string };
	async function observeIO({ parentFile, privatePaths = [], canonicalPaths = new Set<string>(), sessionDir }: IOOptions, work: () => Promise<unknown>) {
	  const records: IORecord[] = [], fds = new Map<number, string | undefined>();
	  const original = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync, closeSync: fs.closeSync, readdirSync: fs.readdirSync };
	  const copy = TemporalRuntime.prototype.withSelectedForkCopyTransaction;
	  let copyCalls = 0;
	  const pathOf = (p: unknown): string | undefined => typeof p === 'string' ? resolve(p) : p instanceof URL ? resolve(p.pathname) : typeof p === 'number' ? fds.get(p) : undefined;
	  function record(op: string, arg: unknown) {
	    const path = pathOf(arg); if (!path) return;
	    const stack = new Error().stack ?? '';
	    if (path === parentFile || path === sessionDir || privatePaths.includes(path) || canonicalPaths.has(path)) records.push({ op, path, parentPrivate: privatePaths.includes(path), canonical: canonicalPaths.has(path), ownedParentHeader: path === parentFile && /readNativeSessionHeader|forkSource|continuation\.ts/.test(stack), ownedDiscovery: path === sessionDir && /discoverNativeSessionHeaders|continuation\.ts/.test(stack), stack });
	  }
	  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { record('open', args[0]); const fd = original.openSync(...args); fds.set(fd, pathOf(args[0])); return fd; }) as typeof fs.openSync;
	  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => { record('read', args[0]); return original.readSync(...args); }) as typeof fs.readSync;
	  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { record('readFile', args[0]); return original.readFileSync(...args); }) as typeof fs.readFileSync;
	  fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => { record('readdir', args[0]); return original.readdirSync(...args); }) as typeof fs.readdirSync;
	  fs.closeSync = (...args: Parameters<typeof fs.closeSync>) => { try { return original.closeSync(...args); } finally { fds.delete(args[0]); } };
	  TemporalRuntime.prototype.withSelectedForkCopyTransaction = function(this: TemporalRuntime, ...args: Parameters<typeof copy>) { copyCalls++; return copy.apply(this, args); } as typeof copy;
	  syncBuiltinESMExports();
	  let error: unknown;
	  try { await work(); } catch (e) { error = e; }
	  finally { Object.assign(fs, original); TemporalRuntime.prototype.withSelectedForkCopyTransaction = copy; syncBuiltinESMExports(); }
	  // Assertions after restore: caught read/hash errors cannot hide attempts.
	  return { records, copyCalls, error };
	}
	type Probe = Awaited<ReturnType<typeof observeIO>>;
	function assertBounded(p: Probe) { assert.deepEqual(p.records.filter(r => r.ownedDiscovery), [], 'no State Flow native ancestry discovery'); }
	function assertSharedIO(p: Probe) {
	  assert.ifError(p.error);
	  assert.equal(p.copyCalls, 0, 'shared-only fork never enters private-copy transaction');
	  assert.deepEqual(p.records.filter(r => r.parentPrivate), [], 'zero exact parent canonical Session-body attempts');
	  assert.deepEqual(p.records.filter(r => r.ownedParentHeader), [], 'zero State Flow parent-header attempts; SDK trace reads remain legal');
	  assertBounded(p);
	}
	function assertOffIO(p: Probe) { assertSharedIO(p); assert.deepEqual(p.records.filter(r => r.canonical), [], 'public Off is canonical-memory inert'); }
	async function patch(f: RealPiFixture, s: AgentSession, scopes: ScopeSelection, marker: string) {
	  const results: ToolResultMessage[] = [], id = `native-${marker}`;
	  const body = Object.fromEntries(scopes.map(scope => [scope, { tactics: { [`${scope}Marker`]: marker } }]));
	  const beforeCalls = f.faux.state.callCount;
	  f.faux.setResponses([
	    () => fauxAssistantMessage(fauxToolCall('patch_state', modelPatchArguments(scopes, body), { id }), { stopReason: 'toolUse' }),
	    context => { results.push(...context.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolCallId === id)); return fauxAssistantMessage(`NATIVE-ANSWER-${marker}`); },
	  ]);
	  await s.prompt(`NATIVE-REQUEST-${marker}`);
	  assert.equal(f.faux.state.callCount - beforeCalls, 2);
	  assert.equal(results.length, 1, 'original native result delivered exactly once');
	  assert.equal(results[0]!.toolName, 'patch_state');
	  assert.notEqual(results[0]!.isError, true, JSON.stringify(results[0]!.content));
	  assert.equal(s.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && JSON.stringify(e.message.content).includes(`NATIVE-ANSWER-${marker}`)).length, 1, 'native answer delivered');
	  for (const scope of scopes) assert.equal(f.readState(s, 0, scope).tactics[`${scope}Marker`], marker);
	}
	async function plain(f: RealPiFixture, s: AgentSession, marker: string) {
	  let calls = 0;
	  f.faux.setResponses([() => { calls++; return fauxAssistantMessage(marker); }]);
	  await s.prompt(`request ${marker}`);
	  assert.equal(calls, 1);
	}
	async function create(f: RealPiFixture, scopes: ScopeSelection, mode: Mode) { config(f, scopes, mode); return f.createRuntime('new'); }
	function assertNoCapturedAnswer(f: RealPiFixture, s: AgentSession, scopes: ScopeSelection) {
	  assertNoPrivate(f, s);
	  // readState normalizes absence to ''; no canonical shared body may capture the answer.
	  assert.equal(f.readState(s).response, '');
	  for (const scope of scopes) {
	    const p = scopePaths(f, s, scope);
	    assert.doesNotMatch(fs.readFileSync(p.checkpoint, 'utf8') + fs.readFileSync(p.patches, 'utf8'), /NATIVE-ANSWER/);
	  }
	}
	async function forkCase(t: TestContext, scopes: ScopeSelection, mode: Mode, laterOff = false) {
	  const f = await realPiFixture(t, { stateFlow: true, mode: 'configured', initializeRepository: false });
	  const runtime = await create(f, scopes, mode), parent = runtime.session;
	  await patch(f, parent, scopes, 'OLDER_POINT');
	  const point = parent.sessionManager.getLeafId()!;
	  await patch(f, parent, scopes, 'PARENT_CURRENT');
	  const parentFile = parent.sessionFile!, parentPrivate = bytes(privateFiles(f, parent));
	  const sourceSession = scopes.includes('session') ? structuredClone(f.readState(parent, 0, 'session')) : undefined;
	  config(f, scopes.length === 3 ? ['cwd'] : ALL, mode === 'active' ? 'passive' : 'active');
	  if (laterOff) await parent.prompt('/state-flow-off');
	  const nativeBeforeFork = fs.readFileSync(parentFile);
	  const io = { parentFile, privatePaths: privateFiles(f, parent), sessionDir: f.sessionDir };
	  const probe = await observeIO(io, async () => { assert.equal((await runtime.fork(point, { position: 'at' })).cancelled, false); });
	  assert.ifError(probe.error);
	  assertBounded(probe);
	  const child = runtime.session;
	  assert.notEqual(child.sessionId, parent.sessionId);
	  assert.notEqual(nativeSessionKey(child), nativeSessionKey(parent));
	  assert.equal(child.sessionManager.getHeader()!.parentSession, parentFile);
	  assert.deepEqual(policy(child).scopes, scopes, 'native parent capture wins over later repository defaults');
	  assert.equal(policy(child).mode, mode, 'earlier native policy wins over later parent Off/defaults');
	  assert.equal(life(f, child).step, 0);
	  assert.equal(life(f, child).specification, undefined);
	  assert.deepEqual(JSON.parse(fs.readFileSync(lifePaths(f, child).config, 'utf8')).scopes, scopes);
	  for (const scope of scopes) assert.equal(f.readState(child, 0, scope).tactics[`${scope}Marker`], 'PARENT_CURRENT', 'current memory, not old native-point snapshot');
	  if (scopes.includes('session')) {
	    assert.deepEqual(f.readState(child, 0, 'session'), sourceSession);
	    assert.equal(life(f, child).privateAcquisition, 'acquired');
	    assert.deepEqual(life(f, child).identity, { cwd: f.cwd, sessionId: child.sessionId });
	    assert.equal(probe.copyCalls, 1);
	    assert.ok(probe.records.some(r => r.ownedParentHeader), 'positive control: attributable State Flow header read');
	    assert.ok(probe.records.some(r => r.parentPrivate), 'positive control: exact private read');
	  } else {
	    assertSharedIO(probe);
	    assertNoCapturedAnswer(f, child, scopes);
	    assert.equal(life(f, child).privateAcquisition, 'deferred', 'not independent unacquired origin');
	    assert.ok(pending(child).length > 0);
	  }
	  assert.deepEqual(fs.readFileSync(parentFile), nativeBeforeFork);
	  assert.deepEqual(bytes(privateFiles(f, parent)), parentPrivate);
	  const beforeStep = life(f, child).step;
	  await patch(f, child, scopes, 'CHILD_OWN');
	  assert.equal(life(f, child).step, beforeStep + (mode === 'active' && scopes.includes('session') ? 2 : 1), 'one patch plus only legitimate Session answer capture');
	  if (!scopes.includes('session')) assertNoCapturedAnswer(f, child, scopes);
	  const ownPrivate = scopes.includes('session') ? structuredClone(f.readState(child, 0, 'session')) : undefined;
	  const childPrivate = bytes(privateFiles(f, child));
	  if (scopes.includes('session')) {
	    const peer = await f.createSession('resume', SessionManager.open(parentFile, f.sessionDir));
	    if (laterOff) await peer.prompt('/state-flow-active');
	    await patch(f, peer, scopes, 'PARENT_PEER_LATER');
	    const peerBodies = bytes(privateFiles(f, peer)), peerNative = fs.readFileSync(parentFile);
	    await child.reload();
	    assert.deepEqual(f.readState(child, 0, 'session'), ownPrivate);
	    await child.navigateTree(point, { summarize: false });
	    assert.deepEqual(f.readState(child, 0, 'session'), ownPrivate, 'earlier parent native point retains current child private changes');
	    assert.deepEqual(bytes(privateFiles(f, child)), childPrivate);
	    assert.deepEqual(bytes(privateFiles(f, peer)), peerBodies);
	    assert.deepEqual(fs.readFileSync(parentFile), peerNative);
	  } else {
	    const pendingBefore = pending(child).map(e => JSON.stringify(e));
	    const traceBefore = fs.readFileSync(child.sessionFile!, 'utf8'), parentBefore = fs.readFileSync(parentFile);
	    const observed = { ...io, canonicalPaths: watchedPaths(f, parent, child) };
	    assertOffIO(await observeIO(observed, () => child.prompt('/state-flow-off')));
	    assertOffIO(await observeIO(observed, () => child.reload()));
	    assert.deepEqual(pending(child).slice(0, pendingBefore.length).map(e => JSON.stringify(e)), pendingBefore);
	    assert.ok(fs.readFileSync(child.sessionFile!, 'utf8').startsWith(traceBefore), 'native trace never erased');
	    assertNoPrivate(f, child);
	    assert.deepEqual(fs.readFileSync(parentFile), parentBefore);
	    await plain(f, child, 'OFF-NATIVE-ANSWER');
	    assertNoPrivate(f, child);
	  }
	}
	async function lateCase(t: TestContext, scopes: ScopeSelection, mode: Mode, missingProof = false) {
	  const f = await realPiFixture(t, { stateFlow: true, mode: 'configured', initializeRepository: false });
	  const runtime = await create(f, scopes, mode), parent = runtime.session;
	  await patch(f, parent, scopes, 'SHARED_PARENT');
	  assertNoPrivate(f, parent);
	  assert.equal(life(f, parent).privateAcquisition, 'unacquired');
	  const point = parent.sessionManager.getLeafId()!, parentFile = parent.sessionFile!;
	  const io = { parentFile, privatePaths: privateFiles(f, parent), sessionDir: f.sessionDir };
	  assertSharedIO(await observeIO(io, async () => { assert.equal((await runtime.fork(point, { position: 'at' })).cancelled, false); }));
	  const child = runtime.session;
	  assertNoPrivate(f, child);
	  assert.equal(life(f, child).privateAcquisition, 'deferred');
	  const peer = await f.createSession('resume', SessionManager.open(parentFile, f.sessionDir));
	  await peer.prompt('/state-flow-off');
	  policyAdapter(peer, ['session']);
	  await peer.reload();
	  assertNoPrivate(f, peer);
	  assert.equal(life(f, peer).privateAcquisition, 'unacquired', 'native policy data is not an acquisition grant');
	  await peer.prompt('/state-flow-active');
	  assert.equal(life(f, peer).privateAcquisition, 'acquired');
	  await patch(f, peer, ['session'], 'LATEST_PARENT_PRIVATE');
	  const source = structuredClone(f.readState(peer, 0, 'session'));
	  const parentBytes = bytes(privateFiles(f, peer)), parentTrace = fs.readFileSync(parentFile);
	  await child.prompt('/state-flow-off');
	  policyAdapter(child, ['session'], true);
	  await child.reload();
	  assertNoPrivate(f, child);
	  assert.equal(life(f, child).privateAcquisition, 'deferred');
	  if (missingProof) fs.unlinkSync(privateFiles(f, peer)[0]!); // Disposable fixture only; no repair.
	  const probe = await observeIO(io, () => child.prompt('/state-flow-active'));
	  assert.ifError(probe.error);
	  assertBounded(probe);
	  if (missingProof) {
	    assertNoPrivate(f, child);
	    assert.equal(life(f, child).privateAcquisition, 'deferred');
	    assert.throws(() => f.readState(child, 0, 'session'), /unavailable/);
	    assert.ok(f.notifications.some(n => /missing|incomplete|unavailable|partial|absent/i.test(n)), f.notifications.join('\n'));
	    assert.deepEqual(fs.readFileSync(parentFile), parentTrace);
	    return;
	  }
	  assert.equal(probe.copyCalls, 1);
	  assert.ok(probe.records.some(r => r.ownedParentHeader));
	  assert.ok(probe.records.some(r => r.parentPrivate));
	  assert.equal(life(f, child).privateAcquisition, 'acquired');
	  assert.deepEqual(f.readState(child, 0, 'session'), source, 'latest NOW-acquired direct parent, not invented empty root');
	  assert.deepEqual(bytes(privateFiles(f, peer)), parentBytes);
	  assert.deepEqual(fs.readFileSync(parentFile), parentTrace);
	  await patch(f, child, ['session'], 'CHILD_PRIVATE_AFTER_LATE');
	  const childBodies = bytes(privateFiles(f, child)), own = structuredClone(f.readState(child, 0, 'session'));
	  await patch(f, peer, ['session'], 'PARENT_CHANGED_AGAIN');
	  const peerNow = bytes(privateFiles(f, peer)), peerTrace = fs.readFileSync(parentFile);
	  await child.reload();
	  assert.deepEqual(f.readState(child, 0, 'session'), own);
	  await child.navigateTree(point, { summarize: false });
	  assert.throws(() => f.readState(child, 0, 'session'), /session scope is excluded/, 'earlier shared policy does not expose retained private state');
	  assert.deepEqual(bytes(privateFiles(f, child)), childBodies, 'excluded acquired private bytes preserved');
	  await child.prompt('/state-flow-off');
	  policyAdapter(child, ['session'], true);
	  await child.reload();
	  const recapture = await observeIO(io, () => child.prompt('/state-flow-active'));
	  assert.ifError(recapture.error);
	  assert.equal(recapture.copyCalls, 0, 'already acquired child-current never recopies');
	  assert.equal(recapture.records.filter(r => r.ownedParentHeader || r.parentPrivate).length, 0, 'no parent proof/body read for acquired child-current');
	  assert.deepEqual(f.readState(child, 0, 'session'), own);
	  assert.deepEqual(bytes(privateFiles(f, peer)), peerNow);
	  assert.deepEqual(fs.readFileSync(parentFile), peerTrace);
	  assert.equal(child.sessionManager.getHeader()!.parentSession, parentFile);
	}
	for (const scopes of SEVEN) for (const mode of ['active', 'passive'] as const) test(`native fork/current selected=${scopes.join('+')} mode=${mode}`, { timeout: 30000 }, t => forkCase(t, scopes, mode));
	for (const scopes of SHARED) for (const mode of ['active', 'passive'] as const) test(`native late Session selected=${scopes.join('+')} mode=${mode}`, { timeout: 30000 }, t => lateCase(t, scopes, mode));
	test('native late Session missing required parent proof selected=global mode=active', { timeout: 30000 }, t => lateCase(t, ['global'], 'active', true));
}

{
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("native selection did not withdraw before exclusion release")), 3000);
		})]).finally(() => clearTimeout(timer));
	}

	/** Watch the exact canonical cohort, not native trace or every filesystem alias. */
	async function noCanonicalIO(paths: Set<string>, action: () => Promise<void>): Promise<void> {
		const read = fs.readFileSync, open = fs.openSync, stat = fs.lstatSync, exists = fs.existsSync;
		const attempts: string[] = [];
		const guard = (path: unknown, operation: string) => {
			if (paths.has(String(path))) { attempts.push(`${operation}:${String(path)}`); throw new Error("Off canonical I/O attempted"); }
		};
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { guard(args[0], "read"); return read(...args); }) as typeof fs.readFileSync;
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { guard(args[0], "open"); return open(...args); }) as typeof fs.openSync;
		fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => { guard(args[0], "stat"); return stat(...args); }) as typeof fs.lstatSync;
		fs.existsSync = ((path: fs.PathLike) => { guard(path, "exists"); return exists(path); }) as typeof fs.existsSync;
		syncBuiltinESMExports();
		try { await action(); assert.deepEqual(attempts, [], "denial must not swallow canonical I/O attempts"); }
		finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = stat; fs.existsSync = exists; syncBuiltinESMExports(); }
	}

	const selections = Array.from({ length: 7 }, (_, index) => captureScopeSelection(
		DEFAULT_SCOPE_SELECTION.filter((_scope, bit) => ((index + 1) & (1 << bit)) !== 0),
	));

	for (const scopes of selections) test(`native selected ${scopes.join("+")} Start withdraws on Off policy scope ABA before exclusion release`, { timeout: 15_000 }, async t => {
		let policy!: SelectedPolicyLifetime;
		const select = SelectedPolicyLifetime.prototype.select;
		t.mock.method(SelectedPolicyLifetime.prototype, "select", function(this: SelectedPolicyLifetime, ...args: Parameters<typeof select>) {
			const value = Reflect.apply(select, this, args); policy = this; return value;
		});
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes }));
		const runtime = await f.createRuntime("new"), session = runtime.session, target = scopes[0];
		let seedResult: Context["messages"][number] | undefined;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { retained: "native-created" } } }), { id: "seed" }), { stopReason: "toolUse" }),
			context => { seedResult = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "seed"); return fauxAssistantMessage("Seed accepted"); },
		]);
		await session.prompt("Create selected memory through the original native tool");
		assert.ok(seedResult?.role === "toolResult"); assert.notEqual(seedResult.isError, true);
		await session.prompt("/state-flow-off");
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		const before = files(), notices = [...f.notifications];
		mkdirSync(f.repositoryRoot, { recursive: true });
		let entered!: () => void, release!: () => void, staged!: () => void;
		const enteredLock = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const enteredStart = new Promise<void>(resolve => { staged = resolve; });
		t.after(() => release());
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; });
		await enteredLock;
		let oldSignal: AbortSignal | undefined;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) {
			oldSignal = args[2]; staged(); return Reflect.apply(inspect, this, args);
		});
		const oldStart = session.prompt("/state-flow-active");
		await deadline(enteredStart); spy.mock.restore();
		assert.ok(oldSignal); assert.equal(oldSignal.aborted, false);
		const selectData = async (wanted: ScopeSelection) => {
			// Owned native-policy DATA adapter, not a public scope chooser or private grant.
			session.sessionManager.appendCustomEntry("state-flow-passive-stop", { version: 2, owner: session.sessionId, mode: "off", scopes: wanted });
			const point = session.sessionManager.getLeafId()!;
			session.sessionManager.appendCustomEntry("native-scope-cancellation-sentinel", { point });
			assert.equal((await session.navigateTree(point, { summarize: false })).cancelled, false);
			assert.equal(policy.policy!.mode, "off"); assert.deepEqual(policy.policy!.scopes, wanted);
		};
		const alternative = captureScopeSelection(scopes.length === 1 && scopes[0] === "cwd" ? ["global"] : ["cwd"]);
		await noCanonicalIO(new Set(before.map(file => file.path)), async () => {
			await selectData(alternative);
			assert.equal(oldSignal!.aborted, true); await deadline(oldStart);
			assert.equal(fs.existsSync(`${f.repositoryRoot}/.state-flow-publication.lock`), true);
			await selectData(scopes);
			assert.equal(oldSignal!.aborted, true, "equal-valued A does not revive old Start authority");
		});
		assert.deepEqual(files(), before); assert.deepEqual(f.notifications, notices, "superseded Start reports no stale failure");
		release(); await holding;
		await session.prompt("/state-flow-active");
		assert.deepEqual(policy.policy!.scopes, scopes); assert.equal(policy.policy!.mode, "active");
		assert.equal(f.readState(session, 0, target).tactics.retained, "native-created");
		let freshResult: Context["messages"][number] | undefined;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { fresh: true } } }), { id: "fresh" }), { stopReason: "toolUse" }),
			context => { freshResult = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "fresh"); return fauxAssistantMessage("Fresh selected operation accepted"); },
		]);
		await session.prompt("Use the fresh selected original operation");
		assert.ok(freshResult?.role === "toolResult"); assert.notEqual(freshResult.isError, true);
		assert.equal(f.readState(session, 0, target).tactics.fresh, true);
		for (const scope of DEFAULT_SCOPE_SELECTION.filter(scope => !scopes.includes(scope))) assert.throws(() => f.readState(session, 0, scope), /scope is excluded/);
	});
}

{
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("selected native publication did not withdraw before lock release")), 3000);
		})]).finally(() => clearTimeout(timer));
	}
	const selections = Array.from({ length: 7 }, (_, index) => captureScopeSelection(
		DEFAULT_SCOPE_SELECTION.filter((_scope, bit) => ((index + 1) & (1 << bit)) !== 0),
	));

	for (const scopes of selections) for (const kind of ["patch", "response"] as const)
		test(`native ${scopes.join("+")} ${kind} publication withdraws on Off while exclusion remains held`, { timeout: 15_000 }, async t => {
			const target = scopes[0], marker = `WAITING-${scopes.join("-")}-${kind}`;
			let armed = false;
			const f = await realPiFixture(t, { mode: "configured", initializeRepository: false, extensions: [{
				name: "selected-publication-witness", factory(pi) {
					pi.on("tool_call", event => { if (kind === "patch" && event.toolCallId === "waiting-native-patch") armed = true; });
					pi.on("message_end", event => {
						if (kind === "response" && event.message.role === "assistant" && JSON.stringify(event.message.content).includes(marker)) armed = true;
					});
				},
			}] });
			fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes }));
			const runtime = await f.createRuntime("new"), session = runtime.session;
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { retained: "native-created" } } }), { id: "seed" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Seed accepted"),
			]);
			await session.prompt("Create selected memory");
			assert.equal(f.readState(session, 0, target).tactics.retained, "native-created");
			await session.prompt("/state-flow-active");
			let release: () => void = () => {}, entered!: () => void;
			let holding: Promise<void> | undefined, oldSignal: AbortSignal | undefined;
			const waiting = new Promise<void>(resolve => { entered = resolve; });
			const patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
			t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof patch>) {
				if (!armed) return Reflect.apply(patch, this, args);
				armed = false;
				let locked!: () => void;
				const acquired = new Promise<void>(resolve => { locked = resolve; });
				const gate = new Promise<void>(resolve => { release = resolve; });
				// A separate fixture-owned exclusion holder; it authors no semantic data.
				holding = withStorageTransaction(f.repositoryRoot, async () => { locked(); await gate; });
				return acquired.then(() => { oldSignal = args[2]; entered(); return Reflect.apply(patch, this, args); });
			});
			f.faux.setResponses(kind === "patch" ? [
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { stale: marker } } }), { id: "waiting-native-patch" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Old native tool settled"),
			] : [fauxAssistantMessage(marker)]);
			const operation = session.prompt(`Begin cancellable ${kind}`);
			try {
				await deadline(waiting); assert.ok(oldSignal); assert.equal(oldSignal.aborted, false);
				// Preparation is already accepted; cancellation must not undo that earlier acceptance.
				const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
				const before = files(), notices = [...f.notifications];
				await session.prompt("/state-flow-off");
				await deadline(operation);
				assert.equal(oldSignal.aborted, true);
				assert.equal(fs.existsSync(`${f.repositoryRoot}/.state-flow-publication.lock`), true);
				assert.deepEqual(files(), before, "no stale publication and no rollback of accepted preparation");
				assert.deepEqual(f.notifications, notices, "withdrawn publication emits no stale diagnostic");
				if (kind === "patch") {
					const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "waiting-native-patch");
					assert.ok(result?.role === "toolResult"); assert.equal(result.isError, true, "original native patch execution was rejected");
				} else assert.ok(session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(marker)), "ordinary native answer delivered despite capture cancellation");
			} finally {
				release(); await holding;
				await operation;
			}
			await session.prompt("/state-flow-active");
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { fresh: true } } }), { id: "fresh" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Fresh answer"),
			]);
			await session.prompt("Use a fresh selected native request");
			assert.equal(f.readState(session, 0, target).tactics.retained, "native-created");
			assert.equal(f.readState(session, 0, target).tactics.stale, undefined);
			assert.equal(f.readState(session, 0, target).tactics.fresh, true);
			for (const scope of DEFAULT_SCOPE_SELECTION.filter(scope => !scopes.includes(scope))) assert.throws(() => f.readState(session, 0, scope), /scope is excluded/);
		});
}

{
	const sharedSelections: ScopeSelection[] = [["global"], ["cwd"], ["global", "cwd"]];
	for (const scopes of sharedSelections) test(`native shared ${scopes.join("+")} peers preserve untargeted accepted drift without a private owner`, { timeout: 20_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		fs.writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "passive", scopes }));
		const first = await f.createSession("new"), second = await f.createSession("new");
		assert.notEqual(first.sessionId, second.sessionId);
		const results = new Map<string, ToolResultMessage>();
		const observe = (context: Context) => {
			for (const message of context.messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
		};
		const publish = async (session: typeof first, field: string, id: string) => {
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", modelPatchArguments(scopes, Object.fromEntries(scopes.map(scope => [scope, { strategy: { [field]: id } }]))), { id }), { stopReason: "toolUse" }),
				context => { observe(context); return fauxAssistantMessage(`Accepted ${id}`); },
			]);
			await session.prompt(`Publish ${id}`);
			const result = results.get(id); assert.ok(result); assert.notEqual(result.isError, true, JSON.stringify(result.content));
		};
		await publish(first, "firstOwner", "first-initial");
		await publish(second, "secondOwner", "second-accepted");
		// The first instance still has its older accepted cache; publication must use live shared state.
		await publish(first, "firstAfterPeer", "first-fresh");
		for (const scope of scopes) {
			assert.equal(f.readState(first, 0, scope).strategy.firstOwner, "first-initial");
			assert.equal(f.readState(first, 0, scope).strategy.secondOwner, "second-accepted");
			assert.equal(f.readState(first, 0, scope).strategy.firstAfterPeer, "first-fresh");
		}
		await second.reload();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_state", { paths: scopes.flatMap(scope => ["firstOwner", "secondOwner", "firstAfterPeer"].map(field => `${scope}.strategy.${field}`)) }, { id: "peer-read" }), { stopReason: "toolUse" }),
			context => { observe(context); return fauxAssistantMessage("Current peer values observed"); },
		]);
		await second.prompt("Read current shared values after native reload");
		const read = results.get("peer-read"); assert.ok(read); assert.notEqual(read.isError, true);
		const body = read.content.filter(part => part.type === "text").map(part => part.text).join("");
		assert.deepEqual(JSON.parse(body).value, scopes.flatMap(() => ["first-initial", "second-accepted", "first-fresh"]));
		for (const session of [first, second]) {
			assert.throws(() => f.readState(session, 0, "session"), /session scope is excluded/);
			const paths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
			assert.deepEqual([paths.checkpoint, paths.patches, paths.meta].map(path => fs.existsSync(path)), [false, false, false]);
		}
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners: StateScope[] = ['global', 'cwd', 'session'];
	const selections: StateScope[][] = [['global'], ['cwd'], ['session'], ['global', 'cwd'], ['global', 'session'], ['cwd', 'session'], owners];
	const text = (m: AgentMessage): string => 'content' in m && Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
	for (const selected of selections) for (const chosen of ['active', 'passive', 'off'] as const)
	  test(`native public scopes ${selected.join('+')} ${chosen}`, { timeout: 60000 }, async t => {
	    const f = await realPiFixture(t, { mode: 'configured', initializeRepository: false });
	    const config = `${f.repositoryRoot}/config.json`;
	    writeFileSync(config, JSON.stringify({ mode: 'off', scopes: owners }));
	    const defaults = readFileSync(config);
	    const { session } = await f.createRuntime('new');
	    const errors: unknown[] = [];
	    await session.bindExtensions({ onError: error => { errors.push(error); } });
	    const key = nativeSessionKey(session);
	    const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
	    const semantic = (scope: StateScope) => {
	      const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, key);
	      return [p.checkpoint, p.patches, p.meta].map(path => [path, existsSync(path) ? readFileSync(path).toString('base64') : null]);
	    };
	    const checkpoints = () => session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'state-flow-snapshot').length;
	    const status = async () => {
	      await session.prompt('/state-flow-status');
	      assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${selected.join(', ')}`), JSON.stringify({ notifications: f.notifications, errors }));
	    };
	    const before = files(), accepted = checkpoints();
	    await session.prompt(`/state-flow-${chosen} ${[...selected].reverse().join(' ')}`);
	    assert.deepEqual(errors, [], 'public scope command must succeed through SDK');
	    await status();
	    assert.deepEqual(readFileSync(config), defaults);
	    if (chosen !== 'active') {
	      assert.deepEqual(files(), before, 'Passive/Off selection has no canonical publication (not a read-I/O proof)');
	      assert.equal(checkpoints(), accepted);
	    }
	    const excluded = owners.filter(o => !selected.includes(o));
	    const excludedBefore = excluded.map(semantic);
	    const assertExcluded = () => {
	      assert.deepEqual(excluded.map(semantic), excludedBefore);
	      for (const o of excluded) assert.throws(() => f.readState(session, 0, o), /excluded|unavailable/);
	      if (!selected.includes('session')) assert.ok(semantic('session').every(([, bytes]) => bytes === null));
	    };
	    let calls = 0;
	    let observed: Context | undefined;
	    f.faux.setResponses([c => { calls++; observed = structuredClone(c); return answer('Before first patch'); }]);
	    await session.prompt('Observe mode before the first native patch');
	    assert.equal(calls, 1);
	    assert.ok(observed);
	    for (const name of ['patch_state', 'read_state']) assert.equal(getCurrentTools(observed.messages).some(v => v.name === name), chosen !== 'off');
	    if (chosen === 'off') assert.equal(getCurrentSystemMessage(observed.messages)?.sections?.state_flow, undefined);
	    if (chosen !== 'active') {
	      assert.deepEqual(files(), before, 'Passive/Off ordinary delivery cannot initialize canonical lifecycle');
	      assert.equal(checkpoints(), accepted);
	    }
	    if (chosen === 'off') { await session.prompt('/state-flow-active'); await status(); }
	    const mode = chosen === 'passive' ? 'passive' : 'active';
	    const results: ToolResultMessage[] = [];
	    let patchBytes: ReturnType<typeof semantic>[] | undefined;
	    calls = 0;
	    const marker = `public-${selected.join('-')}-${chosen}`;
	    const patch = Object.fromEntries(selected.map(o => [o, { tactics: { [o]: marker }, lazy: { hidden: `LAZY-${marker}` } }]));
	    f.faux.setResponses([
	      () => { calls++; return answer(tool('patch_state', modelPatchArguments(selected, patch), { id: 'public-first-patch' }), { stopReason: 'toolUse' }); },
	      c => { calls++; results.push(...c.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolCallId === 'public-first-patch')); patchBytes = owners.map(semantic); return answer('Public ordinary answer'); },
	    ]);
	    await session.prompt('Write the publicly selected native owners');
	    assert.equal(calls, 2);
	    assert.equal(results.length, 1, 'exactly one original-ID native result');
	    assert.notEqual(results[0].isError, true, text(results[0]));
	    for (const o of selected) assert.equal(f.readState(session, 0, o).tactics?.[o], marker);
	    if (mode === 'active' && selected.includes('session')) assert.equal(f.readState(session).response, 'Public ordinary answer');
	    else { assert.ok(!f.readState(session).response); assert.deepEqual(owners.map(semantic), patchBytes); }
	    assertExcluded();
	    for (const [i, path] of [`${selected[0]}.tactics.${selected[0]}`, ...(excluded.length ? [excluded[0]] : [])].entries()) {
	      const reads: ToolResultMessage[] = [];
	      calls = 0;
	      f.faux.setResponses([
	        () => { calls++; return answer(tool('read_state', { path }, { id: `public-read-${i}` }), { stopReason: 'toolUse' }); },
	        c => {
	          calls++; reads.push(...c.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolCallId === `public-read-${i}`));
	          observed = structuredClone(c); return answer('Read finished');
	        },
	      ]);
	      await session.prompt('Read a canonical owner through native tools');
	      assert.equal(calls, 2); assert.equal(reads.length, 1);
	      assert.equal(Boolean(reads[0].isError), i > 0, text(reads[0]));
	      if (i === 0) assert.equal(JSON.parse(text(reads[0])).value, marker);
	      assert.ok(observed);
	      const heads: string[] = observed.messages.filter(m => m.role === 'user').map(text).filter(s => /^State Flow (?:runtime context|passive memory)/.test(s));
	      for (const head of heads) {
	        assert.ok(!head.includes(`LAZY-${marker}`), 'automatic head excludes lazy bodies, not prior native tool arguments');
	      }
	    }
	    assert.deepEqual(readFileSync(config), defaults);
	    writeFileSync(config, JSON.stringify({ mode: 'off', scopes: selected.length === 3 ? ['cwd'] : owners.filter(o => !selected.includes(o)) }));
	    const changedDefaults = readFileSync(config);
	    await session.reload();
	    for (const command of ['/state-flow-passive   ', '/state-flow-off', '/state-flow-active']) {
	      const semanticBefore = owners.map(semantic);
	      await session.prompt(command); await status(); assertExcluded();
	      if (command !== '/state-flow-active') assert.deepEqual(owners.map(semantic), semanticBefore);
	      if (command !== '/state-flow-off') for (const o of selected) assert.equal(f.readState(session, 0, o).tactics?.[o], marker);
	    }
	    assert.deepEqual(readFileSync(config), changedDefaults);
	    assert.deepEqual(errors, []);
	  });

	for (const mode of ['active', 'passive', 'off'] as const)
	  test(`native public ${mode} malformed arguments are atomic`, { timeout: 60000 }, async t => {
	    const f = await realPiFixture(t, { mode: 'configured', initializeRepository: false });
	    const config = `${f.repositoryRoot}/config.json`;
	    writeFileSync(config, JSON.stringify({ mode: 'off', scopes: owners }));
	    const defaults = readFileSync(config);
	    const { session } = await f.createRuntime('new');
	    const errors: unknown[] = [];
	    await session.bindExtensions({ onError: error => { errors.push(error); } });
	    const key = nativeSessionKey(session);
	    const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
	    const before = files();
	    const accepted = session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'state-flow-snapshot').length;
	    for (const args of ['cwd cwd', 'bogus', 'global,cwd']) {
	      const notice = f.notifications.length, errorCount = errors.length;
	      let error: unknown;
	      try { await session.prompt(`/state-flow-${mode} ${args}`); } catch (caught) { error = caught; }
	      assert.ok(error || errors.length > errorCount || f.notifications.length > notice, 'actual SDK exposes argument refusal');
	      assert.deepEqual(files(), before);
	      assert.equal(session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'state-flow-snapshot').length, accepted);
	      await session.prompt('/state-flow-status');
	      assert.ok(f.notifications.at(-1)?.includes('Selected scopes: global, cwd, session'));
	      assert.ok(f.notifications.at(-1)?.includes('Mode: off'));
	      assert.deepEqual(readFileSync(config), defaults);
	    }
	  });
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("public selector did not withdraw before exclusion release")), 3000); })]).finally(() => clearTimeout(timer));
	}
	async function seed(f: RealPiFixture, s: AgentSession, scopes = DEFAULT_SCOPE_SELECTION) {
		const results: ToolResultMessage[] = [];
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(scopes, { cwd: { tactics: { retained: true } } }), { id: "public-seed" }), { stopReason: "toolUse" }), c => {
			results.push(...c.messages.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "public-seed")); return answer("Seed accepted");
		}]);
		await s.prompt("Create genuine native source"); assert.equal(results.length, 1); assert.notEqual(results[0]!.isError, true);
	}
	async function noCanonicalIO(paths: Set<string>, action: () => Promise<void>) {
		const read = fs.readFileSync, open = fs.openSync, stat = fs.lstatSync, exists = fs.existsSync, attempts: string[] = [];
		const guard = (p: unknown) => { if (paths.has(String(p))) { attempts.push(String(p)); throw new Error("Off canonical I/O"); } };
		fs.readFileSync = ((...a: Parameters<typeof read>) => { guard(a[0]); return read(...a); }) as typeof read;
		fs.openSync = ((...a: Parameters<typeof open>) => { guard(a[0]); return open(...a); }) as typeof open;
		fs.lstatSync = ((...a: Parameters<typeof stat>) => { guard(a[0]); return stat(...a); }) as typeof stat;
		fs.existsSync = p => { guard(p); return exists(p); }; syncBuiltinESMExports();
		try { await action(); assert.deepEqual(attempts, [], "no swallowed canonical I/O attempts"); }
		finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = stat; fs.existsSync = exists; syncBuiltinESMExports(); }
	}
	const selections = Array.from({ length: 7 }, (_, i) => captureScopeSelection(DEFAULT_SCOPE_SELECTION.filter((_, bit) => ((i + 1) & (1 << bit)) !== 0)));
	for (const scopes of selections) test(`public Off ${scopes.join("+")} is canonical-I/O inert and withdraws pending Start before release`, { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { mode: "passive", initializeRepository: false }), { session } = await f.createRuntime("new");
		await seed(f, session); await session.prompt("/state-flow-off");
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before = files();
		let release!: () => void, entered!: () => void, staged!: () => void;
		const enteredLock = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { staged = r; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; }); await enteredLock;
		let oldSignal: AbortSignal | undefined;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) { oldSignal = args[2]; staged(); return Reflect.apply(inspect, this, args); });
		const starting = session.prompt("/state-flow-active");
		try {
			await deadline(waiting); spy.mock.restore(); assert.ok(oldSignal); assert.equal(oldSignal.aborted, false);
			await noCanonicalIO(new Set(before.map(f => f.path)), async () => {
				await session.prompt(`/state-flow-off ${[...scopes].reverse().join(" ")}`);
				await deadline(starting); assert.equal(oldSignal!.aborted, true);
				await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`));
				await session.prompt("/state-flow-off global cwd session"); assert.equal(oldSignal!.aborted, true, "equal-valued original selection cannot revive Start");
			});
			assert.deepEqual(files(), before);
		} finally { release(); await holding; await starting; }
		await session.prompt(`/state-flow-active ${scopes.join(" ")}`);
		await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`));
		await session.reload(); await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`));
	});

	for (const mode of ["active", "passive"] as const) test(`public ${mode} scope A-B-A withdraws B before release and accepts fresh A`, { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-${mode} cwd`); await seed(f, session, ["cwd"]);
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before = files();
		let release!: () => void, entered!: () => void, staged!: () => void;
		const acquired = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { staged = r; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; }); await acquired;
		let signalB: AbortSignal | undefined;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...args: Parameters<typeof inspect>) { signalB = args[2]; staged(); return Reflect.apply(inspect, this, args); });
		const b = session.prompt(`/state-flow-${mode} cwd session`);
		let a: Promise<void> | undefined;
		try {
			await deadline(waiting); spy.mock.restore(); assert.ok(signalB); assert.equal(signalB.aborted, false);
			a = session.prompt(`/state-flow-${mode} cwd`); await deadline(b); assert.equal(signalB.aborted, true);
			assert.deepEqual(files(), before);
		} finally { release(); await holding; await b; await a; }
		assert.equal(f.readState(session, 0, "cwd").tactics.retained, true); assert.throws(() => f.readState(session, 0, "session"), /excluded/);
		const p = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
		assert.deepEqual([p.checkpoint, p.patches, p.meta].map(p => fs.existsSync(p)), [false, false, false]);
		await session.reload(); assert.equal(f.readState(session, 0, "cwd").tactics.retained, true);
	});

	for (const bookmark of [true, false]) test(`newer public mode-only Passive survives scope Start header wait and reload bookmark=${bookmark}`, { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		const root = session.sessionManager.getLeafId()!;
		await session.prompt("/state-flow-passive cwd"); await seed(f, session, ["cwd"]);
		if (!bookmark) assert.equal((await session.navigateTree(root, { summarize: false })).cancelled, false);
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before = files();
		let release!: () => void, entered!: () => void, staged!: () => void, installed!: () => void;
		const acquired = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { staged = r; }), observing = new Promise<void>(r => { installed = r; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; }); await acquired;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle, refresh = TemporalRuntime.prototype.refreshSelectedShared;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...a: Parameters<typeof inspect>) { staged(); return Reflect.apply(inspect, this, a); });
		t.mock.method(TemporalRuntime.prototype, "refreshSelectedShared", async function(this: TemporalRuntime, ...a: Parameters<typeof refresh>) { const v = await Reflect.apply(refresh, this, a); installed(); return v; });
		const starting = session.prompt("/state-flow-active cwd session");
		try { await deadline(waiting); spy.mock.restore(); await session.prompt("/state-flow-passive"); await deadline(starting); assert.deepEqual(files(), before); }
		finally { release(); await holding; await starting; }
		await deadline(observing); await new Promise<void>(r => setImmediate(r));
		assert.equal(f.readState(session, 0, "cwd").tactics.retained, true); assert.deepEqual(files(), before);
		await session.reload(); assert.equal(f.readState(session, 0, "cwd").tactics.retained, true); assert.deepEqual(files(), before);
		await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes("Mode: passive")); assert.ok(f.notifications.at(-1)?.includes("Selected scopes: cwd, session"));
		assert.ok(f.notifications.at(-1)?.includes("Materialized scopes: cwd"), "wanted participation is not a fabricated private view");
	});

	for (const change of [false, true]) test(`public equal canonical choice preserves pending native patch; scope ABA cancels it change=${change}`, { timeout: 15_000 }, async t => {
		let armed = false;
		const f = await realPiFixture(t, { initializeRepository: false, extensions: [{ name: "public-patch-witness", factory(pi) {
			pi.on("tool_call", e => { if (e.toolCallId === "held-public-patch") armed = true; });
		} }] }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-active cwd session"); await seed(f, session);
		let release!: () => void, staged!: () => void, holding: Promise<void> | undefined, oldSignal: AbortSignal | undefined;
		const waiting = new Promise<void>(r => { staged = r; }), patch = TemporalRuntime.prototype.withSelectedPatchTransaction;
		t.mock.method(TemporalRuntime.prototype, "withSelectedPatchTransaction", function(this: TemporalRuntime, ...a: Parameters<typeof patch>) {
			if (!armed) return Reflect.apply(patch, this, a); armed = false;
			let entered!: () => void;
			const acquired = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
			holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; });
			return acquired.then(() => { oldSignal = a[2]; staged(); return Reflect.apply(patch, this, a); });
		});
		f.faux.setResponses([answer(tool("patch_state", { cwd: { tactics: { held: true } } }, { id: "held-public-patch" }), { stopReason: "toolUse" }), answer("Old operation delivered")]);
		const operation = session.prompt("Begin pending native mutation");
		let b: Promise<void> | undefined, a: Promise<void> | undefined;
		try {
			await deadline(waiting); assert.ok(oldSignal); assert.equal(oldSignal.aborted, false);
			const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			if (!change) {
				await session.prompt("/state-flow-active session cwd"); assert.equal(oldSignal.aborted, false, "equal canonical scope/mode must preserve the request");
			} else {
				b = session.prompt("/state-flow-passive session"); a = session.prompt("/state-flow-passive cwd session");
				await deadline(b); await deadline(operation); assert.equal(oldSignal.aborted, true);
			}
			assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
		} finally { release(); await holding; await operation; await b; await a; }
		const result = session.messages.find(m => m.role === "toolResult" && m.toolCallId === "held-public-patch");
		assert.ok(result?.role === "toolResult"); assert.equal(Boolean(result.isError), change);
		assert.equal(f.readState(session, 0, "cwd").tactics.held, change ? undefined : true);
		assert.equal(f.readState(session, 0, "cwd").tactics.retained, true);
	});

	test("different public Active selection withdraws old-scope inactive persistence without borrowing its completion", { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-active cwd session"); await seed(f, session);
		let release!: () => void, entered!: () => void, staged!: () => void;
		const acquired = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { staged = r; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; }); await acquired;
		let signal: AbortSignal | undefined;
		const persist = TemporalRuntime.prototype.persistSelectedPassive;
		t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive", function(this: TemporalRuntime, ...a: Parameters<typeof persist>) { signal = a[1]; staged(); return Reflect.apply(persist, this, a); });
		const passive = session.prompt("/state-flow-passive"); let active: Promise<void> | undefined;
		try {
			await deadline(waiting); assert.ok(signal); assert.equal(signal.aborted, false);
			active = session.prompt("/state-flow-active cwd"); await deadline(passive); assert.equal(signal.aborted, true);
		} finally { release(); await holding; await passive; await active; }
		await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes("Mode: active")); assert.ok(f.notifications.at(-1)?.includes("Selected scopes: cwd"));
		assert.equal(f.readState(session, 0, "cwd").tactics.retained, true); assert.throws(() => f.readState(session, 0, "session"), /excluded/);
	});

	test("public Passive Session expansion cannot clear a real mode-persistence fence or mint private authority", { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-active cwd"); await seed(f, session, ["cwd"]);
		const persist = t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive", async () => { throw new Error("CONTROLLED_NATIVE_PASSIVE_PERSISTENCE_FAULT"); });
		await session.prompt("/state-flow-passive"); persist.mock.restore();
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		await session.prompt("/state-flow-passive cwd session");
		assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
		assert.throws(() => f.readState(session, 0, "cwd"), /unavailable/); assert.throws(() => f.readState(session, 0, "session"), /unavailable/);
		await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes("Memory writes paused"));
	});

	test("public Session choices cannot reacquire corrupt acquired memory after a shared-only checkpoint", { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-passive cwd session"); await seed(f, session);
		await session.prompt("/state-flow-passive cwd");
		const privatePaths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
		fs.writeFileSync(privatePaths.checkpoint, "null\n");
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		for (const command of ["/state-flow-passive cwd session", "/state-flow-active cwd session"]) {
			await session.prompt(command); assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
			assert.throws(() => f.readState(session, 0, "cwd"), /unavailable/);
		}
	});

	test("public Session expansion of a deferred shared child cannot manufacture parent private permission", { timeout: 15_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), runtime = await f.createRuntime("new"), parent = runtime.session;
		await parent.prompt("/state-flow-passive cwd"); await seed(f, parent, ["cwd"]);
		assert.equal((await runtime.fork(parent.sessionManager.getLeafId()!, { position: "at" })).cancelled, false);
		const child = runtime.session, before = captureTemporalFileBases(f.cwd, child.sessionId, f.repositoryRoot, nativeSessionKey(child));
		const source = captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent));
		for (const command of ["/state-flow-passive cwd session", "/state-flow-active cwd session"]) {
			await child.prompt(command); assert.deepEqual(captureTemporalFileBases(f.cwd, child.sessionId, f.repositoryRoot, nativeSessionKey(child)), before);
			assert.throws(() => f.readState(child, 0, "session"), /unavailable/);
		}
		assert.deepEqual(captureTemporalFileBases(f.cwd, parent.sessionId, f.repositoryRoot, nativeSessionKey(parent)), source);
	});
}

{
	function observeTracker(t: TestContext) {
		let tracker!: SkillReadTracker;
		const clear = SkillReadTracker.prototype.clear;
		t.mock.method(SkillReadTracker.prototype, "clear", function(this: SkillReadTracker) { tracker = this; return Reflect.apply(clear, this, []); });
		return () => tracker;
	}
	function configured(scopes: ScopeSelection) {
		const root = harness({ initializeRepository: false }).repositoryRoot;
		writeFileSync(join(root, "config.json"), JSON.stringify({ scopes }));
		return harness({ initializeRepository: false, repositoryRoot: root, mode: "off" });
	}
	function register(h: ReturnType<typeof harness>, scope: "global" | "cwd" | "session") {
		const source = join(h.repositoryRoot, "fixture-skills", scope, "SKILL.md");
		mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, `registered ${scope} Skill body`);
		h.registerSkill(source, scope === "global" ? "user" : scope === "cwd" ? "project" : "temporary");
		return source;
	}
	function noSourceIO<T>(paths: string[], action: () => T): T {
		const forbidden = new Set(paths), attempts: string[] = [], stat = fs.lstatSync, open = fs.openSync;
		const guard = (path: unknown) => { if (forbidden.has(String(path))) { attempts.push(String(path)); throw new Error("excluded Skill source touched"); } };
		fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => { guard(args[0]); return stat(...args); }) as typeof fs.lstatSync;
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { guard(args[0]); return open(...args); }) as typeof fs.openSync;
		syncBuiltinESMExports();
		try { const result = action(); assert.deepEqual(attempts, [], "a caught hash failure is still forbidden source I/O"); return result; }
		finally { fs.lstatSync = stat; fs.openSync = open; syncBuiltinESMExports(); }
	}

	test("native-bound Skill tracker follows all seven captured Off selections before any enabled-subset execution", async t => {
		const current = observeTracker(t), scopes = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) {
			const wanted = captureScopeSelection(scopes.filter((_, bit) => (mask & (1 << bit)) !== 0)), h = configured(wanted);
			await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
			const tracker = current(); assert.ok(tracker);
			const registered = Object.fromEntries(scopes.map(scope => [scope, register(h, scope)]));
			const key = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId()).key;
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			// Direct lower invocation on the native-bound tracker, not an Off/native read or guard bypass.
			noSourceIO(scopes.filter(scope => !wanted.includes(scope)).map(scope => registered[scope]), () => {
				for (const scope of scopes) {
					const read = tracker.recordResult("read", { path: registered[scope] }, false)!;
					assert.equal(read.scope, scope);
					if (wanted.includes(scope)) assert.match(read.hash!, /^sha256:[0-9a-f]{64}$/);
					else assert.deepEqual(read, { path: registered[scope], scope });
				}
			});
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
		}
	});

	test("native scope DATA ABA clears pending Skill correlation and does not move disabled ownership", async t => {
		const current = observeTracker(t), h = configured(["cwd"]);
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const source = register(h, "cwd"), tracker = current();
		tracker.recordStart("old-cwd-read", "read", { path: source });
		const select = async (scopes: ScopeSelection) => {
			h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "off", scopes: [...scopes] } });
			await h.handlers.get("session_tree")!({}, h.ctx);
		};
		await select(["global"]);
		noSourceIO([source], () => {
			tracker.recordEnd("old-cwd-read", "read", false); assert.equal(tracker.successful.size, 0);
			assert.deepEqual(tracker.recordResult("read", { path: source }, false), { path: source, scope: "cwd" });
		});
		await select(["cwd"]);
		assert.equal(current(), tracker); tracker.recordEnd("old-cwd-read", "read", false);
		assert.equal(tracker.successful.size, 0, "a scope round trip cannot revive old pending reads");
	});

	test("cold native captured Skill selection wins over later global defaults without resampling", async t => {
		const current = observeTracker(t), h = configured(["cwd"]);
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const source = register(h, "global"), entries = structuredClone(h.entries);
		writeFileSync(join(h.repositoryRoot, "config.json"), JSON.stringify({ scopes: ["global"] }));
		const resumed = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, mode: "off" });
		resumed.entries.push(...entries); resumed.registerSkill(source, "user");
		await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
		noSourceIO([source], () => assert.deepEqual(current().recordResult("read", { path: source }, false), { path: source, scope: "global" }));
		assert.equal(resumed.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
		// The later default really would select this owner without retained branch DATA.
		const fresh = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, mode: "off" }); fresh.registerSkill(source, "user");
		await fresh.handlers.get("session_start")!({ reason: "new" }, fresh.ctx);
		assert.match(current().recordResult("read", { path: source }, false)!.hash!, /^sha256:[0-9a-f]{64}$/);
	});

	test("native all-three Skill hooks retain hash proof through compilation and clear only accepted acquisitions", async t => {
		const current = observeTracker(t), h = configured(["global", "cwd", "session"]);
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx); await h.commands.get("state-flow-active")!.handler("", h.ctx);
		const source = register(h, "cwd");
		h.handlers.get("tool_execution_start")!({ toolCallId: "owned-skill", toolName: "read", args: { path: source } }, h.ctx);
		h.handlers.get("tool_call")!({ toolCallId: "owned-skill", toolName: "read", input: { path: source } }, h.ctx);
		h.handlers.get("tool_execution_end")!({ toolCallId: "owned-skill", toolName: "read", isError: false }, h.ctx);
		const result = h.handlers.get("tool_result")!({ toolCallId: "owned-skill", toolName: "read", input: { path: source }, isError: false, content: [] }, h.ctx);
		assert.match(JSON.stringify(result), /belongs at cwd\.artifacts/);
		assert.match(current().successful.get(source)!.hash!, /^sha256:[0-9a-f]{64}$/);
		await h.tools.get("patch_state")!.execute("compile-owned-skill", { cwd: { artifacts: { [source]: { description: "Owned guidance", kind: "skill", compilation: { rule: "native scoped guidance" } } } } }, undefined, undefined, h.ctx);
		assert.deepEqual(h.readState(0, "cwd").artifacts[source].compilation, { rule: "native scoped guidance" });
		assert.equal(current().successful.has(source), false);
	});
}

{
	function deadline<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("obsolete context did not withdraw before foreign lock release")), 5000); })]).finally(() => clearTimeout(timer));
	}

	test("transport request guard never inspects provider payload and idle projection remains outside the native lease", async () => {
		const h = harness({ initializeRepository: false }); await start(h);
		const controller = new AbortController();
		const ctx = { ...h.ctx, signal: controller.signal, abort: () => controller.abort() };
		h.handlers.get("turn_start")!({}, ctx);
		const payload = { get payload(): never { return assert.fail("provider payload observed"); } };
		assert.equal(h.handlers.get("before_provider_request")!(payload, ctx), undefined); assert.equal(controller.signal.aborted, false);
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		assert.equal(h.handlers.get("before_provider_request")!(payload, ctx), undefined); assert.equal(controller.signal.aborted, true);
		let idleAbort = false;
		h.handlers.get("context_with_system")!({ messages: [] }, { ...h.ctx, abort: () => { idleAbort = true; } });
		assert.equal(idleAbort, false);
	});

	test("late transcript/transport guards cannot abort a replacement ambient operation", async () => {
		const h = harness({ initializeRepository: false }); await start(h);
		const old = new AbortController(), replacement = new AbortController();
		let signal = old.signal;
		const ctx = { ...h.ctx, get signal() { return signal; }, abort: () => signal === old.signal ? old.abort() : replacement.abort() };
		h.handlers.get("turn_start")!({}, ctx);
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		signal = replacement.signal;
		h.handlers.get("context_with_system")!({ messages: [] }, ctx);
		h.handlers.get("before_provider_request")!({}, ctx);
		assert.equal(replacement.signal.aborted, false);
	});

	test("real Pi final transcript checkpoint aborts a request invalidated by a later context handler, retaining already accepted preparation", async t => {
		let session!: AgentSession, changed = false, prepared: string | undefined, accepted: ReturnType<typeof captureTemporalFileBases> | undefined;
		const f = await realPiFixture(t, { initializeRepository: false, mode: "active", extensions: [{ name: "later-context-change", factory(pi) {
			pi.on("context", async event => {
				if (!changed) {
					changed = true;
					prepared = JSON.parse(readFileSync(sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)).runtime, "utf8")).specification;
					await session.prompt("/state-flow-off"); await session.prompt("/state-flow-active");
					accepted = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
				}
				return { messages: event.messages };
			});
		} }] });
		session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("MUST NOT REACH PROVIDER")]);
		await deadline(session.prompt("Preparation accepted before the later policy change"));
		assert.equal(changed, true); assert.equal(f.faux.state.callCount, 0, "undefined context must not expose the raw native fallback");
		assert.equal(prepared, "Preparation accepted before the later policy change");
		assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), accepted, "later Abort cannot roll back accepted preparation/mode publications or replay the old specification");
		assert.equal(f.readState(session, 0, "session").response, "");
		f.faux.setResponses([fauxAssistantMessage("Fresh accepted answer")]); await session.prompt("Fresh request after cancellation");
		assert.equal(f.faux.state.callCount, 1); assert.equal(f.readState(session, 0, "session").response, "Fresh accepted answer");
	});

	for (const control of ["off", "passive", "restart", "tree"] as const) test(`real Pi stale preparation withdraws at ${control} before lock release without canceling independent replacement work`, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "active" });
		const session = await f.createSession("new"), leaf = session.sessionManager.getLeafId()!;
		const lock = join(f.repositoryRoot, ".state-flow-publication.lock");
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		let entered!: () => void, armed = true;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		writeFileSync(lock, `${process.pid}\n`);
		const open = fs.openSync;
		fs.openSync = ((path: fs.PathLike, flags: string | number, ...args: any[]) => {
			try { return (open as any)(path, flags, ...args); }
			finally { if (armed && path === lock && flags === "wx") { armed = false; entered(); } }
		}) as typeof fs.openSync; syncBuiltinESMExports();
		let running: Promise<void> | undefined, replacement: Promise<unknown> | undefined;
		try {
			f.faux.setResponses([fauxAssistantMessage("OBSOLETE PROVIDER INPUT")]);
			running = session.prompt("Old pending preparation"); await deadline(waiting);
			if (control === "tree") {
				await assert.rejects(session.navigateTree(leaf, { summarize: false }), /Wait for the current response/);
				await session.abort();
				replacement = session.navigateTree(leaf, { summarize: false });
			} else if (control === "restart") {
				await session.prompt("/state-flow-off"); replacement = session.prompt("/state-flow-active");
			} else replacement = session.prompt(`/state-flow-${control}`);
			await deadline(running);
			assert.equal(existsSync(lock), true); assert.equal(f.faux.state.callCount, 0);
			assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
			assert.equal(f.notifications.some(message => /preparation failed|lock is unavailable/.test(message)), false);
		} finally {
			fs.openSync = open; syncBuiltinESMExports(); if (existsSync(lock)) rmSync(lock);
			await running; await replacement;
		}
		if (control === "off") {
			const bytes = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
			f.faux.setResponses([fauxAssistantMessage("Genuine Off native continuation")]); await session.prompt("A new Off request is permitted");
			assert.equal(f.faux.state.callCount, 1); assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), bytes);
			await session.prompt("/state-flow-active");
		} else if (control === "passive") {
			const path = sessionRuntimePaths(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)).config;
			assert.equal(JSON.parse(readFileSync(path, "utf8")).mode, "passive", "old request Abort must not cancel independent Passive persistence");
			assert.equal(f.statuses.at(-1), "state-flow passive");
			await session.prompt("/state-flow-active");
		}
		f.faux.setResponses([fauxAssistantMessage("Only fresh context accepts")]); await session.prompt("Fresh native preparation");
		assert.equal(f.readState(session, 0, "session").response, "Only fresh context accepts");
	});

	test("real Pi Off turn changes policy before context without acquiring a request from the replacement mode", async t => {
		let session!: AgentSession, changed = false;
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off", extensions: [{ name: "change-before-context", factory(pi) {
			pi.on("turn_start", async () => { if (!changed) { changed = true; await session.prompt("/state-flow-active"); } });
		} }] });
		session = await f.createSession("new");
		f.faux.setResponses([fauxAssistantMessage("OLD OFF TURN MUST NOT BECOME ACTIVE INPUT")]); await deadline(session.prompt("Begin under Off"));
		assert.equal(f.faux.state.callCount, 0);
		f.faux.setResponses([fauxAssistantMessage("Fresh Active input")]); await session.prompt("Begin under Active");
		assert.equal(f.faux.state.callCount, 1); assert.equal(f.readState(session, 0, "session").response, "Fresh Active input");
	});

	test("a genuine Off native turn performs no automatic canonical or source reads", async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "off" }); const session = await f.createSession("new");
		const read = fs.readFileSync, stat = fs.lstatSync, open = fs.openSync;
		const assertOutside = (path: unknown) => { if (typeof path === "string") assert.equal(path.startsWith(f.repositoryRoot), false, `Off observed canonical/source path ${path}`); };
		fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => { assertOutside(path); return (read as any)(path, ...args); }) as typeof fs.readFileSync;
		fs.lstatSync = ((path: fs.PathLike, ...args: any[]) => { assertOutside(path); return (stat as any)(path, ...args); }) as typeof fs.lstatSync;
		fs.openSync = ((path: fs.PathLike, ...args: any[]) => { assertOutside(path); return (open as any)(path, ...args); }) as typeof fs.openSync; syncBuiltinESMExports();
		try { f.faux.setResponses([fauxAssistantMessage("Native only")]); await session.prompt("Off remains inert"); }
		finally { fs.readFileSync = read; fs.lstatSync = stat; fs.openSync = open; syncBuiltinESMExports(); }
		assert.equal(f.faux.state.callCount, 1); assert.equal(readFileSync(session.sessionFile!, "utf8").includes("Native only"), true);
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners = ["global", "cwd", "session"] as const;
	const choices = Array.from({ length: 7 }, (_, i) => captureScopeSelection(owners.filter((_, bit) => (i + 1) & (1 << bit))));
	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	function head(c: Context, mode: "active" | "passive") {
		const prefix = mode === "active" ? "State Flow runtime context" : "State Flow passive memory";
		for (const message of c.messages) if (message.role === "user" && Array.isArray(message.content)) {
			const part = message.content.find(p => p.type === "text" && p.text.startsWith(prefix));
			if (!part || part.type !== "text") continue;
			const projection = message.content.find(p => p.type === "text" && p.text.startsWith("State Flow projection: "));
			assert.ok(projection && projection.type === "text");
			return { body: JSON.parse(part.text.slice(part.text.indexOf("\n") + 1)), projection: projection.text.slice("State Flow projection: ".length) };
		}
		assert.fail(`Missing actual ${mode} model head`);
	}
	function result(c: Context, id: string): ToolResultMessage {
		const r = c.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === id);
		assert.ok(r, id); assert.notEqual(r.isError, true, text(r)); return structuredClone(r);
	}

	for (const selected of choices) for (const mode of ["active", "passive"] as const)
	test(`actual ${selected.join("+")} ${mode} head renders wanted refs/navigation/recent while canonical storage stays scoped`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "configured" });
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
		const seed = Object.fromEntries(selected.map(owner => [owner, { intents: { task: { $ref: `${selected.length === 1 ? "" : owner + "."}lazy.plan` } }, strategy: { literal: `${owner}.lazy.plan` }, lazy: { plan: ["BODY_NOT_IN_HEAD"] } }]));
		let seeded: ToolResultMessage | undefined;
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(selected, seed), { id: "seed-context" }), { stopReason: "toolUse" }), c => { seeded = result(c, "seed-context"); return answer("Seeded"); }]);
		await session.prompt("Seed actual canonical memory"); assert.ok(seeded);
		for (const owner of selected) assert.deepEqual(f.readState(session, 0, owner).intents.task, { $ref: `${owner}.lazy.plan` });
		await session.reload(); let observed: Context | undefined;
		f.faux.setResponses([c => { observed = structuredClone(c); return answer("Inspected"); }]); await session.prompt("Inspect a fresh actual context head");
		assert.ok(observed); const { body, projection } = head(observed, mode), target = selected.at(-1)!;
		assert.ok(projection.length > 0); assert.equal(Object.hasOwn(body, "modelScopes"), false);
		assert.deepEqual(body.state.intents.task, { $ref: selected.length === 1 ? "lazy.plan" : `${target}.lazy.plan` });
		assert.equal(body.state.strategy.literal, `${target}.lazy.plan`, "ordinary text never has prefixes stripped");
		assert.equal(Object.hasOwn(body.state, "lazy"), false); assert.doesNotMatch(JSON.stringify(body), /BODY_NOT_IN_HEAD/);
		assert.equal(body.lazy_navigation.path, selected.length === 1 ? "lazy" : "effective.lazy");
		assert.deepEqual(body.lazy_navigation.keys, { plan: "array" });
		if (mode === "active") {
			assert.ok(Array.isArray(body.recent_transitions) && body.recent_transitions.length > 0);
			const authored = body.recent_transitions.find((record: { patch?: { intents?: unknown }; transitions?: Array<{ patch: { intents?: unknown } }> }) => record.patch?.intents || record.transitions?.some(v => v.patch.intents));
			assert.ok(authored); assert.equal(typeof authored.id, "string"); assert.ok(Number.isSafeInteger(authored.at));
			if (selected.length === 1) {
				assert.deepEqual(Object.keys(authored).sort(), ["at", "id", "patch"]); assert.deepEqual(authored.patch.intents.task, { $ref: "lazy.plan" }); assert.equal(Object.hasOwn(authored.patch, "lazy"), false);
			} else {
				assert.equal(Object.hasOwn(authored, "patch"), false);
				assert.deepEqual(authored.transitions.map((v: { scope: string }) => v.scope), selected);
				for (const v of authored.transitions) { assert.deepEqual(v.patch.intents.task, { $ref: `${v.scope}.lazy.plan` }); assert.equal(Object.hasOwn(v.patch, "lazy"), false); }
			}
		} else assert.equal(Object.hasOwn(body, "recent_transitions"), false, "Passive does not acquire Active history semantics");
	});

	for (const owner of owners)
	test(`actual ${owner} flat cascade receipt uses the frozen model projection, canonical storage and genuine native reads`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "configured" });
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-active ${owner}`);
		let seed: ToolResultMessage | undefined;
		f.faux.setResponses([answer(tool("patch_state", { lazy: { plan: "PRIVATE_LAZY_BODY" }, tactics: { step: "draft", kept: true }, intents: { task: { owns: [{ $ref: "lazy.plan" }, { $ref: "tactics.step" }] } } }, { id: "cascade-seed" }), { stopReason: "toolUse" }), c => { seed = result(c, "cascade-seed"); return answer("Seeded cascade"); }]);
		await session.prompt("Seed a real ref dependency"); assert.ok(seed); await session.reload();
		let before: ReturnType<typeof head> | undefined, receipt: ToolResultMessage | undefined, read: ToolResultMessage | undefined;
		f.faux.setResponses([
			c => { before = head(c, "active"); return answer(tool("patch_state", { intents: { task: null } }, { id: "cascade-delete" }), { stopReason: "toolUse" }); },
			c => { receipt = result(c, "cascade-delete"); return answer(tool("read_state", { path: "tactics" }, { id: "cascade-inspect" }), { stopReason: "toolUse" }); },
			c => { read = result(c, "cascade-inspect"); return answer("Cascade inspected"); },
		]);
		await session.prompt("Delete source and inspect actual cascade"); assert.ok(before && receipt && read);
		assert.deepEqual(before.body.state.intents.task, { owns: [{ $ref: "lazy.plan" }, { $ref: "tactics.step" }] });
		const part = receipt.content.find(p => p.type === "text" && p.text.trimStart().startsWith('{"state_updates":'));
		assert.ok(part && part.type === "text", text(receipt)); const updates = JSON.parse(part.text).state_updates;
		assert.equal(updates.projection, before.projection); assert.deepEqual(updates.cascaded, ["lazy.plan", "tactics.step"]);
		assert.ok(updates.effective.some((e: { path: string[]; deleted?: true }) => e.path.join(".") === "tactics.step" && e.deleted));
		assert.equal(updates.lazy_navigation.path, "lazy"); assert.equal(updates.lazy_navigation.available, false);
		assert.deepEqual(JSON.parse(text(read)), { value: { kept: true } }); assert.deepEqual(f.readState(session, 0, owner).tactics, { kept: true }); assert.deepEqual(f.readState(session, 0, owner).intents, {});
		assert.deepEqual((receipt.details as { scopes: string[] }).scopes, [owner], "canonical receipt ownership is not erased");
		assert.doesNotMatch(text(receipt), /PRIVATE_LAZY_BODY/);
	});

	test("actual wanted CWD+Session with available-only CWD keeps multi context and does not acquire private files", { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-passive cwd"); let seeded: ToolResultMessage | undefined;
		f.faux.setResponses([answer(tool("patch_state", { intents: { task: { $ref: "lazy.plan" } }, lazy: { plan: "ONLY_LAZY" } }, { id: "shared-seed" }), { stopReason: "toolUse" }), c => { seeded = result(c, "shared-seed"); return answer("Shared"); }]);
		await session.prompt("Seed shared ref"); assert.ok(seeded); await session.prompt("/state-flow-passive cwd session");
		const paths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
		const presence = () => [paths.checkpoint, paths.patches, paths.meta].map(path => existsSync(path));
		assert.deepEqual(presence(), [false, false, false]);
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)); let observed: Context | undefined;
		f.faux.setResponses([c => { observed = structuredClone(c); return answer("Observe sparse"); }]); await session.prompt("Use wanted arity, not available owners");
		assert.ok(observed); const { body } = head(observed, "passive");
		assert.deepEqual(body.state.intents.task, { $ref: "cwd.lazy.plan" }); assert.equal(body.lazy_navigation.path, "effective.lazy");
		assert.deepEqual(presence(), [false, false, false]); assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
		assert.equal(existsSync(`${f.repositoryRoot}/config.json`), false, "public choice does not create an absent defaults file");
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners: StateScope[] = ['global', 'cwd', 'session'];
	const selections: StateScope[][] = [['global'], ['cwd'], ['session'], ['global', 'cwd'], ['global', 'session'], ['cwd', 'session'], owners];
	const text = (m: ToolResultMessage) => m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
	for (const selected of selections) for (const mode of ['active', 'passive'] as const)
	  test(`native flat read wanted=${selected.join('+')} ${mode}`, { timeout: 60000 }, async t => {
	    const f = await realPiFixture(t, { mode: 'configured', initializeRepository: false });
	    const config = `${f.repositoryRoot}/config.json`;
	    writeFileSync(config, JSON.stringify({ mode: 'off', scopes: owners, historyLimit: 7 }));
	    const defaults = readFileSync(config);
	    const { session } = await f.createRuntime('new');
	    const errors: unknown[] = [];
	    await session.bindExtensions({ onError: e => { errors.push(e); } });
	    await session.prompt(`/state-flow-${mode} ${selected.join(' ')}`);
	    const key = nativeSessionKey(session);
	    const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
	    const semantic = (scope: StateScope) => {
	      const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, key);
	      return [p.checkpoint, p.patches, p.meta].map(path => [path, existsSync(path) ? readFileSync(path).toString('base64') : null]);
	    };
	    const excluded = owners.filter(o => !selected.includes(o)), excludedBefore = excluded.map(semantic);
	    const target = selected.at(-1)!, sole = selected.length === 1;
	    const refs = (o: StateScope, project = false) => ({
	      current: { $ref: `${project ? '' : `${o}.`}tactics.items[1]` },
	      nested: [[{ $ref: `${project ? '' : `${o}.`}lazy.body` }]],
	      cross: { $ref: `${owners.find(x => x !== o)}.tactics.items[1]` },
	      historical: { $ref: `${o}[1].tactics.items[1]` },
	      effective: { $ref: 'effective.tactics.items[1]' },
	      resource: { $ref: 'src/file.ts' }, text: `$${o}.tactics.items[1]`,
	    });
	    const results = new Map<string, ToolResultMessage>(), contexts: Context[] = [];
	    const observe = (c: Context) => {
	      contexts.push(structuredClone(c));
	      for (const m of c.messages) if (m.role === 'toolResult') results.set(m.toolCallId, structuredClone(m));
	    };
	    const call = (name: string, args: Parameters<typeof tool>[1], id: string, capture?: () => void): FauxResponseFactory => c => {
	      observe(c); capture?.(); return answer(tool(name, args, { id }), { stopReason: 'toolUse' });
	    };
	    // New intent entry makes reference projection observable in the actual second delta.
	    const patch = (phase: number) => Object.fromEntries(selected.map(o => [o, {
	      intents: { [phase === 1 ? 'first' : 'links']: refs(o) }, tactics: { items: [phase * 10, phase], label: o }, lazy: { body: refs(o) },
	    }]));
	    let beforeReads: ReturnType<typeof files> | undefined, afterReads: ReturnType<typeof files> | undefined;
	    const steps: FauxResponseFactory[] = [
	      call('patch_state', modelPatchArguments(selected, patch(1)), 'patch1'), call('patch_state', modelPatchArguments(selected, patch(2)), 'patch2'),
	      call('read_state', { path: 'tactics.items[1]' }, 'flat', () => { beforeReads = files(); }),
	      call('read_state', { path: `${target}.intents.links` }, 'explicit-refs'),
	      call('read_state', { path: 'lazy.body' }, 'lazy-refs'),
	      call('read_state', { path: 'effective[1].tactics.items[1]' }, 'history'),
	      call('read_state', { paths: [`${target}.tactics.items[1]`, 'tactics.items[0]', `${target}.intents.links`] }, 'batch'),
	      call('read_state', { path: 'tactics', projection: 'keys' }, 'keys'),
	      call('read_state', { path: 'patches[0]' }, 'alias-patch'),
	      call('read_state', { path: `${target}.patches[0]` }, 'explicit-patch'),
	      call('read_state', { path: 'nonexistent.value' }, 'bad-root'),
	      call('read_state', { paths: [`${target}.tactics.items[1]`, 'nonexistent.value'] }, 'bad-batch'),
	    ];
	    if (excluded.length) steps.push(call('read_state', { paths: [`${target}.tactics.items[1]`, `${excluded[0]}.tactics`] }, 'excluded'));
	    steps.push(c => { observe(c); afterReads = files(); return answer('Completed native read cohort'); });
	    f.faux.setResponses(steps);
	    await session.prompt('Patch twice, then inspect current and historical selected memory in this operation.');
	    const result = (id: string, error = false) => {
	      const r = results.get(id); assert.ok(r, `original native result ${id}`);
	      assert.equal(Boolean(r.isError), error, `${id}: ${text(r)}`); return r;
	    };
	    const envelope = (id: string) => JSON.parse(text(result(id)));
	    result('patch1'); result('patch2');
	    assert.deepEqual(afterReads, beforeReads, 'all reads leave canonical bytes unchanged before ordinary answer');
	    assert.equal(envelope('flat').value, 2);
	    assert.deepEqual(envelope('explicit-refs').value, refs(target, sole));
	    assert.deepEqual(envelope('lazy-refs').value, refs(target, sole));
	    assert.equal(envelope('history').value, 1, 'historical boundary differs from ordinary array index');
	    assert.deepEqual(envelope('batch').value, [2, 20, refs(target, sole)]);
	    assert.ok(envelope('keys').keys.items);
	    const canonicalPatch = envelope('explicit-patch').patch;
	    assert.deepEqual(canonicalPatch.intents.links, refs(target, sole));
	    assert.equal(canonicalPatch.tactics.items[1], 2);
	    if (sole) assert.deepEqual(envelope('alias-patch').patch, canonicalPatch);
	    else result('alias-patch', true);
	    assert.equal((result('explicit-refs').details as { path: string }).path, `${target}.intents.links`);
	    assert.equal((result('explicit-patch').details as { path: string }).path, `${target}.patches[0]`);
	    if (sole) assert.equal((result('alias-patch').details as { path: string }).path, 'patches[0]');
	    result('bad-root', true); result('bad-batch', true);
	    if (excluded.length) result('excluded', true);
	    assert.deepEqual(excluded.map(semantic), excludedBefore);
	    assert.deepEqual(readFileSync(config), defaults);
	    for (const o of selected) assert.deepEqual(f.readState(session, 0, o).intents?.links, refs(o), 'canonical publication remains scoped');
	    // Runtime inspector deliberately omits lazy; explicit native lazy read above proves its body.
	    assert.equal(contexts.length, steps.length, 'every provider continuation completed');
	    for (const c of contexts) assert.ok(getCurrentTools(c.messages).some(v => v.name === 'read'), 'host allowlisted read survives');
	    const beforeOff = files();
	    await session.prompt('/state-flow-off');
	    let off: Context | undefined;
	    f.faux.setResponses([c => { off = structuredClone(c); return answer('Off answer'); }]);
	    await session.prompt('Observe Off tool withdrawal');
	    assert.ok(off);
	    const names = getCurrentTools(off.messages).map(v => v.name);
	    assert.ok(names.includes('read'));
	    assert.ok(!names.includes('read_state') && !names.includes('patch_state'));
	    assert.deepEqual(files(), beforeOff);
	    assert.deepEqual(errors, []);
	  });
}

{
	// Explicit source-harness reentrancy faults, not provider/native JSON-argument getters.
	for (const change of ["scope", "scope-aba", "off", "abort", "physical", "equal"] as const)
	test(`flat-read captured arguments retain their original request through ${change}`, async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await h.commands.get("state-flow-passive")!.handler("cwd", h.ctx);
		await h.tools.get("patch_state")!.execute("seed", modelPatchArguments(["cwd"], { cwd: { tactics: { marker: "OLD_CWD_BODY" } } }), undefined, undefined, h.ctx);
		const controller = new AbortController(), cwd = h.ctx.cwd;
		const pending: Promise<unknown>[] = [];
		let captures = 0;
		const params = { get path() {
			captures++;
			if (change === "scope" || change === "scope-aba") pending.push(h.commands.get("state-flow-passive")!.handler("global", h.ctx));
			if (change === "scope-aba" || change === "equal") pending.push(h.commands.get("state-flow-passive")!.handler("cwd", h.ctx));
			if (change === "off") pending.push(h.commands.get("state-flow-off")!.handler("", h.ctx));
			if (change === "abort") controller.abort();
			if (change === "physical") h.ctx.cwd = `${h.repositoryRoot}/foreign`;
			return "cwd.tactics.marker";
		} };
		try {
			const reading = h.tools.get("read_state")!.execute("late-raw-read", params, controller.signal, undefined, h.ctx);
			if (change === "equal") assert.match(JSON.stringify(await reading), /OLD_CWD_BODY/);
			else await assert.rejects(reading);
			assert.equal(captures, 1, "detach once, never reread live arguments after final lease check");
		} finally { h.ctx.cwd = cwd; await Promise.allSettled(pending); }
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const text = (result: ToolResultMessage) => result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	function observe(context: Context, into: Map<string, ToolResultMessage>) {
		for (const m of context.messages) if (m.role === "toolResult") into.set(m.toolCallId, structuredClone(m));
	}

	for (const change of ["sole-owner", "sole-aba", "arity", "off", "off-aba", "equal"] as const)
	test(`actual native flat read retains original owner across public ${change}`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, tools: ["read", "read_state", "patch_state"] });
		const { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-passive cwd");
		const results = new Map<string, ToolResultMessage>();
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(["cwd"], { cwd: { lazy: { box: { $ref: "cwd.tactics.x" } }, tactics: { x: "ORIGINAL_CWD" } } }), { id: "seed" }), { stopReason: "toolUse" }), c => { observe(c, results); return answer("Seeded"); }]);
		await session.prompt("Seed actual selected memory");
		const seeded = results.get("seed"); assert.ok(seeded); assert.notEqual(seeded.isError, true, text(seeded));
		const semantic = () => {
			const p = temporalScopePaths(f.cwd, session.sessionId, "cwd", f.repositoryRoot, nativeSessionKey(session));
			return [p.checkpoint, p.patches, p.meta].map(path => readFileSync(path).toString("base64"));
		};
		const before = semantic(), foreign = `${f.cwd}/unrelated.txt`;
		writeFileSync(foreign, "FOREIGN_READ_OK");
		let controls = 0;
		f.faux.setResponses([
			async () => {
				if (change === "sole-owner" || change === "sole-aba") { await session.prompt("/state-flow-passive global"); controls++; }
				if (change === "arity") { await session.prompt("/state-flow-passive global cwd"); controls++; }
				if (change === "off" || change === "off-aba") { await session.prompt("/state-flow-off"); controls++; }
				if (change === "sole-aba" || change === "off-aba" || change === "equal") { await session.prompt("/state-flow-passive cwd"); controls++; }
				return answer([tool("read_state", { path: "lazy.box" }, { id: "old-flat-read" }), tool("read", { path: foreign }, { id: "unrelated-read" })], { stopReason: "toolUse" });
			},
			c => { observe(c, results); return answer("Actual continuation"); },
		]);
		await session.prompt("Read with original native request");
		assert.ok(controls > 0);
		const old = results.get("old-flat-read"); assert.ok(old, "original-ID result reaches actual continuation");
		assert.equal(Boolean(old.isError), change !== "equal", text(old));
		if (change === "equal") assert.deepEqual(JSON.parse(text(old)), { value: { $ref: "tactics.x" } });
		else assert.doesNotMatch(text(old), /ORIGINAL_CWD|cwd\.tactics\.x/);
		const unrelated = results.get("unrelated-read"); assert.ok(unrelated); assert.notEqual(unrelated.isError, true, text(unrelated)); assert.match(text(unrelated), /FOREIGN_READ_OK/);
		assert.deepEqual(semantic(), before, "mode/selection/read is not semantic mutation");
		await session.prompt("/state-flow-passive cwd");
		f.faux.setResponses([answer(tool("read_state", { path: "lazy.box" }, { id: "fresh-flat-read" }), { stopReason: "toolUse" }), c => { observe(c, results); return answer("Fresh receipt"); }]);
		await session.prompt("Read with fresh current native receipt");
		const fresh = results.get("fresh-flat-read"); assert.ok(fresh); assert.notEqual(fresh.isError, true, text(fresh));
		assert.deepEqual(JSON.parse(text(fresh)), { value: { $ref: "tactics.x" } });
		assert.deepEqual(semantic(), before);
	});

	test("actual read interface arity uses wanted CWD+Session, not the only observable CWD owner", { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false });
		const { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-passive cwd");
		const results = new Map<string, ToolResultMessage>();
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(["cwd"], { cwd: { intents: { i: { $ref: "cwd.lazy.plan" } }, lazy: { plan: ["kept"] } } }), { id: "source" }), { stopReason: "toolUse" }), c => { observe(c, results); return answer("Seed shared source"); }]);
		await session.prompt("Seed genuine native CWD-only bookmark");
		const source = results.get("source"); assert.ok(source); assert.notEqual(source.isError, true, text(source));
		await session.prompt("/state-flow-passive cwd session");
		const key = nativeSessionKey(session), privatePaths = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, key);
		const privatePresence = () => [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta].map(p => existsSync(p));
		assert.deepEqual(privatePresence(), [false, false, false]);
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
		f.faux.setResponses([
			answer(tool("read_state", { path: "intents.i" }, { id: "wanted-multi" }), { stopReason: "toolUse" }),
			c => { observe(c, results); return answer(tool("read_state", { path: "patches[0]" }, { id: "no-single-alias" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer(tool("read_state", { paths: ["intents.i", "session.lazy.plan"] }, { id: "unavailable-private-batch" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("Observed only, not acquired"); },
		]);
		await session.prompt("Read wanted multi-owner policy over sparse available view");
		const read = results.get("wanted-multi"); assert.ok(read); assert.notEqual(read.isError, true, text(read));
		assert.deepEqual(JSON.parse(text(read)), { value: { $ref: "cwd.lazy.plan" } }, "wanted multi-owner interface never flattens available-only CWD refs");
		for (const id of ["no-single-alias", "unavailable-private-batch"]) { const result = results.get(id); assert.ok(result); assert.equal(result.isError, true); assert.doesNotMatch(text(result), /kept/); }
		assert.deepEqual(privatePresence(), [false, false, false]);
		assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key), before);
	});

	test("actual sole-owner patches alias refuses folded hot history without inventing an empty patch", { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", historyLimit: 0 }));
		const { session } = await f.createRuntime("new"); await session.prompt("/state-flow-passive cwd");
		const results = new Map<string, ToolResultMessage>();
		f.faux.setResponses([
			answer(tool("patch_state", modelPatchArguments(["cwd"], { cwd: { tactics: { current: "FOLDED_CURRENT_VALUE" } } }), { id: "material" }), { stopReason: "toolUse" }),
			c => { observe(c, results); return answer(tool("read_state", { path: "patches[0]" }, { id: "folded-patch" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer(tool("read_state", { path: "tactics.current" }, { id: "available-current" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("History absent, value present"); },
		]);
		await session.prompt("Keep current values without fabricated history");
		const patch = results.get("folded-patch"), current = results.get("available-current"); assert.ok(patch); assert.ok(current);
		const material = results.get("material"); assert.ok(material); assert.notEqual(material.isError, true, text(material)); assert.equal(patch.isError, true); assert.match(text(patch), /predates retained hot history/);
		assert.notEqual(current.isError, true, text(current)); assert.deepEqual(JSON.parse(text(current)), { value: "FOLDED_CURRENT_VALUE" });
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");

	// Actual native read→authored sole-owner flat write→cascade, not a second engine or direct canonical seed.
	for (const owner of ["global", "cwd", "session"] as const)
	test(`native ${owner} scope-free read ref roundtrips through actual sole-owner flat patch grammar without losing ownership`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false });
		const { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-passive ${owner}`);
		const results = new Map<string, ToolResultMessage>(); let calls = 0, stored: JsonValue | undefined;
		const observe = (c: Context) => { calls++; for (const m of c.messages) if (m.role === "toolResult") results.set(m.toolCallId, structuredClone(m)); };
		f.faux.setResponses([
			c => { observe(c); return answer(tool("patch_state", modelPatchArguments([owner], { [owner]: { intents: { original: { $ref: `${owner}.lazy.plan` } }, lazy: { plan: { keep: true } } } }), { id: "seed" }), { stopReason: "toolUse" }); },
			c => { observe(c); return answer(tool("read_state", { path: "intents.original" }, { id: "read-flat-ref" }), { stopReason: "toolUse" }); },
			c => { observe(c); const ref = JSON.parse(text(results.get("read-flat-ref")!)).value; return answer(tool("patch_state", modelPatchArguments([owner], { [owner]: { intents: { original: null, copy: ref } } }), { id: "roundtrip" }), { stopReason: "toolUse" }); },
			c => { observe(c); stored = structuredClone(f.readState(session, 0, owner).intents); return answer(tool("read_state", { path: "lazy.plan" }, { id: "still-owned" }), { stopReason: "toolUse" }); },
			c => { observe(c); return answer(tool("patch_state", modelPatchArguments([owner], { [owner]: { intents: { copy: null } } }), { id: "close-copy" }), { stopReason: "toolUse" }); },
			c => { observe(c); return answer(tool("read_state", { path: "lazy.plan" }, { id: "closed-target" }), { stopReason: "toolUse" }); },
			c => { observe(c); return answer("Read and write stay coherent"); },
		]);
		await session.prompt("Move this intent using the ref actually returned by read_state, then close it");
		assert.equal(calls, 7);
		for (const id of ["seed", "read-flat-ref", "roundtrip", "still-owned", "close-copy"]) { const r = results.get(id); assert.ok(r, id); assert.notEqual(r.isError, true, `${id}: ${text(r)}`); }
		assert.deepEqual(JSON.parse(text(results.get("read-flat-ref")!)), { value: { $ref: "lazy.plan" } });
		assert.deepEqual(stored, { copy: { $ref: `${owner}.lazy.plan` } }, "actual canonical reference must retain owner, never persisted unscoped");
		assert.deepEqual(JSON.parse(text(results.get("still-owned")!)), { value: { keep: true } });
		const gone = results.get("closed-target"); assert.ok(gone); assert.equal(gone.isError, true);
		assert.deepEqual(f.readState(session, 0, owner).intents, {}, "runtime inspector materializes the empty intent plane; it is not raw stored shape");
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, i) => captureScopeSelection(owners.filter((_, bit) => (i + 1) & (1 << bit))));
	const section = (c: Context) => getCurrentSystemMessage(c.messages)?.sections?.state_flow;
	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	function assertInterface(context: Context, selected: readonly string[], mode: "active" | "passive") {
		const protocol = section(context); assert.equal(typeof protocol, "string", "a validated native view contributes the mode protocol");
		if (selected.length === 1) {
			assert.match(protocol!, /One-owner interface: patch_state takes intents\/strategy\/tactics\/artifacts\/lazy object planes directly/);
			assert.match(protocol!, /never add an owner wrapper/);
			assert.match(protocol!, /\{"\$ref":"lazy\.plan"\}/);
			assert.match(protocol!, /nested array\[N\] stays an array index/);
			assert.doesNotMatch(protocol!, new RegExp(`PATCH: Use ${selected[0]} object patches`));
			if (mode === "active") assert.match(protocol!, /Compile acquired invalidated artifacts directly at artifacts\[exact path\]/);
		} else {
			assert.doesNotMatch(protocol!, /One-owner interface:/);
			if (mode === "active") assert.ok(protocol!.includes(`PATCH: Use ${selected.join("/")} object patches`));
		}
		if (mode === "passive") assert.match(protocol!, /Passive turns never trigger State Flow continuation or compaction/);
		else assert.match(protocol!, /sole model-authored semantic mutation mechanism/);
		const declaration = getCurrentTools(context.messages).find(v => v.name === "patch_state"); assert.ok(declaration);
		assert.deepEqual(Object.keys((declaration.parameters as { properties: object }).properties).sort(), selected.length === 1 ? ["artifacts", "intents", "lazy", "strategy", "tactics"] : ["cwd", "global", "session"]);
	}

	for (const selected of selections) for (const mode of ["active", "passive"] as const)
	test(`actual normative ${selected.join("+")} ${mode} interface agrees cold, after native patch and after changed-default reload`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false, mode: "configured" });
		const config = `${f.repositoryRoot}/config.json`; writeFileSync(config, JSON.stringify({ mode: "off", scopes: owners }));
		const defaults = readFileSync(config), { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
		const contexts: Context[] = [], results = new Map<string, ToolResultMessage>();
		let beforeRead: ReturnType<typeof captureTemporalFileBases> | undefined, afterRead: typeof beforeRead;
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		const observe = (c: Context) => { contexts.push(structuredClone(c)); for (const m of c.messages) if (m.role === "toolResult") results.set(m.toolCallId, structuredClone(m)); };
		const target = selected.at(-1)!;
		const patch = Object.fromEntries(selected.map(owner => [owner, { strategy: { normative: owner }, intents: { task: { $ref: `${selected.length === 1 ? "" : owner + "."}lazy.plan` } }, lazy: { plan: ["next"] } }]));
		f.faux.setResponses([
			c => { observe(c); return answer(tool("patch_state", modelPatchArguments(selected, patch), { id: "normative-patch" }), { stopReason: "toolUse" }); },
			c => { observe(c); beforeRead = files(); return answer(tool("read_state", { path: "intents.task" }, { id: "normative-read" }), { stopReason: "toolUse" }); },
			c => { observe(c); afterRead = files(); return answer("Normative native continuation"); },
		]);
		await session.prompt("Use the actual selected model grammar, then read its ref");
		assert.equal(contexts.length, 3);
		if (mode === "passive") assert.equal(section(contexts[0]!), undefined, "cold Passive does not fabricate memory/protocol before validated source exists");
		else assertInterface(contexts[0]!, selected, mode);
		for (const c of contexts.slice(1)) assertInterface(c, selected, mode);
		for (const id of ["normative-patch", "normative-read"]) { const r = results.get(id); assert.ok(r, id); assert.notEqual(r.isError, true, text(r)); }
		assert.deepEqual(JSON.parse(text(results.get("normative-read")!)), { value: { $ref: selected.length === 1 ? "lazy.plan" : `${target}.lazy.plan` } });
		assert.deepEqual(afterRead, beforeRead, "protocol/read contribution does not publish memory");
		assert.deepEqual(readFileSync(config), defaults);
		writeFileSync(config, JSON.stringify({ mode: mode === "active" ? "passive" : "active", scopes: selected.length === 1 ? owners : ["cwd"] }));
		const changed = readFileSync(config); await session.reload();
		let resumed: Context | undefined;
		f.faux.setResponses([c => { resumed = structuredClone(c); return answer("After reload"); }]); await session.prompt("Retain native captured interface despite different defaults");
		assert.ok(resumed); assertInterface(resumed, selected, mode);
		assert.deepEqual(readFileSync(config), changed);
		for (const owner of selected) assert.equal(f.readState(session, 0, owner).strategy.normative, owner);
	});

	test("actual normative guidance stays multi for wanted CWD+Session over available-only CWD", { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-passive cwd");
		let patched: ToolResultMessage | undefined;
		f.faux.setResponses([answer(tool("patch_state", { tactics: { known: true } }, { id: "source" }), { stopReason: "toolUse" }), c => { patched = c.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "source"); return answer("Shared only"); }]);
		await session.prompt("Establish actual shared source"); assert.ok(patched); assert.notEqual(patched.isError, true, text(patched));
		await session.prompt("/state-flow-passive cwd session");
		const p = temporalScopePaths(f.cwd, session.sessionId, "session", f.repositoryRoot, nativeSessionKey(session));
		const presence = () => [p.checkpoint, p.patches, p.meta].map(path => existsSync(path));
		assert.deepEqual(presence(), [false, false, false]);
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)); let context: Context | undefined;
		f.faux.setResponses([c => { context = structuredClone(c); return answer("Observe wanted interface"); }]); await session.prompt("Render policy, not sparse view arity");
		assert.ok(context); assertInterface(context, ["cwd", "session"], "passive"); assert.match(section(context)!, /Participating owners: cwd session/);
		assert.deepEqual(presence(), [false, false, false]); assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before);
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, i) => captureScopeSelection(owners.filter((_, bit) => (i + 1) & (1 << bit))));
	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	const observe = (c: Context, results: Map<string, ToolResultMessage>) => { for (const m of c.messages) if (m.role === "toolResult") results.set(m.toolCallId, structuredClone(m)); };

	for (const selected of selections) for (const mode of ["active", "passive"] as const)
	test(`actual ${selected.join("+")} ${mode} mutation matches declared flat/multi grammar and canonical ownership`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }); const { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-${mode} ${selected.join(" ")}`);
		const key = nativeSessionKey(session), files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, key);
		const results = new Map<string, ToolResultMessage>(); const contexts: Context[] = [];
		const authored = Object.fromEntries(selected.map(owner => [owner, { tactics: { marker: owner, slots: [{ n: 1 }, { n: 2 }] }, lazy: { plan: { next: true } }, intents: { task: { $ref: `${selected.length === 1 ? "" : owner + "."}lazy.plan` } } }]));
		const args = modelPatchArguments(selected, authored);
		let beforeInvalid: ReturnType<typeof files> | undefined, afterInvalid: ReturnType<typeof files> | undefined;
		const target = selected[0]; const update = modelPatchArguments(selected, { [target]: { tactics: { slots: { "[0]": { n: 3 } } } } });
		f.faux.setResponses([
			c => { contexts.push(structuredClone(c)); observe(c, results); return answer(tool("patch_state", args, { id: "initial" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer(tool("patch_state", update, { id: "array-update" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer(tool("read_state", { path: `${target}.tactics.slots[0].n` }, { id: "array-current" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); beforeInvalid = files(); return answer(tool("patch_state", selected.length === 1 ? { tactics: {}, [target]: { tactics: { forbidden: true } } } : { tactics: { forbidden: true } }, { id: "wrong-family" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); afterInvalid = files(); return answer(tool("read_state", { path: `${target}.intents.task` }, { id: "ref" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("Mutation settled"); },
		]);
		await session.prompt("Use the actual declared mutation grammar and preserve canonical replay");
		assert.equal(contexts.length, 1); const declaration = getCurrentTools(contexts[0]!.messages).find(v => v.name === "patch_state"); assert.ok(declaration);
		assert.deepEqual(Object.keys((declaration.parameters as { properties: object }).properties).sort(), selected.length === 1 ? ["artifacts", "intents", "lazy", "strategy", "tactics"] : ["cwd", "global", "session"]);
		for (const id of ["initial", "array-update", "array-current", "ref"]) { const r = results.get(id); assert.ok(r, id); assert.notEqual(r.isError, true, `${id}: ${text(r)}`); }
		assert.deepEqual(JSON.parse(text(results.get("array-current")!)), { value: 3 });
		assert.deepEqual(JSON.parse(text(results.get("ref")!)), { value: { $ref: selected.length === 1 ? "lazy.plan" : `${target}.lazy.plan` } });
		const invalid = results.get("wrong-family"); assert.ok(invalid); assert.equal(invalid.isError, true); assert.deepEqual(afterInvalid, beforeInvalid);
		for (const owner of selected) assert.deepEqual(f.readState(session, 0, owner).intents?.task, { $ref: `${owner}.lazy.plan` });
		for (const owner of owners.filter(o => !selected.includes(o))) assert.throws(() => f.readState(session, 0, owner), /excluded|unavailable/);
	});

	test("actual mutation registration caches only flat/multi shape on an unregistered template", { timeout: 30_000 }, async t => {
		let api!: ExtensionAPI; const schemas: unknown[] = [];
		const f = await realPiFixture(t, { stateFlow: false, initializeRepository: false, tools: ["read", "read_state", "patch_state"], extensions: [{ name: "actual-state-flow-registration-observer", factory(pi) {
			api = pi; const register = pi.registerTool;
			pi.registerTool = definition => { if (definition.name === "patch_state") schemas.push(definition.parameters); register(definition); };
			stateFlowExtension(pi, { agentDir: f.agentDir, repositoryRoot: f.repositoryRoot });
		} }] });
		const { session } = await f.createRuntime("new"); assert.equal(schemas.length, 1);
		await session.prompt("/state-flow-passive cwd"); assert.equal(schemas.length, 2, JSON.stringify(schemas));
		for (const command of ["/state-flow-passive cwd", "/state-flow-passive global", "/state-flow-active global", "/state-flow-passive global"]) { await session.prompt(command); assert.equal(schemas.length, 2); }
		await session.prompt("/state-flow-passive global cwd"); assert.equal(schemas.length, 3);
		await session.prompt("/state-flow-passive global cwd session"); assert.equal(schemas.length, 3);
		await session.prompt("/state-flow-off session"); assert.equal(schemas.length, 3, "Off choice stays inert/withdrawn; no declaration refresh");
		await session.prompt("/state-flow-passive session"); assert.equal(schemas.length, 4);
		assert.equal(schemas[1], schemas[3], "same flat schema reused without sole-owner embedded identity");
		assert.equal(schemas[0], schemas[2], "same scoped schema reused");
		const active = api.getActiveTools(); assert.ok(active.includes("read_state") && active.includes("patch_state"));
		const before = schemas.length; f.faux.setResponses([answer("No mutation")]); await session.prompt("Ordinary inference never registers again"); assert.equal(schemas.length, before);
	});

	for (const change of ["sole", "sole-aba", "arity", "off-aba", "multi-to-sole"] as const)
	test(`actual old mutation wrapper cannot rebind authority across ${change}`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { initializeRepository: false }); const { session } = await f.createRuntime("new");
		const selection = change === "multi-to-sole" ? ["global", "cwd"] as const : ["cwd"] as const;
		await session.prompt(`/state-flow-passive ${selection.join(" ")}`);
		const results = new Map<string, ToolResultMessage>(); let changed = false;
		const before = captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		f.faux.setResponses([
			async () => {
				if (change === "off-aba") { await session.prompt("/state-flow-off"); await session.prompt("/state-flow-passive cwd"); }
				else { await session.prompt(change === "arity" ? "/state-flow-passive global cwd" : "/state-flow-passive global"); if (change === "sole-aba") await session.prompt("/state-flow-passive cwd"); }
				changed = true;
				return answer(tool("patch_state", modelPatchArguments(selection, { cwd: { tactics: { stale: true } } }), { id: "old-mutation" }), { stopReason: "toolUse" });
			},
			c => { observe(c, results); return answer("Fresh continuation"); },
		]);
		await session.prompt("Return an old correctly shaped call after public selection change");
		assert.equal(changed, true); const old = results.get("old-mutation"); assert.ok(old); assert.equal(old.isError, true, text(old));
		assert.deepEqual(captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before, "unaccepted stale native operation never creates semantic/lifecycle authority");
		await session.prompt("/state-flow-passive cwd");
		f.faux.setResponses([answer(tool("patch_state", { tactics: { fresh: true } }, { id: "fresh-mutation" }), { stopReason: "toolUse" }), c => { observe(c, results); return answer("Fresh accepted"); }]);
		await session.prompt("Fresh native receipt may independently author its actual sole owner");
		const fresh = results.get("fresh-mutation"); assert.ok(fresh); assert.notEqual(fresh.isError, true, text(fresh)); assert.equal(f.readState(session, 0, "cwd").tactics.fresh, true);
	});

	test("host-denied ToolInfo never becomes a registration loop or a tool permission grant", { timeout: 30_000 }, async t => {
		let api!: ExtensionAPI; let registrations = 0;
		const f = await realPiFixture(t, { stateFlow: false, tools: ["read"], initializeRepository: false, extensions: [{ name: "actual-host-filtered-state-flow", factory(pi) {
			api = pi; const register = pi.registerTool;
			pi.registerTool = definition => { if (definition.name === "patch_state") registrations++; register(definition); };
			stateFlowExtension(pi, { agentDir: f.agentDir, repositoryRoot: f.repositoryRoot });
		} }] });
		const { session } = await f.createRuntime("new"); assert.equal(registrations, 1);
		await session.prompt("/state-flow-passive cwd"); assert.equal(registrations, 2);
		assert.equal(api.getAllTools().some(tool => tool.name === "patch_state"), false, "host filtering really omits registered tool metadata");
		for (const command of ["/state-flow-passive cwd", "/state-flow-passive global", "/state-flow-active global", "/state-flow-passive global"]) { await session.prompt(command); assert.equal(registrations, 2); }
		assert.deepEqual(api.getActiveTools(), ["read"]);
	});

	test("raw patch caller coherence precedes parameters and failure-diagnostic capture", async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await h.tools.get("patch_state")!.execute("seed", { cwd: { tactics: { keep: true } } }, undefined, undefined, h.ctx);
		let reads = 0;
		const params = { get cwd() { reads++; return { tactics: { mustNotPublish: true } }; } };
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		await assert.rejects(h.tools.get("patch_state")!.execute("foreign", params, undefined, undefined, { ...h.ctx, cwd: `${h.repositoryRoot}/foreign` }), /patch selection owner changed/);
		assert.equal(reads, 0, "a rejected caller cannot force argument or diagnostic-input getters");
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners = ["global", "cwd", "session"] as const;
	const choices = Array.from({ length: 7 }, (_, i) => captureScopeSelection(owners.filter((_, bit) => (i + 1) & (1 << bit))));
	for (const selected of choices)
	test(`native intent-first rewrite ${selected.join("+")} retains only new knowledge after reload`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		const { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-active ${selected.join(" ")}`);
		const owner = selected.at(-1)!, results = new Map<string, ToolResultMessage>();
		const ref = (plane: string) => ({ $ref: `${selected.length === 1 ? "" : owner + "."}${plane}.epic` });
		const seed = modelPatchArguments(selected, { [owner]: {
			intents: { done: { refs: ["strategy", "tactics", "lazy"].map(ref) } },
			strategy: { epic: { stale: "remove" } }, tactics: { epic: { stale: "remove" } }, lazy: { epic: { stale: "remove" } },
		} });
		// Deliberately put intents last: semantic phases cannot follow JSON insertion order.
		const rewrite = modelPatchArguments(selected, { [owner]: {
			strategy: { epic: { conclusion: "durable" } }, tactics: { epic: { result: "fresh" } }, lazy: { epic: { archive: "fresh" } },
			intents: { done: null },
		} });
		f.faux.setResponses([
			() => answer(tool("patch_state", seed, { id: "phase-seed" }), { stopReason: "toolUse" }),
			c => { observe(c, results); return answer(tool("patch_state", rewrite, { id: "phase-rewrite" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("Accepted phase rewrite"); },
		]);
		await session.prompt("Close the intent and write durable replacement knowledge in one patch");
		result(results, "phase-seed"); const receipt = result(results, "phase-rewrite");
		assert.ok(text(receipt).includes("strategy.epic"));
		await session.reload();
		f.faux.setResponses([
			() => answer(tool("read_state", { path: "strategy" }, { id: "phase-read" }), { stopReason: "toolUse" }),
			c => { observe(c, results); return answer("Read replacement"); },
		]);
		await session.prompt("Inspect the retained replacement");
		assert.deepEqual(JSON.parse(text(result(results, "phase-read"))).value, { epic: { conclusion: "durable" } });
		const state = f.readState(session, 0, owner);
		assert.deepEqual(state.intents, {});
		assert.deepEqual(state.tactics, { epic: { result: "fresh" } });
		const paths = temporalScopePaths(f.cwd, session.sessionId, owner, f.repositoryRoot, nativeSessionKey(session));
		const stream = parseScopeStream(readFileSync(paths.checkpoint, "utf8"), readFileSync(paths.patches, "utf8"), owner, owner === "cwd" ? f.cwd : undefined, readFileSync(paths.meta, "utf8"));
		assert.ok(stream);
		let canonical = stream.checkpoint.state;
		for (const record of stream.patches) canonical = applyPatch(canonical, record.patch as JsonObject);
		assert.equal(canonical.intents, undefined);
		assert.deepEqual(canonical.lazy, { epic: { archive: "fresh" } });
	});

	const declarationByShape = new Map<string, string>();
	const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");
	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	function observe(c: Context, results: Map<string, ToolResultMessage>) {
		for (const m of c.messages) if (m.role === "toolResult") results.set(m.toolCallId, structuredClone(m));
	}
	function result(results: Map<string, ToolResultMessage>, id: string) {
		const r = results.get(id); assert.ok(r, id); assert.notEqual(r.isError, true, text(r)); return r;
	}
	function record(value: unknown): JsonObject { assert.ok(isObject(value)); return value; }
	function owned(c: Context) {
		const declaration = getCurrentTools(c.messages).filter(v => ["patch_state", "read_state"].includes(v.name)).map(v => ({ name: v.name, description: v.description, parameters: v.parameters }));
		assert.equal(declaration.length, 2);
		const protocol = getCurrentSystemMessage(c.messages)?.sections?.state_flow; assert.equal(typeof protocol, "string");
		const message = c.messages.find(m => m.role === "user" && Array.isArray(m.content) && m.content.some(p => p.type === "text" && p.text.startsWith("State Flow runtime context")));
		assert.ok(message && message.role === "user");
		return { declaration: JSON.stringify(declaration), protocol: protocol!, head: JSON.stringify(message.content) };
	}

	for (const selected of choices)
	test(`native linked handoff/checkpoint ${selected.join("+")} uses declared interface, own replay identities and stable trusted bytes`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-active ${selected.join(" ")}`);
		const target = selected.at(-1)!, results = new Map<string, ToolResultMessage>(), seedContexts: Context[] = [], continued: Context[] = [];
		const initialApproach = { id: "gather-first", rationale: "Gather evidence before choosing a verification method", steps: ["gather", "verify"], status: "accepted" };
		const revisedApproach = { id: "verify-first", rationale: "The initial assumption was contradicted by fixture evidence", steps: ["verify", "publish"], status: "accepted" };
		const reference = (path: string) => ({ $ref: `${selected.length === 1 ? "" : target + "."}${path}` });
		const seed = modelPatchArguments(selected, { [target]: {
			strategy: { requirements: { outcome: "Publish a verified report", constraint: "No account operations" }, accepted: initialApproach, proposals: { shortcut: "Unverified; not accepted" }, prerequisites: { evidence: "available", inputAssumption: "unchecked" }, dependencies: { publication: "Revalidate externally", inputFormat: "Keep current format" } },
			intents: { report: { owns: [reference("lazy.reportEvidence"), reference("tactics.reportWork")] } },
			tactics: { reportWork: { observation: "Gathered evidence", next: "verify" }, retained: "Revalidate external publication before replay" },
			lazy: { reportEvidence: { note: "SUPPORT_NOT_AUTOMATIC" } },
		} });
		f.faux.setResponses([
			c => { seedContexts.push(structuredClone(c)); return answer(tool("patch_state", seed, { id: "linked-seed" }), { stopReason: "toolUse" }); },
			c => { seedContexts.push(structuredClone(c)); observe(c, results); return answer("Checkpoint seeded"); },
		]);
		await session.prompt("Store the fixture's binding requirement, accepted method and separate unaccepted proposal"); result(results, "linked-seed");
		await session.reload();
		const path = temporalScopePaths(f.cwd, session.sessionId, target, f.repositoryRoot, nativeSessionKey(session));
		const stream = () => {
			const s = parseScopeStream(readFileSync(path.checkpoint, "utf8"), readFileSync(path.patches, "utf8"), target, target === "cwd" ? f.cwd : undefined, readFileSync(path.meta, "utf8"));
			assert.ok(s); return s;
		};
		const revise = modelPatchArguments(selected, { [target]: {
			strategy: { accepted: revisedApproach, proposals: { shortcut: null }, rejected: { shortcut: "Did not verify the fixture evidence" }, revisionEvidence: "Fixture assumption contradicted; original constraint still binding", prerequisites: { inputAssumption: "failed" }, failedPrerequisite: { check: "Initial input assumption", result: "failed", implication: "Use verified method" } },
			tactics: { reportWork: { observation: "Verification passed", next: "publish" } },
		} });
		const close = modelPatchArguments(selected, { [target]: { intents: { report: null }, strategy: { closure: { outcome: "Verified report complete", revalidate: "External publication is not proved by memory" } } } });
		let boundary: { id: string } | undefined, replay: JsonObject | undefined;
		let beforeHistory: ReturnType<typeof captureTemporalFileBases> | undefined, afterHistory: typeof beforeHistory;
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		const capture = (c: Context) => { continued.push(structuredClone(c)); observe(c, results); };
		f.faux.setResponses([
			c => { capture(c); return answer(tool("read_state", { path: "strategy" }, { id: "linked-restored" }), { stopReason: "toolUse" }); },
			c => { capture(c); return answer(tool("patch_state", revise, { id: "linked-revise" }), { stopReason: "toolUse" }); },
			c => { capture(c); boundary = structuredClone(stream().patches.at(-1)!.transition); beforeHistory = files(); return answer(tool("read_state", { path: "effective[1].strategy.accepted" }, { id: "linked-history" }), { stopReason: "toolUse" }); },
			c => { capture(c); return answer(tool("read_state", { path: selected.length === 1 ? "patches[0]" : `${target}.patches[0]` }, { id: "linked-patch" }), { stopReason: "toolUse" }); },
			c => { capture(c); afterHistory = files(); return answer(tool("patch_state", close, { id: "linked-close" }), { stopReason: "toolUse" }); },
			c => { capture(c); const current = stream(); replay = structuredClone(current.checkpoint.state); for (const record of current.patches) replay = applyPatch(replay, record.patch as JsonObject); return answer(tool("read_state", { path: target }, { id: "linked-final-state" }), { stopReason: "toolUse" }); },
			c => { capture(c); return answer("Closed verified report"); },
		]);
		await session.prompt("Continue from the accepted memory, revise on supplied evidence and reconcile completed consequences");
		for (const id of ["linked-restored", "linked-revise", "linked-history", "linked-patch", "linked-close", "linked-final-state"]) result(results, id);
		const restored = JSON.parse(text(result(results, "linked-restored"))).value;
		assert.deepEqual(restored.accepted, initialApproach); assert.deepEqual(restored.requirements, { outcome: "Publish a verified report", constraint: "No account operations" });
		assert.deepEqual(restored.proposals, { shortcut: "Unverified; not accepted" }); assert.deepEqual(restored.prerequisites, { evidence: "available", inputAssumption: "unchecked" });
		assert.deepEqual(JSON.parse(text(result(results, "linked-history"))).value, initialApproach); assert.deepEqual(afterHistory, beforeHistory);
		assert.ok(boundary && replay); assert.equal((result(results, "linked-patch").details as { transitionId: string }).transitionId, boundary.id, "the actual native scalar patch forwards this store's exact retained boundary ID");
		assert.equal(JSON.parse(text(result(results, "linked-patch"))).patch.strategy.accepted.id, revisedApproach.id);
		const final = record(JSON.parse(text(result(results, "linked-final-state"))).value), strategy = record(final.strategy);
		assert.deepEqual(final, projectModelReferences(projectStateForRead(replay), selected), "native current read equals this condition's actual canonical checkpoint/tail replay");
		assert.deepEqual(strategy.accepted, revisedApproach); assert.deepEqual(strategy.requirements, restored.requirements);
		assert.deepEqual(strategy.rejected, { shortcut: "Did not verify the fixture evidence" }); assert.equal(strategy.proposals, undefined);
		assert.deepEqual(strategy.prerequisites, { evidence: "available", inputAssumption: "failed" }); assert.deepEqual(strategy.dependencies, restored.dependencies);
		assert.deepEqual(strategy.failedPrerequisite, { check: "Initial input assumption", result: "failed", implication: "Use verified method" });
		assert.deepEqual(strategy.closure, { outcome: "Verified report complete", revalidate: "External publication is not proved by memory" });
		assert.equal(final.intents, undefined); assert.equal(final.lazy, undefined); assert.deepEqual(final.tactics, { retained: "Revalidate external publication before replay" });
		const cascade = text(result(results, "linked-close"));
		for (const ownedPath of ["lazy.reportEvidence", "tactics.reportWork"]) assert.ok(cascade.includes(`${selected.length === 1 ? "" : target + "."}${ownedPath}`));
		if (selected.includes("session")) assert.equal(f.readState(session, 0, "session").response, "Closed verified report");
		for (const scope of owners.filter(scope => !selected.includes(scope))) assert.throws(() => f.readState(session, 0, scope as StateScope), /excluded|unavailable/);
		for (const contexts of [seedContexts, continued]) {
			const first = owned(contexts[0]!);
			for (const context of contexts) { const actual = owned(context); assert.equal(actual.declaration, first.declaration); assert.equal(actual.protocol, first.protocol); assert.equal(actual.head, first.head); }
		}
		const first = owned(continued[0]!), shape = selected.length === 1 ? "flat" : "multi";
		if (declarationByShape.has(shape)) assert.equal(first.declaration, declarationByShape.get(shape), "identical arity has identical declarations, not per-owner identity");
		else declarationByShape.set(shape, first.declaration);
		t.diagnostic(JSON.stringify({ kind: "M3.4-deterministic-interface-bytes", wanted: selected, shape, scopeTarget: target,
			declarationJsonUtf8Bytes: bytes(first.declaration), ownedWrappedSectionUtf8Bytes: bytes(first.protocol), ownedHeadContentJsonUtf8Bytes: bytes(first.head),
			seedProviderContexts: seedContexts.length, continuedProviderContexts: continued.length, patchBoundaryForwardedExactly: true, canonicalReplayMatched: true,
			limits: "actual SDK model Context, not provider wire/tokens/cache/latency/cost or observed model errors/quality" }));
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	const owners = ["global", "cwd", "session"] as const;
	const choices = Array.from({ length: 7 }, (_, i) => captureScopeSelection(owners.filter((_, bit) => (i + 1) & (1 << bit))));
	const text = (r: ToolResultMessage) => r.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	function observe(c: Context, results: Map<string, ToolResultMessage>) {
		for (const m of c.messages) if (m.role === "toolResult") results.set(m.toolCallId, structuredClone(m));
	}
	function result(results: Map<string, ToolResultMessage>, id: string, error = false) {
		const r = results.get(id); assert.ok(r, id); assert.equal(Boolean(r.isError), error, text(r)); return r;
	}
	function handoff(c: Context) {
		for (const m of c.messages) if (m.role === "user" && Array.isArray(m.content)) {
			const p = m.content.find(p => p.type === "text" && p.text.startsWith("State Flow exit handoff"));
			if (p?.type === "text") return JSON.parse(p.text.slice(p.text.indexOf("\n") + 1));
		}
		assert.fail("No actual native exit/bootstrap handoff");
	}

	for (const selected of choices)
	test(`actual ${selected.join("+")} Skill targets, scope-blind compiler retry and deletion hints retain canonical evidence`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		const routes = ["user", "project", "temporary"] as const;
		const paths = Object.fromEntries(owners.map((owner, i) => [owner, f.registerSkill(routes[i]!, `outputs-${owner}`, `# ${owner} source\n\nOnly useful exact-source guidance.`)])) as Record<typeof owners[number], string>;
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-active ${selected.join(" ")}`);
		const results = new Map<string, ToolResultMessage>(), target = selected.at(-1)!, path = paths[target];
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		const card = { description: "Useful compiled guidance", kind: "skill", compilation: { lesson: "Use exact source, no owner lookup needed" } };
		const valid = selected.length === 1 ? { artifacts: { [path]: card } } : { [target]: { artifacts: { [path]: card } } };
		const invalid = modelPatchArguments(selected, { [target]: { artifacts: { [path]: { description: "Incomplete Skill", compilation: { lesson: "Needs a kind" } } } } });
		const missingKey = "/source/cwd/~[0].md", pointerKey = missingKey.replace(/~/g, "~0").replace(/\//g, "~1");
		const noop = modelPatchArguments(selected, { [target]: { tactics: { missing: { "a/b~[0]": null } }, artifacts: { [missingKey]: null } } });
		let beforeInvalid: ReturnType<typeof files> | undefined, afterInvalid: typeof beforeInvalid, beforeNoop: typeof beforeInvalid, afterNoop: typeof beforeInvalid;
		f.faux.setResponses([
			...owners.map(owner => (c: Context) => { observe(c, results); return answer(tool("read", { path: paths[owner] }, { id: `read-${owner}` }), { stopReason: "toolUse" }); }),
			c => { observe(c, results); beforeInvalid = files(); return answer(tool("patch_state", invalid, { id: "bad-compile" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); afterInvalid = files(); return answer(tool("patch_state", valid, { id: "good-compile" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); beforeNoop = files(); return answer(tool("patch_state", noop, { id: "missing-delete" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); afterNoop = files(); return answer(tool("read_state", { path: "artifacts" }, { id: "read-card" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("Output interface inspected"); },
		]);
		await session.prompt("Read actual Skills, retry compilation with declared grammar, inspect no-op deletion locators");
		for (const owner of owners) {
			const r = result(results, `read-${owner}`);
			if (selected.includes(owner)) assert.ok(text(r).includes(`belongs at ${selected.length === 1 ? "" : owner + "."}artifacts[${JSON.stringify(paths[owner])}]`));
			else assert.doesNotMatch(text(r), /State Flow acquisition|belongs at/);
		}
		const bad = result(results, "bad-compile", true); assert.ok(text(bad).includes(`Invalid Skill at ${target}.artifacts[${JSON.stringify(path)}]`)); assert.match(text(bad), /kind must be/);
		assert.deepEqual(afterInvalid, beforeInvalid, "failed compilation cannot publish semantics/provenance/lifecycle");
		result(results, "good-compile"); const deleted = result(results, "missing-delete");
		const prefix = selected.length === 1 ? "" : `/${target}`;
		assert.ok(text(deleted).includes(`deletion skipped at ${prefix}/tactics/missing/a~1b~0[0]`));
		assert.ok(text(deleted).includes(`deletion skipped at ${prefix}/artifacts/${pointerKey}`));
		assert.ok(text(deleted).includes(`First unavailable component: ${prefix}/tactics`));
		const canonical = (deleted.details as { missingDeletions: Array<{ path: string; unavailablePath: string }> }).missingDeletions;
		assert.ok(canonical.some(v => v.path === `/${target}/tactics/missing/a~1b~0[0]` && v.unavailablePath === `/${target}/tactics`));
		assert.deepEqual(afterNoop, beforeNoop, "a no-op locator receipt cannot create a transition");
		const read = JSON.parse(text(result(results, "read-card"))); assert.deepEqual(read.value[path], card);
		assert.deepEqual(f.readState(session, 0, target).artifacts?.[path], card);
		const scopePaths = temporalScopePaths(f.cwd, session.sessionId, target, f.repositoryRoot, nativeSessionKey(session));
		const provenance = JSON.parse(readFileSync(scopePaths.meta, "utf8")).artifacts[path];
		assert.equal(provenance.sourceHash, hashArtifactSource(readFileSync(path))); assert.equal(provenance.compilerRevision, SKILL_ARTIFACT_COMPILER);
	});

	for (const selected of choices)
	test(`actual ${selected.join("+")} new Stop, reload and bootstrap handoffs render wanted refs without canonical relocation`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-active ${selected.join(" ")}`);
		const patch = Object.fromEntries(selected.map(owner => [owner, { lazy: { plan: "LAZY_BODY_NOT_AUTOMATIC" }, tactics: { link: { $ref: `${selected.length === 1 ? "" : owner + "."}lazy.plan` }, literal: `${owner}.lazy.plan` } }]));
		const results = new Map<string, ToolResultMessage>();
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(selected, patch), { id: "handoff-seed" }), { stopReason: "toolUse" }), c => { observe(c, results); return answer("LAST_ACTIVE_ANSWER"); }]);
		await session.prompt("Seed durable continuation refs"); result(results, "handoff-seed");
		await session.prompt("/state-flow-passive"); const contexts: Context[] = [];
		const inspect = async () => { f.faux.setResponses([c => { contexts.push(structuredClone(c)); return answer("Passive native continuation"); }]); await session.prompt("Inspect the retained handoff"); };
		await inspect(); await session.reload(); await inspect();
		await session.prompt("/state-flow-active"); f.faux.setResponses([c => { contexts.push(structuredClone(c)); return answer("Bootstrap native continuation"); }]); await session.prompt("Retain the bootstrap boundary");
		assert.equal(contexts.length, 3); const target = selected.at(-1)!;
		for (const c of contexts) {
			const body = handoff(c); assert.deepEqual(body.state.tactics.link, { $ref: selected.length === 1 ? "lazy.plan" : `${target}.lazy.plan` });
			assert.equal(body.state.tactics.literal, `${target}.lazy.plan`); assert.equal(Object.hasOwn(body.state, "response"), false);
			assert.doesNotMatch(JSON.stringify(body), /LAZY_BODY_NOT_AUTOMATIC|LAST_ACTIVE_ANSWER/);
		}
		assert.deepEqual(handoff(contexts[0]!), handoff(contexts[1]!), "new reload rendering retains the same native continuation boundary");
		for (const owner of selected) assert.deepEqual(f.readState(session, 0, owner).tactics.link, { $ref: `${owner}.lazy.plan` });
	});

	for (const owner of owners)
	test(`actual ${owner} ordinary compiler diagnostic retains provenance but requires no scoped retry arguments`, { timeout: 30_000 }, async t => {
		const f = await realPiFixture(t, { mode: "configured", initializeRepository: false });
		const path = `${f.cwd}/ordinary-${owner}.md`; writeFileSync(path, "Exact ordinary source body\n");
		writeFileSync(`${f.repositoryRoot}/config.json`, JSON.stringify({ mode: "off", scopes: owners }));
		const { session } = await f.createRuntime("new"); await session.prompt(`/state-flow-active ${owner}`);
		const results = new Map<string, ToolResultMessage>(), files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session));
		let before: ReturnType<typeof files> | undefined, after: typeof before;
		f.faux.setResponses([
			answer(tool("patch_state", { artifacts: { [path]: { description: "Registered ordinary" } } }, { id: "ordinary-register" }), { stopReason: "toolUse" }),
			c => { observe(c, results); return answer(tool("read", { path }, { id: "ordinary-read" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); before = files(); return answer(tool("patch_state", { tactics: { mustNotPublish: true } }, { id: "ordinary-invalid" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); after = files(); return answer(tool("patch_state", { artifacts: { [path]: { description: "Compiled ordinary" } } }, { id: "ordinary-retry" }), { stopReason: "toolUse" }); },
			c => { observe(c, results); return answer("Ordinary compilation complete"); },
		]);
		await session.prompt("Acquire exact ordinary source and retry using only flat artifact fields");
		result(results, "ordinary-register"); result(results, "ordinary-read");
		assert.match(text(result(results, "ordinary-invalid", true)), new RegExp(`requires compiler output at ${owner}\\.artifacts`));
		assert.deepEqual(after, before); result(results, "ordinary-retry"); assert.equal(f.readState(session, 0, owner).tactics.mustNotPublish, undefined);
		assert.deepEqual(f.readState(session, 0, owner).artifacts?.[path], { description: "Compiled ordinary" });
		const p = temporalScopePaths(f.cwd, session.sessionId, owner, f.repositoryRoot, nativeSessionKey(session));
		const proof = JSON.parse(readFileSync(p.meta, "utf8")).artifacts[path];
		assert.equal(proof.compilerRevision, ORDINARY_ARTIFACT_COMPILER); assert.equal(proof.sourceHash, undefined, "ordinary source evidence is fingerprint-based, not an invented content hash");
		const current = statSync(path, { bigint: true }); assert.deepEqual(proof.sourceFingerprint, { size: Number(current.size), mtimeNs: current.mtimeNs.toString() });
	});
}

{
	const answer = fauxAssistantMessage, tool = fauxToolCall;

	type Section = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	function presentation() {
		let current!: Section;
		return { section: () => current, load: async (): Promise<StateFlowTelegramModules> => ({ sections: { registerTelegramSection(s) { current = s; return () => {}; } } }) };
	}
	function callback(action: string, acknowledge = async (_text?: string) => {}) {
		const edits: StateFlowTelegramView[] = [], notices: Array<string | undefined> = [];
		const ctx: StateFlowTelegramCallbackContext = { action, payload: "global cwd session", callbackData: (a, p) => `${a}:${p ?? ""}`,
			answerCallback: async text => { notices.push(text); await acknowledge(text); }, edit: async v => { edits.push(v); }, openRich: async () => {} };
		return { ctx, edits, notices };
	}
	function deadline<T>(p: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Telegram control did not withdraw before release")), 3000); })]).finally(() => clearTimeout(timer));
	}
	async function noCanonicalIO(paths: Set<string>, action: () => Promise<void>) {
		const read = fs.readFileSync, open = fs.openSync, stat = fs.lstatSync, exists = fs.existsSync, attempts: string[] = [];
		const guard = (p: unknown) => { if (paths.has(String(p))) { attempts.push(String(p)); throw new Error("Telegram Off canonical I/O"); } };
		fs.readFileSync = ((...a: Parameters<typeof read>) => { guard(a[0]); return read(...a); }) as typeof read;
		fs.openSync = ((...a: Parameters<typeof open>) => { guard(a[0]); return open(...a); }) as typeof open;
		fs.lstatSync = ((...a: Parameters<typeof stat>) => { guard(a[0]); return stat(...a); }) as typeof stat;
		fs.existsSync = p => { guard(p); return exists(p); }; syncBuiltinESMExports();
		try { await action(); assert.deepEqual(attempts, [], "no swallowed exact-path canonical accesses"); }
		finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = stat; fs.existsSync = exists; syncBuiltinESMExports(); }
	}
	const selections = Array.from({ length: 7 }, (_, i) => captureScopeSelection(DEFAULT_SCOPE_SELECTION.filter((_, bit) => ((i + 1) & (1 << bit)) !== 0)));
	for (const scopes of selections) test(`native Telegram ${scopes.join("+")} Off withdraws mode-only Start while exclusion stays held`, { timeout: 15_000 }, async t => {
		const ui = presentation(), f = await realPiFixture(t, { initializeRepository: false, telegram: { load: ui.load } }), { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-passive ${[...scopes].reverse().join(" ")}`);
		const target = scopes[0], results: ToolResultMessage[] = [];
		f.faux.setResponses([answer(tool("patch_state", modelPatchArguments(scopes, { [target]: { tactics: { retained: true } } }), { id: "telegram-source" }), { stopReason: "toolUse" }), c => {
			results.push(...c.messages.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "telegram-source")); return answer("Source accepted");
		}]);
		await session.prompt("Create native memory before Telegram controls"); assert.equal(results.length, 1); assert.notEqual(results[0]!.isError, true);
		assert.equal(await ui.section().handleCallback!(callback("off").ctx), "handled");
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before = files();
		let release!: () => void, entered!: () => void, staged!: () => void;
		const acquired = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { staged = r; });
		const holding = withStorageTransaction(f.repositoryRoot, async () => { entered(); await gate; }); await acquired;
		let signal: AbortSignal | undefined;
		const inspect = TemporalRuntime.prototype.inspectSelectedLifecycle;
		const spy = t.mock.method(TemporalRuntime.prototype, "inspectSelectedLifecycle", function(this: TemporalRuntime, ...a: Parameters<typeof inspect>) { signal = a[2]; staged(); return Reflect.apply(inspect, this, a); });
		const active = callback("active"), starting = Promise.resolve(ui.section().handleCallback!(active.ctx));
		try {
			await deadline(waiting); spy.mock.restore(); assert.ok(signal); assert.equal(signal.aborted, false);
			assert.deepEqual(active.notices, ["Switching State Flow to active"]);
			const off = callback("off");
			await noCanonicalIO(new Set(before.map(f => f.path)), async () => {
				assert.equal(await ui.section().handleCallback!(off.ctx), "handled"); await deadline(starting); assert.equal(signal!.aborted, true);
			});
			assert.equal(active.edits.length, 0, "withdrawn Start cannot overwrite the newer menu"); assert.equal(off.edits.length, 1);
			assert.deepEqual(files(), before); await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`));
		} finally { release(); await holding; await starting; }
		assert.equal(await ui.section().handleCallback!(callback("active").ctx), "handled"); assert.equal(f.readState(session, 0, target).tactics.retained, true);
		await session.reload(); await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`));
	});

	for (const scopes of selections) test(`native Telegram ${scopes.join("+")} completed Passive receipt cannot present after public scope ABA`, { timeout: 15_000 }, async t => {
		const ui = presentation(), f = await realPiFixture(t, { initializeRepository: false, telegram: { load: ui.load } }), { session } = await f.createRuntime("new");
		await session.prompt(`/state-flow-active ${scopes.join(" ")}`);
		let acknowledge!: () => void, announced!: () => void, accepted!: () => void;
		const ack = new Promise<void>(r => { acknowledge = r; }), seen = new Promise<void>(r => { announced = r; }), published = new Promise<void>(r => { accepted = r; });
		const persist = TemporalRuntime.prototype.persistSelectedPassive;
		const spy = t.mock.method(TemporalRuntime.prototype, "persistSelectedPassive", async function(this: TemporalRuntime, ...a: Parameters<typeof persist>) {
			const value = await Reflect.apply(persist, this, a); accepted(); return value;
		});
		const passive = callback("passive", async () => { announced(); await ack; }), selecting = Promise.resolve(ui.section().handleCallback!(passive.ctx));
		try {
			await deadline(seen); await deadline(published); await new Promise<void>(r => setImmediate(r)); spy.mock.restore();
			const bits = () => DEFAULT_SCOPE_SELECTION.map(scope => {
				const p = temporalScopePaths(f.cwd, session.sessionId, scope, f.repositoryRoot, nativeSessionKey(session));
				return [p.checkpoint, p.patches, p.meta].map(p => fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : null);
			});
			const before = bits(), alternative = scopes.length === 1 && scopes[0] === "cwd" ? "global" : "cwd";
			await session.prompt(`/state-flow-off ${alternative}`); await session.prompt(`/state-flow-passive ${scopes.join(" ")}`);
			assert.deepEqual(bits(), before, "control ABA does not create a semantic transition or delete accepted memory");
		} finally { acknowledge(); await selecting; }
		assert.deepEqual(passive.edits, [], "completed old receipt cannot resurrect after equality returns, even without another Telegram callback");
		await session.prompt("/state-flow-status"); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes.join(", ")}`)); assert.ok(f.notifications.at(-1)?.includes("Mode: passive"));
	});


	for (const replaced of [false, true]) test(`native busy Telegram Start defers current scopes and Off withdraws old deferral replaced=${replaced}`, { timeout: 15_000 }, async t => {
		const ui = presentation(), f = await realPiFixture(t, { initializeRepository: false, telegram: { load: ui.load } }), { session } = await f.createRuntime("new");
		await session.prompt("/state-flow-off cwd session");
		const files = () => captureTemporalFileBases(f.cwd, session.sessionId, f.repositoryRoot, nativeSessionKey(session)), before = files();
		let entered!: () => void, release!: () => void;
		const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
		let calls = 0;
		f.faux.setResponses([async () => { calls++; entered(); await gate; return answer("Ordinary Off answer delivered"); }]);
		const operation = session.prompt("Keep this native operation busy");
		try {
			await deadline(started); const active = callback("active"); assert.equal(await ui.section().handleCallback!(active.ctx), "handled");
			assert.ok(active.notices.includes("State Flow will become active after the current turn"));
			assert.deepEqual(files(), before, "a deferred presentation action grants no memory");
			if (replaced) await session.prompt("/state-flow-off global");
			assert.deepEqual(files(), before);
		} finally { release(); await operation; }
		assert.equal(calls, 1); await session.prompt("/state-flow-status");
		const mode = replaced ? "off" : "active", scopes = replaced ? "global" : "cwd, session";
		assert.ok(f.notifications.at(-1)?.includes(`Mode: ${mode}`)); assert.ok(f.notifications.at(-1)?.includes(`Selected scopes: ${scopes}`));
		if (replaced) assert.deepEqual(files(), before, "settled old deferral cannot acquire for the new Off selection");
		else assert.doesNotThrow(() => f.readState(session, 0, "session"));
	});
}

{
	async function cohort(h: ReturnType<typeof harness>) {
		return (await loadSelectedFileCohort(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), DEFAULT_SCOPE_SELECTION, h.repositoryRoot,
			resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId()).key))!;
	}

	function policy(h: ReturnType<typeof harness>) {
		return prepareSelectedBranchPolicy(h.entries, { owner: h.ctx.sessionManager.getSessionId(), markerEntryType: "state-flow-passive-stop",
			defaults: { mode: "off", scopes: DEFAULT_SCOPE_SELECTION } });
	}

	test("native Passive shared observation exposes only present owners; invalid first authoring creates no private/lifecycle owners", async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		writeGlobalState({ ...emptyState(), strategy: { inherited: "present" } }, h.repositoryRoot);
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.equal(h.readState(0, "global").strategy.inherited, "present");
		assert.throws(() => h.readState(0, "session"), /excluded/);
		assert.throws(() => h.readState(0, "cwd"), /excluded/);
		const entries = structuredClone(h.entries);
		await assert.rejects(h.tools.get("patch_state")!.execute("invalid", { session: { response: "forged" } }, undefined, undefined, h.ctx), /response/);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
		assert.deepEqual(h.entries, entries);
		assert.equal(h.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
		assert.equal(policy(h).mode, "passive");
		await h.tools.get("patch_state")!.execute("first", { session: { tactics: { first: "authored" } } }, undefined, undefined, h.ctx);
		const accepted = await cohort(h);
		assert.equal(accepted.lifecycle.runtime.meta.version, 2);
		assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(accepted.lifecycle.runtime.meta.step, 1);
		assert.equal(accepted.view.lineage.length, 2, "origin and first patch must be accepted together");
		assert.deepEqual(readTemporalView(accepted.view, 0, "session"), { tactics: { first: "authored" } });
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
		assert.equal(h.entries.at(-1).data.version, 2);
	});

	test("auto-start binds a newer Passive choice at origin publication and Off still cancels that origin", async (t) => {
		for (const mode of ["passive", "off"] as const) {
			const h = harness({ initializeRepository: false, mode: "active" });
			let enter!: () => void, release!: () => void;
			const entered = new Promise<void>(resolve => { enter = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const restores: Array<() => void> = [];
			for (const method of ["withSelectedSessionAcquisitionTransaction", "withSelectedFirstPatchTransaction"] as const) {
				const original = TemporalRuntime.prototype[method];
				const mocked = t.mock.method(TemporalRuntime.prototype, method, async function(this: TemporalRuntime, ...args: any[]) {
					enter(); await gate;
					return Reflect.apply(original, this, args);
				});
				restores.push(() => mocked.mock.restore());
			}
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			const attaching = h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
			try {
				await entered;
				await h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
				assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
			} finally { release(); await attaching; for (const restore of restores) restore(); }
			assert.equal(policy(h).mode, mode);
			if (mode === "off") {
				assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
				continue;
			}
			const accepted = await cohort(h);
			assert.equal(accepted.lifecycle.runtime.config.mode, "passive");
			assert.equal(accepted.lifecycle.runtime.meta.step, 0);
			assert.equal(accepted.view.lineage.length, 1, "one origin, no fabricated semantic patch");
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
			await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
			assert.equal(policy(h).mode, "passive");
		}
	});

	test("first native authoring rolls back all owners on publication failure and retries one selected acceptance", async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const rename = fs.renameSync;
		let injected = false;
		const runtime = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime;
		fs.renameSync = ((source, target) => {
			if (!injected && target === runtime) { injected = true; throw new Error("injected first-authoring failure"); }
			return rename(source, target);
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		try {
			await assert.rejects(h.tools.get("patch_state")!.execute("fail", { session: { tactics: { first: true } } }, undefined, undefined, h.ctx), /injected/);
		} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
		assert.equal(h.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
		await h.tools.get("patch_state")!.execute("retry", { session: { tactics: { first: true } } }, undefined, undefined, h.ctx);
		assert.equal((await cohort(h)).lifecycle.runtime.meta.step, 1);
	});

	test("a first native patch withdraws before a foreign lock releases and creates no empty private origin", async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const lock = join(h.repositoryRoot, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const rejected = assert.rejects(h.tools.get("patch_state")!.execute("queued-first", { session: { tactics: { stale: true } } }, undefined, undefined, h.ctx), /abort|cancel|current|changed/i);
			await new Promise(resolve => setTimeout(resolve, 15));
			await h.commands.get("state-flow-off")!.handler("", h.ctx);
			await Promise.race([rejected, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("first patch did not withdraw while exclusion remained held")), 1000); })]);
			assert.equal(existsSync(lock), true);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
		} finally { clearTimeout(timer); rmSync(lock, { force: true }); }
	});

	async function unacquiredNativeFixture(selection: ScopeSelection = ["cwd"], mode: "off" | "passive" = "off") {
		const h = harness({ initializeRepository: false, mode });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const key = resolveSessionAddress(h.ctx.sessionManager.getSessionFile(), h.ctx.sessionManager.getSessionId()).key;
		const source = new TemporalRuntime(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
		await source.withSelectedSharedOriginTransaction(selection, emptySnapshot("passive"), p => p(), undefined, true);
		await source.withSelectedPatchTransaction(tx => tx.publish({ config: { mode: "passive" }, meta: {
			step: 4, specification: "earlier shared-only run", bootstrap: true, validation: { attempt: 2, error: "old observation", instruction: "old check" } } },
			{ id: "prior-shared-progress", transitions: selection.map(scope => ({ scope, patch: { strategy: { retained: scope } } })) }), () => {});
		return { h, source, key };
	}

	test("explicit native Start acquires a truthful unacquired source through exact-base admission, not a new origin or implicit resume", async t => {
		for (const selection of [["global"], ["cwd"], ["global", "cwd"]] as ScopeSelection[]) {
			const { h, key } = await unacquiredNativeFixture(selection);
			assert.deepEqual(policy(h).scopes, DEFAULT_SCOPE_SELECTION);
			const privatePaths = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot, key);
			assert.equal(existsSync(privatePaths.meta), false);
			let calls = 0;
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				assert.equal(args[0].kind, "unacquired");
				if (args[0].kind !== "unacquired") throw new Error("Expected exact existing unacquired base");
				assert.deepEqual(args[0].base.view.selection, selection);
				assert.deepEqual(args[0].selection, policy(h).scopes);
				assert.equal(this.selectedView(), undefined); assert.equal(existsSync(privatePaths.meta), false);
				calls++; return Reflect.apply(acquire, this, args);
			});
			try { await h.commands.get("state-flow-active")!.handler("", h.ctx); } finally { spy.mock.restore(); }
			assert.equal(calls, 1);
			const accepted = await cohort(h);
			assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired");
			assert.equal(accepted.lifecycle.runtime.meta.step, 4);
			assert.equal(accepted.lifecycle.runtime.meta.specification, undefined, "explicit Start clears only old run specification/repair");
			assert.equal(accepted.lifecycle.runtime.meta.validation, undefined);
			assert.equal(accepted.lifecycle.runtime.config.mode, "active");
			for (const scope of selection) assert.equal(h.readState(0, scope).strategy.retained, scope);
			assert.deepEqual(h.readState(0, "session"), { intents: {}, strategy: {}, tactics: {}, artifacts: {}, response: "" });
			assert.deepEqual(readTemporalView(accepted.view, 0, "session"), {});
			assert.equal(accepted.view.scopes.session!.revision, 0);
			assert.equal(accepted.view.scopes.session!.patches.length, 0);
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
		}
	});

	test("native Passive first mutation accepts existing unacquired source and patch in one publication with source run fields", async () => {
		const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
		assert.deepEqual(policy(h).scopes, DEFAULT_SCOPE_SELECTION);
		const privateMeta = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot, key).meta;
		assert.equal(existsSync(privateMeta), false);
		const rename = fs.renameSync; let privatePublications = 0;
		fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => { if (String(args[1]) === privateMeta) privatePublications++; return rename(...args); }) as typeof fs.renameSync;
		syncBuiltinESMExports();
		const result = await (async () => {
			try { return await h.tools.get("patch_state")!.execute("existing-unacquired-first", { session: { tactics: { firstPrivate: true } } }, undefined, undefined, h.ctx); }
			finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		})();
		assert.equal(privatePublications, 1, "origin and first private patch have no intermediate empty publication");
		const accepted = await cohort(h);
		assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(accepted.lifecycle.runtime.meta.step, 5);
		assert.equal(accepted.lifecycle.runtime.meta.specification, "earlier shared-only run");
		assert.deepEqual(accepted.lifecycle.runtime.meta.validation, { attempt: 2, error: "old observation", instruction: "old check" });
		assert.equal(accepted.lifecycle.runtime.meta.bootstrap, true);
		assert.equal(accepted.lifecycle.runtime.config.mode, "passive");
		assert.equal(h.readState(0, "cwd").strategy.retained, "cwd");
		assert.equal(h.readState(0, "session").tactics.firstPrivate, true);
		assert.equal(accepted.view.scopes.session!.revision, 1);
		assert.equal(accepted.view.scopes.session!.patches.length, 1);
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
		assert.equal(result.details.step, 5);
	});

	test("first mutation cannot borrow a live policy receipt from another native physical owner", async () => {
		const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
		const foreign = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager,
			getSessionId: () => "foreign-caller", getSessionFile: () => join(h.repositoryRoot, "foreign-caller.jsonl"),
			getHeader: () => ({ ...h.ctx.sessionManager.getHeader()!, id: "foreign-caller" }) } };
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
		await assert.rejects(h.tools.get("patch_state")!.execute("foreign-first-owner", { session: { tactics: { prohibited: true } } }, undefined, undefined, foreign), /owner|selection|policy/i);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
	});

	test("unacquired first mutation valid no-op acquires only the authorized origin without a fake step or semantic revision", async () => {
		for (const selection of [["global"], ["cwd"], ["global", "cwd"]] as ScopeSelection[]) {
			const { h, key } = await unacquiredNativeFixture(selection, "passive");
			const patch = Object.fromEntries(selection.map(scope => [scope, { strategy: { retained: scope } }]));
			const result = await h.tools.get("patch_state")!.execute("unacquired-noop", patch, undefined, undefined, h.ctx);
			const accepted = await cohort(h);
			assert.equal(result.details.changed, false); assert.equal(result.details.step, 4);
			assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired");
			assert.equal(accepted.lifecycle.runtime.meta.step, 4);
			assert.equal(accepted.view.scopes.session!.revision, 0); assert.equal(accepted.view.scopes.session!.patches.length, 0);
			assert.equal(accepted.view.lineage.length, 1);
			for (const scope of selection) assert.equal(accepted.view.scopes[scope]!.revision, 1);
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			await h.tools.get("patch_state")!.execute("repeat-noop", patch, undefined, undefined, h.ctx);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
		}
	});

	test("unacquired native drafts and deferred/pending authority refuse without intermediate lifecycle or private files", async () => {
		for (const refusal of ["response", "retired", "deferred", "pending"] as const) {
			const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
			if (refusal === "deferred") {
				const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
				const metadata = JSON.parse(readFileSync(life.runtime, "utf8")); metadata.privateAcquisition = "deferred"; writeFileSync(life.runtime, JSON.stringify(metadata));
			} else if (refusal === "pending") h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: {
				version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "passive", scopes: [...DEFAULT_SCOPE_SELECTION], forkPending: true } });
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), entries = structuredClone(h.entries);
			const patch = refusal === "response" ? { session: { response: "forged" } } : refusal === "retired" ? { session: { contract: { old: true } } } : { session: { tactics: { prohibited: true } } };
			await assert.rejects(h.tools.get("patch_state")!.execute(`refuse-${refusal}`, patch, undefined, undefined, h.ctx), /response|contract|retired|participation/i);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
			assert.deepEqual(h.entries, entries);
		}
	});

	test("first-mutation receipts withdraw for Abort/Off/ABA while an equal Passive policy preserves the owned mutation", async t => {
		for (const boundary of ["abort", "off", "same-policy", "aba"] as const) {
			const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			let entered!: () => void, release!: () => void;
			const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			t.after(() => release());
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", async function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				entered(); await gate; return Reflect.apply(acquire, this, args);
			});
			const controller = new AbortController();
			const operation = h.tools.get("patch_state")!.execute("held-first-mutation", { session: { tactics: { first: true } } }, controller.signal, undefined, h.ctx);
			const pending = boundary === "same-policy" ? operation.then((value: unknown) => ({ value }), (error: unknown) => ({ error })) : assert.rejects(operation);
			try {
				await waiting;
				if (boundary === "abort") controller.abort(new Error("first mutation cancelled"));
				else if (boundary === "aba") { await h.commands.get("state-flow-off")!.handler("", h.ctx); await h.commands.get("state-flow-passive")!.handler("", h.ctx); }
				else if (boundary === "off") await h.commands.get("state-flow-off")!.handler("", h.ctx);
				else await h.commands.get("state-flow-passive")!.handler("", h.ctx);
				release(); const result = await pending;
				if (boundary === "same-policy") {
					assert.ok(result && "value" in result);
					assert.equal((await cohort(h)).lifecycle.runtime.meta.step, 5);
					assert.equal(h.readState(0, "session").tactics.first, true);
				} else {
					assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
					assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
				}
			} finally { release(); spy.mock.restore(); }
		}
	});

	test("unacquired first mutation exact-base CAS keeps semantic/run/header-loss peer reality and installs no private origin", async t => {
		for (const drift of ["semantic", "run", "header-loss"] as const) {
			const { h, source, key } = await unacquiredNativeFixture(["cwd"], "passive");
			let entered!: () => void, release!: () => void;
			const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			t.after(() => release());
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", async function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				entered(); await gate; return Reflect.apply(acquire, this, args);
			});
			const pending = assert.rejects(h.tools.get("patch_state")!.execute("stale-first", { session: { tactics: { prohibited: true } } }, undefined, undefined, h.ctx));
			try {
				await waiting;
				if (drift === "header-loss") { const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key); rmSync(life.config); rmSync(life.runtime); }
				else await source.withSelectedPatchTransaction(tx => {
					const next = structuredClone(tx.snapshot); if (drift === "run") next.meta.step = 5;
					tx.publish(next, drift === "semantic" ? { id: "peer-first-mutation", transitions: [{ scope: "cwd", patch: { tactics: { peer: true } } }] } : undefined);
				}, () => {});
				const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
				release(); await pending;
				assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
				assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
			} finally { release(); spy.mock.restore(); }
		}
	});

	test("first mutation preserves known private denial with accepted or cleared cache rather than reclassifying as unacquired", async t => {
		for (const clearCache of [false, true]) {
			const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
			let owner!: TemporalRuntime;
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				owner = this; return Reflect.apply(acquire, this, args);
			});
			try { await h.tools.get("patch_state")!.execute("known-owned-first", { session: { strategy: { owned: true } } }, undefined, undefined, h.ctx); } finally { spy.mock.restore(); }
			const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			const metadata = JSON.parse(readFileSync(life.runtime, "utf8")); metadata.privateAcquisition = "unacquired";
			writeFileSync(life.config, JSON.stringify({ mode: "passive", scopes: ["cwd"] })); writeFileSync(life.runtime, JSON.stringify(metadata));
			const privatePaths = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot, key);
			for (const name of ["checkpoint", "patches", "meta"] as const) rmSync(privatePaths[name]);
			if (clearCache) owner.view = undefined;
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			await assert.rejects(h.tools.get("patch_state")!.execute("cannot-reinitialize", { session: { tactics: { prohibited: true } } }, undefined, undefined, h.ctx), /private|authority|acquisition/i);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
		}
	});

	test("first mutation publication is final after native checkpoint failure and retry is a semantic no-op", async () => {
		const { h, key } = await unacquiredNativeFixture(["cwd"], "passive");
		const push = h.entries.push;
		h.entries.push = ((...entries: any[]) => { if (entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE)) throw new Error("first mutation checkpoint failed"); return push.apply(h.entries, entries); }) as typeof h.entries.push;
		const patch = { session: { tactics: { acceptedDespiteNativeFailure: true } } };
		await assert.rejects(h.tools.get("patch_state")!.execute("accepted-first", patch, undefined, undefined, h.ctx), /checkpoint failed/);
		h.entries.push = push;
		const accepted = await cohort(h);
		assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired"); assert.equal(accepted.lifecycle.runtime.meta.step, 5);
		assert.equal(h.readState(0, "session").tactics.acceptedDespiteNativeFailure, true);
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
		const retry = await h.tools.get("patch_state")!.execute("retry-first", patch, undefined, undefined, h.ctx);
		assert.equal(retry.details.changed, false); assert.equal(retry.details.step, 5);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
	});

	test("ordinary Active resume does not grant first private acquisition; only a subsequent explicit Start can accept truthful unacquired data", async () => {
		const { h, key } = await unacquiredNativeFixture();
		h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "active", scopes: [...DEFAULT_SCOPE_SELECTION] } });
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.throws(() => h.readState(0, "session"), /unavailable|explicit private acquisition/);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal((await cohort(h)).lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(h.readState(0, "cwd").strategy.retained, "cwd");
	});

	test("explicit first private acquisition withdraws for newer Passive or Off without installing old Start state", async t => {
		for (const mode of ["passive", "off"] as const) {
			const { h, key } = await unacquiredNativeFixture();
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			let entered!: () => void, release!: () => void;
			const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			t.after(() => release());
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", async function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				assert.equal(args[0].kind, "unacquired"); entered(); await gate; return Reflect.apply(acquire, this, args);
			});
			const pending = h.commands.get("state-flow-active")!.handler("", h.ctx);
			try {
				await waiting; const newer = h.commands.get(`state-flow-${mode}`)!.handler("", h.ctx);
				release(); await Promise.all([pending, newer]);
			} finally { release(); spy.mock.restore(); }
			assert.equal(policy(h).mode, mode);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
		}
	});

	test("unacquired native activation refuses exact-base shared or lifecycle drift without overwriting a peer", async t => {
		for (const drift of ["semantic", "lifecycle", "header-loss"] as const) {
			const { h, source, key } = await unacquiredNativeFixture();
			let entered!: () => void, release!: () => void;
			const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			t.after(() => release());
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", async function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				entered(); await gate; return Reflect.apply(acquire, this, args);
			});
			const pending = h.commands.get("state-flow-active")!.handler("", h.ctx);
			try {
				await waiting;
				if (drift === "header-loss") {
					const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
					rmSync(life.config); rmSync(life.runtime);
				} else await source.withSelectedPatchTransaction(tx => {
					const next = structuredClone(tx.snapshot);
					if (drift === "lifecycle") next.meta.step = 5;
					tx.publish(next, drift === "semantic" ? { id: "foreign-shared-progress", transitions: [{ scope: "cwd", patch: { strategy: { peer: true } } }] } : undefined);
				}, () => {});
				const peer = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
				release(); await pending;
				assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), peer);
				assert.equal(policy(h).mode, "off");
				assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
			} finally { release(); spy.mock.restore(); }
		}
	});

	test("explicit Start cannot reinterpret deferred, lost acquired or malformed lifecycle as truthful unacquired authority", async () => {
		for (const refusal of ["deferred", "lost-acquired", "future", "pending-fork"] as const) {
			const { h, key } = await unacquiredNativeFixture();
			const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			const metadata = JSON.parse(readFileSync(life.runtime, "utf8"));
			if (refusal === "future") metadata.version = 999;
			else if (refusal === "pending-fork") h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: {
				version: 2, owner: h.ctx.sessionManager.getSessionId(), mode: "off", scopes: [...DEFAULT_SCOPE_SELECTION], forkPending: true } });
			else metadata.privateAcquisition = refusal === "deferred" ? "deferred" : "acquired";
			writeFileSync(life.runtime, JSON.stringify(metadata));
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			await h.commands.get("state-flow-active")!.handler("", h.ctx);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
			assert.equal(policy(h).mode, "off");
			assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 0);
		}
	});

	test("a live owner that has accepted private memory cannot escape its acquisition knowledge through a new activation candidate", async t => {
		for (const clearCache of [false, true]) {
			const { h, key } = await unacquiredNativeFixture();
			let owner!: TemporalRuntime;
			const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
				owner = this; return Reflect.apply(acquire, this, args);
			});
			try { await h.commands.get("state-flow-active")!.handler("", h.ctx); } finally { spy.mock.restore(); }
			assert.ok(owner);
			await h.tools.get("patch_state")!.execute("known-private", { session: { strategy: { privateAccepted: "must not reinitialize" } } }, undefined, undefined, h.ctx);
			await h.commands.get("state-flow-passive")!.handler("", h.ctx);
			const replacementRoot = join(h.repositoryRoot, "replacement-policy-fixture");
			const replacement = new TemporalRuntime(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), replacementRoot, key);
			await replacement.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("passive"), p => p(), undefined, true);
			const life = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
			const foreign = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), replacementRoot, key);
			writeFileSync(life.config, readFileSync(foreign.config)); writeFileSync(life.runtime, readFileSync(foreign.runtime));
			const shared = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "cwd", h.repositoryRoot, key);
			const foreignShared = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "cwd", replacementRoot, key);
			for (const name of ["checkpoint", "patches", "meta"] as const) writeFileSync(shared[name], readFileSync(foreignShared[name]));
			const privatePaths = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot, key);
			for (const name of ["checkpoint", "patches", "meta"] as const) rmSync(privatePaths[name]);
			if (clearCache) owner.view = undefined;
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), entries = structuredClone(h.entries);
			await h.commands.get("state-flow-active")!.handler("", h.ctx);
			assert.equal(policy(h).mode, "passive");
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), before);
			assert.deepEqual(h.entries, entries);
			assert.equal(existsSync(privatePaths.meta), false);
		}
	});

	test("accepted first private acquisition stays final after native checkpoint failure and later Start never reacquires", async t => {
		const { h, key } = await unacquiredNativeFixture();
		let calls = 0;
		const acquire = TemporalRuntime.prototype.withSelectedSessionAcquisitionTransaction;
		t.mock.method(TemporalRuntime.prototype, "withSelectedSessionAcquisitionTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof acquire>) {
			calls++; return Reflect.apply(acquire, this, args);
		});
		const push = h.entries.push;
		h.entries.push = ((...entries: any[]) => {
			if (entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE)) throw new Error("accepted acquisition checkpoint failed");
			return push.apply(h.entries, entries);
		}) as typeof h.entries.push;
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		h.entries.push = push;
		assert.equal((await cohort(h)).lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(h.readState(0, "cwd").strategy.retained, "cwd");
		assert.equal(calls, 1);
		const accepted = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key);
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		assert.equal(calls, 1);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot, key), accepted);
		assert.equal(h.readState(0, "cwd").strategy.retained, "cwd");
	});

	test("explicit new-session Active uses one atomic first-authoring port with its captured native policy", async t => {
		const h = harness({ initializeRepository: false, mode: "off" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const calls: unknown[] = [];
		const first = TemporalRuntime.prototype.withSelectedFirstPatchTransaction;
		const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedFirstPatchTransaction", function(this: TemporalRuntime, ...args: Parameters<typeof first>) {
			calls.push(structuredClone(args[0]));
			assert.deepEqual(args[0], policy(h).scopes);
			assert.equal(this.selectedView(), undefined);
			assert.equal(existsSync(sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot).runtime), false);
			return Reflect.apply(first, this, args);
		});
		try { await h.commands.get("state-flow-active")!.handler("", h.ctx); }
		finally { spy.mock.restore(); }
		assert.deepEqual(calls, [[...DEFAULT_SCOPE_SELECTION]]);
		const accepted = await cohort(h);
		assert.equal(accepted.lifecycle.runtime.meta.step, 0);
		assert.equal(accepted.view.lineage.length, 1, "explicit Start publishes origin/lifecycle, not a dummy semantic patch");
		assert.deepEqual(Object.fromEntries(Object.entries(accepted.view.scopes).map(([scope, stream]) => [scope, stream!.revision])), { global: 0, cwd: 0, session: 0 });
		assert.equal(h.entries.filter(entry => entry.customType === SNAPSHOT_ENTRY_TYPE).length, 1);
	});

	test("native selected run preserves exact accepted Session response, current memory across tree selection, and v2 mode policy", async () => {
		const h = harness({ initializeRepository: false });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		await start(h, "Do the scoped work");
		await commitScopedTerminal(h, [{ scope: "session", patch: { strategy: { stable: true } } }], "  Exact final answer\n\n");
		const accepted = await cohort(h);
		assert.equal(readTemporalView(accepted.view, 0, "session").response, "  Exact final answer\n\n");
		assert.equal(readTemporalView(accepted.view, 0, "global").response, undefined);
		assert.equal(readTemporalView(accepted.view, 0, "cwd").response, undefined);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		const passive = await cohort(h);
		assert.equal(passive.lifecycle.runtime.config.mode, "passive");
		assert.deepEqual(passive.view, accepted.view);
		assert.equal(policy(h).mode, "passive");
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.readState(0, "session").response, "  Exact final answer\n\n");
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		const beforeOff = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.equal(policy(h).mode, "off");
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), beforeOff);
		assert.equal(h.activeTools.includes("patch_state"), false);
	});

	test("native pre-runtime tree policy and failed native checkpoint cannot rewind or replace current private memory", async () => {
		const h = harness({ initializeRepository: false, mode: "passive" });
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		const early = [...h.entries];
		const push = h.entries.push;
		h.entries.push = ((...entries: any[]) => {
			if (entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE)) throw new Error("native checkpoint unavailable");
			return push.apply(h.entries, entries);
		}) as typeof h.entries.push;
		try {
			await assert.rejects(h.tools.get("patch_state")!.execute("accepted-before-native-error", { session: { tactics: { survives: true } } }, undefined, undefined, h.ctx), /native checkpoint/);
		} finally { h.entries.push = push; }
		assert.equal(h.readState(0, "session").tactics.survives, true, "ancillary error must retain accepted data");
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.equal(h.readState(0, "session").tactics.survives, true, "policy-only capture must restore canonical current memory");
		h.ctx.sessionManager.getBranch = () => early;
		await h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.readState(0, "session").tactics.survives, true, "pre-runtime Pi position is not a private-memory rewind");
		assert.equal((await cohort(h)).lifecycle.runtime.meta.step, 1);
	});

	test("native mode-only Passive refuses shared drift rather than adopting it, fences writes and recovers only through explicit current acceptance", async () => {
		const h = harness({ initializeRepository: false }); await start(h);
		const peer = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot, sessionId: "peer" }); await start(peer);
		await peer.tools.get("patch_state")!.execute("peer", { global: { tactics: { newer: true } } }, undefined, undefined, peer.ctx);
		const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
		assert.ok(policy(h).persistenceError);
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { tactics: { x: true } } }, undefined, undefined, h.ctx), /writes paused/);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before, "fenced restoration must stay read-only");
		assert.equal(h.readState(0, "global").tactics.newer, true);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		assert.equal(policy(h).persistenceError, undefined);
		await h.tools.get("patch_state")!.execute("recovered", { session: { tactics: { x: true } } }, undefined, undefined, h.ctx);
	});

	test("explicit Start clears stale run specification and validation without rewinding accepted semantic memory", async () => {
		const h = harness({ initializeRepository: false }); await start(h, "stale prior run");
		await h.tools.get("patch_state")!.execute("retained", { session: { tactics: { retained: true } } }, undefined, undefined, h.ctx);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		const paths = sessionRuntimePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
		const metadata = JSON.parse(readFileSync(paths.runtime, "utf8"));
		metadata.validation = { attempt: 1, error: "stale failure", instruction: "old repair" };
		writeFileSync(paths.runtime, JSON.stringify(metadata));
		const previous = await cohort(h);
		assert.equal(previous.lifecycle.runtime.meta.specification, "stale prior run");
		await h.commands.get("state-flow-active")!.handler("", h.ctx);
		const next = await cohort(h);
		assert.equal(next.lifecycle.runtime.meta.specification, undefined);
		assert.equal(next.lifecycle.runtime.meta.validation, undefined);
		assert.equal(next.lifecycle.runtime.meta.step, previous.lifecycle.runtime.meta.step);
		assert.deepEqual(next.view, previous.view);
		assert.equal(h.readState(0, "session").tactics.retained, true);
	});

	test("recognized Active policy stays inference-blocked on malformed admission, gated selection and failed capture", async () => {
		for (const fault of ["malformed", "subset", "capture"] as const) {
			const h = harness({ initializeRepository: false, ...(fault === "capture" ? { mode: "active" as const } : {}) });
			if (fault !== "capture") h.entries.push({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: {
				version: 2, mode: "active", scopes: fault === "subset" ? ["cwd"] : [...DEFAULT_SCOPE_SELECTION], boundary: "unread-head", step: fault === "malformed" ? -1 : 0,
			} });
			const push = h.entries.push;
			if (fault === "capture") h.entries.push = (() => { throw new Error("required capture append failed"); }) as typeof h.entries.push;
			const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
			try { await h.handlers.get("session_start")!({ reason: fault === "capture" ? "new" : "resume" }, h.ctx); }
			finally { h.entries.push = push; }
			assert.match(h.statuses.at(-1) ?? "", /active \(blocked\)/, fault);
			const operation = new AbortController();
			await h.inferenceContext([{ role: "user", content: [{ type: "text", text: "must not infer native fallback" }], timestamp: 1 }], operation);
			assert.equal(operation.signal.aborted, true, fault);
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
			await assert.rejects(h.tools.get("patch_state")!.execute("blocked", { session: { tactics: { no: true } } }, undefined, undefined, h.ctx), /unavailable|off/);
			await h.commands.get("state-flow-off")!.handler("", h.ctx);
			assert.equal(policy(h).mode, "off", "explicit Off must remain a memory-inert escape from failed admission");
			if (fault === "subset") assert.deepEqual(policy(h).scopes, ["cwd"], "Off retains a recognized gated scope choice");
			await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
			const offOperation = new AbortController(); await h.inferenceContext([], offOperation);
			assert.equal(offOperation.signal.aborted, false);
			if (fault === "subset") {
				await h.commands.get("state-flow-active")!.handler("", h.ctx);
				assert.equal(policy(h).mode, "off", "mode-only Start cannot widen a captured gated choice");
				assert.deepEqual(policy(h).scopes, ["cwd"]);
			}
			assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
		}
	});

	async function deferredNativeForkFixture() {
		const root = harness({ initializeRepository: false }).repositoryRoot;
		const timestamp = "2026-10-24T00:00:00.000Z", parentFile = join(root, "source-parent.jsonl"), childFile = join(root, "deferred-child.jsonl");
		const parent = harness({ initializeRepository: false, repositoryRoot: root, sessionId: "source-parent", sessionFile: parentFile, sessionTimestamp: timestamp, mode: "active" });
		writeFileSync(parentFile, JSON.stringify(parent.ctx.sessionManager.getHeader()) + "\n");
		await parent.handlers.get("session_start")!({ reason: "new" }, parent.ctx);
		await parent.tools.get("patch_state")!.execute("parent-current", { session: { strategy: { inherited: "actual current parent" } } }, undefined, undefined, parent.ctx);
		const childKey = resolveSessionAddress(childFile, "deferred-child", timestamp).key;
		const deferred = new TemporalRuntime(parent.ctx.cwd, "deferred-child", root, childKey);
		await deferred.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, publish => publish(), undefined, true);
		await deferred.withSelectedPatchTransaction(transaction => transaction.publish({ config: { mode: "active" }, meta: { step: 3, specification: "shared-only progress", bootstrap: true } },
			{ id: "child-before-private", transitions: [{ scope: "cwd", patch: { tactics: { childProgress: true } } }] }), () => {});
		const options = { initializeRepository: false, repositoryRoot: root, sessionId: "deferred-child", sessionFile: childFile, sessionTimestamp: timestamp, mode: "active" as const };
		const header = { ...parent.ctx.sessionManager.getHeader()!, id: "deferred-child", parentSession: parentFile };
		writeFileSync(childFile, JSON.stringify(header) + "\n");
		const child = harness(options); child.ctx.sessionManager.getHeader = () => header;
		child.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { version: 2, owner: "deferred-child", mode: "active", scopes: [...DEFAULT_SCOPE_SELECTION], forkPending: true } });
		const parentBefore = captureTemporalFileBases(parent.ctx.cwd, "source-parent", root, resolveSessionAddress(parentFile, "source-parent", timestamp).key);
		return { root, parent, child, childKey, parentBefore, parentFile, timestamp };
	}

	test("native pending fork acquires a canonically deferred child from parent-current memory without resetting shared run fields", async () => {
		const { root, parent, child, parentBefore, parentFile, timestamp } = await deferredNativeForkFixture();
		await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
		assert.equal(child.readState(0, "session").strategy.inherited, "actual current parent");
		assert.equal(child.readState(0, "cwd").tactics.childProgress, true);
		const accepted = await cohort(child);
		assert.equal(accepted.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(accepted.lifecycle.runtime.meta.step, 3);
		assert.equal(accepted.lifecycle.runtime.meta.specification, "shared-only progress");
		assert.equal(accepted.lifecycle.runtime.meta.bootstrap, true);
		assert.equal(policy(child).forkPending, false);
		assert.deepEqual(captureTemporalFileBases(parent.ctx.cwd, "source-parent", root, resolveSessionAddress(parentFile, "source-parent", timestamp).key), parentBefore);
	});

	test("deferred native copy keeps newer Passive independent and Off withdraws the original acquisition before publication", async t => {
		for (const mode of ["passive", "off"] as const) {
			const { root, child, childKey } = await deferredNativeForkFixture();
			const before = captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey);
			let entered!: () => void, release!: () => void;
			const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
			t.after(() => release());
			const copy = TemporalRuntime.prototype.withSelectedForkCopyTransaction;
			const spy = t.mock.method(TemporalRuntime.prototype, "withSelectedForkCopyTransaction", async function(this: TemporalRuntime, ...args: Parameters<typeof copy>) {
				assert.equal(args[0].kind, "fork-deferred"); entered(); await gate; return Reflect.apply(copy, this, args);
			});
			const pending = child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
			try {
				await waiting; await child.commands.get(`state-flow-${mode}`)!.handler("", child.ctx);
				release(); await pending;
			} finally { release(); spy.mock.restore(); }
			assert.equal(policy(child).mode, mode);
			if (mode === "off") {
				assert.deepEqual(captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey), before);
				assert.equal(policy(child).forkPending, true);
			} else {
				const accepted = await cohort(child);
				assert.equal(accepted.lifecycle.runtime.config.mode, "passive");
				assert.equal(accepted.lifecycle.runtime.meta.step, 3);
				assert.equal(accepted.lifecycle.runtime.meta.specification, "shared-only progress");
				assert.equal(policy(child).forkPending, false);
				assert.equal(child.readState(0, "session").strategy.inherited, "actual current parent");
			}
		}
	});

	test("accepted deferred copy survives native reset failure and cold resume cannot recopy from a missing parent", async () => {
		const { root, child, childKey, parentFile, timestamp } = await deferredNativeForkFixture();
		const push = child.entries.push;
		child.entries.push = ((...entries: any[]) => {
			if (entries.some(entry => entry.customType === "state-flow-passive-stop" && entry.data?.reset === true)) throw new Error("deferred child reset failed");
			return push.apply(child.entries, entries);
		}) as typeof child.entries.push;
		await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
		assert.equal(child.readState(0, "session").strategy.inherited, "actual current parent");
		assert.equal(policy(child).forkPending, true);
		const bytes = captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey);
		rmSync(parentFile);
		const childFile = child.ctx.sessionManager.getSessionFile()!;
		const resumed = harness({ initializeRepository: false, repositoryRoot: root, sessionId: "deferred-child", sessionFile: childFile, sessionTimestamp: timestamp, mode: "active" });
		resumed.ctx.sessionManager.getHeader = child.ctx.sessionManager.getHeader;
		resumed.entries.push(...child.entries);
		await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
		assert.equal(resumed.readState(0, "session").strategy.inherited, "actual current parent");
		assert.equal((await cohort(resumed)).lifecycle.runtime.meta.step, 3);
		assert.equal(policy(resumed).forkPending, false);
		assert.deepEqual(captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey), bytes);
	});

	test("native pending fork cannot treat an independent unacquired lifecycle as deferred-copy authority", async () => {
		const { root, child, childKey } = await deferredNativeForkFixture();
		const life = sessionRuntimePaths(child.ctx.cwd, "deferred-child", root, childKey);
		const metadata = JSON.parse(readFileSync(life.runtime, "utf8")); metadata.privateAcquisition = "unacquired";
		writeFileSync(life.runtime, JSON.stringify(metadata));
		const before = captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey);
		await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
		assert.throws(() => child.readState(0, "session"), /no deferred private-copy authority/);
		assert.deepEqual(captureTemporalFileBases(child.ctx.cwd, "deferred-child", root, childKey), before);
	});

	test("pending fork without a native boundary copies parent-current memory and retains an already accepted child without parent reads", async () => {
		for (const failChildReset of [false, true]) {
			const root = harness({ initializeRepository: false }).repositoryRoot;
			const parentFile = join(root, "parent-session.jsonl"), childFile = join(root, "child-session.jsonl");
			const timestamp = "2026-10-24T00:00:00.000Z";
			const parent = harness({ initializeRepository: false, repositoryRoot: root, sessionId: "parent", sessionFile: parentFile, sessionTimestamp: timestamp, mode: "active" });
			writeFileSync(parentFile, JSON.stringify(parent.ctx.sessionManager.getHeader()) + "\n");
			const pushParent = parent.entries.push;
			parent.entries.push = ((...entries: any[]) => {
				if (entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE)) throw new Error("parent native checkpoint failed");
				return pushParent.apply(parent.entries, entries);
			}) as typeof parent.entries.push;
			try {
				await parent.handlers.get("session_start")!({ reason: "new" }, parent.ctx);
				await assert.rejects(parent.tools.get("patch_state")!.execute("parent-accepted", { session: { tactics: { parentCurrent: "inherit-current" } } }, undefined, undefined, parent.ctx), /parent native checkpoint failed/);
			} finally { parent.entries.push = pushParent; }
			assert.equal(parent.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
			const parentKey = resolveSessionAddress(parentFile, "parent", timestamp).key;
			const parentBefore = captureTemporalFileBases(parent.ctx.cwd, "parent", root, parentKey);
			const options = { initializeRepository: false, repositoryRoot: root, sessionId: "child", sessionFile: childFile, sessionTimestamp: timestamp, mode: "active" as const };
			const header = { ...parent.ctx.sessionManager.getHeader()!, id: "child", parentSession: parentFile };
			writeFileSync(childFile, JSON.stringify(header) + "\n");
			let child = harness(options); child.ctx.sessionManager.getHeader = () => header;
			child.entries.push(...structuredClone([...parent.entries]));
			const pushChild = child.entries.push;
			if (failChildReset) child.entries.push = ((...entries: any[]) => {
				if (entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE || entry.data?.reset === true)) throw new Error("child native disposition failed");
				return pushChild.apply(child.entries, entries);
			}) as typeof child.entries.push;
			try { await child.handlers.get("session_start")!({ reason: "fork" }, child.ctx); }
			finally { child.entries.push = pushChild; }
			assert.equal(child.readState(0, "session").tactics.parentCurrent, "inherit-current");
			assert.deepEqual(captureTemporalFileBases(parent.ctx.cwd, "parent", root, parentKey), parentBefore);
			if (failChildReset) {
				await child.tools.get("patch_state")!.execute("child-current", { session: { tactics: { childCurrent: true } } }, undefined, undefined, child.ctx);
				const entries = structuredClone([...child.entries]).filter(entry => entry.customType !== SNAPSHOT_ENTRY_TYPE);
				rmSync(parentFile);
				child = harness(options); child.ctx.sessionManager.getHeader = () => header; child.entries.push(...entries);
				await child.handlers.get("session_start")!({ reason: "resume" }, child.ctx);
				assert.equal(child.readState(0, "session").tactics.childCurrent, true, "pending bookkeeping cannot recopy or require the parent after child acceptance");
			}
		}
	});

	test("required private loss never falls back to shared model context and excluded native selection never widens", async () => {
		const h = harness({ initializeRepository: false }); await start(h);
		const paths = temporalScopePaths(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), "session", h.repositoryRoot);
		writeFileSync(paths.checkpoint, "not-json");
		const before = readFileSync(paths.checkpoint, "utf8");
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.throws(() => h.readState(0, "session"), /unavailable/);
		await h.commands.get("state-flow-passive")!.handler("", h.ctx);
		const context = await h.handlers.get("context")!({ messages: [] }, h.ctx);
		assert.equal((JSON.stringify(context) ?? "").includes("passive memory"), false);
		assert.equal(readFileSync(paths.checkpoint, "utf8"), before);
		const subset = harness({ initializeRepository: false });
		subset.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: {
			version: 2, owner: subset.ctx.sessionManager.getSessionId(), mode: "passive", scopes: ["cwd"],
		} });
		await subset.handlers.get("session_start")!({ reason: "resume" }, subset.ctx);
		await assert.rejects(subset.tools.get("patch_state")!.execute("widen", { session: { tactics: { no: true } } }, undefined, undefined, subset.ctx), /State Flow session patch scope is excluded/);
		assert.equal(existsSync(join(subset.repositoryRoot, "global")), false);
		await assert.rejects(subset.commands.get("state-flow-active")!.handler("session session", subset.ctx), /State Flow scopes/);
	});

	function configuredPolicyHarness(scopes: ScopeSelection, mode: "off" | "active" | "passive" = "off") {
		const root = harness({ initializeRepository: false }).repositoryRoot;
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify({ mode, scopes: [...scopes].reverse() }));
		const options = { repositoryRoot: root, cwd: join(root, "project"), sessionId: "configured-owner", mode: "configured" as const, initializeRepository: false };
		return { h: harness(options), options, path };
	}

	const configuredSelections = Array.from({ length: 7 }, (_, index) => captureScopeSelection(
		DEFAULT_SCOPE_SELECTION.filter((_scope, bit) => ((index + 1) & (1 << bit)) !== 0),
	));

	for (const scopes of configuredSelections) test(`native Off captures configured ${scopes.join("+")} once across reload, mode-only Off and later global defaults`, async () => {
		const { h, options, path } = configuredPolicyHarness(scopes);
		const bytes = readFileSync(path, "utf8");
		const files = () => captureTemporalFileBases(options.cwd, options.sessionId, options.repositoryRoot);
		const before = files();
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.deepEqual(h.entries.map(({ data }) => data), [{ version: 2, owner: options.sessionId, mode: "off", scopes }]);
		assert.equal(h.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
		assert.equal(readFileSync(path, "utf8"), bytes);
		const captured = structuredClone(h.entries);
		await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
		await h.commands.get("state-flow-off")!.handler("", h.ctx);
		assert.deepEqual(h.entries, captured);
		const laterScopes = scopes.length === 3 ? captureScopeSelection(["cwd"]) : DEFAULT_SCOPE_SELECTION;
		writeFileSync(path, JSON.stringify({ mode: "off", scopes: laterScopes }));
		const resumed = harness(options); resumed.entries.push(...structuredClone(captured));
		await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
		await resumed.commands.get("state-flow-off")!.handler("", resumed.ctx);
		assert.deepEqual(resumed.entries, captured, "later configured scopes cannot replace an established native branch choice");
		assert.deepEqual(policy(resumed).scopes, scopes);
		assert.deepEqual(files(), before, "capture/resume/Off have no canonical memory publication");
		const independent = harness({ ...options, sessionId: "new-loaded-default" });
		await independent.handlers.get("session_start")!({ reason: "new" }, independent.ctx);
		assert.deepEqual(policy(independent).scopes, laterScopes, "a fresh registration samples the later default for a new owner");
		h.entries.splice(0); h.ctx.sessionManager.getSessionId = () => "new-before-reload";
		await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		assert.deepEqual(policy(h).scopes, scopes, "an existing registration retains its load-time defaults even for a new owner");
		assert.deepEqual(files(), before);
	});

	for (const scopes of configuredSelections) test(`legacy Off samples configured ${scopes.join("+")} at first upgraded attachment without converting storage`, async () => {
		const { h, options, path } = configuredPolicyHarness(scopes);
		h.entries.push({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: { mode: "off" } });
		const before = captureTemporalFileBases(options.cwd, options.sessionId, options.repositoryRoot);
		await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		assert.deepEqual(h.entries.at(-1).data, { version: 2, owner: options.sessionId, mode: "off", scopes });
		const captured = structuredClone(h.entries);
		writeFileSync(path, JSON.stringify({ mode: "active", scopes: scopes.length === 3 ? ["cwd"] : DEFAULT_SCOPE_SELECTION }));
		const resumed = harness(options); resumed.entries.push(...structuredClone(captured));
		await resumed.handlers.get("session_start")!({ reason: "reload" }, resumed.ctx);
		assert.deepEqual(resumed.entries, captured);
		assert.deepEqual(policy(resumed).scopes, scopes);
		assert.equal(policy(resumed).mode, "off");
		assert.deepEqual(captureTemporalFileBases(options.cwd, options.sessionId, options.repositoryRoot), before);
	});

	for (const scopes of configuredSelections.filter(selection => selection.length < 3)) for (const mode of ["active", "passive"] as const)
		test(`configured ${mode} ${scopes.join("+")} accepts selected memory without resampling a wider default`, async () => {
			const { h, options, path } = configuredPolicyHarness(scopes, mode);
			const files = () => captureTemporalFileBases(options.cwd, options.sessionId, options.repositoryRoot);
			const excluded = DEFAULT_SCOPE_SELECTION.filter(scope => !scopes.includes(scope));
			const excludedPaths = new Set(excluded.flatMap(scope => {
				const p = temporalScopePaths(options.cwd, options.sessionId, scope, options.repositoryRoot);
				return [p.checkpoint, p.patches, p.meta];
			}));
			const excludedBefore = files().filter(file => excludedPaths.has(file.path));
			await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
			assert.deepEqual(h.entries[0].data, { version: 2, owner: options.sessionId, mode, scopes }, "native policy is captured before memory acceptance");
			assert.deepEqual(policy(h).scopes, scopes);
			if (mode === "passive") {
				assert.equal(h.entries.some(entry => entry.customType === SNAPSHOT_ENTRY_TYPE), false);
				assert.throws(() => h.readState(), /unavailable/);
			} else for (const scope of scopes) assert.deepEqual(h.readState(0, scope).tactics, {});
			const target = scopes[0];
			await h.tools.get("patch_state")!.execute("selected-first", modelPatchArguments(scopes, { [target]: { tactics: { capturedOwner: target, retained: "before-default" } } }), undefined, undefined, h.ctx);
			assert.equal(h.readState(0, target).tactics.capturedOwner, target);
			const beforeRefusal = files();
			await assert.rejects(h.tools.get("patch_state")!.execute("no-widening", {
				[target]: { tactics: { retained: "must-not-commit" } }, [excluded[0]]: { tactics: { mustNotWrite: true } },
			}, undefined, undefined, h.ctx), new RegExp(`State Flow ${excluded[0]} patch scope is excluded`));
			assert.deepEqual(files(), beforeRefusal, "excluded owner rejects the whole supplied cohort");
			if (mode === "active") {
				h.beforeAgentStart("Use captured owners");
				const controller = new AbortController(); await h.inferenceContext([], controller);
				assert.equal(controller.signal.aborted, false, "accepted selected Active memory can prepare inference");
			}
			const captured = structuredClone(h.entries);
			writeFileSync(path, JSON.stringify({ mode: "off", scopes: DEFAULT_SCOPE_SELECTION }));
			const resumed = harness(options); resumed.entries.push(...captured);
			await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
			assert.deepEqual(policy(resumed).scopes, scopes);
			assert.equal(policy(resumed).mode, mode);
			assert.equal(resumed.readState(0, target).tactics.retained, "before-default");
			const beforeOff = files();
			await resumed.commands.get("state-flow-off")!.handler("", resumed.ctx);
			assert.deepEqual(files(), beforeOff, "Off changes native policy only");
			assert.equal(policy(resumed).mode, "off"); assert.deepEqual(policy(resumed).scopes, scopes);
			await resumed.commands.get("state-flow-active")!.handler("", resumed.ctx);
			assert.equal(policy(resumed).mode, "active"); assert.deepEqual(policy(resumed).scopes, scopes);
			assert.equal(resumed.readState(0, target).tactics.retained, "before-default");
			for (const scope of excluded) assert.throws(() => resumed.readState(0, scope), /scope.*excluded/);
			assert.deepEqual(files().filter(file => excludedPaths.has(file.path)), excludedBefore, "captured subsets never initialize excluded owners");
		});

	for (const scopes of configuredSelections) test(`Off fork inherits ${scopes.join("+")} rather than later configured defaults and stays parent-read-free`, async () => {
		const { h: parent, options, path } = configuredPolicyHarness(scopes);
		await parent.handlers.get("session_start")!({ reason: "new" }, parent.ctx);
		const inherited = structuredClone(parent.entries);
		writeFileSync(path, JSON.stringify({ mode: "off", scopes: scopes.length === 3 ? ["cwd"] : DEFAULT_SCOPE_SELECTION }));
		const childOptions = { ...options, sessionId: "policy-child", sessionTimestamp: "2026-10-24T00:00:00.000Z" };
		const parentFile = join(options.repositoryRoot, "absent-parent-header.jsonl");
		const childHeader = { type: "session", version: 3, id: childOptions.sessionId, timestamp: childOptions.sessionTimestamp, cwd: options.cwd, parentSession: parentFile };
		const child = harness(childOptions); child.ctx.sessionManager.getHeader = () => childHeader;
		child.entries.push(...structuredClone(inherited));
		const key = resolveSessionAddress(undefined, childOptions.sessionId, childOptions.sessionTimestamp).key;
		const before = captureTemporalFileBases(options.cwd, childOptions.sessionId, options.repositoryRoot, key);
		const read = fs.readFileSync; let parentReads = 0;
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
			if (String(args[0]) === parentFile) { parentReads++; throw new Error("Off must not inspect the parent header"); }
			return Reflect.apply(read, fs, args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			await child.handlers.get("session_start")!({ reason: "fork" }, child.ctx);
			assert.deepEqual(child.entries.at(-1).data, { version: 2, owner: childOptions.sessionId, mode: "off", scopes, forkPending: true });
			assert.notEqual(child.entries.at(-1).data.scopes, parent.entries.at(-1).data.scopes);
			const chosen = structuredClone(child.entries);
			const resumed = harness(childOptions); resumed.ctx.sessionManager.getHeader = () => childHeader;
			resumed.entries.push(...structuredClone(chosen));
			await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
			await resumed.commands.get("state-flow-off")!.handler("", resumed.ctx);
			assert.deepEqual(resumed.entries, chosen);
			assert.deepEqual(policy(resumed).scopes, scopes); assert.equal(policy(resumed).forkPending, true);
		} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
		assert.equal(parentReads, 0);
		assert.deepEqual(parent.entries, inherited, "child policy capture does not mutate parent evidence");
		assert.deepEqual(captureTemporalFileBases(options.cwd, childOptions.sessionId, options.repositoryRoot, key), before);
	});
}
