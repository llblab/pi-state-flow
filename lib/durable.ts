import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalJson, containsNull, isJsonValue } from "./json.ts";
import { validateScopeStream, validateTemporalState, type ScopeStream, type TemporalState } from "./temporal.ts";
import { isMaterializedState, type MaterializedState, type StateScope } from "./state.ts";

const MAX_SCOPE_SLUG_LENGTH = 80;
const SCOPE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,80}-[a-f0-9]{64}$/;
const STATE_FILE = "state.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PATCHES_FILE = "patches.jsonl";

/** Canonical replay sources; current state is deliberately not serialized beside the tail. */
export interface ScopeStreamSources {
	checkpoint: string;
	patches: string;
}

export function serializeScopeStream(stream: ScopeStream, scope: StateScope): ScopeStreamSources {
	validateScopeStream(stream, scope);
	return {
		checkpoint: `${canonicalJson(stream.checkpoint)}\n`,
		patches: stream.patches.map((record) => `${canonicalJson(record)}\n`).join(""),
	};
}

/** Decode the entire bounded replay input before accepting any materialized state. */
export function parseScopeStream(
	checkpointSource: string | undefined,
	patchesSource: string | undefined,
	scope: StateScope,
): ScopeStream | undefined {
	if (checkpointSource === undefined && patchesSource === undefined) return undefined;
	if (checkpointSource === undefined || patchesSource === undefined) {
		throw new Error(`State Flow ${scope} scope has an incomplete checkpoint/tail pair`);
	}
	let checkpoint: unknown;
	try {
		checkpoint = JSON.parse(checkpointSource);
	} catch {
		throw new Error(`State Flow ${scope} checkpoint contains invalid JSON`);
	}
	const patches: unknown[] = [];
	for (const [index, line] of patchesSource.split(/\r?\n/).entries()) {
		if (line.trim().length === 0) continue;
		try {
			patches.push(JSON.parse(line));
		} catch {
			throw new Error(`State Flow ${scope} tail contains invalid JSON at line ${index + 1}`);
		}
	}
	const stream = { checkpoint, patches };
	validateScopeStream(stream, scope);
	return stream;
}

export interface TemporalScopePaths {
	directory: string;
	checkpoint: string;
	patches: string;
}

export function temporalScopePaths(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string): TemporalScopePaths {
	const directory = scope === "global" ? resolve(repositoryRoot)
		: scope === "cwd" ? cwdScopePaths(cwd, repositoryRoot).directory
			: scope === "session" ? sessionScopePaths(cwd, sessionId, repositoryRoot).directory
				: undefined;
	if (directory === undefined) throw new Error("Unknown temporal scope");
	return { directory, checkpoint: join(directory, CHECKPOINT_FILE), patches: join(directory, PATCHES_FILE) };
}

export function sessionRuntimePaths(cwd: string, sessionId: string, repositoryRoot: string): { config: string; meta: string } {
	const directory = sessionScopePaths(cwd, sessionId, repositoryRoot).directory;
	return { config: join(directory, "config.json"), meta: join(directory, "meta.json") };
}

/** A temporal reader never treats a legacy current snapshot as an anchored checkpoint. */
export function loadScopeStream(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string): ScopeStream | undefined {
	const paths = temporalScopePaths(cwd, sessionId, scope, repositoryRoot);
	if (readRegularBytes(join(paths.directory, STATE_FILE), repositoryRoot) !== undefined) {
		throw new Error(`Legacy State Flow storage requires explicit migration: ${paths.directory}`);
	}
	return parseScopeStream(readRegularFile(paths.checkpoint, repositoryRoot), readRegularFile(paths.patches, repositoryRoot), scope);
}

/** Include legacy names in the CAS basis solely to prevent format races during cutover. */
export function captureTemporalFileBases(cwd: string, sessionId: string, repositoryRoot: string): DurableFileBase[] {
	const paths = (["global", "cwd", "session"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(cwd, sessionId, scope, repositoryRoot);
		const runtime = scope === "session" ? sessionRuntimePaths(cwd, sessionId, repositoryRoot) : undefined;
		return [pair.checkpoint, pair.patches, join(pair.directory, STATE_FILE), ...(runtime === undefined ? [] : [runtime.config, runtime.meta])];
	});
	return captureOwnedFileBases(paths, repositoryRoot);
}

