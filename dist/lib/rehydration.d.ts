import { type ArtifactAcquisitionIntent, type ArtifactAcquisitionReason } from "./acquisition.ts";
import type { ArtifactSourceIdentity } from "./artifact.ts";
import type { StateScope } from "./state.ts";
export type RehydrationPhase = "resume-bootstrap" | "new-bootstrap" | "step";
export interface RehydrationRoute {
    scope: StateScope;
    source: ArtifactSourceIdentity;
    metadata: unknown;
    /** Runtime-owned compilation evidence retained beside the semantic artifact. */
    provenance?: unknown;
    compiler: string;
    intent: ArtifactAcquisitionIntent;
    materializedSufficient?: boolean;
    explicitRefresh?: boolean;
    sourceBytes?: number;
}
export interface RehydrationRead extends ArtifactSourceIdentity {
    scope: StateScope;
    reason: ArtifactAcquisitionReason;
}
export interface RehydrationPlan {
    reads: RehydrationRead[];
    materialized: string[];
    deferred: Array<{
        path: string;
        reason: "new-session-scope" | "read-count-limit" | "source-byte-limit";
    }>;
}
export interface RehydrationOptions {
    maxReads?: number;
    maxSourceBytes?: number;
}
/** Plan visible reads only; this function never reads, compiles, mutates, or publishes sources. */
export declare function planKnowledgeRehydration(phase: RehydrationPhase, routes: readonly RehydrationRoute[], options?: RehydrationOptions): RehydrationPlan;
