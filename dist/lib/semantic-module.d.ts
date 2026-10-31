import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type JsonObject, type JsonValue } from "./json.ts";
export type ModuleContextContribution = {
    kind: "data";
    value: JsonValue;
} | {
    kind: "conversation";
    indices: readonly number[];
};
export interface ModuleFrame<Input> {
    mode: "active" | "passive";
    conversation: readonly AgentMessage[];
    input: Input;
}
/** Internal trusted package code, not an effects sandbox or a stored-plane registration. */
export interface SemanticModule<Content extends JsonValue, Input = undefined> {
    readonly immutable: boolean;
    readonly id: string;
    validate(value: unknown): value is Content;
    context(content: Content | undefined, frame: ModuleFrame<Input>): readonly ModuleContextContribution[];
    produce?(content: Content | undefined, input: Input, signal: AbortSignal): Content | undefined | Promise<Content | undefined>;
}
/** Public host DTOs: shared owners receive neither native conversation nor current prompt. */
export interface StateFlowModuleSource {
    readonly mode: "active" | "passive";
    readonly scope: "global" | "cwd" | "session";
    readonly conversation: readonly AgentMessage[];
    readonly prompt?: string;
}
export interface StateFlowModuleFrame<Input extends JsonValue = JsonValue> extends StateFlowModuleSource {
    readonly input: Input | undefined;
}
export interface StateFlowModuleInput<Input extends JsonValue = JsonValue> {
    readonly value: Input;
    /** Verify only the captured source; throw if obsolete. No acquisition or async work. */
    assertCurrent(): void;
}
/** Published public v1 contract; retained descriptors govern durable compatibility. */
export interface StateFlowModule<Content extends JsonObject = JsonObject, Input extends JsonValue = JsonValue> {
    readonly immutable: boolean;
    readonly id: string;
    readonly apiVersion: 1;
    readonly schemaVersion: number;
    validate(value: unknown): value is Content;
    captureInput?(frame: StateFlowModuleSource, signal: AbortSignal): StateFlowModuleInput<Input> | Promise<StateFlowModuleInput<Input>>;
    context(content: Content | undefined, frame: StateFlowModuleFrame<Input>): readonly ModuleContextContribution[];
    produce?(content: Content | undefined, frame: StateFlowModuleFrame<Input>, signal: AbortSignal): Content | undefined | Promise<Content | undefined>;
}
/** Durable identity only: retained even while a definition is unavailable or content deleted. */
export interface RetainedModuleDescriptor {
    schemaVersion: number;
    immutable: boolean;
}
export type RetainedModules = Record<string, RetainedModuleDescriptor>;
export declare function validateRetainedModules(value: unknown): asserts value is RetainedModules;
/** Descriptors cannot be removed, recycled or implicitly change schema/policy. */
export declare function assertRetainedModules(previous: unknown, next: unknown): void;
export type EvaluatedModuleContext = {
    kind: "data";
    value: JsonValue;
} | {
    kind: "conversation";
    messages: readonly AgentMessage[];
};
/** Raw durable planes use JSON object values, independent of any definition callback. */
export declare function validateModuleObject(value: unknown): asserts value is JsonObject;
/** Context consumes captured data; conversation selections retain the host's exact original messages. */
export declare function evaluateModuleContext<Content extends JsonValue, Input>(module: SemanticModule<Content, Input>, content: unknown, frame: ModuleFrame<Input>): readonly EvaluatedModuleContext[];
/** Isolated public input/context capture; grants neither native nor publication authority. */
export interface PreparedModuleContext {
    assertCurrent(): void;
    evaluate(accepted?: {
        content: unknown;
    }): readonly EvaluatedModuleContext[];
    produce(): Promise<JsonObject | undefined>;
}
export declare function prepareModuleContext<Content extends JsonObject, Input extends JsonValue>(module: StateFlowModule<Content, Input>, content: unknown, source: StateFlowModuleSource, signal: AbortSignal, checkCurrent: () => void): Promise<PreparedModuleContext>;
/** Evaluate only: the host must separately bind the captured basis to its existing atomic acceptance. */
export declare function produceModuleContent<Content extends JsonValue, Input>(module: SemanticModule<Content, Input>, content: unknown, input: Input, signal: AbortSignal, checkCurrent: () => void): Promise<Content | undefined>;
