import { applyPatch, containsNull, hashJson, validatePatch } from "./json.ts";
import { hasCompiledSkill } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import type { StateDocument } from "./state.ts";

export interface StagedTransition {
	nextState: StateDocument;
	stateHash: string;
	committed: boolean;
}

export function stageTransition(
	currentState: StateDocument,
	patch: StateDocument,
	successfulSkillReads: Iterable<string>,
): StagedTransition {
	validatePatch(patch);
	const basis = structuredClone(currentState);
	const nextState = applyPatch(basis, patch) as StateDocument;
	if (containsNull(nextState)) {
		throw new Error("Materialized state cannot contain null; use null only as an object-key deletion marker");
	}
	const missingCompilations = [...successfulSkillReads]
		.filter((source) => !hasCompiledSkill(nextState.contract, source));
	if (missingCompilations.length > 0) {
		throw new Error(
			`Every successfully read Skill must have a non-empty compilation at contract.compiled_skills[exactReadPath]; missing: ${missingCompilations.join(", ")}`,
		);
	}
	return { nextState, stateHash: hashJson(basis), committed: false };
}

export function commitTransition(snapshot: Snapshot, stage: StagedTransition): boolean {
	if (stage.committed) return false;
	if (hashJson(snapshot.state) !== stage.stateHash) {
		throw new Error("State changed after response validation; regenerate the terminal response");
	}
	if (snapshot.step >= Number.MAX_SAFE_INTEGER) {
		throw new Error("State Flow iteration counter is exhausted; start a fresh episode");
	}
	snapshot.state = structuredClone(stage.nextState);
	snapshot.step += 1;
	snapshot.validation = undefined;
	snapshot.bootstrap = false;
	stage.committed = true;
	return true;
}
