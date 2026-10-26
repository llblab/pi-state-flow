import type { ArtifactInvalidationReason } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { type Snapshot } from "./snapshot.ts";
import { type SemanticState, type ScopeStateValues, type StateScope } from "./state.ts";
import { type ScopeSelection } from "./selection.ts";
import type { ScopeRevisions, TransitionBoundary } from "./temporal.ts";
export declare const STATUS_KEY = "state-flow";
export type Colorize = (color: "accent" | "dim", text: string) => string;
export type StaleArtifactReason = ArtifactInvalidationReason | "source-removed";
export interface StaleArtifactDiagnostic {
    scope: StateScope;
    path: string;
    reason: StaleArtifactReason;
}
export interface StatusDiagnostics {
    repositoryRoot: string;
    cwdScopeKey: string;
    sessionScopeKey: string;
    /** Omission retains all-three compatibility; a subset must be explicit, never inferred from missing data. */
    selection?: ScopeSelection;
    /** Captured policy may request Session while only shared owners are observable. Never a materialization grant. */
    requestedSelection?: ScopeSelection;
    scopeStates: ScopeStateValues;
    /** Legacy overlay override. Explicit selected observations derive only from scopeStates. */
    effectiveState?: SemanticState;
    recent: RecentTransitionWindow;
    historyLimit: number;
    temporal?: {
        head: TransitionBoundary;
        historyDepth: number;
        tailCounts: Partial<Record<StateScope, number>>;
        revisions: Partial<ScopeRevisions>;
    };
    staleArtifacts: readonly StaleArtifactDiagnostic[];
    durableStateError?: string;
    publicationError?: string;
}
export declare function formatScopeRevisionVector(revisions: Partial<ScopeRevisions>, selection?: ScopeSelection): string;
export declare function compactStatus(snapshot: Snapshot, _revisions: Partial<ScopeRevisions>, colorize: Colorize): string | undefined;
/** Operator-only footprint: serialized plane sizes and intent-owned share of top-level tactics/lazy entries. */
export declare function scopeMemoryLines(states: ScopeStateValues, selection?: ScopeSelection): string[];
export declare function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string;
