import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, isJsonValue, isObject } from "./json.js";
import { captureTemporalWitnesses, validateTemporalLineage } from "./temporal.js";
import { captureScopeSelection } from "./selection.js";
const MAX_RESTORED_STEP = Number.MAX_SAFE_INTEGER - 1;
const MAX_LEGACY_VALIDATION_ATTEMPT = 7;
/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export class RevisionUnavailableError extends Error {
}
export function isStateFlowMode(value) {
    return value === "active" || value === "passive" || value === "off";
}
/**
 * Read only mode policy, without validating or accessing semantic checkpoint metadata.
 * Missing/invalid policy stays undecided; callers must not treat this as restoration proof.
 * Legacy `enabled:false` follows the caller's inactive policy.
 */
export function readCheckpointMode(value, inactiveMode = "passive") {
    if (!isObject(value))
        return undefined;
    if (Object.hasOwn(value, "mode"))
        return Object.hasOwn(value, "enabled") || !isStateFlowMode(value.mode) ? undefined : value.mode;
    return typeof value.enabled === "boolean" ? value.enabled ? "active" : inactiveMode : undefined;
}
/** Capture closed caller-owned run fields, omitting only undefined optional in-memory fields. */
export function captureLifecycleSnapshot(value) {
    if (!isObject(value) || Object.keys(value).sort().join(",") !== "config,meta" || !isObject(value.config)
        || Object.keys(value.config).join(",") !== "mode" || !isObject(value.meta)
        || Object.keys(value.meta).some((key) => !["step", "specification", "bootstrap", "validation"].includes(key))) {
        throw new Error("Selected State Flow lifecycle update contains non-owned fields");
    }
    const meta = Object.fromEntries(Object.entries(value.meta).filter(([, field]) => field !== undefined));
    const supplied = { config: value.config, meta };
    if (!isJsonValue(supplied))
        throw new Error("Invalid State Flow lifecycle snapshot");
    const normalized = { config: { mode: isStateFlowMode(value.config.mode) ? value.config.mode : "off" }, meta: restoredMeta(meta) };
    if (meta.bootstrap === false)
        normalized.meta.bootstrap = false;
    if (meta.step === Number.MAX_SAFE_INTEGER)
        normalized.meta.step = Number.MAX_SAFE_INTEGER;
    if (canonicalJson(normalized) !== canonicalJson(supplied))
        throw new Error("Invalid State Flow lifecycle snapshot");
    return structuredClone(normalized);
}
/** Failed Active selection retains its policy and fences inference until explicit recovery or an inactive choice. */
export function isActiveRestorationBlocked(snapshot) {
    return snapshot.config.mode === "active" && snapshot.meta.validation?.attempt === 0;
}
/** Retained private identity proof, never private values or acquisition permission. */
export function capturePrivateCausalBasis(value) {
    if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "causalWitnesses,lineage")
        throw new Error("Invalid State Flow private causal basis");
    const lineage = value.lineage;
    validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
    const causalWitnesses = captureTemporalWitnesses(lineage, value.causalWitnesses, MAX_HISTORY_LIMIT);
    const witnessed = new Set(causalWitnesses.map(witness => witness.transition.id));
    if (lineage.slice(1).some(boundary => !witnessed.has(boundary.id)))
        throw new Error("Insufficient State Flow private causal basis witnesses");
    return structuredClone({ lineage, causalWitnesses });
}
export function validateSessionRuntime(value, cwd, sessionId) {
    validateRuntimeVersion(value, cwd, sessionId, 1);
}
/** Shared syntax checks do not widen native admission or prove private-stream acquisition. */
function validateRuntimeVersion(value, cwd, sessionId, expectedVersion) {
    if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "config,meta"
        || !isObject(value.config) || !isObject(value.meta))
        throw new Error("Invalid State Flow session runtime envelope");
    const { version, identity, lineage, artifacts, temporal: _temporalScope, ...fields } = value.meta;
    if (!Object.hasOwn(value.meta, "version") || version !== expectedVersion)
        throw new Error("Unsupported State Flow runtime provenance format");
    if (artifacts !== undefined)
        parseArtifactProvenanceRegistry(artifacts, "State Flow session artifact provenance");
    if (expectedVersion === 2 && (!Object.hasOwn(value.meta, "privateAcquisition") || !["unacquired", "deferred", "acquired"].includes(value.meta.privateAcquisition))) {
        throw new Error("Invalid State Flow private acquisition provenance");
    }
    if (Object.hasOwn(value.meta, "privateCausalBasis")) {
        if (expectedVersion !== 2 || value.meta.privateAcquisition !== "acquired")
            throw new Error("Invalid State Flow private causal basis provenance");
        capturePrivateCausalBasis(value.meta.privateCausalBasis);
    }
    if (!isObject(identity) || Object.keys(identity).sort().join(",") !== "cwd,sessionId"
        || identity.cwd !== resolve(cwd) || identity.sessionId !== sessionId || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
        throw new Error("State Flow runtime scope identity mismatch");
    }
    validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
    const known = new Set(["step", "specification", "validation", "bootstrap"]);
    if (Object.keys(fields).some((key) => ["state", "strategy", "tactics", "contract", "working", "response"].includes(key))) {
        throw new Error("Semantic state does not belong in State Flow runtime metadata");
    }
    const runtimeFields = Object.fromEntries(Object.entries(fields).filter(([key]) => known.has(key)));
    const normalized = {
        config: { mode: isStateFlowMode(value.config.mode) ? value.config.mode : "off" },
        meta: restoredMeta(runtimeFields),
    };
    if (runtimeFields.bootstrap === false)
        normalized.meta.bootstrap = false;
    if (runtimeFields.step === Number.MAX_SAFE_INTEGER)
        normalized.meta.step = Number.MAX_SAFE_INTEGER;
    if (expectedVersion === 2 && !Object.hasOwn(value.config, "scopes"))
        throw new Error("State Flow lifecycle v2 requires explicit scopes");
    const scopes = expectedVersion === 2 ? captureScopeSelection(value.config.scopes) : undefined;
    const normalizedConfig = scopes === undefined ? normalized.config : { ...normalized.config, scopes };
    const suppliedConfig = scopes === undefined ? value.config : { ...value.config, scopes };
    if (canonicalJson({ config: normalizedConfig, meta: normalized.meta }) !== canonicalJson({ config: suppliedConfig, meta: runtimeFields })) {
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
/** Legacy `enabled:false` decodes as non-active; native checkpoints, not this file, select branch policy. */
export function parseSessionRuntime(config, runtimeSource, cwd, sessionId) {
    if (config === undefined && runtimeSource === undefined)
        return undefined;
    if (config === undefined || runtimeSource === undefined)
        throw new Error("Incomplete State Flow config/runtime pair");
    let runtime;
    try {
        const settings = JSON.parse(config);
        runtime = { config: legacySessionConfig(settings), meta: JSON.parse(runtimeSource) };
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw new Error("State Flow session runtime contains invalid JSON");
        throw error;
    }
    validateSessionRuntime(runtime, cwd, sessionId);
    const { temporal: _legacyTemporal, ...runtimeMeta } = runtime.meta;
    return { config: { mode: runtime.config.mode }, meta: runtimeMeta };
}
function legacySessionConfig(settings) {
    const mode = isObject(settings) && Object.keys(settings).length === 1 ? readCheckpointMode(settings, "passive") : undefined;
    if (mode === undefined)
        throw new Error("Invalid State Flow runtime configuration or counters");
    return { mode };
}
/** Detached lifecycle preflight only; current native readers/writers still admit version 1 exclusively. */
export function prepareSessionPolicyMigration(config, runtimeSource, cwd, sessionId, legacySelection) {
    if (config === undefined && runtimeSource === undefined)
        return undefined;
    if (config === undefined || runtimeSource === undefined)
        throw new Error("Incomplete State Flow config/runtime pair");
    const metadata = parsePolicyDocument(runtimeSource);
    if (!isObject(metadata) || !Object.hasOwn(metadata, "version") || (metadata.version !== 1 && metadata.version !== 2))
        throw new Error("Unsupported State Flow runtime provenance format");
    const sourceVersion = metadata.version;
    const settings = parsePolicyDocument(config);
    if (sourceVersion === 1 && (Object.hasOwn(metadata, "privateAcquisition") || Object.hasOwn(metadata, "causalWitnesses") || Object.hasOwn(metadata, "privateCausalBasis") || (isObject(settings) && Object.hasOwn(settings, "scopes")))) {
        throw new Error("Target State Flow policy fields in legacy lifecycle format");
    }
    const sourceValue = { config: sourceVersion === 1 ? legacySessionConfig(settings) : settings, meta: metadata };
    validateRuntimeVersion(sourceValue, cwd, sessionId, sourceVersion);
    const scopes = captureScopeSelection(sourceVersion === 1 ? legacySelection : settings.scopes);
    const runtime = {
        config: { ...sourceValue.config, scopes },
        meta: { ...metadata, version: 2, ...(sourceVersion === 1 ? { privateAcquisition: "acquired" } : {}) },
    };
    validateRuntimeVersion(runtime, cwd, sessionId, 2);
    return {
        sourceVersion, targetVersion: 2, requiresConversion: sourceVersion === 1,
        source: { config, runtime: runtimeSource }, runtime,
        target: { config: `${canonicalJson(runtime.config)}\n`, runtime: `${canonicalJson(runtime.meta)}\n` },
    };
}
function parsePolicyDocument(source) {
    try {
        return JSON.parse(source);
    }
    catch {
        throw new Error("State Flow session policy contains invalid JSON");
    }
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
function envelope(mode, meta) {
    return { config: { mode }, meta };
}
export function emptySnapshot(mode = "passive") {
    return envelope(mode, { step: 0 });
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
        mode: snapshot.config.mode,
        step: snapshot.meta.step,
        ...(snapshot.meta.bootstrap === true ? { bootstrap: true } : {}),
        ...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
    };
    return parseRetainedPiCheckpoint(checkpoint);
}
/** Encode an explicit inactive choice on a branch that has no accepted runtime. */
export function preRuntimeCheckpoint(mode) {
    if (mode === "active")
        throw new Error("An active State Flow branch requires a retained semantic boundary");
    return { mode };
}
/** Decode the retained-window checkpoint contract; legacy `enabled`/`{disabled:true}` markers map through `inactiveMode`. */
export function parseRetainedPiCheckpoint(value, inactiveMode = "passive") {
    if (!isObject(value))
        throw new Error("Invalid State Flow retained-boundary checkpoint");
    const keys = Object.keys(value);
    if (keys.length === 1 && value.disabled === true)
        return { mode: inactiveMode };
    if (keys.length === 1 && (value.mode === "passive" || value.mode === "off"))
        return { mode: value.mode };
    const allowed = new Set(["boundary", "mode", "enabled", "step", "bootstrap", "specification"]);
    const mode = readCheckpointMode(value, inactiveMode);
    if (keys.some((key) => !allowed.has(key))
        || typeof value.boundary !== "string" || value.boundary.trim().length === 0
        || mode === undefined
        || !Number.isSafeInteger(value.step) || value.step < 0 || value.step > MAX_RESTORED_STEP
        || (value.bootstrap !== undefined && value.bootstrap !== true)
        || (value.specification !== undefined && typeof value.specification !== "string")) {
        throw new Error("Invalid State Flow retained-boundary checkpoint");
    }
    return {
        boundary: value.boundary,
        mode,
        step: value.step,
        ...(value.bootstrap === true ? { bootstrap: true } : {}),
        ...(typeof value.specification === "string" ? { specification: value.specification } : {}),
    };
}
/** Native policy value preflight; no retained boundary, fork or acquisition authority is created. */
export function prepareRetainedPolicyMigration(value, legacySelection, inactiveMode = "passive") {
    if (!isObject(value))
        throw new Error("Invalid State Flow policy checkpoint");
    const legacy = !Object.hasOwn(value, "version");
    let declaredVersion;
    try {
        if (!legacy)
            declaredVersion = value.version;
    }
    catch {
        throw new Error("Invalid State Flow policy checkpoint");
    }
    if (!legacy && declaredVersion !== 2)
        throw new Error("Unsupported State Flow native policy version");
    const sourceVersion = legacy ? "legacy" : 2;
    if (sourceVersion === "legacy" && Object.hasOwn(value, "scopes"))
        throw new Error("Target State Flow policy fields in legacy native checkpoint");
    if (!isJsonValue(value))
        throw new Error("Invalid State Flow policy checkpoint");
    const { version: _version, scopes, ...lifecycle } = value;
    if (sourceVersion === 2 && (!Object.hasOwn(value, "scopes") || !isStateFlowMode(lifecycle.mode)
        || Object.hasOwn(lifecycle, "enabled") || Object.hasOwn(lifecycle, "disabled"))) {
        throw new Error("Invalid State Flow lifecycle v2 policy");
    }
    const checkpoint = parseRetainedPiCheckpoint(lifecycle, inactiveMode);
    return {
        sourceVersion, targetVersion: 2, requiresConversion: sourceVersion === "legacy",
        checkpoint: { ...checkpoint, version: 2, scopes: captureScopeSelection(sourceVersion === "legacy" ? legacySelection : scopes) },
    };
}
export function migrationFailure(data, error, mode = "passive") {
    const meta = restoredMeta(data.meta, data);
    meta.validation = {
        attempt: 0,
        error,
        instruction: "Start a fresh State Flow episode; null is reserved for patch deletion.",
    };
    return envelope(mode, meta);
}
