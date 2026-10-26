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
    type: "number" | "boolean";
};
type StateReadKeys = Record<string, string> | [];
export interface StateReadHint {
    type: "dangling-reference";
    message: string;
    paths: string[];
}
export type ProjectedStateRead = {
    value: JsonValue | JsonValue[];
    hint?: StateReadHint[];
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
/** Project exact current/historical state paths without exposing temporal metadata. */
export declare function readProjectedState(view: ReadableTemporalState, paths: readonly string[], projection?: StateReadProjection, historyLimit?: number): ProjectedStateRead;
export {};
