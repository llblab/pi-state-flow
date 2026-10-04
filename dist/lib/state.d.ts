import { type ArtifactCompilationUpdate, type ArtifactModelHints, type ArtifactRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
/** Runtime defaults for documented semantic planes; stored objects may omit them or retain other fields. */
export type MaterializedState = JsonObject & {
    intents: JsonObject;
    contract: JsonObject;
    working: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
    lazy: JsonObject;
};
/** Sparse semantic state: documented planes may be absent. Disk codecs select only known fields. */
export type SemanticState = JsonObject & Partial<{
    intents: JsonObject;
    contract: JsonObject;
    working: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
    lazy: JsonObject;
}>;
export type ScopedSemanticStates = Record<StateScope, SemanticState>;
/** Compatibility name for callers that still treat materialized state as a document. */
export type StateDocument = MaterializedState;
/** Model patch shape; artifact entries may be compiler outputs before trusted metadata is attached. */
export interface StatePatch extends JsonObject {
    artifacts: JsonObject;
    contract: JsonObject;
    working: JsonObject;
    intents: JsonObject;
    response: string;
    lazy: JsonObject;
}
export type StateScope = "global" | "cwd" | "session";
/** A model-authored patch for one scope. Response is captured by the runtime in session state. */
export interface ScopePatch {
    artifacts?: JsonObject;
    contract?: JsonObject;
    working?: JsonObject;
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
    contract: JsonObject;
    working: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
};
/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export declare function selectSemanticFields(value: JsonObject): JsonObject;
/** Read only documented, present planes; empty responses carry no semantic value. */
export declare function projectSemanticState(state: JsonObject): SemanticState;
/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export declare function projectSemanticPatch(patch: JsonObject): JsonObject;
/** Explicit hot reads filter hidden bodies/bookkeeping without normalizing legacy semantic data. */
export declare function projectStateForRead(state: SemanticState, artifactHints?: ArtifactModelHints): SemanticState;
/** Ordinary model context omits empty object fields; exact reads and replay remain observational. */
export declare function projectStateForModel(state: SemanticState, artifactHints?: ArtifactModelHints): SemanticState;
