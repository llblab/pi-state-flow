import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry } from "./artifact.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { canonicalJson, isJsonValue, isObject, type JsonObject } from "./json.ts";
import { captureTemporalWitnesses, validateTemporalLineage, type ExcludedTransitionWitness, type TransitionBoundary } from "./temporal.ts";
import { captureScopeSelection, type ScopeSelection } from "./selection.ts";
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

/** Capture closed caller-owned run fields, omitting only undefined optional in-memory fields. */
export function captureLifecycleSnapshot(value: Snapshot): Snapshot {
	if (!isObject(value) || Object.keys(value).sort().join(",") !== "config,meta" || !isObject(value.config)
		|| Object.keys(value.config).join(",") !== "mode" || !isObject(value.meta)
		|| Object.keys(value.meta).some((key) => !["step", "specification", "bootstrap", "validation"].includes(key))) {
		throw new Error("Selected State Flow lifecycle update contains non-owned fields");
	}
	const meta = Object.fromEntries(Object.entries(value.meta).filter(([, field]) => field !== undefined));
	const supplied = { config: value.config, meta };
	if (!isJsonValue(supplied)) throw new Error("Invalid State Flow lifecycle snapshot");
	const normalized: Snapshot = { config: { mode: isStateFlowMode(value.config.mode) ? value.config.mode : "off" }, meta: restoredMeta(meta) };
	if (meta.bootstrap === false) normalized.meta.bootstrap = false;
	if (meta.step === Number.MAX_SAFE_INTEGER) normalized.meta.step = Number.MAX_SAFE_INTEGER;
	if (canonicalJson(normalized) !== canonicalJson(supplied)) throw new Error("Invalid State Flow lifecycle snapshot");
	return structuredClone(normalized);
}

/** Failed Active selection retains its policy and fences inference until explicit recovery or an inactive choice. */
export function isActiveRestorationBlocked(snapshot: Snapshot): boolean {
	return snapshot.config.mode === "active" && snapshot.meta.validation?.attempt === 0;
}

interface LifecycleMetadata extends SnapshotMeta {
	identity: { cwd: string; sessionId: string };
	lineage: TransitionBoundary[];
	[key: string]: unknown;
}

export type PrivateAcquisition = "unacquired" | "deferred" | "acquired";
export interface PrivateCausalBasis {
	lineage: TransitionBoundary[];
	causalWitnesses: ExcludedTransitionWitness[];
}

/** Retained private identity proof, never private values or acquisition permission. */
export function capturePrivateCausalBasis(value: unknown): PrivateCausalBasis {
	if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "causalWitnesses,lineage") throw new Error("Invalid State Flow private causal basis");
	const lineage: unknown = value.lineage;
	validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
	const causalWitnesses = captureTemporalWitnesses(lineage, value.causalWitnesses, MAX_HISTORY_LIMIT);
	const witnessed = new Set(causalWitnesses.map(witness => witness.transition.id));
	if (lineage.slice(1).some(boundary => !witnessed.has(boundary.id))) throw new Error("Insufficient State Flow private causal basis witnesses");
	return structuredClone({ lineage, causalWitnesses });
}

export interface SelectedSessionRuntime {
	config: SnapshotConfig & { scopes: ScopeSelection };
	meta: LifecycleMetadata & { version: 2; privateAcquisition: PrivateAcquisition; privateCausalBasis?: PrivateCausalBasis };
}

/** Validate normalized authority syntax; file presence and replay are checked by storage. */
function validateSelectedSessionRuntime(value: unknown, cwd: string, sessionId: string): asserts value is SelectedSessionRuntime {
	if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "config,meta"
		|| !isObject(value.config) || !isObject(value.meta)) throw new Error("Invalid State Flow session runtime envelope");
	const { version, identity, lineage, artifacts, temporal: _temporalScope, ...fields } = value.meta;
	if (!Object.hasOwn(value.meta, "version") || version !== 2) throw new Error("Unsupported State Flow runtime provenance format");
	if (artifacts !== undefined) parseArtifactProvenanceRegistry(artifacts, "State Flow session artifact provenance");
	if (!Object.hasOwn(value.meta, "privateAcquisition") || !["unacquired", "deferred", "acquired"].includes(value.meta.privateAcquisition as string)) {
		throw new Error("Invalid State Flow private acquisition provenance");
	}
	if (Object.hasOwn(value.meta, "privateCausalBasis")) {
		if (value.meta.privateAcquisition !== "acquired") throw new Error("Invalid State Flow private causal basis provenance");
		capturePrivateCausalBasis(value.meta.privateCausalBasis);
	}
	if (!isObject(identity) || Object.keys(identity).sort().join(",") !== "cwd,sessionId"
		|| identity.cwd !== resolve(cwd) || identity.sessionId !== sessionId || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
		throw new Error("State Flow runtime scope identity mismatch");
	}
	validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
	const known = new Set(["step", "specification", "validation", "bootstrap"]);
	if (Object.keys(fields).some((key) => ["state", "strategy", "tactics", "contract", "working", "response"].includes(key))) {
		throw new Error("Semantic state does not belong in State Flow runtime metadata");
	}
	const runtimeFields = Object.fromEntries(Object.entries(fields).filter(([key]) => known.has(key)));
	const normalized: Snapshot = {
		config: { mode: isStateFlowMode(value.config.mode) ? value.config.mode : "off" },
		meta: restoredMeta(runtimeFields),
	};
	if (runtimeFields.bootstrap === false) normalized.meta.bootstrap = false;
	if (runtimeFields.step === Number.MAX_SAFE_INTEGER) normalized.meta.step = Number.MAX_SAFE_INTEGER;
	if (!Object.hasOwn(value.config, "scopes")) throw new Error("State Flow lifecycle requires explicit scopes");
	const scopes = captureScopeSelection(value.config.scopes);
	const normalizedConfig = { ...normalized.config, scopes };
	const suppliedConfig = { ...value.config, scopes };
	if (canonicalJson({ config: normalizedConfig, meta: normalized.meta }) !== canonicalJson({ config: suppliedConfig, meta: runtimeFields })) {
		throw new Error("Invalid State Flow runtime configuration or counters");
	}
}

