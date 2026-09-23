import { mkdirSync, writeFileSync } from "node:fs";
import { temporalScopePaths, serializeScopeMetadata, serializeScopeStream } from "../lib/durable.ts";
import { emptyState, type MaterializedState, type StateScope } from "../lib/state.ts";
import { createTemporalState } from "../lib/temporal.ts";
import "./git-environment.ts";

function writeScope(cwd: string, sessionId: string, scope: StateScope, state: MaterializedState, root: string): string {
	const states = { global: emptyState(), cwd: emptyState(), session: emptyState(), [scope]: state };
	const stream = createTemporalState(states, `fixture-${scope}`).scopes[scope];
	const paths = temporalScopePaths(cwd, sessionId, scope, root);
	mkdirSync(paths.directory, { recursive: true });
	const sources = serializeScopeStream(stream, scope, scope === "cwd" ? cwd : undefined);
	writeFileSync(paths.checkpoint, sources.checkpoint);
	writeFileSync(paths.patches, sources.patches);
	writeFileSync(paths.meta, serializeScopeMetadata({}, stream, scope, scope === "cwd" ? cwd : undefined));
	return paths.checkpoint;
}

export function writeGlobalState(state: MaterializedState, root: string): string {
	return writeScope("/fixture", "fixture", "global", state, root);
}

export function writeCwdState(cwd: string, state: MaterializedState, root: string): string {
	return writeScope(cwd, "fixture", "cwd", state, root);
}

export function writeSessionState(cwd: string, sessionId: string, state: MaterializedState, root: string): string {
	return writeScope(cwd, sessionId, "session", state, root);
}

export function initializeCwdState(cwd: string, root: string): void {
	writeCwdState(cwd, emptyState(), root);
}
