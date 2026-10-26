import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as currentFixture from "./current-fixture.ts";
import * as legacyPublicationFixture from "./legacy-publication-fixture.ts";
import * as currentAuthorFixture from "./current-author-fixture.ts";
import * as originFixture from "./origin-fixture.ts";
import * as lifecycleFixture from "./lifecycle-fixture.ts";
import * as sessionAcquisitionFixture from "./session-acquisition-fixture.ts";
import * as deferredForkFixture from "./deferred-fork-fixture.ts";
import * as readObservationFixture from "./read-observation-fixture.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { withStorageTransaction, loadSelectedFileCohort, assertSelectedFileCohortBasis, type SelectedFilePublication, type SelectedFileCohort, type SelectedForkCopyRequest, type SelectedSessionAcquisitionRequest, type StorageTransaction } from "../lib/storage.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { readNativeSessionHeader } from "../lib/continuation.ts";
import { TemporalRuntime, SharedScopeRemovalConflictError, type ForkLifecycle, type SelectedRuntimePatchTransaction } from "../lib/runtime.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths, type SessionAddress } from "../lib/durable.ts";
import { writeGlobalState } from "./storage-fixture.ts";
import { emptySnapshot, prepareRetainedPolicyMigration, type RetainedBoundaryCheckpoint, type Snapshot, type StateFlowMode } from "../lib/snapshot.ts";
import { emptyState, type AtomicScopePatches, type StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import type { SuccessfulArtifactRead } from "../lib/acquisition.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { advanceTemporalState, constrainTemporalState, createTemporalState, readTemporalState, readTemporalView, temporalScopeRevisions, validateTemporalState } from "../lib/temporal.ts";
import { commitScopedTransition, stageAtomicScopePatches, commitSelectedTransition, stageSelectedScopePatches, stageSelectedScopedTransition, type StagedSelectedTransition } from "../lib/transition.ts";
import { commitScopedTerminal, harness, start } from "./harness.ts";
import { loadScopeProvenance, nativePolicyMarker } from "./temporal-fixture.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "../lib/selection.ts";

async function patchCurrent(runtime: TemporalRuntime, snapshot: Snapshot, patches: AtomicScopePatches, signal?: AbortSignal) {
	return runtime.withPatchTransaction((tx) => {
		const stage = stageAtomicScopePatches(tx.states, patches, [], tx.causalBasis);
		let changed = false;
		commitScopedTransition(snapshot, tx.states, stage, (accepted, next) => {
			changed = tx.publish(next, accepted, stage.provenanceUpdates).changed;
		}, tx.causalBasis, { finalizeRun: false });
		return changed;
	}, signal);
}

function forkAwaited(runtime: TemporalRuntime, source: { id: string; key: string }, checkpoint: RetainedBoundaryCheckpoint, signal?: AbortSignal) {
	return runtime.withForkTransaction(source, checkpoint, (snapshot, publish) => ({ snapshot, publication: publish(snapshot) }), signal);
}

/** Accept the current same-session memory, as branch attachment does. */
function attachCurrent(runtime: TemporalRuntime, signal?: AbortSignal) {
	return runtime.withStartTransaction((current, publish) => {
		assert.ok(current);
		publish(current);
		return current;
	}, signal);
}

test("captured asynchronous module targets reject shared drift before authoring while ordinary current patches still rebase", async t => {
	const f = await currentFixture.fixture(t, ["cwd", "session"]), runtime = new TemporalRuntime(f.cwd, f.id, f.root);
	await f.refresh(["cwd", "session"], 7, runtime);
	await f.drift(); let entered = false;
	const before = captureTemporalFileBases(f.cwd, f.id, f.root);
	await assert.rejects(runtime.withSelectedPatchTransaction(tx => { entered = true; tx.publish(tx.snapshot); }, () => {}, undefined, ["cwd"]), /advanced|live/);
	assert.equal(entered, false); assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), before);
	await runtime.withSelectedPatchTransaction(tx => { assert.equal(tx.states.cwd!.strategy!.marker, "live"); tx.publish(tx.snapshot); }, () => {});
});

test("module context read leases detect cache replacement without acquiring or publishing memory", async t => {
	const root = mkdtempSync(join(tmpdir(), "module-context-read-lease-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(join(root, "cwd"), "owner", root);
	assert.throws(() => runtime.captureSelectedReadBasis(), /unavailable/);
	await runtime.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), publish => publish(), undefined, true);
	const check = runtime.captureSelectedReadBasis(), before = (await loadSelectedFileCohort(runtime.cwd, runtime.sessionId, ["cwd"], root))!;
	check(); assert.deepEqual(await loadSelectedFileCohort(runtime.cwd, runtime.sessionId, ["cwd"], root), before);
	await runtime.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot, { id: "after-context-read", transitions: [{ scope: "cwd", patch: { tactics: { changed: true } } }] }), () => {});
	assert.throws(check, /content basis changed/);
});

test("sparse disk scopes survive passive reads, Start, patches and empty-response acceptance without implicit defaults", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-sparse-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const owner = "sparse-session";
	new TemporalRuntime(cwd, owner, root).initialize(emptySnapshot(), true);
	const sparse = {
		global: { strategy: { shared: true }, response: "retained lower answer", lazy: { shared: "cold" }, extra: { retained: true } },
		cwd: { tactics: { project: true } },
		session: {},
	};
	for (const scope of ["global", "cwd", "session"] as const) {
		writeFileSync(temporalScopePaths(cwd, owner, scope, root).checkpoint, ` ${JSON.stringify(sparse[scope])}\n`);
	}
	const files = () => captureTemporalFileBases(cwd, owner, root);
	const before = files();
	const passive = new TemporalRuntime(cwd, owner, root);
	assert.equal(passive.loadPassive(), true);
	const loaded = new TemporalRuntime(cwd, owner, root);
	assert.ok(await loaded.refreshCurrentMemory());
	assert.equal(loaded.view!.scopes.global.checkpoint.state.extra, undefined);
	assert.equal(loaded.read().response, "retained lower answer");
	assert.deepEqual(loaded.read(0, "session"), emptyState());
	assert.deepEqual(files(), before, "reading fallbacks must not rewrite canonical bytes");
	const h = harness({ cwd, repositoryRoot: root, sessionId: owner, mode: "passive" });
	t.after(() => h.handlers.get("session_shutdown")!({}, h.ctx));
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await start(h, "Use sparse memory");
	assert.equal(h.readState().response, "retained lower answer");
	assert.equal(h.readState().extra, undefined);
	assert.deepEqual(h.readState().tactics, { project: true });
	assert.deepEqual(files().filter(({ path }) => /\/(checkpoint\.json|patches\.jsonl)$/.test(path)),
		before.filter(({ path }) => /\/(checkpoint\.json|patches\.jsonl)$/.test(path)), "Start must not fill semantic planes");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /retained lower answer/);
	const patch = { session: { tactics: { accepted: true } } };
	await h.tools.get("patch_state")!.execute("sparse-patch", patch, undefined, undefined, h.ctx);
	assert.equal(h.readState().response, "retained lower answer", "an unrelated patch must not introduce an empty response override");
	const accepted = files();
	await h.tools.get("patch_state")!.execute("sparse-repeat", patch, undefined, undefined, h.ctx);
	assert.deepEqual(files(), accepted, "a repeated sparse patch must not create a revision");
	await commitScopedTerminal(h, [], "");
	assert.equal(h.readState().response, "retained lower answer", "empty and absent response have identical overlay meaning");
	const restored = new TemporalRuntime(cwd, owner, root);
	const observing = files();
	await restored.refreshSelectedCurrent(DEFAULT_SCOPE_SELECTION, () => {});
	const observed = restored.observedSelectedView()!;
	assert.ok(observed.scopes.session); assert.ok(observed.scopes.global);
	assert.equal(restored.selectedView(), undefined, "inspection cannot grant accepted publication authority");
	assert.deepEqual(files(), observing, "selected inspection cannot rewrite sparse source bytes");
	assert.equal(restored.read().response, "retained lower answer");
	assert.deepEqual(restored.readView(0, "session"), { tactics: { accepted: true } });
	assert.equal(restored.read(1).response, "retained lower answer");
	assert.deepEqual(observed.scopes.session.checkpoint.state, {});
	assert.deepEqual(observed.scopes.session.patches.map(({ patch }) => patch), [{ tactics: { accepted: true } }]);
	assert.equal(observed.scopes.global.checkpoint.state.extra, undefined);
	assert.deepEqual(temporalScopeRevisions(observed), { global: 0, cwd: 0, session: 1 });
	await h.tools.get("patch_state")!.execute("owned-global-write", { global: { tactics: { accepted: true } } }, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(readFileSync(temporalScopePaths(cwd, owner, "global", root).checkpoint, "utf8")).extra, undefined);
	await restored.refreshSelectedCurrent(DEFAULT_SCOPE_SELECTION, () => {});
	assert.deepEqual(temporalScopeRevisions(restored.observedSelectedView()!), { global: 1, cwd: 0, session: 1 });
	assert.equal(h.notifications.some((message) => /failed|unavailable/i.test(message)), false);
});

test("authored patches use the current shared head, preserve private state and accept exact repeats without history", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-head-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "a", root);
	const b = new TemporalRuntime(cwd, "b", root);
	const sa = emptySnapshot();
	const sb = emptySnapshot();
	await patchCurrent(a, sa, { global: { tactics: { choice: "original", gone: "old" } }, session: { tactics: { private: "a" } } });
	await patchCurrent(b, sb, { global: { tactics: { choice: "foreign", gone: "new", unrelated: "keep" } }, cwd: { lazy: { list: [1, 2], foreign: true } }, session: { tactics: { private: "b" } } });
	const peerFiles = captureTemporalFileBases(cwd, "b", root).filter(({ path }) => path.startsWith(temporalScopePaths(cwd, "b", "session", root).directory + "/"));
	const authored: AtomicScopePatches = { global: { tactics: { choice: "original", gone: null } }, cwd: { lazy: { list: [3] } }, session: { tactics: { accepted: true } } };
	await patchCurrent(a, sa, authored);
	assert.deepEqual(a.read(0, "global").tactics, { choice: "original", unrelated: "keep" }, "an authored value equal to a stale cache still overwrites the current assignment");
	assert.deepEqual(a.read(0, "cwd").lazy, { list: [3], foreign: true });
	assert.deepEqual(a.read(0, "session").tactics, { private: "a", accepted: true });
	assert.deepEqual(a.read(1, "global").tactics, { choice: "foreign", gone: "new", unrelated: "keep" }, "history uses the actual accepted basis");
	assert.deepEqual(temporalScopeRevisions(a.view!), { global: 3, cwd: 2, session: 2 });
	assert.deepEqual(captureTemporalFileBases(cwd, "b", root).filter(({ path }) => path.startsWith(temporalScopePaths(cwd, "b", "session", root).directory + "/")), peerFiles);
	const before = captureTemporalFileBases(cwd, "a", root);
	const view = structuredClone(a.view);
	const snapshot = structuredClone(sa);
	assert.equal(await patchCurrent(a, sa, authored), false);
	assert.deepEqual(sa, snapshot);
	assert.deepEqual(a.view, view);
	assert.deepEqual(captureTemporalFileBases(cwd, "a", root), before);
});

test("current-head patch preparation never publishes empty initialization or installs rejected drafts", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-reject-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot();
	const files = () => captureTemporalFileBases(cwd, "owner", root);
	const empty = files();
	await assert.rejects(patchCurrent(runtime, snapshot, { global: { tactics: { tentative: true } }, session: { artifacts: { invalid: { kind: "document" } } } }), /non-empty description/);
	assert.deepEqual(files(), empty);
	assert.equal(runtime.view, undefined);
	assert.deepEqual(snapshot, emptySnapshot());
	await patchCurrent(runtime, snapshot, { session: { tactics: { retained: true } } });
	const peer = new TemporalRuntime(cwd, "peer", root);
	await patchCurrent(peer, emptySnapshot(), { global: { tactics: { foreign: true } } });
	const canonical = files();
	const cached = runtime.states();
	const before = structuredClone(snapshot);
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === sessionRuntimePaths(cwd, "owner", root).runtime) { failed = true; throw new Error("injected patch publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	const patches = { global: { tactics: { local: true } }, session: { tactics: { published: true } } };
	try { await assert.rejects(patchCurrent(runtime, snapshot, patches), /injected patch publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(files(), canonical);
	assert.deepEqual(runtime.states(), cached, "uncommitted shared adoption must not be installed either");
	assert.deepEqual(snapshot, before);
	await patchCurrent(runtime, snapshot, patches);
	assert.deepEqual(runtime.read(0, "global").tactics, { foreign: true, local: true });
	assert.deepEqual(runtime.read(0, "session").tactics, { retained: true, published: true });
});

test("patch transactions cancel live waiting without changing memory and retain exact private ownership fences", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-fence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot();
	await patchCurrent(runtime, snapshot, { session: { tactics: { retained: true } } });
	const files = () => captureTemporalFileBases(cwd, "owner", root);
	const before = files();
	const state = runtime.states();
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const holder = withStorageTransaction(root, async () => { enter(); await gate; });
	await entered;
	const controller = new AbortController();
	const pending = patchCurrent(runtime, snapshot, { global: { tactics: { cancelled: true } } }, controller.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await delay(50);
	controller.abort();
	await rejected;
	assert.deepEqual(files(), before);
	assert.deepEqual(runtime.states(), state);
	assert.equal(readFileSync(join(root, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	release();
	await holder;
	const unselected = new TemporalRuntime(cwd, "owner", root);
	assert.equal(unselected.loadPassive(), true);
	await assert.rejects(patchCurrent(unselected, emptySnapshot(), { global: { tactics: { unsafe: true } } }), /memory is not selected/);
	const selected = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in selected);
	const competing = new TemporalRuntime(cwd, "owner", root);
	const other = await attachCurrent(competing);
	await patchCurrent(competing, other, { session: { tactics: { peer: true } } });
	const winner = files();
	await assert.rejects(patchCurrent(runtime, snapshot, { global: { tactics: { unsafe: true } }, session: { tactics: { stale: true } } }), /base or scope identity changed concurrently/);
	assert.deepEqual(files(), winner);
	assert.deepEqual(runtime.states(), state);
});

test("current-head artifact replacement publishes matching evidence, accepts duplicate compilation and preserves untouched evidence", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-compile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "a", root);
	const b = new TemporalRuntime(cwd, "b", root);
	const sa = emptySnapshot();
	const sb = emptySnapshot();
	await patchCurrent(a, sa, { session: { tactics: { owner: "a" } } });
	const compile = (runtime: TemporalRuntime, snapshot: Snapshot, path: string, size: number, metadata: JsonObject) => runtime.withPatchTransaction((tx) => {
		const stage = stageAtomicScopePatches(tx.states, { global: { artifacts: { [path]: metadata } } }, [], tx.causalBasis,
			[{ path, scope: "global", reason: "source-changed", sourceFingerprint: { size, mtimeNs: "10" } }]);
		commitScopedTransition(snapshot, tx.states, stage, (accepted, next) => tx.publish(next, accepted, stage.provenanceUpdates), tx.causalBasis, { finalizeRun: false });
	});
	await compile(b, sb, "/other", 1, { description: "Keep" });
	await compile(b, sb, "/compiled", 2, { description: "Old", obsolete: true });
	await compile(a, sa, "/compiled", 3, { description: "Replacement" });
	assert.deepEqual(a.read(0, "global").artifacts, { "/other": { description: "Keep" }, "/compiled": { description: "Replacement" } });
	assert.deepEqual(a.artifactProvenance("global")["/compiled"]!.sourceFingerprint, { size: 3, mtimeNs: "10" });
	assert.deepEqual(a.artifactProvenance("global")["/other"], b.artifactProvenance("global")["/other"]);
	assert.deepEqual(a.read(1, "global").artifacts["/compiled"], { description: "Old", obsolete: true });
	const before = captureTemporalFileBases(cwd, "a", root);
	const view = structuredClone(a.view);
	await compile(a, sa, "/compiled", 3, { description: "Replacement" });
	assert.deepEqual(a.view, view);
	assert.deepEqual(captureTemporalFileBases(cwd, "a", root), before);
	removeSharedPair(root, cwd, "global");
	const fresh = new TemporalRuntime(cwd, "fresh", root);
	await patchCurrent(fresh, emptySnapshot(), { global: { artifacts: { "/compiled": { description: "Unproven registration" } } } });
	assert.deepEqual(fresh.artifactProvenance("global"), {}, "leftover metadata cannot revive compilation evidence without its semantic pair");
	assert.equal(fresh.read(0, "global").artifacts["/other"], undefined);
});

test("current-head patches use wholly absent shared scopes as empty but reject partial or malformed evidence", async (t) => {
	for (const scope of ["global", "cwd"] as const) for (const fault of ["absent", "partial", "malformed"]) {
		const root = mkdtempSync(join(tmpdir(), "state-flow-patch-presence-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const runtime = new TemporalRuntime(cwd, "owner", root);
		const snapshot = emptySnapshot();
		await patchCurrent(runtime, snapshot, { [scope]: { tactics: { old: true } }, session: { tactics: { private: true } } });
		const paths = temporalScopePaths(cwd, "owner", scope, root);
		if (fault === "malformed") writeFileSync(paths.checkpoint, "malformed");
		else { rmSync(paths.checkpoint); if (fault === "absent") rmSync(paths.patches); }
		const before = captureTemporalFileBases(cwd, "owner", root);
		const state = runtime.states();
		const patches = { [scope]: { tactics: { fresh: true } }, session: { tactics: { accepted: true } } };
		if (fault === "absent") {
			await patchCurrent(runtime, snapshot, patches);
			assert.deepEqual(runtime.read(0, scope).tactics, { fresh: true });
			assert.deepEqual(runtime.read(0, "session").tactics, { private: true, accepted: true });
		} else {
			await assert.rejects(patchCurrent(runtime, snapshot, patches), /[Ii]ncomplete|invalid JSON/);
			assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), before);
			assert.deepEqual(runtime.states(), state);
		}
	}
});

test("runtime keeps native session storage identity paired and detached from caller mutation", () => {
	const address = { id: "session-id", key: "timestamp_session-id" };
	const runtime = new TemporalRuntime("/project", address, "/store");
	address.id = "mutated";
	address.key = "mutated";
	assert.equal(runtime.sessionId, "session-id");
	assert.equal(runtime.sessionKey, "timestamp_session-id");
});

test("awaited current-head Start preserves semantics, provenance, revisions and history regardless of old mode or unfinished work", async (t) => {
	for (const mode of ["off", "passive", "active"] as const) for (const unfinished of [false, true]) {
		const root = mkdtempSync(join(tmpdir(), "state-flow-current-start-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const runtime = new TemporalRuntime(cwd, "session", root);
		const snapshot = emptySnapshot(mode);
		if (unfinished) snapshot.meta.specification = "Interrupted old request";
		runtime.initialize(snapshot, true);
		const before = runtime.states();
		const next = structuredClone(before);
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		for (const scope of ["global", "cwd", "session"] as const) {
			next[scope].tactics.owner = scope;
			next[scope].artifacts["/retained.txt"] = { description: "Retained compilation" };
		}
		snapshot.meta.step++;
		runtime.publish(snapshot, true, createAcceptedTransition(before, next), { provenance: {
			global: { "/retained.txt": evidence }, cwd: { "/retained.txt": evidence }, session: { "/retained.txt": evidence },
		} });
		publishScopedPatch(runtime, snapshot, "session", { latest: true }, "latest");
		const files = () => captureTemporalFileBases(cwd, "session", root).filter(({ path }) => !/\/(?:config|runtime)\.json$/.test(path));
		const semanticFiles = files();
		const cohort = captureTemporalFileBases(cwd, "session", root);
		const reader = new TemporalRuntime(cwd, "session", root);
		assert.notEqual((await reader.refreshCurrentMemory())!.config.mode, "active");
		assert.deepEqual(reader.states(), runtime.states());
		assert.deepEqual(captureTemporalFileBases(cwd, "session", root), cohort, "current-memory inspection never publishes policy or a new origin");
		const active = new TemporalRuntime(cwd, "session", root);
		const accept = (current: Snapshot, publish: (value: Snapshot) => unknown) => {
			assert.equal(current.meta.specification, undefined, "old unfinished prompts are not new-run authority");
			publish({ ...current, config: { mode: "active" as const } });
			assert.throws(() => publish(current), /already consumed/);
			return current;
		};
		const current = await active.withStartTransaction((current, publish) => accept(current!, publish));
		assert.deepEqual(active.states(), runtime.states());
		assert.deepEqual(active.read(1), runtime.read(1));
		assert.deepEqual(active.view!.lineage, runtime.view!.lineage, "a policy change does not reset available history");
		assert.deepEqual(temporalScopeRevisions(active.view!), temporalScopeRevisions(runtime.view!));
		assert.equal(current.meta.step, snapshot.meta.step);
		for (const scope of ["global", "cwd", "session"] as const) assert.deepEqual(active.artifactProvenance(scope), runtime.artifactProvenance(scope));
		assert.deepEqual(files(), semanticFiles);
	}
});

test("current-head Start adopts validated foreign shared streams without losing private state", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-current-shared-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const first = new TemporalRuntime(cwd, "first", root);
	const stopped = emptySnapshot();
	first.initialize(stopped, true);
	publishScopedPatch(first, stopped, "session", { private: "retained" }, "first-private");
	const second = new TemporalRuntime(cwd, "second", root);
	const other = emptySnapshot("active");
	second.initialize(other, true);
	publishScopedPatch(second, other, "global", { shared: "new" }, "second-shared");
	publishScopedPatch(second, other, "session", { owner: "second" }, "second-private");
	const current = new TemporalRuntime(cwd, "first", root);
	const selected = await current.withStartTransaction((snapshot, publish) => {
		publish({ ...snapshot!, config: { mode: "active" as const } });
		return snapshot!;
	});
	assert.equal(current.read().tactics.private, "retained");
	assert.equal(current.read().tactics.shared, "new");
	assert.equal(current.read(0, "session").tactics.owner, undefined);
	assert.throws(() => current.read(1), /predates the proven temporal origin/, "shared adoption does not invent a cross-writer past");
	assert.equal(selected.meta.step, stopped.meta.step);
});

test("current-head Start distinguishes a new owner from incomplete private storage without writing", async (t) => {
	for (const missing of ["config", "runtime", "checkpoint", "patches", "meta"] as const) {
		const root = mkdtempSync(join(tmpdir(), "state-flow-current-incomplete-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const runtime = new TemporalRuntime(cwd, "session", root);
		await assert.rejects(runtime.withStartTransaction(() => assert.fail("missing origin was admitted")), /Current State Flow session memory is unavailable/);
		runtime.initialize(emptySnapshot(), true);
		await assert.rejects(new TemporalRuntime(cwd, "other", root).withStartTransaction(() => assert.fail("new private owner was admitted")), /Current State Flow session memory is unavailable/);
		const scope = temporalScopePaths(cwd, "session", "session", root);
		const policy = sessionRuntimePaths(cwd, "session", root);
		rmSync(missing === "config" || missing === "runtime" ? policy[missing] : scope[missing]);
		const files = captureTemporalFileBases(cwd, "session", root);
		const activation = new TemporalRuntime(cwd, "session", root);
		await assert.rejects(activation.withStartTransaction(() => assert.fail("partial authority reached Start")), /Incomplete|incomplete|Unsupported/);
		assert.equal(activation.view, undefined);
		assert.deepEqual(captureTemporalFileBases(cwd, "session", root), files);
	}
});

test("awaited current-head activation refuses a noncooperating private replacement without overwriting its bytes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-passive-start-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const first = new TemporalRuntime(cwd, "passive-session", root);
	const stopped = emptySnapshot();
	first.initialize(stopped, true);
	publishScopedPatch(first, stopped, "session", { before: "retained" }, "passive-initial");
	const activation = new TemporalRuntime(cwd, "passive-session", root);
	let files: ReturnType<typeof captureTemporalFileBases> = [];
	await assert.rejects(activation.withStartTransaction((current, publish) => {
		const path = sessionRuntimePaths(cwd, "passive-session", root).config;
		const config = JSON.parse(readFileSync(path, "utf8"));
		config.mode = "active";
		// Nonparticipating writers can replace a file despite the cooperative lock.
		writeFileSync(path, JSON.stringify(config));
		files = captureTemporalFileBases(cwd, "passive-session", root);
		publish({ ...current!, config: { mode: "active" as const } });
	}), /base or scope identity changed concurrently/);
	assert.equal(activation.view, undefined);
	assert.deepEqual(captureTemporalFileBases(cwd, "passive-session", root), files);
});

test("awaited Start authorizes absent private memory only inside its single-use acceptance", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-active-authority-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "absent");
	const runtime = new TemporalRuntime(parent, "owner", root);
	const before = captureTemporalFileBases(parent, "owner", root);
	const aborted = AbortSignal.abort(new Error("Start cancelled before initialization"));
	await assert.rejects(runtime.withStartTransaction(() => assert.fail("aborted Start ran"), aborted), /cancelled before initialization/);
	assert.equal(existsSync(root), false);
	await assert.rejects(runtime.withStartTransaction(() => assert.fail("missing origin was admitted")), /storage is unavailable/);
	assert.equal(existsSync(root), false, "no root is created without explicit initialization authority");
	await assert.rejects(runtime.withStartTransaction((current) => {
		assert.equal(current, undefined);
		throw new Error("branch does not authorize empty memory");
	}, undefined, true), /does not authorize empty memory/);
	assert.equal(runtime.view, undefined);
	assert.deepEqual(captureTemporalFileBases(parent, "owner", root), before);
	let borrowed!: (snapshot: Snapshot) => unknown;
	await assert.rejects(runtime.withStartTransaction((_current, publish) => { borrowed = publish; }, undefined, true), /requires one synchronous publication/);
	assert.throws(() => borrowed(emptySnapshot("active")), /transaction has ended/);
	assert.equal(runtime.view, undefined);
	await assert.rejects(withStorageTransaction(root, () => runtime.withStartTransaction(() => assert.fail("recursive Start ran"))), /Recursive/);
	const late = new AbortController();
	await runtime.withStartTransaction((current, publish) => {
		assert.equal(current, undefined);
		assert.equal(publish(emptySnapshot("active")).changed, true);
		assert.throws(() => publish(emptySnapshot()), /already consumed/);
		late.abort();
	}, late.signal, true);
	const accepted = captureTemporalFileBases(parent, "owner", root);
	assert.equal((await runtime.withStartTransaction((current, publish) => publish({ ...current!, config: { mode: "active" as const } }))).changed, false);
	assert.deepEqual(captureTemporalFileBases(parent, "owner", root), accepted);
});

test("awaited Start rejects unaccepted candidates and preserves the exact cohort on publication failure", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-active-rollback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot();
	await patchCurrent(runtime, snapshot, { session: { tactics: { retained: true } } });
	const activation = new TemporalRuntime(root, "owner", root);
	activation.loadPassive();
	const cached = structuredClone(activation.view);
	const before = captureTemporalFileBases(root, "owner", root);
	const rename = fs.renameSync;
	const config = sessionRuntimePaths(root, "owner", root).config;
	fs.renameSync = (from, to) => {
		if (to === config) throw new Error("injected Start publication failure");
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		await assert.rejects(activation.withStartTransaction((current, publish) => publish({ ...current!, config: { mode: "active" as const } })), /injected Start publication failure/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.deepEqual(activation.view, cached);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before);
	await activation.withStartTransaction((current, publish) => publish({ ...current!, config: { mode: "active" as const } }));
	assert.deepEqual(activation.read(0, "session").tactics, { retained: true });
});

test("passive memory admits global state before a CWD has materialized", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-global-passive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeGlobalState({ ...emptyState(), tactics: { preference: "global" } }, root);
	const runtime = new TemporalRuntime("/new-project", "new-session", root);
	assert.equal(runtime.loadPassive(), true);
	assert.equal(runtime.read(0, "global").tactics.preference, "global");
	assert.deepEqual(runtime.read(0, "cwd"), emptyState());
});

for (const limit of [0, 1, 12] as const) {
	test(`fork copies current parent memory from an old step and applies historyLimit ${limit} to stored tails`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-retention-change-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot("active");
		parent.initialize(snapshot, true);
		const checkpoints = [parent.retainedCheckpoint(snapshot)];
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		for (let index = 1; index <= 6; index++) {
			const before = parent.states();
			const next = structuredClone(before);
			for (const scope of ["global", "cwd", "session"] as const) {
				next[scope].tactics.index = index;
				next[scope].artifacts["/unchanged.txt"] = { description: "Stable compilation" };
			}
			snapshot.meta.step++;
			parent.publish(snapshot, true, createAcceptedTransition(before, next), { provenance: {
				global: { "/unchanged.txt": evidence }, cwd: { "/unchanged.txt": evidence }, session: { "/unchanged.txt": evidence },
			} });
			checkpoints.push(parent.retainedCheckpoint(snapshot));
		}
		const beforeFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, "child", root, undefined, limit);
		const oldest = checkpoints[0]!;
		assert.ok("boundary" in oldest);
		// The fork's native step does not select memory; the child receives the parent's current state.
		const accepted = await forkAwaited(selected, { id: parent.sessionId, key: parent.sessionKey }, oldest);
		assert.equal(accepted.snapshot.meta.step, 0);
		for (const scope of ["global", "cwd", "session"] as const) {
			assert.equal(selected.read(0, scope).tactics.index, 6);
			assert.deepEqual(selected.artifactProvenance(scope), { "/unchanged.txt": evidence });
			assert.ok(selected.view!.scopes[scope].patches.length <= limit);
			const paths = temporalScopePaths(cwd, selected.sessionId, scope, root);
			assert.ok(readFileSync(paths.patches, "utf8").split("\n").filter(Boolean).length <= limit);
		}
		{
			const directory = temporalScopePaths(cwd, parent.sessionId, "session", root).directory;
			const privateFiles = (files: ReturnType<typeof captureTemporalFileBases>) => files.filter(({ path }) => dirname(path) === directory);
			assert.deepEqual(privateFiles(captureTemporalFileBases(cwd, parent.sessionId, root)), privateFiles(beforeFiles));
		}
		const smallerTails = structuredClone(selected.view!.scopes);
		const increased = new TemporalRuntime(cwd, selected.sessionId, root, undefined, 12);
		const resumed = await attachCurrent(increased);
		assert.deepEqual(increased.view!.scopes, smallerTails, "raising retention cannot reconstruct folded tails");
		assert.throws(() => increased.read(1), /predates the proven temporal origin/);
		const before = increased.states();
		const next = structuredClone(before);
		next.session.tactics.next = true;
		resumed.meta.step++;
		increased.publish(resumed, true, createAcceptedTransition(before, next));
		assert.deepEqual(increased.read(1, "session"), before.session);
	});
}

