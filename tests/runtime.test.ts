import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as currentFixture from "./current-fixture.ts";
import * as currentAuthorFixture from "./current-author-fixture.ts";
import * as originFixture from "./origin-fixture.ts";
import * as lifecycleFixture from "./lifecycle-fixture.ts";
import * as sessionAcquisitionFixture from "./session-acquisition-fixture.ts";
import * as deferredForkFixture from "./deferred-fork-fixture.ts";
import * as readObservationFixture from "./read-observation-fixture.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { withStorageTransaction, loadSelectedFileCohort, assertSelectedFileCohortBasis, type SelectedFilePublication, type SelectedFileCohort, type SelectedForkCopyRequest, type SelectedSessionAcquisitionRequest, type StorageTransaction } from "../lib/storage.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeSessionHeader } from "../lib/continuation.ts";
import { TemporalRuntime, SharedScopeRemovalConflictError, type ForkLifecycle, type SelectedRuntimePatchTransaction } from "../lib/runtime.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths, type SessionAddress } from "../lib/durable.ts";
import { emptySnapshot, prepareRetainedPolicyMigration, type Snapshot } from "../lib/snapshot.ts";
import { emptyState, type AtomicScopePatches, type StateScope } from "../lib/state.ts";
import type { SuccessfulArtifactRead } from "../lib/acquisition.ts";
import { advanceTemporalState, constrainTemporalState, createTemporalState, readTemporalView, temporalScopeRevisions } from "../lib/temporal.ts";
import { commitSelectedTransition, stageSelectedScopePatches, stageSelectedScopedTransition, type StagedSelectedTransition } from "../lib/transition.ts";
import { commitScopedTerminal, harness, start } from "./harness.ts";
import { nativePolicyMarker, rewriteBaselineLifecycleAsNumeric, writeNumericLifecycleFixture } from "./temporal-fixture.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "../lib/selection.ts";

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
	writeNumericLifecycleFixture(cwd, owner, root, createTemporalState({ global: {}, cwd: {}, session: {} }, "sparse-origin"));
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
	assert.equal(await passive.refreshSelectedShared(["global", "cwd"], () => {}), true);
	assert.equal(passive.observedSelectedView()!.scopes.session, undefined);
	const loaded = new TemporalRuntime(cwd, owner, root);
	assert.ok(await loaded.refreshSelectedCurrent(DEFAULT_SCOPE_SELECTION, () => {}));
	assert.equal(loaded.observedSelectedView()!.scopes.global!.checkpoint.state.extra, undefined);
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
	await h.tools.get("state_flow_patch")!.execute("sparse-patch", patch, undefined, undefined, h.ctx);
	assert.equal(h.readState().response, "retained lower answer", "an unrelated patch must not introduce an empty response override");
	const accepted = files();
	await h.tools.get("state_flow_patch")!.execute("sparse-repeat", patch, undefined, undefined, h.ctx);
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
	await h.tools.get("state_flow_patch")!.execute("owned-global-write", { global: { tactics: { accepted: true } } }, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(readFileSync(temporalScopePaths(cwd, owner, "global", root).checkpoint, "utf8")).extra, undefined);
	await restored.refreshSelectedCurrent(DEFAULT_SCOPE_SELECTION, () => {});
	assert.deepEqual(temporalScopeRevisions(restored.observedSelectedView()!), { global: 1, cwd: 0, session: 1 });
	assert.equal(h.notifications.some((message) => /failed|unavailable/i.test(message)), false);
});

test("runtime keeps native session storage identity paired and detached from caller mutation", () => {
	const address = { id: "session-id", key: "timestamp_session-id" };
	const runtime = new TemporalRuntime("/project", address, "/store");
	address.id = "mutated";
	address.key = "mutated";
	assert.equal(runtime.sessionId, "session-id");
	assert.equal(runtime.sessionKey, "timestamp_session-id");
});

