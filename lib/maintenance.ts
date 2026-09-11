import {
	classifyArtifactFreshness,
	type ArtifactMetadata,
	type ArtifactProvenance,
	type ArtifactRegistry,
	type ArtifactSourceIdentity,
} from "./artifact.ts";
import type { ArtifactSourceCandidate } from "./discovery.ts";
import { isObject } from "./json.ts";

export const DEFAULT_ARTIFACT_MAINTENANCE_MAX_READS = 1;
export const DEFAULT_ARTIFACT_MAINTENANCE_MAX_SOURCE_BYTES = 16 * 1024;
export const DEFAULT_ARTIFACT_MAINTENANCE_MINIMUM_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ArtifactMaintenanceOptions {
	/** Stable cycle time supplied by the caller. */
	now?: Date | number | string;
	/** A source must be at least this old. Missing/unparseable timestamps rank as oldest. */
	minimumAgeMs?: number;
	/** Strict source-read count ceiling for this cycle. */
	maxReads?: number;
	/** Strict source-byte ceiling; bytes conservatively upper-bound source tokenizer input. */
	maxSourceBytes?: number;
}

export interface ArtifactMaintenanceRequest extends ArtifactSourceIdentity {
	reason: "maintenance";
	sourceBytes: number;
}

export interface ArtifactMaintenancePlan {
	requiresCompilation: ArtifactMaintenanceRequest[];
	deferred: ArtifactMaintenanceRequest[];
	budget: {
		maxReads: number;
		maxSourceBytes: number;
		usedReads: number;
		usedSourceBytes: number;
	};
}

function nonNegativeSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return value;
}

function cycleTime(value: Date | number | string | undefined): number {
	const timestamp = value === undefined
		? Date.now()
		: value instanceof Date
			? value.getTime()
			: typeof value === "number"
				? value
				: Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error("Artifact maintenance cycle time must be valid");
	return timestamp;
}

function compiledTime(entry: ArtifactProvenance | undefined, legacy: unknown): number {
	const timestamp = entry?.malformed === true ? undefined
		: entry !== undefined && Object.hasOwn(entry, "compiledAt") ? entry.compiledAt
			: legacy;
	if (typeof timestamp !== "string") return Number.NEGATIVE_INFINITY;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function request(source: ArtifactSourceCandidate): ArtifactMaintenanceRequest {
	return {
		path: source.path,
		hash: source.hash,
		reason: "maintenance",
		sourceBytes: source.bytes,
	};
}

/**
 * Select a bounded, oldest-first maintenance cohort from otherwise fresh artifacts.
 *
 * This planner is opt-in and side-effect free. Correctness invalidations remain the
 * responsibility of planArtifactInvalidation; they are never displaced by maintenance.
 */
export function planArtifactMaintenance(
	sources: readonly ArtifactSourceCandidate[],
	registry: Readonly<Record<string, unknown>>,
	compiler: string,
	options: ArtifactMaintenanceOptions = {},
	provenance: Readonly<Record<string, ArtifactProvenance>> = {},
): ArtifactMaintenancePlan {
	if (!isObject(registry)) throw new Error("Artifacts must be a path-keyed JSON object");
	const now = cycleTime(options.now);
	const minimumAgeMs = nonNegativeSafeInteger(
		options.minimumAgeMs ?? DEFAULT_ARTIFACT_MAINTENANCE_MINIMUM_AGE_MS,
		"Artifact maintenance minimum age",
	);
	const maxReads = nonNegativeSafeInteger(
		options.maxReads ?? DEFAULT_ARTIFACT_MAINTENANCE_MAX_READS,
		"Artifact maintenance read budget",
	);
	const maxSourceBytes = nonNegativeSafeInteger(
		options.maxSourceBytes ?? DEFAULT_ARTIFACT_MAINTENANCE_MAX_SOURCE_BYTES,
		"Artifact maintenance source-byte budget",
	);

	const seen = new Set<string>();
	const eligible: { source: ArtifactSourceCandidate; compiledAt: number }[] = [];
	for (const source of sources) {
		if (seen.has(source.path)) throw new Error(`Duplicate artifact source path: ${source.path}`);
		seen.add(source.path);
		nonNegativeSafeInteger(source.bytes, `Artifact source bytes at ${source.path}`);
		const metadata = Object.hasOwn(registry, source.path) ? registry[source.path] : undefined;
		const entry = Object.hasOwn(provenance, source.path) ? provenance[source.path] : undefined;
		const freshness = classifyArtifactFreshness(source, metadata, compiler, false, entry);
		if (freshness.kind !== "fresh") continue;
		const compiledAt = compiledTime(entry, isObject(metadata) ? (metadata as ArtifactMetadata).compiled_at : undefined);
		if (compiledAt !== Number.NEGATIVE_INFINITY && now - compiledAt < minimumAgeMs) continue;
		eligible.push({ source, compiledAt });
	}
	eligible.sort((left, right) => {
		if (left.compiledAt !== right.compiledAt) return left.compiledAt - right.compiledAt;
		return left.source.path < right.source.path ? -1 : left.source.path > right.source.path ? 1 : 0;
	});

	const requiresCompilation: ArtifactMaintenanceRequest[] = [];
	const deferred: ArtifactMaintenanceRequest[] = [];
	let usedSourceBytes = 0;
	for (const candidate of eligible) {
		const next = request(candidate.source);
		if (requiresCompilation.length >= maxReads
			|| candidate.source.bytes > maxSourceBytes - usedSourceBytes) {
			deferred.push(next);
			continue;
		}
		requiresCompilation.push(next);
		usedSourceBytes += candidate.source.bytes;
	}
	return {
		requiresCompilation,
		deferred,
		budget: {
			maxReads,
			maxSourceBytes,
			usedReads: requiresCompilation.length,
			usedSourceBytes,
		},
	};
}
