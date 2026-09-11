import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { adoptFileStateToGit, captureTemporalGitBase, loadTemporalRevision, publishTemporalStateToGit } from "../lib/git.ts";
import { hashJson } from "../lib/json.ts";
import { createSessionRuntime, emptySnapshot, resolveSessionRuntime } from "../lib/snapshot.ts";
import { emptyState } from "../lib/state.ts";
import {
	captureTemporalFileBase, detectGitCapability, initializeFileStore, isFileRevision,
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
	const runtime = createSessionRuntime(snapshot, cwd, sessionId, view.lineage, "files");
	const base = captureTemporalFileBase(cwd, sessionId, root);
	return { parent, root, cwd, sessionId, snapshot, view, runtime, base };
}

function actualReference(cwd: string, sessionId: string, root: string): string {
	return `file:${hashJson({ root, files: captureTemporalFileBases(cwd, sessionId, root).map(({ path, identity }) => [relative(root, path), identity]) })}`;
}

test("capability absence is executable ENOENT only, not exit failure, permission failure, or timeout", (t) => {
	const { parent } = fixture(t);
	const path = process.env.PATH;
	process.env.PATH = parent;
	try { assert.equal(detectGitCapability(), "files"); }
	finally { process.env.PATH = path; }
	assert.equal(detectGitCapability(), "git");
	const spawn = childProcess.spawnSync;
	try {
		for (const code of [undefined, "EACCES", "ETIMEDOUT"]) {
			childProcess.spawnSync = (() => ({ status: code ? null : 128, stdout: "", stderr: "broken Git", error: code ? Object.assign(new Error(code), { code }) : undefined })) as unknown as typeof spawn;
			syncBuiltinESMExports();
			assert.throws(detectGitCapability, /Cannot resolve Git capability/);
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
});

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
			f.view = advanceTemporalState(f.view, [{ scope, patch: { working: { [scope]: n } } }], `T${n}`);
			f.snapshot.meta.step = n;
			f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files");
			publication = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [scope], publication.base, f.root, f.runtime);
			retained.push(readTemporalState(f.view));
			const restarted = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, publication.revision);
			assert.deepEqual(restarted.view, f.view);
			for (let offset = 0; offset < restarted.view.lineage.length; offset++) assert.deepEqual(readTemporalState(restarted.view, offset), retained.at(-1 - offset));
			for (const stream of Object.values(restarted.view.scopes)) assert.ok(stream.patches.length <= 7);
		}
		assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, firstReference), /unavailable/);
		f.view = advanceTemporalState(f.view, [{ scope: "session", patch: { response: "Final answer" } }], "terminal");
		f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files");
		publication = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], publication.base, f.root, f.runtime);
		assert.equal(readTemporalState(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, publication.revision).view).response, "Final answer");
		const noOp = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], publication.base, f.root, f.runtime);
		assert.equal(noOp.changed, false);
		assert.equal(noOp.revision, publication.revision);
		const semantics = publication.base.files.filter(({ path }) => path.endsWith("checkpoint.json") || path.endsWith("patches.jsonl"));
		f.snapshot.config.enabled = false;
		f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files");
		const stopped = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], publication.base, f.root, f.runtime);
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
	f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files", provenance.session);
	const first = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime, f.sessionId, provenance);
	const loaded = loadTemporalFileRevision(f.cwd, f.sessionId, f.root, first.revision);
	assert.deepEqual(loaded.provenance, provenance);
	const globalMeta = temporalScopePaths(f.cwd, f.sessionId, "global", f.root).meta;
	assert.deepEqual(JSON.parse(readFileSync(globalMeta, "utf8")), { version: 1, artifacts: provenance.global });
	assert.equal(existsSync(temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).meta), false);
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
	const original = readFileSync(paths.meta);
	writeFileSync(paths.meta, Buffer.concat([original, Buffer.from("\n")]));
	assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, p.revision), /unavailable/);
	for (const mutate of [
		(meta: any) => { meta.identity.sessionId = "foreign"; },
		(meta: any) => { meta.lineage = [{ id: "foreign", parent: null, position: 0 }]; },
		(meta: any) => { meta.publication = "unconfirmed"; },
		(meta: any) => { meta.temporalRevision = "a".repeat(40); },
	]) {
		const meta = JSON.parse(original.toString());
		mutate(meta);
		writeFileSync(paths.meta, JSON.stringify(meta));
		assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, actualReference(f.cwd, f.sessionId, f.root)), /identity|lineage|boundary|provenance|historical|origin|reachable/i);
	}
	assert.throws(() => resolveSessionRuntime(f.runtime, "a".repeat(40)), /Git publication provenance/);
});

