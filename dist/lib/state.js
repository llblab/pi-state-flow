import { isArtifactRegistry, projectArtifactsForModel, updateArtifactRegistry, } from "./artifact.js";
import { applyPatch, isObject, pruneEmptyObjects } from "./json.js";
export function emptyState() {
    return { intents: {}, contract: {}, working: {}, artifacts: {}, response: "", lazy: {} };
}
export function isMaterializedState(value) {
    return isObject(value)
        && isArtifactRegistry(value.artifacts)
        && isObject(value.contract)
        && isObject(value.working)
        && isObject(value.intents)
        && typeof value.response === "string"
        && isObject(value.lazy);
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
        return applyPatch(effective, scope);
    }, emptyState());
}
/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export function selectSemanticFields(value) {
    return structuredClone(Object.fromEntries(Object.keys(emptyState())
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]])));
}
/** Read only documented, present planes; empty responses carry no semantic value. */
export function projectSemanticState(state) {
    const projected = selectSemanticFields(state);
    if (projected.response === "")
        delete projected.response;
    return projected;
}
/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export function projectSemanticPatch(patch) {
    const projected = selectSemanticFields(patch);
    if (projected.response === "")
        projected.response = null;
    return projected;
}
/** Explicit hot reads filter hidden bodies/bookkeeping without normalizing legacy semantic data. */
export function projectStateForRead(state, artifactHints = {}) {
    const { lazy: _hidden, ...visible } = state;
    const projected = projectSemanticState(visible);
    if (projected.artifacts)
        projected.artifacts = projectArtifactsForModel(projected.artifacts, artifactHints);
    return projected;
}
/** Ordinary model context omits empty object fields; exact reads and replay remain observational. */
export function projectStateForModel(state, artifactHints = {}) {
    return pruneEmptyObjects(projectStateForRead(state, artifactHints));
}
