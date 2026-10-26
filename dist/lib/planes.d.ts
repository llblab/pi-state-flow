import { type ArtifactModelHints } from "./artifact.ts";
import { type JsonObject, type JsonValue } from "./json.ts";
import { type SemanticModule } from "./semantic-module.ts";
export type LazyValueKind = "array" | "boolean" | "null" | "number" | "object" | "string";
export interface LazyNavigation {
    available: boolean;
    path: string;
    keys?: Record<string, LazyValueKind>;
}
export declare function lazyValueKind(value: JsonValue): LazyValueKind;
/** Navigation only: existing complete-catalog budgets, never lazy bodies. */
export declare function projectLazyNavigation(content: JsonValue | undefined): LazyNavigation;
interface PlaneInput {
    artifactHints: ArtifactModelHints;
    lazyNavigation?: LazyNavigation;
}
type PlaneModule = SemanticModule<JsonValue, PlaneInput>;
/** Storage/presentation bindings are explicit; a module id alone never registers a stored root. */
export declare const SEMANTIC_PLANES: readonly Readonly<{
    module: PlaneModule;
    target: string;
}>[];
export declare const MODEL_PLANE_NAMES: readonly string[];
/** Ordinary context values and navigation share the same executable mode-aware module path. */
export declare function projectPlaneContext(state: JsonObject, hints?: ArtifactModelHints, mode?: "active" | "passive"): {
    state: JsonObject;
    lazy_navigation: LazyNavigation;
};
export {};
