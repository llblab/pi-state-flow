// Domain: exact file-cohort publication, current-only recovery, and cooperating worktree exclusion.
// Excludes: temporal algebra, Pi lifecycle, Git objects/remotes, and backend fallback policy.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
	assertOwnedFileUpdates, captureTemporalFileBases, parseScopeProvenance, parseScopeStream, restoreDurableFileBases,
	serializeScopeProvenance, sessionRuntimePaths, temporalScopePaths, temporalStateFileUpdates, writeOwnedFileUpdates,
	type DurableFileBase, type OwnedFileUpdate,
} from "./durable.ts";
import { parseArtifactProvenanceRegistry, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { hashJson, sameJson } from "./json.ts";
import { RevisionUnavailableError, isFileRevision, parseSessionRuntime, serializeSessionRuntime, type FileRevision, type SessionRuntime } from "./snapshot.ts";
import { planLegacyStorageMigration } from "./migration.ts";
export { isFileRevision, type FileRevision } from "./snapshot.ts";
import type { StateScope } from "./state.ts";
import { validateTemporalState, type TemporalState } from "./temporal.ts";

const SCOPES = ["global", "cwd", "session"] as const;
export interface TemporalFileBase { files: DurableFileBase[] }

/** Probe once at a lifecycle boundary, never on cached state reads. Only spawn ENOENT is absence. */
export function detectGitCapability(): "git" | "files" {
	const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 15_000 });
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return "files";
	if (result.error || result.status !== 0) {
		throw new RevisionUnavailableError(`Cannot resolve Git capability: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
	}
	return "git";
}

export function assertStorageDirectory(path: string): void {
	const root = resolve(path);
	const parent = dirname(root);
	if (parent !== root) assertStorageDirectory(parent);
	const stat = lstatSync(root, { throwIfNoEntry: false });
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`State Flow repository path is not a regular directory: ${root}`);
}

/** Explicit creation only; existing bytes and unrelated files are never adopted or rewritten here. */
export function initializeFileStore(root: string): void {
	assertStorageDirectory(root);
	mkdirSync(resolve(root), { recursive: true });
}

/** Git writers also acquire this lock before their common-Git-directory lock. */
export function withStoragePublicationLock<T>(repositoryRoot: string, action: (root: string) => T): T {
	const root = resolve(repositoryRoot);
	assertStorageDirectory(root);
	const path = resolve(root, ".state-flow-publication.lock");
	let descriptor: number;
	try {
		descriptor = openSync(path, "wx", 0o600);
	} catch (error) {
		throw new RevisionUnavailableError(`State Flow publication lock is unavailable at ${path}; reconcile the active or interrupted publisher before retrying`, { cause: error });
	}
	try {
		writeFileSync(descriptor, `${process.pid}\n`);
		return action(root);
	} finally {
		closeSync(descriptor);
		rmSync(path);
	}
}

export function assertTemporalFileBase(expected: TemporalFileBase, current: TemporalFileBase): void {
	if (expected.files.length !== current.files.length || current.files.some((file, index) => {
		const previous = expected.files[index]!;
		return file.path !== previous.path || file.identity !== previous.identity;
	})) throw new Error("Temporal State Flow base or scope identity changed concurrently");
}

/** One shared publication plan for Git and files; neither backend invents semantic changes. */
export function planTemporalPublication(
	cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[],
	current: TemporalFileBase, root: string, runtime?: SessionRuntime, runtimeOnly = false, sessionKey = sessionId,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>,
): { updates: OwnedFileUpdate[]; changedScopes: StateScope[] } {
	const candidates = temporalStateFileUpdates(cwd, sessionId, view, scopes, root, sessionKey);
	const files = new Map(current.files.map((file) => [file.path, file]));
	if (runtimeOnly && scopes.length !== 0) throw new Error("Runtime-only publication cannot write semantic scopes");
	const changedScopes: StateScope[] = [];
	for (const scope of SCOPES) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		if (files.get(resolve(paths.directory, "state.json"))!.identity !== "missing") throw new Error("Legacy State Flow storage requires explicit migration");
		const previous = parseScopeStream(files.get(paths.checkpoint)!.content, files.get(paths.patches)!.content, scope, scope === "cwd" ? cwd : undefined);
		if (runtimeOnly || (previous !== undefined && sameJson(previous, view.scopes[scope]))) continue;
		if (!scopes.includes(scope)) throw new Error(`Temporal scope update omitted a changed stream: ${scope}`);
		changedScopes.push(scope);
	}
	const provenanceUpdates: OwnedFileUpdate[] = [];
	if (provenance !== undefined) {
		for (const scope of ["global", "cwd"] as const) {
			const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
			const registry = provenance[scope];
			const currentFile = files.get(paths.meta)!;
			if (Object.keys(registry).length === 0 && currentFile.identity === "missing") continue;
			if (!sameJson(parseScopeProvenance(currentFile.content, paths.meta), registry)) {
				provenanceUpdates.push({ path: paths.meta, content: serializeScopeProvenance(registry) });
			}
		}
	}
	const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
	const previousRuntime = parseSessionRuntime(files.get(runtimePaths.config)!.content, files.get(runtimePaths.meta)!.content, cwd, sessionId);
	if (previousRuntime !== undefined && changedScopes.length > 0 && runtime === undefined) throw new Error("Temporal semantic publication requires its session runtime cohort");
	const runtimeUpdates: OwnedFileUpdate[] = [];
	if (runtime !== undefined) {
		const sources = serializeSessionRuntime(runtime, cwd, sessionId);
		if (!sameJson(runtime.meta.lineage, view.lineage)) throw new Error("Runtime lineage does not match the temporal cohort");
		if (previousRuntime === undefined || !sameJson(previousRuntime, runtime)) {
			runtimeUpdates.push({ path: runtimePaths.config, content: sources.config }, { path: runtimePaths.meta, content: sources.meta });
		}
	}
	const changedPaths = new Set(changedScopes.flatMap((scope) => {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		return [paths.checkpoint, paths.patches];
	}));
	return { updates: [...candidates.filter(({ path }) => changedPaths.has(path)), ...provenanceUpdates, ...runtimeUpdates], changedScopes };
}

/** The accepted basis comes from prepared outputs, never a post-publication worktree reread. */
export function temporalFileReceipts(current: TemporalFileBase, updates: readonly OwnedFileUpdate[]): DurableFileBase[] {
	const receipts = new Map(updates.map((update) => [update.path, update.content]));
	return current.files.map((file) => {
		if (!receipts.has(file.path)) return file;
		const content = receipts.get(file.path);
		return content === undefined ? { path: file.path, identity: "missing" } : {
			path: file.path, content, bytes: Buffer.from(content),
			identity: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		};
	});
}

function fileRevision(base: TemporalFileBase, root: string): FileRevision {
	return `file:${hashJson({ root: resolve(root), files: base.files.map(({ path, identity }) => [relative(root, path), identity]) })}`;
}

function decodeFileCohort(cwd: string, sessionId: string, root: string, base: TemporalFileBase, sessionKey = sessionId) {
	const files = new Map(base.files.map((file) => [file.path, file.content]));
	const scopes = {} as TemporalState["scopes"];
	for (const scope of SCOPES) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		if (files.get(resolve(paths.directory, "state.json")) !== undefined) throw new Error("Legacy State Flow storage requires explicit migration");
		const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? cwd : undefined);
		if (!stream) throw new Error("Incomplete file-only temporal scope cohort");
		scopes[scope] = stream;
	}
	const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
	const runtime = parseSessionRuntime(files.get(paths.config), files.get(paths.meta), cwd, sessionId);
	if (!runtime || runtime.meta.publication !== "files") throw new Error("File-only recovery requires file publication provenance, not a Git self reference");
	const view = { scopes, lineage: runtime.meta.lineage };
	validateTemporalState(view);
	const provenance: Record<StateScope, ArtifactProvenanceRegistry> = {
		global: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta),
		cwd: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta),
		session: parseArtifactProvenanceRegistry(runtime.meta.artifacts, "State Flow session artifact provenance"),
	};
	return { runtime, view, provenance };
}

export function captureTemporalFileBase(cwd: string, sessionId: string, root: string, sessionKey = sessionId): TemporalFileBase {
	return withStoragePublicationLock(root, (locked) => ({ files: captureTemporalFileBases(cwd, sessionId, locked, sessionKey) }));
}

/** Current-only reference: exact bytes, complete identities and lineage, no aliases or history store. */
export function loadTemporalFileRevision(cwd: string, sessionId: string, root: string, revision: string, sessionKey = sessionId) {
	if (!isFileRevision(revision)) throw new Error("File recovery requires an exact file revision");
	return withStoragePublicationLock(root, (locked) => {
		const base = { files: captureTemporalFileBases(cwd, sessionId, locked, sessionKey) };
		if (fileRevision(base, locked) !== revision) throw new RevisionUnavailableError(`State Flow file revision is unavailable: ${revision}`);
		return { base, revision, ...decodeFileCohort(cwd, sessionId, locked, base, sessionKey) };
	});
}

/** Publish a validated full runtime/scoped cohort; no Git commands, success receipts, or pending pushes. */
export function publishTemporalStateToFiles(
	cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[],
	base: TemporalFileBase, root: string, runtime: SessionRuntime, sessionKey = sessionId,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>,
): { base: TemporalFileBase; revision: FileRevision; changed: boolean } {
	return withStoragePublicationLock(root, (locked) => {
		if (runtime.meta.publication !== "files") throw new Error("File publication requires explicit file provenance");
		const current = { files: captureTemporalFileBases(cwd, sessionId, locked, sessionKey) };
		assertTemporalFileBase(base, current);
		const { updates } = planTemporalPublication(cwd, sessionId, view, scopes, current, locked, runtime, false, sessionKey, provenance);
		const next = { files: temporalFileReceipts(current, updates) };
		decodeFileCohort(cwd, sessionId, locked, next, sessionKey);
		const revision = fileRevision(next, locked);
		publishFileUpdates(current.files, updates, locked);
		return { base: next, revision, changed: updates.length > 0 };
	});
}

function publishFileUpdates(bases: readonly DurableFileBase[], updates: readonly OwnedFileUpdate[], root: string): void {
	writeOwnedFileUpdates(updates, bases, root);
	try {
		assertOwnedFileUpdates(updates, root);
	} catch (error) {
		try {
			const touched = new Set(updates.map(({ path }) => path));
			restoreDurableFileBases(bases.filter(({ path }) => touched.has(path)), root, updates);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "State Flow file publication and rollback failed");
		}
		throw error;
	}
}

/** In-store format conversion only; no Git history or cross-repository import. */
export function migrateLegacyStorageToFiles(cwd: string, sessionId: string, root: string, sessionKey = sessionId): void {
	withStoragePublicationLock(root, (locked) => {
		const plan = planLegacyStorageMigration(cwd, sessionId, locked, undefined, sessionKey);
		if (plan.updates.length) publishFileUpdates(plan.bases, plan.updates, locked);
	});
}
