import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fixture as selectedCurrentFixture } from "./current-fixture.ts";
import * as originFixture from "./origin-fixture.ts";
import * as lifecycleFixture from "./lifecycle-fixture.ts";
import * as sessionAcquisitionFixture from "./session-acquisition-fixture.ts";
import * as deferredForkFixture from "./deferred-fork-fixture.ts";
import * as readObservationFixture from "./read-observation-fixture.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { rewriteBaselineLifecycleAsNumeric, writeNumericLifecycleFixture } from "./temporal-fixture.ts";
import { stageSelectedScopePatches } from "../lib/transition.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import type { AcceptedTransition } from "../lib/history.ts";
import { emptySnapshot, RevisionUnavailableError } from "../lib/snapshot.ts";
import type { StateScope } from "../lib/state.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION } from "../lib/selection.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import {
	assertSelectedFileCohortBasis, initializeFileStore, loadSelectedFileCohort, PublicationBusyError, publishSelectedTemporalStateToFiles,
	withStorageTransaction, type SelectedFileCohort, type SelectedModuleAdditions, type SelectedPublicationRequest, type SelectedReadObservation, type StorageTransaction,
} from "../lib/storage.ts";
import { advanceTemporalState, constrainTemporalState, createTemporalState, readTemporalView, temporalScopeRevisions } from "../lib/temporal.ts";

test("selected module additions require genuine scoped first content through original replay authority", async t => {
	const modules = { x_public_notes: { schemaVersion: 2, immutable: false } };
	for (const channel of ["origin", "current", "replay"] as const) {
		const f = await selectedCurrentFixture(t, ["session"]);
		const base = (await loadSelectedFileCohort(f.cwd, f.id, ["session"], f.root))!;
		const original = structuredClone(base.view);
		const transition: AcceptedTransition = { id: `first-${channel}`, transitions: [{ scope: "session", patch: { x_public_notes: { text: "first", nested: {} } } }] };
		const basis = structuredClone(base.view);
		basis.scopes.session!.modules = modules;
		const next = advanceTemporalState(basis, transition.transitions, transition.id, 7);
		const files = base.basis.files.map(file => [file.path, readFileSync(file.path)] as const);
		const unchanged = () => { for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes); assert.deepEqual(base.view, original); };
		await assert.rejects(publishSelectedTemporalStateToFiles(f.cwd, f.id, { view: basis, historyLimit: 7 }, base, f.root), /replay successor/);
		unchanged();
		for (const additions of [
			{ session: modules }, { global: modules }, { session: {} },
			{ session: { x_public_notes: { schemaVersion: 0, immutable: false } } },
			{ session: { x_public_notes: { schemaVersion: 2, immutable: false, extra: true } } },
		] as SelectedModuleAdditions[]) {
			await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
				selection: ["session"], historyLimit: 7, moduleAdditions: additions,
			}, tx.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root), f.root)));
			unchanged();
		}
		for (const value of [{}, null]) {
			await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
				selection: ["session"], historyLimit: 7, moduleAdditions: { session: modules },
				transition: { id: "empty", transitions: [{ scope: "session", patch: { x_public_notes: value } }] },
			}, tx.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root), f.root)));
			unchanged();
		}
		const saved = await withStorageTransaction(f.root, tx => {
			if (channel === "current") return tx.acceptSelectedCurrent(f.cwd, f.id, {
				selection: ["session"], historyLimit: 7, transition, moduleAdditions: { session: modules },
			}, tx.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root), f.root);
			if (channel === "origin") return tx.acquireSelectedSession(f.cwd, "new-owner", {
				kind: "new", selection: ["session"], historyLimit: 7, snapshot: emptySnapshot("active"),
				author: (_basis, publish) => { publish(emptySnapshot("active"), transition, undefined, { session: modules }); },
			}, f.root);
			return tx.publishSelected(f.cwd, f.id, { view: next, transition, historyLimit: 7, moduleAdditions: { session: modules } }, base, f.root);
		});
		const id = channel === "origin" ? "new-owner" : f.id;
		const reloaded = (await loadSelectedFileCohort(f.cwd, id, ["session"], f.root))!;
		assert.deepEqual(reloaded.view, saved.cohort.view);
		assert.deepEqual(reloaded.view.scopes.session!.modules, modules);
		assert.deepEqual(readTemporalView(reloaded.view, 0, "session").x_public_notes, { text: "first", nested: {} });
		assert.equal(readTemporalView(reloaded.view, 1, "session").x_public_notes, undefined);
		const meta = JSON.parse(readFileSync(temporalScopePaths(f.cwd, id, "session", f.root).meta, "utf8"));
		assert.equal(meta.version, 4);
		if (channel !== "origin") assert.ok(saved.migrationBackup);
		await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, id, {
			selection: ["session"], historyLimit: 7, transition, moduleAdditions: { session: modules },
		}, tx.prepareSelectedCurrent(f.cwd, id, ["session"], 7, f.root), f.root)), /already exists/);
	}
});

test("selected descriptor admission rejects raw collisions before backup and preserves additive metadata4 history", async t => {
	const modules = { x_public_notes: { schemaVersion: 1, immutable: false } };
	for (const location of ["checkpoint", "patches", "meta"] as const) {
		const f = await selectedCurrentFixture(t, ["global"]);
		const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const raw = readFileSync(paths[location], "utf8");
		if (location === "meta") writeFileSync(paths.meta, JSON.stringify({ ...JSON.parse(raw), modules: {} }));
		else if (location === "checkpoint") writeFileSync(paths.checkpoint, JSON.stringify({ ...JSON.parse(raw), x_ignored: { opaque: true } }));
		else writeFileSync(paths.patches, raw.trim().split("\n").map(line => JSON.stringify({ ...JSON.parse(line), x_ignored: { opaque: true } })).join("\n") + "\n");
		const bytes = [paths.checkpoint, paths.patches, paths.meta].map(path => [path, readFileSync(path)] as const);
		await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
			selection: ["global"], historyLimit: 7, moduleAdditions: { global: modules },
			transition: { id: "collision", transitions: [{ scope: "global", patch: { x_public_notes: { text: "new" } } }] },
		}, tx.prepareSelectedCurrent(f.cwd, f.id, ["global"], 7, f.root), f.root)), /collision/);
		for (const [path, expected] of bytes) assert.deepEqual(readFileSync(path), expected);
		assert.equal(existsSync(`${f.root}-migration-backups`), false);
	}
	const f = await selectedCurrentFixture(t, ["global", "session"]);
	const excluded = Object.defineProperty({}, "cwd", { enumerable: true, get() { assert.fail("excluded additions body was evaluated"); } });
	await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
		selection: ["global", "session"], historyLimit: 7, moduleAdditions: excluded,
	}, tx.prepareSelectedCurrent(f.cwd, f.id, ["global", "session"], 7, f.root), f.root)), /excluded/);
	let saved = await withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
		selection: ["global", "session"], historyLimit: 7, moduleAdditions: { global: modules, session: modules },
		transition: { id: "first-both", transitions: ["global", "session"].map(scope => ({ scope: scope as StateScope, patch: { x_public_notes: { text: scope } } })) },
	}, tx.prepareSelectedCurrent(f.cwd, f.id, ["global", "session"], 7, f.root), f.root));
	const old = structuredClone(saved.cohort.view);
	const additions = { session: { x_public_archive: { schemaVersion: 4, immutable: true } } };
	const transition: AcceptedTransition = { id: "second-plane", transitions: [{ scope: "session", patch: { x_public_archive: { summary: "archive" } } }] };
	saved = await withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
		selection: ["global", "session"], historyLimit: 7, moduleAdditions: additions, transition,
	}, tx.prepareSelectedCurrent(f.cwd, f.id, ["global", "session"], 7, f.root), f.root));
	assert.equal(saved.migrationBackup, undefined, "metadata4 additions are not a codec migration");
	assert.deepEqual(saved.cohort.view.scopes.session!.modules, { ...modules, ...additions.session });
	assert.deepEqual(readTemporalView(saved.cohort.view, 1, "session"), readTemporalView(old, 0, "session"));
	assert.deepEqual(saved.cohort.view.scopes.global, old.scopes.global, "untargeted selected owner stays byte-semantic identical");
	const forged = structuredClone(saved.cohort.view);
	forged.scopes.session!.modules!.x_public_notes = { schemaVersion: 2, immutable: true };
	await assert.rejects(publishSelectedTemporalStateToFiles(f.cwd, f.id, { view: forged, historyLimit: 7 }, saved.cohort, f.root), /replay successor/);
	for (const immutable of [true, false]) await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
		selection: ["global", "session"], historyLimit: 7, moduleAdditions: { session: { x_public_notes: { schemaVersion: 1, immutable } } }, transition,
	}, tx.prepareSelectedCurrent(f.cwd, f.id, ["global", "session"], 7, f.root), f.root)), /already exists/);
});

