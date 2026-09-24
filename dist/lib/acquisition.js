import { classifyArtifactCompilationNeed, inspectRegisteredArtifactPaths, sameArtifactSourceFingerprint, } from "./artifact.js";
import { isObject } from "./json.js";
function readPath(toolName, args) {
    return toolName === "read" && isObject(args) && typeof args.path === "string"
        ? args.path
        : undefined;
}
/** Correlate successful read-tool executions with the current ordinary artifact invalidation plan. */
export class ArtifactReadTracker {
    successful = new Map();
    #pending = new Map();
    #candidates = new Map();
    setCandidates(candidates) {
        this.#candidates.clear();
        for (const candidate of candidates)
            this.#candidates.set(candidate.path, structuredClone(candidate));
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
        const path = readPath(pending.toolName, pending.args);
        if (path === undefined)
            return;
        const candidate = this.#candidates.get(path);
        if (candidate === undefined || pending.fingerprint === undefined)
            return;
        const observation = inspectRegisteredArtifactPaths([path])[0];
        if (observation?.kind !== "present" || !sameArtifactSourceFingerprint(pending.fingerprint, observation.fingerprint))
            return;
        const finalObservation = inspectRegisteredArtifactPaths([path])[0];
        if (finalObservation?.kind !== "present" || !sameArtifactSourceFingerprint(observation.fingerprint, finalObservation.fingerprint))
            return;
        this.successful.set(path, structuredClone({ ...candidate, sourceFingerprint: finalObservation.fingerprint }));
    }
    #record(toolCallId, toolName, args) {
        if (toolName !== "read") {
            this.#pending.delete(toolCallId);
            return;
        }
        const path = readPath(toolName, args);
        const observation = path !== undefined && this.#candidates.has(path) ? inspectRegisteredArtifactPaths([path])[0] : undefined;
        this.#pending.set(toolCallId, {
            toolName,
            args,
            ...(observation?.kind === "present" ? { fingerprint: observation.fingerprint } : {}),
        });
    }
}
/**
 * Apply one materialized-first source acquisition policy.
 *
 * Required recompilation always wins. Otherwise routine use and a new session
 * stay on materialized state; only a concrete source need permits rereading.
 */
export function decideArtifactAcquisition(source, metadata, compiler, options) {
    const need = classifyArtifactCompilationNeed(source, metadata, compiler, options.explicitRefresh ?? false, options.provenance);
    if (need.kind === "requires-compilation") {
        return { kind: "read-source", reason: need.reason };
    }
    switch (options.intent) {
        case "routine":
        case "new-session":
            return { kind: "use-materialized", reason: "no-concrete-need" };
        case "relevant-gap":
            return options.materializedSufficient === true
                ? { kind: "use-materialized", reason: "materialized-sufficient" }
                : { kind: "read-source", reason: "materialized-gap" };
        case "exact-source":
            return { kind: "read-source", reason: "exact-source" };
        case "exact-edit":
            return { kind: "read-source", reason: "exact-edit" };
        case "contradiction-or-failure":
            return { kind: "read-source", reason: "contradiction-or-failure" };
        case "explicit-request":
            return { kind: "read-source", reason: "explicit-request" };
        case "maintenance":
            return { kind: "read-source", reason: "maintenance" };
    }
}
