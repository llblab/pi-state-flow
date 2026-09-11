// Domain: durable Git revision reads, compare-and-swap publication, and exact-commit push retry.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
	assertOwnedFileUpdates,
	captureOwnedFileBases,
	captureLegacyTemporalFileBases,
	captureTemporalFileBases,
	cwdScopePaths,
	legacySessionRuntimePaths,
	legacyTemporalScopePaths,
	durablePaths,
	isStateFlowOwnedPath,
	parseScopeProvenance,
	parseScopeStream,
	parseStateSource,
	serializeScopeStream,
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
import { sameJson } from "./json.ts";
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
	/** Runtime-owned artifact provenance retained at this revision. */
	provenance: Record<StateScope, ArtifactProvenanceRegistry>;
	/** True only when this revision directly selected pre-0.4 hashed paths. */
	legacyLayout?: true;
}

export function captureTemporalGitBase(cwd: string, sessionId: string, repositoryRoot: string, sessionKey = sessionId): TemporalGitBase {
	return withPublicationLock(repositoryRoot, (root) => captureTemporalBaseUnderLock(cwd, sessionId, root, sessionKey));
}

function captureTemporalBaseUnderLock(cwd: string, sessionId: string, root: string, sessionKey = sessionId): TemporalGitBase {
	return { head: currentHead(root), files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
}

function revisionScopeFiles(root: string, revision: string, cwd: string, sessionId: string, sessionKey: string, scope: StateScope) {
	const read = (paths: ReturnType<typeof temporalScopePaths>) => ({
		paths,
		checkpoint: revisionFile(root, revision, paths.checkpoint),
		patches: revisionFile(root, revision, paths.patches),
		legacy: revisionFile(root, revision, resolve(paths.directory, "state.json")),
		meta: revisionFile(root, revision, paths.meta),
	});
	const canonical = read(temporalScopePaths(cwd, sessionId, scope, root, sessionKey));
	if (scope === "global" || [canonical.checkpoint, canonical.patches, canonical.legacy].some(({ identity }) => identity !== "missing")) return { ...canonical, legacyLayout: false };
	return { ...read(legacyTemporalScopePaths(cwd, sessionId, scope, root)), legacyLayout: true };
}

/** Cold scope-stream reconstruction; pre-0.4 hashed paths remain read-only revision input. */
export function loadTemporalRevision(cwd: string, sessionId: string, repositoryRoot: string, revision: string, sessionKey = sessionId): TemporalRevisionLoad {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, revision);
	const files: DurableFileBase[] = [];
	const scopes = {} as Record<StateScope, ScopeStream | undefined>;
	const provenance: Record<StateScope, ArtifactProvenanceRegistry> = { global: {}, cwd: {}, session: {} };
	let legacyLayout = false;
	for (const scope of ["global", "cwd", "session"] as const) {
		const selected = revisionScopeFiles(root, revision, cwd, sessionId, sessionKey, scope);
		if (selected.legacy.identity !== "missing") throw new Error("Historical legacy storage requires explicit migration interpretation");
		legacyLayout ||= selected.legacyLayout;
		files.push(selected.checkpoint, selected.patches, selected.legacy, ...(scope === "session" ? [] : [selected.meta]));
		if (scope !== "session") provenance[scope] = parseScopeProvenance(selected.meta.content, selected.meta.path);
		scopes[scope] = parseScopeStream(selected.checkpoint.content, selected.patches.content, scope,
			scope === "cwd" && !selected.legacyLayout ? cwd : undefined);
	}
	const readRuntime = (paths: ReturnType<typeof sessionRuntimePaths>) => ({
		paths, config: revisionFile(root, revision, paths.config), meta: revisionFile(root, revision, paths.meta),
	});
	let selectedRuntime = { ...readRuntime(sessionRuntimePaths(cwd, sessionId, root, sessionKey)), legacyLayout: false };
	if (selectedRuntime.config.identity === "missing" && selectedRuntime.meta.identity === "missing") {
		selectedRuntime = { ...readRuntime(legacySessionRuntimePaths(cwd, sessionId, root)), legacyLayout: true };
	}
	legacyLayout ||= selectedRuntime.legacyLayout;
	const { paths: runtimePaths, config, meta } = selectedRuntime;
	files.push(config, meta);
	const document = parseSessionRuntime(config.content, meta.content, cwd, sessionId);
	if (document === undefined) return { base: { head: revision, files }, scopes, provenance, ...(legacyLayout ? { legacyLayout: true as const } : {}) };
	provenance.session = parseArtifactProvenanceRegistry(document.meta.artifacts, "State Flow session artifact provenance");
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
		const selected = loadTemporalRevision(cwd, sessionId, root, temporalRevision, sessionKey);
		Object.assign(scopes, selected.scopes);
	}
	if (scopes.global === undefined || scopes.cwd === undefined || scopes.session === undefined) {
		throw new Error("Session runtime has incomplete temporal scope storage");
	}
	validateTemporalState({ lineage: document.meta.lineage, scopes: { global: scopes.global, cwd: scopes.cwd, session: scopes.session } });
	return { base: { head: revision, files }, scopes, runtime: { document, revision: owner }, provenance, ...(legacyLayout ? { legacyLayout: true as const } : {}) };
}