/** Select exact serialized scope updates from one validated active temporal cohort. */
export function temporalStateFileUpdates(
	cwd: string,
	sessionId: string,
	view: TemporalState,
	scopes: readonly StateScope[],
	repositoryRoot: string,
): OwnedFileUpdate[] {
	validateTemporalState(view);
	const seen = new Set<StateScope>();
	return scopes.flatMap((scope) => {
		if (seen.has(scope)) throw new Error(`Duplicate temporal scope update: ${scope}`);
		seen.add(scope);
		const paths = temporalScopePaths(cwd, sessionId, scope, repositoryRoot);
		if (readRegularBytes(join(paths.directory, STATE_FILE), repositoryRoot) !== undefined) {
			throw new Error(`Legacy State Flow storage requires explicit migration: ${paths.directory}`);
		}
		const sources = serializeScopeStream(view.scopes[scope], scope);
		return [{ path: paths.checkpoint, content: sources.checkpoint }, { path: paths.patches, content: sources.patches }];
	});
}

export interface DurablePaths {
	repositoryRoot: string;
	globalState: string;
	globalPatches: string;
}

export interface ScopePaths {
	directory: string;
	state: string;
	patches: string;
}

export interface DurableFileBase {
	path: string;
	identity: "missing" | `sha256:${string}`;
	content?: string;
	/** Opaque originals for byte-exact rollback, including non-UTF-8 legacy journals. */
	bytes?: Uint8Array;
}

/** Dedicated runtime storage, independent from Markdown source discovery. */
export function getDurableRepositoryRoot(agentDir = getAgentDir()): string {
	return resolve(agentDir, "state-flow");
}

/** Legacy snapshot paths retained only for one-way migration and exact ownership checks. */
export function durablePaths(repositoryRoot = getDurableRepositoryRoot()): DurablePaths {
	const root = resolve(repositoryRoot);
	return {
		repositoryRoot: root,
		globalState: join(root, STATE_FILE),
		globalPatches: join(root, PATCHES_FILE),
	};
}

function readableScopeKey(identity: string, readable: string): string {
	if (identity.length === 0) throw new Error("State Flow scope identity must be non-empty");
	const slug = readable
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, MAX_SCOPE_SLUG_LENGTH) || "scope";
	const digest = createHash("sha256").update(identity).digest("hex");
	return `${slug}-${digest}`;
}

