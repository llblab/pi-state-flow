import {
	isArtifactRegistry,
	projectArtifactsForModel,
	updateArtifactRegistry,
	type ArtifactCompilationUpdate,
	type ArtifactRegistry,
} from "./artifact.ts";
import { applyPatch, isObject, type JsonObject } from "./json.ts";

/** The canonical semantic state shape shared by global, CWD, and session scopes. */
export interface MaterializedState extends JsonObject {
	artifacts: ArtifactRegistry;
	contract: JsonObject;
	working: JsonObject;
	response: string;
}

/** Compatibility name for callers that still treat materialized state as a document. */
export type StateDocument = MaterializedState;

/** Model patch shape; artifact entries may be compiler outputs before trusted metadata is attached. */
export interface StatePatch extends JsonObject {
	artifacts: JsonObject;
	contract: JsonObject;
	working: JsonObject;
	response: string;
}

export type StateScope = "global" | "cwd" | "session";

/** A model-authored patch for one scope. Response is captured by the runtime in session state. */
export interface ScopePatch {
	artifacts?: JsonObject;
	contract?: JsonObject;
	working?: JsonObject;
}

export interface ScopedPatch {
	scope: StateScope;
	patch: ScopePatch;
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

export function emptyState(): MaterializedState {
	return { artifacts: {}, contract: {}, working: {}, response: "" };
}

export function isMaterializedState(value: unknown): value is MaterializedState {
	return isObject(value)
		&& isArtifactRegistry(value.artifacts)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& typeof value.response === "string"
		&& Object.keys(value).every((key) => key === "artifacts" || key === "contract" || key === "working" || key === "response");
}

export const isStateDocument = isMaterializedState;

/** Atomically replace compiled and removed artifacts inside one materialized scope. */
export function updateMaterializedArtifacts(
	state: MaterializedState,
	updates: readonly ArtifactCompilationUpdate[],
	removed: readonly string[] = [],
): MaterializedState {
	if (!isMaterializedState(state)) throw new Error("Cannot update artifacts in an invalid materialized state");
	const artifacts = updateArtifactRegistry(state.artifacts, updates, removed);
	return { ...structuredClone(state), artifacts };
}

/** Overlay lower-to-higher scopes without mutating any scope document. */
export function overlayStates(...scopes: readonly MaterializedState[]): MaterializedState {
	return scopes.reduce<MaterializedState>((effective, scope) => {
		return applyPatch(effective, scope) as MaterializedState;
	}, emptyState());
}

/** Model-visible projection: runtime artifact bookkeeping never reaches ordinary context. */
export function projectStateForModel(state: MaterializedState): MaterializedState {
	return { ...structuredClone(state), artifacts: projectArtifactsForModel(state.artifacts) };
}
