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
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	parseArtifactProvenanceRegistry,
	serializeArtifactProvenanceRegistry,
	type ArtifactProvenanceRegistry,
} from "./artifact.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { parseScopeMetadataHeader, prepareSerializedScopeMigration, type ScopeMigrationSources } from "./migration.ts";
import { canonicalJson, decodeJson, decodeUtf8, InvalidStateFlowData, isJsonValue, isObject, sameJson, type JsonObject } from "./json.ts";
import { validateScopeStream, validateTemporalState, type ScopeStream, type TemporalState } from "./temporal.ts";
import { assertRetainedModules, validateRetainedModules } from "./semantic-module.ts";
import { selectSemanticFields, type StateScope } from "./state.ts";

const SESSION_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const STATE_FILE = "state.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PATCHES_FILE = "patches.jsonl";
const META_FILE = "meta.json";
const RUNTIME_FILE = "runtime.json";

/** Canonical semantic sources plus runtime-owned temporal metadata. */
export interface ScopeStreamSources {
	checkpoint: string;
	patches: string;
	temporal: ScopeTemporalMetadata;
}

/** Read-only activation eligibility for one canonical CWD scope. */
export function hasCwdMaterialization(cwd: string, repositoryRoot: string): boolean {
	return loadScopeStream(cwd, "", "cwd", repositoryRoot) !== undefined;
}

export interface ScopeTemporalMetadata {
	revision: number;
	checkpoint: ScopeStream["checkpoint"]["through"];
	patches: ScopeStream["patches"][number]["transition"][];
}

export interface SessionAddress {
	readonly id: string;
	readonly key: string;
}

/** Semantic files contain no runtime envelope; temporal boundaries and CWD ownership live in meta.json. */
export function serializeScopeStream(stream: ScopeStream, scope: StateScope, cwdIdentity?: string): ScopeStreamSources {
	validateScopeStream(stream, scope, MAX_HISTORY_LIMIT);
	if (scope === "cwd" && cwdIdentity === undefined) throw new Error("State Flow CWD scope serialization requires its canonical identity");
	if (scope !== "cwd" && cwdIdentity !== undefined) throw new Error("Only State Flow CWD scope serialization accepts a CWD identity");
	return {
		checkpoint: `${canonicalJson(selectSemanticFields(stream.checkpoint.state, stream.modules))}\n`,
		patches: stream.patches.map((record) => `${canonicalJson(selectSemanticFields(record.patch as JsonObject, stream.modules))}\n`).join(""),
		temporal: {
			revision: stream.revision,
			checkpoint: structuredClone(stream.checkpoint.through),
			patches: stream.patches.map((record) => structuredClone(record.transition)),
		},
	};
}

export type ScopeStreamPresence =
	| { kind: "absent" }
	| { kind: "present"; stream: ScopeStream };

function isSupportedScopeMetadataVersion(version: unknown): boolean {
	return version === 3 || version === 4;
}

/** Distinguish a wholly absent semantic cohort from partial or malformed surviving authority. */
export function classifyScopeStream(
	checkpointSource: string | undefined,
	patchesSource: string | undefined,
	scope: StateScope,
	expectedCwd?: string,
	metaSource?: string,
): ScopeStreamPresence {
	if (scope !== "global" && scope !== "cwd" && scope !== "session") throw new Error("Unknown temporal scope");
	if (metaSource !== undefined) parseScopeMetadataHeader(metaSource, scope, scope === "cwd" ? expectedCwd : undefined);
	if (checkpointSource === undefined && patchesSource === undefined && metaSource === undefined) return { kind: "absent" };
	if (checkpointSource === undefined || patchesSource === undefined) {
		throw new InvalidStateFlowData(`State Flow ${scope} scope has an incomplete checkpoint/tail pair`);
	}
	if (metaSource === undefined) {
		decodeJson(checkpointSource, `State Flow ${scope} checkpoint`);
		for (const [index, line] of patchesSource.split(/\r?\n/).entries()) {
			if (line.trim().length !== 0) decodeJson(line, `State Flow ${scope} tail at line ${index + 1}`);
		}
		throw new Error(`Unsupported State Flow ${scope} storage format`);
	}
	// In Unicode mode this range matches lone UTF-16 surrogates, not valid pairs or JSON escapes.
	if ([checkpointSource, patchesSource, metaSource].some((source) => /[\uD800-\uDFFF]/u.test(source))) {
		throw new InvalidStateFlowData(`State Flow ${scope} source is not lossless UTF-8 text`);
	}
	return { kind: "present", stream: decodeScopeStream({
		checkpoint: Buffer.from(checkpointSource), patches: Buffer.from(patchesSource), meta: Buffer.from(metaSource),
	}, scope, expectedCwd) };
}

