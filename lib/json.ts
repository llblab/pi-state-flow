import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export function applyPatch(state: JsonObject, patch: JsonObject): JsonObject {
	const next: JsonObject = structuredClone(state);
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
			continue;
		}
		const current = next[key];
		const materialized = isObject(current) && isObject(value)
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
