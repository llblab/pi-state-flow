import { type SessionAddress } from "./durable.ts";
import { type ArtifactProvenance, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { publishTemporalStateToFiles } from "./storage.ts";
import { type AcceptedTransition, type RecentTransitionWindow } from "./history.ts";
import { type RetainedBoundaryCheckpoint, type RetainedPiCheckpoint, type Snapshot } from "./snapshot.ts";
import { type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";
import { type TemporalState } from "./temporal.ts";
export type RuntimePublication = ReturnType<typeof publishTemporalStateToFiles>;
export interface RuntimePatchTransaction {
    readonly states: ScopedStates;
    readonly causalBasis: string;
    readonly provenance: Record<StateScope, ArtifactProvenanceRegistry>;
    publish(snapshot: Snapshot, accepted?: AcceptedTransition, provenance?: Partial<Record<StateScope, Record<string, ArtifactProvenance>>>): RuntimePublication;
}
/** A targeted removed scope was deliberately adopted as empty before refusing the stale semantic patch. */
export declare class SharedScopeRemovalConflictError extends Error {
    readonly scopes: readonly StateScope[];
    constructor(scopes: readonly StateScope[]);
}
/** Cached branch-selected temporal state and publication basis; excludes Pi event policy. */
export declare class TemporalRuntime {
    view: TemporalState | undefined;
    private base;
    private semanticRevision;
    private savedRuntime;
    private transaction;
    private restoredOriginPending;
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
    states(): ScopedStates;
    causalBasis(): string;
    /** Encode Pi lifecycle state against the current retained semantic boundary. */
    retainedCheckpoint(snapshot: Snapshot): RetainedPiCheckpoint;
    usesCanonicalFiles(): boolean;
    recent(): RecentTransitionWindow;
    /** Prepare a retained session boundary from current canonical files; shared scopes remain live. */
    prepareBoundaryRestore(checkpoint: RetainedBoundaryCheckpoint): {
        snapshot: Snapshot;
        restore: () => Snapshot;
    };
    private prepareBoundaryRestoreBase;
    /** Restore and canonically accept one retained boundary as a single lifecycle operation. */
    restoreBoundary(checkpoint: RetainedBoundaryCheckpoint): {
        snapshot: Snapshot;
        publication: RuntimePublication;
    };
    /** Await a coherent read-only recovery view; this neither activates policy nor accepts publication authority. */
    refreshCurrentMemory(signal?: AbortSignal): Promise<Snapshot | undefined>;
    private loadCurrentMemoryBase;
    /** Copy one retained source-session boundary over the child's current shared scopes. */
    prepareBoundaryFork(source: SessionAddress, checkpoint: RetainedBoundaryCheckpoint): {
        snapshot: Snapshot;
        fork: () => {
            snapshot: Snapshot;
            publication: RuntimePublication;
        };
    };
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
    /** Activate current owned memory; the caller must authorize a wholly absent private origin after waiting. */
    withStartTransaction<T>(action: (current: Snapshot | undefined, publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal, allowCreateOrigin?: boolean): Promise<T>;
    /** Select one retained private boundary beside current shared streams, then accept only after caller policy is rechecked. */
    withRestoreTransaction<T>(checkpoint: RetainedBoundaryCheckpoint, action: (selected: Snapshot, publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal): Promise<T>;
    /** Copy exact retained parent authority into an unoccupied child; the caller rechecks native selection after waiting. */
    withForkTransaction<T>(source: SessionAddress, checkpoint: RetainedBoundaryCheckpoint, action: (selected: Snapshot, publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal): Promise<T>;
    private prepareForkCandidate;
    /** Recheck caller policy after waiting, then accept only config/runtime over an already accepted private basis. */
    withLifecycleTransaction<T>(action: (publish: (snapshot: Snapshot) => RuntimePublication) => T, signal?: AbortSignal): Promise<T>;
    private withPublicationTransaction;
    /** Canonically accept a prepared retained-boundary origin before lifecycle-only persistence. */
    acceptRestoredOrigin(snapshot: Snapshot): RuntimePublication;
    publish(snapshot: Snapshot, semantic?: boolean, accepted?: AcceptedTransition, options?: {
        provenance?: Partial<Record<StateScope, Record<string, ArtifactProvenance>>>;
    }): RuntimePublication | undefined;
}
