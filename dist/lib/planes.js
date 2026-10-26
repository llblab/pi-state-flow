// Domain: static bindings of the six stored planes to the internal module contract.
// Excludes: storage dialect expansion, source acquisition, staging order and publication.
import { projectArtifactsForModel } from "./artifact.js";
import { isObject } from "./json.js";
import { evaluateModuleContext } from "./semantic-module.js";
export function lazyValueKind(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "object")
        return "object";
    return typeof value;
}
function hasLazyContent(value) {
    return !isObject(value) || Object.values(value).some(hasLazyContent);
}
/** Navigation only: existing complete-catalog budgets, never lazy bodies. */
export function projectLazyNavigation(content) {
    const entries = isObject(content) ? Object.entries(content).filter(([, value]) => hasLazyContent(value)) : [];
    const base = { available: entries.length > 0, path: "effective.lazy" };
    if (!base.available || entries.length > 32)
        return base;
    const keys = Object.fromEntries(entries.map(([key, value]) => [key, lazyValueKind(value)]));
    return JSON.stringify(keys).length <= 1024 ? { ...base, keys } : base;
}
function objectPlane(id) {
    return Object.freeze({
        immutable: false,
        id,
        validate: isObject,
        context: (content) => content === undefined ? [] : [{ kind: "data", value: content }],
    });
}
const artifacts = Object.freeze({
    immutable: false,
    id: "artifacts",
    // Observation may contain retained legacy bookkeeping; canonical artifact admission stays in its owner.
    validate: isObject,
    context: (content, frame) => content === undefined ? [] : [{ kind: "data", value: projectArtifactsForModel(content, frame.input.artifactHints) }],
});
const response = Object.freeze({
    immutable: true,
    id: "response",
    validate: (value) => typeof value === "string",
    context: (content, frame) => content === undefined || content === "" || frame.mode === "passive" ? [] : [{ kind: "data", value: content }],
});
const lazy = Object.freeze({
    immutable: false,
    id: "lazy",
    validate: isObject,
    context: (content, frame) => [{ kind: "data", value: (frame.input.lazyNavigation ?? projectLazyNavigation(content)) }],
});
/** Storage/presentation bindings are explicit; a module id alone never registers a stored root. */
export const SEMANTIC_PLANES = Object.freeze([
    { module: objectPlane("intents"), target: "state" },
    { module: objectPlane("strategy"), target: "state" },
    { module: objectPlane("tactics"), target: "state" },
    { module: artifacts, target: "state" },
    { module: response, target: "state" },
    { module: lazy, target: "lazy_navigation" },
].map(binding => Object.freeze(binding)));
export const MODEL_PLANE_NAMES = Object.freeze(SEMANTIC_PLANES.filter(({ module }) => !module.immutable).map(({ module }) => module.id));
/** Ordinary context values and navigation share the same executable mode-aware module path. */
export function projectPlaneContext(state, hints = {}, mode = "active") {
    const projected = {};
    let navigation;
    for (const { module, target } of SEMANTIC_PLANES) {
        // Lazy needs structural metadata only; never clone its hidden body into a context callback.
        const content = target !== "lazy_navigation" && Object.hasOwn(state, module.id) ? state[module.id] : undefined;
        const input = { artifactHints: hints, ...(target === "lazy_navigation" ? { lazyNavigation: projectLazyNavigation(state.lazy) } : {}) };
        const contribution = evaluateModuleContext(module, content, { mode, conversation: [], input });
        if (contribution.length > 1 || contribution[0]?.kind === "conversation")
            throw new Error("Stored-plane binding requires at most one data contribution");
        const item = contribution[0];
        if (!item || item.kind !== "data")
            continue;
        if (target === "lazy_navigation")
            navigation = item.value;
        else
            Object.defineProperty(projected, module.id, { value: item.value, enumerable: true, configurable: true, writable: true });
    }
    return { state: projected, lazy_navigation: navigation };
}