test("file CAS rejects stale and foreign bases and omitted changes before writes", (t) => {
	const f = fixture(t);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, "foreign", f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime), /scope identity changed/);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["session"], f.base, f.root, f.runtime), /omitted a changed stream/);
	const p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], f.base, f.root, f.runtime), /changed concurrently/);
	const path = temporalScopePaths(f.cwd, f.sessionId, "global", f.root).patches;
	const concurrent = Buffer.from([0xff, 0xfe, 0x0a]);
	writeFileSync(path, concurrent);
	assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], p.base, f.root, f.runtime), /changed concurrently/);
	assert.deepEqual(readFileSync(path), concurrent);
});

test("file and Git publishers share worktree exclusion, and file recovery never steals locks", (t) => {
	const f = fixture(t);
	withStoragePublicationLock(f.root, () => {
		assert.throws(() => captureTemporalFileBase(f.cwd, f.sessionId, f.root), /publication lock/);
		assert.throws(() => captureTemporalGitBase(f.cwd, f.sessionId, f.root), /publication lock/);
		assert.throws(() => publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime), /publication lock/);
		assert.throws(() => loadTemporalFileRevision(f.cwd, f.sessionId, f.root, `file:${"a".repeat(64)}`), /publication lock/);
		assert.equal(existsSync(join(f.root, "checkpoint.json")), false);
	});
	assert.equal(existsSync(join(f.root, ".state-flow-publication.lock")), false);
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
	f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files");
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

test("file primitives work beside existing Git metadata but incomplete Git promotion fails closed", (t) => {
	const f = fixture(t);
	execFileSync("git", ["init", f.root], { stdio: "ignore" });
	const gitConfig = readFileSync(join(f.root, ".git", "config"));
	const p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], f.base, f.root, f.runtime);
	assert.deepEqual(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, p.revision).view, f.view);
	assert.deepEqual(readFileSync(join(f.root, ".git", "config")), gitConfig);
	const gitRuntime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage);
	assert.throws(() => publishTemporalStateToGit(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], captureTemporalGitBase(f.cwd, f.sessionId, f.root), f.root, gitRuntime), /full-cohort Git adoption/);
	assert.deepEqual(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, p.revision).view, f.view);
});