/** Follow Pi's readable CWD convention and append the full canonical-path hash. */
export function cwdScopeKey(cwd: string): string {
	const canonical = resolve(cwd);
	const piStyle = `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return readableScopeKey(canonical, piStyle);
}

/** Pi's immutable session ID is the canonical identity for one durable session layer. */
export function sessionScopeKey(sessionId: string): string {
	if (sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
		throw new Error("State Flow session identity must be a non-empty trimmed string");
	}
	return readableScopeKey(sessionId, sessionId);
}

export function cwdScopePaths(cwd: string, repositoryRoot = getDurableRepositoryRoot()): ScopePaths {
	const directory = join(resolve(repositoryRoot), cwdScopeKey(cwd));
	return { directory, state: join(directory, STATE_FILE), patches: join(directory, PATCHES_FILE) };
}

export function sessionScopePaths(
	cwd: string,
	sessionId: string,
	repositoryRoot = getDurableRepositoryRoot(),
): ScopePaths {
	const directory = join(cwdScopePaths(cwd, repositoryRoot).directory, sessionScopeKey(sessionId));
	return { directory, state: join(directory, STATE_FILE), patches: join(directory, PATCHES_FILE) };
}

export function cwdStatePath(cwd: string, repositoryRoot = getDurableRepositoryRoot()): string {
	return cwdScopePaths(cwd, repositoryRoot).state;
}

export function cwdPatchesPath(cwd: string, repositoryRoot = getDurableRepositoryRoot()): string {
	return cwdScopePaths(cwd, repositoryRoot).patches;
}

export function sessionStatePath(cwd: string, sessionId: string, repositoryRoot = getDurableRepositoryRoot()): string {
	return sessionScopePaths(cwd, sessionId, repositoryRoot).state;
}

export function sessionPatchesPath(cwd: string, sessionId: string, repositoryRoot = getDurableRepositoryRoot()): string {
	return sessionScopePaths(cwd, sessionId, repositoryRoot).patches;
}

/** Exact semantic file shapes, including legacy snapshots only during the storage cutover. */
export function isStateFlowOwnedPath(candidate: string, repositoryRoot = getDurableRepositoryRoot()): boolean {
	const root = resolve(repositoryRoot);
	const absolute = resolve(candidate);
	const global = durablePaths(root);
	if (absolute === global.globalState || absolute === global.globalPatches || absolute === join(root, CHECKPOINT_FILE)) return true;
	const segments = relative(root, absolute).split(sep);
	if (segments.length === 2) {
		return SCOPE_KEY_PATTERN.test(segments[0]!) && (segments[1] === STATE_FILE || segments[1] === CHECKPOINT_FILE || segments[1] === PATCHES_FILE);
	}
	if (segments.length === 3) {
		return SCOPE_KEY_PATTERN.test(segments[0]!)
			&& SCOPE_KEY_PATTERN.test(segments[1]!)
			&& (segments[2] === STATE_FILE || segments[2] === CHECKPOINT_FILE || segments[2] === PATCHES_FILE
				|| segments[2] === "config.json" || segments[2] === "meta.json");
	}
	return false;
}

function missing(error: unknown): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertWithinRepository(path: string, repositoryRoot: string): void {
	const child = relative(repositoryRoot, path);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error(`Durable State Flow path escapes its repository: ${path}`);
	}
}

/** Reject symlinked directory components instead of following them during reads or writes. */
function assertDirectoryChain(repositoryRoot: string, directory: string, create: boolean): boolean {
	const root = resolve(repositoryRoot);
	const target = resolve(directory);
	if (target !== root) assertWithinRepository(target, root);
	const relativeDirectory = relative(root, target);
	const directories = [root];
	if (relativeDirectory.length > 0) {
		let current = root;
		for (const segment of relativeDirectory.split(sep)) {
			current = join(current, segment);
			directories.push(current);
		}
	}
	for (const current of directories) {
		try {
			const metadata = lstatSync(current);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`Durable State Flow directory is not a regular directory: ${current}`);
			}
		} catch (error) {
			if (!missing(error)) throw error;
			if (!create) return false;
			mkdirSync(current);
		}
	}
	return true;
}

function readRegularBytes(path: string, repositoryRoot: string): Buffer | undefined {
	if (!assertDirectoryChain(repositoryRoot, dirname(path), false)) return undefined;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!fstatSync(descriptor).isFile()) {
			throw new Error(`Durable State Flow path is not a regular file: ${path}`);
		}
		return readFileSync(descriptor);
	} catch (error) {
		if (missing(error)) return undefined;
		if (error instanceof Error
			&& "code" in error
			&& (error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(`Durable State Flow path is not a regular file: ${path}`);
		}
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function readRegularFile(path: string, repositoryRoot: string): string | undefined {
	return readRegularBytes(path, repositoryRoot)?.toString("utf8");
}

function byteIdentity(bytes: Uint8Array | undefined): DurableFileBase["identity"] {
	return bytes === undefined ? "missing" : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fileBase(path: string, repositoryRoot: string): DurableFileBase {
	const bytes = readRegularBytes(path, repositoryRoot);
	if (bytes === undefined) return { path, identity: "missing" };
	return { path, identity: byteIdentity(bytes), content: bytes.toString("utf8"), bytes };
}

function assertCurrentBytes(path: string, root: string, expected: Uint8Array | undefined): void {
	if (byteIdentity(readRegularBytes(path, root)) !== byteIdentity(expected)) {
		throw new Error(`State Flow file conflict at ${path}; preserve concurrent bytes and reconcile before retrying`);
	}
}

/** Capture exact owned bytes for one compare-and-swap publication or migration cohort. */
export function captureOwnedFileBases(paths: readonly string[], repositoryRoot: string): DurableFileBase[] {
	const root = resolve(repositoryRoot);
	return paths.map((path) => {
		if (!isStateFlowOwnedPath(path, root)) throw new Error(`Cannot capture a non-State Flow path: ${path}`);
		return fileBase(resolve(path), root);
	});
}

function validateState(value: unknown, path: string): asserts value is MaterializedState {
	if (!isMaterializedState(value) || !isJsonValue(value) || containsNull(value)) {
		throw new Error(`Durable State Flow file has invalid materialized state: ${path}`);
	}
}

/** One-way legacy current-state interpretation; explanatory journals are not recovery input. */
export function parseStateSource(source: string | undefined, path: string): MaterializedState | undefined {
	if (source === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error(`Durable State Flow file contains invalid JSON: ${path}`);
	}
	validateState(value, path);
	return structuredClone(value);
}

interface PreparedFile {
	path: string;
	repositoryRoot: string;
	temporary: string;
	original?: Uint8Array;
	next?: Uint8Array;
}

function prepareFile(path: string, repositoryRoot: string, content: string | undefined, expected?: DurableFileBase): PreparedFile {
	assertWithinRepository(path, repositoryRoot);
	assertDirectoryChain(repositoryRoot, dirname(path), true);
	const original = readRegularBytes(path, repositoryRoot);
	if (expected !== undefined && byteIdentity(original) !== expected.identity) {
		throw new Error(`State Flow file conflict during preparation: ${path}`);
	}
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const next = content === undefined ? undefined : Buffer.from(content);
	if (next !== undefined) writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
	return { path, repositoryRoot, temporary, original, next };
}

function restorePrepared(prepared: PreparedFile): void {
	assertCurrentBytes(prepared.path, prepared.repositoryRoot, prepared.next);
	if (prepared.original === undefined) {
		rmSync(prepared.path, { force: true });
		return;
	}
	const rollback = join(dirname(prepared.path), `.${basename(prepared.path)}.${process.pid}.${randomUUID()}.rollback`);
	try {
		writeFileSync(rollback, prepared.original, { flag: "wx", mode: 0o600 });
		renameSync(rollback, prepared.path);
	} finally {
		rmSync(rollback, { force: true });
	}
}

function publishPrepared(prepared: PreparedFile[]): void {
	let published = 0;
	try {
		for (const item of prepared) {
			assertCurrentBytes(item.path, item.repositoryRoot, item.original);
			if (item.next === undefined) rmSync(item.path, { force: true });
			else renameSync(item.temporary, item.path);
			published += 1;
		}
	} catch (error) {
		let rollbackError: unknown;
		for (let index = published - 1; index >= 0; index--) {
			try {
				restorePrepared(prepared[index]!);
			} catch (failure) {
				rollbackError ??= failure;
			}
		}
		if (rollbackError !== undefined) {
			throw new AggregateError([error, rollbackError], "Durable State Flow transition publication and rollback failed");
		}
		throw error;
	} finally {
		for (const item of prepared) rmSync(item.temporary, { force: true });
	}
}

export interface OwnedFileUpdate {
	path: string;
	/** Omission means removal of this exact owned file, not a semantic null patch. */
	content?: string;
}

/** Verify the publisher's exact output before commit or rollback, without trusting changed worktree bytes. */
export function assertOwnedFileUpdates(updates: readonly OwnedFileUpdate[], repositoryRoot: string): void {
	const root = resolve(repositoryRoot);
	for (const update of updates) {
		if (!isStateFlowOwnedPath(update.path, root)) throw new Error(`Cannot inspect a non-State Flow path: ${update.path}`);
		assertCurrentBytes(update.path, root, update.content === undefined ? undefined : Buffer.from(update.content));
	}
}

/** Publish a prevalidated file cohort, preserving original bytes for failed preparation/publication. */
export function writeOwnedFileUpdates(
	updates: readonly OwnedFileUpdate[],
	bases: readonly DurableFileBase[],
	repositoryRoot: string,
): string[] {
	const root = resolve(repositoryRoot);
	const byPath = new Map(bases.map((base) => [resolve(base.path), base]));
	const seen = new Set<string>();
	const prepared: PreparedFile[] = [];
	try {
		for (const update of updates) {
			const path = resolve(update.path);
			if (!isStateFlowOwnedPath(path, root)) throw new Error(`Cannot update a non-State Flow path: ${path}`);
			if (seen.has(path)) throw new Error(`Duplicate State Flow file update: ${path}`);
			seen.add(path);
			const base = byPath.get(path);
			if (base === undefined) throw new Error(`State Flow file update has no captured base: ${path}`);
			prepared.push(prepareFile(path, root, update.content, base));
		}
	} catch (error) {
		for (const item of prepared) rmSync(item.temporary, { force: true });
		throw error;
	}
	publishPrepared(prepared);
	return prepared.map(({ path }) => path);
}

/** Restore exact pre-transition bytes only while files still match this publisher's output. */
export function restoreDurableFileBases(
	bases: readonly DurableFileBase[],
	repositoryRoot: string,
	expectedCurrent: readonly OwnedFileUpdate[],
): void {
	const root = resolve(repositoryRoot);
	const expected = new Map(expectedCurrent.map((update) => [resolve(update.path), update]));
	for (const base of bases) {
		assertWithinRepository(base.path, root);
		if (!isStateFlowOwnedPath(base.path, root)) {
			throw new Error(`Cannot restore a non-State Flow path: ${base.path}`);
		}
	}
	for (const base of bases) {
		const update = expected.get(resolve(base.path));
		if (update === undefined) throw new Error(`Rollback has no published basis: ${base.path}`);
		assertCurrentBytes(base.path, root, update.content === undefined ? undefined : Buffer.from(update.content));
		if (base.identity === "missing") {
			rmSync(base.path, { force: true });
			continue;
		}
		const original = base.bytes ?? (base.content === undefined ? undefined : Buffer.from(base.content));
		if (original === undefined) throw new Error(`Durable State Flow base content is missing: ${base.path}`);
		assertDirectoryChain(root, dirname(base.path), true);
		const temporary = join(dirname(base.path), `.${basename(base.path)}.${process.pid}.${randomUUID()}.restore`);
		try {
			writeFileSync(temporary, original, { flag: "wx", mode: 0o600 });
			renameSync(temporary, base.path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}
