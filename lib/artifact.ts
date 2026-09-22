import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { containsNull, isJsonValue, isObject, type JsonObject, type JsonValue } from "./json.ts";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODEL_FORBIDDEN_PROVENANCE_FIELDS = ["hash", "compiler", "sourceHash", "sourceFingerprint", "compilerRevision", "compiledAt", "source_hash_verified"] as const;

export interface ArtifactSourceFingerprint {
	size: number;
	mtimeNs: string;
}

export function parseArtifactSourceFingerprint(value: unknown): ArtifactSourceFingerprint | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (Object.keys(candidate).sort().join(",") !== "mtimeNs,size"
		|| !Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0
		|| typeof candidate.mtimeNs !== "string" || !/^-?\d+$/.test(candidate.mtimeNs)) return undefined;
	return { size: candidate.size as number, mtimeNs: candidate.mtimeNs };
}

export function sameArtifactSourceFingerprint(left: ArtifactSourceFingerprint, right: ArtifactSourceFingerprint): boolean {
	return left.size === right.size && left.mtimeNs === right.mtimeNs;
}

export type ArtifactSourceObservation =
	| { path: string; kind: "present"; fingerprint: ArtifactSourceFingerprint }
	| { path: string; kind: "missing" }
	| { path: string; kind: "unavailable"; reason: string };

function artifactSourceErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

/** Inspect only exact registered artifact paths without reading source bodies or traversing directories. */
export function inspectRegisteredArtifactPaths(paths: Iterable<string>): ArtifactSourceObservation[] {
	return [...new Set(paths)].sort().map((path) => {
		if (!isAbsolute(path) || resolve(path) !== path) {
			return { path, kind: "unavailable", reason: "artifact path is not canonical and absolute" };
		}
		let metadata;
		try {
			metadata = lstatSync(path, { bigint: true });
		} catch (error) {
			const code = artifactSourceErrorCode(error);
			if (code === "ENOENT" || code === "ENOTDIR") return { path, kind: "missing" };
			return { path, kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			return { path, kind: "unavailable", reason: "artifact source is not a regular non-symlink file" };
		}
		if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
			return { path, kind: "unavailable", reason: "artifact source size exceeds the supported range" };
		}
		return {
			path,
			kind: "present",
			fingerprint: { size: Number(metadata.size), mtimeNs: metadata.mtimeNs.toString() },
		};
	});
}

/** Current compiler protocol for ordinary registered source artifacts. */
export const ORDINARY_ARTIFACT_COMPILER = "artifact-v1";

/** Compilation evidence that runtime-owned scope metadata may retain per artifact path. */
export interface ArtifactProvenance {
	/** Retained value; absent means unavailable, malformed means fail closed. */
	sourceHash?: unknown;
	sourceFingerprint?: unknown;
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
 * runtime-owned compilation evidence in the scope `meta.json` provenance registry.
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

/** Source identity is sufficient for compilation decisions; it never contains the source body. */
export type ArtifactScope = "global" | "cwd" | "session";

export interface ArtifactSourceIdentity {
	path: string;
	/** Exact semantic owner selected from the effective global → CWD → session overlay. */
	scope?: ArtifactScope;
	/** Transitional legacy content identity; generic maintenance uses the filesystem fingerprint instead. */
	hash?: string;
	/** Stable filesystem evidence observed across the successful source read. */
	sourceFingerprint?: ArtifactSourceFingerprint;
}

export type ArtifactInvalidationReason =
	| "new"
	| "source-changed"
	| "compiler-changed"
	| "invalid-metadata"
	| "explicit-refresh";

export type ArtifactCompilationNeed =
	| { kind: "current" }
	| { kind: "requires-compilation"; reason: ArtifactInvalidationReason };

export interface ArtifactInvalidationRequest extends ArtifactSourceIdentity {
	reason: ArtifactInvalidationReason;
}

/** Model-visible invalidation projection: paths and reasons only, never source identity. */
export interface ArtifactInvalidationNotice {
	path: string;
	scope?: ArtifactScope;
	reason: ArtifactInvalidationReason;
}

/** Trusted compilation input; embedded timestamps are accepted here, but never in model patches. */
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
	if (source.hash !== undefined && !isArtifactHash(source.hash)) {
		throw new Error(`Artifact source at ${source.path} must have a sha256:<64 lowercase hex characters> hash`);
	}
	if (source.sourceFingerprint !== undefined && parseArtifactSourceFingerprint(source.sourceFingerprint) === undefined) {
		throw new Error(`Artifact source fingerprint at ${source.path} is invalid`);
	}
}

