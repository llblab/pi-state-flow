import { isJsonValue, isObject } from "./json.js";
export function validateRetainedModules(value) {
    if (!isObject(value) || !isJsonValue(value) || !losslessStoredJson(value))
        throw new Error("Invalid State Flow retained modules");
    for (const [id, descriptor] of Object.entries(value)) {
        if (!/^x_[a-z][a-z0-9_]*$/.test(id) || !isObject(descriptor)
            || Object.keys(descriptor).sort().join(",") !== "immutable,schemaVersion"
            || !Number.isSafeInteger(descriptor.schemaVersion) || descriptor.schemaVersion <= 0
            || typeof descriptor.immutable !== "boolean")
            throw new Error(`Invalid State Flow retained module descriptor: ${id}`);
    }
}
/** Descriptors cannot be removed, recycled or implicitly change schema/policy. */
export function assertRetainedModules(previous, next) {
    validateRetainedModules(previous);
    validateRetainedModules(next);
    for (const [id, descriptor] of Object.entries(previous)) {
        if (!Object.hasOwn(next, id) || next[id].schemaVersion !== descriptor.schemaVersion
            || next[id].immutable !== descriptor.immutable)
            throw new Error(`State Flow retained module descriptor changed: ${id}`);
    }
}
function dense(value) {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++)
            if (!Object.hasOwn(value, index) || !dense(value[index]))
                return false;
    }
    else if (isObject(value))
        return Object.values(value).every(dense);
    return true;
}
function losslessStoredJson(value) {
    if (value === null || typeof value !== "object")
        return true;
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1)
        return false;
    return keys.every(key => {
        if (Array.isArray(value) && key === "length")
            return true;
        const property = Object.getOwnPropertyDescriptor(value, key);
        return typeof key === "string" && property.enumerable === true && "value" in property && losslessStoredJson(property.value);
    });
}
/** Raw durable planes use JSON object values, independent of any definition callback. */
export function validateModuleObject(value) {
    if (!isObject(value) || !isJsonValue(value) || !dense(value) || !losslessStoredJson(value))
        throw new Error("State Flow external content must be a finite dense JSON object");
}
function capture(value) {
    try {
        return structuredClone(value);
    }
    catch {
        throw new Error("Semantic module inputs must be detachable data");
    }
}
function captureJson(value) {
    if (!isJsonValue(value) || !dense(value))
        throw new Error("Semantic module content must be finite dense JSON data");
    const copy = capture(value);
    if (!isJsonValue(copy) || !dense(copy))
        throw new Error("Semantic module content must be finite dense JSON data");
    return copy;
}
function contentFor(module, value) {
    if (value === undefined)
        return undefined;
    const copy = captureJson(value), validation = capture(copy);
    if (module.validate(validation) !== true || !isJsonValue(validation) || !dense(validation))
        throw new Error(`Invalid content for semantic module ${module.id}`);
    // Validators neither transform the content nor retain the returned candidate.
    return capture(copy);
}
/** Context consumes captured data; conversation selections retain the host's exact original messages. */
export function evaluateModuleContext(module, content, frame) {
    if (frame.mode !== "active" && frame.mode !== "passive")
        throw new Error("Semantic module context requires Active or Passive mode");
    const original = [...frame.conversation];
    const result = module.context(contentFor(module, content), { mode: frame.mode, conversation: capture(original), input: capture(frame.input) });
    if (!Array.isArray(result))
        throw new Error("Semantic module context must return a contribution array");
    let last = -1;
    return Array.from(result, contribution => {
        if (!isObject(contribution))
            throw new Error("Invalid semantic module context contribution");
        const keys = Object.keys(contribution).sort().join(",");
        if (contribution.kind === "data" && keys === "kind,value")
            return { kind: "data", value: captureJson(contribution.value) };
        if (contribution.kind !== "conversation" || keys !== "indices,kind" || !Array.isArray(contribution.indices)) {
            throw new Error("Invalid semantic module context contribution");
        }
        const messages = Array.from(contribution.indices, index => {
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index <= last || index >= original.length)
                throw new Error("Semantic module conversation indices must be ordered, unique and in range");
            last = index;
            const message = original[index];
            if (!message || !["user", "assistant", "toolResult"].includes(message.role))
                throw new Error("Semantic modules may select conversation messages, not protocol frames");
            return message;
        });
        return { kind: "conversation", messages };
    });
}
async function cancelableModuleWork(work, signal, checkCurrent) {
    const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
    check();
    let abort;
    const canceled = new Promise((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
    try {
        return await Promise.race([Promise.resolve().then(() => { check(); return work(); }).then(value => { check(); return value; }), canceled]);
    }
    finally {
        signal.removeEventListener("abort", abort);
    }
}
export async function prepareModuleContext(module, content, source, signal, checkCurrent) {
    const { mode, scope, prompt } = source;
    if (mode !== "active" && mode !== "passive" || !["global", "cwd", "session"].includes(scope))
        throw new Error("Invalid State Flow module source frame");
    if (scope !== "session" && (source.conversation.length || prompt !== undefined))
        throw new Error("Shared module frames cannot acquire Session conversation or prompt");
    const conversation = [...source.conversation];
    const frameSource = { mode, scope, conversation, ...(prompt === undefined ? {} : { prompt }) };
    const adapter = { id: module.id, immutable: module.immutable,
        validate: value => module.validate(value),
        context: (value, frame) => module.context(value, { mode, scope, conversation: frame.conversation, input: frame.input, ...(prompt === undefined ? {} : { prompt }) }) };
    const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
    check();
    const previous = contentFor(adapter, content);
    const receipt = module.captureInput ? await cancelableModuleWork(() => module.captureInput(capture(frameSource), signal), signal, check) : undefined;
    if (module.captureInput && receipt === undefined || receipt !== undefined && (!isObject(receipt) || typeof receipt.assertCurrent !== "function" || !Object.hasOwn(receipt, "value"))) {
        throw new Error("State Flow module input requires value and synchronous assertCurrent");
    }
    const currentInput = receipt?.assertCurrent.bind(receipt);
    const assertCurrent = () => {
        check();
        const result = currentInput?.();
        if (result !== undefined) {
            if (result && typeof result.then === "function")
                void Promise.resolve(result).catch(() => { });
            throw new Error("State Flow module input assertion must synchronously throw or return void");
        }
        check();
    };
    assertCurrent();
    const input = receipt === undefined ? undefined : captureJson(receipt.value);
    assertCurrent();
    return Object.freeze({ assertCurrent, produce: async () => {
            assertCurrent();
            if (mode !== "active")
                throw new Error("State Flow module producers require Active mode");
            if (!module.produce)
                return undefined;
            const producing = { id: module.id, immutable: module.immutable,
                validate: (value) => isObject(value) && (Object.keys(value).length === 0 || module.validate(value)),
                context: () => [], produce: (value, frame, activeSignal) => module.produce(value, frame, activeSignal) };
            const candidate = await produceModuleContent(producing, previous, { ...frameSource, input }, signal, assertCurrent);
            if (candidate !== undefined)
                validateModuleObject(candidate);
            assertCurrent();
            return candidate;
        }, evaluate: (accepted) => {
            assertCurrent();
            const result = evaluateModuleContext(adapter, accepted === undefined ? previous : accepted.content, { mode, conversation, input });
            if (scope !== "session" && result.some(item => item.kind === "conversation"))
                throw new Error("Shared modules cannot replace Session conversation");
            assertCurrent();
            return result;
        } });
}
/** Evaluate only: the host must separately bind the captured basis to its existing atomic acceptance. */
export async function produceModuleContent(module, content, input, signal, checkCurrent) {
    const check = () => { signal.throwIfAborted(); checkCurrent(); signal.throwIfAborted(); };
    check();
    const produce = module.produce?.bind(module);
    if (!produce)
        return undefined;
    const previous = contentFor(module, content), captured = capture(input);
    check();
    return cancelableModuleWork(async () => {
        const value = await produce(previous, captured, signal);
        check();
        return contentFor(module, value);
    }, signal, check);
}
