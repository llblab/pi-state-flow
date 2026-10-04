import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry, type ArtifactProvenanceRegistry } from "./artifact.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { canonicalJson, isJsonValue, isObject, type JsonObject } from "./json.ts";
import { validateTemporalLineage, type TransitionBoundary } from "./temporal.ts";
const MAX_RESTORED_STEP = Number.MAX_SAFE_INTEGER - 1;
const MAX_LEGACY_VALIDATION_ATTEMPT = 7;

/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export class RevisionUnavailableError extends Error {}


export type StateFlowMode = "active" | "passive" | "off";
export type InactiveMode = Exclude<StateFlowMode, "active">;

export function isStateFlowMode(value: unknown): value is StateFlowMode {
	return value === "active" || value === "passive" || value === "off";
}

/** The session's selected mode is the only serialized behavior switch. */
export interface SnapshotConfig {
	mode: StateFlowMode;
}

/**
 * Read only mode policy, without validating or accessing semantic checkpoint metadata.
 * Missing/invalid policy stays undecided; callers must not treat this as restoration proof.
 * Legacy `enabled:false` follows the caller's inactive policy.
 */
export function readCheckpointMode(value: unknown, inactiveMode: InactiveMode = "passive"): StateFlowMode | undefined {
	if (!isObject(value)) return undefined;
	if (Object.hasOwn(value, "mode")) return Object.hasOwn(value, "enabled") || !isStateFlowMode(value.mode) ? undefined : value.mode;
	return typeof value.enabled === "boolean" ? value.enabled ? "active" : inactiveMode : undefined;
}

interface LegacyValidationFeedback {
	attempt: number;
	error: string;
	instruction: string;
}

export interface SnapshotMeta {
	step: number;
	specification?: string;
	/** Read-only compatibility/recovery diagnostic; 0.7 never schedules terminal-envelope retries. */
	validation?: LegacyValidationFeedback;
	bootstrap?: boolean;
}

/** In-memory runtime config/provenance; durable config/meta and scope files own restoration. */
export interface StateFlowSnapshot {
	config: SnapshotConfig;
	meta: SnapshotMeta;
}

export type Snapshot = StateFlowSnapshot;

/** Failed Active selection retains its policy and fences inference until explicit recovery or an inactive choice. */
export function isActiveRestorationBlocked(snapshot: Snapshot): boolean {
	return snapshot.config.mode === "active" && snapshot.meta.validation?.attempt === 0;
}

export interface SessionRuntime {
	config: SnapshotConfig;
	meta: SnapshotMeta & {
		version: 1;
		identity: { cwd: string; sessionId: string };
		lineage: TransitionBoundary[];
		/** Runtime-owned artifact compilation evidence; never projected as semantic state. */
		artifacts?: ArtifactProvenanceRegistry;
		temporal?: { checkpoint: TransitionBoundary; patches: TransitionBoundary[] };
		[key: string]: unknown;
	};
}

export function validateSessionRuntime(value: unknown, cwd: string, sessionId: string): asserts value is SessionRuntime {
	if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "config,meta"
		|| !isObject(value.config) || !isObject(value.meta)) throw new Error("Invalid State Flow session runtime envelope");
	const { version, identity, lineage, artifacts, temporal: _temporalScope, ...fields } = value.meta;
	if (artifacts !== undefined) parseArtifactProvenanceRegistry(artifacts, "State Flow session artifact provenance");
	if (version !== 1) throw new Error("Unsupported State Flow runtime provenance format");
	if (!isObject(identity) || Object.keys(identity).sort().join(",") !== "cwd,sessionId"
		|| identity.cwd !== resolve(cwd) || identity.sessionId !== sessionId || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
		throw new Error("State Flow runtime scope identity mismatch");
	}
	validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
	const known = new Set(["step", "specification", "validation", "bootstrap"]);
	if (Object.keys(fields).some((key) => ["state", "contract", "working", "response"].includes(key))) {
		throw new Error("Semantic state does not belong in State Flow runtime metadata");
	}
	const runtimeFields = Object.fromEntries(Object.entries(fields).filter(([key]) => known.has(key)));
	const normalized: Snapshot = {
		config: { mode: isStateFlowMode(value.config.mode) ? value.config.mode : "off" },
		meta: restoredMeta(runtimeFields),
	};
	if (runtimeFields.bootstrap === false) normalized.meta.bootstrap = false;
	if (runtimeFields.step === Number.MAX_SAFE_INTEGER) normalized.meta.step = Number.MAX_SAFE_INTEGER;
	if (canonicalJson({ config: normalized.config, meta: normalized.meta }) !== canonicalJson({ config: value.config, meta: runtimeFields })) {
		throw new Error("Invalid State Flow runtime configuration or counters");
	}
}

