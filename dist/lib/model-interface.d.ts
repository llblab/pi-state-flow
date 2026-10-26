import { type JsonValue, type MissingDeletion } from "./json.ts";
import { type ScopeSelection } from "./selection.ts";
import type { AtomicScopePatches, StateScope } from "./state.ts";
/** Anchor eligible flat current references, never text/resource/effective/historical references. */
export declare function canonicalizeModelReferences(value: unknown, scopes: ScopeSelection, external?: readonly string[]): JsonValue;
/** Strip only validated same-owner current semantic reference prefixes; canonical data stays untouched. */
export declare function projectModelReferences(value: unknown, scopes: ScopeSelection, external?: readonly string[]): JsonValue;
/** Value normalization only; callers must validate their original request/owner before invoking it. */
export declare function normalizeModelPatches(value: unknown, scopes: ScopeSelection, external?: readonly string[]): AtomicScopePatches;
/** Compilation target syntax, not a query locator: preserve the exact opaque source key. */
export declare function projectModelArtifactTarget(scope: StateScope, path: string, scopes: ScopeSelection): string;
/** Known deletion-report JSON pointers only; do not parse source keys or rewrite diagnostics. */
export declare function projectModelMissingDeletion(deletion: MissingDeletion, scopes: ScopeSelection): MissingDeletion;
/** Sole-owner locators bind to that exact owner; multi-owner effective aliases keep their existing meaning. */
export declare function normalizeModelReadPath(path: string, scopes: ScopeSelection, historyLimit?: number): string;
/** Presentation locator only: history keeps an explicit projection root and does not become an array index. */
export declare function projectModelReadPath(path: string, scopes: ScopeSelection, historyLimit?: number): string;
