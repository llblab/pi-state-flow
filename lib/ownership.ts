import { isObject, type JsonObject, type JsonValue } from "./json.ts";
import type { SemanticState, StateScope } from "./state.ts";

/** Planes whose object keys an intent may own by structured reference. */
export type OwnedPlane = "working" | "lazy";

/** One same-scope object-key target of an intent ownership reference. */
export interface OwnedPath {
	plane: OwnedPlane;
	keys: string[];
}

const OWNED_PLANES = new Set<string>(["working", "lazy"]);
// Same key grammar as read_state value paths; array selectors never parse.
const OBJECT_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/**
 * Parse one structured `$ref` target as an ownership path of `scope`.
 * Cross-scope, unscoped, `effective`, historical, plane-root, array-element
 * and non-`working`/`lazy` targets are not ownership targets.
 */
export function parseOwnedPath(scope: StateScope, ref: string): OwnedPath | undefined {
	const parts = ref.split(".");
	if (parts.length < 3 || parts[0] !== scope || !OWNED_PLANES.has(parts[1]!)) return undefined;
	const keys = parts.slice(2);
	if (!keys.every((key) => OBJECT_KEY.test(key))) return undefined;
	return { plane: parts[1] as OwnedPlane, keys };
}

function pathId(path: OwnedPath): string {
	return JSON.stringify([path.plane, ...path.keys]);
}

/** Extract unique ownership targets from structured references anywhere inside one intent value. */
export function extractOwnedPaths(scope: StateScope, value: JsonValue): OwnedPath[] {
	const found = new Map<string, OwnedPath>();
	const visit = (node: JsonValue): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isObject(node)) return;
		if (typeof node.$ref === "string") {
			const path = parseOwnedPath(scope, node.$ref);
			if (path) found.set(pathId(path), path);
		}
		for (const key of Object.keys(node)) if (key !== "$ref" || typeof node[key] !== "string") visit(node[key]!);
	};
	visit(value);
	return [...found.values()];
}

function related(left: OwnedPath, right: OwnedPath): boolean {
	if (left.plane !== right.plane) return false;
	const length = Math.min(left.keys.length, right.keys.length);
	for (let index = 0; index < length; index++) if (left.keys[index] !== right.keys[index]) return false;
	return true;
}

function exists(state: SemanticState, path: OwnedPath): boolean {
	let node: JsonValue | undefined = state[path.plane];
	for (const key of path.keys) {
		if (!isObject(node) || !Object.hasOwn(node, key)) return false;
		node = node[key];
	}
	return true;
}

/**
 * Compute the same-scope ownership cascade for intent keys removed between
 * `before` and `after` (the state after authored operations). A target is
 * kept while any remaining intent references it, an ancestor or a descendant;
 * missing targets are skipped. The result is minimal (no target below
 * another) and deterministically ordered.
 */
export function computeIntentCascade(scope: StateScope, before: SemanticState, after: SemanticState): OwnedPath[] {
	const previous = isObject(before.intents) ? before.intents : {};
	const remaining = isObject(after.intents) ? after.intents : {};
	const deleted = Object.keys(previous).filter((key) => !Object.hasOwn(remaining, key));
	if (deleted.length === 0) return [];
	const candidates = new Map<string, OwnedPath>();
	for (const key of deleted) for (const path of extractOwnedPaths(scope, previous[key]!)) candidates.set(pathId(path), path);
	if (candidates.size === 0) return [];
	const retained = Object.values(remaining).flatMap((value) => extractOwnedPaths(scope, value));
	const owned = [...candidates.values()].filter((path) =>
		!retained.some((other) => related(path, other)) && exists(after, path));
	return owned
		.filter((path) => !owned.some((other) => other.keys.length < path.keys.length && related(path, other)))
		.sort((left, right) => pathId(left).localeCompare(pathId(right)));
}

/** Express cascade targets as explicit nested object-key deletions. */
export function cascadeDeletionPatch(paths: readonly OwnedPath[]): JsonObject {
	const patch: JsonObject = {};
	const define = (target: JsonObject, key: string, value: JsonValue) =>
		Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
	for (const path of paths) {
		if (!Object.hasOwn(patch, path.plane)) define(patch, path.plane, {});
		let node = patch[path.plane] as JsonObject;
		for (const key of path.keys.slice(0, -1)) {
			if (!Object.hasOwn(node, key)) define(node, key, {});
			node = node[key] as JsonObject;
		}
		define(node, path.keys.at(-1)!, null);
	}
	return patch;
}

/** Render an ownership target as its scoped `read_state` path. */
export function formatOwnedPath(scope: StateScope, path: OwnedPath): string {
	return [scope, path.plane, ...path.keys].join(".");
}

/** Top-level `working`/`lazy` keys that at least one current intent of `scope` owns. */
export function ownedTopLevelKeys(scope: StateScope, state: SemanticState): Record<OwnedPlane, Set<string>> {
	const owned: Record<OwnedPlane, Set<string>> = { working: new Set(), lazy: new Set() };
	const intents = isObject(state.intents) ? state.intents : {};
	for (const value of Object.values(intents)) for (const path of extractOwnedPaths(scope, value)) owned[path.plane].add(path.keys[0]!);
	return owned;
}
