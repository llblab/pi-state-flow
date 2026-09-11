import { createHash } from "node:crypto";
import { containsNull, isJsonValue, isObject, type JsonObject, type JsonValue } from "./json.ts";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODEL_FORBIDDEN_PROVENANCE_FIELDS = ["hash", "compiler", "sourceHash", "compilerRevision", "compiledAt", "source_hash_verified"] as const;

/** Current compiler protocol for ordinary source artifacts such as Knowledge Markdown. */
export const ORDINARY_ARTIFACT_COMPILER = "artifact-v1";

/** Freshness fields that runtime-owned scope metadata may retain per artifact path. */
export interface ArtifactProvenance {
	/** Retained value; absent means unavailable, malformed means fail closed. */
	sourceHash?: unknown;
	compilerRevision?: unknown;
	compiledAt?: unknown;
	/** Internal marker for an uninterpretable retained entry; every dependent capability fails closed. */
	malformed?: true;
}

export type ArtifactProvenanceRegistry = Record<string, ArtifactProvenance>;

/**
 * Model-visible artifact metadata retained per canonical source path.
 *
 * `hash`, `compiler`, and `compiled_at` remain accepted only as retired embedded
 * provenance input from pre-0.7 state; they are consumed as compatibility evidence
 * and stripped from model projection. New compilations keep semantic fields here and
 * runtime-owned freshness in the scope `meta.json` provenance registry.
 */
