import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseArtifactProvenanceRegistry, serializeArtifactProvenanceRegistry, } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, isJsonValue, isObject } from "./json.js";
import { validateScopeStream, validateTemporalState } from "./temporal.js";
const SESSION_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const STATE_FILE = "state.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PATCHES_FILE = "patches.jsonl";
const META_FILE = "meta.json";
const RUNTIME_FILE = "runtime.json";
/** Read-only activation eligibility for one canonical CWD scope. */
export function hasCwdMaterialization(cwd, repositoryRoot) {
    const root = resolve(repositoryRoot);
    const directory = cwdScopePaths(cwd, root).directory;
    const [checkpoint, patches, meta] = captureOwnedFileBases([
        join(directory, CHECKPOINT_FILE), join(directory, PATCHES_FILE), join(directory, META_FILE),
    ], root);
    if (checkpoint.content !== undefined)
        return parseScopeStream(checkpoint.content, patches.content, "cwd", cwd, meta.content) !== undefined;
    if (patches.content !== undefined)
        throw new Error(`State Flow tail has no provable checkpoint: ${JSON.stringify(directory)}`);
    return false;
}
/** Semantic files contain no runtime envelope; temporal boundaries and CWD ownership live in meta.json. */
export function serializeScopeStream(stream, scope, cwdIdentity) {
    validateScopeStream(stream, scope, MAX_HISTORY_LIMIT);
    if (scope === "cwd" && cwdIdentity === undefined)
        throw new Error("State Flow CWD scope serialization requires its canonical identity");
    if (scope !== "cwd" && cwdIdentity !== undefined)
        throw new Error("Only State Flow CWD scope serialization accepts a CWD identity");
    return {
        checkpoint: `${canonicalJson(stream.checkpoint.state)}\n`,
        patches: stream.patches.map((record) => `${canonicalJson(record.patch)}\n`).join(""),
        temporal: {
            revision: stream.revision,
            checkpoint: structuredClone(stream.checkpoint.through),
            patches: stream.patches.map((record) => structuredClone(record.transition)),
        },
    };
}
/** Distinguish a wholly absent semantic cohort from partial or malformed surviving authority. */
export function classifyScopeStream(checkpointSource, patchesSource, scope, expectedCwd, metaSource) {
    if (scope !== "global" && scope !== "cwd" && scope !== "session")
        throw new Error("Unknown temporal scope");
    if (checkpointSource === undefined && patchesSource === undefined)
        return { kind: "absent" };
    if (checkpointSource === undefined || patchesSource === undefined) {
        throw new Error(`State Flow ${scope} scope has an incomplete checkpoint/tail pair`);
    }
    let checkpoint;
    try {
        checkpoint = JSON.parse(checkpointSource);
    }
    catch {
        throw new Error(`State Flow ${scope} checkpoint contains invalid JSON`);
    }
    let meta;
    if (metaSource !== undefined) {
        try {
            meta = JSON.parse(metaSource);
        }
        catch {
            throw new Error(`State Flow ${scope} metadata contains invalid JSON`);
        }
        if (!isObject(meta))
            throw new Error(`Invalid State Flow ${scope} metadata`);
    }
    const patches = [];
    for (const [index, line] of patchesSource.split(/\r?\n/).entries()) {
        if (line.trim().length === 0)
            continue;
        try {
            patches.push(JSON.parse(line));
        }
        catch {
            throw new Error(`State Flow ${scope} tail contains invalid JSON at line ${index + 1}`);
        }
    }
    const temporal = meta?.temporal;
    if (!isObject(temporal) || !Object.hasOwn(temporal, "checkpoint") || !Array.isArray(temporal.patches)) {
        throw new Error(`Unsupported State Flow ${scope} storage format`);
    }
    const owner = meta?.owner;
    if (scope === "cwd" && expectedCwd !== undefined
        && (!isObject(owner) || Object.keys(owner).join(",") !== "cwd" || owner.cwd !== resolve(expectedCwd))) {
        throw new Error(owner === undefined ? "State Flow CWD scope identity is missing" : "State Flow CWD scope identity mismatch");
    }
    const boundaries = temporal.patches;
    if (boundaries.length !== patches.length)
        throw new Error(`State Flow ${scope} temporal metadata does not match its semantic tail`);
    const stream = {
        // 0.17.4 and earlier did not persist scope revisions. Credit only their still-retained
        // semantic tail; discarded ancestry cannot be reconstructed without inventing history.
        revision: temporal.revision === undefined ? patches.length : temporal.revision,
        checkpoint: { through: temporal.checkpoint, state: checkpoint },
        patches: patches.map((patch, index) => ({ transition: boundaries[index], patch })),
    };
    validateScopeStream(stream, scope, MAX_HISTORY_LIMIT);
    return { kind: "present", stream };
}
/** Decode the entire bounded replay input before accepting any materialized state. */
export function parseScopeStream(checkpointSource, patchesSource, scope, expectedCwd, metaSource) {
    const presence = classifyScopeStream(checkpointSource, patchesSource, scope, expectedCwd, metaSource);
    return presence.kind === "present" ? presence.stream : undefined;
}
export function temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey = sessionId) {
    const directory = scope === "global" ? resolve(repositoryRoot)
        : scope === "cwd" ? cwdScopePaths(cwd, repositoryRoot).directory
            : scope === "session" ? sessionScopePaths(cwd, sessionId, repositoryRoot, sessionKey).directory
                : undefined;
    if (directory === undefined)
        throw new Error("Unknown temporal scope");
    return { directory, checkpoint: join(directory, CHECKPOINT_FILE), patches: join(directory, PATCHES_FILE), meta: join(directory, META_FILE) };
}
export function sessionRuntimePaths(cwd, sessionId, repositoryRoot, sessionKey = sessionId) {
    const directory = sessionScopePaths(cwd, sessionId, repositoryRoot, sessionKey).directory;
    return { config: join(directory, "config.json"), runtime: join(directory, RUNTIME_FILE), meta: join(directory, META_FILE) };
}
/** Unsupported state.json presence never becomes an anchored checkpoint. */
export function loadScopeStream(cwd, sessionId, scope, repositoryRoot, sessionKey = sessionId) {
    const paths = temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey);
    if (readRegularBytes(join(paths.directory, STATE_FILE), repositoryRoot) !== undefined) {
        throw new Error(`Unsupported State Flow storage format: ${JSON.stringify(paths.directory)}`);
    }
    return parseScopeStream(readRegularFile(paths.checkpoint, repositoryRoot), readRegularFile(paths.patches, repositoryRoot), scope, scope === "cwd" ? cwd : undefined, readRegularFile(paths.meta, repositoryRoot));
}
/** Include unsupported predecessor names in the CAS basis so they cannot race canonical publication. */
export function captureTemporalFileBases(cwd, sessionId, repositoryRoot, sessionKey = sessionId) {
    const paths = ["global", "cwd", "session"].flatMap((scope) => {
        const pair = temporalScopePaths(cwd, sessionId, scope, repositoryRoot, sessionKey);
        const runtime = scope === "session" ? sessionRuntimePaths(cwd, sessionId, repositoryRoot, sessionKey) : undefined;
        return [pair.checkpoint, pair.patches, ...(runtime === undefined ? [pair.meta] : [runtime.config, runtime.runtime, runtime.meta])];
    });
    return captureOwnedFileBases(paths, repositoryRoot);
}
/** Select exact serialized scope updates from one validated active temporal cohort. */
export function temporalStateFileUpdates(cwd, sessionId, view, scopes, repositoryRoot, sessionKey = sessionId) {
    validateTemporalState(view, MAX_HISTORY_LIMIT);
    const seen = new Set();
    return scopes.flatMap((scope) => {
        if (seen.has(scope))
            throw new Error(`Duplicate temporal scope update: ${scope}`);
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
export function serializeScopeMetadata(registry, stream, scope, cwdIdentity, existingSource) {
    const existing = parseMetadataDocument(existingSource, `State Flow metadata`);
    if (scope === "session") {
        for (const key of ["identity", "lineage", "step", "specification", "validation", "bootstrap"])
            delete existing[key];
    }
    const sources = serializeScopeStream(stream, scope, cwdIdentity);
    const value = {
        ...existing,
        version: 2,
        ...(registry === undefined ? {} : { artifacts: serializeArtifactProvenanceRegistry(registry) }),
        temporal: sources.temporal,
        ...(scope === "cwd" ? { owner: { cwd: resolve(cwdIdentity) } } : {}),
    };
    return `${canonicalJson(value)}\n`;
}
/** Compatibility serializer retained for metadata-only callers. */
export function serializeScopeProvenance(registry) {
    return `${canonicalJson({ version: 2, artifacts: serializeArtifactProvenanceRegistry(registry) })}\n`;
}
function parseMetadataDocument(source, label) {
    if (source === undefined)
        return {};
    let value;
    try {
        value = JSON.parse(source);
    }
    catch {
        throw new Error(`${label} contains invalid JSON`);
    }
    if (!isObject(value) || !isJsonValue(value))
        throw new Error(`Invalid ${label}`);
    return value;
}
/** Missing provenance is unavailable evidence, never corrupt state. Unknown metadata is preserved by writers. */
export function parseScopeProvenance(source, path) {
    const value = parseMetadataDocument(source, `State Flow provenance file: ${JSON.stringify(path)}`);
    if (Object.keys(value).length === 0)
        return {};
    if (value.version !== 1 && value.version !== 2)
        throw new Error(`Invalid State Flow provenance document: ${JSON.stringify(path)}`);
    if (!Object.hasOwn(value, "artifacts"))
        return {};
    return parseArtifactProvenanceRegistry(value.artifacts, `State Flow provenance at ${JSON.stringify(path)}`);
}
/** Dedicated runtime storage, independent from Markdown source discovery. */
export function getDurableRepositoryRoot(agentDir = getAgentDir()) {
    return resolve(agentDir, "state-flow");
}
/** Match Pi's native project-session directory convention exactly. */
export function cwdScopeKey(cwd) {
    const canonical = resolve(cwd);
    return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
/** One safe directory segment, normally the native Pi session filename stem. */
export function sessionScopeKey(key) {
    if (!SESSION_KEY_PATTERN.test(key))
        throw new Error("State Flow session storage key must be one Pi-safe path segment");
    return key;
}
/** Prefer the actual native file stem; reproduce it from the immutable header when in-memory. */
export function sessionStorageKey(sessionFile, sessionId, timestamp) {
    if (sessionFile !== undefined) {
        const name = basename(sessionFile);
        if (!name.endsWith(".jsonl"))
            throw new Error("State Flow session file must use Pi's .jsonl format");
        return sessionScopeKey(name.slice(0, -".jsonl".length));
    }
    if (timestamp !== undefined)
        return sessionScopeKey(`${timestamp.replace(/[:.]/g, "-")}_${sessionId}`);
    return sessionScopeKey(sessionId);
}
export function resolveSessionAddress(sessionFile, sessionId, timestamp) {
    if (sessionId.trim().length === 0 || sessionId !== sessionId.trim())
        throw new Error("State Flow session identity must be non-empty and trimmed");
    return Object.freeze({ id: sessionId, key: sessionStorageKey(sessionFile, sessionId, timestamp) });
}
export function cwdScopePaths(cwd, repositoryRoot = getDurableRepositoryRoot()) {
    return { directory: join(resolve(repositoryRoot), cwdScopeKey(cwd)) };
}
export function sessionScopePaths(cwd, sessionId, repositoryRoot = getDurableRepositoryRoot(), sessionKey = sessionId) {
    return { directory: join(cwdScopePaths(cwd, repositoryRoot).directory, sessionScopeKey(sessionKey)) };
}
/** Exact canonical semantic and runtime file shapes. */
export function isStateFlowOwnedPath(candidate, repositoryRoot = getDurableRepositoryRoot()) {
    const root = resolve(repositoryRoot);
    const absolute = resolve(candidate);
    if (absolute === join(root, CHECKPOINT_FILE) || absolute === join(root, PATCHES_FILE)
        || absolute === join(root, META_FILE))
        return true;
    const segments = relative(root, absolute).split(sep);
    const cwdKey = (value) => value.startsWith("--") && value.endsWith("--");
    const sessionKey = (value) => {
        try {
            return sessionScopeKey(value) === value;
        }
        catch {
            return false;
        }
    };
    if (segments.length === 2) {
        return cwdKey(segments[0]) && (segments[1] === CHECKPOINT_FILE || segments[1] === PATCHES_FILE || segments[1] === META_FILE);
    }
    if (segments.length === 3) {
        return cwdKey(segments[0])
            && sessionKey(segments[1])
            && (segments[2] === CHECKPOINT_FILE || segments[2] === PATCHES_FILE
                || segments[2] === "config.json" || segments[2] === RUNTIME_FILE || segments[2] === META_FILE);
    }
    return false;
}
function missing(error) {
    return error instanceof Error
        && "code" in error
        && error.code === "ENOENT";
}
function assertWithinRepository(path, repositoryRoot) {
    const child = relative(repositoryRoot, path);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
        throw new Error(`Durable State Flow path escapes its repository: ${JSON.stringify(path)}`);
    }
}
/** Reject symlinked directory components instead of following them during reads or writes. */
function assertDirectoryChain(repositoryRoot, directory, create) {
    const root = resolve(repositoryRoot);
    const target = resolve(directory);
    if (target !== root)
        assertWithinRepository(target, root);
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
                throw new Error(`Durable State Flow directory is not a regular directory: ${JSON.stringify(current)}`);
            }
        }
        catch (error) {
            if (!missing(error))
                throw error;
            if (!create)
                return false;
            mkdirSync(current);
        }
    }
    return true;
}
function readRegularBytes(path, repositoryRoot) {
    if (!assertDirectoryChain(repositoryRoot, dirname(path), false))
        return undefined;
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!fstatSync(descriptor).isFile()) {
            throw new Error(`Durable State Flow path is not a regular file: ${JSON.stringify(path)}`);
        }
        return readFileSync(descriptor);
    }
    catch (error) {
        if (missing(error))
            return undefined;
        if (error instanceof Error
            && "code" in error
            && error.code === "ELOOP") {
            throw new Error(`Durable State Flow path is not a regular file: ${JSON.stringify(path)}`);
        }
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
function readRegularFile(path, repositoryRoot) {
    return readRegularBytes(path, repositoryRoot)?.toString("utf8");
}
function byteIdentity(bytes) {
    return bytes === undefined ? "missing" : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function fileBase(path, repositoryRoot) {
    const bytes = readRegularBytes(path, repositoryRoot);
    if (bytes === undefined)
        return { path, identity: "missing" };
    return { path, identity: byteIdentity(bytes), content: bytes.toString("utf8"), bytes };
}
function assertCurrentBytes(path, root, expected) {
    if (byteIdentity(readRegularBytes(path, root)) !== byteIdentity(expected)) {
        throw new Error(`State Flow file conflict at ${JSON.stringify(path)}; concurrent bytes preserved`);
    }
}
/** Capture exact owned bytes for one compare-and-swap publication cohort. */
export function captureOwnedFileBases(paths, repositoryRoot) {
    const root = resolve(repositoryRoot);
    return paths.map((path) => {
        if (!isStateFlowOwnedPath(path, root))
            throw new Error(`Cannot capture a non-State Flow path: ${JSON.stringify(path)}`);
        return fileBase(resolve(path), root);
    });
}
function prepareFile(path, repositoryRoot, content, expected) {
    assertWithinRepository(path, repositoryRoot);
    assertDirectoryChain(repositoryRoot, dirname(path), true);
    const original = readRegularBytes(path, repositoryRoot);
    if (expected !== undefined && byteIdentity(original) !== expected.identity) {
        throw new Error(`State Flow file conflict during preparation: ${JSON.stringify(path)}`);
    }
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const next = content === undefined ? undefined : Buffer.from(content);
    if (next !== undefined)
        writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
    return { path, repositoryRoot, temporary, original, next };
}
function restorePrepared(prepared) {
    assertCurrentBytes(prepared.path, prepared.repositoryRoot, prepared.next);
    if (prepared.original === undefined) {
        rmSync(prepared.path, { force: true });
        return;
    }
    const rollback = join(dirname(prepared.path), `.${basename(prepared.path)}.${process.pid}.${randomUUID()}.rollback`);
    try {
        writeFileSync(rollback, prepared.original, { flag: "wx", mode: 0o600 });
        renameSync(rollback, prepared.path);
    }
    finally {
        rmSync(rollback, { force: true });
    }
}
function publishPrepared(prepared) {
    let published = 0;
    try {
        for (const item of prepared) {
            assertCurrentBytes(item.path, item.repositoryRoot, item.original);
            if (item.next === undefined)
                rmSync(item.path, { force: true });
            else
                renameSync(item.temporary, item.path);
            published += 1;
        }
    }
    catch (error) {
        let rollbackError;
        for (let index = published - 1; index >= 0; index--) {
            try {
                restorePrepared(prepared[index]);
            }
            catch (failure) {
                rollbackError ??= failure;
            }
        }
        if (rollbackError !== undefined) {
            throw new AggregateError([error, rollbackError], "Durable State Flow transition publication and rollback failed");
        }
        throw error;
    }
    finally {
        for (const item of prepared)
            rmSync(item.temporary, { force: true });
    }
}
/** Verify the publisher's exact output before commit or rollback, without trusting changed worktree bytes. */
export function assertOwnedFileUpdates(updates, repositoryRoot) {
    const root = resolve(repositoryRoot);
    for (const update of updates) {
        if (!isStateFlowOwnedPath(update.path, root))
            throw new Error(`Cannot inspect a non-State Flow path: ${JSON.stringify(update.path)}`);
        assertCurrentBytes(update.path, root, update.content === undefined ? undefined : Buffer.from(update.content));
    }
}
/** Publish a prevalidated file cohort, preserving original bytes for failed preparation/publication. */
export function writeOwnedFileUpdates(updates, bases, repositoryRoot) {
    const root = resolve(repositoryRoot);
    const byPath = new Map(bases.map((base) => [resolve(base.path), base]));
    const seen = new Set();
    const prepared = [];
    try {
        for (const update of updates) {
            const path = resolve(update.path);
            if (!isStateFlowOwnedPath(path, root))
                throw new Error(`Cannot update a non-State Flow path: ${JSON.stringify(path)}`);
            if (seen.has(path))
                throw new Error(`Duplicate State Flow file update: ${JSON.stringify(path)}`);
            seen.add(path);
            const base = byPath.get(path);
            if (base === undefined)
                throw new Error(`State Flow file update has no captured base: ${JSON.stringify(path)}`);
            prepared.push(prepareFile(path, root, update.content, base));
        }
    }
    catch (error) {
        for (const item of prepared)
            rmSync(item.temporary, { force: true });
        throw error;
    }
    publishPrepared(prepared);
    return prepared.map(({ path }) => path);
}
/** Restore exact pre-transition bytes only while files still match this publisher's output. */
export function restoreDurableFileBases(bases, repositoryRoot, expectedCurrent) {
    const root = resolve(repositoryRoot);
    const expected = new Map(expectedCurrent.map((update) => [resolve(update.path), update]));
    for (const base of bases) {
        assertWithinRepository(base.path, root);
        if (!isStateFlowOwnedPath(base.path, root)) {
            throw new Error(`Cannot restore a non-State Flow path: ${JSON.stringify(base.path)}`);
        }
    }
    for (const base of bases) {
        const update = expected.get(resolve(base.path));
        if (update === undefined)
            throw new Error(`Rollback has no published basis: ${JSON.stringify(base.path)}`);
        assertCurrentBytes(base.path, root, update.content === undefined ? undefined : Buffer.from(update.content));
        if (base.identity === "missing") {
            rmSync(base.path, { force: true });
            continue;
        }
        const original = base.bytes ?? (base.content === undefined ? undefined : Buffer.from(base.content));
        if (original === undefined)
            throw new Error(`Durable State Flow base content is missing: ${JSON.stringify(base.path)}`);
        assertDirectoryChain(root, dirname(base.path), true);
        const temporary = join(dirname(base.path), `.${basename(base.path)}.${process.pid}.${randomUUID()}.restore`);
        try {
            writeFileSync(temporary, original, { flag: "wx", mode: 0o600 });
            renameSync(temporary, base.path);
        }
        finally {
            rmSync(temporary, { force: true });
        }
    }
}
