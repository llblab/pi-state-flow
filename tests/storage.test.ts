import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { hashJson } from "../lib/json.ts";
import { createSessionRuntime, emptySnapshot, RevisionUnavailableError } from "../lib/snapshot.ts";
import { emptyState } from "../lib/state.ts";
import {
	captureTemporalFileBase, initializeFileStore, isFileRevision,
	loadTemporalFileRevision, PublicationBusyError, publishTemporalStateToFiles, withStoragePublicationLock, withStorageTransaction, type StorageTransaction,
} from "../lib/storage.ts";
import { advanceTemporalState, createTemporalState, readTemporalState } from "../lib/temporal.ts";

function fixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-files-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store");
	initializeFileStore(root);
	const cwd = join(parent, "project");
	const sessionId = "file-session";
	const snapshot = emptySnapshot(true);
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
				working: { [scope]: n },
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
		f.snapshot.config.enabled = false;
		f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
		const stopped = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], publication.base, f.root, f.runtime, f.sessionId, undefined, true);
		const restored = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, stopped.revision);
		assert.equal(restored.runtime.config.enabled, false);
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
		version: 2, artifacts: provenance.global,
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

	const stale = advanceTemporalState(f.view, [{ scope: "session", patch: { working: { hot: "stale" }, lazy: { owner: "stale" } } }], "lazy-stale");
	const staleRuntime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, stale.lineage);
	assert.throws(
		() => publishTemporalStateToFiles(f.cwd, f.sessionId, stale, ["session"], initialized.base, f.root, staleRuntime),
		/changed concurrently/,
	);
	const retained = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, actualReference(f.cwd, f.sessionId, f.root)).view;
	assert.deepEqual(readTemporalState(retained, 0, "session").lazy, { owner: "peer" });
	assert.equal(readTemporalState(retained, 0, "session").working.hot, undefined);
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
		scope, patch: { working: { cohort: "foreign" } },
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
	for (const scope of ["global", "cwd", "session"] as const) assert.equal(readTemporalState(loaded.view, 0, scope).working.cohort, "foreign");
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
	const next = advanceTemporalState(f.view, [{ scope: "session", patch: { working: { accepted: true } } }], "next");
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
	f.view.scopes.session.checkpoint.state.working.raw = "\ufffd";
	const first = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	const paths = temporalScopePaths(f.cwd, f.sessionId, "session", f.root);
	const source = readFileSync(paths.checkpoint, "utf8");
	const opaque = Buffer.concat([Buffer.from(source.split("\ufffd")[0]!), Buffer.from([0xff]), Buffer.from(source.split("\ufffd")[1]!)]);
	writeFileSync(paths.checkpoint, opaque);
	const base = captureTemporalFileBase(f.cwd, f.sessionId, f.root);
	f.view = advanceTemporalState(f.view, [{ scope: "session", patch: { response: "New" } }], "T1");
	f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		if (!injected && to === paths.patches) { injected = true; throw new Error("injected rename failure"); }
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], base, f.root, f.runtime), /injected rename failure/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(injected, true);
	assert.deepEqual(readFileSync(paths.checkpoint), opaque);
	assert.deepEqual(readFileSync(paths.patches), first.base.files.find(({ path }) => path === paths.patches)!.bytes);
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
