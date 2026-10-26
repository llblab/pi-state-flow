import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry } from "./artifact.js";
import { MAX_HISTORY_LIMIT } from "./history.js";
import { canonicalJson, isJsonValue, isObject, validatePatch } from "./json.js";
import { parseStateReadPath, parseValuePath } from "./query.js";
import { assertRetainedModules, validateRetainedModules } from "./semantic-module.js";
import { assertNoRetiredSemanticPlanes } from "./state.js";
import { validateScopeStream } from "./temporal.js";
const LEGACY_PLANES = new Map([["contract", "strategy"], ["working", "tactics"]]);
const LEGACY_SEMANTIC_PLANES = new Set(["intents", "contract", "working", "artifacts", "response", "lazy"]);
const LEGACY_LOCATOR = /^(?:((?:effective|global|cwd|session)(?:\[\d+\])?(?:\.patches(?:\[\d+\])?)?)\.)?(contract|working)(?=$|\.|\[)/;
const MARKED_LOCATOR = /(?<![\p{L}\p{N}_$.[\]:/\\-])\$([\p{L}\p{N}_$.[\]:-]+)(?![\p{L}\p{N}_$.[\]:/\\-])/gu;
function translateLocator(path) {
    const match = LEGACY_LOCATOR.exec(path);
    if (!match)
        return path;
    const [, prefix, plane] = match;
    const suffix = path.slice(match[0].length);
    try {
        if (prefix)
            parseStateReadPath(prefix, MAX_HISTORY_LIMIT);
        // The unchanged lazy root lets the shared parser validate selectors after legacy names retire.
        parseValuePath(`lazy${suffix}`);
    }
    catch {
        return path;
    }
    return `${prefix ? `${prefix}.` : ""}${LEGACY_PLANES.get(plane)}${suffix}`;
}
function translateReferences(value) {
    if (typeof value === "string")
        return value.replace(MARKED_LOCATOR, (_token, path) => `$${translateLocator(path)}`);
    if (Array.isArray(value))
        return value.map(translateReferences);
    if (!isObject(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        key === "$ref" && typeof child === "string" ? translateLocator(child) : translateReferences(child)]));
}
function translateArtifacts(value) {
    if (!isObject(value))
        return translateReferences(value);
    return Object.fromEntries(Object.entries(value).map(([path, card]) => [path, !isObject(card) ? translateReferences(card)
            : Object.fromEntries(Object.entries(card).map(([key, child]) => [key,
                // Retired embedded provenance is evidence, never a semantic reference namespace.
                ["hash", "compiler", "compiled_at"].includes(key) ? structuredClone(child) : translateReferences(child)]))]));
}
/** Translate a raw legacy checkpoint or replay patch before any known-field filtering. */
export function translateLegacySemanticObject(value) {
    validatePatch(value);
    for (const plane of LEGACY_PLANES.values()) {
        if (Object.hasOwn(value, plane))
            throw new Error(`Target State Flow semantic plane in legacy format: ${plane}`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [LEGACY_PLANES.get(key) ?? key,
        key === "artifacts" ? translateArtifacts(child) : LEGACY_SEMANTIC_PLANES.has(key) ? translateReferences(child) : structuredClone(child)]));
}
/** Build a detached target candidate; publication still belongs to the guarded storage transaction. */
export function prepareSemanticMigration(value, scope, sourceVersion, historyLimit = MAX_HISTORY_LIMIT, targetModules) {
    if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== 3 && sourceVersion !== 4)
        throw new Error("Unsupported State Flow migration source version");
    validatePatch(value);
    if (!isObject(value.checkpoint) || !Array.isArray(value.patches))
        throw new Error("Invalid temporal checkpoint/tail envelope");
    if (targetModules !== undefined)
        validateRetainedModules(targetModules);
    if (sourceVersion === 4) {
        validateRetainedModules(value.modules);
        if (targetModules !== undefined)
            assertRetainedModules(value.modules, targetModules);
    }
    else if (Object.hasOwn(value, "modules"))
        throw new Error("Legacy State Flow stream cannot declare modules");
    const translate = (state) => {
        if (sourceVersion !== 4 && targetModules !== undefined && isObject(state)
            && Object.keys(state).some(key => key.startsWith("x_")))
            throw new Error("Legacy State Flow external namespace collision");
        if (sourceVersion < 3)
            return translateLegacySemanticObject(state);
        validatePatch(state);
        assertNoRetiredSemanticPlanes(state);
        return structuredClone(state);
    };
    // Preserve envelope fields until strict target validation; malformed input must not be sanitized into acceptance.
    const stream = {
        ...structuredClone(value),
        ...(targetModules === undefined ? {} : { modules: structuredClone(targetModules) }),
        checkpoint: { ...structuredClone(value.checkpoint), state: translate(value.checkpoint.state) },
        patches: value.patches.map((record) => {
            if (!isObject(record))
                throw new Error("Invalid temporal patch envelope");
            return { ...structuredClone(record), patch: translate(record.patch) };
        }),
    };
    validateScopeStream(stream, scope, historyLimit);
    const targetVersion = sourceVersion === 4 || targetModules !== undefined ? 4 : 3;
    return { sourceVersion, targetVersion, requiresConversion: sourceVersion !== targetVersion, stream };
}
function captureMigrationBytes(value, label) {
    if (!(value instanceof Uint8Array))
        throw new Error(`Incomplete State Flow migration cohort: ${label} bytes are required`);
    const bytes = new Uint8Array(value);
    return { bytes, identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}
function decodeMigrationText(bytes, label) {
    try {
        // Do not silently repair invalid UTF-8 or strip a BOM that ordinary JSON decoding would reject.
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        throw new Error(`State Flow migration ${label} is not valid UTF-8`);
    }
}
function parseMigrationJson(source, label) {
    let value;
    try {
        value = JSON.parse(source);
    }
    catch {
        throw new Error(`State Flow migration ${label} contains invalid JSON`);
    }
    if (!isJsonValue(value))
        throw new Error(`State Flow migration ${label} must contain finite JSON data`);
    return value;
}
/** Decode a complete raw owner cohort before filtering; never load files, normalize authority or publish. */
export function prepareSerializedScopeMigration(sources, scope, expectedCwd, targetModules) {
    const basis = {
        checkpoint: captureMigrationBytes(sources.checkpoint, "checkpoint"),
        patches: captureMigrationBytes(sources.patches, "patches"),
        meta: captureMigrationBytes(sources.meta, "metadata"),
    };
    const metaText = decodeMigrationText(basis.meta.bytes, "metadata");
    const metadata = parseMigrationJson(metaText, "metadata");
    if (!isObject(metadata))
        throw new Error("Invalid State Flow migration metadata");
    const version = metadata.version;
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4)
        throw new Error("Unsupported State Flow migration source version");
    if (version === 4)
        validateRetainedModules(metadata.modules);
    else if (targetModules !== undefined && Object.hasOwn(metadata, "modules"))
        throw new Error("Legacy State Flow modules metadata collision");
    if (scope === "cwd") {
        if (expectedCwd === undefined)
            throw new Error("State Flow CWD migration requires its canonical identity");
        if (metadata.owner === undefined)
            throw new Error("State Flow CWD scope identity is missing");
        if (!isObject(metadata.owner) || Object.keys(metadata.owner).join(",") !== "cwd" || metadata.owner.cwd !== resolve(expectedCwd)) {
            throw new Error("State Flow CWD migration identity mismatch");
        }
    }
    else if (expectedCwd !== undefined)
        throw new Error("Only State Flow CWD migration accepts a CWD identity");
    if (Object.hasOwn(metadata, "artifacts"))
        parseArtifactProvenanceRegistry(metadata.artifacts, "State Flow migration provenance");
    const temporal = metadata.temporal;
    if (!isObject(temporal) || !Object.hasOwn(temporal, "checkpoint") || !Array.isArray(temporal.patches)) {
        throw new Error("Invalid State Flow migration temporal metadata");
    }
    if (version >= 3 && !Object.hasOwn(temporal, "revision"))
        throw new Error("State Flow target migration metadata requires a revision");
    const checkpointText = decodeMigrationText(basis.checkpoint.bytes, "checkpoint");
    const patchesText = decodeMigrationText(basis.patches.bytes, "tail");
    const checkpoint = parseMigrationJson(checkpointText, "checkpoint");
    const patches = patchesText.split(/\r?\n/).flatMap((line, index) => line.trim().length === 0 ? []
        : [parseMigrationJson(line, `tail line ${index + 1}`)]);
    const boundaries = temporal.patches;
    if (boundaries.length !== patches.length)
        throw new Error("State Flow migration metadata does not match its semantic tail");
    const candidate = prepareSemanticMigration({
        ...(version === 4 ? { modules: metadata.modules } : {}),
        revision: temporal.revision === undefined ? patches.length : temporal.revision,
        checkpoint: { through: temporal.checkpoint, state: checkpoint },
        patches: patches.map((patch, index) => ({ transition: boundaries[index], patch })),
    }, scope, version, MAX_HISTORY_LIMIT, targetModules);
    const target = !candidate.requiresConversion && targetModules === undefined ? { checkpoint: checkpointText, patches: patchesText, meta: metaText } : {
        checkpoint: `${canonicalJson(candidate.stream.checkpoint.state)}\n`,
        patches: candidate.stream.patches.map((record) => `${canonicalJson(record.patch)}\n`).join(""),
        meta: `${canonicalJson({ ...metadata, version: candidate.targetVersion,
            ...(candidate.stream.modules === undefined ? {} : { modules: candidate.stream.modules }),
            temporal: { ...temporal, revision: candidate.stream.revision } })}\n`,
    };
    return { ...candidate, basis, target };
}
