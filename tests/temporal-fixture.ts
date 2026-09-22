import { readFileSync } from "node:fs";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot, parseRetainedPiCheckpoint, type Snapshot } from "../lib/snapshot.ts";
import { loadScopeStream, parseScopeProvenance, temporalScopePaths } from "../lib/durable.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import type { MaterializedState, StateScope } from "../lib/state.ts";

/** Explicit test-only projection; raw Pi checkpoint data is never replaced or normalized. */
export function resolveCheckpoint(data: unknown, cwd: string, sessionId: string, root: string, sessionKey = sessionId): Snapshot {
	const retained = parseRetainedPiCheckpoint(data);
	if ("disabled" in retained) return emptySnapshot();
	return new TemporalRuntime(cwd, sessionId, root, sessionKey).prepareBoundaryRestore(retained).snapshot;
}

export * from "../lib/durable.ts";
export * from "./storage-fixture.ts";
function materialization(cwd: string, sessionId: string, scope: StateScope, root: string, sessionKey = sessionId) {
	const stream = loadScopeStream(cwd, sessionId, scope, root, sessionKey);
	if (!stream) return undefined;
	let state = structuredClone(stream.checkpoint.state);
	for (const record of stream.patches) state = applyPatch(state, record.patch as JsonObject) as MaterializedState;
	return { state, recentTransitions: stream.patches.map(({ transition, patch }) => ({ id: transition.id, at: transition.position, transitions: [{ scope, patch }] })) };
}
export const loadSessionMaterialization = (cwd: string, session: string, root: string, sessionKey = session) => materialization(cwd, session, "session", root, sessionKey);
export const loadCwdMaterialization = (cwd: string, root: string) => materialization(cwd, "fixture", "cwd", root);
export const loadGlobalMaterialization = (root: string) => materialization("/tmp", "fixture", "global", root);
export const loadSessionState = (cwd: string, session: string, root: string, sessionKey = session) => loadSessionMaterialization(cwd, session, root, sessionKey)?.state;
export const loadCwdState = (cwd: string, root: string) => loadCwdMaterialization(cwd, root)?.state;
export const loadGlobalState = (root: string) => loadGlobalMaterialization(root)?.state;

function optionalSource(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Test-only provenance projection from the canonical scope `meta.json` files. */
export function loadScopeProvenance(cwd: string, sessionId: string, scope: StateScope, root: string, sessionKey = sessionId): ArtifactProvenanceRegistry {
	const paths = temporalScopePaths(cwd, sessionId, scope, root, sessionKey);
	return parseScopeProvenance(optionalSource(paths.meta), paths.meta);
}
export const loadCwdProvenance = (cwd: string, root: string) => loadScopeProvenance(cwd, "fixture", "cwd", root);
export const loadGlobalProvenance = (root: string) => loadScopeProvenance("/tmp", "fixture", "global", root);
