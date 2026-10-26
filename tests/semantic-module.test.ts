import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assertRetainedModules, validateRetainedModules, validateModuleObject, evaluateModuleContext, produceModuleContent, prepareModuleContext, type StateFlowModule, type StateFlowModuleInput, type SemanticModule } from "../lib/semantic-module.ts";
import { isObject, type JsonObject, type JsonValue } from "../lib/json.ts";

test("retained module identity and raw object validation never consult definition callbacks or accept lossy JSON shapes", () => {
	const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	validateRetainedModules(modules);
	assertRetainedModules(modules, { ...modules, x_new: { schemaVersion: 2, immutable: false } });
	for (const next of [{}, { x_acme_archive: { schemaVersion: 2, immutable: true } }, { x_acme_archive: { schemaVersion: 1, immutable: false } }]) {
		assert.throws(() => assertRetainedModules(modules, next), /descriptor changed/);
	}
	validateModuleObject(JSON.parse('{"__proto__":{},"empty":{},"array":[{},[]]}'));
	const sparse = new Array(1), extended = Object.assign([1], { extra: true });
	const hidden = Object.defineProperty({}, "lost", { value: true });
	const accessor = Object.defineProperty({}, "lost", { get: () => true, enumerable: true });
	for (const value of [sparse, extended, hidden, accessor, { [Symbol("lost")]: true }, Number.POSITIVE_INFINITY, undefined]) {
		assert.throws(() => validateModuleObject({ nested: value }), /finite dense JSON object/);
	}
	assert.throws(() => validateRetainedModules(Object.defineProperty({}, "x_hidden", { value: modules.x_acme_archive })), /retained modules/);
});

test("public producers use the original captured frame once and context can observe only explicitly accepted replacement content", async () => {
	let captures = 0, productions = 0, epoch = 1;
	const original = { note: "old", obsolete: true }, candidate = { note: "new" };
	const module: StateFlowModule = { id: "x_producing", apiVersion: 1, schemaVersion: 1, immutable: true, validate: isObject,
		captureInput: () => { captures++; const current = epoch; return { value: { epoch }, assertCurrent() { assert.equal(epoch, current, "stale producer input"); } }; },
		produce(content, frame) { productions++; assert.deepEqual(content, original); assert.deepEqual(frame.input, { epoch: 1 }); assert.equal(frame.scope, "cwd"); assert.deepEqual(frame.conversation, []); return candidate; },
		context: (content, frame) => [{ kind: "data", value: { content: content ?? "absent", input: frame.input! } }] };
	const prepared = await prepareModuleContext(module, original, { mode: "active", scope: "cwd", conversation: [] }, new AbortController().signal, () => {});
	const proposal = await prepared.produce(); candidate.note = "caller alias";
	assert.deepEqual(proposal, { note: "new" }); assert.deepEqual(original, { note: "old", obsolete: true });
	assert.deepEqual(prepared.evaluate(), [{ kind: "data", value: { content: original, input: { epoch: 1 } } }], "a proposal alone cannot replace captured context");
	assert.deepEqual(prepared.evaluate({ content: proposal }), [{ kind: "data", value: { content: { note: "new" }, input: { epoch: 1 } } }]);
	assert.deepEqual(prepared.evaluate({ content: undefined }), [{ kind: "data", value: { content: "absent", input: { epoch: 1 } } }]);
	assert.equal(captures, 1); assert.equal(productions, 1);
	epoch++; await assert.rejects(prepared.produce(), /stale producer input/);
	const passive = await prepareModuleContext(module, undefined, { mode: "passive", scope: "cwd", conversation: [] }, new AbortController().signal, () => {});
	await assert.rejects(passive.produce(), /Active/); assert.equal(productions, 1);
	const empty = await prepareModuleContext({ ...module, validate: (value): value is JsonObject => isObject(value) && typeof value.note === "string", produce: () => ({}) }, undefined, { mode: "active", scope: "cwd", conversation: [] }, new AbortController().signal, () => {});
	assert.deepEqual(await empty.produce(), {}, "empty object is an explicit deletion proposal, not no proposal");
});

