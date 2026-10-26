import {
	compileArtifact,
	ORDINARY_ARTIFACT_COMPILER,
	validateArtifactMetadata,
	validateArtifactRegistry,
	validateModelArtifactPatch,
	type ArtifactCompilerOutput,
	type ArtifactProvenance,
} from "./artifact.ts";
import type { SuccessfulArtifactRead } from "./acquisition.ts";
import { createAcceptedTransition, type AcceptedTransition } from "./history.ts";
import { applyOwnedPatch, containsNull, hashJson, isObject, sameJson, validatePatch, type JsonObject, type MissingDeletion } from "./json.ts";
import { cascadeDeletionPatch, computeIntentCascade, type OwnedPath } from "./ownership.ts";
import { hasCompiledSkillArtifact, SKILL_ARTIFACT_COMPILER, type SuccessfulSkillRead } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import { assertScopeStateValues, emptyState, pruneSemanticState } from "./state.ts";
import { captureScopeSelection, type ScopeSelection } from "./selection.ts";
import { MODEL_PLANE_NAMES } from "./planes.ts";
import { validateModuleObject, type RetainedModules, type StateFlowModule } from "./semantic-module.ts";
import type { JsonValue } from "./json.ts";
import type {
	AtomicScopePatches,
	SemanticState,
	ScopePatch,
	ScopedPatch,
	ScopedSemanticStates,
	ScopeStateValues,
	SemanticTransition,
	StateDocument,
	StatePatch,
	StateScope,
	TerminalTransition,
} from "./state.ts";

interface StagedTransition<States extends ScopeStateValues> {
	nextStates: States;
	/** Authored no-op deletions; presentation evidence only, never replay input. */
	missingDeletions: MissingDeletion[];
	/** Scope-local targets cleared before other writes; may be recreated, never replay input. */
	cascades: { [Owner in keyof States]: OwnedPath[] };
	stateHashes: { [Owner in keyof States]: string };
	/** Fresh runtime-owned provenance for artifacts compiled in this transition. */
	provenanceUpdates: { [Owner in keyof States]: Record<string, ArtifactProvenance> };
	causalBasis: string;
	committed: boolean;
	moduleAdditions?: Partial<Record<StateScope, RetainedModules>>;
}

export type StagedScopedTransition = StagedTransition<ScopedSemanticStates> & { selection?: never };
export type StagedSelectedTransition = StagedTransition<ScopeStateValues> & { selection: ScopeSelection };

/** Internal host proposals only; never accepted from model tool arguments. */
export interface ModuleReplacement {
	scope: StateScope;
	id: string;
	content: JsonObject;
}

export interface SelectedSemanticBasis {
	selection: ScopeSelection;
	states: ScopeStateValues;
	modules?: Partial<Record<StateScope, RetainedModules>>;
}

function selectedOwners(basis: SelectedSemanticBasis): ScopeSelection {
	const selection = captureScopeSelection(basis.selection);
	assertScopeStateValues(basis.states, selection);
	return selection;
}

const SCOPES = new Set<StateScope>(["global", "cwd", "session"]);
const PATCH_KEYS = new Set(MODEL_PLANE_NAMES);

