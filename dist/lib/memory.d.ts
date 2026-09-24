import type { ScopedStates, StateScope } from "./state.ts";
export declare function retainedMemoryScopes(states: ScopedStates): Record<StateScope, boolean>;
