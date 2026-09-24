// Domain: optional settled-turn backup of already-accepted canonical State Flow files.
import { constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { captureOwnedFileBases, isStateFlowOwnedPath } from "./durable.ts";
import { withFilePublicationLock, withStorageTransaction } from "./storage.ts";

const GIT_TIMEOUT_MS = 15_000;
const STATE_FLOW_COMMIT_TRAILER = "State-Flow-Durable: v1";
const activePushes = new Map<string, Promise<void>>();

function redactGitDiagnostic(value: string): string {
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
		.replace(/([?&](?:access_token|auth|password|token)=)[^&\s]+/gi, "$1***");
}

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

function git(
	repositoryRoot: string,
	args: readonly string[],
	options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {},
): GitResult {
	const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		input: options.input,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
	});
	const status = result.status ?? 1;
	const stdout = result.stdout ?? "";
	const stderr = result.error?.message ?? result.stderr ?? "";
	if (result.error || (status !== 0 && !options.allowFailure)) {
		const detail = stderr.trim() || stdout.trim() || `exit status ${status}`;
		throw new Error(`Git command failed (${args.join(" ")}): ${detail}`);
	}
	return { status, stdout, stderr };
}

function assertDirectoryPath(path: string): void {
	const parent = dirname(path);
	if (parent !== path) assertDirectoryPath(parent);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
		throw new Error(`State Flow repository path is not a regular directory: ${path}`);
	}
}

function assertRepositoryRoot(repositoryRoot: string): string {
	const expected = resolve(repositoryRoot);
	assertDirectoryPath(expected);
	if (lstatSync(resolve(expected, ".git"), { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`State Flow Git metadata must not be a symlink: ${expected}`);
	}
	const actual = resolve(git(expected, ["rev-parse", "--show-toplevel"]).stdout.trim());
	if (actual !== expected) throw new Error(`State Flow backup repository root mismatch: expected ${expected}, found ${actual}`);
	return expected;
}

async function withBackupLock<T>(repositoryRoot: string, action: (root: string) => T | Promise<T>, signal?: AbortSignal, waitForLock = true): Promise<T> {
	signal?.throwIfAborted();
	const root = assertRepositoryRoot(repositoryRoot);
	const common = resolve(root, git(root, ["rev-parse", "--git-common-dir"]).stdout.trim());
	const path = resolve(common, "state-flow-backup.lock");
	return withFilePublicationLock(path, () => action(root), signal, (cause) => new Error(
		`State Flow backup lock is unavailable at ${JSON.stringify(path)}; retry on a later settled turn`, { cause },
	), waitForLock);
}

/** Inventory only the bounded canonical namespace, never artifact sources or unrelated directory trees. */
function captureBackupFiles(root: string, tracked: ReadonlySet<string>) {
	const paths = new Set([...tracked].map((path) => resolve(root, path)));
	const visit = (directory: string, depth: number): void => {
		assertDirectoryPath(directory);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (isStateFlowOwnedPath(path, root)) {
				if (!entry.isFile()) throw new Error(`State Flow backup source is not a regular file: ${path}`);
				paths.add(path);
			} else if (depth < 2 && isStateFlowOwnedPath(join(path, "checkpoint.json"), root)) {
				if (entry.isSymbolicLink()) throw new Error(`State Flow backup namespace is not a regular directory: ${path}`);
				if (entry.isDirectory()) visit(path, depth + 1);
			}
		}
	};
	visit(root, 0);
	return captureOwnedFileBases([...paths].sort(), root).map((file) => ({
		path: relative(root, file.path).split(sep).join("/"),
		bytes: file.bytes,
		mode: file.bytes === undefined ? 0o600 : lstatSync(file.path).mode,
	}));
}

/** Stage captured bytes through native Git filters without rereading live canonical files. */
function prepareBackupWorktree(root: string, worktree: string, files: ReturnType<typeof captureBackupFiles>): void {
	mkdirSync(worktree);
	const directories = new Set<string>();
	for (const file of files) {
		if (file.bytes === undefined) continue;
		const target = join(worktree, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.bytes, { mode: file.mode & 0o777 });
		let directory = dirname(file.path);
		while (true) {
			directories.add(directory);
			if (directory === ".") break;
			directory = dirname(directory);
		}
	}
	// Git policy is not semantic input and is read outside the canonical lock.
	for (const directory of directories) {
		const source = join(root, directory, ".gitattributes");
		assertDirectoryPath(dirname(source));
		const stat = lstatSync(source, { throwIfNoEntry: false });
		if (!stat) continue;
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`State Flow backup attributes are not a regular file: ${source}`);
		writeFileSync(join(worktree, directory, ".gitattributes"), readFileSync(source, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }), { mode: 0o600 });
	}
}

