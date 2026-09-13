import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import fs, { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { inspectRuntimeRevision, TemporalRuntime } from "../lib/runtime.ts";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths, sessionPatchesPath, serializeScopeProvenance } from "../lib/durable.ts";
import { writeCwdState, writeGlobalState, writeSessionState } from "./legacy-fixture.ts";
import { createSessionRuntime, emptySnapshot, isFileRevision, parsePiCheckpoint, persistableSnapshot, type Snapshot } from "../lib/snapshot.ts";
import { withStoragePublicationLock } from "../lib/storage.ts";
import { captureTemporalGitBase, publishTemporalStateToGit } from "../lib/git.ts";
import { emptyState, type StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { readTemporalState, validateTemporalState } from "../lib/temporal.ts";
import { commitScopedTransition, stageAtomicScopePatches } from "../lib/transition.ts";
import { commitScopedTerminal, commitTerminal, harness, start } from "./harness.ts";
import { resolveCheckpoint } from "./temporal-fixture.ts";

test("runtime keeps native session storage identity paired and detached from caller mutation", () => {
	const address = { id: "session-id", key: "timestamp_session-id" };
	const runtime = new TemporalRuntime("/project", address, "/store");
	address.id = "mutated";
	address.key = "mutated";
	assert.equal(runtime.sessionId, "session-id");
	assert.equal(runtime.sessionKey, "timestamp_session-id");
});

test("fork copies only the selected session stream and provenance into a fresh owner over live shared scopes", (t) => {
	const f = driftFixture(t);
	const parent = restoreSessionA(f);
	const before = parent.runtime.states();
	const after = structuredClone(before);
	const provenance = Object.fromEntries((["global", "cwd", "session"] as const).map((scope) => {
		const path = `/sources/${scope}.md`;
		after[scope].artifacts[path] = { description: `${scope} routing` };
		return [scope, { [path]: { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "fixture-v1" } }];
	}));
	parent.snapshot.meta.specification = "Parent request, not a child run";
	parent.snapshot.meta.step++;
	parent.runtime.publish(parent.snapshot, true, createAcceptedTransition(before, after, "fork-artifacts"), { provenance });
	let selectedRevision = "";
	for (let index = 0; index < 5; index++) selectedRevision = publishScopedPatch(parent.runtime, parent.snapshot, "session", { counter: index }, `fork-seed-${index}`)!.commit!;
	const selected = structuredClone(parent.runtime.view!.scopes.session);
	assert.equal(selected.patches.length, 7);
	const sessionFiles = temporalScopePaths(f.cwd, "session-a", "session", f.root);
	const sourceBytes = [sessionFiles.checkpoint, sessionFiles.patches].map((path) => readFileSync(path));
	const child = new TemporalRuntime(f.cwd, "fork-child", f.root);
	const source = { id: "session-a", key: "session-a" };
	const prepared = child.prepareFork(source, selectedRevision);
	assert.equal(child.view, undefined);
	source.id = "caller-mutated";
	prepared.snapshot.config.enabled = false;
	prepared.snapshot.meta.step = 999;
	// Advance both shared streams, their provenance and the parent's private future after preparation.
	const live = parent.runtime.states();
	const future = structuredClone(live);
	for (const scope of ["global", "cwd", "session"] as const) future[scope].working.future = scope;
	parent.snapshot.meta.step++;
	parent.runtime.publish(parent.snapshot, true, createAcceptedTransition(live, future, "parent-future"), {
		provenance: { global: { "/sources/global.md": { sourceHash: `sha256:${"b".repeat(64)}`, compilerRevision: "fixture-v2" } }, cwd: { "/sources/cwd.md": { sourceHash: `sha256:${"b".repeat(64)}`, compilerRevision: "fixture-v2" } } },
	});
	// Forking must not even prune a valid but currently unreferenced shared provenance entry.
	const globalMeta = temporalScopePaths(f.cwd, "session-a", "global", f.root).meta;
	const registry = { ...parent.runtime.artifactProvenance("global"), "/sources/orphan.md": { sourceHash: `sha256:${"c".repeat(64)}`, compilerRevision: "fixture-v2" } };
	writeFileSync(globalMeta, serializeScopeProvenance(registry));
	execFileSync("git", ["-C", f.root, "add", "-A"]);
	execFileSync("git", ["-C", f.root, "commit", "-m", "fixture provenance"]);
	const protectedFiles = captureTemporalGitBase(f.cwd, "session-a", f.root).files;
	const fork = prepared.fork();
	assert.ok(fork.publication.commit);
	assert.equal(fork.snapshot.meta.durableBase, fork.publication.commit);
	assert.equal(fork.snapshot.config.enabled, true);
	assert.equal(fork.snapshot.meta.step, 0);
	assert.equal(fork.snapshot.meta.specification, undefined);
	assert.deepEqual(child.view!.scopes.session, selected);
	assert.deepEqual(child.artifactProvenance("session"), provenance.session);
	assert.deepEqual(child.artifactProvenance("global"), registry);
	assert.equal(child.artifactProvenance("cwd")["/sources/cwd.md"].compilerRevision, "fixture-v2");
	assert.equal(child.read().working.future, "cwd");
	assert.equal(child.read(0, "session").working.future, undefined);
	assert.deepEqual(captureTemporalGitBase(f.cwd, "session-a", f.root).files, protectedFiles);
	const copiedFiles = temporalScopePaths(f.cwd, child.sessionId, "session", f.root);
	assert.deepEqual([copiedFiles.checkpoint, copiedFiles.patches].map((path) => readFileSync(path)), sourceBytes);
	assert.equal(child.view!.lineage.length, 1);
	assert.equal(child.view!.lineage[0].parent, null);
	for (const scope of [undefined, "global", "cwd", "session"] as const) assert.throws(() => child.read(1, scope), /origin/);
	assert.throws(() => prepared.fork(), /already consumed/);
	const cold = new TemporalRuntime(f.cwd, child.sessionId, f.root);
	assert.equal(cold.restore(fork.publication.commit!).meta.step, 0);
	assert.deepEqual(cold.states(), child.states());
	assert.deepEqual(cold.view, child.view);
	const parentPrivate = [sessionFiles.checkpoint, sessionFiles.patches, sessionFiles.meta].map((path) => readFileSync(path));
	const accepted = publishScopedPatch(child, fork.snapshot, "session", { childOnly: true }, "child-first")!;
	assert.equal(child.read(1, "session").working.childOnly, undefined);
	assert.equal(child.read().working.childOnly, true);
	assert.equal(child.view!.lineage.length, 2);
	assert.deepEqual([sessionFiles.checkpoint, sessionFiles.patches, sessionFiles.meta].map((path) => readFileSync(path)), parentPrivate);
	cold.restore(accepted.commit!);
	assert.deepEqual(cold.states(), child.states());
});

test("fork copy rejects aliases, occupied targets and unavailable sources without installing state", (t) => {
	const f = driftFixture(t);
	const source = { id: "session-a", key: "session-a" };
	assert.throws(() => new TemporalRuntime(f.cwd, source, f.root).prepareFork(source, f.revision), /distinct/);
	assert.throws(() => new TemporalRuntime(f.cwd, { id: "other", key: source.key }, f.root).prepareFork(source, f.revision), /distinct/);
	const child = new TemporalRuntime(f.cwd, "fork-child", f.root);
	assert.throws(() => child.prepareFork(source, "f".repeat(40)), /readable Git commit/);
	assert.throws(() => child.prepareFork({ ...source, id: "wrong-owner" }, f.revision), /identity mismatch/);
	const prepared = child.prepareFork(source, f.revision);
	const occupant = new TemporalRuntime(f.cwd, child.sessionId, f.root);
	occupant.initialize(emptySnapshot(true), true);
	const before = captureTemporalGitBase(f.cwd, child.sessionId, f.root);
	assert.throws(() => prepared.fork(), /already has session storage/);
	assert.equal(child.view, undefined);
	assert.deepEqual(captureTemporalGitBase(f.cwd, child.sessionId, f.root), before);
	assert.throws(() => prepared.fork(), /already consumed/);
	// Missing worktree files do not make an occupied HEAD namespace new again.
	rmSync(temporalScopePaths(f.cwd, child.sessionId, "session", f.root).directory, { recursive: true });
	const missing = captureTemporalGitBase(f.cwd, child.sessionId, f.root);
	assert.throws(() => child.prepareFork({ id: "session-a", key: "session-a" }, f.revision).fork(), /already has session storage/);
	assert.deepEqual(captureTemporalGitBase(f.cwd, child.sessionId, f.root), missing);
});

test("fork copy rechecks CAS after its fresh basis and preserves a concurrent shared edit", (t) => {
	const f = driftFixture(t);
	const child = new TemporalRuntime(f.cwd, "fork-child", f.root);
	const prepared = child.prepareFork({ id: "session-a", key: "session-a" }, f.revision);
	const lock = join(f.root, ".git", "state-flow-publication.lock");
	const path = temporalScopePaths(f.cwd, "session-a", "global", f.root).checkpoint;
	const concurrent = `${readFileSync(path, "utf8")} `;
	const remove = fs.rmSync;
	let injected = false;
	const mock = t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
		remove(target, options);
		if (String(target) === lock && !injected) {
			injected = true;
			writeFileSync(path, concurrent);
		}
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => prepared.fork(), /changed concurrently/);
		assert.equal(injected, true);
		assert.equal(child.view, undefined);
		assert.equal(readFileSync(path, "utf8"), concurrent);
		assert.equal(existsSync(sessionRuntimePaths(f.cwd, child.sessionId, f.root).meta), false);
		assert.equal(execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), f.revision);
		assert.throws(() => prepared.fork(), /already consumed/);
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
	}
});