test("Git adoption captures full file cohorts over unborn or stale HEAD and rolls back failures without losing staging", (t) => {
	const identity = { GIT_AUTHOR_NAME: "State Flow Tests", GIT_AUTHOR_EMAIL: "state-flow@example.invalid", GIT_COMMITTER_NAME: "State Flow Tests", GIT_COMMITTER_EMAIL: "state-flow@example.invalid" };
	const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
	Object.assign(process.env, identity);
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
	for (const existingGit of [false, true]) {
		const f = fixture(t);
		const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
		let oldHead: string | undefined;
		if (existingGit) {
			execFileSync("git", ["init", f.root], { stdio: "ignore" });
			const initial = publishTemporalStateToGit(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], captureTemporalGitBase(f.cwd, f.sessionId, f.root), f.root,
				createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage));
			oldHead = initial.commit!;
		}
		let p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], captureTemporalFileBase(f.cwd, f.sessionId, f.root), f.root, f.runtime);
		for (let n = 1; n <= 8; n++) {
			f.view = advanceTemporalState(f.view, (["global", "cwd", "session"] as const).map((scope) => ({ scope, patch: { working: { [scope]: n } } })), `F${n}`);
			f.snapshot.meta.step = n;
			f.runtime = createSessionRuntime(f.snapshot, f.cwd, f.sessionId, f.view.lineage, "files");
			p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, ["global", "cwd", "session"], p.base, f.root, f.runtime);
		}
		// A valid differently formatted inherited stream must retain its exact bytes.
		const checkpoint = temporalScopePaths(f.cwd, f.sessionId, "cwd", f.root).checkpoint;
		writeFileSync(checkpoint, readFileSync(checkpoint, "utf8") + "\n");
		p = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], captureTemporalFileBase(f.cwd, f.sessionId, f.root), f.root, f.runtime);
		const expected = Array.from({ length: 8 }, (_, offset) => readTemporalState(f.view, offset));
		const scopeFiles = p.base.files.filter(({ path }) => path.endsWith("checkpoint.json") || path.endsWith("patches.jsonl"));
		writeFileSync(join(f.root, "notes.md"), "unrelated notes");
		let indexBefore: string | undefined;
		if (existingGit) {
			writeFileSync(join(f.root, "staged.txt"), "staged bytes");
			git("add", "staged.txt");
			writeFileSync(join(f.root, "staged.txt"), "unstaged bytes");
			indexBefore = git("diff", "--cached", "--binary");
		}
		process.env.GIT_AUTHOR_NAME = "";
		assert.throws(() => adoptFileStateToGit(f.cwd, f.sessionId, f.root, p.revision, f.snapshot), /Git command failed/);
		process.env.GIT_AUTHOR_NAME = identity.GIT_AUTHOR_NAME;
		assert.deepEqual(loadTemporalFileRevision(f.cwd, f.sessionId, f.root, p.revision).view, f.view);
		if (oldHead) assert.equal(git("rev-parse", "HEAD"), oldHead);
		else assert.throws(() => git("rev-parse", "--verify", "HEAD"));
		const adopted = adoptFileStateToGit(f.cwd, f.sessionId, f.root, p.revision, f.snapshot);
		assert.equal(adopted.push?.status, "local");
		assert.match(adopted.revision, /^[0-9a-f]{40}$/);
		assert.deepEqual(adopted.view, f.view);
		const cold = loadTemporalRevision(f.cwd, f.sessionId, f.root, adopted.revision);
		const restored = { scopes: cold.scopes as typeof f.view.scopes, lineage: cold.runtime!.document.meta.lineage };
		assert.deepEqual(Array.from({ length: 8 }, (_, offset) => readTemporalState(restored, offset)), expected);
		assert.equal(cold.runtime!.document.meta.step, 8);
		for (const file of scopeFiles) {
			assert.deepEqual(readFileSync(file.path), file.bytes);
			assert.deepEqual(execFileSync("git", ["-C", f.root, "show", `${adopted.revision}:${relative(f.root, file.path)}`]), file.bytes);
		}
		const tree = git("ls-tree", "-r", "--name-only", adopted.revision).split("\n");
		for (const file of scopeFiles) assert.ok(tree.includes(relative(f.root, file.path)));
		assert.ok(tree.includes("notes.md"));
		assert.equal(readFileSync(join(f.root, "notes.md"), "utf8"), "unrelated notes");
		assert.equal(git("status", "--porcelain=v1"), "");
		if (indexBefore !== undefined) {
			assert.ok(tree.includes("staged.txt"));
			assert.equal(git("show", `${adopted.revision}:staged.txt`), "unstaged bytes");
			assert.equal(readFileSync(join(f.root, "staged.txt"), "utf8"), "unstaged bytes");
		}
		assert.throws(() => adoptFileStateToGit(f.cwd, f.sessionId, f.root, p.revision, f.snapshot), /unavailable/);
		assert.equal(git("rev-parse", "HEAD"), adopted.revision);
		const filesAgain = publishTemporalStateToFiles(f.cwd, f.sessionId, f.view, [], captureTemporalFileBase(f.cwd, f.sessionId, f.root), f.root, f.runtime);
		const reused = adoptFileStateToGit(f.cwd, f.sessionId, f.root, filesAgain.revision, f.snapshot);
		assert.equal(reused.commit, undefined);
		assert.equal(reused.revision, adopted.revision);
		assert.equal(git("rev-parse", "HEAD"), adopted.revision);
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
