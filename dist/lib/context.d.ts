import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ArtifactInvalidationNotice, type ArtifactModelHints } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import type { Snapshot } from "./snapshot.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { type MaterializedState, type ModelState } from "./state.ts";
/** Refresh only our section; Pi owns system frames, tools and forced-prompt precedence. */
export declare function projectSystemProtocol(messages: AgentMessage[], protocol: string | undefined): AgentMessage[];
type LazyValueKind = "array" | "boolean" | "null" | "number" | "object" | "string";
/** Fixed-budget navigation only: never place lazy bodies or partial key catalogs in baseline context. */
export declare function lazyNavigationHint(state: MaterializedState): {
    available: boolean;
    path: string;
    keys?: Record<string, LazyValueKind>;
};
/** Context retained after semantic State Flow is stopped in this physical session. */
export interface PassiveContinuation {
    startedAt: number;
    activeRunStartedAt?: number;
    preserveContext?: true;
    handoff: AgentMessage;
}
export declare function syntheticUser(text: string): AgentMessage;
export declare function createPassiveContinuation(state: ModelState, startedAt?: number, activeRunStartedAt?: number, preserveContext?: boolean): PassiveContinuation;
/** Keep the interrupted run through later results; an idle stop retains only later conversation. */
export declare function passiveContinuationMessages(messages: AgentMessage[], continuation: PassiveContinuation): AgentMessage[];
export declare function runtimeContextMessage(snapshot: Snapshot, state: MaterializedState, recentTransitions?: RecentTransitionWindow, artifactInvalidations?: readonly ArtifactInvalidationNotice[], rehydrationPhase?: RehydrationPhase, artifactHints?: ArtifactModelHints): AgentMessage;
/** Captured identity survives text decoration; an uncertain boundary retains available context. */
export declare function currentRunTrajectory(messages: AgentMessage[], specification: string | undefined, anchorTimestamp: number | undefined): {
    messages: AgentMessage[];
    anchorTimestamp?: number;
};
export {};
