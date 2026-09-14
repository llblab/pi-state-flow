import { projectStateForModel, type MaterializedState, type ScopePatch, type StateScope } from "./state.ts";
import { readTemporalState, type TemporalState, type TransitionBoundary } from "./temporal.ts";

export type StateReadQuery =
	| { kind: "state"; path: string; offset: number; scope?: StateScope }
	| { kind: "patch"; path: string; offset: number; scope: StateScope };

export type StateReadResult =
	| { path: string; boundary: TransitionBoundary; state: MaterializedState }
	| { path: string; boundary: TransitionBoundary; patch: ScopePatch & { response?: string } };

const PATH_PATTERN = /^state(?:\[(\d+)\])?(?:\.(global|cwd|session)(?:\[(\d+)\])?(?:\.patches(?:\[(\d+)\])?)?)?$/;

/** Resolve the compact model-facing path grammar without treating aliases as literal JSON containers. */
export function parseStateReadPath(path: string): StateReadQuery {
	const match = PATH_PATTERN.exec(path);
	if (!match) throw new Error("Invalid State Flow read path");
	const [, effectiveOffset, scope, scopeOffset, patchOffset] = match;
	if (effectiveOffset !== undefined && scope !== undefined) throw new Error("State Flow read path cannot index both state and a scope");
	if (path.includes(".patches") && scopeOffset !== undefined) throw new Error("Index patches after .patches, not after the scope");
	const rawOffset = patchOffset ?? scopeOffset ?? effectiveOffset ?? "0";
	const offset = Number(rawOffset);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 7) throw new Error("State Flow read path index must be an integer from 0 to 7");
	if (patchOffset !== undefined || path.endsWith(".patches")) {
		return { kind: "patch", path, offset, scope: scope as StateScope };
	}
	return { kind: "state", path, offset, ...(scope === undefined ? {} : { scope: scope as StateScope }) };
}

export function readStatePath(view: TemporalState, path: string): StateReadResult {
	const query = parseStateReadPath(path);
	if (query.kind === "state") {
		const boundary = view.lineage[view.lineage.length - 1 - query.offset];
		if (!boundary) throw new Error("Requested history predates the proven temporal origin");
		return { path, boundary: structuredClone(boundary), state: projectStateForModel(readTemporalState(view, query.offset, query.scope)) };
	}
	const record = view.scopes[query.scope].patches.at(-1 - query.offset);
	if (!record) throw new Error(`Requested ${query.scope} patch predates retained hot history`);
	return { path, boundary: structuredClone(record.transition), patch: structuredClone(record.patch) };
}
