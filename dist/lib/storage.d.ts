import { type DurableFileBase, type OwnedFileUpdate, type OwnedFilePresence, type SessionAddress } from "./durable.ts";
import { type ArtifactProvenanceRegistry } from "./artifact.ts";
import { type AcceptedTransition } from "./history.ts";
import { type SelectedLifecycleDocument, type Snapshot } from "./snapshot.ts";
import type { StateScope } from "./state.ts";
import { type SelectedTemporalState, type ExcludedTransitionWitness } from "./temporal.ts";
import { type ScopeSelection } from "./selection.ts";
import { type RetainedModules } from "./semantic-module.ts";
export interface TemporalFileBase {
    files: DurableFileBase[];
}
export declare function temporalFileContents(base: TemporalFileBase): Map<string, string | undefined>;
export declare function decodeLifecycleFilePair(config: DurableFileBase, runtime: DurableFileBase, cwd: string, sessionId: string): SelectedLifecycleDocument | undefined;
export declare function assertStorageDirectory(path: string): void;
/** Explicit creation only; existing bytes and unrelated files are never adopted or rewritten here. */
export declare function initializeFileStore(root: string): void;
export interface StorageTransaction {
    readonly prepareSelected: (cwd: string, sessionId: string, selection: ScopeSelection, root: string, sessionKey?: string) => SelectedFileCohort | undefined;
    readonly observeSelectedShared: (cwd: string, selection: ScopeSelection, root: string) => SelectedReadObservation;
    readonly persistSelectedPassive: (cwd: string, sessionId: string, base: SelectedFileCohort, root: string, sessionKey?: string) => SelectedFilePublication;
    readonly hasSelectedCurrentAuthority: (cwd: string, sessionId: string, selection: ScopeSelection, root: string, sessionKey?: string) => boolean;
    readonly inspectSelectedLifecycle: (cwd: string, sessionId: string, selection: ScopeSelection, root: string, sessionKey?: string) => SelectedLifecycleDocument | undefined;
    readonly prepareSelectedCurrent: (cwd: string, sessionId: string, selection: ScopeSelection, historyLimit: number, root: string, sessionKey?: string, expectedLifecycle?: TemporalFileBase) => SelectedCurrentCandidate;
    readonly acceptSelectedCurrent: (cwd: string, sessionId: string, request: SelectedCurrentRequest, base: SelectedCurrentCandidate, root: string, sessionKey?: string) => SelectedFilePublication;
    readonly publishSelected: (cwd: string, sessionId: string, request: SelectedPublicationRequest, base: SelectedFileCohort, root: string, sessionKey?: string) => SelectedFilePublication;
    /** Caller must independently own a genuinely new session origin; absence alone grants no authority. */
    readonly initializeSelectedSharedOrigin: (cwd: string, sessionId: string, request: SelectedOriginRequest, root: string, sessionKey?: string) => SelectedFilePublication;
    readonly acquireSelectedSession: (cwd: string, sessionId: string, request: SelectedSessionAcquisitionRequest, root: string, sessionKey?: string) => SelectedFilePublication;
    /** Native caller owns the fresh fork identity; never look up a parent while Session is excluded. */
    readonly deferSelectedFork: (cwd: string, sessionId: string, request: SelectedOriginRequest, root: string, sessionKey?: string) => SelectedFilePublication;
    readonly copySelectedFork: (cwd: string, sessionId: string, request: SelectedForkCopyRequest, root: string, sessionKey?: string) => SelectedFilePublication;
}
export declare class PublicationBusyError extends Error {
    constructor(path: string);
}
/** Await an exact file mutex; shared by canonical transactions and the independent Git backup owner. */
export declare function withFilePublicationLock<T>(lockPath: string, action: () => T | Promise<T>, signal?: AbortSignal, unavailable?: (cause: unknown) => Error, waitForLock?: boolean): Promise<T>;
/** Await store-wide exclusion, then capture/apply/publish through callback-scoped operations. */
export declare function withStorageTransaction<T>(repositoryRoot: string, action: (transaction: StorageTransaction) => T | Promise<T>, signal?: AbortSignal, waitForLock?: boolean): Promise<T>;
export declare function assertTemporalFileBase(expected: TemporalFileBase, current: TemporalFileBase): void;
/** The accepted basis comes from prepared outputs, never a post-publication worktree reread. */
export declare function temporalFileReceipts(current: TemporalFileBase, updates: readonly OwnedFileUpdate[]): DurableFileBase[];
export interface SelectedFileCohort {
    /** Exact byte dependencies only; unrelated excluded bodies are not a CAS input. */
    basis: TemporalFileBase;
    /** Separate existence/type dependencies, not byte-CAS receipts or write permission. */
    presence: OwnedFilePresence[];
    lifecycle: SelectedLifecycleDocument;
    view: SelectedTemporalState;
    witnesses: ExcludedTransitionWitness[];
    provenance: Partial<Record<StateScope, ArtifactProvenanceRegistry>>;
}
/** Read-only Start/refresh candidate, not an admitted persisted view or a publication capability. */
export interface SelectedCurrentCandidate extends SelectedFileCohort {
    alignment: "retained" | "current-origin";
}
export type SelectedProvenanceUpdates = Partial<Record<StateScope, ArtifactProvenanceRegistry>>;
/** Reject excluded owners before their values/getters; metadata values remain runtime-owned evidence, not source authentication. */
export declare function captureSelectedProvenanceUpdates(value: SelectedProvenanceUpdates | undefined, selection: ScopeSelection): SelectedProvenanceUpdates | undefined;
/** Host-admitted additions only; never inferred from an explicit output view or a registry. */
export type SelectedModuleAdditions = Partial<Record<StateScope, RetainedModules>>;
export declare function captureSelectedModuleAdditions(value: unknown, selection: ScopeSelection): SelectedModuleAdditions | undefined;
export interface SelectedCurrentRequest {
    selection: ScopeSelection;
    historyLimit: number;
    lifecycle?: Snapshot;
    transition?: AcceptedTransition;
    provenance?: SelectedProvenanceUpdates;
    moduleAdditions?: SelectedModuleAdditions;
}
export interface SelectedPublicationRequest {
    view: SelectedTemporalState;
    historyLimit: number;
    /** Exact authored replay, including runtime-owned cascades/response when the caller owns them. */
    transition?: AcceptedTransition;
    /** Closed run/mode fields only. Identity, acquisition and causal witnesses cannot be supplied here. */
    lifecycle?: Snapshot;
    provenance?: SelectedProvenanceUpdates;
    moduleAdditions?: SelectedModuleAdditions;
}
export interface SelectedOriginRequest {
    selection: ScopeSelection;
    snapshot: Snapshot;
    historyLimit: number;
    /** Synchronous first authoring on the same source-derived origin, before any owner is published. */
    author?: (basis: {
        view: SelectedTemporalState;
        snapshot: Snapshot;
        provenance: SelectedProvenanceUpdates;
    }, publish: (snapshot: Snapshot, transition?: AcceptedTransition, provenance?: SelectedProvenanceUpdates, moduleAdditions?: SelectedModuleAdditions) => SelectedFilePublication) => void;
}
export type SelectedSessionAcquisitionRequest = SelectedOriginRequest & ({
    kind: "new";
} | {
    kind: "unacquired";
    base: SelectedFileCohort;
});
export type SelectedForkCopyRequest = SelectedOriginRequest & {
    source: SessionAddress;
} & ({
    kind: "fork-new";
} | {
    kind: "fork-deferred";
    base: SelectedFileCohort;
});
/** Read-only availability, not a lifecycle cohort, accepted publication basis or private acquisition claim. */
export interface SelectedReadObservation {
    selection: ScopeSelection;
    view?: SelectedTemporalState;
    provenance: SelectedProvenanceUpdates;
}
export interface SelectedFilePublication {
    cohort: SelectedFileCohort;
    changed: boolean;
    migrationBackup?: string;
}
/** Await a fresh guarded transaction; no private initialization or fork acquisition is admitted. */
export declare function publishSelectedTemporalStateToFiles(cwd: string, sessionId: string, request: SelectedPublicationRequest, base: SelectedFileCohort, root: string, sessionKey?: string, signal?: AbortSignal): Promise<SelectedFilePublication>;
/** Read-only selected admission under exclusion; never initialize a store or grant publication/acquisition. */
export declare function loadSelectedFileCohort(cwd: string, sessionId: string, selection: ScopeSelection, root: string, sessionKey?: string, signal?: AbortSignal): Promise<SelectedFileCohort | undefined>;
/** Exact recapture comparison; future selected publishers must repeat both dependency checks under exclusion. */
export declare function assertSelectedFileCohortBasis(expected: SelectedFileCohort, current: SelectedFileCohort): void;
