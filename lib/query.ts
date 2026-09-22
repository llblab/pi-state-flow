import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history.ts";
import { isObject, sameJson, type JsonValue } from "./json.ts";
import { projectStateForModel, type ModelState, type ScopePatch, type StateScope } from "./state.ts";
import { readTemporalState, type TemporalState, type TransitionBoundary } from "./temporal.ts";

export type StateReadQuery =
	| { kind: "state"; path: string; offset: number; scope?: StateScope }
	| { kind: "patch"; path: string; offset: number; scope: StateScope };

export type StateReadResult =
	| { path: string; boundary: TransitionBoundary; state: ModelState }
	| { path: string; boundary: TransitionBoundary; patch: ScopePatch & { response?: string } };

export type StateReadProjection = "value" | "keys" | "patch";
type StateReadMeta = { type: "object"; size: number } | { type: "array"; length: number } | { type: "string"; length: number } | { type: "number" | "boolean" };
type StateReadKeys = Record<string, string> | [];
export interface StateReadHint {
	type: "dangling-reference";
	message: string;
	paths: string[];
}

export type ProjectedStateRead =
	| { value: JsonValue | JsonValue[]; hint?: StateReadHint[] }
	| { meta: StateReadMeta | StateReadMeta[]; keys: StateReadKeys | StateReadKeys[] }
	| { patch: JsonValue | JsonValue[] };

export interface StateReferenceSource {
	scope: StateScope;
	path: string;
	form: "structured" | "text";
}

const MAX_REFERENCE_SOURCES = 3;
const MAX_REFERENCE_SCAN_NODES = 10_000;

type ValueSelector = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "range"; start: number; end: number };

const PATH_PATTERN = /^(effective|global|cwd|session)(?:\[(\d+)\])?(?:\.patches(?:\[(\d+)\])?)?$/;

/** Resolve a projection root without repeating the tool name in every path. */
export function parseStateReadPath(path: string, historyLimit = DEFAULT_HISTORY_LIMIT): StateReadQuery {
	if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > MAX_HISTORY_LIMIT) {
		throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
	}
	const match = PATH_PATTERN.exec(path);
	if (!match) throw new Error("Invalid State Flow read path");
	const [, root, rootOffset, patchOffset] = match;
	if (path.includes(".patches") && rootOffset !== undefined) throw new Error("Index patches after .patches, not after the scope");
	if (path.includes(".patches") && root === "effective") throw new Error("Patch history requires an explicit scope");
	const offset = Number(patchOffset ?? rootOffset ?? "0");
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > historyLimit) throw new Error(`State Flow read path index must be an integer from 0 to ${historyLimit}`);
	if (patchOffset !== undefined || path.endsWith(".patches")) {
		return { kind: "patch", path, offset, scope: root as StateScope };
	}
	return { kind: "state", path, offset, ...(root === "effective" ? {} : { scope: root as StateScope }) };
}

export function readStatePath(view: TemporalState, path: string, historyLimit = DEFAULT_HISTORY_LIMIT): StateReadResult {
	const query = parseStateReadPath(path, historyLimit);
	if (query.kind === "state") {
		const boundary = view.lineage[view.lineage.length - 1 - query.offset];
		if (!boundary) throw new Error("Requested history predates the proven temporal origin");
		return { path, boundary: structuredClone(boundary), state: projectStateForModel(readTemporalState(view, query.offset, query.scope, historyLimit)) };
	}
	const record = view.scopes[query.scope].patches.at(-1 - query.offset);
	if (!record) throw new Error(`Requested ${query.scope} patch predates retained hot history`);
	return { path, boundary: structuredClone(record.transition), patch: structuredClone(record.patch) };
}

