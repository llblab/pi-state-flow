import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	cwdPatchesPath,
	cwdStatePath,
	durablePaths,
	loadScopeStream,
	temporalScopePaths,
	sessionRuntimePaths,
	sessionPatchesPath,
	sessionStatePath,
	parseScopeStream,
	temporalStateFileUpdates,
	writeOwnedFileUpdates,
} from "../lib/durable.ts";
import {
	captureTemporalGitBase,
	loadTemporalRevision,
	publishTemporalStateToGit,
	migrateLegacyStorageToGit,
	pushGitCommit,
	initializeGitRepository,
} from "../lib/git.ts";
import { writeCwdState, writeGlobalState, writeSessionState } from "./legacy-fixture.ts";
import { emptyState, type ScopedStates } from "../lib/state.ts";
import { advanceTemporalState, createTemporalState, readTemporalState, type TemporalState } from "../lib/temporal.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import type { RecentScopePatch } from "../lib/history.ts";
import { createSessionRuntime, emptySnapshot, resolveSessionRuntime } from "../lib/snapshot.ts";
import { harness, scopedTerminalComment, start } from "./harness.ts";

function run(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function fixture(t: TestContext, temporal = false): { repository: string; remote: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "state-flow-git-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repository = join(root, "repository");
	const remote = join(root, "remote.git");
	execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
	run(repository, "config", "user.name", "State Flow Tests");
	run(repository, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(repository, "README.md"), "fixture\n");
	run(repository, "add", "README.md");
	run(repository, "commit", "-m", "fixture");
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	run(repository, "remote", "add", "origin", remote);
	run(repository, "push", "-u", "origin", "main");
	const cwd = join(root, "project");
	if (!temporal) writeCwdState(cwd, emptyState(), repository);
	return { repository, remote, cwd };
}

test("explicit repository initialization rejects unsafe roots and supports real worktrees", (t) => {
	const { repository } = fixture(t, true);
	const nested = join(repository, "dedicated");
	const head = run(repository, "rev-parse", "HEAD");
	fs.mkdirSync(nested);
	assert.throws(() => captureTemporalGitBase(repository, "session", nested), /root mismatch/);
	initializeGitRepository(nested);
	assert.throws(() => run(nested, "rev-parse", "--verify", "HEAD"));
	assert.throws(() => run(nested, "config", "--local", "--get", "user.name"));
	assert.equal(run(nested, "rev-parse", "--show-toplevel"), nested);
	assert.equal(run(repository, "rev-parse", "HEAD"), head);
	const nonempty = join(repository, "nonempty");
	fs.mkdirSync(nonempty);
	writeFileSync(join(nonempty, "notes.md"), "preserve");
	initializeGitRepository(nonempty);
	assert.equal(run(nonempty, "rev-parse", "--show-toplevel"), nonempty);
	assert.equal(readFileSync(join(nonempty, "notes.md"), "utf8"), "preserve");
	assert.equal(run(nonempty, "ls-files"), "");
	assert.equal(run(repository, "rev-parse", "HEAD"), head);
	const link = join(repository, "link");
	fs.symlinkSync(nested, link);
	assert.throws(() => initializeGitRepository(link), /regular directory/);
	const worktree = join(dirname(repository), "worktree");
	run(repository, "worktree", "add", "-b", "other", worktree);
	initializeGitRepository(worktree);
	assert.equal(run(worktree, "rev-parse", "HEAD"), head);
});

test("local-only push validates commits and does not hide branch or remote errors", (t) => {
	const { repository } = fixture(t, true);
	const commit = run(repository, "rev-parse", "HEAD");
	run(repository, "remote", "remove", "origin");
	assert.deepEqual(pushGitCommit(repository, commit), { status: "local", commit });
	assert.equal(pushGitCommit(repository, "a".repeat(40)).status, "pending");
	assert.equal(pushGitCommit(repository, "HEAD").status, "pending");
	run(repository, "config", "branch.main.remote", "missing");
	assert.equal(pushGitCommit(repository, commit).status, "pending");
	run(repository, "config", "--unset", "branch.main.remote");
	run(repository, "checkout", "--detach");
	assert.equal(pushGitCommit(repository, commit).status, "pending");
});

test("Git publication cannot omit uncommitted streams merely because live files match the view", (t) => {
	const { repository, cwd } = fixture(t, true);
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "draft");
	const initial = captureTemporalGitBase(cwd, "draft", repository);
	writeOwnedFileUpdates(temporalStateFileUpdates(cwd, "draft", view, ["global", "cwd", "session"], repository), initial.files, repository);
	const live = captureTemporalGitBase(cwd, "draft", repository);
	assert.throws(() => publishTemporalStateToGit(cwd, "draft", view, ["session"], live, repository), /omitted an uncommitted stream/);
	assert.equal(run(repository, "rev-parse", "HEAD"), initial.head);
	const published = publishTemporalStateToGit(cwd, "draft", view, ["global", "cwd", "session"], live, repository);
	assert.deepEqual(loadTemporalRevision(cwd, "draft", repository, published.commit!).scopes, view.scopes);
});

