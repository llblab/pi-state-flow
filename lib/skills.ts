import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	hashArtifactSource,
	isArtifactHash,
	type ArtifactProvenance,
	type ArtifactRegistry,
} from "./artifact.ts";
import { isObject } from "./json.ts";
import type { StateScope } from "./state.ts";

export const SKILL_ARTIFACT_COMPILER = "skill-artifact-v1";

function hasContent(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (isObject(value)) return Object.keys(value).length > 0;
	return value !== undefined && value !== null;
}

export function hasCompiledSkillArtifact(
	artifacts: ArtifactRegistry,
	provenance: ArtifactProvenance | undefined,
	source: string,
	expectedHash?: string,
): boolean {
	const metadata = artifacts[source];
	if (!isObject(metadata)
		|| metadata.kind !== "skill"
		|| !isObject(metadata.compilation)
		|| !hasContent(metadata.compilation)
		|| provenance?.malformed === true) return false;
	const compilerRevision = provenance !== undefined && Object.hasOwn(provenance, "compilerRevision")
		? provenance.compilerRevision
		: metadata.compiler;
	const sourceHash = provenance !== undefined && Object.hasOwn(provenance, "sourceHash")
		? provenance.sourceHash
		: metadata.hash;
	return compilerRevision === SKILL_ARTIFACT_COMPILER
		&& (expectedHash === undefined || sourceHash === expectedHash);
}

export type SkillSourceHasher = (source: string) => string;

export function hashSkillSource(source: string): string {
	return hashArtifactSource(readFileSync(source));
}

function readPath(toolName: unknown, args: unknown): string | undefined {
	if (toolName !== "read" || !isObject(args) || typeof args.path !== "string") return undefined;
	return args.path;
}

export interface SuccessfulSkillRead {
	path: string;
	scope: StateScope;
	hash?: string;
	error?: string;
}

export interface SkillCommandInfo {
	source: string;
	sourceInfo: { path: string; scope: string };
}

export interface RegisteredSkillSource {
	path: string;
	scope: StateScope;
}

export type RegisteredSkillResolver = (path: string) => RegisteredSkillSource | undefined;

export function registeredSkillResolver(cwd: string, commands: readonly SkillCommandInfo[]): RegisteredSkillResolver {
	const skills = new Map<string, RegisteredSkillSource>();
	const conflicts = new Set<string>();
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const scope = command.sourceInfo.scope === "user" ? "global"
			: command.sourceInfo.scope === "project" ? "cwd"
			: command.sourceInfo.scope === "temporary" ? "session"
			: undefined;
		if (!scope) continue;
		const path = resolve(cwd, command.sourceInfo.path);
		const existing = skills.get(path);
		if (existing && existing.scope !== scope) {
			skills.delete(path);
			conflicts.add(path);
		} else if (!conflicts.has(path)) {
			skills.set(path, { path, scope });
		}
	}
	return (path) => skills.get(resolve(cwd, path));
}

interface PendingRead {
	toolName: string;
	args: unknown;
}

/** Correlates Pi's mutable tool lifecycle and captures trusted source identity. */
export class SkillReadTracker {
	readonly successful = new Map<string, SuccessfulSkillRead>();
	readonly #pending = new Map<string, PendingRead>();
	readonly hashSource: SkillSourceHasher;
	readonly resolveRegistered: RegisteredSkillResolver;

	constructor(hashSource: SkillSourceHasher = hashSkillSource, resolveRegistered: RegisteredSkillResolver = () => undefined) {
		this.hashSource = hashSource;
		this.resolveRegistered = resolveRegistered;
	}

	clear(): void {
		this.successful.clear();
		this.#pending.clear();
	}

	recordStart(toolCallId: string, toolName: string, args: unknown): void {
		this.#record(toolCallId, toolName, args);
	}

	recordCall(toolCallId: string, toolName: string, input: unknown): void {
		this.#record(toolCallId, toolName, input);
	}

	recordEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const pending = this.#pending.get(toolCallId);
		this.#pending.delete(toolCallId);
		if (isError || !pending || toolName !== pending.toolName) return;
		this.#recordSuccessful(pending.toolName, pending.args);
	}

	recordResult(toolName: string, input: unknown, isError: boolean): SuccessfulSkillRead | undefined {
		if (isError) return undefined;
		return this.#recordSuccessful(toolName, input);
	}

	delete(path: string): void {
		this.successful.delete(path);
	}

	#recordSuccessful(toolName: string, args: unknown): SuccessfulSkillRead | undefined {
		const source = readPath(toolName, args);
		if (!source) return undefined;
		const registered = this.resolveRegistered(source);
		if (!registered) return undefined;
		let read: SuccessfulSkillRead;
		try {
			const hash = this.hashSource(registered.path);
			if (!isArtifactHash(hash)) throw new Error("hasher returned a non-canonical SHA-256 identity");
			read = { ...registered, hash };
		} catch (error) {
			read = { ...registered, error: error instanceof Error ? error.message : String(error) };
		}
		this.successful.set(registered.path, read);
		return read;
	}

	#record(toolCallId: string, toolName: string, args: unknown): void {
		if (toolName !== "read") {
			this.#pending.delete(toolCallId);
			return;
		}
		this.#pending.set(toolCallId, { toolName, args });
	}
}
