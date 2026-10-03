import { classifyArtifactCompilationNeed, inspectRegisteredArtifactPaths, sameArtifactSourceFingerprint, ORDINARY_ARTIFACT_COMPILER, } from "./artifact.js";
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
export const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";
const SCOPES = ["global", "cwd", "session"];
/**
 * One selected branch's ordinary-artifact acquisition plan: runtime-observed
 * invalidations, their model hints and the read tracker correlated to them.
 * The tracker's candidates always equal the current invalidation plan.
 */
export class ArtifactAcquisitionState {
    reads = new ArtifactReadTracker();
    #invalidations = [];
    #hints = {};
    get invalidations() { return this.#invalidations; }
    get hints() { return this.#hints; }
    /** Drop the invalidation plan; hints remain until the next refresh. */
    clearInvalidations() { this.#setInvalidations([]); }
    /** Forget plan and hints when no memory view is selected. */
    reset() {
        this.#hints = {};
        this.#setInvalidations([]);
    }
    /** Re-observe exact registered sources for the selected scope artifacts. */
    refresh(states, provenance) {
        const paths = new Set();
        for (const scope of SCOPES)
            for (const path of Object.keys(states[scope].artifacts))
                paths.add(path);
        const observations = new Map(inspectRegisteredArtifactPaths(paths).map((observation) => [observation.path, observation]));
        const hints = {};
        const invalidations = new Map();
        for (const scope of SCOPES) {
            const registry = provenance(scope);
            for (const [path, metadata] of Object.entries(states[scope].artifacts)) {
                // A narrower owner replaces broader evidence for the same path.
                delete hints[path];
                invalidations.delete(path);
                if (metadata.kind === "skill")
                    continue;
                const observed = observations.get(path);
                if (observed?.kind !== "present")
                    continue;
                const need = classifyArtifactCompilationNeed({ path, scope, sourceFingerprint: observed.fingerprint }, metadata, ORDINARY_ARTIFACT_COMPILER, false, registry[path]);
                if (need.kind !== "requires-compilation")
                    continue;
                if (need.reason === "source-changed")
                    hints[path] = SOURCE_CHANGED_HINT;
                invalidations.set(path, { path, scope, reason: need.reason });
            }
        }
        this.#hints = hints;
        this.#setInvalidations([...invalidations.values()].sort((left, right) => left.path.localeCompare(right.path)));
    }
    /** Accepted compilations leave the plan; correlated read evidence is single-use. */
    acceptAcquired(paths = new Set(this.reads.successful.keys())) {
        this.#setInvalidations(this.#invalidations.filter(({ path }) => !paths.has(path)));
        this.reads.clear();
    }
    #setInvalidations(invalidations) {
        this.#invalidations = invalidations;
        this.reads.setCandidates(invalidations);
    }
}
/** Deletion patches for registered artifacts whose exact source is observed missing, in every owning scope. */
export function missingArtifactRemovals(states) {
    const owners = new Map();
    for (const scope of SCOPES)
        for (const path of Object.keys(states[scope].artifacts ?? {})) {
            owners.set(path, [...owners.get(path) ?? [], scope]);
        }
    const removals = {};
    for (const observation of inspectRegisteredArtifactPaths(owners.keys())) {
        if (observation.kind !== "missing")
            continue;
        for (const scope of owners.get(observation.path) ?? []) {
            const artifacts = (removals[scope]?.artifacts ?? {});
            removals[scope] = { ...(removals[scope] ?? {}), artifacts: { ...artifacts, [observation.path]: null } };
        }
    }
    return removals;
}
