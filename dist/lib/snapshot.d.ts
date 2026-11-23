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
export interface SelectedLifecycleDocument {
    sourceVersion: 2 | "baseline";
    runtime: SelectedSessionRuntime;
    /** Bytes in the admitted format, not file observations or publication authority. */
    target: {
        config: string;
        runtime: string;
    };
}
/** Recognized incompatible evidence is not corrupt memory and must never trigger a reset. */
export declare class UnsupportedLifecycleFormatError extends Error {
}
/** Identify a supported, owned lifecycle without interpreting config, lineage or private authority. */
export declare function parseSelectedLifecycleHeader(source: string, cwd: string, sessionId: string): {
    baseline: boolean;
    metadata: JsonObject;
    source: string;
};
/** Decode Baseline or V2; classify a retired/unknown runtime before decoding captured config bytes. */
export declare function parseSelectedLifecycle(configSource: string | undefined | (() => string | undefined), runtimeSource: string | undefined, cwd: string, sessionId: string): SelectedLifecycleDocument | undefined;
export declare function decodeSelectedLifecycle(header: ReturnType<typeof parseSelectedLifecycleHeader>, config: string | undefined, cwd: string, sessionId: string): SelectedLifecycleDocument;
/** Pure wire codec. Missing owner claims stay missing; only the storage owner can admit their replay. */
export declare function parseBaselineLifecycle(config: string, source: string, cwd: string, sessionId: string): SelectedSessionRuntime;
/** Serialize selected lifecycle proof without repeating transition identities. No file authority. */
export declare function serializeBaselineLifecycle(runtime: SelectedSessionRuntime, cwd: string, sessionId: string): {
    config: string;
    runtime: string;
};
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