test("file-only fork copies its exact session cohort and rejects a source that expires after preparation", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "state-flow-file-fork-"));
	const path = process.env.PATH;
	process.env.PATH = directory;
	t.after(() => { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; rmSync(directory, { recursive: true, force: true }); });
	const root = join(directory, "store");
	const cwd = join(directory, "project");
	const parent = new TemporalRuntime(cwd, "file-parent", root);
	parent.prepare();
	const snapshot = emptySnapshot(true);
	parent.initialize(snapshot, true);
	const before = parent.states();
	const after = structuredClone(before);
	after.session.working.retained = true;
	after.session.artifacts["/private.md"] = { description: "Private file routing" };
	parent.publish(snapshot, true, createAcceptedTransition(before, after, "file-seed"), { provenance: { session: { "/private.md": { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "fixture-v1" } } } });
	snapshot.config.enabled = false;
	const stopped = parent.publish(snapshot)!;
	assert.ok(isFileRevision(stopped.revision));
	const source = { id: parent.sessionId, key: parent.sessionKey };
	const child = new TemporalRuntime(cwd, "file-child", root);
	const copied = child.prepareFork(source, stopped.revision!).fork();
	assert.ok(isFileRevision(copied.snapshot.meta.durableBase));
	assert.equal(copied.snapshot.config.enabled, false);
	assert.deepEqual(child.view!.scopes.session, parent.view!.scopes.session);
	assert.deepEqual(child.artifactProvenance("session"), parent.artifactProvenance("session"));
	assert.equal(existsSync(join(root, ".git")), false);
	const other = new TemporalRuntime(cwd, "file-other", root);
	const expired = other.prepareFork(source, stopped.revision!);
	publishScopedPatch(parent, snapshot, "session", { later: true }, "file-future");
	assert.throws(() => expired.fork(), /file revision is unavailable/);
	assert.equal(other.view, undefined);
	assert.equal(existsSync(sessionRuntimePaths(cwd, other.sessionId, root).meta), false);
	const cold = new TemporalRuntime(cwd, child.sessionId, root);
	cold.restore(copied.snapshot.meta.durableBase!);
	assert.deepEqual(cold.read(0, "session"), child.read(0, "session"));
	assert.equal(cold.read(0, "session").working.later, undefined);
});

test("prepared Git restore is read-only, detached, single-use, and acquires a fresh live publication basis", (t) => {
	const fixture = driftFixture(t);
	const seeded = seedGlobalArtifact(fixture);
	const runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	const prepared = runtime.prepareRestore(seeded.revision);
	const selected = structuredClone(prepared.snapshot);
	assert.equal(runtime.view, undefined);
	assert.equal(execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), seeded.revision);
	prepared.snapshot.config.enabled = false;
	prepared.snapshot.meta.step = 999;
	prepared.snapshot.meta.durableBase = "f".repeat(40);
	const peer = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	const peerSnapshot = peer.restore(seeded.revision);
	const later = publishScopedPatch(peer, peerSnapshot, "session", { later: true }, "same-session-later")!;
	const snapshot = prepared.restore();
	assert.equal(snapshot.config.enabled, selected.config.enabled);
	assert.equal(snapshot.meta.step, selected.meta.step);
	assert.equal(snapshot.meta.durableBase, seeded.revision);
	assert.equal(runtime.read().working.later, undefined);
	assert.equal(runtime.artifactProvenance("global")[seeded.path].sourceHash, `sha256:${"a".repeat(64)}`);
	assert.equal(execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), later.commit);
	// Same-session files advanced after inspection: a cached old publication basis would reject this.
	const accepted = publishScopedPatch(runtime, snapshot, "session", { resumed: true }, "prepared-resume")!;
	assert.ok(accepted.commit);
	assert.equal(runtime.read().working.resumed, true);
	assert.equal(runtime.read().working.later, undefined);
	assert.throws(() => prepared.restore(), /already consumed/);
	assert.equal(runtime.read().working.resumed, true);
});

test("prepared restore separates immutable validation from live exclusion and installs nothing after failure", (t) => {
	const fixture = driftFixture(t);
	const runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	withStoragePublicationLock(fixture.root, () => {
		assert.throws(() => runtime.prepareRestore("f".repeat(40)), /not a readable Git commit/);
		const prepared = runtime.prepareRestore(fixture.revision);
		assert.equal(prepared.snapshot.config.enabled, true);
		assert.equal(runtime.view, undefined);
		assert.throws(() => prepared.restore(), /publication lock/);
		assert.equal(runtime.view, undefined);
		assert.throws(() => prepared.restore(), /already consumed/);
	});
	assert.equal(runtime.prepareRestore(fixture.revision).restore().meta.durableBase, fixture.revision);
	assert.equal(runtime.read().working.sessionA, "retained");
});

