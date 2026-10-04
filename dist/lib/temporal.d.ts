import { type RecentScopePatch } from "./history.ts";
import { type MaterializedState, type SemanticState, type ScopedSemanticStates, type StateScope } from "./state.ts";
/** Owns hot temporal algebra; excludes filesystem, Git, identity allocation, and Pi lifecycle. */
export interface TransitionBoundary {
    id: string;
    /** Branch-local order only. Identity and parent links distinguish forks at equal positions. */
    position: number;
    parent: string | null;
}
export interface ScopeCheckpoint {
    through: TransitionBoundary;
    state: SemanticState;
}
export interface TemporalPatch {
    transition: TransitionBoundary;
    patch: RecentScopePatch["patch"];
}
export interface ScopeStream {
    /** Monotonic semantic revision owned by this scope; independent of branch-local boundary positions. */
    revision: number;
    checkpoint: ScopeCheckpoint;
    patches: TemporalPatch[];
}
export interface TemporalState {
    /** Oldest to newest, including the boundary immediately before the retained transitions. */
    lineage: TransitionBoundary[];
    scopes: Record<StateScope, ScopeStream>;
}
export type ScopeRevisions = Record<StateScope, number>;
/** Replay validation is shared by disk codecs and active-lineage materialization. */
export declare function validateScopeStream(value: unknown, scope: StateScope, historyLimit?: number): asserts value is ScopeStream;
export declare function validateTemporalLineage(value: unknown, historyLimit?: number): asserts value is TransitionBoundary[];
/** Bind one owned stream to its runtime lineage without requiring patches from unrelated scopes. */
export declare function validateScopeLineage(stream: ScopeStream, scope: StateScope, lineage: readonly TransitionBoundary[], historyLimit?: number): void;
/** Validate one revision-selected cohort. Its older ancestry must be bound by the durable loader. */
export declare function validateTemporalState(view: TemporalState, historyLimit?: number): void;
/** Adopt revision-proven inherited streams without rewriting their checkpoints or tails. */
export declare function adoptTemporalStreams(scopes: Record<StateScope, ScopeStream>, id: string, historyLimit?: number): TemporalState;
/** New or migrated state starts at a proven current boundary, with no invented past. */
export declare function createTemporalState(states: ScopedSemanticStates, id: string, historyLimit?: number): TemporalState;
/** Fold retained tails to a lower configured limit without inventing history. */
export declare function constrainTemporalState(view: TemporalState, historyLimit: number): TemporalState;
/** Current independent scope revisions; Effective uses this vector rather than inventing a scalar owner. */
export declare function temporalScopeRevisions(view: TemporalState): ScopeRevisions;
/** Exact scope semantics for authored staging; defaults must never become implicit writes. */
export declare function readTemporalScopes(view: TemporalState, offset?: number, historyLimit?: number): ScopedSemanticStates;
/** Sparse current/historical view: unknown planes and absent values never become effective data. */
export declare function readTemporalView(view: TemporalState, offset?: number, scope?: StateScope, historyLimit?: number): SemanticState;
/** Internal defaulted materialization for consumers that require object registries. */
export declare function readTemporalState(view: TemporalState, offset?: number, scope?: StateScope, historyLimit?: number): MaterializedState;
/** Allocate the identity outside this algebra; only materially effective patches accept it. */
export declare function advanceTemporalState(view: TemporalState, transitions: readonly RecentScopePatch[], id: string, historyLimit?: number): TemporalState;