test("temporal Git writer preserves all hot states through sparse folding and cold revision reads", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "temporal-git";
	let states: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let view = createTemporalState(states, "origin");
	let base = captureTemporalGitBase(cwd, session, repository);
	const initialized = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, repository);
	base = initialized.base;
	const coldRevision = initialized.commit!;
	const origin = structuredClone(view);
	const snapshots = [structuredClone(states)];
	writeFileSync(join(repository, "staged.txt"), "unrelated staging\n");
	run(repository, "add", "staged.txt");
	writeFileSync(join(repository, "dirty.txt"), "unrelated dirty file\n");
	const staged = run(repository, "diff", "--cached", "--name-status");
	for (let index = 1; index <= 10; index++) {
		const changes: RecentScopePatch[] = [{ scope: "session", patch: { response: `Answer ${index}` } }];
		if (index % 2 === 0) changes.push({ scope: "cwd", patch: { working: { project: index } } });
		if (index % 3 === 0) changes.push({ scope: "global", patch: { working: { shared: index } } });
		view = advanceTemporalState(view, changes, `T${index}`);
		states = structuredClone(states);
		for (const change of changes) states[change.scope] = applyPatch(states[change.scope], change.patch as JsonObject) as ScopedStates["session"];
		snapshots.push(states);
		const publication = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, repository);
		assert.equal(publication.push?.status, "pushed");
		base = publication.base;
		const allowed = new Set(changes.flatMap(({ scope }) => {
			const paths = temporalScopePaths(cwd, session, scope, repository);
			return [paths.checkpoint, paths.patches].map((path) => path.slice(repository.length + 1));
		}));
		for (const path of run(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", publication.commit!).split("\n")) {
			assert.ok(allowed.has(path), `unchanged scope or unrelated file was committed: ${path}`);
		}
		const loaded: TemporalState = { lineage: view.lineage, scopes: {
			global: loadScopeStream(cwd, session, "global", repository)!,
			cwd: loadScopeStream(cwd, session, "cwd", repository)!,
			session: loadScopeStream(cwd, session, "session", repository)!,
		} };
		for (let offset = 0; offset < loaded.lineage.length; offset++) {
			for (const scope of ["global", "cwd", "session"] as const) assert.deepEqual(readTemporalState(loaded, offset, scope), snapshots.at(-1 - offset)![scope]);
		}
	}
	assert.equal(loadScopeStream(cwd, session, "session", repository)!.checkpoint.state.response, "Answer 3");
	assert.throws(() => readTemporalState(view, 8), /integer from 0 to 7/);
	const before = { head: run(repository, "rev-parse", "HEAD"), status: run(repository, "status", "--short") };
	const cold = loadTemporalRevision(cwd, session, repository, coldRevision);
	const restored: TemporalState = { lineage: origin.lineage, scopes: { global: cold.scopes.global!, cwd: cold.scopes.cwd!, session: cold.scopes.session! } };
	assert.deepEqual(readTemporalState(restored), emptyState());
	assert.deepEqual({ head: run(repository, "rev-parse", "HEAD"), status: run(repository, "status", "--short") }, before);
	assert.equal(run(repository, "diff", "--cached", "--name-status"), staged);
	const noOp = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, repository);
	assert.equal(noOp.commit, undefined);
	assert.equal(run(repository, "rev-parse", "HEAD"), before.head);
});