test("runtime can retain an accepted local commit as a queue target without pushing", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "queued-runtime", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
	const initial = runtime.initialize(snapshot, true)!;
	snapshot.meta.durableBase = initial.commit;
	const remote = execFileSync("git", ["-C", h.repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
	const remoteBefore = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	const current = runtime.states();
	const next = { ...current, session: { ...current.session, response: "Queued locally" } };
	snapshot.meta.step++;
	const publication = runtime.publish(snapshot, true, createAcceptedTransition(current, next), { pushRemote: false })!;
	assert.ok(publication.commit);
	assert.equal(publication.push, undefined);
	assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(runtime.read().response, "Queued locally");
});

test("pointer round-trips preserve source-owned config, counters, and bootstrap state across runtime revisions", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "roundtrip", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
	const initial = runtime.initialize(snapshot, true)!;
	snapshot.meta.durableBase = initial.commit;
	const retained = [];
	for (const [index, step] of [0, 7, Number.MAX_SAFE_INTEGER].entries()) {
		snapshot.config = { enabled: index !== 1 };
		snapshot.meta.step = step;
		snapshot.meta.specification = `Specification ${index}`;
		snapshot.meta.bootstrap = index === 0;
		const result = runtime.publish(snapshot)!;
		snapshot.meta.durableBase = result.commit;
		const pointer = persistableSnapshot(snapshot);
		assert.deepEqual(pointer, { revision: result.commit });
		retained.push({ pointer, expected: structuredClone(snapshot) });
	}
	writeFileSync(join(h.repositoryRoot, "knowledge-only.md"), "Unrelated Knowledge revision\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", h.repositoryRoot, ...args], { encoding: "utf8" }).trim();
	git("add", "knowledge-only.md");
	git("commit", "-m", "unrelated fixture history");
	const head = git("rev-parse", "HEAD");
	const paths = sessionRuntimePaths(h.ctx.cwd, "roundtrip", h.repositoryRoot);
	const before = readFileSync(paths.meta);
	for (const { pointer, expected } of retained) {
		assert.deepEqual(resolveCheckpoint(pointer, h.ctx.cwd, "roundtrip", h.repositoryRoot), expected);
		const restored = new TemporalRuntime(h.ctx.cwd, "roundtrip", h.repositoryRoot).restore((pointer as { revision: string }).revision);
		delete restored.meta.pendingPublication;
		assert.deepEqual(restored, expected);
		assert.notEqual(restored.meta.durableBase, head);
	}
	const redirected = new TemporalRuntime(h.ctx.cwd, "roundtrip", h.repositoryRoot).prepareRestore(head);
	assert.equal(redirected.snapshot.meta.durableBase, retained.at(-1)!.expected.meta.durableBase);
	const normalized = redirected.restore();
	delete normalized.meta.pendingPublication;
	assert.deepEqual(normalized, retained.at(-1)!.expected);
	assert.equal(git("rev-parse", "HEAD"), head);
	assert.deepEqual(readFileSync(paths.meta), before);
});

test("live adapter writes only temporal pairs and runtime, and restores old branch stop without semantic writes", async () => {
	const h = harness();
	await start(h);
	const files = readdirSync(h.repositoryRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.parentPath.includes(".git")).map((entry) => relative(h.repositoryRoot, join(entry.parentPath, entry.name))).sort();
	assert.equal(files.length, 8);
	assert.equal(files.filter((name) => name.endsWith("checkpoint.json")).length, 3);
	assert.equal(files.some((name) => name.endsWith("state.json")), false);
	await commitTerminal(h, {}, { branch: "old" }, "Old");
	const oldEntries = structuredClone(h.entries);
	await commitTerminal(h, {}, { branch: "new" }, "New");
	const pair = temporalScopePaths(h.ctx.cwd, "harness-session", "session", h.repositoryRoot);
	const before = readFileSync(pair.patches);
	h.ctx.sessionManager.getBranch = () => oldEntries;
	h.handlers.get("session_tree")!({}, h.ctx);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.deepEqual(readFileSync(pair.patches), before);
	const stopped = h.entries.at(-1).data;
	const runtime = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
	assert.equal(runtime.restore(stopped.revision).config.enabled, false);
	assert.equal(runtime.read().working.branch, "old");
	assert.equal(runtime.read(1).working.branch, "old");
	assert.throws(() => runtime.read(8), /0 to 7/);
});

test("live initialization explicitly migrates a revision-linked predecessor session without replaying explanatory journals", () => {
	const h = harness();
	writeGlobalState(emptyState(), h.repositoryRoot);
	writeCwdState(h.ctx.cwd, emptyState(), h.repositoryRoot);
	writeSessionState(h.ctx.cwd, "harness-session", { ...emptyState(), working: { retained: "legacy" } }, h.repositoryRoot);
	writeFileSync(sessionPatchesPath(h.ctx.cwd, "harness-session", h.repositoryRoot), "old explanatory text, not replay JSON\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", h.repositoryRoot, ...args], { encoding: "utf8" }).trim();
	git("add", "."); // Temporary fixture contains only these predecessor files.
	git("commit", "-m", "legacy fixture");
	h.entries.push({ type: "custom", customType: "state-flow-snapshot", data: { config: { enabled: true, transitionWindow: 7 }, meta: { step: 3, durableBase: git("rev-parse", "HEAD") } } });
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.readState().working.retained, "legacy");
	assert.throws(() => h.readState(1), /predates the proven temporal origin/);
	assert.equal(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").some((path) => path.endsWith("state.json")), false);
});

test("failed restore installs no partial runtime and unavailable publication cannot accept transitions", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, {}, { value: "old" }, "Old");
	const revision = h.entries.at(-1).data.revision;
	const runtime = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const lock = join(h.repositoryRoot, ".git", "state-flow-publication.lock");
	writeFileSync(lock, "fixture\n");
	try {
		assert.throws(() => runtime.restore(revision), /publication lock/);
		assert.equal(runtime.view, undefined);
		assert.throws(() => runtime.publish(emptySnapshot(true), true), /publication is unavailable/);
		assert.throws(() => runtime.read(), /runtime is unavailable/);
	} finally {
		rmSync(lock);
	}
	assert.equal(runtime.restore(revision).meta.durableBase, revision);
	assert.equal(runtime.read().working.value, "old");
});

for (const legacy of [false, true]) test(`start retries the selected ${legacy ? "legacy" : "pointer"} branch after transient restore failure and the next terminal state is durable`, async () => {
	const h = harness();
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	await start(h);
	await commitTerminal(h, {}, { value: "old" }, "Old");
	const selectedBranch = structuredClone(h.entries);
	if (legacy) selectedBranch.at(-1).data = h.resolveSnapshot(selectedBranch.at(-1).data);
	await commitTerminal(h, {}, { value: "unselected future" }, "Future");
	h.ctx.sessionManager.getBranch = () => selectedBranch;
	const before = head();
	const lock = join(h.repositoryRoot, ".git", "state-flow-publication.lock");
	writeFileSync(lock, "fixture\n");
	try {
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), false);
		assert.throws(() => h.readState(), /runtime is unavailable/);
		assert.equal(h.notifications.some((message) => /previous valid snapshot/.test(message)), false);
		const count = h.entries.length;
		await assert.rejects(h.commands.get("state-flow-stop").handler("", h.ctx), /publication lock/);
		assert.equal(h.entries.length, count, "unavailable selected stop must not emit a successful checkpoint");
	} finally {
		rmSync(lock);
	}
	assert.equal(head(), before);
	await h.commands.get("state-flow-start").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.readState().working.value, "old");
	const resumedHead = head();
	await commitTerminal(h, {}, { value: "new" }, "New");
	assert.notEqual(head(), resumedHead);
	assert.equal(h.readState().working.value, "new");
	assert.equal(h.readState(1).working.value, "new");
	assert.equal(h.readState(2).working.value, "old");
	assert.equal(h.resolveSnapshot().meta.step, 4);
	assert.match(h.entries.at(-1).data.revision, /^[a-f0-9]{40}$/);
});

