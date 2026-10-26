import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashArtifactSource, isArtifactHash, } from "./artifact.js";
import { isObject } from "./json.js";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION } from "./selection.js";
export const SKILL_ARTIFACT_COMPILER = "skill-artifact-v1";
function hasContent(value) {
    if (typeof value === "string")
        return value.trim().length > 0;
    if (Array.isArray(value))
        return value.length > 0;
    if (isObject(value))
        return Object.keys(value).length > 0;
    return value !== undefined && value !== null;
}
export function hasCompiledSkillArtifact(artifacts, provenance, source, expectedHash) {
    const metadata = artifacts[source];
    if (!isObject(metadata)
        || metadata.kind !== "skill"
        || !isObject(metadata.compilation)
        || !hasContent(metadata.compilation)
        || provenance?.malformed === true)
        return false;
    const compilerRevision = provenance !== undefined && Object.hasOwn(provenance, "compilerRevision")
        ? provenance.compilerRevision
        : metadata.compiler;
    const sourceHash = provenance !== undefined && Object.hasOwn(provenance, "sourceHash")
        ? provenance.sourceHash
        : metadata.hash;
    return compilerRevision === SKILL_ARTIFACT_COMPILER
        && (expectedHash === undefined || sourceHash === expectedHash);
}
export function hashSkillSource(source) {
    const expected = lstatSync(source, { bigint: true });
    if (!expected.isFile() || expected.isSymbolicLink())
        throw new Error("Skill source must be a regular non-symlink file");
    const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino)
            throw new Error("Skill source changed before identity capture");
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor, { bigint: true });
        const current = lstatSync(source, { bigint: true });
        if (current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
            || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
            || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs)
            throw new Error("Skill source changed during identity capture");
        return hashArtifactSource(bytes);
    }
    finally {
        closeSync(descriptor);
    }
}
function readPath(toolName, args) {
    if (toolName !== "read" || !isObject(args) || typeof args.path !== "string")
        return undefined;
    return args.path;
}
export function registeredSkillResolver(cwd, commands) {
    const skills = new Map();
    const conflicts = new Set();
    for (const command of commands) {
        if (command.source !== "skill")
            continue;
        const scope = command.sourceInfo.scope === "user" ? "global"
            : command.sourceInfo.scope === "project" ? "cwd"
                : command.sourceInfo.scope === "temporary" ? "session"
                    : undefined;
        if (!scope)
            continue;
        const path = resolve(cwd, command.sourceInfo.path);
        const existing = skills.get(path);
        if (existing && existing.scope !== scope) {
            skills.delete(path);
            conflicts.add(path);
        }
        else if (!conflicts.has(path)) {
            skills.set(path, { path, scope });
        }
    }
    return (path) => skills.get(resolve(cwd, path));
}
/** Correlates Pi's mutable tool lifecycle and captures trusted source identity. */
export class SkillReadTracker {
    successful = new Map();
    #pending = new Map();
    hashSource;
    resolveRegistered;
    #selection;
    constructor(hashSource = hashSkillSource, resolveRegistered = () => undefined, selection = DEFAULT_SCOPE_SELECTION) {
        this.hashSource = hashSource;
        this.resolveRegistered = resolveRegistered;
        this.#selection = captureScopeSelection(selection);
    }
    /** Selection changes revoke correlated reads; a disabled Skill still retains ownership-only volatile evidence. */
    select(selection) {
        const wanted = captureScopeSelection(selection);
        if (wanted.join(",") !== this.#selection.join(","))
            this.clear();
        this.#selection = wanted;
    }
    /** Rehash only attempted selected compilations; this body acquisition must run outside canonical exclusion. */
    validateCompilations(patches) {
        for (const scope of Object.keys(patches))
            if (!this.#selection.includes(scope))
                throw new Error(`State Flow ${scope} Skill compilation owner is excluded`);
        for (const read of this.successful.values()) {
            if (!this.#selection.includes(read.scope) || !Object.hasOwn(patches, read.scope))
                continue;
            const artifacts = patches[read.scope]?.artifacts;
            if (!isObject(artifacts) || !Object.hasOwn(artifacts, read.path) || !isObject(artifacts[read.path]))
                continue;
            const registered = this.resolveRegistered(read.path);
            if (!registered || registered.path !== read.path || registered.scope !== read.scope)
                throw new Error(`Registered Skill ownership changed after acquisition: ${read.path}`);
            if (!isArtifactHash(read.hash) || read.error !== undefined || this.hashSource(read.path) !== read.hash)
                throw new Error(`Skill source changed after acquisition: ${read.path}`);
        }
    }
    clear() {
        this.successful.clear();
        this.#pending.clear();
    }
    recordStart(toolCallId, toolName, args) {
        this.#record(toolCallId, toolName, args);
    }
    recordCall(toolCallId, toolName, input) {
        this.#record(toolCallId, toolName, input);
    }
    recordEnd(toolCallId, toolName, isError) {
        const pending = this.#pending.get(toolCallId);
        this.#pending.delete(toolCallId);
        if (isError || !pending || toolName !== pending.toolName)
            return;
        this.#recordSuccessful(pending.toolName, pending.args);
    }
    recordResult(toolName, input, isError) {
        if (isError)
            return undefined;
        return this.#recordSuccessful(toolName, input);
    }
    delete(path) {
        this.successful.delete(path);
    }
    #recordSuccessful(toolName, args) {
        const source = readPath(toolName, args);
        if (!source)
            return undefined;
        const registered = this.resolveRegistered(source);
        if (!registered)
            return undefined;
        if (!this.#selection.includes(registered.scope)) {
            const read = { path: registered.path, scope: registered.scope };
            this.successful.set(registered.path, read);
            return read;
        }
        let read;
        try {
            const hash = this.hashSource(registered.path);
            if (!isArtifactHash(hash))
                throw new Error("hasher returned a non-canonical SHA-256 identity");
            read = { ...registered, hash };
        }
        catch (error) {
            read = { ...registered, error: error instanceof Error ? error.message : String(error) };
        }
        this.successful.set(registered.path, read);
        return read;
    }
    #record(toolCallId, toolName, args) {
        if (toolName !== "read") {
            this.#pending.delete(toolCallId);
            return;
        }
        this.#pending.set(toolCallId, { toolName, args });
    }
}
