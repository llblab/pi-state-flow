import { type ArtifactProvenanceRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
import { type TransitionBoundary } from "./temporal.ts";
/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export declare class RevisionUnavailableError extends Error {
}
export type StateFlowMode = "active" | "passive" | "off";
export type InactiveMode = Exclude<StateFlowMode, "active">;
export declare function isStateFlowMode(value: unknown): value is StateFlowMode;
/** The session's selected mode is the only serialized behavior switch. */
export interface SnapshotConfig {
    mode: StateFlowMode;
}
/**
 * Read only mode policy, without validating or accessing semantic checkpoint metadata.
 * Missing/invalid policy stays undecided; callers must not treat this as restoration proof.
 * Legacy `enabled:false` follows the caller's inactive policy.
 */
export declare function readCheckpointMode(value: unknown, inactiveMode?: InactiveMode): StateFlowMode | undefined;
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
/** Failed Active selection retains its policy and fences inference until explicit recovery or an inactive choice. */
export declare function isActiveRestorationBlocked(snapshot: Snapshot): boolean;
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
/** Legacy `enabled:false` decodes as non-active; native checkpoints, not this file, select branch policy. */
export declare function parseSessionRuntime(config: string | undefined, runtimeSource: string | undefined, cwd: string, sessionId: string): SessionRuntime | undefined;
export declare function emptySnapshot(mode?: StateFlowMode): Snapshot;
export type RetainedBoundaryCheckpoint = {
    boundary: string;
    mode: StateFlowMode;
    step: number;
    bootstrap?: true;
    specification?: string;
};
/** A proven pre-runtime branch retains only its explicit inactive choice, never semantic storage. */
export type PreRuntimeCheckpoint = {
    mode: InactiveMode;
};
export type RetainedPiCheckpoint = RetainedBoundaryCheckpoint | PreRuntimeCheckpoint;
export type FileRevision = `file:${string}`;
export declare function isFileRevision(value: unknown): value is FileRevision;
/** Encode branch lifecycle against one retained temporal identity without semantic or backup data. */
export declare function retainedBoundaryCheckpoint(snapshot: Snapshot, boundary: string): RetainedBoundaryCheckpoint;
/** Encode an explicit inactive choice on a branch that has no accepted runtime. */
export declare function preRuntimeCheckpoint(mode: StateFlowMode): PreRuntimeCheckpoint;
/** Decode the retained-window checkpoint contract; legacy `enabled`/`{disabled:true}` markers map through `inactiveMode`. */
export declare function parseRetainedPiCheckpoint(value: unknown, inactiveMode?: InactiveMode): RetainedPiCheckpoint;
export declare function migrationFailure(data: JsonObject, error: string, mode?: StateFlowMode): Snapshot;
export {};