{
	test("fork from an old step copies current artifacts with their current provenance", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-provenance-selection-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot("active");
		parent.initialize(snapshot, true);
		const evidence = (version: number) => ({ sourceFingerprint: { size: version, mtimeNs: String(version) }, compilerRevision: "artifact-v1" });
		const before = parent.states();
		const initial = structuredClone(before);
		initial.session.artifacts = {
			"/changed.txt": { description: "Version 1" },
			"/untouched.txt": { description: "Stable semantics" },
			"/returned.txt": { description: "Original semantics" },
			"/removed.txt": { description: "Removed later" },
			"/unproven.txt": { description: "No compilation evidence" },
		};
		for (const scope of ["global", "cwd"] as const) initial[scope].artifacts = { "/shared.txt": { description: "Old shared semantics" } };
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(before, initial), { provenance: {
			global: { "/shared.txt": evidence(1) },
			cwd: { "/shared.txt": evidence(1) },
			session: Object.fromEntries(["/changed.txt", "/untouched.txt", "/returned.txt", "/removed.txt"].map((path) => [path, evidence(1)])),
		} });
		const historical = parent.retainedCheckpoint(snapshot);
		const changed = structuredClone(initial);
		changed.session.artifacts["/changed.txt"] = { description: "Version 2" };
		changed.session.artifacts["/returned.txt"] = { description: "Intermediate semantics" };
		delete changed.session.artifacts["/removed.txt"];
		for (const scope of ["global", "cwd"] as const) changed[scope].artifacts["/shared.txt"] = { description: "Live shared semantics" };
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(initial, changed), { provenance: {
			global: { "/shared.txt": evidence(2) }, cwd: { "/shared.txt": evidence(2) },
			session: { "/changed.txt": evidence(2), "/returned.txt": evidence(2) },
		} });
		const returned = structuredClone(changed);
		returned.session.artifacts["/returned.txt"] = structuredClone(initial.session.artifacts["/returned.txt"]!);
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(changed, returned), { provenance: { session: { "/returned.txt": evidence(3) } } });
		// Unchanged accepted semantics can acquire newer evidence without a semantic transition.
		parent.publish(snapshot, false, undefined, { provenance: { session: { "/untouched.txt": evidence(3) } } });
		const checkpoint = historical;
		assert.ok("boundary" in checkpoint);
		const parentFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, "child", root);
		await forkAwaited(selected, { id: parent.sessionId, key: parent.sessionKey }, checkpoint);
		const expected = parent.artifactProvenance("session");
		assert.deepEqual(selected.read(0, "session").artifacts, returned.session.artifacts);
		assert.deepEqual(selected.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, "session", root, selected.sessionKey), expected);
		for (const scope of ["global", "cwd"] as const) {
			assert.deepEqual(selected.read(0, scope).artifacts, changed[scope].artifacts);
			assert.deepEqual(selected.artifactProvenance(scope), { "/shared.txt": evidence(2) });
			assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, scope, root, selected.sessionKey), { "/shared.txt": evidence(2) });
		}
		assert.deepEqual(captureTemporalFileBases(cwd, parent.sessionId, root), parentFiles);
		const meta = temporalScopePaths(cwd, selected.sessionId, "session", root).meta;
		assert.deepEqual(JSON.parse(readFileSync(meta, "utf8")).artifacts, expected);
		const reloaded = new TemporalRuntime(cwd, selected.sessionId, root);
		await attachCurrent(reloaded);
		assert.deepEqual(reloaded.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, reloaded.sessionId, "session", root, reloaded.sessionKey), expected);
	});
}

for (const operation of ["attach", "fork"] as const) {
	test(`${operation} rejects contradictory session lineage before accepting a new origin`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-session-lineage-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const seed = (id: string) => {
			const runtime = new TemporalRuntime(cwd, id, root);
			const snapshot = emptySnapshot("active");
			runtime.initialize(snapshot, true);
			const before = runtime.states();
			const next = structuredClone(before);
			next.session.tactics.owner = id;
			snapshot.meta.step++;
			runtime.publish(snapshot, true, createAcceptedTransition(before, next));
			return runtime.retainedCheckpoint(snapshot);
		};
		const checkpoint = seed("a");
		assert.ok("boundary" in checkpoint);
		seed("b");
		const a = temporalScopePaths(cwd, "a", "session", root);
		const b = temporalScopePaths(cwd, "b", "session", root);
		for (const key of ["checkpoint", "patches", "meta"] as const) writeFileSync(a[key], readFileSync(b[key]));
		const selected = new TemporalRuntime(cwd, operation.endsWith("fork") ? "child" : "a", root);
		const before = ["a", "b", "child"].map((id) => captureTemporalFileBases(cwd, id, root));
		if (operation === "fork") await assert.rejects(forkAwaited(selected, { id: "a", key: "a" }, checkpoint), /Conflicting State Flow temporal lineage/);
		else await assert.rejects(attachCurrent(selected), /Conflicting State Flow temporal lineage/);
		assert.equal(selected.view, undefined, "contradictory state must not become an accepted cache");
		assert.deepEqual(["a", "b", "child"].map((id) => captureTemporalFileBases(cwd, id, root)), before);
	});
}

async function forkFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-awaited-fork-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const parent = new TemporalRuntime(root, "parent", root);
	const snapshot = emptySnapshot("passive");
	snapshot.meta.bootstrap = true;
	snapshot.meta.specification = "Parent unfinished request";
	await patchCurrent(parent, snapshot, { session: { tactics: { value: "SELECTED" } } });
	const checkpoint = parent.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	await patchCurrent(parent, snapshot, { session: { tactics: { value: "LATER" } } });
	return { root, parent, checkpoint, source: { id: "parent", key: "parent" }, child: new TemporalRuntime(root, "child", root) };
}

test("awaited fork refuses every occupied child file and unsupported legacy evidence without writes", async (t) => {
	for (const name of ["checkpoint.json", "patches.jsonl", "meta.json", "config.json", "runtime.json", "state.json"]) {
		const { root, child, source, checkpoint } = await forkFixture(t);
		const directory = temporalScopePaths(root, "child", "session", root).directory;
		fs.mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, name), "occupied");
		const before = ["parent", "child"].map((id) => captureTemporalFileBases(root, id, root));
		await assert.rejects(forkAwaited(child, source, checkpoint), /already has session storage|Unsupported State Flow storage/, name);
		assert.equal(child.view, undefined);
		assert.deepEqual(["parent", "child"].map((id) => captureTemporalFileBases(root, id, root)), before);
		assert.equal(readFileSync(join(directory, name), "utf8"), "occupied");
	}
});

test("awaited fork rejects invalid source identity and missing authority without initializing a child", async (t) => {
	for (const fault of ["same-id", "same-key", "wrong-id", "missing", "malformed"] as const) {
		const { root, child, source, checkpoint } = await forkFixture(t);
		if (fault === "same-id") source.id = "child";
		if (fault === "same-key") source.key = "child";
		if (fault === "wrong-id") source.id = "another";
		if (fault === "missing") rmSync(sessionRuntimePaths(root, "parent", root).runtime);
		if (fault === "malformed") writeFileSync(temporalScopePaths(root, "parent", "session", root).patches, "broken");
		const before = ["parent", "child"].map((id) => captureTemporalFileBases(root, id, root));
		await assert.rejects(child.withForkTransaction(source, checkpoint, () => assert.fail("invalid parent reached acceptance")));
		assert.equal(child.view, undefined);
		assert.deepEqual(["parent", "child"].map((id) => captureTemporalFileBases(root, id, root)), before);
		assert.equal(existsSync(temporalScopePaths(root, "child", "session", root).directory), false);
	}
});

for (const owner of ["parent", "child"] as const) test(`awaited fork preserves an uncooperative ${owner} writer and refuses its stale copy`, async (t) => {
	const { root, child, source, checkpoint } = await forkFixture(t);
	let winner: Array<ReturnType<typeof captureTemporalFileBases>> | undefined;
	await assert.rejects(child.withForkTransaction(source, checkpoint, (selected, publish) => {
		const path = sessionRuntimePaths(root, owner, root).runtime;
		fs.mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, owner === "parent" ? readFileSync(path, "utf8") + "\n" : "occupied by another writer");
		winner = ["parent", "child"].map((id) => captureTemporalFileBases(root, id, root));
		return publish(selected);
	}), /base or scope identity changed concurrently/);
	assert.equal(child.view, undefined);
	assert.deepEqual(["parent", "child"].map((id) => captureTemporalFileBases(root, id, root)), winner);
});

test("awaited fork rolls back rejected child publication and retries without changing parent-private authority", async (t) => {
	const { root, child, source, checkpoint } = await forkFixture(t);
	const before = ["parent", "child"].map((id) => captureTemporalFileBases(root, id, root));
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === sessionRuntimePaths(root, "child", root).runtime) { failed = true; throw new Error("injected fork publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	try { await assert.rejects(forkAwaited(child, source, checkpoint), /injected fork publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.equal(child.view, undefined);
	assert.deepEqual(["parent", "child"].map((id) => captureTemporalFileBases(root, id, root)), before);
	const accepted = await forkAwaited(child, source, checkpoint);
	assert.deepEqual(accepted.snapshot, { config: { mode: "passive" as const }, meta: { step: 0, bootstrap: true } });
	assert.equal(child.read(0, "session").tactics.value, "LATER", "the child copies the parent's current memory");
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before[0]);
	await patchCurrent(child, accepted.snapshot, { session: { tactics: { child: true } } });
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before[0]);
});

test("awaited fork rechecks occupied targets after competing child acceptances wait together", async (t) => {
	const { root, child, source, checkpoint } = await forkFixture(t);
	const before = captureTemporalFileBases(root, "parent", root);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(root, async () => { enter(); await gate; });
	await entered;
	const other = new TemporalRuntime(root, "child", root);
	const results = Promise.allSettled([forkAwaited(child, source, checkpoint), forkAwaited(other, source, checkpoint)]);
	try {
		await delay(40);
		assert.equal(child.view, undefined);
		assert.equal(other.view, undefined);
		assert.equal(existsSync(temporalScopePaths(root, "child", "session", root).directory), false);
	} finally { release(); await holder; }
	const outcomes = await results;
	assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
	const rejected = outcomes.find((result) => result.status === "rejected");
	assert.ok(rejected?.status === "rejected");
	assert.match(String(rejected.reason), /already has session storage/);
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before);
});

test("awaited fork preserves live shared provenance and metadata without pruning unrelated evidence", async (t) => {
	const { root, child, source, checkpoint } = await forkFixture(t);
	const path = temporalScopePaths(root, "parent", "global", root).meta;
	const metadata = JSON.parse(readFileSync(path, "utf8"));
	metadata.artifacts = { "/unregistered": { sourceFingerprint: { size: 1, mtimeNs: "7" }, compilerRevision: "artifact-v1" } };
	metadata.foreign = { retained: true };
	writeFileSync(path, JSON.stringify(metadata));
	const before = captureTemporalFileBases(root, "parent", root);
	await forkAwaited(child, source, checkpoint);
	assert.deepEqual(child.artifactProvenance("global"), metadata.artifacts);
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before);
});

test("awaited fork capabilities expire and post-acceptance faults cannot copy again or roll the child back", async (t) => {
	const { root, child, source, checkpoint } = await forkFixture(t);
	const before = ["parent", "child"].map((id) => captureTemporalFileBases(root, id, root));
	await assert.rejects(forkAwaited(child, source, checkpoint, AbortSignal.abort()), { name: "AbortError" });
	await assert.rejects(child.withForkTransaction(source, checkpoint, () => { throw new Error("selection superseded"); }), /selection superseded/);
	let borrowed!: (snapshot: Snapshot) => unknown;
	await assert.rejects(child.withForkTransaction(source, checkpoint, (_selected, publish) => { borrowed = publish; }), /requires one synchronous publication/);
	assert.throws(() => borrowed(emptySnapshot()), /transaction has ended/);
	await assert.rejects(withStorageTransaction(root, () => forkAwaited(child, source, checkpoint)), /Recursive/);
	assert.deepEqual(["parent", "child"].map((id) => captureTemporalFileBases(root, id, root)), before);
	const controller = new AbortController();
	await assert.rejects(child.withForkTransaction(source, checkpoint, (selected, publish) => {
		assert.equal(child.view, undefined);
		publish(selected);
		assert.equal(child.read(0, "session").tactics.value, "LATER");
		assert.throws(() => publish(selected), /already consumed/);
		controller.abort();
		throw new Error("post-acceptance child checkpoint failure");
	}, controller.signal), /post-acceptance child checkpoint failure/);
	const accepted = captureTemporalFileBases(root, "child", root);
	assert.equal(child.view!.lineage.length, 1);
	await assert.rejects(forkAwaited(child, source, checkpoint), /already has session storage/);
	await assert.rejects(forkAwaited(new TemporalRuntime(root, "child", root), source, checkpoint), /already has session storage/);
	assert.deepEqual(captureTemporalFileBases(root, "child", root), accepted);
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before[0]);
});

for (const limit of [0, 7]) test(`awaited current-memory recovery preserves current private authority without accepting writes at limit ${limit}`, async (t) => {
	const { root } = await forkFixture(t);
	await patchCurrent(new TemporalRuntime(root, "foreign", root), emptySnapshot(), {
		global: { tactics: { shared: true } }, cwd: { tactics: { project: true } }, session: { tactics: { secret: "FOREIGN" } },
	});
	const before = ["parent", "foreign"].map((id) => captureTemporalFileBases(root, id, root));
	const reader = new TemporalRuntime(root, "parent", root, undefined, limit);
	const snapshot = await reader.refreshCurrentMemory();
	assert.deepEqual(snapshot, { config: { mode: "passive" as const }, meta: { step: 2, bootstrap: true } });
	assert.deepEqual(reader.read().tactics, { shared: true, project: true, value: "LATER" });
	assert.deepEqual(temporalScopeRevisions(reader.view!), { global: 1, cwd: 1, session: 2 });
	assert.ok(reader.view!.scopes.session.patches.length <= limit);
	assert.equal(reader.view!.lineage.length, 1, "independent shared advancement cannot invent composed history");
	await assert.rejects(reader.withLifecycleTransaction((publish) => publish(snapshot!)), /requires an accepted runtime/);
	await assert.rejects(reader.withPatchTransaction(() => assert.fail("read-only recovery authorized a patch")), /not selected/);
	assert.deepEqual(["parent", "foreign"].map((id) => captureTemporalFileBases(root, id, root)), before);
});

test("awaited current-memory recovery leaves absence and invalid private authority untouched", async (t) => {
	const absent = mkdtempSync(join(tmpdir(), "state-flow-recovery-absent-"));
	t.after(() => rmSync(absent, { recursive: true, force: true }));
	const missing = join(absent, "missing");
	const reader = new TemporalRuntime(absent, "owner", missing);
	await assert.rejects(reader.refreshCurrentMemory(AbortSignal.abort()), { name: "AbortError" });
	assert.equal(await reader.refreshCurrentMemory(), undefined);
	assert.equal(existsSync(missing), false);
	for (const fault of ["absent", "partial", "malformed", "provenance", "identity"] as const) {
		const { root } = await forkFixture(t);
		const recovering = new TemporalRuntime(root, "parent", root);
		assert.ok(await recovering.refreshCurrentMemory());
		const cached = recovering.view;
		const paths = sessionRuntimePaths(root, "parent", root);
		if (fault === "absent") rmSync(temporalScopePaths(root, "parent", "session", root).directory, { recursive: true });
		if (fault === "partial") rmSync(paths.runtime);
		if (fault === "malformed") writeFileSync(paths.runtime, "broken");
		if (fault === "provenance") {
			const path = temporalScopePaths(root, "parent", "session", root).meta;
			writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), artifacts: [] }));
		}
		if (fault === "identity") {
			const contents = readFileSync(paths.runtime, "utf8");
			writeFileSync(paths.runtime, contents.replaceAll('"parent"', '"foreign"'));
		}
		const before = captureTemporalFileBases(root, "parent", root);
		if (fault === "absent") assert.equal(await recovering.refreshCurrentMemory(), undefined);
		else await assert.rejects(recovering.refreshCurrentMemory(), fault);
		assert.equal(recovering.view, cached, "unavailable recovery must not replace the cache with empty memory");
		assert.deepEqual(captureTemporalFileBases(root, "parent", root), before);
	}
});

test("awaited current-memory recovery rejects cancellation observed during capture before installing its view", async (t) => {
	const { root } = await forkFixture(t);
	const reader = new TemporalRuntime(root, "parent", root);
	assert.ok(await reader.refreshCurrentMemory());
	const cached = reader.view;
	const before = captureTemporalFileBases(root, "parent", root);
	const controller = new AbortController();
	const read = fs.readFileSync;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const value = read(...args);
		if (value.toString().includes('"LATER"')) controller.abort(new Error("recovery selection superseded during capture"));
		return value;
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	try { await assert.rejects(reader.refreshCurrentMemory(controller.signal), /recovery selection superseded during capture/); }
	finally { fs.readFileSync = read; syncBuiltinESMExports(); }
	assert.equal(reader.view, cached);
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before);
});

test("stopping an ordinary disabled session is harmless and does not initialize or publish storage", async () => {
	const h = harness();
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await h.commands.get("state-flow-off").handler("", h.ctx);
	await h.commands.get("state-flow-off").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.deepEqual(h.entries.at(-1).data, nativePolicyMarker(h.ctx.sessionManager.getSessionId(), "off"));
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(head(), before);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.throws(() => h.readState(), /runtime is unavailable/);
});

test("runtime causal basis rejects staged work after accepted history returns to identical values", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "causal-stage", h.repositoryRoot);
	const snapshot = emptySnapshot("active");
	runtime.initialize(snapshot, true);
	const initial = runtime.states();
	const initialBasis = runtime.causalBasis();
	const originPosition = runtime.view!.lineage.at(-1)!.position;
	const stage = stageAtomicScopePatches(initial, { session: { intents: { stale: "Must not publish" } } }, [], initialBasis);
	const changed = structuredClone(initial);
	changed.session.intents.temporary = "Advance and remove";
	snapshot.meta.step = 1;
	runtime.publish(snapshot, true, createAcceptedTransition(initial, changed, "z-first"));
	snapshot.meta.step = 2;
	runtime.publish(snapshot, true, createAcceptedTransition(changed, initial, "a-second"));
	assert.deepEqual(runtime.states(), initial);
	assert.notEqual(runtime.causalBasis(), initialBasis);
	assert.throws(() => commitScopedTransition(snapshot, runtime.states(), stage, () => assert.fail("stale publication"), runtime.causalBasis()), /causal basis changed/);
	assert.deepEqual(runtime.recent().map(({ id, at }) => ({ id, at })), [{ id: "z-first", at: originPosition + 1 }, { id: "a-second", at: originPosition + 2 }]);
	const projected = runtime.recent();
	projected[0]!.transitions[0]!.patch.intents!.temporary = "mutated";
	assert.equal(runtime.recent()[0]!.transitions[0]!.patch.intents!.temporary, "Advance and remove");
	assert.equal(runtime.read(1).intents.temporary, "Advance and remove");
	assert.equal(snapshot.meta.step, 2);
});


test("ordinary startup needs no existing Git repository and creates no storage", () => {
	const h = harness();
	const absent = join(h.repositoryRoot, "absent");
	const runtime = new TemporalRuntime(h.ctx.cwd, "ordinary", absent);
	assert.equal(runtime.initialize(emptySnapshot(), false), undefined);
	assert.equal(runtime.view, undefined);
	assert.equal(existsSync(absent), false);
});



// --- Shared-scope drift reconciliation ---

function publishScopedPatch(
	runtime: TemporalRuntime,
	snapshot: Snapshot,
	scope: StateScope,
	tactics: JsonObject,
	id: string,
) {
	const before = runtime.states();
	const after = structuredClone(before);
	after[scope].tactics = { ...after[scope].tactics, ...structuredClone(tactics) };
	snapshot.meta.step += 1;
	return runtime.publish(snapshot, true, createAcceptedTransition(before, after, id));
}

for (const scope of ["global", "cwd"] as const) for (const write of ["session", "provenance", "target"] as const) {
	test(`first passive ${write} publication reconciles or fences foreign ${scope} drift`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-passive-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "extensions");
		const otherScope = scope === "global" ? "cwd" : "global";
		const source = join(root, "source.txt");
		const a = new TemporalRuntime(cwd, "session-a", root);
		const aSnapshot = emptySnapshot("active");
		a.initialize(aSnapshot, true);
		const seed = a.states();
		const seeded = structuredClone(seed);
		seeded[otherScope].artifacts[source] = { description: "Known source" };
		seeded.session.tactics.private = "session-a only";
		a.publish(aSnapshot, true, createAcceptedTransition(seed, seeded));
		const b = new TemporalRuntime(cwd, "session-b", root);
		const snapshot = emptySnapshot();
		assert.equal(b.loadPassive(), true);
		publishScopedPatch(a, aSnapshot, scope, { neighbor: "accepted" }, "foreign-shared-update");
		const winnerFiles = captureTemporalFileBases(cwd, a.sessionId, root);
		const beforeFiles = captureTemporalFileBases(cwd, b.sessionId, root);
		const before = b.states();
		const evidence = { sourceFingerprint: { size: 2, mtimeNs: "2" }, compilerRevision: "artifact-v1" };
		const stage = stageAtomicScopePatches(before, {
			[write === "target" ? scope : "session"]: { tactics: { mine: "accepted" } },
		}, [], b.causalBasis());
		const publish = () => write === "provenance"
			? b.publish(snapshot, false, undefined, { provenance: { [otherScope]: { [source]: evidence } } })
			: commitScopedTransition(snapshot, before, stage, (accepted, next) => {
				b.publish(next, accepted !== undefined, accepted);
			}, b.causalBasis(), { finalizeRun: false });
		if (write === "target") {
			assert.throws(publish, new RegExp(`cannot publish the ${scope === "cwd" ? "CWD" : scope} patch`));
			assert.deepEqual(captureTemporalFileBases(cwd, b.sessionId, root), beforeFiles);
			assert.deepEqual(b.states(), before);
			assert.equal(snapshot.meta.step, 0);
			return;
		}
		assert.ok(publish());
		assert.notEqual(snapshot.config.mode, "active");
		assert.equal(b.read(0, scope).tactics.neighbor, "accepted");
		assert.equal(b.read(0, "session").tactics.private, undefined);
		if (write === "session") {
			assert.equal(b.read(0, "session").tactics.mine, "accepted");
			assert.equal(snapshot.meta.step, 1);
			assert.deepEqual(temporalScopeRevisions(b.view!), { global: 1, cwd: 1, session: 1 });
		} else {
			assert.deepEqual(b.artifactProvenance(otherScope)[source], evidence);
			assert.equal(snapshot.meta.step, 0);
		}
		const protectedPaths = temporalScopePaths(cwd, a.sessionId, scope, root);
		const privatePaths = sessionRuntimePaths(cwd, a.sessionId, root);
		const protectedFiles = (files: typeof winnerFiles) => files.filter(({ path }) =>
			path.startsWith(`${dirname(privatePaths.runtime)}/`) || Object.values(protectedPaths).includes(path));
		assert.deepEqual(protectedFiles(captureTemporalFileBases(cwd, a.sessionId, root)), protectedFiles(winnerFiles));
		const restored = new TemporalRuntime(cwd, b.sessionId, root);
		await restored.refreshCurrentMemory();
		assert.deepEqual(restored.states(), b.states());
		assert.deepEqual(restored.artifactProvenance(otherScope), b.artifactProvenance(otherScope));
	});
}

test("first passive publication still fences another writer of the same private session", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-passive-private-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "extensions");
	new TemporalRuntime(cwd, "seed", root).initialize(emptySnapshot(), true);
	const passive = new TemporalRuntime(cwd, "same-session", root);
	passive.loadPassive();
	const competing = new TemporalRuntime(cwd, passive.sessionId, root);
	competing.initialize(emptySnapshot(), true);
	const files = captureTemporalFileBases(cwd, passive.sessionId, root);
	assert.throws(() => publishScopedPatch(passive, emptySnapshot(), "session", { stale: true }, "stale-private"), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(cwd, passive.sessionId, root), files);
});

function removeSharedPair(root: string, cwd: string, scope: "global" | "cwd"): void {
	const paths = temporalScopePaths(cwd, "session-a", scope, root);
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
}











test("lifecycle transactions require accepted authority and never initialize from passive or prepared views", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-authority-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "absent");
	const snapshot = emptySnapshot("active");
	const owner = new TemporalRuntime(parent, "owner", root);
	const refused = (runtime: TemporalRuntime) => assert.rejects(runtime.withLifecycleTransaction((publish) => publish(snapshot)), /requires an accepted runtime/);
	await refused(owner);
	assert.equal(existsSync(root), false);
	await assert.rejects(owner.withLifecycleTransaction(() => assert.fail("canceled action ran"), AbortSignal.abort()), { name: "AbortError" });
	assert.equal(existsSync(root), false);
	owner.initialize(snapshot, true);
	const files = captureTemporalFileBases(parent, "owner", root);
	const unselected = new TemporalRuntime(parent, "owner", root);
	const passive = new TemporalRuntime(parent, "passive", root);
	assert.equal(passive.loadPassive(), true);
	const readOnly = new TemporalRuntime(parent, "owner", root);
	assert.ok(await readOnly.refreshCurrentMemory());
	for (const runtime of [unselected, passive, readOnly]) {
		const cached = structuredClone(runtime.view);
		await refused(runtime);
		assert.deepEqual(runtime.view, cached);
	}
	assert.deepEqual(captureTemporalFileBases(parent, "owner", root), files);
	assert.equal(existsSync(temporalScopePaths(parent, "passive", "session", root).directory), false);
});

test("lifecycle refusal and failed publication install neither metadata nor candidate shared adoption", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-reject-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot("active");
	await patchCurrent(runtime, snapshot, { session: { tactics: { private: "retained" } } });
	await patchCurrent(new TemporalRuntime(cwd, "peer", root), emptySnapshot("active"), { global: { tactics: { foreign: "accepted" } } });
	const cached = structuredClone(runtime.view);
	const files = captureTemporalFileBases(cwd, "owner", root);
	const stopped = { ...structuredClone(snapshot), config: { mode: "passive" as const } };
	const input = structuredClone(stopped);
	await assert.rejects(runtime.withLifecycleTransaction(() => { throw new Error("selection changed while waiting"); }), /selection changed/);
	assert.deepEqual(runtime.view, cached);
	assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), files);
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (!failed && to === sessionRuntimePaths(cwd, "owner", root).runtime) {
			failed = true;
			throw new Error("injected lifecycle publication failure");
		}
		rename(from, to);
	};
	syncBuiltinESMExports();
	try { await assert.rejects(runtime.withLifecycleTransaction((publish) => publish(stopped)), /injected lifecycle publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), files, "failed runtime rename must roll back its earlier config replacement");
	assert.deepEqual(runtime.view, cached);
	assert.deepEqual(stopped, input);
	assert.equal((await runtime.withLifecycleTransaction((publish) => publish(stopped))).changed, true);
	assert.equal(runtime.read(0, "global").tactics.foreign, "accepted");
	assert.deepEqual(runtime.read(0, "session").tactics, { private: "retained" });
	assert.equal(stopped.meta.step, snapshot.meta.step);
});

for (const fault of ["absent", "partial", "malformed"] as const) test(`lifecycle transactions do not repair ${fault} shared storage`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-incomplete-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot("active");
	runtime.initialize(snapshot, true);
	const cached = structuredClone(runtime.view);
	if (fault === "malformed") writeFileSync(join(root, "meta.json"), "not JSON\n");
	else {
		rmSync(join(root, "checkpoint.json"));
		if (fault === "absent") rmSync(join(root, "patches.jsonl"));
	}
	const files = captureTemporalFileBases(root, "owner", root);
	await assert.rejects(runtime.withLifecycleTransaction((publish) => publish({ ...snapshot, config: { mode: "passive" as const } })), /incomplete|missing|metadata|JSON/i);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), files);
	assert.deepEqual(runtime.view, cached);
});

test("lifecycle capabilities are synchronous, single-use and cancelable only before acceptance", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-capability-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot("active");
	runtime.initialize(snapshot, true);
	const before = captureTemporalFileBases(root, "owner", root);
	let borrowed!: (snapshot: Snapshot) => unknown;
	await assert.rejects(runtime.withLifecycleTransaction((publish) => { borrowed = publish; }), /requires one synchronous publication/);
	assert.throws(() => borrowed(snapshot), /transaction has ended/, "an expired no-op cannot bypass the borrowed storage guard");
	await assert.rejects(withStorageTransaction(root, () => runtime.withLifecycleTransaction((publish) => publish(snapshot))), /Recursive/);
	const canceled = new AbortController();
	await assert.rejects(runtime.withLifecycleTransaction((publish) => {
		canceled.abort();
		return publish(snapshot);
	}, canceled.signal), { name: "AbortError" });
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before);
	const late = new AbortController();
	const accepted = await runtime.withLifecycleTransaction((publish) => {
		const result = publish({ ...snapshot, config: { mode: "passive" as const } });
		assert.throws(() => publish(snapshot), /already consumed/);
		late.abort();
		return result;
	}, late.signal);
	assert.equal(accepted.changed, true, "post-acceptance cancellation cannot undo saved lifecycle");
	const files = captureTemporalFileBases(root, "owner", root);
	assert.equal((await runtime.withLifecycleTransaction((publish) => publish({ ...snapshot, config: { mode: "passive" as const } }))).changed, false);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), files);
	assert.equal(existsSync(join(root, ".state-flow-publication.lock")), false);
});

test("no-transition patch acceptance distinguishes missing shared initialization from a metadata-only no-op", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-preparation-absence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot("active");
	await patchCurrent(runtime, snapshot, { cwd: { tactics: { old: "never resurrect" } }, session: { tactics: { private: true } } });
	const step = snapshot.meta.step;
	const paths = temporalScopePaths(root, "owner", "cwd", root);
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
	const before = captureTemporalFileBases(root, "owner", root);
	await assert.rejects(runtime.withLifecycleTransaction((publish) => publish(snapshot)), /Incomplete file-only temporal scope cohort/);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before, "the explicit runtime-only API never repairs semantic storage");
	const next = { ...snapshot, meta: { ...snapshot.meta, specification: "Current request" } };
	await runtime.withPatchTransaction((tx) => {
		assert.deepEqual(tx.states.cwd, {});
		assert.deepEqual(tx.provenance.cwd, {});
		assert.equal(tx.publish(next).changed, true);
		assert.throws(() => tx.publish(next), /already consumed/);
	});
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
	assert.deepEqual(runtime.read(0, "cwd"), emptyState());
	assert.deepEqual(runtime.readView(0, "cwd"), {});
	assert.deepEqual(runtime.readView(), { tactics: { private: true } });
	assert.deepEqual(runtime.read(0, "session").tactics, { private: true });
	assert.equal(next.meta.step, step, "initializing the current empty reality is not a semantic transition");
	const accepted = captureTemporalFileBases(root, "owner", root);
	await runtime.withPatchTransaction((tx) => assert.equal(tx.publish(next).changed, false));
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), accepted);
});