function compileReadArtifacts(
	nextState: StateDocument,
	patch: Pick<StatePatch, "artifacts">,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead>,
	provenance: Record<string, ArtifactProvenance>,
): void {
	for (const read of successfulArtifactReads) {
		const output = patch.artifacts[read.path];
		if (!isObject(output)) {
			throw new Error(`Successfully read invalidated artifact requires compiler output at ${read.scope ?? "global"}.artifacts[${JSON.stringify(read.path)}]`);
		}
		const compiled = compileArtifact({
			source: { path: read.path, scope: read.scope, hash: read.hash, sourceFingerprint: read.sourceFingerprint },
			compiler: ORDINARY_ARTIFACT_COMPILER,
			output: output as ArtifactCompilerOutput,
		});
		validateArtifactMetadata(compiled.semantic, read.path);
		Object.defineProperty(nextState.artifacts, read.path, {
			value: compiled.semantic,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		provenance[read.path] = compiled.provenance;
	}
}

function validateSkillCompilerOutput(scope: StateScope, path: string, output: unknown): asserts output is JsonObject {
	const problems: string[] = [];
	if (!isObject(output)) problems.push("artifact entry is missing");
	else {
		if (typeof output.description !== "string" || output.description.trim().length === 0) problems.push("description must be non-empty");
		if (output.kind !== "skill") problems.push('kind must be "skill"');
		if (!isObject(output.compilation) || Object.keys(output.compilation).length === 0) problems.push("compilation object must be non-empty");
	}
	if (problems.length === 0) return;
	const target = `${scope}.artifacts[${JSON.stringify(path)}]`;
	throw new Error(`Invalid Skill at ${target}: ${problems.join("; ")}`);
}

function validateSkillCompilerTargets(
	patches: ReadonlyMap<StateScope, ScopePatch>,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	owners: readonly StateScope[],
): void {
	for (const read of successfulSkillReads) {
		for (const scope of owners) {
			if (scope === read.scope) continue;
			const artifacts = patches.get(scope)?.artifacts;
			if (artifacts && Object.hasOwn(artifacts, read.path) && artifacts[read.path] !== null) {
				throw new Error(`Registered Skill compiler output for ${read.path} belongs at ${read.scope}.artifacts[${JSON.stringify(read.path)}], not ${scope}.artifacts`);
			}
		}
	}
}

function compileReadSkills(
	scope: StateScope,
	nextState: StateDocument,
	patch: Pick<StatePatch, "artifacts">,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	provenance: Record<string, ArtifactProvenance>,
): void {
	for (const read of successfulSkillReads) {
		if (!Object.hasOwn(patch.artifacts, read.path)) continue;
		if (read.hash === undefined) {
			throw new Error(`Could not capture the source hash for successfully read Skill ${read.path}: ${read.error ?? "unknown error"}`);
		}
		const output = patch.artifacts[read.path];
		validateSkillCompilerOutput(scope, read.path, output);
		const compiled = compileArtifact({
			source: { path: read.path, scope, hash: read.hash },
			compiler: SKILL_ARTIFACT_COMPILER,
			output: { ...structuredClone(output), kind: "skill" } as ArtifactCompilerOutput,
		});
		validateArtifactMetadata(compiled.semantic, read.path);
		Object.defineProperty(nextState.artifacts, read.path, {
			value: compiled.semantic,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		provenance[read.path] = compiled.provenance;
		if (!hasCompiledSkillArtifact(nextState.artifacts, provenance[read.path], read.path, read.hash)) {
			throw new Error(`Skill artifact compilation at ${read.path} is not locally materialized for its executed source identity`);
		}
	}
}

function validateMaterializedTransition(nextState: StateDocument, scope: StateScope): void {
	if (Object.keys(emptyState()).some((key) => containsNull(nextState[key]))) {
		throw new Error("Materialized state cannot contain null; use null only as an object-key deletion marker");
	}
	validateArtifactRegistry(nextState.artifacts, `${scope}.artifacts`);
	if (Object.hasOwn(nextState.strategy, "compiled_skills")) {
		throw new Error("strategy.compiled_skills is retired; Skill compilations belong only in source-addressed artifacts");
	}
}

function validateScopePatch(scope: unknown, patch: unknown, definitions: readonly StateFlowModule<JsonObject, JsonValue>[] = [], retained?: RetainedModules): asserts patch is ScopePatch {
	if (typeof scope !== "string" || !SCOPES.has(scope as StateScope)) {
		throw new Error(`Unknown State Flow transition scope: ${String(scope)}`);
	}
	validatePatch(patch);
	for (const key of Object.keys(patch)) {
		if (!PATCH_KEYS.has(key)) {
			const definition = definitions.find(module => module.id === key);
			if (!definition) throw new Error(`Unknown State Flow patch key ${JSON.stringify(key)}; expected one of: ${[...PATCH_KEYS].join(", ")}`);
			if (definition.immutable) throw new Error(`Immutable State Flow patch key ${JSON.stringify(key)}`);
			const descriptor = retained?.[key];
			if (descriptor && (descriptor.schemaVersion !== definition.schemaVersion || descriptor.immutable !== definition.immutable)) {
				throw new Error(`Unavailable State Flow module descriptor: ${key}`);
			}
			if (!isObject(patch[key])) throw new Error(`Scoped State Flow patch field ${key} must be a JSON object`);
		}
	}
	for (const key of ["artifacts", "strategy", "tactics", "intents"] as const) {
		if (Object.hasOwn(patch, key) && !isObject(patch[key])) {
			throw new Error(`Scoped State Flow patch field ${key} must be a JSON object`);
		}
	}
	if (Object.hasOwn(patch, "lazy") && !isObject(patch.lazy)) {
		throw new Error("Scoped State Flow patch field lazy must be a JSON object");
	}
	if (isObject(patch.artifacts)) validateModelArtifactPatch(patch.artifacts, `${scope}.artifacts`);
}

/** Stage all scope updates against one immutable basis before any state is published. */
function stageScopedSemanticTransition(
	currentStates: ScopeStateValues,
	transition: SemanticTransition,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead>,
	acceptedResponse?: string,
	owners: readonly StateScope[] = [...SCOPES],
	definitions: readonly StateFlowModule<JsonObject, JsonValue>[] = [],
	modules: Partial<Record<StateScope, RetainedModules>> = {},
	replacements: readonly ModuleReplacement[] = [],
): StagedTransition<ScopeStateValues> {
	if (!Array.isArray(transition.transitions)) throw new Error("State Flow transitions must be an array");
	const patches = new Map<StateScope, ScopePatch>();
	for (const item of transition.transitions) {
		if (!isObject(item)) throw new Error("Every State Flow transition must be an object");
		const keys = Object.keys(item).sort();
		if (keys.length !== 2 || keys[0] !== "patch" || keys[1] !== "scope") {
			throw new Error('Every State Flow transition must contain exactly "scope" and "patch"');
		}
		const scope = item.scope as StateScope;
		if (SCOPES.has(scope) && !owners.includes(scope)) throw new Error(`State Flow ${scope} scope is excluded`);
		validateScopePatch(scope, item.patch, definitions, modules[scope]);
		if (patches.has(scope)) throw new Error(`Duplicate State Flow transition scope: ${scope}`);
		patches.set(scope, item.patch);
	}

	const produced = new Map<StateScope, Map<string, JsonObject>>();
	for (const item of replacements) {
		if (!isObject(item) || !owners.includes(item.scope as StateScope)) throw new Error("State Flow module replacement owner is excluded");
		if (Object.keys(item).sort().join(",") !== "content,id,scope" || typeof item.id !== "string" || !/^x_[a-z][a-z0-9_]*$/.test(item.id)) throw new Error("Invalid State Flow module replacement");
		const scope = item.scope as StateScope, definition = definitions.find(module => module.id === item.id), descriptor = modules[scope]?.[item.id];
		if (!definition || descriptor && (descriptor.schemaVersion !== definition.schemaVersion || descriptor.immutable !== definition.immutable)) throw new Error(`Unavailable State Flow module replacement: ${item.id}`);
		if (patches.get(scope) && Object.hasOwn(patches.get(scope)!, item.id)) throw new Error("Model patches and producer replacements cannot conflict");
		const content = item.content;
		validateModuleObject(content);
		if (containsNull(content)) throw new Error("State Flow module replacements cannot contain stored null");
		const scoped = produced.get(scope) ?? new Map<string, JsonObject>();
		if (scoped.has(item.id)) throw new Error("Duplicate State Flow module replacement");
		scoped.set(item.id, structuredClone(content)); produced.set(scope, scoped);
	}

	const artifactReads = [...successfulArtifactReads];
	const skillReads = [...successfulSkillReads];
	validateSkillCompilerTargets(patches, skillReads, owners);
	const nextStates = { ...currentStates };
	const provenanceUpdates = Object.fromEntries(owners.map((scope) => [scope, {}])) as Partial<Record<StateScope, Record<string, ArtifactProvenance>>>;
	const cascades = Object.fromEntries(owners.map((scope) => [scope, []])) as Partial<Record<StateScope, OwnedPath[]>>;
	const missingDeletions: MissingDeletion[] = [];
	const moduleAdditions: Partial<Record<StateScope, RetainedModules>> = {};
	for (const scope of owners) {
		const currentState = currentStates[scope]!;
		const authored = patches.get(scope) ?? {};
		const patch = { ...authored, ...(scope === "session" && acceptedResponse !== undefined ? { response: acceptedResponse } : {}) };
		const scopedMissing: MissingDeletion[] = [];
		const normalize = patches.has(scope) || scope === "session" && acceptedResponse !== undefined;
		const { intents, ...other } = patch;
		const intentState = applyOwnedPatch(structuredClone(currentState), intents === undefined ? {} : { intents }, scopedMissing);
		// Intent ownership ends before other writes, independent of JSON key order.
		const cascade = cascades[scope] = computeIntentCascade(scope, currentState, normalize ? pruneSemanticState(intentState) : intentState);
		const cleared = cascade.length > 0 ? applyOwnedPatch(intentState, cascadeDeletionPatch(cascade)) : intentState;
		const applied = applyOwnedPatch(cleared, other, scopedMissing);
		for (const [id, content] of produced.get(scope) ?? []) {
			if (Object.keys(content).length === 0) delete applied[id];
			else Object.defineProperty(applied, id, { value: content, enumerable: true, configurable: true, writable: true });
		}
		const patched = normalize ? pruneSemanticState(applied) : applied;
		missingDeletions.push(...scopedMissing.map(({ path, unavailablePath }) => ({
			path: `/${scope}${path}`, unavailablePath: `/${scope}${unavailablePath}`,
		})));
		let materialized = { ...emptyState(), ...patched } as StateDocument;

		compileReadArtifacts(
			materialized,
			{ artifacts: authored.artifacts ?? {} },
			artifactReads.filter((read) => (read.scope ?? "global") === scope),
			provenanceUpdates[scope]!,
		);
		compileReadSkills(scope, materialized, { artifacts: authored.artifacts ?? {} }, skillReads.filter((read) => read.scope === scope), provenanceUpdates[scope]!);
		const nextState: SemanticState = materialized;
		for (const key of Object.keys(emptyState())) {
			if (!Object.hasOwn(patched, key)
				&& !(key === "artifacts" && Object.keys(provenanceUpdates[scope]!).length > 0)) delete nextState[key];
		}
		const normalized = normalize ? pruneSemanticState(nextState) : nextState;
		for (const id of new Set([...Object.keys(authored).filter(key => !PATCH_KEYS.has(key)), ...(produced.get(scope)?.keys() ?? [])])) {
			const definition = definitions.find(module => module.id === id)!;
			const content = normalized[id];
			if (content === undefined && produced.get(scope)?.has(id)) continue;
			validateModuleObject(content);
			if (containsNull(content)) throw new Error("State Flow external content cannot contain stored null");
			if (Object.keys(content).length === 0) delete normalized[id];
			else {
				if (definition.validate(structuredClone(content)) !== true) throw new Error(`Invalid State Flow module content: ${id}`);
				if (!Object.hasOwn(modules[scope] ?? {}, id)) (moduleAdditions[scope] ??= {})[id] = { schemaVersion: definition.schemaVersion, immutable: definition.immutable };
			}
		}
		validateMaterializedTransition({ ...emptyState(), ...normalized }, scope);
		nextStates[scope] = normalized;
	}
	return {
		nextStates,
		missingDeletions,
		cascades,
		provenanceUpdates,
		stateHashes: Object.fromEntries(owners.map((scope) => [scope, hashJson(currentStates[scope]!)])),
		causalBasis,
		committed: false,
		...(Object.keys(moduleAdditions).length ? { moduleAdditions } : {}),
	};
}

/** Stage one canonical atomic scope cohort without changing the finalized response. */
export function stageAtomicScopePatches(
	currentStates: ScopedSemanticStates,
	patches: AtomicScopePatches,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): StagedScopedTransition {
	return stageScopedSemanticTransition(
		currentStates,
		atomicScopeTransitions(patches),
		successfulSkillReads,
		causalBasis,
		successfulArtifactReads,
	) as StagedScopedTransition;
}

export function stageScopedTransition(
	currentStates: ScopedSemanticStates,
	transition: TerminalTransition,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): StagedScopedTransition {
	if (typeof transition.response !== "string") {
		throw new Error("Accepted State Flow response body must be a string");
	}
	return stageScopedSemanticTransition(
		currentStates,
		transition,
		successfulSkillReads,
		causalBasis,
		successfulArtifactReads,
		transition.response,
	) as StagedScopedTransition;
}

function atomicScopeTransitions(patches: AtomicScopePatches, owners: readonly StateScope[] = [...SCOPES]): SemanticTransition {
	if (!isObject(patches)) throw new Error("Atomic State Flow scope patches must be an object");
	for (const key of Object.keys(patches)) {
		if (!SCOPES.has(key as StateScope)) throw new Error(`Unknown atomic State Flow scope: ${key}`);
		if (!owners.includes(key as StateScope)) throw new Error(`State Flow ${key} scope is excluded`);
	}
	const transitions: ScopedPatch[] = [];
	for (const scope of owners) if (Object.hasOwn(patches, scope)) transitions.push({ scope, patch: patches[scope] as ScopePatch });
	return { transitions };
}

/** Value-only selected staging; a selection or causal token is not physical publication authority. */
export function stageSelectedScopePatches(
	current: SelectedSemanticBasis,
	patches: AtomicScopePatches,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
	definitions: readonly StateFlowModule<JsonObject, JsonValue>[] = [],
	replacements: readonly ModuleReplacement[] = [],
): StagedSelectedTransition {
	const selection = selectedOwners(current);
	return { ...stageScopedSemanticTransition(current.states, atomicScopeTransitions(patches, selection), successfulSkillReads,
		causalBasis, successfulArtifactReads, undefined, selection, definitions, current.modules, replacements), selection };
}

/** Excluded Session suppresses capture, not ordinary-answer delivery or lifecycle completion. */
export function stageSelectedScopedTransition(
	current: SelectedSemanticBasis,
	transition: TerminalTransition,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): StagedSelectedTransition {
	const selection = selectedOwners(current);
	if (typeof transition.response !== "string") throw new Error("Accepted State Flow response body must be a string");
	return { ...stageScopedSemanticTransition(current.states, transition, successfulSkillReads, causalBasis, successfulArtifactReads,
		selection.includes("session") ? transition.response : undefined, selection), selection };
}

/** Commit one accepted transition; durable publication receives all changed scopes as one cohort. */
export interface CommitScopedTransitionOptions {
	/** Runtime response reconciliation finalizes bootstrap lifecycle state. */
	finalizeRun?: boolean;
}

export function commitScopedTransition(
	snapshot: Snapshot,
	states: ScopedSemanticStates,
	stage: StagedScopedTransition,
	publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void,
	causalBasis: string,
	options: CommitScopedTransitionOptions = {},
): boolean {
	if (Object.hasOwn(stage, "selection")) throw new Error("Selected State Flow stages require selected-cohort commit");
	return commitSemanticTransition(snapshot, states, stage, publishDurable, causalBasis, options, [...SCOPES]);
}

export function commitSelectedTransition(
	snapshot: Snapshot,
	current: SelectedSemanticBasis,
	stage: StagedSelectedTransition,
	publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void,
	causalBasis: string,
	options: CommitScopedTransitionOptions = {},
): boolean {
	if (stage.committed) return false;
	const selection = selectedOwners(current);
	if (!sameJson(selection, stage.selection)) throw new Error("State Flow selection changed before reconciliation");
	selectedOwners({ selection, states: stage.nextStates });
	return commitSemanticTransition(snapshot, current.states, stage, publishDurable, causalBasis, options, selection);
}

function commitSemanticTransition(
	snapshot: Snapshot,
	states: ScopeStateValues,
	stage: StagedTransition<ScopeStateValues>,
	publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void,
	causalBasis: string,
	options: CommitScopedTransitionOptions,
	owners: readonly StateScope[],
): boolean {
	if (stage.committed) return false;
	if (causalBasis !== stage.causalBasis) throw new Error("State Flow causal basis changed before response reconciliation; rematerialize state before retrying");
	for (const scope of owners) {
		if (hashJson(states[scope]!) !== stage.stateHashes[scope]) {
			throw new Error(`State Flow ${scope} scope changed before response reconciliation; rematerialize state before retrying`);
		}
	}
	// The finalized response may differ from message_end after chained handlers.
	// Derive replay input only here, from the complete accepted semantic result.
	const accepted = createAcceptedTransition(states, stage.nextStates);
	if (accepted !== undefined && snapshot.meta.step >= Number.MAX_SAFE_INTEGER) {
		throw new Error("State Flow iteration counter is exhausted; start a fresh episode");
	}
	const nextSnapshot = structuredClone(snapshot);
	if (accepted !== undefined) nextSnapshot.meta.step += 1;
	if (options.finalizeRun !== false) {
		nextSnapshot.meta.validation = undefined;
		nextSnapshot.meta.bootstrap = false;
	}
	publishDurable(accepted, nextSnapshot);
	for (const scope of owners) states[scope] = structuredClone(stage.nextStates[scope]!);
	if (accepted !== undefined) snapshot.meta.step += 1;
	if (options.finalizeRun !== false) {
		snapshot.meta.validation = undefined;
		snapshot.meta.bootstrap = false;
	}
	stage.committed = true;
	return true;
}
