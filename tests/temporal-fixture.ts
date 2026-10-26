import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { emptySnapshot, prepareRetainedPolicyMigration, type Snapshot } from "../lib/snapshot.ts";
import { captureSelectedNativeMarker } from "../lib/session.ts";
import { DEFAULT_SCOPE_SELECTION } from "../lib/selection.ts";
import { loadScopeStream, parseScopeProvenance, temporalScopePaths, type captureTemporalFileBases } from "../lib/durable.ts";
import { applyPatch, isObject, type JsonObject } from "../lib/json.ts";
import { overlayStates, type StateScope } from "../lib/state.ts";

/** Explicit test-only projection of the lifecycle a Pi checkpoint records; it never selects a memory revision. */
export function resolveCheckpoint(data: unknown, _cwd: string, _sessionId: string, _root: string, _sessionKey?: string): Snapshot {
	// Policy-only native observations carry no accepted semantic boundary or run counter.
	if (isObject(data) && data.version === 2 && Object.hasOwn(data, "owner")) return emptySnapshot(captureSelectedNativeMarker(data).mode);
	const retained = prepareRetainedPolicyMigration(data, DEFAULT_SCOPE_SELECTION).checkpoint;
	if (!("boundary" in retained)) return emptySnapshot(retained.mode);
	return { config: { mode: retained.mode }, meta: {
		step: retained.step,
		...(retained.bootstrap ? { bootstrap: true } : {}),
		...(retained.specification === undefined ? {} : { specification: retained.specification }),
	} };
}

export function nativePolicyMarker(owner: string, mode: "off" | "passive" | "active") {
	return { version: 2, owner, mode, scopes: ["global", "cwd", "session"] };
}

/** Native tree acceptance may persist its mode, but cannot change semantic bytes or run metadata. */
export function assertNativeModeOnlyChange(actual: ReturnType<typeof captureTemporalFileBases>, before: ReturnType<typeof captureTemporalFileBases>, config: string, mode: "passive") {
	assert.deepEqual(actual.filter(file => file.path !== config), before.filter(file => file.path !== config));
	const previous = before.find(file => file.path === config)!;
	const current = actual.find(file => file.path === config)!;
	assert.deepEqual(JSON.parse(current.content!), { ...JSON.parse(previous.content!), mode });
}

export function assertTreePolicyCheckpoint(actual: Array<{ type: string; customType?: string; data?: any }>, before: Array<{ type: string; customType?: string; data?: any }>) {
	assert.deepEqual(actual.slice(0, -1), before);
	const prior = before.findLast(entry => entry.customType === "state-flow-snapshot")!;
	assert.deepEqual(actual.at(-1), { type: "custom", customType: "state-flow-snapshot", data: { ...prior.data, mode: "passive" } });
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
