import { type ScopeStateValues, type ScopedStates, type StateScope } from "./state.ts";
import { type ScopeSelection } from "./selection.ts";
export declare function retainedMemoryScopes(states: ScopedStates): Record<StateScope, boolean>;
export declare function retainedMemoryScopes(states: ScopeStateValues, selection: ScopeSelection): Partial<Record<StateScope, boolean>>;
