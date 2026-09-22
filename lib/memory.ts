import type { MaterializedState, ScopedStates, StateScope } from "./state.ts";

function hasSemanticMemory(state: MaterializedState): boolean {
	return Object.keys(state.contract).length > 0 || Object.keys(state.working).length > 0;
}

export function retainedMemoryScopes(states: ScopedStates): Record<StateScope, boolean> {
	return {
		global: hasSemanticMemory(states.global),
		cwd: hasSemanticMemory(states.cwd),
		session: hasSemanticMemory(states.session),
	};
}
