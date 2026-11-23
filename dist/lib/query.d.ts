import { type RecentScopePatch } from "./history.ts";
import { type JsonValue } from "./json.ts";
import { type SemanticState, type StateScope } from "./state.ts";
import { type SelectedTemporalState, type TemporalState, type TransitionBoundary } from "./temporal.ts";
type ReadableTemporalState = TemporalState | SelectedTemporalState;
export type StateReadQuery = {
    kind: "state";
    path: string;
    offset: number;
    scope?: StateScope;
} | {
    kind: "patch";
    path: string;
    offset: number;
    scope: StateScope;
};
export type StateReadResult = {
    path: string;
    boundary: TransitionBoundary;
    state: SemanticState;
} | {
    path: string;
    boundary: TransitionBoundary;
    patch: RecentScopePatch["patch"];
};
export type StateReadProjection = "value" | "keys" | "patch";
type ReadPathErrorCode = "invalid_path" | "scope_excluded" | "scope_unavailable" | "history_unavailable" | "path_not_found" | "invalid_selector";
export declare class StateReadPathError extends Error {
    readonly code: ReadPathErrorCode;
    constructor(code: ReadPathErrorCode, message?: string);
}
type KeysAbsence = "absent" | "unavailable";
export type CurrentReadAvailability = Partial<Record<StateScope | "effective", KeysAbsence>>;
type StateReadMeta = {
    type: "object";
    size: number;
} | {
    type: "array";
    length: number;
} | {
    type: "string";
    length: number;
} | {
    type: "number" | "boolean" | KeysAbsence;
};
type StateReadKeys = Record<string, string> | [];
export interface StateReadHint {
    type: "dangling-reference";
    message: string;
    paths: string[];
}
export type ProjectedStateRead = {
    value: JsonValue;
    hint?: StateReadHint[];
} | {
    values: JsonValue[];
} | {
    meta: StateReadMeta | StateReadMeta[];
    keys: StateReadKeys | StateReadKeys[];
} | {
    patch: JsonValue | JsonValue[];
};
export interface StateReferenceSource {
    scope: StateScope;
    path: string;
    form: "structured" | "text";
}
type ValueSelector = {
    kind: "key";
    key: string;
} | {
    kind: "index";
    index: number;
} | {
    kind: "range";
    start: number;
    end: number;
};
/** Recognize patch-history syntax only; effective still fails temporal validation. */
export declare function patchHistoryRoot(path: string): StateScope | "effective" | "flat" | undefined;
export declare function flatSemanticRoot(path: string): string | undefined;
/** Resolve a projection root without repeating the tool name in every path. */
export declare function parseStateReadPath(path: string, historyLimit?: number): StateReadQuery;
export declare function readStatePath(view: ReadableTemporalState, path: string, historyLimit?: number): StateReadResult;
/** Parse semantic locator syntax without resolving values, authority or target existence. */
export declare function parseValuePath(path: string): {
    root: string;
    selectors: ValueSelector[];
};
/** Reactively locate exact durable sources for one failed state-path resolution. */
export declare function findStateReferenceSources(view: ReadableTemporalState, path: string, historyLimit?: number): {
    sources: StateReferenceSource[];
    truncated: boolean;
};
/** Preserve input slots. Only typed locator failures are collected; an invalid read basis still rejects the batch. */
export declare function readValueBatch(view: ReadableTemporalState | undefined, paths: readonly string[], normalizePath: (path: string) => string, availability: CurrentReadAvailability, historyLimit?: number): {
    values: JsonValue[];
};
/** Project exact paths; the caller may supply current catalog statuses without inventing temporal streams. */
export declare function readProjectedState(view: ReadableTemporalState | undefined, paths: readonly string[], projection?: StateReadProjection, historyLimit?: number, availability?: CurrentReadAvailability): ProjectedStateRead;
export {};