/** Legacy state.json is already current; explanatory journals are irrelevant to semantic recovery. */
export function loadLegacyStatesAtRevision(cwd: string, sessionId: string, repositoryRoot: string, revision: string, sessionKey = sessionId): Record<StateScope, MaterializedState | undefined> {
	const root = assertRepositoryRoot(repositoryRoot);
	assertReadableRevision(root, revision);
	const canonical = {
		global: durablePaths(root).globalState,
		cwd: cwdScopePaths(cwd, root).state,
		session: sessionScopePaths(cwd, sessionId, root, sessionKey).state,
	};
	const states = {} as Record<StateScope, MaterializedState | undefined>;
	for (const scope of ["global", "cwd", "session"] as const) {
		let path = canonical[scope];
		let source = revisionFile(root, revision, path).content;
		if (source === undefined && scope !== "global") {
			path = resolve(legacyTemporalScopePaths(cwd, sessionId, scope, root).directory, "state.json");
			source = revisionFile(root, revision, path).content;
		}
		states[scope] = parseStateSource(source, path);
	}
	return states;
}

/** Move a current-head draft CWD pair before a new native-named session is initialized. */
export function migrateHashedCwdAtHead(cwd: string, repositoryRoot: string): void {
	withPublicationLock(repositoryRoot, (root) => {
		const head = currentHead(root);
		if (!head) return;
		const old = legacyTemporalScopePaths(cwd, "unused", "cwd", root);
		const target = temporalScopePaths(cwd, "unused", "cwd", root);
		const paths = [old.checkpoint, old.patches, resolve(old.directory, "state.json"), target.checkpoint, target.patches, resolve(target.directory, "state.json")];
		const captured = captureOwnedFileBases(paths, root);
		const byPath = new Map(captured.map((file) => [file.path, file]));
		const oldCheckpoint = byPath.get(old.checkpoint)!;
		const oldPatches = byPath.get(old.patches)!;
		const oldState = byPath.get(resolve(old.directory, "state.json"))!;
		const targetFiles = [byPath.get(target.checkpoint)!, byPath.get(target.patches)!, byPath.get(resolve(target.directory, "state.json"))!];
		if (targetFiles[2]!.identity !== "missing") return; // Canonical current-state format migrates in the next owner.
		if (targetFiles[0]!.identity !== "missing" || targetFiles[1]!.identity !== "missing") {
			parseScopeStream(targetFiles[0]!.content, targetFiles[1]!.content, "cwd", cwd);
			return;
		}
		if (oldCheckpoint.identity === "missing" && oldPatches.identity === "missing" && oldState.identity === "missing") return;
		if (oldState.identity !== "missing") throw new Error("Hashed current-state storage requires explicit format migration before path migration");
		const oldStream = parseScopeStream(oldCheckpoint.content, oldPatches.content, "cwd")!;
		for (const file of [oldCheckpoint, oldPatches]) {
			if (revisionFile(root, head, file.path).identity !== file.identity) throw new Error(`Hashed CWD source is not anchored at current HEAD: ${file.path}`);
		}
		const source = serializeScopeStream(oldStream, "cwd", cwd);
		const updates = [
			{ path: target.checkpoint, content: source.checkpoint }, { path: target.patches, content: source.patches },
			{ path: old.checkpoint }, { path: old.patches },
		];
		try {
			publishOwnedCohort(root, updates, captured, head, [], "migrate");
		} catch (error) {
			try { rmdirSync(target.directory); } catch { /* Preserve nonempty or concurrently used directories. */ }
			throw error;
		}
		try { rmdirSync(old.directory); } catch { /* Draft sessions may remain under this directory. */ }
	});
}

