import { isObject } from "./json.js";
const OWNED_PLANES = new Set(["working", "lazy"]);
// Same key grammar as read_state value paths; array selectors never parse.
const OBJECT_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
/**
 * Parse one structured `$ref` target as an ownership path of `scope`.
 * Cross-scope, unscoped, `effective`, historical, plane-root, array-element
 * and non-`working`/`lazy` targets are not ownership targets.
 */
export function parseOwnedPath(scope, ref) {
    const parts = ref.split(".");
    if (parts.length < 3 || parts[0] !== scope || !OWNED_PLANES.has(parts[1]))
        return undefined;
    const keys = parts.slice(2);
    if (!keys.every((key) => OBJECT_KEY.test(key)))
        return undefined;
    return { plane: parts[1], keys };
}
function pathId(path) {
    return JSON.stringify([path.plane, ...path.keys]);
}
/** Extract unique ownership targets from structured references anywhere inside one intent value. */
export function extractOwnedPaths(scope, value) {
    const found = new Map();
    const visit = (node) => {
        if (Array.isArray(node)) {
            for (const item of node)
                visit(item);
            return;
        }
        if (!isObject(node))
            return;
        if (typeof node.$ref === "string") {
            const path = parseOwnedPath(scope, node.$ref);
            if (path)
                found.set(pathId(path), path);
        }
        for (const key of Object.keys(node))
            if (key !== "$ref" || typeof node[key] !== "string")
                visit(node[key]);
    };
    visit(value);
    return [...found.values()];
}
function related(left, right) {
    if (left.plane !== right.plane)
        return false;
    const length = Math.min(left.keys.length, right.keys.length);
    for (let index = 0; index < length; index++)
        if (left.keys[index] !== right.keys[index])
            return false;
    return true;
}
function exists(state, path) {
    let node = state[path.plane];
    for (const key of path.keys) {
        if (!isObject(node) || !Object.hasOwn(node, key))
            return false;
        node = node[key];
    }
    return true;
}
/**
 * Compute the same-scope ownership cascade for intent keys removed between
 * `before` and `after` (the state after authored operations). A target is
 * kept while any remaining intent references it, an ancestor or a descendant;
 * missing targets are skipped. The result is minimal (no target below
 * another) and deterministically ordered.
 */
export function computeIntentCascade(scope, before, after) {
    const previous = isObject(before.intents) ? before.intents : {};
    const remaining = isObject(after.intents) ? after.intents : {};
    const deleted = Object.keys(previous).filter((key) => !Object.hasOwn(remaining, key));
    if (deleted.length === 0)
        return [];
    const candidates = new Map();
    for (const key of deleted)
        for (const path of extractOwnedPaths(scope, previous[key]))
            candidates.set(pathId(path), path);
    if (candidates.size === 0)
        return [];
    const retained = Object.values(remaining).flatMap((value) => extractOwnedPaths(scope, value));
    const owned = [...candidates.values()].filter((path) => !retained.some((other) => related(path, other)) && exists(after, path));
    return owned
        .filter((path) => !owned.some((other) => other.keys.length < path.keys.length && related(path, other)))
        .sort((left, right) => pathId(left).localeCompare(pathId(right)));
}
/** Express cascade targets as explicit nested object-key deletions. */
export function cascadeDeletionPatch(paths) {
    const patch = {};
    const define = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    for (const path of paths) {
        if (!Object.hasOwn(patch, path.plane))
            define(patch, path.plane, {});
        let node = patch[path.plane];
        for (const key of path.keys.slice(0, -1)) {
            if (!Object.hasOwn(node, key))
                define(node, key, {});
            node = node[key];
        }
        define(node, path.keys.at(-1), null);
    }
    return patch;
}
/** Render an ownership target as its scoped `read_state` path. */
export function formatOwnedPath(scope, path) {
    return [scope, path.plane, ...path.keys].join(".");
}
/** Top-level `working`/`lazy` keys that at least one current intent of `scope` owns. */
export function ownedTopLevelKeys(scope, state) {
    const owned = { working: new Set(), lazy: new Set() };
    const intents = isObject(state.intents) ? state.intents : {};
    for (const value of Object.values(intents))
        for (const path of extractOwnedPaths(scope, value))
            owned[path.plane].add(path.keys[0]);
    return owned;
}