test("public module inputs capture detached typed data and throwing original-source receipts in both modes", async () => {
	let epoch = 1, captured = 0;
	const input = { label: "original" }, content = { note: "stored" };
	const module: StateFlowModule<JsonObject, typeof input> = { id: "x_input", apiVersion: 1, schemaVersion: 1, immutable: false,
		validate: (value): value is JsonObject => { (value as JsonObject).note = "validator alias"; return true; },
		captureInput(source) { captured++; assert.equal(source.conversation.length, 0); assert.equal(source.prompt, undefined); const version = epoch; return { value: input, assertCurrent() { assert.equal(epoch, version, "source changed"); } }; },
		context(value, source) { assert.equal(value!.note, "stored"); assert.equal(source.input!.label, "original"); source.input!.label = "callback alias"; return [{ kind: "data", value: { label: "context", scope: source.scope, mode: source.mode } }]; } };
	for (const mode of ["active", "passive"] as const) {
		const prepared = await prepareModuleContext(module, content, { mode, scope: "cwd", conversation: [] }, new AbortController().signal, () => {});
		assert.deepEqual(prepared.evaluate(), [{ kind: "data", value: { label: "context", scope: "cwd", mode } }]);
		assert.deepEqual(input, { label: "original" }); assert.deepEqual(content, { note: "stored" });
		epoch++; assert.throws(prepared.assertCurrent, /source changed/); assert.throws(prepared.evaluate, /source changed/);
	}
	const before = captured;
	await assert.rejects(prepareModuleContext(module, content, { mode: "active", scope: "global", conversation: [], prompt: "private" }, new AbortController().signal, () => {}), /Shared/);
	assert.equal(captured, before);
	const shared: StateFlowModule = { ...module, context: () => [{ kind: "conversation", indices: [] }] };
	const prepared = await prepareModuleContext(shared, undefined, { mode: "passive", scope: "cwd", conversation: [] }, new AbortController().signal, () => {});
	assert.throws(prepared.evaluate, /Shared modules/);
});

test("public input capture cancels signal-ignoring work and refuses malformed or asynchronous assertions", async () => {
	let release!: (value: StateFlowModuleInput) => void, entered!: () => void, contexts = 0;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const module: StateFlowModule = { id: "x_async_input", apiVersion: 1, schemaVersion: 1, immutable: true, validate: isObject,
		captureInput: () => { entered(); return new Promise(resolve => { release = resolve; }); }, context: () => { contexts++; return []; } };
	const controller = new AbortController();
	const waiting = prepareModuleContext(module, undefined, { mode: "active", scope: "session", conversation: [] }, controller.signal, () => {});
	await ready; controller.abort(new Error("input canceled")); await assert.rejects(waiting, /input canceled/);
	release({ value: {}, assertCurrent() {} }); await Promise.resolve(); assert.equal(contexts, 0);
	for (const receipt of [undefined, {}, { value: {}, assertCurrent: async () => {} }, { value: {}, assertCurrent: async () => { throw new Error("late asynchronous assertion"); } }, { value: {}, assertCurrent: () => false }]) {
		const invalid = { ...module, captureInput: () => receipt } as unknown as StateFlowModule;
		await assert.rejects(prepareModuleContext(invalid, undefined, { mode: "passive", scope: "session", conversation: [] }, new AbortController().signal, () => {}), /input requires|synchronously/);
	}
});

const frame = { mode: "active" as const, conversation: [] as AgentMessage[], input: { label: "captured" } };
const memory: SemanticModule<JsonObject, { label: string }> = {
	immutable: false,
	id: "notes",
	validate: isObject,
	context: (content, current) => [{ kind: "data", value: { mode: current.mode, label: current.input.label, content: content ?? {} } }],
};

test("module context supports absent state and both modes without authoring defaults", () => {
	for (const mode of ["active", "passive"] as const) {
		assert.deepEqual(evaluateModuleContext(memory, undefined, { ...frame, mode }), [{ kind: "data", value: { mode, label: "captured", content: {} } }]);
	}
	assert.throws(() => evaluateModuleContext(memory, undefined, { ...frame, mode: "off" as "active" }), /Active or Passive/);
	assert.throws(() => evaluateModuleContext(memory, "bad", frame), /Invalid content/);
	assert.equal(memory.immutable, false);
});

