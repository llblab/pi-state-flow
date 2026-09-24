import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { withStorageTransaction } from "../lib/storage.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TemporalRuntime } from "../lib/runtime.ts";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { writeGlobalState } from "./storage-fixture.ts";
import { createSessionRuntime, emptySnapshot, type RetainedBoundaryCheckpoint, type Snapshot } from "../lib/snapshot.ts";
import { emptyState, type AtomicScopePatches, type StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { advanceTemporalState, temporalScopeRevisions, validateTemporalState } from "../lib/temporal.ts";
import { commitScopedTransition, stageAtomicScopePatches } from "../lib/transition.ts";
import { harness } from "./harness.ts";
import { loadScopeProvenance } from "./temporal-fixture.ts";

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

function restoreAwaited(runtime: TemporalRuntime, checkpoint: RetainedBoundaryCheckpoint, signal?: AbortSignal) {
	return runtime.withRestoreTransaction(checkpoint, (snapshot, publish) => ({ snapshot, publication: publish(snapshot) }), signal);
}

test("authored patches use the current shared head, preserve private state and accept exact repeats without history", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-head-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "a", root);
	const b = new TemporalRuntime(cwd, "b", root);
	const sa = emptySnapshot();
	const sb = emptySnapshot();
	await patchCurrent(a, sa, { global: { working: { choice: "original", gone: "old" } }, session: { working: { private: "a" } } });
	await patchCurrent(b, sb, { global: { working: { choice: "foreign", gone: "new", unrelated: "keep" } }, cwd: { lazy: { list: [1, 2], foreign: true } }, session: { working: { private: "b" } } });
	const peerFiles = captureTemporalFileBases(cwd, "b", root).filter(({ path }) => path.startsWith(temporalScopePaths(cwd, "b", "session", root).directory + "/"));
	const authored: AtomicScopePatches = { global: { working: { choice: "original", gone: null } }, cwd: { lazy: { list: [3] } }, session: { working: { accepted: true } } };
	await patchCurrent(a, sa, authored);
	assert.deepEqual(a.read(0, "global").working, { choice: "original", unrelated: "keep" }, "an authored value equal to a stale cache still overwrites the current assignment");
	assert.deepEqual(a.read(0, "cwd").lazy, { list: [3], foreign: true });
	assert.deepEqual(a.read(0, "session").working, { private: "a", accepted: true });
	assert.deepEqual(a.read(1, "global").working, { choice: "foreign", gone: "new", unrelated: "keep" }, "history uses the actual accepted basis");
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
	await assert.rejects(patchCurrent(runtime, snapshot, { global: { working: { tentative: true } }, session: { artifacts: { invalid: {} } } }), /non-empty description/);
	assert.deepEqual(files(), empty);
	assert.equal(runtime.view, undefined);
	assert.deepEqual(snapshot, emptySnapshot());
	await patchCurrent(runtime, snapshot, { session: { working: { retained: true } } });
	const peer = new TemporalRuntime(cwd, "peer", root);
	await patchCurrent(peer, emptySnapshot(), { global: { working: { foreign: true } } });
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
	const patches = { global: { working: { local: true } }, session: { working: { published: true } } };
	try { await assert.rejects(patchCurrent(runtime, snapshot, patches), /injected patch publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(files(), canonical);
	assert.deepEqual(runtime.states(), cached, "uncommitted shared adoption must not be installed either");
	assert.deepEqual(snapshot, before);
	await patchCurrent(runtime, snapshot, patches);
	assert.deepEqual(runtime.read(0, "global").working, { foreign: true, local: true });
	assert.deepEqual(runtime.read(0, "session").working, { retained: true, published: true });
});

test("patch transactions cancel live waiting without changing memory and retain exact private ownership fences", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-patch-fence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot();
	await patchCurrent(runtime, snapshot, { session: { working: { retained: true } } });
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
	const pending = patchCurrent(runtime, snapshot, { global: { working: { cancelled: true } } }, controller.signal);
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
	await assert.rejects(patchCurrent(unselected, emptySnapshot(), { global: { working: { unsafe: true } } }), /memory is not selected/);
	const selected = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in selected);
	const competing = new TemporalRuntime(cwd, "owner", root);
	const other = competing.restoreBoundary(selected).snapshot;
	await patchCurrent(competing, other, { session: { working: { peer: true } } });
	const winner = files();
	await assert.rejects(patchCurrent(runtime, snapshot, { global: { working: { unsafe: true } }, session: { working: { stale: true } } }), /base or scope identity changed concurrently/);
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
	await patchCurrent(a, sa, { session: { working: { owner: "a" } } });
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
		await patchCurrent(runtime, snapshot, { [scope]: { working: { old: true } }, session: { working: { private: true } } });
		const paths = temporalScopePaths(cwd, "owner", scope, root);
		if (fault === "malformed") writeFileSync(paths.checkpoint, "malformed");
		else { rmSync(paths.checkpoint); if (fault === "absent") rmSync(paths.patches); }
		const before = captureTemporalFileBases(cwd, "owner", root);
		const state = runtime.states();
		const patches = { [scope]: { working: { fresh: true } }, session: { working: { accepted: true } } };
		if (fault === "absent") {
			await patchCurrent(runtime, snapshot, patches);
			assert.deepEqual(runtime.read(0, scope).working, { fresh: true });
			assert.deepEqual(runtime.read(0, "session").working, { private: true, accepted: true });
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
	for (const enabled of [false, true]) for (const unfinished of [false, true]) {
		const root = mkdtempSync(join(tmpdir(), "state-flow-current-start-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const runtime = new TemporalRuntime(cwd, "session", root);
		const snapshot = emptySnapshot(enabled);
		if (unfinished) snapshot.meta.specification = "Interrupted old request";
		runtime.initialize(snapshot, true);
		const before = runtime.states();
		const next = structuredClone(before);
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		for (const scope of ["global", "cwd", "session"] as const) {
			next[scope].working.owner = scope;
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
		assert.equal((await reader.refreshCurrentMemory())!.config.enabled, false);
		assert.deepEqual(reader.states(), runtime.states());
		assert.deepEqual(captureTemporalFileBases(cwd, "session", root), cohort, "current-memory inspection never publishes policy or a new origin");
		const active = new TemporalRuntime(cwd, "session", root);
		const accept = (current: Snapshot, publish: (value: Snapshot) => unknown) => {
			assert.equal(current.meta.specification, undefined, "old unfinished prompts are not new-run authority");
			publish({ ...current, config: { enabled: true } });
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
	const other = emptySnapshot(true);
	second.initialize(other, true);
	publishScopedPatch(second, other, "global", { shared: "new" }, "second-shared");
	publishScopedPatch(second, other, "session", { owner: "second" }, "second-private");
	const current = new TemporalRuntime(cwd, "first", root);
	const selected = await current.withStartTransaction((snapshot, publish) => {
		publish({ ...snapshot!, config: { enabled: true } });
		return snapshot!;
	});
	assert.equal(current.read().working.private, "retained");
	assert.equal(current.read().working.shared, "new");
	assert.equal(current.read(0, "session").working.owner, undefined);
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
		config.enabled = true;
		// Nonparticipating writers can replace a file despite the cooperative lock.
		writeFileSync(path, JSON.stringify(config));
		files = captureTemporalFileBases(cwd, "passive-session", root);
		publish({ ...current!, config: { enabled: true } });
	}), /base or scope identity changed concurrently/);
	assert.equal(activation.view, undefined);
	assert.deepEqual(captureTemporalFileBases(cwd, "passive-session", root), files);
});

test("awaited Start authorizes absent private memory only inside its single-use acceptance", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-start-authority-"));
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
	assert.throws(() => borrowed(emptySnapshot(true)), /transaction has ended/);
	assert.equal(runtime.view, undefined);
	await assert.rejects(withStorageTransaction(root, () => runtime.withStartTransaction(() => assert.fail("recursive Start ran"))), /Recursive/);
	const late = new AbortController();
	await runtime.withStartTransaction((current, publish) => {
		assert.equal(current, undefined);
		assert.equal(publish(emptySnapshot(true)).changed, true);
		assert.throws(() => publish(emptySnapshot()), /already consumed/);
		late.abort();
	}, late.signal, true);
	const accepted = captureTemporalFileBases(parent, "owner", root);
	assert.equal((await runtime.withStartTransaction((current, publish) => publish({ ...current!, config: { enabled: true } }))).changed, false);
	assert.deepEqual(captureTemporalFileBases(parent, "owner", root), accepted);
});

test("awaited Start rejects unaccepted candidates and preserves the exact cohort on publication failure", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-start-rollback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot();
	await patchCurrent(runtime, snapshot, { session: { working: { retained: true } } });
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
		await assert.rejects(activation.withStartTransaction((current, publish) => publish({ ...current!, config: { enabled: true } })), /injected Start publication failure/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.deepEqual(activation.view, cached);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before);
	await activation.withStartTransaction((current, publish) => publish({ ...current!, config: { enabled: true } }));
	assert.deepEqual(activation.read(0, "session").working, { retained: true });
});