for (const mode of ["raw", "awaited", "preparation"] as const) for (const scope of ["global", "cwd"] as const) for (const historyLimit of [0, 7]) for (const drift of ["state", "provenance"] as const) {
	test(`${mode} lifecycle-only publication adopts ${scope} ${drift} drift at limit ${historyLimit} without touching semantic files`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const a = new TemporalRuntime(cwd, "session-a", root, undefined, historyLimit);
		const snapshot = emptySnapshot("active");
		a.initialize(snapshot, true);
		const source = join(root, "registered.txt");
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		const before = a.states();
		const seeded = structuredClone(before);
		seeded[scope].artifacts[source] = { description: "Registered compilation" };
		seeded.session.tactics.private = "retained";
		snapshot.meta.step++;
		a.publish(snapshot, true, createAcceptedTransition(before, seeded), { provenance: { [scope]: { [source]: evidence } } });
		const privateState = a.read(0, "session");
		const previousHead = a.causalBasis();
		// The independent publisher deliberately retains a wider tail than a current-only reader.
		execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
			import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
			import { createAcceptedTransition } from ${JSON.stringify(new URL("../lib/history.ts", import.meta.url).href)};
			const { cwd, root, scope, drift, source, evidence } = JSON.parse(process.argv[1]);
			const b = new TemporalRuntime(cwd, "session-b", root);
			const snapshot = emptySnapshot("active");
			b.initialize(snapshot, true);
			const before = b.states();
			const next = structuredClone(before);
			if (drift === "state") { next[scope].tactics.foreign = "accepted"; snapshot.meta.step++; }
			b.publish(snapshot, drift === "state", drift === "state" ? createAcceptedTransition(before, next) : undefined,
				{ provenance: { [scope]: { [source]: { ...evidence, sourceFingerprint: { size: 2, mtimeNs: "2" } } } } });
		`, JSON.stringify({ cwd, root, scope, drift, source, evidence })], { stdio: "pipe" });
		const meta = temporalScopePaths(cwd, a.sessionId, scope, root).meta;
		const document = JSON.parse(readFileSync(meta, "utf8"));
		document.artifacts["/orphaned-evidence.txt"] = evidence;
		document.external = { preserved: true };
		writeFileSync(meta, `${JSON.stringify(document, null, 2)}\n`);
		const runtimePaths = sessionRuntimePaths(cwd, a.sessionId, root);
		const protectedFiles = () => captureTemporalFileBases(cwd, a.sessionId, root)
			.filter(({ path }) => path !== runtimePaths.config && path !== runtimePaths.runtime);
		const retained = protectedFiles();
		if (drift === "provenance") {
			assert.throws(() => a.publish(snapshot, false, undefined, { provenance: { [scope]: { [source]: evidence } } }), /cannot publish the (global|CWD) patch/);
			assert.deepEqual(protectedFiles(), retained, "explicit stale provenance writes are not lifecycle-only");
		}
		const stopped = structuredClone(snapshot);
		stopped.config.mode = "passive";
		const persist = (value: Snapshot) => mode === "raw" ? a.publish(value)
			: mode === "preparation" ? a.withPatchTransaction((tx) => tx.publish(value))
			: a.withLifecycleTransaction((publish) => publish(value));
		assert.equal((await persist(stopped))?.changed, true);
		assert.equal(JSON.parse(readFileSync(runtimePaths.config, "utf8")).mode, "passive");
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).step, snapshot.meta.step);
		assert.deepEqual(protectedFiles(), retained);
		assert.deepEqual(a.read(0, "session"), privateState);
		assert.deepEqual(a.artifactProvenance(scope), document.artifacts, "Stop must not prune unrelated evidence");
		if (drift === "state") {
			assert.equal(a.read(0, scope).tactics.foreign, "accepted");
			assert.notEqual(a.causalBasis(), previousHead);
			assert.equal(a.view!.lineage.length, 1);
			assert.equal(a.view!.lineage[0]!.parent, null, "shared adoption is an origin, not a semantic transition");
		} else assert.equal(a.causalBasis(), previousHead);
		const stoppedFiles = captureTemporalFileBases(cwd, a.sessionId, root);
		assert.equal((await persist(stopped))?.changed, mode === "raw" ? undefined : false, "unchanged lifecycle persistence must not fabricate another origin");
		assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), stoppedFiles);
		const restarted = structuredClone(stopped);
		restarted.config.mode = "active";
		restarted.meta.specification = "Next request";
		assert.equal((await persist(restarted))?.changed, true);
		assert.deepEqual(protectedFiles(), retained);
		assert.equal(restarted.meta.step, snapshot.meta.step);
	});
}

for (const conflict of ["private-state", "runtime-metadata"] as const) test(`lifecycle-only publication refuses concurrent ${conflict} from the same session`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-private-conflict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "session-a", root);
	const snapshot = emptySnapshot("active");
	a.initialize(snapshot, true);
	const other = new TemporalRuntime(cwd, a.sessionId, root);
	const current = await attachCurrent(other);
	if (conflict === "private-state") publishScopedPatch(other, current, "session", { other: "accepted" }, "competing-private-write");
	else {
		current.meta.specification = "Competing request";
		other.publish(current);
	}
	const files = captureTemporalFileBases(cwd, a.sessionId, root);
	const cached = structuredClone(a.view);
	const stopped = structuredClone(snapshot);
	stopped.config.mode = "passive";
	assert.throws(() => a.publish(stopped), /base or scope identity changed concurrently/);
	await assert.rejects(a.withLifecycleTransaction((publish) => publish(stopped)), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), files);
	assert.deepEqual(a.view, cached);
});

for (const operation of ["inspection", "lifecycle", "fork", "recovery"] as const) test(`awaited ${operation} sees one completed foreign cohort, stays cancelable and preserves private memory`, { timeout: 15_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-shared-inspect-"));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot("active");
	if (operation === "fork") snapshot.meta.specification = "Selected checkpoint request";
	await patchCurrent(runtime, snapshot, { session: { tactics: { private: "LOCAL" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const originalCheckpoint = structuredClone(checkpoint);
	if (operation === "fork") await patchCurrent(runtime, snapshot, { session: { tactics: { private: "NEWER-CACHED" } } });
	const childRuntime = new TemporalRuntime(cwd, "child", root);
	const source = { id: "owner", key: "owner" };
	let restoreMode: StateFlowMode = "active";
	const cached = structuredClone(runtime.view);
	const ready = join(root, "ready");
	const release = join(root, "release");
	const receipt = join(root, "receipt.json");
	const lifetime = new AbortController();
	let pending: Promise<boolean> | undefined;
	const run = (signal?: AbortSignal) => operation === "inspection" ? runtime.refreshShared(signal)
		: operation === "recovery" ? runtime.refreshCurrentMemory(signal).then((selected) => {
			assert.ok(selected);
			assert.notEqual(selected.config.mode, "active");
			assert.equal(selected.meta.specification, undefined);
			return true;
		})
		: operation === "fork" ? childRuntime.withForkTransaction(source, checkpoint, (selected, publish) => {
			assert.equal(selected.meta.step, 0);
			assert.equal(selected.meta.specification, undefined);
			assert.equal(selected.config.mode, originalCheckpoint.mode);
			return publish({ ...selected, config: { mode: restoreMode } });
		}, signal).then(({ changed }) => changed)
		: runtime.withLifecycleTransaction((publish) => publish({ ...structuredClone(snapshot), config: { mode: "passive" as const } }), signal).then(({ changed }) => changed);
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { join } from "node:path";
		import { syncBuiltinESMExports } from "node:module";
		import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
		import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
		import { stageAtomicScopePatches, commitScopedTransition } from ${JSON.stringify(new URL("../lib/transition.ts", import.meta.url).href)};
		import { captureTemporalFileBases } from ${JSON.stringify(new URL("../lib/durable.ts", import.meta.url).href)};
		const { root, cwd, ready, release, receipt } = JSON.parse(process.argv[1]);
		const rename = fs.renameSync;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (to !== join(root, "patches.jsonl")) return;
			fs.writeFileSync(ready, "partially written");
			const deadline = Date.now() + 12_000;
			while (!fs.existsSync(release)) {
				if (Date.now() > deadline) throw new Error("inspection fixture gate expired");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		};
		syncBuiltinESMExports();
		await new TemporalRuntime(cwd, "foreign", root).withPatchTransaction((tx) => {
			const stage = stageAtomicScopePatches(tx.states, {
				global: { tactics: { global: "COMPLETE" }, artifacts: { "/compiled": { description: "Complete card" } } },
				cwd: { tactics: { cwd: "COMPLETE" } }, session: { tactics: { secret: "FOREIGN" } },
			}, [], tx.causalBasis, [{ path: "/compiled", scope: "global", sourceFingerprint: { size: 7, mtimeNs: "10" } }]);
			commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted, stage.provenanceUpdates), tx.causalBasis);
			fs.writeFileSync(receipt, JSON.stringify(Object.fromEntries(["owner", "foreign"].map((id) =>
				[id, captureTemporalFileBases(cwd, id, root).map(({ path, identity }) => ({ path, identity }))]))));
		});
	`, JSON.stringify({ root, cwd, ready, release, receipt })], { stdio: ["ignore", "ignore", "inherit"] });
	const closed = once(child, "close");
	t.after(async () => {
		lifetime.abort();
		if (child.exitCode === null) child.kill("SIGKILL");
		await closed;
		await pending?.catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	});
	const deadline = Date.now() + 5_000;
	while (!existsSync(ready)) {
		if (Date.now() > deadline || child.exitCode !== null) assert.fail("foreign reader fixture did not reach its partial publication");
		await delay(10);
	}
	let ended = false;
	pending = run(lifetime.signal).then((changed) => { ended = true; return changed; });
	const controller = new AbortController();
	const partial = captureTemporalFileBases(cwd, "owner", root);
	const canceled = assert.rejects(run(controller.signal), { name: "AbortError" });
	await delay(40);
	controller.abort();
	await canceled;
	assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), partial);
	snapshot.meta.specification = "Latest lifecycle input after waiting";
	restoreMode = "passive";
	source.id = "wrong-parent"; source.key = "wrong-parent";
	checkpoint.boundary = "mutated-after-admission";
	checkpoint.step = 999;
	checkpoint.mode = "passive";
	checkpoint.specification = "Caller mutation must not change the selected pointer";
	await delay(2_200);
	assert.equal(ended, false);
	assert.deepEqual(runtime.view, cached, "partial foreign files never replace accepted memory");
	assert.equal(readFileSync(join(root, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	writeFileSync(release, "continue");
	assert.equal((await closed)[0], 0);
	assert.equal(await pending, true);
	if (operation === "fork") {
		assert.deepEqual(runtime.view, cached, "fork cannot install a view into its parent");
		// The child copies the parent's current private memory, not the revision at the native fork step.
		assert.deepEqual(childRuntime.read().tactics, { global: "COMPLETE", cwd: "COMPLETE", private: "NEWER-CACHED" });
		assert.deepEqual(temporalScopeRevisions(childRuntime.view!), { global: 1, cwd: 1, session: 2 });
		assert.deepEqual(childRuntime.artifactProvenance("global")["/compiled"]!.sourceFingerprint, { size: 7, mtimeNs: "10" });
		const received = JSON.parse(readFileSync(receipt, "utf8"));
		for (const id of ["owner", "foreign"]) assert.deepEqual(captureTemporalFileBases(cwd, id, root).map(({ path, identity }) => ({ path, identity })), received[id]);
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(cwd, "child", root).config, "utf8")).mode, "passive");
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(cwd, "child", root).runtime, "utf8")).step, 0);
		return;
	}
	const runtimePaths = sessionRuntimePaths(cwd, "owner", root);
	const protectedFiles = (files: Array<{ path: string; identity: string }>) => files.filter(({ path }) => operation === "inspection" || operation === "recovery"
		|| (path !== runtimePaths.config && path !== runtimePaths.runtime)).map(({ path, identity }) => ({ path, identity }));
	const canonical = captureTemporalFileBases(cwd, "owner", root);
	const received = JSON.parse(readFileSync(receipt, "utf8"));
	assert.deepEqual(protectedFiles(canonical), protectedFiles(received.owner));
	const foreignDirectory = temporalScopePaths(cwd, "foreign", "session", root).directory + "/";
	const foreignPrivate = (files: Array<{ path: string; identity: string }>) => files.filter(({ path }) => path.startsWith(foreignDirectory)).map(({ path, identity }) => ({ path, identity }));
	assert.equal(foreignPrivate(received.foreign).length, 5);
	assert.deepEqual(foreignPrivate(captureTemporalFileBases(cwd, "foreign", root)), foreignPrivate(received.foreign));
	if (operation === "recovery") await assert.rejects(runtime.withLifecycleTransaction((publish) => publish(snapshot)), /requires an accepted runtime/);
	if (operation !== "inspection" && operation !== "recovery") {
		assert.equal(JSON.parse(readFileSync(runtimePaths.config, "utf8")).mode, "passive");
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).specification, snapshot.meta.specification);
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).step, snapshot.meta.step);
	}
	assert.deepEqual(runtime.read().tactics, { global: "COMPLETE", cwd: "COMPLETE", private: "LOCAL" });
	assert.deepEqual(runtime.artifactProvenance("global")["/compiled"]!.sourceFingerprint, { size: 7, mtimeNs: "10" });
	assert.deepEqual(temporalScopeRevisions(runtime.view!), { global: 1, cwd: 1, session: 1 });
	const reader = new TemporalRuntime(cwd, "unselected", root);
	assert.equal(await reader.refreshShared(), true);
	assert.deepEqual(reader.read(0, "session"), emptyState());
	assert.deepEqual(reader.read(0, "global"), runtime.read(0, "global"));
	assert.equal(existsSync(temporalScopePaths(cwd, "unselected", "session", root).directory), false);
	assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), canonical);
	const accepted = structuredClone(runtime.view);
	assert.equal(await runtime.refreshShared(), false);
	assert.deepEqual(runtime.view, accepted, "unchanged inspection invents no new history");
});

test("shared inspection never initializes absent storage or installs malformed passive evidence", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-inspect-invalid-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "absent");
	const runtime = new TemporalRuntime(parent, "reader", root);
	assert.equal(await runtime.refreshShared(), false);
	assert.equal(existsSync(root), false);
	await assert.rejects(runtime.refreshShared(AbortSignal.abort()), { name: "AbortError" });
	assert.equal(existsSync(root), false);
	writeGlobalState({ ...emptyState(), tactics: { retained: true } }, root);
	const meta = join(root, "meta.json");
	const valid = readFileSync(meta, "utf8");
	writeFileSync(meta, JSON.stringify({ ...JSON.parse(valid), artifacts: [] }));
	const broken = captureTemporalFileBases(parent, "reader", root);
	await assert.rejects(runtime.refreshShared(), /provenance/i);
	assert.equal(runtime.view, undefined);
	assert.deepEqual(runtime.artifactProvenance("global"), {});
	assert.deepEqual(captureTemporalFileBases(parent, "reader", root), broken);
	writeFileSync(meta, valid);
	assert.equal(await runtime.refreshShared(), true);
	assert.equal(runtime.read().tactics.retained, true);
	const cached = structuredClone(runtime.view);
	writeFileSync(join(root, "patches.jsonl"), "malformed\n");
	const malformed = captureTemporalFileBases(parent, "reader", root);
	await assert.rejects(runtime.refreshShared());
	assert.deepEqual(runtime.view, cached);
	assert.deepEqual(captureTemporalFileBases(parent, "reader", root), malformed);
});

test("shared inspection cannot adopt an independently changed private cohort", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-inspect-owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot("active");
	await patchCurrent(runtime, snapshot, { session: { tactics: { private: "accepted" } } });
	const cached = structuredClone(runtime.view);
	const competing = new TemporalRuntime(cwd, "owner", root);
	const restored = await attachCurrent(competing);
	await patchCurrent(competing, restored, { global: { tactics: { current: true } }, session: { tactics: { private: "different" } } });
	const canonical = captureTemporalFileBases(cwd, "owner", root);
	await assert.rejects(runtime.refreshShared(), /base or scope identity changed concurrently/);
	assert.deepEqual(runtime.view, cached);
	assert.deepEqual(captureTemporalFileBases(cwd, "owner", root), canonical);
});

test("file-backed publication reconciles an untouched shared scope advanced by another session", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-file-drift-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; });
	const a = new TemporalRuntime(cwd, "session-a", root);
	a.prepare();
	const snapshot = emptySnapshot("active");
	a.initialize(snapshot, true);
	publishScopedPatch(a, snapshot, "session", { sessionA: "retained" }, "a-file-seed");
	const b = new TemporalRuntime(cwd, "session-b", root);
	b.prepare();
	b.initialize(emptySnapshot("active"), true);
	publishScopedPatch(b, emptySnapshot("active"), "global", { globalAdvanced: "file" }, "b-file-advance");
	const beforeRefresh = captureTemporalFileBases(cwd, a.sessionId, root);
	assert.equal(await a.refreshShared(), true);
	assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), beforeRefresh);
	assert.deepEqual(temporalScopeRevisions(a.view!), { global: 1, cwd: 0, session: 1 });
	const publication = publishScopedPatch(a, snapshot, "session", { sessionPatch: "applied" }, "a-file-drift")!;
	assert.ok(publication.revision);
	validateTemporalState(a.view!);
	assert.equal(a.read().tactics.globalAdvanced, "file");
	assert.equal(a.read().tactics.sessionA, "retained");
	assert.equal(a.read().tactics.sessionPatch, "applied");
	assert.deepEqual(temporalScopeRevisions(a.view!), { global: 1, cwd: 0, session: 2 });
});

test("file-backed publication repairs a wholly absent untouched CWD pair without resurrecting it", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-file-absence-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; });
	const runtime = new TemporalRuntime(cwd, "session-a", root);
	runtime.prepare();
	const snapshot = emptySnapshot("active");
	runtime.initialize(snapshot, true);
	publishScopedPatch(runtime, snapshot, "cwd", { must_not_resurrect: "old-file-value" }, "file-cwd-seed");
	removeSharedPair(root, cwd, "cwd");
	const publication = publishScopedPatch(runtime, snapshot, "session", { sessionPatch: "applied" }, "file-cwd-repair")!;
	assert.ok(publication.revision);
	assert.equal(runtime.read(0, "cwd").tactics.must_not_resurrect, undefined);
	assert.equal(runtime.read().tactics.sessionPatch, "applied");
	const paths = temporalScopePaths(cwd, "session-a", "cwd", root);
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
});

{
	const { scopes, selections, run, fixture, unchanged } = currentFixture;

	test("aligned current selections retain available history across every subset and retention limit; repeat acceptance is byte-idempotent", async (t) => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t);
			const before = (await loadSelectedFileCohort(f.cwd, f.id, selection, f.root))!;
			const result = await f.refresh(selection, limit);
			assert.equal(result.cohort.view.lineage.length, limit === 0 ? 1 : 2);
			assert.deepEqual(temporalScopeRevisions(result.cohort.view), Object.fromEntries(selection.map(scope => [scope, 1])));
			for (const scope of selection) {
				assert.deepEqual(readTemporalView(result.cohort.view, 0, scope), readTemporalView(before.view, 0, scope));
				assert.deepEqual(result.cohort.provenance[scope], before.provenance[scope]);
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				assert.deepEqual(JSON.parse(readFileSync(paths.meta, "utf8")).opaque, { preserve: scope });
			}
			assert.equal(result.cohort.lifecycle.runtime.meta.step, 7);
			assert.deepEqual(result.cohort.lifecycle.runtime.meta.opaque, { preserve: "lifecycle" });
			assert.equal((await f.refresh(selection, limit)).changed, false);
			assertSelectedFileCohortBasis(result.cohort, (await loadSelectedFileCohort(f.cwd, f.id, selection, f.root))!);
		}
	});

	test("shared drift adopts current selected values/revisions once; excluded shared drift neither reads nor realigns Session-only history", async (t) => {
		for (const selection of selections) {
			const f = await fixture(t);
			await f.drift();
			const privatePaths = temporalScopePaths(f.cwd, f.id, "session", f.root);
			const privateBefore = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta].map(path => [path, readFileSync(path)] as const);
			const result = await f.refresh(selection);
			const shared = selection.some(scope => scope !== "session");
			assert.equal(result.cohort.view.lineage.length, shared ? 1 : 2);
			for (const scope of selection) {
				assert.equal(readTemporalView(result.cohort.view, 0, scope).strategy!.marker, scope === "session" ? "session" : "live");
				assert.equal(result.cohort.view.scopes[scope]!.revision, scope === "session" ? 1 : 2);
			}
			if (shared) assert.throws(() => readTemporalView(result.cohort.view, 1), /predates the proven temporal origin/);
			if (!selection.includes("session")) unchanged(privateBefore);
			assert.equal(result.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
			assert.equal(result.cohort.lifecycle.runtime.meta.step, 7);
			assert.equal((await f.refresh(selection)).changed, false);
		}
	});

	test("newly selected wholly absent shared owners get a current origin, but no Session is acquired implicitly", async (t) => {
		const f = await fixture(t, ["session"]);
		const result = await f.refresh(["cwd", "session"]);
		assert.deepEqual(readTemporalView(result.cohort.view, 0, "cwd"), {});
		assert.deepEqual(temporalScopeRevisions(result.cohort.view), { cwd: 0, session: 1 });
		assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "global", f.root).meta), false);
		const shared = await fixture(t, ["global"]);
		const unacquired = await shared.refresh(["cwd"]);
		assert.equal(unacquired.cohort.lifecycle.runtime.meta.privateAcquisition, "unacquired");
		assert.equal(existsSync(temporalScopePaths(shared.cwd, shared.id, "session", shared.root).meta), false);
		await assert.rejects(shared.refresh(["session"]), /explicit private acquisition/);
		const child = new TemporalRuntime(shared.cwd, "deferred", shared.root);
		await child.withSelectedDeferredForkTransaction(["global"], { mode: "active" }, publish => publish(), undefined, true);
		await child.withSelectedCurrentTransaction(["cwd"], (current, publish) => {
			assert.equal(current.meta.step, 0);
			assert.equal(publish().cohort.lifecycle.runtime.meta.privateAcquisition, "deferred");
		}, () => {});
		await assert.rejects(child.withSelectedCurrentTransaction(["session"], () => assert.fail(), () => {}), /explicit private acquisition/);
	});

	for (const change of ["absent-shared", "drifted-shared"] as const) test(`selection round trip recovers acquired private memory after ${change} origin without excluded writes`, async (t) => {
		const f = await fixture(t, change === "absent-shared" ? ["session"] : ["global", "cwd", "session"]);
		const privatePaths = temporalScopePaths(f.cwd, f.id, "session", f.root);
		const privateBefore = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta].map(path => [path, readFileSync(path)] as const);
		if (change === "drifted-shared") await f.drift();
		const read = fs.readFileSync, excluded = new Set(privateBefore.map(([path]) => path));
		let shared: SelectedFilePublication;
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
			if (excluded.has(String(args[0]))) assert.fail("excluding Session cannot open its bodies to mint private authority");
			return Reflect.apply(read, fs, args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try { shared = await f.refresh(["cwd"], 7, f.owner); }
		finally { fs.readFileSync = read; syncBuiltinESMExports(); }
		assert.equal(shared.cohort.view.lineage.length, 1);
		unchanged(privateBefore);
		assert.equal(shared.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.ok(shared.cohort.lifecycle.runtime.meta.privateCausalBasis);
		const cold = new TemporalRuntime(f.cwd, f.id, f.root);
		const resumed = await f.refresh(["session"], 7, cold);
		assert.equal(readTemporalView(resumed.cohort.view, 0, "session").strategy!.marker, "session");
		assert.equal(resumed.cohort.view.scopes.session!.revision, 1);
		assert.equal(resumed.cohort.lifecycle.runtime.meta.step, 7);
		assert.equal(resumed.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(resumed.cohort.lifecycle.runtime.meta.privateCausalBasis, undefined, "only accepted Session admission retires the detached basis");
		assert.equal((await f.refresh(["session"], 7, cold)).changed, false);
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelected(f.cwd, f.id, ["session"], f.root)!;
			const transition = { id: "new-private-after-return", transitions: [{ scope: "session" as const, patch: { strategy: { marker: "new-private" } } }] };
			transaction.publishSelected(f.cwd, f.id, { view: advanceTemporalState(base.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base, f.root);
		});
		const excludedAgain = await f.refresh(["cwd"], 7, cold);
		assert.equal(excludedAgain.cohort.lifecycle.runtime.meta.privateCausalBasis!.causalWitnesses.at(-1)!.transition.id, "new-private-after-return");
		const fresh = await f.refresh(["session"], 7, cold);
		assert.equal(readTemporalView(fresh.cohort.view).strategy!.marker, "new-private");
		assert.equal(fresh.cohort.view.scopes.session!.revision, 2);
	});

	for (const limit of [0, 1, 7, 100]) test(`existing current/acquisition ports preserve seven-by-seven policy round trips at retention ${limit}`, async (t) => {
		for (const from of selections) for (const to of selections) {
			const f = await fixture(t, from);
			const runtime = new TemporalRuntime(f.cwd, f.id, f.root, undefined, limit);
			await f.refresh(from, limit, runtime);
			const excluded = scopes.filter(scope => !to.includes(scope)).flatMap(scope => {
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				return [paths.checkpoint, paths.patches, paths.meta].map(path => [path, existsSync(path) ? readFileSync(path) : undefined] as const);
			});
			let result: SelectedFilePublication;
			if (!from.includes("session") && to.includes("session")) {
				await assert.rejects(f.refresh(to, limit, runtime), /explicit private acquisition/);
				const base = (await loadSelectedFileCohort(f.cwd, f.id, from, f.root))!;
				await runtime.withSelectedSessionAcquisitionTransaction({ kind: "unacquired", base, selection: to, snapshot: run, historyLimit: limit }, publish => { result = publish(); }, undefined, true);
			} else result = await f.refresh(to, limit, runtime);
			assert.deepEqual(result!.cohort.view.selection, to);
			assert.deepEqual(result!.cohort.lifecycle.runtime.config.scopes, to);
			assert.equal(result!.cohort.lifecycle.runtime.meta.step, 7);
			for (const scope of to) {
				assert.equal(result!.cohort.view.scopes[scope]!.revision, from.includes(scope) ? 1 : 0);
				assert.equal(readTemporalView(result!.cohort.view, 0, scope).strategy?.marker, from.includes(scope) ? scope : undefined);
			}
			for (const [path, bytes] of excluded) {
				if (bytes) assert.deepEqual(readFileSync(path), bytes, path);
				else assert.equal(existsSync(path), false, path);
			}
			const returned = await f.refresh(from, limit, runtime);
			for (const scope of from) assert.equal(readTemporalView(returned.cohort.view, 0, scope).strategy!.marker, scope);
			assert.deepEqual(temporalScopeRevisions(returned.cohort.view), Object.fromEntries(from.map(scope => [scope, 1])));
			assert.equal((await f.refresh(from, limit, runtime)).changed, false);
		}
	});

	test("retained private basis survives shared folding and mode-only Passive; readonly observation and parent copy confer no repair authority", async (t) => {
		const f = await fixture(t);
		const shared = await f.refresh(["cwd"], 7, f.owner);
		const retained = structuredClone(shared.cohort.lifecycle.runtime.meta.privateCausalBasis);
		const privatePaths = temporalScopePaths(f.cwd, f.id, "session", f.root);
		const privateBefore = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta].map(path => [path, readFileSync(path)] as const);
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelected(f.cwd, f.id, ["cwd"], f.root)!;
			const transition = { id: "shared-after-exclusion", transitions: [{ scope: "cwd" as const, patch: { tactics: { progress: true } } }] };
			transaction.publishSelected(f.cwd, f.id, { view: constrainTemporalState(advanceTemporalState(base.view, transition.transitions, transition.id), 0), transition, historyLimit: 0 }, base, f.root);
		});
		const current = await f.refresh(["cwd"], 7, f.owner);
		assert.deepEqual(current.cohort.lifecycle.runtime.meta.privateCausalBasis, retained);
		const runtimeBefore = readFileSync(f.runtimePaths.runtime);
		await f.owner.persistSelectedPassive(() => {});
		assert.deepEqual(readFileSync(f.runtimePaths.runtime), runtimeBefore);
		const bytes = captureTemporalFileBases(f.cwd, f.id, f.root);
		const observer = new TemporalRuntime(f.cwd, f.id, f.root);
		await observer.refreshSelectedCurrent(["session"], () => {});
		assert.equal(observer.readView(0, "session").strategy!.marker, "session");
		assert.equal(observer.selectedView(), undefined);
		assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), bytes);
		const child = new TemporalRuntime(f.cwd, "retained-private-child", f.root);
		let copied: SelectedFilePublication | undefined;
		await child.withSelectedForkCopyTransaction({ kind: "fork-new", source: { id: f.id, key: f.id }, selection: ["session"], snapshot: emptySnapshot("passive"), historyLimit: 7 }, publish => { copied = publish(); }, () => {});
		assert.equal(readTemporalView(copied!.cohort.view).strategy!.marker, "session");
		assert.equal(copied!.cohort.lifecycle.runtime.meta.privateCausalBasis, undefined);
		assert.equal(copied!.cohort.lifecycle.runtime.meta.identity.sessionId, "retained-private-child");
		assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), bytes, "parent copy is read-only and does not retire its proof");
		unchanged(privateBefore);
	});

	test("first exclusion refuses incomplete admitted skeletons instead of discarding the only private authority", async (t) => {
		const f = await fixture(t);
		const metadata = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8"));
		delete metadata.causalWitnesses;
		writeFileSync(f.runtimePaths.runtime, JSON.stringify(metadata));
		const before = captureTemporalFileBases(f.cwd, f.id, f.root);
		await assert.rejects(f.refresh(["cwd"]), /Insufficient.*private causal basis/);
		assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), before);
	});

	test("retained proof cannot admit foreign private bytes, missing ownership witnesses, lost files or old separated sources without proof", async (t) => {
		for (const fault of ["foreign", "witness", "missing-proof", "missing-file", "selected-policy"] as const) {
			const f = await fixture(t, ["session"]); await f.refresh(["cwd"]);
			const paths = temporalScopePaths(f.cwd, f.id, "session", f.root);
			if (fault === "foreign") {
				const foreign = await fixture(t, ["session"]);
				const other = temporalScopePaths(foreign.cwd, foreign.id, "session", foreign.root);
				for (const key of ["checkpoint", "patches", "meta"] as const) writeFileSync(paths[key], readFileSync(other[key]));
			} else if (fault === "missing-file") rmSync(paths.meta);
			else if (fault === "selected-policy") writeFileSync(f.runtimePaths.config, JSON.stringify({ mode: "active", scopes: ["session"] }));
			else {
				const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8"));
				if (fault === "missing-proof") delete meta.privateCausalBasis;
				else {
					const parent = meta.privateCausalBasis.lineage.at(-1);
					const transition = { id: "false-private-claim", parent: parent.id, position: parent.position + 1 };
					meta.privateCausalBasis.lineage.push(transition);
					meta.privateCausalBasis.causalWitnesses.push({ transition, owners: ["session"] });
				}
				writeFileSync(f.runtimePaths.runtime, JSON.stringify(meta));
			}
			const before = captureTemporalFileBases(f.cwd, f.id, f.root);
			await assert.rejects(f.refresh(["session"]));
			assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), before);
		}
	});

	test("shared drift cannot conceal malformed private replay, epochs, lineage, witness syntax or false selected-owner claims", async (t) => {
		for (const failure of ["private", "lineage", "epoch", "null-witness", "owner", "partial-shared"] as const) {
			const f = await fixture(t);
			await f.drift();
			const paths = temporalScopePaths(f.cwd, f.id, "session", f.root);
			const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8"));
			if (failure === "private") writeFileSync(paths.patches, "invalid private replay");
			if (failure === "lineage") { meta.lineage[0].id = "foreign"; meta.lineage[1].parent = "foreign"; }
			if (failure === "epoch") meta.version = 99;
			if (failure === "null-witness") meta.causalWitnesses = null;
			if (failure === "owner") meta.causalWitnesses[0].owners = [];
			if (failure === "partial-shared") rmSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).meta);
			writeFileSync(f.runtimePaths.runtime, JSON.stringify(meta));
			const bytes = readFileSync(f.runtimePaths.runtime);
			await assert.rejects(f.refresh(["global", "cwd", "session"]));
			assert.deepEqual(readFileSync(f.runtimePaths.runtime), bytes);
		}
		const f = await fixture(t, ["global", "session"]);
		// A later Global-only record must not acquire a fictional Session write through its witness metadata.
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelected(f.cwd, f.id, ["global", "session"], f.root)!;
			const transition = { id: "only-global", transitions: [{ scope: "global" as const, patch: { tactics: { progress: "shared-only" } } }] };
			transaction.publishSelected(f.cwd, f.id, { view: advanceTemporalState(base.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base, f.root);
		});
		const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8")); meta.causalWitnesses.at(-1).owners = ["global", "session"];
		writeFileSync(f.runtimePaths.runtime, JSON.stringify(meta)); await f.drift();
		await assert.rejects(f.refresh(["global", "session"]), /missing its selected owner patch/);
	});

	test("legacy complete dependencies convert lifecycle with exact backup; disabled legacy corruption is not bypassed by drift", async (t) => {
		for (const corrupt of [false, true]) {
			const f = await fixture(t);
			await f.drift();
			const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8")); delete meta.privateAcquisition; delete meta.causalWitnesses;
			writeFileSync(f.runtimePaths.runtime, JSON.stringify({ ...meta, version: 1 })); writeFileSync(f.runtimePaths.config, JSON.stringify({ mode: "active" }));
			if (corrupt) writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).meta, "invalid disabled legacy dependency");
			if (corrupt) { await assert.rejects(f.refresh(["session"])); continue; }
			const original = readFileSync(f.runtimePaths.runtime);
			const legacyReader = new TemporalRuntime(f.cwd, f.id, f.root);
			assert.ok(await legacyReader.refreshCurrentMemory());
			assert.ok(legacyReader.view);
			const accepted = await f.refresh(["session"], 7, legacyReader);
			assert.equal(legacyReader.view, undefined);
			assert.deepEqual(legacyReader.readView(), readTemporalView(accepted.cohort.view));
			assert.throws(() => legacyReader.states(), /requires selected runtime operations/);
			assert.ok(accepted.migrationBackup);
			const manifest = JSON.parse(readFileSync(accepted.migrationBackup, "utf8"));
			assert.deepEqual(manifest.lifecycleConversion, { sourceVersion: 1, targetVersion: 2 });
			assert.equal(manifest.files.length, 11);
			assert.ok(manifest.files.some((file: any) => file.path.endsWith("runtime.json") && file.bytes === original.toString("base64")));
			assert.equal(accepted.cohort.basis.files.length, 5);
			assert.equal(accepted.cohort.view.lineage.length, 1);
		}
	});

	test("failed adoption restores exact original bytes; retry preserves opaque provenance and never resets known private authority", async (t) => {
		const f = await fixture(t); await f.drift();
		const original = [f.runtimePaths.config, f.runtimePaths.runtime, ...scopes.flatMap(scope => {
			const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta];
		})].map(path => [path, readFileSync(path)] as const);
		const rename = fs.renameSync; let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === f.runtimePaths.runtime) { injected = true; throw new Error("injected current adoption failure"); } rename(from, to); }; syncBuiltinESMExports();
		try { await assert.rejects(f.refresh(["global", "cwd", "session"]), /injected current adoption failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		unchanged(original);
		const accepted = await f.refresh(["global", "cwd", "session"], 7, f.owner);
		assert.equal(accepted.cohort.provenance.session!["/source.txt"]!.compilerRevision, "current-v1");
		for (const scope of scopes) { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); rmSync(p.checkpoint); rmSync(p.patches); rmSync(p.meta); }
		await assert.rejects(f.owner.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], historyLimit: 7, snapshot: run }, p => p(), undefined, true), /Known/);
		await assert.rejects(f.refresh(["global"], 7, f.owner), /Acquired.*incomplete/);
	});

	test("Off is observational until explicit active acceptance; missing session authority cannot initialize a new origin", async (t) => {
		const f = await fixture(t, ["session"]);
		writeFileSync(f.runtimePaths.config, JSON.stringify({ mode: "off", scopes: ["session"] }));
		const runtime = new TemporalRuntime(f.cwd, f.id, f.root);
		const before = readFileSync(f.runtimePaths.runtime);
		await assert.rejects(runtime.withSelectedCurrentTransaction(["session"], (_current, publish) => publish(), () => {}), /Off cannot accept/);
		assert.deepEqual(readFileSync(f.runtimePaths.runtime), before);
		await runtime.withSelectedCurrentTransaction(["session"], (current, publish) => { current.config.mode = "passive"; assert.equal(publish(current).cohort.lifecycle.runtime.config.mode, "passive"); }, () => {});
		const missingRoot = join(f.root, "never-created");
		await assert.rejects(new TemporalRuntime(f.cwd, "missing", missingRoot).withSelectedCurrentTransaction(["session"], () => assert.fail(), () => {}), /storage is unavailable/);
		assert.equal(existsSync(missingRoot), false);
		await assert.rejects(new TemporalRuntime(f.cwd, "unbound", f.root).withSelectedCurrentTransaction(["global"], () => assert.fail(), () => {}), /current session authority is unavailable/);
	});

	test("current admission captures selection before waiting, then checks current native policy and current lifecycle", async (t) => {
		const f = await fixture(t);
		const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
		const mutable: StateScope[] = ["global", "session"];
		const wanted = mutable as unknown as ScopeSelection;
		const runtime = new TemporalRuntime(f.cwd, f.id, f.root);
		const pending = runtime.withSelectedCurrentTransaction(wanted, (current, publish) => {
			assert.equal(current.meta.step, 8);
			assert.deepEqual(publish().cohort.view.selection, ["global", "session"]);
		}, () => {});
		mutable[0] = "cwd";
		const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8")); writeFileSync(f.runtimePaths.runtime, JSON.stringify({ ...meta, step: 8 }));
		rmSync(lock); await pending;
		// A sticky acquired observation is not erased by a manually downgraded header plus deleted private files.
		for (const path of Object.values(temporalScopePaths(f.cwd, f.id, "session", f.root)).filter(path => /(?:checkpoint|patches|meta)\./.test(path))) rmSync(path);
		const acquired = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8")); writeFileSync(f.runtimePaths.runtime, JSON.stringify({ ...acquired, privateAcquisition: "unacquired" }));
		await assert.rejects(runtime.withSelectedCurrentTransaction(["global"], () => assert.fail(), () => {}), /cannot be downgraded/);
	});

	test("current capabilities are store/lifetime/cancellation guarded; independent policy rechecks and one synchronous publication are required", async (t) => {
		const f = await fixture(t);
		let held: StorageTransaction | undefined;
		await withStorageTransaction(f.root, transaction => {
			held = transaction;
			assert.throws(() => transaction.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, join(f.root, "foreign")), /different store/);
		});
		assert.throws(() => held!.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root), /transaction has ended/);
		const runtime = new TemporalRuntime(f.cwd, f.id, f.root);
		await assert.rejects(runtime.withSelectedCurrentTransaction(["session"], () => assert.fail(), undefined as any), /independent native policy/);
		await assert.rejects(runtime.withSelectedCurrentTransaction(["session"], () => {}, () => {}), /one synchronous publication/);
		let calls = 0;
		await assert.rejects(runtime.withSelectedCurrentTransaction(["session"], (_current, publish) => publish(), () => { if (++calls === 3) throw new Error("revoked native policy"); }), /revoked native policy/);
		await runtime.withSelectedCurrentTransaction(["session"], (_current, publish) => { publish(); assert.throws(publish, /already consumed/); }, () => {});
		const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
		const cancel = new AbortController();
		try {
			const pending = runtime.withSelectedCurrentTransaction(["session"], () => assert.fail(), () => {}, cancel.signal);
			cancel.abort(); await assert.rejects(pending, { name: "AbortError" }); assert.equal(existsSync(lock), true);
		} finally { rmSync(lock); }
	});
}

