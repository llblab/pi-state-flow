import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ArtifactInvalidationNotice, type ArtifactModelHints } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { type JsonValue } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";
import { type OwnedPath } from "./ownership.ts";
import { type ScopeSelection } from "./selection.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { type AtomicScopePatches, type SemanticState, type StateScope } from "./state.ts";
import { type EvaluatedModuleContext, type ModuleFrame, type SemanticModule } from "./semantic-module.ts";
/** Refresh only our section; Pi owns system frames, tools and forced-prompt precedence. */
export declare function projectSystemProtocol(messages: AgentMessage[], protocol: string | undefined): AgentMessage[];
/** Compatibility facade; the lazy plane owns the unchanged navigation policy. */
export declare function lazyNavigationHint(state: SemanticState): import("./planes.ts").LazyNavigation;
/** Materialize module contributions only; native context selection/replacement authority stays with the host. */
export declare function semanticModuleMessages<Content extends JsonValue, Input>(module: SemanticModule<Content, Input>, content: unknown, frame: ModuleFrame<Input>): AgentMessage[];
export type ModelStateUpdate = {
    path: (string | number)[];
} & ({
    value: JsonValue;
} | {
    deleted: true;
});
/** Exact projected replacements, not authored merge patches; paths are unambiguous key/index segments. */
export declare function acceptedStateUpdates(before: SemanticState, after: SemanticState, patches: AtomicScopePatches): {
    effective: ModelStateUpdate[];
    lazy_navigation?: import("./planes.ts").LazyNavigation | undefined;
};
export interface ContextView {
    /** Wanted presentation DATA only; never infer it from available state or use it as authority. */
    modelScopes?: ScopeSelection;
    state: SemanticState;
    lazy_navigation?: ReturnType<typeof lazyNavigationHint>;
    artifact_invalidations: readonly ArtifactInvalidationNotice[];
    knowledge_rehydration: {
        phase: RehydrationPhase;
    } | null;
}
export declare function contextView(state: SemanticState, hints: ArtifactModelHints, invalidations: readonly ArtifactInvalidationNotice[], phase?: RehydrationPhase, includeResponse?: boolean, modelScopes?: ScopeSelection): ContextView;
/** Same owned passive envelope as before, with presentation chosen from captured wanted DATA. */
export declare function passiveContextHead(view: ContextView): AgentMessage;
/** Volatile model projection only. Native messages own trajectory; this cache owns no persistence or lifecycle. */
export declare class ContextProjection {
    private identity;
    private head;
    private view;
    private native;
    private notices;
    reset(): void;
    /** Called only after successful publication and ancillary acceptance, immediately before returning the native result. */
    acceptPatch(before: SemanticState, after: SemanticState, patches: AtomicScopePatches, hints: ArtifactModelHints, cascades?: Partial<Record<StateScope, readonly OwnedPath[]>>, includeResponse?: boolean, modelScopes?: ScopeSelection): {
        effective: ModelStateUpdate[];
        lazy_navigation?: import("./planes.ts").LazyNavigation | undefined;
        projection: `${string}-${string}-${string}-${string}-${string}`;
        cascaded?: string[] | undefined;
    } | undefined;
    project(messages: AgentMessage[], current: ContextView, makeHead: () => AgentMessage, initial?: ContextView): AgentMessage[];
}
/** Context retained after semantic State Flow is stopped in this physical session. */
export interface PassiveContinuation {
    startedAt: number;
    activeRunStartedAt?: number;
    preserveContext?: true;
    handoff: AgentMessage;
    state: SemanticState;
}
export declare function syntheticUser(text: string): AgentMessage;
/** A unique native user anchor admits completed conversation, never the current run or protocol frames. */
export declare function moduleConversationSource(messages: readonly AgentMessage[], anchorTimestamp: number | undefined): {
    conversation: readonly AgentMessage[];
    prompt?: string;
};
export interface ScopedModuleContext {
    id: string;
    scope: StateScope;
    contributions: readonly EvaluatedModuleContext[];
}
/** Provider projection only: preserve current/foreign identities and allow one explicit completed-history selector. */
export declare function projectModuleContext(projected: AgentMessage[], original: readonly AgentMessage[], conversation: readonly AgentMessage[], modules: readonly ScopedModuleContext[]): AgentMessage[];
export declare function createPassiveContinuation(state: SemanticState, startedAt?: number, activeRunStartedAt?: number, preserveContext?: boolean, modelScopes?: ScopeSelection): PassiveContinuation;
/** Keep the interrupted run through later results; an idle stop retains only later conversation. */
export declare function passiveContinuationMessages(messages: AgentMessage[], continuation: PassiveContinuation): AgentMessage[];
export declare function runtimeContextMessage(snapshot: Snapshot, state: SemanticState, recentTransitions?: RecentTransitionWindow, artifactInvalidations?: readonly ArtifactInvalidationNotice[], rehydrationPhase?: RehydrationPhase, artifactHints?: ArtifactModelHints): AgentMessage;
/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export declare function runtimeContextHead(snapshot: Snapshot, view: ContextView, recentTransitions?: RecentTransitionWindow): AgentMessage;
/** Captured identity survives text decoration; an uncertain boundary retains available context. */
export declare function currentRunTrajectory(messages: AgentMessage[], specification: string | undefined, anchorTimestamp: number | undefined): {
    messages: AgentMessage[];
    anchorTimestamp?: number;
};
