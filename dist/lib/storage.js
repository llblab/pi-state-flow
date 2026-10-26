// Domain: exact file-cohort publication, current-only recovery, and cooperating worktree exclusion.
// Excludes: temporal algebra, Pi lifecycle, Git objects/remotes, and backend fallback policy.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertOwnedFileUpdates, captureTemporalFileBases, captureOwnedFileBases, captureOwnedFilePresence, classifyScopeStream, parseScopeProvenance, parseScopeStream, restoreDurableFileBases, serializeScopeMetadata, serializeScopeStream, sessionRuntimePaths, temporalScopePaths, temporalStateFileUpdates, writeOwnedFileUpdates, } from "./durable.js";
import { isInterpretableArtifactProvenance, parseArtifactProvenanceRegistry } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, hashJson, isJsonValue, isObject, sameJson } from "./json.js";
import { prepareSerializedScopeMigration } from "./migration.js";
import { RevisionUnavailableError, isFileRevision, parseSessionRuntime, prepareSessionPolicyMigration, captureLifecycleSnapshot, capturePrivateCausalBasis, serializeSessionRuntime } from "./snapshot.js";
export { isFileRevision } from "./snapshot.js";
import { validateTemporalState, selectTemporalState, restoreSelectedTemporalState, temporalCausalWitnesses, constrainTemporalState, advanceTemporalState, createSelectedTemporalState, adoptSelectedTemporalStreams, validateScopeLineage, scopeLineageMatches, captureTemporalWitnesses, readTemporalView } from "./temporal.js";
import { captureScopeSelection } from "./selection.js";
import { validateRetainedModules } from "./semantic-module.js";
const SCOPES = ["global", "cwd", "session"];
/** Opaque CAS capture stays byte-exact; semantic consumers alone require lossless text. */
export function temporalFileContents(base) {
    return new Map(base.files.map((file) => [file.path, file.bytes === undefined ? file.content
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes)]));
}
export function assertStorageDirectory(path) {
    const root = resolve(path);
    const parent = dirname(root);
    if (parent !== root)
        assertStorageDirectory(parent);
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error(`State Flow repository path is not a regular directory: ${JSON.stringify(root)}`);
}
/** Explicit creation only; existing bytes and unrelated files are never adopted or rewritten here. */
export function initializeFileStore(root) {
    assertStorageDirectory(root);
    mkdirSync(resolve(root), { recursive: true });
}
const PUBLICATION_LOCK_WAIT_MS = 2_000;
const PUBLICATION_LOCK_POLL_MS = 25;
const publicationLockWait = new Int32Array(new SharedArrayBuffer(4));
function publicationLockOwner(path, allowCurrentProcess) {
    let owner;
    try {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat)
            return "absent";
        if (!stat.isFile() || stat.isSymbolicLink())
            return "unavailable";
        owner = readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }).trim();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "absent";
        throw error;
    }
    if (owner.length === 0)
        return "pending";
    if (!/^[1-9]\d*$/.test(owner))
        return "unavailable";
    const pid = Number(owner);
    if (!Number.isSafeInteger(pid) || (pid === process.pid && !allowCurrentProcess))
        return "unavailable";
    try {
        process.kill(pid, 0);
        return "live";
    }
    catch (error) {
        return error.code === "EPERM" ? "live" : "unavailable";
    }
}
/** Wait only for a cooperating live owner; interrupted or malformed locks remain explicit recovery errors. */
export function acquirePublicationLock(path, unavailable) {
    const deadline = Date.now() + PUBLICATION_LOCK_WAIT_MS;
    while (true) {
        try {
            return openSync(path, "wx", 0o600);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw unavailable(error);
            let owner;
            try {
                owner = publicationLockOwner(path, false);
            }
            catch (cause) {
                throw unavailable(cause);
            }
            if (owner === "unavailable" || Date.now() >= deadline)
                throw unavailable(error);
            Atomics.wait(publicationLockWait, 0, 0, Math.min(PUBLICATION_LOCK_POLL_MS, deadline - Date.now()));
        }
    }
}
/** Canonical writers and bounded backup capture share exclusion; no Git work runs under this lock. */
export function withStoragePublicationLock(repositoryRoot, action) {
    const root = resolve(repositoryRoot);
    assertStorageDirectory(root);
    const path = resolve(root, ".state-flow-publication.lock");
    const descriptor = acquirePublicationLock(path, (cause) => new RevisionUnavailableError(`State Flow publication lock is unavailable at ${JSON.stringify(path)}`, { cause }));
    try {
        writeFileSync(descriptor, `${process.pid}\n`);
        return action(root);
    }
    finally {
        closeSync(descriptor);
        rmSync(path);
    }
}
export class PublicationBusyError extends Error {
    constructor(path) { super(`State Flow publication lock is busy at ${JSON.stringify(path)}`); }
}
const storageLockContext = new AsyncLocalStorage();
/** Await an exact file mutex; shared by canonical transactions and the independent Git backup owner. */
export async function withFilePublicationLock(lockPath, action, signal, unavailable = (cause) => new RevisionUnavailableError(`State Flow publication lock is unavailable at ${JSON.stringify(resolve(lockPath))}`, { cause }), waitForLock = true) {
    const path = resolve(lockPath);
    const inherited = storageLockContext.getStore();
    if (inherited?.some((held) => held.active && held.path === path))
        throw new Error(`Recursive State Flow publication lock at ${JSON.stringify(path)}`);
    let descriptor;
    let pendingSince;
    while (true) {
        signal?.throwIfAborted();
        assertStorageDirectory(dirname(path));
        try {
            descriptor = openSync(path, "wx", 0o600);
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw unavailable(error);
            let owner;
            try {
                owner = publicationLockOwner(path, true);
            }
            catch (cause) {
                throw unavailable(cause);
            }
            if (owner === "unavailable")
                throw unavailable(error);
            if (!waitForLock)
                throw new PublicationBusyError(path);
            // An empty file may be between exclusive creation and PID publication, but not forever.
            if (owner === "pending")
                pendingSince ??= performance.now();
            else
                pendingSince = undefined;
            if (pendingSince !== undefined && performance.now() - pendingSince >= PUBLICATION_LOCK_WAIT_MS)
                throw unavailable(error);
        }
        await delay(PUBLICATION_LOCK_POLL_MS, undefined, { signal });
    }
    let identity;
    const held = { path, active: true };
    let failed;
    try {
        identity = fstatSync(descriptor);
        writeFileSync(descriptor, `${process.pid}\n`);
        signal?.throwIfAborted();
        return await storageLockContext.run([...(inherited?.filter((owner) => owner.active) ?? []), held], action);
    }
    catch (error) {
        failed = { error };
        throw error;
    }
    finally {
        held.active = false;
        try {
            const current = lstatSync(path, { throwIfNoEntry: false });
            if (!identity || !current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
                || readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== `${process.pid}\n`) {
                throw new Error(`State Flow publication lock changed during transaction at ${JSON.stringify(path)}; current owner preserved`);
            }
            rmSync(path);
        }
        catch (error) {
            if (failed)
                throw new AggregateError([failed.error, error], "State Flow storage transaction and lock release failed");
            throw error;
        }
        finally {
            closeSync(descriptor);
        }
    }
}
/** Await store-wide exclusion, then capture/apply/publish through callback-scoped operations. */
export async function withStorageTransaction(repositoryRoot, action, signal, waitForLock = true) {
    const root = resolve(repositoryRoot);
    return withFilePublicationLock(resolve(root, ".state-flow-publication.lock"), async () => {
        let active = true;
        let selectedPublicationUsed = false;
        const guard = (requestedRoot) => {
            if (!active)
                throw new Error("State Flow storage transaction has ended");
            if (resolve(requestedRoot) !== root)
                throw new Error("State Flow storage transaction belongs to a different store");
            signal?.throwIfAborted();
        };
        const transaction = Object.freeze({
            capture: (cwd, sessionId, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                return { files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
            },
            prepareSelected: (cwd, sessionId, selection, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                return prepareSelectedFileCohort(cwd, sessionId, selection, root, sessionKey);
            },
            observeSelectedShared: (cwd, selection, requestedRoot) => {
                guard(requestedRoot);
                return observeSelectedShared(cwd, selection, root);
            },
            persistSelectedPassive: (cwd, sessionId, base, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return persistSelectedPassive(cwd, sessionId, base, root, sessionKey);
            },
            hasSelectedCurrentAuthority: (cwd, sessionId, selection, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                return captureSelectedLifecycle(cwd, sessionId, captureScopeSelection(selection), root, sessionKey).lifecycle !== undefined;
            },
            inspectSelectedLifecycle: (cwd, sessionId, selection, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                return captureSelectedLifecycle(cwd, sessionId, captureScopeSelection(selection), root, sessionKey).lifecycle;
            },
            prepareSelectedCurrent: (cwd, sessionId, selection, historyLimit, requestedRoot, sessionKey = sessionId, expectedLifecycle) => {
                guard(requestedRoot);
                return prepareSelectedCurrent(cwd, sessionId, selection, historyLimit, root, sessionKey, expectedLifecycle);
            },
            acceptSelectedCurrent: (cwd, sessionId, request, base, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                const current = prepareSelectedCurrent(cwd, sessionId, request.selection, request.historyLimit, root, sessionKey);
                assertSelectedFileCohortBasis(base, current);
                if ((request.lifecycle?.config.mode ?? current.lifecycle.runtime.config.mode) === "off")
                    throw new Error("Off cannot accept current State Flow memory");
                const expected = selectedReplaySuccessor(current.view, request.historyLimit, request.transition, request.moduleAdditions);
                return publishSelectedSuccessor(cwd, sessionId, current, expected, request.historyLimit, request.lifecycle, root, sessionKey, request.provenance);
            },
            publishSelected: (cwd, sessionId, request, base, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return publishSelectedFileCohort(cwd, sessionId, request, base, root, sessionKey);
            },
            initializeSelectedSharedOrigin: (cwd, sessionId, request, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return acceptSelectedOrigin(cwd, sessionId, { ...request, kind: "shared-new" }, root, sessionKey);
            },
            acquireSelectedSession: (cwd, sessionId, request, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return acceptSelectedOrigin(cwd, sessionId, request, root, sessionKey);
            },
            deferSelectedFork: (cwd, sessionId, request, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return acceptSelectedOrigin(cwd, sessionId, { ...request, kind: "shared-deferred" }, root, sessionKey);
            },
            copySelectedFork: (cwd, sessionId, request, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                if (selectedPublicationUsed)
                    throw new Error("Selected State Flow publication capability was already used");
                selectedPublicationUsed = true;
                return acceptSelectedOrigin(cwd, sessionId, request, root, sessionKey);
            },
            publish: (cwd, sessionId, view, scopes, base, requestedRoot, runtime, sessionKey, provenance, runtimeOnly) => {
                guard(requestedRoot);
                return publishLockedTemporalStateToFiles(cwd, sessionId, view, scopes, base, root, runtime, sessionKey, provenance, runtimeOnly);
            },
        });
        try {
            return await action(transaction);
        }
        finally {
            active = false;
        }
    }, signal, undefined, waitForLock);
}
export function assertTemporalFileBase(expected, current) {
    if (expected.files.length !== current.files.length || current.files.some((file, index) => {
        const previous = expected.files[index];
        return file.path !== previous.path || file.identity !== previous.identity;
    }))
        throw new Error("Temporal State Flow base or scope identity changed concurrently");
}
/** Plan exact canonical updates; lifecycle-only writes exclude semantic files and provenance. */
export function planTemporalPublication(cwd, sessionId, view, scopes, current, root, runtime, runtimeOnly = false, sessionKey = sessionId, provenance) {
    const candidates = temporalStateFileUpdates(cwd, sessionId, view, scopes, root, sessionKey);
    const decoded = temporalFileContents(current);
    const files = new Map(current.files.map((file) => [file.path, { ...file, content: decoded.get(file.path) }]));
    if (runtimeOnly && (scopes.length !== 0 || provenance !== undefined))
        throw new Error("Runtime-only publication cannot write semantic scopes or artifact provenance");
    const changedScopes = [];
    const migrations = new Map();
    for (const scope of SCOPES) {
        const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
        const previous = parseScopeStream(files.get(paths.checkpoint).content, files.get(paths.patches).content, scope, scope === "cwd" ? cwd : undefined, files.get(paths.meta).content);
        if (!runtimeOnly && scopes.includes(scope) && previous !== undefined && JSON.parse(files.get(paths.meta).content).version !== (view.scopes[scope].modules === undefined ? 3 : 4)) {
            migrations.set(scope, prepareSerializedScopeMigration({
                checkpoint: files.get(paths.checkpoint).bytes, patches: files.get(paths.patches).bytes, meta: files.get(paths.meta).bytes,
            }, scope, scope === "cwd" ? cwd : undefined, view.scopes[scope].modules));
        }
        if (runtimeOnly || (previous !== undefined && !migrations.has(scope) && sameJson(previous, view.scopes[scope])))
            continue;
        if (!scopes.includes(scope))
            throw new Error(`Temporal scope update omitted a changed stream: ${scope}`);
        changedScopes.push(scope);
    }
    const provenanceUpdates = [];
    // Every scope metadata file owns provenance and temporal boundaries beside semantic files.
    if (!runtimeOnly) {
        for (const scope of SCOPES) {
            const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
            const registry = provenance?.[scope] ?? parseScopeProvenance(files.get(paths.meta).content, paths.meta);
            const currentFile = files.get(paths.meta);
            if (!changedScopes.includes(scope)
                && (provenance === undefined || sameJson(parseScopeProvenance(currentFile.content, paths.meta), registry)))
                continue;
            const migration = migrations.get(scope);
            const unchangedRegistry = sameJson(parseScopeProvenance(currentFile.content, paths.meta), registry);
            let content = serializeScopeMetadata(unchangedRegistry ? undefined : registry, view.scopes[scope], scope, scope === "cwd" ? cwd : undefined, migration?.target.meta ?? currentFile.content);
            if (migration && !unchangedRegistry) {
                const raw = JSON.parse(migration.target.meta);
                const next = JSON.parse(content);
                const prior = parseScopeProvenance(currentFile.content, paths.meta);
                if (isObject(raw.artifacts) && isObject(next.artifacts)) {
                    for (const [path, value] of Object.entries(raw.artifacts))
                        if (prior[path]?.malformed) {
                            if (!Object.hasOwn(next.artifacts, path))
                                Object.defineProperty(next.artifacts, path, { value, enumerable: true });
                        }
                    content = `${canonicalJson(next)}\n`;
                }
            }
            if (currentFile.content !== content)
                provenanceUpdates.push({ path: paths.meta, content });
        }
    }
    const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const previousRuntime = parseSessionRuntime(files.get(runtimePaths.config).content, files.get(runtimePaths.runtime).content, cwd, sessionId);
    if (previousRuntime !== undefined && changedScopes.length > 0 && runtime === undefined)
        throw new Error("Temporal semantic publication requires its session runtime cohort");
    const runtimeUpdates = [];
    if (runtime !== undefined) {
        const sources = serializeSessionRuntime(runtime, cwd, sessionId);
        if (!sameJson(runtime.meta.lineage, view.lineage))
            throw new Error("Runtime lineage does not match the temporal cohort");
        if (files.get(runtimePaths.config).content !== sources.config || files.get(runtimePaths.runtime).content !== sources.runtime) {
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
export function temporalFileReceipts(current, updates) {
    const receipts = new Map(updates.map((update) => [update.path, update.content]));
    return current.files.map((file) => {
        if (!receipts.has(file.path))
            return file;
        const content = receipts.get(file.path);
        return content === undefined ? { path: file.path, identity: "missing" } : {
            path: file.path, content, bytes: Buffer.from(content),
            identity: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        };
    });
}
function fileRevision(base, root) {
    return `file:${hashJson({ root: resolve(root), files: base.files.map(({ path, identity }) => [relative(root, path), identity]) })}`;
}
function decodeFileCohort(cwd, sessionId, root, base, sessionKey = sessionId) {
    const files = temporalFileContents(base);
    const scopes = {};
    for (const scope of SCOPES) {
        const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
        const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? cwd : undefined, files.get(paths.meta));
        if (!stream)
            throw new Error("Incomplete file-only temporal scope cohort");
        scopes[scope] = stream;
    }
    const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const runtime = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), cwd, sessionId);
    if (!runtime)
        throw new Error("Canonical recovery requires a complete session runtime");
    const view = { scopes, lineage: runtime.meta.lineage };
    validateTemporalState(view, MAX_HISTORY_LIMIT);
    const provenance = {
        global: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "global", root, sessionKey).meta),
        cwd: parseScopeProvenance(files.get(temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta), temporalScopePaths(cwd, sessionId, "cwd", root, sessionKey).meta),
        session: parseScopeProvenance(files.get(paths.meta), paths.meta),
    };
    return { runtime, view, provenance };
}
/** Reject excluded owners before their values/getters; metadata values remain runtime-owned evidence, not source authentication. */
export function captureSelectedProvenanceUpdates(value, selection) {
    if (value === undefined)
        return undefined;
    if (!isObject(value))
        throw new Error("Selected State Flow provenance updates must be an object");
    for (const scope of Object.keys(value))
        if (!selection.includes(scope))
            throw new Error(`State Flow ${scope} provenance owner is excluded`);
    if (!isJsonValue(value))
        throw new Error("Selected State Flow provenance updates must be finite JSON");
    const result = {};
    for (const scope of selection)
        if (Object.hasOwn(value, scope)) {
            const registry = parseArtifactProvenanceRegistry(value[scope]);
            if (!sameJson(registry, value[scope]) || Object.values(registry).some((entry) => entry.malformed))
                throw new Error("Invalid selected State Flow provenance updates");
            if (Object.keys(registry).length > 0)
                result[scope] = structuredClone(registry);
        }
    return Object.keys(result).length > 0 ? result : undefined;
}
export function captureSelectedModuleAdditions(value, selection) {
    if (value === undefined)
        return undefined;
    if (!isObject(value))
        throw new Error("Invalid selected State Flow module additions");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !selection.includes(key)))
        throw new Error("Selected State Flow module owner is excluded");
    const captured = {};
    for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property.enumerable || !("value" in property))
            throw new Error("Selected State Flow module additions require detached data");
        const modules = property.value;
        validateRetainedModules(modules);
        if (Object.keys(modules).length === 0)
            throw new Error("Empty selected State Flow module additions");
        captured[key] = structuredClone(modules);
    }
    return Object.keys(captured).length === 0 ? undefined : captured;
}
function observeSelectedShared(cwd, selection, root) {
    const wanted = captureScopeSelection(selection);
    if (wanted.includes("session"))
        throw new Error("Shared State Flow observation cannot select Session");
    const layouts = wanted.map(scope => ({ scope, paths: temporalScopePaths(cwd, "", scope, root) }));
    if (captureOwnedFilePresence(layouts.map(({ paths }) => resolve(paths.directory, "state.json")), root).some(file => file.present)) {
        throw new Error("Unsupported State Flow selected semantic layout");
    }
    const basis = { files: captureOwnedFileBases(layouts.flatMap(({ paths }) => [paths.checkpoint, paths.patches, paths.meta]), root) };
    const sources = temporalFileContents(basis);
    const streams = {};
    const provenance = {};
    for (const { scope, paths } of layouts) {
        const bodies = [sources.get(paths.checkpoint), sources.get(paths.patches), sources.get(paths.meta)];
        if (bodies.every(body => body === undefined))
            continue;
        if (bodies.some(body => body === undefined))
            throw new Error(`Incomplete selected State Flow ${scope} observation`);
        streams[scope] = parseScopeStream(bodies[0], bodies[1], scope, scope === "cwd" ? cwd : undefined, bodies[2]);
        provenance[scope] = parseScopeProvenance(bodies[2], paths.meta);
    }
    const present = wanted.filter(scope => streams[scope] !== undefined);
    return { selection: wanted, provenance, ...(present.length === 0 ? {} : {
            view: adoptSelectedTemporalStreams(streams, captureScopeSelection(present), `observation:${randomUUID()}`, MAX_HISTORY_LIMIT),
        }) };
}
/** Await a fresh guarded transaction; no private initialization or fork acquisition is admitted. */
export async function publishSelectedTemporalStateToFiles(cwd, sessionId, request, base, root, sessionKey = sessionId, signal) {
    return withStorageTransaction(root, (transaction) => transaction.publishSelected(cwd, sessionId, request, base, root, sessionKey), signal);
}
function publishSelectedFileCohort(cwd, sessionId, request, base, root, sessionKey) {
    const current = prepareSelectedFileCohort(cwd, sessionId, base.view.selection, root, sessionKey);
    if (!current)
        throw new Error("Selected State Flow source authority is unavailable");
    assertSelectedFileCohortBasis(base, current);
    const expected = selectedReplaySuccessor(current.view, request.historyLimit, request.transition, request.moduleAdditions);
    if (!sameJson(expected, request.view))
        throw new Error("Selected State Flow output is not the admitted replay successor");
    return publishSelectedSuccessor(cwd, sessionId, current, expected, request.historyLimit, request.lifecycle, root, sessionKey, request.provenance);
}
/** Strictly lifecycle-only; a mode choice cannot repair, convert or refresh semantic authority. */
function persistSelectedPassive(cwd, sessionId, base, root, sessionKey) {
    const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const lifecyclePaths = new Set([paths.config, paths.runtime]);
    const lifecycleBasis = { files: base.basis.files.filter(file => lifecyclePaths.has(file.path)) };
    const current = prepareSelectedFileCohort(cwd, sessionId, base.view.selection, root, sessionKey, lifecycleBasis);
    if (!current)
        throw new Error("Selected State Flow source authority is unavailable");
    assertSelectedFileCohortBasis(base, current);
    const source = current.lifecycle.runtime.meta;
    const snapshot = captureLifecycleSnapshot({ config: { mode: "passive" }, meta: { step: source.step,
            ...Object.fromEntries(["specification", "bootstrap", "validation"].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]])) } });
    return publishSelectedSuccessor(cwd, sessionId, current, current.view, MAX_HISTORY_LIMIT, snapshot, root, sessionKey, undefined, true);
}
function selectedReplaySuccessor(view, historyLimit, transition, additions) {
    const current = constrainTemporalState(view, historyLimit);
    const admitted = captureSelectedModuleAdditions(additions, current.selection);
    if (admitted !== undefined) {
        for (const [owner, modules] of Object.entries(admitted)) {
            const scope = owner, stream = current.scopes[scope];
            for (const id of Object.keys(modules)) {
                if (Object.hasOwn(stream.modules ?? {}, id))
                    throw new Error("Selected State Flow module descriptor already exists");
                if (!transition?.transitions.some(item => item.scope === scope && Object.hasOwn(item.patch, id))) {
                    throw new Error("Selected State Flow module admission requires a content transition");
                }
            }
            stream.modules = { ...stream.modules, ...modules };
        }
    }
    if (transition === undefined)
        return current;
    if (!isObject(transition))
        throw new Error("Invalid selected State Flow replay request");
    const next = advanceTemporalState(current, transition.transitions, transition.id, historyLimit);
    for (const [owner, modules] of Object.entries(admitted ?? {})) {
        const content = readTemporalView(next, 0, owner, historyLimit);
        for (const id of Object.keys(modules)) {
            const value = content[id];
            if (!isObject(value) || Object.keys(value).length === 0)
                throw new Error("Selected State Flow module admission requires nonempty content");
        }
    }
    return next;
}
/** Merge known owned evidence without curating unbound or forward-compatible metadata. */
function mergeSelectedArtifactProvenance(priorMeta, path, before, after, updates, inherited) {
    const previous = parseScopeProvenance(priorMeta, path);
    const registry = { ...previous, ...inherited?.registry, ...updates };
    const removed = Object.keys(registry).filter(key => isInterpretableArtifactProvenance(registry[key])
        && Object.hasOwn(before ?? {}, key) && !Object.hasOwn(after ?? {}, key));
    for (const key of removed)
        delete registry[key];
    const raw = priorMeta === undefined ? { version: 3 } : JSON.parse(priorMeta);
    const artifacts = { ...raw.artifacts, ...inherited?.raw, ...updates };
    for (const key of removed)
        delete artifacts[key];
    const changed = !sameJson(previous, registry) || (inherited?.raw !== undefined
        && (raw.artifacts === undefined || !sameJson(raw.artifacts, artifacts)));
    return { registry, changed, metadata: changed ? canonicalJson({ ...raw, artifacts }) : priorMeta };
}
/** Check raw predecessor namespaces before selected metadata3→4 admission can hide ignored data. */
function assertSelectedModuleConversion(basis, paths, scope, cwd, modules) {
    if (modules === undefined)
        return;
    const files = new Map(basis.files.map(file => [file.path, file.bytes]));
    prepareSerializedScopeMigration({ checkpoint: files.get(paths.checkpoint), patches: files.get(paths.patches), meta: files.get(paths.meta) }, scope, scope === "cwd" ? cwd : undefined, modules);
}
/** One byte planner for replay successors and current-only adoption; neither admits new private authority. */
function publishSelectedSuccessor(cwd, sessionId, current, expected, historyLimit, requestedLifecycle, root, sessionKey, requestedProvenance, lifecycleOnly = false) {
    const provenance = captureSelectedProvenanceUpdates(requestedProvenance, expected.selection);
    const nextProvenance = {};
    const lifecycleKeys = ["step", "specification", "bootstrap", "validation"];
    const lifecycle = requestedLifecycle === undefined ? undefined : captureLifecycleSnapshot(requestedLifecycle);
    const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const metadata = { ...current.lifecycle.runtime.meta };
    if (lifecycle) {
        for (const key of lifecycleKeys)
            delete metadata[key];
        Object.assign(metadata, lifecycle.meta);
    }
    if (!lifecycleOnly && metadata.privateAcquisition === "acquired") {
        if (expected.selection.includes("session"))
            delete metadata.privateCausalBasis;
        else if (current.lifecycle.sourceVersion === 1 || current.lifecycle.runtime.config.scopes.includes("session")) {
            // Retain the admitted source claim before replacing the selected causal origin.
            // The requested view may already omit Session or use a new shared-only origin.
            if (current.lifecycle.sourceVersion === 1 && !sameJson(current.view.lineage, current.lifecycle.runtime.meta.lineage)) {
                throw new Error("Insufficient State Flow private causal basis before legacy realignment");
            }
            metadata.privateCausalBasis = capturePrivateCausalBasis({ lineage: current.lifecycle.runtime.meta.lineage,
                causalWitnesses: current.lifecycle.sourceVersion === 1 ? temporalCausalWitnesses(current.view, MAX_HISTORY_LIMIT)
                    : current.lifecycle.runtime.meta.causalWitnesses ?? [] });
        }
    }
    metadata.lineage = structuredClone(expected.lineage);
    metadata.causalWitnesses = temporalCausalWitnesses(expected, historyLimit);
    const targetLifecycle = prepareSessionPolicyMigration(`${canonicalJson({ mode: lifecycle === undefined ? current.lifecycle.runtime.config.mode : lifecycle.config.mode, scopes: expected.selection })}\n`, `${canonicalJson(metadata)}\n`, cwd, sessionId, expected.selection);
    const sources = temporalFileContents(current.basis);
    const updates = [];
    const convertedScopes = [];
    for (const scope of expected.selection) {
        const scopePaths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
        const priorMeta = sources.get(scopePaths.meta);
        const converting = priorMeta !== undefined && JSON.parse(priorMeta).version !== (expected.scopes[scope].modules === undefined ? 3 : 4);
        if (converting) {
            assertSelectedModuleConversion(current.basis, scopePaths, scope, cwd, expected.scopes[scope].modules);
            convertedScopes.push(scope);
        }
        const previous = parseScopeStream(sources.get(scopePaths.checkpoint), sources.get(scopePaths.patches), scope, scope === "cwd" ? cwd : undefined, priorMeta);
        const merged = mergeSelectedArtifactProvenance(priorMeta, scopePaths.meta, readTemporalView(current.view, 0, scope, MAX_HISTORY_LIMIT).artifacts, readTemporalView(expected, 0, scope, MAX_HISTORY_LIMIT).artifacts, provenance?.[scope]);
        nextProvenance[scope] = merged.registry;
        const metadataChanged = merged.changed;
        const streamChanged = converting || previous === undefined || !sameJson(previous, expected.scopes[scope]);
        if (!streamChanged && !metadataChanged)
            continue;
        const stream = expected.scopes[scope];
        if (streamChanged) {
            const wire = serializeScopeStream(stream, scope, scope === "cwd" ? cwd : undefined);
            updates.push({ path: scopePaths.checkpoint, content: wire.checkpoint }, { path: scopePaths.patches, content: wire.patches });
        }
        updates.push({ path: scopePaths.meta, content: serializeScopeMetadata(undefined, stream, scope, scope === "cwd" ? cwd : undefined, merged.metadata) });
    }
    if (sources.get(paths.config) !== targetLifecycle.target.config)
        updates.push({ path: paths.config, content: targetLifecycle.target.config });
    if (sources.get(paths.runtime) !== targetLifecycle.target.runtime)
        updates.push({ path: paths.runtime, content: targetLifecycle.target.runtime });
    if (lifecycleOnly && updates.some(update => update.path !== paths.config && update.path !== paths.runtime)) {
        throw new Error("Selected Passive persistence requires lifecycle v2 and semantic v3 without semantic changes");
    }
    const receipts = { files: temporalFileReceipts(current.basis, updates) };
    const cohort = decodeSelectedFileCohort(cwd, sessionId, expected.selection, root, sessionKey, { lifecycle: targetLifecycle, basis: receipts, presence: current.presence });
    if (!sameJson(cohort.view, expected) || !sameJson(cohort.provenance, nextProvenance))
        throw new Error("Selected State Flow receipt does not match accepted replay");
    const lifecycleConversion = current.lifecycle.sourceVersion === 1 ? { sourceVersion: 1, targetVersion: 2 } : undefined;
    const assertPresence = () => {
        if (!sameJson(current.presence, captureOwnedFilePresence(current.presence.map((file) => file.path), root)))
            throw new Error("Selected State Flow presence dependencies changed concurrently");
    };
    assertPresence();
    const migrationBackup = convertedScopes.length > 0 || lifecycleConversion !== undefined
        ? preserveMigrationBasis(current.basis, root, cwd, sessionId, sessionKey, { scopes: convertedScopes, lifecycle: lifecycleConversion, presence: current.presence }, updates) : undefined;
    assertPresence();
    publishFileUpdates(current.basis.files, updates, root);
    return { cohort, changed: updates.length > 0, ...(migrationBackup ? { migrationBackup } : {}) };
}
/** Initialize only genuinely absent private authority or first acquisition from an admitted unacquired owner. */
function acceptSelectedOrigin(cwd, sessionId, request, root, sessionKey) {
    const wanted = captureScopeSelection(request.selection);
    if (!["shared-new", "shared-deferred", "new", "unacquired", "fork-new", "fork-deferred"].includes(request.kind))
        throw new Error("Invalid selected origin admission kind");
    const copying = request.kind === "fork-new" || request.kind === "fork-deferred";
    const acquiring = request.kind === "new" || request.kind === "unacquired" || copying;
    if (acquiring !== wanted.includes("session"))
        throw new Error(acquiring ? "Selected private acquisition requires Session" : "Selected shared origin cannot acquire Session");
    const snapshot = captureLifecycleSnapshot(request.snapshot);
    if (snapshot.config.mode === "off")
        throw new Error("Off cannot initialize State Flow memory");
    if ((request.kind === "shared-deferred" || request.kind === "fork-new") && (snapshot.meta.step !== 0 || snapshot.meta.specification !== undefined || snapshot.meta.validation !== undefined)) {
        throw new Error("Selected fork deferral requires a fresh child lifecycle");
    }
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, sessionId, wanted, root, sessionKey);
    let prior;
    if (request.kind === "unacquired" || request.kind === "fork-deferred") {
        const required = request.kind === "fork-deferred" ? "deferred" : "unacquired";
        if (!lifecycle || lifecycle.sourceVersion !== 2 || lifecycle.runtime.meta.privateAcquisition !== required) {
            throw new Error(`Selected private acquisition requires admitted lifecycle-v2 ${required} authority`);
        }
        prior = prepareSelectedFileCohort(cwd, sessionId, request.base.view.selection, root, sessionKey);
        if (!prior)
            throw new Error("Selected private acquisition source is unavailable");
        assertSelectedFileCohortBasis(request.base, prior);
        const fields = Object.fromEntries(["step", "specification", "bootstrap", "validation"]
            .filter((key) => Object.hasOwn(lifecycle.runtime.meta, key)).map((key) => [key, lifecycle.runtime.meta[key]]));
        if (!sameJson(fields, snapshot.meta))
            throw new Error("Selected private acquisition cannot reset run lifecycle fields");
    }
    else if (lifecycle)
        throw new Error("Existing State Flow session requires current-memory acceptance, not a new origin");
    const copy = copying ? captureSelectedForkSource(cwd, sessionId, sessionKey, request.source, root) : undefined;
    const scopePaths = wanted.map((scope) => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
    const layouts = captureOwnedFilePresence(scopePaths.filter(({ scope }) => scope !== "session").map(({ paths }) => resolve(paths.directory, "state.json")), root);
    if (layouts.some((file) => file.present))
        throw new Error("Unsupported State Flow selected semantic layout");
    presence.push(...layouts);
    const scopeFiles = captureOwnedFileBases(scopePaths.flatMap(({ paths }) => [paths.checkpoint, paths.patches, paths.meta]), root);
    const basis = { files: [...new Map([...lifecycleFiles, ...scopeFiles, ...(prior?.basis.files ?? []), ...(copy?.basis.files ?? [])].map((file) => [file.path, file])).values()] };
    if (prior) {
        const recaptured = new Map([...lifecycleFiles, ...scopeFiles].map((file) => [file.path, file.identity]));
        if (prior.basis.files.some((file) => recaptured.has(file.path) && recaptured.get(file.path) !== file.identity))
            throw new Error("Selected acquisition source changed concurrently");
    }
    const sources = temporalFileContents(basis);
    const origin = `files:selected-origin:${randomUUID()}`;
    const fresh = createSelectedTemporalState(Object.fromEntries(wanted.map((scope) => [scope, {}])), wanted, `${origin}:empty`, request.historyLimit);
    const streams = {};
    const existing = new Set();
    for (const { scope, paths } of scopePaths) {
        const values = [paths.checkpoint, paths.patches, paths.meta].map((path) => sources.get(path));
        if (scope === "session" && values.some((value) => value !== undefined))
            throw new Error("Selected private acquisition target is occupied");
        if (values.some((value) => value !== undefined) && values.some((value) => value === undefined))
            throw new Error(`State Flow ${scope} origin requires complete or wholly absent scope files`);
        if (scope === "session" && copy) {
            streams.session = copy.stream;
            continue;
        }
        const source = classifyScopeStream(values[0], values[1], scope, scope === "cwd" ? cwd : undefined, values[2]);
        if (source.kind === "present") {
            streams[scope] = source.stream;
            existing.add(scope);
        }
        else
            streams[scope] = fresh.scopes[scope];
    }
    const originView = existing.size === 0 && !copy ? fresh : adoptSelectedTemporalStreams(streams, wanted, origin, request.historyLimit);
    const finish = (nextSnapshot, transition, requestedProvenance, moduleAdditions) => {
        const snapshot = captureLifecycleSnapshot(nextSnapshot);
        if (snapshot.config.mode === "off")
            throw new Error("Off cannot initialize State Flow memory");
        const provenance = captureSelectedProvenanceUpdates(requestedProvenance, wanted);
        const view = selectedReplaySuccessor(originView, request.historyLimit, transition, moduleAdditions);
        const metadata = { ...prior?.lifecycle.runtime.meta };
        for (const key of ["step", "specification", "bootstrap", "validation"])
            delete metadata[key];
        Object.assign(metadata, snapshot.meta);
        const target = prepareSessionPolicyMigration(`${canonicalJson({ mode: snapshot.config.mode, scopes: wanted })}\n`, `${canonicalJson({ ...metadata, version: 2, identity: { cwd: resolve(cwd), sessionId }, lineage: view.lineage,
            privateAcquisition: acquiring ? "acquired" : request.kind === "shared-deferred" ? "deferred" : "unacquired", causalWitnesses: temporalCausalWitnesses(view, request.historyLimit) })}\n`, cwd, sessionId, wanted);
        const updates = [];
        const convertedScopes = [];
        for (const { scope, paths } of scopePaths) {
            const prior = sources.get(paths.meta);
            const converting = prior !== undefined && JSON.parse(prior).version !== (view.scopes[scope].modules === undefined ? 3 : 4);
            if (converting) {
                assertSelectedModuleConversion(basis, paths, scope, cwd, view.scopes[scope].modules);
                convertedScopes.push(scope);
            }
            const merged = mergeSelectedArtifactProvenance(prior, paths.meta, readTemporalView(originView, 0, scope, MAX_HISTORY_LIMIT).artifacts, readTemporalView(view, 0, scope, MAX_HISTORY_LIMIT).artifacts, provenance?.[scope], scope === "session" && copy ? { registry: copy.provenance, raw: copy.rawArtifacts } : undefined);
            if (existing.has(scope) && !converting && sameJson(streams[scope], view.scopes[scope]) && !merged.changed)
                continue;
            const stream = view.scopes[scope];
            const wire = serializeScopeStream(stream, scope, scope === "cwd" ? cwd : undefined);
            updates.push({ path: paths.checkpoint, content: wire.checkpoint }, { path: paths.patches, content: wire.patches }, { path: paths.meta, content: serializeScopeMetadata(undefined, stream, scope, scope === "cwd" ? cwd : undefined, merged.metadata) });
        }
        const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
        updates.push({ path: paths.config, content: target.target.config }, { path: paths.runtime, content: target.target.runtime });
        const receipts = { files: temporalFileReceipts(basis, updates) };
        const privatePaths = temporalScopePaths(cwd, sessionId, "session", root, sessionKey);
        const created = new Set(acquiring ? [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta] : []);
        const targetPresence = presence.map((file) => created.has(file.path) ? { ...file, present: true } : file);
        const cohort = decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, { lifecycle: target, basis: receipts, presence: targetPresence });
        if (!sameJson(cohort.view, view))
            throw new Error("Selected State Flow origin receipts do not match adopted values");
        const assertOriginBasis = () => {
            assertTemporalFileBase(basis, { files: captureOwnedFileBases(basis.files.map(file => file.path), root) });
            if (!sameJson(presence, captureOwnedFilePresence(presence.map(file => file.path), root)))
                throw new Error("Selected origin presence changed concurrently");
            copy?.assertCurrent();
        };
        assertOriginBasis();
        const migrationBackup = convertedScopes.length > 0
            ? preserveMigrationBasis(basis, root, cwd, sessionId, sessionKey, { scopes: convertedScopes, presence }, updates) : undefined;
        assertOriginBasis();
        publishFileUpdates(basis.files, updates, root);
        return { cohort, changed: true, ...(migrationBackup ? { migrationBackup } : {}) };
    };
    if (!request.author)
        return finish(snapshot);
    let consumed = false;
    let accepted;
    const provenance = Object.fromEntries(scopePaths.map(({ scope, paths }) => [scope,
        scope === "session" && copy ? copy.provenance : parseScopeProvenance(sources.get(paths.meta), paths.meta)]));
    let authorActive = true;
    try {
        request.author({ view: structuredClone(originView), snapshot: structuredClone(snapshot), provenance }, (next, transition, evidence, moduleAdditions) => {
            if (!authorActive)
                throw new Error("Selected first authoring callback has ended");
            if (consumed)
                throw new Error("Selected first authoring publication was already consumed");
            consumed = true;
            accepted = finish(next, transition, evidence, moduleAdditions);
            return accepted;
        });
    }
    finally {
        authorActive = false;
    }
    if (!accepted)
        throw new Error("Selected first authoring requires one synchronous publication");
    return accepted;
}
/** Select a retained private basis only when current policy excluded it; selected Session cannot use stale proof as fallback. */
function validateSelectedPrivateStream(lifecycle, stream) {
    if (lifecycle.runtime.meta.privateAcquisition !== "acquired")
        throw new Error("State Flow private memory requires acquired authority");
    const metadata = lifecycle.runtime.meta;
    const witnesses = lifecycle.sourceVersion === 2 ? captureTemporalWitnesses(metadata.lineage, Object.hasOwn(metadata, "causalWitnesses") ? metadata.causalWitnesses : [], MAX_HISTORY_LIMIT) : [];
    const retained = lifecycle.sourceVersion === 2 && !lifecycle.runtime.config.scopes.includes("session")
        ? metadata.privateCausalBasis : undefined;
    if (retained) {
        restoreSelectedTemporalState({ session: stream }, ["session"], retained.lineage, retained.causalWitnesses, MAX_HISTORY_LIMIT);
    }
    else
        validateScopeLineage(stream, "session", metadata.lineage, MAX_HISTORY_LIMIT);
    for (const witness of witnesses.filter(item => item.owners.includes("session"))) {
        if (!stream.patches.some(record => sameJson(record.transition, witness.transition)))
            throw new Error("Accepted temporal witness is missing its selected owner patch");
    }
}
/** Admit only this direct parent's private stream; native lineage/parent authority belongs to the caller. */
function captureSelectedForkSource(cwd, childId, childKey, source, root) {
    if (!source || typeof source.id !== "string" || typeof source.key !== "string" || source.id === childId || source.key === childKey) {
        throw new Error("Selected fork requires a distinct direct-parent identity and key");
    }
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, source.id, ["session"], root, source.key);
    if (!lifecycle || lifecycle.runtime.meta.privateAcquisition !== "acquired")
        throw new Error("Selected fork parent has no acquired current private memory");
    const paths = temporalScopePaths(cwd, source.id, "session", root, source.key);
    const scopeFiles = captureOwnedFileBases([paths.checkpoint, paths.patches, paths.meta], root);
    const basis = { files: [...lifecycleFiles, ...scopeFiles] };
    const files = temporalFileContents(basis);
    const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), "session", undefined, files.get(paths.meta));
    if (!stream)
        throw new Error("Selected fork parent private stream is unavailable");
    validateSelectedPrivateStream(lifecycle, stream);
    const provenance = parseScopeProvenance(files.get(paths.meta), paths.meta);
    // Raw inheritance is bound to the same admitted parent metadata bytes as interpreted evidence.
    const rawMetadata = files.get(paths.meta);
    const rawArtifacts = rawMetadata === undefined ? undefined : JSON.parse(rawMetadata).artifacts;
    return { basis, stream, provenance, rawArtifacts, assertCurrent: () => {
            const current = { files: captureOwnedFileBases(basis.files.map((file) => file.path), root) };
            assertTemporalFileBase(basis, current);
            if (!sameJson(presence, captureOwnedFilePresence(presence.map((file) => file.path), root)))
                throw new Error("Selected fork parent presence changed concurrently");
        } };
}
/** Read-only selected admission under exclusion; never initialize a store or grant publication/acquisition. */
export async function loadSelectedFileCohort(cwd, sessionId, selection, root, sessionKey = sessionId, signal) {
    signal?.throwIfAborted();
    const wanted = captureScopeSelection(selection);
    assertStorageDirectory(root);
    if (!lstatSync(root, { throwIfNoEntry: false }))
        return undefined;
    return withStorageTransaction(root, (transaction) => transaction.prepareSelected(cwd, sessionId, wanted, root, sessionKey), signal);
}
/** Exact recapture comparison; future selected publishers must repeat both dependency checks under exclusion. */
export function assertSelectedFileCohortBasis(expected, current) {
    if (!sameJson(expected.view.selection, current.view.selection))
        throw new Error("Selected State Flow policy changed concurrently");
    assertTemporalFileBase(expected.basis, current.basis);
    if (!sameJson(expected.presence, current.presence))
        throw new Error("Selected State Flow presence dependencies changed concurrently");
}
function captureSelectedLifecycle(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle) {
    const privatePaths = temporalScopePaths(cwd, sessionId, "session", root, sessionKey);
    const privateFiles = [privatePaths.checkpoint, privatePaths.patches, privatePaths.meta];
    const legacyPrivate = resolve(privatePaths.directory, "state.json");
    const presence = captureOwnedFilePresence([...privateFiles, legacyPrivate], root);
    if (presence.at(-1).present)
        throw new Error("Unsupported State Flow private semantic layout");
    const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const lifecycleFiles = captureOwnedFileBases([runtimePaths.config, runtimePaths.runtime], root);
    // Compare before parsing: a changed legacy epoch must not widen a selected mode-only read.
    if (expectedLifecycle)
        assertTemporalFileBase(expectedLifecycle, { files: lifecycleFiles });
    const lifecycleText = temporalFileContents({ files: lifecycleFiles });
    const lifecycle = prepareSessionPolicyMigration(lifecycleText.get(runtimePaths.config), lifecycleText.get(runtimePaths.runtime), cwd, sessionId, wanted);
    if (!lifecycle) {
        if (presence.some((file) => file.present))
            throw new Error("Orphan State Flow private semantics without lifecycle authority");
        return { lifecycle, lifecycleFiles, presence };
    }
    const acquired = lifecycle.runtime.meta.privateAcquisition === "acquired";
    if (acquired && presence.slice(0, 3).some((file) => !file.present))
        throw new Error("Acquired State Flow private semantics are incomplete");
    if (!acquired && presence.some((file) => file.present))
        throw new Error("Unacquired State Flow private target is occupied");
    return { lifecycle, lifecycleFiles, presence };
}
function prepareSelectedFileCohort(cwd, sessionId, selection, root, sessionKey, expectedLifecycle) {
    const wanted = captureScopeSelection(selection);
    const captured = captureSelectedCohortSource(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle, expectedLifecycle !== undefined);
    return captured ? decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, captured) : undefined;
}
function captureSelectedCohortSource(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle, requireV2 = false) {
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle);
    if (requireV2 && lifecycle?.sourceVersion !== 2)
        throw new Error("Selected Passive persistence requires lifecycle v2 and semantic v3");
    if (!lifecycle)
        return undefined;
    if (lifecycle.runtime.meta.privateAcquisition !== "acquired" && wanted.includes("session"))
        throw new Error("Selected State Flow Session requires explicit private acquisition");
    const dependencies = lifecycle.sourceVersion === 1 ? SCOPES : wanted;
    const scopePaths = dependencies.map((scope) => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
    const layouts = captureOwnedFilePresence(scopePaths.filter(({ scope }) => scope !== "session").map(({ paths }) => resolve(paths.directory, "state.json")), root);
    if (layouts.some((file) => file.present))
        throw new Error("Unsupported State Flow selected semantic layout");
    presence.push(...layouts);
    const scopeFiles = captureOwnedFileBases(scopePaths.flatMap(({ paths }) => [paths.checkpoint, paths.patches, paths.meta]), root);
    const basis = { files: [...lifecycleFiles, ...scopeFiles] };
    return { lifecycle, basis, presence };
}
/** Current-only admission may replace stale shared alignment, never malformed private/stream/witness evidence. */
function prepareSelectedCurrent(cwd, sessionId, selection, historyLimit, root, sessionKey, expectedLifecycle) {
    const wanted = captureScopeSelection(selection);
    const source = captureSelectedCohortSource(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle);
    if (!source)
        throw new Error("Selected State Flow current session authority is unavailable");
    const { lifecycle, basis, presence } = source;
    const lineage = lifecycle.runtime.meta.lineage;
    const witnesses = lifecycle.sourceVersion === 2 ? captureTemporalWitnesses(lineage, Object.hasOwn(lifecycle.runtime.meta, "causalWitnesses") ? lifecycle.runtime.meta.causalWitnesses : [], MAX_HISTORY_LIMIT) : [];
    const dependencies = lifecycle.sourceVersion === 1 ? SCOPES : wanted;
    const files = temporalFileContents(basis);
    const origin = `files:selected-current:${randomUUID()}`;
    const empty = createSelectedTemporalState(Object.fromEntries(wanted.map((scope) => [scope, {}])), wanted, `${origin}:empty`, historyLimit);
    const streams = {};
    const provenance = {};
    let needsOrigin = false;
    for (const scope of dependencies) {
        const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
        const values = [paths.checkpoint, paths.patches, paths.meta].map((path) => files.get(path));
        if (values.some((value) => value !== undefined) && values.some((value) => value === undefined))
            throw new Error(`Selected current State Flow ${scope} requires complete or wholly absent files`);
        const stream = parseScopeStream(values[0], values[1], scope, scope === "cwd" ? cwd : undefined, values[2]);
        if (!stream && (scope === "session" || lifecycle.sourceVersion === 1))
            throw new Error(`Selected State Flow ${scope} stream is unavailable`);
        const registry = parseScopeProvenance(values[2], paths.meta);
        if (scope === "session")
            validateSelectedPrivateStream(lifecycle, stream);
        const aligned = stream !== undefined && scopeLineageMatches(stream, scope, lineage, MAX_HISTORY_LIMIT);
        if (!aligned)
            needsOrigin = true;
        // Unchanged owners must still substantiate every selected-owner claim; drift discards old shared history only.
        if (aligned && scope !== "session")
            for (const witness of witnesses.filter((item) => item.owners.includes(scope))) {
                if (!stream.patches.some((record) => sameJson(record.transition, witness.transition)))
                    throw new Error("Accepted temporal witness is missing its selected owner patch");
            }
        if (wanted.includes(scope)) {
            streams[scope] = stream ?? empty.scopes[scope];
            provenance[scope] = registry;
        }
    }
    if (!needsOrigin) {
        const decoded = decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, source);
        const view = constrainTemporalState(decoded.view, historyLimit);
        return { ...decoded, alignment: "retained", view, witnesses: temporalCausalWitnesses(view, historyLimit) };
    }
    const view = adoptSelectedTemporalStreams(streams, wanted, origin, historyLimit);
    return { basis, presence, lifecycle, provenance, view, witnesses: temporalCausalWitnesses(view, historyLimit), alignment: "current-origin" };
}
/** Decode predicted receipts too; no canonical reread is needed to establish an accepted output basis. */
function decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, captured) {
    const { lifecycle } = captured;
    const dependencies = lifecycle.sourceVersion === 1 ? SCOPES : wanted;
    const scopePaths = dependencies.map((scope) => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
    const paths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const bytePaths = new Set([paths.config, paths.runtime, ...scopePaths.flatMap(({ paths }) => [paths.checkpoint, paths.patches, paths.meta])]);
    const privatePaths = temporalScopePaths(cwd, sessionId, "session", root, sessionKey);
    const presencePaths = new Set([privatePaths.checkpoint, privatePaths.patches, privatePaths.meta, resolve(privatePaths.directory, "state.json"),
        ...scopePaths.filter(({ scope }) => scope !== "session").map(({ paths }) => resolve(paths.directory, "state.json"))]);
    const basis = { files: captured.basis.files.filter(({ path }) => bytePaths.has(path)) };
    const presence = captured.presence.filter(({ path }) => presencePaths.has(path));
    if (basis.files.length !== bytePaths.size || presence.length !== presencePaths.size)
        throw new Error("Incomplete selected State Flow dependency receipts");
    const files = temporalFileContents(basis);
    const streams = {};
    const provenance = {};
    for (const { scope, paths } of scopePaths) {
        const stream = parseScopeStream(files.get(paths.checkpoint), files.get(paths.patches), scope, scope === "cwd" ? cwd : undefined, files.get(paths.meta));
        if (!stream)
            throw new Error(`Selected State Flow ${scope} stream is unavailable`);
        streams[scope] = stream;
        const registry = parseScopeProvenance(files.get(paths.meta), paths.meta);
        if (wanted.includes(scope))
            provenance[scope] = registry;
    }
    let view;
    if (lifecycle.sourceVersion === 1) {
        const complete = { lineage: lifecycle.runtime.meta.lineage, scopes: streams };
        validateTemporalState(complete, MAX_HISTORY_LIMIT);
        view = selectTemporalState(complete, wanted, MAX_HISTORY_LIMIT);
    }
    else {
        const evidence = Object.hasOwn(lifecycle.runtime.meta, "causalWitnesses") ? lifecycle.runtime.meta.causalWitnesses : [];
        view = restoreSelectedTemporalState(streams, wanted, lifecycle.runtime.meta.lineage, evidence, MAX_HISTORY_LIMIT);
    }
    return { basis, presence, lifecycle, view, witnesses: temporalCausalWitnesses(view, MAX_HISTORY_LIMIT), provenance };
}
export function captureTemporalFileBase(cwd, sessionId, root, sessionKey = sessionId) {
    return withStoragePublicationLock(root, (locked) => ({ files: captureTemporalFileBases(cwd, sessionId, locked, sessionKey) }));
}
/** Current-only reference: exact bytes, complete identities and lineage, no aliases or history store. */
export function loadTemporalFileRevision(cwd, sessionId, root, revision, sessionKey = sessionId) {
    if (!isFileRevision(revision))
        throw new Error("File recovery requires an exact file revision");
    return withStoragePublicationLock(root, (locked) => {
        const base = { files: captureTemporalFileBases(cwd, sessionId, locked, sessionKey) };
        if (fileRevision(base, locked) !== revision)
            throw new RevisionUnavailableError(`State Flow file revision is unavailable: ${revision}`);
        return { base, revision, ...decodeFileCohort(cwd, sessionId, locked, base, sessionKey) };
    });
}
/** Publish a validated canonical cohort; runtimeOnly owns only session config/runtime files. */
export function publishTemporalStateToFiles(cwd, sessionId, view, scopes, base, root, runtime, sessionKey = sessionId, provenance, runtimeOnly = false) {
    return withStoragePublicationLock(root, (locked) => publishLockedTemporalStateToFiles(cwd, sessionId, view, scopes, base, locked, runtime, sessionKey, provenance, runtimeOnly));
}
/** Shared publication owner; callers must hold the matching store lock for the complete cohort. */
function publishLockedTemporalStateToFiles(cwd, sessionId, view, scopes, base, root, runtime, sessionKey = sessionId, provenance, runtimeOnly = false) {
    const current = { files: captureTemporalFileBases(cwd, sessionId, root, sessionKey) };
    assertTemporalFileBase(base, current);
    const { updates } = planTemporalPublication(cwd, sessionId, view, scopes, current, root, runtime, runtimeOnly, sessionKey, provenance);
    const next = { files: temporalFileReceipts(current, updates) };
    decodeFileCohort(cwd, sessionId, root, next, sessionKey);
    const revision = fileRevision(next, root);
    const convertedScopes = SCOPES.filter((scope) => {
        const path = temporalScopePaths(cwd, sessionId, scope, root, sessionKey).meta;
        const previous = current.files.find((file) => file.path === path)?.content;
        const content = updates.find((file) => file.path === path)?.content;
        return previous !== undefined && content !== undefined && JSON.parse(previous).version !== JSON.parse(content).version;
    });
    const migrationBackup = convertedScopes.length > 0 ? preserveMigrationBasis(current, root, cwd, sessionId, sessionKey, { scopes: convertedScopes }, updates) : undefined;
    publishFileUpdates(current.files, updates, root);
    return { base: next, revision, changed: updates.length > 0, ...(migrationBackup ? { migrationBackup } : {}) };
}
/** Preserve exactly the converted transaction's owned basis, never discover other sessions or source files. */
function preserveMigrationBasis(base, root, cwd, sessionId, sessionKey, conversion, updates) {
    const targetVersion = updates.some(file => file.path.endsWith("/meta.json") && file.content !== undefined && JSON.parse(file.content).version === 4) ? 4 : 3;
    const content = `${canonicalJson({ version: 1, kind: "state-flow-semantic-migration", targetVersion,
        root: resolve(root), cwd: resolve(cwd), sessionId, sessionKey, convertedScopes: conversion.scopes,
        ...(conversion.lifecycle ? { lifecycleConversion: conversion.lifecycle } : {}),
        ...(conversion.presence ? { presenceDependencies: conversion.presence.map((file) => ({ path: relative(root, file.path), present: file.present })) } : {}),
        updatedPaths: updates.map((file) => relative(root, file.path)),
        files: base.files.map((file) => ({ path: relative(root, file.path), identity: file.identity,
            bytes: file.bytes === undefined ? null : Buffer.from(file.bytes).toString("base64") })),
    })}\n`;
    const directory = resolve(dirname(root), `${basename(root)}-migration-backups`);
    assertStorageDirectory(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
        throw new Error("State Flow migration backup directory must be private; canonical files preserved");
    }
    const path = resolve(directory, `${createHash("sha256").update(content).digest("hex")}.json`);
    try {
        writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== content) {
        throw new Error("State Flow migration backup is unavailable or changed; canonical files preserved");
    }
    return path;
}
function publishFileUpdates(bases, updates, root) {
    writeOwnedFileUpdates(updates, bases, root);
    try {
        assertOwnedFileUpdates(updates, root);
    }
    catch (error) {
        try {
            const touched = new Set(updates.map(({ path }) => path));
            restoreDurableFileBases(bases.filter(({ path }) => touched.has(path)), root, updates);
        }
        catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "State Flow file publication and rollback failed");
        }
        throw error;
    }
}
