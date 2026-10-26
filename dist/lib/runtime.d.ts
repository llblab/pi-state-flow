import { type SessionAddress } from "./durable.ts";
import { type ArtifactProvenance, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { publishTemporalStateToFiles, type SelectedFilePublication, type SelectedSessionAcquisitionRequest, type SelectedForkCopyRequest, type SelectedModuleAdditions, type SelectedProvenanceUpdates } from "./storage.ts";
import { type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { type RetainedPiCheckpoint, type SelectedRetainedPiCheckpoint, type Snapshot, type StateFlowMode, type PrivateAcquisition } from "./snapshot.ts";
import { type MaterializedState, type SemanticState, type ScopedSemanticStates, type ScopedStates, type ScopeStateValues, type StateScope } from "./state.ts";
import { type TemporalState, type SelectedTemporalState } from "./temporal.ts";
import { type ScopeSelection } from "./selection.ts";
export type RuntimePublication = ReturnType<typeof publishTemporalStateToFiles>;
export interface RuntimePatchTransaction {
    readonly states: ScopedSemanticStates;
    readonly causalBasis: string;
    readonly provenance: Record<StateScope, ArtifactProvenanceRegistry>;
    publish(snapshot: Snapshot, accepted?: AcceptedTransition, provenance?: Partial<Record<StateScope, Record<string, ArtifactProvenance>>>): RuntimePublication;
}
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
/** A targeted removed scope was deliberately adopted as empty before refusing the stale semantic patch. */
export declare class SharedScopeRemovalConflictError extends Error {
    readonly scopes: readonly StateScope[];
    constructor(scopes: readonly StateScope[]);
}
/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export declare class TemporalRuntime {
    private memory;
    /** Compatibility access to the legacy cache only; selected memory never masquerades as three owners. */
    get view(): TemporalState | undefined;
    set view(value: TemporalState | undefined);
    private base;
    private semanticRevision;
    private savedRuntime;
    /** Backend choice survives cache clearing but grants no origin, private acquisition or publication authority. */
    private selectedBackendChosen;
    private selectedOriginAccepted;
    private observedSessionAuthority;
    private observedPrivateSemantics;
    private transaction;
    private provenanceByScope;
    /** Shared scopes whose wholly absent live basis was accepted after one stale-target refusal. */
    private readonly absentSharedScopes;
    readonly cwd: string;
    private readonly session;
    readonly root: string;
    readonly historyLimit: number;
    constructor(cwd: string, session: string | SessionAddress, root: string, sessionKey?: string, historyLimit?: number);
    get sessionId(): string;
    get sessionKey(): string;
    private rememberSessionAuthority;
    private assertLegacyAdmission;
    /** Only owned durable acceptance calls this; returned receipts and read-only candidates are not installers. */
    private installSelected;
    private clearLegacyBasis;
    private installObserved;
    private observationGuard;
    private selectedReadCache;
    /** Detached read-only selected values; never accepted run fields or a publication/acquisition basis. */
    observedSelectedView(): SelectedTemporalState | undefined;
    /** Explicit shared inspection before acquisition; missing owners stay unavailable rather than becoming empty streams. */
    refreshSelectedShared(selection: ScopeSelection, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<boolean>;
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
    /** Read canonical shared memory without creating, migrating, or publishing storage. */
    loadPassive(): boolean;
    private loadPassiveBase;
    /** Select canonical file acceptance even when Git is available; backup remains a later concern. */
    prepareCanonical(): void;
    /** Canonical preparation is the default; Git backup is a later independent concern. */
    prepare(): void;
    read(offset?: number, scope?: StateScope): MaterializedState;
    readView(offset?: number, scope?: StateScope): SemanticState;
    states(): ScopedStates;
    causalBasis(): string;
    /** Encode Pi lifecycle state against the current retained semantic boundary. */
    retainedCheckpoint(snapshot: Snapshot): RetainedPiCheckpoint;
    usesCanonicalFiles(): boolean;
    recent(): RecentTransitionWindow;
    /** Await a coherent read-only recovery view; this neither activates policy nor accepts publication authority. */
    refreshCurrentMemory(signal?: AbortSignal): Promise<Snapshot | undefined>;
    private loadCurrentMemoryBase;
    initialize(snapshot: Snapshot, allowCreateCwd: boolean, expectedShared?: Pick<ScopedStates, "global" | "cwd">, newSessionOrigin?: boolean): RuntimePublication | undefined;
    private initializeOrigin;
    /** Copy the private origin and apply configured retention folding, preserving live shared values/provenance. */
    private publishForkOrigin;
    /**
     * Reconcile untouched shared-scope drift against the current proven live basis.
     *
     * A restored branch can lag behind live global/CWD state. Untouched shared scopes adopt
     * the current live streams at a fresh origin; a shared scope the accepted transition
     * actually changes remains a fail-closed write conflict. Divergence in non-adoptable
     * session or runtime files also fails closed under the existing race rule.
     */
    private reconcileSharedDrift;
    /** Await coherent shared inspection, lazily loading an empty private view only when none is selected. */
    refreshShared(signal?: AbortSignal): Promise<boolean>;
    /** Prepare current shared state while retaining the exact accepted private publication basis. */
    private publicationCandidate;
    /** Stage and accept synchronously inside an awaited lock; expose neither selection nor raw storage operations. */
    withPatchTransaction<T>(action: (transaction: RuntimePatchTransaction) => T, signal?: AbortSignal): Promise<T>;
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
    /** Activate current owned memory; the caller must authorize a wholly absent private origin after waiting. */
    withStartTransaction<T>(action: (current: Snapshot | undefined, publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** New-session shared-only acceptance; caller rechecks native origin authority after waiting. */
    withSelectedSharedOriginTransaction<T>(selection: ScopeSelection, snapshot: Snapshot, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** Child-owned deferred marker only; no parent locator or parent memory is acquired here. */
    withSelectedDeferredForkTransaction<T>(selection: ScopeSelection, lifecycle: ForkLifecycle, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowDeferFork?: boolean, modeAtPublication?: () => StateFlowMode): Promise<T>;
    /** Explicit first private acquisition, never deferred-parent recovery or repair of lost acquired state. */
    withSelectedSessionAcquisitionTransaction<T>(request: SelectedSessionAcquisitionRequest, action: (publish: () => SelectedFilePublication) => T, signal?: AbortSignal, allowAcquirePrivate?: boolean): Promise<T>;
    /** Stage first lifecycle/semantic authoring into one origin acceptance, never an empty publication followed by a patch. */
    withSelectedFirstPatchTransaction<T>(selection: ScopeSelection, snapshot: Snapshot, action: (transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** Same-session current acceptance/authoring; native policy checks are synchronous under exclusion. */
    withSelectedCurrentTransaction<T>(selection: ScopeSelection, action: (current: Snapshot, publish: (snapshot?: Snapshot) => SelectedFilePublication, transaction: SelectedRuntimePatchTransaction) => T, revalidateNativePolicy: () => void, signal?: AbortSignal): Promise<T>;
    /** Prepare may read persisted native identity outside exclusion; recheck must use in-memory native policy only. */
    withSelectedForkCopyTransaction<T>(request: SelectedForkCopyRequest, action: (publish: () => SelectedFilePublication) => T, revalidateDirectParent: (source: Readonly<SessionAddress>, phase: "prepare" | "recheck") => void, signal?: AbortSignal): Promise<T>;
    private withSelectedOriginAcceptance;
    /** Copy the parent's current session memory into an unoccupied child; the caller rechecks native selection after waiting. */
    withForkTransaction<T>(source: SessionAddress, lifecycle: ForkLifecycle, action: (selected: Snapshot, publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal): Promise<T>;
    private prepareForkCandidate;
    /** Recheck caller policy after waiting, then accept only config/runtime over an already accepted private basis. */
    withLifecycleTransaction<T>(action: (publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal): Promise<T>;
    private withPublicationTransaction;
    publish(snapshot: Snapshot, semantic?: boolean, accepted?: AcceptedTransition, options?: {
        provenance?: Partial<Record<StateScope, Record<string, ArtifactProvenance>>>;
    }): RuntimePublication | undefined;
}