/** Move only the selected current-head draft layout; older branch layouts remain cold read input. */
export function migrateHashedLayoutAtHead(
	cwd: string,
	sessionId: string,
	repositoryRoot: string,
	revision: string,
	sessionKey: string,
): (ReturnType<typeof publishOwnedCohort> & { base: TemporalGitBase; view: TemporalState }) | undefined {
	return withPublicationLock(repositoryRoot, (root) => {
		if (currentHead(root) !== revision) return undefined;
		const selected = loadTemporalRevision(cwd, sessionId, root, revision, sessionKey);
		if (!selected.legacyLayout || !selected.runtime || !selected.scopes.global || !selected.scopes.cwd || !selected.scopes.session) return undefined;
		const view = { lineage: selected.runtime.document.meta.lineage, scopes: {
			global: selected.scopes.global, cwd: selected.scopes.cwd, session: selected.scopes.session,
		} };
		validateTemporalState(view);
		const canonical = captureTemporalBaseUnderLock(cwd, sessionId, root, sessionKey);
		const legacyLive = captureLegacyTemporalFileBases(cwd, sessionId, root);
		const bases = new Map([...canonical.files, ...legacyLive].map((file) => [file.path, file]));
		const selectedFiles = new Map(selected.base.files.map((file) => [file.path, file]));
		const updates: OwnedFileUpdate[] = [];
		const cleanupDirectories = new Set<string>();
		const targetDirectories = new Set<string>();
		const removeEmptyDirectories = (directories: ReadonlySet<string>): void => {
			for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
				try { rmdirSync(directory); } catch { /* Preserve nonempty or concurrently used directories. */ }
			}
		};
		const move = (sourcePath: string, targetPath: string, content?: string): void => {
			const source = selectedFiles.get(sourcePath);
			if (!source || source.identity === "missing" || source.content === undefined) throw new Error(`Hashed-layout migration source is unavailable: ${sourcePath}`);
			if (bases.get(sourcePath)?.identity !== source.identity) throw new Error(`Hashed-layout source changed after selected revision: ${sourcePath}`);
			if (bases.get(targetPath)?.identity !== "missing") throw new Error(`Canonical State Flow path already exists during hashed-layout migration: ${targetPath}`);
			updates.push({ path: targetPath, content: content ?? source.content }, { path: sourcePath });
			cleanupDirectories.add(dirname(sourcePath));
			targetDirectories.add(dirname(targetPath));
		};
		for (const scope of ["cwd", "session"] as const) {
			const old = legacyTemporalScopePaths(cwd, sessionId, scope, root);
			const target = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
			if (selectedFiles.get(old.checkpoint)?.identity !== "missing") {
				if (scope === "cwd") {
					const stream = parseScopeStream(selectedFiles.get(old.checkpoint)!.content, selectedFiles.get(old.patches)!.content, "cwd")!;
					const source = serializeScopeStream(stream, "cwd", cwd);
					move(old.checkpoint, target.checkpoint, source.checkpoint);
					move(old.patches, target.patches, source.patches);
				} else {
					move(old.checkpoint, target.checkpoint);
					move(old.patches, target.patches);
				}
			}
		}
		const oldRuntime = legacySessionRuntimePaths(cwd, sessionId, root);
		const targetRuntime = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
		const migratedRuntime = structuredClone(selected.runtime.document);
		migratedRuntime.meta.temporalRevision = "self";
		const runtimeSource = serializeSessionRuntime(migratedRuntime, cwd, sessionId);
		if (selectedFiles.get(oldRuntime.config)?.identity !== "missing") {
			move(oldRuntime.config, targetRuntime.config, runtimeSource.config);
			move(oldRuntime.meta, targetRuntime.meta, runtimeSource.meta);
		} else {
			for (const [path, content] of [[targetRuntime.config, runtimeSource.config], [targetRuntime.meta, runtimeSource.meta]] as const) {
				const source = selectedFiles.get(path);
				if (!source || source.identity === "missing" || source.content === undefined) throw new Error(`Layout migration runtime is unavailable: ${path}`);
				if (bases.get(path)?.identity !== source.identity) throw new Error(`Layout migration runtime changed after selected revision: ${path}`);
				if (source.content !== content) updates.push({ path, content });
			}
		}
		if (updates.length === 0) return undefined;
		let publication: ReturnType<typeof publishOwnedCohort>;
		try {
			publication = publishOwnedCohort(root, updates, [...bases.values()], revision, [], "migrate");
		} catch (error) {
			removeEmptyDirectories(targetDirectories);
			throw error;
		}
		const nextFiles = temporalFileReceipts(canonical, updates);
		removeEmptyDirectories(cleanupDirectories);
		return { ...publication, base: { head: publication.commit ?? revision, files: nextFiles }, view };
	});
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
		// A State Flow commit carries the complete non-ignored worktree delta, including user edits
		// and manual deletions, while `.gitignore` stays authoritative for untracked files. The
		// transient publication lock is ours, not repository content.
		git(repositoryRoot, ["add", "-A", "--", ".", ":(exclude).state-flow-publication.lock"], { env });
		for (const update of updates) {
			const relativePath = relativeOwnedPath(update.path, repositoryRoot);
			if (update.content === undefined) {
				git(repositoryRoot, ["update-index", "--force-remove", "--", relativePath], { env });
				continue;
			}
			const blob = git(repositoryRoot, ["hash-object", "-w", "--stdin"], { input: update.content }).stdout.trim();
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
	return { scopes: plan.scopes, ...publishOwnedCohort(root, plan.updates, plan.bases, currentHead(root), plan.scopes, "migrate") };
}

function publishOwnedCohort(
	root: string,
	updates: readonly OwnedFileUpdate[],
	bases: readonly DurableFileBase[],
	head: string | undefined,
	scopes: readonly StateScope[],
	operation: "persist" | "migrate",
	push = true,
): { commit?: string; push?: GitPushResult } {
	let published = false;
	try {
		writeOwnedFileUpdates(updates, bases, root);
		published = true;
		const commit = commitOwnedFiles(root, updates, head, scopes, operation);
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
	const sources = serializeSessionRuntime(runtime, cwd, sessionId);
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
	const absentFromHead = (files: OwnedFileUpdate[]) => files.some(({ path, content }) => current.head === undefined || revisionFile(root, current.head, path).content !== content);
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		const pair = desired([paths.checkpoint, paths.patches]);
		if (!absentFromHead(pair)) continue;
		if (!scopes.includes(scope)) throw new Error(`Temporal scope update omitted an uncommitted stream: ${scope}`);
		for (const update of pair) targets.set(update.path, update);
		if (!changedScopes.includes(scope)) changedScopes.push(scope);
	}
	if (runtime) {
		const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
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