test("first selected module writes remain cohort-atomic for every owner subset and failed conversion", async t => {
	const scopes = ["global", "cwd", "session"] as const;
	const modules = { x_public_notes: { schemaVersion: 1, immutable: false } };
	for (let mask = 1; mask < 8; mask++) {
		const wanted = captureScopeSelection(scopes.filter((_, bit) => mask & (1 << bit)));
		const f = await selectedCurrentFixture(t, wanted);
		const base = (await loadSelectedFileCohort(f.cwd, f.id, wanted, f.root))!;
		const transition: AcceptedTransition = { id: `first-${mask}`, transitions: wanted.map(scope => ({ scope, patch: { x_public_notes: { owner: scope } } })) };
		const additions = Object.fromEntries(wanted.map(scope => [scope, modules]));
		const request = { selection: wanted, historyLimit: 7, moduleAdditions: additions, transition };
		const bytes = base.basis.files.map(file => [file.path, readFileSync(file.path)] as const);
		const rename = fs.renameSync, target = temporalScopePaths(f.cwd, f.id, wanted.at(-1)!, f.root).patches;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === target) { injected = true; throw new Error("injected first-content failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, request,
			tx.prepareSelectedCurrent(f.cwd, f.id, wanted, 7, f.root), f.root)), /injected first-content failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		for (const [path, expected] of bytes) assert.deepEqual(readFileSync(path), expected);
		assert.deepEqual((await loadSelectedFileCohort(f.cwd, f.id, wanted, f.root))!.view, base.view);
		const result = await withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, request,
			tx.prepareSelectedCurrent(f.cwd, f.id, wanted, 7, f.root), f.root));
		assert.ok(result.migrationBackup);
		assert.equal(readdirSync(`${f.root}-migration-backups`).length, 1, "completed exact backup is reused after rollback");
		const backup = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.deepEqual(backup.convertedScopes, wanted);
		for (const file of base.basis.files) {
			const receipt = backup.files.find((entry: { path: string }) => entry.path === relative(f.root, file.path));
			assert.equal(receipt.identity, file.identity);
			assert.deepEqual(receipt.bytes === null ? undefined : Buffer.from(receipt.bytes, "base64"), file.bytes);
		}
		for (const scope of wanted) {
			assert.deepEqual(result.cohort.view.scopes[scope]!.modules, modules);
			assert.deepEqual(readTemporalView(result.cohort.view, 0, scope).x_public_notes, { owner: scope });
			assert.deepEqual(readTemporalView(result.cohort.view, 1, scope), readTemporalView(base.view, 0, scope));
		}
		const folded = await withStorageTransaction(f.root, tx => tx.acceptSelectedCurrent(f.cwd, f.id, {
			selection: wanted, historyLimit: 0, transition: { id: `core-${mask}`, transitions: wanted.map(scope => ({ scope, patch: { tactics: { unrelated: true } } })) },
		}, tx.prepareSelectedCurrent(f.cwd, f.id, wanted, 0, f.root), f.root));
		for (const scope of wanted) {
			assert.deepEqual(folded.cohort.view.scopes[scope]!.modules, modules);
			assert.deepEqual(readTemporalView(folded.cohort.view, 0, scope).x_public_notes, { owner: scope });
		}
	}
});

test("metadata4 conversion preserves foreign edits during guarded rollback instead of overwriting opaque bytes", async t => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-external-foreign-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "owner";
	writeNumericLifecycleFixture(cwd, id, root, createTemporalState({ global: {}, cwd: {}, session: { strategy: { old: true } } }, "foreign-origin"));
	const paths = temporalScopePaths(cwd, id, "session", root);
	writeFileSync(paths.checkpoint, readFileSync(paths.checkpoint, "utf8") + " ");
	const base = (await loadSelectedFileCohort(cwd, id, ["session"], root))!;
	const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	const view = structuredClone(base.view);
	view.scopes.session!.modules = modules;
	const transition: AcceptedTransition = { id: "foreign-external", transitions: [{ scope: "session", patch: { x_acme_archive: { empty: {} } } }] };
	const next = advanceTemporalState(view, transition.transitions, transition.id);
	const rename = fs.renameSync, foreign = '{"foreign":"must survive"}\n';
	let injected = false;
	fs.renameSync = (from, to) => {
		if (to === paths.patches && injected) throw new Error("injected metadata4 tail failure");
		rename(from, to);
		if (to === paths.checkpoint && !injected) { injected = true; writeFileSync(paths.checkpoint, foreign); }
	};
	syncBuiltinESMExports();
	try {
		await assert.rejects(publishSelectedTemporalStateToFiles(cwd, id, {
			view: next, transition, historyLimit: 7, moduleAdditions: { session: modules },
		}, base, root), error => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error.errors[1]), /file conflict.*concurrent bytes preserved/);
			return true;
		});
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(injected, true);
	assert.equal(readFileSync(paths.checkpoint, "utf8"), foreign);
	for (const file of base.basis.files) if (file.bytes && file.path !== paths.checkpoint) assert.deepEqual(readFileSync(file.path), file.bytes);
	assert.equal(readdirSync(`${root}-migration-backups`).length, 1);
});

test("metadata4 owned conversion uses exact-byte backup/CAS/rollback and selected replay/fork retain opaque descriptors", async t => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-external-upgrade-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "parent";
	const origin = createTemporalState({ global: {}, cwd: {}, session: { strategy: { plan: "retained" } } }, "upgrade-origin");
	const old = advanceTemporalState(origin, [{ scope: "session", patch: { tactics: { old: true } } }], "upgrade-old");
	writeNumericLifecycleFixture(cwd, id, root, old);
	const paths = temporalScopePaths(cwd, id, "session", root);
	const base = await withStorageTransaction(root, tx => {
		const loaded = tx.prepareSelected(cwd, id, ["session"], root)!;
		return tx.persistSelectedPassive(cwd, id, loaded, root).cohort;
	});
	assert.equal(base.lifecycle.sourceVersion, 2);
	assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).version, 3);
	assert.equal(existsSync(`${root}-migration-backups`), false);
	const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	const view = structuredClone(base.view);
	view.scopes.session!.modules = modules;
	const opaque = JSON.parse('{"empty":{},"slots":[{},[]],"__proto__":{"constructor":{}},"a/b~c":{"remove":true,"keep":{}}}');
	const upgrade: AcceptedTransition = { id: "upgrade-external", transitions: [{ scope: "session", patch: { x_acme_archive: opaque } }] };
	const publish = () => publishSelectedTemporalStateToFiles(cwd, id, {
		view: advanceTemporalState(view, upgrade.transitions, upgrade.id), transition: upgrade, historyLimit: 7, moduleAdditions: { session: modules },
	}, base, root);
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => { if (!injected && to === paths.patches) { injected = true; throw new Error("injected metadata4 publication failure"); } rename(from, to); };
	syncBuiltinESMExports();
	try { await assert.rejects(publish(), /injected metadata4 publication failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(injected, true);
	for (const file of base.basis.files) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
	const result = await publish();
	assert.ok(result.migrationBackup);
	const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
	assert.equal(manifest.targetVersion, 4);
	assert.deepEqual(manifest.convertedScopes, ["session"]);
	assert.equal(readdirSync(`${root}-migration-backups`).length, 1, "completed exact backup reused after rollback");
	for (const file of base.basis.files) {
		const receipt = manifest.files.find((item: { path: string }) => item.path === relative(root, file.path));
		assert.equal(receipt.identity, file.identity);
		assert.deepEqual(receipt.bytes === null ? undefined : Buffer.from(receipt.bytes, "base64"), file.bytes);
	}
	await assert.rejects(publish(), /changed concurrently/);
	rewriteBaselineLifecycleAsNumeric(cwd, id, root, 2);
	const v2 = (await loadSelectedFileCohort(cwd, id, ["session"], root))!;
	assert.deepEqual(v2.view.scopes.session, result.cohort.view.scopes.session);
	// No registry or definition is involved. Accepted external replay remains raw.
	const transition: AcceptedTransition = { id: "upgrade-external-2", transitions: [{ scope: "session", patch: { x_acme_archive: { "a/b~c": { remove: null, revision: 2 } } } }] };
	const nextV2 = advanceTemporalState(v2.view, transition.transitions, transition.id);
	const acceptedV2 = await publishSelectedTemporalStateToFiles(cwd, id, { view: nextV2, transition, historyLimit: 7 }, v2, root);
	assert.ok(acceptedV2.migrationBackup);
	const selected = (await loadSelectedFileCohort(cwd, id, ["session"], root))!;
	assertSelectedFileCohortBasis(selected, acceptedV2.cohort);
	const before = readTemporalView(selected.view, 0, "session");
	const stage = stageSelectedScopePatches({ selection: ["session"], states: { session: before } }, { session: { tactics: { core: "unrelated" } } }, [], "metadata4");
	const accepted = createAcceptedTransition({ session: before }, stage.nextStates, "upgrade-core")!;
	const next = advanceTemporalState(selected.view, accepted.transitions, accepted.id);
	const saved = await publishSelectedTemporalStateToFiles(cwd, id, { view: next, transition: accepted, historyLimit: 7 }, selected, root);
	assert.equal(saved.migrationBackup, undefined, "Baseline replay does not repeat conversion");
	assert.deepEqual(readTemporalView(saved.cohort.view, 0, "session").x_acme_archive, before.x_acme_archive);
	await withStorageTransaction(root, transaction => {
		const passive = transaction.persistSelectedPassive(cwd, id, saved.cohort, root);
		assert.deepEqual(passive.cohort.view.scopes.session!.modules, modules);
	});
	const parentBytes = captureTestBasis(cwd, id, root);
	const fork = await withStorageTransaction(root, transaction => transaction.copySelectedFork(cwd, "child", {
		kind: "fork-new", source: { id, key: id }, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7,
	}, root));
	assert.deepEqual(fork.cohort.view.scopes.session!.modules, modules);
	assert.deepEqual(readTemporalView(fork.cohort.view, 0, "session"), readTemporalView(saved.cohort.view, 0, "session"));
	assert.equal(fork.cohort.view.scopes.session!.revision, saved.cohort.view.scopes.session!.revision);
	assert.throws(() => readTemporalView(fork.cohort.view, 1), /predates/);
	for (const file of parentBytes.files) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
	assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).version, 4);
});

