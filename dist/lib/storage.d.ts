import { type DurableFileBase, type OwnedFileUpdate } from "./durable.ts";
import type { ArtifactProvenanceRegistry } from "./artifact.ts";
import { type FileRevision, type SessionRuntime } from "./snapshot.ts";
export { isFileRevision, type FileRevision } from "./snapshot.ts";
import type { StateScope } from "./state.ts";
import { type TemporalState } from "./temporal.ts";
export interface TemporalFileBase {
    files: DurableFileBase[];
}
export declare function assertStorageDirectory(path: string): void;
/** Explicit creation only; existing bytes and unrelated files are never adopted or rewritten here. */
export declare function initializeFileStore(root: string): void;
/** Wait only for a cooperating live owner; interrupted or malformed locks remain explicit recovery errors. */
export declare function acquirePublicationLock(path: string, unavailable: (cause: unknown) => Error): number;
/** Canonical writers and bounded backup capture share exclusion; no Git work runs under this lock. */
export declare function withStoragePublicationLock<T>(repositoryRoot: string, action: (root: string) => T): T;
export interface StorageTransaction {
    readonly capture: typeof captureTemporalFileBase;
    readonly publish: typeof publishTemporalStateToFiles;
}
export declare class PublicationBusyError extends Error {
    constructor(path: string);
}
/** Await an exact file mutex; shared by canonical transactions and the independent Git backup owner. */
export declare function withFilePublicationLock<T>(lockPath: string, action: () => T | Promise<T>, signal?: AbortSignal, unavailable?: (cause: unknown) => Error, waitForLock?: boolean): Promise<T>;
/** Await store-wide exclusion, then capture/apply/publish through callback-scoped operations. */
export declare function withStorageTransaction<T>(repositoryRoot: string, action: (transaction: StorageTransaction) => T | Promise<T>, signal?: AbortSignal, waitForLock?: boolean): Promise<T>;
export declare function assertTemporalFileBase(expected: TemporalFileBase, current: TemporalFileBase): void;
/** Plan exact canonical updates; lifecycle-only writes exclude semantic files and provenance. */
export declare function planTemporalPublication(cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[], current: TemporalFileBase, root: string, runtime?: SessionRuntime, runtimeOnly?: boolean, sessionKey?: string, provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>): {
    updates: OwnedFileUpdate[];
    changedScopes: StateScope[];
};
/** The accepted basis comes from prepared outputs, never a post-publication worktree reread. */
export declare function temporalFileReceipts(current: TemporalFileBase, updates: readonly OwnedFileUpdate[]): DurableFileBase[];
export declare function captureTemporalFileBase(cwd: string, sessionId: string, root: string, sessionKey?: string): TemporalFileBase;
/** Current-only reference: exact bytes, complete identities and lineage, no aliases or history store. */
export declare function loadTemporalFileRevision(cwd: string, sessionId: string, root: string, revision: string, sessionKey?: string): {
    runtime: SessionRuntime;
    view: {
        scopes: Record<StateScope, import("./temporal.ts").ScopeStream>;
        lineage: import("./temporal.ts").TransitionBoundary[];
    };
    provenance: Record<StateScope, ArtifactProvenanceRegistry>;
    base: {
        files: DurableFileBase[];
    };
    revision: `file:${string}`;
};
/** Publish a validated canonical cohort; runtimeOnly owns only session config/runtime files. */
export declare function publishTemporalStateToFiles(cwd: string, sessionId: string, view: TemporalState, scopes: readonly StateScope[], base: TemporalFileBase, root: string, runtime: SessionRuntime, sessionKey?: string, provenance?: Readonly<Record<StateScope, ArtifactProvenanceRegistry>>, runtimeOnly?: boolean): {
    base: TemporalFileBase;
    revision: FileRevision;
    changed: boolean;
};
