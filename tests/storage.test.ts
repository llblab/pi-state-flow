import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fixture as selectedCurrentFixture } from "./current-fixture.ts";
import * as originFixture from "./origin-fixture.ts";
import * as legacyPublicationFixture from "./legacy-publication-fixture.ts";
import * as lifecycleFixture from "./lifecycle-fixture.ts";
import * as sessionAcquisitionFixture from "./session-acquisition-fixture.ts";
import * as deferredForkFixture from "./deferred-fork-fixture.ts";
import * as readObservationFixture from "./read-observation-fixture.ts";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths, writeOwnedFileUpdates } from "../lib/durable.ts";
import { hashJson } from "../lib/json.ts";
import { stageSelectedScopePatches } from "../lib/transition.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import type { AcceptedTransition } from "../lib/history.ts";
import { createSessionRuntime, emptySnapshot, RevisionUnavailableError } from "../lib/snapshot.ts";
import { emptyState, type StateScope } from "../lib/state.ts";
import { captureScopeSelection } from "../lib/selection.ts";
import {
	assertSelectedFileCohortBasis, captureTemporalFileBase, initializeFileStore, isFileRevision, loadSelectedFileCohort,
	loadTemporalFileRevision, PublicationBusyError, publishSelectedTemporalStateToFiles, publishTemporalStateToFiles, withStoragePublicationLock, withStorageTransaction, type SelectedFileCohort, type SelectedModuleAdditions, type SelectedPublicationRequest, type SelectedReadObservation, type StorageTransaction,
} from "../lib/storage.ts";
import { advanceTemporalState, constrainTemporalState, createTemporalState, readTemporalState, readTemporalView, temporalCausalWitnesses, temporalScopeRevisions } from "../lib/temporal.ts";

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

test("metadata4 conversion preserves foreign edits during guarded rollback instead of overwriting opaque bytes", t => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-external-foreign-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "owner";
	initializeFileStore(root);
	const view = createTemporalState({ global: {}, cwd: {}, session: { strategy: { old: true } } }, "foreign-origin");
	const runtime = createSessionRuntime(emptySnapshot("active"), cwd, id, view.lineage);
	publishTemporalStateToFiles(cwd, id, view, ["global", "cwd", "session"], captureTemporalFileBase(cwd, id, root), root, runtime);
	const base = captureTemporalFileBase(cwd, id, root), paths = temporalScopePaths(cwd, id, "session", root);
	view.scopes.session.modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	const next = advanceTemporalState(view, [{ scope: "session", patch: { x_acme_archive: { empty: {} } } }], "foreign-external");
	const rename = fs.renameSync, foreign = '{"foreign":"must survive"}\n';
	let injected = false;
	fs.renameSync = (from, to) => {
		if (to === paths.patches && injected) throw new Error("injected metadata4 tail failure");
		rename(from, to);
		if (to === paths.checkpoint && !injected) { injected = true; writeFileSync(paths.checkpoint, foreign); }
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => publishTemporalStateToFiles(cwd, id, next, ["session"], base, root,
			createSessionRuntime(emptySnapshot("active"), cwd, id, next.lineage)), error => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error.errors[1]), /file conflict.*concurrent bytes preserved/);
			return true;
		});
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(injected, true);
	assert.equal(readFileSync(paths.checkpoint, "utf8"), foreign);
	for (const file of base.files) if (file.bytes && file.path !== paths.checkpoint) assert.deepEqual(readFileSync(file.path), file.bytes);
	assert.equal(readdirSync(`${root}-migration-backups`).length, 1);
});

