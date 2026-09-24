export type ContinuationTransport = "local" | "sdk" | "telegram" | string;
export interface ContinuationHostContext {
    cwd: string;
    agentDir: string;
    sessionDir: string;
    transport: ContinuationTransport;
}
export type ContinuationHostIntent = {
    kind: "default";
} | {
    kind: "new";
} | {
    kind: "resume-exact";
    sessionFile: string;
    sessionId: string;
} | {
    kind: "native-picker";
} | {
    kind: "continue-recent";
} | {
    kind: "no-session";
};
export interface ContinuationCandidateSummary {
    sessionFile: string;
    sessionId: string;
    lastActivity: string;
    reason: string;
}
export type ContinuationRecommendation = {
    action: "resume";
    sessionFile: string;
    sessionId: string;
    reason: "latest-enabled-state-flow";
} | {
    action: "choose";
    candidates: ContinuationCandidateSummary[];
    reason: "ambiguous";
} | {
    action: "new";
    reason: "none" | "last-not-state-flow" | "ineligible";
};
export type ContinuationStartupDecision = ContinuationRecommendation | {
    action: "new";
    reason: "explicit-new";
} | {
    action: "resume";
    sessionFile: string;
    sessionId: string;
    reason: "explicit-resume";
} | {
    action: "native";
    mode: "picker" | "continue-recent" | "no-session";
};
export interface ContinuationProjectIdentity {
    profile: string;
    cwd: string;
    gitCommonDir?: string;
    worktree?: string;
    branch?: string;
    transport: ContinuationTransport;
}
export interface ContinuationSessionCandidate extends ContinuationCandidateSummary {
    profile: string;
    cwd: string;
    gitCommonDir?: string;
    worktree?: string;
    branch?: string;
    transport: ContinuationTransport;
    lifecycle: "open" | "closed" | "archived";
    doNotAutoResume?: boolean;
    stateFlow: {
        enabled: boolean;
        restorable: boolean;
    };
}
export type ContinuationRecommender = (context: Readonly<ContinuationHostContext>, signal?: AbortSignal) => ContinuationRecommendation | Promise<ContinuationRecommendation>;
/** Rank already header/provenance-only candidates without transcript content or I/O. */
export declare function recommendContinuationFromProvenance(identity: ContinuationProjectIdentity, candidates: readonly ContinuationSessionCandidate[]): ContinuationRecommendation;
export declare function resolveContinuationStartup(context: ContinuationHostContext, intent: ContinuationHostIntent, recommend: ContinuationRecommender, signal?: AbortSignal): Promise<ContinuationStartupDecision>;
export interface NativeSessionHeader {
    file: string;
    id: string;
    cwd: string;
    timestamp: string;
    lastActivity: string;
}
export interface ContinuationCandidateProvenance {
    profile: string;
    gitCommonDir?: string;
    worktree?: string;
    branch?: string;
    transport: ContinuationTransport;
    lifecycle: "open" | "closed" | "archived";
    doNotAutoResume?: boolean;
    stateFlow: {
        enabled: boolean;
        restorable: boolean;
    };
    reason: string;
}
export declare function readNativeSessionHeader(path: string): NativeSessionHeader;
export declare function discoverNativeSessionHeaders(sessionDir: string): {
    headers: NativeSessionHeader[];
    invalid: Array<{
        file: string;
        error: string;
    }>;
};
/** Await one exact canonical cohort; never read transcript bodies, initialize, or publish. */
export declare function inspectStateFlowContinuationProvenance(header: Readonly<NativeSessionHeader>, repositoryRoot: string, signal?: AbortSignal): Promise<Pick<ContinuationCandidateProvenance, "stateFlow" | "reason">>;
export declare function buildContinuationCandidates(headers: readonly NativeSessionHeader[], inspect: (header: Readonly<NativeSessionHeader>, signal?: AbortSignal) => ContinuationCandidateProvenance | undefined | Promise<ContinuationCandidateProvenance | undefined>, signal?: AbortSignal): Promise<ContinuationSessionCandidate[]>;