export type ArtifactMetadata = JsonObject & {
	description: string;
	compilation?: JsonObject;
	kind?: string;
	tags?: string[];
	hash?: string;
	compiler?: string;
	compiled_at?: string;
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

/** Model-visible invalidation projection: paths and reasons only, never source identity. */
export interface ArtifactInvalidationNotice {
	path: string;
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
	tags?: string[];
};

export interface ArtifactCompilationUpdate {
	source: ArtifactSourceIdentity;
	compiler: string;
	output: ArtifactCompilerOutput;
}

/** One compilation split into its model-visible and runtime-owned halves. */
export interface CompiledArtifact {
	semantic: ArtifactMetadata;
	provenance: ArtifactProvenance;
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
	if (Object.hasOwn(value, "compilation") && !isObject(value.compilation)) {
		throw new Error(`Artifact metadata at ${path} compilation must be an object`);
	}
	if (Object.hasOwn(value, "kind")
		&& (typeof value.kind !== "string" || value.kind.trim().length === 0)) {
		throw new Error(`Artifact metadata at ${path} kind must be a non-empty string`);
	}
	if (Object.hasOwn(value, "tags") && (!Array.isArray(value.tags)
		|| value.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0 || tag !== tag.trim())
		|| new Set(value.tags).size !== value.tags.length)) {
		throw new Error(`Artifact metadata at ${path} tags must be unique non-empty trimmed strings`);
	}
	if (Object.hasOwn(value, "hash") && !isArtifactHash(value.hash)) {
		throw new Error(`Artifact metadata at ${path} must have a sha256:<64 lowercase hex characters> hash`);
	}
	if (Object.hasOwn(value, "compiler") && (typeof value.compiler !== "string" || value.compiler.trim().length === 0)) {
		throw new Error(`Artifact metadata at ${path} must have a non-empty compiler revision`);
	}
	if (Object.hasOwn(value, "compiled_at") && typeof value.compiled_at !== "string") {
		throw new Error(`Artifact metadata at ${path} compiled_at must be a string`);
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

export function selectArtifactsByTags(
	registry: ArtifactRegistry,
	tags: readonly string[],
	match: "all" | "any" = "all",
): string[] {
	validateArtifactRegistry(registry);
	if (tags.length === 0 || tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0 || tag !== tag.trim())) {
		throw new Error("Artifact tag query requires one or more non-empty trimmed strings");
	}
	const requested = new Set(tags);
	return Object.entries(registry)
		.filter(([, metadata]) => {
			const available = new Set(metadata.tags ?? []);
			return match === "all"
				? [...requested].every((tag) => available.has(tag))
				: [...requested].some((tag) => available.has(tag));
		})
		.map(([path]) => path)
		.sort();
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

function isProvenanceEntry(value: unknown): value is ArtifactProvenance {
	return isObject(value) && (value.malformed === undefined || value.malformed === true);
}

/** Parse one scope `meta.json` provenance registry; missing input means no recorded evidence. */
export function parseArtifactProvenanceRegistry(value: unknown, context = "Artifact provenance"): ArtifactProvenanceRegistry {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error(`${context} must be a path-keyed JSON object`);
	const registry: ArtifactProvenanceRegistry = {};
	for (const [path, entry] of Object.entries(value)) {
		if (path.trim().length === 0) throw new Error(`${context} path keys must be non-empty`);
		if (!isObject(entry) || !isJsonValue(entry)) {
			registry[path] = { malformed: true };
			continue;
		}
		const known = new Set(["sourceHash", "compilerRevision", "compiledAt"]);
		if (Object.keys(entry).some((key) => !known.has(key))) {
			registry[path] = { malformed: true };
			continue;
		}
		registry[path] = {
			...(Object.hasOwn(entry, "sourceHash") ? { sourceHash: entry.sourceHash } : {}),
			...(Object.hasOwn(entry, "compilerRevision") ? { compilerRevision: entry.compilerRevision } : {}),
			...(Object.hasOwn(entry, "compiledAt") ? { compiledAt: entry.compiledAt } : {}),
		};
	}
	return registry;
}

/** Canonical retained form; uninterpretable entries cannot round-trip and are omitted. */
export function serializeArtifactProvenanceRegistry(registry: Readonly<ArtifactProvenanceRegistry>): JsonObject {
	const artifacts: JsonObject = {};
	for (const [path, entry] of Object.entries(registry)) {
		if (entry.malformed === true) continue;
		const fields: JsonObject = {};
		if (entry.sourceHash !== undefined) fields.sourceHash = entry.sourceHash as JsonValue;
		if (entry.compilerRevision !== undefined) fields.compilerRevision = entry.compilerRevision as JsonValue;
		if (entry.compiledAt !== undefined) fields.compiledAt = entry.compiledAt as JsonValue;
		if (Object.keys(fields).length === 0) continue;
		artifacts[path] = fields;
	}
	return artifacts;
}

function invalidField(value: unknown, validate: (candidate: unknown) => boolean): boolean {
	return value !== undefined && !validate(value);
}

const INVALID_EVIDENCE = Symbol("invalid-evidence");

/** Later authority wins per field; absent runtime evidence falls back to retired embedded values. */
function fieldEvidence(entry: ArtifactProvenance | undefined, field: "sourceHash" | "compilerRevision" | "compiledAt", legacy: unknown): unknown {
	if (entry?.malformed === true) return INVALID_EVIDENCE;
	if (entry !== undefined && Object.hasOwn(entry, field)) return entry[field];
	return legacy;
}

/** Classify freshness from semantic state and runtime provenance without acquiring the source body. */
export function classifyArtifactFreshness(
	source: ArtifactSourceIdentity,
	metadata: unknown,
	compiler: string,
	explicitRefresh = false,
	provenance?: unknown,
): ArtifactFreshness {
	validateSourceIdentity(source);
	validateCompilerRevision(compiler);
	if (metadata === undefined) return { kind: "requires-compilation", reason: "new" };
	if (!isArtifactMetadata(metadata)) return { kind: "requires-compilation", reason: "invalid-metadata" };
	const entry = isProvenanceEntry(provenance) ? provenance : undefined;
	const runtime = entry?.malformed === true;
	const sourceHash = runtime ? INVALID_EVIDENCE : fieldEvidence(entry, "sourceHash", metadata.hash);
	if (sourceHash === INVALID_EVIDENCE || invalidField(sourceHash, (value) => isArtifactHash(value))) {
		return { kind: "requires-compilation", reason: "invalid-metadata" };
	}
	if (typeof sourceHash === "string" && sourceHash !== source.hash) {
		return { kind: "requires-compilation", reason: "source-changed" };
	}
	const compilerRevision = runtime ? INVALID_EVIDENCE : fieldEvidence(entry, "compilerRevision", metadata.compiler);
	if (compilerRevision === INVALID_EVIDENCE || invalidField(compilerRevision, (value) => typeof value === "string" && value.trim().length > 0)) {
		return { kind: "requires-compilation", reason: "invalid-metadata" };
	}
	if (typeof compilerRevision === "string" && compilerRevision !== compiler) {
		return { kind: "requires-compilation", reason: "compiler-changed" };
	}
	if (explicitRefresh) return { kind: "requires-compilation", reason: "explicit-refresh" };
	return { kind: "fresh" };
}

/** Produce a deterministic acquisition plan from path/hash candidates and retained evidence. */
export function planArtifactInvalidation(
	sources: readonly ArtifactSourceIdentity[],
	registry: Readonly<Record<string, unknown>>,
	compiler: string,
	options: ArtifactInvalidationOptions = {},
	provenance: Readonly<ArtifactProvenanceRegistry> = {},
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
		const entry = Object.hasOwn(provenance, source.path) ? provenance[source.path] : undefined;
		const freshness = classifyArtifactFreshness(
			source,
			metadata,
			compiler,
			refreshRequested(source.path, options.explicitRefresh),
			entry,
		);
		const identity = { path: source.path, hash: source.hash };
		if (freshness.kind === "fresh") fresh.push(identity);
		else requiresCompilation.push({ ...identity, reason: freshness.reason });
	}
	const removed = Object.keys(registry).filter((path) => !seen.has(path)).sort();
	return { fresh, requiresCompilation, removed };
}

/** Split one compiler output into model-visible semantics and runtime-owned provenance. */
export function compileArtifact(update: ArtifactCompilationUpdate): CompiledArtifact {
	validateSourceIdentity(update.source);
	validateCompilerRevision(update.compiler, update.source.path);
	if (!isObject(update.output) || MODEL_FORBIDDEN_PROVENANCE_FIELDS.some((field) => Object.hasOwn(update.output, field))) {
		throw new Error(`Artifact compiler output at ${update.source.path} cannot set runtime-owned provenance fields`);
	}
	// Timestamps are runtime evidence; the model-visible entry never retains them.
	const semantic = structuredClone(update.output) as ArtifactMetadata;
	delete semantic.compiled_at;
	validateArtifactMetadata(semantic, update.source.path);
	return {
		semantic,
		provenance: {
			sourceHash: update.source.hash,
			compilerRevision: update.compiler,
			...(typeof update.output.compiled_at === "string" ? { compiledAt: update.output.compiled_at } : {}),
		},
	};
}

/** Merge one compilation/removal cohort into the runtime-owned provenance registry. */
export function updateArtifactProvenance(
	registry: Readonly<ArtifactProvenanceRegistry>,
	updates: readonly ArtifactCompilationUpdate[],
	removed: readonly string[] = [],
): ArtifactProvenanceRegistry {
	const next = structuredClone(registry) as ArtifactProvenanceRegistry;
	for (const update of updates) next[update.source.path] = compileArtifact(update).provenance;
	for (const path of removed) delete next[path];
	return next;
}

/** Keep only provenance whose artifact path still exists in the given semantic registry. */
export function pruneArtifactProvenance(
	registry: Readonly<ArtifactProvenanceRegistry>,
	semantic: Readonly<Record<string, unknown>>,
): ArtifactProvenanceRegistry {
	const next: ArtifactProvenanceRegistry = {};
	for (const [path, entry] of Object.entries(registry)) {
		if (Object.hasOwn(semantic, path)) next[path] = structuredClone(entry);
	}
	return next;
}

/** Validate and apply a whole compilation/removal cohort of model-visible artifacts. */
export function updateArtifactRegistry(
	registry: ArtifactRegistry,
	updates: readonly ArtifactCompilationUpdate[],
	removed: readonly string[] = [],
): ArtifactRegistry {
	validateArtifactRegistry(registry);
	const compiled = new Map<string, ArtifactMetadata>();
	for (const update of updates) {
		if (compiled.has(update.source.path)) throw new Error(`Duplicate artifact compilation: ${update.source.path}`);
		compiled.set(update.source.path, compileArtifact(update).semantic);
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

/** Runtime-owned artifact fields that never belong in ordinary model context. */
const RUNTIME_ARTIFACT_FIELDS = [...MODEL_FORBIDDEN_PROVENANCE_FIELDS, "compiled_at"] as const;

/** Strip retained runtime bookkeeping from one model-visible artifact entry. */
export function projectArtifactForModel(entry: unknown): unknown {
	if (!isObject(entry)) return entry;
	const projected = structuredClone(entry);
	for (const field of RUNTIME_ARTIFACT_FIELDS) delete projected[field];
	return projected;
}

/** Strip retained runtime bookkeeping from a model-visible artifact registry. */
export function projectArtifactsForModel(registry: Readonly<ArtifactRegistry>): ArtifactRegistry {
	const projected: ArtifactRegistry = {};
	for (const [path, entry] of Object.entries(registry)) {
		Object.defineProperty(projected, path, {
			value: projectArtifactForModel(entry),
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return projected;
}