test("ordinary startup leaves global-only legacy storage and publication history untouched", () => {
	const h = harness();
	writeGlobalState({ ...emptyState(), working: { keep: "global legacy" } }, h.repositoryRoot);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	const path = join(h.repositoryRoot, "state.json");
	const original = readFileSync(path);
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(head(), before);
	assert.deepEqual(readFileSync(path), original);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.equal(h.entries.length, 0);
});

test("stopping an ordinary disabled session is harmless and does not initialize or publish storage", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.deepEqual(h.entries.at(-1).data, { disabled: true });
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(head(), before);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.throws(() => h.readState(), /runtime is unavailable/);
});

test("stop retries a failed branch restoration and remains disabled after resume without losing state", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, {}, { keep: "selected" }, "Selected");
	const lock = join(h.repositoryRoot, ".git", "state-flow-publication.lock");
	writeFileSync(lock, "fixture\n");
	try {
		h.handlers.get("session_tree")!({}, h.ctx);
		await assert.rejects(h.commands.get("state-flow-stop").handler("", h.ctx), /publication lock/);
		assert.equal(h.activeTools.includes("patch_state"), false);
		assert.throws(() => h.readState(), /runtime is unavailable/);
	} finally {
		rmSync(lock);
	}
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const checkpoint = h.entries.at(-1);
	assert.equal(h.resolveSnapshot(checkpoint.data).config.enabled, false);
	assert.equal(h.resolveSnapshot(checkpoint.data).meta.step, 2);
	assert.equal(h.readState().working.keep, "selected");
	const resumed = harness({ repositoryRoot: h.repositoryRoot, cwd: h.ctx.cwd });
	resumed.entries.push(checkpoint);
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.equal(resumed.readState().working.keep, "selected");
	assert.equal(resumed.readState(1).working.keep, "selected");
});

test("explicit start on a pre-runtime branch creates an empty session origin without losing later cold history", async () => {
	for (const marker of [false, true]) {
		const h = harness();
		h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		if (marker) await h.commands.get("state-flow-stop").handler("", h.ctx);
		const early = structuredClone(h.entries);
		await start(h);
		await commitTerminal(h, {}, { later: "private" }, "Later");
		const laterRevision = h.entries.at(-1).data.revision;
		h.entries.splice(0, h.entries.length, ...early);
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), false);
		await h.commands.get("state-flow-start").handler("", h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), true);
		assert.deepEqual(h.readState(0, "session"), emptyState());
		assert.equal(h.resolveSnapshot().meta.step, 0);
		assert.throws(() => h.readState(1), /predates the proven temporal origin/);
		const older = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
		older.restore(laterRevision);
		assert.equal(older.read().working.later, "private");
	}
});

test("stop cannot turn invalid-only recovery into permission to replace an existing session runtime", async () => {
	const owner = harness();
	await start(owner);
	await commitTerminal(owner, {}, { later: "private" }, "Later");
	const revision = owner.entries.at(-1).data.revision;
	const head = () => execFileSync("git", ["-C", owner.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	const paths = sessionRuntimePaths(owner.ctx.cwd, "harness-session", owner.repositoryRoot);
	const pair = temporalScopePaths(owner.ctx.cwd, "harness-session", "session", owner.repositoryRoot);
	const files = [paths.config, paths.meta, pair.checkpoint, pair.patches].map((path) => ({ path, bytes: readFileSync(path) }));
	for (const data of [{ config: null }, { revision: "f".repeat(40) }]) {
		const h = harness({ cwd: owner.ctx.cwd, repositoryRoot: owner.repositoryRoot });
		const invalid = { type: "custom", customType: "state-flow-snapshot", data };
		h.entries.push(invalid);
		// Stop as the first command must inspect branch evidence, not assume ordinary mode.
		await assert.rejects(h.commands.get("state-flow-stop").handler("", h.ctx), /unproven branch/);
		for (let attempt = 0; attempt < 2; attempt++) {
			await h.commands.get("state-flow-start").handler("", h.ctx);
			assert.equal(h.activeTools.includes("patch_state"), false);
			assert.match(h.notifications.at(-1)!, /Selected branch revision is unavailable/);
			await assert.rejects(h.commands.get("state-flow-stop").handler("", h.ctx), /unproven branch/);
			assert.deepEqual(h.entries, [invalid]);
			h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
		}
		assert.throws(() => h.readState(), /runtime is unavailable/);
		assert.equal(head(), before);
		for (const { path, bytes } of files) assert.deepEqual(readFileSync(path), bytes);
	}
	const retained = new TemporalRuntime(owner.ctx.cwd, "harness-session", owner.repositoryRoot);
	retained.restore(revision);
	assert.equal(retained.read().working.later, "private");
});

test("runtime causal basis rejects staged work after accepted history returns to identical values", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "causal-stage", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	const initial = runtime.states();
	const initialBasis = runtime.causalBasis();
	const originPosition = runtime.view!.lineage.at(-1)!.position;
	const stage = stageAtomicScopePatches(initial, { session: { working: { stale: true } } }, [], initialBasis);
	const changed = structuredClone(initial);
	changed.session.working.temporary = true;
	snapshot.meta.step = 1;
	runtime.publish(snapshot, true, createAcceptedTransition(initial, changed, "z-first"));
	snapshot.meta.step = 2;
	runtime.publish(snapshot, true, createAcceptedTransition(changed, initial, "a-second"));
	assert.deepEqual(runtime.states(), initial);
	assert.notEqual(runtime.causalBasis(), initialBasis);
	assert.throws(() => commitScopedTransition(snapshot, runtime.states(), stage, () => assert.fail("stale publication"), runtime.causalBasis()), /causal basis changed/);
	assert.deepEqual(runtime.recent().map(({ id, at }) => ({ id, at })), [{ id: "z-first", at: originPosition + 1 }, { id: "a-second", at: originPosition + 2 }]);
	const projected = runtime.recent();
	projected[0]!.transitions[0]!.patch.working!.temporary = "mutated";
	assert.equal(runtime.recent()[0]!.transitions[0]!.patch.working!.temporary, true);
	assert.equal(runtime.read(1).working.temporary, true);
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

test("a new session initializes Git over inherited file-only scopes and commits their actual bytes", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-new-session-adoption-"));
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const originalPath = process.env.PATH;
	const identity = { GIT_AUTHOR_NAME: "State Flow Tests", GIT_AUTHOR_EMAIL: "state-flow@example.invalid", GIT_COMMITTER_NAME: "State Flow Tests", GIT_COMMITTER_EMAIL: "state-flow@example.invalid" };
	const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
	t.after(() => {
		process.env.PATH = originalPath;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(parent, { recursive: true, force: true });
	});
	process.env.PATH = parent;
	const first = new TemporalRuntime(cwd, "file-session", root);
	first.prepare();
	const snapshot = emptySnapshot(true);
	first.initialize(snapshot, true);
	const before = first.states();
	const changed = structuredClone(before);
	changed.global.working.global = "inherited";
	changed.cwd.working.cwd = "inherited";
	changed.session.working.private = "not inherited";
	snapshot.meta.step = 1;
	first.publish(snapshot, true, createAcceptedTransition(before, changed, "file-change"));
	const inherited = (["global", "cwd"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(cwd, "file-session", scope, root);
		return [pair.checkpoint, pair.patches];
	});
	const bytes = inherited.map((path) => readFileSync(path));
	process.env.PATH = originalPath;
	Object.assign(process.env, identity);
	const next = new TemporalRuntime(cwd, "git-session", root);
	next.prepare();
	const published = next.initialize(emptySnapshot(true), true)!;
	const restored = new TemporalRuntime(cwd, "git-session", root);
	const resolved = restored.restore(published.commit!);
	assert.equal(resolved.meta.step, 0);
	assert.deepEqual(restored.read().working, { global: "inherited", cwd: "inherited" });
	assert.deepEqual(restored.read(0, "session"), emptyState());
	assert.throws(() => restored.read(1), /origin/);
	assert.deepEqual(inherited.map((path) => readFileSync(path)), bytes);
	for (const [index, path] of inherited.entries()) assert.deepEqual(execFileSync("git", ["-C", root, "show", `${published.commit}:${relative(root, path)}`]), bytes[index]);
});

test("enabled legacy Pi state restores into a missing file store without Git", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-legacy-no-git-"));
	const root = join(parent, "store");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; rmSync(parent, { recursive: true, force: true }); });
	const h = harness({ repositoryRoot: root, initializeRepository: false });
	h.entries.push({ type: "custom", customType: "state-flow-snapshot", data: {
		enabled: true, state: { contract: { legacy: true }, working: { preserved: true }, response: "Legacy" }, step: 2,
	} });
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.deepEqual(h.readState(), { artifacts: {}, contract: { legacy: true }, working: { preserved: true }, response: "Legacy" });
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.ok(isFileRevision(h.resolveSnapshot().meta.durableBase));
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(existsSync(join(root, ".git")), false);
});