export interface SelectedLifecycleDocument {
	sourceVersion: 2 | "baseline";
	runtime: SelectedSessionRuntime;
	/** Bytes in the admitted format, not file observations or publication authority. */
	target: { config: string; runtime: string };
}

/** Recognized incompatible evidence is not corrupt memory and must never trigger a reset. */
export class UnsupportedLifecycleFormatError extends Error {}

/** Decode Baseline or V2; classify a retired/unknown runtime before decoding captured config bytes. */
export function parseSelectedLifecycle(
	configSource: string | undefined | (() => string | undefined), runtimeSource: string | undefined, cwd: string, sessionId: string,
): SelectedLifecycleDocument | undefined {
	const readConfig = () => typeof configSource === "function" ? configSource() : configSource;
	if (runtimeSource === undefined) {
		if (readConfig() === undefined) return undefined;
		throw new Error("Incomplete State Flow config/runtime pair");
	}
	const metadata = parsePolicyDocument(runtimeSource);
	if (isObject(metadata) && metadata.version === 1) {
		throw new UnsupportedLifecycleFormatError("State Flow lifecycle V1 is retired; use a previous State Flow release to open this session or start a new session");
	}
	if (!isObject(metadata)) throw new Error("Invalid State Flow session runtime envelope");
	const baseline = metadata.format === "baseline";
	if (baseline && (Object.hasOwn(metadata, "version") || Object.hasOwn(metadata, "causalWitnesses"))) refuseMixedBaseline();
	if (!baseline && metadata.version !== 2) {
		throw new UnsupportedLifecycleFormatError("Unsupported State Flow lifecycle format; keep the files and use a release that supports it");
	}
	const config = readConfig();
	if (config === undefined) throw new Error("Incomplete State Flow config/runtime pair");
	if (baseline) {
		const runtime = decodeBaselineLifecycle(config, metadata, cwd, sessionId);
		return { sourceVersion: "baseline", runtime, target: { config: `${canonicalJson(runtime.config)}\n`, runtime: runtimeSource } };
	}
	const runtime: unknown = { config: parsePolicyDocument(config), meta: metadata };
	validateSelectedSessionRuntime(runtime, cwd, sessionId);
	runtime.config.scopes = captureScopeSelection(runtime.config.scopes);
	return { sourceVersion: 2, runtime, target: { config: `${canonicalJson(runtime.config)}\n`, runtime: `${canonicalJson(runtime.meta)}\n` } };
}

function encodeBaselineLineage(lineage: TransitionBoundary[], evidence: unknown): unknown[] {
	const witnesses = new Map(captureTemporalWitnesses(lineage, evidence, MAX_HISTORY_LIMIT)
		.map(({ transition, owners }) => [transition.id, owners]));
	return lineage.map(boundary => {
		const owners = witnesses.get(boundary.id);
		return owners === undefined ? boundary : { ...boundary, owners };
	});
}

function decodeBaselineLineage(value: unknown): PrivateCausalBasis {
	if (!Array.isArray(value)) throw new Error("Invalid State Flow Baseline lineage");
	const causalWitnesses: unknown[] = [];
	const lineage: unknown = value.map((row, index) => {
		if (!isObject(row) || Object.keys(row).some(key => !["id", "position", "parent", "owners"].includes(key))) {
			throw new Error("Invalid State Flow Baseline transition");
		}
		const { owners, ...transition } = row;
		if (Object.hasOwn(row, "owners")) {
			if (index === 0) throw new Error("State Flow Baseline anchor cannot claim transition owners");
			causalWitnesses.push({ transition, owners });
		}
		return transition;
	});
	validateTemporalLineage(lineage, MAX_HISTORY_LIMIT);
	return { lineage, causalWitnesses: captureTemporalWitnesses(lineage, causalWitnesses, MAX_HISTORY_LIMIT) };
}