test("passive memory admits global state before a CWD has materialized", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-global-passive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeGlobalState({ ...emptyState(), working: { preference: "global" } }, root);
	const runtime = new TemporalRuntime("/new-project", "new-session", root);
	assert.equal(runtime.loadPassive(), true);
	assert.equal(runtime.read(0, "global").working.preference, "global");
	assert.deepEqual(runtime.read(0, "cwd"), emptyState());
});

for (const operation of ["restore", "awaited-restore", "fork", "awaited-fork"] as const) for (const [limit, offset] of [[0, 0], [1, 0], [1, 1], [12, 0]] as const) {
	test(`${operation} applies historyLimit ${limit} to stored tails at selected offset ${offset}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-retention-change-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot(true);
		parent.initialize(snapshot, true);
		const checkpoints = [parent.retainedCheckpoint(snapshot)];
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		for (let index = 1; index <= 6; index++) {
			const before = parent.states();
			const next = structuredClone(before);
			for (const scope of ["global", "cwd", "session"] as const) {
				next[scope].working.index = index;
				next[scope].artifacts["/unchanged.txt"] = { description: "Stable compilation" };
			}
			snapshot.meta.step++;
			parent.publish(snapshot, true, createAcceptedTransition(before, next), { provenance: {
				global: { "/unchanged.txt": evidence }, cwd: { "/unchanged.txt": evidence }, session: { "/unchanged.txt": evidence },
			} });
			checkpoints.push(parent.retainedCheckpoint(snapshot));
		}
		const beforeFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, operation.endsWith("fork") ? "child" : parent.sessionId, root, undefined, limit);
		if (limit < 6) {
			const outside = checkpoints.at(-limit - 2)!;
			assert.ok("boundary" in outside);
			if (operation === "awaited-fork") await assert.rejects(forkAwaited(selected, { id: parent.sessionId, key: parent.sessionKey }, outside), /outside the retained temporal window/);
			else if (operation === "awaited-restore") await assert.rejects(restoreAwaited(selected, outside), /outside the retained temporal window/);
			else assert.throws(() => operation === "fork"
				? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, outside)
				: selected.prepareBoundaryRestore(outside), /outside the retained temporal window/);
			assert.deepEqual(captureTemporalFileBases(cwd, parent.sessionId, root), beforeFiles);
		}
		const checkpoint = checkpoints.at(-offset - 1)!;
		assert.ok("boundary" in checkpoint);
		const accepted = operation === "awaited-fork" ? await forkAwaited(selected, { id: parent.sessionId, key: parent.sessionKey }, checkpoint)
			: operation === "awaited-restore" ? await restoreAwaited(selected, checkpoint) : operation === "fork"
			? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, checkpoint).fork()
			: selected.restoreBoundary(checkpoint);
		assert.equal(accepted.snapshot.meta.step, operation.endsWith("fork") ? 0 : checkpoint.step);
		for (const scope of ["global", "cwd", "session"] as const) {
			assert.equal(selected.read(0, scope).working.index, scope === "session" ? 6 - offset : 6);
			assert.deepEqual(selected.artifactProvenance(scope), { "/unchanged.txt": evidence });
			assert.ok(selected.view!.scopes[scope].patches.length <= limit);
			const paths = temporalScopePaths(cwd, selected.sessionId, scope, root);
			assert.ok(readFileSync(paths.patches, "utf8").split("\n").filter(Boolean).length <= limit);
		}
		if (operation.endsWith("fork")) {
			const directory = temporalScopePaths(cwd, parent.sessionId, "session", root).directory;
			const privateFiles = (files: ReturnType<typeof captureTemporalFileBases>) => files.filter(({ path }) => dirname(path) === directory);
			assert.deepEqual(privateFiles(captureTemporalFileBases(cwd, parent.sessionId, root)), privateFiles(beforeFiles));
		}
		const smallerTails = structuredClone(selected.view!.scopes);
		const ownCheckpoint = selected.retainedCheckpoint(accepted.snapshot);
		assert.ok("boundary" in ownCheckpoint);
		const increased = new TemporalRuntime(cwd, selected.sessionId, root, undefined, 12);
		const resumed = (operation === "awaited-restore" ? await restoreAwaited(increased, ownCheckpoint) : increased.restoreBoundary(ownCheckpoint)).snapshot;
		assert.deepEqual(increased.view!.scopes, smallerTails, "raising retention cannot reconstruct folded tails");
		assert.throws(() => increased.read(1), /predates the proven temporal origin/);
		const before = increased.states();
		const next = structuredClone(before);
		next.session.working.next = true;
		resumed.meta.step++;
		increased.publish(resumed, true, createAcceptedTransition(before, next));
		assert.deepEqual(increased.read(1, "session"), before.session);
	});
}

for (const operation of ["restore", "awaited-restore", "fork", "awaited-fork"] as const) for (const selection of ["historical", "head"] as const) {
	test(`${operation} keeps only matching artifact provenance at the ${selection} boundary`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-provenance-selection-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot(true);
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
		const checkpoint = selection === "head" ? parent.retainedCheckpoint(snapshot) : historical;
		assert.ok("boundary" in checkpoint);
		const parentFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, operation.endsWith("fork") ? "child" : parent.sessionId, root);
		const accepted = operation === "awaited-fork" ? await forkAwaited(selected, { id: parent.sessionId, key: parent.sessionKey }, checkpoint)
			: operation === "awaited-restore" ? await restoreAwaited(selected, checkpoint) : operation === "fork"
			? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, checkpoint).fork()
			: selected.restoreBoundary(checkpoint);
		const expected: ArtifactProvenanceRegistry = selection === "head"
			? parent.artifactProvenance("session")
			: { "/untouched.txt": evidence(3) };
		assert.deepEqual(selected.read(0, "session").artifacts, (selection === "head" ? returned : initial).session.artifacts);
		assert.deepEqual(selected.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, "session", root, selected.sessionKey), expected);
		for (const scope of ["global", "cwd"] as const) {
			assert.deepEqual(selected.read(0, scope).artifacts, changed[scope].artifacts);
			assert.deepEqual(selected.artifactProvenance(scope), { "/shared.txt": evidence(2) });
			assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, scope, root, selected.sessionKey), { "/shared.txt": evidence(2) });
		}
		if (operation.endsWith("fork")) assert.deepEqual(captureTemporalFileBases(cwd, parent.sessionId, root), parentFiles);
		const meta = temporalScopePaths(cwd, selected.sessionId, "session", root).meta;
		assert.deepEqual(JSON.parse(readFileSync(meta, "utf8")).artifacts, expected);
		const ownCheckpoint = selected.retainedCheckpoint(accepted.snapshot);
		assert.ok("boundary" in ownCheckpoint);
		const reloaded = new TemporalRuntime(cwd, selected.sessionId, root);
		reloaded.restoreBoundary(ownCheckpoint);
		assert.deepEqual(reloaded.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, reloaded.sessionId, "session", root, reloaded.sessionKey), expected);
	});
}

for (const operation of ["restore", "awaited-restore", "fork", "awaited-fork"] as const) {
	test(`${operation} rejects contradictory session lineage before accepting a new origin`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-session-lineage-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const seed = (id: string) => {
			const runtime = new TemporalRuntime(cwd, id, root);
			const snapshot = emptySnapshot(true);
			runtime.initialize(snapshot, true);
			const before = runtime.states();
			const next = structuredClone(before);
			next.session.working.owner = id;
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
		if (operation === "awaited-fork") await assert.rejects(forkAwaited(selected, { id: "a", key: "a" }, checkpoint), /Conflicting State Flow temporal lineage/);
		else if (operation === "awaited-restore") await assert.rejects(restoreAwaited(selected, checkpoint), /Conflicting State Flow temporal lineage/);
		else assert.throws(() => operation === "restore"
			? selected.restoreBoundary(checkpoint)
			: selected.prepareBoundaryFork({ id: "a", key: "a" }, checkpoint).fork(), /Conflicting State Flow temporal lineage/);
		assert.equal(selected.view, undefined, "contradictory state must not become an accepted cache");
		assert.deepEqual(["a", "b", "child"].map((id) => captureTemporalFileBases(cwd, id, root)), before);
	});
}

test("awaited restoration never initializes missing evidence or substitutes foreign private authority", async (t) => {
	for (const fault of ["root", "global-absent", "cwd-partial", "session-meta", "runtime-malformed", "foreign-boundary"] as const) {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-restore-authority-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store");
		const runtime = new TemporalRuntime(parent, "owner", root);
		const snapshot = emptySnapshot(true);
		await patchCurrent(runtime, snapshot, { session: { working: { private: "OWNER" } } });
		let checkpoint = runtime.retainedCheckpoint(snapshot);
		if (fault === "root") rmSync(root, { recursive: true });
		else if (fault === "global-absent") { rmSync(join(root, "checkpoint.json")); rmSync(join(root, "patches.jsonl")); }
		else if (fault === "cwd-partial") rmSync(temporalScopePaths(parent, "owner", "cwd", root).patches);
		else if (fault === "session-meta") rmSync(temporalScopePaths(parent, "owner", "session", root).meta);
		else if (fault === "runtime-malformed") writeFileSync(sessionRuntimePaths(parent, "owner", root).runtime, "not JSON");
		else {
			const peer = new TemporalRuntime(parent, "peer", root);
			const other = emptySnapshot(true);
			await patchCurrent(peer, other, { session: { working: { private: "FOREIGN" } } });
			checkpoint = peer.retainedCheckpoint(other);
		}
		assert.ok("boundary" in checkpoint);
		const files = ["owner", "peer"].map((id) => captureTemporalFileBases(parent, id, root));
		const cached = structuredClone(runtime.view);
		await assert.rejects(runtime.withRestoreTransaction(checkpoint, () => assert.fail("invalid restoration reached acceptance")), /unavailable|incomplete|unsupported|invalid JSON|outside the retained temporal window/i, fault);
		assert.deepEqual(["owner", "peer"].map((id) => captureTemporalFileBases(parent, id, root)), files, fault);
		assert.deepEqual(runtime.view, cached, fault);
		if (fault === "root") assert.equal(existsSync(root), false);
	}
});

for (const operation of ["restore", "fork"] as const) test(`awaited ${operation} checks retention after waiting instead of accepting an expired prepared view`, { timeout: 5_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-restore-expiry-"));
	const runtime = new TemporalRuntime(root, "owner", root, undefined, 1);
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "SELECTED" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const cached = structuredClone(runtime.view);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const cancellation = new AbortController();
	let restoring: Promise<unknown> | undefined;
	const holder = withStorageTransaction(root, async (storage) => {
		enter(); await gate;
		let view = structuredClone(runtime.view!);
		let states = runtime.states();
		const latest = structuredClone(snapshot);
		for (let step = 0; step < 2; step++) {
			const next = structuredClone(states);
			next.session.working.value = `LATER-${step}`;
			const transition = createAcceptedTransition(states, next);
			assert.ok(transition);
			view = advanceTemporalState(view, transition.transitions, transition.id, 1);
			states = next;
			latest.meta.step++;
		}
		storage.publish(root, "owner", view, ["global", "cwd", "session"], storage.capture(root, "owner", root), root,
			createSessionRuntime(latest, root, "owner", view.lineage), "owner");
	});
	t.after(async () => {
		cancellation.abort(); release();
		await Promise.allSettled([holder, restoring]);
		rmSync(root, { recursive: true, force: true });
	});
	await entered;
	const child = new TemporalRuntime(root, "child", root, undefined, 1);
	restoring = operation === "fork"
		? child.withForkTransaction({ id: "owner", key: "owner" }, checkpoint, () => assert.fail("expired source reached acceptance"), cancellation.signal)
		: runtime.withRestoreTransaction(checkpoint, () => assert.fail("expired selection reached acceptance"), cancellation.signal);
	const refused = assert.rejects(restoring, /outside the retained temporal window/);
	await delay(40);
	assert.deepEqual(runtime.view, cached);
	release(); await holder;
	const winner = captureTemporalFileBases(root, "owner", root);
	await refused;
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), winner);
	assert.deepEqual(runtime.view, cached, "failed selection does not install the later canonical head as a substitute");
	assert.equal(child.view, undefined);
	assert.equal(existsSync(temporalScopePaths(root, "child", "session", root).directory), false);
	const current = new TemporalRuntime(root, "owner", root);
	assert.ok(await current.refreshCurrentMemory());
	assert.equal(current.read(0, "session").working.value, "LATER-1");
});

for (const target of ["checkpoint", "runtime"] as const) test(`awaited restoration fences a private ${target} race without replacing concurrent bytes`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-restore-cas-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "SELECTED" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "LATER" } } });
	const cached = structuredClone(runtime.view);
	let winner: ReturnType<typeof captureTemporalFileBases> | undefined;
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, (selected, publish) => {
		const path = target === "checkpoint" ? temporalScopePaths(root, "owner", "session", root).checkpoint : sessionRuntimePaths(root, "owner", root).runtime;
		writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("\n")]));
		winner = captureTemporalFileBases(root, "owner", root);
		return publish(selected);
	}), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), winner);
	assert.deepEqual(runtime.view, cached);
	await restoreAwaited(runtime, checkpoint);
	assert.equal(runtime.read(0, "session").working.value, "SELECTED");
});

test("awaited restoration rolls back a failed cohort without installing selected history or shared adoption", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-restore-rollback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "SELECTED" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "LATER" } } });
	await patchCurrent(new TemporalRuntime(root, "peer", root), emptySnapshot(), { global: { working: { peer: true } } });
	const before = captureTemporalFileBases(root, "owner", root);
	const cached = structuredClone(runtime.view);
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === sessionRuntimePaths(root, "owner", root).runtime) { failed = true; throw new Error("injected restore publication failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	try { await assert.rejects(restoreAwaited(runtime, checkpoint), /injected restore publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before);
	assert.deepEqual(runtime.view, cached);
	await restoreAwaited(runtime, checkpoint);
	assert.deepEqual(runtime.read().working, { peer: true, value: "SELECTED" });
});

test("restore capabilities expire, reject obsolete policy and install accepted memory before returning to the caller", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-restore-capability-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "SELECTED" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	await patchCurrent(runtime, snapshot, { session: { working: { value: "LATER" } } });
	const before = captureTemporalFileBases(root, "owner", root);
	const cached = structuredClone(runtime.view);
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, () => assert.fail("pre-aborted selection ran"), AbortSignal.abort()), { name: "AbortError" });
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, () => { throw new Error("caller selection superseded"); }), /caller selection superseded/);
	let borrowed!: (snapshot: Snapshot) => unknown;
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, (_selected, publish) => { borrowed = publish; }), /requires one synchronous publication/);
	assert.throws(() => borrowed(snapshot), /transaction has ended/);
	await assert.rejects(withStorageTransaction(root, () => restoreAwaited(runtime, checkpoint)), /Recursive/);
	const canceled = new AbortController();
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, (selected, publish) => {
		canceled.abort(); return publish(selected);
	}, canceled.signal), { name: "AbortError" });
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before);
	assert.deepEqual(runtime.view, cached);
	const late = new AbortController();
	await assert.rejects(runtime.withRestoreTransaction(checkpoint, (selected, publish) => {
		assert.equal(runtime.read(0, "session").working.value, "LATER", "staging cannot install the historical view");
		const result = publish(selected);
		assert.equal(result.changed, true);
		assert.equal(runtime.read(0, "session").working.value, "SELECTED", "caller checkpointing sees accepted memory before yielding");
		assert.throws(() => publish(selected), /already consumed/);
		late.abort();
		throw new Error("post-acceptance checkpoint failure");
	}, late.signal), /post-acceptance checkpoint failure/);
	const accepted = captureTemporalFileBases(root, "owner", root);
	assert.notDeepEqual(accepted, before);
	assert.equal(runtime.read(0, "session").working.value, "SELECTED");
	assert.equal(runtime.view!.lineage.length, 1);
	assert.throws(() => runtime.read(1), /predates the proven temporal origin/);
	await runtime.withLifecycleTransaction((publish) => publish({ config: { enabled: false }, meta: { step: checkpoint.step } }));
	assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(root, "owner", root).config, "utf8")).enabled, false);
});

async function forkFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-awaited-fork-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const parent = new TemporalRuntime(root, "parent", root);
	const snapshot = emptySnapshot(false);
	snapshot.meta.bootstrap = true;
	snapshot.meta.specification = "Parent unfinished request";
	await patchCurrent(parent, snapshot, { session: { working: { value: "SELECTED" } } });
	const checkpoint = parent.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	await patchCurrent(parent, snapshot, { session: { working: { value: "LATER" } } });
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

test("awaited fork rejects invalid source identity, missing authority and expired history without initializing a child", async (t) => {
	for (const fault of ["same-id", "same-key", "wrong-id", "missing", "expired", "malformed"] as const) {
		const { root, child, source, checkpoint } = await forkFixture(t);
		if (fault === "same-id") source.id = "child";
		if (fault === "same-key") source.key = "child";
		if (fault === "wrong-id") source.id = "another";
		if (fault === "missing") rmSync(sessionRuntimePaths(root, "parent", root).runtime);
		if (fault === "expired") checkpoint.boundary = "unretained";
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
	assert.deepEqual(accepted.snapshot, { config: { enabled: false }, meta: { step: 0, bootstrap: true } });
	assert.equal(child.read(0, "session").working.value, "SELECTED");
	assert.deepEqual(captureTemporalFileBases(root, "parent", root), before[0]);
	await patchCurrent(child, accepted.snapshot, { session: { working: { child: true } } });
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
		assert.equal(child.read(0, "session").working.value, "SELECTED");
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
		global: { working: { shared: true } }, cwd: { working: { project: true } }, session: { working: { secret: "FOREIGN" } },
	});
	const before = ["parent", "foreign"].map((id) => captureTemporalFileBases(root, id, root));
	const reader = new TemporalRuntime(root, "parent", root, undefined, limit);
	const snapshot = await reader.refreshCurrentMemory();
	assert.deepEqual(snapshot, { config: { enabled: false }, meta: { step: 2, bootstrap: true } });
	assert.deepEqual(reader.read().working, { shared: true, project: true, value: "LATER" });
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
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.deepEqual(h.entries.at(-1).data, { disabled: true });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(head(), before);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.throws(() => h.readState(), /runtime is unavailable/);
});

test("runtime causal basis rejects staged work after accepted history returns to identical values", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "causal-stage", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
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
	working: JsonObject,
	id: string,
) {
	const before = runtime.states();
	const after = structuredClone(before);
	after[scope].working = { ...after[scope].working, ...structuredClone(working) };
	snapshot.meta.step += 1;
	return runtime.publish(snapshot, true, createAcceptedTransition(before, after, id));
}

for (const scope of ["global", "cwd"] as const) for (const write of ["session", "provenance", "target"] as const) {
	test(`first passive ${write} publication reconciles or fences foreign ${scope} drift`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-passive-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "extensions");
		const otherScope = scope === "global" ? "cwd" : "global";
		const source = join(root, "source.txt");
		const a = new TemporalRuntime(cwd, "session-a", root);
		const aSnapshot = emptySnapshot(true);
		a.initialize(aSnapshot, true);
		const seed = a.states();
		const seeded = structuredClone(seed);
		seeded[otherScope].artifacts[source] = { description: "Known source" };
		seeded.session.working.private = "session-a only";
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
			[write === "target" ? scope : "session"]: { working: { mine: "accepted" } },
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
		assert.equal(snapshot.config.enabled, false);
		assert.equal(b.read(0, scope).working.neighbor, "accepted");
		assert.equal(b.read(0, "session").working.private, undefined);
		if (write === "session") {
			assert.equal(b.read(0, "session").working.mine, "accepted");
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
		const checkpoint = b.retainedCheckpoint(snapshot);
		assert.ok("boundary" in checkpoint);
		const restored = new TemporalRuntime(cwd, b.sessionId, root);
		restored.prepareBoundaryRestore(checkpoint).restore();
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
	const snapshot = emptySnapshot(true);
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
	const checkpoint = owner.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const prepared = new TemporalRuntime(parent, "owner", root);
	prepared.prepareBoundaryRestore(checkpoint).restore();
	for (const runtime of [unselected, passive, readOnly, prepared]) {
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
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { private: "retained" } } });
	await patchCurrent(new TemporalRuntime(cwd, "peer", root), emptySnapshot(true), { global: { working: { foreign: "accepted" } } });
	const cached = structuredClone(runtime.view);
	const files = captureTemporalFileBases(cwd, "owner", root);
	const stopped = { ...structuredClone(snapshot), config: { enabled: false } };
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
	assert.equal(runtime.read(0, "global").working.foreign, "accepted");
	assert.deepEqual(runtime.read(0, "session").working, { private: "retained" });
	assert.equal(stopped.meta.step, snapshot.meta.step);
});

for (const fault of ["absent", "partial", "malformed"] as const) test(`lifecycle transactions do not repair ${fault} shared storage`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-incomplete-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	const cached = structuredClone(runtime.view);
	if (fault === "malformed") writeFileSync(join(root, "meta.json"), "not JSON\n");
	else {
		rmSync(join(root, "checkpoint.json"));
		if (fault === "absent") rmSync(join(root, "patches.jsonl"));
	}
	const files = captureTemporalFileBases(root, "owner", root);
	await assert.rejects(runtime.withLifecycleTransaction((publish) => publish({ ...snapshot, config: { enabled: false } })), /incomplete|missing|metadata|JSON/i);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), files);
	assert.deepEqual(runtime.view, cached);
});

test("lifecycle capabilities are synchronous, single-use and cancelable only before acceptance", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-capability-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
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
		const result = publish({ ...snapshot, config: { enabled: false } });
		assert.throws(() => publish(snapshot), /already consumed/);
		late.abort();
		return result;
	}, late.signal);
	assert.equal(accepted.changed, true, "post-acceptance cancellation cannot undo saved lifecycle");
	const files = captureTemporalFileBases(root, "owner", root);
	assert.equal((await runtime.withLifecycleTransaction((publish) => publish({ ...snapshot, config: { enabled: false } }))).changed, false);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), files);
	assert.equal(existsSync(join(root, ".state-flow-publication.lock")), false);
});

test("no-transition patch acceptance distinguishes missing shared initialization from a metadata-only no-op", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-preparation-absence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { cwd: { working: { old: "never resurrect" } }, session: { working: { private: true } } });
	const step = snapshot.meta.step;
	const paths = temporalScopePaths(root, "owner", "cwd", root);
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
	const before = captureTemporalFileBases(root, "owner", root);
	await assert.rejects(runtime.withLifecycleTransaction((publish) => publish(snapshot)), /Incomplete file-only temporal scope cohort/);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), before, "the explicit runtime-only API never repairs semantic storage");
	const next = { ...snapshot, meta: { ...snapshot.meta, specification: "Current request" } };
	await runtime.withPatchTransaction((tx) => {
		assert.deepEqual(tx.states.cwd, emptyState());
		assert.deepEqual(tx.provenance.cwd, {});
		assert.equal(tx.publish(next).changed, true);
		assert.throws(() => tx.publish(next), /already consumed/);
	});
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
	assert.deepEqual(runtime.read(0, "cwd"), emptyState());
	assert.deepEqual(runtime.read(0, "session").working, { private: true });
	assert.equal(next.meta.step, step, "initializing the current empty reality is not a semantic transition");
	const accepted = captureTemporalFileBases(root, "owner", root);
	await runtime.withPatchTransaction((tx) => assert.equal(tx.publish(next).changed, false));
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), accepted);
});

test("lifecycle authority is checked again after waiting without overwriting a newer selected view", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-selection-"));
	const runtime = new TemporalRuntime(root, "owner", root);
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const prepared = runtime.prepareBoundaryRestore(checkpoint);
	const files = captureTemporalFileBases(root, "owner", root);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const lifetime = new AbortController();
	const holder = withStorageTransaction(root, () => gate);
	const pending = runtime.withLifecycleTransaction(() => assert.fail("obsolete lifecycle action ran"), lifetime.signal);
	const refused = assert.rejects(pending, /requires an accepted runtime/);
	t.after(async () => {
		lifetime.abort();
		release();
		await holder;
		await pending.catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	});
	prepared.restore();
	const selected = structuredClone(runtime.view);
	release();
	await holder;
	await refused;
	assert.deepEqual(runtime.view, selected);
	assert.deepEqual(captureTemporalFileBases(root, "owner", root), files);
});

for (const mode of ["raw", "awaited", "preparation"] as const) for (const scope of ["global", "cwd"] as const) for (const historyLimit of [0, 7]) for (const drift of ["state", "provenance"] as const) {
	test(`${mode} lifecycle-only publication adopts ${scope} ${drift} drift at limit ${historyLimit} without touching semantic files`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const a = new TemporalRuntime(cwd, "session-a", root, undefined, historyLimit);
		const snapshot = emptySnapshot(true);
		a.initialize(snapshot, true);
		const source = join(root, "registered.txt");
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		const before = a.states();
		const seeded = structuredClone(before);
		seeded[scope].artifacts[source] = { description: "Registered compilation" };
		seeded.session.working.private = "retained";
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
			const snapshot = emptySnapshot(true);
			b.initialize(snapshot, true);
			const before = b.states();
			const next = structuredClone(before);
			if (drift === "state") { next[scope].working.foreign = "accepted"; snapshot.meta.step++; }
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
		stopped.config.enabled = false;
		const persist = (value: Snapshot) => mode === "raw" ? a.publish(value)
			: mode === "preparation" ? a.withPatchTransaction((tx) => tx.publish(value))
			: a.withLifecycleTransaction((publish) => publish(value));
		assert.equal((await persist(stopped))?.changed, true);
		assert.equal(JSON.parse(readFileSync(runtimePaths.config, "utf8")).enabled, false);
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).step, snapshot.meta.step);
		assert.deepEqual(protectedFiles(), retained);
		assert.deepEqual(a.read(0, "session"), privateState);
		assert.deepEqual(a.artifactProvenance(scope), document.artifacts, "Stop must not prune unrelated evidence");
		if (drift === "state") {
			assert.equal(a.read(0, scope).working.foreign, "accepted");
			assert.notEqual(a.causalBasis(), previousHead);
			assert.equal(a.view!.lineage.length, 1);
			assert.equal(a.view!.lineage[0]!.parent, null, "shared adoption is an origin, not a semantic transition");
		} else assert.equal(a.causalBasis(), previousHead);
		const stoppedFiles = captureTemporalFileBases(cwd, a.sessionId, root);
		assert.equal((await persist(stopped))?.changed, mode === "raw" ? undefined : false, "unchanged lifecycle persistence must not fabricate another origin");
		assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), stoppedFiles);
		const restarted = structuredClone(stopped);
		restarted.config.enabled = true;
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
	const snapshot = emptySnapshot(true);
	a.initialize(snapshot, true);
	const checkpoint = a.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const other = new TemporalRuntime(cwd, a.sessionId, root);
	const current = other.restoreBoundary(checkpoint).snapshot;
	if (conflict === "private-state") publishScopedPatch(other, current, "session", { other: "accepted" }, "competing-private-write");
	else {
		current.meta.specification = "Competing request";
		other.publish(current);
	}
	const files = captureTemporalFileBases(cwd, a.sessionId, root);
	const cached = structuredClone(a.view);
	const stopped = structuredClone(snapshot);
	stopped.config.enabled = false;
	assert.throws(() => a.publish(stopped), /base or scope identity changed concurrently/);
	await assert.rejects(a.withLifecycleTransaction((publish) => publish(stopped)), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), files);
	assert.deepEqual(a.view, cached);
});

for (const operation of ["inspection", "lifecycle", "restore", "fork", "recovery"] as const) test(`awaited ${operation} sees one completed foreign cohort, stays cancelable and preserves private memory`, { timeout: 15_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-shared-inspect-"));
	const cwd = join(root, "project");
	const runtime = new TemporalRuntime(cwd, "owner", root);
	const snapshot = emptySnapshot(true);
	if (operation === "restore" || operation === "fork") snapshot.meta.specification = "Selected checkpoint request";
	await patchCurrent(runtime, snapshot, { session: { working: { private: "LOCAL" } } });
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const originalCheckpoint = structuredClone(checkpoint);
	if (operation === "restore" || operation === "fork") await patchCurrent(runtime, snapshot, { session: { working: { private: "NEWER-CACHED" } } });
	const childRuntime = new TemporalRuntime(cwd, "child", root);
	const source = { id: "owner", key: "owner" };
	let restoreEnabled = true;
	const cached = structuredClone(runtime.view);
	const ready = join(root, "ready");
	const release = join(root, "release");
	const receipt = join(root, "receipt.json");
	const lifetime = new AbortController();
	let pending: Promise<boolean> | undefined;
	const run = (signal?: AbortSignal) => operation === "inspection" ? runtime.refreshShared(signal)
		: operation === "recovery" ? runtime.refreshCurrentMemory(signal).then((selected) => {
			assert.ok(selected);
			assert.equal(selected.config.enabled, false);
			assert.equal(selected.meta.specification, undefined);
			return true;
		})
		: operation === "fork" ? childRuntime.withForkTransaction(source, checkpoint, (selected, publish) => {
			assert.equal(selected.meta.step, 0);
			assert.equal(selected.meta.specification, undefined);
			assert.equal(selected.config.enabled, originalCheckpoint.enabled);
			return publish({ ...selected, config: { enabled: restoreEnabled } });
		}, signal).then(({ changed }) => changed)
		: operation === "restore" ? runtime.withRestoreTransaction(checkpoint, (selected, publish) => {
			assert.equal(selected.meta.specification, originalCheckpoint.specification);
			assert.equal(selected.meta.step, originalCheckpoint.step);
			assert.equal(selected.config.enabled, originalCheckpoint.enabled);
			return publish({ ...selected, config: { enabled: restoreEnabled } });
		}, signal).then(({ changed }) => changed)
		: runtime.withLifecycleTransaction((publish) => publish({ ...structuredClone(snapshot), config: { enabled: false } }), signal).then(({ changed }) => changed);
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
				global: { working: { global: "COMPLETE" }, artifacts: { "/compiled": { description: "Complete card" } } },
				cwd: { working: { cwd: "COMPLETE" } }, session: { working: { secret: "FOREIGN" } },
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
	restoreEnabled = false;
	source.id = "wrong-parent"; source.key = "wrong-parent";
	checkpoint.boundary = "mutated-after-admission";
	checkpoint.step = 999;
	checkpoint.enabled = false;
	checkpoint.specification = "Caller mutation must not change the selected pointer";
	await delay(2_200);
	assert.equal(ended, false);
	assert.deepEqual(runtime.view, cached, "partial foreign files never replace accepted memory");
	assert.equal(readFileSync(join(root, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	writeFileSync(release, "continue");
	assert.equal((await closed)[0], 0);
	assert.equal(await pending, true);
	if (operation === "fork") {
		assert.deepEqual(runtime.view, cached, "fork cannot install a historical view into its parent");
		assert.deepEqual(childRuntime.read().working, { global: "COMPLETE", cwd: "COMPLETE", private: "LOCAL" });
		assert.deepEqual(temporalScopeRevisions(childRuntime.view!), { global: 1, cwd: 1, session: 1 });
		assert.deepEqual(childRuntime.artifactProvenance("global")["/compiled"]!.sourceFingerprint, { size: 7, mtimeNs: "10" });
		const received = JSON.parse(readFileSync(receipt, "utf8"));
		for (const id of ["owner", "foreign"]) assert.deepEqual(captureTemporalFileBases(cwd, id, root).map(({ path, identity }) => ({ path, identity })), received[id]);
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(cwd, "child", root).config, "utf8")).enabled, false);
		assert.equal(JSON.parse(readFileSync(sessionRuntimePaths(cwd, "child", root).runtime, "utf8")).step, 0);
		return;
	}
	const runtimePaths = sessionRuntimePaths(cwd, "owner", root);
	const privateDirectory = temporalScopePaths(cwd, "owner", "session", root).directory + "/";
	const protectedFiles = (files: Array<{ path: string; identity: string }>) => files.filter(({ path }) => operation === "inspection" || operation === "recovery"
		|| (operation === "restore" ? !path.startsWith(privateDirectory) : path !== runtimePaths.config && path !== runtimePaths.runtime)).map(({ path, identity }) => ({ path, identity }));
	const canonical = captureTemporalFileBases(cwd, "owner", root);
	const received = JSON.parse(readFileSync(receipt, "utf8"));
	assert.deepEqual(protectedFiles(canonical), protectedFiles(received.owner));
	const foreignDirectory = temporalScopePaths(cwd, "foreign", "session", root).directory + "/";
	const foreignPrivate = (files: Array<{ path: string; identity: string }>) => files.filter(({ path }) => path.startsWith(foreignDirectory)).map(({ path, identity }) => ({ path, identity }));
	assert.equal(foreignPrivate(received.foreign).length, 5);
	assert.deepEqual(foreignPrivate(captureTemporalFileBases(cwd, "foreign", root)), foreignPrivate(received.foreign));
	if (operation === "recovery") await assert.rejects(runtime.withLifecycleTransaction((publish) => publish(snapshot)), /requires an accepted runtime/);
	if (operation !== "inspection" && operation !== "recovery") {
		assert.equal(JSON.parse(readFileSync(runtimePaths.config, "utf8")).enabled, false);
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).specification, operation === "restore" ? originalCheckpoint.specification : snapshot.meta.specification);
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).step, operation === "restore" ? originalCheckpoint.step : snapshot.meta.step);
	}
	assert.deepEqual(runtime.read().working, { global: "COMPLETE", cwd: "COMPLETE", private: "LOCAL" });
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
	writeGlobalState({ ...emptyState(), working: { retained: true } }, root);
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
	assert.equal(runtime.read().working.retained, true);
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
	const snapshot = emptySnapshot(true);
	await patchCurrent(runtime, snapshot, { session: { working: { private: "accepted" } } });
	const cached = structuredClone(runtime.view);
	const checkpoint = runtime.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const competing = new TemporalRuntime(cwd, "owner", root);
	const restored = competing.restoreBoundary(checkpoint).snapshot;
	await patchCurrent(competing, restored, { global: { working: { current: true } }, session: { working: { private: "different" } } });
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
	const snapshot = emptySnapshot(true);
	a.initialize(snapshot, true);
	publishScopedPatch(a, snapshot, "session", { sessionA: "retained" }, "a-file-seed");
	const b = new TemporalRuntime(cwd, "session-b", root);
	b.prepare();
	b.initialize(emptySnapshot(true), true);
	publishScopedPatch(b, emptySnapshot(true), "global", { globalAdvanced: "file" }, "b-file-advance");
	const beforeRefresh = captureTemporalFileBases(cwd, a.sessionId, root);
	assert.equal(await a.refreshShared(), true);
	assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), beforeRefresh);
	assert.deepEqual(temporalScopeRevisions(a.view!), { global: 1, cwd: 0, session: 1 });
	const publication = publishScopedPatch(a, snapshot, "session", { sessionPatch: "applied" }, "a-file-drift")!;
	assert.ok(publication.revision);
	validateTemporalState(a.view!);
	assert.equal(a.read().working.globalAdvanced, "file");
	assert.equal(a.read().working.sessionA, "retained");
	assert.equal(a.read().working.sessionPatch, "applied");
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
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	publishScopedPatch(runtime, snapshot, "cwd", { must_not_resurrect: "old-file-value" }, "file-cwd-seed");
	removeSharedPair(root, cwd, "cwd");
	const publication = publishScopedPatch(runtime, snapshot, "session", { sessionPatch: "applied" }, "file-cwd-repair")!;
	assert.ok(publication.revision);
	assert.equal(runtime.read(0, "cwd").working.must_not_resurrect, undefined);
	assert.equal(runtime.read().working.sessionPatch, "applied");
	const paths = temporalScopePaths(cwd, "session-a", "cwd", root);
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
});
