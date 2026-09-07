// Domain: durable Git revision reads, compare-and-swap publication, and exact-commit push retry.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
	assertOwnedFileUpdates,
	captureOwnedFileBases,
	captureTemporalFileBases,
	cwdScopePaths,
	durablePaths,
	isStateFlowOwnedPath,
	parseScopeStream,
	parseStateSource,
	restoreDurableFileBases,
	temporalScopePaths,
	sessionScopePaths,
	sessionRuntimePaths,
	writeOwnedFileUpdates,
	type DurableFileBase,
	type OwnedFileUpdate,
} from "./durable.ts";
import { planLegacyStorageMigration } from "./migration.ts";
import { hashJson } from "./json.ts";
import { validateTemporalState, type ScopeStream, type TemporalState } from "./temporal.ts";
import { createSessionRuntime, parseSessionRuntime, serializeSessionRuntime, type SessionRuntime, type Snapshot } from "./snapshot.ts";
import { assertTemporalFileBase, loadTemporalFileRevision, planTemporalPublication, temporalFileReceipts, withStoragePublicationLock } from "./storage.ts";
import type { MaterializedState, StateScope } from "./state.ts";

const GIT_TIMEOUT_MS = 15_000;
const STATE_FLOW_COMMIT_TRAILER = "State-Flow-Durable: v1";

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

export interface GitPushResult {
	status: "pushed" | "local" | "pending";
	commit: string;
	error?: string;
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
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			...options.env,
		},
	});
	const status = result.status ?? 1;
	const stdout = result.stdout ?? "";
	const stderr = result.error?.message ?? result.stderr ?? "";
	if (status !== 0 && !options.allowFailure) {
		const detail = stderr.trim() || stdout.trim() || `exit status ${status}`;
		throw new Error(`Git command failed (${args.join(" ")}): ${detail}`);
	}
	return { status, stdout, stderr };
}

function assertDirectoryPath(path: string): void {
	const parent = dirname(path);
	if (parent !== path) assertDirectoryPath(parent);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`State Flow repository path is not a regular directory: ${path}`);
}

/** Explicit start only: initialize this exact root, preserving existing files and ancestor Git. */
export function initializeGitRepository(repositoryRoot: string): void {
	const root = resolve(repositoryRoot);
	assertDirectoryPath(root);
	if (lstatSync(resolve(root, ".git"), { throwIfNoEntry: false })) {
		assertRepositoryRoot(root);
		return;
	}
	mkdirSync(root, { recursive: true });
	git(root, ["init"]);
	assertRepositoryRoot(root);
}

