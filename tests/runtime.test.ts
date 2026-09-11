import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TemporalRuntime } from "../lib/runtime.ts";
import { sessionRuntimePaths, temporalScopePaths, sessionPatchesPath } from "../lib/durable.ts";
import { writeCwdState, writeGlobalState, writeSessionState } from "./legacy-fixture.ts";
import { createSessionRuntime, emptySnapshot, isFileRevision, parsePiCheckpoint, persistableSnapshot, type Snapshot } from "../lib/snapshot.ts";
import { withStoragePublicationLock } from "../lib/storage.ts";
import { captureTemporalGitBase, publishTemporalStateToGit } from "../lib/git.ts";
import { emptyState, type StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { validateTemporalState } from "../lib/temporal.ts";
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
