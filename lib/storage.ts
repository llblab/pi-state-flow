// Domain: exact file-cohort publication, current-only recovery, and cooperating worktree exclusion.
// Excludes: temporal algebra, Pi lifecycle, Git objects/remotes, and backend fallback policy.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	assertOwnedFileUpdates, captureTemporalFileBases, parseScopeProvenance, parseScopeStream, restoreDurableFileBases,
	serializeScopeMetadata, sessionRuntimePaths, temporalScopePaths, temporalStateFileUpdates, writeOwnedFileUpdates,
	type DurableFileBase, type OwnedFileUpdate,
} from "./durable.ts";
import type { ArtifactProvenanceRegistry } from "./artifact.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { hashJson, sameJson } from "./json.ts";
import { RevisionUnavailableError, isFileRevision, parseSessionRuntime, serializeSessionRuntime, type FileRevision, type SessionRuntime } from "./snapshot.ts";
export { isFileRevision, type FileRevision } from "./snapshot.ts";
import type { StateScope } from "./state.ts";
import { validateTemporalState, type TemporalState } from "./temporal.ts";

const SCOPES = ["global", "cwd", "session"] as const;
export interface TemporalFileBase { files: DurableFileBase[] }

export function assertStorageDirectory(path: string): void {
	const root = resolve(path);
	const parent = dirname(root);
	if (parent !== root) assertStorageDirectory(parent);
	const stat = lstatSync(root, { throwIfNoEntry: false });
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`State Flow repository path is not a regular directory: ${JSON.stringify(root)}`);
}

/** Explicit creation only; existing bytes and unrelated files are never adopted or rewritten here. */
export function initializeFileStore(root: string): void {
	assertStorageDirectory(root);
	mkdirSync(resolve(root), { recursive: true });
}

const PUBLICATION_LOCK_WAIT_MS = 2_000;
const PUBLICATION_LOCK_POLL_MS = 25;
const publicationLockWait = new Int32Array(new SharedArrayBuffer(4));

function publicationLockOwner(path: string, allowCurrentProcess: boolean): "live" | "pending" | "absent" | "unavailable" {
	let owner: string;
	try {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) return "absent";
		if (!stat.isFile() || stat.isSymbolicLink()) return "unavailable";
		owner = readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
	if (owner.length === 0) return "pending";
	if (!/^[1-9]\d*$/.test(owner)) return "unavailable";
	const pid = Number(owner);
	if (!Number.isSafeInteger(pid) || (pid === process.pid && !allowCurrentProcess)) return "unavailable";
	try { process.kill(pid, 0); return "live"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? "live" : "unavailable"; }
}

