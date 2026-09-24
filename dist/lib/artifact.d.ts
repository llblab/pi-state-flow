import { type JsonObject } from "./json.ts";
export interface ArtifactSourceFingerprint {
    size: number;
    mtimeNs: string;
}
export declare function parseArtifactSourceFingerprint(value: unknown): ArtifactSourceFingerprint | undefined;
export declare function sameArtifactSourceFingerprint(left: ArtifactSourceFingerprint, right: ArtifactSourceFingerprint): boolean;
export type ArtifactSourceObservation = {
    path: string;
    kind: "present";
    fingerprint: ArtifactSourceFingerprint;
} | {
    path: string;
    kind: "missing";
} | {
    path: string;
    kind: "unavailable";
    reason: string;
};
/** Inspect only exact registered artifact paths without reading source bodies or traversing directories. */
export declare function inspectRegisteredArtifactPaths(paths: Iterable<string>): ArtifactSourceObservation[];
/** Current compiler protocol for ordinary registered source artifacts. */
export declare const ORDINARY_ARTIFACT_COMPILER = "artifact-v1";
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
export type ArtifactInvalidationReason = "new" | "source-changed" | "compiler-changed" | "invalid-metadata" | "explicit-refresh";
export type ArtifactCompilationNeed = {
    kind: "current";
} | {
    kind: "requires-compilation";
    reason: ArtifactInvalidationReason;
};
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
export declare function hashArtifactSource(source: string | Uint8Array): string;
export declare function isArtifactHash(value: unknown): value is string;
export declare function validateArtifactMetadata(value: unknown, path?: string): asserts value is ArtifactMetadata;
export declare function isArtifactMetadata(value: unknown): value is ArtifactMetadata;
export declare function validateArtifactRegistry(value: unknown, context?: string): asserts value is ArtifactRegistry;
export declare function selectArtifactsByTags(registry: ArtifactRegistry, tags: readonly string[], match?: "all" | "any"): string[];
export declare function isArtifactRegistry(value: unknown): value is ArtifactRegistry;
/** Parse one scope `meta.json` provenance registry; missing input means no recorded evidence. */
export declare function parseArtifactProvenanceRegistry(value: unknown, context?: string): ArtifactProvenanceRegistry;
/** Canonical retained form; uninterpretable entries cannot round-trip and are omitted. */
export declare function serializeArtifactProvenanceRegistry(registry: Readonly<ArtifactProvenanceRegistry>): JsonObject;
/** Decide whether retained compilation evidence requires source reacquisition. */
export declare function classifyArtifactCompilationNeed(source: ArtifactSourceIdentity, metadata: unknown, compiler: string, explicitRefresh?: boolean, provenance?: unknown): ArtifactCompilationNeed;
/** Split one compiler output into model-visible semantics and runtime-owned provenance. */
export declare function compileArtifact(update: ArtifactCompilationUpdate): CompiledArtifact;
/** Merge one compilation/removal cohort into the runtime-owned provenance registry. */
export declare function updateArtifactProvenance(registry: Readonly<ArtifactProvenanceRegistry>, updates: readonly ArtifactCompilationUpdate[], removed?: readonly string[]): ArtifactProvenanceRegistry;
/** Keep only provenance whose artifact path still exists in the given semantic registry. */
export declare function pruneArtifactProvenance(registry: Readonly<ArtifactProvenanceRegistry>, semantic: Readonly<Record<string, unknown>>): ArtifactProvenanceRegistry;
/** Validate and apply a whole compilation/removal cohort of model-visible artifacts. */
export declare function updateArtifactRegistry(registry: ArtifactRegistry, updates: readonly ArtifactCompilationUpdate[], removed?: readonly string[]): ArtifactRegistry;
/** Validate authored fields only: legacy retained evidence stays readable but cannot be model-edited. */
export declare function validateModelArtifactPatch(patch: JsonObject, context?: string): void;
/** Strip retained runtime bookkeeping from one model-visible artifact entry. */
export declare function projectArtifactForModel(entry: unknown): unknown;
export type ArtifactModelHints = Readonly<Record<string, string | readonly string[]>>;
/** Strip retained runtime bookkeeping and add deterministic runtime-only guidance. */
export declare function projectArtifactsForModel(registry: Readonly<ArtifactRegistry>, hints?: ArtifactModelHints): ArtifactRegistry;
