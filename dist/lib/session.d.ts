export declare const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";
interface BranchEntry {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
    message?: {
        role?: unknown;
    };
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
    /** A same-owner failed Stop remains a write fence until a later accepted checkpoint. */
    persistenceError?: string;
}
export interface SnapshotDiscovery {
    candidates: unknown[];
    errors: string[];
}
/** Enumerate active-branch snapshots newest-first while containing hostile entries. */
export declare function discoverSnapshotData(branch: readonly BranchEntry[]): SnapshotDiscovery;
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
