import { type ArtifactCompilationUpdate, type ArtifactModelHints, type ArtifactRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
/** The canonical semantic state shape shared by global, CWD, and session scopes. */
export type MaterializedState = JsonObject & {
    intents: JsonObject;
    contract: JsonObject;
    working: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
    lazy: JsonObject;
};
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
export declare const isStateDocument: typeof isMaterializedState;
/** Atomically replace compiled and removed artifacts inside one materialized scope. */
export declare function updateMaterializedArtifacts(state: MaterializedState, updates: readonly ArtifactCompilationUpdate[], removed?: readonly string[]): MaterializedState;
/** Overlay lower-to-higher scopes without mutating any scope document. */
export declare function overlayStates(...scopes: readonly MaterializedState[]): MaterializedState;
export type ModelState = JsonObject & {
    intents: JsonObject;
    contract: JsonObject;
    working: JsonObject;
    artifacts: ArtifactRegistry;
    response: string;
};
/** Model-visible projection: lazy bodies and runtime artifact bookkeeping stay out of ordinary context. */
export declare function projectStateForModel(state: MaterializedState, artifactHints?: ArtifactModelHints): ModelState;