test("session config/meta publish atomically with temporal files and config-only stop creates no semantic step", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "runtime-session";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = emptySnapshot(true);
	const runtime = createSessionRuntime(snapshot, cwd, session, view.lineage);
	const first = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository, runtime);
	const paths = sessionRuntimePaths(cwd, session, repository);
	assert.deepEqual(JSON.parse(readFileSync(paths.config, "utf8")), runtime.config);
	assert.deepEqual(JSON.parse(readFileSync(paths.meta, "utf8")), runtime.meta);
	const semanticPaths = (["global", "cwd", "session"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(cwd, session, scope, repository);
		return [pair.checkpoint, pair.patches];
	});
	const semanticBefore = semanticPaths.map((path) => readFileSync(path));
	snapshot.config.enabled = false;
	const stopped = createSessionRuntime(snapshot, cwd, session, view.lineage);
	const second = publishTemporalStateToGit(cwd, session, view, [], first.base, repository, stopped);
	assert.ok(second.commit);
	assert.deepEqual(semanticPaths.map((path) => readFileSync(path)), semanticBefore);
	const changed = run(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", second.commit!).split("\n");
	assert.deepEqual(changed, [paths.config.slice(repository.length + 1)]);
	const original = loadTemporalRevision(cwd, session, repository, first.commit!);
	const stop = loadTemporalRevision(cwd, session, repository, second.commit!);
	assert.equal(original.runtime!.document.config.enabled, true);
	assert.equal(stop.runtime!.document.config.enabled, false);
	assert.equal(stop.runtime!.document.meta.step, 0);
	assert.deepEqual(stop.runtime!.document.meta.lineage, view.lineage);
	assert.equal(stop.runtime!.revision, second.commit);
	writeFileSync(join(repository, "unrelated.md"), "Knowledge-only advance\n");
	run(repository, "add", "unrelated.md");
	run(repository, "commit", "-m", "knowledge-only advance");
	const head = run(repository, "rev-parse", "HEAD");
	const afterKnowledge = loadTemporalRevision(cwd, session, repository, head);
	assert.equal(afterKnowledge.base.head, head);
	assert.equal(afterKnowledge.runtime!.revision, second.commit);
	assert.equal(resolveSessionRuntime(afterKnowledge.runtime!.document, afterKnowledge.runtime!.revision).snapshot.meta.durableBase, second.commit);
});

test("semantic runtime publication binds lineage and recovers the existing publication target after push failure", (t) => {
	const { repository, remote, cwd } = fixture(t, true);
	const session = "runtime-publication";
	const origin = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = emptySnapshot(true);
	const runtime = createSessionRuntime(snapshot, cwd, session, origin.lineage);
	const first = publishTemporalStateToGit(cwd, session, origin, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository, runtime);
	const next = advanceTemporalState(origin, [{ scope: "session", patch: { response: "Accepted" } }], "T1");
	assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["session"], first.base, repository), /requires its session runtime cohort/);
	assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["session"], first.base, repository, runtime), /Runtime lineage does not match/);
	snapshot.meta.step = 1;
	const acceptedRuntime = createSessionRuntime(snapshot, cwd, session, next.lineage);
	run(repository, "remote", "set-url", "origin", join(repository, "missing.git"));
	const accepted = publishTemporalStateToGit(cwd, session, next, ["session"], first.base, repository, acceptedRuntime);
	assert.equal(accepted.push?.status, "pending");
	const persisted = loadTemporalRevision(cwd, session, repository, accepted.commit!);
	const restored = resolveSessionRuntime(persisted.runtime!.document, persisted.runtime!.revision);
	assert.equal(restored.publicationTarget, accepted.commit);
	assert.equal(restored.snapshot.meta.step, 1);
	assert.deepEqual(restored.lineage, next.lineage);
	assert.equal(persisted.scopes.session!.patches.length, 1);
	run(repository, "remote", "set-url", "origin", remote);
	assert.equal(pushGitCommit(repository, restored.publicationTarget).status, "pushed");
	assert.equal(run(repository, "rev-parse", "HEAD"), accepted.commit);
	const noOp = publishTemporalStateToGit(cwd, session, next, [], accepted.base, repository, acceptedRuntime);
	assert.equal(noOp.commit, undefined);
});