{
	function fixture(t: TestContext, acquisition: "acquired" | "unacquired" | "deferred" = "acquired", version: 1 | 2 = 2) {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-store-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), sessionId = "owner";
		let view = createTemporalState({ global: { strategy: { marker: "global-only-value" } }, cwd: { strategy: { marker: "cwd-only-value" } }, session: {} }, "store-origin");
		view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { step: 1 } } }], "store-global");
		view = advanceTemporalState(view, [{ scope: "cwd", patch: { tactics: { step: 2 } } }], "store-cwd");
		if (acquisition === "acquired") view = advanceTemporalState(view, [{ scope: "session", patch: { strategy: { marker: "session-only-value" } } }], "store-session");
		writeNumericLifecycleFixture(cwd, sessionId, root, view, version, acquisition);
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		const privatePaths = temporalScopePaths(cwd, sessionId, "session", root);
		if (version === 2) {
			const metadata = JSON.parse(readFileSync(paths.runtime, "utf8"));
			writeFileSync(paths.runtime, JSON.stringify({ ...metadata, opaqueParent: "/not-a-parent-to-read" }));
		}
		const load = (selection: readonly StateScope[], signal?: AbortSignal) => loadSelectedFileCohort(cwd, sessionId, captureScopeSelection(selection), root, sessionId, signal);
		return { root, cwd, sessionId, paths, privatePaths, view, load };
	}

	async function observeReads<T>(action: () => Promise<T>): Promise<{ result: T; reads: string[] }> {
		const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRead = fs.readFileSync;
		const descriptors = new Map<number, string>(), reads: string[] = [];
		fs.openSync = ((path: fs.PathLike, ...args: any[]) => {
			const descriptor = (originalOpen as any)(path, ...args);
			descriptors.set(descriptor, String(path));
			return descriptor;
		}) as typeof fs.openSync;
		fs.closeSync = ((descriptor: number) => { descriptors.delete(descriptor); return originalClose(descriptor); }) as typeof fs.closeSync;
		fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
			reads.push(typeof path === "number" ? descriptors.get(path) ?? "unknown-descriptor" : String(path));
			return (originalRead as any)(path, ...args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try { return { result: await action(), reads }; }
		finally { fs.openSync = originalOpen; fs.closeSync = originalClose; fs.readFileSync = originalRead; syncBuiltinESMExports(); }
	}

	test("v2 selected admission covers every subset with exact dependencies and no excluded body reads or writes", async (t) => {
		const f = fixture(t);
		const order = ["global", "cwd", "session"] as const;
		const original = captureTestBasis(f.cwd, f.sessionId, f.root);
		for (let mask = 1; mask < 8; mask++) {
			const selection = order.filter((_, bit) => mask & (1 << bit));
			const { result: cohort, reads } = await observeReads(() => f.load(selection));
			assert.ok(cohort);
			assert.equal(cohort.basis.files.length, 2 + 3 * selection.length);
			assert.deepEqual(Object.keys(cohort.view.scopes), selection);
			assert.deepEqual(Object.keys(cohort.provenance), selection);
			assert.deepEqual(temporalScopeRevisions(cohort.view), Object.fromEntries(selection.map((scope) => [scope, f.view.scopes[scope].revision])));
			for (let offset = 0; offset < f.view.lineage.length; offset++) for (const scope of selection) {
				assert.deepEqual(readTemporalView(cohort.view, offset, scope), readTemporalView(f.view, offset, scope));
			}
			for (const scope of order.filter((scope) => !selection.includes(scope))) {
				const paths = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
				for (const path of [paths.checkpoint, paths.patches, paths.meta]) assert.equal(reads.includes(path), false, path);
				assert.equal(JSON.stringify(cohort.view).includes(`${scope}-only-value`), false);
			}
		}
		for (const file of original.files) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
		assert.equal(existsSync(`${f.root}-migration-backups`), false);
	});

	test("unacquired/deferred shared-only lifecycle is legitimate but cannot initialize or acquire excluded private semantics", async (t) => {
		for (const acquisition of ["unacquired", "deferred"] as const) {
			const f = fixture(t, acquisition);
			const cohort = await f.load(["cwd"]);
			assert.ok(cohort);
			assert.equal(cohort.lifecycle.runtime.meta.privateAcquisition, acquisition);
			assert.deepEqual(Object.keys(cohort.view.scopes), ["cwd"]);
			assert.equal(existsSync(f.privatePaths.checkpoint), false);
			await assert.rejects(f.load(["session"]), /requires explicit private acquisition/);
			writeFileSync(f.privatePaths.checkpoint, "occupied-private-secret");
			const { reads } = await observeReads(async () => { await assert.rejects(f.load(["cwd"]), /target is occupied/); });
			assert.equal(reads.includes(f.privatePaths.checkpoint), false);
			assert.equal(readFileSync(f.privatePaths.checkpoint, "utf8"), "occupied-private-secret");
		}
	});

	test("acquired private absence cannot be reclassified as unacquired, while unrelated disabled body corruption is isolated", async (t) => {
		const f = fixture(t);
		writeFileSync(f.privatePaths.checkpoint, Buffer.from([0xff, 0xfe]));
		writeFileSync(f.privatePaths.meta, "unrelated-malformed-private-metadata");
		const { result: cohort, reads } = await observeReads(() => f.load(["cwd"]));
		assert.ok(cohort);
		assert.deepEqual(cohort.view.causalBasis.map((witness) => witness.owners), [["global"], ["session"]]);
		assert.equal(reads.includes(f.privatePaths.checkpoint), false);
		assert.equal(reads.includes(f.privatePaths.meta), false);
		const before = captureTestBasis(f.cwd, f.sessionId, f.root);
		const refused = await observeReads(async () => {
			await assert.rejects(f.load(["session"]), /session metadata contains invalid JSON/);
		});
		assert.equal(refused.reads.includes(f.privatePaths.checkpoint), false, "malformed selected header refuses before body I/O");
		assert.deepEqual(captureTestBasis(f.cwd, f.sessionId, f.root), before);
		rmSync(f.privatePaths.patches);
		await assert.rejects(f.load(["cwd"]), /Acquired.*incomplete/);
	});

	test("v2 contiguous lineage alone is not proof of excluded transitions; malformed, false-owner and mixed witnesses fail", async (t) => {
		const f = fixture(t);
		const original = JSON.parse(readFileSync(f.paths.runtime, "utf8"));
		for (const causalWitnesses of [undefined, null, [], [{ transition: f.view.lineage[1], owners: ["session"] }],
			[{ transition: { ...f.view.lineage[1], parent: "wrong" }, owners: ["global"] }],
			[{ transition: f.view.lineage[1], owners: ["global"], patch: { private: "not-allowed" } }]]) {
			writeFileSync(f.paths.runtime, JSON.stringify({ ...original, causalWitnesses }));
			await assert.rejects(f.load(["session"]));
		}
		writeFileSync(f.paths.runtime, JSON.stringify({ ...original, version: 3 }));
		await assert.rejects(f.load(["session"]), /Unsupported/);
		writeFileSync(f.paths.runtime, JSON.stringify({ ...original, identity: { cwd: f.cwd, sessionId: "foreign" } }));
		await assert.rejects(f.load(["session"]), /identity/);
	});

	test("retired V1 refuses before any selected or excluded semantic body is read", async t => {
		const f = fixture(t, "acquired", 1);
		const before = captureTemporalFileBases(f.cwd, f.sessionId, f.root);
		const { reads } = await observeReads(async () => assert.rejects(f.load(["cwd"]), /lifecycle V1 is retired/));
		assert.deepEqual(reads.filter(path => /(?:checkpoint\.json|patches\.jsonl|meta\.json)$/.test(path)), []);
		assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), before);
	});

	test("selected basis checks include lifecycle/selected bytes and existence dependencies, not unrelated excluded bytes", async (t) => {
		const f = fixture(t);
		const first = (await f.load(["session"]))!;
		const global = temporalScopePaths(f.cwd, f.sessionId, "global", f.root);
		writeFileSync(global.checkpoint, "excluded-body-is-not-a-byte-dependency");
		const same = (await f.load(["session"]))!;
		assert.doesNotThrow(() => assertSelectedFileCohortBasis(first, same));
		const body = JSON.parse(readFileSync(f.privatePaths.checkpoint, "utf8"));
		body.strategy = { changed: true };
		writeFileSync(f.privatePaths.checkpoint, JSON.stringify(body));
		const changed = (await f.load(["session"]))!;
		assert.throws(() => assertSelectedFileCohortBasis(first, changed), /changed concurrently/);
	});

	test("absent/orphan/partial authority and symbolic targets fail without initializing a store", async (t) => {
		const parent = mkdtempSync(join(tmpdir(), "selected-absent-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "missing");
		assert.equal(await loadSelectedFileCohort(parent, "owner", ["cwd"], root), undefined);
		assert.equal(existsSync(root), false);
		const f = fixture(t);
		rmSync(f.paths.config);
		await assert.rejects(f.load(["cwd"]), /Incomplete/);
		rmSync(f.paths.runtime);
		await assert.rejects(f.load(["cwd"]), /Orphan/);
		const symbolic = fixture(t);
		rmSync(symbolic.privatePaths.checkpoint);
		fs.symlinkSync(join(parent, "outside"), symbolic.privatePaths.checkpoint);
		await assert.rejects(symbolic.load(["cwd"]), /regular file/);
	});

	test("selected preparation remains callback/store/cancellation-owned while holding no publication authority", async (t) => {
		const f = fixture(t);
		let retained: StorageTransaction | undefined;
		await withStorageTransaction(f.root, (transaction) => {
			retained = transaction;
			assert.ok(transaction.prepareSelected(f.cwd, f.sessionId, ["cwd"], f.root));
			assert.throws(() => transaction.prepareSelected(f.cwd, f.sessionId, ["cwd"], `${f.root}-foreign`), /different store/);
		});
		assert.throws(() => retained!.prepareSelected(f.cwd, f.sessionId, ["cwd"], f.root), /ended/);
		const lock = join(f.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const { reads } = await observeReads(async () => {
				const pending = f.load(["cwd"], controller.signal);
				setTimeout(() => controller.abort(), 20);
				await assert.rejects(pending, { name: "AbortError" });
			});
			assert.equal(reads.includes(f.paths.runtime), false);
			assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
		} finally { rmSync(lock); }
	});
}

function fixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-files-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "project"), sessionId = "file-session";
	initializeFileStore(root);
	return { parent, root, cwd, sessionId, base: captureTestBasis(cwd, sessionId, root) };
}