test("file runtime starts without Git, retains locked pointers, resumes stopped state and refuses lost past", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-no-git-"));
	const root = join(parent, "store");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; rmSync(parent, { recursive: true, force: true }); });
	const options = { repositoryRoot: root, initializeRepository: false, cwd: join(parent, "project") };
	const h = harness(options);
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.equal(existsSync(root), false);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.deepEqual(h.entries.at(-1).data, { disabled: true });
	await start(h, "File lifecycle");
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(existsSync(join(root, ".git")), false);
	await commitTerminal(h, {}, { file: "first" }, "File answer");
	const first = structuredClone(h.entries);
	const pointer = h.entries.at(-1).data;
	assert.deepEqual(Object.keys(pointer), ["revision"]);
	assert.ok(isFileRevision(pointer.revision));
	const pendingRuntime = new TemporalRuntime(h.ctx.cwd, "harness-session", root);
	const pendingRestore = pendingRuntime.prepareRestore(pointer.revision);
	assert.equal(pendingRuntime.view, undefined);
	assert.deepEqual(parsePiCheckpoint(pointer), pointer);
	assert.equal(h.resolveSnapshot().meta.pendingPublication, undefined);
	assert.equal(h.readState().working.file, "first");
	assert.equal(h.readState(1).response, "");
	const step = h.resolveSnapshot().meta.step;
	await commitScopedTerminal(h, [], "File answer");
	assert.equal(h.resolveSnapshot().meta.step, step);
	withStoragePublicationLock(root, () => {
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), false);
		assert.throws(() => h.readState(), /unavailable/);
	});
	await h.commands.get("state-flow-start").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.readState().working.file, "first");
	await commitTerminal(h, {}, { file: "second" }, "Second answer");
	assert.throws(() => pendingRestore.restore(), /unavailable/);
	assert.equal(pendingRuntime.view, undefined, "An expired file cohort is never installed from a prepared read");
	const semanticFiles = (["global", "cwd", "session"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(h.ctx.cwd, "harness-session", scope, root);
		return [pair.checkpoint, pair.patches];
	});
	const before = semanticFiles.map((file) => readFileSync(file));
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const stopped = h.resolveSnapshot();
	assert.equal(stopped.config.enabled, false);
	assert.equal(stopped.meta.step, step + 2);
	assert.deepEqual(semanticFiles.map((file) => readFileSync(file)), before);
	const resumed = harness(options);
	resumed.entries.push(...structuredClone(h.entries));
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.resolveSnapshot().config.enabled, false);
	assert.equal(resumed.readState().working.file, "second");
	assert.equal(resumed.resolveSnapshot().meta.pendingPublication, undefined);
	const metaPath = sessionRuntimePaths(h.ctx.cwd, "harness-session", root).meta;
	const metaBefore = readFileSync(metaPath);
	// An older disabled marker cannot turn expired file history into a replacement origin.
	resumed.ctx.sessionManager.getBranch = () => first;
	resumed.handlers.get("session_tree")!({}, resumed.ctx);
	assert.throws(() => resumed.readState(), /unavailable/);
	await resumed.commands.get("state-flow-start").handler("", resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.deepEqual(readFileSync(metaPath), metaBefore);
	assert.deepEqual(semanticFiles.map((file) => readFileSync(file)), before);
	for (const revision of ["file:" + "A".repeat(64), "file:" + "a".repeat(63)]) assert.throws(() => parsePiCheckpoint({ revision }));
	assert.throws(() => parsePiCheckpoint({ ...pointer, enabled: true }));
});

// --- Shared-scope drift reconciliation ---

const driftIdentityKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;

