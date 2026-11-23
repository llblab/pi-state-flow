import type { ArtifactProvenanceRegistry } from "./artifact.ts";
import { type SessionAddress } from "./durable.ts";
import { type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { type ScopeSelection } from "./selection.ts";
import { type SelectedRetainedPiCheckpoint, type Snapshot, type StateFlowMode, type PrivateAcquisition } from "./snapshot.ts";
import type { MaterializedState, SemanticState, ScopeStateValues, StateScope } from "./state.ts";
import { type SelectedFilePublication, type SelectedSessionAcquisitionRequest, type SelectedForkCopyRequest, type SelectedModuleAdditions, type SelectedProvenanceUpdates } from "./storage.ts";
import { type SelectedTemporalState } from "./temporal.ts";
export interface SelectedRuntimePatchTransaction {
    readonly selection: ScopeSelection;
    readonly states: ScopeStateValues;
    readonly modules?: SelectedModuleAdditions;
    readonly snapshot: Snapshot;
    readonly causalBasis: string;
    readonly provenance: SelectedProvenanceUpdates;
    publish(snapshot: Snapshot, accepted?: AcceptedTransition, provenance?: SelectedProvenanceUpdates, moduleAdditions?: SelectedModuleAdditions): SelectedFilePublication;
}
export interface SelectedLifecycleInspection {
    readonly selection: ScopeSelection;
    readonly privateAcquisition: PrivateAcquisition;
    readonly snapshot: Snapshot;
}
/** Child policy recorded by the native fork; memory always comes from the parent's current files. */
export interface ForkLifecycle {
    mode: StateFlowMode;
    bootstrap?: true;
}
/** A replay target disappeared; reconcile it through current acceptance before retrying. */
export declare class SharedScopeRemovalConflictError extends Error {
    readonly scopes: readonly StateScope[];
    constructor(scopes: readonly StateScope[]);
}
/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export declare class TemporalRuntime {
    private memory;
    private acceptedCurrentMemory;
    private observedSessionAuthority;
    private privateAcquisitionEvidence?;
    readonly cwd: string;
    private readonly session;
    readonly root: string;
    readonly historyLimit: number;
    constructor(cwd: string, session: string | SessionAddress, root: string, sessionKey?: string, historyLimit?: number);
    get sessionId(): string;
    get sessionKey(): string;
    /** Revoke cache-dependent leases without forgetting known owner or acquisition evidence. */
    clearCache(): void;
    private rememberSessionAuthority;
    /** Only owned durable acceptance calls this; returned receipts and read-only candidates are not installers. */
    private installSelected;
    private installObserved;
    private observationGuard;
    private selectedReadCache;
    /** Last admitted lifecycle evidence for presentation only; future operations still check current files. */
    observedPrivateAcquisition(): PrivateAcquisition | "absent" | undefined;
    /** Detached read-only selected values; never accepted run fields or a publication/acquisition basis. */
    observedSelectedView(): SelectedTemporalState | undefined;
    /** Shared owners proven absent by a completed read-only observation; no empty streams are synthesized. */
    observedAbsentSharedScopes(): StateScope[];
    /** Explicit shared inspection before acquisition; missing owners stay unavailable rather than becoming empty streams. */
    refreshSelectedShared(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal, requireUnacquiredPrivate?: boolean): Promise<boolean>;
    /** Header-only disposition data; never semantic observation, acceptance, or acquisition permission. */
    inspectSelectedLifecycle(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<SelectedLifecycleInspection | undefined>;
    /** Native bookmarks never decide whether current canonical authority exists. */
    hasSelectedCurrentAuthority(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<boolean>;
    /** Fenced inactive restoration/operator inspection: source proof only, without conversion or durable acceptance. */
    refreshSelectedCurrent(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<Snapshot>;
    /** Detached accepted selected values only, never a file receipt or publication capability. */
    selectedView(): SelectedTemporalState | undefined;
    /** Accepted run fields only; local policy and pending native prompts remain the adapter's responsibility. */
    selectedSnapshot(): Snapshot;
    /** Native bookkeeping may change mode, never invent accepted run fields or a semantic boundary. */
    retainedSelectedCheckpoint(mode?: StateFlowMode): SelectedRetainedPiCheckpoint;
    /** Read-only cache identity lease; no source acquisition, storage receipt or publication authority. */
    captureSelectedReadBasis(): () => void;
    /** Exact present owners for the existing selected staging engine; no defaulted disabled scopes. */
    selectedStates(offset?: number): {
        selection: ScopeSelection;
        states: ScopeStateValues;
    };
    /** Runtime-owned artifact compilation evidence for one scope; never model-visible state. */
    artifactProvenance(scope: StateScope): ArtifactProvenanceRegistry;
    read(offset?: number, scope?: StateScope): MaterializedState;
    readView(offset?: number, scope?: StateScope): SemanticState;
    causalBasis(): string;
    recent(): RecentTransitionWindow;
    /** Authored under exclusion against validated live selected values; use the existing selected staging/commit engine. */
    withSelectedPatchTransaction<T>(action: (transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal, capturedTargets?: readonly StateScope[]): Promise<T>;
    /** Mode-only Passive persistence: exact accepted sources, no current-origin adoption or caller-authored run fields. */
    persistSelectedPassive(revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<SelectedFilePublication>;
    /** Precomputed replay remains tied to its accepted cache; changed selected shared targets conflict before publication. */
    publishSelected(snapshot: Snapshot, accepted: AcceptedTransition | undefined, revalidateNativePolicy: () => void, options?: {
        provenance?: SelectedProvenanceUpdates;
        moduleAdditions?: SelectedModuleAdditions;
        signal?: AbortSignal;
    }): Promise<SelectedFilePublication>;
    private withSelectedPublicationTransaction;
    private assertSelectedReplayTargets;
    /** New-session shared-only acceptance; caller rechecks native origin authority after waiting. */
    withSelectedSharedOriginTransaction<T>(selection: ScopeSelection, snapshot: Snapshot, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** Child-owned deferred marker only; no parent locator or parent memory is acquired here. */
    withSelectedDeferredForkTransaction<T>(selection: ScopeSelection, lifecycle: ForkLifecycle, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowDeferFork?: boolean, modeAtPublication?: () => StateFlowMode): Promise<T>;
    /** Explicit first private acquisition, never deferred-parent recovery or repair of lost acquired state. */
    withSelectedSessionAcquisitionTransaction<T>(request: SelectedSessionAcquisitionRequest, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowAcquirePrivate?: boolean): Promise<T>;
    /** Stage first lifecycle/semantic authoring into one origin acceptance, never an empty publication followed by a patch. */
    withSelectedFirstPatchTransaction<T>(selection: ScopeSelection, snapshot: Snapshot, action: (transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** Same-session current acceptance/authoring; native policy checks are synchronous under exclusion. */
    withSelectedCurrentTransaction<T>(selection: ScopeSelection, action: (current: Snapshot, publish: (snapshot?: Snapshot) => SelectedFilePublication, transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal, requiredPresent?: ScopeSelection): Promise<T>;
    /** Prepare may read persisted native identity outside exclusion; recheck must use in-memory native policy only. */
    withSelectedForkCopyTransaction<T>(request: SelectedForkCopyRequest, action: (publish: () => SelectedFilePublication) => T, revalidateDirectParent: (source: Readonly<SessionAddress>, phase: "prepare" | "recheck") => void, signal?: AbortSignal): Promise<T>;
    private withSelectedOriginAcceptance;
}
