export type StateFlowDiagnosticCategory = "invalid-patch" | "publication-conflict" | "finalization";
/** Minimal structural block; only ordinary text keeps its exact content. */
export interface StateFlowDiagnosticBlock {
    type: string;
    text?: string;
}
export interface StateFlowDiagnosticRecord {
    at: string;
    sessionId: string;
    cwd: string;
    category: StateFlowDiagnosticCategory;
    error: string;
    content?: StateFlowDiagnosticBlock[];
    /** Rejected tool arguments, captured for reproducible diagnosis. Never reasoning bodies. */
    input?: unknown;
    tool?: string;
    toolCallId?: string;
}
/** Preserve exact text blocks and block boundaries; reasoning bodies are never duplicated. */
export declare function projectDiagnosticContent(content: unknown): StateFlowDiagnosticBlock[];
/** Diagnostic JSONL lives beneath the active Pi agent directory, never inside the state repository. */
export declare function stateFlowLogPath(agentDir: string): string;
export declare function appendStateFlowDiagnostic(path: string, record: StateFlowDiagnosticRecord): void;
export interface DiagnosticExtras {
    content?: unknown;
    input?: unknown;
    tool?: string;
    toolCallId?: string;
}
/** Own diagnostic path safety, projection, persistence, and one-shot failure reporting. */
export declare class StateFlowDiagnosticWriter {
    private warningReported;
    private readonly enabled;
    private readonly path;
    private readonly repositoryRoot;
    private readonly notify;
    constructor(enabled: boolean, path: string, repositoryRoot: string, notify: (message: string) => void);
    record(sessionId: string, cwd: string, error: string, category: StateFlowDiagnosticCategory, extras?: DiagnosticExtras): void;
    /** Push warnings stay short; retain the available Git failure detail locally even without opt-in logging. */
    recordBackupPushFailure(sessionId: string, cwd: string, error: string): boolean;
    private write;
}
