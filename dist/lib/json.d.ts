export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}
/** Expected rejection of input data. This is not evidence about any stored owner. */
export declare class InvalidStateFlowData extends Error {
}
export declare function nativeDecoderCause(error: unknown): Error | undefined;
export declare function decodeUtf8(bytes: Uint8Array, label: string): string;
export declare function decodeJson(source: string, label: string): unknown;
export interface MissingDeletion {
    /** JSON Pointer paths relative to the patched object. */
    path: string;
    unavailablePath: string;
}
/** Internal path-copying step; callers must own the detached draft and collect failures privately. */
export declare function applyOwnedPatch(state: JsonObject, patch: JsonObject, missingDeletions?: MissingDeletion[], path?: string, unavailablePath?: string): JsonObject;
/** Remove empty object fields without removing array slots or mutating the input. */
export declare function pruneEmptyObjects(value: JsonObject): JsonObject;
export declare function pruneEmptyObjects(value: JsonValue): JsonValue;
/** Detach at the mutable public boundary; share untouched paths only inside the owned draft. */
export declare function applyPatch(state: JsonObject, patch: JsonObject, missingDeletions?: MissingDeletion[]): JsonObject;
export declare function isObject(value: JsonValue | unknown): value is JsonObject;
export declare function validatePatch(value: unknown): asserts value is JsonObject;
export declare function canonicalJson(value: JsonValue | unknown): string;
/** Deterministic-by-construction presentation JSON; preserves intentional object insertion order. */
export declare function presentationJson(value: JsonValue | unknown): string;
export declare function sameJson(left: JsonValue | unknown, right: JsonValue | unknown): boolean;
export declare function hashJson(value: JsonValue | unknown): string;
export declare function containsNull(value: unknown): boolean;
export declare function isJsonValue(value: unknown, ancestors?: WeakSet<object>): value is JsonValue;
