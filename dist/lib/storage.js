// Domain: exact file-cohort publication, current-only recovery, and cooperating worktree exclusion.
// Excludes: temporal algebra, Pi lifecycle, Git objects/remotes, and backend fallback policy.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureDirectoryBasis, captureOwnedFileBases, captureOwnedFilePresence, classifyScopeStream, decodeScopeStream, parseScopeProvenance, parseScopeStream, serializeScopeMetadata, serializeScopeStream, sessionRuntimePaths, temporalScopePaths, writeOwnedFileUpdates, } from "./durable.js";
import { isInterpretableArtifactProvenance, parseArtifactProvenanceRegistry } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, decodeUtf8, InvalidStateFlowData, isJsonValue, isObject, sameJson } from "./json.js";
import { parseScopeMetadataHeader, prepareSerializedScopeMigration } from "./migration.js";
import { RevisionUnavailableError, parseSelectedLifecycle, parseSelectedLifecycleHeader, decodeSelectedLifecycle, captureLifecycleSnapshot, capturePrivateCausalBasis, serializeBaselineLifecycle } from "./snapshot.js";
import { restoreSelectedTemporalState, temporalCausalWitnesses, constrainTemporalState, advanceTemporalState, createSelectedTemporalState, adoptSelectedTemporalStreams, validateScopeLineage, scopeLineageMatches, captureTemporalWitnesses, readTemporalView } from "./temporal.js";
import { captureScopeSelection } from "./selection.js";
import { validateRetainedModules } from "./semantic-module.js";
/** Opaque CAS capture stays byte-exact; semantic consumers alone require lossless text. */
function fileText(file) {
    return file.bytes === undefined ? file.content : decodeUtf8(file.bytes, `State Flow file ${JSON.stringify(file.path)}`);
}
export function temporalFileContents(base) {
    return new Map(base.files.map(file => [file.path, fileText(file)]));
}
export function decodeLifecycleFilePair(config, runtime, cwd, sessionId) {
    return parseSelectedLifecycle(() => fileText(config), fileText(runtime), cwd, sessionId);
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
function publicationLockOwner(path) {
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
    if (!Number.isSafeInteger(pid))
        return "unavailable";
    try {
        process.kill(pid, 0);
        return "live";
    }
    catch (error) {
        return error.code === "EPERM" ? "live" : "unavailable";
    }
}
export class PublicationBusyError extends Error {
    constructor(path) { super(`State Flow publication lock is busy at ${JSON.stringify(path)}`); }
}
/** A recognized temporary failure at the canonical lock admission boundary, not unavailable memory in general. */
export class TransientStorageAcquisitionError extends RevisionUnavailableError {
}
function canonicalLockUnavailable(path, cause) {
    const message = `State Flow publication lock is unavailable at ${JSON.stringify(path)}`;
    if (cause instanceof Error && ["EAGAIN", "EBUSY"].includes(cause.code ?? "")) {
        return new TransientStorageAcquisitionError(`Temporary ${message}`, { cause });
    }
    return new RevisionUnavailableError(message, { cause });
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
                owner = publicationLockOwner(path);
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
        const cleanup = [];
        try {
            const current = lstatSync(path, { throwIfNoEntry: false });
            if (!identity || !current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
                || readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== `${process.pid}\n`) {
                throw new Error(`State Flow publication lock changed during transaction at ${JSON.stringify(path)}; current owner preserved`);
            }
            rmSync(path);
        }
        catch (error) {
            cleanup.push(error);
        }
        try {
            closeSync(descriptor);
        }
        catch (error) {
            cleanup.push(error);
        }
        if (cleanup.length) {
            if (failed || cleanup.length > 1)
                throw new AggregateError(failed ? [failed.error, ...cleanup] : cleanup, "State Flow storage lock release failed");
            throw cleanup[0];
        }
    }
}
/** Await store-wide exclusion, then capture/apply/publish through callback-scoped operations. */
export async function withStorageTransaction(repositoryRoot, action, signal, waitForLock = true) {
    const root = resolve(repositoryRoot), lock = resolve(root, ".state-flow-publication.lock");
    return withFilePublicationLock(lock, async () => {
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
            prepareSelectedRecovery: (cwd, sessionId, selection, requestedRoot, sessionKey) => {
                guard(requestedRoot);
                const plan = captureSelectedRecovery(cwd, sessionId, selection, root, sessionKey, signal);
                return {
                    damage: plan.damage.map(({ scope, files, cause }) => ({ scope, files: structuredClone(files), cause })),
                    lifecycleAbsent: plan.lifecycleAbsent,
                    reset: (revalidate) => {
                        guard(requestedRoot);
                        if (selectedPublicationUsed)
                            throw new Error("Selected State Flow publication capability was already used");
                        selectedPublicationUsed = true;
                        if (!plan.damage.length)
                            return;
                        const updates = plan.damage.flatMap(({ files }) => files.filter(file => file.identity !== "missing").map(({ path }) => ({ path })));
                        const removed = new Set(updates.map(({ path }) => path));
                        writeOwnedFileUpdates(updates, plan.basis.files, root, phase => {
                            if (phase === "before")
                                revalidate?.();
                            if (!sameJson(plan.directories, captureDirectoryBasis(plan.directoryPaths))) {
                                throw new Error("State Flow recovery directory identity changed concurrently");
                            }
                            const basis = phase === "before" ? plan.basis : { files: temporalFileReceipts(plan.basis, updates) };
                            assertTemporalFileBase(basis, { files: captureOwnedFileBases(basis.files.map(({ path }) => path), root) });
                            const presence = phase === "before" ? plan.presence : plan.presence.map(file => removed.has(file.path) ? { ...file, present: false } : file);
                            if (!sameJson(presence, captureOwnedFilePresence(presence.map(({ path }) => path), root))) {
                                throw new Error("State Flow recovery presence dependencies changed concurrently");
                            }
                            if (phase === "before")
                                guard(requestedRoot);
                        });
                    },
                };
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
                captureScopeSelection(selection);
                return captureSelectedLifecycle(cwd, sessionId, root, sessionKey).lifecycle !== undefined;
            },
            inspectSelectedLifecycle: (cwd, sessionId, selection, requestedRoot, sessionKey = sessionId) => {
                guard(requestedRoot);
                captureScopeSelection(selection);
                return captureSelectedLifecycle(cwd, sessionId, root, sessionKey).lifecycle;
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
        });
        try {
            return await action(transaction);
        }
        finally {
            active = false;
        }
    }, signal, cause => canonicalLockUnavailable(lock, cause), waitForLock);
}
export function assertTemporalFileBase(expected, current) {
    if (expected.files.length !== current.files.length || current.files.some((file, index) => {
        const previous = expected.files[index];
        return file.path !== previous.path || file.identity !== previous.identity;
    }))
        throw new Error("Temporal State Flow base or scope identity changed concurrently");
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
    const basis = { files: captureSelectedSemanticFiles(layouts, cwd, root) };
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
        else if (current.lifecycle.runtime.config.scopes.includes("session")) {
            // Retain the admitted private proof, not a possibly realigned shared-only view.
            metadata.privateCausalBasis = capturePrivateCausalBasis({ lineage: current.lifecycle.runtime.meta.lineage,
                causalWitnesses: current.lifecycle.runtime.meta.causalWitnesses ?? [] });
        }
    }
    metadata.lineage = structuredClone(expected.lineage);
    metadata.causalWitnesses = temporalCausalWitnesses(expected, historyLimit);
    const runtime = {
        config: { mode: lifecycle?.config.mode ?? current.lifecycle.runtime.config.mode, scopes: expected.selection },
        meta: metadata,
    };
    const sources = temporalFileContents(current.basis);
    const updates = [];
    const convertedScopes = [];
    let materialAcceptance = expected.lineage.at(-1).id !== current.view.lineage.at(-1).id;
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
        materialAcceptance ||= metadataChanged;
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
    const writeBaseline = current.lifecycle.sourceVersion === "baseline" || current.lifecycle.sourceVersion === 2 && !lifecycleOnly && materialAcceptance;
    const targetLifecycle = planSelectedLifecycle(runtime, cwd, sessionId, writeBaseline);
    if (sources.get(paths.config) !== targetLifecycle.target.config)
        updates.push({ path: paths.config, content: targetLifecycle.target.config });
    if (sources.get(paths.runtime) !== targetLifecycle.target.runtime)
        updates.push({ path: paths.runtime, content: targetLifecycle.target.runtime });
    if (lifecycleOnly && updates.some(update => update.path !== paths.config && update.path !== paths.runtime)) {
        throw new Error("Selected Passive persistence requires an admitted lifecycle without semantic changes");
    }
    const receipts = { files: temporalFileReceipts(current.basis, updates) };
    const cohort = decodeSelectedFileCohort(cwd, sessionId, expected.selection, root, sessionKey, { lifecycle: targetLifecycle, basis: receipts, presence: current.presence });
    if (!sameJson(cohort.view, expected) || !sameJson(cohort.provenance, nextProvenance))
        throw new Error("Selected State Flow receipt does not match accepted replay");
    const lifecycleConversion = selectedLifecycleConversion(current.lifecycle, targetLifecycle);
    const assertPresence = () => {
        if (!sameJson(current.presence, captureOwnedFilePresence(current.presence.map((file) => file.path), root)))
            throw new Error("Selected State Flow presence dependencies changed concurrently");
    };
    assertPresence();
    const migrationBackup = convertedScopes.length > 0 || lifecycleConversion !== undefined
        ? preserveMigrationBasis(current.basis, root, cwd, sessionId, sessionKey, { scopes: convertedScopes, lifecycle: lifecycleConversion, presence: current.presence }, updates) : undefined;
    assertPresence();
    writeOwnedFileUpdates(updates, current.basis.files, root);
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
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, sessionId, root, sessionKey);
    let prior;
    if (request.kind === "unacquired" || request.kind === "fork-deferred") {
        const required = request.kind === "fork-deferred" ? "deferred" : "unacquired";
        if (!lifecycle || lifecycle.runtime.meta.privateAcquisition !== required) {
            throw new Error(`Selected private acquisition requires admitted ${required} lifecycle authority`);
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
    const scopeFiles = captureSelectedSemanticFiles(scopePaths, cwd, root);
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
        const target = planSelectedLifecycle({
            config: { mode: snapshot.config.mode, scopes: wanted },
            meta: { ...metadata, step: snapshot.meta.step, version: 2, identity: { cwd: resolve(cwd), sessionId }, lineage: view.lineage,
                privateAcquisition: acquiring ? "acquired" : request.kind === "shared-deferred" ? "deferred" : "unacquired",
                causalWitnesses: temporalCausalWitnesses(view, request.historyLimit) },
        }, cwd, sessionId, true);
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
        const lifecycleConversion = prior && selectedLifecycleConversion(prior.lifecycle, target);
        const migrationBackup = convertedScopes.length > 0 || lifecycleConversion !== undefined
            ? preserveMigrationBasis(basis, root, cwd, sessionId, sessionKey, { scopes: convertedScopes, lifecycle: lifecycleConversion, presence }, updates) : undefined;
        assertOriginBasis();
        writeOwnedFileUpdates(updates, basis.files, root);
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
    const witnesses = captureTemporalWitnesses(metadata.lineage, lifecycleWitnesses(lifecycle), MAX_HISTORY_LIMIT);
    const retained = !lifecycle.runtime.config.scopes.includes("session")
        ? metadata.privateCausalBasis : undefined;
    if (retained) {
        restoreSelectedTemporalState({ session: stream }, ["session"], retained.lineage, retained.causalWitnesses, MAX_HISTORY_LIMIT);
    }
    else
        validateScopeLineage(stream, "session", metadata.lineage, MAX_HISTORY_LIMIT);
    for (const witness of witnesses.filter(item => item.owners.includes("session"))) {
        if (!stream.patches.some(record => sameJson(record.transition, witness.transition)))
            throw new InvalidStateFlowData("Accepted temporal witness is missing its selected owner patch");
    }
}
/** Admit only this direct parent's private stream; native lineage/parent authority belongs to the caller. */
function captureSelectedForkSource(cwd, childId, childKey, source, root) {
    if (!source || typeof source.id !== "string" || typeof source.key !== "string" || source.id === childId || source.key === childKey) {
        throw new Error("Selected fork requires a distinct direct-parent identity and key");
    }
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, source.id, root, source.key);
    if (!lifecycle || lifecycle.runtime.meta.privateAcquisition !== "acquired")
        throw new Error("Selected fork parent has no acquired current private memory");
    const paths = temporalScopePaths(cwd, source.id, "session", root, source.key);
    const scopeFiles = captureSelectedSemanticFiles([{ scope: "session", paths }], cwd, root);
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
const semanticPaths = (paths) => [paths.checkpoint, paths.patches, paths.meta];
const predecessorPath = (paths) => resolve(paths.directory, "state.json");
function captureSelectedSemanticFiles(layouts, cwd, root) {
    const headers = captureOwnedFileBases(layouts.map(({ paths }) => paths.meta), root);
    layouts.forEach(({ scope }, i) => {
        const text = fileText(headers[i]);
        if (text !== undefined)
            parseScopeMetadataHeader(text, scope, scope === "cwd" ? cwd : undefined);
    });
    return layouts.flatMap(({ paths }, i) => [...captureOwnedFileBases([paths.checkpoint, paths.patches], root), headers[i]]);
}
/** A data validator refuses drafts too. Only this ingestion boundary binds its expected failure to a captured owner. */
function diagnoseCapturedData(read, signal) {
    try {
        return { value: read() };
    }
    catch (cause) {
        signal?.throwIfAborted();
        if (!(cause instanceof InvalidStateFlowData))
            throw cause;
        return { cause };
    }
}
function captureSelectedRecovery(cwd, sessionId, selection, root, sessionKey, signal) {
    const wanted = captureScopeSelection(selection);
    const { config, runtime } = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const privatePaths = temporalScopePaths(cwd, sessionId, "session", root, sessionKey);
    const layouts = wanted.map(scope => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
    const directoryPaths = [...new Set([root, privatePaths.directory, ...layouts.map(({ paths }) => paths.directory)])];
    const directories = captureDirectoryBasis(directoryPaths);
    const presence = captureOwnedFilePresence([...new Set([config, runtime, ...semanticPaths(privatePaths), predecessorPath(privatePaths),
            ...layouts.flatMap(({ paths }) => [...semanticPaths(paths), predecessorPath(paths)])])], root);
    const present = new Set(presence.filter(file => file.present).map(file => file.path));
    if (layouts.some(({ paths }) => present.has(predecessorPath(paths))) || present.has(predecessorPath(privatePaths))) {
        throw new Error("Unsupported State Flow recovery layout; predecessor files were preserved");
    }
    const capture = (paths) => {
        signal?.throwIfAborted();
        const files = captureOwnedFileBases(paths, root);
        if (files.some(file => present.has(file.path) !== (file.identity !== "missing")))
            throw new Error("State Flow recovery presence changed during capture");
        return files;
    };
    const [runtimeFile, ...headers] = capture([runtime, ...layouts.map(({ paths }) => paths.meta)]);
    const headerFiles = new Map(headers.map(file => [file.path, file]));
    const privatePresent = semanticPaths(privatePaths).filter(path => present.has(path));
    if (!present.has(runtime) && (present.has(config) || privatePresent.length > 0)) {
        throw new Error("State Flow recovery cannot prove a supported private lifecycle; files were preserved");
    }
    // Header failures are never promoted to corruption. No semantic body or config is decoded yet.
    const admittedHeader = (owner, read) => {
        const result = diagnoseCapturedData(read, signal);
        if ("cause" in result)
            throw new Error(`State Flow recovery cannot prove the ${owner} header; files were preserved`, { cause: result.cause });
        return result.value;
    };
    const lifecycleHeader = runtimeFile.identity === "missing" ? undefined
        : admittedHeader("private lifecycle", () => parseSelectedLifecycleHeader(fileText(runtimeFile), cwd, sessionId));
    const acquisition = lifecycleHeader?.metadata.privateAcquisition;
    if (lifecycleHeader && acquisition !== "acquired" && acquisition !== "unacquired" && acquisition !== "deferred") {
        throw new Error("State Flow recovery cannot prove private acquisition authority; files were preserved");
    }
    if (acquisition !== "acquired" && privatePresent.length)
        throw new Error("Unacquired State Flow private target is occupied");
    for (const { scope, paths } of layouts) {
        if (present.has(paths.meta))
            admittedHeader(scope, () => parseScopeMetadataHeader(fileText(headerFiles.get(paths.meta)), scope, scope === "cwd" ? cwd : undefined));
        else if (semanticPaths(paths).some(path => present.has(path))) {
            throw new Error(`State Flow recovery cannot prove the ${scope} format and owner without metadata; files were preserved`);
        }
    }
    if (acquisition === "acquired" && !wanted.includes("session") && privatePresent.length > 0 && privatePresent.length < 3) {
        throw new Error("Acquired State Flow private semantics are incomplete; excluded files were preserved");
    }
    const [configFile, ...bodies] = capture([config, ...layouts.flatMap(({ paths }) => [paths.checkpoint, paths.patches])]);
    const basis = { files: [runtimeFile, ...headers, configFile, ...bodies] };
    const byPath = new Map(basis.files.map(file => [file.path, file]));
    const damage = [];
    const privateFiles = basis.files.filter(({ path }) => path === config || path === runtime || semanticPaths(privatePaths).includes(path));
    const record = (scope, cause, files) => {
        if (!damage.some(entry => entry.scope === scope))
            damage.push({ scope, cause, files });
    };
    let lifecycle;
    if (lifecycleHeader) {
        const result = diagnoseCapturedData(() => decodeSelectedLifecycle(lifecycleHeader, fileText(configFile), cwd, sessionId), signal);
        if ("cause" in result) {
            if (acquisition === "deferred" || (privatePresent.length > 0 && !wanted.includes("session")))
                throw result.cause;
            record("session", result.cause, privateFiles);
        }
        else
            lifecycle = result.value;
    }
    if (acquisition === "acquired" && privatePresent.length === 0) {
        // Existing disappeared-private restart, backed by the retained owned acquired lifecycle.
        record("session", new InvalidStateFlowData("Acquired State Flow private semantics are missing"), privateFiles);
    }
    const streams = {};
    for (const { scope, paths } of layouts) {
        if (!present.has(paths.meta))
            continue;
        const files = semanticPaths(paths).map(path => byPath.get(path));
        const [checkpoint, patches, meta] = files.map(file => file.bytes);
        const result = diagnoseCapturedData(() => decodeScopeStream({ checkpoint, patches, meta }, scope, cwd), signal);
        if ("cause" in result)
            record(scope, result.cause, scope === "session" ? privateFiles : files);
        else
            streams[scope] = result.value;
    }
    // The private stream and its own lifecycle suffice; shared damage proves nothing about this pair.
    if (lifecycle && streams.session && !damage.some(item => item.scope === "session")) {
        const document = lifecycle, stream = streams.session;
        const result = diagnoseCapturedData(() => validateSelectedPrivateStream(document, stream), signal);
        if ("cause" in result)
            record("session", result.cause, privateFiles);
    }
    // Ambiguous cross-owner disagreement is a refusal, not a reason to discard the private anchor.
    if (!damage.length && lifecycle && !(wanted.includes("session") && acquisition !== "acquired")
        && !currentSharedNeedsOrigin(lifecycle, wanted, streams)) {
        restoreSelectedTemporalState(streams, wanted, lifecycle.runtime.meta.lineage, lifecycleWitnesses(lifecycle), MAX_HISTORY_LIMIT);
    }
    signal?.throwIfAborted();
    return { damage, basis, presence, directories, directoryPaths, lifecycleAbsent: !lifecycleHeader || damage.some(item => item.scope === "session") };
}
function captureSelectedLifecycle(cwd, sessionId, root, sessionKey, expectedLifecycle) {
    const runtimePaths = sessionRuntimePaths(cwd, sessionId, root, sessionKey);
    const lifecycleFiles = captureOwnedFileBases([runtimePaths.config, runtimePaths.runtime], root);
    // Compare before parsing: a replaced lifecycle cannot widen this read.
    if (expectedLifecycle)
        assertTemporalFileBase(expectedLifecycle, { files: lifecycleFiles });
    const lifecycle = decodeLifecycleFilePair(lifecycleFiles[0], lifecycleFiles[1], cwd, sessionId);
    const privatePaths = temporalScopePaths(cwd, sessionId, "session", root, sessionKey);
    const presence = captureOwnedFilePresence([privatePaths.checkpoint, privatePaths.patches, privatePaths.meta, resolve(privatePaths.directory, "state.json")], root);
    if (presence.at(-1).present)
        throw new Error("Unsupported State Flow private semantic layout");
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
    const captured = captureSelectedCohortSource(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle);
    return captured ? decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, captured) : undefined;
}
function captureSelectedCohortSource(cwd, sessionId, wanted, root, sessionKey, expectedLifecycle) {
    const { lifecycle, lifecycleFiles, presence } = captureSelectedLifecycle(cwd, sessionId, root, sessionKey, expectedLifecycle);
    if (!lifecycle)
        return undefined;
    if (lifecycle.runtime.meta.privateAcquisition !== "acquired" && wanted.includes("session"))
        throw new Error("Selected State Flow Session requires explicit private acquisition");
    const scopePaths = wanted.map((scope) => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
    const layouts = captureOwnedFilePresence(scopePaths.filter(({ scope }) => scope !== "session").map(({ paths }) => resolve(paths.directory, "state.json")), root);
    if (layouts.some((file) => file.present))
        throw new Error("Unsupported State Flow selected semantic layout");
    presence.push(...layouts);
    const scopeFiles = captureSelectedSemanticFiles(scopePaths, cwd, root);
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
    const files = temporalFileContents(basis);
    const origin = `files:selected-current:${randomUUID()}`;
    const empty = createSelectedTemporalState(Object.fromEntries(wanted.map((scope) => [scope, {}])), wanted, `${origin}:empty`, historyLimit);
    const streams = {};
    const provenance = {};
    for (const scope of wanted) {
        const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
        const values = [paths.checkpoint, paths.patches, paths.meta].map((path) => files.get(path));
        if (values.some((value) => value !== undefined) && values.some((value) => value === undefined))
            throw new Error(`Selected current State Flow ${scope} requires complete or wholly absent files`);
        const stream = parseScopeStream(values[0], values[1], scope, scope === "cwd" ? cwd : undefined, values[2]);
        if (!stream && scope === "session")
            throw new Error(`Selected State Flow ${scope} stream is unavailable`);
        const registry = parseScopeProvenance(values[2], paths.meta);
        if (scope === "session")
            validateSelectedPrivateStream(lifecycle, stream);
        streams[scope] = stream;
        provenance[scope] = registry;
    }
    if (!currentSharedNeedsOrigin(lifecycle, wanted, streams)) {
        const decoded = decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, source);
        const view = constrainTemporalState(decoded.view, historyLimit);
        return { ...decoded, alignment: "retained", view, witnesses: temporalCausalWitnesses(view, historyLimit) };
    }
    for (const scope of wanted)
        streams[scope] ??= empty.scopes[scope];
    const view = adoptSelectedTemporalStreams(streams, wanted, origin, historyLimit);
    return { basis, presence, lifecycle, provenance, view, witnesses: temporalCausalWitnesses(view, historyLimit), alignment: "current-origin" };
}
function currentSharedNeedsOrigin(lifecycle, wanted, streams) {
    const lineage = lifecycle.runtime.meta.lineage;
    const witnesses = captureTemporalWitnesses(lineage, lifecycleWitnesses(lifecycle), MAX_HISTORY_LIMIT);
    let needsOrigin = false;
    for (const scope of wanted) {
        const stream = streams[scope];
        const aligned = stream !== undefined && scopeLineageMatches(stream, scope, lineage, MAX_HISTORY_LIMIT);
        if (!aligned)
            needsOrigin = true;
        // Unchanged owners must substantiate selected-owner claims; shared drift discards old alignment only.
        if (aligned && scope !== "session")
            for (const witness of witnesses.filter(item => item.owners.includes(scope))) {
                if (!stream.patches.some(record => sameJson(record.transition, witness.transition)))
                    throw new Error("Accepted temporal witness is missing its selected owner patch");
            }
    }
    return needsOrigin;
}
/** Decode predicted receipts too; no canonical reread is needed to establish an accepted output basis. */
function decodeSelectedFileCohort(cwd, sessionId, wanted, root, sessionKey, captured) {
    const { lifecycle } = captured;
    const scopePaths = wanted.map((scope) => ({ scope, paths: temporalScopePaths(cwd, sessionId, scope, root, sessionKey) }));
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
        provenance[scope] = parseScopeProvenance(files.get(paths.meta), paths.meta);
    }
    const view = restoreSelectedTemporalState(streams, wanted, lifecycle.runtime.meta.lineage, lifecycleWitnesses(lifecycle), MAX_HISTORY_LIMIT);
    return { basis, presence, lifecycle, view, witnesses: temporalCausalWitnesses(view, MAX_HISTORY_LIMIT), provenance };
}
function lifecycleWitnesses(document) {
    const meta = document.runtime.meta;
    return Object.hasOwn(meta, "causalWitnesses") ? meta.causalWitnesses : [];
}
function planSelectedLifecycle(runtime, cwd, sessionId, baseline) {
    const wire = baseline ? serializeBaselineLifecycle(runtime, cwd, sessionId)
        : { config: `${canonicalJson(runtime.config)}\n`, runtime: `${canonicalJson(runtime.meta)}\n` };
    return parseSelectedLifecycle(wire.config, wire.runtime, cwd, sessionId);
}
function selectedLifecycleConversion(source, target) {
    if (source.sourceVersion === 2 && target.sourceVersion === "baseline")
        return { sourceVersion: 2, targetVersion: "baseline" };
    return undefined;
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
