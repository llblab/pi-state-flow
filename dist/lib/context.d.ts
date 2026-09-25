import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ArtifactInvalidationNotice, type ArtifactModelHints } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { type JsonValue } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { type AtomicScopePatches, type MaterializedState, type ModelState } from "./state.ts";
/** Refresh only our section; Pi owns system frames, tools and forced-prompt precedence. */
export declare function projectSystemProtocol(messages: AgentMessage[], protocol: string | undefined): AgentMessage[];
type LazyValueKind = "array" | "boolean" | "null" | "number" | "object" | "string";
/** Fixed-budget navigation only: never place lazy bodies or partial key catalogs in baseline context. */
export declare function lazyNavigationHint(state: MaterializedState): {
    available: boolean;
    path: string;
    keys?: Record<string, LazyValueKind>;
};
export type ModelStateUpdate = {
    path: (string | number)[];
} & ({
    value: JsonValue;
} | {
    deleted: true;
});
/** Exact projected replacements, not authored merge patches; paths are unambiguous key/index segments. */
export declare function acceptedStateUpdates(before: MaterializedState, after: MaterializedState, patches: AtomicScopePatches): {
    effective: ModelStateUpdate[];
    lazy_navigation?: {
        available: boolean;
        path: string;
        keys?: Record<string, LazyValueKind>;
    } | undefined;
};
export interface ContextView {
    state: ModelState;
    lazy_navigation?: ReturnType<typeof lazyNavigationHint>;
    artifact_invalidations: readonly ArtifactInvalidationNotice[];
    knowledge_rehydration: {
        phase: RehydrationPhase;
    } | null;
}
export declare function contextView(state: MaterializedState, hints: ArtifactModelHints, invalidations: readonly ArtifactInvalidationNotice[], phase?: RehydrationPhase): ContextView;
/** Volatile model projection only. Native messages own trajectory; this cache owns no persistence or lifecycle. */
export declare class ContextProjection {
    private identity;
    private head;
    private view;
    private native;
    private notices;
    reset(): void;
    /** Called only after successful publication and ancillary acceptance, immediately before returning the native result. */
    acceptPatch(before: MaterializedState, after: MaterializedState, patches: AtomicScopePatches, hints: ArtifactModelHints): {
        effective: ModelStateUpdate[];
        lazy_navigation?: {
            available: boolean;
            path: string;
            keys?: Record<string, LazyValueKind>;
        } | undefined;
        projection: `${string}-${string}-${string}-${string}-${string}`;
    } | undefined;
    project(messages: AgentMessage[], current: ContextView, makeHead: () => AgentMessage, initial?: ContextView): AgentMessage[];
}
/** Context retained after semantic State Flow is stopped in this physical session. */
export interface PassiveContinuation {
    startedAt: number;
    activeRunStartedAt?: number;
    preserveContext?: true;
    handoff: AgentMessage;
    state: ModelState;
}
export declare function syntheticUser(text: string): AgentMessage;
export declare function createPassiveContinuation(state: ModelState, startedAt?: number, activeRunStartedAt?: number, preserveContext?: boolean): PassiveContinuation;
/** Keep the interrupted run through later results; an idle stop retains only later conversation. */
export declare function passiveContinuationMessages(messages: AgentMessage[], continuation: PassiveContinuation): AgentMessage[];
export declare function runtimeContextMessage(snapshot: Snapshot, state: MaterializedState, recentTransitions?: RecentTransitionWindow, artifactInvalidations?: readonly ArtifactInvalidationNotice[], rehydrationPhase?: RehydrationPhase, artifactHints?: ArtifactModelHints): AgentMessage;
/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export declare function runtimeContextHead(snapshot: Snapshot, view: ContextView, recentTransitions?: RecentTransitionWindow): AgentMessage;
/** Captured identity survives text decoration; an uncertain boundary retains available context. */
export declare function currentRunTrajectory(messages: AgentMessage[], specification: string | undefined, anchorTimestamp: number | undefined): {
    messages: AgentMessage[];
    anchorTimestamp?: number;
};
export {};
