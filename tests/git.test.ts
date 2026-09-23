import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, relative, sep } from "node:path";
import test from "node:test";
import { awaitInFlightBackupPushes, backupCurrentStateFlowFiles, pushCurrentStateFlowBackup, startStateFlowBackupPush } from "../lib/git.ts";
import { captureTemporalFileBases, isStateFlowOwnedPath } from "../lib/durable.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import "./git-environment.ts";
import { emptySnapshot } from "../lib/snapshot.ts";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("backup requires the exact State Flow root to be a Git repository", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-no-git-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.throws(() => backupCurrentStateFlowFiles(root), /Git command failed|repository/);
});

test("settled backup commits only State Flow-owned current files", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "unrelated.txt"), "baseline\n");
	git(root, "add", "unrelated.txt");
	git(root, "commit", "-m", "baseline");
	const before = git(root, "rev-parse", "HEAD");
	writeFileSync(join(root, "checkpoint.json"), "{\"accepted\":true}\n");
	writeFileSync(join(root, "unrelated.txt"), "caller edit\n");
	const commit = backupCurrentStateFlowFiles(root);
	assert.match(commit ?? "", /^[0-9a-f]{40,64}$/);
	assert.notEqual(commit, before);
	assert.equal(git(root, "show", "HEAD:checkpoint.json"), '{"accepted":true}');
	assert.equal(git(root, "show", "HEAD:unrelated.txt"), "baseline");
	assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "caller edit\n");
	assert.equal(backupCurrentStateFlowFiles(root), undefined);
});

test("backup replication pushes the exact current commit only to the configured branch remote", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-push-"));
	const remote = mkdtempSync(join(tmpdir(), "state-flow-backup-remote-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	});
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "checkpoint.json"), "{\"accepted\":true}\n");
	const commit = backupCurrentStateFlowFiles(root)!;
	git(remote, "init", "--bare", "-b", "main");
	git(root, "remote", "add", "origin", remote);
	git(root, "config", "branch.main.remote", "origin");
	git(root, "config", "branch.main.merge", "refs/heads/main");
	assert.deepEqual(await pushCurrentStateFlowBackup(root), { commit, remote: "origin", ref: "refs/heads/main" });
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), commit);
});