/** A git-backed session A with one retained session layer; older revisions stay readable. */
function driftFixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-shared-drift-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const previous = Object.fromEntries(driftIdentityKeys.map((key) => [key, process.env[key]]));
	process.env.GIT_AUTHOR_NAME = "State Flow Tests";
	process.env.GIT_AUTHOR_EMAIL = "state-flow@example.invalid";
	process.env.GIT_COMMITTER_NAME = "State Flow Tests";
	process.env.GIT_COMMITTER_EMAIL = "state-flow@example.invalid";
	t.after(() => {
		for (const key of driftIdentityKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const runtime = new TemporalRuntime(cwd, "session-a", root);
	runtime.prepare();
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	const initial = runtime.states();
	const seeded = structuredClone(initial);
	seeded.session.working.sessionA = "retained";
	snapshot.meta.step = 1;
	const publication = runtime.publish(snapshot, true, createAcceptedTransition(initial, seeded, "a-seed"))!;
	return { parent, root, cwd, revision: publication.commit! };
}

/** A separate session inherits shared scopes, then advances one of them. */
function advanceShared(fixture: ReturnType<typeof driftFixture>, scope: "global" | "cwd", label: string): string {
	const runtime = new TemporalRuntime(fixture.cwd, `session-b-${label}`, fixture.root);
	runtime.prepare();
	runtime.initialize(emptySnapshot(true), true);
	const snapshot = emptySnapshot(true);
	const publication = publishScopedPatch(runtime, snapshot, scope, { [scope === "global" ? "globalAdvanced" : "cwdAdvanced"]: label }, `advance-${label}`)!;
	return publication.commit!;
}

function restoreSessionA(fixture: ReturnType<typeof driftFixture>): { runtime: TemporalRuntime; snapshot: Snapshot } {
	const runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	return { runtime, snapshot: runtime.restore(fixture.revision) };
}

function seedGlobalArtifact(fixture: ReturnType<typeof driftFixture>) {
	const selected = restoreSessionA(fixture);
	const before = selected.runtime.states();
	const after = structuredClone(before);
	const path = "/sources/shared.md";
	after.global.artifacts[path] = { description: "Shared routing" };
	selected.snapshot.meta.step += 1;
	const publication = selected.runtime.publish(
		selected.snapshot,
		true,
		createAcceptedTransition(before, after, "artifact-seed"),
		{ provenance: { global: { [path]: { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "artifact-v1" } } } },
	)!;
	return { path, revision: publication.commit!, snapshot: selected.snapshot };
}

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

for (const sameCwd of [true, false]) for (const point of ["before-ref", "after-ref"] as const) {
	test(`fatal publisher interruption preserves selected history and fails closed (${sameCwd ? "same" : "different"} CWD, ${point})`, { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
		const f = driftFixture(t);
		const survivor = restoreSessionA(f);
		let selected = f.revision;
		for (let step = 2; step <= 7; step++) selected = publishScopedPatch(survivor.runtime, survivor.snapshot, "session", { counter: step }, `survivor-${step}`)!.commit!;
		const scopes = [undefined, "global", "cwd", "session"] as const;
		const expected = Array.from({ length: 8 }, (_, offset) => scopes.map((scope) => survivor.runtime.read(offset, scope)));
		const selectedView = structuredClone(survivor.runtime.view!);
		const sessionDirectory = temporalScopePaths(f.cwd, "session-a", "session", f.root).directory;
		const privateFiles = () => captureTemporalFileBases(f.cwd, "session-a", f.root).filter(({ path }) => path.startsWith(`${sessionDirectory}/`));
		const privateBefore = privateFiles();
		const peerCwd = sameCwd ? f.cwd : join(f.parent, "other-project");
		const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./runtime-worker.ts", import.meta.url)), f.root, peerCwd, point], { detached: true, stdio: "pipe" });
		const closed = once(child, "close");
		void closed.catch(() => {});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
		child.stdin.on("error", () => {});
		const lines = createInterface({ input: child.stdout });
		const replies = lines[Symbol.asyncIterator]();
		let privateDirectory: string | undefined;
		t.after(async () => {
			if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
			await closed;
			lines.close();
			if (privateDirectory) rmSync(privateDirectory, { recursive: true, force: true });
			rmSync(f.parent, { recursive: true, force: true });
		});
		async function reply(event: string) {
			const next = await replies.next();
			if (next.done) await closed;
			assert.equal(next.done, false, stderr || `publisher exited before ${event}: ${child.signalCode ?? child.exitCode}`);
			const value = JSON.parse(next.value!);
			assert.equal(value.event, event);
			assert.equal(value.pid, child.pid);
			return value;
		}
		const ready = await reply("ready");
		assert.notEqual(ready.pid, process.pid);
		assert.match(ready.revision, /^[0-9a-f]{40,64}$/);
		const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
		assert.equal(git("rev-parse", "HEAD"), ready.revision);
		const acceptedPeer = inspectRuntimeRevision(peerCwd, "session-b-crash", f.root, ready.revision);
		for (const scope of ["global", "cwd", "session"] as const) assert.equal(readTemporalState(acceptedPeer.view, 0, scope).working.peer, "accepted");
		assert.deepEqual(privateFiles(), privateBefore);
		const restored = new TemporalRuntime(f.cwd, "session-a", f.root);
		const prepared = restored.prepareRestore(selected);
		assert.equal(prepared.snapshot.meta.durableBase, selected);
		const unrelated = join(f.root, "unrelated.txt");
		writeFileSync(unrelated, "staged caller bytes\n");
		git("add", "--", "unrelated.txt");
		writeFileSync(unrelated, "unstaged caller bytes\n");
		const callerIndex = readFileSync(join(f.root, ".git", "index"));
		child.stdin.write("G");
		const index = await reply("index");
		assert.equal(basename(index.privateIndex), "index");
		assert.equal(dirname(dirname(index.privateIndex)), resolve(tmpdir()));
		assert.ok(basename(dirname(index.privateIndex)).startsWith("state-flow-index-"));
		assert.equal(lstatSync(dirname(index.privateIndex)).isSymbolicLink(), false);
		privateDirectory = dirname(index.privateIndex);
		const paused = await reply("paused");
		assert.equal(paused.point, point);
		assert.equal(paused.privateIndex, index.privateIndex);
		assert.equal(paused.ref, git("symbolic-ref", "HEAD"));
		assert.equal(paused.previous, ready.revision);
		assert.match(paused.commit, /^[0-9a-f]{40,64}$/);
		const head = point === "before-ref" ? ready.revision : paused.commit;
		assert.equal(git("rev-parse", "HEAD"), head);
		git("merge-base", "--is-ancestor", ready.revision, paused.commit);
		assert.equal(git("show", `${paused.commit}:unrelated.txt`), "unstaged caller bytes");
		assert.deepEqual(readFileSync(join(f.root, ".git", "index")), callerIndex, "the interrupted private-index attempt cannot overwrite the caller index");
		const locks = [join(f.root, ".state-flow-publication.lock"), join(f.root, ".git", "state-flow-publication.lock")];
		for (const path of locks) assert.equal(readFileSync(path, "utf8"), `${child.pid}\n`);
		const files = () => [...captureTemporalFileBases(f.cwd, "session-a", f.root), ...captureTemporalFileBases(peerCwd, "session-b-crash", f.root)]
			.map((file) => ({ ...file, mode: lstatSync(file.path, { throwIfNoEntry: false })?.mode }));
		const interruptedFiles = files();
		assert.ok(interruptedFiles.some(({ content }) => content?.includes("unacknowledged")), "the fixture must reach actual owned-file publication");
		assert.throws(() => prepared.restore(), /publication lock is unavailable/);
		assert.equal(restored.view, undefined);
		assert.throws(() => prepared.restore(), /already consumed/);
		const before = survivor.runtime.states();
		const after = structuredClone(before);
		after.session.working.mustNotPublish = true;
		const candidate = structuredClone(survivor.snapshot);
		candidate.meta.step++;
		const transition = createAcceptedTransition(before, after, "blocked-survivor")!;
		assert.throws(() => survivor.runtime.publish(candidate, true, transition), /publication lock is unavailable/);
		process.kill(-child.pid!, "SIGKILL");
		const [code, signal] = await closed;
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
		for (const path of locks) assert.equal(readFileSync(path, "utf8"), `${child.pid}\n`, "fatal exit cannot silently release publication ownership");
		assert.throws(() => survivor.runtime.publish(candidate, true, transition), /publication lock is unavailable/);
		const retry = restored.prepareRestore(selected);
		assert.equal(retry.snapshot.meta.durableBase, selected);
		assert.throws(() => retry.restore(), /publication lock is unavailable/);
		assert.equal(restored.view, undefined);
		const cold = inspectRuntimeRevision(f.cwd, "session-a", f.root, selected);
		assert.deepEqual(cold.view, selectedView);
		for (let offset = 0; offset < 8; offset++) for (const [index, scope] of scopes.entries()) {
			assert.deepEqual(survivor.runtime.read(offset, scope), expected[offset]![index]);
			assert.deepEqual(readTemporalState(cold.view, offset, scope), expected[offset]![index]);
		}
		assert.deepEqual(inspectRuntimeRevision(peerCwd, "session-b-crash", f.root, ready.revision).view, acceptedPeer.view);
		const attempted = inspectRuntimeRevision(peerCwd, "session-b-crash", f.root, paused.commit);
		for (const scope of ["global", "cwd", "session"] as const) assert.equal(readTemporalState(attempted.view, 0, scope).working.peer, "unacknowledged");
		assert.deepEqual(files(), interruptedFiles, "blocked writers and cold inspection must preserve the interrupted files and modes");
		assert.deepEqual(privateFiles(), privateBefore, "the interrupted peer must not change another session's private files");
		assert.deepEqual(readFileSync(join(f.root, ".git", "index")), callerIndex);
		assert.equal(readFileSync(unrelated, "utf8"), "unstaged caller bytes\n");
		assert.equal(git("rev-parse", "HEAD"), head);
	});
}

function sharedBytes(root: string, cwd: string, scope: "global" | "cwd"): Buffer[] {
	const paths = temporalScopePaths(cwd, "session-a", scope, root);
	return [readFileSync(paths.checkpoint), readFileSync(paths.patches)];
}

test("a session patch adopts an advanced live global scope without rewinding shared history", (t) => {
	const fixture = driftFixture(t);
	const liveHead = advanceShared(fixture, "global", "one");
	const restored = restoreSessionA(fixture);
	const bytes = sharedBytes(fixture.root, fixture.cwd, "global");
	const publication = publishScopedPatch(restored.runtime, restored.snapshot, "session", { sessionPatch: "applied" }, "a-global-drift")!;
	assert.ok(publication.commit);
	validateTemporalState(restored.runtime.view!);
	const view = restored.runtime.view!;
	assert.equal(view.lineage.length, 2);
	assert.equal(view.lineage[0]!.parent, null);
	assert.equal(view.lineage[1]!.parent, view.lineage[0]!.id);
	assert.equal(restored.runtime.read().working.globalAdvanced, "one");
	assert.equal(restored.runtime.read().working.sessionA, "retained");
	assert.equal(restored.runtime.read().working.sessionPatch, "applied");
	assert.deepEqual(restored.runtime.read(0, "global"), restored.runtime.read(1, "global"));
	assert.deepEqual(restored.runtime.read(0, "cwd"), restored.runtime.read(1, "cwd"));
	assert.equal(restored.runtime.read(1, "session").working.sessionPatch, undefined);
	assert.deepEqual(restored.runtime.recent().map(({ id }) => id), ["a-global-drift"]);
	assert.throws(() => restored.runtime.read(2), /origin/);
	assert.deepEqual(sharedBytes(fixture.root, fixture.cwd, "global"), bytes);
	for (const revision of [fixture.revision, liveHead]) {
		assert.doesNotThrow(() => execFileSync("git", ["-C", fixture.root, "cat-file", "-e", revision], { stdio: "ignore" }));
	}
});

test("a session patch adopts an advanced live CWD scope", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "cwd", "one");
	const restored = restoreSessionA(fixture);
	const bytes = sharedBytes(fixture.root, fixture.cwd, "cwd");
	const publication = publishScopedPatch(restored.runtime, restored.snapshot, "session", { sessionPatch: "applied" }, "a-cwd-drift")!;
	assert.ok(publication.commit);
	assert.equal(restored.runtime.read().working.cwdAdvanced, "one");
	assert.equal(restored.runtime.read().working.sessionA, "retained");
	assert.equal(restored.runtime.read().working.sessionPatch, "applied");
	assert.deepEqual(sharedBytes(fixture.root, fixture.cwd, "cwd"), bytes);
});

