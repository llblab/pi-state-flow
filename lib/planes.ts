// Domain: static bindings of the six stored planes to the internal module contract.
// Excludes: storage dialect expansion, source acquisition, staging order and publication.
import { projectArtifactsForModel, type ArtifactModelHints, type ArtifactRegistry } from "./artifact.ts";
import { isObject, type JsonObject, type JsonValue } from "./json.ts";
import { evaluateModuleContext, type SemanticModule } from "./semantic-module.ts";

export type LazyValueKind = "array" | "boolean" | "null" | "number" | "object" | "string";
export interface LazyNavigation {
	available: boolean;
	path: string;
	keys?: Record<string, LazyValueKind>;
}

export function lazyValueKind(value: JsonValue): LazyValueKind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	return typeof value as Exclude<LazyValueKind, "array" | "object">;
}

function hasLazyContent(value: JsonValue): boolean {
	return !isObject(value) || Object.values(value).some(hasLazyContent);
}

/** Navigation only: existing complete-catalog budgets, never lazy bodies. */
export function projectLazyNavigation(content: JsonValue | undefined): LazyNavigation {
	const entries = isObject(content) ? Object.entries(content).filter(([, value]) => hasLazyContent(value)) : [];
	const base = { available: entries.length > 0, path: "effective.lazy" };
	if (!base.available || entries.length > 32) return base;
	const keys = Object.fromEntries(entries.map(([key, value]) => [key, lazyValueKind(value)]));
	return JSON.stringify(keys).length <= 1024 ? { ...base, keys } : base;
}

interface PlaneInput {
	artifactHints: ArtifactModelHints;
	lazyNavigation?: LazyNavigation;
}
type PlaneModule = SemanticModule<JsonValue, PlaneInput>;
function objectPlane(id: string): PlaneModule {
	return Object.freeze<PlaneModule>({
		immutable: false,
		id,
		validate: isObject,
		context: (content: JsonValue | undefined) => content === undefined ? [] : [{ kind: "data" as const, value: content }],
	});
}

const artifacts: PlaneModule = Object.freeze<PlaneModule>({
	immutable: false,
	id: "artifacts",
	// Observation may contain retained legacy bookkeeping; canonical artifact admission stays in its owner.
	validate: isObject,
	context: (content, frame) => content === undefined ? [] : [{ kind: "data", value: projectArtifactsForModel(content as ArtifactRegistry, frame.input.artifactHints) as JsonObject }],
});

const response: PlaneModule = Object.freeze<PlaneModule>({
	immutable: true,
	id: "response",
	validate: (value: unknown): value is string => typeof value === "string",
	context: (content, frame) => content === undefined || content === "" || frame.mode === "passive" ? [] : [{ kind: "data", value: content }],
});

const lazy: PlaneModule = Object.freeze<PlaneModule>({
	immutable: false,
	id: "lazy",
	validate: isObject,
	context: (content, frame) => [{ kind: "data", value: (frame.input.lazyNavigation ?? projectLazyNavigation(content)) as unknown as JsonObject }],
});

/** Storage/presentation bindings are explicit; a module id alone never registers a stored root. */
export const SEMANTIC_PLANES = Object.freeze([
	{ module: objectPlane("intents"), target: "state" },
	{ module: objectPlane("strategy"), target: "state" },
	{ module: objectPlane("tactics"), target: "state" },
	{ module: artifacts, target: "state" },
	{ module: response, target: "state" },
	{ module: lazy, target: "lazy_navigation" },
].map(binding => Object.freeze(binding)));

export const MODEL_PLANE_NAMES: readonly string[] = Object.freeze(SEMANTIC_PLANES.filter(({ module }) => !module.immutable).map(({ module }) => module.id));

/** Ordinary context values and navigation share the same executable mode-aware module path. */
export function projectPlaneContext(state: JsonObject, hints: ArtifactModelHints = {}, mode: "active" | "passive" = "active") {
	const projected: JsonObject = {};
	let navigation!: LazyNavigation;
	for (const { module, target } of SEMANTIC_PLANES) {
		// Lazy needs structural metadata only; never clone its hidden body into a context callback.
		const content = target !== "lazy_navigation" && Object.hasOwn(state, module.id) ? state[module.id] : undefined;
		const input: PlaneInput = { artifactHints: hints, ...(target === "lazy_navigation" ? { lazyNavigation: projectLazyNavigation(state.lazy) } : {}) };
		const contribution = evaluateModuleContext(module, content, { mode, conversation: [], input });
		if (contribution.length > 1 || contribution[0]?.kind === "conversation") throw new Error("Stored-plane binding requires at most one data contribution");
		const item = contribution[0];
		if (!item || item.kind !== "data") continue;
		if (target === "lazy_navigation") navigation = item.value as unknown as LazyNavigation;
		else Object.defineProperty(projected, module.id, { value: item.value, enumerable: true, configurable: true, writable: true });
	}
	return { state: projected, lazy_navigation: navigation };
}
