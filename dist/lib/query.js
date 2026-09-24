import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.js";
import { isObject, sameJson } from "./json.js";
import { projectStateForModel } from "./state.js";
import { readTemporalState } from "./temporal.js";
const MAX_REFERENCE_SOURCES = 3;
const MAX_REFERENCE_SCAN_NODES = 10_000;
const PATH_PATTERN = /^(effective|global|cwd|session)(?:\[(\d+)\])?(?:\.patches(?:\[(\d+)\])?)?$/;
/** Resolve a projection root without repeating the tool name in every path. */
export function parseStateReadPath(path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > MAX_HISTORY_LIMIT) {
        throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
    }
    const match = PATH_PATTERN.exec(path);
    if (!match)
        throw new Error("Invalid State Flow read path");
    const [, root, rootOffset, patchOffset] = match;
    if (path.includes(".patches") && rootOffset !== undefined)
        throw new Error("Index patches after .patches, not after the scope");
    if (path.includes(".patches") && root === "effective")
        throw new Error("Patch history requires an explicit scope");
    const offset = Number(patchOffset ?? rootOffset ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > historyLimit)
        throw new Error(`State Flow read path index must be an integer from 0 to ${historyLimit}`);
    if (patchOffset !== undefined || path.endsWith(".patches")) {
        return { kind: "patch", path, offset, scope: root };
    }
    return { kind: "state", path, offset, ...(root === "effective" ? {} : { scope: root }) };
}
export function readStatePath(view, path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const query = parseStateReadPath(path, historyLimit);
    if (query.kind === "state") {
        const boundary = view.lineage[view.lineage.length - 1 - query.offset];
        if (!boundary)
            throw new Error("Requested history predates the proven temporal origin");
        return { path, boundary: structuredClone(boundary), state: projectStateForModel(readTemporalState(view, query.offset, query.scope, historyLimit)) };
    }
    const record = view.scopes[query.scope].patches.at(-1 - query.offset);
    if (!record)
        throw new Error(`Requested ${query.scope} patch predates retained hot history`);
    return { path, boundary: structuredClone(record.transition), patch: structuredClone(record.patch) };
}
function parseValuePath(path) {
    const explicitRoot = /^(?:effective|global|cwd|session)(?:\[\d+\])?(?=\.|$)/.exec(path)?.[0];
    const implicitRoot = /^(?:artifacts|contract|working|intents|response|lazy)(?=\.|\[|$)/.exec(path)?.[0];
    if (explicitRoot === undefined && implicitRoot === undefined) {
        throw new Error("State Flow read path requires a semantic path or an effective, global, cwd, or session root");
    }
    const root = explicitRoot ?? "effective";
    const selectors = implicitRoot === undefined ? [] : [{ kind: "key", key: implicitRoot }];
    let rest = path.slice((explicitRoot ?? implicitRoot).length);
    while (rest.length > 0) {
        const key = /^\.([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(rest);
        if (key) {
            selectors.push({ kind: "key", key: key[1] });
            rest = rest.slice(key[0].length);
            continue;
        }
        const range = /^\[(\d+)(?::|\.\.)(\d+)\]/.exec(rest);
        if (range) {
            selectors.push({ kind: "range", start: Number(range[1]), end: Number(range[2]) });
            rest = rest.slice(range[0].length);
            continue;
        }
        const index = /^\[(\d+)\]/.exec(rest);
        if (index) {
            selectors.push({ kind: "index", index: Number(index[1]) });
            rest = rest.slice(index[0].length);
            continue;
        }
        throw new Error("Invalid State Flow read path selector");
    }
    return { root, selectors };
}
function selectValue(root, selectors, path) {
    let value = root;
    for (const selector of selectors) {
        if (selector.kind === "key") {
            if (!isObject(value) || !Object.hasOwn(value, selector.key))
                throw new Error(`State Flow read path does not exist: ${path}`);
            value = value[selector.key];
            continue;
        }
        if (!Array.isArray(value))
            throw new Error(`State Flow array selector requires an array: ${path}`);
        if (selector.kind === "index") {
            if (selector.index >= value.length)
                throw new Error(`Index ${selector.index} is outside ${path} with length ${value.length}`);
            value = value[selector.index];
            continue;
        }
        if (selector.start > selector.end || selector.end > value.length)
            throw new Error(`Range [${selector.start}:${selector.end}] is outside ${path} with length ${value.length}`);
        value = value.slice(selector.start, selector.end);
    }
    return structuredClone(value);
}
function valueKind(value) {
    if (Array.isArray(value))
        return "array";
    if (isObject(value))
        return "object";
    return typeof value;
}
function referenceCandidates(path) {
    if (/^(?:artifacts|contract|working|intents|response|lazy)(?=\.|\[|$)/.test(path))
        return [path, `effective.${path}`];
    return [path];
}
function inlineReferencePattern(path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9_$.[\\]:-])\\$${escaped}(?=$|[^A-Za-z0-9_$.[\\]:-])`, "u");
}
/** Reactively locate exact durable sources for one failed state-path resolution. */
export function findStateReferenceSources(view, path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const candidates = referenceCandidates(path);
    const patterns = candidates.map(inlineReferencePattern);
    const sources = [];
    let visited = 0;
    let truncated = false;
    const visit = (value, owner, ownerPath) => {
        if (sources.length >= MAX_REFERENCE_SOURCES || visited >= MAX_REFERENCE_SCAN_NODES) {
            truncated = true;
            return;
        }
        visited += 1;
        if (typeof value === "string") {
            if (patterns.some((pattern) => pattern.test(value)))
                sources.push({ scope: owner, path: ownerPath, form: "text" });
            return;
        }
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length && !truncated; index++)
                visit(value[index], owner, `${ownerPath}[${index}]`);
            return;
        }
        if (!isObject(value))
            return;
        if (typeof value.$ref === "string" && candidates.includes(value.$ref)) {
            sources.push({ scope: owner, path: ownerPath, form: "structured" });
            if (sources.length >= MAX_REFERENCE_SOURCES) {
                truncated = true;
                return;
            }
        }
        for (const key of Object.keys(value).sort()) {
            if (key === "response" || (key === "$ref" && typeof value[key] === "string"))
                continue;
            visit(value[key], owner, ownerPath ? `${ownerPath}.${key}` : `${owner}.${key}`);
            if (truncated)
                return;
        }
    };
    for (const scope of ["global", "cwd", "session"]) {
        const state = readTemporalState(view, 0, scope, historyLimit);
        for (const plane of ["artifacts", "contract", "working", "intents", "lazy"]) {
            const value = state[plane];
            if (value !== undefined)
                visit(value, scope, `${scope}.${plane}`);
            if (truncated)
                break;
        }
        if (truncated)
            break;
    }
    sources.sort((left, right) => (left.form === right.form ? left.path.localeCompare(right.path) : left.form === "structured" ? -1 : 1));
    return { sources, truncated };
}
function missingReferenceHint(view, path, historyLimit) {
    const { sources, truncated } = findStateReferenceSources(view, path, historyLimit);
    if (sources.length === 0)
        return undefined;
    return [{
            type: "dangling-reference",
            message: `The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task${truncated ? "; additional reference owners may exist beyond the bounded scan" : ""}.`,
            paths: sources.map(({ path: sourcePath }) => sourcePath),
        }];
}
function projectValue(value, projection) {
    if (projection === "value")
        return { value: structuredClone(value) };
    if (isObject(value)) {
        return {
            meta: { type: "object", size: Object.keys(value).length },
            keys: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, valueKind(child)])),
        };
    }
    if (Array.isArray(value))
        return { meta: { type: "array", length: value.length }, keys: [] };
    if (typeof value === "string")
        return { meta: { type: "string", length: value.length }, keys: [] };
    if (value === null)
        throw new Error("State Flow semantic state cannot contain null");
    return { meta: { type: typeof value }, keys: [] };
}
function patchAtPath(view, root, selectors, path, historyLimit) {
    const rootQuery = parseStateReadPath(root, historyLimit);
    if (rootQuery.kind !== "state")
        throw new Error("Patch projection requires a state path");
    const boundary = view.lineage.at(-1 - rootQuery.offset);
    if (!boundary)
        throw new Error("Requested history predates the proven temporal origin");
    let patch = {};
    if (rootQuery.scope) {
        patch = structuredClone(view.scopes[rootQuery.scope].patches.find((record) => record.transition.id === boundary.id)?.patch ?? {});
    }
    else {
        const before = view.lineage.at(-2 - rootQuery.offset);
        if (before) {
            const current = readTemporalState(view, rootQuery.offset, undefined, historyLimit);
            const previous = readTemporalState(view, rootQuery.offset + 1, undefined, historyLimit);
            patch = diffObjects(previous, current);
        }
    }
    for (let index = 0; index < selectors.length; index++) {
        const selector = selectors[index];
        if (patch === null)
            return null;
        if (selector.kind === "key" && isObject(patch) && Object.hasOwn(patch, selector.key)) {
            patch = patch[selector.key];
            continue;
        }
        if (selector.kind !== "key" && isObject(patch)) {
            const key = selector.kind === "index" ? `[${selector.index}]` : undefined;
            if (key && Object.hasOwn(patch, key)) {
                patch = patch[key];
                continue;
            }
        }
        if (Array.isArray(patch))
            return selectValue(patch, selectors.slice(index), path);
        if (!isObject(patch)) {
            const result = readStatePath(view, root, historyLimit);
            if (!("state" in result))
                throw new Error("Patch projection requires a state path");
            return selectValue(result.state, selectors, path);
        }
        return {};
    }
    return structuredClone(patch);
}
function diffObjects(previous, current) {
    if (!isObject(previous) || !isObject(current))
        return structuredClone(current);
    const patch = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        if (!Object.hasOwn(current, key))
            patch[key] = null;
        else if (!Object.hasOwn(previous, key))
            patch[key] = structuredClone(current[key]);
        else if (!sameJson(previous[key], current[key]))
            patch[key] = diffObjects(previous[key], current[key]);
    }
    return patch;
}
/** Project exact current/historical state paths without exposing temporal metadata. */
export function readProjectedState(view, paths, projection = "value", historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (paths.length === 0)
        throw new Error("read_state requires at least one path");
    if (projection === "patch") {
        const patches = paths.map((path) => {
            const { root, selectors } = parseValuePath(path);
            return patchAtPath(view, root, selectors, path, historyLimit);
        });
        return { patch: patches.length === 1 ? patches[0] : patches };
    }
    const projected = paths.map((path) => {
        try {
            const { root, selectors } = parseValuePath(path);
            const query = parseStateReadPath(root, historyLimit);
            if (query.kind !== "state")
                throw new Error("Value and keys projections require a state path");
            const readsLazy = selectors[0]?.kind === "key" && selectors[0].key === "lazy";
            const state = readsLazy
                ? readTemporalState(view, query.offset, query.scope, historyLimit)
                : projectStateForModel(readTemporalState(view, query.offset, query.scope, historyLimit));
            if (readsLazy && !Object.hasOwn(state, "lazy"))
                state.lazy = {};
            return projectValue(selectValue(state, selectors, path), projection);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const missing = /does not exist| is outside /.test(message);
            const hint = missing && projection === "value" && paths.length === 1 ? missingReferenceHint(view, path, historyLimit) : undefined;
            if (hint)
                return { value: null, hint };
            throw new Error(message, error instanceof Error ? { cause: error } : undefined);
        }
    });
    if (projected.length === 1)
        return projected[0];
    if (projection === "value")
        return { value: projected.map((result) => result.value) };
    return {
        meta: projected.map((result) => result.meta),
        keys: projected.map((result) => result.keys),
    };
}
