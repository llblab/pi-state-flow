import {
	isArtifactRegistry,
	projectArtifactsForModel,
	updateArtifactRegistry,
	type ArtifactCompilationUpdate,
	type ArtifactModelHints,
	type ArtifactRegistry,
} from "./artifact.ts";
import { applyPatch, isObject, type JsonObject } from "./json.ts";

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

export function emptyState(): MaterializedState {
	return { intents: {}, contract: {}, working: {}, artifacts: {}, response: "", lazy: {} };
}

export function isMaterializedState(value: unknown): value is MaterializedState {
	return isObject(value)
		&& isArtifactRegistry(value.artifacts)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& isObject(value.intents)
		&& typeof value.response === "string"
		&& isObject(value.lazy);
}

/** Missing planes are valid storage, not missing authority. Present values retain their type checks. */
export function isSemanticState(value: unknown): value is SemanticState {
	return isObject(value) && isMaterializedState({ ...emptyState(), ...value });
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
export function overlayStates(...scopes: readonly JsonObject[]): MaterializedState {
	return scopes.reduce<MaterializedState>((effective, scope) => {
		return applyPatch(effective, scope) as MaterializedState;
	}, emptyState());
}

/** Default-bearing SDK compatibility view; model transport uses sparse SemanticState instead. */
export type ModelState = JsonObject & {
	intents: JsonObject;
	contract: JsonObject;
	working: JsonObject;
	artifacts: ArtifactRegistry;
	response: string;
};

/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export function selectSemanticFields(value: JsonObject): JsonObject {
	return structuredClone(Object.fromEntries(Object.keys(emptyState())
		.filter((key) => Object.hasOwn(value, key))
		.map((key) => [key, value[key]])));
}

/** Read only documented, present planes; empty responses carry no semantic value. */
export function projectSemanticState(state: JsonObject): SemanticState {
	const projected = selectSemanticFields(state);
	if (projected.response === "") delete projected.response;
	return projected;
}

/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export function projectSemanticPatch(patch: JsonObject): JsonObject {
	const projected = selectSemanticFields(patch);
	if (projected.response === "") projected.response = null;
	return projected;
}

/** Model-visible projection: lazy bodies and runtime artifact bookkeeping stay out of ordinary context. */
export function projectStateForModel(state: SemanticState, artifactHints: ArtifactModelHints = {}): SemanticState {
	const { lazy: _hidden, ...visible } = state;
	const projected = projectSemanticState(visible);
	if (projected.artifacts) projected.artifacts = projectArtifactsForModel(projected.artifacts, artifactHints);
	return projected;
}
