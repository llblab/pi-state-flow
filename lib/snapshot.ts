import { resolve } from "node:path";
import { RECENT_TRANSITION_LIMIT } from "./history.ts";
import { parseRemotePublicationPolicyDocument, serializeRemotePublicationPolicyDocument, type RemotePublicationPolicyDocument } from "./publication.ts";
import { applyPatch, canonicalJson, containsNull, isJsonValue, isObject, type JsonObject } from "./json.ts";
import { validateTemporalLineage, type TransitionBoundary } from "./temporal.ts";
import { migrateLegacySkillCompilations } from "./skills.ts";
import { isMaterializedState, type MaterializedState } from "./state.ts";
import { MAX_VALIDATION_RETRIES, type ValidationFeedback } from "./validation.ts";

const MAX_RESTORED_STEP = Number.MAX_SAFE_INTEGER - 1;

/** Missing operational capability is not evidence that a checkpoint target is invalid. */
export class RevisionUnavailableError extends Error {}

export interface SnapshotConfig {
	enabled: boolean;
	transitionWindow: number;
}

export interface PendingPublicationState {
	commit: string;
	error: string;
}

export interface SnapshotMeta {
	durableBase?: string;
	pendingPublication?: PendingPublicationState;
	step: number;
	specification?: string;
	validation?: ValidationFeedback;
	bootstrap?: boolean;
	remotePublication?: RemotePublicationPolicyDocument;
}

export interface LegacySessionMigration {
	state: MaterializedState;
}

/** In-memory runtime config/provenance; durable config/meta and scope files own restoration. */
export interface StateFlowSnapshot {
	config: SnapshotConfig;
	meta: SnapshotMeta;
	/** Ephemeral one-way migration payload. persistSnapshot() never writes it to Pi checkpoints. */
	legacySession?: LegacySessionMigration;
}

export type Snapshot = StateFlowSnapshot;

export interface SessionRuntime {
	config: SnapshotConfig;
	meta: Omit<SnapshotMeta, "durableBase" | "pendingPublication"> & {
		version: 1;
		identity: { cwd: string; sessionId: string };
		lineage: TransitionBoundary[];
		/** Resolved against the commit that last wrote this runtime record, not arbitrary HEAD. */
		revision: "self";
		temporalRevision?: "self" | string;
		/** Durable intent survives a crash before the push result can be observed. */
		publication: "unconfirmed" | "files";
	};
}

export function validateSessionRuntime(value: unknown, cwd: string, sessionId: string): asserts value is SessionRuntime {
	if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "config,meta"
		|| !isObject(value.config) || !isObject(value.meta)) throw new Error("Invalid State Flow session runtime envelope");
	const { version, identity, lineage, revision, temporalRevision, publication, ...fields } = value.meta;
	if (temporalRevision !== undefined && temporalRevision !== "self"
		&& !isExactRevision(temporalRevision)) throw new Error("Invalid temporal revision reference");
	if (version !== 1 || revision !== "self" || (publication !== "unconfirmed" && publication !== "files")) throw new Error("Unsupported State Flow runtime provenance format");
	if (publication === "files" && temporalRevision !== undefined && temporalRevision !== "self") throw new Error("File runtime cannot select a historical temporal revision");
	if (!isObject(identity) || Object.keys(identity).sort().join(",") !== "cwd,sessionId"
		|| identity.cwd !== resolve(cwd) || identity.sessionId !== sessionId || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
		throw new Error("State Flow runtime scope identity mismatch");
	}
	validateTemporalLineage(lineage);
	const allowed = new Set(["step", "specification", "validation", "bootstrap", "remotePublication"]);
	if (Object.keys(fields).some((key) => !allowed.has(key))) throw new Error("Unexpected State Flow runtime metadata field");
	const normalized = migrateSnapshot({ config: value.config, meta: fields });
	if (fields.bootstrap === false) normalized.meta.bootstrap = false;
	if (fields.step === Number.MAX_SAFE_INTEGER) normalized.meta.step = Number.MAX_SAFE_INTEGER;
	if (canonicalJson({ config: normalized.config, meta: normalized.meta }) !== canonicalJson({ config: value.config, meta: fields })) {
		throw new Error("Invalid State Flow runtime configuration or counters");
	}
}