/** Decode opaque sources through the same semantic admission path used for conversion. */
export function decodeScopeStream(sources: ScopeMigrationSources, scope: StateScope, expectedCwd?: string): ScopeStream {
	const decoded = prepareSerializedScopeMigration(sources, scope, scope === "cwd" ? expectedCwd : undefined);
	const stream = {
		...decoded.stream,
		checkpoint: { ...decoded.stream.checkpoint, state: selectSemanticFields(decoded.stream.checkpoint.state, decoded.stream.modules) },
		patches: decoded.stream.patches.map((record) => ({ ...record, patch: selectSemanticFields(record.patch as JsonObject, decoded.stream.modules) })),
	};
	validateScopeStream(stream, scope, MAX_HISTORY_LIMIT);
	return stream;
}

/** Decode the entire bounded replay input before accepting any materialized state. */
export function parseScopeStream(
	checkpointSource: string | undefined,
	patchesSource: string | undefined,
	scope: StateScope,
	expectedCwd?: string,
	metaSource?: string,
): ScopeStream | undefined {
	const presence = classifyScopeStream(checkpointSource, patchesSource, scope, expectedCwd, metaSource);
	return presence.kind === "present" ? presence.stream : undefined;
}

export interface TemporalScopePaths {
	directory: string;
	checkpoint: string;
	patches: string;
	/** Runtime-owned artifact provenance for this scope; the session file also owns runtime lineage. */
	meta: string;
}

export function temporalScopePaths(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string, sessionKey = sessionId): TemporalScopePaths {
	const directory = scope === "global" ? resolve(repositoryRoot)
		: scope === "cwd" ? cwdScopePaths(cwd, repositoryRoot).directory
			: scope === "session" ? sessionScopePaths(cwd, sessionId, repositoryRoot, sessionKey).directory
				: undefined;
	if (directory === undefined) throw new Error("Unknown temporal scope");
	return { directory, checkpoint: join(directory, CHECKPOINT_FILE), patches: join(directory, PATCHES_FILE), meta: join(directory, META_FILE) };
}

export function sessionRuntimePaths(cwd: string, sessionId: string, repositoryRoot: string, sessionKey = sessionId): { config: string; runtime: string; meta: string } {
	const directory = sessionScopePaths(cwd, sessionId, repositoryRoot, sessionKey).directory;
	return { config: join(directory, "config.json"), runtime: join(directory, RUNTIME_FILE), meta: join(directory, META_FILE) };
}

/** Unsupported state.json presence never becomes an anchored checkpoint. */
export function loadScopeStream(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string, sessionKey = sessionId): ScopeStream | undefined {
	const paths = temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey);
	if (captureOwnedFilePresence([join(paths.directory, STATE_FILE)], repositoryRoot)[0]!.present) {
		throw new Error(`Unsupported State Flow storage format: ${JSON.stringify(paths.directory)}`);
	}
	const meta = readRegularBytes(paths.meta, repositoryRoot);
	if (meta !== undefined) parseScopeMetadataHeader(decodeUtf8(meta, `State Flow ${scope} metadata`), scope, scope === "cwd" ? cwd : undefined);
	const checkpoint = readRegularBytes(paths.checkpoint, repositoryRoot);
	const patches = readRegularBytes(paths.patches, repositoryRoot);
	if (meta !== undefined) return decodeScopeStream({ checkpoint, patches, meta }, scope, cwd);
	return parseScopeStream(checkpoint && decodeUtf8(checkpoint, `State Flow ${scope} checkpoint`),
		patches && decodeUtf8(patches, `State Flow ${scope} tail`), scope, scope === "cwd" ? cwd : undefined);
}