function currentHead(repositoryRoot: string): string | undefined {
	const result = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function currentBranchRef(repositoryRoot: string): string {
	const result = git(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
	if (result.status !== 0 || result.stdout.trim().length === 0) throw new Error("State Flow backup requires an attached Git branch");
	return result.stdout.trim();
}

function configuredPushDestination(repositoryRoot: string): { remote: string; ref: string } | undefined {
	const branchRef = currentBranchRef(repositoryRoot);
	const branch = branchRef.slice("refs/heads/".length);
	const configuredRemote = git(repositoryRoot, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true });
	if (configuredRemote.status > 1) throw new Error(configuredRemote.stderr || "Cannot inspect State Flow backup remote configuration");
	if (configuredRemote.status !== 0 || configuredRemote.stdout.trim().length === 0) return undefined;
	const remote = configuredRemote.stdout.trim();
	if (remote === ".") throw new Error("State Flow backup replication requires a non-local Git remote");
	const configuredMerge = git(repositoryRoot, ["config", "--get", `branch.${branch}.merge`], { allowFailure: true });
	if (configuredMerge.status > 1) throw new Error(configuredMerge.stderr || "Cannot inspect State Flow backup branch configuration");
	const ref = configuredMerge.status === 0 && configuredMerge.stdout.trim().length > 0
		? configuredMerge.stdout.trim()
		: branchRef;
	return { remote, ref };
}

async function commitCurrentOwnedFiles(repositoryRoot: string, expectedHead: string | undefined, signal?: AbortSignal, waitForLock = true): Promise<string | undefined> {
	const branchRef = currentBranchRef(repositoryRoot);
	if (currentHead(repositoryRoot) !== expectedHead) throw new Error("State Flow backup Git base changed concurrently");
	const temporary = mkdtempSync(`${tmpdir()}${sep}state-flow-backup-index-`);
	const env = { GIT_INDEX_FILE: `${temporary}${sep}index` };
	try {
		if (expectedHead === undefined) git(repositoryRoot, ["read-tree", "--empty"], { env });
		else git(repositoryRoot, ["read-tree", expectedHead], { env });
		const owned = (paths: string) => paths.split("\0").filter((path) => path.length > 0 && isStateFlowOwnedPath(resolve(repositoryRoot, path), repositoryRoot));
		const headPaths = new Set(expectedHead === undefined ? [] : owned(git(repositoryRoot, ["ls-tree", "-r", "--name-only", "-z", expectedHead]).stdout));
		const tracked = new Set([...headPaths, ...owned(git(repositoryRoot, ["ls-files", "--cached", "-z"]).stdout)]);
		// No Git command, filter, staging write, or ref update runs inside this short capture lock.
		const snapshot = await withStorageTransaction(repositoryRoot, () => captureBackupFiles(repositoryRoot, tracked), signal, waitForLock);
		signal?.throwIfAborted();
		if (currentBranchRef(repositoryRoot) !== branchRef || currentHead(repositoryRoot) !== expectedHead) {
			throw new Error("State Flow backup Git base changed concurrently");
		}
		const present = snapshot.filter((file) => file.bytes !== undefined).map((file) => file.path);
		const ignore = present.length === 0 ? { status: 1, stdout: "", stderr: "" }
			: git(repositoryRoot, ["check-ignore", "--no-index", "--stdin", "-z"], { input: `${present.join("\0")}\0`, allowFailure: true });
		if (ignore.status !== 0 && (ignore.status !== 1 || ignore.stderr.trim())) throw new Error(`Git ignore selection failed: ${ignore.stderr || ignore.status}`);
		const ignored = new Set(ignore.stdout.split("\0"));
		const candidates = snapshot.filter((file) => file.bytes === undefined
			? headPaths.has(file.path) : tracked.has(file.path) || !ignored.has(file.path));
		if (candidates.length === 0) return undefined;
		const pathspec = `${candidates.map((file) => file.path).join("\0")}\0`;
		const worktree = join(temporary, "worktree");
		prepareBackupWorktree(repositoryRoot, worktree, candidates);
		git(repositoryRoot, ["--literal-pathspecs", `--work-tree=${worktree}`, "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: pathspec });
		const tree = git(repositoryRoot, ["write-tree"], { env }).stdout.trim();
		if (expectedHead !== undefined && tree === git(repositoryRoot, ["rev-parse", `${expectedHead}^{tree}`]).stdout.trim()) return undefined;
		const args = ["commit-tree", tree];
		if (expectedHead !== undefined) args.push("-p", expectedHead);
		const commit = git(repositoryRoot, args, { input: `state-flow: settled canonical backup\n\n${STATE_FLOW_COMMIT_TRAILER}\n` }).stdout.trim();
		const previous = expectedHead ?? "0".repeat(commit.length);
		git(repositoryRoot, ["update-ref", branchRef, commit, previous]);
		try {
			// Align only owned entries; the caller's unrelated stages and index-only data remain intact.
			git(repositoryRoot, ["--literal-pathspecs", "reset", "--quiet", "--no-refresh", commit, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: pathspec });
		} catch (error) {
			git(repositoryRoot, ["update-ref", branchRef, previous, commit]);
			throw error;
		}
		return commit;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/** Await a coherent capture; hosts without cancellation may refuse contention instead of hanging Abort. */
export function backupCurrentStateFlowFiles(repositoryRoot: string, signal?: AbortSignal, waitForLock = true): Promise<string | undefined> {
	return withBackupLock(repositoryRoot, (root) => commitCurrentOwnedFiles(root, currentHead(root), signal, waitForLock), signal, waitForLock);
}

/** Skip overlapping pushes; the next accepted turn can push the latest HEAD. */
export function startStateFlowBackupPush(repositoryRoot: string, onFailure: (error: unknown) => void, onSuccess?: () => void): boolean {
	const root = resolve(repositoryRoot);
	if (activePushes.has(root)) return false;
	const push = pushCurrentStateFlowBackup(root).then(
		(result) => {
			if (result) { try { onSuccess?.(); } catch { /* Reporting cannot change push acceptance. */ } }
		},
		(error) => {
			try { onFailure(error); } catch { /* Reporting cannot revive a failed push. */ }
		},
	).finally(() => { activePushes.delete(root); });
	activePushes.set(root, push);
	return true;
}

/** Resolve only after the push process has closed (including timeout termination). */
export async function awaitInFlightBackupPushes(repositoryRoot: string): Promise<void> {
	const push = activePushes.get(resolve(repositoryRoot));
	if (push) await push;
}

/** Push the current backup commit to its explicitly configured branch remote without blocking settlement. */
export function pushCurrentStateFlowBackup(repositoryRoot: string): Promise<{ commit: string; remote: string; ref: string } | undefined> {
	return new Promise((resolvePush, rejectPush) => {
		let root: string;
		let commit: string | undefined;
		let destination: { remote: string; ref: string } | undefined;
		try {
			root = assertRepositoryRoot(repositoryRoot);
			commit = currentHead(root);
			destination = configuredPushDestination(root);
		} catch (error) {
			rejectPush(new Error(redactGitDiagnostic(error instanceof Error ? error.message : String(error))));
			return;
		}
		if (commit === undefined || destination === undefined) {
			resolvePush(undefined);
			return;
		}
		const child = spawn("git", ["-C", root, "push", "--porcelain", "--", destination.remote, `${commit}:${destination.ref}`], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
		});
		let stderr = "";
		let failure: Error | undefined;
		let settled = false;
		function terminate(error: Error): void {
			failure ??= error;
			if (child.exitCode !== null || child.signalCode !== null) {
				child.stderr?.destroy();
				return;
			}
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				// Keep waiting for close: signalling failure is not proof that the process ended.
			}
		}
		const timeout = setTimeout(() => terminate(new Error(`Git backup push timed out after ${GIT_TIMEOUT_MS}ms`)), GIT_TIMEOUT_MS);
		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) rejectPush(error);
			else resolvePush({ commit: commit!, ...destination! });
		}
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-1000); });
		child.on("error", (error) => {
			failure ??= error;
			if (!child.pid) finish(error);
		});
		child.once("exit", () => { if (failure) child.stderr?.destroy(); });
		child.once("close", (code, endedBy) => finish(failure ?? (code === 0 ? undefined
			: new Error(`Git backup push failed (${endedBy ?? code}): ${redactGitDiagnostic(stderr.trim()) || "no diagnostic output"}`))));
	});
}