test("in-flight backup push settlement closes the process and prevents overlapping pushes", { timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-push-lifecycle-"));
	const remote = join(root, "remote.git");
	const repository = join(root, "store");
	const bin = join(root, "bin");
	mkdirSync(bin);
	git(root, "init", "--bare", "-b", "main", remote);
	git(root, "init", "-b", "main", repository);
	git(repository, "config", "user.name", "State Flow Test");
	git(repository, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(repository, "checkpoint.json"), "{}\n");
	const first = backupCurrentStateFlowFiles(repository)!;
	git(repository, "remote", "add", "origin", remote);
	git(repository, "config", "branch.main.remote", "origin");
	git(repository, "config", "branch.main.merge", "refs/heads/main");
	const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const script = join(bin, "git");
	const entered = join(root, "entered");
	const release = join(root, "release");
	writeFileSync(script, `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args.includes('--porcelain') && args.includes('push')) {\n  fs.appendFileSync(${JSON.stringify(entered)}, 'push\\n');\n  while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n}\nconst result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: 'inherit', env: process.env });\nprocess.exit(result.status ?? 1);\n`);
	chmodSync(script, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${originalPath}`;
	t.after(async () => {
		writeFileSync(release, "go");
		await awaitInFlightBackupPushes(repository);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	});
	const failures: unknown[] = [];
	assert.equal(startStateFlowBackupPush(repository, (error) => failures.push(error)), true);
	const deadline = Date.now() + 5_000;
	while (!existsSync(entered)) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the slow push");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	writeFileSync(join(repository, "checkpoint.json"), "{\"next\":true}\n");
	const second = backupCurrentStateFlowFiles(repository)!;
	assert.notEqual(second, first);
	assert.equal(startStateFlowBackupPush(repository, (error) => failures.push(error)), false);
	assert.equal(readFileSync(entered, "utf8"), "push\n");
	let settled = false;
	const shutdown = awaitInFlightBackupPushes(repository).then(() => { settled = true; });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(settled, false, "shutdown must wait for the active push process");
	writeFileSync(release, "go");
	await shutdown;
	assert.equal(failures.length, 0);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), first);
	const remoteBefore = readFileSync(join(remote, "refs", "heads", "main"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(readFileSync(join(remote, "refs", "heads", "main")), remoteBefore, "no remote writes after shutdown resolves");
	assert.equal(readFileSync(entered, "utf8"), "push\n");
	assert.equal(startStateFlowBackupPush(repository, (error) => failures.push(error)), true);
	await awaitInFlightBackupPushes(repository);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), second, "a later turn retries the latest HEAD");
});

test("backup replication skips repositories without an explicitly configured branch remote", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-local-"));
	const remote = mkdtempSync(join(tmpdir(), "state-flow-backup-unused-remote-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	});
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "checkpoint.json"), "{}\n");
	backupCurrentStateFlowFiles(root);
	git(remote, "init", "--bare", "-b", "main");
	git(root, "remote", "add", "origin", remote);
	assert.equal(await pushCurrentStateFlowBackup(root), undefined);
	assert.throws(() => git(remote, "rev-parse", "refs/heads/main"));
});

test("failed backup replication remains retryable on the next attempt", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-push-retry-"));
	const remoteParent = mkdtempSync(join(tmpdir(), "state-flow-backup-push-retry-remote-"));
	const remote = join(remoteParent, "remote.git");
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(remoteParent, { recursive: true, force: true });
	});
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "checkpoint.json"), "{}\n");
	const commit = backupCurrentStateFlowFiles(root)!;
	git(root, "remote", "add", "origin", remote);
	git(root, "config", "branch.main.remote", "origin");
	git(root, "config", "branch.main.merge", "refs/heads/main");
	await assert.rejects(pushCurrentStateFlowBackup(root), /Git backup push failed/);
	mkdirSync(remote);
	git(remote, "init", "--bare", "-b", "main");
	assert.deepEqual(await pushCurrentStateFlowBackup(root), { commit, remote: "origin", ref: "refs/heads/main" });
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), commit);
});

test("backup replication does not force a divergent configured remote", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-no-force-"));
	const remote = mkdtempSync(join(tmpdir(), "state-flow-backup-no-force-remote-"));
	const writer = mkdtempSync(join(tmpdir(), "state-flow-backup-no-force-writer-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
		rmSync(writer, { recursive: true, force: true });
	});
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "checkpoint.json"), "{\"generation\":1}\n");
	const baseline = backupCurrentStateFlowFiles(root)!;
	git(remote, "init", "--bare", "-b", "main");
	git(root, "remote", "add", "origin", remote);
	git(root, "config", "branch.main.remote", "origin");
	git(root, "config", "branch.main.merge", "refs/heads/main");
	await pushCurrentStateFlowBackup(root);
	git(writer, "clone", remote, ".");
	git(writer, "config", "user.name", "Remote Writer");
	git(writer, "config", "user.email", "remote@example.invalid");
	writeFileSync(join(writer, "remote.txt"), "divergent remote commit\n");
	git(writer, "add", "remote.txt");
	git(writer, "commit", "-m", "remote advance");
	git(writer, "push", "origin", "main");
	const remoteHead = git(remote, "rev-parse", "refs/heads/main");
	assert.notEqual(remoteHead, baseline);
	writeFileSync(join(root, "checkpoint.json"), "{\"generation\":2}\n");
	const localHead = backupCurrentStateFlowFiles(root)!;
	await assert.rejects(pushCurrentStateFlowBackup(root), /Git backup push failed/);
	assert.equal(git(root, "rev-parse", "HEAD"), localHead);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteHead);
});

for (const outcome of ["success", "unchanged", "index-lock"] as const) test(`backup preserves unrelated staged data on ${outcome}`, (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-index-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	for (const path of ["notes.txt", "deleted.txt", "checkpoint.json", "patches.jsonl"]) writeFileSync(join(root, path), "baseline\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "baseline");
	const head = git(root, "rev-parse", "HEAD");
	writeFileSync(join(root, "notes.txt"), "staged version\n");
	writeFileSync(join(root, "new.txt"), "index-only addition\n");
	git(root, "add", "notes.txt", "new.txt");
	writeFileSync(join(root, "notes.txt"), "unstaged version\n");
	rmSync(join(root, "new.txt"));
	git(root, "rm", "deleted.txt");
	const unrelated = ["notes.txt", "deleted.txt", "new.txt"];
	const stages = () => git(root, "ls-files", "--stage", "-z", "--", ...unrelated);
	const changes = () => git(root, "diff", "--cached", "--name-status", "--", ...unrelated);
	const beforeStages = stages();
	const beforeChanges = changes();
	if (outcome !== "unchanged") {
		writeFileSync(join(root, "checkpoint.json"), "accepted canonical bytes\n");
		git(root, "rm", "patches.jsonl");
	}
	const beforeIndex = readFileSync(join(root, ".git", "index"));
	if (outcome === "index-lock") {
		const lock = join(root, ".git", "index.lock");
		writeFileSync(lock, "caller-owned lock\n");
		assert.throws(() => backupCurrentStateFlowFiles(root), /index\.lock/);
		assert.equal(readFileSync(lock, "utf8"), "caller-owned lock\n");
		assert.equal(git(root, "rev-parse", "HEAD"), head);
		assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex);
	} else {
		const commit = backupCurrentStateFlowFiles(root);
		if (outcome === "unchanged") {
			assert.equal(commit, undefined);
			assert.equal(git(root, "rev-parse", "HEAD"), head);
			assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex);
		} else {
			assert.notEqual(commit, undefined);
			assert.equal(git(root, "show", "HEAD:checkpoint.json"), "accepted canonical bytes");
			assert.equal(git(root, "ls-tree", "--name-only", "HEAD", "--", "patches.jsonl"), "");
			assert.equal(git(root, "diff", "--cached", "--", "checkpoint.json", "patches.jsonl"), "");
			assert.equal(backupCurrentStateFlowFiles(root), undefined);
		}
	}
	assert.equal(stages(), beforeStages);
	assert.equal(changes(), beforeChanges);
	assert.equal(git(root, "show", ":notes.txt"), "staged version");
	assert.equal(git(root, "show", ":new.txt"), "index-only addition");
	assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "unstaged version\n");
	assert.equal(existsSync(join(root, "new.txt")), false);
	assert.equal(existsSync(join(root, "deleted.txt")), false);
	if (outcome !== "unchanged") assert.equal(readFileSync(join(root, "checkpoint.json"), "utf8"), "accepted canonical bytes\n");
});

for (const [phase, fail] of [["read-tree", false], ["add", false], ["add", true]] as const) test(`backup releases canonical writers during ${phase} (failure=${fail}) and commits one captured cohort`, { timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-concurrency-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "notes.txt"), "baseline\n");
	git(root, "add", "notes.txt");
	git(root, "commit", "-m", "baseline");
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "writer-a", root);
	const snapshot = emptySnapshot(true);
	a.initialize(snapshot, true);
	const baseline = backupCurrentStateFlowFiles(root)!;
	const publish = (generation: number) => {
		const before = a.states();
		const next = structuredClone(before);
		for (const scope of ["global", "cwd", "session"] as const) next[scope].working.generation = generation;
		snapshot.meta.step++;
		a.publish(snapshot, true, createAcceptedTransition(before, next));
	};
	publish(1);
	const capturedBefore = captureTemporalFileBases(cwd, a.sessionId, root);
	writeFileSync(join(root, "notes.txt"), "staged caller version\n");
	git(root, "add", "notes.txt");
	writeFileSync(join(root, "notes.txt"), "unstaged caller version\n");
	const callerIndex = git(root, "ls-files", "--stage", "-z", "--", "notes.txt");
	const indexBefore = readFileSync(join(root, ".git", "index"));
	const release = join(root, "release-backup-test");
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import childProcess from "node:child_process";
		import { existsSync, readFileSync } from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { join } from "node:path";
		import { backupCurrentStateFlowFiles } from ${JSON.stringify(new URL("../lib/git.ts", import.meta.url).href)};
		const { root, release, phase, fail } = JSON.parse(process.argv[1]);
		const original = childProcess.spawnSync;
		const lockedCommands = [];
		let paused = false;
		childProcess.spawnSync = (command, args, options) => {
			const lock = join(root, ".state-flow-publication.lock");
			if (command === "git" && existsSync(lock) && readFileSync(lock, "utf8").trim() === String(process.pid)) lockedCommands.push(args);
			if (command === "git" && args.includes(phase) && !paused) {
				paused = true;
				process.send({ phase: "paused" });
				const until = Date.now() + 15000;
				while (!existsSync(release) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
				if (!existsSync(release)) throw new Error("Backup test was not released");
				if (fail) return { status: 1, stdout: "", stderr: "controlled backup failure" };
			}
			return original(command, args, options);
		};
		syncBuiltinESMExports();
		let result;
		try { result = { commit: backupCurrentStateFlowFiles(root) }; }
		catch (error) { result = { error: error.message }; }
		process.send({ phase: "complete", ...result, lockedCommands }, () => process.disconnect());
	`, JSON.stringify({ root, release, phase, fail })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const messages: any[] = [];
	child.on("message", (message) => messages.push(message));
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += data; });
	const completed = once(child, "close");
	t.after(() => { if (child.exitCode === null) child.kill(); });
	let capturedAfter: ReturnType<typeof captureTemporalFileBases> = [];
	try {
		const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
		assert.equal((ready as any).phase, "paused", JSON.stringify(ready));
		publish(2);
		const later = new TemporalRuntime(join(root, "later-project"), "later-session", root);
		later.initialize(emptySnapshot(true), true);
		capturedAfter = [...captureTemporalFileBases(cwd, a.sessionId, root), ...captureTemporalFileBases(later.cwd, later.sessionId, root)];
	} finally {
		writeFileSync(release, "resume\n");
		const [code] = await completed;
		assert.equal(code, 0, stderr);
	}
	const result = messages.at(-1);
	assert.equal(result.phase, "complete");
	assert.deepEqual(result.lockedCommands, [], "no Git command may execute under the backup's canonical lock");
	assert.equal(a.read().working.generation, 2);
	for (const file of capturedAfter) if (file.bytes) assert.deepEqual(readFileSync(file.path), file.bytes);
	assert.equal(git(root, "ls-files", "--stage", "-z", "--", "notes.txt"), callerIndex);
	assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "unstaged caller version\n");
	const verify = (commit: string, files: ReturnType<typeof captureTemporalFileBases>) => {
		const expected = new Map(files.filter((file) => file.bytes !== undefined).map((file) => [relative(root, file.path).split(sep).join("/"), file.bytes]));
		const owned = git(root, "ls-tree", "-r", "--name-only", "-z", commit).split("\0").filter((path) => path && isStateFlowOwnedPath(join(root, path), root));
		assert.deepEqual(owned.sort(), [...expected.keys()].sort());
		for (const [path, bytes] of expected) assert.deepEqual(execFileSync("git", ["-C", root, "show", `${commit}:${path}`]), bytes, path);
	};
	if (fail) {
		assert.match(result.error, /controlled backup failure/);
		assert.equal(git(root, "rev-parse", "HEAD"), baseline);
		assert.deepEqual(readFileSync(join(root, ".git", "index")), indexBefore);
	} else {
		assert.equal(result.error, undefined);
		verify(result.commit, phase === "add" ? capturedBefore : capturedAfter);
	}
	assert.equal(existsSync(join(root, ".state-flow-publication.lock")), false);
	assert.equal(existsSync(join(root, ".git", "state-flow-backup.lock")), false);
	const next = backupCurrentStateFlowFiles(root);
	assert.equal(next === undefined, !fail && phase === "read-tree");
	verify(next ?? result.commit, capturedAfter);
});