function parseValuePath(path: string): { root: string; selectors: ValueSelector[] } {
	const explicitRoot = /^(?:effective|global|cwd|session)(?:\[\d+\])?(?=\.|$)/.exec(path)?.[0];
	const implicitRoot = /^(?:artifacts|contract|working|intents|response|lazy)(?=\.|\[|$)/.exec(path)?.[0];
	if (explicitRoot === undefined && implicitRoot === undefined) {
		throw new Error("State Flow read path requires a semantic path or an effective, global, cwd, or session root");
	}
	const root = explicitRoot ?? "effective";
	const selectors: ValueSelector[] = implicitRoot === undefined ? [] : [{ kind: "key", key: implicitRoot }];
	let rest = path.slice((explicitRoot ?? implicitRoot)!.length);
	while (rest.length > 0) {
		const key = /^\.([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(rest);
		if (key) {
			selectors.push({ kind: "key", key: key[1]! });
			rest = rest.slice(key[0].length);
			continue;
		}
		const range = /^\[(\d+)(?::|\.\.)(\d+)\]/.exec(rest);
		if (range) {
			selectors.push({ kind: "range", start: Number(range[1]), end: Number(range[2]) });
			rest = rest.slice(range[0].length);
			continue;
		}
		const index = /^\[(\d+)\]/.exec(rest);
		if (index) {
			selectors.push({ kind: "index", index: Number(index[1]) });
			rest = rest.slice(index[0].length);
			continue;
		}
		throw new Error("Invalid State Flow read path selector");
	}
	return { root, selectors };
}

function selectValue(root: JsonValue, selectors: readonly ValueSelector[], path: string): JsonValue {
	let value = root;
	for (const selector of selectors) {
		if (selector.kind === "key") {
			if (!isObject(value) || !Object.hasOwn(value, selector.key)) throw new Error(`State Flow read path does not exist: ${path}`);
			value = value[selector.key]!;
			continue;
		}
		if (!Array.isArray(value)) throw new Error(`State Flow array selector requires an array: ${path}`);
		if (selector.kind === "index") {
			if (selector.index >= value.length) throw new Error(`Index ${selector.index} is outside ${path} with length ${value.length}`);
			value = value[selector.index]!;
			continue;
		}
		if (selector.start > selector.end || selector.end > value.length) throw new Error(`Range [${selector.start}:${selector.end}] is outside ${path} with length ${value.length}`);
		value = value.slice(selector.start, selector.end);
	}
	return structuredClone(value);
}

function valueKind(value: JsonValue): string {
	if (Array.isArray(value)) return "array";
	if (isObject(value)) return "object";
	return typeof value;
}

function referenceCandidates(path: string): string[] {
	if (/^(?:artifacts|contract|working|intents|response|lazy)(?=\.|\[|$)/.test(path)) return [path, `effective.${path}`];
	return [path];
}

function inlineReferencePattern(path: string): RegExp {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^A-Za-z0-9_$.[\\]:-])\\$${escaped}(?=$|[^A-Za-z0-9_$.[\\]:-])`, "u");
}

/** Reactively locate exact durable sources for one failed state-path resolution. */
export function findStateReferenceSources(view: TemporalState, path: string, historyLimit = DEFAULT_HISTORY_LIMIT): { sources: StateReferenceSource[]; truncated: boolean } {
	const candidates = referenceCandidates(path);
	const patterns = candidates.map(inlineReferencePattern);
	const sources: StateReferenceSource[] = [];
	let visited = 0;
	let truncated = false;
	const visit = (value: JsonValue, owner: StateScope, ownerPath: string): void => {
		if (sources.length >= MAX_REFERENCE_SOURCES || visited >= MAX_REFERENCE_SCAN_NODES) {
			truncated = true;
			return;
		}
		visited += 1;
		if (typeof value === "string") {
			if (patterns.some((pattern) => pattern.test(value))) sources.push({ scope: owner, path: ownerPath, form: "text" });
			return;
		}
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length && !truncated; index++) visit(value[index]!, owner, `${ownerPath}[${index}]`);
			return;
		}
		if (!isObject(value)) return;
		if (typeof value.$ref === "string" && candidates.includes(value.$ref)) {
			sources.push({ scope: owner, path: ownerPath, form: "structured" });
			if (sources.length >= MAX_REFERENCE_SOURCES) { truncated = true; return; }
		}
		for (const key of Object.keys(value).sort()) {
			if (key === "response" || (key === "$ref" && typeof value[key] === "string")) continue;
			visit(value[key]!, owner, ownerPath ? `${ownerPath}.${key}` : `${owner}.${key}`);
			if (truncated) return;
		}
	};
	for (const scope of ["global", "cwd", "session"] as const) {
		const state = readTemporalState(view, 0, scope, historyLimit);
		for (const plane of ["artifacts", "contract", "working", "intents", "lazy"] as const) {
			const value = state[plane];
			if (value !== undefined) visit(value as JsonValue, scope, `${scope}.${plane}`);
			if (truncated) break;
		}
		if (truncated) break;
	}
	sources.sort((left, right) => (left.form === right.form ? left.path.localeCompare(right.path) : left.form === "structured" ? -1 : 1));
	return { sources, truncated };
}

function missingReferenceHint(view: TemporalState, path: string, historyLimit: number): StateReadHint[] | undefined {
	const { sources, truncated } = findStateReferenceSources(view, path, historyLimit);
	if (sources.length === 0) return undefined;
	return [{
		type: "dangling-reference",
		message: `Reconcile the verified current values that reference this path${truncated ? "; additional sources may exist beyond the bounded scan" : ""}.`,
		paths: sources.map(({ path: sourcePath }) => sourcePath),
	}];
}

function projectValue(value: JsonValue, projection: StateReadProjection): ProjectedStateRead {
	if (projection === "value") return { value: structuredClone(value) };
	if (isObject(value)) {
		return {
			meta: { type: "object", size: Object.keys(value).length },
			keys: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, valueKind(child)])),
		};
	}
	if (Array.isArray(value)) return { meta: { type: "array", length: value.length }, keys: [] };
	if (typeof value === "string") return { meta: { type: "string", length: value.length }, keys: [] };
	if (value === null) throw new Error("State Flow semantic state cannot contain null");
	return { meta: { type: typeof value as "number" | "boolean" }, keys: [] };
}

function patchAtPath(view: TemporalState, root: string, selectors: readonly ValueSelector[], path: string, historyLimit: number): JsonValue {
	const rootQuery = parseStateReadPath(root, historyLimit);
	if (rootQuery.kind !== "state") throw new Error("Patch projection requires a state path");
	const boundary = view.lineage.at(-1 - rootQuery.offset);
	if (!boundary) throw new Error("Requested history predates the proven temporal origin");
	let patch: JsonValue = {};
	if (rootQuery.scope) {
		patch = structuredClone(view.scopes[rootQuery.scope].patches.find((record) => record.transition.id === boundary.id)?.patch ?? {}) as JsonValue;
	} else {
		const before = view.lineage.at(-2 - rootQuery.offset);
		if (before) {
			const current = readTemporalState(view, rootQuery.offset, undefined, historyLimit);
			const previous = readTemporalState(view, rootQuery.offset + 1, undefined, historyLimit);
			patch = diffObjects(previous, current);
		}
	}
	for (let index = 0; index < selectors.length; index++) {
		const selector = selectors[index]!;
		if (patch === null) return null;
		if (selector.kind === "key" && isObject(patch) && Object.hasOwn(patch, selector.key)) {
			patch = patch[selector.key]!;
			continue;
		}
		if (selector.kind !== "key" && isObject(patch)) {
			const key = selector.kind === "index" ? `[${selector.index}]` : undefined;
			if (key && Object.hasOwn(patch, key)) {
				patch = patch[key]!;
				continue;
			}
		}
		if (Array.isArray(patch)) return selectValue(patch, selectors.slice(index), path);
		if (!isObject(patch)) {
			const result = readStatePath(view, root, historyLimit);
			if (!("state" in result)) throw new Error("Patch projection requires a state path");
			return selectValue(result.state, selectors, path);
		}
		return {};
	}
	return structuredClone(patch);
}

function diffObjects(previous: JsonValue, current: JsonValue): JsonValue {
	if (!isObject(previous) || !isObject(current)) return structuredClone(current);
	const patch: Record<string, JsonValue> = {};
	for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
		if (!Object.hasOwn(current, key)) patch[key] = null;
		else if (!Object.hasOwn(previous, key)) patch[key] = structuredClone(current[key]!);
		else if (!sameJson(previous[key], current[key])) patch[key] = diffObjects(previous[key]!, current[key]!);
	}
	return patch;
}

/** Project exact current/historical state paths without exposing temporal metadata. */
export function readProjectedState(view: TemporalState, paths: readonly string[], projection: StateReadProjection = "value", historyLimit = DEFAULT_HISTORY_LIMIT): ProjectedStateRead {
	if (paths.length === 0) throw new Error("read_state requires at least one path");
	if (projection === "patch") {
		const patches = paths.map((path) => {
			const { root, selectors } = parseValuePath(path);
			return patchAtPath(view, root, selectors, path, historyLimit);
		});
		return { patch: patches.length === 1 ? patches[0]! : patches };
	}
	const projected = paths.map((path) => {
		try {
			const { root, selectors } = parseValuePath(path);
			const query = parseStateReadPath(root, historyLimit);
			if (query.kind !== "state") throw new Error("Value and keys projections require a state path");
			const readsLazy = selectors[0]?.kind === "key" && selectors[0].key === "lazy";
			const state = readsLazy
				? readTemporalState(view, query.offset, query.scope, historyLimit)
				: projectStateForModel(readTemporalState(view, query.offset, query.scope, historyLimit));
			if (readsLazy && !Object.hasOwn(state, "lazy")) state.lazy = {};
			return projectValue(selectValue(state, selectors, path), projection);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const missing = /does not exist| is outside /.test(message);
			const hint = missing && projection === "value" && paths.length === 1 ? missingReferenceHint(view, path, historyLimit) : undefined;
			if (hint) return { value: null, hint };
			throw new Error(message, error instanceof Error ? { cause: error } : undefined);
		}
	});
	if (projected.length === 1) return projected[0]!;
	if (projection === "value") return { value: projected.map((result) => (result as { value: JsonValue }).value) };
	return {
		meta: projected.map((result) => (result as Extract<ProjectedStateRead, { meta: unknown }>).meta),
		keys: projected.map((result) => (result as Extract<ProjectedStateRead, { meta: unknown }>).keys),
	} as unknown as ProjectedStateRead;
}