test("metadata4 owned conversion uses exact-byte backup/CAS/rollback and selected replay/fork retain opaque descriptors", async t => {
	for (const version of [1, 2, 3]) {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-external-upgrade-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "parent";
		initializeFileStore(root);
		let view = createTemporalState({ global: {}, cwd: {}, session: { strategy: { plan: "retained" } } }, "upgrade-origin");
		view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { old: true } } }], "upgrade-old");
		const runtime = () => createSessionRuntime(emptySnapshot("active"), cwd, id, view.lineage);
		publishTemporalStateToFiles(cwd, id, view, ["global", "cwd", "session"], captureTemporalFileBase(cwd, id, root), root, runtime());
		const paths = temporalScopePaths(cwd, id, "session", root);
		if (version < 3) {
			for (const path of [paths.checkpoint, paths.patches]) writeFileSync(path, readFileSync(path, "utf8").replaceAll('"strategy":', '"contract":').replaceAll('"tactics":', '"working":'));
			writeFileSync(paths.meta, JSON.stringify({ ...JSON.parse(readFileSync(paths.meta, "utf8")), version }));
		}
		let base = captureTemporalFileBase(cwd, id, root);
		// Observation and a real runtime-only publication do not adopt a new semantic epoch.
		assert.ok(await loadSelectedFileCohort(cwd, id, ["session"], root));
		const policy = createSessionRuntime(emptySnapshot("passive"), cwd, id, view.lineage);
		publishTemporalStateToFiles(cwd, id, view, [], base, root, policy, id, undefined, true);
		assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).version, version);
		assert.equal(existsSync(`${root}-migration-backups`), false);
		base = captureTemporalFileBase(cwd, id, root);
		const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
		view.scopes.session.modules = modules;
		const opaque = JSON.parse('{"empty":{},"slots":[{},[]],"__proto__":{"constructor":{}},"a/b~c":{"remove":true,"keep":{}}}');
		view = advanceTemporalState(view, [{ scope: "session", patch: { x_acme_archive: opaque } }], "upgrade-external");
		const publish = () => publishTemporalStateToFiles(cwd, id, view, ["session"], base, root, runtime());
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === paths.patches) { injected = true; throw new Error("injected metadata4 publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { assert.throws(publish, /injected metadata4 publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		for (const file of base.files) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
		const result = publish();
		assert.ok(result.migrationBackup);
		const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.equal(manifest.targetVersion, 4);
		assert.deepEqual(manifest.convertedScopes, ["session"]);
		assert.equal(readdirSync(`${root}-migration-backups`).length, 1, "completed exact backup reused after rollback");
		for (const file of base.files) {
			const receipt = manifest.files.find((item: { path: string }) => item.path === relative(root, file.path));
			assert.equal(receipt.identity, file.identity);
			assert.deepEqual(receipt.bytes === null ? undefined : Buffer.from(receipt.bytes, "base64"), file.bytes);
		}
		assert.throws(publish, /changed concurrently/);
		let selected = (await loadSelectedFileCohort(cwd, id, ["session"], root))!;
		assert.deepEqual(selected.view.scopes.session, view.scopes.session);
		// No registry or definition is involved. Accepted external replay remains raw, model admission does not widen.
		const second = advanceTemporalState(view, [{ scope: "session", patch: { x_acme_archive: { "a/b~c": { remove: null, revision: 2 } } } }], "upgrade-external-2");
		publishTemporalStateToFiles(cwd, id, second, ["session"], result.base, root, createSessionRuntime(emptySnapshot("active"), cwd, id, second.lineage));
		selected = (await loadSelectedFileCohort(cwd, id, ["session"], root))!;
		const before = readTemporalView(selected.view, 0, "session");
		const stage = stageSelectedScopePatches({ selection: ["session"], states: { session: before } }, { session: { tactics: { core: "unrelated" } } }, [], "metadata4");
		const accepted = createAcceptedTransition({ session: before }, stage.nextStates, "upgrade-core")!;
		const next = advanceTemporalState(selected.view, accepted.transitions, accepted.id);
		const saved = await publishSelectedTemporalStateToFiles(cwd, id, { view: next, transition: accepted, historyLimit: 7 }, selected, root);
		assert.equal(saved.migrationBackup !== undefined, true, "only legacy lifecycle1 converts here");
		assert.deepEqual(readTemporalView(saved.cohort.view, 0, "session").x_acme_archive, before.x_acme_archive);
		await withStorageTransaction(root, transaction => {
			const passive = transaction.persistSelectedPassive(cwd, id, saved.cohort, root);
			assert.deepEqual(passive.cohort.view.scopes.session!.modules, modules);
		});
		const parentBytes = captureTemporalFileBase(cwd, id, root);
		const fork = await withStorageTransaction(root, transaction => transaction.copySelectedFork(cwd, "child", {
			kind: "fork-new", source: { id, key: id }, selection: ["session"], snapshot: emptySnapshot("active"), historyLimit: 7,
		}, root));
		assert.deepEqual(fork.cohort.view.scopes.session!.modules, modules);
		assert.deepEqual(readTemporalView(fork.cohort.view, 0, "session"), readTemporalView(saved.cohort.view, 0, "session"));
		assert.equal(fork.cohort.view.scopes.session!.revision, saved.cohort.view.scopes.session!.revision);
		assert.throws(() => readTemporalView(fork.cohort.view, 1), /predates/);
		for (const file of parentBytes.files) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
		assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).version, 4);
	}
});

