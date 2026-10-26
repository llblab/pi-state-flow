import { type ScopeSelection } from "./selection.ts";
import { type RecentScopePatch } from "./history.ts";
import { type RetainedModules } from "./semantic-module.ts";
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
    /** Presence selects metadata4; absent preserves the legacy exact three-key stream. */
    modules?: RetainedModules;
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
/** Value-only witnesses copied from a validated cohort; not physical store/publication authority. */
export interface ExcludedTransitionWitness {
    transition: TransitionBoundary;
    owners: ScopeSelection;
}
export interface SelectedTemporalState {
    selection: ScopeSelection;
    lineage: TransitionBoundary[];
    scopes: Partial<Record<StateScope, ScopeStream>>;
    /** Only excluded-owner witnesses for retained steps with no selected semantic patch. No values or patches. */
    causalBasis: ExcludedTransitionWitness[];
}
type TemporalCohort = TemporalState | SelectedTemporalState;
export type ScopeRevisions = Record<StateScope, number>;
/** Replay validation is shared by disk codecs and active-lineage materialization. */
export declare function validateScopeStream(value: unknown, scope: StateScope, historyLimit?: number): asserts value is ScopeStream;
export declare function validateTemporalLineage(value: unknown, historyLimit?: number): asserts value is TransitionBoundary[];
/** Bind one owned stream to its runtime lineage without requiring patches from unrelated scopes. */
export declare function validateScopeLineage(stream: ScopeStream, scope: StateScope, lineage: readonly TransitionBoundary[], historyLimit?: number): void;
/** Classify live shared drift only after both stream and lineage have passed their own validators. */
export declare function scopeLineageMatches(stream: ScopeStream, scope: StateScope, lineage: readonly TransitionBoundary[], historyLimit?: number): boolean;
/** Validate one revision-selected cohort. Its older ancestry must be bound by the durable loader. */
export declare function validateTemporalState(view: TemporalState, historyLimit?: number): void;
/** Structural consistency only: storage must additionally bind witnesses to accepted source authority. */
export declare function validateSelectedTemporalState(view: SelectedTemporalState, historyLimit?: number): void;
/** Adopt revision-proven inherited streams without rewriting their checkpoints or tails. */
export declare function adoptTemporalStreams(scopes: Record<StateScope, ScopeStream>, id: string, historyLimit?: number): TemporalState;
/** New or migrated state starts at a proven current boundary, with no invented past. */
export declare function createTemporalState(states: ScopedSemanticStates, id: string, historyLimit?: number): TemporalState;
/** Restrict a validated value cohort; expanding selection requires separately acquired current streams. */
export declare function selectTemporalState(source: TemporalCohort, selection: ScopeSelection, historyLimit?: number): SelectedTemporalState;
/** Complete retained witness skeleton, derived from validated semantic records/basis, never from lineage alone. */
export declare function temporalCausalWitnesses(view: TemporalCohort, historyLimit?: number): ExcludedTransitionWitness[];
/** Metadata syntax only; a skeleton is neither semantic replay nor acquisition/publication authority. */
export declare function captureTemporalWitnesses(lineage: readonly TransitionBoundary[], witnesses: unknown, historyLimit?: number): ExcludedTransitionWitness[];
/** Reconstruct selected values from caller-bound accepted evidence; this validates syntax/consistency, not physical authority. */
export declare function restoreSelectedTemporalState(scopes: Partial<Record<StateScope, ScopeStream>>, selection: ScopeSelection, lineage: readonly TransitionBoundary[], witnesses: unknown, historyLimit?: number): SelectedTemporalState;
/** Explicit selected values at a new origin; this constructor grants no initialization/acquisition permission. */
export declare function createSelectedTemporalState(states: Partial<ScopedSemanticStates>, selection: ScopeSelection, id: string, historyLimit?: number): SelectedTemporalState;
/** Adopt explicitly admitted selected streams at current values only, without invented aligned history. */
export declare function adoptSelectedTemporalStreams(scopes: Partial<Record<StateScope, ScopeStream>>, selection: ScopeSelection, id: string, historyLimit?: number): SelectedTemporalState;
/** Fold retained tails to a lower configured limit without inventing history. */
export declare function constrainTemporalState<T extends TemporalCohort>(view: T, historyLimit: number): T;
/** Current independent scope revisions; Effective uses this vector rather than inventing a scalar owner. */
export declare function temporalScopeRevisions(view: TemporalState): ScopeRevisions;
export declare function temporalScopeRevisions(view: SelectedTemporalState): Partial<ScopeRevisions>;
/** Exact scope semantics for authored staging; defaults must never become implicit writes. */
export declare function readTemporalScopes(view: TemporalState, offset?: number, historyLimit?: number): ScopedSemanticStates;
export declare function readTemporalScopes(view: SelectedTemporalState, offset?: number, historyLimit?: number): Partial<ScopedSemanticStates>;
/** Sparse current/historical view: unknown planes and absent values never become effective data. */
export declare function readTemporalView(view: TemporalCohort, offset?: number, scope?: StateScope, historyLimit?: number): SemanticState;
/** Internal defaulted materialization for consumers that require object registries. */
export declare function readTemporalState(view: TemporalCohort, offset?: number, scope?: StateScope, historyLimit?: number): MaterializedState;
/** Allocate the identity outside this algebra; only materially effective patches accept it. */
export declare function advanceTemporalState<T extends TemporalCohort>(view: T, transitions: readonly RecentScopePatch[], id: string, historyLimit?: number): T;
export {};
