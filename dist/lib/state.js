import { isArtifactRegistry, updateArtifactRegistry, } from "./artifact.js";
import { applyPatch, isJsonValue, isObject, pruneEmptyObjects } from "./json.js";
import { projectPlaneContext, SEMANTIC_PLANES } from "./planes.js";
import { validateModuleObject, validateRetainedModules } from "./semantic-module.js";
/** Value admission only: owners must already be a captured policy, never inferred from missing data. */
export function assertScopeStateValues(states, owners) {
    if (!isObject(states) || Object.keys(states).length !== owners.length
        || Object.keys(states).some((scope) => !owners.includes(scope))
        || owners.some((scope) => !Object.hasOwn(states, scope)))
        throw new Error("Selected State Flow values must match their owners exactly");
    for (const scope of owners)
        if (!isJsonValue(states[scope]) || !isSemanticState(states[scope]))
            throw new Error(`Invalid selected State Flow ${scope} value`);
}
/** Temporary root-plane reservation; nested domain data is not an alternate semantic namespace. */
export function assertNoRetiredSemanticPlanes(value) {
    for (const plane of ["contract", "working"]) {
        if (Object.hasOwn(value, plane))
            throw new Error(`Retired State Flow semantic plane: ${plane}`);
    }
}
export function emptyState() {
    return { intents: {}, strategy: {}, tactics: {}, artifacts: {}, response: "", lazy: {} };
}
export function isMaterializedState(value) {
    return isObject(value)
        && !Object.hasOwn(value, "contract") && !Object.hasOwn(value, "working")
        && isArtifactRegistry(value.artifacts)
        && SEMANTIC_PLANES.every(({ module }) => module.validate(value[module.id]));
}
/** Missing planes are valid storage, not missing authority. Present values retain their type checks. */
export function isSemanticState(value) {
    return isObject(value) && isMaterializedState({ ...emptyState(), ...value });
}
export const isStateDocument = isMaterializedState;
/** Atomically replace compiled and removed artifacts inside one materialized scope. */
export function updateMaterializedArtifacts(state, updates, removed = []) {
    if (!isMaterializedState(state))
        throw new Error("Cannot update artifacts in an invalid materialized state");
    const artifacts = updateArtifactRegistry(state.artifacts, updates, removed);
    return { ...structuredClone(state), artifacts };
}
/** Overlay lower-to-higher scopes without mutating any scope document. */
export function overlayStates(...scopes) {
    return scopes.reduce((effective, scope) => {
        assertNoRetiredSemanticPlanes(scope);
        return applyPatch(effective, scope);
    }, emptyState());
}
/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export function selectSemanticFields(value, modules) {
    assertNoRetiredSemanticPlanes(value);
    if (modules !== undefined)
        validateExternalPlanes(value, modules, true);
    return structuredClone(Object.fromEntries([...Object.keys(emptyState()), ...Object.keys(modules ?? {})]
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]])));
}
/** v4 admits only declared object planes; null is a replay deletion, never stored content. */
export function validateExternalPlanes(value, modules, patch = false) {
    validateRetainedModules(modules);
    const core = emptyState();
    for (const [key, field] of Object.entries(value)) {
        if (Object.hasOwn(core, key))
            continue;
        if (!Object.hasOwn(modules, key) || !(patch && field === null || isObject(field))) {
            throw new Error(`Undeclared or invalid State Flow external plane: ${key}`);
        }
        if (field !== null)
            validateModuleObject(field);
    }
}
/** Normalize only core planes: opaque external bodies are not empty-branch policy subjects. */
export function pruneSemanticState(value) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
        if (key.startsWith("x_"))
            return [[key, field]];
        const pruned = pruneEmptyObjects({ [key]: field });
        return Object.entries(pruned);
    }));
}
/** Read only documented, present planes; empty responses carry no semantic value. */
export function projectSemanticState(state, modules) {
    const projected = selectSemanticFields(state, modules);
    if (projected.response === "")
        delete projected.response;
    return projected;
}
/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export function projectSemanticPatch(patch, modules) {
    const projected = selectSemanticFields(patch, modules);
    if (projected.response === "")
        projected.response = null;
    return projected;
}
/** Explicit hot reads filter hidden bodies/bookkeeping without normalizing legacy semantic data. */
export function projectStateForRead(state, artifactHints = {}, modules) {
    const { lazy: _hidden, ...visible } = state;
    const selected = projectSemanticState(visible, modules);
    const core = projectPlaneContext(selected, artifactHints).state;
    return { ...core, ...Object.fromEntries(Object.keys(modules ?? {}).filter(id => Object.hasOwn(selected, id)).map(id => [id, structuredClone(selected[id])])) };
}
/** Ordinary model context omits empty object fields; exact reads and replay remain observational. */
export function projectStateForModel(state, artifactHints = {}) {
    return pruneEmptyObjects(projectStateForRead(state, artifactHints));
}