function validateCompilerRevision(compiler: string, path?: string): void {
	if (typeof compiler !== "string" || compiler.trim().length === 0) {
		throw new Error(path === undefined
			? "Artifact compiler revision must be non-empty"
			: `Artifact compiler revision at ${path} must be non-empty`);
	}
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
		const known = new Set(["sourceHash", "sourceFingerprint", "compilerRevision", "compiledAt"]);
		if (Object.keys(entry).some((key) => !known.has(key))) {
			registry[path] = { malformed: true };
			continue;
		}
		registry[path] = {
			...(Object.hasOwn(entry, "sourceHash") ? { sourceHash: entry.sourceHash } : {}),
			...(Object.hasOwn(entry, "sourceFingerprint") ? { sourceFingerprint: entry.sourceFingerprint } : {}),
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
		if (entry.sourceFingerprint !== undefined) fields.sourceFingerprint = entry.sourceFingerprint as JsonValue;
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

/** Later authority wins per field; absent runtime evidence falls back to retired embedded values. */
function fieldEvidence(entry: ArtifactProvenance | undefined, field: "sourceHash" | "compilerRevision" | "compiledAt", legacy: unknown): unknown {
	if (entry !== undefined && Object.hasOwn(entry, field)) return entry[field];
	return legacy;
}

/** Decide whether retained compilation evidence requires source reacquisition. */
export function classifyArtifactCompilationNeed(
	source: ArtifactSourceIdentity,
	metadata: unknown,
	compiler: string,
	explicitRefresh = false,
	provenance?: unknown,
): ArtifactCompilationNeed {
	validateSourceIdentity(source);
	validateCompilerRevision(compiler);
	if (metadata === undefined) return { kind: "requires-compilation", reason: "new" };
	if (!isArtifactMetadata(metadata)) return { kind: "requires-compilation", reason: "invalid-metadata" };
	const entry = isProvenanceEntry(provenance) ? provenance : undefined;
	if ((provenance !== undefined && entry === undefined) || entry?.malformed === true) {
		return { kind: "requires-compilation", reason: "invalid-metadata" };
	}
	if (source.sourceFingerprint !== undefined) {
		const retained = parseArtifactSourceFingerprint(entry?.sourceFingerprint);
		if (retained === undefined) return { kind: "requires-compilation", reason: "invalid-metadata" };
		if (!sameArtifactSourceFingerprint(source.sourceFingerprint, retained)) return { kind: "requires-compilation", reason: "source-changed" };
	}
	if (source.sourceFingerprint === undefined || source.hash !== undefined) {
		// Explicit current-hash observations, including Skills, retain their identity contract.
		const sourceHash = fieldEvidence(entry, "sourceHash", metadata.hash);
		if (invalidField(sourceHash, isArtifactHash)) return { kind: "requires-compilation", reason: "invalid-metadata" };
		if (source.hash !== undefined && typeof sourceHash === "string" && sourceHash !== source.hash) {
			return { kind: "requires-compilation", reason: "source-changed" };
		}
	}
	const compilerRevision = fieldEvidence(entry, "compilerRevision", metadata.compiler);
	if (invalidField(compilerRevision, (value) => typeof value === "string" && value.trim().length > 0)) {
		return { kind: "requires-compilation", reason: "invalid-metadata" };
	}
	if (typeof compilerRevision === "string" && compilerRevision !== compiler) {
		return { kind: "requires-compilation", reason: "compiler-changed" };
	}
	if (explicitRefresh) return { kind: "requires-compilation", reason: "explicit-refresh" };
	return { kind: "current" };
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
			...(update.source.hash === undefined ? {} : { sourceHash: update.source.hash }),
			...(update.source.sourceFingerprint === undefined ? {} : { sourceFingerprint: structuredClone(update.source.sourceFingerprint) }),
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
const RUNTIME_ARTIFACT_FIELDS = [...MODEL_FORBIDDEN_PROVENANCE_FIELDS, "compiled_at", "hint"] as const;

/** Validate authored fields only: legacy retained evidence stays readable but cannot be model-edited. */
export function validateModelArtifactPatch(patch: JsonObject): void {
	for (const [path, entry] of Object.entries(patch)) {
		if (!isObject(entry)) continue; // Whole-artifact deletion and materialized shape belong to the transition owner.
		const field = RUNTIME_ARTIFACT_FIELDS.find((field) => Object.hasOwn(entry, field));
		if (field !== undefined) throw new Error(`Artifact patch at ${path} cannot set runtime-owned field ${field}`);
	}
}

/** Strip retained runtime bookkeeping from one model-visible artifact entry. */
export function projectArtifactForModel(entry: unknown): unknown {
	if (!isObject(entry)) return entry;
	const projected = structuredClone(entry);
	for (const field of RUNTIME_ARTIFACT_FIELDS) delete projected[field];
	return projected;
}

export type ArtifactModelHints = Readonly<Record<string, string | readonly string[]>>;

/** Strip retained runtime bookkeeping and add deterministic runtime-only guidance. */
export function projectArtifactsForModel(registry: Readonly<ArtifactRegistry>, hints: ArtifactModelHints = {}): ArtifactRegistry {
	const projected: ArtifactRegistry = {};
	for (const [path, entry] of Object.entries(registry)) {
		const modelEntry = projectArtifactForModel(entry);
		const values = (Array.isArray(hints[path]) ? hints[path] : [hints[path]])
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
		const hint = [...new Set(values)].sort().join("\n");
		if (hint.length > 0 && isObject(modelEntry)) modelEntry.hint = hint;
		Object.defineProperty(projected, path, {
			value: modelEntry,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return projected;
}
