import { execFileSync } from "node:child_process";
import { isLocalGitRepository } from "../lib/git.ts";
import { inspectSnapshotRevision } from "../lib/runtime.ts";
import { emptySnapshot, isFileRevision, parsePiCheckpoint, type Snapshot } from "../lib/snapshot.ts";
import { loadScopeStream } from "../lib/durable.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import type { MaterializedState, StateScope } from "../lib/state.ts";

/** Explicit test-only projection; raw Pi checkpoint data is never replaced or normalized. */
export function resolveCheckpoint(data: unknown, cwd: string, sessionId: string, root: string): Snapshot {
	const parsed = parsePiCheckpoint(data);
	if ("disabled" in parsed) return emptySnapshot();
	if (!("revision" in parsed)) return parsed;
	const snapshot = inspectSnapshotRevision(cwd, sessionId, root, parsed.revision).snapshot;
	if (isFileRevision(parsed.revision)) return snapshot;
	try {
		if (isLocalGitRepository(root)) return snapshot;
		execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", parsed.revision, "@{upstream}"], { stdio: "ignore" });
	} catch {
		snapshot.meta.pendingPublication = { commit: parsed.revision, error: "Durable publication intent is unconfirmed" };
	}
	return snapshot;
}

export * from "../lib/durable.ts";
export * from "./legacy-fixture.ts";
function materialization(cwd: string, sessionId: string, scope: StateScope, root: string) {
	const stream = loadScopeStream(cwd, sessionId, scope, root);
	if (!stream) return undefined;
	let state = structuredClone(stream.checkpoint.state);
	for (const record of stream.patches) state = applyPatch(state, record.patch as JsonObject) as MaterializedState;
	return { state, recentTransitions: stream.patches.map(({ transition, patch }) => ({ id: transition.id, at: transition.position, transitions: [{ scope, patch }] })) };
}
export const loadSessionMaterialization = (cwd: string, session: string, root: string) => materialization(cwd, session, "session", root);
export const loadCwdMaterialization = (cwd: string, root: string) => materialization(cwd, "fixture", "cwd", root);
export const loadGlobalMaterialization = (root: string) => materialization("/tmp", "fixture", "global", root);
export const loadSessionState = (cwd: string, session: string, root: string) => loadSessionMaterialization(cwd, session, root)?.state;
export const loadCwdState = (cwd: string, root: string) => loadCwdMaterialization(cwd, root)?.state;
export const loadGlobalState = (root: string) => loadGlobalMaterialization(root)?.state;