/** Include unsupported predecessor names in the CAS basis so they cannot race canonical publication. */
export function captureTemporalFileBases(cwd: string, sessionId: string, repositoryRoot: string, sessionKey = sessionId): DurableFileBase[] {
	const paths = (["global", "cwd", "session"] as const).flatMap((scope) => {
		const pair = temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey);
		const runtime = scope === "session" ? sessionRuntimePaths(cwd, sessionId, repositoryRoot, sessionKey) : undefined;
		return [pair.checkpoint, pair.patches, ...(runtime === undefined ? [pair.meta] : [runtime.config, runtime.runtime, runtime.meta])];
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
	sessionKey = sessionId,
): OwnedFileUpdate[] {
	validateTemporalState(view, MAX_HISTORY_LIMIT);
	const seen = new Set<StateScope>();
	return scopes.flatMap((scope) => {
		if (seen.has(scope)) throw new Error(`Duplicate temporal scope update: ${scope}`);
		seen.add(scope);
		const paths = temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey);
		if (readRegularBytes(join(paths.directory, STATE_FILE), repositoryRoot) !== undefined) {
			throw new Error(`Unsupported State Flow storage format: ${JSON.stringify(paths.directory)}`);
		}
		const sources = serializeScopeStream(view.scopes[scope], scope, scope === "cwd" ? cwd : undefined);
		return [{ path: paths.checkpoint, content: sources.checkpoint }, { path: paths.patches, content: sources.patches }];
	});
}

/** Merge authoritative owned leaves while preserving forward-compatible metadata siblings. */
export function serializeScopeMetadata(
	registry: Readonly<ArtifactProvenanceRegistry> | undefined, stream: ScopeStream, scope: StateScope,
	cwdIdentity?: string, existingSource?: string,
): string {
	const existing = parseMetadataDocument(existingSource, `State Flow metadata`);
	if (Object.keys(existing).length > 0 && !isSupportedScopeMetadataVersion(existing.version)) {
		throw new Error("Unsupported State Flow metadata version");
	}
	if (existing.version === 4) assertRetainedModules(existing.modules, stream.modules);
	const sources = serializeScopeStream(stream, scope, cwdIdentity);
	const value = {
		...existing,
		version: stream.modules === undefined ? 3 : 4,
		...(stream.modules === undefined ? {} : { modules: structuredClone(stream.modules) }),
		...(registry === undefined ? {} : { artifacts: serializeArtifactProvenanceRegistry(registry) }),
		temporal: { ...(isObject(existing.temporal) ? existing.temporal : {}), ...sources.temporal },
		...(scope === "cwd" ? { owner: { cwd: resolve(cwdIdentity!) } } : {}),
	};
	return `${canonicalJson(value)}\n`;
}

/** Compatibility serializer retained for metadata-only callers. */
export function serializeScopeProvenance(registry: Readonly<ArtifactProvenanceRegistry>): string {
	return `${canonicalJson({ version: 3, artifacts: serializeArtifactProvenanceRegistry(registry) })}\n`;
}

function parseMetadataDocument(source: string | undefined, label: string): Record<string, unknown> {
	if (source === undefined) return {};
	const value = decodeJson(source, label);
	if (!isObject(value) || !isJsonValue(value)) throw new InvalidStateFlowData(`Invalid ${label}`);
	return value;
}

/** Missing provenance is unavailable evidence, never corrupt state. Unknown metadata is preserved by writers. */
export function parseScopeProvenance(source: string | undefined, path: string): ArtifactProvenanceRegistry {
	const value = parseMetadataDocument(source, `State Flow provenance file: ${JSON.stringify(path)}`);
	if (Object.keys(value).length === 0) return {};
	if (!isSupportedScopeMetadataVersion(value.version)) throw new Error(`Invalid State Flow provenance document: ${JSON.stringify(path)}`);
	if (value.version === 4) validateRetainedModules(value.modules);
	if (!Object.hasOwn(value, "artifacts")) return {};
	return parseArtifactProvenanceRegistry(value.artifacts, `State Flow provenance at ${JSON.stringify(path)}`);
}

export interface ScopePaths {
	directory: string;
}

