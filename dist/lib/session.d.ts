import { type InactiveMode, type StateFlowMode, type RetainedPolicyMigrationCandidate } from "./snapshot.ts";
import { type ScopeSelection } from "./selection.ts";
import { type RecoveryIncident } from "./healing.ts";
import type { StateScope } from "./state.ts";
export declare const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";
/** Requested native policy, not proof of accepted memory or acquisition permission. */
export interface SelectedNativeRequestPolicy {
    readonly cwd: string;
    readonly owner: string;
    readonly mode: StateFlowMode;
    readonly scopes: ScopeSelection;
}
/** Cancelable pre-provider turn, including Off bookkeeping; not memory/acquisition authority. */
export type NativeContextRequest = Pick<SelectedPolicyRequest, "signal" | "revalidate">;
export interface SelectedPolicyRequest {
    readonly policy: SelectedNativeRequestPolicy;
    readonly signal: AbortSignal;
    /** Synchronous in-memory recheck, suitable for the selected runtime's native-policy port. */
    revalidate(): void;
}
/** Owns policy-bound cancellation only; no storage, attachment, source acquisition or slot registry. */
export declare class SelectedPolicyLifetime {
    #private;
    get policy(): SelectedNativeRequestPolicy | undefined;
    /** Cancellation only, including Off; unlike capture(), this grants no enabled memory receipt. */
    get signal(): AbortSignal;
    /** Same captured policy preserves independent owners; a real choice revokes all old requests. */
    select(value: SelectedNativeRequestPolicy): void;
    /** Capture at admission, before any source acquisition, asynchronous wait or queued work. */
    capture(): SelectedPolicyRequest;
    /** Same-policy branch movement/Abort may revoke requests without inventing a different selection. */
    invalidate(): void;
    /** Shutdown cannot be reopened by a late selection or abort listener. */
    end(): void;
}
/** One SDK turn and its finalized assistant batch; IDs are evidence only within this owned turn. */
export declare class NativeToolRequestCorrelation {
    #private;
    begin(request: SelectedPolicyRequest | undefined, signal: AbortSignal | undefined, currentIdentity: () => boolean, controlSignal?: AbortSignal): void;
    /** Stable lease from turn_start through provider preparation, before assistant finalization. */
    preparing(): NativeContextRequest;
    /** Capture the exact same enabled request later returned for its finalized batch. */
    projectedRequest(): SelectedPolicyRequest | undefined;
    /** Provider-only revalidation of captured context data; callbacks must neither acquire nor recurse into this request. */
    bindPreparedContext(check: () => void): void;
    finalize(calls: readonly {
        id: string;
        name: string;
    }[]): void;
    get active(): boolean;
    /** Identify the ambient model owner; deciding which Abort cause to forward belongs to the native port. */
    ownsOperation(signal: AbortSignal | undefined): boolean;
    has(id: string): boolean;
    current(): SelectedPolicyRequest;
    check(id: string, name: string): SelectedPolicyRequest;
    /** Only explicit SDK parent evidence, never an ID prefix or branch-history guess. */
    nested(id: string, name: string, parent: string): void;
    take(id: string, name: string): SelectedPolicyRequest;
    end(): void;
}
interface BranchEntry {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
    message?: {
        role?: unknown;
    };
}
export declare const RECOVERY_ENTRY_TYPE = "state-flow-recovery";
/** Binding to one native session and configured store, never a semantic authority receipt. */
export interface NativeRecoveryOwner {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly file: string | null;
    readonly timestamp: string | null;
    readonly cwd: string;
    readonly root: string;
}
export declare function nativeRecoveryReceipt(owner: NativeRecoveryOwner, incidents: readonly RecoveryIncident[]): {
    version: number;
    owner: {
        sessionId: string;
        sessionKey: string;
        file: string | null;
        timestamp: string | null;
        cwd: string;
        root: string;
    };
    incidents: readonly RecoveryIncident[];
};
/** Consult the physical session's append-only entries, not its navigable branch. */
export declare function readNativeRecoveryReceipt(entries: readonly BranchEntry[], owner: NativeRecoveryOwner): readonly RecoveryIncident[];
type RecoveryAppend = (data: ReturnType<typeof nativeRecoveryReceipt>) => void;
/** The compact current receipt of one native attachment. Quarantine, writes and run delivery stay outside it. */
export declare class NativeRecoveryBinding {
    #private;
    readonly owner: NativeRecoveryOwner;
    constructor(owner: NativeRecoveryOwner, entries: readonly BranchEntry[]);
    incidents(): readonly RecoveryIncident[];
    /** A present-day acceptance does not change the historical fact or its delivery state. */
    proveCurrent(runtime: object, scopes: ScopeSelection, facts: readonly RecoveryIncident[]): void;
    provesCurrent(runtime: object | undefined, incident: RecoveryIncident, required: readonly StateScope[]): boolean;
    record(incident: RecoveryIncident, append: RecoveryAppend): void;
    /** Acknowledge the exact displayed versions. Never replace an unconfirmed durable fact with a local assumption. */
    acknowledge(displayed: readonly RecoveryIncident[], append: RecoveryAppend): void;
    /** A live effect may be known even if it could not be added to the native file. */
    remember(incident: RecoveryIncident): void;
}
/** Evidence for delivery, not a native lease and never proof of recovery success. */
export declare class RecoveryNoticeDelivery {
    #private;
    get hasAnswer(): boolean;
    reset(): void;
    offer(binding: NativeRecoveryBinding, facts: readonly RecoveryIncident[], operation: AbortSignal, request: SelectedPolicyRequest): void;
    answer(operation: AbortSignal, request: SelectedPolicyRequest, entryId: string): void;
    end(operation: AbortSignal | undefined, successful: boolean): void;
    settling(binding: NativeRecoveryBinding, entryId: string, operation?: AbortSignal): void;
    settled(binding: NativeRecoveryBinding, entryId: string, operation?: AbortSignal): readonly RecoveryIncident[];
}
/** Use Pi's append-only lookup once per exact physical attachment, not at every use or tree step. */
export declare class NativeRecoveryReceipts {
    #private;
    readonly delivery: RecoveryNoticeDelivery;
    bind(reader: {
        getEntries(): readonly BranchEntry[];
    }, owner: NativeRecoveryOwner): NativeRecoveryBinding;
}
export interface SessionEntryLookup {
    getLeafEntry(): (BranchEntry & {
        id?: string;
        parentId?: string | null;
    }) | undefined;
    getEntry(id: string): (BranchEntry & {
        id?: string;
        parentId?: string | null;
    }) | undefined;
}
export interface PassiveStopBoundary {
    at: number;
    from?: number;
    preserveContext?: true;
    /** A same-owner failed mode change remains a write fence until a later accepted checkpoint. */
    persistenceError?: string;
    /** The inactive mode selected by that failed change; legacy markers omit it. */
    mode?: InactiveMode;
    /** Native-only Off choice; canonical runtime mode is deliberately not updated. */
    memoryDeferred?: true;
}
export interface SnapshotDiscovery {
    candidates: unknown[];
    errors: string[];
}
/** Enumerate active-branch snapshots newest-first while containing hostile entries. */
export declare function discoverSnapshotData(branch: readonly BranchEntry[]): SnapshotDiscovery;
/** Read native mode policy only; semantic checkpoint validity remains the recovery owner's concern. */
export declare function findBranchPolicy(branch: readonly BranchEntry[], sessionId: string | undefined, stopEntryType: string | undefined, inactiveMode: InactiveMode): {
    mode: StateFlowMode;
    persistenceError?: string;
} | undefined;
/** Checkpoint-only preflight: no Stop/fork precedence, installation or authority. Invalid owned data cannot fall back. */
export declare function prepareBranchCheckpointPolicy(branch: readonly BranchEntry[], legacySelection: ScopeSelection, inactiveMode?: InactiveMode): RetainedPolicyMigrationCandidate | undefined;
/** Native-only policy/bookkeeping. This marker never grants canonical memory or parent-copy authority. */
export interface SelectedNativePolicyMarker {
    version: 2;
    owner: string;
    mode: StateFlowMode;
    scopes: ScopeSelection;
    reset?: true;
    forkPending?: true;
    at?: number;
    from?: number;
    preserveContext?: true;
    persistenceError?: string;
    memoryDeferred?: true;
}
/** Closed v2 writer value. Legacy records are translated only in branch context, never given a fabricated owner. */
export declare function captureSelectedNativeMarker(value: unknown): SelectedNativePolicyMarker;
export interface SelectedBranchPolicyOptions {
    owner: string;
    markerEntryType: string;
    /** The caller chooses new-session versus inactive fallback mode; absence itself grants no acquisition. */
    defaults: {
        mode: StateFlowMode;
        scopes: ScopeSelection;
    };
    inactiveMode?: InactiveMode;
    /** Native fresh-fork fact only; no parent header or store lookup belongs in this resolver. */
    fork?: boolean;
}
export interface SelectedBranchPolicyCandidate {
    mode: StateFlowMode;
    scopes: ScopeSelection;
    source: "default" | "checkpoint" | "marker";
    forkPending: boolean;
    stop?: PassiveStopBoundary;
    persistenceError?: string;
    requiresCapture: boolean;
    /** Policy-only capture preserves fences; only a separately owned acceptance may append reset/checkpoint. */
    capture: SelectedNativePolicyMarker;
}
/** Complete native branch admission only; never read canonical/parent files, attach policy or confer memory authority. */
export declare function prepareSelectedBranchPolicy(branch: readonly BranchEntry[], options: SelectedBranchPolicyOptions): SelectedBranchPolicyCandidate;
/** Native policy bookkeeping retains an unacquired fork across extension reloads. */
export declare function hasPendingFork(branch: readonly BranchEntry[], sessionId: string, entryType: string): boolean;
export declare function snapshotDataNewestFirst(branch: readonly BranchEntry[]): unknown[];
export declare function latestSnapshotData(branch: readonly BranchEntry[]): unknown;
export declare function hasPriorConversation(branch: readonly BranchEntry[]): boolean;
/** Native conversation after the latest valid checkpoint may contain uncompiled work, not a new semantic authority. */
export declare function hasUncheckpointedConversation(branch: readonly BranchEntry[]): boolean;
/** Auto-start eligibility is session identity/lifecycle, not the presence of CWD materialization. */
export declare function isNewSession(reason: unknown, branch: readonly BranchEntry[]): boolean;
export declare function findAssistantToolBatch(session: SessionEntryLookup, toolCallId: string): string[] | undefined;
export declare function findPassiveStopBoundary(branch: readonly BranchEntry[], sessionId: string, entryType: string): PassiveStopBoundary | undefined;
export declare function retainsPhysicalSessionProjection(reason: unknown): boolean;
export {};