test("a session patch adopts both advanced shared scopes at one proven origin", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "global", "one");
	advanceShared(fixture, "cwd", "two");
	const restored = restoreSessionA(fixture);
	const publication = publishScopedPatch(restored.runtime, restored.snapshot, "session", { sessionPatch: "applied" }, "a-both-drift")!;
	assert.ok(publication.commit);
	validateTemporalState(restored.runtime.view!);
	assert.equal(restored.runtime.read().working.globalAdvanced, "one");
	assert.equal(restored.runtime.read().working.cwdAdvanced, "two");
	assert.equal(restored.runtime.read().working.sessionPatch, "applied");
	assert.deepEqual(restored.runtime.recent().map(({ id }) => id), ["a-both-drift"]);
});

test("file-backed publication reconciles an untouched shared scope advanced by another session", (t) => {
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
	const publication = publishScopedPatch(a, snapshot, "session", { sessionPatch: "applied" }, "a-file-drift")!;
	assert.ok(publication.revision);
	validateTemporalState(a.view!);
	assert.equal(a.read().working.globalAdvanced, "file");
	assert.equal(a.read().working.sessionA, "retained");
	assert.equal(a.read().working.sessionPatch, "applied");
});

test("a CWD patch adopts an advanced global scope while requiring its own basis", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "global", "one");
	const restored = restoreSessionA(fixture);
	const publication = publishScopedPatch(restored.runtime, restored.snapshot, "cwd", { cwdPatch: "applied" }, "a-cwd-patch")!;
	assert.ok(publication.commit);
	validateTemporalState(restored.runtime.view!);
	assert.equal(restored.runtime.read().working.globalAdvanced, "one");
	assert.equal(restored.runtime.read().working.cwdPatch, "applied");
	assert.equal(restored.runtime.read().working.sessionA, "retained");
});

test("a CWD patch fails precisely when the live CWD state advanced", (t) => {
	const fixture = driftFixture(t);
	const liveHead = advanceShared(fixture, "cwd", "one");
	const restored = restoreSessionA(fixture);
	const before = restored.runtime.states();
	const after = structuredClone(before);
	after.cwd.working.cwdPatch = "rejected";
	restored.snapshot.meta.step += 1;
	assert.throws(
		() => restored.runtime.publish(restored.snapshot, true, createAcceptedTransition(before, after, "a-cwd-conflict")),
		/cannot publish the CWD patch because the live CWD state advanced after this transition's selected basis/,
	);
	assert.equal(execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), liveHead);
});

test("a global patch adopts an advanced CWD scope while requiring its own basis", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "cwd", "one");
	const restored = restoreSessionA(fixture);
	const publication = publishScopedPatch(restored.runtime, restored.snapshot, "global", { globalPatch: "applied" }, "a-global-patch")!;
	assert.ok(publication.commit);
	validateTemporalState(restored.runtime.view!);
	assert.equal(restored.runtime.read().working.cwdAdvanced, "one");
	assert.equal(restored.runtime.read().working.globalPatch, "applied");
	assert.equal(restored.runtime.read().working.sessionA, "retained");
});

test("a global patch fails precisely when the live global state advanced", (t) => {
	const fixture = driftFixture(t);
	const liveHead = advanceShared(fixture, "global", "one");
	const restored = restoreSessionA(fixture);
	const before = restored.runtime.states();
	const after = structuredClone(before);
	after.global.working.globalPatch = "rejected";
	restored.snapshot.meta.step += 1;
	assert.throws(
		() => restored.runtime.publish(restored.snapshot, true, createAcceptedTransition(before, after, "a-global-conflict")),
		/cannot publish the global patch because the live global state advanced after this transition's selected basis/,
	);
	assert.equal(execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), liveHead);
});

