import { type ArtifactProvenance } from "./artifact.ts";
import type { SuccessfulArtifactRead } from "./acquisition.ts";
import { type AcceptedTransition } from "./history.ts";
import { type JsonObject, type MissingDeletion } from "./json.ts";
import { type OwnedPath } from "./ownership.ts";
import { type SuccessfulSkillRead } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import { type ScopeSelection } from "./selection.ts";
import { type RetainedModules, type StateFlowModule } from "./semantic-module.ts";
import type { JsonValue } from "./json.ts";
import type { AtomicScopePatches, ScopedSemanticStates, ScopeStateValues, StateScope, TerminalTransition } from "./state.ts";
interface StagedTransition<States extends ScopeStateValues> {
    nextStates: States;
    /** Authored no-op deletions; presentation evidence only, never replay input. */
    missingDeletions: MissingDeletion[];
    /** Scope-local targets cleared before other writes; may be recreated, never replay input. */
    cascades: {
        [Owner in keyof States]: OwnedPath[];
    };
    stateHashes: {
        [Owner in keyof States]: string;
    };
    /** Fresh runtime-owned provenance for artifacts compiled in this transition. */
    provenanceUpdates: {
        [Owner in keyof States]: Record<string, ArtifactProvenance>;
    };
    causalBasis: string;
    committed: boolean;
    moduleAdditions?: Partial<Record<StateScope, RetainedModules>>;
}
export type StagedScopedTransition = StagedTransition<ScopedSemanticStates> & {
    selection?: never;
};
export type StagedSelectedTransition = StagedTransition<ScopeStateValues> & {
    selection: ScopeSelection;
};
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
/** Stage one canonical atomic scope cohort without changing the finalized response. */
export declare function stageAtomicScopePatches(currentStates: ScopedSemanticStates, patches: AtomicScopePatches, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
export declare function stageScopedTransition(currentStates: ScopedSemanticStates, transition: TerminalTransition, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
/** Value-only selected staging; a selection or causal token is not physical publication authority. */
export declare function stageSelectedScopePatches(current: SelectedSemanticBasis, patches: AtomicScopePatches, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>, definitions?: readonly StateFlowModule<JsonObject, JsonValue>[], replacements?: readonly ModuleReplacement[]): StagedSelectedTransition;
/** Excluded Session suppresses capture, not ordinary-answer delivery or lifecycle completion. */
export declare function stageSelectedScopedTransition(current: SelectedSemanticBasis, transition: TerminalTransition, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedSelectedTransition;
/** Commit one accepted transition; durable publication receives all changed scopes as one cohort. */
export interface CommitScopedTransitionOptions {
    /** Runtime response reconciliation finalizes bootstrap lifecycle state. */
    finalizeRun?: boolean;
}
export declare function commitScopedTransition(snapshot: Snapshot, states: ScopedSemanticStates, stage: StagedScopedTransition, publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void, causalBasis: string, options?: CommitScopedTransitionOptions): boolean;
export declare function commitSelectedTransition(snapshot: Snapshot, current: SelectedSemanticBasis, stage: StagedSelectedTransition, publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void, causalBasis: string, options?: CommitScopedTransitionOptions): boolean;
export {};
