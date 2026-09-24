import { isArtifactRegistry, projectArtifactsForModel, updateArtifactRegistry, } from "./artifact.js";
import { applyPatch, isObject } from "./json.js";
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
        && isObject(value.lazy)
        && Object.keys(value).every((key) => key === "artifacts" || key === "contract" || key === "working" || key === "intents" || key === "response" || key === "lazy");
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
/** Model-visible projection: lazy bodies and runtime artifact bookkeeping stay out of ordinary context. */
export function projectStateForModel(state, artifactHints = {}) {
    const cloned = structuredClone(state);
    return {
        intents: cloned.intents,
        contract: cloned.contract,
        working: cloned.working,
        artifacts: projectArtifactsForModel(cloned.artifacts, artifactHints),
        response: cloned.response,
    };
}