function assertRepositoryRoot(repositoryRoot: string): string {
	const expected = resolve(repositoryRoot);
	assertDirectoryPath(expected);
	if (lstatSync(resolve(expected, ".git"), { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`State Flow Git metadata must not be a symlink: ${expected}`);
	}
	const actual = resolve(git(expected, ["rev-parse", "--show-toplevel"]).stdout.trim());
	if (actual !== expected) {
		throw new Error(`State Flow durable repository root mismatch: expected ${expected}, found ${actual}`);
	}
	return expected;
}

/** Serialize cooperating State Flow publishers through capture, commit, and rollback. */
function withPublicationLock<T>(repositoryRoot: string, action: (root: string) => T): T {
	return withStoragePublicationLock(repositoryRoot, (lockedRoot) => {
		const root = assertRepositoryRoot(lockedRoot);
		const common = resolve(root, git(root, ["rev-parse", "--git-common-dir"]).stdout.trim());
		const path = resolve(common, "state-flow-publication.lock");
		let descriptor: number;
		try {
			descriptor = openSync(path, "wx", 0o600);
		} catch (error) {
			throw new Error(`State Flow publication lock is unavailable at ${path}; reconcile the active or interrupted publisher before retrying`, { cause: error });
		}
		try {
			writeFileSync(descriptor, `${process.pid}\n`);
			return action(root);
		} finally {
			closeSync(descriptor);
			rmSync(path);
		}
	});
}

function currentHead(repositoryRoot: string): string | undefined {
	const result = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function currentBranchRef(repositoryRoot: string): string {
	const result = git(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
	if (result.status !== 0 || result.stdout.trim().length === 0) {
		throw new Error("State Flow durable publication requires an attached Git branch");
	}
	return result.stdout.trim();
}

function revisionFile(
	repositoryRoot: string,
	revision: string,
	path: string,
): DurableFileBase {
	const relativePath = relativeOwnedPath(path, repositoryRoot);
	const object = `${revision}:${relativePath}`;
	const entry = git(repositoryRoot, ["ls-tree", "-z", revision, "--", relativePath]).stdout;
	if (entry.length === 0) return { path, identity: "missing" };
	if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) {
		throw new Error(`Historical State Flow file is not a regular blob: ${path}`);
	}
	const content = git(repositoryRoot, ["show", object]).stdout;
	return {
		path,
		identity: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		content,
	};
}

function assertReadableRevision(root: string, revision: string): void {
	if (!/^[0-9a-f]{40,64}$/.test(revision)
		|| git(root, ["cat-file", "-e", `${revision}^{commit}`], { allowFailure: true }).status !== 0) {
		throw new Error(`State Flow revision is not a readable Git commit: ${revision}`);
	}
}

export interface TemporalGitBase {
	head?: string;
	files: DurableFileBase[];
}

export interface TemporalRevisionLoad {
	base: TemporalGitBase;
	scopes: Record<StateScope, ScopeStream | undefined>;
	runtime?: { document: SessionRuntime; revision: string };
}

export function captureTemporalGitBase(cwd: string, sessionId: string, repositoryRoot: string): TemporalGitBase {
	return withPublicationLock(repositoryRoot, (root) => captureTemporalBaseUnderLock(cwd, sessionId, root));
}

function captureTemporalBaseUnderLock(cwd: string, sessionId: string, root: string): TemporalGitBase {
	return { head: currentHead(root), files: captureTemporalFileBases(cwd, sessionId, root) };
}

/** Cold scope-stream reconstruction; callers restore lineage from the matching runtime revision. */
export function loadTemporalRevision(cwd: string, sessionId: string, repositoryRoot: string, revision: string): TemporalRevisionLoad {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, revision);
	const files: DurableFileBase[] = [];
	const scopes = {} as Record<StateScope, ScopeStream | undefined>;
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root);
		const checkpoint = revisionFile(root, revision, paths.checkpoint);
		const patches = revisionFile(root, revision, paths.patches);
		const legacy = revisionFile(root, revision, resolve(paths.directory, "state.json"));
		if (legacy.identity !== "missing") throw new Error("Historical legacy storage requires explicit migration interpretation");
		files.push(checkpoint, patches, legacy);
		scopes[scope] = parseScopeStream(checkpoint.content, patches.content, scope);
	}
	const runtimePaths = sessionRuntimePaths(cwd, sessionId, root);
	const config = revisionFile(root, revision, runtimePaths.config);
	const meta = revisionFile(root, revision, runtimePaths.meta);
	files.push(config, meta);
	const document = parseSessionRuntime(config.content, meta.content, cwd, sessionId);
	if (document === undefined) return { base: { head: revision, files }, scopes };
	const owner = git(root, ["log", "-1", "--format=%H", revision, "--",
		relativeOwnedPath(runtimePaths.config, root), relativeOwnedPath(runtimePaths.meta, root),
	]).stdout.trim();
	assertReadableRevision(root, owner);
	const temporalRevision = document.meta.temporalRevision === undefined || document.meta.temporalRevision === "self"
		? owner : document.meta.temporalRevision;
	if (temporalRevision !== revision) {
		if (git(root, ["merge-base", "--is-ancestor", temporalRevision, revision], { allowFailure: true }).status !== 0) {
			throw new Error("Temporal revision must be an ancestor of its runtime owner");
		}
		const selected = loadTemporalRevision(cwd, sessionId, root, temporalRevision);
		Object.assign(scopes, selected.scopes);
	}
	if (scopes.global === undefined || scopes.cwd === undefined || scopes.session === undefined) {
		throw new Error("Session runtime has incomplete temporal scope storage");
	}
	validateTemporalState({ lineage: document.meta.lineage, scopes: { global: scopes.global, cwd: scopes.cwd, session: scopes.session } });
	return { base: { head: revision, files }, scopes, runtime: { document, revision: owner } };
}

/** Legacy state.json is already current; explanatory journals are irrelevant to semantic recovery. */
export function loadLegacyStatesAtRevision(cwd: string, sessionId: string, repositoryRoot: string, revision: string): Record<StateScope, MaterializedState | undefined> {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, revision);
	const paths = {
		global: durablePaths(root).globalState,
		cwd: cwdScopePaths(cwd, root).state,
		session: sessionScopePaths(cwd, sessionId, root).state,
	};
	const states = {} as Record<StateScope, MaterializedState | undefined>;
	for (const scope of ["global", "cwd", "session"] as const) {
		states[scope] = parseStateSource(revisionFile(root, revision, paths[scope]).content, paths[scope]);
	}
	return states;
}