{
	const { selections, run, fixture, author } = currentAuthorFixture;

	test("cold existing current author atomically stages one selected semantic patch at every selection and retention", async t => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, selection, limit); let calls = 0;
			assert.equal(f.cold.selectedView(), undefined);
			await f.cold.withSelectedCurrentTransaction(selection, (current, _publish, transaction) => {
				calls++; assert.deepEqual(current, run); assert.deepEqual(transaction.snapshot, run); assert.equal(f.cold.selectedView(), undefined);
				assert.deepEqual(transaction.selection, selection); assert.ok(Object.isFrozen(transaction));
				const next = author(transaction); assert.equal(next.meta.step, 5);
			}, () => {});
			assert.equal(calls, 1); assert.equal(f.cold.readView(0, selection[0]).tactics!.firstCurrentMutation, "owned");
			const metadata = JSON.parse(readFileSync(f.paths.runtime, "utf8"));
			assert.equal(metadata.step, 5); assert.equal(metadata.specification, run.meta.specification); assert.deepEqual(metadata.validation, run.meta.validation); assert.equal(metadata.bootstrap, true);
			assert.equal(metadata.privateAcquisition, selection.includes("session") ? "acquired" : "unacquired");
			if (!selection.includes("session")) assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "session", f.root).meta), false);
		}
	});

	test("shared current author preserves acquired excluded private bytes without opening their bodies", async t => {
		for (const selection of selections.filter(value => !value.includes("session"))) {
			const f = await fixture(t, ["global", "cwd", "session"]), privatePaths = temporalScopePaths(f.cwd, f.id, "session", f.root);
			const paths = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta], before = paths.map(path => readFileSync(path)), attempts: string[] = [];
			const read = fs.readFileSync, open = fs.openSync;
			fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { if (paths.includes(String(args[0]))) { attempts.push(String(args[0])); throw new Error("excluded private body read"); } return read(...args); }) as typeof fs.readFileSync;
			fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { if (paths.includes(String(args[0]))) { attempts.push(String(args[0])); throw new Error("excluded private body open"); } return open(...args); }) as typeof fs.openSync; syncBuiltinESMExports();
			try { await f.cold.withSelectedCurrentTransaction(selection, (_current, _publish, transaction) => author(transaction), () => {}); }
			finally { fs.readFileSync = read; fs.openSync = open; syncBuiltinESMExports(); assert.deepEqual(attempts, []); }
			assert.deepEqual(paths.map(path => readFileSync(path)), before);
			assert.equal(JSON.parse(readFileSync(f.paths.runtime, "utf8")).privateAcquisition, "acquired");
		}
	});

	test("current semantic author cannot acquire Session or repair missing required private authority", async t => {
		const f = await fixture(t), before = f.bytes(); let calls = 0;
		await assert.rejects(f.cold.withSelectedCurrentTransaction(["cwd", "session"], () => { calls++; }, () => {}), /explicit private acquisition/);
		assert.equal(calls, 0); assert.deepEqual(f.bytes(), before);
		const acquired = await fixture(t, ["cwd", "session"]), privateMeta = temporalScopePaths(acquired.cwd, acquired.id, "session", acquired.root).meta;
		rmSync(privateMeta); const broken = acquired.bytes();
		await assert.rejects(acquired.cold.withSelectedCurrentTransaction(["cwd"], () => { calls++; }, () => {}));
		assert.equal(calls, 0); assert.deepEqual(acquired.bytes(), broken);
		const child = new TemporalRuntime(f.cwd, "deferred-child", f.root);
		await child.withSelectedDeferredForkTransaction(["cwd"], { mode: "passive" }, publish => publish(), undefined, true);
		const coldChild = new TemporalRuntime(f.cwd, "deferred-child", f.root);
		await coldChild.withSelectedCurrentTransaction(["cwd"], (_current, _publish, transaction) => author(transaction), () => {});
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(f.cwd, "deferred-child", f.root).runtime, "utf8")).privateAcquisition, "deferred");
		assert.equal(existsSync(temporalScopePaths(f.cwd, "deferred-child", "session", f.root).meta), false);
		await assert.rejects(coldChild.withSelectedCurrentTransaction(["session"], () => { calls++; }, () => {}), /explicit private acquisition/);
		assert.equal(calls, 0);
	});

	test("current author publisher is callback-scoped and single-use; acceptance survives a later author failure", async t => {
		for (const outcome of ["none", "throw-before", "throw-after"] as const) {
			const f = await fixture(t), before = f.bytes(); let escaped!: SelectedRuntimePatchTransaction["publish"];
			await assert.rejects(f.cold.withSelectedCurrentTransaction(["cwd"], (_current, _publish, transaction) => {
				escaped = transaction.publish;
				if (outcome === "throw-after") { author(transaction); assert.throws(() => transaction.publish(transaction.snapshot), /already consumed/); }
				if (outcome !== "none") throw new Error("author exit");
			}, () => {}));
			let fields = 0; const late = { get config() { fields++; return run.config; }, get meta() { fields++; return run.meta; } };
			assert.throws(() => escaped(late), /ended/); assert.equal(fields, 0);
			if (outcome === "throw-after") assert.equal(f.cold.readView(0, "cwd").tactics!.firstCurrentMutation, "owned");
			else { assert.deepEqual(f.bytes(), before); assert.equal(f.cold.selectedView(), undefined); }
		}
	});

	test("current author forwards trusted provenance, rejects excluded updates before getters and preserves foreign CAS bytes", async t => {
		const f = await fixture(t), source = "/fixture/source.md";
		await f.cold.withSelectedCurrentTransaction(["cwd"], (_current, _publish, transaction) => {
			const stage = stageSelectedScopePatches(transaction, { cwd: { artifacts: { [source]: { description: "fixture registry" } } } }, [], transaction.causalBasis);
			const next = structuredClone(transaction.snapshot), provenance = { cwd: { [source]: { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "fixture-current-v1", compiledAt: "fixture-stamp" } } };
			commitSelectedTransition(next, transaction, stage, (accepted, snapshot) => transaction.publish(snapshot, accepted, provenance), transaction.causalBasis, { finalizeRun: false });
		}, () => {});
		assert.equal(f.cold.artifactProvenance("cwd")[source].sourceHash, `sha256:${"a".repeat(64)}`);
		const refused = await fixture(t), before = refused.bytes(); let getters = 0;
		await assert.rejects(refused.cold.withSelectedCurrentTransaction(["cwd"], (_current, _publish, transaction) => transaction.publish(transaction.snapshot, undefined, { get session(): never { getters++; throw new Error("excluded provenance getter"); } }), () => {}), /excluded/);
		assert.equal(getters, 0); assert.deepEqual(refused.bytes(), before);
		const conflict = await fixture(t), checkpoint = temporalScopePaths(conflict.cwd, conflict.id, "cwd", conflict.root).checkpoint;
		await assert.rejects(conflict.cold.withSelectedCurrentTransaction(["cwd"], (_current, _publish, transaction) => { writeFileSync(checkpoint, '{"strategy":{"foreign":true}}\n'); author(transaction); }, () => {}), /changed|concurrent/i);
		assert.equal(readFileSync(checkpoint, "utf8"), '{"strategy":{"foreign":true}}\n'); assert.equal(conflict.cold.selectedView(), undefined);
	});
}

{
	const { fixture, seed, create } = originFixture;

	test("new shared-only origin initializes exactly the chosen scopes across Active/Passive without any private semantic owner", async (t) => {
		for (const selection of [["global"], ["cwd"], ["global", "cwd"]] as const) for (const mode of ["active", "passive"] as const) {
			const f = fixture(t);
			const accepted = await create(f, selection, mode);
			assert.equal(accepted.cohort.lifecycle.sourceVersion, 2);
			assert.equal(accepted.cohort.lifecycle.runtime.config.mode, mode);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "unacquired");
			assert.deepEqual(accepted.cohort.view.selection, selection);
			assert.deepEqual(Object.keys(accepted.cohort.view.scopes), selection);
			assert.deepEqual(temporalScopeRevisions(accepted.cohort.view), Object.fromEntries(selection.map((scope) => [scope, 0])));
			assert.equal(accepted.cohort.view.lineage.length, 1);
			assert.equal(accepted.cohort.view.lineage[0]!.position, 0);
			assert.equal(accepted.cohort.basis.files.length, 2 + 3 * selection.length);
			assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.id, captureScopeSelection(selection), f.root))!);
			for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
			for (const scope of ["global", "cwd"] as const) {
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				assert.equal(existsSync(paths.checkpoint), (selection as readonly string[]).includes(scope));
			}
			assert.equal(f.runtime.view, undefined, "selected cache must not impersonate a legacy three-owner view");
			assert.equal(existsSync(`${f.root}-migration-backups`), false);
		}
	});

	test("missing authority, Off, invalid run fields and Session selection cannot even create the absent root", async (t) => {
		for (const kind of ["authority", "off", "scope", "invalid", "canceled"] as const) {
			const f = fixture(t);
			const snapshot = emptySnapshot(kind === "off" ? "off" : "active");
			if (kind === "invalid") (snapshot.meta as any).privateAcquisition = "unacquired";
			const controller = new AbortController();
			if (kind === "canceled") controller.abort();
			await assert.rejects(f.runtime.withSelectedSharedOriginTransaction(kind === "scope" ? ["session"] : ["cwd"], snapshot,
				() => assert.fail("unauthorized callback"), controller.signal, kind !== "authority"));
			assert.equal(existsSync(f.root), false);
		}
	});

	test("adopts selected current shared values/revisions at a fresh history origin while disabled corruption is neither opened nor rewritten", async (t) => {
		const f = fixture(t);
		seed(f, "cwd");
		const hidden = seed(f, "global");
		writeFileSync(hidden.paths.checkpoint, Buffer.from([0xff]));
		writeFileSync(hidden.paths.meta, "unrelated-bad-metadata");
		const originalOpen = fs.openSync;
		const opened: string[] = [];
		fs.openSync = ((path: fs.PathLike, ...args: any[]) => { opened.push(String(path)); return (originalOpen as any)(path, ...args); }) as typeof fs.openSync;
		syncBuiltinESMExports();
		let accepted: SelectedFilePublication;
		try { accepted = await create(f, ["cwd"]); }
		finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
		for (const path of [hidden.paths.checkpoint, hidden.paths.patches, hidden.paths.meta]) assert.equal(opened.includes(path), false);
		assert.deepEqual(readFileSync(hidden.paths.checkpoint), Buffer.from([0xff]));
		assert.equal(readFileSync(hidden.paths.meta, "utf8"), "unrelated-bad-metadata");
		assert.deepEqual(readTemporalView(accepted.cohort.view), { strategy: { retained: "cwd" }, tactics: { step: "before-origin" } });
		assert.deepEqual(temporalScopeRevisions(accepted.cohort.view), { cwd: 1 });
		assert.equal(accepted.cohort.view.lineage.length, 1);
		assert.equal(accepted.cohort.view.lineage[0]!.position, 2);
		assert.throws(() => readTemporalView(accepted.cohort.view, 1));
		assert.deepEqual(JSON.parse(readFileSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).meta, "utf8")).foreign, { keep: true });
	});

	test("mixed absent/live shared owners and independent peer streams adopt without reusing a causal identity", async (t) => {
		for (const present of [["global"], ["cwd"], ["global", "cwd"]] as const) {
			const f = fixture(t);
			for (const scope of present) seed(f, scope);
			const result = await create(f, ["global", "cwd"]);
			assert.equal(result.cohort.view.lineage.length, 1);
			assert.deepEqual(temporalScopeRevisions(result.cohort.view), Object.fromEntries(["global", "cwd"].map((scope) => [scope, (present as readonly string[]).includes(scope) ? 1 : 0])));
			assertSelectedFileCohortBasis(result.cohort, (await loadSelectedFileCohort(f.cwd, f.id, ["global", "cwd"], f.root))!);
			for (const scope of present) assert.equal(readTemporalView(result.cohort.view, 0, scope).strategy!.retained, scope);
		}
	});

	test("every partial selected scope, retired layout and private/lifecycle survivor refuses rather than initializes", async (t) => {
		for (const missing of ["checkpoint", "patches", "meta"] as const) {
			const f = fixture(t);
			const source = seed(f, "cwd");
			rmSync(source.paths[missing]);
			await assert.rejects(create(f, ["cwd"]), /complete or wholly absent/);
			assert.equal(existsSync(f.paths.config), false);
		}
		for (const kind of ["orphan-meta", "retired", "private", "config", "runtime", "symlink"] as const) {
			const f = fixture(t);
			const paths = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
			mkdirSync(kind === "private" || kind === "config" || kind === "runtime" ? f.privatePaths.directory : paths.directory, { recursive: true });
			if (kind === "orphan-meta") writeFileSync(paths.meta, "{}");
			if (kind === "retired") writeFileSync(join(paths.directory, "state.json"), "secret");
			if (kind === "private") writeFileSync(f.privatePaths.checkpoint, "private-survivor");
			if (kind === "config") writeFileSync(f.paths.config, '{"mode":"active"}');
			if (kind === "runtime") writeFileSync(f.paths.runtime, "{}");
			if (kind === "symlink") fs.symlinkSync(join(f.parent, "outside"), paths.checkpoint);
			await assert.rejects(create(f, ["cwd"]));
			assert.equal(existsSync(`${f.root}-migration-backups`), false);
			if (kind === "private") assert.equal(readFileSync(f.privatePaths.checkpoint, "utf8"), "private-survivor");
		}
	});

	test("legacy selected shared conversion is backed up with absent lifecycle and presence evidence; interruption rolls back and retry reuses that backup", async (t) => {
		const f = fixture(t);
		const source = seed(f, "cwd", true);
		const target = f.paths.runtime;
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === target) { injected = true; throw new Error("injected origin publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(create(f, ["cwd"]), /injected origin publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		for (const [path, bytes] of source.original) assert.deepEqual(readFileSync(path), bytes);
		assert.equal(existsSync(f.paths.config), false);
		assert.equal(existsSync(f.paths.runtime), false);
		const directory = `${f.root}-migration-backups`;
		assert.equal(readdirSync(directory).length, 1);
		const result = await create(f, ["cwd"]);
		assert.ok(result.migrationBackup);
		assert.equal(readdirSync(directory).length, 1, "fresh origin ids must not make exact-source retry backups diverge");
		const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.deepEqual(manifest.convertedScopes, ["cwd"]);
		assert.equal(manifest.lifecycleConversion, undefined);
		assert.equal(manifest.files.length, 5);
		assert.equal(manifest.files.filter((file: any) => file.bytes === null).length, 2);
		assert.ok(manifest.presenceDependencies.every((file: any) => file.present === false));
		assert.equal(result.cohort.lifecycle.runtime.meta.privateAcquisition, "unacquired");
		assert.deepEqual(temporalScopeRevisions(result.cohort.view), { cwd: 1 });
	});

	test("accepted or remembered session authority cannot become a new origin after its files disappear", async (t) => {
		const f = fixture(t);
		await create(f, ["cwd"]);
		rmSync(f.paths.config); rmSync(f.paths.runtime);
		await assert.rejects(create(f, ["cwd"]), /Known.*current-memory acceptance/);
		await assert.rejects(f.runtime.withStartTransaction(() => assert.fail("legacy acquisition"), undefined, true), /selected runtime integration/);
		const existing = fixture(t);
		existing.runtime.initialize(emptySnapshot("active"), true);
		const paths = [existing.paths.config, existing.paths.runtime, existing.privatePaths.checkpoint, existing.privatePaths.patches, existing.privatePaths.meta];
		for (const path of paths) rmSync(path);
		assert.equal(existing.runtime.loadPassive(), true, "shared inspection cannot forget the prior private authority");
		await assert.rejects(create(existing, ["cwd"]), /Known.*current-memory acceptance/);
	});

	test("callback-owned origin acceptance is synchronous, single-use and cancelable before held exclusion releases", async (t) => {
		const f = fixture(t);
		let retained: (() => SelectedFilePublication) | undefined;
		await f.runtime.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), (publish) => {
			retained = publish;
			publish();
			assert.throws(publish, /already consumed/);
		}, undefined, true);
		assert.throws(retained!, /already consumed/);
		const empty = fixture(t);
		await assert.rejects(empty.runtime.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), () => {}, undefined, true), /one synchronous publication/);
		assert.equal(existsSync(empty.paths.runtime), false);
		const lock = join(empty.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const pending = empty.runtime.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), () => assert.fail("withdrawn callback"), controller.signal, true);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(existsSync(empty.paths.runtime), false);
			assert.equal(existsSync(lock), true);
		} finally { rmSync(lock); }
	});
}

