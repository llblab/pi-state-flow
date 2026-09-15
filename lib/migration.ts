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
import { canonicalJson } from "./json.ts";
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
			if (owner.cwd === cwdOwner && typeof owner.sessionId === "string" && owner.sessionId.length > 0) directories.push({ directory, scope: "session" });
		}
	}
	if (!directories.some(({ directory }) => directory === selectedSession)) directories.push({ directory: selectedSession, scope: "session" });
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
	return migrationDirectories(cwd, sessionId, root, sessionKey).some(({ directory }) => {
		if (lstatSync(join(directory, "checkpoint.json"), { throwIfNoEntry: false }) === undefined) return false;
		try {
			const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
			return meta === null || typeof meta !== "object" || !("temporal" in meta);
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
	const paths = directories.flatMap(({ directory }) => [
		join(directory, "checkpoint.json"), join(directory, "patches.jsonl"), join(directory, "meta.json"),
	]);
	const bases = captureOwnedFileBases(paths, root);
	const byPath = new Map(bases.map((base) => [base.path, base]));
	const updates: OwnedFileUpdate[] = [];
	const scopes: StateScope[] = [];
	for (const { scope, directory, cwdIdentity } of directories) {
		const checkpoint = byPath.get(join(directory, "checkpoint.json"))!;
		const patches = byPath.get(join(directory, "patches.jsonl"))!;
		const meta = byPath.get(join(directory, "meta.json"))!;
		if (checkpoint.content !== undefined) {
			const stream = parseScopeStream(checkpoint.content, patches.content, scope, cwdIdentity, meta.content)!;
			const source = serializeScopeStream(stream, scope, cwdIdentity);
			let metadata = serializeScopeMetadata(undefined, stream, scope, cwdIdentity, meta.content);
			if (scope === "session") {
				const runtime = JSON.parse(metadata) as Record<string, unknown>;
				runtime.revision = "self";
				runtime.temporalRevision = "self";
				metadata = `${canonicalJson(runtime)}\n`;
			}
			if (checkpoint.content !== source.checkpoint || patches.content !== source.patches || meta.content !== metadata) {
				if (!scopes.includes(scope)) scopes.push(scope);
				updates.push({ path: checkpoint.path, content: source.checkpoint }, { path: patches.path, content: source.patches }, { path: meta.path, content: metadata });
			}
			continue;
		}
		if (patches.content !== undefined) throw new Error(`State Flow tail has no provable checkpoint: ${directory}`);
	}
	return { bases, updates, scopes };
}
