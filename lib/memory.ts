import { assertScopeStateValues, type SemanticState, type ScopeStateValues, type ScopedStates, type StateScope } from "./state.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";

function hasSemanticMemory(state: SemanticState): boolean {
	return Object.keys(state.strategy ?? {}).length > 0 || Object.keys(state.tactics ?? {}).length > 0;
}

export function retainedMemoryScopes(states: ScopedStates): Record<StateScope, boolean>;
export function retainedMemoryScopes(states: ScopeStateValues, selection: ScopeSelection): Partial<Record<StateScope, boolean>>;
export function retainedMemoryScopes(states: ScopeStateValues, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): Partial<Record<StateScope, boolean>> {
	const selected = captureScopeSelection(selection);
	assertScopeStateValues(states, selected);
	return Object.fromEntries(selected.map(scope => [scope, hasSemanticMemory(states[scope]!)]));
}