test("stopping an ordinary disabled session is harmless and does not initialize or publish storage", async () => {
	const h = harness();
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await h.commands.get("state-flow-off").handler("", h.ctx);
	await h.commands.get("state-flow-off").handler("", h.ctx);
	assert.equal(h.activeTools.includes("state_flow_patch"), false);
	assert.deepEqual(h.entries.at(-1).data, nativePolicyMarker(h.ctx.sessionManager.getSessionId(), "off"));
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("state_flow_patch"), false);
	assert.equal(head(), before);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.throws(() => h.readState(), /runtime is unavailable/);
});

test("current observation canceled during capture cannot install new memory", async t => {
	const f = await currentFixture.fixture(t, ["session"]);
	const reader = new TemporalRuntime(f.cwd, f.id, f.root);
	await reader.refreshSelectedCurrent(["session"], () => {});
	const cached = reader.observedSelectedView();
	await f.owner.withSelectedCurrentTransaction(["session"], (_snapshot, _publish, tx) => tx.publish(
		tx.snapshot, { id: "later-private", transitions: [{ scope: "session", patch: { tactics: { capture: "LATER-SELECTED" } } }] },
	), () => {});
	const before = captureTemporalFileBases(f.cwd, f.id, f.root);
	const controller = new AbortController();
	const read = fs.readFileSync;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const value = read(...args);
		if (value.toString().includes("LATER-SELECTED")) controller.abort(new Error("observation superseded during capture"));
		return value;
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	try { await assert.rejects(reader.refreshSelectedCurrent(["session"], () => {}, controller.signal), /superseded during capture/); }
	finally { fs.readFileSync = read; syncBuiltinESMExports(); }
	assert.deepEqual(reader.observedSelectedView(), cached);
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.id, f.root), before);
});

