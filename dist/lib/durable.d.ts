import { type ArtifactProvenanceRegistry } from "./artifact.ts";
import { type ScopeStream, type TemporalState } from "./temporal.ts";
import type { StateScope } from "./state.ts";
/** Canonical semantic sources plus runtime-owned temporal metadata. */
export interface ScopeStreamSources {
    checkpoint: string;
    patches: string;
    temporal: ScopeTemporalMetadata;
}
/** Read-only activation eligibility for one canonical CWD scope. */
export declare function hasCwdMaterialization(cwd: string, repositoryRoot: string): boolean;
export interface ScopeTemporalMetadata {
    revision: number;
    checkpoint: ScopeStream["checkpoint"]["through"];
    patches: ScopeStream["patches"][number]["transition"][];
}
export interface SessionAddress {
    readonly id: string;
    readonly key: string;
}
/** Semantic files contain no runtime envelope; temporal boundaries and CWD ownership live in meta.json. */
export declare function serializeScopeStream(stream: ScopeStream, scope: StateScope, cwdIdentity?: string): ScopeStreamSources;
export type ScopeStreamPresence = {
    kind: "absent";
} | {
    kind: "present";
    stream: ScopeStream;
};
/** Distinguish a wholly absent semantic cohort from partial or malformed surviving authority. */
export declare function classifyScopeStream(checkpointSource: string | undefined, patchesSource: string | undefined, scope: StateScope, expectedCwd?: string, metaSource?: string): ScopeStreamPresence;
/** Decode the entire bounded replay input before accepting any materialized state. */
export declare function parseScopeStream(checkpointSource: string | undefined, patchesSource: string | undefined, scope: StateScope, expectedCwd?: string, metaSource?: string): ScopeStream | undefined;
export interface TemporalScopePaths {
    directory: string;
    checkpoint: string;
    patches: string;
    /** Runtime-owned artifact provenance for this scope; the session file also owns runtime lineage. */
    meta: string;
}
export declare function temporalScopePaths(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string, sessionKey?: string): TemporalScopePaths;
export declare function sessionRuntimePaths(cwd: string, sessionId: string, repositoryRoot: string, sessionKey?: string): {
    config: string;
    runtime: string;
    meta: string;
};
/** Unsupported state.json presence never becomes an anchored checkpoint. */
export declare function loadScopeStream(cwd: string, sessionId: string, scope: StateScope, repositoryRoot: string, sessionKey?: string): ScopeStream | undefined;
/** Include unsupported predecessor names in the CAS basis so they cannot race canonical publication. */
export declare function captureTemporalFileBases(cwd: string, sessionId: string, repositoryRoot: string, sessionKey?: string): DurableFileBase[];
/** Select exact serialized scope updates from one validated active temporal cohort. */
export declare function temporalStateFileUpdates(cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[], repositoryRoot: string, sessionKey?: string): OwnedFileUpdate[];
/** Merge authoritative owned leaves while preserving forward-compatible metadata siblings. */
export declare function serializeScopeMetadata(registry: Readonly<ArtifactProvenanceRegistry> | undefined, stream: ScopeStream, scope: StateScope, cwdIdentity?: string, existingSource?: string): string;
/** Compatibility serializer retained for metadata-only callers. */
export declare function serializeScopeProvenance(registry: Readonly<ArtifactProvenanceRegistry>): string;
/** Missing provenance is unavailable evidence, never corrupt state. Unknown metadata is preserved by writers. */
export declare function parseScopeProvenance(source: string | undefined, path: string): ArtifactProvenanceRegistry;
export interface ScopePaths {
    directory: string;
}
export interface DurableFileBase {
    path: string;
    identity: "missing" | `sha256:${string}`;
    content?: string;
    /** Opaque originals for byte-exact rollback. */
    bytes?: Uint8Array;
}
/** Dedicated runtime storage, independent from Markdown source discovery. */
export declare function getDurableRepositoryRoot(agentDir?: string): string;
/** Match Pi's native project-session directory convention exactly. */
export declare function cwdScopeKey(cwd: string): string;
/** One safe directory segment, normally the native Pi session filename stem. */
export declare function sessionScopeKey(key: string): string;
/** Prefer the actual native file stem; reproduce it from the immutable header when in-memory. */
export declare function sessionStorageKey(sessionFile: string | undefined, sessionId: string, timestamp?: string): string;
export declare function resolveSessionAddress(sessionFile: string | undefined, sessionId: string, timestamp?: string): SessionAddress;
export declare function cwdScopePaths(cwd: string, repositoryRoot?: string): ScopePaths;
export declare function sessionScopePaths(cwd: string, sessionId: string, repositoryRoot?: string, sessionKey?: string): ScopePaths;
/** Exact canonical semantic and runtime file shapes. */
export declare function isStateFlowOwnedPath(candidate: string, repositoryRoot?: string): boolean;
/** Capture exact owned bytes for one compare-and-swap publication cohort. */
export declare function captureOwnedFileBases(paths: readonly string[], repositoryRoot: string): DurableFileBase[];
export interface OwnedFileUpdate {
    path: string;
    /** Omission means removal of this exact owned file, not a semantic null patch. */
    content?: string;
}
/** Verify the publisher's exact output before commit or rollback, without trusting changed worktree bytes. */
export declare function assertOwnedFileUpdates(updates: readonly OwnedFileUpdate[], repositoryRoot: string): void;
/** Publish a prevalidated file cohort, preserving original bytes for failed preparation/publication. */
export declare function writeOwnedFileUpdates(updates: readonly OwnedFileUpdate[], bases: readonly DurableFileBase[], repositoryRoot: string): string[];
/** Restore exact pre-transition bytes only while files still match this publisher's output. */
export declare function restoreDurableFileBases(bases: readonly DurableFileBase[], repositoryRoot: string, expectedCurrent: readonly OwnedFileUpdate[]): void;
