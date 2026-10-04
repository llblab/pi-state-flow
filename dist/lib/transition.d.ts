import { type ArtifactProvenance } from "./artifact.ts";
import type { SuccessfulArtifactRead } from "./acquisition.ts";
import { type AcceptedTransition } from "./history.ts";
import { type MissingDeletion } from "./json.ts";
import { type OwnedPath } from "./ownership.ts";
import { type SuccessfulSkillRead } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import type { AtomicScopePatches, ScopedSemanticStates, StateScope, TerminalTransition } from "./state.ts";
export interface StagedScopedTransition {
    nextStates: ScopedSemanticStates;
    /** Authored no-op deletions; presentation evidence only, never replay input. */
    missingDeletions: MissingDeletion[];
    /** Scope-local targets removed by the staged intent cascade, not replay input. */
    cascades: Record<StateScope, OwnedPath[]>;
    stateHashes: Record<StateScope, string>;
    /** Fresh runtime-owned provenance for artifacts compiled in this transition. */
    provenanceUpdates: Record<StateScope, Record<string, ArtifactProvenance>>;
    causalBasis: string;
    committed: boolean;
}
/** Stage one canonical atomic scope cohort without changing the finalized response. */
export declare function stageAtomicScopePatches(currentStates: ScopedSemanticStates, patches: AtomicScopePatches, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
export declare function stageScopedTransition(currentStates: ScopedSemanticStates, transition: TerminalTransition, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
/** Commit one accepted transition; durable publication receives all changed scopes as one cohort. */
export interface CommitScopedTransitionOptions {
    /** Runtime response reconciliation finalizes bootstrap lifecycle state. */
    finalizeRun?: boolean;
}
export declare function commitScopedTransition(snapshot: Snapshot, states: ScopedSemanticStates, stage: StagedScopedTransition, publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void, causalBasis: string, options?: CommitScopedTransitionOptions): boolean;