{
	const scopes = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));

	async function fixture(t: TestContext, selection: ScopeSelection = ["global", "cwd", "session"], mode: "active" | "passive" = "active", limit = 7) {
		const directory = mkdtempSync(join(tmpdir(), "state-flow-selected-runtime-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const cwd = join(directory, "cwd"), root = join(directory, "store"), id = "owner";
		const runtime = new TemporalRuntime(cwd, id, root, undefined, limit);
		let accepted: SelectedFilePublication | undefined;
		if (selection.includes("session")) await runtime.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot: emptySnapshot(mode), historyLimit: limit }, publish => { accepted = publish(); }, undefined, true);
		else await runtime.withSelectedSharedOriginTransaction(selection, emptySnapshot(mode), publish => { accepted = publish(); }, undefined, true);
		const patch = async (label: string, owners: ScopeSelection = selection) => withStorageTransaction(root, transaction => {
			const base = transaction.prepareSelected(cwd, id, selection, root)!;
			const transition = { id: label, transitions: owners.map(scope => ({ scope, patch: {
				strategy: { layer: scope, label }, tactics: { nested: { label } },
				...(scope === "session" ? { response: `answer-${label}` } : {}),
			} })) };
			return transaction.publishSelected(cwd, id, { view: advanceTemporalState(base.view, transition.transitions, transition.id, limit), transition, historyLimit: limit }, base, root);
		});
		const refresh = async (wanted: ScopeSelection = selection) => {
			let result: SelectedFilePublication | undefined;
			await runtime.withSelectedCurrentTransaction(wanted, (_current, publish) => { result = publish(); }, () => {});
			return result!;
		};
		return { cwd, root, id, runtime, accepted: accepted!, patch, refresh };
	}

	test("owned selected acceptance installs exactly the selected owners across Active/Passive; sparse/effective/history reads use one cache", async (t) => {
		for (const selection of selections) for (const mode of ["active", "passive"] as const) {
			const f = await fixture(t, selection, mode);
			assert.equal(f.runtime.view, undefined, "selected values never become a legacy three-owner view");
			assert.deepEqual(f.runtime.selectedView()!.selection, selection);
			assert.deepEqual(Object.keys(f.runtime.selectedStates().states), selection);
			assert.deepEqual(f.runtime.readView(), {});
			assert.equal(f.runtime.read().response, "");
			await f.patch("first");
			assert.deepEqual(f.runtime.readView(), {}, "external writes do not silently replace accepted cached values");
			await f.refresh();
			assert.equal(f.runtime.readView().strategy!.layer, selection.at(-1));
			assert.equal(f.runtime.read().strategy.layer, selection.at(-1));
			assert.equal(f.runtime.readView().response, selection.includes("session") ? "answer-first" : undefined);
			assert.deepEqual(f.runtime.readView(1), {});
			assert.deepEqual(f.runtime.selectedStates(1).states, Object.fromEntries(selection.map(scope => [scope, {}])));
			assert.equal(f.runtime.causalBasis(), "first");
			assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), Object.fromEntries(selection.map(scope => [scope, 1])));
			for (const scope of scopes) {
				if (selection.includes(scope)) {
					assert.equal(f.runtime.readView(0, scope).strategy!.layer, scope);
					assert.deepEqual(f.runtime.artifactProvenance(scope), {});
				} else {
					assert.throws(() => f.runtime.read(0, scope), /scope is excluded/);
					assert.throws(() => f.runtime.readView(0, scope), /scope is excluded/);
					assert.throws(() => f.runtime.artifactProvenance(scope), /scope is excluded/);
				}
			}
			assert.throws(() => f.runtime.states(), /requires selected runtime operations/);
		}
	});

	test("selected cached reads honor retention and current-origin adoption without fabricated aligned past", async (t) => {
		for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, ["global", "session"], "active", limit);
			await f.patch("retained"); await f.refresh();
			if (limit === 0) assert.throws(() => f.runtime.readView(1));
			else assert.deepEqual(f.runtime.readView(1), {});
			const peer = new TemporalRuntime(f.cwd, "peer", f.root, undefined, limit);
			await peer.withSelectedSharedOriginTransaction(["global"], emptySnapshot("active"), publish => publish(), undefined, true);
			await withStorageTransaction(f.root, transaction => {
				const base = transaction.prepareSelected(f.cwd, "peer", ["global"], f.root)!;
				const transition = { id: "peer-drift", transitions: [{ scope: "global" as const, patch: { tactics: { peer: true } } }] };
				transaction.publishSelected(f.cwd, "peer", { view: advanceTemporalState(base.view, transition.transitions, transition.id, limit), transition, historyLimit: limit }, base, f.root);
			});
			assert.equal(f.runtime.readView(0, "session").strategy!.label, "retained");
			await f.refresh();
			assert.equal(f.runtime.selectedView()!.lineage.length, 1);
			assert.throws(() => f.runtime.readView(1));
			assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), { global: 2, session: 1 });
		}
	});

	test("excluded-only witnesses retain read offsets but never expose excluded semantic patches in recent output", async (t) => {
		const f = await fixture(t);
		await f.patch("shared-and-private"); await f.patch("private-only", ["session"]);
		await f.refresh(["global"]);
		assert.equal(f.runtime.readView().strategy!.label, "shared-and-private");
		assert.equal(f.runtime.readView(1).strategy!.label, "shared-and-private");
		assert.deepEqual(f.runtime.readView(2), {});
		assert.equal(f.runtime.selectedView()!.causalBasis.length, 1);
		assert.deepEqual(f.runtime.recent().map(item => item.id), ["shared-and-private"]);
		assert.ok(f.runtime.recent().every(item => item.transitions.every(patch => patch.scope === "global")));
		assert.deepEqual(f.runtime.selectedStates().selection, ["global"]);
	});

	test("accepted receipts, projections, staging values and per-owner provenance cannot alias installed cache", async (t) => {
		const f = await fixture(t, ["global", "session"]);
		f.accepted.cohort.view.scopes.global!.checkpoint.state = { strategy: { forged: true } };
		f.accepted.cohort.view.selection = ["session"];
		f.accepted.cohort.provenance.global = { "/forged": { compilerRevision: "forged" } };
		assert.deepEqual(f.runtime.readView(), {});
		assert.deepEqual(f.runtime.selectedStates().selection, ["global", "session"]);
		assert.deepEqual(f.runtime.artifactProvenance("global"), {});
		await f.patch("detached");
		const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
		writeFileSync(paths.meta, JSON.stringify({ ...meta, artifacts: { "/source": { compilerRevision: "owned" } } }));
		const receipt = await f.refresh();
		const staged = f.runtime.selectedStates();
		assert.equal(Object.isFrozen(staged.selection), true);
		staged.states.global!.strategy!.layer = "forged";
		f.runtime.selectedView()!.scopes.global!.patches.length = 0;
		f.runtime.read().tactics.nested = { forged: true };
		f.runtime.readView().strategy!.layer = "forged";
		f.runtime.recent()[0]!.transitions[0]!.patch.strategy = { forged: true };
		f.runtime.artifactProvenance("global")["/source"]!.compilerRevision = "forged";
		receipt.cohort.view.scopes.global!.patches.length = 0;
		assert.equal(f.runtime.readView(0, "global").strategy!.layer, "global");
		assert.equal(f.runtime.readView().tactics!.nested && (f.runtime.readView().tactics!.nested as any).label, "detached");
		assert.equal(f.runtime.artifactProvenance("global")["/source"]!.compilerRevision, "owned");
	});

	test("cached inspection performs no I/O; legacy acquisition/checkpoint paths fail before excluded-body observation and remain fenced after clearing", async (t) => {
		const f = await fixture(t, ["cwd"]);
		await f.patch("local"); await f.refresh();
		const open = fs.openSync, stat = fs.lstatSync;
		let observed = 0;
		fs.openSync = (() => { observed++; throw new Error("unexpected cached read I/O"); }) as typeof fs.openSync;
		fs.lstatSync = (() => { observed++; throw new Error("unexpected cached stat I/O"); }) as typeof fs.lstatSync;
		syncBuiltinESMExports();
		try {
			assert.equal(f.runtime.readView().strategy!.layer, "cwd");
			assert.equal(f.runtime.selectedStates().states.cwd!.strategy!.label, "local");
			assert.deepEqual(f.runtime.artifactProvenance("cwd"), {});
			f.runtime.selectedView(); f.runtime.recent(); f.runtime.causalBasis();
			assert.throws(() => f.runtime.loadPassive(), /requires selected runtime operations/);
			await assert.rejects(f.runtime.refreshCurrentMemory(), /requires selected runtime operations/);
			await assert.rejects(f.runtime.refreshShared(), /requires selected runtime operations/);
			assert.throws(() => f.runtime.retainedCheckpoint(emptySnapshot("active")), /requires selected runtime operations/);
			const legacy = createTemporalState({ global: {}, cwd: {}, session: {} }, "forged-legacy");
			assert.throws(() => { f.runtime.view = legacy; }, /requires selected runtime operations/);
			f.runtime.view = undefined;
			assert.equal(f.runtime.selectedView(), undefined);
			assert.throws(() => f.runtime.readView(), /runtime is unavailable/);
			assert.throws(() => f.runtime.selectedStates(), /runtime is unavailable/);
			assert.throws(() => f.runtime.artifactProvenance("session"), /requires selected runtime operations/);
			assert.throws(() => f.runtime.loadPassive(), /requires selected runtime operations/);
			assert.equal(observed, 0);
		} finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
	});

	test("publication failure, cancellation and abandoned candidates preserve the old cache; accepted publication survives caller failure", async (t) => {
		const f = await fixture(t, ["global", "session"]);
		await f.patch("accepted-old"); await f.refresh();
		const before = f.runtime.selectedView();
		await f.patch("disk-new");
		await assert.rejects(f.runtime.withSelectedCurrentTransaction(["session"], () => {}, () => {}), /one synchronous publication/);
		assert.deepEqual(f.runtime.selectedView(), before);
		const paths = sessionRuntimePaths(f.cwd, f.id, f.root);
		const rename = fs.renameSync; let failed = false;
		fs.renameSync = (from, to) => { if (!failed && to === paths.runtime) { failed = true; throw new Error("cache install publication failure"); } rename(from, to); }; syncBuiltinESMExports();
		try { await assert.rejects(f.refresh(["session"]), /cache install publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.deepEqual(f.runtime.selectedView(), before);
		const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
		const cancel = new AbortController();
		try {
			const pending = f.runtime.withSelectedCurrentTransaction(["session"], () => assert.fail(), () => {}, cancel.signal);
			cancel.abort(); await assert.rejects(pending, { name: "AbortError" });
			assert.deepEqual(f.runtime.selectedView(), before);
		} finally { rmSync(lock); }
		await assert.rejects(f.runtime.withSelectedCurrentTransaction(["session"], (_current, publish) => { publish(); throw new Error("after acceptance"); }, () => {}), /after acceptance/);
		assert.deepEqual(f.runtime.selectedStates().selection, ["session"]);
		assert.equal(f.runtime.readView().strategy!.label, "disk-new");
	});

	test("first acquisition and deferred fork copy replace the selected variant only after private acceptance", async (t) => {
		const f = await fixture(t, ["global"]);
		await f.runtime.withSelectedSessionAcquisitionTransaction({ kind: "unacquired", base: f.accepted.cohort, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), undefined, true);
		assert.deepEqual(f.runtime.selectedStates().states, { session: {} });
		assert.throws(() => f.runtime.readView(0, "global"), /scope is excluded/);
		const parent = await fixture(t, ["session"]);
		await parent.patch("parent-current");
		const child = new TemporalRuntime(parent.cwd, "child", parent.root);
		let deferred: SelectedFilePublication | undefined;
		await child.withSelectedDeferredForkTransaction(["global"], { mode: "active" }, publish => { deferred = publish(); }, undefined, true);
		assert.deepEqual(child.selectedStates().selection, ["global"]);
		assert.throws(() => child.readView(0, "session"), /scope is excluded/);
		await child.withSelectedForkCopyTransaction({ kind: "fork-deferred", base: deferred!.cohort, source: { id: parent.id, key: parent.id }, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), () => {});
		assert.deepEqual(child.selectedStates().selection, ["session"]);
		assert.equal(child.readView().strategy!.label, "parent-current");
		assert.equal(child.readView().response, "answer-parent-current");
		assert.throws(() => child.readView(1));
	});

	test("read-only file candidates do not install a runtime and cleared selected caches need new owned acceptance", async (t) => {
		const f = await fixture(t, ["session"]);
		const cold = new TemporalRuntime(f.cwd, f.id, f.root);
		await withStorageTransaction(f.root, transaction => transaction.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root));
		assert.equal(cold.selectedView(), undefined);
		assert.throws(() => cold.selectedStates(), /runtime is unavailable/);
		await cold.withSelectedCurrentTransaction(["session"], (_current, publish) => publish(), () => {});
		assert.deepEqual(cold.selectedStates().states, { session: {} });
		cold.view = undefined;
		await assert.rejects(cold.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), undefined, true), /Known/);
		await cold.withSelectedCurrentTransaction(["session"], (_current, publish) => publish(), () => {});
		assert.deepEqual(cold.selectedStates().states, { session: {} });
	});
}

{
	const { scopes, selections, fixture, files, unchanged, withoutBodies, legacyLifecycle } = lifecycleFixture;

	test("header-only lifecycle inspection distinguishes stored selection and acquisition without semantic IO, cache or publication", async t => {
		for (const selection of selections) {
			const f = await fixture(t, selection), before = files(f);
			const cold = new TemporalRuntime(f.cwd, f.id, f.root);
			const bodies = scopes.flatMap(scope => { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; });
			await withoutBodies(bodies, async () => {
				for (const wanted of selections) {
					const inspection = await cold.inspectSelectedLifecycle(wanted, () => {});
					assert.deepEqual(inspection!.selection, selection);
					assert.equal(Object.isFrozen(inspection!.selection), true);
					assert.equal(inspection!.privateAcquisition, selection.includes("session") ? "acquired" : "unacquired");
					assert.deepEqual(inspection!.snapshot, f.runtime.selectedSnapshot());
					inspection!.snapshot.meta.step = 999;
					assert.equal((await cold.inspectSelectedLifecycle(wanted, () => {}))!.snapshot.meta.step, 1);
					assert.equal(await cold.hasSelectedCurrentAuthority(wanted, () => {}), true);
					assert.equal(cold.selectedView(), undefined);
					assert.throws(() => cold.selectedSnapshot(), /unavailable/);
				}
			});
			unchanged(before);
		}
		const directory = mkdtempSync(join(tmpdir(), "state-flow-header-deferred-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
		const root = join(directory, "missing"), cold = new TemporalRuntime(directory, "deferred", root);
		assert.equal(await cold.inspectSelectedLifecycle(["session"], () => {}), undefined);
		assert.equal(existsSync(root), false);
		await cold.withSelectedDeferredForkTransaction(["cwd"], { mode: "passive", bootstrap: true }, p => p(), undefined, true);
		const reader = new TemporalRuntime(directory, "deferred", root);
		const inspected = await reader.inspectSelectedLifecycle(["session"], () => {});
		assert.equal(inspected!.privateAcquisition, "deferred"); assert.deepEqual(inspected!.selection, ["cwd"]);
		assert.deepEqual(inspected!.snapshot, { config: { mode: "passive" }, meta: { step: 0, bootstrap: true } });
		assert.equal(reader.selectedView(), undefined);
		await assert.rejects(reader.withSelectedCurrentTransaction(["session"], () => {}, () => {}), /explicit private acquisition/);
	});

	test("header inspection validates admission before projection and retains denial-only knowledge of lost private authority", async t => {
		const f = await fixture(t, ["session"]), cold = new TemporalRuntime(f.cwd, f.id, f.root), life = sessionRuntimePaths(f.cwd, f.id, f.root);
		await cold.inspectSelectedLifecycle(["cwd"], () => {});
		const original = readFileSync(life.runtime, "utf8"), malformed = JSON.parse(original);
		malformed.version = 999; writeFileSync(life.runtime, JSON.stringify(malformed));
		await assert.rejects(cold.inspectSelectedLifecycle(["cwd"], () => {}), /unsupported|Unsupported|version/i);
		writeFileSync(life.runtime, original);
		const replacementRoot = join(f.root, "replacement"), replacement = new TemporalRuntime(f.cwd, f.id, replacementRoot);
		await replacement.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), p => p(), undefined, true);
		const replacementLife = sessionRuntimePaths(f.cwd, f.id, replacementRoot);
		writeFileSync(life.config, readFileSync(replacementLife.config)); writeFileSync(life.runtime, readFileSync(replacementLife.runtime));
		const privatePaths = temporalScopePaths(f.cwd, f.id, "session", f.root);
		for (const path of [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta]) rmSync(path);
		await assert.rejects(cold.inspectSelectedLifecycle(["cwd"], () => {}), /cannot be downgraded/);
		assert.equal((await new TemporalRuntime(f.cwd, f.id, f.root).inspectSelectedLifecycle(["cwd"], () => {}))!.privateAcquisition, "unacquired");
		assert.equal(cold.selectedView(), undefined);
		await assert.rejects(cold.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), p => p(), undefined, true), /authority|origin|Known/i);
		rmSync(life.config); rmSync(life.runtime);
		await assert.rejects(cold.inspectSelectedLifecycle(["cwd"], () => {}), /authority is unavailable/);
	});

	test("header inspection waits cancelably and withdraws before header IO after native ownership changes", async t => {
		const f = await fixture(t), cold = new TemporalRuntime(f.cwd, f.id, f.root), before = files(f);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
		t.after(() => release());
		const lock = withStorageTransaction(f.root, async () => { entered(); await gate; }); await held;
		const life = sessionRuntimePaths(f.cwd, f.id, f.root);
		await withoutBodies([life.config, life.runtime], async () => {
			const controller = new AbortController();
			const canceled = assert.rejects(cold.inspectSelectedLifecycle(["cwd"], () => {}, controller.signal), (error: unknown) => error instanceof Error
				&& ((error.name === "AbortError" && error.cause instanceof Error && error.cause.message === "cancel inspection") || error.message === "cancel inspection"));
			controller.abort(new Error("cancel inspection")); await canceled;
			let current = true;
			const stale = assert.rejects(cold.inspectSelectedLifecycle(["cwd"], () => { if (!current) throw new Error("old native selection"); }), /old native selection/);
			current = false; release(); await lock; await stale;
		});
		assert.equal(cold.selectedView(), undefined); unchanged(before);
	});

	test("selected Passive mode-only persistence preserves every owner/window, run fields, semantic bytes and provenance", async t => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, selection, limit);
			const life = sessionRuntimePaths(f.cwd, f.id, f.root);
			const snapshot = f.runtime.selectedSnapshot(), view = f.runtime.selectedView();
			const provenance = selection.map(scope => f.runtime.artifactProvenance(scope));
			const before = files(f).filter(([path]) => path !== life.config);
			const publication = await f.runtime.persistSelectedPassive(() => {});
			assert.equal(publication.changed, true); assert.equal(publication.migrationBackup, undefined);
			assert.deepEqual(f.runtime.selectedSnapshot(), { ...snapshot, config: { mode: "passive" } });
			assert.deepEqual(f.runtime.selectedView(), view); unchanged(before);
			assert.deepEqual(selection.map(scope => f.runtime.artifactProvenance(scope)), provenance);
			assert.deepEqual(JSON.parse(readFileSync(life.config, "utf8")), { mode: "passive", scopes: selection });
			assert.equal(publication.cohort.lifecycle.runtime.meta.privateAcquisition, selection.includes("session") ? "acquired" : "unacquired");
			publication.cohort.lifecycle.runtime.meta.step = 999;
			publication.cohort.view.lineage[0]!.id = "caller-mutated";
			assert.equal(f.runtime.selectedSnapshot().meta.step, 1); assert.deepEqual(f.runtime.selectedView(), view);
			assert.equal((await f.runtime.persistSelectedPassive(() => {})).changed, false);
		}
	});

	test("accepted selected run/checkpoint capture is detached and I/O-free; mode-only native bookkeeping grants no canonical change", async t => {
		for (const selection of selections) {
			const f = await fixture(t, selection), before = files(f), expected = f.runtime.selectedSnapshot();
			await withoutBodies(before.map(([path]) => path), async () => {
				for (const mode of ["active", "passive", "off"] as const) {
					const checkpoint = f.runtime.retainedSelectedCheckpoint(mode);
					assert.deepEqual(prepareRetainedPolicyMigration(checkpoint, ["session"]).checkpoint, checkpoint);
					assert.equal("boundary" in checkpoint && checkpoint.boundary, f.runtime.causalBasis());
					assert.equal(checkpoint.mode, mode); assert.deepEqual(checkpoint.scopes, selection);
					assert.equal("validation" in checkpoint, false); assert.equal("bootstrap" in checkpoint, false);
				}
				const snapshot = f.runtime.selectedSnapshot(); snapshot.meta.validation!.error = "mutated"; snapshot.meta.step = 999;
				assert.deepEqual(f.runtime.selectedSnapshot(), expected);
			});
			assert.equal(f.runtime.retainedSelectedCheckpoint().mode, "active"); unchanged(before);
		}
		const missing = new TemporalRuntime("/absent", "owner", "/absent/state-flow-selected-test");
		assert.throws(() => missing.selectedSnapshot(), /selected.*unavailable/i);
		assert.throws(() => missing.retainedSelectedCheckpoint("off"), /selected.*unavailable/i);
		await assert.rejects(missing.persistSelectedPassive(() => {}), /selected.*unavailable/i);
	});

	test("mode-only persistence omits disabled acquired bodies and never converts or maintains excluded sources", async t => {
		const f = await fixture(t, scopes);
		await f.runtime.withSelectedCurrentTransaction(["cwd"], (_s, publish) => publish(), () => {});
		const omitted = ["global", "session"] as const;
		const paths = omitted.flatMap(scope => { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; });
		for (const path of paths) writeFileSync(path, `unreadable omitted body ${path}`);
		const before = paths.map(path => [path, readFileSync(path)] as const);
		await withoutBodies(paths, () => f.runtime.persistSelectedPassive(() => {}));
		unchanged(before); assert.deepEqual(f.runtime.selectedView()!.selection, ["cwd"]);
	});

	test("mode-only Passive persistence preserves deferred forks without acquiring Session or parent authority", async t => {
		const f = await fixture(t, ["cwd"]), child = new TemporalRuntime(f.cwd, "child", f.root);
		await child.withSelectedDeferredForkTransaction(["cwd"], { mode: "active", bootstrap: true }, p => p(), undefined, true);
		const snapshot = child.selectedSnapshot(), view = child.selectedView();
		const receipt = await child.persistSelectedPassive(() => {});
		assert.equal(receipt.cohort.lifecycle.runtime.meta.privateAcquisition, "deferred");
		assert.deepEqual(child.selectedSnapshot(), { ...snapshot, config: { mode: "passive" } });
		assert.deepEqual(child.selectedView(), view);
		const checkpoint = child.retainedSelectedCheckpoint();
		assert.equal("bootstrap" in checkpoint && checkpoint.bootstrap, true);
		const p = temporalScopePaths(f.cwd, "child", "session", f.root);
		for (const path of [p.checkpoint, p.patches, p.meta]) assert.equal(existsSync(path), false);
	});

	test("Passive persistence refuses stale selected shared bytes/removal, lifecycle and lost private presence without adoption or repair", async t => {
		for (const kind of ["shared-drift", "shared-removal", "lifecycle", "private-loss"] as const) {
			const f = await fixture(t), p = temporalScopePaths(f.cwd, f.id, "global", f.root);
			if (kind === "shared-drift") writeFileSync(p.meta, readFileSync(p.meta, "utf8") + " ");
			if (kind === "shared-removal") for (const path of [p.checkpoint, p.patches, p.meta]) rmSync(path);
			if (kind === "lifecycle") { const path = sessionRuntimePaths(f.cwd, f.id, f.root).runtime; writeFileSync(path, readFileSync(path, "utf8") + " "); }
			if (kind === "private-loss") rmSync(temporalScopePaths(f.cwd, f.id, "session", f.root).checkpoint);
			const before = files(f), snapshot = f.runtime.selectedSnapshot(), view = f.runtime.selectedView();
			await assert.rejects(f.runtime.persistSelectedPassive(() => {}), /changed concurrently|unavailable|incomplete/);
			unchanged(before); assert.deepEqual(f.runtime.selectedView(), view); assert.deepEqual(f.runtime.selectedSnapshot(), snapshot);
			if (kind === "shared-removal") assert.equal(existsSync(p.checkpoint), false);
		}
	});

	test("changed lifecycle epochs refuse Passive persistence before semantic bodies", async t => {
		const { f, before, bodies } = await legacyLifecycle(t);
		await withoutBodies(bodies, () => assert.rejects(f.runtime.persistSelectedPassive(() => {}), /changed concurrently/));
		unchanged(before);
	});

	test("same-policy no-op Passive persistence does not revoke an already queued semantic owner", async t => {
		const f = await fixture(t, ["session"]); await f.runtime.persistSelectedPassive(() => {});
		let release!: () => void, entered!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const hold = withStorageTransaction(f.root, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
		await ready;
		const noop = f.runtime.persistSelectedPassive(() => {});
		const patch = f.runtime.withSelectedPatchTransaction(transaction => transaction.publish(transaction.snapshot, {
			id: "after-noop", transitions: [{ scope: "session", patch: { tactics: { retained: true } } }],
		}), () => {});
		release(); await hold;
		assert.equal((await noop).changed, false); await patch;
		assert.equal(f.runtime.readView().tactics!.retained, true);
	});

	test("Passive persistence rechecks policy/cache ownership after waiting and failed publication installs nothing", async t => {
		const f = await fixture(t, ["session"]), before = files(f), old = f.runtime.selectedSnapshot();
		await assert.rejects(f.runtime.persistSelectedPassive(undefined as unknown as () => void), /independent native policy authority/);
		let checks = 0;
		await assert.rejects(f.runtime.persistSelectedPassive(() => { if (++checks === 2) throw new Error("native policy revoked"); }), /native policy revoked/);
		const rename = fs.renameSync, config = sessionRuntimePaths(f.cwd, f.id, f.root).config;
		fs.renameSync = ((from, to) => { if (String(to) === config) throw new Error("injected Passive publication failure"); rename(from, to); }) as typeof rename;
		syncBuiltinESMExports();
		try { await assert.rejects(f.runtime.persistSelectedPassive(() => {}), /injected Passive publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		unchanged(before); assert.deepEqual(f.runtime.selectedSnapshot(), old);
		const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
		const obsolete = assert.rejects(f.runtime.persistSelectedPassive(() => {}), /selection or acceptance changed concurrently/);
		f.runtime.view = undefined; rmSync(lock);
		await f.runtime.withSelectedCurrentTransaction(["session"], (_s, publish) => publish(), () => {}); await obsolete;
		await f.runtime.persistSelectedPassive(() => {}); assert.equal(f.runtime.selectedSnapshot().config.mode, "passive");
	});
}

{
	const { fixture, request } = sessionAcquisitionFixture;

	test("new-session acquisition covers every Session-containing subset in Active/Passive without initializing omitted shared owners", async (t) => {
		for (const selection of [["session"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]] as const) for (const mode of ["active", "passive"] as const) {
			const f = fixture(t);
			const accepted = await f.acquire(request(selection, emptySnapshot(mode)));
			assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
			assert.equal(accepted.cohort.lifecycle.runtime.config.mode, mode);
			assert.deepEqual(temporalScopeRevisions(accepted.cohort.view), Object.fromEntries(selection.map((scope) => [scope, 0])));
			assert.equal(accepted.cohort.view.lineage.length, 1);
			assert.deepEqual(readTemporalView(accepted.cohort.view, 0, "session"), {});
			for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), true);
			for (const scope of ["global", "cwd"] as const) assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, scope, f.root).checkpoint), (selection as readonly string[]).includes(scope));
			assert.ok(accepted.cohort.presence.filter((file) => [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta].includes(file.path)).every((file) => file.present));
			assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.id, captureScopeSelection(selection), f.root))!);
			assert.equal(f.runtime.view, undefined);
		}
	});

	test("first unacquired→acquired preserves run counters/opaque identity and captures a new current history origin without semantic revisions", async (t) => {
		for (const selection of [["session"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]] as const) {
			const f = fixture(t);
			const snapshot: Snapshot = { config: { mode: "active" }, meta: { step: 4, specification: "continue", bootstrap: true } };
			const initial = await f.shared(["cwd"], snapshot);
			await withStorageTransaction(f.root, (transaction) => {
				const transition = { id: "before-private-acquisition", transitions: [{ scope: "cwd" as const, patch: { strategy: { retained: true } } }] };
				transaction.publishSelected(f.cwd, f.id, { view: advanceTemporalState(initial.view, transition.transitions, transition.id), transition, historyLimit: 7 }, initial, f.root);
			});
			const raw = JSON.parse(readFileSync(f.paths.runtime, "utf8"));
			writeFileSync(f.paths.runtime, JSON.stringify({ ...raw, foreign: { keep: "$session.working.opaque" } }));
			const base = (await loadSelectedFileCohort(f.cwd, f.id, ["cwd"], f.root))!;
			const oldCwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
			const oldBytes = [oldCwd.checkpoint, oldCwd.patches, oldCwd.meta].map((path) => [path, readFileSync(path)] as const);
			const accepted = await f.acquire({ kind: "unacquired", base, selection: captureScopeSelection(selection), snapshot: { ...snapshot, config: { mode: "passive" } }, historyLimit: 7 });
			assert.equal(accepted.cohort.lifecycle.runtime.meta.step, 4);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.specification, "continue");
			assert.equal(accepted.cohort.lifecycle.runtime.meta.bootstrap, true);
			assert.equal(accepted.cohort.lifecycle.runtime.config.mode, "passive");
			assert.deepEqual(accepted.cohort.lifecycle.runtime.meta.identity, base.lifecycle.runtime.meta.identity);
			assert.deepEqual(accepted.cohort.lifecycle.runtime.meta.foreign, { keep: "$session.working.opaque" });
			assert.equal(accepted.cohort.view.scopes.session!.revision, 0);
			if ((selection as readonly string[]).includes("cwd")) {
				assert.equal(accepted.cohort.view.scopes.cwd!.revision, 1);
				assert.equal(readTemporalView(accepted.cohort.view, 0, "cwd").strategy!.retained, true);
			}
			assert.equal(accepted.cohort.view.lineage.length, 1);
			assert.throws(() => readTemporalView(accepted.cohort.view, 1));
			if (!(selection as readonly string[]).includes("cwd")) for (const [path, bytes] of oldBytes) assert.deepEqual(readFileSync(path), bytes);
			assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.id, captureScopeSelection(selection), f.root))!);
			await assert.rejects(f.acquire({ kind: "unacquired", base, selection: captureScopeSelection(selection), snapshot, historyLimit: 7 }), /Known acquired/);
		}
	});

	test("missing permission, Off, no Session and malformed admission kinds refuse before creating an absent root", async (t) => {
		for (const failure of ["permission", "off", "selection", "kind"] as const) {
			const f = fixture(t);
			const input = request(failure === "selection" ? ["cwd"] : ["session"], emptySnapshot(failure === "off" ? "off" : "active"));
			if (failure === "kind") (input as any).kind = "guessed";
			await assert.rejects(f.runtime.withSelectedSessionAcquisitionTransaction(input, () => assert.fail("forbidden callback"), undefined, failure !== "permission"));
			assert.equal(existsSync(f.root), false);
		}
	});

	test("unacquired requires exact byte basis and unchanged run fields; deferred/acquired/lost/occupied evidence never becomes empty", async (t) => {
		for (const failure of ["stale", "reset", "deferred", "acquired", "occupied", "partial", "identity"] as const) {
			const f = fixture(t);
			const base = await f.shared();
			const source = readFileSync(f.paths.runtime, "utf8");
			const meta = JSON.parse(source);
			if (failure === "stale") writeFileSync(f.paths.runtime, `${source} `);
			if (failure === "deferred" || failure === "acquired") writeFileSync(f.paths.runtime, JSON.stringify({ ...meta, privateAcquisition: failure }));
			if (failure === "occupied") writeFileSync(f.privatePaths.checkpoint, "do-not-overwrite");
			if (failure === "partial") rmSync(f.paths.config);
			if (failure === "identity") writeFileSync(f.paths.runtime, JSON.stringify({ ...meta, identity: { cwd: f.cwd, sessionId: "foreign" } }));
			const snapshot = emptySnapshot("active");
			if (failure === "reset") snapshot.meta.step = 1;
			const before = existsSync(f.paths.runtime) ? readFileSync(f.paths.runtime) : undefined;
			await assert.rejects(f.acquire({ kind: "unacquired", base, selection: ["session"], snapshot, historyLimit: 7 }, new TemporalRuntime(f.cwd, f.id, f.root)));
			if (before) assert.deepEqual(readFileSync(f.paths.runtime), before);
			assert.equal(existsSync(f.privatePaths.meta), false);
			if (failure === "occupied") assert.equal(readFileSync(f.privatePaths.checkpoint, "utf8"), "do-not-overwrite");
		}
	});

	test("failed private creation rolls back complete lifecycle/shared bytes and missing private files; retry succeeds once", async (t) => {
		const f = fixture(t);
		const base = await f.shared();
		const before = base.basis.files.map((file) => [file.path, file.bytes] as const);
		const input: SelectedSessionAcquisitionRequest = { kind: "unacquired", base, selection: ["cwd", "session"], snapshot: emptySnapshot("active"), historyLimit: 7 };
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === f.paths.runtime) { injected = true; throw new Error("injected acquisition publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(f.acquire(input), /injected acquisition publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		for (const [path, bytes] of before) if (bytes) assert.deepEqual(readFileSync(path), bytes);
		for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
		const accepted = await f.acquire(input);
		assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.id, ["cwd", "session"], f.root))!);
	});

	test("remembered legacy private authority cannot be hidden by passive inspection or a rewritten unacquired header", async (t) => {
		const f = fixture(t);
		f.runtime.initialize(emptySnapshot("active"), true);
		for (const path of [f.paths.config, f.paths.runtime, f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) rmSync(path);
		assert.equal(f.runtime.loadPassive(), true);
		const other = new TemporalRuntime(f.cwd, f.id, f.root);
		let base: SelectedFileCohort | undefined;
		await other.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), (publish) => { base = publish().cohort; }, undefined, true);
		await assert.rejects(f.acquire({ kind: "unacquired", base: base!, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }), /Known acquired/);
	});

	test("waiting acquisition captures its admission inputs and cancellation/callback expiry cannot confer publication", async (t) => {
		const f = fixture(t);
		const base = await f.shared();
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const input: SelectedSessionAcquisitionRequest = { kind: "unacquired", base, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 };
			const pending = f.runtime.withSelectedSessionAcquisitionTransaction(input, () => assert.fail("canceled callback"), controller.signal, true);
			(input as any).kind = "new";
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(existsSync(f.privatePaths.checkpoint), false);
			assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
		} finally { rmSync(lock); }
		let retained: (() => SelectedFilePublication) | undefined;
		await assert.rejects(f.runtime.withSelectedSessionAcquisitionTransaction({ kind: "unacquired", base, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, (publish) => { retained = publish; }, undefined, true), /one synchronous publication/);
		assert.throws(retained!, /ended/);

	});

	test("acquisition admission data stays captured while waiting, not reinterpreted from caller mutations", async (t) => {
		const f = fixture(t);
		const base = await f.shared();
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const input: SelectedSessionAcquisitionRequest = { kind: "unacquired", base, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 };
		let result: SelectedFilePublication | undefined;
		const pending = f.runtime.withSelectedSessionAcquisitionTransaction(input, (publish) => { result = publish(); }, undefined, true);
		(input as any).kind = "new";
		input.historyLimit = 0;
		input.snapshot.meta.step = 50;
		const timer = setTimeout(() => rmSync(lock), 20);
		try { await pending; }
		finally { clearTimeout(timer); rmSync(lock, { force: true }); }
		assert.equal(result!.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.equal(result!.cohort.lifecycle.runtime.meta.step, 0);
		assert.deepEqual(result!.cohort.view.selection, ["session"]);
	});

	test("an occupied/symlink new private slot is never adopted as caller-authored data", async (t) => {
		for (const symbolic of [false, true]) {
			const f = fixture(t);
			mkdirSync(f.privatePaths.directory, { recursive: true });
			if (symbolic) fs.symlinkSync(join(f.root, "outside"), f.privatePaths.checkpoint);
			else writeFileSync(f.privatePaths.checkpoint, "private-sentinel");
			await assert.rejects(f.acquire(request(["session"])));
			assert.equal(existsSync(f.paths.runtime), false);
			if (!symbolic) assert.equal(readFileSync(f.privatePaths.checkpoint, "utf8"), "private-sentinel");
		}
	});
}

