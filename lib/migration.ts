// Domain: predecessor temporal-envelope migration planning; Git/files backends own publication and rollback.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	captureOwnedFileBases,
	cwdScopePaths,
	parseScopeStream,
	serializeScopeMetadata,
	serializeScopeStream,
	sessionScopeKey,
	sessionScopePaths,
	type DurableFileBase,
	type OwnedFileUpdate,
} from "./durable.ts";
import { parseSessionRuntime, serializeSessionRuntime } from "./snapshot.ts";
import type { StateScope } from "./state.ts";

export interface LegacyStorageMigration {
	bases: DurableFileBase[];
	updates: OwnedFileUpdate[];
	scopes: StateScope[];
}

interface MigrationDirectory {
	directory: string;
	scope: StateScope;
	cwdIdentity?: string;
	sessionId?: string;
}

/** Discover every owner-proven CWD and session cohort beneath the configured store. */
function migrationDirectories(cwd: string, sessionId: string, root: string, sessionKey: string): MigrationDirectory[] {
	const selectedCwd = cwdScopePaths(cwd, root).directory;
	const selectedSession = sessionScopePaths(cwd, sessionId, root, sessionKey).directory;
	const directories: MigrationDirectory[] = [{ directory: root, scope: "global" }];
	const cwdOwners = new Map<string, string>([[selectedCwd, resolve(cwd)]]);
	if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(root, entry.name);
			let checkpoint: unknown;
			let meta: unknown;
			try { checkpoint = JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8")); }
			catch { continue; }
			try { meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")); } catch { /* predecessor metadata may be absent */ }
			const owner = checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) && (checkpoint as { owner?: unknown }).owner
				? (checkpoint as { owner: { cwd?: unknown } }).owner
				: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as { owner?: { cwd?: unknown } }).owner : undefined;
			if (owner && typeof owner.cwd === "string" && resolve(owner.cwd) === owner.cwd) cwdOwners.set(directory, owner.cwd);
		}
	}
	for (const [cwdDirectory, cwdOwner] of cwdOwners) {
		directories.push({ directory: cwdDirectory, scope: "cwd", cwdIdentity: cwdOwner });
		if (lstatSync(cwdDirectory, { throwIfNoEntry: false }) === undefined) continue;
		for (const entry of readdirSync(cwdDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try { sessionScopeKey(entry.name); } catch { continue; }
			const directory = join(cwdDirectory, entry.name);
			let meta: unknown;
			try { meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")); }
			catch { continue; }
			const identity = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as { identity?: unknown }).identity : undefined;
			if (!identity || typeof identity !== "object" || Array.isArray(identity)) continue;
			const owner = identity as { cwd?: unknown; sessionId?: unknown };
			if (owner.cwd === cwdOwner && typeof owner.sessionId === "string" && owner.sessionId.length > 0) {
				directories.push({ directory, scope: "session", cwdIdentity: cwdOwner, sessionId: owner.sessionId });
			}
		}
	}
	if (!directories.some(({ directory }) => directory === selectedSession)) {
		directories.push({ directory: selectedSession, scope: "session", cwdIdentity: resolve(cwd), sessionId });
	}
	return directories;
}

/** Read-only activation eligibility, before global migration or any repository publication. */
export function hasCwdMaterialization(cwd: string, repositoryRoot: string): boolean {
	const root = resolve(repositoryRoot);
	const directory = cwdScopePaths(cwd, root).directory;
	const [checkpoint, patches, meta] = captureOwnedFileBases([
		join(directory, "checkpoint.json"), join(directory, "patches.jsonl"), join(directory, "meta.json"),
	], root);
	if (checkpoint!.content !== undefined) return parseScopeStream(checkpoint!.content, patches!.content, "cwd", cwd, meta!.content) !== undefined;
	if (patches!.content !== undefined) throw new Error(`State Flow tail has no provable checkpoint: ${directory}`);
	return false;
}

/** Detect predecessor snapshots or temporal envelopes without mutating the store. */
export function hasLegacyStateSources(
	cwd: string,
	sessionId: string,
	repositoryRoot: string,
	sessionKey = sessionId,
): boolean {
	const root = resolve(repositoryRoot);
	return migrationDirectories(cwd, sessionId, root, sessionKey).some(({ directory, scope }) => {
		if (lstatSync(join(directory, "checkpoint.json"), { throwIfNoEntry: false }) === undefined) return false;
		try {
			const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
			if (meta === null || typeof meta !== "object" || !("temporal" in meta)) return true;
			return scope === "session"
				&& lstatSync(join(directory, "runtime.json"), { throwIfNoEntry: false }) === undefined
				&& ("identity" in meta || "lineage" in meta);
		} catch { return true; }
	});
}

/** Plan from current scope snapshots only; old explanatory journals are never replay input. */
export function planLegacyStorageMigration(
	cwd: string,
	sessionId: string,
	repositoryRoot: string,
	_origin?: string,
	sessionKey = sessionId,
): LegacyStorageMigration {
	const root = resolve(repositoryRoot);
	const directories = migrationDirectories(cwd, sessionId, root, sessionKey);
	const paths = directories.flatMap(({ directory, scope }) => [
		join(directory, "checkpoint.json"), join(directory, "patches.jsonl"), join(directory, "meta.json"),
		...(scope === "session" ? [join(directory, "config.json"), join(directory, "runtime.json")] : []),
	]);
	const bases = captureOwnedFileBases(paths, root);
	const byPath = new Map(bases.map((base) => [base.path, base]));
	const updates: OwnedFileUpdate[] = [];
	const scopes: StateScope[] = [];
	for (const { scope, directory, cwdIdentity, sessionId: ownedSessionId } of directories) {
		const checkpoint = byPath.get(join(directory, "checkpoint.json"))!;
		const patches = byPath.get(join(directory, "patches.jsonl"))!;
		const meta = byPath.get(join(directory, "meta.json"))!;
		if (checkpoint.content !== undefined) {
			const stream = parseScopeStream(checkpoint.content, patches.content, scope, scope === "cwd" ? cwdIdentity : undefined, meta.content)!;
			const source = serializeScopeStream(stream, scope, scope === "cwd" ? cwdIdentity : undefined);
			const metadata = serializeScopeMetadata(undefined, stream, scope, scope === "cwd" ? cwdIdentity : undefined, meta.content);
			const cohortUpdates: OwnedFileUpdate[] = [
				...(checkpoint.content === source.checkpoint ? [] : [{ path: checkpoint.path, content: source.checkpoint }]),
				...(patches.content === source.patches ? [] : [{ path: patches.path, content: source.patches }]),
				...(meta.content === metadata ? [] : [{ path: meta.path, content: metadata }]),
			];
			if (scope === "session") {
				const config = byPath.get(join(directory, "config.json"))!;
				const runtimeFile = byPath.get(join(directory, "runtime.json"))!;
				const runtime = parseSessionRuntime(config.content, runtimeFile.content, cwdIdentity!, ownedSessionId!, meta.content);
				if (runtime !== undefined) {
					const serialized = serializeSessionRuntime(runtime, cwdIdentity!, ownedSessionId!);
					if (runtimeFile.content !== serialized.runtime) cohortUpdates.push({ path: runtimeFile.path, content: serialized.runtime });
				}
			}
			if (cohortUpdates.length > 0) {
				if (!scopes.includes(scope)) scopes.push(scope);
				updates.push(...cohortUpdates);
			}
			continue;
		}
		if (patches.content !== undefined) throw new Error(`State Flow tail has no provable checkpoint: ${directory}`);
	}
	return { bases, updates, scopes };
}
