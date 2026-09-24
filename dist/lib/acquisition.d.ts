import { type ArtifactInvalidationReason, type ArtifactInvalidationRequest, type ArtifactSourceIdentity } from "./artifact.ts";
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
