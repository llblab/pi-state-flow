import { type ArtifactInvalidationReason, type ArtifactInvalidationRequest, type ArtifactSourceIdentity, type ArtifactProvenanceRegistry } from "./artifact.ts";
import type { AtomicScopePatches, ScopedSemanticStates, ScopedStates, StateScope } from "./state.ts";
/** Why the caller is considering source-body acquisition. */
export type ArtifactAcquisitionIntent = "routine" | "new-session" | "relevant-gap" | "exact-source" | "exact-edit" | "contradiction-or-failure" | "explicit-request" | "maintenance";
export type ArtifactAcquisitionReason = ArtifactInvalidationReason | "materialized-gap" | "exact-source" | "exact-edit" | "contradiction-or-failure" | "explicit-request" | "maintenance";
export type ArtifactAcquisitionDecision = {
    kind: "use-materialized";
    reason: "no-concrete-need" | "materialized-sufficient";
} | {
    kind: "read-source";
    reason: ArtifactAcquisitionReason;
};
export interface ArtifactAcquisitionOptions {
    intent: ArtifactAcquisitionIntent;
    /** Caller-assessed semantic sufficiency; only relevant to a concrete relevant gap. */
    materializedSufficient?: boolean;
    explicitRefresh?: boolean;
    /** Runtime-owned compilation evidence retained beside the semantic artifact. */
    provenance?: unknown;
}
/** A successful read correlated to a runtime-observed invalidation candidate. */
export interface SuccessfulArtifactRead extends ArtifactInvalidationRequest {
}
/** Correlate successful read-tool executions with the current ordinary artifact invalidation plan. */
export declare class ArtifactReadTracker {
    #private;
    readonly successful: Map<string, SuccessfulArtifactRead>;
    setCandidates(candidates: Iterable<ArtifactInvalidationRequest>): void;
    clear(): void;
    recordStart(toolCallId: string, toolName: string, args: unknown): void;
    recordCall(toolCallId: string, toolName: string, input: unknown): void;
    recordEnd(toolCallId: string, toolName: string, isError: boolean): void;
}
/**
 * Apply one materialized-first source acquisition policy.
 *
 * Required recompilation always wins. Otherwise routine use and a new session
 * stay on materialized state; only a concrete source need permits rereading.
 */
export declare function decideArtifactAcquisition(source: ArtifactSourceIdentity, metadata: unknown, compiler: string, options: ArtifactAcquisitionOptions): ArtifactAcquisitionDecision;
export declare const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";
/**
 * One selected branch's ordinary-artifact acquisition plan: runtime-observed
 * invalidations, their model hints and the read tracker correlated to them.
 * The tracker's candidates always equal the current invalidation plan.
 */
export declare class ArtifactAcquisitionState {
    #private;
    readonly reads: ArtifactReadTracker;
    get invalidations(): readonly ArtifactInvalidationRequest[];
    get hints(): Record<string, string>;
    /** Drop the invalidation plan; hints remain until the next refresh. */
    clearInvalidations(): void;
    /** Forget plan and hints when no memory view is selected. */
    reset(): void;
    /** Re-observe exact registered sources for the selected scope artifacts. */
    refresh(states: ScopedStates, provenance: (scope: StateScope) => ArtifactProvenanceRegistry): void;
    /** Accepted compilations leave the plan; correlated read evidence is single-use. */
    acceptAcquired(paths?: ReadonlySet<string>): void;
}
/** Deletion patches for registered artifacts whose exact source is observed missing, in every owning scope. */
export declare function missingArtifactRemovals(states: ScopedSemanticStates): AtomicScopePatches;