export function createSessionRuntime(
	snapshot: Snapshot,
	cwd: string,
	sessionId: string,
	lineage: readonly TransitionBoundary[],
	_artifacts: ArtifactProvenanceRegistry = {},
): SessionRuntime {
	const fields = snapshot.meta;
	const runtime: SessionRuntime = {
		config: structuredClone(snapshot.config),
		meta: {
			...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as SnapshotMeta,
			version: 1,
			identity: { cwd: resolve(cwd), sessionId },
			lineage: structuredClone([...lineage]),
		},
	};
	validateSessionRuntime(runtime, cwd, sessionId);
	return runtime;
}

export function serializeSessionRuntime(
	runtime: SessionRuntime, cwd: string, sessionId: string,
): { config: string; runtime: string } {
	validateSessionRuntime(runtime, cwd, sessionId);
	const { temporal: _retiredTemporal, artifacts: _legacyArtifacts, ...runtimeMeta } = runtime.meta;
	return { config: `${canonicalJson(runtime.config)}\n`, runtime: `${canonicalJson(runtimeMeta)}\n` };
}

/** Legacy `enabled:false` decodes as non-active; native checkpoints, not this file, select branch policy. */
export function parseSessionRuntime(
	config: string | undefined, runtimeSource: string | undefined, cwd: string, sessionId: string,
): SessionRuntime | undefined {
	if (config === undefined && runtimeSource === undefined) return undefined;
	if (config === undefined || runtimeSource === undefined) throw new Error("Incomplete State Flow config/runtime pair");
	let runtime: unknown;
	try {
		const settings: unknown = JSON.parse(config);
		const mode = isObject(settings) && Object.keys(settings).length === 1 ? readCheckpointMode(settings, "passive") : undefined;
		if (mode === undefined) throw new Error("Invalid State Flow runtime configuration or counters");
		runtime = { config: { mode }, meta: JSON.parse(runtimeSource) };
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("State Flow session runtime contains invalid JSON");
		throw error;
	}
	validateSessionRuntime(runtime, cwd, sessionId);
	const { temporal: _legacyTemporal, ...runtimeMeta } = runtime.meta;
	return { config: { mode: runtime.config.mode }, meta: runtimeMeta };
}

function restoredStep(value: unknown): number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= MAX_RESTORED_STEP
		? value
		: 0;
}

function restoredValidation(value: unknown): LegacyValidationFeedback | undefined {
	if (!isObject(value)
		|| !Number.isSafeInteger(value.attempt as number)
		|| (value.attempt as number) < 0
		|| (value.attempt as number) > MAX_LEGACY_VALIDATION_ATTEMPT
		|| typeof value.error !== "string"
		|| typeof value.instruction !== "string") return undefined;
	return {
		attempt: value.attempt as number,
		error: value.error,
		instruction: value.instruction,
	};
}

function restoredMeta(value: unknown, legacy: JsonObject = {}): SnapshotMeta {
	const meta = isObject(value) ? value : legacy;
	const validation = restoredValidation(meta.validation);
	return {
		step: restoredStep(meta.step),
		...(typeof meta.specification === "string" ? { specification: meta.specification } : {}),
		...(validation === undefined ? {} : { validation }),
		...(meta.bootstrap === true ? { bootstrap: true } : {}),
	};
}