test("backup preserves Git ignore/filter policy, literal paths, and opaque snapshot bytes", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "meta.json"), "tracked metadata\n");
	git(root, "add", "meta.json");
	git(root, "commit", "-m", "tracked metadata");
	writeFileSync(join(root, ".gitignore"), "meta.json\n");
	writeFileSync(join(root, ".gitattributes"), "checkpoint.json filter=backup-test\n*.jsonl -text\n");
	const filter = "process.stdout.write('filtered:' + require('node:fs').readFileSync(0, 'utf8'))";
	git(root, "config", "filter.backup-test.clean", `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(filter)}`);
	git(root, "config", "filter.backup-test.required", "true");
	writeFileSync(join(root, "meta.json"), "current tracked metadata\n");
	writeFileSync(join(root, "checkpoint.json"), "captured root\n");
	const cwd = join(root, "--project[1]--");
	mkdirSync(cwd);
	writeFileSync(join(cwd, ".gitattributes"), "checkpoint.json -filter\n");
	writeFileSync(join(cwd, "checkpoint.json"), "literal child\n");
	writeFileSync(join(cwd, "meta.json"), "ignored metadata\n");
	const opaque = Buffer.from([0xff, 0xfe, 0, 10]);
	writeFileSync(join(root, "patches.jsonl"), opaque);
	const commit = backupCurrentStateFlowFiles(root)!;
	assert.equal(git(root, "show", `${commit}:checkpoint.json`), "filtered:captured root");
	assert.equal(git(root, "show", `${commit}:--project[1]--/checkpoint.json`), "literal child");
	assert.equal(git(root, "show", `${commit}:meta.json`), "current tracked metadata");
	assert.deepEqual(execFileSync("git", ["-C", root, "show", `${commit}:patches.jsonl`]), opaque);
	assert.equal(git(root, "ls-tree", "--name-only", "-r", commit).includes("--project[1]--/meta.json"), false);
	assert.equal(git(root, "ls-tree", "--name-only", "-r", commit).includes(".gitattributes"), false);
	assert.equal(readFileSync(join(root, "checkpoint.json"), "utf8"), "captured root\n");
	assert.equal(backupCurrentStateFlowFiles(root), undefined);
});