{
	const { fixture } = deferredForkFixture;

	test("deferred fork publication samples the latest independently owned mode after a held wait without inherited run fields", async t => {
		const f = fixture(t); mkdirSync(f.root);
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		const lock = withStorageTransaction(f.root, async () => { entered(); await gate; }); await waiting;
		let mode: "active" | "passive" = "active", samples = 0;
		const pending = f.runtime.withSelectedDeferredForkTransaction(["cwd"], { mode, bootstrap: true }, p => p(), undefined, true, () => { samples++; return mode; });
		mode = "passive"; release(); await lock; await pending;
		assert.equal(f.runtime.selectedSnapshot().config.mode, "passive");
		assert.equal(samples, 1);
		assert.deepEqual(f.runtime.selectedSnapshot().meta, { step: 0, bootstrap: true });
		assert.equal((await loadSelectedFileCohort(f.cwd, f.id, ["cwd"], f.root))!.lifecycle.runtime.meta.privateAcquisition, "deferred");
		assert.equal(existsSync(f.privatePaths.meta), false);
	});

	test("mode-only deferred authoring preserves selected ownership and fresh captured lifecycle across every shared selection/window", async t => {
		for (const selection of [["global"], ["cwd"], ["global", "cwd"]] as const) for (const limit of [0, 1, 7, 100]) for (const mode of ["active", "passive"] as const) {
			const f = fixture(t, limit), input: ForkLifecycle = { mode, bootstrap: true };
			const open = fs.openSync, opened: string[] = [];
			fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return open(...args); }) as typeof fs.openSync;
			syncBuiltinESMExports();
			let samples = 0;
			try {
				await f.runtime.withSelectedDeferredForkTransaction(captureScopeSelection(selection), input, publish => publish(), undefined, true, () => {
					samples++; Object.assign(input, { mode: "off", bootstrap: false, step: 99, specification: "cannot inherit", validation: { attempt: 9 } });
					return mode === "active" ? "passive" : "active";
				});
			} finally { fs.openSync = open; syncBuiltinESMExports(); }
			assert.equal(samples, 1);
			const snapshot = f.runtime.selectedSnapshot();
			assert.equal(snapshot.config.mode, mode === "active" ? "passive" : "active");
			assert.deepEqual(snapshot.meta, { step: 0, bootstrap: true });
			const view = f.runtime.selectedView()!;
			assert.deepEqual(view.selection, selection); assert.equal(view.lineage.length, 1);
			for (const scope of selection) assert.equal(view.scopes[scope]!.revision, 0);
			const allowed = new Set([f.paths.config, f.paths.runtime, join(f.root, ".state-flow-publication.lock"), ...selection.flatMap(scope => {
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root); return [paths.checkpoint, paths.patches, paths.meta];
			})]);
			assert.ok(opened.every(path => allowed.has(path) || (path.startsWith(f.root) && path.includes(".tmp"))), JSON.stringify(opened));
			assert.equal(existsSync(f.privatePaths.meta), false);
		}
	});

	test("late mode cannot mint deferral authority, inject run fields, publish Off or outlive cancellation", async t => {
		for (const failure of ["authority", "initial-off", "session", "invalid-hook", "occupied", "late-off", "late-object", "throw", "abort"] as const) {
			const f = fixture(t), controller = new AbortController(); let samples = 0;
			if (failure === "occupied") { mkdirSync(f.privatePaths.directory, { recursive: true }); writeFileSync(f.privatePaths.meta, "occupied private evidence"); }
			const sampler = () => {
				samples++;
				if (failure === "throw") throw new Error("mode selection failed");
				if (failure === "abort") controller.abort(new Error("mode source revoked"));
				return failure === "late-off" ? "off" : failure === "late-object" ? { mode: "passive", step: 99 } as any : "passive";
			};
			await assert.rejects(f.runtime.withSelectedDeferredForkTransaction(failure === "session" ? ["session"] : ["cwd"],
				{ mode: failure === "initial-off" ? "off" : "active" }, publish => publish(), controller.signal, failure !== "authority",
				failure === "invalid-hook" ? {} as any : sampler), (error: unknown) => error instanceof Error, failure);
			assert.equal(samples, ["late-off", "late-object", "throw", "abort"].includes(failure) ? 1 : 0);
			assert.equal(f.runtime.selectedView(), undefined);
			for (const path of [f.paths.config, f.paths.runtime, f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta,
				temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint]) assert.equal(existsSync(path), failure === "occupied" && path === f.privatePaths.meta);
			if (failure === "occupied") assert.equal(readFileSync(f.privatePaths.meta, "utf8"), "occupied private evidence");
			if (["authority", "initial-off", "session", "invalid-hook"].includes(failure)) assert.equal(existsSync(f.root), false);
		}
	});

	test("a deferred mode sampler is never called after cancellation while waiting for exclusion", async t => {
		const f = fixture(t); mkdirSync(f.root);
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		const lock = withStorageTransaction(f.root, async () => { entered(); await gate; }); await waiting;
		let samples = 0; const controller = new AbortController();
		const pending = assert.rejects(f.runtime.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, p => p(), controller.signal, true,
			() => { samples++; return "passive"; }), { name: "AbortError" });
		controller.abort(); await pending;
		assert.equal(samples, 0); assert.equal(existsSync(f.paths.config), false);
		assert.equal(existsSync(f.privatePaths.meta), false); assert.equal(f.runtime.selectedView(), undefined);
		release(); await lock;
	});

	test("deferred mode sampler is single-use and callback-lifetime bound; accepted publication remains final after callback failure", async t => {
		for (const published of [false, true]) {
			const f = fixture(t); let samples = 0, retained!: () => SelectedFilePublication;
			await assert.rejects(f.runtime.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, publish => {
				retained = publish;
				if (published) { publish(); assert.throws(publish, /consumed/); }
				throw new Error("native callback ended");
			}, undefined, true, () => { samples++; return "passive"; }), /native callback ended/);
			assert.equal(samples, published ? 1 : 0);
			const before = [f.paths.config, f.paths.runtime].map(path => existsSync(path) ? readFileSync(path) : undefined);
			await withStorageTransaction(f.root, () => { assert.throws(retained, /ended|consumed/); });
			assert.equal(samples, published ? 1 : 0);
			assert.deepEqual([f.paths.config, f.paths.runtime].map(path => existsSync(path) ? readFileSync(path) : undefined), before);
			if (published) assert.equal(f.runtime.selectedSnapshot().config.mode, "passive");
			else assert.equal(f.runtime.selectedView(), undefined);
		}
	});

	test("every shared-only fork selection persists child-owned deferred policy across cold reload without any parent header/store read", async (t) => {
		for (const selection of [["global"], ["cwd"], ["global", "cwd"]] as const) for (const mode of ["active", "passive"] as const) {
			const f = fixture(t);
			const open = fs.openSync;
			const opened: string[] = [];
			fs.openSync = ((path: fs.PathLike, ...args: any[]) => { opened.push(String(path)); return (open as any)(path, ...args); }) as typeof fs.openSync;
			syncBuiltinESMExports();
			let accepted: SelectedFilePublication;
			try { accepted = await f.defer(selection, { mode, bootstrap: true }); }
			finally { fs.openSync = open; syncBuiltinESMExports(); }
			assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "deferred");
			assert.equal(accepted.cohort.lifecycle.runtime.meta.step, 0);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.bootstrap, true);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.specification, undefined);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.validation, undefined);
			assert.deepEqual(accepted.cohort.lifecycle.runtime.meta.identity, { cwd: f.cwd, sessionId: f.id });
			assert.deepEqual(accepted.cohort.view.selection, selection);
			assert.ok(opened.every((path) => path.startsWith(f.root)), JSON.stringify(opened));
			const allowed = new Set([f.paths.config, f.paths.runtime, join(f.root, ".state-flow-publication.lock"), ...selection.flatMap((scope) => {
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				return [paths.checkpoint, paths.patches, paths.meta];
			})]);
			assert.ok(opened.every((path) => allowed.has(path) || path.includes(".tmp")), JSON.stringify(opened));
			for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
			const cold = (await loadSelectedFileCohort(f.cwd, f.id, captureScopeSelection(selection), f.root))!;
			assertSelectedFileCohortBasis(accepted.cohort, cold);
			assert.equal(cold.lifecycle.runtime.meta.privateAcquisition, "deferred");
			assert.equal(f.runtime.view, undefined);
		}
	});

	test("a deferred child cannot use independent/new or unacquired empty Session acquisition", async (t) => {
		const f = fixture(t);
		const accepted = await f.defer();
		const before = readFileSync(f.paths.runtime);
		for (const kind of ["new", "unacquired"] as const) {
			const owner = new TemporalRuntime(f.cwd, f.id, f.root);
			const request = { kind, ...(kind === "unacquired" ? { base: accepted.cohort } : {}), selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 } as any;
			await assert.rejects(owner.withSelectedSessionAcquisitionTransaction(request, (publish) => publish(), undefined, true), /current-memory acceptance|unacquired authority/);
		}
		assert.deepEqual(readFileSync(f.paths.runtime), before);
		assert.equal(existsSync(f.privatePaths.checkpoint), false);
		await assert.rejects(loadSelectedFileCohort(f.cwd, f.id, ["session"], f.root), /explicit private acquisition/);
	});

	test("Off, missing native fork authority, Session selection and inherited run fields refuse without creating a root", async (t) => {
		for (const failure of ["off", "authority", "session", "run-fields"] as const) {
			const f = fixture(t);
			const lifecycle = failure === "run-fields" ? { mode: "active", step: 9 } as any : { mode: failure === "off" ? "off" : "active" } as ForkLifecycle;
			await assert.rejects(f.runtime.withSelectedDeferredForkTransaction(failure === "session" ? ["session"] : ["cwd"], lifecycle, () => assert.fail("invalid callback"), undefined, failure !== "authority"));
			assert.equal(existsSync(f.root), false);
		}
	});

	test("every surviving child-private or lifecycle file refuses fork deferral without adopting or overwriting it", async (t) => {
		for (const field of ["checkpoint", "patches", "meta", "config", "runtime"] as const) {
			const f = fixture(t);
			mkdirSync(f.privatePaths.directory, { recursive: true });
			const path = field === "config" || field === "runtime" ? f.paths[field] : f.privatePaths[field];
			writeFileSync(path, "preserve occupied child");
			await assert.rejects(f.defer());
			assert.equal(readFileSync(path, "utf8"), "preserve occupied child");
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint), false);
		}
	});

	test("interrupted deferred acceptance rolls back owned files and permits a fresh explicit retry without private creation", async (t) => {
		const f = fixture(t);
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === f.paths.runtime) { injected = true; throw new Error("injected deferred publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(f.defer(), /injected deferred publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		for (const path of [f.paths.config, f.paths.runtime, f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
		assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint), false);
		const accepted = await f.defer();
		assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "deferred");
		assert.equal(existsSync(f.privatePaths.checkpoint), false);
	});

	test("deferral is single-use and cancellation-owned; a deferred fact stays sticky after file loss", async (t) => {
		const f = fixture(t);
		let retained: (() => SelectedFilePublication) | undefined;
		await f.runtime.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, (publish) => {
			retained = publish;
			publish();
			assert.throws(publish, /already consumed/);
		}, undefined, true);
		assert.throws(retained!, /already consumed/);
		rmSync(f.paths.config); rmSync(f.paths.runtime);
		await assert.rejects(f.defer(), /Known.*current-memory acceptance/);
		const other = fixture(t);
		mkdirSync(other.root);
		const lock = join(other.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const pending = other.runtime.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, () => assert.fail("canceled callback"), controller.signal, true);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(existsSync(lock), true);
			assert.equal(existsSync(other.paths.runtime), false);
		} finally { rmSync(lock); }

	});
}