export interface DurableFileBase {
	path: string;
	identity: "missing" | `sha256:${string}`;
	content?: string;
	/** Opaque originals for byte-exact rollback. */
	bytes?: Uint8Array;
}

/** Dedicated runtime storage, independent from Markdown source discovery. */
export function getDurableRepositoryRoot(agentDir = getAgentDir()): string {
	return resolve(agentDir, "state-flow");
}

/** Match Pi's native project-session directory convention exactly. */
export function cwdScopeKey(cwd: string): string {
	const canonical = resolve(cwd);
	return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** One safe directory segment, normally the native Pi session filename stem. */
export function sessionScopeKey(key: string): string {
	if (!SESSION_KEY_PATTERN.test(key)) throw new Error("State Flow session storage key must be one Pi-safe path segment");
	return key;
}

/** Prefer the actual native file stem; reproduce it from the immutable header when in-memory. */
export function sessionStorageKey(sessionFile: string | undefined, sessionId: string, timestamp?: string): string {
	if (sessionFile !== undefined) {
		const name = basename(sessionFile);
		if (!name.endsWith(".jsonl")) throw new Error("State Flow session file must use Pi's .jsonl format");
		return sessionScopeKey(name.slice(0, -".jsonl".length));
	}
	if (timestamp !== undefined) return sessionScopeKey(`${timestamp.replace(/[:.]/g, "-")}_${sessionId}`);
	return sessionScopeKey(sessionId);
}

export function resolveSessionAddress(sessionFile: string | undefined, sessionId: string, timestamp?: string): SessionAddress {
	if (sessionId.trim().length === 0 || sessionId !== sessionId.trim()) throw new Error("State Flow session identity must be non-empty and trimmed");
	return Object.freeze({ id: sessionId, key: sessionStorageKey(sessionFile, sessionId, timestamp) });
}

export function cwdScopePaths(cwd: string, repositoryRoot = getDurableRepositoryRoot()): ScopePaths {
	return { directory: join(resolve(repositoryRoot), cwdScopeKey(cwd)) };
}

export function sessionScopePaths(
	cwd: string,
	sessionId: string,
	repositoryRoot = getDurableRepositoryRoot(),
	sessionKey = sessionId,
): ScopePaths {
	return { directory: join(cwdScopePaths(cwd, repositoryRoot).directory, sessionScopeKey(sessionKey)) };
}

/** Exact canonical semantic and runtime file shapes. */
export function isStateFlowOwnedPath(candidate: string, repositoryRoot = getDurableRepositoryRoot()): boolean {
	const root = resolve(repositoryRoot);
	const absolute = resolve(candidate);
	if (absolute === join(root, CHECKPOINT_FILE) || absolute === join(root, PATCHES_FILE)
		|| absolute === join(root, META_FILE)) return true;
	const segments = relative(root, absolute).split(sep);
	const cwdKey = (value: string) => value.startsWith("--") && value.endsWith("--");
	const sessionKey = (value: string) => {
		try { return sessionScopeKey(value) === value; } catch { return false; }
	};
	if (segments.length === 2) {
		return cwdKey(segments[0]!) && (segments[1] === CHECKPOINT_FILE || segments[1] === PATCHES_FILE || segments[1] === META_FILE);
	}
	if (segments.length === 3) {
		return cwdKey(segments[0]!)
			&& sessionKey(segments[1]!)
			&& (segments[2] === CHECKPOINT_FILE || segments[2] === PATCHES_FILE
				|| segments[2] === "config.json" || segments[2] === RUNTIME_FILE || segments[2] === META_FILE);
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
		throw new Error(`Durable State Flow path escapes its repository: ${JSON.stringify(path)}`);
	}
}

/** Reject symlinked directory components instead of following them during reads or writes. */
function assertDirectoryChain(repositoryRoot: string, directory: string, create: boolean, capture?: (path: string, identity: string) => void): boolean {
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
			const metadata = capture ? lstatSync(current, { bigint: true }) : lstatSync(current);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`Durable State Flow directory is not a regular directory: ${JSON.stringify(current)}`);
			}
			capture?.(current, `${metadata.dev}:${metadata.ino}`);
		} catch (error) {
			if (!missing(error)) throw error;
			if (!create) return false;
			mkdirSync(current);
		}
	}
	return true;
}

