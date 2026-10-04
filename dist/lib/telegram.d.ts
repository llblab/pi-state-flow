import type { StateFlowMode } from "./snapshot.ts";
import type { ScopeRevisions } from "./temporal.ts";
export declare const STATE_FLOW_TELEGRAM_ID = "@llblab/pi-state-flow";
/** Resolve the package export or the compiled sibling-extension layout used in local development. */
export declare function stateFlowTelegramSectionSpecifiers(moduleUrl?: string): string[];
export interface StateFlowTelegramSnapshot {
    /** The current session's selected mode. */
    mode: StateFlowMode;
    /** Failed Active restoration fences inference without silently selecting an inactive mode. */
    inferenceBlocked?: boolean;
    /** Legacy branch step retained for existing adapter ports; current runtime ports also supply owner revisions. */
    step: number;
    revisions?: ScopeRevisions;
    bootstrap: boolean;
    startPending: boolean;
}
export type StateFlowTelegramScope = "global" | "cwd" | "session" | "effective";
export interface StateFlowTelegramState {
    artifacts?: Record<string, unknown>;
    contract?: Record<string, unknown>;
    working?: Record<string, unknown>;
    intents?: Record<string, unknown>;
    response?: string;
    lazy?: unknown;
}
export type StateFlowTelegramRichText = string | StateFlowTelegramRichText[] | {
    type: "bold" | "code";
    text: StateFlowTelegramRichText;
};
export type StateFlowTelegramRichBlock = {
    type: "heading";
    text: StateFlowTelegramRichText;
    size: 3;
} | {
    type: "pre";
    text: StateFlowTelegramRichText;
    language?: string;
} | {
    type: "details";
    summary: StateFlowTelegramRichText;
    blocks: StateFlowTelegramRichBlock[];
    is_open?: true;
};
export interface StateFlowTelegramRichMessage {
    blocks: StateFlowTelegramRichBlock[];
    skip_entity_detection?: boolean;
}
export interface StateFlowTelegramButton {
    text: string;
    callback_data: string;
}
export interface StateFlowTelegramView {
    text: string;
    parseMode?: "markdown" | "html" | "plain";
    replyMarkup?: {
        inline_keyboard: StateFlowTelegramButton[][];
    };
}
export interface StateFlowTelegramSectionContext {
    callbackData(action: string, payload?: string): string;
    edit(view: StateFlowTelegramView): Promise<void>;
    openRich(message: StateFlowTelegramRichMessage): Promise<void>;
    answerCallback(text?: string): Promise<void>;
}
export interface StateFlowTelegramCallbackContext extends StateFlowTelegramSectionContext {
    action: string;
    payload: string;
}
export interface StateFlowTelegramSectionModule {
    registerTelegramSection(section: {
        id: string;
        label: string;
        getLabel?: () => string;
        render: (ctx: StateFlowTelegramSectionContext) => StateFlowTelegramView | Promise<StateFlowTelegramView>;
        handleCallback?: (ctx: StateFlowTelegramCallbackContext) => "handled" | "pass" | Promise<"handled" | "pass">;
    }): () => void;
}
export interface StateFlowTelegramModules {
    sections?: StateFlowTelegramSectionModule;
}
export type StateFlowTelegramLoader = () => Promise<StateFlowTelegramModules>;
export interface StateFlowTelegramControlResult {
    ok: boolean;
    message: string;
    /** A completed control can lose its presentation authority after a mode or selection change. */
    signal?: AbortSignal;
}
export interface StateFlowTelegramInspection {
    state: StateFlowTelegramState;
    revisions: ScopeRevisions;
    /** A selection can revoke a completed observation before the adapter presents it. */
    signal?: AbortSignal;
}
export interface StateFlowTelegramPort {
    snapshot(): StateFlowTelegramSnapshot;
    state(scope: StateFlowTelegramScope): StateFlowTelegramState;
    /** Optional additive capability; absent legacy ports retain their branch-step presentation. */
    revisions?(): ScopeRevisions;
    /** Active may need a settled native boundary; inactive modes apply immediately. */
    canStartNow(): boolean;
    /** Select the current session's mode through the same lifecycle owners as the terminal commands. */
    select(mode: StateFlowMode): StateFlowTelegramControlResult;
    deferStart(): void;
    cancelStart(): void;
}
export interface StateFlowTelegramInspectionPort extends Omit<StateFlowTelegramPort, "state" | "revisions" | "select"> {
    inspect(scope: StateFlowTelegramScope): StateFlowTelegramInspection | Promise<StateFlowTelegramInspection>;
    select(mode: StateFlowMode): StateFlowTelegramControlResult | Promise<StateFlowTelegramControlResult>;
}
export interface StateFlowTelegramAdapter {
    ensure(): Promise<boolean>;
    dispose(): void;
}
/** Main-menu section label shows only the current session mode. */
export declare function formatStateFlowSectionLabel(snapshot: StateFlowTelegramSnapshot): string;
export declare const STATE_FLOW_MODES: readonly ["off", "passive", "active"];
/** One radio-style mode row followed directly by read-only scope actions. */
export declare function buildStateFlowSectionView(snapshot: StateFlowTelegramSnapshot, callbackData: (action: string, payload?: string) => string): StateFlowTelegramView;
export declare function renderStateFlowRichState(scope: StateFlowTelegramScope, revisions: ScopeRevisions, state: StateFlowTelegramState): StateFlowTelegramRichMessage;
/** Default loader; injectable so tests and embedded hosts can control transport presence. */
export declare function loadStateFlowTelegramModules(): Promise<StateFlowTelegramModules>;
export declare function createStateFlowTelegramAdapter(options: {
    port: StateFlowTelegramPort | StateFlowTelegramInspectionPort;
    load?: StateFlowTelegramLoader;
}): StateFlowTelegramAdapter;