export function createSessionRuntime(snapshot: Snapshot, cwd: string, sessionId: string, lineage: readonly TransitionBoundary[], publication: SessionRuntime["meta"]["publication"] = "unconfirmed"): SessionRuntime {
	const { durableBase: _base, pendingPublication: _publication, ...fields } = snapshot.meta;
	const runtime: SessionRuntime = {
		config: structuredClone(snapshot.config),
		meta: {
			...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Omit<SnapshotMeta, "durableBase" | "pendingPublication">,
			version: 1,
			identity: { cwd: resolve(cwd), sessionId },
			lineage: structuredClone([...lineage]),
			revision: "self",
			publication,
		},
	};
	validateSessionRuntime(runtime, cwd, sessionId);
	return runtime;
}

export function serializeSessionRuntime(runtime: SessionRuntime, cwd: string, sessionId: string): { config: string; meta: string } {
	validateSessionRuntime(runtime, cwd, sessionId);
	return { config: `${canonicalJson(runtime.config)}\n`, meta: `${canonicalJson(runtime.meta)}\n` };
}

export function parseSessionRuntime(config: string | undefined, meta: string | undefined, cwd: string, sessionId: string): SessionRuntime | undefined {
	if (config === undefined && meta === undefined) return undefined;
	if (config === undefined || meta === undefined) throw new Error("Incomplete State Flow config/meta pair");
	let runtime: unknown;
	try {
		runtime = { config: JSON.parse(config), meta: JSON.parse(meta) };
	} catch {
		throw new Error("State Flow session runtime contains invalid JSON");
	}
	validateSessionRuntime(runtime, cwd, sessionId);
	return runtime;
}

export function resolveSessionRuntime(runtime: SessionRuntime, revision: string): { snapshot: Snapshot; lineage: TransitionBoundary[]; publicationTarget: string } {
	validateSessionRuntime(runtime, runtime.meta.identity.cwd, runtime.meta.identity.sessionId);
	if (!isExactRevision(revision) || runtime.meta.publication !== "unconfirmed") throw new Error("Runtime self reference requires its exact Git revision and Git publication provenance");
	const { version: _version, identity: _identity, lineage, revision: _self, temporalRevision: _temporal, publication: _intent, ...fields } = runtime.meta;
	return {
		snapshot: { config: structuredClone(runtime.config), meta: { ...structuredClone(fields), durableBase: revision } },
		lineage: structuredClone(lineage),
		publicationTarget: revision,
	};
}

export function resolveFileSessionRuntime(runtime: SessionRuntime, revision: string): Snapshot {
	validateSessionRuntime(runtime, runtime.meta.identity.cwd, runtime.meta.identity.sessionId);
	if (!isFileRevision(revision) || runtime.meta.publication !== "files") throw new Error("File runtime requires its exact file revision and file publication provenance");
	const { version: _version, identity: _identity, lineage: _lineage, revision: _self, temporalRevision: _temporal, publication: _intent, ...fields } = runtime.meta;
	return { config: structuredClone(runtime.config), meta: { ...structuredClone(fields), durableBase: revision } };
}

function isLegacyTwoPartState(value: unknown): value is { contract: JsonObject; working: JsonObject } {
	return isObject(value)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& Object.keys(value).every((key) => key === "contract" || key === "working");
}

function isLegacyThreePartState(value: unknown): value is { contract: JsonObject; working: JsonObject; response: string } {
	return isObject(value)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& typeof value.response === "string"
		&& Object.keys(value).every((key) => key === "contract" || key === "working" || key === "response");
}

function restoredStep(value: unknown): number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= MAX_RESTORED_STEP
		? value
		: 0;
}

function restoredValidation(value: unknown): ValidationFeedback | undefined {
	if (!isObject(value)
		|| !Number.isSafeInteger(value.attempt as number)
		|| (value.attempt as number) < 0
		|| (value.attempt as number) > MAX_VALIDATION_RETRIES
		|| typeof value.error !== "string"
		|| typeof value.instruction !== "string") return undefined;
	return {
		attempt: value.attempt as number,
		error: value.error,
		instruction: value.instruction,
	};
}