{
	async function fixture(t: TestContext) {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-copy-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), parentId = "source", childId = "child";
		const owner = new TemporalRuntime(cwd, parentId, root), child = new TemporalRuntime(cwd, childId, root);
		const source: SessionAddress = { id: parentId, key: parentId };
		const nativeParent = join(parent, "source.jsonl"), nativeChild = join(parent, "child.jsonl");
		const header = (id: string) => ({ type: "session", id, cwd, timestamp: "2026-10-24T00:00:00.000Z" });
		writeFileSync(nativeParent, JSON.stringify(header(parentId)) + "\n");
		writeFileSync(nativeChild, JSON.stringify({ ...header(childId), parentSession: nativeParent }) + "\n");
		let preparedSource: SessionAddress | undefined;
		const prove = (selected: Readonly<SessionAddress>, phase: "prepare" | "recheck" = "prepare") => {
			if (phase === "recheck") { assert.deepEqual(selected, preparedSource); return; }
			const childHeader = readNativeSessionHeader(nativeChild);
			const raw = JSON.parse(readFileSync(nativeChild, "utf8"));
			assert.equal(childHeader.id, childId); assert.equal(childHeader.cwd, cwd);
			assert.equal(raw.parentSession, nativeParent);
			const parentHeader = readNativeSessionHeader(nativeParent);
			assert.equal(parentHeader.id, selected.id); assert.equal(parentHeader.cwd, cwd);
			assert.equal(selected.key, parentId);
			preparedSource = { ...selected };
		};
		await owner.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), undefined, true);
		const patchParent = async (value: string) => withStorageTransaction(root, transaction => {
			const base = transaction.prepareSelected(cwd, parentId, ["session"], root)!;
			const transition = { id: `parent-${value}`, transitions: [{ scope: "session" as const, patch: { strategy: { value }, tactics: { exact: [{}, []] }, artifacts: { "/source.txt": { description: "Current source artifact" } }, response: `answer-${value}` } }] };
			return transaction.publishSelected(cwd, parentId, { view: advanceTemporalState(base.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base, root).cohort;
		});
		await patchParent("current");
		const paths = temporalScopePaths(cwd, parentId, "session", root);
		const metadata = JSON.parse(readFileSync(paths.meta, "utf8"));
		writeFileSync(paths.meta, JSON.stringify({ ...metadata, artifacts: { "/source.txt": { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "compiler-v1" } } }));
		const copy = async (selection: readonly StateScope[], base?: SelectedFileCohort, runtime = child) => {
			const request: SelectedForkCopyRequest = { selection: captureScopeSelection(selection), snapshot: emptySnapshot("active"), historyLimit: 7, source,
				...(base ? { kind: "fork-deferred" as const, base } : { kind: "fork-new" as const }) };
			let accepted: SelectedFilePublication | undefined;
			await runtime.withSelectedForkCopyTransaction(request, publish => { accepted = publish(); }, prove);
			return accepted!;
		};
		const defer = async () => {
			let base: SelectedFileCohort | undefined;
			await child.withSelectedDeferredForkTransaction(["cwd"], { mode: "active" }, publish => { base = publish().cohort; }, undefined, true);
			return base!;
		};
		return { parent, root, cwd, parentId, childId, child, source, paths, nativeParent, nativeChild, prove, patchParent, copy, defer };
	}

	test("parent copy and same-session acceptance equally reject malformed current witnesses and false private-owner claims", async (t) => {
		for (const retained of [false, true]) for (const deferred of [false, true]) for (const fault of ["null-witness", "false-owner"] as const) {
			const f = await fixture(t);
			if (retained) await new TemporalRuntime(f.cwd, f.parentId, f.root).withSelectedCurrentTransaction(["cwd"], (_run, publish) => publish(), () => {});
			const base = deferred ? await f.defer() : undefined;
			const runtimePath = sessionRuntimePaths(f.cwd, f.parentId, f.root).runtime;
			const metadata = JSON.parse(readFileSync(runtimePath, "utf8"));
			if (fault === "null-witness") metadata.causalWitnesses = null;
			else {
				const prior = metadata.lineage.at(-1);
				const transition = { id: "fictional-private-write", parent: prior.id, position: prior.position + 1 };
				metadata.lineage.push(transition); metadata.causalWitnesses.push({ transition, owners: ["session"] });
			}
			writeFileSync(runtimePath, JSON.stringify(metadata));
			const parentBefore = captureTemporalFileBases(f.cwd, f.parentId, f.root);
			const childBefore = captureTemporalFileBases(f.cwd, f.childId, f.root);
			const cacheBefore = f.child.selectedView();
			const current = new TemporalRuntime(f.cwd, f.parentId, f.root);
			await assert.rejects(current.withSelectedCurrentTransaction(["session"], (_run, publish) => publish(), () => {}), /witness/);
			await assert.rejects(f.copy(["session"], base), /witness/, `${retained}/${deferred}/${fault}`);
			assert.deepEqual(captureTemporalFileBases(f.cwd, f.parentId, f.root), parentBefore);
			assert.deepEqual(captureTemporalFileBases(f.cwd, f.childId, f.root), childBefore);
			assert.deepEqual(f.child.selectedView(), cacheBefore, "failed copying cannot install child values or erase deferred authority");
		}
	});

	test("all Session-containing fork selections copy only parent-current private values/revision/provenance into a fresh child origin", async (t) => {
		for (const selection of [["session"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]] as const) {
			const f = await fixture(t);
			const parentBefore = (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!;
			const accepted = await f.copy(selection);
			assert.deepEqual(readTemporalView(accepted.cohort.view, 0, "session"), readTemporalView(parentBefore.view, 0, "session"));
			assert.equal(accepted.cohort.view.scopes.session!.revision, parentBefore.view.scopes.session!.revision);
			assert.deepEqual(accepted.cohort.provenance.session, parentBefore.provenance.session);
			assert.equal(accepted.cohort.provenance.session!["/source.txt"]!.sourceHash, `sha256:${"a".repeat(64)}`);
			assert.equal(accepted.cohort.view.lineage.length, 1);
			assert.throws(() => readTemporalView(accepted.cohort.view, 1));
			assert.equal(accepted.cohort.lifecycle.runtime.meta.identity.sessionId, f.childId);
			assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
			assert.equal(accepted.cohort.lifecycle.runtime.meta.step, 0);
			assertSelectedFileCohortBasis(parentBefore, (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!);
			assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.childId, captureScopeSelection(selection), f.root))!);
			for (const scope of ["global", "cwd"] as const) assert.equal(existsSync(temporalScopePaths(f.cwd, f.childId, scope, f.root).checkpoint), (selection as readonly string[]).includes(scope));
			assert.equal(f.child.view, undefined);
		}
	});

	test("eager and deferred forks retain raw future, malformed and special-key evidence through later authoring", async (t) => {
		for (const deferred of [false, true]) {
			const f = await fixture(t);
			const raw = Object.fromEntries([["/source.txt", { compilerRevision: "v1" }], ["/bad", { sourceHash: 42 }], ["/future", { futureShape: { keep: 42 } }], ["/primitive", 42], ["__proto__", { futureProto: [42] }], ["constructor", { compilerRevision: "v1" }], ["prototype", { futureShape: true }]]);
			await withStorageTransaction(f.root, tx => {
				const base = tx.prepareSelected(f.cwd, f.parentId, ["session"], f.root)!;
				const transition = { id: "raw-registered-parent", transitions: [{ scope: "session" as const, patch: { artifacts: Object.fromEntries(Object.keys(raw).map(path => [path, { description: "parent registration" }])) } }] };
				tx.publishSelected(f.cwd, f.parentId, { view: advanceTemporalState(base.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base, f.root);
			});
			const metadata = JSON.parse(readFileSync(f.paths.meta, "utf8"));
			writeFileSync(f.paths.meta, JSON.stringify({ ...metadata, artifacts: raw }));
			const before = readFileSync(f.paths.meta);
			const base = deferred ? await f.defer() : undefined;
			await f.copy(deferred ? ["cwd", "session"] : ["session"], base);
			const childPaths = temporalScopePaths(f.cwd, f.childId, "session", f.root);
			assert.deepEqual(JSON.parse(readFileSync(childPaths.meta, "utf8")).artifacts, raw);
			await f.child.withSelectedPatchTransaction(tx => {
				const transition = { id: "remove-child-registrations", transitions: [{ scope: "session" as const, patch: { artifacts: null } }] };
				tx.publish(tx.snapshot, transition);
			}, () => {});
			const after = JSON.parse(readFileSync(childPaths.meta, "utf8")).artifacts;
			for (const path of ["/bad", "/future", "/primitive", "__proto__", "prototype"]) assert.deepEqual(after[path], raw[path], path);
			for (const path of ["/source.txt", "constructor"]) assert.equal(Object.hasOwn(after, path), false, path);
			assert.deepEqual(readFileSync(f.paths.meta), before);
		}
	});

	test("eager and deferred forks preserve explicit empty versus absent raw artifact registries", async (t) => {
		for (const deferred of [false, true]) for (const empty of [false, true]) {
			const f = await fixture(t);
			const metadata = JSON.parse(readFileSync(f.paths.meta, "utf8"));
			if (empty) metadata.artifacts = {}; else delete metadata.artifacts;
			writeFileSync(f.paths.meta, JSON.stringify(metadata));
			const before = readFileSync(f.paths.meta);
			const base = deferred ? await f.defer() : undefined;
			const result = await f.copy(deferred ? ["cwd", "session"] : ["session"], base);
			const target = temporalScopePaths(f.cwd, f.childId, "session", f.root);
			const copied = JSON.parse(readFileSync(target.meta, "utf8"));
			assert.equal(Object.hasOwn(copied, "artifacts"), empty);
			if (empty) assert.deepEqual(copied.artifacts, {});
			assert.deepEqual(result.cohort.provenance.session, {});
			assert.deepEqual(readFileSync(f.paths.meta), before);
		}
	});

	test("raw-only inherited payload changes conflict even when parsed evidence is unchanged", async (t) => {
		for (const deferred of [false, true]) {
			const f = await fixture(t);
			const metadata = JSON.parse(readFileSync(f.paths.meta, "utf8")); metadata.artifacts["/future"] = { futureShape: { keep: 42 } };
			writeFileSync(f.paths.meta, JSON.stringify(metadata));
			const base = deferred ? await f.defer() : undefined;
			const lifecycle = sessionRuntimePaths(f.cwd, f.childId, f.root), child = temporalScopePaths(f.cwd, f.childId, "session", f.root);
			const targets = [lifecycle.config, lifecycle.runtime, child.checkpoint, child.patches, child.meta];
			const before = targets.map(path => existsSync(path) ? readFileSync(path) : undefined);
			const originalOpen = fs.openSync;
			let captures = 0;
			const spy = t.mock.method(fs, "openSync", ((path: fs.PathLike, ...args: any[]) => {
				if (String(path) === f.paths.meta && ++captures === 2) {
					metadata.artifacts["/future"].futureShape.keep = 43;
					writeFileSync(f.paths.meta, JSON.stringify(metadata));
				}
				return Reflect.apply(originalOpen, fs, [path, ...args]);
			}) as typeof fs.openSync);
			syncBuiltinESMExports();
			try { await assert.rejects(f.copy(deferred ? ["cwd", "session"] : ["session"], base), /changed concurrently|conflict/); }
			finally { spy.mock.restore(); syncBuiltinESMExports(); }
			assert.deepEqual(targets.map(path => existsSync(path) ? readFileSync(path) : undefined), before);
			assert.equal(JSON.parse(readFileSync(f.paths.meta, "utf8")).artifacts["/future"].futureShape.keep, 43, "rollback never overwrites the parent's foreign edit");
		}
	});

	test("a cold deferred child copies the parent's then-current head once, preserving its own shared-only run fields", async (t) => {
		const f = await fixture(t);
		const base = await f.defer();
		await f.patchParent("newer");
		const currentParent = (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!;
		const cold = new TemporalRuntime(f.cwd, f.childId, f.root);
		const accepted = await f.copy(["cwd", "session"], base, cold);
		assert.equal(readTemporalView(accepted.cohort.view, 0, "session").strategy!.value, "newer");
		assert.equal(accepted.cohort.view.scopes.session!.revision, 2);
		assert.deepEqual(temporalScopeRevisions(accepted.cohort.view), { cwd: 0, session: 2 });
		assertSelectedFileCohortBasis(currentParent, (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!);
		await f.patchParent("after-copy");
		await assert.rejects(f.copy(["session"], base, cold), /Known acquired/);
		assert.equal(readTemporalView((await loadSelectedFileCohort(f.cwd, f.childId, ["session"], f.root))!.view).strategy!.value, "newer");
	});

	test("copy needs independent direct-parent evidence; absent/unacquired parent and foreign identity never become empty memory", async (t) => {
		for (const failure of ["proof", "parent-header", "missing", "unacquired", "identity", "self"] as const) {
			const f = await fixture(t);
			const parentRuntime = sessionRuntimePaths(f.cwd, f.parentId, f.root);
			if (failure === "parent-header") writeFileSync(f.nativeParent, JSON.stringify({ type: "session", id: "foreign", cwd: f.cwd, timestamp: "2026-10-24T00:00:00.000Z" }));
			if (failure === "missing") rmSync(f.paths.checkpoint);
			if (failure === "unacquired") {
				const meta = JSON.parse(readFileSync(parentRuntime.runtime, "utf8"));
				writeFileSync(parentRuntime.runtime, JSON.stringify({ ...meta, privateAcquisition: "unacquired" }));
				for (const path of [f.paths.checkpoint, f.paths.patches, f.paths.meta]) rmSync(path);
			}
			if (failure === "identity") {
				const meta = JSON.parse(readFileSync(parentRuntime.runtime, "utf8"));
				writeFileSync(parentRuntime.runtime, JSON.stringify({ ...meta, identity: { cwd: f.cwd, sessionId: "foreign" } }));
			}
			const input: SelectedForkCopyRequest = { kind: "fork-new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7, source: failure === "self" ? { id: f.childId, key: f.childId } : f.source };
			await assert.rejects(f.child.withSelectedForkCopyTransaction(input, publish => publish(), failure === "proof" ? undefined as any : f.prove));
			assert.equal(existsSync(sessionRuntimePaths(f.cwd, f.childId, f.root).runtime), false);
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.childId, "session", f.root).checkpoint), false);
		}
	});

	test("stale deferred target, occupied child and changed native parent evidence refuse without consuming parent state", async (t) => {
		for (const failure of ["stale", "occupied", "native-change"] as const) {
			const f = await fixture(t);
			const base = await f.defer();
			const parentBefore = (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!;
			if (failure === "stale") {
				const path = sessionRuntimePaths(f.cwd, f.childId, f.root).runtime;
				writeFileSync(path, readFileSync(path, "utf8") + " ");
			}
			if (failure === "occupied") writeFileSync(temporalScopePaths(f.cwd, f.childId, "session", f.root).checkpoint, "child-sentinel");
			let proofs = 0;
			const prove = (source: Readonly<SessionAddress>, phase: "prepare" | "recheck") => { f.prove(source, phase); proofs++; if (failure === "native-change" && proofs > 1) throw new Error("native parent changed"); };
			await assert.rejects(f.child.withSelectedForkCopyTransaction({ kind: "fork-deferred", source: f.source, base, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), prove));
			assertSelectedFileCohortBasis(parentBefore, (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!);
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.childId, "session", f.root).meta), false);
		}
	});

	test("a fork copy reads no disabled shared body and cannot mutate its parent through publication rollback/retry", async (t) => {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.childId, "global", f.root);
		writeFileSync(global.checkpoint, Buffer.from([0xff])); writeFileSync(global.patches, "invalid hidden tail"); writeFileSync(global.meta, "invalid hidden metadata");
		const parentBefore = (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!;
		const rename = fs.renameSync;
		const childRuntime = sessionRuntimePaths(f.cwd, f.childId, f.root);
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === childRuntime.runtime) { injected = true; throw new Error("injected fork-copy publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(f.copy(["session"]), /injected fork-copy publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(existsSync(childRuntime.runtime), false);
		assert.equal(existsSync(temporalScopePaths(f.cwd, f.childId, "session", f.root).checkpoint), false);
		assertSelectedFileCohortBasis(parentBefore, (await loadSelectedFileCohort(f.cwd, f.parentId, ["session"], f.root))!);
		const accepted = await f.copy(["session"]);
		assert.equal(accepted.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.deepEqual(readFileSync(global.checkpoint), Buffer.from([0xff]));
		assert.equal(readFileSync(global.meta, "utf8"), "invalid hidden metadata");
	});

	test("a legacy acquired parent copies beside independent current shared streams without touching parent bytes", async (t) => {
		const f = await fixture(t);
		const parentPaths = sessionRuntimePaths(f.cwd, f.parentId, f.root);
		const meta = JSON.parse(readFileSync(parentPaths.runtime, "utf8"));
		delete meta.privateAcquisition; delete meta.causalWitnesses;
		writeFileSync(parentPaths.runtime, JSON.stringify({ ...meta, version: 1 }));
		writeFileSync(parentPaths.config, JSON.stringify({ mode: "active" }));
		const peer = new TemporalRuntime(f.cwd, "shared-peer", f.root);
		let shared: SelectedFileCohort | undefined;
		await peer.withSelectedSharedOriginTransaction(["global", "cwd"], emptySnapshot("active"), publish => { shared = publish().cohort; }, undefined, true);
		await withStorageTransaction(f.root, transaction => {
			const transition = { id: "live-shared-peer", transitions: [{ scope: "global" as const, patch: { strategy: { shared: "live" } } }] };
			transaction.publishSelected(f.cwd, "shared-peer", { view: advanceTemporalState(shared!.view, transition.transitions, transition.id), transition, historyLimit: 7 }, shared!, f.root);
		});
		const sourcePaths = [parentPaths.config, parentPaths.runtime, f.paths.checkpoint, f.paths.patches, f.paths.meta];
		const source = sourcePaths.map(path => [path, readFileSync(path)] as const);
		const accepted = await f.copy(["global", "cwd", "session"]);
		assert.equal(readTemporalView(accepted.cohort.view, 0, "global").strategy!.shared, "live");
		assert.equal(readTemporalView(accepted.cohort.view, 0, "session").strategy!.value, "current");
		assert.deepEqual(temporalScopeRevisions(accepted.cohort.view), { global: 1, cwd: 0, session: 1 });
		for (const [path, bytes] of source) assert.deepEqual(readFileSync(path), bytes);
	});

	test("a held fork copy is cancelable before exclusion releases and its accepted capability is single-use", async (t) => {
		const f = await fixture(t);
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const pending = f.child.withSelectedForkCopyTransaction({ kind: "fork-new", source: f.source, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, () => assert.fail("canceled copy"), f.prove, controller.signal);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(existsSync(lock), true);
			assert.equal(existsSync(sessionRuntimePaths(f.cwd, f.childId, f.root).runtime), false);
		} finally { rmSync(lock); }
		await f.child.withSelectedForkCopyTransaction({ kind: "fork-new", source: f.source, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => {
			publish();
			assert.throws(publish, /already consumed/);
		}, f.prove);
	});

	test("parent bytes are recaptured before acceptance and foreign source edits cannot yield an accepted child", async (t) => {
		const f = await fixture(t);
		const originalRead = fs.readFileSync;
		let injected = false;
		// The first read admits the parent's stream; the second sees a foreign edit on source recapture.
		let count = 0;
		const originalOpen = fs.openSync;
		const descriptors = new Map<number, string>();
		fs.openSync = ((path: fs.PathLike, ...args: any[]) => { const fd = (originalOpen as any)(path, ...args); descriptors.set(fd, String(path)); return fd; }) as typeof fs.openSync;
		fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
			const name = typeof path === "number" ? descriptors.get(path) : String(path);
			if (name === f.paths.checkpoint && ++count === 2) { injected = true; writeFileSync(f.paths.checkpoint, readFileSync(f.paths.checkpoint, "utf8") + " "); }
			return (originalRead as any)(path, ...args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try { await assert.rejects(f.copy(["session"]), /changed concurrently/); }
		finally { fs.readFileSync = originalRead; fs.openSync = originalOpen; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		assert.equal(existsSync(sessionRuntimePaths(f.cwd, f.childId, f.root).runtime), false);
	});
}

{
	const scopes = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));

	async function fixture(t: TestContext, selection: ScopeSelection = ["global", "session"], limit = 7) {
		const directory = mkdtempSync(join(tmpdir(), "state-flow-selected-transactions-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const root = join(directory, "store"), cwd = join(directory, "cwd"), id = "owner";
		const runtime = new TemporalRuntime(cwd, id, root, undefined, limit);
		let snapshot = { ...emptySnapshot("active"), meta: { step: 0, bootstrap: true } };
		if (selection.includes("session")) await runtime.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot, historyLimit: limit }, p => p(), undefined, true);
		else await runtime.withSelectedSharedOriginTransaction(selection, snapshot, p => p(), undefined, true);
		const apply = async (patches: AtomicScopePatches, response?: string, reads: SuccessfulArtifactRead[] = []) => {
			let stage: StagedSelectedTransition | undefined, publication: SelectedFilePublication | undefined;
			await runtime.withSelectedPatchTransaction(transaction => {
				stage = response === undefined ? stageSelectedScopePatches(transaction, patches, [], transaction.causalBasis, reads)
					: stageSelectedScopedTransition(transaction, { transitions: Object.entries(patches).map(([scope, patch]) => ({ scope: scope as StateScope, patch })), response }, [], transaction.causalBasis, reads);
				commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, next) => { publication = transaction.publish(next, accepted, stage!.provenanceUpdates); }, transaction.causalBasis, { finalizeRun: response !== undefined });
				snapshot = transaction.snapshot as typeof snapshot;
			}, () => {});
			return { stage: stage!, publication: publication! };
		};
		const peer = async () => {
			const other = new TemporalRuntime(cwd, "peer", root);
			await other.withSelectedSharedOriginTransaction(["global"], emptySnapshot("active"), p => p(), undefined, true);
			await withStorageTransaction(root, transaction => {
				const base = transaction.prepareSelected(cwd, "peer", ["global"], root)!;
				const transition = { id: "peer-live", transitions: [{ scope: "global" as const, patch: { strategy: { peer: true } } }] };
				transaction.publishSelected(cwd, "peer", { view: advanceTemporalState(base.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base, root);
			});
		};
		return { root, cwd, id, runtime, apply, peer, snapshot: () => structuredClone(snapshot) };
	}
	function cohortFiles(f: { cwd: string; id: string; root: string }) {
		const paths = sessionRuntimePaths(f.cwd, f.id, f.root);
		return [paths.config, paths.runtime, ...scopes.flatMap(scope => { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; })]
			.filter(path => existsSync(path)).map(path => [path, readFileSync(path)] as const);
	}
	function unchanged(files: ReturnType<typeof cohortFiles>) { for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes, path); }

	function firstAuthoringFixture(t: TestContext, limit = 7) {
		const directory = mkdtempSync(join(tmpdir(), "state-flow-first-authoring-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const root = join(directory, "store"), cwd = join(directory, "workspace"), id = "first-owner";
		return { root, cwd, id, runtime: new TemporalRuntime(cwd, id, root, undefined, limit) };
	}

	function firstAuthor(transaction: SelectedRuntimePatchTransaction, patches: AtomicScopePatches) {
		const stage = stageSelectedScopePatches(transaction, patches, [], transaction.causalBasis);
		let publication: SelectedFilePublication | undefined;
		commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, snapshot) => {
			publication = transaction.publish(snapshot, accepted, stage.provenanceUpdates);
		}, transaction.causalBasis, { finalizeRun: false });
		return { stage, publication: publication! };
	}

	for (const mode of ["active", "passive"] as const) for (const limit of [0, 1, 7, 100])
		test(`first authoring atomically admits exactly selected owners in ${mode} at retention ${limit}`, async t => {
			for (const selection of selections) {
				const f = firstAuthoringFixture(t, limit);
				const paths = sessionRuntimePaths(f.cwd, f.id, f.root);
				let result: ReturnType<typeof firstAuthor> | undefined;
				let publications = 0;
				const rename = fs.renameSync;
				fs.renameSync = ((from, to) => { if (String(to) === paths.runtime) publications++; return rename(from, to); }) as typeof fs.renameSync;
				syncBuiltinESMExports();
				try {
					await f.runtime.withSelectedFirstPatchTransaction(selection, emptySnapshot(mode), transaction => {
						assert.equal(existsSync(paths.runtime), false, "first authoring must not publish an empty lifecycle before validation");
						assert.equal(f.runtime.selectedView(), undefined);
						result = firstAuthor(transaction, Object.fromEntries(selection.map(scope => [scope, { strategy: { owner: scope } }])));
					}, () => {}, undefined, true);
				} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
				assert.equal(publications, 1, "origin, semantics and lifecycle form one accepted publication");
				assert.equal(result!.stage.committed, true);
				assert.deepEqual(f.runtime.selectedView()!.selection, selection);
				assert.equal(f.runtime.selectedSnapshot().meta.step, 1);
				assert.equal(result!.publication.cohort.lifecycle.runtime.meta.privateAcquisition, selection.includes("session") ? "acquired" : "unacquired");
				assert.equal(result!.publication.cohort.lifecycle.runtime.config.mode, mode);
				assert.equal(f.runtime.selectedView()!.lineage.length, limit === 0 ? 1 : 2);
				assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), Object.fromEntries(selection.map(scope => [scope, 1])));
				for (const scope of selection) assert.equal(f.runtime.readView(0, scope).strategy!.owner, scope);
				for (const scope of scopes.filter(scope => !selection.includes(scope))) {
					const excluded = temporalScopePaths(f.cwd, f.id, scope, f.root);
					for (const path of [excluded.checkpoint, excluded.patches, excluded.meta]) assert.equal(existsSync(path), false, path);
				}
			}
		});

	for (const mode of ["active", "passive"] as const) test(`invalid first authoring publishes nothing; accepted semantic no-op creates only origin lifecycle in ${mode}`, async t => {
		for (const selection of selections) {
			const f = firstAuthoringFixture(t), snapshot = emptySnapshot(mode);
			const scope = selection[0]!;
			await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(selection, snapshot, transaction => {
				firstAuthor(transaction, { [scope]: { response: "forbidden" } });
			}, () => {}, undefined, true), /response/);
			assert.equal(cohortFiles(f).length, 0); assert.equal(f.runtime.selectedView(), undefined);
			let result: ReturnType<typeof firstAuthor> | undefined;
			await f.runtime.withSelectedFirstPatchTransaction(selection, snapshot, transaction => {
				result = firstAuthor(transaction, { [scope]: { tactics: { absent: null } } });
			}, () => {}, undefined, true);
			assert.equal(result!.stage.committed, true);
			assert.equal(f.runtime.selectedSnapshot().meta.step, 0);
			assert.equal(f.runtime.selectedView()!.lineage.length, 1, "explicit accepted origin is not a semantic patch");
			assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), Object.fromEntries(selection.map(owner => [owner, 0])));
			for (const owner of selection) assert.deepEqual(f.runtime.readView(0, owner), {});
			if (!selection.includes("session")) assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "session", f.root).meta), false);
			assert.deepEqual(snapshot, emptySnapshot(mode), "caller run fields stay detached");
		}
	});

	test("shared first-authoring source CAS preserves a competing edit and never leaves an empty owned lifecycle", async t => {
		for (const selection of selections.filter(value => !value.includes("session"))) {
			const f = firstAuthoringFixture(t);
			const peer = new TemporalRuntime(f.cwd, "source-peer", f.root);
			await peer.withSelectedSharedOriginTransaction(selection, emptySnapshot("active"), publish => publish(), undefined, true);
			const source = temporalScopePaths(f.cwd, f.id, selection[0]!, f.root).meta;
			const before = readFileSync(source, "utf8");
			let stage: StagedSelectedTransition | undefined;
			await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(selection, emptySnapshot("passive"), transaction => {
				stage = stageSelectedScopePatches(transaction, { [selection[0]!]: { strategy: { mustNotPublish: true } } }, [], transaction.causalBasis);
				writeFileSync(source, `${before} `);
				commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, snapshot) => transaction.publish(snapshot, accepted, stage!.provenanceUpdates), transaction.causalBasis, { finalizeRun: false });
			}, () => {}, undefined, true), /concurrent/);
			assert.equal(stage!.committed, false);
			assert.equal(readFileSync(source, "utf8"), `${before} `);
			assert.equal(existsSync(sessionRuntimePaths(f.cwd, f.id, f.root).runtime), false);
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "session", f.root).meta), false);
			assert.equal(f.runtime.selectedView(), undefined);
		}
	});

	test("shared first-authoring rolls back failed publication and retries one exact selected cohort", async t => {
		for (const selection of selections.filter(value => !value.includes("session"))) {
			const f = firstAuthoringFixture(t), snapshot = emptySnapshot("passive");
			const runtimePath = sessionRuntimePaths(f.cwd, f.id, f.root).runtime;
			const rename = fs.renameSync; let injected = false;
			fs.renameSync = ((from, to) => { if (!injected && String(to) === runtimePath) { injected = true; throw new Error("first shared publication failure"); } return rename(from, to); }) as typeof fs.renameSync;
			syncBuiltinESMExports();
			try {
				await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(selection, snapshot, transaction => firstAuthor(transaction, { [selection[0]!]: { tactics: { retry: true } } }), () => {}, undefined, true), /first shared publication failure/);
			} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
			assert.equal(injected, true); assert.equal(cohortFiles(f).length, 0); assert.equal(f.runtime.selectedView(), undefined);
			await f.runtime.withSelectedFirstPatchTransaction(selection, snapshot, transaction => firstAuthor(transaction, { [selection[0]!]: { tactics: { retry: true } } }), () => {}, undefined, true);
			assert.equal(f.runtime.selectedSnapshot().meta.step, 1);
			assert.equal(f.runtime.readView(0, selection[0]!).tactics!.retry, true);
			assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), Object.fromEntries(selection.map(scope => [scope, scope === selection[0] ? 1 : 0])));
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "session", f.root).meta), false);
		}
	});

	test("first-authoring dispatch captures selection before a held wait and cancellation settles without private fallback", async t => {
		for (const cancel of [false, true]) {
			const f = firstAuthoringFixture(t); fs.mkdirSync(f.root);
			const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
			const controller = new AbortController(), mutable: StateScope[] = ["cwd"];
			let entered = false;
			const pending = f.runtime.withSelectedFirstPatchTransaction(mutable as unknown as ScopeSelection, emptySnapshot("active"), transaction => {
				entered = true;
				assert.deepEqual(transaction.selection, ["cwd"]);
				firstAuthor(transaction, { cwd: { strategy: { captured: true } } });
			}, () => {}, controller.signal, true);
			mutable[0] = "session";
			try {
				if (cancel) {
					controller.abort();
					await assert.rejects(pending, { name: "AbortError" });
					assert.equal(existsSync(lock), true); assert.equal(entered, false); assert.equal(cohortFiles(f).length, 0);
				} else { rmSync(lock); await pending; assert.equal(entered, true); assert.deepEqual(f.runtime.selectedView()!.selection, ["cwd"]); }
			} finally { rmSync(lock, { force: true }); }
			assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, "session", f.root).meta), false);
		}
	});

	test("escaped first-authoring publishers are revoked after normal or exceptional callback exit before a foreign lock can be bypassed", async t => {
		for (const selection of selections) for (const throws of [false, true]) {
			const f = firstAuthoringFixture(t);
			let escaped: SelectedRuntimePatchTransaction | undefined;
			await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(selection, emptySnapshot("passive"), transaction => {
				escaped = transaction;
				if (throws) throw new Error("author callback failure");
			}, () => {}, undefined, true), throws ? /author callback failure/ : /one synchronous publication/);
			assert.equal(cohortFiles(f).length, 0); assert.equal(f.runtime.selectedView(), undefined);
			const lock = join(f.root, ".state-flow-publication.lock"); writeFileSync(lock, `${process.pid}\n`);
			try {
				const transaction = escaped!;
				const stage = stageSelectedScopePatches(transaction, { [selection[0]!]: { strategy: { escaped: true } } }, [], transaction.causalBasis);
				assert.throws(() => commitSelectedTransition(transaction.snapshot, transaction, stage,
					(accepted, snapshot) => transaction.publish(snapshot, accepted, stage.provenanceUpdates), transaction.causalBasis, { finalizeRun: false }), /ended/);
				assert.equal(stage.committed, false);
				assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
				assert.equal(cohortFiles(f).length, 0); assert.equal(f.runtime.selectedView(), undefined);
			} finally { rmSync(lock); }
		}
	});

	test("first authoring cannot replace known acquired authority or acquire an origin without independent permission", async t => {
		const f = firstAuthoringFixture(t);
		await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(["cwd"], emptySnapshot("active"), () => assert.fail("no grant"), () => {}), /explicit native origin authority/);
		assert.equal(existsSync(f.root), false);
		await f.runtime.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, publish => publish(), undefined, true);
		const before = cohortFiles(f), view = f.runtime.selectedView();
		await assert.rejects(f.runtime.withSelectedFirstPatchTransaction(["cwd"], emptySnapshot("active"), () => assert.fail("known private owner"), () => {}, undefined, true), /Known|existing|Existing/);
		unchanged(before); assert.deepEqual(f.runtime.selectedView(), view);
	});

	test("selected runtime stage/commit publishes one cohort across every subset and retention window, including Session-only response and no-op completion", async (t) => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, selection, limit);
			await f.apply(Object.fromEntries(selection.map(scope => [scope, { strategy: { chosen: scope }, intents: { task: { $ref: `${scope}.lazy.plan` } }, lazy: { plan: { next: true } } }])));
			const closed = await f.apply(Object.fromEntries(selection.map(scope => [scope, { intents: { task: null }, lazy: { plan: { resurrect: true } } }])));
			for (const scope of selection) {
				assert.deepEqual(f.runtime.readView(0, scope).lazy, { plan: { resurrect: true } });
				assert.deepEqual(closed.stage.cascades[scope], [{ plane: "lazy", keys: ["plan"] }]);
			}
			const before = f.runtime.selectedView()!;
			await f.apply({}, "ordinary-final-answer");
			const session = selection.includes("session");
			assert.equal(f.runtime.readView().response, session ? "ordinary-final-answer" : undefined);
			assert.equal(f.snapshot().meta.step, session ? 3 : 2);
			assert.equal(f.snapshot().meta.bootstrap, false);
			assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), Object.fromEntries(selection.map(scope => [scope, scope === "session" ? 3 : 2])));
			if (!session) assert.deepEqual(f.runtime.selectedView(), before);
			if (limit > 0 && session) assert.equal(f.runtime.readView(1).response, undefined);
			const noop = await f.apply(Object.fromEntries(selection.map(scope => [scope, { strategy: { chosen: scope } }])));
			assert.equal(noop.publication.changed, false);
			assert.equal(noop.stage.committed, true);
			assert.deepEqual(Object.keys(f.runtime.selectedStates().states), selection);
			for (const scope of scopes.filter(scope => !selection.includes(scope))) assert.equal(existsSync(temporalScopePaths(f.cwd, f.id, scope, f.root).meta), false);
		}
	});

	test("raw replay rejects changed shared targets but adopts untargeted live shared state without rebasing a stale patch", async (t) => {
		const f = await fixture(t);
		await f.apply({ global: { strategy: { old: true } }, session: { strategy: { private: true } } });
		await f.peer();
		const old = f.runtime.selectedView(); const files = cohortFiles(f);
		await assert.rejects(f.runtime.publishSelected(f.snapshot(), { id: "stale-global", transitions: [{ scope: "global", patch: { strategy: { stale: true } } }] }, () => {}), /live global state advanced/);
		assert.deepEqual(f.runtime.selectedView(), old); unchanged(files);
		const snapshot = f.snapshot(); snapshot.meta.step++;
		await f.runtime.publishSelected(snapshot, { id: "private-replay", transitions: [{ scope: "session", patch: { tactics: { accepted: true } } }] }, () => {});
		assert.equal(f.runtime.readView(0, "global").strategy!.peer, true);
		assert.equal(f.runtime.readView(0, "session").tactics!.accepted, true);
		assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), { global: 2, session: 2 });
		assert.equal(f.runtime.selectedView()!.lineage.length, 2);
	});

	test("fresh authored transactions may target live shared values after drift; raw provenance targets also conflict", async (t) => {
		const f = await fixture(t);
		await f.apply({ global: { strategy: { initial: true } } }); await f.peer();
		await f.runtime.withSelectedPatchTransaction(transaction => {
			assert.equal(transaction.states.global!.strategy!.peer, true);
			const stage = stageSelectedScopePatches(transaction, { global: { tactics: { authored: "on-live" } } }, [], transaction.causalBasis);
			commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, snapshot) => transaction.publish(snapshot, accepted, stage.provenanceUpdates), transaction.causalBasis, { finalizeRun: false });
		}, () => {});
		assert.equal(f.runtime.readView(0, "global").tactics!.authored, "on-live");
		const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const meta = JSON.parse(readFileSync(paths.meta, "utf8")); writeFileSync(paths.meta, JSON.stringify({ ...meta, artifacts: { "/source": { compilerRevision: "peer" } } }));
		await assert.rejects(f.runtime.publishSelected(f.snapshot(), undefined, () => {}, { provenance: { global: { "/source": { compilerRevision: "new" } } } }), /live global state advanced/);
	});

	test("removed replay targets refuse without installation or repair; explicit refresh can accept empty shared reality for a new authored patch", async (t) => {
		const f = await fixture(t);
		await f.apply({ global: { strategy: { old: true } }, session: { strategy: { private: true } } });
		const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
		for (const path of [paths.checkpoint, paths.patches, paths.meta]) rmSync(path);
		const before = f.runtime.selectedView();
		await assert.rejects(f.runtime.publishSelected(f.snapshot(), { id: "removed-target", transitions: [{ scope: "global", patch: { tactics: { stale: true } } }] }, () => {}), (error: unknown) => error instanceof SharedScopeRemovalConflictError && error.scopes[0] === "global");
		assert.deepEqual(f.runtime.selectedView(), before);
		assert.equal(existsSync(paths.checkpoint), false);
		await f.runtime.withSelectedCurrentTransaction(["global", "session"], (_snapshot, publish) => publish(), () => {});
		assert.deepEqual(f.runtime.readView(0, "global"), {});
		await f.apply({ global: { strategy: { fresh: true } } });
		assert.equal(f.runtime.readView(0, "global").strategy!.fresh, true);
		assert.deepEqual(temporalScopeRevisions(f.runtime.selectedView()!), { global: 1, session: 1 });
		// A removed but untargeted shared owner may be adopted atomically with private semantic work.
		for (const path of [paths.checkpoint, paths.patches, paths.meta]) rmSync(path);
		await f.runtime.publishSelected(f.snapshot(), { id: "untargeted-removal", transitions: [{ scope: "session", patch: { tactics: { done: true } } }] }, () => {});
		assert.deepEqual(f.runtime.readView(0, "global"), {});
		assert.equal(f.runtime.selectedView()!.scopes.global!.revision, 0);
	});

	test("accepted registration deletion removes only its known provenance, preserving unbound and opaque metadata", async (t) => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, selection, limit);
			const reads: SuccessfulArtifactRead[] = selection.map(scope => ({ path: "/registered", scope, reason: "source-changed", sourceFingerprint: { size: 1, mtimeNs: "1" } }));
			await f.apply(Object.fromEntries(selection.map(scope => [scope, { artifacts: { "/registered": { description: "known" }, "/future": { description: "opaque evidence" } } }])), undefined, reads);
			for (const scope of selection) {
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
				writeFileSync(paths.meta, JSON.stringify({ ...meta, opaque: { retain: true }, artifacts: { ...meta.artifacts, "/unbound": { compilerRevision: "keep-without-registration" }, "/future": { unknownFutureShape: true } } }));
			}
			await f.runtime.withSelectedCurrentTransaction(selection, (_snapshot, publish) => publish(), () => {});
			await f.apply(Object.fromEntries(selection.map(scope => [scope, { tactics: { unrelated: true } }])));
			for (const scope of selection) assert.ok(f.runtime.artifactProvenance(scope)["/registered"], "unrelated changes cannot prune live provenance");
			await f.apply(Object.fromEntries(selection.map(scope => [scope, { artifacts: { "/registered": null, "/future": null } }])));
			for (const scope of selection) {
				assert.equal(f.runtime.artifactProvenance(scope)["/registered"], undefined);
				assert.deepEqual(f.runtime.artifactProvenance(scope)["/unbound"], { compilerRevision: "keep-without-registration" });
				const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
				const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
				assert.equal(Object.hasOwn(meta.artifacts, "/registered"), false);
				assert.deepEqual(meta.artifacts["/future"], { unknownFutureShape: true });
				assert.deepEqual(meta.opaque, { retain: true });
			}
		}
	});

	test("first atomic authoring revokes deleted shared registration evidence without losing opaque metadata", async (t) => {
		for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, ["global"], limit);
			await f.apply({ global: { artifacts: { "/registered": { description: "known" }, "/future": { description: "opaque" } } } }, undefined,
				[{ path: "/registered", scope: "global", reason: "source-changed", sourceFingerprint: { size: 1, mtimeNs: "1" } }]);
			const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
			const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
			writeFileSync(paths.meta, JSON.stringify({ ...meta, opaque: { retain: true }, artifacts: { ...meta.artifacts, "/future": { futureShape: true } } }));
			const fresh = new TemporalRuntime(f.cwd, "new-private-owner", f.root, undefined, limit);
			await fresh.withSelectedFirstPatchTransaction(["global", "session"], emptySnapshot("passive"), transaction => {
				const stage = stageSelectedScopePatches(transaction, { global: { artifacts: { "/registered": null, "/future": null } } }, [], transaction.causalBasis);
				commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, next) => transaction.publish(next, accepted, stage.provenanceUpdates), transaction.causalBasis);
			}, () => {}, undefined, true);
			assert.equal(fresh.artifactProvenance("global")["/registered"], undefined);
			const after = JSON.parse(readFileSync(paths.meta, "utf8"));
			assert.deepEqual(after.artifacts["/future"], { futureShape: true }); assert.deepEqual(after.opaque, { retain: true });
			assert.equal(fresh.selectedSnapshot().meta.step, 1);
		}
	});

	test("successor and first-author deletion preserve invalid recognized provenance values verbatim", async (t) => {
		const retained = Object.fromEntries(Object.entries({ badHash: { sourceHash: 42 }, badFingerprint: { sourceFingerprint: { size: -1, mtimeNs: "1" } }, badCompiler: { compilerRevision: 42 }, badTime: { compiledAt: 42 }, mixed: { compilerRevision: "valid", sourceHash: false }, future: { futurePayload: [42] }, primitive: 42, empty: {} }));
		for (const first of [false, true]) {
			const scope = first ? "global" : "session";
			const f = await fixture(t, [scope]);
			const cards = Object.fromEntries([...Object.keys(retained), "/good"].map(path => [path, { description: "registered" }]));
			await f.apply({ [scope]: { artifacts: cards } });
			const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
			const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
			writeFileSync(paths.meta, JSON.stringify({ ...meta, artifacts: { ...retained, "/good": { compilerRevision: "v1" } } }));
			const deletion = { [scope]: { artifacts: Object.fromEntries(Object.keys(cards).map(path => [path, null])) } };
			if (!first) { await f.runtime.withSelectedCurrentTransaction([scope], (_snapshot, publish) => publish(), () => {}); await f.apply(deletion); }
			else {
				const fresh = new TemporalRuntime(f.cwd, "first-raw-preservation", f.root);
				await fresh.withSelectedFirstPatchTransaction(["global", "session"], emptySnapshot("passive"), transaction => {
					const stage = stageSelectedScopePatches(transaction, deletion, [], transaction.causalBasis);
					commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, next) => transaction.publish(next, accepted, stage.provenanceUpdates), transaction.causalBasis);
				}, () => {}, undefined, true);
			}
			assert.deepEqual(JSON.parse(readFileSync(paths.meta, "utf8")).artifacts, retained);
		}
	});

	test("compiler provenance publishes atomically with semantic output, preserves opaque evidence, and metadata-only updates do not rewrite checkpoint/tail or revisions", async (t) => {
		const f = await fixture(t, ["cwd"]);
		const paths = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
		writeFileSync(paths.meta, JSON.stringify({ ...meta, artifacts: { "future-note": { retained: "opaque" } }, opaque: { keep: true } }));
		await f.runtime.withSelectedCurrentTransaction(["cwd"], (_snapshot, publish) => publish(), () => {});
		const read: SuccessfulArtifactRead = { path: "/registered/source.txt", scope: "cwd", reason: "source-changed", sourceFingerprint: { size: 5, mtimeNs: "7" } };
		const result = await f.apply({ cwd: { artifacts: { [read.path]: { description: "Compiled" } } } }, undefined, [read]);
		assert.deepEqual(f.runtime.artifactProvenance("cwd")[read.path], result.stage.provenanceUpdates.cwd![read.path]);
		assert.deepEqual(JSON.parse(readFileSync(paths.meta, "utf8")).artifacts["future-note"], { retained: "opaque" });
		assert.deepEqual(JSON.parse(readFileSync(paths.meta, "utf8")).opaque, { keep: true });
		const before = [paths.checkpoint, paths.patches].map(path => [path, readFileSync(path)] as const);
		const revision = f.runtime.selectedView()!.scopes.cwd!.revision, head = f.runtime.causalBasis();
		await f.runtime.publishSelected(f.snapshot(), undefined, () => {}, { provenance: { cwd: { [read.path]: { compilerRevision: "next" } } } });
		for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes);
		assert.equal(f.runtime.selectedView()!.scopes.cwd!.revision, revision);
		assert.equal(f.runtime.causalBasis(), head);
		assert.equal(f.runtime.artifactProvenance("cwd")[read.path]!.compilerRevision, "next");
		assert.equal((await f.runtime.publishSelected(f.snapshot(), undefined, () => {}, { provenance: { cwd: { [read.path]: { compilerRevision: "next" } } } })).changed, false);
		const absent = await fixture(t, ["cwd", "session"]);
		const empty = temporalScopePaths(absent.cwd, absent.id, "cwd", absent.root);
		for (const path of [empty.checkpoint, empty.patches, empty.meta]) rmSync(path);
		await absent.apply({ cwd: { artifacts: { [read.path]: { description: "Fresh current compiler output" } } } }, undefined, [read]);
		assert.deepEqual(absent.runtime.artifactProvenance("cwd")[read.path]!.sourceFingerprint, read.sourceFingerprint);
		assert.deepEqual(temporalScopeRevisions(absent.runtime.selectedView()!), { cwd: 1, session: 0 });
	});

	test("excluded metadata/patch owners fail before their getters; malformed compiler deltas cannot sanitize into acceptance", async (t) => {
		const f = await fixture(t, ["cwd"]);
		const provenance = Object.defineProperty({}, "session", { enumerable: true, get: () => assert.fail("excluded provenance getter") });
		await assert.rejects(f.runtime.publishSelected(f.snapshot(), undefined, () => {}, { provenance }), /provenance owner is excluded/);
		const replay = { id: "excluded", transitions: [{ scope: "session" as const, get patch(): never { return assert.fail("excluded patch getter"); } }] };
		await assert.rejects(f.runtime.publishSelected(f.snapshot(), replay, () => {}), /excluded owner/);
		for (const delta of [{ cwd: { "/source": { unknown: "field" } } }, { cwd: { "/source": { malformed: true } } }, { cwd: { "/source": { sourceHash: Infinity } } }]) {
			await assert.rejects(f.runtime.publishSelected(f.snapshot(), undefined, () => {}, { provenance: delta as any }));
		}
		assert.deepEqual(f.runtime.readView(), {});
	});

	test("non-adoptable lifecycle/private changes, publication failure and callback lifetime cannot commit a selected stage or replace its cache", async (t) => {
		const f = await fixture(t, ["session"]);
		let stage: StagedSelectedTransition | undefined; const before = f.runtime.selectedView(), files = cohortFiles(f);
		const rename = fs.renameSync; let failed = false;
		fs.renameSync = (from, to) => { if (!failed && to === sessionRuntimePaths(f.cwd, f.id, f.root).runtime) { failed = true; throw new Error("injected selected stage publication failure"); } rename(from, to); }; syncBuiltinESMExports();
		try {
			await assert.rejects(f.runtime.withSelectedPatchTransaction(transaction => {
				stage = stageSelectedScopePatches(transaction, { session: { strategy: { no: "install" } } }, [], transaction.causalBasis);
				commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, snapshot) => transaction.publish(snapshot, accepted), transaction.causalBasis);
			}, () => {}), /injected selected stage publication failure/);
		} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(stage!.committed, false); assert.deepEqual(f.runtime.selectedView(), before); unchanged(files);
		let escaped: ((snapshot: ReturnType<typeof emptySnapshot>) => SelectedFilePublication) | undefined;
		await assert.rejects(f.runtime.withSelectedPatchTransaction(transaction => { escaped = transaction.publish; }, () => {}), /one synchronous publication/);
		assert.throws(() => escaped!(f.snapshot()), /transaction has ended/);
		await f.runtime.withSelectedPatchTransaction(transaction => { transaction.publish(transaction.snapshot); assert.throws(() => transaction.publish(transaction.snapshot), /already consumed/); }, () => {});
		const privateMeta = temporalScopePaths(f.cwd, f.id, "session", f.root).meta;
		writeFileSync(privateMeta, readFileSync(privateMeta, "utf8") + " ");
		await assert.rejects(f.runtime.withSelectedPatchTransaction(() => assert.fail(), () => {}), /changed concurrently/);
		for (const field of ["config", "runtime"] as const) {
			const current = await fixture(t);
			const path = sessionRuntimePaths(current.cwd, current.id, current.root)[field];
			writeFileSync(path, readFileSync(path, "utf8") + " ");
			await assert.rejects(current.runtime.withSelectedPatchTransaction(() => assert.fail("changed lifecycle must refuse before staging"), () => {}), /changed concurrently/);
		}
	});

	test("held selected transactions revoke on cache change-away-and-back; raw inputs detach before waiting and cancellation installs nothing", async (t) => {
		const f = await fixture(t, ["session"]);
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const pending = f.runtime.withSelectedPatchTransaction(() => assert.fail("obsolete cache owner"), () => {});
		f.runtime.view = undefined; rmSync(lock);
		await f.runtime.withSelectedCurrentTransaction(["session"], (_snapshot, publish) => publish(), () => {});
		await assert.rejects(pending, /selection or acceptance changed concurrently/);
		writeFileSync(lock, `${process.pid}\n`);
		const transition = { id: "detached-input", transitions: [{ scope: "session" as const, patch: { strategy: { retained: "original" } } }] };
		const snapshot = f.snapshot(); snapshot.meta.step++;
		const provenance = { session: { "/source": { compilerRevision: "original" } } };
		const publication = f.runtime.publishSelected(snapshot, transition, () => {}, { provenance });
		transition.transitions[0]!.patch.strategy.retained = "mutated"; provenance.session["/source"].compilerRevision = "mutated"; snapshot.meta.step = 999;
		rmSync(lock); const accepted = await publication;
		assert.equal(f.runtime.readView().strategy!.retained, "original");
		assert.equal(f.runtime.artifactProvenance("session")["/source"]!.compilerRevision, "original");
		assert.equal(accepted.cohort.lifecycle.runtime.meta.step, 1);
		const before = f.runtime.selectedView(); writeFileSync(lock, `${process.pid}\n`);
		const cancel = new AbortController();
		try { const pending = f.runtime.withSelectedPatchTransaction(() => assert.fail(), () => {}, cancel.signal); cancel.abort(); await assert.rejects(pending, { name: "AbortError" }); }
		finally { rmSync(lock); }
		assert.deepEqual(f.runtime.selectedView(), before);
		let calls = 0;
		await assert.rejects(f.runtime.withSelectedPatchTransaction(transaction => transaction.publish(transaction.snapshot), () => { if (++calls === 3) throw new Error("native policy revoked"); }), /native policy revoked/);
		assert.deepEqual(f.runtime.selectedView(), before);
	});
}