{
	function fixture(t: TestContext, acquisition: "acquired" | "unacquired" | "deferred" = "acquired", version: 1 | 2 = 2) {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-store-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), sessionId = "owner";
		initializeFileStore(root);
		let view = createTemporalState({ global: { strategy: { marker: "global-only-value" } }, cwd: { strategy: { marker: "cwd-only-value" } }, session: {} }, "store-origin");
		view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { step: 1 } } }], "store-global");
		view = advanceTemporalState(view, [{ scope: "cwd", patch: { tactics: { step: 2 } } }], "store-cwd");
		if (acquisition === "acquired") view = advanceTemporalState(view, [{ scope: "session", patch: { strategy: { marker: "session-only-value" } } }], "store-session");
		const runtime = createSessionRuntime(emptySnapshot("active"), cwd, sessionId, view.lineage);
		publishTemporalStateToFiles(cwd, sessionId, view, ["global", "cwd", "session"], captureTemporalFileBase(cwd, sessionId, root), root, runtime);
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		const privatePaths = temporalScopePaths(cwd, sessionId, "session", root);
		if (version === 2) {
			writeFileSync(paths.config, JSON.stringify({ mode: "active", scopes: acquisition === "acquired" ? ["global", "cwd", "session"] : ["global", "cwd"] }));
			writeFileSync(paths.runtime, JSON.stringify({ ...runtime.meta, version: 2, privateAcquisition: acquisition, causalWitnesses: temporalCausalWitnesses(view), opaqueParent: "/not-a-parent-to-read" }));
			if (acquisition !== "acquired") for (const path of [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta]) rmSync(path);
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
		const original = captureTemporalFileBase(f.cwd, f.sessionId, f.root);
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
		await assert.rejects(f.load(["session"]));
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

	test("legacy lifecycle admission derives witnesses only after validating its complete all-owner cohort", async (t) => {
		const f = fixture(t, "acquired", 1);
		const { result: cohort, reads } = await observeReads(() => f.load(["cwd"]));
		assert.ok(cohort);
		assert.equal(cohort.basis.files.length, 11);
		assert.equal(cohort.lifecycle.sourceVersion, 1);
		assert.deepEqual(cohort.view.causalBasis.map((witness) => witness.owners), [["global"], ["session"]]);
		assert.equal(reads.includes(f.privatePaths.checkpoint), true);
		const differentlySelected = (await f.load(["global"]))!;
		assert.throws(() => assertSelectedFileCohortBasis(cohort, differentlySelected), /policy changed/);
		writeFileSync(f.privatePaths.checkpoint, "invalid-private-legacy-body");
		await assert.rejects(f.load(["cwd"]));
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
	const root = join(parent, "store");
	initializeFileStore(root);
	const cwd = join(parent, "project");
	const sessionId = "file-session";
	const snapshot = emptySnapshot("active");
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(snapshot, cwd, sessionId, view.lineage);
	const base = captureTemporalFileBase(cwd, sessionId, root);
	return { parent, root, cwd, sessionId, snapshot, view, runtime, base };
}

function actualReference(cwd: string, sessionId: string, root: string): string {
	return `file:${hashJson({ root, files: captureTemporalFileBases(cwd, sessionId, root).map(({ path, identity }) => [relative(root, path), identity]) })}`;
}


test("file cohorts persist sparse hot history, terminal responses, and config-only stop without executing Git", (t) => {
	const f = fixture(t);
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (() => assert.fail("file publication/recovery must not spawn any command")) as typeof spawn;
	syncBuiltinESMExports();
	try {
		writeFileSync(join(f.root, "unrelated.md"), "retained\n");
		let publication = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
		assert.ok(isFileRevision(publication.revision));
		assert.equal("commit" in publication, false);
		assert.equal("push" in publication, false);
		const firstReference = publication.revision;
		const retained = [readTemporalState(f.view)];
		for (let n = 1; n <= 10; n++) {
			const scope = n % 3 === 0 ? "global" : n % 2 === 0 ? "cwd" : "session";
			f.view = advanceTemporalState(f.view, [{ scope, patch: {
				tactics: { [scope]: n },
				...(n === 1 ? { intents: { current: "Persist in file-only mode" } } : {}),
			} }], `T${n}`);
			f.snapshot.meta.step = n;
			f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
			publication = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [scope], publication.base, f.root, f.runtime);
			retained.push(readTemporalState(f.view));
			const restarted = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, publication.revision);
			assert.deepEqual(restarted.view, f.view);
			for (let offset = 0; offset < restarted.view.lineage.length; offset++) assert.deepEqual(readTemporalState(restarted.view, offset), retained.at(-1 - offset));
			for (const stream of Object.values(restarted.view.scopes)) assert.ok(stream.patches.length <= 7);
		}
		assert.equal(readTemporalState(f.view).intents.current, "Persist in file-only mode");
		assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, firstReference), /unavailable/);
		f.view = advanceTemporalState(f.view, [{ scope: "session", patch: { response: "Final answer" } }], "terminal");
		f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
		publication = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], publication.base, f.root, f.runtime);
		assert.equal(readTemporalState(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, publication.revision).view).response, "Final answer");
		const noOp = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], publication.base, f.root, f.runtime);
		assert.equal(noOp.changed, false);
		assert.equal(noOp.revision, publication.revision);
		const semantics = publication.base.files.filter(({ path }) => path.endsWith("checkpoint.json") || path.endsWith("patches.jsonl"));
		f.snapshot.config.mode = "passive";
		f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
		const stopped = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], publication.base, f.root, f.runtime, f.sessionId, undefined, true);
		const restored = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, stopped.revision);
		assert.notEqual(restored.runtime.config.mode, "active");
		assert.deepEqual(restored.view, f.view);
		for (const file of semantics) assert.deepEqual(readFileSync(file.path), file.bytes);
		assert.equal(readFileSync(join(f.root, "unrelated.md"), "utf8"), "retained\n");
		assert.equal(existsSync(join(f.root, ".git")), false);
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
});

