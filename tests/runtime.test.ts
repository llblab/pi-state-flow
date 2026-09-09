import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TemporalRuntime } from "../lib/runtime.ts";
import { sessionRuntimePaths, temporalScopePaths, sessionPatchesPath } from "../lib/durable.ts";
import { writeCwdState, writeGlobalState, writeSessionState } from "./legacy-fixture.ts";
import { emptySnapshot, isFileRevision, parsePiCheckpoint, persistableSnapshot } from "../lib/snapshot.ts";
import { withStoragePublicationLock } from "../lib/storage.ts";
import { emptyState } from "../lib/state.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { commitScopedTransition, stageScopedPatch } from "../lib/transition.ts";
import { commitTerminal, harness, start } from "./harness.ts";
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

test("pointer round-trips preserve source-owned config, counters, bootstrap and retry state across runtime revisions", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "roundtrip", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
	const initial = runtime.initialize(snapshot, true)!;
	snapshot.meta.durableBase = initial.commit;
	const retained = [];
	for (const [index, step] of [0, 7, Number.MAX_SAFE_INTEGER].entries()) {
		snapshot.config = { enabled: index !== 1, transitionWindow: index };
		snapshot.meta.step = step;
		snapshot.meta.specification = `Specification ${index}`;
		snapshot.meta.bootstrap = index === 0;
		snapshot.meta.validation = { attempt: index + 1, error: `Error ${index}`, instruction: `Retry ${index}` };
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
	commitTerminal(h, {}, { branch: "old" }, "Old");
	const oldEntries = structuredClone(h.entries);
	commitTerminal(h, {}, { branch: "new" }, "New");
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
	assert.equal(runtime.read(1).working.branch, undefined);
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
	commitTerminal(h, {}, { value: "old" }, "Old");
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
	commitTerminal(h, {}, { value: "old" }, "Old");
	const selectedBranch = structuredClone(h.entries);
	if (legacy) selectedBranch.at(-1).data = h.resolveSnapshot(selectedBranch.at(-1).data);
	commitTerminal(h, {}, { value: "unselected future" }, "Future");
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
	commitTerminal(h, {}, { value: "new" }, "New");
	assert.notEqual(head(), resumedHead);
	assert.equal(h.readState().working.value, "new");
	assert.equal(h.readState(1).working.value, "old");
	assert.equal(h.resolveSnapshot().meta.step, 2);
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
	commitTerminal(h, {}, { keep: "selected" }, "Selected");
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
	assert.equal(h.resolveSnapshot(checkpoint.data).meta.step, 1);
	assert.equal(h.readState().working.keep, "selected");
	const resumed = harness({ repositoryRoot: h.repositoryRoot, cwd: h.ctx.cwd });
	resumed.entries.push(checkpoint);
	resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
	assert.equal(resumed.activeTools.includes("patch_state"), false);
	assert.equal(resumed.readState().working.keep, "selected");
	assert.equal(resumed.readState(1).working.keep, undefined);
});

test("explicit start on a pre-runtime branch creates an empty session origin without losing later cold history", async () => {
	for (const marker of [false, true]) {
		const h = harness();
		h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
		if (marker) await h.commands.get("state-flow-stop").handler("", h.ctx);
		const early = structuredClone(h.entries);
		await start(h);
		commitTerminal(h, {}, { later: "private" }, "Later");
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
	commitTerminal(owner, {}, { later: "private" }, "Later");
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
	const stage = stageScopedPatch(initial, { scope: "session", patch: { working: { stale: true } } }, [], initialBasis);
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
	commitTerminal(h, {}, { file: "first" }, "File answer");
	const first = structuredClone(h.entries);
	const pointer = h.entries.at(-1).data;
	assert.deepEqual(Object.keys(pointer), ["revision"]);
	assert.ok(isFileRevision(pointer.revision));
	assert.deepEqual(parsePiCheckpoint(pointer), pointer);
	assert.equal(h.resolveSnapshot().meta.pendingPublication, undefined);
	assert.equal(h.readState().working.file, "first");
	assert.equal(h.readState(1).response, "");
	const step = h.resolveSnapshot().meta.step;
	commitTerminal(h, {}, { file: "first" }, "File answer");
	assert.equal(h.resolveSnapshot().meta.step, step);
	withStoragePublicationLock(root, () => {
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.activeTools.includes("patch_state"), false);
		assert.throws(() => h.readState(), /unavailable/);
	});
	await h.commands.get("state-flow-start").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.equal(h.readState().working.file, "first");
	commitTerminal(h, {}, { file: "second" }, "Second answer");
	const semanticFiles = (["global", "cwd", "session"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(h.ctx.cwd, "harness-session", scope, root);
		return [pair.checkpoint, pair.patches];
	});
	const before = semanticFiles.map((file) => readFileSync(file));
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	const stopped = h.resolveSnapshot();
	assert.equal(stopped.config.enabled, false);
	assert.equal(stopped.meta.step, step + 1);
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