test("backup inventories only canonical namespace levels and records removed owned directories", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-inventory-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	const cwd = join(root, "--project--");
	const session = join(cwd, "session");
	for (const directory of [session, join(session, "unrelated"), join(cwd, ".private"), join(root, "unrelated")]) mkdirSync(directory, { recursive: true });
	for (const directory of [root, cwd, session]) writeFileSync(join(directory, "checkpoint.json"), "{}\n");
	writeFileSync(join(session, "unrelated", "source.txt"), "Not a backup source");
	const visited: string[] = [];
	const original = fs.readdirSync;
	fs.readdirSync = ((path: any, options: any) => { visited.push(String(path)); return original(path, options); }) as typeof original;
	syncBuiltinESMExports();
	try { assert.ok(backupCurrentStateFlowFiles(root)); }
	finally { fs.readdirSync = original; syncBuiltinESMExports(); }
	assert.deepEqual(visited.sort(), [root, cwd, session].sort());
	rmSync(session, { recursive: true });
	const removed = backupCurrentStateFlowFiles(root)!;
	assert.ok(removed);
	assert.equal(git(root, "ls-tree", "--name-only", "-r", removed).includes("session/"), false);
	assert.equal(readFileSync(join(cwd, "checkpoint.json"), "utf8"), "{}\n");
});