for (const resumeAfterAdvance of [false, true]) test(`runtime-only Stop preserves live shared provenance and selected cold evidence (${resumeAfterAdvance ? "resumed" : "running"} session)`, (t) => {
	const fixture = driftFixture(t);
	let { runtime, snapshot } = restoreSessionA(fixture);
	const scopes: StateScope[] = ["global", "cwd", "session"];
	const beforeSeed = runtime.states();
	const seeded = structuredClone(beforeSeed);
	const provenance: Record<StateScope, ArtifactProvenanceRegistry> = { global: {}, cwd: {}, session: {} };
	for (const scope of scopes) {
		const path = `/sources/${scope}.md`;
		seeded[scope].artifacts[path] = { description: `${scope} at selected revision` };
		provenance[scope][path] = { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "artifact-v1" };
	}
	snapshot.meta.step += 1;
	const selected = runtime.publish(snapshot, true, createAcceptedTransition(beforeSeed, seeded), { pushRemote: false, provenance })!.commit!;
	const selectedLineage = structuredClone(runtime.view!.lineage);
	const selectedStep = snapshot.meta.step;
	// The child publishes after A has selected its state, without sharing an in-process cache.
	const childSource = `
		import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
		import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
		import { createAcceptedTransition } from ${JSON.stringify(new URL("../lib/history.ts", import.meta.url).href)};
		const [root, cwd] = process.argv.slice(1);
		const runtime = new TemporalRuntime(cwd, "session-b-provenance", root);
		const snapshot = emptySnapshot(true);
		snapshot.meta.remotePublication = { version: 1, mode: "off" };
		runtime.initialize(snapshot, true);
		const before = runtime.states();
		const after = structuredClone(before);
		const provenance = { global: {}, cwd: {} };
		for (const scope of ["global", "cwd"]) for (const suffix of ["", "-added"]) {
			const path = "/sources/" + scope + suffix + ".md";
			after[scope].artifacts[path] = { description: scope + suffix + " from independent publisher" };
			provenance[scope][path] = { sourceHash: "sha256:" + "b".repeat(64), compilerRevision: "artifact-v2" };
		}
		snapshot.meta.step += 1;
		const result = runtime.publish(snapshot, true, createAcceptedTransition(before, after), { pushRemote: false, provenance });
		console.log(JSON.stringify({ pid: process.pid, revision: result.commit }));
	`;
	const child = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource, fixture.root, fixture.cwd], { encoding: "utf8", timeout: 30_000 }));
	assert.notEqual(child.pid, process.pid);
	assert.match(child.revision, /^[0-9a-f]{40,64}$/);
	if (resumeAfterAdvance) {
		runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
		snapshot = runtime.restore(selected);
	}
	const sharedPaths = (["global", "cwd"] as const).flatMap((scope) => {
		const paths = temporalScopePaths(fixture.cwd, "session-a", scope, fixture.root);
		return [paths.checkpoint, paths.patches, paths.meta];
	});
	const sharedBefore = sharedPaths.map((path) => readFileSync(path));
	snapshot.config.enabled = false;
	const stopped = runtime.publish(snapshot)!.commit!;
	assert.deepEqual(sharedPaths.map((path) => readFileSync(path)), sharedBefore, "Stop must not rewind another publisher's semantic files or provenance");
	const paths = sessionRuntimePaths(fixture.cwd, "session-a", fixture.root);
	const changed = execFileSync("git", ["-C", fixture.root, "diff-tree", "--no-commit-id", "--name-only", "-r", stopped], { encoding: "utf8" }).trim().split("\n").sort();
	assert.deepEqual(changed, [paths.config, paths.meta].map((path) => relative(fixture.root, path).replaceAll("\\", "/")).sort());
	const restored = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	const stoppedSnapshot = restored.restore(stopped);
	assert.equal(stoppedSnapshot.config.enabled, false);
	assert.equal(stoppedSnapshot.meta.step, selectedStep);
	assert.deepEqual(restored.states(), seeded);
	assert.deepEqual(restored.view!.lineage, selectedLineage);
	for (const scope of scopes) assert.deepEqual(restored.artifactProvenance(scope), provenance[scope], "cold provenance must belong to the same selected scopes, not the live stop commit");
	const peer = new TemporalRuntime(fixture.cwd, "session-b-provenance", fixture.root);
	peer.restore(child.revision);
	for (const scope of ["global", "cwd"] as const) {
		assert.equal(peer.artifactProvenance(scope)[`/sources/${scope}.md`]!.sourceHash, `sha256:${"b".repeat(64)}`);
		assert.ok(peer.read(0, scope).artifacts[`/sources/${scope}-added.md`]);
	}
});

test("a provenance-only write adopts drift in an untouched shared scope", (t) => {
	const fixture = driftFixture(t);
	const seeded = seedGlobalArtifact(fixture);
	advanceShared(fixture, "cwd", "provenance-untouched");
	const runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	const snapshot = runtime.restore(seeded.revision);
	const publication = runtime.publish(snapshot, false, undefined, { provenance: { global: {
		[seeded.path]: { sourceHash: `sha256:${"b".repeat(64)}`, compilerRevision: "artifact-v1" },
	} } })!;
	assert.ok(publication.commit);
	assert.equal(runtime.read().working.cwdAdvanced, "provenance-untouched");
	assert.equal(runtime.artifactProvenance("global")[seeded.path]!.sourceHash, `sha256:${"b".repeat(64)}`);
});

test("a provenance-only write fails when its shared target advanced", (t) => {
	const fixture = driftFixture(t);
	const seeded = seedGlobalArtifact(fixture);
	advanceShared(fixture, "global", "provenance-target");
	const runtime = new TemporalRuntime(fixture.cwd, "session-a", fixture.root);
	const snapshot = runtime.restore(seeded.revision);
	assert.throws(
		() => runtime.publish(snapshot, false, undefined, { provenance: { global: {
			[seeded.path]: { sourceHash: `sha256:${"b".repeat(64)}`, compilerRevision: "artifact-v1" },
		} } }),
		/cannot publish the global patch because the live global state advanced/,
	);
});

test("a multi-scope transition names every shared target that advanced", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "global", "one");
	advanceShared(fixture, "cwd", "two");
	const restored = restoreSessionA(fixture);
	const before = restored.runtime.states();
	const after = structuredClone(before);
	after.global.working.globalPatch = "rejected";
	after.cwd.working.cwdPatch = "rejected";
	restored.snapshot.meta.step += 1;
	assert.throws(
		() => restored.runtime.publish(restored.snapshot, true, createAcceptedTransition(before, after, "a-both-conflict")),
		/cannot publish the global and CWD patches because the live global and CWD states advanced/,
	);
});

test("a multi-scope transition adopts an untouched shared scope and still writes its targets", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "global", "one");
	const restored = restoreSessionA(fixture);
	const before = restored.runtime.states();
	const after = structuredClone(before);
	after.cwd.working.cwdPatch = "applied";
	after.session.working.sessionPatch = "applied";
	restored.snapshot.meta.step += 1;
	const publication = restored.runtime.publish(restored.snapshot, true, createAcceptedTransition(before, after, "a-multi"))!;
	assert.ok(publication.commit);
	validateTemporalState(restored.runtime.view!);
	assert.equal(restored.runtime.read().working.globalAdvanced, "one");
	assert.equal(restored.runtime.read().working.cwdPatch, "applied");
	assert.equal(restored.runtime.read().working.sessionPatch, "applied");
});

test("publication CAS still rejects a target advance after a reconciliation capture", (t) => {
	const fixture = driftFixture(t);
	advanceShared(fixture, "global", "one");
	const restored = restoreSessionA(fixture);
	const first = publishScopedPatch(restored.runtime, restored.snapshot, "session", { sessionPatch: "first" }, "a-first")!;
	assert.ok(first.commit);
	const stale = captureTemporalGitBase(fixture.cwd, "session-a", fixture.root);
	advanceShared(fixture, "cwd", "second");
	restored.snapshot.meta.step += 1;
	assert.throws(
		() => publishTemporalStateToGit(
			fixture.cwd,
			"session-a",
			restored.runtime.view!,
			["session"],
			stale,
			fixture.root,
			createSessionRuntime(restored.snapshot, fixture.cwd, "session-a", restored.runtime.view!.lineage),
			"session-a",
		),
		/changed concurrently/,
	);
});
