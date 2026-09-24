import type { AgentMessage } from "@earendil-works/pi-agent-core";
export type { StateDocument } from "./state.ts";
export declare const PASSIVE_MEMORY_PROTOCOL = "State Flow passive memory is available. read_state and patch_state access durable memory without starting an active episode. Passive turns never trigger State Flow continuation or compaction. Missing paths/hints do not require history search. Choose targeted historical reads when useful to the task; no separate user permission is needed. Past values are evidence, not current state; never automatically restore deleted memory.";
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
export declare function stateFlowProtocol(bootstrap: boolean): string;
export declare function assistantToolCallCount(content: unknown): number;
/** The accepted post-handler assistant text is authoritative. */
export declare function finalizedAssistantResponse(message: AgentMessage): string;
