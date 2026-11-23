// Domain: visible self-healing of unrecoverable canonical scope cohorts by quarantine and reset to absence.
// Excludes: semantic repair, Git restoration, foreign-owner data, transient I/O failures and Pi lifecycle policy.
import { createHash } from "node:crypto";
import { constants, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { canonicalJson } from "./json.js";
import { RetiredSemanticFormatError } from "./migration.js";
import { sessionRuntimePaths, temporalScopePaths } from "./durable.js";
import { captureScopeSelection } from "./selection.js";
import { RevisionUnavailableError, UnsupportedLifecycleFormatError } from "./snapshot.js";
import { assertStorageDirectory, PublicationBusyError, withStorageTransaction } from "./storage.js";
/**
 * Only semantic decoding/validation failures are healable. Filesystem, lock, cancellation and
 * foreign-owner identity failures keep failing closed because resetting cannot fix them safely.
 */
export function isHealableCorruption(error) {
    if (!(error instanceof Error))
        return false;
    if (error instanceof RevisionUnavailableError || error instanceof PublicationBusyError
        || error instanceof RetiredSemanticFormatError || error instanceof UnsupportedLifecycleFormatError)
        return false;
    if (error.name === "AbortError")
        return false;
    if (typeof error.code === "string")
        return false;
    if (/identity mismatch/i.test(error.message))
        return false;
    if (error instanceof AggregateError)
        return error.errors.every(isHealableCorruption);
    return true;
}
function scopeFiles(request, scope) {
    const paths = temporalScopePaths(request.cwd, request.sessionId, scope, request.root, request.sessionKey);
    const semantic = [paths.checkpoint, paths.patches, paths.meta, resolve(paths.directory, "state.json")];
    if (scope !== "session")
        return semantic;
    const runtime = sessionRuntimePaths(request.cwd, request.sessionId, request.root, request.sessionKey);
    return [...semantic, runtime.config, runtime.runtime];
}
function readPresent(path) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat)
        return undefined;
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`State Flow quarantine refuses a non-regular file: ${JSON.stringify(path)}`);
    return readFileSync(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
}
/** Exact-byte private record first; canonical files are removed only after the record verifies. */
function quarantineScope(request, scope, reason) {
    const root = resolve(request.root);
    const files = scopeFiles(request, scope).map(path => ({ path, bytes: readPresent(path) })).filter(file => file.bytes !== undefined);
    if (files.length === 0)
        return undefined;
    const at = (request.now?.() ?? new Date()).toISOString();
    const content = `${canonicalJson({ version: 1, kind: "state-flow-quarantine", at, root, cwd: resolve(request.cwd),
        sessionId: request.sessionId, sessionKey: request.sessionKey, scope, reason,
        files: files.map(file => ({ path: relative(root, file.path), bytes: file.bytes.toString("base64") })) })}\n`;
    const directory = resolve(dirname(root), `${basename(root)}-quarantine`);
    assertStorageDirectory(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
        throw new Error("State Flow quarantine directory must be private; canonical files preserved");
    }
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const path = resolve(directory, `${at.replace(/[:.]/g, "-")}-${scope}-${digest}.json`);
    try {
        writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    if (readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== content) {
        throw new Error("State Flow quarantine record changed; canonical files preserved");
    }
    for (const file of files)
        rmSync(file.path);
    return { scope, reason, quarantine: path };
}
function probe(action, signal) {
    try {
        action();
        return undefined;
    }
    catch (error) {
        // Cancellation reasons are arbitrary values; they never prove corruption.
        signal?.throwIfAborted();
        if (!isHealableCorruption(error))
            throw error;
        return error;
    }
}
/**
 * Converge the selected owners to a loadable store: decode each owner independently, then the
 * complete selected cohort. A broken owner is quarantined and becomes wholly absent, which the
 * normal lifecycle treats as empty memory. Healthy stores are never written.
 */
export function healSelectedStoreLocked(storage, request, signal) {
    const wanted = captureScopeSelection(request.selection);
    const { cwd, sessionId, sessionKey, root, historyLimit } = request;
    const healed = [];
    const reset = (scope, error) => {
        const result = quarantineScope(request, scope, error.message);
        if (result)
            healed.push(result);
    };
    // An incompatible lifecycle must refuse before any selected shared owner can be reset.
    let lifecycle;
    const lifecycleFailure = probe(() => { lifecycle = storage.inspectSelectedLifecycle(cwd, sessionId, wanted, root, sessionKey); }, signal);
    for (const scope of wanted.filter(owner => owner !== "session")) {
        const failure = probe(() => storage.observeSelectedShared(cwd, captureScopeSelection([scope]), root), signal);
        if (failure)
            reset(scope, failure);
    }
    if (lifecycleFailure) {
        reset("session", lifecycleFailure);
        return { healed, lifecycleAbsent: true };
    }
    if (!lifecycle)
        return { healed, lifecycleAbsent: true };
    if (wanted.includes("session") && lifecycle.runtime.meta.privateAcquisition !== "acquired")
        return { healed, lifecycleAbsent: false };
    // The session lifecycle anchors cross-owner lineage, so a contradictory cohort resets that private anchor.
    const cohortFailure = probe(() => storage.prepareSelectedCurrent(cwd, sessionId, wanted, historyLimit, root, sessionKey), signal);
    if (cohortFailure)
        reset("session", cohortFailure);
    return { healed, lifecycleAbsent: cohortFailure !== undefined };
}
/** Never waits behind a live writer: a busy store is being used, so healing defers to a later attempt. */
export async function healSelectedStore(request, signal) {
    const root = resolve(request.root);
    if (!lstatSync(root, { throwIfNoEntry: false }))
        return { healed: [], lifecycleAbsent: true };
    return withStorageTransaction(root, storage => healSelectedStoreLocked(storage, { ...request, root }, signal), signal, false);
}
/** One pending reset notice: projected to the model until an agent run settles after seeing it. */
export class HealNotice {
    #message;
    #projected = false;
    announce(message) {
        this.#message = message;
        this.#projected = false;
    }
    /** Model-facing text for the current request, marking it as seen. */
    project() {
        if (this.#message === undefined)
            return undefined;
        this.#projected = true;
        return `${this.#message}. Tell the user about this State Flow memory reset in your next answer.`;
    }
    /** A settled run that saw the notice consumes it; an unseen notice survives. */
    settle() {
        if (!this.#projected)
            return;
        this.#message = undefined;
        this.#projected = false;
    }
}
export function describeHealedScopes(healed) {
    return healed.map(item => `${item.scope} memory was unreadable (${item.reason}) and was reset to empty; original bytes quarantined at ${item.quarantine}`).join("; ");
}