test("historical temporal reads reject symlink modes even when their blob contains valid checkpoint JSON", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "temporal-history-mode";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const base = captureTemporalGitBase(cwd, session, repository);
	publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, repository);
	const blob = run(repository, "rev-parse", "HEAD:checkpoint.json");
	run(repository, "update-index", "--cacheinfo", `120000,${blob},checkpoint.json`);
	run(repository, "commit", "-m", "malformed historical symlink fixture");
	const revision = run(repository, "rev-parse", "HEAD");
	assert.throws(() => loadTemporalRevision(cwd, session, repository, revision), /not a regular blob/);
	assert.equal(run(repository, "rev-parse", "HEAD"), revision);
});

test("temporal publication rejects omitted changes, foreign session bases, and stale streams before writes", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "temporal-cas";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const base = captureTemporalGitBase(cwd, session, repository);
	assert.throws(() => publishTemporalStateToGit(cwd, session, view, ["session"], base, repository), /omitted a changed stream/);
	assert.throws(() => publishTemporalStateToGit(cwd, "other-session", view, ["global", "cwd", "session"], base, repository), /scope identity changed/);
	assert.equal(loadScopeStream(cwd, session, "global", repository), undefined);
	const first = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, repository);
	const next = advanceTemporalState(view, [{ scope: "session", patch: { response: "next" } }], "T1");
	assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["session"], base, repository), /changed concurrently/);
	assert.throws(() => publishTemporalStateToGit(cwd, session, next, [], first.base, repository), /omitted a changed stream/);
	assert.equal(loadScopeStream(cwd, session, "session", repository)!.patches.length, 0);
});

test("temporal publication reconciles a Knowledge-only HEAD advance as commit ancestry", (t) => {
	const { repository, remote, cwd } = fixture(t, true);
	const session = "knowledge-advance";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const first = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository);
	writeFileSync(join(repository, "knowledge.md"), "independent knowledge\n");
	run(repository, "add", "knowledge.md");
	run(repository, "commit", "-m", "knowledge: update");
	const knowledgeCommit = run(repository, "rev-parse", "HEAD");
	const next = advanceTemporalState(view, [{ scope: "cwd", patch: { working: { next: "continue" } } }], "T1");
	const publication = publishTemporalStateToGit(cwd, session, next, ["cwd"], first.base, repository);
	assert.equal(run(repository, "rev-parse", `${publication.commit}^`), knowledgeCommit);
	const paths = temporalScopePaths(cwd, session, "cwd", repository);
	assert.deepEqual(run(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", publication.commit!).split("\n"), [paths.patches.slice(repository.length + 1)]);
	assert.equal(readFileSync(join(repository, "knowledge.md"), "utf8"), "independent knowledge\n");
	assert.equal(run(remote, "rev-parse", "refs/heads/main"), publication.commit);
});

test("canonical CAS preserves concurrent uncommitted and committed bytes even in an omitted scope", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "concurrent-scopes";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const first = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository);
	const next = advanceTemporalState(view, [{ scope: "cwd", patch: { working: { writer: "state-flow" } } }], "T1");
	const path = temporalScopePaths(cwd, session, "global", repository).patches;
	const concurrent = Buffer.from([0xff, 0xfe, 0x0a]);
	writeFileSync(path, concurrent);
	for (const committed of [false, true]) {
		if (committed) {
			run(repository, "add", "--", path);
			run(repository, "commit", "-m", "concurrent global bytes");
		}
		const head = run(repository, "rev-parse", "HEAD");
		assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["cwd"], first.base, repository), /changed concurrently/);
		assert.deepEqual(readFileSync(path), concurrent);
		assert.equal(run(repository, "rev-parse", "HEAD"), head);
	}
});