test("context isolates content and captured inputs and detaches returned data", () => {
	const content = { keep: "original" }, input = { label: "original" }, output = { nested: { keep: true } };
	const changing: typeof memory = { ...memory, context(value, current) {
		value!.keep = "module copy"; current.input.label = "module copy";
		return [{ kind: "data", value: output }];
	} };
	const result = evaluateModuleContext(changing, content, { ...frame, input });
	assert.deepEqual(content, { keep: "original" }); assert.deepEqual(input, { label: "original" });
	output.nested.keep = false;
	assert.deepEqual(result, [{ kind: "data", value: { nested: { keep: true } } }]);
});

test("a stateless recent-window module selects exact source identities in original order", () => {
	const source: AgentMessage[] = [
		{ role: "user", content: "old", timestamp: 1 },
		{ role: "user", content: "recent", timestamp: 2 },
		{ role: "user", content: "latest", timestamp: 3 },
	];
	const window: SemanticModule<JsonObject, number> = { immutable: true, id: "recent", validate: isObject, context(_content, current) {
		current.conversation[1]!.timestamp = 99;
		return [{ kind: "data", value: { window: current.input } }, { kind: "conversation", indices: [1, 2] }];
	} };
	const result = evaluateModuleContext(window, undefined, { mode: "passive", conversation: source, input: 2 });
	assert.deepEqual(source.map(message => message.timestamp), [1, 2, 3]);
	assert.equal(result[1]!.kind, "conversation");
	if (result[1]!.kind === "conversation") {
		assert.strictEqual(result[1]!.messages[0], source[1]); assert.strictEqual(result[1]!.messages[1], source[2]);
	}
});

test("conversation indices reject sparse, duplicated, reordered, invalid and protocol-frame selections", () => {
	const source: AgentMessage[] = [{ role: "user", content: "one", timestamp: 1 }, { role: "user", content: "two", timestamp: 2 }];
	for (const indices of [[-1], [2], [0.5], [NaN], [1, 0], [0, 0], new Array(1)]) {
		const invalid: typeof memory = { ...memory, context: () => [{ kind: "conversation", indices }] };
		assert.throws(() => evaluateModuleContext(invalid, {}, { ...frame, conversation: source }), /indices/);
	}
	const duplicate: typeof memory = { ...memory, context: () => [{ kind: "conversation", indices: [0] }, { kind: "conversation", indices: [0] }] };
	assert.throws(() => evaluateModuleContext(duplicate, {}, { ...frame, conversation: source }), /indices/);
	const select: typeof memory = { ...memory, context: () => [{ kind: "conversation", indices: [0] }] };
	assert.throws(() => evaluateModuleContext(select, {}, { ...frame, conversation: [{ role: "system", content: "not conversation" } as unknown as AgentMessage] }), /protocol frames/);
});

test("context accepts only closed contribution shapes and finite dense detached JSON", () => {
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	const invalid: unknown[] = [undefined, NaN, Infinity, () => {}, cycle, new Array(1), [undefined]];
	for (const value of invalid) {
		const module: typeof memory = { ...memory, context: () => [{ kind: "data", value: value as JsonValue }] };
		assert.throws(() => evaluateModuleContext(module, {}, frame), /finite dense JSON/);
	}
	for (const contribution of [{ kind: "system", value: "instructions" }, { kind: "data", value: {}, extra: true }, { kind: "conversation", indices: [], messages: [] }]) {
		const module = { ...memory, context: () => [contribution] } as unknown as typeof memory;
		assert.throws(() => evaluateModuleContext(module, {}, frame), /Invalid semantic module context/);
	}
	const asynchronous = { ...memory, context: async () => [] } as unknown as typeof memory;
	assert.throws(() => evaluateModuleContext(asynchronous, {}, frame), /contribution array/);
});

