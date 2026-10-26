import { assertScopeStateValues } from "./state.js";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION } from "./selection.js";
function hasSemanticMemory(state) {
    return Object.keys(state.strategy ?? {}).length > 0 || Object.keys(state.tactics ?? {}).length > 0;
}
export function retainedMemoryScopes(states, selection = DEFAULT_SCOPE_SELECTION) {
    const selected = captureScopeSelection(selection);
    assertScopeStateValues(states, selected);
    return Object.fromEntries(selected.map(scope => [scope, hasSemanticMemory(states[scope])]));
}
