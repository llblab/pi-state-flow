import {
	compileArtifact,
	ORDINARY_ARTIFACT_COMPILER,
	validateArtifactMetadata,
	validateArtifactRegistry,
	type ArtifactCompilerOutput,
	type ArtifactProvenance,
} from "./artifact.ts";
import type { SuccessfulArtifactRead } from "./acquisition.ts";
import { createAcceptedTransition, type AcceptedTransition } from "./history.ts";
import { applyPatch, containsNull, hashJson, isObject, validatePatch } from "./json.ts";
import { hasCompiledSkillArtifact, SKILL_ARTIFACT_COMPILER, type SuccessfulSkillRead } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import type {
	MaterializedState,
	ScopePatch,
	ScopedPatch,
	ScopedStates,
	SemanticTransition,
	StateDocument,
	StatePatch,
	StateScope,
	TerminalTransition,
} from "./state.ts";

export interface StagedScopedTransition {
	nextStates: ScopedStates;
	stateHashes: Record<StateScope, string>;
	/** Fresh runtime-owned provenance for artifacts compiled in this transition. */
	provenanceUpdates: Record<StateScope, Record<string, ArtifactProvenance>>;
	causalBasis: string;
	committed: boolean;
}

const SCOPES = new Set<StateScope>(["global", "cwd", "session"]);
const PATCH_KEYS = new Set(["artifacts", "contract", "working"]);

