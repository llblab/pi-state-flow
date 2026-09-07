import { createHash } from "node:crypto";
import { containsNull, isJsonValue, isObject, type JsonObject } from "./json.ts";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Current compiler protocol for ordinary source artifacts such as Knowledge Markdown. */
export const ORDINARY_ARTIFACT_COMPILER = "artifact-v1";

/** Source-addressed metadata retained after artifact compilation. */
export type ArtifactMetadata = JsonObject & {
	description: string;
	hash: string;
	compiler: string;
	compiled_at?: string;
	compilation?: JsonObject;
	kind?: string;
};

/** Artifact source paths are the canonical registry keys. */
export type ArtifactRegistry = JsonObject & Record<string, ArtifactMetadata>;

/** Source identity is sufficient for freshness decisions; it never contains the source body. */
export interface ArtifactSourceIdentity {
	path: string;
	hash: string;
}

export type ArtifactInvalidationReason =
	| "new"
	| "source-changed"
	| "compiler-changed"
	| "invalid-metadata"
	| "explicit-refresh";

export type ArtifactFreshness =
	| { kind: "fresh" }
	| { kind: "requires-compilation"; reason: ArtifactInvalidationReason };

export interface ArtifactInvalidationRequest extends ArtifactSourceIdentity {
	reason: ArtifactInvalidationReason;
}

export interface ArtifactInvalidationPlan {
	fresh: ArtifactSourceIdentity[];
	requiresCompilation: ArtifactInvalidationRequest[];
	removed: string[];
}

export interface ArtifactInvalidationOptions {
	/** Refresh every source, or only paths in the supplied set. */
	explicitRefresh?: boolean | ReadonlySet<string>;
}

/** Compiler-owned fields before State Flow attaches trusted source freshness metadata. */
export type ArtifactCompilerOutput = JsonObject & {
	description: string;
	compiled_at?: string;
	compilation?: JsonObject;
	kind?: string;
};

export interface ArtifactCompilationUpdate {
	source: ArtifactSourceIdentity;
	compiler: string;
	output: ArtifactCompilerOutput;
}

