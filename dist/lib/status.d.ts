import type { ArtifactInvalidationReason } from "./artifact.ts";
import { type RecentTransitionWindow } from "./history.ts";
import type { Snapshot } from "./snapshot.ts";
import { type ScopedStates, type StateScope } from "./state.ts";
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
    scopeStates: ScopedStates;
    recent: RecentTransitionWindow;
    historyLimit: number;
    temporal?: {
        head: TransitionBoundary;
        historyDepth: number;
        tailCounts: Record<StateScope, number>;
        revisions: ScopeRevisions;
    };
    staleArtifacts: readonly StaleArtifactDiagnostic[];
    durableStateError?: string;
    publicationError?: string;
}
export declare function formatScopeRevisionVector(revisions: ScopeRevisions): string;
export declare function compactStatus(snapshot: Snapshot, revisions: ScopeRevisions, colorize: Colorize): string | undefined;
export declare function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string;
