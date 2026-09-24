import { type JsonValue } from "./json.ts";
import { type ModelState, type ScopePatch, type StateScope } from "./state.ts";
import { type TemporalState, type TransitionBoundary } from "./temporal.ts";
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
    state: ModelState;
} | {
    path: string;
    boundary: TransitionBoundary;
    patch: ScopePatch & {
        response?: string;
    };
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
/** Resolve a projection root without repeating the tool name in every path. */
export declare function parseStateReadPath(path: string, historyLimit?: number): StateReadQuery;
export declare function readStatePath(view: TemporalState, path: string, historyLimit?: number): StateReadResult;
/** Reactively locate exact durable sources for one failed state-path resolution. */
export declare function findStateReferenceSources(view: TemporalState, path: string, historyLimit?: number): {
    sources: StateReferenceSource[];
    truncated: boolean;
};
/** Project exact current/historical state paths without exposing temporal metadata. */
export declare function readProjectedState(view: TemporalState, paths: readonly string[], projection?: StateReadProjection, historyLimit?: number): ProjectedStateRead;
export {};
