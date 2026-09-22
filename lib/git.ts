// Domain: optional settled-turn backup of already-accepted canonical State Flow files.
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { captureOwnedFileBases, isStateFlowOwnedPath } from "./durable.ts";
import { acquirePublicationLock, withStoragePublicationLock } from "./storage.ts";

const GIT_TIMEOUT_MS = 15_000;
const STATE_FLOW_COMMIT_TRAILER = "State-Flow-Durable: v1";

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

function withBackupLock<T>(repositoryRoot: string, action: (root: string) => T): T {
	const root = assertRepositoryRoot(repositoryRoot);
	const common = resolve(root, git(root, ["rev-parse", "--git-common-dir"]).stdout.trim());
	const path = resolve(common, "state-flow-backup.lock");
	const descriptor = acquirePublicationLock(path, (cause) => new Error(
		`State Flow backup lock is unavailable at ${path}; retry on a later settled turn`, { cause },
	));
	try {
		writeFileSync(descriptor, `${process.pid}\n`);
		return action(root);
	} finally {
		closeSync(descriptor);
		rmSync(path);
	}
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

function commitCurrentOwnedFiles(repositoryRoot: string, expectedHead: string | undefined): string | undefined {
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
		const snapshot = withStoragePublicationLock(repositoryRoot, (root) => captureBackupFiles(root, tracked));
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

/** Commit only current State Flow-owned files; never changes canonical acceptance. */
export function backupCurrentStateFlowFiles(repositoryRoot: string): string | undefined {
	return withBackupLock(repositoryRoot, (root) => commitCurrentOwnedFiles(root, currentHead(root)));
}
