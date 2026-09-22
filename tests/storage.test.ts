import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { hashJson } from "../lib/json.ts";
import { createSessionRuntime, emptySnapshot } from "../lib/snapshot.ts";
import { emptyState } from "../lib/state.ts";
import {
	captureTemporalFileBase, initializeFileStore, isFileRevision,
	loadTemporalFileRevision, publishTemporalStateToFiles, withStoragePublicationLock,
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
		version: 1, artifacts: provenance.global,
		temporal: { checkpoint: f.view.scopes.global.checkpoint.through, patches: f.view.scopes.global.patches.map((record) => record.transition) },
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