function restoredTransitionWindow(value: unknown): number {
	return Number.isSafeInteger(value)
		&& (value as number) >= 0
		&& (value as number) <= RECENT_TRANSITION_LIMIT
		? value as number
		: RECENT_TRANSITION_LIMIT;
}

function restoredPendingPublication(value: unknown): PendingPublicationState | undefined {
	if (!isObject(value)
		|| typeof value.commit !== "string"
		|| !/^[0-9a-f]{40,64}$/.test(value.commit)
		|| typeof value.error !== "string"
		|| value.error.trim().length === 0) return undefined;
	return { commit: value.commit, error: value.error };
}

function restoredMeta(value: unknown, legacy: JsonObject = {}): SnapshotMeta {
	const meta = isObject(value) ? value : legacy;
	const pendingPublication = restoredPendingPublication(meta.pendingPublication);
	const validation = restoredValidation(meta.validation);
	let remotePublication: RemotePublicationPolicyDocument | undefined;
	try {
		if (meta.remotePublication !== undefined) remotePublication = serializeRemotePublicationPolicyDocument(
			parseRemotePublicationPolicyDocument(meta.remotePublication, { legacyRuntime: false }),
		);
	} catch {
		remotePublication = undefined;
	}
	return {
		...(isDurableRevision(meta.durableBase)
			? { durableBase: meta.durableBase }
			: {}),
		...(pendingPublication === undefined ? {} : { pendingPublication }),
		step: restoredStep(meta.step),
		...(typeof meta.specification === "string" ? { specification: meta.specification } : {}),
		...(validation === undefined ? {} : { validation }),
		...(meta.bootstrap === true ? { bootstrap: true } : {}),
		...(remotePublication === undefined ? {} : { remotePublication }),
	};
}

function envelope(
	enabled: boolean,
	meta: SnapshotMeta,
	transitionWindow = RECENT_TRANSITION_LIMIT,
	legacySession?: LegacySessionMigration,
): Snapshot {
	return {
		config: { enabled, transitionWindow },
		meta,
		...(legacySession === undefined ? {} : { legacySession }),
	};
}

export function emptySnapshot(enabled = false): Snapshot {
	return envelope(enabled, { step: 0 });
}

export type PiCheckpoint = { revision: string } | { disabled: true };
export type FileRevision = `file:${string}`;

export function isFileRevision(value: unknown): value is FileRevision {
	return typeof value === "string" && /^file:[0-9a-f]{64}$/.test(value);
}

export function isDurableRevision(value: unknown): value is string {
	return isExactRevision(value) || isFileRevision(value);
}

