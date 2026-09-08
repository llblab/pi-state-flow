// Domain: conservative current-snapshot migration planning; Git owns publication and rollback.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
	captureOwnedFileBases,
	cwdScopePaths,
	parseScopeStream,
	parseStateSource,
	serializeScopeStream,
	sessionScopePaths,
	type DurableFileBase,
	type OwnedFileUpdate,
} from "./durable.ts";
import type { StateScope } from "./state.ts";
import type { ScopeStream } from "./temporal.ts";

export interface LegacyStorageMigration {
	bases: DurableFileBase[];
	updates: OwnedFileUpdate[];
	scopes: StateScope[];
}

/** Read-only activation eligibility, before global migration or any repository publication. */
export function hasCwdMaterialization(cwd: string, repositoryRoot: string): boolean {
	const root = resolve(repositoryRoot);
	const directory = cwdScopePaths(cwd, root).directory;
	const [legacy, checkpoint, patches] = captureOwnedFileBases([
		join(directory, "state.json"), join(directory, "checkpoint.json"), join(directory, "patches.jsonl"),
	], root);
	if (checkpoint!.content !== undefined) {
		if (legacy!.content !== undefined) throw new Error(`Ambiguous State Flow storage has both current and checkpoint snapshots: ${directory}`);
		return parseScopeStream(checkpoint!.content, patches!.content, "cwd", cwd) !== undefined;
	}
	if (legacy!.content !== undefined) return parseStateSource(legacy!.content, legacy!.path) !== undefined;
	if (patches!.content !== undefined) throw new Error(`State Flow tail has no provable snapshot: ${directory}`);
	return false;
}

/** Plan from current scope snapshots only; old explanatory journals are never replay input. */
export function planLegacyStorageMigration(
	cwd: string,
	sessionId: string,
	repositoryRoot: string,
	origin: string = randomUUID(),
	sessionKey = sessionId,
): LegacyStorageMigration {
	const root = resolve(repositoryRoot);
	const directories: Record<StateScope, string> = {
		global: root,
		cwd: cwdScopePaths(cwd, root).directory,
		session: sessionScopePaths(cwd, sessionId, root, sessionKey).directory,
	};
	const paths = Object.values(directories).flatMap((directory) => [
		join(directory, "state.json"), join(directory, "checkpoint.json"), join(directory, "patches.jsonl"),
	]);
	const bases = captureOwnedFileBases(paths, root);
	const byPath = new Map(bases.map((base) => [base.path, base]));
	const updates: OwnedFileUpdate[] = [];
	const scopes: StateScope[] = [];
	for (const scope of ["global", "cwd", "session"] as const) {
		const directory = directories[scope];
		const legacy = byPath.get(join(directory, "state.json"))!;
		const checkpoint = byPath.get(join(directory, "checkpoint.json"))!;
		const patches = byPath.get(join(directory, "patches.jsonl"))!;
		if (checkpoint.content !== undefined) {
			if (legacy.content !== undefined) throw new Error(`Ambiguous State Flow storage has both current and checkpoint snapshots: ${directory}`);
			parseScopeStream(checkpoint.content, patches.content, scope, scope === "cwd" ? cwd : undefined);
			continue;
		}
		if (legacy.content === undefined) {
			if (patches.content !== undefined) throw new Error(`State Flow tail has no provable snapshot: ${directory}`);
			continue;
		}
		const state = parseStateSource(legacy.content, legacy.path)!;
		const stream: ScopeStream = {
			checkpoint: { through: { id: origin, position: 0, parent: null }, state },
			patches: [],
		};
		const source = serializeScopeStream(stream, scope, scope === "cwd" ? cwd : undefined);
		scopes.push(scope);
		updates.push(
			{ path: checkpoint.path, content: source.checkpoint },
			{ path: patches.path, content: source.patches },
			{ path: legacy.path },
		);
	}
	return { bases, updates, scopes };
}
