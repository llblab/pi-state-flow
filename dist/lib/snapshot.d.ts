import { type ArtifactProvenanceRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
import { type TransitionBoundary } from "./temporal.ts";
/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export declare class RevisionUnavailableError extends Error {
}
/** Expired history cannot be restored, but explicit activation may use validated current memory. */
export declare class HistoryBoundaryExpiredError extends RevisionUnavailableError {
}
export interface SnapshotConfig {
    enabled: boolean;
}
interface LegacyValidationFeedback {
    attempt: number;
    error: string;
    instruction: string;
}
export interface SnapshotMeta {
    step: number;
    specification?: string;
    /** Read-only compatibility/recovery diagnostic; 0.7 never schedules terminal-envelope retries. */
    validation?: LegacyValidationFeedback;
    bootstrap?: boolean;
}
/** In-memory runtime config/provenance; durable config/meta and scope files own restoration. */
export interface StateFlowSnapshot {
    config: SnapshotConfig;
    meta: SnapshotMeta;
}
export type Snapshot = StateFlowSnapshot;
export interface SessionRuntime {
    config: SnapshotConfig;
    meta: SnapshotMeta & {
        version: 1;
        identity: {
            cwd: string;
            sessionId: string;
        };
        lineage: TransitionBoundary[];
        /** Runtime-owned artifact compilation evidence; never projected as semantic state. */
        artifacts?: ArtifactProvenanceRegistry;
        temporal?: {
            checkpoint: TransitionBoundary;
            patches: TransitionBoundary[];
        };
        [key: string]: unknown;
    };
}
export declare function validateSessionRuntime(value: unknown, cwd: string, sessionId: string): asserts value is SessionRuntime;
export declare function createSessionRuntime(snapshot: Snapshot, cwd: string, sessionId: string, lineage: readonly TransitionBoundary[], _artifacts?: ArtifactProvenanceRegistry): SessionRuntime;
export declare function serializeSessionRuntime(runtime: SessionRuntime, cwd: string, sessionId: string): {
    config: string;
    runtime: string;
};
export declare function parseSessionRuntime(config: string | undefined, runtimeSource: string | undefined, cwd: string, sessionId: string): SessionRuntime | undefined;
export declare function emptySnapshot(enabled?: boolean): Snapshot;
export type RetainedBoundaryCheckpoint = {
    boundary: string;
    enabled: boolean;
    step: number;
    bootstrap?: true;
    specification?: string;
};
export type RetainedPiCheckpoint = RetainedBoundaryCheckpoint | {
    disabled: true;
};
export type FileRevision = `file:${string}`;
export declare function isFileRevision(value: unknown): value is FileRevision;
/** Encode branch lifecycle against one retained temporal identity without semantic or backup data. */
export declare function retainedBoundaryCheckpoint(snapshot: Snapshot, boundary: string): RetainedBoundaryCheckpoint;
/** Decode the 0.17 retained-window checkpoint contract. */
export declare function parseRetainedPiCheckpoint(value: unknown): RetainedPiCheckpoint;
export declare function migrationFailure(data: JsonObject, error: string): Snapshot;
export {};
