import {
	isArtifactRegistry,
	updateArtifactRegistry,
	type ArtifactCompilationUpdate,
	type ArtifactModelHints,
	type ArtifactRegistry,
} from "./artifact.ts";
import { applyPatch, isJsonValue, isObject, pruneEmptyObjects, type JsonObject } from "./json.ts";
import { projectPlaneContext, SEMANTIC_PLANES } from "./planes.ts";
import { validateModuleObject, validateRetainedModules, type RetainedModules } from "./semantic-module.ts";

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
export function assertScopeStateValues(states: ScopeStateValues, owners: readonly StateScope[]): void {
	if (!isObject(states) || Object.keys(states).length !== owners.length
		|| Object.keys(states).some((scope) => !owners.includes(scope as StateScope))
		|| owners.some((scope) => !Object.hasOwn(states, scope))) throw new Error("Selected State Flow values must match their owners exactly");
	for (const scope of owners) if (!isJsonValue(states[scope]) || !isSemanticState(states[scope])) throw new Error(`Invalid selected State Flow ${scope} value`);
}

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
export function assertNoRetiredSemanticPlanes(value: JsonObject): void {
	for (const plane of ["contract", "working"]) {
		if (Object.hasOwn(value, plane)) throw new Error(`Retired State Flow semantic plane: ${plane}`);
	}
}

export function emptyState(): MaterializedState {
	return { intents: {}, strategy: {}, tactics: {}, artifacts: {}, response: "", lazy: {} };
}

export function isMaterializedState(value: unknown): value is MaterializedState {
	return isObject(value)
		&& !Object.hasOwn(value, "contract") && !Object.hasOwn(value, "working")
		&& isArtifactRegistry(value.artifacts)
		&& SEMANTIC_PLANES.every(({ module }) => module.validate(value[module.id]));
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
		assertNoRetiredSemanticPlanes(scope);
		return applyPatch(effective, scope) as MaterializedState;
	}, emptyState());
}

/** Default-bearing SDK compatibility view; model transport uses sparse SemanticState instead. */
export type ModelState = JsonObject & {
	intents: JsonObject;
	strategy: JsonObject;
	tactics: JsonObject;
	artifacts: ArtifactRegistry;
	response: string;
};

/** Select only owned top-level fields, preserving nested data and replay deletion markers. */
export function selectSemanticFields(value: JsonObject, modules?: RetainedModules): JsonObject {
	assertNoRetiredSemanticPlanes(value);
	if (modules !== undefined) validateExternalPlanes(value, modules, true);
	return structuredClone(Object.fromEntries([...Object.keys(emptyState()), ...Object.keys(modules ?? {})]
		.filter((key) => Object.hasOwn(value, key))
		.map((key) => [key, value[key]])));
}

/** v4 admits only declared object planes; null is a replay deletion, never stored content. */
export function validateExternalPlanes(value: JsonObject, modules: RetainedModules, patch = false): void {
	validateRetainedModules(modules);
	const core = emptyState();
	for (const [key, field] of Object.entries(value)) {
		if (Object.hasOwn(core, key)) continue;
		if (!Object.hasOwn(modules, key) || !(patch && field === null || isObject(field))) {
			throw new Error(`Undeclared or invalid State Flow external plane: ${key}`);
		}
		if (field !== null) validateModuleObject(field);
	}
}

/** Normalize only core planes: opaque external bodies are not empty-branch policy subjects. */
export function pruneSemanticState(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
		if (key.startsWith("x_")) return [[key, field]];
		const pruned = pruneEmptyObjects({ [key]: field });
		return Object.entries(pruned);
	}));
}

/** Read only documented, present planes; empty responses carry no semantic value. */
export function projectSemanticState(state: JsonObject, modules?: RetainedModules): SemanticState {
	const projected = selectSemanticFields(state, modules);
	if (projected.response === "") delete projected.response;
	return projected;
}

/** Preserve deletion meaning in visible history without exposing ignored fields or empty responses. */
export function projectSemanticPatch(patch: JsonObject, modules?: RetainedModules): JsonObject {
	const projected = selectSemanticFields(patch, modules);
	if (projected.response === "") projected.response = null;
	return projected;
}

/** Explicit hot reads filter hidden bodies/bookkeeping without normalizing legacy semantic data. */
export function projectStateForRead(state: SemanticState, artifactHints: ArtifactModelHints = {}, modules?: RetainedModules): SemanticState {
	const { lazy: _hidden, ...visible } = state;
	const selected = projectSemanticState(visible, modules);
	const core = projectPlaneContext(selected, artifactHints).state;
	return { ...core, ...Object.fromEntries(Object.keys(modules ?? {}).filter(id => Object.hasOwn(selected, id)).map(id => [id, structuredClone(selected[id])])) } as SemanticState;
}

/** Ordinary model context omits empty object fields; exact reads and replay remain observational. */
export function projectStateForModel(state: SemanticState, artifactHints: ArtifactModelHints = {}): SemanticState {
	return pruneEmptyObjects(projectStateForRead(state, artifactHints));
}