/** Pure wire codec. Missing owner claims stay missing; only the storage owner can admit their replay. */
export function parseBaselineLifecycle(config: string, source: string, cwd: string, sessionId: string): SelectedSessionRuntime {
	return decodeBaselineLifecycle(config, parsePolicyDocument(source), cwd, sessionId);
}

function decodeBaselineLifecycle(config: string, raw: unknown, cwd: string, sessionId: string): SelectedSessionRuntime {
	if (!isObject(raw) || raw.format !== "baseline" || Object.hasOwn(raw, "version") || Object.hasOwn(raw, "causalWitnesses")) {
		refuseMixedBaseline();
	}
	const { format: _format, lineage, privateCausalBasis, ...fields } = raw;
	const temporal = decodeBaselineLineage(lineage);
	const privateBasis = Object.hasOwn(raw, "privateCausalBasis")
		? { privateCausalBasis: capturePrivateCausalBasis(decodeBaselineLineage(privateCausalBasis)) } : {};
	const runtime = {
		config: parsePolicyDocument(config),
		meta: { ...fields, ...temporal, ...privateBasis, version: 2 },
	};
	validateSelectedSessionRuntime(runtime, cwd, sessionId);
	runtime.config.scopes = captureScopeSelection(runtime.config.scopes);
	return runtime;
}

/** Serialize selected lifecycle proof without repeating transition identities. No file authority. */
export function serializeBaselineLifecycle(runtime: SelectedSessionRuntime, cwd: string, sessionId: string): { config: string; runtime: string } {
	validateSelectedSessionRuntime(runtime, cwd, sessionId);
	const { version: _version, lineage, causalWitnesses, privateCausalBasis, ...fields } = runtime.meta;
	if (Object.hasOwn(fields, "format")) throw new Error("State Flow Baseline format collides with retained lifecycle metadata");
	const privateBasis = privateCausalBasis === undefined ? {} : {
		privateCausalBasis: encodeBaselineLineage(privateCausalBasis.lineage, privateCausalBasis.causalWitnesses),
	};
	const metadata = {
		...fields, ...privateBasis, format: "baseline",
		lineage: encodeBaselineLineage(lineage, Object.hasOwn(runtime.meta, "causalWitnesses") ? causalWitnesses : []),
	};
	return {
		config: `${canonicalJson({ ...runtime.config, scopes: captureScopeSelection(runtime.config.scopes) })}\n`,
		runtime: `${canonicalJson(metadata)}\n`,
	};
}

function refuseMixedBaseline(): never {
	throw new UnsupportedLifecycleFormatError("Unsupported or mixed State Flow Baseline lifecycle format; canonical files were not accepted");
}

function parsePolicyDocument(source: string): unknown {
	try { return JSON.parse(source); }
	catch { throw new Error("State Flow session policy contains invalid JSON"); }
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

export type SelectedRetainedPiCheckpoint = RetainedPiCheckpoint & { version: 2; scopes: ScopeSelection };
export interface RetainedPolicyMigrationCandidate {
	sourceVersion: "legacy" | 2;
	targetVersion: 2;
	requiresConversion: boolean;
	checkpoint: SelectedRetainedPiCheckpoint;
}

/** Native policy value preflight; no retained boundary, fork or acquisition authority is created. */
export function prepareRetainedPolicyMigration(
	value: unknown, legacySelection: ScopeSelection, inactiveMode: InactiveMode = "passive",
): RetainedPolicyMigrationCandidate {
	if (!isObject(value)) throw new Error("Invalid State Flow policy checkpoint");
	const legacy = !Object.hasOwn(value, "version");
	let declaredVersion: unknown;
	try { if (!legacy) declaredVersion = value.version; }
	catch { throw new Error("Invalid State Flow policy checkpoint"); }
	if (!legacy && declaredVersion !== 2) throw new Error("Unsupported State Flow native policy version");
	const sourceVersion = legacy ? "legacy" : 2;
	if (sourceVersion === "legacy" && Object.hasOwn(value, "scopes")) throw new Error("Target State Flow policy fields in legacy native checkpoint");
	if (!isJsonValue(value)) throw new Error("Invalid State Flow policy checkpoint");
	const { version: _version, scopes, ...lifecycle } = value;
	if (sourceVersion === 2 && (!Object.hasOwn(value, "scopes") || !isStateFlowMode(lifecycle.mode)
		|| Object.hasOwn(lifecycle, "enabled") || Object.hasOwn(lifecycle, "disabled"))) {
		throw new Error("Invalid State Flow lifecycle v2 policy");
	}
	const checkpoint = parseRetainedPiCheckpoint(lifecycle, inactiveMode);
	return {
		sourceVersion, targetVersion: 2, requiresConversion: sourceVersion === "legacy",
		checkpoint: { ...checkpoint, version: 2, scopes: captureScopeSelection(sourceVersion === "legacy" ? legacySelection : scopes) },
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
