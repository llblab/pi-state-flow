import { type ArtifactProvenanceRegistry } from "./artifact.ts";
import { type JsonObject } from "./json.ts";
import { type ExcludedTransitionWitness, type TransitionBoundary } from "./temporal.ts";
import { type ScopeSelection } from "./selection.ts";
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
/** Capture closed caller-owned run fields, omitting only undefined optional in-memory fields. */
export declare function captureLifecycleSnapshot(value: Snapshot): Snapshot;
/** Failed Active selection retains its policy and fences inference until explicit recovery or an inactive choice. */
export declare function isActiveRestorationBlocked(snapshot: Snapshot): boolean;
interface LifecycleMetadata extends SnapshotMeta {
    identity: {
        cwd: string;
        sessionId: string;
    };
    lineage: TransitionBoundary[];
    [key: string]: unknown;
}
interface SessionRuntimeMetadata extends LifecycleMetadata {
    /** Runtime-owned artifact compilation evidence; never projected as semantic state. */
    artifacts?: ArtifactProvenanceRegistry;
    temporal?: {
        checkpoint: TransitionBoundary;
        patches: TransitionBoundary[];
    };
}
export interface SessionRuntime {
    config: SnapshotConfig;
    meta: SessionRuntimeMetadata & {
        version: 1;
    };
}
export type PrivateAcquisition = "unacquired" | "deferred" | "acquired";
export interface PrivateCausalBasis {
    lineage: TransitionBoundary[];
    causalWitnesses: ExcludedTransitionWitness[];
}
/** Retained private identity proof, never private values or acquisition permission. */
export declare function capturePrivateCausalBasis(value: unknown): PrivateCausalBasis;
export interface SelectedSessionRuntime {
    config: SnapshotConfig & {
        scopes: ScopeSelection;
    };
    meta: LifecycleMetadata & {
        version: 2;
        privateAcquisition: PrivateAcquisition;
        privateCausalBasis?: PrivateCausalBasis;
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
export interface SessionPolicyMigrationCandidate {
    sourceVersion: 1 | 2;
    targetVersion: 2;
    requiresConversion: boolean;
    /** Original strings, not file observations or publication authority. */
    source: {
        config: string;
        runtime: string;
    };
    runtime: SelectedSessionRuntime;
    target: {
        config: string;
        runtime: string;
    };
}
/** Detached lifecycle preflight only; current native readers/writers still admit version 1 exclusively. */
export declare function prepareSessionPolicyMigration(config: string | undefined, runtimeSource: string | undefined, cwd: string, sessionId: string, legacySelection: ScopeSelection): SessionPolicyMigrationCandidate | undefined;
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
export type SelectedRetainedPiCheckpoint = RetainedPiCheckpoint & {
    version: 2;
    scopes: ScopeSelection;
};
export interface RetainedPolicyMigrationCandidate {
    sourceVersion: "legacy" | 2;
    targetVersion: 2;
    requiresConversion: boolean;
    checkpoint: SelectedRetainedPiCheckpoint;
}
/** Native policy value preflight; no retained boundary, fork or acquisition authority is created. */
export declare function prepareRetainedPolicyMigration(value: unknown, legacySelection: ScopeSelection, inactiveMode?: InactiveMode): RetainedPolicyMigrationCandidate;
export declare function migrationFailure(data: JsonObject, error: string, mode?: StateFlowMode): Snapshot;
export {};
