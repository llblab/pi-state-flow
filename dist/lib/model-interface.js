// Domain: detached model/canonical patch, locator and structured-reference translation.
// Excludes: SDK schemas, mode, acquisition, existence checks, storage and request/publication authority.
import { isJsonValue, isObject } from "./json.js";
import { DEFAULT_HISTORY_LIMIT } from "./history.js";
import { parseStateReadPath, parseValuePath } from "./query.js";
import { captureScopeSelection } from "./selection.js";
import { MODEL_PLANE_NAMES } from "./planes.js";
const PATCH_PLANES = MODEL_PLANE_NAMES;
const SEMANTIC_ROOT = /^(?:intents|strategy|tactics|artifacts|response|lazy|x_[a-z][a-z0-9_]*)(?=\.|\[|$)/;
const PATCH_PATH = /^(?:effective|global|cwd|session)\.patches(?:\[\d+\])?$/;
function dense(value) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            if (!Object.hasOwn(value, i) || !dense(value[i]))
                return false;
        return true;
    }
    return !isObject(value) || Object.values(value).every(dense);
}
function capture(value) {
    if (!isJsonValue(value))
        throw new Error("Model interface requires finite acyclic JSON data");
    let copy;
    try {
        copy = structuredClone(value);
    }
    catch {
        throw new Error("Model interface requires detached JSON data");
    }
    if (!isJsonValue(copy) || !dense(copy))
        throw new Error("Model interface requires finite dense JSON data");
    return copy;
}
function translateReferences(value, translate) {
    if (Array.isArray(value))
        return value.map(child => translateReferences(child, translate));
    if (!isObject(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        key === "$ref" && typeof child === "string" ? translate(child) : translateReferences(child, translate)]));
}
function semanticReference(path, external) {
    const root = SEMANTIC_ROOT.exec(path)?.[0];
    if (!root || root.startsWith("x_") && external !== undefined && !external.includes(root))
        return false;
    try {
        parseValuePath(path);
        return true;
    }
    catch {
        return false;
    }
}
/** Anchor eligible flat current references, never text/resource/effective/historical references. */
export function canonicalizeModelReferences(value, scopes, external = []) {
    const selected = captureScopeSelection(scopes), copy = capture(value);
    return selected.length !== 1 ? copy : translateReferences(copy, ref => semanticReference(ref, external) ? `${selected[0]}.${ref}` : ref);
}
/** Strip only validated same-owner current semantic reference prefixes; canonical data stays untouched. */
export function projectModelReferences(value, scopes, external = []) {
    const selected = captureScopeSelection(scopes), copy = capture(value), prefix = `${selected[0]}.`;
    return selected.length !== 1 ? copy : translateReferences(copy, ref => ref.startsWith(prefix) && semanticReference(ref.slice(prefix.length), external) ? ref.slice(prefix.length) : ref);
}
function admitKeys(value, selected, external) {
    const keys = Object.keys(value);
    if (!keys.length)
        throw new Error("Model patch requires at least one supplied branch");
    if (selected.length === 1) {
        if (keys.some(key => !PATCH_PLANES.includes(key) && !external.includes(key)))
            throw new Error("Single-owner model patches require flat semantic planes");
    }
    else
        for (const key of keys) {
            if (!selected.includes(key))
                throw new Error(`Multi-owner model patches require participating explicit owners; does not accept field ${key}`);
        }
}
function planePatch(value, external) {
    if (!isObject(value) || !Object.keys(value).length)
        throw new Error("Model scope patch must be a nonempty object");
    for (const key of Object.keys(value)) {
        if (!PATCH_PLANES.includes(key) && !external.includes(key))
            throw new Error(`Model patch does not accept semantic plane ${key}`);
        if (!isObject(value[key]))
            throw new Error(`Model patch plane ${key} must be a JSON object`);
    }
}
/** Value normalization only; callers must validate their original request/owner before invoking it. */
export function normalizeModelPatches(value, scopes, external = []) {
    const selected = captureScopeSelection(scopes);
    if (!isObject(value))
        throw new Error("Model patch must be an object");
    // Reject shape/excluded owners before touching a supplied owner's payload or cloning it.
    admitKeys(value, selected, external);
    const copy = (selected.length === 1 ? canonicalizeModelReferences(value, selected, external) : capture(value));
    admitKeys(copy, selected, external);
    if (selected.length === 1) {
        planePatch(copy, external);
        return { [selected[0]]: copy };
    }
    for (const key of Object.keys(copy))
        planePatch(copy[key], external);
    return copy;
}
/** Compilation target syntax, not a query locator: preserve the exact opaque source key. */
export function projectModelArtifactTarget(scope, path, scopes) {
    const selected = captureScopeSelection(scopes);
    if (!selected.includes(scope))
        throw new Error("Model artifact target scope is excluded");
    if (typeof path !== "string")
        throw new Error("Model artifact target path must be a string");
    return `${selected.length === 1 ? "" : scope + "."}artifacts[${JSON.stringify(path)}]`;
}
/** Known deletion-report JSON pointers only; do not parse source keys or rewrite diagnostics. */
export function projectModelMissingDeletion(deletion, scopes) {
    const selected = captureScopeSelection(scopes);
    const project = (path) => {
        if (typeof path !== "string")
            throw new Error("Model deletion locator must be a string");
        const prefix = `/${selected[0]}`;
        return selected.length === 1 && (path === prefix || path.startsWith(prefix + "/")) ? path.slice(prefix.length) : path;
    };
    return { path: project(deletion.path), unavailablePath: project(deletion.unavailablePath) };
}
function validateReadPath(path, selected, historyLimit) {
    const query = PATCH_PATH.test(path) ? parseStateReadPath(path, historyLimit) : parseStateReadPath(parseValuePath(path).root, historyLimit);
    if (query.scope !== undefined && !selected.includes(query.scope))
        throw new Error("Model read scope is excluded");
}
/** Sole-owner locators bind to that exact owner; multi-owner effective aliases keep their existing meaning. */
export function normalizeModelReadPath(path, scopes, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const selected = captureScopeSelection(scopes);
    if (typeof path !== "string")
        throw new Error("Model read path must be a string");
    let canonical = path;
    if (selected.length === 1) {
        if (/^patches(?:\[\d+\])?$/.test(path))
            canonical = `${selected[0]}.${path}`;
        else if (SEMANTIC_ROOT.test(path))
            canonical = `${selected[0]}.${path}`;
        else if (/^effective(?=\.|\[|$)/.test(path))
            canonical = selected[0] + path.slice("effective".length);
    }
    validateReadPath(canonical, selected, historyLimit);
    return canonical;
}
/** Presentation locator only: history keeps an explicit projection root and does not become an array index. */
export function projectModelReadPath(path, scopes, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const selected = captureScopeSelection(scopes), canonical = normalizeModelReadPath(path, selected, historyLimit);
    if (selected.length !== 1)
        return canonical;
    const prefix = `${selected[0]}.`;
    if (canonical.startsWith(prefix) && /^patches(?:\[\d+\])?$/.test(canonical.slice(prefix.length)))
        return canonical.slice(prefix.length);
    if (canonical.startsWith(prefix) && semanticReference(canonical.slice(prefix.length)))
        return canonical.slice(prefix.length);
    return "effective" + canonical.slice(selected[0].length);
}
