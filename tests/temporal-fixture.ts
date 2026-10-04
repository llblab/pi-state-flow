import { readFileSync } from "node:fs";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { emptySnapshot, parseRetainedPiCheckpoint, type Snapshot } from "../lib/snapshot.ts";
import { loadScopeStream, parseScopeProvenance, temporalScopePaths } from "../lib/durable.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import { overlayStates, type StateScope } from "../lib/state.ts";

/** Explicit test-only projection of the lifecycle a Pi checkpoint records; it never selects a memory revision. */
export function resolveCheckpoint(data: unknown, _cwd: string, _sessionId: string, _root: string, _sessionKey?: string): Snapshot {
	const retained = parseRetainedPiCheckpoint(data);
	if (!("boundary" in retained)) return emptySnapshot(retained.mode);
	return { config: { mode: retained.mode }, meta: {
		step: retained.step,
		...(retained.bootstrap ? { bootstrap: true } : {}),
		...(retained.specification === undefined ? {} : { specification: retained.specification }),
	} };
}

export * from "../lib/durable.ts";
export * from "./storage-fixture.ts";
function materialization(cwd: string, sessionId: string, scope: StateScope, root: string, sessionKey = sessionId) {
	const stream = loadScopeStream(cwd, sessionId, scope, root, sessionKey);
	if (!stream) return undefined;
	let state = structuredClone(stream.checkpoint.state);
	for (const record of stream.patches) state = applyPatch(state, record.patch as JsonObject);
	return { state: overlayStates(state), recentTransitions: stream.patches.map(({ transition, patch }) => ({ id: transition.id, at: transition.position, transitions: [{ scope, patch }] })) };
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