test("file cohorts persist scope provenance beside semantic state and reload it exactly", (t) => {
	const f = fixture(t);
	const artifactPath = join(f.parent, "knowledge", "a.md");
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, "guidance\n");
	const sourceHash = hashArtifactSource("guidance\n");
	f.view = advanceTemporalState(f.view, [{ scope: "global", patch: { artifacts: { [artifactPath]: { description: "Guidance" } } } }], "T1");
	f.snapshot.meta.step = 1;
	const provenance = {
		global: { [artifactPath]: { sourceHash, compilerRevision: ORDINARY_ARTIFACT_COMPILER } },
		cwd: {},
		session: {},
	};
	f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, provenance.session);
	const first = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime, f.sessionId, provenance);
	const loaded = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, first.revision);
	assert.deepEqual(loaded.provenance, provenance);
	const globalMeta = temporalScopePaths(f.cwd, f.sessionId, "global", f.root).meta;
	assert.deepEqual(JSON.parse(readFileSync(globalMeta, "utf8")), {
		version: 3, artifacts: provenance.global,
		temporal: { revision: 1, checkpoint: f.view.scopes.global.checkpoint.through, patches: f.view.scopes.global.patches.map((record) => record.transition) },
	});
	assert.equal(existsSync(temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).meta), true);
	// A provenance-only change is still one durable cohort without a semantic transition.
	const refreshed = {
		global: { [artifactPath]: { sourceHash: hashArtifactSource("guidance two\n"), compilerRevision: ORDINARY_ARTIFACT_COMPILER } },
		cwd: {},
		session: {},
	};
	const second = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], first.base, f.root, f.runtime, f.sessionId, refreshed);
	assert.equal(second.changed, true);
	assert.notEqual(second.revision, first.revision);
	assert.deepEqual(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, second.revision).provenance, refreshed);
	assert.deepEqual(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, second.revision).view, f.view);
});

test("file references bind exact bytes, complete runtime identities and lineage, never Git pointers", (t) => {
	const f = fixture(t);
	const p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	for (const revision of ["HEAD", "a".repeat(40), "file:" + "A".repeat(64)]) assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, revision), /exact file revision/);
	assert.throws(() => loadTemporalFileRevision(f.cwd, "foreign", f.root, p.revision), /unavailable/);
	assert.throws(() => loadTemporalFileRevision(join(f.cwd, "other"), f.sessionId, f.root, p.revision), /unavailable/);
	const copy = join(f.parent, "copied");
	fs.cpSync(f.root, copy, { recursive: true });
	assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, copy, p.revision), /unavailable/);
	const paths = sessionRuntimePaths(f.cwd, f.sessionId, f.root);
	const original = readFileSync(paths.runtime);
	writeFileSync(paths.runtime, Buffer.concat([original, Buffer.from("\n")]));
	assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, p.revision), /unavailable/);
	for (const mutate of [
		(meta: any) => { meta.identity.sessionId = "foreign"; },
		(meta: any) => { meta.lineage = [{ id: "foreign", parent: null, position: 0 }]; },
	]) {
		const meta = JSON.parse(original.toString());
		mutate(meta);
		writeFileSync(paths.runtime, JSON.stringify(meta));
		assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, actualReference(f.cwd, f.sessionId, f.root)), /identity|lineage|boundary|provenance|historical|origin|reachable/i);
	}
});

test("file CAS rejects stale and foreign bases and omitted changes before writes", (t) => {
	const f = fixture(t);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, "foreign", f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime), /scope identity changed/);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], f.base, f.root, f.runtime), /omitted a changed stream/);
	const p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], f.base, f.root, f.runtime), /changed concurrently/);
	const accepted = captureTemporalFileBases(f.cwd, f.sessionId, f.root);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global"], p.base, f.root, f.runtime, f.sessionId, undefined, true), /Runtime-only publication cannot write/);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], p.base, f.root, f.runtime, f.sessionId, { global: {}, cwd: {}, session: {} }, true), /Runtime-only publication cannot write/);
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), accepted);
	const path = temporalScopePaths(f.cwd, f.sessionId, "global", f.root).patches;
	const concurrent = Buffer.from([0xff, 0xfe, 0x0a]);
	writeFileSync(path, concurrent);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], p.base, f.root, f.runtime), /changed concurrently/);
	assert.deepEqual(readFileSync(path), concurrent);
});

test("lazy corruption and stale-basis publication fail before damaging retained hot state", (t) => {
	const f = fixture(t);
	const initialized = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	const peer = advanceTemporalState(f.view, [{ scope: "session", patch: { lazy: { owner: "peer" } } }], "lazy-peer");
	const peerRuntime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, peer.lineage);
	const accepted = publishTemporalStateToFiles(f.cwd, f.sessionId, peer, ["session"], initialized.base, f.root, peerRuntime);

	const corrupt = structuredClone(peer);
	corrupt.scopes.session.checkpoint.state.lazy = null as never;
	assert.throws(
		() => publishTemporalStateToFiles(f.cwd, f.sessionId, corrupt, ["session"], accepted.base, f.root, peerRuntime),
		/Invalid temporal materialized semantic state/,
	);

	const stale = advanceTemporalState(f.view, [{ scope: "session", patch: { tactics: { hot: "stale" }, lazy: { owner: "stale" } } }], "lazy-stale");
	const staleRuntime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, stale.lineage);
	assert.throws(
		() => publishTemporalStateToFiles(f.cwd, f.sessionId, stale, ["session"], initialized.base, f.root, staleRuntime),
		/changed concurrently/,
	);
	const retained = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, actualReference(f.cwd, f.sessionId, f.root)).view;
	assert.deepEqual(readTemporalState(retained, 0, "session").lazy, { owner: "peer" });
	assert.equal(readTemporalState(retained, 0, "session").tactics.hot, undefined);
});


