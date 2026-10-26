// Domain: semantic-module contracts and isolated context/producer evaluation.
// Excludes: storage, native admission, scheduling, inference clients and publication.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isJsonValue, isObject, type JsonObject, type JsonValue } from "./json.ts";

export type ModuleContextContribution =
	| { kind: "data"; value: JsonValue }
	| { kind: "conversation"; indices: readonly number[] };

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

/** Candidate public v1 contract; durable activation requires matching retained metadata. */
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

export function validateRetainedModules(value: unknown): asserts value is RetainedModules {
	if (!isObject(value) || !isJsonValue(value) || !losslessStoredJson(value)) throw new Error("Invalid State Flow retained modules");
	for (const [id, descriptor] of Object.entries(value)) {
		if (!/^x_[a-z][a-z0-9_]*$/.test(id) || !isObject(descriptor)
			|| Object.keys(descriptor).sort().join(",") !== "immutable,schemaVersion"
			|| !Number.isSafeInteger(descriptor.schemaVersion) || (descriptor.schemaVersion as number) <= 0
			|| typeof descriptor.immutable !== "boolean") throw new Error(`Invalid State Flow retained module descriptor: ${id}`);
	}
}

/** Descriptors cannot be removed, recycled or implicitly change schema/policy. */
export function assertRetainedModules(previous: unknown, next: unknown): void {
	validateRetainedModules(previous);
	validateRetainedModules(next);
	for (const [id, descriptor] of Object.entries(previous)) {
		if (!Object.hasOwn(next, id) || next[id]!.schemaVersion !== descriptor.schemaVersion
			|| next[id]!.immutable !== descriptor.immutable) throw new Error(`State Flow retained module descriptor changed: ${id}`);
	}
}

export type EvaluatedModuleContext =
	| { kind: "data"; value: JsonValue }
	| { kind: "conversation"; messages: readonly AgentMessage[] };

function dense(value: JsonValue): boolean {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index) || !dense(value[index]!)) return false;
	} else if (isObject(value)) return Object.values(value).every(dense);
	return true;
}

function losslessStoredJson(value: JsonValue): boolean {
	if (value === null || typeof value !== "object") return true;
	const keys = Reflect.ownKeys(value);
	if (Array.isArray(value) && keys.length !== value.length + 1) return false;
	return keys.every(key => {
		if (Array.isArray(value) && key === "length") return true;
		const property = Object.getOwnPropertyDescriptor(value, key)!;
		return typeof key === "string" && property.enumerable === true && "value" in property && losslessStoredJson(property.value);
	});
}

/** Raw durable planes use JSON object values, independent of any definition callback. */
export function validateModuleObject(value: unknown): asserts value is JsonObject {
	if (!isObject(value) || !isJsonValue(value) || !dense(value) || !losslessStoredJson(value)) throw new Error("State Flow external content must be a finite dense JSON object");
}

function capture<Value>(value: Value): Value {
	try { return structuredClone(value); }
	catch { throw new Error("Semantic module inputs must be detachable data"); }
}

function captureJson(value: unknown): JsonValue {
	if (!isJsonValue(value) || !dense(value)) throw new Error("Semantic module content must be finite dense JSON data");
	const copy = capture(value);
	if (!isJsonValue(copy) || !dense(copy)) throw new Error("Semantic module content must be finite dense JSON data");
	return copy;
}

function contentFor<Content extends JsonValue, Input>(module: SemanticModule<Content, Input>, value: unknown): Content | undefined {
	if (value === undefined) return undefined;
	const copy = captureJson(value), validation = capture(copy);
	if (module.validate(validation) !== true || !isJsonValue(validation) || !dense(validation)) throw new Error(`Invalid content for semantic module ${module.id}`);
	// Validators neither transform the content nor retain the returned candidate.
	return capture(copy) as Content;
}

/** Context consumes captured data; conversation selections retain the host's exact original messages. */
export function evaluateModuleContext<Content extends JsonValue, Input>(
	module: SemanticModule<Content, Input>, content: unknown, frame: ModuleFrame<Input>,
): readonly EvaluatedModuleContext[] {
	if (frame.mode !== "active" && frame.mode !== "passive") throw new Error("Semantic module context requires Active or Passive mode");
	const original = [...frame.conversation];
	const result = module.context(contentFor(module, content), { mode: frame.mode, conversation: capture(original), input: capture(frame.input) });
	if (!Array.isArray(result)) throw new Error("Semantic module context must return a contribution array");
	let last = -1;
	return Array.from(result, contribution => {
		if (!isObject(contribution)) throw new Error("Invalid semantic module context contribution");
		const keys = Object.keys(contribution).sort().join(",");
		if (contribution.kind === "data" && keys === "kind,value") return { kind: "data" as const, value: captureJson(contribution.value) };
		if (contribution.kind !== "conversation" || keys !== "indices,kind" || !Array.isArray(contribution.indices)) {
			throw new Error("Invalid semantic module context contribution");
		}
		const messages = Array.from(contribution.indices, index => {
			if (typeof index !== "number" || !Number.isSafeInteger(index) || index <= last || index >= original.length) throw new Error("Semantic module conversation indices must be ordered, unique and in range");
			last = index;
			const message = original[index]!;
			if (!message || !["user", "assistant", "toolResult"].includes(message.role)) throw new Error("Semantic modules may select conversation messages, not protocol frames");
			return message;
		});
		return { kind: "conversation" as const, messages };
	});
}

