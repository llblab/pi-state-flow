import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

const ARRAY_INDEX_SELECTOR = /^\[(0|[1-9]\d*)\]$/;

function isIndexedArrayPatch(value: JsonObject): boolean {
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => ARRAY_INDEX_SELECTOR.test(key));
}

function applyArrayPatch(state: JsonValue[], patch: JsonObject): JsonValue[] {
	const next = structuredClone(state);
	for (const [selector, value] of Object.entries(patch)) {
		const match = ARRAY_INDEX_SELECTOR.exec(selector)!;
		const index = Number(match[1]);
		if (!Number.isSafeInteger(index) || index >= next.length) {
			throw new Error(`State patch array index ${selector} is out of bounds for length ${next.length}`);
		}
		if (value === null) throw new Error(`State patch array index ${selector} cannot be deleted; replace the whole array instead`);
		const current = next[index]!;
		next[index] = Array.isArray(current) && isObject(value) && isIndexedArrayPatch(value)
			? applyArrayPatch(current, value)
			: isObject(current) && isObject(value)
				? applyPatch(current, value)
				: structuredClone(value);
	}
	return next;
}

export function applyPatch(state: JsonObject, patch: JsonObject): JsonObject {
	const next: JsonObject = structuredClone(state);
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
			continue;
		}
		const current = next[key];
		const materialized = Array.isArray(current) && isObject(value) && isIndexedArrayPatch(value)
			? applyArrayPatch(current, value)
			: isObject(current) && isObject(value)
				? applyPatch(current, value)
				: structuredClone(value);
		Object.defineProperty(next, key, {
			value: materialized,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return next;
}

export function isObject(value: JsonValue | unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePatch(value: unknown): asserts value is JsonObject {
	if (!isObject(value)) throw new Error("State patch must be a JSON object");
	if (!isJsonValue(value)) throw new Error("State patch must contain finite, acyclic JSON data");
}

export function canonicalJson(value: JsonValue | unknown): string {
	if (!isJsonValue(value)) throw new Error("Value must be finite, acyclic JSON data");
	return JSON.stringify(orderValue(value));
}

export function sameJson(left: JsonValue | unknown, right: JsonValue | unknown): boolean {
	if (left === right) {
		if (!isJsonValue(left)) throw new Error("Values must be finite, acyclic JSON data");
		return true;
	}
	if (!isJsonValue(left) || !isJsonValue(right)) throw new Error("Values must be finite, acyclic JSON data");
	return equalJsonValues(left, right);
}

function equalJsonValues(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length
			&& left.every((value, index) => equalJsonValues(value, right[index]!));
	}
	if (isObject(left) || isObject(right)) {
		if (!isObject(left) || !isObject(right)) return false;
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length
			&& keys.every((key) => Object.hasOwn(right, key) && equalJsonValues(left[key]!, right[key]!));
	}
	return false;
}

export function hashJson(value: JsonValue | unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function orderValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => orderValue(item));
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value).sort().map((key) => [key, orderValue(value[key])]),
	);
}

export function containsNull(value: unknown): boolean {
	if (value === null) return true;
	if (Array.isArray(value)) return value.some((item) => containsNull(item));
	if (!isObject(value)) return false;
	return Object.values(value).some((item) => containsNull(item));
}

export function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.every((item) => isJsonValue(item, ancestors));
		if (!isObject(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return false;
		return Object.values(value).every((item) => isJsonValue(item, ancestors));
	} catch {
		return false;
	} finally {
		ancestors.delete(value);
	}
}