function compileReadArtifacts(
	nextState: StateDocument,
	patch: Pick<StatePatch, "artifacts">,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead>,
	provenance: Record<string, ArtifactProvenance>,
): void {
	for (const read of successfulArtifactReads) {
		const output = patch.artifacts[read.path];
		if (!isObject(output)) {
			throw new Error(`Every successfully read invalidated artifact must have a global compiler output at artifacts[exact candidate path]; missing: ${read.path}`);
		}
		const compiled = compileArtifact({
			source: { path: read.path, hash: read.hash },
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

function compileReadSkills(
	nextState: StateDocument,
	patch: Pick<StatePatch, "artifacts">,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	provenance: Record<string, ArtifactProvenance>,
): void {
	for (const read of successfulSkillReads) {
		if (read.hash === undefined) {
			throw new Error(`Could not capture the source hash for successfully read Skill ${read.path}: ${read.error ?? "unknown error"}`);
		}
		const output = patch.artifacts[read.path];
		if (!isObject(output)) {
			throw new Error(`Every successfully read Skill must have a CWD artifact compiler output at artifacts[exactReadPath]; missing: ${read.path}`);
		}
		if (Object.hasOwn(output, "hash") || Object.hasOwn(output, "compiler")) {
			throw new Error(`Skill artifact compiler output at ${read.path} cannot set runtime-owned hash or compiler fields`);
		}
		if (typeof output.description !== "string" || output.description.trim().length === 0) {
			throw new Error(`Skill artifact compiler output at ${read.path} must have a non-empty description`);
		}
		if (Object.hasOwn(output, "kind") && output.kind !== "skill") {
			throw new Error(`Skill artifact compiler output at ${read.path} kind must be "skill"`);
		}
		if (!isObject(output.compilation) || Object.keys(output.compilation).length === 0) {
			throw new Error(`Skill artifact compiler output at ${read.path} must have a non-empty compilation object`);
		}
		const compiled = compileArtifact({
			source: { path: read.path, hash: read.hash },
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

function validateMaterializedTransition(nextState: StateDocument): void {
	if (containsNull(nextState)) {
		throw new Error("Materialized state cannot contain null; use null only as an object-key deletion marker");
	}
	validateArtifactRegistry(nextState.artifacts);
	if (Object.hasOwn(nextState.contract, "compiled_skills")) {
		throw new Error("contract.compiled_skills is retired; Skill compilations belong only in source-addressed artifacts");
	}
}

function validateScopePatch(scope: unknown, patch: unknown): asserts patch is ScopePatch {
	if (typeof scope !== "string" || !SCOPES.has(scope as StateScope)) {
		throw new Error(`Unknown State Flow transition scope: ${String(scope)}`);
	}
	validatePatch(patch);
	for (const key of Object.keys(patch)) {
		if (!PATCH_KEYS.has(key)) {
			throw new Error(`Scoped State Flow patches cannot modify ${key}; only artifacts, contract, and working are model-owned`);
		}
	}
	for (const key of PATCH_KEYS) {
		if (Object.hasOwn(patch, key) && !isObject(patch[key])) {
			throw new Error(`Scoped State Flow patch field ${key} must be a JSON object`);
		}
	}
}

function completePatch(patch: ScopePatch, response: string): StatePatch {
	return {
		artifacts: patch.artifacts ?? {},
		contract: patch.contract ?? {},
		working: patch.working ?? {},
		response,
	};
}

/** Stage all scope updates against one immutable basis before any state is published. */
function stageScopedSemanticTransition(
	currentStates: ScopedStates,
	transition: SemanticTransition,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead>,
	acceptedResponse?: string,
): StagedScopedTransition {
	if (!Array.isArray(transition.transitions)) throw new Error("State Flow transitions must be an array");
	const patches = new Map<StateScope, ScopePatch>();
	for (const item of transition.transitions) {
		if (!isObject(item)) throw new Error("Every State Flow transition must be an object");
		const keys = Object.keys(item).sort();
		if (keys.length !== 2 || keys[0] !== "patch" || keys[1] !== "scope") {
			throw new Error('Every State Flow transition must contain exactly "scope" and "patch"');
		}
		validateScopePatch(item.scope, item.patch);
		const scope = item.scope as StateScope;
		if (patches.has(scope)) throw new Error(`Duplicate State Flow transition scope: ${scope}`);
		patches.set(scope, item.patch);
	}

	const cwdPatch = patches.get("cwd") ?? {};
	const nextStates = structuredClone(currentStates);
	const provenanceUpdates: Record<StateScope, Record<string, ArtifactProvenance>> = { global: {}, cwd: {}, session: {} };
	for (const scope of SCOPES) {
		const authored = patches.get(scope) ?? {};
		const response = scope === "session" && acceptedResponse !== undefined
			? acceptedResponse
			: currentStates[scope].response;
		const patch = completePatch(authored, response);
		const nextState = applyPatch(structuredClone(currentStates[scope]), patch) as MaterializedState;
		compileReadArtifacts(nextState, { artifacts: scope === "global" ? authored.artifacts ?? {} : {} }, scope === "global" ? successfulArtifactReads : [], provenanceUpdates.global);
		compileReadSkills(nextState, { artifacts: scope === "cwd" ? cwdPatch.artifacts ?? {} : {} }, scope === "cwd" ? successfulSkillReads : [], provenanceUpdates.cwd);
		validateMaterializedTransition(nextState);
		nextStates[scope] = nextState;
	}
	return {
		nextStates,
		provenanceUpdates,
		stateHashes: {
			global: hashJson(currentStates.global),
			cwd: hashJson(currentStates.cwd),
			session: hashJson(currentStates.session),
		},
		causalBasis,
		committed: false,
	};
}

/** Validate that explicit unchanged resolution has no pending acquisition/compilation obligation. */
export function validateUnchangedResolution(
	currentStates: ScopedStates,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): void {
	stageScopedSemanticTransition(
		currentStates,
		{ transitions: [] },
		successfulSkillReads,
		causalBasis,
		successfulArtifactReads,
	);
}

/** Stage one intermediate state barrier without changing the finalized response. */
export function stageScopedPatch(
	currentStates: ScopedStates,
	transition: ScopedPatch,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): StagedScopedTransition {
	return stageScopedSemanticTransition(
		currentStates,
		{ transitions: [transition] },
		successfulSkillReads,
		causalBasis,
		successfulArtifactReads,
	);
}

export function stageScopedTransition(
	currentStates: ScopedStates,
	transition: TerminalTransition,
	successfulSkillReads: Iterable<SuccessfulSkillRead>,
	causalBasis: string,
	successfulArtifactReads: Iterable<SuccessfulArtifactRead> = [],
): StagedScopedTransition {
	if (typeof transition.response !== "string" || transition.response.trim().length === 0) {
		throw new Error("Accepted State Flow response body must be non-empty");
	}
	return stageScopedSemanticTransition(
		currentStates,
		transition,
		successfulSkillReads,
		causalBasis,
		successfulArtifactReads,
		transition.response,
	);
}

/** Commit one accepted transition; durable publication receives all changed scopes as one cohort. */
export interface CommitScopedTransitionOptions {
	/** Runtime response reconciliation finalizes bootstrap lifecycle state. */
	finalizeRun?: boolean;
}

export function commitScopedTransition(
	snapshot: Snapshot,
	states: ScopedStates,
	stage: StagedScopedTransition,
	publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void,
	causalBasis: string,
	options: CommitScopedTransitionOptions = {},
): boolean {
	if (stage.committed) return false;
	if (causalBasis !== stage.causalBasis) throw new Error("State Flow causal basis changed before response reconciliation; rematerialize state before retrying");
	for (const scope of SCOPES) {
		if (hashJson(states[scope]) !== stage.stateHashes[scope]) {
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
	states.global = structuredClone(stage.nextStates.global);
	states.cwd = structuredClone(stage.nextStates.cwd);
	states.session = structuredClone(stage.nextStates.session);
	if (accepted !== undefined) snapshot.meta.step += 1;
	if (options.finalizeRun !== false) {
		snapshot.meta.validation = undefined;
		snapshot.meta.bootstrap = false;
	}
	stage.committed = true;
	return true;
}