test("publication waits for a brief cooperating live owner", async (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".state-flow-publication.lock");
	const child = childProcess.spawn(process.execPath, ["-e", `
		const fs = require("node:fs");
		const path = process.argv[1];
		fs.writeFileSync(path, process.pid + "\\n", { flag: "wx", mode: 0o600 });
		process.stdout.write("ready\\n");
		setTimeout(() => { fs.rmSync(path); }, 150);
	`, lock], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => { if (child.exitCode === null) child.kill(); });
	await once(child.stdout!, "data");
	let entered = false;
	withStoragePublicationLock(f.root, () => { entered = true; });
	assert.equal(entered, true);
	assert.equal(existsSync(lock), false);
	if (child.exitCode === null) await once(child, "exit");
});

test("async store transactions wait through a partial foreign publication without blocking the event loop", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	const next = advanceTemporalState(f.view, (["global", "cwd", "session"] as const).map((scope) => ({
		scope, patch: { tactics: { cohort: "foreign" } },
	})), "foreign");
	f.snapshot.meta.step = 1;
	const nextRuntime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, next.lineage);
	const partial = join(f.parent, "partial");
	const release = join(f.parent, "release");
	const receipt = join(f.parent, "receipt.json");
	const child = childProcess.spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { withStorageTransaction } from ${JSON.stringify(new URL("../lib/storage.ts", import.meta.url).href)};
		const { cwd, sessionId, root, view, runtime, partial, release, receipt, pauseAt } = JSON.parse(process.argv[1]);
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
			const base = tx.capture(cwd, sessionId, root);
			const result = tx.publish(cwd, sessionId, view, ["global", "cwd", "session"], base, root, runtime);
			fs.writeFileSync(receipt, JSON.stringify({ revision: result.revision, files: result.base.files.map(({ path, identity }) => ({ path, identity })) }));
		});
	`, JSON.stringify({ cwd: f.cwd, sessionId: f.sessionId, root: f.root, view: next, runtime: nextRuntime,
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
		return tx.capture(f.cwd, f.sessionId, f.root).files.map(({ path, identity }) => ({ path, identity }));
	});
	let settled = false;
	observed.then(() => { settled = true; }, () => { settled = true; });
	await delay(2_200); // Live contention outlasts the legacy 2-second fail-fast budget.
	assert.equal(entered, false);
	assert.equal(settled, false, "ordinary live contention must still be waiting, not a failed model call");
	assert.equal(readFileSync(join(f.root, ".state-flow-publication.lock"), "utf8").trim(), String(child.pid));
	writeFileSync(release, "continue");
	const files = await observed;
	assert.equal((await closed)[0], 0);
	const accepted = JSON.parse(readFileSync(receipt, "utf8"));
	assert.deepEqual(files, accepted.files, "reader must see the complete checkpoint/tail/metadata/runtime cohort");
	const loaded = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, accepted.revision);
	assert.deepEqual(loaded.view, next);
	for (const scope of ["global", "cwd", "session"] as const) assert.equal(readTemporalState(loaded.view, 0, scope).tactics.cohort, "foreign");
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
		assert.throws(() => tx.capture(f.cwd, f.sessionId, join(f.parent, "other")), /different store/);
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
	assert.throws(() => borrowed[0]!.capture(f.cwd, f.sessionId, f.root), /has ended/);
	assert.throws(() => borrowed[0]!.publish(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime), /has ended/);
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
	assert.deepEqual(await withStorageTransaction(f.root, (tx) => tx.capture(f.cwd, f.sessionId, f.root), undefined, false), f.base);
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
		assert.throws(() => withStoragePublicationLock(f.root, () => assert.fail("unreadable lock admitted")), unavailable);
		await assert.rejects(withStorageTransaction(f.root, () => assert.fail("unreadable lock admitted")), unavailable);
	} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
	assert.equal(readFileSync(lock, "utf8"), "unreadable owner\n");
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), f.base.files);
});

test("transaction cancellation and failed publication preserve canonical bytes and release exclusion", async (t) => {
	const f = fixture(t);
	await withStorageTransaction(f.root, (tx) => {
		const base = tx.capture(f.cwd, f.sessionId, f.root);
		tx.publish(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], base, f.root, f.runtime);
	});
	const before = captureTemporalFileBases(f.cwd, f.sessionId, f.root);
	const next = advanceTemporalState(f.view, [{ scope: "session", patch: { tactics: { accepted: true } } }], "next");
	const runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, next.lineage);
	const controller = new AbortController();
	await assert.rejects(withStorageTransaction(f.root, (tx) => {
		const base = tx.capture(f.cwd, f.sessionId, f.root);
		controller.abort();
		tx.publish(f.cwd, f.sessionId, next, ["session"], base, f.root, runtime);
	}, controller.signal), { name: "AbortError" });
	const rename = fs.renameSync;
	let failed = false;
	fs.renameSync = (from, to) => {
		if (to === temporalScopePaths(f.cwd, f.sessionId, "session", f.root).patches) { failed = true; throw new Error("injected transaction rename failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		await assert.rejects(withStorageTransaction(f.root, (tx) => {
			tx.publish(f.cwd, f.sessionId, next, ["session"], tx.capture(f.cwd, f.sessionId, f.root), f.root, runtime);
		}), /injected transaction rename failure/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(failed, true);
	assert.deepEqual(captureTemporalFileBases(f.cwd, f.sessionId, f.root), before);
	assert.equal(existsSync(join(f.root, ".state-flow-publication.lock")), false);
	await withStorageTransaction(f.root, (tx) => {
		tx.publish(f.cwd, f.sessionId, next, ["session"], tx.capture(f.cwd, f.sessionId, f.root), f.root, runtime);
	});
	assert.equal(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, actualReference(f.cwd, f.sessionId, f.root)).view.lineage.at(-1)!.id, "next");
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

test("file preparation rollback restores opaque originals and preserves conflicting external output", (t) => {
	const f = fixture(t);
	f.view.scopes.session.checkpoint.state.tactics = { raw: "\ufffd" };
	const first = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	const paths = temporalScopePaths(f.cwd, f.sessionId, "session", f.root);
	const source = readFileSync(paths.checkpoint, "utf8");
	const opaque = Buffer.concat([Buffer.from(source.split("\ufffd")[0]!), Buffer.from([0xff]), Buffer.from(source.split("\ufffd")[1]!)]);
	writeFileSync(paths.checkpoint, opaque);
	let base = captureTemporalFileBase(f.cwd, f.sessionId, f.root);
	f.view = advanceTemporalState(f.view, [{ scope: "session", patch: { response: "New" } }], "T1");
	f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], base, f.root, f.runtime), /encoded data|UTF-8/i);
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		if (!injected && to === paths.patches) { injected = true; throw new Error("injected rename failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeOwnedFileUpdates([{ path: paths.checkpoint, content: source }, { path: paths.patches, content: '{"response":"New"}\n' }], base.files, f.root), /injected rename failure/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(injected, true);
	assert.deepEqual(readFileSync(paths.checkpoint), opaque);
	assert.deepEqual(readFileSync(paths.patches), first.base.files.find(({ path }) => path === paths.patches)!.bytes);
	// Semantic publication rejects invalid UTF-8; exercise post-publication conflict handling from a valid basis.
	writeFileSync(paths.checkpoint, source);
	base = captureTemporalFileBase(f.cwd, f.sessionId, f.root);
	const concurrent = Buffer.from([0xfe, 0xff]);
	injected = false;
	fs.renameSync = (from, to) => {
		rename(from, to);
		if (!injected && to === paths.patches) { injected = true; writeFileSync(paths.checkpoint, concurrent); }
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], base, f.root, f.runtime), AggregateError);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.deepEqual(readFileSync(paths.checkpoint), concurrent);
	assert.equal(existsSync(join(f.root, ".state-flow-publication.lock")), false);
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

	test("Passive persistence cannot convert selected semantic predecessors even with matching candidate bytes", async t => {
		const f = await fixture(t, ["session"]), p = temporalScopePaths(f.cwd, f.id, "session", f.root);
		const metadata = JSON.parse(readFileSync(p.meta, "utf8")); metadata.version = 2;
		for (const path of [p.checkpoint, p.patches]) writeFileSync(path, readFileSync(path, "utf8").replaceAll('"strategy"', '"contract"'));
		writeFileSync(p.meta, JSON.stringify(metadata));
		const before = files(f);
		await withStorageTransaction(f.root, transaction => {
			const base = transaction.prepareSelected(f.cwd, f.id, ["session"], f.root)!;
			assert.throws(() => transaction.persistSelectedPassive(f.cwd, f.id, base, f.root), /requires lifecycle v2 and semantic v3/);
		});
		unchanged(before);
	});

	test("matching legacy lifecycle candidates cannot authorize Passive-only conversion", async t => {
		const { f, before, bodies } = await legacyLifecycle(t);
		await withStorageTransaction(f.root, async transaction => {
			const legacy = transaction.prepareSelected(f.cwd, f.id, ["cwd"], f.root)!;
			assert.equal(legacy.lifecycle.sourceVersion, 1);
			await withoutBodies(bodies, () => assert.rejects(async () => transaction.persistSelectedPassive(f.cwd, f.id, legacy, f.root), /requires lifecycle v2 and semantic v3/));
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
	function fixture(t: TestContext, version: 1 | 2 = 1, acquisition: "acquired" | "unacquired" | "deferred" = "acquired") {
		const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-publish-"));
		t.after(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "store"), cwd = join(parent, "workspace"), sessionId = "owner";
		initializeFileStore(root);
		let view = createTemporalState({ global: { strategy: { marker: "global" } }, cwd: { strategy: { marker: "cwd" } }, session: {} }, "publish-origin");
		view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { step: 1 } } }], "publish-global");
		view = advanceTemporalState(view, [{ scope: "cwd", patch: { tactics: { step: 2 } } }], "publish-cwd");
		if (acquisition === "acquired") view = advanceTemporalState(view, [{ scope: "session", patch: { strategy: { marker: "private" } } }], "publish-session");
		const runtime = createSessionRuntime(emptySnapshot("active"), cwd, sessionId, view.lineage);
		publishTemporalStateToFiles(cwd, sessionId, view, ["global", "cwd", "session"], captureTemporalFileBase(cwd, sessionId, root), root, runtime);
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		const privatePaths = temporalScopePaths(cwd, sessionId, "session", root);
		const metadata = { ...runtime.meta, foreign: { retained: "$session.working.opaque" } };
		writeFileSync(paths.runtime, JSON.stringify(version === 1 ? metadata : { ...metadata, version: 2, privateAcquisition: acquisition, causalWitnesses: temporalCausalWitnesses(view) }));
		if (version === 2) {
			writeFileSync(paths.config, JSON.stringify({ mode: "active", scopes: acquisition === "acquired" ? ["global", "cwd", "session"] : ["global", "cwd"] }));
			if (acquisition !== "acquired") for (const path of [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta]) rmSync(path);
		}
		for (const scope of ["global", "cwd", "session"] as const) {
			const path = temporalScopePaths(cwd, sessionId, scope, root).meta;
			if (existsSync(path)) writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), foreign: { keep: scope }, artifacts: { "future-note": { retained: "opaque" } } }));
		}
		const original = captureTemporalFileBase(cwd, sessionId, root);
		const backupDir = `${root}-migration-backups`;
		const load = async (selection: readonly StateScope[]) => (await loadSelectedFileCohort(cwd, sessionId, captureScopeSelection(selection), root))!;
		const publish = (base: SelectedFileCohort, request: SelectedPublicationRequest, signal?: AbortSignal) => publishSelectedTemporalStateToFiles(cwd, sessionId, request, base, root, sessionId, signal);
		return { root, cwd, sessionId, paths, privatePaths, view, original, backupDir, load, publish };
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

	test("lifecycle-only v1→v2 publication backs up the complete exact source before changes; scope selection changes no semantic revision", async (t) => {
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		const result = await f.publish(base, request(base));
		assert.ok(result.migrationBackup);
		const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.deepEqual(manifest.convertedScopes, []);
		assert.deepEqual(manifest.lifecycleConversion, { sourceVersion: 1, targetVersion: 2 });
		assert.equal(manifest.files.length, 11);
		for (const file of f.original.files) assert.equal(manifest.files.find((entry: any) => entry.path === relative(f.root, file.path)).bytes, file.bytes === undefined ? null : Buffer.from(file.bytes).toString("base64"));
		assert.deepEqual(manifest.updatedPaths.sort(), [relative(f.root, f.paths.config), relative(f.root, f.paths.runtime)].sort());
		assert.equal(fs.statSync(result.migrationBackup).mode & 0o777, 0o600);
		assert.equal(fs.statSync(f.backupDir).mode & 0o777, 0o700);
		unchanged(f, [f.paths.config, f.paths.runtime]);
		assert.deepEqual(temporalScopeRevisions(result.cohort.view), temporalScopeRevisions(base.view));
		assert.deepEqual(result.cohort.view.lineage, base.view.lineage);
		assert.equal(result.cohort.lifecycle.sourceVersion, 2);
		assert.equal(result.cohort.lifecycle.runtime.meta.privateAcquisition, "acquired");
		assert.deepEqual(result.cohort.lifecycle.runtime.config.scopes, ["cwd"]);
		assert.equal(result.cohort.basis.files.length, 5);
		assertSelectedFileCohortBasis(result.cohort, await f.load(["cwd"]));
		const again = await f.publish(result.cohort, request(result.cohort));
		assert.equal(again.changed, false);
		assert.equal(again.migrationBackup, undefined);
		assert.equal(readdirSync(f.backupDir).length, 1);
	});

	test("selected replay publishes exact next receipts, increments only changed owners and preserves excluded bytes/opaque metadata", async (t) => {
		const f = fixture(t, 2);
		const base = await f.load(["global", "cwd"]);
		const transition: AcceptedTransition = { id: "selected-accepted", transitions: [
			{ scope: "global", patch: { strategy: { chosen: "yes" } } }, { scope: "cwd", patch: { tactics: { progress: "verified" } } },
		] };
		const next = request(base, transition);
		next.lifecycle = { config: { mode: "passive" }, meta: { step: 1, specification: "continue" } };
		const result = await f.publish(base, next);
		assert.equal(result.changed, true);
		assert.equal(result.migrationBackup, undefined);
		assert.equal(existsSync(f.backupDir), false);
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
	});

	test("every selected subset publishes one atomic replay and only selected Session can retain its authored response", async (t) => {
		const order = ["global", "cwd", "session"] as const;
		for (let mask = 1; mask < 8; mask++) {
			const f = fixture(t, 2);
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
			const f = fixture(t, 2, acquisition);
			const base = await f.load(["cwd"]);
			const next = request(base, { id: "shared-only-next", transitions: [{ scope: "cwd", patch: { tactics: { check: true } } }] });
			const result = await f.publish(base, next);
			assert.equal(result.cohort.lifecycle.runtime.meta.privateAcquisition, acquisition);
			for (const path of [f.privatePaths.checkpoint, f.privatePaths.patches, f.privatePaths.meta]) assert.equal(existsSync(path), false);
			await assert.rejects(f.load(["session"]), /requires explicit private acquisition/);
			assert.equal(existsSync(f.backupDir), false);
		}
	});

	test("folding limits 0/1/7/100 preserve exact replay and revisions without folding disabled streams", async (t) => {
		for (const limit of [0, 1, 7, 100]) {
			const f = fixture(t, 2);
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
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		const foreign = `${readFileSync(f.paths.runtime, "utf8")} `;
		writeFileSync(f.paths.runtime, foreign);
		await assert.rejects(f.publish(base, request(base)), /changed concurrently/);
		assert.equal(readFileSync(f.paths.runtime, "utf8"), foreign);
		assert.equal(existsSync(f.backupDir), false);
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

	test("backup privacy/failure precedes writes and interrupted publication rolls back exactly while retaining/reusing its completed backup", async (t) => {
		const blocked = fixture(t);
		const blockedBase = await blocked.load(["cwd"]);
		fs.mkdirSync(blocked.backupDir, { mode: 0o755 });
		fs.chmodSync(blocked.backupDir, 0o755);
		await assert.rejects(blocked.publish(blockedBase, request(blockedBase)), /backup directory must be private/);
		unchanged(blocked);
		assert.deepEqual(readdirSync(blocked.backupDir), []);
		const f = fixture(t);
		const base = await f.load(["cwd"]);
		const next = request(base, { id: "interrupted-next", transitions: [{ scope: "cwd", patch: { tactics: { verified: true } } }] });
		const target = temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).patches;
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => { if (!injected && to === target) { injected = true; throw new Error("injected selected publication failure"); } rename(from, to); };
		syncBuiltinESMExports();
		try { await assert.rejects(f.publish(base, next), /injected selected publication failure/); }
		finally { fs.renameSync = rename; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		unchanged(f);
		assert.equal(readdirSync(f.backupDir).length, 1);
		const result = await f.publish(base, next);
		assert.ok(result.migrationBackup);
		assert.equal(readdirSync(f.backupDir).length, 1);
	});

	test("selected semantic v2 conversion composes with lifecycle migration without touching omitted owners", async (t) => {
		for (const version of [1, 2] as const) {
			const f = fixture(t, version);
			const paths = temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root);
			for (const path of [paths.checkpoint, paths.patches]) writeFileSync(path, readFileSync(path, "utf8").replace(/"strategy"\s*:/g, '"contract":').replace(/"tactics"\s*:/g, '"working":'));
			writeFileSync(paths.meta, JSON.stringify({ ...JSON.parse(readFileSync(paths.meta, "utf8")), version: 2 }));
			const base = await f.load(["cwd"]);
			const result = await f.publish(base, request(base));
			assert.ok(result.migrationBackup);
			const manifest = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
			assert.deepEqual(manifest.convertedScopes, ["cwd"]);
			assert.deepEqual(manifest.lifecycleConversion, version === 1 ? { sourceVersion: 1, targetVersion: 2 } : undefined);
			assert.deepEqual(result.cohort.view, base.view);
			assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).version, 3);
			assert.deepEqual(temporalScopeRevisions(result.cohort.view), temporalScopeRevisions(base.view));
			assert.equal(readFileSync(paths.checkpoint, "utf8").includes('"contract"'), false);
			assert.equal(readFileSync(paths.patches, "utf8").includes('"working"'), false);
			for (const scope of ["global", "session"] as const) {
				const omitted = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
				for (const path of [omitted.checkpoint, omitted.patches, omitted.meta]) assert.deepEqual(readFileSync(path), f.original.files.find((file) => file.path === path)!.bytes);
			}
			assertSelectedFileCohortBasis(result.cohort, await f.load(["cwd"]));
		}
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

{
	const fixture = legacyPublicationFixture.fixture;

	test("a session-only publication converts no omitted shared owner", (t) => {
		const f = fixture(t);
		const result = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], f.base, f.root, f.runtime);
		assert.ok(result.migrationBackup);
		const backup = JSON.parse(readFileSync(result.migrationBackup, "utf8"));
		assert.deepEqual(backup.convertedScopes, ["session"]);
		for (const scope of ["global", "cwd"] as const) {
			const paths = temporalScopePaths(f.cwd, f.sessionId, scope, f.root);
			for (const path of [paths.checkpoint, paths.patches, paths.meta]) {
				assert.deepEqual(readFileSync(path), Buffer.from(f.base.files.find((file) => file.path === path)!.bytes!));
				assert.equal(backup.updatedPaths.includes(relative(f.root, path)), false);
			}
		}
	});

	test("stale source CAS cannot create migration writes or backups", (t) => {
		const stale = fixture(t);
		const global = temporalScopePaths(stale.cwd, stale.sessionId, "global", stale.root);
		writeFileSync(global.checkpoint, `${readFileSync(global.checkpoint, "utf8")} `);
		const foreign = readFileSync(global.checkpoint);
		assert.throws(() => publishTemporalStateToFiles(stale.cwd, stale.sessionId, stale.view, ["global", "cwd", "session"], stale.base, stale.root, stale.runtime), /changed concurrently/);
		assert.deepEqual(readFileSync(global.checkpoint), foreign);
		assert.equal(existsSync(stale.backupDir), false);
	});
}