/** Wait only for a cooperating live owner; interrupted or malformed locks remain explicit recovery errors. */
export function acquirePublicationLock(path: string, unavailable: (cause: unknown) => Error): number {
	const deadline = Date.now() + PUBLICATION_LOCK_WAIT_MS;
	while (true) {
		try { return openSync(path, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(error);
			let owner: ReturnType<typeof publicationLockOwner>;
			try { owner = publicationLockOwner(path, false); }
			catch (cause) { throw unavailable(cause); }
			if (owner === "unavailable" || Date.now() >= deadline) throw unavailable(error);
			Atomics.wait(publicationLockWait, 0, 0, Math.min(PUBLICATION_LOCK_POLL_MS, deadline - Date.now()));
		}
	}
}

/** Canonical writers and bounded backup capture share exclusion; no Git work runs under this lock. */
export function withStoragePublicationLock<T>(repositoryRoot: string, action: (root: string) => T): T {
	const root = resolve(repositoryRoot);
	assertStorageDirectory(root);
	const path = resolve(root, ".state-flow-publication.lock");
	const descriptor = acquirePublicationLock(path, (cause) => new RevisionUnavailableError(
		`State Flow publication lock is unavailable at ${JSON.stringify(path)}`, { cause },
	));
	try {
		writeFileSync(descriptor, `${process.pid}\n`);
		return action(root);
	} finally {
		closeSync(descriptor);
		rmSync(path);
	}
}

export interface StorageTransaction {
	readonly capture: typeof captureTemporalFileBase;
	readonly publish: typeof publishTemporalStateToFiles;
}

export class PublicationBusyError extends Error {
	constructor(path: string) { super(`State Flow publication lock is busy at ${JSON.stringify(path)}`); }
}

const storageLockContext = new AsyncLocalStorage<readonly { path: string; active: boolean }[]>();

/** Await an exact file mutex; shared by canonical transactions and the independent Git backup owner. */
export async function withFilePublicationLock<T>(
	lockPath: string, action: () => T | Promise<T>, signal?: AbortSignal,
	unavailable: (cause: unknown) => Error = (cause) => new RevisionUnavailableError(
		`State Flow publication lock is unavailable at ${JSON.stringify(resolve(lockPath))}`, { cause },
	), waitForLock = true,
): Promise<T> {
	const path = resolve(lockPath);
	const inherited = storageLockContext.getStore();
	if (inherited?.some((held) => held.active && held.path === path)) throw new Error(`Recursive State Flow publication lock at ${JSON.stringify(path)}`);
	let descriptor: number;
	let pendingSince: number | undefined;
	while (true) {
		signal?.throwIfAborted();
		assertStorageDirectory(dirname(path));
		try { descriptor = openSync(path, "wx", 0o600); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(error);
			let owner: ReturnType<typeof publicationLockOwner>;
			try { owner = publicationLockOwner(path, true); }
			catch (cause) { throw unavailable(cause); }
			if (owner === "unavailable") throw unavailable(error);
			if (!waitForLock) throw new PublicationBusyError(path);
			// An empty file may be between exclusive creation and PID publication, but not forever.
			if (owner === "pending") pendingSince ??= performance.now();
			else pendingSince = undefined;
			if (pendingSince !== undefined && performance.now() - pendingSince >= PUBLICATION_LOCK_WAIT_MS) throw unavailable(error);
		}
		await delay(PUBLICATION_LOCK_POLL_MS, undefined, { signal });
	}
	let identity: ReturnType<typeof fstatSync> | undefined;
	const held = { path, active: true };
	let failed: { error: unknown } | undefined;
	try {
		identity = fstatSync(descriptor);
		writeFileSync(descriptor, `${process.pid}\n`);
		signal?.throwIfAborted();
		return await storageLockContext.run([...(inherited?.filter((owner) => owner.active) ?? []), held], action);
	} catch (error) {
		failed = { error };
		throw error;
	} finally {
		held.active = false;
		try {
			const current = lstatSync(path, { throwIfNoEntry: false });
			if (!identity || !current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
				|| readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== `${process.pid}\n`) {
				throw new Error(`State Flow publication lock changed during transaction at ${JSON.stringify(path)}; current owner preserved`);
			}
			rmSync(path);
		} catch (error) {
			if (failed) throw new AggregateError([failed.error, error], "State Flow storage transaction and lock release failed");
			throw error;
		} finally {
			closeSync(descriptor);
		}
	}
}

/** Await store-wide exclusion, then capture/apply/publish through callback-scoped operations. */
export async function withStorageTransaction<T>(
	repositoryRoot: string, action: (transaction: StorageTransaction) => T | Promise<T>, signal?: AbortSignal, waitForLock = true,
): Promise<T> {
	const root = resolve(repositoryRoot);
	return withFilePublicationLock(resolve(root, ".state-flow-publication.lock"), async () => {
		let active = true;
		const guard = (requestedRoot: string): void => {
			if (!active) throw new Error("State Flow storage transaction has ended");
			if (resolve(requestedRoot) !== root) throw new Error("State Flow storage transaction belongs to a different store");
			signal?.throwIfAborted();
		};
		const transaction = Object.freeze<StorageTransaction>({
			capture: (cwd, sessionId, requestedRoot, sessionKey = sessionId) => {
				guard(requestedRoot);
				return { files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
			},
			publish: (cwd, sessionId, view, scopes, base, requestedRoot, runtime, sessionKey, provenance, runtimeOnly) => {
				guard(requestedRoot);
				return publishLockedTemporalStateToFiles(cwd, sessionId, view, scopes, base, root, runtime, sessionKey, provenance, runtimeOnly);
			},
		});
		try { return await action(transaction); }
		finally { active = false; }
	}, signal, undefined, waitForLock);
}

export function assertTemporalFileBase(expected: TemporalFileBase, current: TemporalFileBase): void {
	if (expected.files.length !== current.files.length || current.files.some((file, index) => {
		const previous = expected.files[index]!;
		return file.path !== previous.path || file.identity !== previous.identity;
	})) throw new Error("Temporal State Flow base or scope identity changed concurrently");
}

/** Plan exact canonical updates; lifecycle-only writes exclude semantic files and provenance. */
export function planTemporalPublication(
	cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[],
	current: TemporalFileBase, root: string, runtime?: SessionRuntime, runtimeOnly = false, sessionKey = sessionId,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>,
): { updates: OwnedFileUpdate[]; changedScopes: StateScope[] } {
	const candidates = temporalStateFileUpdates(cwd, sessionId, view, scopes, root, sessionKey);
	const files = new Map(current.files.map((file) => [file.path, file]));
	if (runtimeOnly && (scopes.length !== 0 || provenance !== undefined)) throw new Error("Runtime-only publication cannot write semantic scopes or artifact provenance");
	const changedScopes: StateScope[] = [];
	for (const scope of SCOPES) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
		const previous = parseScopeStream(files.get(paths.checkpoint)!.content, files.get(paths.patches)!.content, scope,
			scope === "cwd" ? cwd : undefined, files.get(paths.meta)!.content);
		if (runtimeOnly || (previous !== undefined && sameJson(previous, view.scopes[scope]))) continue;
		if (!scopes.includes(scope)) throw new Error(`Temporal scope update omitted a changed stream: ${scope}`);
		changedScopes.push(scope);
	}
	const provenanceUpdates: OwnedFileUpdate[] = [];
	// Every scope metadata file owns provenance and temporal boundaries beside semantic files.
	if (!runtimeOnly) {
		for (const scope of SCOPES) {
			const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
			const registry = provenance?.[scope] ?? parseScopeProvenance(files.get(paths.meta)!.content, paths.meta);
			const currentFile = files.get(paths.meta)!;
			if (!changedScopes.includes(scope)
				&& (provenance === undefined || sameJson(parseScopeProvenance(currentFile.content, paths.meta), registry))) continue;
			const content = serializeScopeMetadata(registry, view.scopes[scope], scope, scope === "cwd" ? cwd : undefined, currentFile.content);
			if (currentFile.content !== content) provenanceUpdates.push({ path: paths.meta, content });
		}
	}
	const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
	const previousRuntime = parseSessionRuntime(files.get(runtimePaths.config)!.content, files.get(runtimePaths.runtime)!.content, cwd, sessionId);
	if (previousRuntime !== undefined && changedScopes.length > 0 && runtime === undefined) throw new Error("Temporal semantic publication requires its session runtime cohort");
	const runtimeUpdates: OwnedFileUpdate[] = [];
	if (runtime !== undefined) {
		const sources = serializeSessionRuntime(runtime, cwd, sessionId);
		if (!sameJson(runtime.meta.lineage, view.lineage)) throw new Error("Runtime lineage does not match the temporal cohort");
		if (files.get(runtimePaths.config)!.content !== sources.config || files.get(runtimePaths.runtime)!.content !== sources.runtime) {
			runtimeUpdates.push({ path: runtimePaths.config, content: sources.config }, { path: runtimePaths.runtime, content: sources.runtime });
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
		const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope,
			scope === "cwd" ? cwd : undefined, files.get(paths.meta));
		if (!stream) throw new Error("Incomplete file-only temporal scope cohort");
		scopes[scope] = stream;
	}
	const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
	const runtime = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), cwd, sessionId);
	if (!runtime) throw new Error("Canonical recovery requires a complete session runtime");
	const view = { scopes, lineage: runtime.meta.lineage };
	validateTemporalState(view, MAX_HISTORY_LIMIT);
	const provenance: Record<StateScope, ArtifactProvenanceRegistry> = {
		global: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta),
		cwd: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta),
		session: parseScopeProvenance(files.get(paths.meta), paths.meta),
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

