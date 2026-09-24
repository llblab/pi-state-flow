import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, isJsonValue, isObject } from "./json.js";
import { validateTemporalLineage } from "./temporal.js";
const MAX_RESTORED_STEP = Number.MAX_SAFE_INTEGER - 1;
const MAX_LEGACY_VALIDATION_ATTEMPT = 7;
/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export class RevisionUnavailableError extends Error {
}
/** Expired history cannot be restored, but explicit activation may use validated current memory. */
export class HistoryBoundaryExpiredError extends RevisionUnavailableError {
}
export function validateSessionRuntime(value, cwd, sessionId) {
    if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "config,meta"
        || !isObject(value.config) || !isObject(value.meta))
        throw new Error("Invalid State Flow session runtime envelope");
    const { version, identity, lineage, artifacts, temporal: _temporalScope, ...fields } = value.meta;
    if (artifacts !== undefined)
        parseArtifactProvenanceRegistry(artifacts, "State Flow session artifact provenance");
    if (version !== 1)
        throw new Error("Unsupported State Flow runtime provenance format");
    if (!isObject(identity) || Object.keys(identity).sort().join(",") !== "cwd,sessionId"
        || identity.cwd !== resolve(cwd) || identity.sessionId !== sessionId || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
        throw new Error("State Flow runtime scope identity mismatch");
    }
    validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
    const known = new Set(["step", "specification", "validation", "bootstrap"]);
    if (Object.keys(fields).some((key) => ["state", "contract", "working", "response"].includes(key))) {
        throw new Error("Semantic state does not belong in State Flow runtime metadata");
    }
    const runtimeFields = Object.fromEntries(Object.entries(fields).filter(([key]) => known.has(key)));
    const normalized = {
        config: { enabled: value.config.enabled === true },
        meta: restoredMeta(runtimeFields),
    };
    if (runtimeFields.bootstrap === false)
        normalized.meta.bootstrap = false;
    if (runtimeFields.step === Number.MAX_SAFE_INTEGER)
        normalized.meta.step = Number.MAX_SAFE_INTEGER;
    if (canonicalJson({ config: normalized.config, meta: normalized.meta }) !== canonicalJson({ config: value.config, meta: runtimeFields })) {
        throw new Error("Invalid State Flow runtime configuration or counters");
    }
}
export function createSessionRuntime(snapshot, cwd, sessionId, lineage, _artifacts = {}) {
    const fields = snapshot.meta;
    const runtime = {
        config: structuredClone(snapshot.config),
        meta: {
            ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
            version: 1,
            identity: { cwd: resolve(cwd), sessionId },
            lineage: structuredClone([...lineage]),
        },
    };
    validateSessionRuntime(runtime, cwd, sessionId);
    return runtime;
}
export function serializeSessionRuntime(runtime, cwd, sessionId) {
    validateSessionRuntime(runtime, cwd, sessionId);
    const { temporal: _retiredTemporal, artifacts: _legacyArtifacts, ...runtimeMeta } = runtime.meta;
    return { config: `${canonicalJson(runtime.config)}\n`, runtime: `${canonicalJson(runtimeMeta)}\n` };
}
export function parseSessionRuntime(config, runtimeSource, cwd, sessionId) {
    if (config === undefined && runtimeSource === undefined)
        return undefined;
    if (config === undefined || runtimeSource === undefined)
        throw new Error("Incomplete State Flow config/runtime pair");
    let runtime;
    try {
        runtime = { config: JSON.parse(config), meta: JSON.parse(runtimeSource) };
    }
    catch {
        throw new Error("State Flow session runtime contains invalid JSON");
    }
    validateSessionRuntime(runtime, cwd, sessionId);
    const { temporal: _legacyTemporal, ...runtimeMeta } = runtime.meta;
    return { config: { enabled: runtime.config.enabled }, meta: runtimeMeta };
}
function restoredStep(value) {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= MAX_RESTORED_STEP
        ? value
        : 0;
}
function restoredValidation(value) {
    if (!isObject(value)
        || !Number.isSafeInteger(value.attempt)
        || value.attempt < 0
        || value.attempt > MAX_LEGACY_VALIDATION_ATTEMPT
        || typeof value.error !== "string"
        || typeof value.instruction !== "string")
        return undefined;
    return {
        attempt: value.attempt,
        error: value.error,
        instruction: value.instruction,
    };
}
function restoredMeta(value, legacy = {}) {
    const meta = isObject(value) ? value : legacy;
    const validation = restoredValidation(meta.validation);
    return {
        step: restoredStep(meta.step),
        ...(typeof meta.specification === "string" ? { specification: meta.specification } : {}),
        ...(validation === undefined ? {} : { validation }),
        ...(meta.bootstrap === true ? { bootstrap: true } : {}),
    };
}
function envelope(enabled, meta) {
    return { config: { enabled }, meta };
}
export function emptySnapshot(enabled = false) {
    return envelope(enabled, { step: 0 });
}
export function isFileRevision(value) {
    return typeof value === "string" && /^file:[0-9a-f]{64}$/.test(value);
}
/** Encode branch lifecycle against one retained temporal identity without semantic or backup data. */
export function retainedBoundaryCheckpoint(snapshot, boundary) {
    if (typeof boundary !== "string" || boundary.trim().length === 0)
        throw new Error("Checkpoint requires a retained temporal boundary identity");
    const checkpoint = {
        boundary,
        enabled: snapshot.config.enabled,
        step: snapshot.meta.step,
        ...(snapshot.meta.bootstrap === true ? { bootstrap: true } : {}),
        ...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
    };
    return parseRetainedPiCheckpoint(checkpoint);
}
/** Decode the 0.17 retained-window checkpoint contract. */
export function parseRetainedPiCheckpoint(value) {
    if (!isObject(value))
        throw new Error("Invalid State Flow retained-boundary checkpoint");
    if (Object.keys(value).length === 1 && value.disabled === true)
        return { disabled: true };
    const allowed = new Set(["boundary", "enabled", "step", "bootstrap", "specification"]);
    if (Object.keys(value).some((key) => !allowed.has(key))
        || typeof value.boundary !== "string" || value.boundary.trim().length === 0
        || typeof value.enabled !== "boolean"
        || !Number.isSafeInteger(value.step) || value.step < 0 || value.step > MAX_RESTORED_STEP
        || (value.bootstrap !== undefined && value.bootstrap !== true)
        || (value.specification !== undefined && typeof value.specification !== "string")) {
        throw new Error("Invalid State Flow retained-boundary checkpoint");
    }
    return {
        boundary: value.boundary,
        enabled: value.enabled,
        step: value.step,
        ...(value.bootstrap === true ? { bootstrap: true } : {}),
        ...(typeof value.specification === "string" ? { specification: value.specification } : {}),
    };
}
export function migrationFailure(data, error) {
    const meta = restoredMeta(data.meta, data);
    meta.validation = {
        attempt: 0,
        error,
        instruction: "Start a fresh State Flow episode; null is reserved for patch deletion.",
    };
    return envelope(false, meta);
}