function envelope(mode: StateFlowMode, meta: SnapshotMeta): Snapshot {
	return { config: { mode }, meta };
}

export function emptySnapshot(mode: StateFlowMode = "passive"): Snapshot {
	return envelope(mode, { step: 0 });
}

export type RetainedBoundaryCheckpoint = {
	boundary: string;
	mode: StateFlowMode;
	step: number;
	bootstrap?: true;
	specification?: string;
};
/** A proven pre-runtime branch retains only its explicit inactive choice, never semantic storage. */
export type PreRuntimeCheckpoint = { mode: InactiveMode };
export type RetainedPiCheckpoint = RetainedBoundaryCheckpoint | PreRuntimeCheckpoint;
export type FileRevision = `file:${string}`;

export function isFileRevision(value: unknown): value is FileRevision {
	return typeof value === "string" && /^file:[0-9a-f]{64}$/.test(value);
}

/** Encode branch lifecycle against one retained temporal identity without semantic or backup data. */
export function retainedBoundaryCheckpoint(snapshot: Snapshot, boundary: string): RetainedBoundaryCheckpoint {
	if (typeof boundary !== "string" || boundary.trim().length === 0) throw new Error("Checkpoint requires a retained temporal boundary identity");
	const checkpoint: RetainedBoundaryCheckpoint = {
		boundary,
		mode: snapshot.config.mode,
		step: snapshot.meta.step,
		...(snapshot.meta.bootstrap === true ? { bootstrap: true as const } : {}),
		...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
	};
	return parseRetainedPiCheckpoint(checkpoint) as RetainedBoundaryCheckpoint;
}

/** Encode an explicit inactive choice on a branch that has no accepted runtime. */
export function preRuntimeCheckpoint(mode: StateFlowMode): PreRuntimeCheckpoint {
	if (mode === "active") throw new Error("An active State Flow branch requires a retained semantic boundary");
	return { mode };
}

/** Decode the retained-window checkpoint contract; legacy `enabled`/`{disabled:true}` markers map through `inactiveMode`. */
export function parseRetainedPiCheckpoint(value: unknown, inactiveMode: InactiveMode = "passive"): RetainedPiCheckpoint {
	if (!isObject(value)) throw new Error("Invalid State Flow retained-boundary checkpoint");
	const keys = Object.keys(value);
	if (keys.length === 1 && value.disabled === true) return { mode: inactiveMode };
	if (keys.length === 1 && (value.mode === "passive" || value.mode === "off")) return { mode: value.mode };
	const allowed = new Set(["boundary", "mode", "enabled", "step", "bootstrap", "specification"]);
	const mode = readCheckpointMode(value, inactiveMode);
	if (keys.some((key) => !allowed.has(key))
		|| typeof value.boundary !== "string" || value.boundary.trim().length === 0
		|| mode === undefined
		|| !Number.isSafeInteger(value.step) || (value.step as number) < 0 || (value.step as number) > MAX_RESTORED_STEP
		|| (value.bootstrap !== undefined && value.bootstrap !== true)
		|| (value.specification !== undefined && typeof value.specification !== "string")) {
		throw new Error("Invalid State Flow retained-boundary checkpoint");
	}
	return {
		boundary: value.boundary,
		mode,
		step: value.step as number,
		...(value.bootstrap === true ? { bootstrap: true } : {}),
		...(typeof value.specification === "string" ? { specification: value.specification } : {}),
	};
}

export function migrationFailure(data: JsonObject, error: string, mode: StateFlowMode = "passive"): Snapshot {
	const meta = restoredMeta(data.meta, data);
	meta.validation = {
		attempt: 0,
		error,
		instruction: "Start a fresh State Flow episode; null is reserved for patch deletion.",
	};
	return envelope(mode, meta);
}