/** Publish a validated canonical cohort; runtimeOnly owns only session config/runtime files. */
export function publishTemporalStateToFiles(
	cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[],
	base: TemporalFileBase, root: string, runtime: SessionRuntime, sessionKey = sessionId,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>, runtimeOnly = false,
): { base: TemporalFileBase; revision: FileRevision; changed: boolean } {
	return withStoragePublicationLock(root, (locked) => publishLockedTemporalStateToFiles(
		cwd, sessionId, view, scopes, base, locked, runtime, sessionKey, provenance, runtimeOnly,
	));
}

/** Shared publication owner; callers must hold the matching store lock for the complete cohort. */
function publishLockedTemporalStateToFiles(
	cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[],
	base: TemporalFileBase, root: string, runtime: SessionRuntime, sessionKey = sessionId,
	provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>, runtimeOnly = false,
): { base: TemporalFileBase; revision: FileRevision; changed: boolean } {
	const current = { files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
	assertTemporalFileBase(base, current);
	const { updates } = planTemporalPublication(cwd, sessionId, view, scopes, current, root, runtime, runtimeOnly, sessionKey, provenance);
	const next = { files: temporalFileReceipts(current, updates) };
	decodeFileCohort(cwd, sessionId, root, next, sessionKey);
	const revision = fileRevision(next, root);
	publishFileUpdates(current.files, updates, root);
	return { base: next, revision, changed: updates.length > 0 };
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