function captureTestBasis(cwd: string, sessionId: string, root: string) {
	return { files: captureTemporalFileBases(cwd, sessionId, root) };
}

async function seededStore(t: TestContext, selection = DEFAULT_SCOPE_SELECTION) {
	const f = fixture(t);
	const runtime = new TemporalRuntime(f.cwd, f.sessionId, f.root);
	const first = await runtime.withSelectedFirstPatchTransaction(selection, emptySnapshot("active"), tx => tx.publish(tx.snapshot), () => {}, undefined, true);
	return { ...f, runtime, first };
}

test("Baseline reloads bounded sparse history and terminal response, and persists Passive without Git", async t => {
	const spawn = t.mock.method(childProcess, "spawnSync", () => assert.fail("canonical publication and inspection must not spawn a command"));
	syncBuiltinESMExports();
	t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
	const f = await seededStore(t);
	const load = async () => (await loadSelectedFileCohort(f.cwd, f.sessionId, DEFAULT_SCOPE_SELECTION, f.root))!;
	writeFileSync(join(f.root, "unrelated.md"), "retained\n");
	const retained = [f.runtime.readView()];
	for (let step = 1; step <= 11; step++) {
		const scope = step === 11 ? "session" : DEFAULT_SCOPE_SELECTION[(step - 1) % 3]!;
		const patch = step === 11 ? { response: "Final answer" } : { tactics: { [scope]: step } };
		const accepted = await f.runtime.withSelectedPatchTransaction(tx => tx.publish(
			{ ...tx.snapshot, meta: { step } }, { id: `T${step}`, transitions: [{ scope, patch }] },
		), () => {});
		retained.push(f.runtime.readView());
		const restarted = await load();
		assertSelectedFileCohortBasis(restarted, accepted.cohort);
		assert.equal(restarted.lifecycle.sourceVersion, "baseline");
		assert.equal(restarted.view.lineage.length, Math.min(step, 7) + 1);
		for (let offset = 0; offset < restarted.view.lineage.length; offset++) assert.deepEqual(readTemporalView(restarted.view, offset), retained.at(-1 - offset));
	}
	assert.equal(f.runtime.readView().response, "Final answer");
	const before = await load();
	const noOp = await f.runtime.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot), () => {});
	assert.equal(noOp.changed, false);
	await f.runtime.persistSelectedPassive(() => {});
	const after = await load(), config = sessionRuntimePaths(f.cwd, f.sessionId, f.root).config;
	assert.equal(after.lifecycle.runtime.config.mode, "passive");
	assert.deepEqual(after.view, before.view);
	assert.deepEqual(after.basis.files.filter(({ path }) => path !== config), before.basis.files.filter(({ path }) => path !== config));
	assert.equal(readFileSync(join(f.root, "unrelated.md"), "utf8"), "retained\n");
	assert.equal(existsSync(join(f.root, ".git")), false);
});