export function hashArtifactSource(source: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function isArtifactHash(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function validateArtifactMetadata(value: unknown, path = "<unknown>"): asserts value is ArtifactMetadata {
	if (!isObject(value) || !isJsonValue(value)) {
		throw new Error(`Artifact metadata at ${path} must be finite, acyclic JSON data`);
	}
	if (containsNull(value)) throw new Error(`Artifact metadata at ${path} cannot contain null`);
	if (typeof value.description !== "string" || value.description.trim().length === 0) {
		throw new Error(`Artifact metadata at ${path} must have a non-empty description`);
	}
	if (!isArtifactHash(value.hash)) {
		throw new Error(`Artifact metadata at ${path} must have a sha256:<64 lowercase hex characters> hash`);
	}
	if (typeof value.compiler !== "string" || value.compiler.trim().length === 0) {
		throw new Error(`Artifact metadata at ${path} must have a non-empty compiler revision`);
	}
	if (Object.hasOwn(value, "compiled_at") && typeof value.compiled_at !== "string") {
		throw new Error(`Artifact metadata at ${path} compiled_at must be a string`);
	}
	if (Object.hasOwn(value, "compilation") && !isObject(value.compilation)) {
		throw new Error(`Artifact metadata at ${path} compilation must be an object`);
	}
	if (Object.hasOwn(value, "kind")
		&& (typeof value.kind !== "string" || value.kind.trim().length === 0)) {
		throw new Error(`Artifact metadata at ${path} kind must be a non-empty string`);
	}
}

export function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
	try {
		validateArtifactMetadata(value);
		return true;
	} catch {
		return false;
	}
}

export function validateArtifactRegistry(value: unknown): asserts value is ArtifactRegistry {
	if (!isObject(value)) throw new Error("Artifacts must be a path-keyed JSON object");
	for (const [path, metadata] of Object.entries(value)) {
		if (path.trim().length === 0) throw new Error("Artifact path keys must be non-empty");
		validateArtifactMetadata(metadata, path);
	}
}

export function isArtifactRegistry(value: unknown): value is ArtifactRegistry {
	try {
		validateArtifactRegistry(value);
		return true;
	} catch {
		return false;
	}
}

function validateSourceIdentity(source: ArtifactSourceIdentity): void {
	if (typeof source.path !== "string" || source.path.trim().length === 0) {
		throw new Error("Artifact source path must be non-empty");
	}
	if (!isArtifactHash(source.hash)) {
		throw new Error(`Artifact source at ${source.path} must have a sha256:<64 lowercase hex characters> hash`);
	}
}

function validateCompilerRevision(compiler: string, path?: string): void {
	if (typeof compiler !== "string" || compiler.trim().length === 0) {
		throw new Error(path === undefined
			? "Artifact compiler revision must be non-empty"
			: `Artifact compiler revision at ${path} must be non-empty`);
	}
}

function refreshRequested(path: string, explicitRefresh: boolean | ReadonlySet<string> | undefined): boolean {
	if (explicitRefresh === true) return true;
	if (!explicitRefresh || typeof explicitRefresh !== "object" || typeof explicitRefresh.has !== "function") return false;
	return explicitRefresh.has(path);
}

/** Classify freshness from source identity and metadata without acquiring the source body. */
export function classifyArtifactFreshness(
	source: ArtifactSourceIdentity,
	metadata: unknown,
	compiler: string,
	explicitRefresh = false,
): ArtifactFreshness {
	validateSourceIdentity(source);
	validateCompilerRevision(compiler);
	if (metadata === undefined) return { kind: "requires-compilation", reason: "new" };
	if (!isArtifactMetadata(metadata)) return { kind: "requires-compilation", reason: "invalid-metadata" };
	if (metadata.hash !== source.hash) return { kind: "requires-compilation", reason: "source-changed" };
	if (metadata.compiler !== compiler) return { kind: "requires-compilation", reason: "compiler-changed" };
	if (explicitRefresh) return { kind: "requires-compilation", reason: "explicit-refresh" };
	return { kind: "fresh" };
}

/** Produce a deterministic acquisition plan from path/hash candidates alone. */
export function planArtifactInvalidation(
	sources: readonly ArtifactSourceIdentity[],
	registry: Readonly<Record<string, unknown>>,
	compiler: string,
	options: ArtifactInvalidationOptions = {},
): ArtifactInvalidationPlan {
	if (!isObject(registry)) throw new Error("Artifacts must be a path-keyed JSON object");
	validateCompilerRevision(compiler);
	const ordered = [...sources].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const seen = new Set<string>();
	const fresh: ArtifactSourceIdentity[] = [];
	const requiresCompilation: ArtifactInvalidationRequest[] = [];
	for (const source of ordered) {
		if (seen.has(source.path)) throw new Error(`Duplicate artifact source path: ${source.path}`);
		seen.add(source.path);
		const metadata = Object.hasOwn(registry, source.path) ? registry[source.path] : undefined;
		const freshness = classifyArtifactFreshness(
			source,
			metadata,
			compiler,
			refreshRequested(source.path, options.explicitRefresh),
		);
		const identity = { path: source.path, hash: source.hash };
		if (freshness.kind === "fresh") fresh.push(identity);
		else requiresCompilation.push({ ...identity, reason: freshness.reason });
	}
	const removed = Object.keys(registry).filter((path) => !seen.has(path)).sort();
	return { fresh, requiresCompilation, removed };
}

function compilationMetadata(update: ArtifactCompilationUpdate): ArtifactMetadata {
	validateSourceIdentity(update.source);
	validateCompilerRevision(update.compiler, update.source.path);
	if (!isObject(update.output) || Object.hasOwn(update.output, "hash") || Object.hasOwn(update.output, "compiler")) {
		throw new Error(`Artifact compiler output at ${update.source.path} cannot set runtime-owned hash or compiler fields`);
	}
	const metadata = {
		...structuredClone(update.output),
		hash: update.source.hash,
		compiler: update.compiler,
	};
	validateArtifactMetadata(metadata, update.source.path);
	return metadata;
}

/** Validate and apply a whole compilation/removal cohort without mutating the prior registry. */
export function updateArtifactRegistry(
	registry: ArtifactRegistry,
	updates: readonly ArtifactCompilationUpdate[],
	removed: readonly string[] = [],
): ArtifactRegistry {
	validateArtifactRegistry(registry);
	const compiled = new Map<string, ArtifactMetadata>();
	for (const update of updates) {
		if (compiled.has(update.source.path)) throw new Error(`Duplicate artifact compilation: ${update.source.path}`);
		compiled.set(update.source.path, compilationMetadata(update));
	}
	const removals = new Set<string>();
	for (const path of removed) {
		if (typeof path !== "string" || path.trim().length === 0) throw new Error("Removed artifact paths must be non-empty");
		if (removals.has(path)) throw new Error(`Duplicate artifact removal: ${path}`);
		if (compiled.has(path)) throw new Error(`Artifact cannot be compiled and removed atomically: ${path}`);
		removals.add(path);
	}

	const next = structuredClone(registry);
	for (const path of removals) delete next[path];
	for (const [path, metadata] of compiled) {
		Object.defineProperty(next, path, {
			value: metadata,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return next;
}