for (const kind of ["symlink", "directory"] as const) test(`backup refuses an owned ${kind} without altering Git or following source bodies`, (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-unsafe-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	const path = join(root, "checkpoint.json");
	writeFileSync(path, "{}\n");
	const head = backupCurrentStateFlowFiles(root)!;
	const index = readFileSync(join(root, ".git", "index"));
	rmSync(path);
	const outside = join(root, "unrelated-source.txt");
	writeFileSync(outside, "Caller-owned source\n");
	if (kind === "symlink") symlinkSync(outside, path, "file");
	else { mkdirSync(path); writeFileSync(join(path, "unrelated-source.txt"), "Must not stage a directory"); }
	assert.throws(() => backupCurrentStateFlowFiles(root), /not a regular file/);
	assert.equal(git(root, "rev-parse", "HEAD"), head);
	assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
	assert.equal(readFileSync(outside, "utf8"), "Caller-owned source\n");
	assert.equal(existsSync(join(root, ".state-flow-publication.lock")), false);
	assert.equal(existsSync(join(root, ".git", "state-flow-backup.lock")), false);
});

for (const owned of [false, true]) test(`unborn backup preserves caller-only index data (owned files=${owned})`, (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-backup-unborn-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init");
	git(root, "config", "user.name", "State Flow Test");
	git(root, "config", "user.email", "state-flow@example.invalid");
	writeFileSync(join(root, "notes.txt"), "index-only content\n");
	git(root, "add", "notes.txt");
	rmSync(join(root, "notes.txt"));
	const before = git(root, "ls-files", "--stage", "-z", "--", "notes.txt");
	if (owned) writeFileSync(join(root, "checkpoint.json"), "{}\n");
	const commit = backupCurrentStateFlowFiles(root);
	assert.equal(commit !== undefined, owned);
	assert.equal(git(root, "ls-files", "--stage", "-z", "--", "notes.txt"), before);
	assert.equal(git(root, "show", ":notes.txt"), "index-only content");
	assert.equal(existsSync(join(root, "notes.txt")), false);
	if (owned) assert.equal(git(root, "ls-tree", "--name-only", "HEAD"), "checkpoint.json");
});
