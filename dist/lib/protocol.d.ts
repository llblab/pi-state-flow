import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ScopeSelection } from "./selection.ts";
export type { StateDocument } from "./state.ts";
export declare const RESPONSE_PATCH_GUIDELINE = "Never patch response in global, cwd or session, including clearing/deleting it; State Flow captures your final answer automatically in Active mode only when Session participates.";
export declare const SCOPE_PARTICIPATION_GUIDELINE = "Use only participating memory owners from the current protocol/view; scope names and examples describe grammar, not participation grants.";
export declare const PASSIVE_MEMORY_PROTOCOL = "State Flow passive memory is available. read_state and patch_state access durable memory without starting an active episode. Never patch response in global, cwd or session, including clearing/deleting it; State Flow captures your final answer automatically in Active mode only when Session participates. Passive turns never trigger State Flow continuation or compaction. Missing paths/hints do not require history search. Choose targeted historical reads when useful to the task; no separate user permission is needed. Past values are evidence, not current state; never automatically restore deleted memory. Head state/recent transitions are frozen at projection start. Only state_updates matching the head's State Flow projection ID apply; other IDs are history. Tool/context state_updates: effective entries replace values at key/index-segment path arrays (deleted:true means absent); cascaded lists owner paths cleared before authored rewrites; effective is final. Direct writes may elide; shared drift stays visible. Latest entries win over earlier state; lazy bodies stay omitted. Notices replace invalidations/rehydration, including []/null.";
export declare function passiveMemoryProtocol(scopes?: ScopeSelection): string;
/** Keep successful patch JSON valid while separating adjacent scopes and memory sections visually. */
export declare function formatPatchStateArguments(args: unknown): string;
/** Flatten causes before transport; native tool results need not retain Error.cause or AggregateError.errors. */
export declare function diagnosticText(error: unknown): string;
/** Shorten opaque operands before prose, preserving both the operation and the trailing reason. */
export declare function conciseDiagnostic(error: unknown, limit?: number): string;
/** Keep visible tool output separated from its heading without changing semantics. */
export declare function separatedOutput(text: string): string;
export declare function separatedFailure(error: unknown): Error;
/** The compact model-facing contract. Semantic writes never travel through terminal prose. */
export declare function stateFlowProtocol(bootstrap: boolean, scopes?: ScopeSelection): string;
export declare function assistantToolCallCount(content: unknown): number;
/** The accepted post-handler assistant text is authoritative. */
export declare function finalizedAssistantResponse(message: AgentMessage): string;