test("async store transactions wait through a partial foreign publication without blocking the event loop", { timeout: 15_000 }, async (t) => {
	const f = await seededStore(t);
	const transition: AcceptedTransition = { id: "foreign", transitions: DEFAULT_SCOPE_SELECTION.map(scope => ({
		scope, patch: { tactics: { cohort: "foreign" } },
	})) };
	const next = advanceTemporalState(f.first.cohort.view, transition.transitions, transition.id);
	const partial = join(f.parent, "partial");
	const release = join(f.parent, "release");
	const receipt = join(f.parent, "receipt.json");
	const child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { withStorageTransaction } from ${JSON.stringify(new URL("../lib/storage.ts", import.meta.url).href)};
		const { cwd, sessionId, root, view, transition, partial, release, receipt, pauseAt } = JSON.parse(process.argv[1]);
		const rename = fs.renameSync;
		let paused = false;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (paused || to !== pauseAt) return;
			paused = true;
			fs.writeFileSync(partial, "half-published");
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(release)) {
				if (Date.now() > deadline) throw new Error("fixture publication pause expired");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		};
		syncBuiltinESMExports();
		await withStorageTransaction(root, (tx) => {
			const base = tx.prepareSelected(cwd, sessionId, ["global", "cwd", "session"], root);
			const result = tx.publishSelected(cwd, sessionId, { view, transition, historyLimit: 7 }, base, root);
			fs.writeFileSync(receipt, JSON.stringify(result.cohort.basis.files.map(({ path, identity }) => ({ path, identity }))));
		});
	`, JSON.stringify({ cwd: f.cwd, sessionId: f.sessionId, root: f.root, view: next, transition,
		partial, release, receipt, pauseAt: temporalScopePaths(f.cwd, f.sessionId, "global", f.root).patches })], { stdio: ["ignore", "ignore", "inherit"] });
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	const closed = once(child, "close");
	const deadline = Date.now() + 5_000;
	while (!existsSync(partial)) {
		if (Date.now() > deadline || child.exitCode !== null) assert.fail("foreign writer did not reach the partial-cohort gate");
		await delay(10);
	}
	let entered = false;
	const observed = withStorageTransaction(f.root, (tx) => {
		entered = true;
		return tx.prepareSelected(f.cwd, f.sessionId, DEFAULT_SCOPE_SELECTION, f.root)!;
	});
	let settled = false;
	observed.then(() => { settled = true; }, () => { settled = true; });
	await delay(2_200); // Live contention outlasts the legacy 2-second fail-fast budget.
	assert.equal(entered, false);
	assert.equal(settled, false, "ordinary live contention must still be waiting, not a failed model call");
	assert.equal(readFileSync(join(f.root, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	writeFileSync(release, "continue");
	const loaded = await observed;
	assert.equal((await closed)[0], 0);
	assert.deepEqual(loaded.basis.files.map(({ path, identity }) => ({ path, identity })), JSON.parse(readFileSync(receipt, "utf8")),
		"reader must see the complete accepted cohort");
	assert.deepEqual(loaded.view, next);
	for (const scope of DEFAULT_SCOPE_SELECTION) assert.equal(readTemporalView(loaded.view, 0, scope).tactics!.cohort, "foreign");
});

test("store transactions serialize local waiters, cancel without stealing, and expire borrowed operations", async (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".state-flow-publication.lock");
	const order: string[] = [];
	const borrowed: StorageTransaction[] = [];
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const first = withStorageTransaction(f.root, async (tx) => {
		borrowed.push(tx);
		order.push("first");
		assert.throws(() => tx.observeSelectedShared(f.cwd, ["cwd"], join(f.parent, "other")), /different store/);
		await assert.rejects(withStorageTransaction(f.root, () => assert.fail("recursive acquisition")), /Recursive/);
		enter();
		await gate;
		order.push("released");
	});
	await entered;
	const second = withStorageTransaction(f.root, () => { order.push("second"); });
	const controller = new AbortController();
	const cancelled = withStorageTransaction(f.root, () => assert.fail("cancelled waiter entered"), controller.signal);
	const cancellation = assert.rejects(cancelled, { name: "AbortError" });
	await delay(50);
	assert.deepEqual(order, ["first"]);
	controller.abort();
	await cancellation;
	assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), f.base.files);
	release();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first", "released", "second"]);
	assert.equal(existsSync(lock), false);
	assert.throws(() => borrowed[0]!.observeSelectedShared(f.cwd, ["cwd"], f.root), /has ended/);
	assert.throws(() => borrowed[0]!.initializeSelectedSharedOrigin(f.cwd, f.sessionId, {
		selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7,
	}, f.root), /has ended/);
	await assert.rejects(withStorageTransaction(f.root, () => assert.fail("aborted before acquisition"), AbortSignal.abort()), { name: "AbortError" });
	assert.equal(existsSync(lock), false);
});

test("nonwaiting admission distinguishes occupied locks from invalid evidence without taking ownership", { timeout: 1_500 }, async (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".state-flow-publication.lock");
	for (const [contents, busy] of [[`${process.pid}\n`, true], ["", true], ["interrupted owner\n", false]] as const) {
		writeFileSync(lock, contents);
		await assert.rejects(withStorageTransaction(f.root, () => assert.fail("occupied lock was entered"), undefined, false), (error: unknown) => {
			assert.equal(error instanceof PublicationBusyError, busy);
			if (!busy) assert.ok(error instanceof RevisionUnavailableError);
			return true;
		});
		assert.equal(readFileSync(lock, "utf8"), contents);
		rmSync(lock);
	}
	const empty = await withStorageTransaction(f.root, tx => tx.observeSelectedShared(f.cwd, ["cwd"], f.root), undefined, false);
	assert.equal(empty.view, undefined);
	assert.deepEqual(captureTestBasis(f.cwd, f.sessionId, f.root), f.base);
	assert.equal(existsSync(lock), false);
});

test("deferred work may acquire a new transaction after its inherited lock context ends", async (t) => {
	const f = fixture(t);
	let start!: () => void;
	const gate = new Promise<void>((resolve) => { start = resolve; });
	let deferred!: Promise<string>;
	await withStorageTransaction(f.root, () => {
		deferred = gate.then(() => withStorageTransaction(f.root, () => "new ownership"));
	});
	start();
	assert.equal(await deferred, "new ownership");
});

test("invalid or interrupted locks remain explicit and untouched, including empty initialization", { timeout: 8_000 }, async (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".state-flow-publication.lock");
	const outside = join(f.parent, "outside");
	writeFileSync(outside, `${process.pid}\n`);
	const deadPid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	for (const owner of ["unrecognized owner\n", `${deadPid}\n`, "", "directory", "symlink"]) {
		if (owner === "directory") mkdirSync(lock);
		else if (owner === "symlink") fs.symlinkSync(outside, lock);
		else writeFileSync(lock, owner);
		await assert.rejects(withStorageTransaction(f.root, () => assert.fail("invalid owner admitted")), /publication lock is unavailable/);
		if (owner === "directory") assert.ok(fs.lstatSync(lock).isDirectory());
		else if (owner === "symlink") assert.equal(fs.readlinkSync(lock), outside);
		else assert.equal(readFileSync(lock, "utf8"), owner);
		rmSync(lock, { recursive: true });
	}
	assert.equal(readFileSync(outside, "utf8"), `${process.pid}\n`);
	writeFileSync(lock, "unreadable owner\n");
	const read = fs.readFileSync;
	const denied = Object.assign(new Error(`EACCES: permission denied, open '${lock}'`), { code: "EACCES" });
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		if (args[0] === lock) throw denied;
		return read(...args);
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	const unavailable = (error: unknown) => error instanceof RevisionUnavailableError && error.cause === denied;
	try {
		await assert.rejects(withStorageTransaction(f.root, () => assert.fail("unreadable lock admitted")), unavailable);
	} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
	assert.equal(readFileSync(lock, "utf8"), "unreadable owner\n");
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), f.base.files);
});

test("transaction cancellation and failed Baseline publication preserve canonical bytes and release exclusion", async t => {
	const f = await seededStore(t, ["session"]);
	const transition: AcceptedTransition = { id: "next", transitions: [{ scope: "session", patch: { tactics: { accepted: true } } }] };
	const view = advanceTemporalState(f.first.cohort.view, transition.transitions, transition.id);
	const request = { view, transition, historyLimit: 7 };
	const before = captureTestBasis(f.cwd, f.sessionId, f.root);
	const controller = new AbortController();
	await assert.rejects(withStorageTransaction(f.root, tx => {
		const base = tx.prepareSelected(f.cwd, f.sessionId, ["session"], f.root)!;
		controller.abort();
		tx.publishSelected(f.cwd, f.sessionId, request, base, f.root);
	}, controller.signal), { name: "AbortError" });
	assert.deepEqual(captureTestBasis(f.cwd, f.sessionId, f.root), before);
	const patches = temporalScopePaths(f.cwd, f.sessionId, "session", f.root).patches;
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === patches) { failed = true; throw new Error("injected transaction rename failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	const publish = () => publishSelectedTemporalStateToFiles(f.cwd, f.sessionId, request, f.first.cohort, f.root);
	try { await assert.rejects(publish(), /injected transaction rename failure/); }
	finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTestBasis(f.cwd, f.sessionId, f.root), before);
	assert.equal(existsSync(join(f.root, ".state-flow-publication.lock")), false);
	const accepted = await publish();
	assertSelectedFileCohortBasis(accepted.cohort, (await loadSelectedFileCohort(f.cwd, f.sessionId, ["session"], f.root))!);
	assert.equal(accepted.cohort.view.lineage.at(-1)!.id, "next");
});

test("transaction release preserves replaced or overwritten lock ownership and both failure causes", async (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".state-flow-publication.lock");
	for (const replacement of ["new-inode", "same-inode"]) {
		await assert.rejects(withStorageTransaction(f.root, () => {
			if (replacement === "new-inode") fs.renameSync(lock, join(f.parent, "displaced-lock"));
			writeFileSync(lock, "other owner\n");
			throw new Error("original action failure");
		}), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.errors[0].message, /original action failure/);
			assert.match(error.errors[1].message, /lock changed.*current owner preserved/);
			return true;
		});
		assert.equal(readFileSync(lock, "utf8"), "other owner\n");
		rmSync(lock);
	}
});

test("file directory creation preserves nonempty directories and rejects symlink ancestors", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "notes.md"), "preserve");
	initializeFileStore(f.root);
	assert.equal(readFileSync(join(f.root, "notes.md"), "utf8"), "preserve");
	const real = join(f.parent, "real");
	mkdirSync(real);
	fs.symlinkSync(real, join(f.parent, "link"));
	assert.throws(() => initializeFileStore(join(f.parent, "link", "store")), /regular directory/);
	assert.equal(existsSync(join(real, "store")), false);
});

{
	const fixture = selectedCurrentFixture;

	test("disabled v2 bodies stay inactive; candidates cannot authorize a forged value, reset identity or bypass exact selected-source CAS", async (t) => {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
		writeFileSync(global.meta, "disabled invalid body");
		await f.refresh(["session"]);
		assert.equal(readFileSync(global.meta, "utf8"), "disabled invalid body");
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root);
			base.view.scopes.session!.checkpoint.state = { strategy: { marker: "forged" } };
			base.lifecycle.runtime.meta.identity.sessionId = "forged";
			const accepted = transaction.acceptSelectedCurrent(f.cwd, f.id, { selection: ["session"], historyLimit: 7 }, base, f.root);
			assert.equal(readTemporalView(accepted.cohort.view).strategy!.marker, "session");
			assert.equal(accepted.cohort.lifecycle.runtime.meta.identity.sessionId, f.id);
		});
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelectedCurrent(f.cwd, f.id, ["session"], 7, f.root);
			writeFileSync(f.runtimePaths.runtime, readFileSync(f.runtimePaths.runtime, "utf8") + " ");
			assert.throws(() => transaction.acceptSelectedCurrent(f.cwd, f.id, { selection: ["session"], historyLimit: 7 }, base, f.root), /changed concurrently/);
			assert.throws(() => transaction.acceptSelectedCurrent(f.cwd, f.id, { selection: ["session"], historyLimit: 7 }, base, f.root), /already used/);
		});
	});

	test("presence changes immediately before publication cannot escape the selected current CAS", async (t) => {
		const f = await fixture(t); await f.drift();
		const retired = join(temporalScopePaths(f.cwd, f.id, "global", f.root).directory, "state.json");
		const before = readFileSync(f.runtimePaths.runtime);
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelectedCurrent(f.cwd, f.id, ["global", "session"], 7, f.root);
			const stat = fs.lstatSync; let reads = 0;
			fs.lstatSync = ((path: fs.PathLike, ...args: any[]) => {
				if (String(path) === retired && ++reads === 3) writeFileSync(retired, "foreign retired layout");
				return (stat as any)(path, ...args);
			}) as typeof fs.lstatSync;
			syncBuiltinESMExports();
			try { assert.throws(() => transaction.acceptSelectedCurrent(f.cwd, f.id, { selection: ["global", "session"], historyLimit: 7 }, base, f.root), /presence dependencies changed concurrently/); }
			finally { fs.lstatSync = stat; syncBuiltinESMExports(); }
		});
		assert.deepEqual(readFileSync(f.runtimePaths.runtime), before);
		assert.equal(readFileSync(retired, "utf8"), "foreign retired layout");
	});
}

test("selected shared origin preparation is store-bound and expires with its transaction", async (t) => {
	const empty = originFixture.fixture(t);
	mkdirSync(empty.root, { recursive: true });
	let ended: StorageTransaction | undefined;
	await withStorageTransaction(empty.root, (transaction) => {
		ended = transaction;
		assert.throws(() => transaction.initializeSelectedSharedOrigin(empty.cwd, empty.id, { selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7 }, `${empty.root}-other`), /different store/);
	});
	assert.throws(() => ended!.initializeSelectedSharedOrigin(empty.cwd, empty.id, { selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7 }, empty.root), /ended/);
});

{
	const { fixture, files, unchanged, withoutBodies, legacyLifecycle } = lifecycleFixture;

	test("storage Passive publication derives run/temporal state from exact sources and consumes the common selected capability", async t => {
		const f = await fixture(t, ["session"]);
		const life = sessionRuntimePaths(f.cwd, f.id, f.root);
		writeFileSync(life.runtime, JSON.stringify({ ...JSON.parse(readFileSync(life.runtime, "utf8")), forward: { opaque: [false, "keep"] } }));
		await f.runtime.withSelectedCurrentTransaction(["session"], (_s, publish) => publish(), () => {});
		const acceptedRuntimeBytes = readFileSync(life.runtime);
		let escaped: (() => unknown) | undefined;
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelected(f.cwd, f.id, ["session"], f.root)!;
			base.lifecycle.runtime.meta.step = 999; base.lifecycle.runtime.meta.specification = "forged";
			base.view.scopes.session!.checkpoint.state = { strategy: { forged: true } };
			escaped = () => transaction.persistSelectedPassive(f.cwd, f.id, base, f.root);
			const receipt = transaction.persistSelectedPassive(f.cwd, f.id, base, f.root);
			assert.equal(receipt.cohort.lifecycle.runtime.meta.step, 1);
			assert.equal(receipt.cohort.lifecycle.runtime.meta.specification, "accepted run");
			assert.equal(receipt.cohort.view.scopes.session!.checkpoint.state.strategy?.forged, undefined);
			assert.throws(() => transaction.persistSelectedPassive(f.cwd, f.id, base, f.root), /already used/);
			assert.throws(() => transaction.publishSelected(f.cwd, f.id, { view: base.view, historyLimit: 7 }, base, f.root), /already used/);
		});
		assert.throws(() => escaped!(), /transaction has ended/);
		assert.deepEqual(readFileSync(life.runtime), acceptedRuntimeBytes);
	});

	test("retired semantic predecessors are refused before Passive persistence can convert them", async t => {
		const f = await fixture(t, ["session"]), p = temporalScopePaths(f.cwd, f.id, "session", f.root);
		const metadata = JSON.parse(readFileSync(p.meta, "utf8")); metadata.version = 2;
		for (const path of [p.checkpoint, p.patches]) writeFileSync(path, readFileSync(path, "utf8").replaceAll('"strategy"', '"contract"'));
		writeFileSync(p.meta, JSON.stringify(metadata));
		const before = files(f);
		await withStorageTransaction(f.root, transaction => {
			assert.throws(() => transaction.prepareSelected(f.cwd, f.id, ["session"], f.root), /no longer converted since State Flow 1\.0\.0/);
		});
		unchanged(before);
	});

	test("retired V1 cannot be used as a Passive lifecycle source", async t => {
		const { f, before, bodies } = await legacyLifecycle(t);
		await withStorageTransaction(f.root, async transaction => {
			await withoutBodies(bodies, () => assert.rejects(async () => transaction.prepareSelected(f.cwd, f.id, ["cwd"], f.root), /lifecycle V1 is retired/));
		});
		unchanged(before);
	});
}

test("selected Session acquisition rejects a mismatched storage transaction root", async (t) => {
	const { fixture, request } = sessionAcquisitionFixture;
	const f = fixture(t);
	await f.shared();
	await withStorageTransaction(f.root, (transaction) => {
		assert.throws(() => transaction.acquireSelectedSession(f.cwd, f.id, request(["session"]), `${f.root}-other`), /different store/);
	});
});

{
	function fixture(t: TestContext, acquisition: "acquired" | "unacquired" | "deferred" = "acquired") {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-publish-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), sessionId = "owner";
		let view = createTemporalState({ global: { strategy: { marker: "global" } }, cwd: { strategy: { marker: "cwd" } }, session: {} }, "publish-origin");
		view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { step: 1 } } }], "publish-global");
		view = advanceTemporalState(view, [{ scope: "cwd", patch: { tactics: { step: 2 } } }], "publish-cwd");
		if (acquisition === "acquired") view = advanceTemporalState(view, [{ scope: "session", patch: { strategy: { marker: "private" } } }], "publish-session");
		writeNumericLifecycleFixture(cwd, sessionId, root, view, 2, acquisition);
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		const privatePaths = temporalScopePaths(cwd, sessionId, "session", root);
		const metadata = JSON.parse(readFileSync(paths.runtime, "utf8"));
		writeFileSync(paths.runtime, JSON.stringify({ ...metadata, foreign: { retained: "$session.working.opaque" } }));
		for (const scope of ["global", "cwd", "session"] as const) {
			const path = temporalScopePaths(cwd, sessionId, scope, root).meta;
			if (existsSync(path)) writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), foreign: { keep: scope }, artifacts: { "future-note": { retained: "opaque" } } }));
		}
		const original = captureTestBasis(cwd, sessionId, root);
		const backupDir = `${root}-migration-backups`;
		const load = async (selection: readonly StateScope[]) => (await loadSelectedFileCohort(cwd, sessionId, captureScopeSelection(selection), root))!;
		const publish = (base: SelectedFileCohort, request: SelectedPublicationRequest, signal?: AbortSignal) => publishSelectedTemporalStateToFiles(cwd, sessionId, request, base, root, sessionId, signal);
		return { root, cwd, sessionId, paths, privatePaths, original, backupDir, load, publish };
	}

	function request(base: SelectedFileCohort, transition?: AcceptedTransition, historyLimit = 7): SelectedPublicationRequest {
		let view = constrainTemporalState(base.view, historyLimit);
		if (transition) view = advanceTemporalState(view, transition.transitions, transition.id, historyLimit);
		return { view, historyLimit, ...(transition ? { transition } : {}) };
	}
	function unchanged(f: ReturnType<typeof fixture>, except: string[] = []) {
		for (const file of f.original.files) if (!except.includes(file.path)) {
			if (file.bytes === undefined) assert.equal(existsSync(file.path), false);
			else assert.deepEqual(readFileSync(file.path), file.bytes, file.path);
		}
	}

	test("V2 observation, accepted no-op and mode-only persistence do not convert", async t => {
		const f = fixture(t);
		const selection = ["global", "cwd", "session"] as const;
		const observer = new TemporalRuntime(f.cwd, f.sessionId, f.root);
		await observer.refreshSelectedCurrent(selection, () => {});
		unchanged(f);
		assert.equal(existsSync(f.backupDir), false);
		const owner = new TemporalRuntime(f.cwd, f.sessionId, f.root);
		const noOp = await owner.withSelectedCurrentTransaction(selection, (_snapshot, publish) => publish(), () => {});
		assert.equal(noOp.cohort.lifecycle.sourceVersion, 2);
		assert.equal(noOp.migrationBackup, undefined);
		const before = captureTestBasis(f.cwd, f.sessionId, f.root);
		await owner.persistSelectedPassive(() => {});
		assert.equal(JSON.parse(readFileSync(f.paths.runtime, "utf8")).version, 2);
		assert.equal(JSON.parse(readFileSync(f.paths.config, "utf8")).mode, "passive");
		for (const file of before.files) if (file.path !== f.paths.config && file.path !== f.paths.runtime) assert.deepEqual(readFileSync(file.path), file.bytes);
		await withStorageTransaction(f.root, tx => {
			const base = tx.prepareSelectedCurrent(f.cwd, f.sessionId, selection, 0, f.root);
			const folded = tx.acceptSelectedCurrent(f.cwd, f.sessionId, { selection, historyLimit: 0 }, base, f.root);
			assert.equal(folded.changed, true);
			assert.equal(folded.cohort.view.lineage.length, 1);
			assert.equal(folded.cohort.lifecycle.sourceVersion, 2, "representation-only folding must not convert");
		});
		assert.equal(existsSync(f.backupDir), false);
	});

	test("V2 conversion refuses an invalid backup directory and restores exact bytes on a later publication failure", async t => {
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		const next = request(base, { id: "first-baseline", transitions: [{ scope: "cwd", patch: { tactics: { check: true } } }] });
		mkdirSync(f.backupDir, { mode: 0o755 });
		await assert.rejects(f.publish(base, next), /backup directory must be private/);
		unchanged(f);
		fs.chmodSync(f.backupDir, 0o700);
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => {
			if (!injected && to === f.paths.runtime) { injected = true; throw new Error("injected Baseline publication failure"); }
			rename(from, to);
		};
		syncBuiltinESMExports();
		try { await assert.rejects(f.publish(base, next), /injected Baseline publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		unchanged(f);
		assert.equal(readdirSync(f.backupDir).length, 1);
		const retry = await f.publish(base, next);
		assert.equal(retry.cohort.lifecycle.sourceVersion, "baseline");
		assert.equal(readdirSync(f.backupDir).length, 1, "retry reuses the same verified backup");
	});

	test("selected replay publishes exact next receipts, increments only changed owners and preserves excluded bytes/opaque metadata", async (t) => {
		const f = fixture(t);
		const base = await f.load(["global", "cwd"]);
		const transition: AcceptedTransition = { id: "selected-accepted", transitions: [
			{ scope: "global", patch: { strategy: { chosen: "yes" } } }, { scope: "cwd", patch: { tactics: { progress: "verified" } } },
		] };
		const next = request(base, transition);
		next.lifecycle = { config: { mode: "passive" }, meta: { step: 1, specification: "continue" } };
		const result = await f.publish(base, next);
		assert.equal(result.changed, true);
		assert.equal(result.cohort.lifecycle.sourceVersion, "baseline");
		const wire = JSON.parse(readFileSync(f.paths.runtime, "utf8"));
		assert.equal(wire.format, "baseline");
		assert.equal(Object.hasOwn(wire, "causalWitnesses"), false);
		assert.deepEqual(wire.lineage.at(-1).owners, ["global", "cwd"]);
		assert.ok(result.migrationBackup);
		const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.deepEqual(manifest.lifecycleConversion, { sourceVersion: 2, targetVersion: "baseline" });
		assert.deepEqual(manifest.convertedScopes, []);
		assert.equal(manifest.files.length, base.basis.files.length);
		for (const file of base.basis.files) assert.equal(manifest.files.find((entry: any) => entry.path === relative(f.root, file.path)).bytes, file.bytes === undefined ? null : Buffer.from(file.bytes).toString("base64"));
		assertSelectedFileCohortBasis(result.cohort, await f.load(["global", "cwd"]));
		assert.deepEqual(temporalScopeRevisions(result.cohort.view), { global: base.view.scopes.global!.revision + 1, cwd: base.view.scopes.cwd!.revision + 1 });
		assert.equal(result.cohort.lifecycle.runtime.meta.step, 1);
		assert.equal(result.cohort.lifecycle.runtime.config.mode, "passive");
		assert.deepEqual(result.cohort.lifecycle.runtime.meta.foreign, { retained: "$session.working.opaque" });
		for (const scope of ["global", "cwd"] as const) {
			const metadata = JSON.parse(readFileSync(temporalScopePaths(f.cwd, f.sessionId, scope, f.root).meta, "utf8"));
			assert.deepEqual(metadata.foreign, { keep: scope });
			assert.deepEqual(metadata.artifacts, { "future-note": { retained: "opaque" } });
		}
		for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.deepEqual(readFileSync(path), f.original.files.find((file) => file.path === path)!.bytes);
		for (let offset = 0; offset < result.cohort.view.lineage.length; offset++) assert.deepEqual(readTemporalView(result.cohort.view, offset), readTemporalView(next.view, offset));
		const noop = request(result.cohort, transition);
		const repeated = await f.publish(result.cohort, noop);
		assert.equal(repeated.changed, false);
		assert.equal(repeated.migrationBackup, undefined);
		assert.equal(readdirSync(f.backupDir).length, 1);
	});

	test("every selected subset publishes one atomic replay and only selected Session can retain its authored response", async (t) => {
		const order = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) {
			const f = fixture(t);
			const selection = order.filter((_, bit) => mask & (1 << bit));
			const base = await f.load(selection);
			const transition: AcceptedTransition = { id: `subset-${mask}`, transitions: selection.map((scope) => ({ scope, patch: {
				tactics: { accepted: mask }, ...(scope === "session" ? { response: `answer-${mask}` } : {}),
			} })) };
			const result = await f.publish(base, request(base, transition));
			assert.equal(result.cohort.basis.files.length, 2 + 3 * selection.length);
			assertSelectedFileCohortBasis(result.cohort, await f.load(selection));
			for (const scope of selection) assert.equal(result.cohort.view.scopes[scope]!.revision, base.view.scopes[scope]!.revision + 1);
			if (selection.includes("session")) assert.equal(readTemporalView(result.cohort.view, 0, "session").response, `answer-${mask}`);
			for (const scope of order.filter((scope) => !selection.includes(scope))) {
				const paths = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
				for (const path of [paths.checkpoint, paths.patches, paths.meta]) assert.deepEqual(readFileSync(path), f.original.files.find((file) => file.path === path)!.bytes);
			}
		}
	});

	test("forged value/lineage/witness, excluded no-op and caller-supplied acquisition fields never reach writes or backup", async (t) => {
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		for (const mutate of [
			(next: SelectedPublicationRequest) => { next.view.lineage.at(-1)!.id = "forged-head"; },
			(next: SelectedPublicationRequest) => { next.view.scopes.cwd!.checkpoint.state.strategy = { forged: true }; },
			(next: SelectedPublicationRequest) => { next.view.causalBasis[0]!.owners = ["session"]; },
			(next: SelectedPublicationRequest) => { next.transition = { id: "excluded-noop", transitions: [{ scope: "global", patch: {} }] }; },
			(next: SelectedPublicationRequest) => { next.lifecycle = { config: { mode: "active" }, meta: { step: 0, privateAcquisition: "unacquired" } } as any; },
			(next: SelectedPublicationRequest) => { next.lifecycle = { config: { mode: null }, meta: { step: 0 } } as any; },
		]) {
			const next = request(base); mutate(next);
			await assert.rejects(f.publish(base, next));
			unchanged(f);
			assert.equal(existsSync(f.backupDir), false);
		}
		const global = await f.load(["global"]);
		await assert.rejects(f.publish(global, { ...request(global), transition: { id: "wrong-response-owner", transitions: [{ scope: "global", patch: { response: "not private" } }] } }), /session response/);
		unchanged(f);
		assert.equal(existsSync(f.backupDir), false);
	});

	test("already-admitted shared-only unacquired/deferred owners can publish but never acquire/create Session", async (t) => {
		for (const acquisition of ["unacquired", "deferred"] as const) {
			const f = fixture(t, acquisition);
			const base = await f.load(["cwd"]);
			const next = request(base, { id: "shared-only-next", transitions: [{ scope: "cwd", patch: { tactics: { check: true } } }] });
			const result = await f.publish(base, next);
			assert.equal(result.cohort.lifecycle.runtime.meta.privateAcquisition, acquisition);
			for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
			await assert.rejects(f.load(["session"]), /requires explicit private acquisition/);
			assert.ok(result.migrationBackup);
			assert.equal(result.cohort.lifecycle.sourceVersion, "baseline");
		}
	});

	test("folding limits 0/1/7/100 preserve exact replay and revisions without folding disabled streams", async (t) => {
		for (const limit of [0, 1, 7, 100]) {
			const f = fixture(t);
			const base = await f.load(["cwd"]);
			const next = request(base, { id: `limit-${limit}`, transitions: [{ scope: "cwd", patch: { tactics: { limit } } }] }, limit);
			const result = await f.publish(base, next);
			assertSelectedFileCohortBasis(result.cohort, await f.load(["cwd"]));
			assert.deepEqual(result.cohort.view, next.view);
			assert.equal(result.cohort.view.scopes.cwd!.revision, base.view.scopes.cwd!.revision + 1);
			for (const scope of ["global", "session"] as const) {
				const paths = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
				for (const path of [paths.checkpoint, paths.patches, paths.meta]) assert.deepEqual(readFileSync(path), f.original.files.find((file) => file.path === path)!.bytes);
			}
		}
	});

	test("stale bytes/presence and cancellation cannot publish or create recovery backups", async (t) => {
		for (const target of ["runtime", "scope"] as const) {
			const f = fixture(t);
			const base = await f.load(["cwd"]);
			const path = target === "runtime" ? f.paths.runtime : temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).checkpoint;
			const foreign = `${readFileSync(path, "utf8")} `;
			writeFileSync(path, foreign);
			await assert.rejects(f.publish(base, request(base)), /changed concurrently/);
			assert.equal(readFileSync(path, "utf8"), foreign);
			unchanged(f, [path]);
			assert.equal(existsSync(f.backupDir), false);
		}
		const missing = fixture(t);
		const missingBase = await missing.load(["cwd"]);
		rmSync(missing.privatePaths.checkpoint);
		await assert.rejects(missing.publish(missingBase, request(missingBase)), /incomplete/);
		assert.equal(existsSync(missing.backupDir), false);
		const canceled = fixture(t);
		const canceledBase = await canceled.load(["cwd"]);
		const lock = join(canceled.root, ".state-flow-publication.lock");
		writeFileSync(lock, `${process.pid}\n`);
		const controller = new AbortController();
		try {
			const pending = canceled.publish(canceledBase, request(canceledBase), controller.signal);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			unchanged(canceled);
			assert.equal(existsSync(canceled.backupDir), false);
			assert.equal(existsSync(lock), true);
		} finally { rmSync(lock); }
	});

	test("uncooperative runtime edits during publication survive guarded rollback, not stale overwrite", async (t) => {
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		const next = request(base, { id: "foreign-interference", transitions: [{ scope: "cwd", patch: { tactics: { accepted: true } } }] });
		const target = temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).checkpoint;
		const foreign = `${readFileSync(f.paths.runtime, "utf8")}\n `;
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => {
			rename(from, to);
			if (!injected && to === target) { injected = true; writeFileSync(f.paths.runtime, foreign); }
		};
		syncBuiltinESMExports();
		try { await assert.rejects(f.publish(base, next), /file conflict.*concurrent bytes preserved/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		assert.equal(readFileSync(f.paths.runtime, "utf8"), foreign);
		unchanged(f, [f.paths.runtime]);
		assert.equal(readdirSync(f.backupDir).length, 1);
	});

	test("selected publication capability is store/callback-owned and single-use even after a failed attempt", async (t) => {
		const f = fixture(t);
		let retained: StorageTransaction | undefined;
		await withStorageTransaction(f.root, (transaction) => {
			retained = transaction;
			const base = transaction.prepareSelected(f.cwd, f.sessionId, ["cwd"], f.root)!;
			assert.throws(() => transaction.publishSelected(f.cwd, f.sessionId, request(base), base, `${f.root}-other`), /different store/);
			const invalid = request(base); invalid.view.lineage.at(-1)!.id = "not-admitted";
			assert.throws(() => transaction.publishSelected(f.cwd, f.sessionId, invalid, base, f.root), /successor/);
			assert.throws(() => transaction.publishSelected(f.cwd, f.sessionId, request(base), base, f.root), /already used/);
		});
		assert.throws(() => retained!.publishSelected(f.cwd, f.sessionId, {} as any, {} as any, f.root), /ended/);
		unchanged(f);
		assert.equal(existsSync(f.backupDir), false);
	});
}

test("deferred fork storage capability is store-bound, single-use and transaction-scoped", async (t) => {
	const other = deferredForkFixture.fixture(t);
	mkdirSync(other.root);
	let ended: StorageTransaction | undefined;
	await withStorageTransaction(other.root, (transaction) => {
		ended = transaction;
		assert.throws(() => transaction.deferSelectedFork(other.cwd, other.id, { selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7 }, `${other.root}-foreign`), /different store/);
		assert.throws(() => transaction.deferSelectedFork(other.cwd, other.id, { selection: ["cwd"], snapshot: { config: { mode: "active" }, meta: { step: 2 } }, historyLimit: 7 }, other.root), /fresh child lifecycle/);
		assert.throws(() => transaction.deferSelectedFork(other.cwd, other.id, { selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7 }, other.root), /already used/);
	});
	assert.throws(() => ended!.deferSelectedFork(other.cwd, other.id, { selection: ["cwd"], snapshot: emptySnapshot("active"), historyLimit: 7 }, other.root), /ended/);
});

{
	const { fixture } = readObservationFixture;

	test("borrowed store observers expire, return detached values and do not consume selected publication capability", async t => {
		const f = await fixture(t); let escaped!: () => SelectedReadObservation;
		await withStorageTransaction(f.root, transaction => {
			escaped = () => transaction.observeSelectedShared(f.cwd, ["cwd"], f.root);
			const first = escaped(); first.view!.scopes.cwd!.checkpoint.state = { strategy: { forged: true } };
			assert.equal(readTemporalView(escaped().view!).strategy!.forged, undefined);
			const base = transaction.prepareSelected(f.cwd, f.id, ["global", "cwd"], f.root)!;
			assert.equal(transaction.persistSelectedPassive(f.cwd, f.id, base, f.root).cohort.lifecycle.runtime.config.mode, "passive");
		});
		assert.throws(escaped, /transaction has ended/);
	});
}
