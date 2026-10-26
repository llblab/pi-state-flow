import { type ArtifactCompilationUpdate, type ArtifactModelHints, type ArtifactRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
import { type RetainedModules } from "./semantic-module.ts";
/** Runtime defaults for documented semantic planes; stored objects may omit them or retain other fields. */
export type MaterializedState = JsonObject & {
    intents: JsonObject;
    strategy: JsonObject;
    tactics: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
    lazy: JsonObject;
};
/** Sparse semantic state: documented planes may be absent. Disk codecs select only known fields. */
export type SemanticState = JsonObject & Partial<{
    intents: JsonObject;
    strategy: JsonObject;
    tactics: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
    lazy: JsonObject;
}>;
export type ScopedSemanticStates = Record<StateScope, SemanticState>;
/** Present owners only; a selection-aware caller must validate the exact acquired key set. */
export type ScopeStateValues = Partial<Record<StateScope, SemanticState>>;
/** Value admission only: owners must already be a captured policy, never inferred from missing data. */
export declare function assertScopeStateValues(states: ScopeStateValues, owners: readonly StateScope[]): void;
/** Compatibility name for callers that still treat materialized state as a document. */
export type StateDocument = MaterializedState;
/** Model patch shape; artifact entries may be compiler outputs before trusted metadata is attached. */
export interface StatePatch extends JsonObject {
    artifacts: JsonObject;
    strategy: JsonObject;
    tactics: JsonObject;
    intents: JsonObject;
    response: string;
    lazy: JsonObject;
}
export type StateScope = "global" | "cwd" | "session";
/** A model-authored patch for one scope. Response is captured by the runtime in session state. */
export interface ScopePatch {
    [module: `x_${string}`]: JsonObject | undefined;
    artifacts?: JsonObject;
    strategy?: JsonObject;
    tactics?: JsonObject;
    intents?: JsonObject;
    lazy?: JsonObject;
}
export interface ScopedPatch {
    scope: StateScope;
    patch: ScopePatch;
}
/** Canonical model-authored scope cohort before runtime final-eligibility handling. */
export interface AtomicScopePatches {
    global?: ScopePatch;
    cwd?: ScopePatch;
    session?: ScopePatch;
}
export interface SemanticTransition {
    transitions: ScopedPatch[];
}
export interface TerminalTransition extends SemanticTransition {
    response: string;
}
export interface ScopedStates {
    global: MaterializedState;
    cwd: MaterializedState;
    session: MaterializedState;
}
/** Temporary root-plane reservation; nested domain data is not an alternate semantic namespace. */
export declare function assertNoRetiredSemanticPlanes(value: JsonObject): void;
export declare function emptyState(): MaterializedState;
export declare function isMaterializedState(value: unknown): value is MaterializedState;
/** Missing planes are valid storage, not missing authority. Present values retain their type checks. */
export declare function isSemanticState(value: unknown): value is SemanticState;
export declare const isStateDocument: typeof isMaterializedState;
/** Atomically replace compiled and removed artifacts inside one materialized scope. */
export declare function updateMaterializedArtifacts(state: MaterializedState, updates: readonly ArtifactCompilationUpdate[], removed?: readonly string[]): MaterializedState;
/** Overlay lower-to-higher scopes without mutating any scope document. */
export declare function overlayStates(...scopes: readonly JsonObject[]): MaterializedState;
/** Default-bearing SDK compatibility view; model transport uses sparse SemanticState instead. */
export type ModelState = JsonObject & {
    intents: JsonObject;
    strategy: JsonObject;
    tactics: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
};
/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export declare function selectSemanticFields(value: JsonObject, modules?: RetainedModules): JsonObject;
/** v4 admits only declared object planes; null is a replay deletion, never stored content. */
export declare function validateExternalPlanes(value: JsonObject, modules: RetainedModules, patch?: boolean): void;
/** Normalize only core planes: opaque external bodies are not empty-branch policy subjects. */
export declare function pruneSemanticState(value: JsonObject): JsonObject;
/** Read only documented, present planes; empty responses carry no semantic value. */
export declare function projectSemanticState(state: JsonObject, modules?: RetainedModules): SemanticState;
/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export declare function projectSemanticPatch(patch: JsonObject, modules?: RetainedModules): JsonObject;
/** Explicit hot reads filter hidden bodies/bookkeeping without normalizing legacy semantic data. */
export declare function projectStateForRead(state: SemanticState, artifactHints?: ArtifactModelHints, modules?: RetainedModules): SemanticState;
/** Ordinary model context omits empty object fields; exact reads and replay remain observational. */
export declare function projectStateForModel(state: SemanticState, artifactHints?: ArtifactModelHints): SemanticState;