{
	const { shared, all, fixture, cohortFiles, unchanged, bodies, forbid } = readObservationFixture;

	test("selected shared observation exposes only present requested owners, including CWD-only without Global, across retention windows", async t => {
		for (const requested of shared) for (const present of shared) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, present, limit), before = cohortFiles(f);
			const expected = requested.filter(scope => present.includes(scope));
			const available = await f.observer.refreshSelectedShared(requested, () => {});
			assert.equal(available, expected.length > 0);
			assert.equal(f.observer.view, undefined); assert.equal(f.observer.selectedView(), undefined);
			if (expected.length === 0) {
				assert.equal(f.observer.observedSelectedView(), undefined);
				assert.throws(() => f.observer.selectedStates(), /unavailable/);
			} else {
				const view = f.observer.observedSelectedView()!;
				assert.deepEqual(view.selection, expected); assert.deepEqual(Object.keys(view.scopes), expected);
				assert.deepEqual(Object.keys(f.observer.selectedStates().states), expected);
				assert.deepEqual(temporalScopeRevisions(view), Object.fromEntries(expected.map(scope => [scope, 1])));
				assert.equal(view.lineage.length, 1); assert.deepEqual(f.observer.recent(), []);
				for (const scope of expected) {
					assert.equal(f.observer.readView(0, scope).strategy!.owner, scope);
					assert.equal(f.observer.readView(0, scope).lazy!.privateBody, scope);
					assert.equal(f.observer.artifactProvenance(scope)["/unobserved-source"]!.compilerRevision, `evidence-${scope}`);
				}
				assert.throws(() => f.observer.readView(1), /history|retained|origin/i);
				for (const scope of all.filter(scope => !expected.includes(scope))) assert.throws(() => f.observer.readView(0, scope), /excluded|unavailable/);
			}
			unchanged(before);
			for (const scope of shared.flatMap(s => s).filter(scope => !present.includes(scope))) for (const path of bodies(f, scope)) assert.equal(existsSync(path), false);
			const life = sessionRuntimePaths(f.cwd, "reader", f.root);
			assert.equal(existsSync(life.config), false); assert.equal(existsSync(life.runtime), false);
		}
	});

	test("empty/absent observation creates no owner, lifecycle or root; invalid selection and revoked native authority fail before canonical I/O", async t => {
		const directory = mkdtempSync(join(tmpdir(), "state-flow-no-observation-root-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
		const root = join(directory, "absent"), runtime = new TemporalRuntime(directory, "reader", root);
		assert.equal(await runtime.refreshSelectedShared(["cwd"], () => {}), false); assert.equal(existsSync(root), false);
		assert.throws(() => runtime.readView(), /unavailable/); assert.throws(() => runtime.selectedSnapshot(), /unavailable/);
		for (const selection of [["session"], ["cwd", "session"], [], ["cwd", "cwd"], ["invalid"]]) {
			await assert.rejects(runtime.refreshSelectedShared(selection as unknown as ScopeSelection, () => {}), /cannot select Session|nonempty unique/);
		}
		await assert.rejects(runtime.refreshSelectedShared(["cwd"], undefined as unknown as () => void), /independent native policy authority/);
		await assert.rejects(runtime.refreshSelectedShared(["cwd"], () => { throw new Error("Off has no memory receipt"); }), /Off has no memory receipt/);
		assert.equal(existsSync(root), false);
	});

	test("observation never opens Session, lifecycle, disabled shared bodies or source artifacts, even when those files are corrupt", async t => {
		const f = await fixture(t, all);
		const life = sessionRuntimePaths(f.cwd, f.id, f.root);
		const excluded = [...bodies(f, "global"), ...bodies(f, "session"), life.config, life.runtime, "/unobserved-source"];
		for (const path of excluded.filter(path => path !== "/unobserved-source")) writeFileSync(path, "unreadable excluded data");
		const before = cohortFiles(f);
		await forbid(excluded, async () => {
			assert.equal(await f.observer.refreshSelectedShared(["cwd"], () => {}), true);
			assert.deepEqual(f.observer.observedSelectedView()!.selection, ["cwd"]);
			assert.equal(f.observer.readView().strategy!.owner, "cwd");
		});
		unchanged(before);
	});

	test("partial triples, metadata-only orphans, retired layout, unsupported epochs, invalid UTF-8 and symbolic files fail without replacing observation", async t => {
		for (const fault of ["checkpoint", "patches", "meta", "metadata-only", "retired", "epoch", "utf8", "symbolic", "identity"] as const) {
			const f = await fixture(t); await f.observer.refreshSelectedShared(["global"], () => {});
			const previous = f.observer.observedSelectedView(), p = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
			if (["checkpoint", "patches", "meta"].includes(fault)) rmSync(p[fault as "checkpoint" | "patches" | "meta"]);
			if (fault === "metadata-only") { rmSync(p.checkpoint); rmSync(p.patches); }
			if (fault === "retired") writeFileSync(join(p.directory, "state.json"), "ignored predecessor");
			if (fault === "epoch") { writeFileSync(p.meta, JSON.stringify({ version: 999 })); writeFileSync(p.checkpoint, "secret invalid checkpoint"); }
			if (fault === "utf8") writeFileSync(p.checkpoint, Buffer.from([0xff]));
			if (fault === "symbolic") { rmSync(p.checkpoint); symlinkSync(p.meta, p.checkpoint); }
			if (fault === "identity") { const meta = JSON.parse(readFileSync(p.meta, "utf8")); meta.owner.cwd = "/foreign"; writeFileSync(p.meta, JSON.stringify(meta)); }
			const before = fault === "symbolic" ? [] : cohortFiles(f);
			await assert.rejects(f.observer.refreshSelectedShared(["cwd"], () => {}), /Incomplete|Unsupported|UTF-8|symbolic|symlink|regular file|identity|Invalid/i);
			assert.deepEqual(f.observer.observedSelectedView(), previous); unchanged(before);
		}
	});

	test("legacy shared owners translate read-only, retaining revisions/provenance and exact predecessor bytes without backup", async t => {
		for (const version of [1, 2]) {
			const f = await fixture(t, ["cwd"]), p = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
			for (const path of [p.checkpoint, p.patches]) writeFileSync(path, readFileSync(path, "utf8").replaceAll('"strategy"', '"contract"'));
			const metadata = JSON.parse(readFileSync(p.meta, "utf8")); metadata.version = version; writeFileSync(p.meta, JSON.stringify(metadata));
			const before = cohortFiles(f), directories = readdirSync(join(f.root, ".."));
			await f.observer.refreshSelectedShared(["cwd"], () => {});
			assert.equal(f.observer.readView().strategy!.owner, "cwd"); assert.equal(f.observer.observedSelectedView()!.scopes.cwd!.revision, 1);
			assert.equal(f.observer.artifactProvenance("cwd")["/unobserved-source"]!.compilerRevision, "evidence-cwd");
			unchanged(before); assert.deepEqual(readdirSync(join(f.root, "..")), directories);
		}
	});

	test("observations are detached, current-only and cannot masquerade as accepted cache, snapshots, checkpoints or publication basis", async t => {
		const f = await fixture(t); await f.observer.refreshSelectedShared(["global", "cwd"], () => {});
		const view = f.observer.observedSelectedView()!, original = f.observer.observedSelectedView();
		view.scopes.cwd!.checkpoint.state = { strategy: { owner: "mutated" } };
		f.observer.selectedStates().states.cwd!.lazy!.privateBody = "mutated";
		f.observer.artifactProvenance("cwd")["/unobserved-source"]!.compilerRevision = "mutated";
		assert.deepEqual(f.observer.observedSelectedView(), original);
		assert.equal(f.observer.artifactProvenance("cwd")["/unobserved-source"]!.compilerRevision, "evidence-cwd");
		assert.throws(() => f.observer.selectedSnapshot(), /unavailable/);
		assert.throws(() => f.observer.retainedSelectedCheckpoint(), /unavailable/);
		const before = cohortFiles(f);
		await forbid(before.map(([path]) => path), async () => {
			assert.equal(f.observer.readView().strategy!.owner, "cwd");
			assert.deepEqual(f.observer.observedSelectedView(), original);
			assert.deepEqual(f.observer.selectedStates().selection, ["global", "cwd"]);
			assert.deepEqual(f.observer.recent(), []);
		});
		await assert.rejects(f.observer.withSelectedPatchTransaction(() => assert.fail("observation cannot author"), () => {}), /unavailable/);
		await assert.rejects(f.observer.publishSelected(emptySnapshot("active"), undefined, () => {}), /unavailable/);
		await assert.rejects(f.observer.persistSelectedPassive(() => {}), /unavailable/);
		await assert.rejects(f.observer.withSelectedSharedOriginTransaction(["cwd"], emptySnapshot("active"), p => p()), /explicit new-session authority/);
		await assert.rejects(f.observer.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, p => p()), /explicit native authority/);
		unchanged(before);
		f.observer.view = undefined;
		await assert.rejects(f.observer.refreshShared(), /selected runtime operations/);
		await assert.rejects(f.observer.withStartTransaction(() => assert.fail(), undefined, true), /selected runtime integration/);
		assert.throws(() => f.observer.loadPassive(), /selected runtime operations/);
	});

	test("observation grants no sticky origin authority but explicit later acquisition can establish selected live memory", async t => {
		const f = await fixture(t, ["global"]); await f.observer.refreshSelectedShared(["global", "cwd"], () => {});
		await f.observer.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["global", "cwd", "session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, p => p(), undefined, true);
		assert.equal(f.observer.observedSelectedView(), undefined);
		assert.deepEqual(f.observer.selectedView()!.selection, all);
		assert.equal(f.observer.readView(0, "global").strategy!.owner, "global");
		assert.deepEqual(temporalScopeRevisions(f.observer.selectedView()!), { global: 1, cwd: 0, session: 0 });
		await f.observer.withSelectedPatchTransaction(transaction => transaction.publish(transaction.snapshot, { id: "authorized", transitions: [{ scope: "session", patch: { tactics: { accepted: true } } }] }), () => {});
		assert.equal(f.observer.readView().tactics!.accepted, true);
		const accepted = f.observer.selectedView();
		await assert.rejects(f.observer.refreshSelectedShared(["global"], () => {}), /Accepted State Flow memory requires current acceptance/);
		assert.deepEqual(f.observer.selectedView(), accepted);
		f.observer.view = undefined;
		await assert.rejects(f.observer.refreshSelectedShared(["global"], () => {}), /Accepted State Flow memory requires current acceptance/);
	});

	test("shared observation does not hide existing private/lifecycle evidence when an explicit fresh origin is attempted", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		await observer.refreshSelectedShared(["cwd"], () => {});
		const before = cohortFiles(f), view = observer.observedSelectedView();
		await assert.rejects(observer.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, p => p(), undefined, true), /Existing State Flow session requires current-memory acceptance/);
		unchanged(before); assert.deepEqual(observer.observedSelectedView(), view);
	});

	test("current observation validates exact selected owners and proven history without granting accepted cache or changing lifecycle", async t => {
		const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(all.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const f = await fixture(t, all, limit), observer = new TemporalRuntime(f.cwd, f.id, f.root, undefined, limit), before = cohortFiles(f);
			const snapshot = await observer.refreshSelectedCurrent(selection, () => {});
			assert.deepEqual(snapshot, f.producer.selectedSnapshot());
			assert.deepEqual(observer.observedSelectedView()!.selection, selection);
			assert.equal(observer.selectedView(), undefined); assert.equal(observer.view, undefined);
			assert.throws(() => observer.selectedSnapshot(), /unavailable/);
			for (const scope of selection) {
				assert.equal(observer.readView(0, scope).strategy!.owner, scope);
				if (limit > 0) assert.deepEqual(observer.readView(1, scope), {});
			}
			unchanged(before); snapshot.meta.step = 999;
			assert.equal(observer.readView().strategy!.owner, selection.at(-1));
			await assert.rejects(observer.persistSelectedPassive(() => {}), /unavailable/);
			unchanged(before);
		}
	});

	test("current observation can read valid shared drift but only explicit current acceptance installs/publishes it", async t => {
		const f = await fixture(t, all), peer = new TemporalRuntime(f.cwd, "peer", f.root);
		await peer.withSelectedSharedOriginTransaction(["global"], emptySnapshot("active"), p => p(), undefined, true);
		await peer.withSelectedPatchTransaction(transaction => transaction.publish(transaction.snapshot, { id: "peer-drift", transitions: [{ scope: "global", patch: { tactics: { peer: true } } }] }), () => {});
		const before = cohortFiles(f), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		await observer.refreshSelectedCurrent(all, () => {});
		assert.equal(observer.readView(0, "global").tactics!.peer, true);
		assert.equal(observer.readView(0, "session").strategy!.owner, "session");
		assert.throws(() => observer.readView(1), /history|origin|retained/i);
		assert.deepEqual(temporalScopeRevisions(observer.observedSelectedView()!), { global: 2, cwd: 1, session: 1 });
		unchanged(before);
		await observer.withSelectedCurrentTransaction(all, (snapshot, publish) => publish({ ...snapshot, config: { mode: "passive" } }), () => {});
		assert.equal(observer.observedSelectedView(), undefined); assert.equal(observer.selectedSnapshot().config.mode, "passive");
		assert.equal(observer.readView(0, "global").tactics!.peer, true);
	});

	test("current observation omits planned absent shared owners instead of exposing fake empty streams or repairing them", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		for (const path of bodies(f, "global")) rmSync(path);
		const before = cohortFiles(f);
		await observer.refreshSelectedCurrent(["global", "session"], () => {});
		assert.deepEqual(observer.observedSelectedView()!.selection, ["session"]);
		assert.deepEqual(temporalScopeRevisions(observer.observedSelectedView()!), { session: 1 });
		assert.throws(() => observer.artifactProvenance("global"), /excluded/);
		assert.throws(() => observer.readView(0, "global"), /excluded/);
		await observer.refreshSelectedCurrent(["global"], () => {});
		assert.equal(observer.observedSelectedView(), undefined); assert.throws(() => observer.readView(), /unavailable/);
		for (const path of bodies(f, "global")) assert.equal(existsSync(path), false);
		unchanged(before);
	});

	test("v2 current observation isolates excluded bodies but requires acquired private presence; v1 requires complete evidence without conversion", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		const privateCheckpoint = temporalScopePaths(f.cwd, f.id, "session", f.root).checkpoint;
		const original = readFileSync(privateCheckpoint);
		writeFileSync(privateCheckpoint, "invalid excluded private body");
		await forbid(bodies(f, "session"), () => observer.refreshSelectedCurrent(["cwd"], () => {}));
		const previous = observer.observedSelectedView(); rmSync(privateCheckpoint);
		await assert.rejects(observer.refreshSelectedCurrent(["cwd"], () => {}), /private semantics are incomplete/);
		assert.deepEqual(observer.observedSelectedView(), previous); writeFileSync(privateCheckpoint, original);
		const life = sessionRuntimePaths(f.cwd, f.id, f.root), metadata = JSON.parse(readFileSync(life.runtime, "utf8"));
		metadata.version = 1; delete metadata.privateAcquisition; delete metadata.causalWitnesses;
		writeFileSync(life.config, JSON.stringify({ mode: "active" })); writeFileSync(life.runtime, JSON.stringify(metadata));
		writeFileSync(privateCheckpoint, "invalid required legacy private body");
		await assert.rejects(observer.refreshSelectedCurrent(["cwd"], () => {}), /JSON|checkpoint|stream|scope/i);
		assert.deepEqual(observer.observedSelectedView(), previous); writeFileSync(privateCheckpoint, original);
		const before = cohortFiles(f); await observer.refreshSelectedCurrent(["cwd"], () => {}); unchanged(before);
		assert.equal(JSON.parse(readFileSync(life.runtime, "utf8")).version, 1);
	});

	test("observed current acquisition remains sticky after clearing and rejects provenance downgrade rather than creating a fresh private owner", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		await observer.refreshSelectedCurrent(["cwd"], () => {}); const previous = observer.observedSelectedView();
		const life = sessionRuntimePaths(f.cwd, f.id, f.root), metadata = JSON.parse(readFileSync(life.runtime, "utf8"));
		for (const path of bodies(f, "session")) rmSync(path);
		metadata.privateAcquisition = "unacquired"; writeFileSync(life.runtime, JSON.stringify(metadata));
		await assert.rejects(observer.refreshSelectedCurrent(["cwd"], () => {}), /Known acquired State Flow private authority cannot be downgraded/);
		assert.deepEqual(observer.observedSelectedView(), previous);
		observer.view = undefined; rmSync(life.config); rmSync(life.runtime);
		const before = cohortFiles(f);
		await assert.rejects(observer.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 }, p => p(), undefined, true), /Known State Flow session requires current-memory acceptance/);
		unchanged(before); assert.equal(existsSync(life.config), false);
	});

	test("current observation cancellation withdraws before lock release and cannot downgrade accepted selected memory", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root), lock = join(f.root, ".state-flow-publication.lock");
		const cancel = new AbortController(); writeFileSync(lock, `${process.pid}\n`);
		try {
			const pending = observer.refreshSelectedCurrent(all, () => {}, cancel.signal); cancel.abort();
			await assert.rejects(pending, { name: "AbortError" }); assert.equal(existsSync(lock), true);
			assert.equal(observer.observedSelectedView(), undefined);
		} finally { rmSync(lock); }
		const before = cohortFiles(f);
		await forbid(before.map(([path]) => path), () => assert.rejects(f.producer.refreshSelectedCurrent(all, () => {}), /Accepted State Flow memory requires current acceptance/));
		unchanged(before);
	});

	test("observation cannot discard a legacy accepted private basis during backend transition", async t => {
		const f = await fixture(t), root = join(f.root, "..", "legacy"), legacy = new TemporalRuntime(f.cwd, "legacy", root);
		await legacy.withStartTransaction((_snapshot, publish) => publish(emptySnapshot("active")), undefined, true);
		const before = cohortFiles({ ...f, root, id: "legacy" }), view = structuredClone(legacy.view);
		await forbid(before.map(([path]) => path), async () => {
			await assert.rejects(legacy.refreshSelectedShared(["cwd"], () => {}), /Accepted State Flow memory requires current acceptance/);
			await assert.rejects(legacy.refreshSelectedCurrent(["cwd"], () => {}), /Accepted State Flow memory requires current acceptance/);
		});
		assert.deepEqual(legacy.view, view); unchanged(before);
	});
}

test("selected runtime forwards detached first-content descriptor admissions without new authority or publisher", async t => {
	const descriptor = { x_public_notes: { schemaVersion: 1, immutable: false } };
	for (const channel of ["origin", "current", "patch", "replay"] as const) {
		const f = await currentFixture.fixture(t, ["session"]);
		const id = channel === "origin" ? "new-module-owner" : f.id;
		const owner = new TemporalRuntime(f.cwd, id, f.root);
		const transition = { id: `module-${channel}`, transitions: [{ scope: "session" as const, patch: { x_public_notes: { saved: channel } } }] };
		const snapshot = emptySnapshot("active");
		const author = (tx: SelectedRuntimePatchTransaction) => tx.publish(tx.snapshot, transition, undefined, { session: descriptor });
		if (channel === "origin") await owner.withSelectedFirstPatchTransaction(["session"], snapshot, author, () => {}, undefined, true);
		else if (channel === "current") await owner.withSelectedCurrentTransaction(["session"], (_s, _p, tx) => author(tx), () => {});
		else {
			await owner.withSelectedCurrentTransaction(["session"], (_s, publish) => publish(), () => {});
			if (channel === "patch") await owner.withSelectedPatchTransaction(author, () => {});
			else {
				const lock = join(f.root, ".state-flow-publication.lock"), additions = structuredClone({ session: descriptor });
				writeFileSync(lock, `${process.pid}\n`);
				const publishing = owner.publishSelected(snapshot, transition, () => {}, { moduleAdditions: additions });
				additions.session.x_public_notes.schemaVersion = 99;
				rmSync(lock);
				await publishing;
			}
		}
		const saved = (await loadSelectedFileCohort(f.cwd, id, ["session"], f.root))!;
		assert.deepEqual(saved.view, owner.selectedView());
		assert.deepEqual(saved.view.scopes.session!.modules, descriptor);
		assert.deepEqual(readTemporalView(saved.view, 0, "session").x_public_notes, { saved: channel });
		assert.equal(readTemporalView(saved.view, 1, "session").x_public_notes, undefined);
		const cancel = new AbortController();
		await owner.withSelectedPatchTransaction(tx => {
			tx.publish(tx.snapshot, { id: "after-module", transitions: [{ scope: "session", patch: { tactics: { accepted: true } } }] });
			cancel.abort();
		}, () => {}, cancel.signal);
		assert.equal(readTemporalView(owner.selectedView()!, 0, "session").tactics?.accepted, true, "late cancellation does not revoke accepted data");
	}
});

test("first selected authoring retains exact source CAS and requires independent explicit origin permission", async () => {
	const h = harness({ initializeRepository: false }); await start(h);
	const child = new TemporalRuntime(h.ctx.cwd, "cas-child", h.repositoryRoot);
	const next = emptySnapshot("passive");
	await assert.rejects(child.withSelectedFirstPatchTransaction(DEFAULT_SCOPE_SELECTION, next, () => assert.fail("no origin permission"), () => {}), /explicit native origin/);
	const global = temporalScopePaths(h.ctx.cwd, "cas-child", "global", h.repositoryRoot);
	const source = readFileSync(global.meta, "utf8");
	await assert.rejects(child.withSelectedFirstPatchTransaction(DEFAULT_SCOPE_SELECTION, next, transaction => {
		const stage = stageSelectedScopePatches(transaction, { session: { tactics: { rejected: true } } }, [], transaction.causalBasis);
		writeFileSync(global.meta, `${source} `);
		commitSelectedTransition(next, transaction, stage, (accepted, snapshot) => { transaction.publish(snapshot, accepted); }, transaction.causalBasis, { finalizeRun: false });
	}, () => {}, undefined, true), /concurrent/);
	assert.equal(readFileSync(global.meta, "utf8"), `${source} `, "a competing exact-byte edit must survive refusal");
	assert.equal(existsSync(sessionRuntimePaths(h.ctx.cwd, "cas-child", h.repositoryRoot).runtime), false);
	assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, "cas-child", "session", h.repositoryRoot).checkpoint), false);
	assert.equal(child.selectedView(), undefined);
	await child.withSelectedFirstPatchTransaction(DEFAULT_SCOPE_SELECTION, next, transaction => {
		const stage = stageSelectedScopePatches(transaction, { session: { tactics: { accepted: true } } }, [], transaction.causalBasis);
		commitSelectedTransition(next, transaction, stage, (accepted, snapshot) => { transaction.publish(snapshot, accepted); }, transaction.causalBasis, { finalizeRun: false });
		child.view = undefined;
	}, () => {}, undefined, true);
	assert.equal(child.selectedView(), undefined, "post-acceptance cache withdrawal must not be undone by a second installer");
	assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, "cas-child", "session", h.repositoryRoot).checkpoint), true);
});

{
	const fixture = legacyPublicationFixture.fixture, assertUnchanged = legacyPublicationFixture.assertUnchanged;

	function start(f: ReturnType<typeof fixture>, runtime = new TemporalRuntime(f.cwd, f.sessionId, f.root), signal?: AbortSignal) {
		return runtime.withStartTransaction((current, publish) => publish({ ...current!, config: { mode: "active" } }), signal);
	}

	test("owned activation converts complete legacy cohorts once, backs up exact dependencies and preserves every retained boundary", async (t) => {
		const f = fixture(t);
		const runtime = new TemporalRuntime(f.cwd, f.sessionId, f.root);
		assert.ok(await runtime.refreshCurrentMemory());
		assertUnchanged(f);
		assert.equal(existsSync(f.backupDir), false, "inspection is observational");
		const result = await start(f, runtime);
		assert.ok(result.migrationBackup);
		const backup = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.equal(backup.files.length, f.base.files.length);
		assert.equal(backup.targetVersion, 3);
		assert.deepEqual(backup.convertedScopes, ["global", "cwd", "session"]);
		for (const original of f.base.files) {
			const saved = backup.files.find((file: { path: string }) => file.path === relative(f.root, original.path));
			assert.ok(saved);
			assert.equal(saved.identity, original.identity);
			assert.deepEqual(saved.bytes === null ? undefined : Buffer.from(saved.bytes, "base64"), original.bytes === undefined ? undefined : Buffer.from(original.bytes));
		}
		assert.equal(fs.statSync(result.migrationBackup).mode & 0o777, 0o600);
		assert.equal(backup.files.some((file: { path: string }) => file.path === "unrelated-note"), false);
		for (const scope of ["global", "cwd", "session"] as const) {
			const paths = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
			const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
			assert.equal(meta.version, 3);
			assert.equal(meta.temporal.revision, f.view.scopes[scope].revision);
			assert.deepEqual(meta.temporal.extra, { preserve: true });
			assert.deepEqual(meta.opaqueLifecycle, { identity: "do not reinterpret" });
			assert.deepEqual(meta.foreign, { keep: true, address: "$session.working.job" });
			assert.deepEqual(meta.artifacts, { "/opaque": { futureEvidence: "preserve" } });
		}
		for (let offset = 0; offset < f.view.lineage.length; offset++) assert.deepEqual(runtime.read(offset), readTemporalState(f.view, offset));
		const repeated = await start(f);
		assert.equal(repeated.migrationBackup, undefined);
		assert.equal(fs.readdirSync(f.backupDir).length, 1);
	});

	test("backup failure and interrupted conversion preserve canonical bytes and leave no accepted runtime", async (t) => {
		const blocked = fixture(t);
		writeFileSync(blocked.backupDir, "not a directory");
		const runtime = new TemporalRuntime(blocked.cwd, blocked.sessionId, blocked.root);
		await assert.rejects(start(blocked, runtime), /not a regular directory/);
		assert.equal(runtime.view, undefined);
		assertUnchanged(blocked);
		const exposed = fixture(t);
		fs.mkdirSync(exposed.backupDir, { mode: 0o700 });
		fs.chmodSync(exposed.backupDir, 0o755);
		await assert.rejects(start(exposed), /backup directory must be private/);
		assertUnchanged(exposed);
		assert.deepEqual(fs.readdirSync(exposed.backupDir), []);
		const f = fixture(t);
		const candidate = new TemporalRuntime(f.cwd, f.sessionId, f.root);
		const target = temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).patches;
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => {
			if (!injected && to === target) { injected = true; throw new Error("injected migration publication failure"); }
			rename(from, to);
		};
		syncBuiltinESMExports();
		try { await assert.rejects(start(f, candidate), /injected migration publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		assert.equal(candidate.view, undefined);
		assertUnchanged(f);
		assert.equal(fs.readdirSync(f.backupDir).length, 1, "a completed recovery backup survives failed publication");
		const result = await start(f, candidate);
		assert.ok(result.migrationBackup);
		assert.equal(fs.readdirSync(f.backupDir).length, 1, "retry reuses the exact verified backup");
	});

	test("cancellation while exclusion is held cannot create migration writes or backups", async (t) => {
		const f = fixture(t);
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		const runtime = new TemporalRuntime(f.cwd, f.sessionId, f.root);
		const pending = start(f, runtime, controller.signal);
		controller.abort();
		try {
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(existsSync(lock), true, "cancellation withdraws before the foreign owner releases exclusion");
			assert.equal(runtime.view, undefined);
			assertUnchanged(f);
			assert.equal(existsSync(f.backupDir), false);
		} finally { rmSync(lock); }
	});

	test("legacy private authority and partial semantic evidence fail before conversion or backup", async (t) => {
		for (const failure of ["identity", "partial"] as const) {
			const f = fixture(t);
			if (failure === "identity") {
				const paths = sessionRuntimePaths(f.cwd, f.sessionId, f.root);
				const meta = JSON.parse(readFileSync(paths.runtime, "utf8"));
				meta.identity.sessionId = "foreign";
				writeFileSync(paths.runtime, JSON.stringify(meta));
			} else rmSync(temporalScopePaths(f.cwd, f.sessionId, "session", f.root).patches);
			const runtime = new TemporalRuntime(f.cwd, f.sessionId, f.root);
			await assert.rejects(start(f, runtime), /identity|incomplete/i);
			assert.equal(runtime.view, undefined);
			assert.equal(existsSync(f.backupDir), false);
			assert.equal(existsSync(join(f.root, ".state-flow-publication.lock")), false);
		}
	});
}