test("an immutable archive producer can use injected inference but only returns a detached candidate", async () => {
	const accepted = { summary: "old" }, input = { text: "captured block" }, result = { summary: "new" };
	let seen = "", calls = 0;
	const infer = async (text: string) => { seen = text; calls++; return result; };
	const archive: SemanticModule<JsonObject, { text: string }> = {
		immutable: true, id: "archive", validate: isObject, context: () => [],
		async produce(content, captured) { content!.summary = "private draft"; return infer(captured.text); },
	};
	const producing = produceModuleContent(archive, accepted, input, new AbortController().signal, () => {});
	input.text = "later input";
	const candidate = await producing;
	assert.equal(calls, 1); assert.equal(seen, "captured block");
	assert.deepEqual(accepted, { summary: "old" }); assert.deepEqual(candidate, { summary: "new" });
	result.summary = "mutated after return"; assert.deepEqual(candidate, { summary: "new" });
});

test("validation cannot retain or invalidate a returned candidate", async () => {
	let retained: JsonObject | undefined;
	const retaining: typeof memory = { ...memory, validate(value): value is JsonObject { if (!isObject(value)) return false; retained = value; return true; }, produce: async () => ({ summary: "accepted candidate" }) };
	const candidate = await produceModuleContent(retaining, undefined, frame.input, new AbortController().signal, () => {});
	retained!.summary = "late validator mutation";
	assert.deepEqual(candidate, { summary: "accepted candidate" });
	const invalidating: typeof memory = { ...retaining, validate(value): value is JsonObject { if (!isObject(value)) return false; value.invalid = NaN; return true; } };
	await assert.rejects(produceModuleContent(invalidating, undefined, frame.input, new AbortController().signal, () => {}), /Invalid content/);
});

test("producer absence and no proposal never fabricate state; invalid results and failures reject", async () => {
	const signal = new AbortController().signal;
	assert.equal(await produceModuleContent(memory, undefined, frame.input, signal, () => {}), undefined);
	const none: typeof memory = { ...memory, produce: async () => undefined };
	assert.equal(await produceModuleContent(none, undefined, frame.input, signal, () => {}), undefined);
	const deterministic: typeof memory = { ...memory, produce: () => ({ captured: "exact deterministic content" }) };
	assert.deepEqual(await produceModuleContent(deterministic, undefined, frame.input, signal, () => {}), { captured: "exact deterministic content" });
	for (const value of ["wrong type", NaN, new Array(1)]) {
		const invalid = { ...memory, produce: async () => value } as unknown as typeof memory;
		await assert.rejects(produceModuleContent(invalid, {}, frame.input, signal, () => {}), /Invalid content|finite dense JSON/);
	}
	const failed: typeof memory = { ...memory, produce: async () => { throw new Error("inference failed"); } };
	await assert.rejects(produceModuleContent(failed, {}, frame.input, signal, () => {}), /inference failed/);
});

test("producer cancellation returns before ignored work finishes and late output cannot install state", async () => {
	let enter!: () => void, release!: (value: JsonObject) => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const gate = new Promise<JsonObject>(resolve => { release = resolve; });
	const producer: typeof memory = { ...memory, produce: async () => { enter(); return gate; } };
	const controller = new AbortController(), accepted = { keep: "accepted" };
	const pending = produceModuleContent(producer, accepted, frame.input, controller.signal, () => {});
	await entered; controller.abort();
	await assert.rejects(pending, /abort/i);
	release({ keep: "late" }); await Promise.resolve();
	assert.deepEqual(accepted, { keep: "accepted" });
	await assert.rejects(produceModuleContent(producer, accepted, frame.input, controller.signal, () => {}), /abort/i);
});

test("obsolete asynchronous producer completion rejects instead of adopting a fresh host basis", async () => {
	let release!: (value: JsonObject) => void, current = true;
	const gate = new Promise<JsonObject>(resolve => { release = resolve; });
	const producer: typeof memory = { ...memory, produce: async () => gate };
	const pending = produceModuleContent(producer, {}, frame.input, new AbortController().signal, () => { if (!current) throw new Error("original basis ended"); });
	await Promise.resolve(); current = false; release({ summary: "stale" });
	await assert.rejects(pending, /original basis ended/);
});