test("the extension accepts a local durable commit without regenerating on push failure", async (t) => {
	const h = harness();
	await start(h, "Persist durable state");
	run(h.repositoryRoot, "remote", "set-url", "origin", join(h.repositoryRoot, "missing.git"));
	const terminal = {
		role: "assistant",
		stopReason: "stop",
		content: [{
			type: "text",
			text: `${scopedTerminalComment([{ scope: "cwd", patch: { working: { accepted: true } } }])}\n\nAccepted.`,
		}],
	};
	const accepted = h.handlers.get("message_end")!({ message: terminal }, h.ctx);
	h.handlers.get("turn_end")!({ message: accepted.message }, h.ctx);

	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.deepEqual(h.entries.at(-1)!.data, { revision: run(h.repositoryRoot, "rev-parse", "HEAD") });
	assert.equal(h.sentMessages.length, 0);
	assert.match(h.notifications.at(-1)!, /accepted durable commit .* push is pending/i);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Publication: pending [0-9a-f]{12} —/);
	assert.match(h.notifications.at(-1)!, /"accepted": true/);

	const remote = mkdtempSync(join(tmpdir(), "state-flow-extension-remote-"));
	t.after(() => rmSync(remote, { recursive: true, force: true }));
	rmSync(remote, { recursive: true });
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	run(h.repositoryRoot, "remote", "set-url", "origin", remote);
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.match(h.notifications.find((message) => /pushed pending durable commit/.test(message))!, /pushed pending/);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Publication: idle/);
	assert.equal(run(remote, "rev-parse", "refs/heads/main"), run(h.repositoryRoot, "rev-parse", "HEAD"));
});