test("selected causal basis rejects staged work after history returns to identical values", async t => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-selected-causal-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = new TemporalRuntime(join(root, "project"), "causal", root);
	await runtime.withSelectedFirstPatchTransaction(["session"], emptySnapshot("active"), tx => tx.publish(tx.snapshot), () => {}, undefined, true);
	const initial = runtime.selectedStates();
	const basis = runtime.causalBasis();
	const origin = runtime.selectedView()!.lineage.at(-1)!;
	const stage = stageSelectedScopePatches(initial, { session: { intents: { stale: "Do not publish" } } }, [], basis);
	for (const [id, temporary] of [["z-first", "Advance and remove"], ["a-second", null]] as const) {
		await runtime.withSelectedPatchTransaction(tx => tx.publish(
			{ ...tx.snapshot, meta: { step: tx.snapshot.meta.step + 1 } },
			{ id, transitions: [{ scope: "session", patch: { intents: temporary === null ? null : { temporary } } }] },
		), () => {});
	}
	assert.deepEqual(runtime.selectedStates(), initial);
	assert.notEqual(runtime.causalBasis(), basis);
	assert.throws(() => commitSelectedTransition(runtime.selectedSnapshot(), runtime.selectedStates(), stage, () => assert.fail("stale publication"), runtime.causalBasis()), /causal basis changed/);
	const recent = runtime.recent();
	assert.deepEqual(recent.map(({ id, at }) => ({ id, at })), [{ id: "z-first", at: origin.position + 1 }, { id: "a-second", at: origin.position + 2 }]);
	recent[0]!.transitions[0]!.patch.intents!.temporary = "mutated";
	assert.equal(runtime.recent()[0]!.transitions[0]!.patch.intents!.temporary, "Advance and remove");
	assert.equal(runtime.read(1).intents.temporary, "Advance and remove");
	assert.equal(runtime.selectedSnapshot().meta.step, 2);
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
		for (const row of metadata.lineage) delete row.owners;
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
					const parent = meta.privateCausalBasis.at(-1);
					const transition = { id: "false-private-claim", parent: parent.id, position: parent.position + 1 };
					meta.privateCausalBasis.push({ ...transition, owners: ["session"] });
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
			if (failure === "null-witness") meta.lineage[1].owners = null;
			if (failure === "owner") meta.lineage[1].owners = [];
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
		const meta = JSON.parse(readFileSync(f.runtimePaths.runtime, "utf8")); meta.lineage.at(-1).owners = ["global", "session"];
		writeFileSync(f.runtimePaths.runtime, JSON.stringify(meta)); await f.drift();
		await assert.rejects(f.refresh(["global", "session"]), /missing its selected owner patch/);
	});

	test("selected current acceptance refuses retired V1 before current alignment or backup", async t => {
		const { f, before, bodies } = await lifecycleFixture.legacyLifecycle(t);
		const owner = new TemporalRuntime(f.cwd, f.id, f.root);
		await lifecycleFixture.withoutBodies(bodies, () => assert.rejects(
			owner.withSelectedCurrentTransaction(["session"], (_run, publish) => publish(), () => {}), /lifecycle V1 is retired/,
		));
		lifecycleFixture.unchanged(before);
		assert.equal(owner.selectedView(), undefined);
		assert.equal(existsSync(`${f.root}-migration-backups`), false);
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
			assert.equal(accepted.cohort.lifecycle.sourceVersion, "baseline");
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
			assert.deepEqual(Object.keys(f.runtime.selectedStates().states), selection);
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

	test("accepted or remembered session authority cannot become a new origin after its files disappear", async (t) => {
		const f = fixture(t);
		await create(f, ["cwd"]);
		rmSync(f.paths.config); rmSync(f.paths.runtime);
		await assert.rejects(create(f, ["cwd"]), /Known.*current-memory acceptance/);
		const existing = fixture(t);
		const producer = new TemporalRuntime(existing.cwd, existing.runtime.sessionId, existing.root);
		await producer.withSelectedFirstPatchTransaction(["session"], emptySnapshot("active"), tx => tx.publish(tx.snapshot), () => {}, undefined, true);
		assert.ok(await existing.runtime.refreshSelectedCurrent(["session"], () => {}));
		const paths = [existing.paths.config, existing.paths.runtime, existing.privatePaths.checkpoint, existing.privatePaths.patches, existing.privatePaths.meta];
		for (const path of paths) rmSync(path);
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

	test("cached inspection and cache withdrawal never touch canonical files", async (t) => {
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
			f.runtime.clearCache();
			assert.equal(f.runtime.selectedView(), undefined);
			assert.throws(() => f.runtime.readView(), /runtime is unavailable/);
			assert.throws(() => f.runtime.selectedStates(), /runtime is unavailable/);
			assert.throws(() => f.runtime.artifactProvenance("session"), /excluded or unavailable/);
			await assert.rejects(f.runtime.refreshSelectedShared(["cwd"], () => {}), /requires current acceptance/);
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
		cold.clearCache();
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
		f.runtime.clearCache(); rmSync(lock);
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
			assert.deepEqual(Object.keys(f.runtime.selectedStates().states), selection);
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

	test("observed acquired private authority cannot be downgraded by a rewritten unacquired header", async (t) => {
		const f = fixture(t);
		const producer = new TemporalRuntime(f.cwd, f.id, f.root);
		await producer.withSelectedFirstPatchTransaction(["session"], emptySnapshot("active"), tx => tx.publish(tx.snapshot), () => {}, undefined, true);
		await f.runtime.refreshSelectedCurrent(["session"], () => {});
		for (const path of [f.paths.config, f.paths.runtime, f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) rmSync(path);
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
			assert.deepEqual(Object.keys(f.runtime.selectedStates().states), selection);
		}
	});

	test("a deferred child cannot use independent/new or unacquired empty Session acquisition", async (t) => {
		const f = fixture(t);
		const accepted = await f.defer();
		const before = readFileSync(f.paths.runtime);
		for (const kind of ["new", "unacquired"] as const) {
			const owner = new TemporalRuntime(f.cwd, f.id, f.root);
			const request = { kind, ...(kind === "unacquired" ? { base: accepted.cohort } : {}), selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7 } as any;
			await assert.rejects(owner.withSelectedSessionAcquisitionTransaction(request, (publish) => publish(), undefined, true), /current-memory acceptance|unacquired lifecycle authority/);
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
			const prior = metadata.lineage.at(-1);
			metadata.lineage.push({ id: "fictional-private-write", parent: prior.id, position: prior.position + 1,
				owners: fault === "null-witness" ? null : ["session"] });
			writeFileSync(runtimePath, JSON.stringify(metadata));
			const parentBefore = captureTemporalFileBases(f.cwd, f.parentId, f.root);
			const childBefore = captureTemporalFileBases(f.cwd, f.childId, f.root);
			const cacheBefore = f.child.selectedView();
			const current = new TemporalRuntime(f.cwd, f.parentId, f.root);
			const refusal = fault === "null-witness" ? /scopes must be a nonempty unique array/ : /witness/;
			await assert.rejects(current.withSelectedCurrentTransaction(["session"], (_run, publish) => publish(), () => {}), refusal);
			await assert.rejects(f.copy(["session"], base), refusal, `${retained}/${deferred}/${fault}`);
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
			assert.deepEqual(Object.keys(f.child.selectedStates().states), selection);
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

	test("a numeric V2 acquired parent copies beside independent current shared streams without touching parent bytes", async (t) => {
		const f = await fixture(t);
		const parentPaths = sessionRuntimePaths(f.cwd, f.parentId, f.root);
		rewriteBaselineLifecycleAsNumeric(f.cwd, f.parentId, f.root, 2);
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

	test("competing direct-parent copies recheck child occupancy under exclusion", async t => {
		const f = await fixture(t);
		const peer = new TemporalRuntime(f.cwd, f.childId, f.root);
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const both = Promise.allSettled([f.copy(["session"]), f.copy(["session"], undefined, peer)]);
		rmSync(lock);
		const outcomes = await both;
		const accepted = outcomes.filter(result => result.status === "fulfilled");
		const refused = outcomes.filter(result => result.status === "rejected");
		assert.equal(accepted.length, 1);
		assert.equal(refused.length, 1);
		assert.match(String(refused[0]!.reason), /occupied|existing/i);
		assert.equal([f.child, peer].filter(runtime => runtime.selectedView() !== undefined).length, 1);
		const live = (await loadSelectedFileCohort(f.cwd, f.childId, ["session"], f.root))!;
		assertSelectedFileCohortBasis(live, accepted[0]!.value.cohort);
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
		f.runtime.clearCache(); rmSync(lock);
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
			assert.deepEqual(f.observer.observedAbsentSharedScopes(), requested.filter(scope => !present.includes(scope)));
			assert.equal(f.observer.selectedView(), undefined);
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
		assert.deepEqual(runtime.observedAbsentSharedScopes(), []);
		assert.equal(await runtime.refreshSelectedShared(["cwd"], () => {}), false); assert.equal(existsSync(root), false);
		assert.deepEqual(runtime.observedAbsentSharedScopes(), ["cwd"]);
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
			assert.deepEqual(f.observer.observedAbsentSharedScopes(), [], "failed observation must not classify CWD as absent");
			assert.deepEqual(f.observer.observedSelectedView(), previous); unchanged(before);
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
		f.observer.clearCache();
		assert.equal(f.observer.observedSelectedView(), undefined);
		assert.throws(() => f.observer.readView(), /unavailable/);
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
		f.observer.clearCache();
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
			assert.equal(observer.selectedView(), undefined);
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

	test("Baseline current observation isolates excluded bodies, requires acquired presence and refuses retired V1", async t => {
		const f = await fixture(t, all), observer = new TemporalRuntime(f.cwd, f.id, f.root);
		const privateCheckpoint = temporalScopePaths(f.cwd, f.id, "session", f.root).checkpoint;
		const original = readFileSync(privateCheckpoint);
		writeFileSync(privateCheckpoint, "invalid excluded private body");
		await forbid(bodies(f, "session"), () => observer.refreshSelectedCurrent(["cwd"], () => {}));
		const previous = observer.observedSelectedView(); rmSync(privateCheckpoint);
		await assert.rejects(observer.refreshSelectedCurrent(["cwd"], () => {}), /private semantics are incomplete/);
		assert.deepEqual(observer.observedSelectedView(), previous); writeFileSync(privateCheckpoint, original);
		const life = sessionRuntimePaths(f.cwd, f.id, f.root);
		rewriteBaselineLifecycleAsNumeric(f.cwd, f.id, f.root, 1);
		writeFileSync(privateCheckpoint, "invalid required legacy private body");
		const before = cohortFiles(f);
		await assert.rejects(observer.refreshSelectedCurrent(["cwd"], () => {}), /lifecycle V1 is retired/);
		assert.deepEqual(observer.observedSelectedView(), previous);
		unchanged(before);
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
		observer.clearCache(); rmSync(life.config); rmSync(life.runtime);
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
		const accepted = f.producer.selectedView();
		await forbid(before.map(([path]) => path), async () => {
			await assert.rejects(f.producer.refreshSelectedShared(["cwd"], () => {}), /Accepted State Flow memory requires current acceptance/);
			await assert.rejects(f.producer.refreshSelectedCurrent(all, () => {}), /Accepted State Flow memory requires current acceptance/);
		});
		assert.deepEqual(f.producer.selectedView(), accepted);
		unchanged(before);
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
		child.clearCache();
	}, () => {}, undefined, true);
	assert.equal(child.selectedView(), undefined, "post-acceptance cache withdrawal must not be undone by a second installer");
	assert.equal(existsSync(temporalScopePaths(h.ctx.cwd, "cas-child", "session", h.repositoryRoot).checkpoint), true);
});

test("V2 current acceptance fails closed on cancellation, foreign identity and partial private evidence before conversion", async t => {
	for (const failure of ["cancel", "identity", "partial"] as const) {
		const root = mkdtempSync(join(tmpdir(), "state-flow-v2-current-refusal-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "workspace"), id = "v2-owner";
		writeNumericLifecycleFixture(cwd, id, root, createTemporalState({ global: {}, cwd: {}, session: {} }, "retained-v2"));
		const lock = join(root, ".state-flow-publication.lock");
		const lifecycle = sessionRuntimePaths(cwd, id, root);
		const controller = new AbortController();
		if (failure === "cancel") writeFileSync(lock, `${process.pid}\n`);
		if (failure === "identity") {
			const meta = JSON.parse(readFileSync(lifecycle.runtime, "utf8"));
			meta.identity.sessionId = "foreign";
			writeFileSync(lifecycle.runtime, JSON.stringify(meta));
		}
		if (failure === "partial") rmSync(temporalScopePaths(cwd, id, "session", root).patches);
		const before = captureTemporalFileBases(cwd, id, root);
		const runtime = new TemporalRuntime(cwd, id, root);
		const pending = runtime.withSelectedCurrentTransaction(DEFAULT_SCOPE_SELECTION, () => assert.fail("unadmitted author"), () => {}, controller.signal);
		if (failure === "cancel") controller.abort();
		await assert.rejects(pending, failure === "cancel" ? { name: "AbortError" } : /identity|incomplete/i);
		assert.equal(existsSync(lock), failure === "cancel", "cancellation does not disturb the independent owner");
		assert.equal(runtime.selectedView(), undefined);
		assert.deepEqual(captureTemporalFileBases(cwd, id, root), before);
		assert.equal(existsSync(`${root}-migration-backups`), false);
	}
});
