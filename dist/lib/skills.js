import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashArtifactSource, isArtifactHash, } from "./artifact.js";
import { isObject } from "./json.js";
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
    return hashArtifactSource(readFileSync(source));
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
    constructor(hashSource = hashSkillSource, resolveRegistered = () => undefined) {
        this.hashSource = hashSource;
        this.resolveRegistered = resolveRegistered;
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
