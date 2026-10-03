import { type JsonObject, type JsonValue } from "./json.ts";
import type { SemanticState, StateScope } from "./state.ts";
/** Planes whose object keys an intent may own by structured reference. */
export type OwnedPlane = "working" | "lazy";
/** One same-scope object-key target of an intent ownership reference. */
export interface OwnedPath {
    plane: OwnedPlane;
    keys: string[];
}
/**
 * Parse one structured `$ref` target as an ownership path of `scope`.
 * Cross-scope, unscoped, `effective`, historical, plane-root, array-element
 * and non-`working`/`lazy` targets are not ownership targets.
 */
export declare function parseOwnedPath(scope: StateScope, ref: string): OwnedPath | undefined;
/** Extract unique ownership targets from structured references anywhere inside one intent value. */
export declare function extractOwnedPaths(scope: StateScope, value: JsonValue): OwnedPath[];
/**
 * Compute the same-scope ownership cascade for intent keys removed between
 * `before` and `after` (the state after authored operations). A target is
 * kept while any remaining intent references it, an ancestor or a descendant;
 * missing targets are skipped. The result is minimal (no target below
 * another) and deterministically ordered.
 */
export declare function computeIntentCascade(scope: StateScope, before: SemanticState, after: SemanticState): OwnedPath[];
/** Express cascade targets as explicit nested object-key deletions. */
export declare function cascadeDeletionPatch(paths: readonly OwnedPath[]): JsonObject;
/** Render an ownership target as its scoped `read_state` path. */
export declare function formatOwnedPath(scope: StateScope, path: OwnedPath): string;
/** Top-level `working`/`lazy` keys that at least one current intent of `scope` owns. */
export declare function ownedTopLevelKeys(scope: StateScope, state: SemanticState): Record<OwnedPlane, Set<string>>;