function relativeOwnedPath(path: string, repositoryRoot: string): string {
	const output = relative(repositoryRoot, path);
	if (output === "" || output === ".." || output.startsWith(`..${sep}`) || !isStateFlowOwnedPath(path, repositoryRoot)) {
		throw new Error(`Git publication received a non-State Flow path: ${path}`);
	}
	return output.split(sep).join("/");
}

function commitOwnedFiles(
	repositoryRoot: string,
	updates: readonly OwnedFileUpdate[],
	expectedHead: string | undefined,
	scopes: readonly StateScope[],
	operation: "persist" | "migrate" = "persist",
): string | undefined {
	assertOwnedFileUpdates(updates, repositoryRoot);
	const branchRef = currentBranchRef(repositoryRoot);
	const observedHead = currentHead(repositoryRoot);
	if (observedHead !== expectedHead) {
		throw new Error("Durable State Flow Git base changed concurrently; reload before publishing");
	}
	const temporary = mkdtempSync(`${tmpdir()}${sep}state-flow-index-`);
	const indexPath = `${temporary}${sep}index`;
	const env = { GIT_INDEX_FILE: indexPath };
	try {
		if (expectedHead === undefined) git(repositoryRoot, ["read-tree", "--empty"], { env });
		else git(repositoryRoot, ["read-tree", expectedHead], { env });
		const entries: Array<{ relativePath: string; blob?: string }> = [];
		for (const update of updates) {
			const relativePath = relativeOwnedPath(update.path, repositoryRoot);
			if (update.content === undefined) {
				entries.push({ relativePath });
				git(repositoryRoot, ["update-index", "--force-remove", "--", relativePath], { env });
				continue;
			}
			const blob = git(repositoryRoot, ["hash-object", "-w", "--stdin"], { input: update.content }).stdout.trim();
			entries.push({ relativePath, blob });
			git(repositoryRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},${relativePath}`], { env });
		}
		const tree = git(repositoryRoot, ["write-tree"], { env }).stdout.trim();
		if (expectedHead !== undefined) {
			const previousTree = git(repositoryRoot, ["rev-parse", `${expectedHead}^{tree}`]).stdout.trim();
			if (tree === previousTree) return undefined;
		}
		const message = `state-flow: ${operation} ${scopes.join("+") || "runtime"} transition\n\n${STATE_FLOW_COMMIT_TRAILER}\n`;
		const commitArgs = ["commit-tree", tree];
		if (expectedHead !== undefined) commitArgs.push("-p", expectedHead);
		const commit = git(repositoryRoot, commitArgs, { input: message }).stdout.trim();
		const zero = "0".repeat(40);
		assertOwnedFileUpdates(updates, repositoryRoot);
		git(repositoryRoot, ["update-ref", branchRef, commit, expectedHead ?? zero]);
		try {
			const indexInfo = entries.map(({ relativePath, blob }) => blob === undefined
				? `0 ${zero}\t${relativePath}\n`
				: `100644 ${blob}\t${relativePath}\n`).join("");
			git(repositoryRoot, ["update-index", "--index-info"], { input: indexInfo });
		} catch (error) {
			git(repositoryRoot, ["update-ref", branchRef, expectedHead ?? zero, commit]);
			throw error;
		}
		return commit;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export interface StorageMigrationPublication {
	commit?: string;
	push?: GitPushResult;
	scopes: StateScope[];
}

/** Explicit migration entrypoint; initialization adopts it only with the temporal writer cutover. */
export function migrateLegacyStorageToGit(
	cwd: string,
	sessionId: string,
	repositoryRoot: string,
): StorageMigrationPublication {
	return withPublicationLock(repositoryRoot, (root) => migrateLegacyStorageUnderLock(cwd, sessionId, root));
}

function migrateLegacyStorageUnderLock(cwd: string, sessionId: string, root: string): StorageMigrationPublication {
	const plan = planLegacyStorageMigration(cwd, sessionId, root);
	if (plan.updates.length === 0) return { scopes: [] };
	const current = captureOwnedFileBases(plan.bases.map(({ path }) => path), root);
	if (current.some((base, index) => base.identity !== plan.bases[index]!.identity)) {
		throw new Error("State Flow storage changed concurrently while planning migration");
	}
	return { scopes: plan.scopes, ...publishOwnedCohort(root, plan.updates, plan.bases, currentHead(root), plan.scopes, "migrate") };
}

function publishOwnedCohort(
	root: string,
	updates: readonly OwnedFileUpdate[],
	bases: readonly DurableFileBase[],
	head: string | undefined,
	scopes: readonly StateScope[],
	operation: "persist" | "migrate",
): { commit?: string; push?: GitPushResult } {
	let published = false;
	try {
		writeOwnedFileUpdates(updates, bases, root);
		published = true;
		const commit = commitOwnedFiles(root, updates, head, scopes, operation);
		return commit === undefined ? {} : { commit, push: pushGitCommit(root, commit) };
	} catch (error) {
		if (published) {
			try {
				const touched = new Set(updates.map(({ path }) => path));
				restoreDurableFileBases(bases.filter(({ path }) => touched.has(path)), root, updates);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "State Flow publication and rollback failed");
			}
		}
		throw error;
	}
}

/** Explicit current-file adoption, not reconstruction or invention of pre-Git history. */
export function adoptFileStateToGit(cwd: string, sessionId: string, repositoryRoot: string, revision: string, snapshot: Snapshot) {
	const selected = loadTemporalFileRevision(cwd, sessionId, repositoryRoot, revision);
	if (snapshot.meta.step !== selected.runtime.meta.step) throw new Error("Git adoption must preserve the semantic step");
	const runtime = createSessionRuntime(snapshot, cwd, sessionId, selected.view.lineage);
	runtime.meta.temporalRevision = "self";
	const sources = serializeSessionRuntime(runtime, cwd, sessionId);
	initializeGitRepository(repositoryRoot);
	return withPublicationLock(repositoryRoot, (root) => {
		const current = captureTemporalBaseUnderLock(cwd, sessionId, root);
		assertTemporalFileBase(selected.base, current);
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		// Preserve exact valid scope bytes; only runtime provenance changes representation.
		const updates = current.files.filter(({ path }) => path.endsWith("checkpoint.json") || path.endsWith("patches.jsonl"))
			.map(({ path, content }) => ({ path, content: content! }));
		updates.push({ path: paths.config, content: sources.config }, { path: paths.meta, content: sources.meta });
		const existing = current.head && updates.every(({ path, content }) => revisionFile(root, current.head!, path).content === content)
			? loadTemporalRevision(cwd, sessionId, root, current.head) : undefined;
		if (existing && (!existing.runtime || hashJson({ lineage: existing.runtime.document.meta.lineage, scopes: existing.scopes }) !== hashJson(selected.view))) {
			throw new Error("Existing Git runtime does not anchor the selected file cohort");
		}
		const publication = publishOwnedCohort(root, updates, current.files, current.head, [], "persist");
		const target = publication.commit ?? existing!.runtime!.revision;
		return { ...publication, revision: target, push: publication.push ?? pushGitCommit(root, target), view: selected.view,
			base: { head: publication.commit ?? current.head, files: temporalFileReceipts(current, updates) } };
	});
}

/** Working-tree equality alone cannot prove that a new commit contains the selected cohort. */
function includeUncommittedCohort(cwd: string, sessionId: string, root: string, current: TemporalGitBase,
	updates: OwnedFileUpdate[], changedScopes: StateScope[], scopes: readonly StateScope[], runtime: boolean): void {
	const targets = new Map(updates.map((update) => [update.path, update]));
	const desired = (paths: string[]) => paths.map((path) => targets.get(path) ?? { path, content: current.files.find((file) => file.path === path)!.content });
	const absentFromHead = (files: OwnedFileUpdate[]) => files.some(({ path, content }) => current.head === undefined || revisionFile(root, current.head, path).content !== content);
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root);
		const pair = desired([paths.checkpoint, paths.patches]);
		if (!absentFromHead(pair)) continue;
		if (!scopes.includes(scope)) throw new Error(`Temporal scope update omitted an uncommitted stream: ${scope}`);
		for (const update of pair) targets.set(update.path, update);
		if (!changedScopes.includes(scope)) changedScopes.push(scope);
	}
	if (runtime) {
		const paths = sessionRuntimePaths(cwd, sessionId, root);
		const pair = desired([paths.config, paths.meta]);
		if (absentFromHead(pair)) for (const update of pair) targets.set(update.path, update);
	}
	updates.splice(0, updates.length, ...targets.values());
}

/** Persist selected streams from one validated view, never derive checkpoints from current state. */
export function publishTemporalStateToGit(
	cwd: string,
	sessionId: string,
	view: TemporalState,
	scopes: readonly StateScope[],
	base: TemporalGitBase,
	repositoryRoot: string,
	runtime?: SessionRuntime,
): { base: TemporalGitBase; commit?: string; push?: GitPushResult } {
	return withPublicationLock(repositoryRoot, (root) => {
		const current = captureTemporalBaseUnderLock(cwd, sessionId, root);
		assertTemporalFileBase(base, current);
		if (runtime?.meta.publication === "files") throw new Error("Git publication requires explicit Git provenance");
		const runtimePaths = sessionRuntimePaths(cwd, sessionId, root);
		const previousRuntime = parseSessionRuntime(current.files.find(({ path }) => path === runtimePaths.config)?.content,
			current.files.find(({ path }) => path === runtimePaths.meta)?.content, cwd, sessionId);
		if (previousRuntime?.meta.publication === "files") throw new Error("File-only storage requires explicit full-cohort Git adoption");
		const runtimeOnly = runtime?.meta.temporalRevision !== undefined && runtime.meta.temporalRevision !== "self";
		if (runtimeOnly) {
			if (scopes.length !== 0) throw new Error("Runtime-only publication cannot write semantic scopes");
			const selected = loadTemporalRevision(cwd, sessionId, root, runtime!.meta.temporalRevision!);
			if (hashJson(selected.scopes) !== hashJson(view.scopes)) throw new Error("Runtime temporal reference does not match selected streams");
		}
		const { updates, changedScopes } = planTemporalPublication(cwd, sessionId, view, scopes, current, root, runtime, runtimeOnly);
		if (!runtimeOnly) includeUncommittedCohort(cwd, sessionId, root, current, updates, changedScopes, scopes, runtime !== undefined);
		if (updates.length === 0) return { base: current };
		const publication = publishOwnedCohort(root, updates, current.files, current.head, changedScopes, "persist");
		const nextFiles = temporalFileReceipts(current, updates);
		return { ...publication, base: { head: publication.commit ?? current.head, files: nextFiles } };
	});
}

function pushDestination(repositoryRoot: string): { remote: string; ref: string } | undefined {
	const branchRef = currentBranchRef(repositoryRoot);
	const branch = branchRef.slice("refs/heads/".length);
	const configuredRemote = git(repositoryRoot, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true });
	if (configuredRemote.status > 1) throw new Error(configuredRemote.stderr || "Cannot inspect Git remote configuration");
	let remote = configuredRemote.status === 0 ? configuredRemote.stdout.trim() : "";
	if (remote.length === 0) {
		const remotes = git(repositoryRoot, ["remote"]).stdout.trim().split(/\s+/).filter(Boolean);
		if (remotes.length === 0) return undefined;
		if (remotes.includes("origin")) remote = "origin";
		else if (remotes.length === 1) remote = remotes[0]!;
		else throw new Error("State Flow durable publication cannot select a Git remote");
	}
	if (remote === ".") throw new Error("State Flow durable publication requires a non-local Git remote");
	const configuredMerge = git(repositoryRoot, ["config", "--get", `branch.${branch}.merge`], { allowFailure: true });
	const ref = configuredMerge.status === 0 && configuredMerge.stdout.trim().length > 0
		? configuredMerge.stdout.trim()
		: branchRef;
	return { remote, ref };
}

/** Read-only publication policy; configuration errors are not local-only success. */
export function isLocalGitRepository(repositoryRoot: string): boolean {
	return pushDestination(assertRepositoryRoot(repositoryRoot)) === undefined;
}

/** Push an already-created commit exactly; failures are publication state, not transition rejection. */
export function pushGitCommit(repositoryRoot: string, commit: string): GitPushResult {
	try {
		const root = assertRepositoryRoot(repositoryRoot);
		assertReadableRevision(root, commit);
		const destination = pushDestination(root);
		if (destination === undefined) return { status: "local", commit };
		const remote = git(root, ["ls-remote", destination.remote, destination.ref], { allowFailure: true });
		const remoteHead = remote.stdout.trim().split(/\s+/)[0];
		if (remote.status === 0 && remoteHead && /^[0-9a-f]{40,64}$/.test(remoteHead)
			&& git(root, ["merge-base", "--is-ancestor", commit, remoteHead], { allowFailure: true }).status === 0) {
			return { status: "pushed", commit };
		}
		const result = git(root, ["push", destination.remote, `${commit}:${destination.ref}`], { allowFailure: true });
		if (result.status === 0) return { status: "pushed", commit };
		return {
			status: "pending",
			commit,
			error: (result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`),
		};
	} catch (error) {
		return { status: "pending", commit, error: error instanceof Error ? error.message : String(error) };
	}
}
