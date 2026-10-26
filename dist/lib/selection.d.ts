import type { StateScope } from "./state.ts";
export type ScopeSelection = readonly [StateScope, ...StateScope[]];
/** Missing global configuration defaults to all owners; this is not a retained-session fallback. */
export declare const DEFAULT_SCOPE_SELECTION: ScopeSelection;
/** Validate an explicit value and detach it in canonical overlay order, without granting owner acquisition. */
export declare function captureScopeSelection(value: unknown): ScopeSelection;
/** Complete only the next unused owner; values replace the full argument prefix. */
export declare function scopeSelectionArgumentCompletions(prefix: string): string[];
/** Blank command arguments preserve policy; callers must not reinterpret them as all scopes. */
export declare function parseScopeSelectionArguments(args: string): ScopeSelection | undefined;