test("migrates all three current snapshots in one isolated commit without losing semantic or cold history", (t) => {
	const { repository, remote, cwd } = fixture(t);
	const sessionId = "migration-session";
	const global = { ...emptyState(), working: { counter: 10 } };
	const session = { ...emptyState(), response: "Retained answer" };
	writeGlobalState(global, repository);
	writeSessionState(cwd, sessionId, session, repository);
	const legacyPaths = [durablePaths(repository).globalState, cwdStatePath(cwd, repository), sessionStatePath(cwd, sessionId, repository)];
	const patchPaths = [durablePaths(repository).globalPatches, cwdPatchesPath(cwd, repository), sessionPatchesPath(cwd, sessionId, repository)];
	writeFileSync(patchPaths[0]!, "malformed explanatory journal: not replay input\n");
	run(repository, "add", "--", ...legacyPaths, ...patchPaths);
	run(repository, "commit", "-m", "legacy scope snapshots");
	const before = run(repository, "rev-parse", "HEAD");
	writeFileSync(join(repository, "staged.txt"), "staged\n");
	run(repository, "add", "staged.txt");
	writeFileSync(join(repository, "dirty.txt"), "dirty\n");
	const staging = run(repository, "diff", "--cached", "--name-status");
	const publication = migrateLegacyStorageToGit(cwd, sessionId, repository);
	assert.deepEqual(publication.scopes, ["global", "cwd", "session"]);
	assert.equal(publication.push?.status, "pushed");
	assert.equal(run(repository, "rev-parse", `${publication.commit}^`), before);
	assert.equal(run(remote, "rev-parse", "refs/heads/main"), publication.commit);
	const origins = new Set<string>();
	for (const [index, scope] of (["global", "cwd", "session"] as const).entries()) {
		const checkpoint = join(dirname(legacyPaths[index]!), "checkpoint.json");
		assert.equal(existsSync(legacyPaths[index]!), false);
		const source = readFileSync(checkpoint, "utf8");
		const stream = parseScopeStream(source, readFileSync(patchPaths[index]!, "utf8"), scope)!;
		assert.deepEqual(stream.checkpoint.state, [global, emptyState(), session][index]);
		assert.deepEqual(stream.patches, []);
		origins.add(stream.checkpoint.through.id);
		const historical = JSON.parse(run(repository, "show", `${before}:${legacyPaths[index]!.slice(repository.length + 1)}`));
		assert.deepEqual(historical, stream.checkpoint.state);
		assert.deepEqual(JSON.parse(run(repository, "show", `${publication.commit}:${checkpoint.slice(repository.length + 1)}`)), JSON.parse(source));
	}
	assert.equal(origins.size, 1);
	assert.equal(run(repository, "diff", "--cached", "--name-status"), staging);
	assert.equal(readFileSync(join(repository, "dirty.txt"), "utf8"), "dirty\n");
	const changed = run(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", publication.commit!);
	assert.doesNotMatch(changed, /README\.md|staged\.txt|dirty\.txt/);
	assert.deepEqual(migrateLegacyStorageToGit(cwd, sessionId, repository), { scopes: [] });
	assert.equal(run(repository, "rev-parse", "HEAD"), publication.commit);
});

test("failed migration restores exact legacy bytes and removes unpublished checkpoints", (t) => {
	const { repository, cwd } = fixture(t);
	const state = cwdStatePath(cwd, repository);
	const patches = cwdPatchesPath(cwd, repository);
	writeFileSync(patches, Buffer.from([0xff, 0xfe, 0x0a]));
	run(repository, "add", "--", state, patches);
	run(repository, "commit", "-m", "legacy scope");
	writeFileSync(join(repository, "staged.txt"), "unrelated staging\n");
	run(repository, "add", "staged.txt");
	const before = { head: run(repository, "rev-parse", "HEAD"), state: readFileSync(state, "utf8"), patches: readFileSync(patches), index: run(repository, "diff", "--cached", "--name-status") };
	// Force failure after isolated-index commit construction, at caller-index alignment.
	writeFileSync(join(repository, ".git", "index.lock"), "held by another writer\n");
	assert.throws(() => migrateLegacyStorageToGit(cwd, "migration-session", repository), /index\.lock/);
	assert.equal(run(repository, "rev-parse", "HEAD"), before.head);
	assert.equal(readFileSync(state, "utf8"), before.state);
	assert.deepEqual(readFileSync(patches), before.patches);
	assert.equal(existsSync(join(dirname(state), "checkpoint.json")), false);
	assert.equal(run(repository, "diff", "--cached", "--name-status"), before.index);
	assert.equal(readFileSync(join(repository, ".git", "index.lock"), "utf8"), "held by another writer\n");
	assert.equal(existsSync(join(repository, ".git", "state-flow-publication.lock")), false);
});

test("cooperating migration and semantic publishers fail before writes while another publication owns the lock", (t) => {
	const { repository, cwd } = fixture(t);
	const path = cwdStatePath(cwd, repository);
	const original = readFileSync(path);
	const base = captureTemporalGitBase(cwd, "session", repository);
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const lock = join(repository, ".git", "state-flow-publication.lock");
	writeFileSync(lock, "another publisher\n");
	assert.throws(() => migrateLegacyStorageToGit(cwd, "session", repository), /publication lock is unavailable/);
	assert.throws(() => publishTemporalStateToGit(cwd, "session", view, ["global", "cwd", "session"], base, repository), /publication lock is unavailable/);
	assert.deepEqual(readFileSync(path), original);
	assert.equal(existsSync(join(dirname(path), "checkpoint.json")), false);
	assert.equal(readFileSync(lock, "utf8"), "another publisher\n");
	rmSync(lock);
	assert.ok(migrateLegacyStorageToGit(cwd, "session", repository).commit);
	assert.equal(existsSync(lock), false);
});

test("temporal publication rejects changed prepared output and rollback preserves external bytes", (t) => {
	const { repository, cwd } = fixture(t, true);
	const session = "prepared-receipt";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const first = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository);
	const next = advanceTemporalState(view, [{ scope: "cwd", patch: { working: { writer: "state-flow" } } }], "T1");
	const { checkpoint: state, patches } = temporalScopePaths(cwd, session, "cwd", repository);
	const base = first.base;
	const before = run(repository, "rev-parse", "HEAD");
	const concurrent = JSON.stringify({ ...emptyState(), working: { writer: "external" } });
	writeFileSync(join(repository, ".git", "index.lock"), "held by another writer\n");
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		rename(from, to);
		if (!injected && to === patches) {
			injected = true;
			writeFileSync(state, concurrent);
		}
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["cwd"], base, repository), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error.errors[0]), /file conflict/);
			assert.match(String(error.errors[1]), /file conflict/);
			return true;
		});
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.equal(readFileSync(state, "utf8"), concurrent);
	assert.equal(run(repository, "rev-parse", "HEAD"), before);
	assert.equal(existsSync(join(repository, ".git", "state-flow-publication.lock")), false);
});

