export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}
/** Detach at the mutable public boundary; share untouched paths only inside the owned draft. */
export declare function applyPatch(state: JsonObject, patch: JsonObject): JsonObject;
export declare function isObject(value: JsonValue | unknown): value is JsonObject;
export declare function validatePatch(value: unknown): asserts value is JsonObject;
export declare function canonicalJson(value: JsonValue | unknown): string;
/** Deterministic-by-construction presentation JSON; preserves intentional object insertion order. */
export declare function presentationJson(value: JsonValue | unknown): string;
export declare function sameJson(left: JsonValue | unknown, right: JsonValue | unknown): boolean;
export declare function hashJson(value: JsonValue | unknown): string;
export declare function containsNull(value: unknown): boolean;
export declare function isJsonValue(value: unknown, ancestors?: WeakSet<object>): value is JsonValue;
