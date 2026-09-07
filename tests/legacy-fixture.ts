import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cwdScopePaths, durablePaths, sessionScopePaths } from "../lib/durable.ts";
import { emptyState, type MaterializedState } from "../lib/state.ts";

/** Test-only predecessor input: deliberately no production publication or validation API. */
function writeLegacy(statePath: string, patchesPath: string, state: MaterializedState): string {
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	writeFileSync(patchesPath, "");
	return statePath;
}

export function writeGlobalState(state: MaterializedState, root: string): string {
	const paths = durablePaths(root);
	return writeLegacy(paths.globalState, paths.globalPatches, state);
}

export function writeCwdState(cwd: string, state: MaterializedState, root: string): string {
	const paths = cwdScopePaths(cwd, root);
	return writeLegacy(paths.state, paths.patches, state);
}

export function writeSessionState(cwd: string, sessionId: string, state: MaterializedState, root: string): string {
	const paths = sessionScopePaths(cwd, sessionId, root);
	return writeLegacy(paths.state, paths.patches, state);
}

export function initializeCwdState(cwd: string, root: string): void {
	writeCwdState(cwd, emptyState(), root);
}