export function isExactRevision(value: unknown): value is string {
	return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

export function persistableSnapshot(snapshot: Snapshot): PiCheckpoint {
	if (snapshot.meta.durableBase !== undefined) {
		if (!isDurableRevision(snapshot.meta.durableBase)) throw new Error("Checkpoint requires an exact Git revision or file reference");
		return { revision: snapshot.meta.durableBase };
	}
	if (snapshot.legacySession) throw new Error("Legacy semantic state requires migration before checkpoint publication");
	if (snapshot.config.enabled) throw new Error("Enabled checkpoint requires a durable runtime revision");
	return { disabled: true };
}

/** New wire shapes are strict; predecessor envelopes remain one-way migration input. */
export function parsePiCheckpoint(value: unknown): PiCheckpoint | Snapshot {
	if (!isObject(value)) throw new Error("Invalid State Flow checkpoint");
	if (Object.hasOwn(value, "revision") || Object.hasOwn(value, "disabled")) {
		if (Object.keys(value).length === 1) {
			if (isDurableRevision(value.revision)) return { revision: value.revision };
			if (value.disabled === true) return { disabled: true };
		}
		throw new Error("Invalid State Flow checkpoint pointer or disabled marker");
	}
	if (!Object.hasOwn(value, "config") && !Object.hasOwn(value, "enabled")) throw new Error("Unrecognized State Flow checkpoint");
	const config = Object.hasOwn(value, "config") ? value.config : value;
	if (!isObject(config) || typeof config.enabled !== "boolean") throw new Error("Invalid legacy State Flow configuration");
	if (Object.hasOwn(value, "meta") && !isObject(value.meta)) throw new Error("Invalid legacy State Flow metadata");
	const meta = isObject(value.meta) ? value.meta : value;
	if (Object.hasOwn(meta, "durableBase") && !isDurableRevision(meta.durableBase)) throw new Error("Invalid legacy State Flow revision");
	return migrateSnapshot(value);
}

export function migrationFailure(data: JsonObject, error: string): Snapshot {
	const meta = restoredMeta(data.meta, data);
	meta.validation = {
		attempt: 0,
		error,
		instruction: "Start a fresh State Flow episode; null is reserved for patch deletion.",
	};
	const config = isObject(data.config) ? data.config : data;
	return envelope(false, meta, restoredTransitionWindow(config.transitionWindow));
}

function migratedSnapshot(
	enabled: boolean,
	meta: SnapshotMeta,
	transitionWindow: number,
	state: MaterializedState,
): Snapshot {
	return envelope(enabled, meta, transitionWindow, {
		state: migrateLegacySkillCompilations(state),
	});
}

export function migrateSnapshot(value: unknown): Snapshot {
	if (!isObject(value)) return emptySnapshot();
	const isEnvelope = Object.hasOwn(value, "config") || Object.hasOwn(value, "meta");
	const config = isEnvelope && isObject(value.config) ? value.config : value;
	const meta = restoredMeta(isEnvelope ? value.meta : undefined, value);
	const enabled = config.enabled === true;
	const transitionWindow = restoredTransitionWindow(config.transitionWindow);
	if (isMaterializedState(value.state)) {
		if (!isJsonValue(value.state)) return migrationFailure(value, "Restored state contains non-JSON data");
		if (containsNull(value.state)) return migrationFailure(value, "Restored state contains null data");
		return migratedSnapshot(enabled, meta, transitionWindow, structuredClone(value.state));
	}
	if (isLegacyThreePartState(value.state)) {
		if (!isJsonValue(value.state)) return migrationFailure(value, "Restored state contains non-JSON data");
		if (containsNull(value.state)) return migrationFailure(value, "Restored state contains null data");
		return migratedSnapshot(enabled, meta, transitionWindow, {
			artifacts: {},
			...structuredClone(value.state),
		});
	}
	if (isLegacyTwoPartState(value.state)) {
		if (!isJsonValue(value.state)) return migrationFailure(value, "Restored state contains non-JSON data");
		if (containsNull(value.state)) return migrationFailure(value, "Restored state contains null data");
		return migratedSnapshot(enabled, meta, transitionWindow, {
			artifacts: {},
			contract: structuredClone(value.state.contract),
			working: structuredClone(value.state.working),
			response: "",
		});
	}
	if (Object.hasOwn(value, "state")) {
		if (isObject(value.state)
			&& (Object.hasOwn(value.state, "response")
				|| Object.hasOwn(value.state, "artifacts")
				|| (Object.hasOwn(value.state, "contract") && Object.hasOwn(value.state, "working")))) {
			return migrationFailure(value, "Restored state has an invalid materialized-state schema");
		}
		if (value.state !== undefined && !isObject(value.state)) {
			return migrationFailure(value, "Restored state has an invalid materialized-state schema");
		}
	}
	if (Object.hasOwn(value, "stateBasis") || Object.hasOwn(value, "previousStatePatch")) {
		const legacyBasis = isObject(value.stateBasis)
			? value.stateBasis
			: isObject(value.state)
				? value.state
				: {};
		const legacyPatch = isObject(value.previousStatePatch) ? value.previousStatePatch : undefined;
		if (!isJsonValue(legacyBasis) || (legacyPatch !== undefined && !isJsonValue(legacyPatch))) {
			return migrationFailure(value, "Legacy state contains non-JSON data");
		}
		const legacyState = legacyPatch === undefined ? legacyBasis : applyPatch(legacyBasis, legacyPatch);
		if (containsNull(legacyState)) return migrationFailure(value, "Legacy state contains null data");
		return migratedSnapshot(enabled, meta, transitionWindow, {
			artifacts: {}, contract: {}, working: structuredClone(legacyState), response: "",
		});
	}
	return envelope(enabled, meta, transitionWindow);
}