/** Capture physical ancestry without opening file bodies or creating directories. */
export function captureDirectoryBasis(directories: readonly string[]): Record<string, string> {
	const basis: Record<string, string> = {};
	for (const directory of directories) {
		const absolute = resolve(directory);
		assertDirectoryChain(parse(absolute).root, absolute, false, (path, identity) => { basis[path] = identity; });
	}
	return basis;
}

function readRegularBytes(path: string, repositoryRoot: string): Buffer | undefined {
	if (!assertDirectoryChain(repositoryRoot, dirname(path), false)) return undefined;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if (!fstatSync(descriptor).isFile()) {
			throw new Error(`Durable State Flow path is not a regular file: ${JSON.stringify(path)}`);
		}
		return readFileSync(descriptor);
	} catch (error) {
		if (missing(error)) return undefined;
		if (error instanceof Error
			&& "code" in error
			&& (error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(`Durable State Flow path is not a regular file: ${JSON.stringify(path)}`);
		}
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
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
		throw new Error(`State Flow file conflict at ${JSON.stringify(path)}; concurrent bytes preserved`);
	}
}

export interface OwnedFilePresence { path: string; present: boolean }

/** Presence-only private-origin/unsupported-layout evidence; never open or decode semantic bodies. */
export function captureOwnedFilePresence(paths: readonly string[], repositoryRoot: string): OwnedFilePresence[] {
	const root = resolve(repositoryRoot);
	return paths.map((requested) => {
		const path = resolve(requested);
		const retiredLayout = basename(path) === STATE_FILE && isStateFlowOwnedPath(join(dirname(path), CHECKPOINT_FILE), root);
		if (!isStateFlowOwnedPath(path, root) && !retiredLayout) throw new Error(`Cannot inspect a non-State Flow path: ${JSON.stringify(path)}`);
		if (!assertDirectoryChain(root, dirname(path), false)) return { path, present: false };
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Durable State Flow path is not a regular file: ${JSON.stringify(path)}`);
		return { path, present: stat !== undefined };
	});
}

/** Capture exact owned bytes for one compare-and-swap publication cohort. */
export function captureOwnedFileBases(paths: readonly string[], repositoryRoot: string): DurableFileBase[] {
	const root = resolve(repositoryRoot);
	return paths.map((path) => {
		if (!isStateFlowOwnedPath(path, root)) throw new Error(`Cannot capture a non-State Flow path: ${JSON.stringify(path)}`);
		return fileBase(resolve(path), root);
	});
}

interface PreparedFile {
	path: string;
	repositoryRoot: string;
	directories?: Record<string, string>;
	temporary?: string;
	original?: Uint8Array;
	next?: Uint8Array;
}

function prepareFile(path: string, repositoryRoot: string, content: string | undefined, expected: DurableFileBase, physical: boolean): PreparedFile {
	assertWithinRepository(path, repositoryRoot);
	const directory = dirname(path);
	const next = content === undefined ? undefined : Buffer.from(content);
	if (next !== undefined) assertDirectoryChain(repositoryRoot, directory, true);
	const directories = physical ? captureDirectoryBasis([directory]) : undefined;
	const original = readRegularBytes(path, repositoryRoot);
	if (byteIdentity(original) !== expected.identity) {
		throw new Error(`State Flow file conflict during preparation: ${JSON.stringify(path)}`);
	}
	const file: PreparedFile = { path, repositoryRoot, original, next, directories };
	if (next !== undefined) {
		const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
		writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
		file.temporary = temporary;
	}
	return file;
}

function assertPreparedDirectory(file: PreparedFile): void {
	if (file.directories && !sameJson(file.directories, captureDirectoryBasis([dirname(file.path)]))) {
		throw new Error(`State Flow directory identity changed at ${JSON.stringify(file.path)}; concurrent files preserved`);
	}
}

function assertPreparedBytes(file: PreparedFile, bytes: Uint8Array | undefined): void {
	assertPreparedDirectory(file);
	assertCurrentBytes(file.path, file.repositoryRoot, bytes);
}

function restorePrepared(file: PreparedFile, cleanup: unknown[]): void {
	assertPreparedBytes(file, file.next);
	if (file.original === undefined) {
		rmSync(file.path);
		return;
	}
	const rollback = join(dirname(file.path), `.${basename(file.path)}.${process.pid}.${randomUUID()}.rollback`);
	writeFileSync(rollback, file.original, { flag: "wx", mode: 0o600 });
	let renamed = false;
	try {
		assertPreparedBytes(file, file.next);
		renameSync(rollback, file.path);
		renamed = true;
	} finally {
		if (!renamed) try {
			assertPreparedDirectory(file);
			rmSync(rollback, { force: true });
		} catch (error) { cleanup.push(error); }
	}
}

export interface OwnedFileUpdate {
	path: string;
	/** Omission means removal of this exact owned file, not a semantic null patch. */
	content?: string;
}

/** A caught publication failure, with evidence about its actual canonical effects. */
export class OwnedFilePublicationError extends AggregateError {
	readonly effect: "unchanged" | "restored" | "incomplete";
	readonly unresolvedPaths: readonly string[];

	constructor(causes: unknown[], effect: OwnedFilePublicationError["effect"], unresolvedPaths: readonly string[]) {
		const first = causes[0];
		const message = first instanceof Error ? first.message : "State Flow owned file publication failed";
		super(causes, effect === "incomplete" ? `${message}; State Flow file rollback incomplete` : message);
		this.effect = effect;
		this.unresolvedPaths = [...unresolvedPaths];
	}
}

/** Publish and verify one provisional cohort; restore every touched path still owned by this operation. */
export function writeOwnedFileUpdates(
	updates: readonly OwnedFileUpdate[],
	bases: readonly DurableFileBase[],
	repositoryRoot: string,
	checkDependencies?: (phase: "before" | "after") => void,
): string[] {
	const root = resolve(repositoryRoot);
	const byPath = new Map(bases.map((base) => [resolve(base.path), base]));
	const seen = new Set<string>();
	const prepared: PreparedFile[] = [], applied: PreparedFile[] = [];
	let attempting: PreparedFile | undefined;
	try {
		for (const update of updates) {
			const path = resolve(update.path);
			if (!isStateFlowOwnedPath(path, root)) throw new Error(`Cannot update a non-State Flow path: ${JSON.stringify(path)}`);
			if (seen.has(path)) throw new Error(`Duplicate State Flow file update: ${JSON.stringify(path)}`);
			seen.add(path);
			const base = byPath.get(path);
			if (base === undefined) throw new Error(`State Flow file update has no captured base: ${JSON.stringify(path)}`);
			prepared.push(prepareFile(path, root, update.content, base, checkDependencies !== undefined));
		}
		checkDependencies?.("before");
		for (const file of prepared) {
			assertPreparedBytes(file, file.original);
			if (file.temporary === undefined && file.original === undefined) continue;
			attempting = file;
			if (file.temporary === undefined) rmSync(file.path);
			else {
				renameSync(file.temporary, file.path);
				delete file.temporary;
			}
			applied.push(file);
			attempting = undefined;
		}
		for (const file of prepared) assertPreparedBytes(file, file.next);
		checkDependencies?.("after");
		return prepared.map(({ path }) => path);
	} catch (error) {
		const causes: unknown[] = [error];
		const unresolved: string[] = [];
		// A syscall that threw without retaining its original bytes cannot certify ownership of its output.
		const verifyRestored = (file: PreparedFile): void => {
			try { assertPreparedBytes(file, file.original); }
			catch (failure) { causes.push(failure); unresolved.push(file.path); }
		};
		for (const file of applied.reverse()) {
			try { restorePrepared(file, causes); }
			catch (failure) { causes.push(failure); }
		}
		for (const file of prepared) if (file.temporary !== undefined) {
			try {
				assertPreparedDirectory(file);
				rmSync(file.temporary, { force: true });
			} catch (failure) { causes.push(failure); }
		}
		if (attempting) verifyRestored(attempting);
		for (const file of applied) verifyRestored(file);
		if (!applied.length && causes.length === 1) throw error;
		throw new OwnedFilePublicationError(causes, unresolved.length ? "incomplete" : applied.length ? "restored" : "unchanged", unresolved);
	}
}