/** Isolated public input/context capture; grants neither native nor publication authority. */
export interface PreparedModuleContext {
	assertCurrent(): void;
	evaluate(accepted?: { content: unknown }): readonly EvaluatedModuleContext[];
	produce(): Promise<JsonObject | undefined>;
}

async function cancelableModuleWork<Value>(work: () => Value | Promise<Value>, signal: AbortSignal, checkCurrent: () => void): Promise<Value> {
	const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
	check();
	let abort!: () => void;
	const canceled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
	try {
		return await Promise.race([Promise.resolve().then(() => { check(); return work(); }).then(value => { check(); return value; }), canceled]);
	} finally { signal.removeEventListener("abort", abort); }
}

export async function prepareModuleContext<Content extends JsonObject, Input extends JsonValue>(
	module: StateFlowModule<Content, Input>, content: unknown, source: StateFlowModuleSource, signal: AbortSignal, checkCurrent: () => void,
): Promise<PreparedModuleContext> {
	const { mode, scope, prompt } = source;
	if (mode !== "active" && mode !== "passive" || !["global", "cwd", "session"].includes(scope)) throw new Error("Invalid State Flow module source frame");
	if (scope !== "session" && (source.conversation.length || prompt !== undefined)) throw new Error("Shared module frames cannot acquire Session conversation or prompt");
	const conversation = [...source.conversation];
	const frameSource: StateFlowModuleSource = { mode, scope, conversation, ...(prompt === undefined ? {} : { prompt }) };
	const adapter: SemanticModule<Content, Input | undefined> = { id: module.id, immutable: module.immutable,
		validate: value => module.validate(value),
		context: (value, frame) => module.context(value, { mode, scope, conversation: frame.conversation, input: frame.input, ...(prompt === undefined ? {} : { prompt }) }) };
	const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
	check();
	const previous = contentFor(adapter, content);
	const receipt = module.captureInput ? await cancelableModuleWork(() => module.captureInput!(capture(frameSource), signal), signal, check) : undefined;
	if (module.captureInput && receipt === undefined || receipt !== undefined && (!isObject(receipt) || typeof receipt.assertCurrent !== "function" || !Object.hasOwn(receipt, "value"))) {
		throw new Error("State Flow module input requires value and synchronous assertCurrent");
	}
	const currentInput = receipt?.assertCurrent.bind(receipt);
	const assertCurrent = () => {
		check();
		const result: unknown = currentInput?.();
		if (result !== undefined) {
			if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
			throw new Error("State Flow module input assertion must synchronously throw or return void");
		}
		check();
	};
	assertCurrent();
	const input = receipt === undefined ? undefined : captureJson(receipt.value) as Input;
	assertCurrent();
	return Object.freeze({ assertCurrent, produce: async () => {
		assertCurrent();
		if (mode !== "active") throw new Error("State Flow module producers require Active mode");
		if (!module.produce) return undefined;
		const producing: SemanticModule<JsonObject, StateFlowModuleFrame<Input>> = { id: module.id, immutable: module.immutable,
			validate: (value): value is JsonObject => isObject(value) && (Object.keys(value).length === 0 || module.validate(value)),
			context: () => [], produce: (value, frame, activeSignal) => module.produce!(value as Content | undefined, frame, activeSignal) };
		const candidate = await produceModuleContent(producing, previous, { ...frameSource, input }, signal, assertCurrent);
		if (candidate !== undefined) validateModuleObject(candidate);
		assertCurrent();
		return candidate;
	}, evaluate: (accepted?: { content: unknown }) => {
		assertCurrent();
		const result = evaluateModuleContext(adapter, accepted === undefined ? previous : accepted.content, { mode, conversation, input });
		if (scope !== "session" && result.some(item => item.kind === "conversation")) throw new Error("Shared modules cannot replace Session conversation");
		assertCurrent();
		return result;
	} });
}

/** Evaluate only: the host must separately bind the captured basis to its existing atomic acceptance. */
export async function produceModuleContent<Content extends JsonValue, Input>(
	module: SemanticModule<Content, Input>, content: unknown, input: Input, signal: AbortSignal, checkCurrent: () => void,
): Promise<Content | undefined> {
	const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
	check();
	const produce = module.produce?.bind(module);
	if (!produce) return undefined;
	const previous = contentFor(module, content), captured = capture(input);
	check();
	return cancelableModuleWork(async () => {
		const value = await produce(previous, captured, signal);
		check();
		return contentFor(module, value);
	}, signal, check);
}