test("linked worktree publishers share common-Git-directory exclusion", (t) => {
	const { repository, cwd } = fixture(t, true);
	const linked = join(dirname(repository), "linked");
	run(repository, "worktree", "add", "-b", "linked", linked);
	const session = "common-lock";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const base = captureTemporalGitBase(cwd, session, linked);
	const lock = join(repository, ".git", "state-flow-publication.lock");
	writeFileSync(lock, "common owner\n");
	assert.throws(() => captureTemporalGitBase(cwd, session, linked), /publication lock is unavailable/);
	assert.throws(() => publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], base, linked), /publication lock is unavailable/);
	assert.throws(() => migrateLegacyStorageToGit(cwd, session, linked), /publication lock is unavailable/);
	assert.equal(existsSync(join(linked, "checkpoint.json")), false);
	assert.equal(readFileSync(lock, "utf8"), "common owner\n");
});

test("accepted temporal publication retains prepared receipts rather than adopting bytes changed during push", (t) => {
	const { repository, remote, cwd } = fixture(t, true);
	const session = "push-receipt";
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const path = temporalScopePaths(cwd, session, "global", repository).checkpoint;
	const concurrent = "concurrent bytes after acceptance";
	writeFileSync(join(remote, "hooks", "post-receive"), `#!/bin/sh\nprintf '%s' '${concurrent}' > '${path}'\n`, { mode: 0o755 });
	const publication = publishTemporalStateToGit(cwd, session, view, ["global", "cwd", "session"], captureTemporalGitBase(cwd, session, repository), repository);
	assert.equal(publication.push?.status, "pushed");
	assert.equal(readFileSync(path, "utf8"), concurrent);
	const receipt = publication.base.files.find((file) => file.path === path)!;
	assert.deepEqual(JSON.parse(receipt.content!), view.scopes.global.checkpoint);
	assert.deepEqual(receipt.bytes, Buffer.from(receipt.content!));
	assert.deepEqual(JSON.parse(run(repository, "show", `${publication.commit}:checkpoint.json`)), view.scopes.global.checkpoint);
	const next = advanceTemporalState(view, [{ scope: "session", patch: { response: "Next" } }], "T1");
	assert.throws(() => publishTemporalStateToGit(cwd, session, next, ["session"], publication.base, repository), /changed concurrently/);
	assert.equal(readFileSync(path, "utf8"), concurrent);
	assert.equal(run(repository, "rev-parse", "HEAD"), publication.commit);
});

test("migration push failure retains one accepted commit and retry never repeats semantic conversion", (t) => {
	const { repository, remote, cwd } = fixture(t);
	run(repository, "remote", "set-url", "origin", join(repository, "missing.git"));
	const publication = migrateLegacyStorageToGit(cwd, "migration-session", repository);
	assert.ok(publication.commit);
	assert.equal(publication.push?.status, "pending");
	assert.equal(existsSync(cwdStatePath(cwd, repository)), false);
	assert.deepEqual(migrateLegacyStorageToGit(cwd, "migration-session", repository), { scopes: [] });
	assert.equal(run(repository, "rev-parse", "HEAD"), publication.commit);
	run(repository, "remote", "set-url", "origin", remote);
	assert.equal(pushGitCommit(repository, publication.commit!).status, "pushed");
	assert.equal(run(remote, "rev-parse", "refs/heads/main"), publication.commit);
});
