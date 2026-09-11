import { readFileSync } from "node:fs";
import {
	hashArtifactSource,
	isArtifactHash,
	type ArtifactMetadata,
	type ArtifactProvenance,
	type ArtifactRegistry,
} from "./artifact.ts";
import { canonicalJson, isObject, type JsonObject, type JsonValue } from "./json.ts";
import type { MaterializedState } from "./state.ts";

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

function legacyCompilation(value: JsonValue): JsonObject | undefined {
	if (!hasContent(value)) return undefined;
	return isObject(value) ? structuredClone(value) : { value: structuredClone(value) };
}

/** Move the retired contract store into source-addressed Skill artifacts. */
export function migrateLegacySkillCompilations(
	state: MaterializedState,
	hasher: SkillSourceHasher = hashSkillSource,
): MaterializedState {
	if (!isObject(state.contract.compiled_skills)) return structuredClone(state);
	const legacy = state.contract.compiled_skills;
	const next = structuredClone(state);
	delete next.contract.compiled_skills;
	for (const [source, value] of Object.entries(legacy)) {
		const compilation = legacyCompilation(value);
		if (!compilation) continue;
		let hash: string;
		let verified = true;
		try {
			hash = hasher(source);
			if (!isArtifactHash(hash)) throw new Error("invalid source hash");
		} catch {
			// Preserve useful legacy behavior while ensuring a later observable source
			// identity normally invalidates this explicitly unverified fallback.
			hash = hashArtifactSource(canonicalJson({ source, compilation }));
			verified = false;
		}
		const metadata: ArtifactMetadata = {
			description: `Compiled operational guidance for the Skill at ${source}`,
			hash,
			compiler: SKILL_ARTIFACT_COMPILER,
			kind: "skill",
			compilation,
			...(verified ? {} : { source_hash_verified: false }),
		};
		Object.defineProperty(next.artifacts, source, {
			value: metadata,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return next;
}

export function skillPathFromRead(toolName: unknown, args: unknown): string | undefined {
	if (toolName !== "read" || !isObject(args) || typeof args.path !== "string") return undefined;
	return /(^|[\\/])SKILL\.md$/.test(args.path) ? args.path : undefined;
}

export interface SuccessfulSkillRead {
	path: string;
	hash?: string;
	error?: string;
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

	constructor(hashSource: SkillSourceHasher = hashSkillSource) {
		this.hashSource = hashSource;
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
		const source = skillPathFromRead(pending.toolName, pending.args);
		if (!source) return;
		try {
			const hash = this.hashSource(source);
			if (!isArtifactHash(hash)) throw new Error("hasher returned a non-canonical SHA-256 identity");
			this.successful.set(source, { path: source, hash });
		} catch (error) {
			this.successful.set(source, {
				path: source,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#record(toolCallId: string, toolName: string, args: unknown): void {
		if (toolName !== "read") {
			this.#pending.delete(toolCallId);
			return;
		}
		this.#pending.set(toolCallId, { toolName, args });
	}
}
