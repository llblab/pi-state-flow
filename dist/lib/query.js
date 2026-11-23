import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.js";
import { isObject, sameJson } from "./json.js";
import { emptyState, projectSemanticPatch, projectStateForRead } from "./state.js";
import { readTemporalView, validateSelectedTemporalState, validateTemporalState } from "./temporal.js";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION } from "./selection.js";
function retainedQueryModules(view, scope) {
    const modules = Object.assign({}, ...(scope ? [scope] : queryOwners(view)).map(owner => view.scopes[owner]?.modules ?? {}));
    return Object.keys(modules).length ? modules : undefined;
}
function queryOwners(view) {
    return Object.hasOwn(view, "selection") || Object.hasOwn(view, "causalBasis")
        ? captureScopeSelection(view.selection) : DEFAULT_SCOPE_SELECTION;
}
function assertQueryScope(view, scope) {
    if (scope !== undefined && !queryOwners(view).includes(scope))
        throw new Error(`State Flow ${scope} scope is excluded`);
}
function queryStream(view, scope, historyLimit) {
    assertQueryScope(view, scope);
    if (Object.hasOwn(view, "selection") || Object.hasOwn(view, "causalBasis"))
        validateSelectedTemporalState(view, historyLimit);
    const stream = view.scopes[scope];
    if (!stream)
        throw new Error(`State Flow ${scope} scope is excluded or unavailable`);
    return stream;
}
export class StateReadPathError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
    }
}
const MAX_REFERENCE_SOURCES = 3;
const MAX_REFERENCE_SCAN_NODES = 10_000;
const PATH_PATTERN = /^(effective|global|cwd|session)(?:\[(\d+)\])?(?:\.patches(?:\[(\d+)\])?)?$/;
const PATCH_HISTORY_LOCATOR = /^(?:(effective|global|cwd|session)\.)?patches(?:\[\d+\])?$/;
const FLAT_SEMANTIC_ROOT = /^(?:artifacts|strategy|tactics|intents|response|lazy|x_[a-z][a-z0-9_]*)(?=\.|\[|$)/;
/** Recognize patch-history syntax only; effective still fails temporal validation. */
export function patchHistoryRoot(path) {
    const match = PATCH_HISTORY_LOCATOR.exec(path);
    return match ? match[1] ?? "flat" : undefined;
}
export function flatSemanticRoot(path) {
    return FLAT_SEMANTIC_ROOT.exec(path)?.[0];
}
/** Resolve a projection root without repeating the tool name in every path. */
export function parseStateReadPath(path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > MAX_HISTORY_LIMIT) {
        throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
    }
    const match = PATH_PATTERN.exec(path);
    if (!match)
        throw new StateReadPathError("invalid_path", "Invalid State Flow read path");
    const [, root, rootOffset, patchOffset] = match;
    if (path.includes(".patches") && rootOffset !== undefined)
        throw new StateReadPathError("invalid_path", "Index patches after .patches, not after the scope");
    if (path.includes(".patches") && root === "effective")
        throw new StateReadPathError("invalid_path", "Patch history requires an explicit scope");
    const offset = Number(patchOffset ?? rootOffset ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > historyLimit)
        throw new StateReadPathError("invalid_path", `State Flow read path index must be an integer from 0 to ${historyLimit}`);
    if (patchOffset !== undefined || path.endsWith(".patches")) {
        return { kind: "patch", path, offset, scope: root };
    }
    return { kind: "state", path, offset, ...(root === "effective" ? {} : { scope: root }) };
}
export function readStatePath(view, path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const query = parseStateReadPath(path, historyLimit);
    assertQueryScope(view, query.scope);
    if (query.kind === "state") {
        const boundary = view.lineage[view.lineage.length - 1 - query.offset];
        if (!boundary)
            throw new Error("Requested history predates the proven temporal origin");
        return { path, boundary: structuredClone(boundary), state: projectStateForRead(readTemporalView(view, query.offset, query.scope, historyLimit), {}, retainedQueryModules(view, query.scope)) };
    }
    const record = queryStream(view, query.scope, historyLimit).patches.at(-1 - query.offset);
    if (!record)
        throw new Error(`Requested ${query.scope} patch predates retained hot history`);
    return { path, boundary: structuredClone(record.transition), patch: projectSemanticPatch(record.patch, retainedQueryModules(view, query.scope)) };
}
/** Parse semantic locator syntax without resolving values, authority or target existence. */
export function parseValuePath(path) {
    const explicitRoot = /^(?:effective|global|cwd|session)(?:\[\d+\])?(?=\.|$)/.exec(path)?.[0];
    const implicitRoot = flatSemanticRoot(path);
    if (explicitRoot === undefined && implicitRoot === undefined) {
        throw new StateReadPathError("invalid_path", "State Flow read path requires a semantic path or an effective, global, cwd, or session root");
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
        throw new StateReadPathError("invalid_path", "Invalid State Flow read path selector; object keys must match [A-Za-z_$][A-Za-z0-9_$-]* (ASCII), array selectors use [N] or [start..end]");
    }
    return { root, selectors };
}
function selectValue(root, selectors, path) {
    let value = root;
    for (const selector of selectors) {
        if (selector.kind === "key") {
            if (!isObject(value) || !Object.hasOwn(value, selector.key))
                throw new StateReadPathError("path_not_found", `State Flow read path does not exist: ${path}`);
            value = value[selector.key];
            continue;
        }
        if (!Array.isArray(value))
            throw new StateReadPathError("invalid_selector", `State Flow array selector requires an array: ${path}`);
        if (selector.kind === "index") {
            if (selector.index >= value.length)
                throw new StateReadPathError("invalid_selector", `Index ${selector.index} is outside ${path} with length ${value.length}`);
            value = value[selector.index];
            continue;
        }
        if (selector.start > selector.end || selector.end > value.length)
            throw new StateReadPathError("invalid_selector", `Range [${selector.start}:${selector.end}] is outside ${path} with length ${value.length}`);
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
    if (flatSemanticRoot(path))
        return [path, `effective.${path}`];
    return [path];
}
function inlineReferencePattern(path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9_$.[\\]:-])\\$${escaped}(?=$|[^A-Za-z0-9_$.[\\]:-])`, "u");
}
/** Reactively locate exact durable sources for one failed state-path resolution. */
export function findStateReferenceSources(view, path, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const owner = /^(global|cwd|session)(?:\[\d+\])?(?=\.|$)/.exec(path)?.[1];
    assertQueryScope(view, owner);
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
    for (const scope of queryOwners(view)) {
        const state = readTemporalView(view, 0, scope, historyLimit);
        for (const plane of ["artifacts", "strategy", "tactics", "intents", "lazy", ...Object.keys(view.scopes[scope]?.modules ?? {})]) {
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
function projectKeys(value) {
    if (value === undefined)
        return { meta: { type: "absent" }, keys: {} };
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
    assertQueryScope(view, rootQuery.scope);
    if (Object.hasOwn(view, "selection") || Object.hasOwn(view, "causalBasis"))
        validateSelectedTemporalState(view, historyLimit);
    const boundary = view.lineage.at(-1 - rootQuery.offset);
    if (!boundary)
        throw new Error("Requested history predates the proven temporal origin");
    let patch = {};
    if (rootQuery.scope) {
        const stream = queryStream(view, rootQuery.scope, historyLimit);
        const record = stream.patches.find((record) => record.transition.id === boundary.id);
        if (Object.hasOwn(view, "selection") && !record && stream.checkpoint.through.id === boundary.id && boundary.parent !== null) {
            throw new Error(`Requested ${rootQuery.scope} patch predates retained hot history`);
        }
        patch = projectSemanticPatch((record?.patch ?? {}), retainedQueryModules(view, rootQuery.scope));
    }
    else {
        const before = view.lineage.at(-2 - rootQuery.offset);
        if (Object.hasOwn(view, "selection") && !before && boundary.parent !== null && queryOwners(view).some(scope => {
            const stream = view.scopes[scope];
            return stream.checkpoint.through.position >= boundary.position || stream.patches.some(record => record.transition.id === boundary.id);
        }))
            throw new Error("Requested effective patch predates retained hot history");
        if (before) {
            const current = readTemporalView(view, rootQuery.offset, undefined, historyLimit);
            const previous = readTemporalView(view, rootQuery.offset + 1, undefined, historyLimit);
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
    const patch = Object.create(null);
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
function resolveProjectedPath(path, historyLimit) {
    const { root, selectors } = parseValuePath(path);
    const query = parseStateReadPath(root, historyLimit);
    if (query.kind !== "state")
        throw new Error("Value and keys projections require a state path");
    const field = selectors.length === 1 && selectors[0]?.kind === "key" ? selectors[0].key : undefined;
    return { query, selectors, field, builtIn: field !== undefined && Object.hasOwn(emptyState(), field) };
}
function materializeReadRoot(view, query, historyLimit) {
    return { raw: readTemporalView(view, query.offset, query.scope, historyLimit), modules: retainedQueryModules(view, query.scope) };
}
function selectStatePath(root, path, resolved, projection) {
    const { query, selectors, field, builtIn } = resolved;
    const { raw, modules } = root;
    const state = selectors[0]?.kind === "key" && selectors[0].key === "lazy" ? raw : (root.visible ??= projectStateForRead(raw, {}, modules));
    if (field !== undefined && !Object.hasOwn(state, field)) {
        if (projection === "value" && (builtIn || /^x_[a-z][a-z0-9_]*$/.test(field)))
            return undefined;
        if (projection === "keys" && query.offset === 0 && (builtIn || (modules && Object.hasOwn(modules, field))))
            return undefined;
    }
    return selectValue(state, selectors, path);
}
/** Preserve input slots. Only typed locator failures are collected; an invalid read basis still rejects the batch. */
export function readValueBatch(view, paths, normalizePath, availability, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (paths.length < 2)
        throw new Error("A State Flow value batch requires at least two paths");
    const owners = view ? queryOwners(view) : [];
    if (view) {
        if ("selection" in view)
            validateSelectedTemporalState(view, historyLimit);
        else
            validateTemporalState(view, historyLimit);
    }
    // Reuse adjacent successful roots without retaining every historical materialization in a batch.
    let last;
    return { values: paths.map((requested) => {
            try {
                const path = normalizePath(requested);
                const patchRoot = patchHistoryRoot(path);
                if (patchRoot !== undefined && patchRoot !== "flat" && patchRoot !== "effective")
                    throw new StateReadPathError("invalid_path");
                const resolved = resolveProjectedPath(path, historyLimit);
                const { query: { scope, offset }, selectors, builtIn } = resolved;
                if (availability[scope ?? "effective"] === "absent") {
                    if (offset !== 0)
                        throw new StateReadPathError("history_unavailable");
                    if (selectors.length === 0 || builtIn)
                        return null;
                    throw new StateReadPathError("path_not_found");
                }
                if (!view || (scope !== undefined && !owners.includes(scope)))
                    throw new StateReadPathError("scope_unavailable");
                if (offset >= view.lineage.length)
                    throw new StateReadPathError("history_unavailable");
                if (!last || last.scope !== scope || last.offset !== offset)
                    last = { scope, offset, root: materializeReadRoot(view, resolved.query, historyLimit) };
                return selectStatePath(last.root, path, resolved, "value") ?? null;
            }
            catch (error) {
                if (!(error instanceof StateReadPathError))
                    throw error;
                return [null, { code: error.code }];
            }
        }) };
}
/** Project exact paths; the caller may supply current catalog statuses without inventing temporal streams. */
export function readProjectedState(view, paths, projection = "value", historyLimit = DEFAULT_HISTORY_LIMIT, availability = {}) {
    if (paths.length === 0)
        throw new Error("state_flow_read requires at least one path");
    if (view)
        queryOwners(view);
    if (projection === "patch") {
        if (!view)
            throw new Error("State Flow temporal runtime is unavailable");
        const patches = paths.map((path) => {
            const { root, selectors } = parseValuePath(path);
            return patchAtPath(view, root, selectors, path, historyLimit);
        });
        return { patch: patches.length === 1 ? patches[0] : patches };
    }
    const projected = paths.map((path) => {
        try {
            const resolved = resolveProjectedPath(path, historyLimit);
            const { query, selectors, builtIn } = resolved;
            const status = availability[query.scope ?? "effective"];
            if (status === "absent" || (projection === "keys" && status !== undefined)) {
                if (query.offset === 0 && (selectors.length === 0 || builtIn)) {
                    return projection === "keys" ? { meta: { type: status }, keys: {} } : { value: null };
                }
                if (query.scope)
                    throw new Error(`State Flow ${query.scope}: selected, unavailable for this path`);
            }
            if (!view)
                throw new Error("State Flow temporal runtime is unavailable");
            const value = selectStatePath(materializeReadRoot(view, query, historyLimit), path, resolved, projection);
            return projection === "keys" ? projectKeys(value) : { value: value ?? null };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const missing = /does not exist| is outside /.test(message);
            const hint = view && missing && projection === "value" && paths.length === 1 ? missingReferenceHint(view, path, historyLimit) : undefined;
            if (hint)
                return { value: null, hint };
            throw new Error(message, error instanceof Error ? { cause: error } : undefined);
        }
    });
    if (projected.length === 1)
        return projected[0];
    if (projection === "value")
        return { values: projected.map((result) => result.value) };
    return {
        meta: projected.map((result) => result.meta),
        keys: projected.map((result) => result.keys),
    };
}
