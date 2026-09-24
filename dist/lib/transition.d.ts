import { type ArtifactProvenance } from "./artifact.ts";
import type { SuccessfulArtifactRead } from "./acquisition.ts";
import { type AcceptedTransition } from "./history.ts";
import { type SuccessfulSkillRead } from "./skills.ts";
import type { Snapshot } from "./snapshot.ts";
import type { AtomicScopePatches, ScopedStates, StateScope, TerminalTransition } from "./state.ts";
export interface StagedScopedTransition {
    nextStates: ScopedStates;
    stateHashes: Record<StateScope, string>;
    /** Fresh runtime-owned provenance for artifacts compiled in this transition. */
    provenanceUpdates: Record<StateScope, Record<string, ArtifactProvenance>>;
    causalBasis: string;
    committed: boolean;
}
/** Stage one canonical atomic scope cohort without changing the finalized response. */
export declare function stageAtomicScopePatches(currentStates: ScopedStates, patches: AtomicScopePatches, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
export declare function stageScopedTransition(currentStates: ScopedStates, transition: TerminalTransition, successfulSkillReads: Iterable<SuccessfulSkillRead>, causalBasis: string, successfulArtifactReads?: Iterable<SuccessfulArtifactRead>): StagedScopedTransition;
/** Commit one accepted transition; durable publication receives all changed scopes as one cohort. */
export interface CommitScopedTransitionOptions {
    /** Runtime response reconciliation finalizes bootstrap lifecycle state. */
    finalizeRun?: boolean;
}
export declare function commitScopedTransition(snapshot: Snapshot, states: ScopedStates, stage: StagedScopedTransition, publishDurable: (accepted: AcceptedTransition | undefined, nextSnapshot: Snapshot) => void, causalBasis: string, options?: CommitScopedTransitionOptions): boolean;
