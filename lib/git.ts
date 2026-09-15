// Domain: durable Git revision reads, compare-and-swap publication, and exact-commit push retry.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
	assertOwnedFileUpdates,
	captureOwnedFileBases,
	captureTemporalFileBases,
	cwdScopePaths,
	isStateFlowOwnedPath,
	parseScopeProvenance,
	parseScopeStream,
	restoreDurableFileBases,
	temporalScopePaths,
	sessionScopePaths,
	sessionRuntimePaths,
	writeOwnedFileUpdates,
	type DurableFileBase,
	type OwnedFileUpdate,
} from "./durable.ts";
import { parseArtifactProvenanceRegistry, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { planLegacyStorageMigration } from "./migration.ts";
import { canonicalJson, sameJson } from "./json.ts";
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
	options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {},
): GitResult {
	const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		input: options.input,
		...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
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

/** One exact-path tree query per immutable revision; inspect only blobs the caller actually selects. */
function revisionFileReader(repositoryRoot: string, revision: string, paths: readonly string[]): (path: string) => DurableFileBase {
	const relativePaths = new Map(paths.map((path) => [path, relativeOwnedPath(path, repositoryRoot)]));
	if (relativePaths.size === 0) throw new Error("Git revision reader requires owned paths");
	const selected = new Set(relativePaths.values());
	const listing = git(repositoryRoot, ["ls-tree", "-z", revision, "--", ...selected], { env: {
		GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0",
	} }).stdout;
	if (listing.length > 0 && !listing.endsWith("\0")) throw new Error("Historical Git tree listing is incomplete");
	const entries = new Map<string, string | null>();
	for (const entry of listing.split("\0").filter(Boolean)) {
		const separator = entry.indexOf("\t");
		if (separator < 0) throw new Error("Historical Git tree listing is malformed");
		const path = entry.slice(separator + 1);
		if (!selected.has(path)) continue;
		entries.set(path, entries.has(path) ? null : entry.slice(0, separator));
	}
	const files = new Map<string, DurableFileBase>();
	return (path) => {
		const relativePath = relativePaths.get(path);
		if (relativePath === undefined) throw new Error(`Git revision reader did not select path: ${path}`);
		const cached = files.get(path);
		if (cached) return cached;
		const entry = entries.get(relativePath);
		if (entry === null) throw new Error(`Historical Git tree has duplicate path: ${relativePath}`);
		if (entry === undefined) {
			const missing: DurableFileBase = { path, identity: "missing" };
			files.set(path, missing);
			return missing;
		}
		if (!/^100(?:644|755) blob [0-9a-f]+$/.test(entry)) {
			throw new Error(`Historical State Flow file is not a regular blob: ${path}`);
		}
		// Selected state/runtime blobs have no semantic byte cap; Node's default pipe budget is only 1 MiB.
		const content = git(repositoryRoot, ["show", `${revision}:${relativePath}`], { maxBuffer: Infinity }).stdout;
		const file: DurableFileBase = { path, identity: `sha256:${createHash("sha256").update(content).digest("hex")}`, content };
		files.set(path, file);
		return file;
	};
}

function revisionFile(repositoryRoot: string, revision: string, path: string): DurableFileBase {
	return revisionFileReader(repositoryRoot, revision, [path])(path);
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
	/** Runtime-owned artifact provenance retained at this revision. */
	provenance: Record<StateScope, ArtifactProvenanceRegistry>;
}

export function captureTemporalGitBase(cwd: string, sessionId: string, repositoryRoot: string, sessionKey = sessionId): TemporalGitBase {
	return withPublicationLock(repositoryRoot, (root) => captureTemporalBaseUnderLock(cwd, sessionId, root, sessionKey));
}

function captureTemporalBaseUnderLock(cwd: string, sessionId: string, root: string, sessionKey = sessionId): TemporalGitBase {
	return { head: currentHead(root), files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
}

function revisionScopeFiles(read: (path: string) => DurableFileBase, paths: ReturnType<typeof temporalScopePaths>) {
	return {
		paths,
		checkpoint: read(paths.checkpoint),
		patches: read(paths.patches),
		meta: read(paths.meta),
	};
}

/** Cold scope-stream reconstruction from canonical revision paths only. */
export function loadTemporalRevision(cwd: string, sessionId: string, repositoryRoot: string, revision: string, sessionKey = sessionId): TemporalRevisionLoad {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, revision);
	const scopePaths = (["global", "cwd", "session"] as const).map((scope) => ({
		scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey),
	}));
	const canonicalRuntime = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
	const readFile = revisionFileReader(root, revision, [
		...scopePaths.flatMap(({ paths }) => [paths.checkpoint, paths.patches, paths.meta]),
		canonicalRuntime.config, canonicalRuntime.meta,
	]);
	const files: DurableFileBase[] = [];
	const scopes = {} as Record<StateScope, ScopeStream | undefined>;
	const provenance: Record<StateScope, ArtifactProvenanceRegistry> = { global: {}, cwd: {}, session: {} };
	for (const { scope, paths } of scopePaths) {
		const selected = revisionScopeFiles(readFile, paths);
		files.push(selected.checkpoint, selected.patches, ...(scope === "session" ? [] : [selected.meta]));
		if (scope !== "session") provenance[scope] = parseScopeProvenance(selected.meta.content, selected.meta.path);
		try {
			scopes[scope] = parseScopeStream(selected.checkpoint.content, selected.patches.content, scope,
				scope === "cwd" ? cwd : undefined, selected.meta.content);
		} catch (error) {
			throw new Error(`Invalid historical State Flow ${scope} scope`, { cause: error });
		}
	}
	const readRuntime = (paths: ReturnType<typeof sessionRuntimePaths>) => ({
		paths, config: readFile(paths.config), meta: readFile(paths.meta),
	});
	const { paths: runtimePaths, config, meta } = readRuntime(canonicalRuntime);
	files.push(config, meta);
	const document = parseSessionRuntime(config.content, meta.content, cwd, sessionId);
	if (document === undefined) return { base: { head: revision, files }, scopes, provenance };
	provenance.session = parseArtifactProvenanceRegistry(document.meta.artifacts, "State Flow session artifact provenance");
	const owner = git(root, ["log", "-1", "--format=%H", revision, "--",
		relativeOwnedPath(runtimePaths.config, root), relativeOwnedPath(runtimePaths.meta, root),
	]).stdout.trim();
	assertReadableRevision(root, owner);
	let temporalRevision = document.meta.temporalRevision === undefined || document.meta.temporalRevision === "self"
		? owner : document.meta.temporalRevision;
	if (temporalRevision !== revision) {
		const ancestor = git(root, ["merge-base", "--is-ancestor", temporalRevision, revision], { allowFailure: true }).status === 0;
		const parents = git(root, ["rev-list", "--parents", "-n", "1", revision]).stdout.trim().split(/\s+/);
		// A store-wide semantic migration intentionally replaces all prior history with one root.
		// Its complete tree owns every scope, so predecessor temporal pointers collapse to self.
		if (!ancestor && parents.length === 1) temporalRevision = owner;
		else if (!ancestor) {
			throw new Error("Temporal revision must be an ancestor of its runtime owner");
		}
		const selected = loadTemporalRevision(cwd, sessionId, root, temporalRevision, sessionKey);
		Object.assign(scopes, selected.scopes);
		Object.assign(provenance, selected.provenance);
	}
	if (scopes.global === undefined || scopes.cwd === undefined || scopes.session === undefined) {
		throw new Error("Session runtime has incomplete temporal scope storage");
	}
	validateTemporalState({ lineage: document.meta.lineage, scopes: { global: scopes.global, cwd: scopes.cwd, session: scopes.session } });
	return { base: { head: revision, files }, scopes, runtime: { document, revision: owner }, provenance };
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
	rootCommit = false,
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
		// A State Flow commit carries the complete non-ignored worktree delta, including user edits
		// and manual deletions, while `.gitignore` stays authoritative for untracked files. The
		// transient publication lock is ours, not repository content.
		git(repositoryRoot, ["add", "-A", "--", ".", ":(exclude).state-flow-publication.lock"], { env });
		const entries: string[] = [];
		for (const update of updates) {
			const relativePath = relativeOwnedPath(update.path, repositoryRoot);
			if (update.content === undefined) {
				git(repositoryRoot, ["update-index", "--force-remove", "--", relativePath], { env });
				continue;
			}
			const blob = git(repositoryRoot, ["hash-object", "-w", "--stdin"], { input: update.content }).stdout.trim();
			entries.push(`100644 ${blob}\t${relativePath}\0`);
		}
		// NUL framing preserves literal path characters while the blobs retain exact prepared bytes.
		if (entries.length > 0) git(repositoryRoot, ["update-index", "-z", "--index-info"], { env, input: entries.join("") });
		const tree = git(repositoryRoot, ["write-tree"], { env }).stdout.trim();
		if (expectedHead !== undefined && !rootCommit) {
			const previousTree = git(repositoryRoot, ["rev-parse", `${expectedHead}^{tree}`]).stdout.trim();
			if (tree === previousTree) return undefined;
		}
		const message = `state-flow: ${operation} ${scopes.join("+") || "runtime"} transition\n\n${STATE_FLOW_COMMIT_TRAILER}\n`;
		const commitArgs = ["commit-tree", tree];
		if (expectedHead !== undefined && !rootCommit) commitArgs.push("-p", expectedHead);
		const commit = git(repositoryRoot, commitArgs, { input: message }).stdout.trim();
		const zero = "0".repeat(40);
		assertOwnedFileUpdates(updates, repositoryRoot);
		git(repositoryRoot, ["update-ref", branchRef, commit, expectedHead ?? zero]);
		try {
			// Align the caller-visible index with the committed tree so advancing HEAD through the
			// isolated index leaves no artificial staged/unstaged status entries behind.
			git(repositoryRoot, ["read-tree", commit]);
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
	sessionKey = sessionId,
): StorageMigrationPublication {
	return withPublicationLock(repositoryRoot, (root) => migrateLegacyStorageUnderLock(cwd, sessionId, root, sessionKey));
}

function migrateLegacyStorageUnderLock(cwd: string, sessionId: string, root: string, sessionKey = sessionId): StorageMigrationPublication {
	const plan = planLegacyStorageMigration(cwd, sessionId, root, undefined, sessionKey);
	if (plan.updates.length === 0) return { scopes: [] };
	const current = captureOwnedFileBases(plan.bases.map(({ path }) => path), root);
	if (current.some((base, index) => base.identity !== plan.bases[index]!.identity)) {
		throw new Error("State Flow storage changed concurrently while planning migration");
	}
	return { scopes: plan.scopes, ...publishOwnedCohort(root, plan.updates, plan.bases, currentHead(root), plan.scopes, "migrate", false, true) };
}

function publishOwnedCohort(
	root: string,
	updates: readonly OwnedFileUpdate[],
	bases: readonly DurableFileBase[],
	head: string | undefined,
	scopes: readonly StateScope[],
	operation: "persist" | "migrate",
	push = true,
	rootCommit = false,
): { commit?: string; push?: GitPushResult } {
	let published = false;
	try {
		writeOwnedFileUpdates(updates, bases, root);
		published = true;
		const commit = commitOwnedFiles(root, updates, head, scopes, operation, rootCommit);
		return commit === undefined ? {} : push ? { commit, push: pushGitCommit(root, commit) } : { commit };
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
export function adoptFileStateToGit(cwd: string, sessionId: string, repositoryRoot: string, revision: string, snapshot: Snapshot, sessionKey = sessionId, push = true) {
	const selected = loadTemporalFileRevision(cwd, sessionId, repositoryRoot, revision, sessionKey);
	if (snapshot.meta.step !== selected.runtime.meta.step) throw new Error("Git adoption must preserve the semantic step");
	const runtime = createSessionRuntime(snapshot, cwd, sessionId, selected.view.lineage, "unconfirmed", selected.provenance.session);
	runtime.meta.temporalRevision = "self";
	const sources = serializeSessionRuntime(runtime, cwd, sessionId, selected.view.scopes.session,
		selected.base.files.find(({ path }) => path === sessionRuntimePaths(cwd, sessionId, repositoryRoot, sessionKey).meta)?.content);
	initializeGitRepository(repositoryRoot);
	return withPublicationLock(repositoryRoot, (root) => {
		const current = captureTemporalBaseUnderLock(cwd, sessionId, root, sessionKey);
		assertTemporalFileBase(selected.base, current);
		const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
		const provenancePaths = new Set([
			temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta,
			temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta,
		]);
		// Preserve exact valid scope bytes; only runtime provenance changes representation.
		const updates = current.files.filter(({ path, identity }) => path.endsWith("checkpoint.json")
			|| path.endsWith("patches.jsonl")
			|| (provenancePaths.has(path) && identity !== "missing"))
			.map(({ path, content }) => ({ path, content: content! }));
		updates.push({ path: paths.config, content: sources.config }, { path: paths.meta, content: sources.meta });
		const existing = current.head && updates.every(({ path, content }) => revisionFile(root, current.head!, path).content === content)
			? loadTemporalRevision(cwd, sessionId, root, current.head, sessionKey) : undefined;
		if (existing && (!existing.runtime || !sameJson({ lineage: existing.runtime.document.meta.lineage, scopes: existing.scopes }, selected.view))) {
			throw new Error("Existing Git runtime does not anchor the selected file cohort");
		}
		const publication = publishOwnedCohort(root, updates, current.files, current.head, [], "persist", push);
		const target = publication.commit ?? existing!.runtime!.revision;
		const remote = push ? publication.push ?? pushGitCommit(root, target) : undefined;
		return { ...publication, revision: target, ...(remote === undefined ? {} : { push: remote }), view: selected.view, provenance: selected.provenance,
			base: { head: publication.commit ?? current.head, files: temporalFileReceipts(current, updates) } };
	});
}

/** Working-tree equality alone cannot prove that a new commit contains the selected cohort. */
function includeUncommittedCohort(cwd: string, sessionId: string, root: string, current: TemporalGitBase,
	updates: OwnedFileUpdate[], changedScopes: StateScope[], scopes: readonly StateScope[], runtime: boolean, sessionKey = sessionId): void {
	const targets = new Map(updates.map((update) => [update.path, update]));
	const desired = (paths: string[]) => paths.map((path) => targets.get(path) ?? { path, content: current.files.find((file) => file.path === path)!.content });
	const pairs = (["global", "cwd", "session"] as const).map((scope) => {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		return { scope, pair: desired([paths.checkpoint, paths.patches]) };
	});
	const runtimePaths = runtime ? sessionRuntimePaths(cwd, sessionId, root, sessionKey) : undefined;
	const runtimePair = runtimePaths ? desired([runtimePaths.config, runtimePaths.meta]) : [];
	const readFile = current.head === undefined ? undefined : revisionFileReader(root, current.head,
		[...pairs.flatMap(({ pair }) => pair), ...runtimePair].map(({ path }) => path));
	const absentFromHead = (files: OwnedFileUpdate[]) => files.some(({ path, content }) => readFile === undefined || readFile(path).content !== content);
	for (const { scope, pair } of pairs) {
		if (!absentFromHead(pair)) continue;
		if (!scopes.includes(scope)) throw new Error(`Temporal scope update omitted an uncommitted stream: ${scope}`);
		for (const update of pair) targets.set(update.path, update);
		if (!changedScopes.includes(scope)) changedScopes.push(scope);
	}
	if (absentFromHead(runtimePair)) for (const update of runtimePair) targets.set(update.path, update);
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
	sessionKey = sessionId,
	push = true,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>,
): { base: TemporalGitBase; commit?: string; push?: GitPushResult } {
	return withPublicationLock(repositoryRoot, (root) => {
		const current = captureTemporalBaseUnderLock(cwd, sessionId, root, sessionKey);
		assertTemporalFileBase(base, current);
		if (runtime?.meta.publication === "files") throw new Error("Git publication requires explicit Git provenance");
		const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
		const previousRuntime = parseSessionRuntime(current.files.find(({ path }) => path === runtimePaths.config)?.content,
			current.files.find(({ path }) => path === runtimePaths.meta)?.content, cwd, sessionId);
		if (previousRuntime?.meta.publication === "files") throw new Error("File-only storage requires explicit full-cohort Git adoption");
		const runtimeOnly = runtime?.meta.temporalRevision !== undefined && runtime.meta.temporalRevision !== "self";
		if (runtimeOnly) {
			if (scopes.length !== 0) throw new Error("Runtime-only publication cannot write semantic scopes");
			const selected = loadTemporalRevision(cwd, sessionId, root, runtime!.meta.temporalRevision!, sessionKey);
			if (!sameJson(selected.scopes, view.scopes)) throw new Error("Runtime temporal reference does not match selected streams");
		}
		const { updates, changedScopes } = planTemporalPublication(cwd, sessionId, view, scopes, current, root, runtime, runtimeOnly, sessionKey, provenance);
		if (!runtimeOnly) includeUncommittedCohort(cwd, sessionId, root, current, updates, changedScopes, scopes, runtime !== undefined, sessionKey);
		if (updates.length === 0) return { base: current };
		const publication = publishOwnedCohort(root, updates, current.files, current.head, changedScopes, "persist", push);
		const nextFiles = temporalFileReceipts(current, updates);
		return { ...publication, base: { head: publication.commit ?? current.head, files: nextFiles } };
	});
}

export function resolveGitPushDestination(repositoryRoot: string): { gitCommonDir: string; remote: string; ref: string } | undefined {
	const root = assertRepositoryRoot(repositoryRoot);
	const common = git(root, ["rev-parse", "--git-common-dir"]).stdout.trim();
	const gitCommonDir = resolve(root, common);
	const destination = pushDestination(root);
	return destination === undefined ? undefined : { gitCommonDir, ...destination };
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
export function isGitCommitAncestor(repositoryRoot: string, ancestor: string, descendant: string): boolean {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, ancestor);
	assertReadableRevision(root, descendant);
	const result = git(root, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`Cannot inspect Git commit ancestry: ${result.stderr || `exit ${result.status}`}`);
}

/** Own one non-interactive exact-target push; cancellation is not confirmation of child exit. */
export function pushGitTarget(
	repositoryRoot: string,
	destination: { remote: string; ref: string },
	commit: string,
	signal?: AbortSignal,
): Promise<void> {
	if (typeof commit !== "string" || !/^[0-9a-f]{40,64}$/.test(commit)) return Promise.reject(new Error("Git push target must be an exact commit"));
	if (signal?.aborted) return Promise.reject(new Error("Git push aborted"));
	return new Promise<void>((resolve, reject) => {
		const child = spawn("git", ["-C", repositoryRoot, "push", "--", destination.remote, `${commit}:${destination.ref}`], {
			detached: process.platform !== "win32", // Own the POSIX group, not a detached daemon; retain the child handle.
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
				child.stderr?.destroy(); // Do not wait indefinitely for an outliving helper's inherited pipe.
				return;
			}
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				// No exit proof: keep the promise and caller's lease outstanding, even if signalling fails.
			}
		}
		const abort = () => terminate(new Error("Git push aborted"));
		const timeout = setTimeout(() => terminate(new Error(`Git push timed out after ${GIT_TIMEOUT_MS}ms`)), GIT_TIMEOUT_MS);
		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		}
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-1000); });
		child.on("error", (error) => {
			failure ??= error;
			if (!child.pid) finish(error); // Spawn failure owns no live process; kill errors do not prove exit.
		});
		child.once("exit", () => { if (failure) child.stderr?.destroy(); });
		child.once("close", (code, endedBy) => finish(failure ?? (code === 0 ? undefined
			: new Error(`Git push failed (${endedBy ?? code}): ${stderr.trim() || "no diagnostic output"}`))));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

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
