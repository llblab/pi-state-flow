import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArtifactProvenanceRegistry } from "./artifact.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { canonicalJson, isJsonValue, isObject, validatePatch, type JsonObject, type JsonValue } from "./json.ts";
import { assertRetainedModules, validateRetainedModules, type RetainedModules } from "./semantic-module.ts";
import { assertNoRetiredSemanticPlanes, type StateScope } from "./state.ts";
import { validateScopeStream, type ScopeStream } from "./temporal.ts";

/** Owns the pure v3/v4 semantic codec and module-descriptor upgrade; excludes I/O, publication, backup and lifecycle authority. */
export interface SemanticMigrationCandidate {
	sourceVersion: 3 | 4;
	targetVersion: 3 | 4;
	/** A format conversion is not an authored semantic transition or revision. */
	requiresConversion: boolean;
	stream: ScopeStream;
}

export type ScopeMigrationFile = "checkpoint" | "patches" | "meta";
export type ScopeMigrationSources = Partial<Record<ScopeMigrationFile, Uint8Array>>;

/** Detached evidence for later backup/CAS, not a publication capability or a filesystem observation. */
export interface MigrationByteReceipt {
	bytes: Uint8Array;
	identity: `sha256:${string}`;
}

export interface SerializedSemanticMigrationCandidate extends SemanticMigrationCandidate {
	basis: Record<ScopeMigrationFile, MigrationByteReceipt>;
	target: Record<ScopeMigrationFile, string>;
}

/** A known retired format, not corruption: self-healing must never reset it. */
export class RetiredSemanticFormatError extends Error {}

/** State Flow 1.0.0 ended the temporary contract/working conversion window; refusal stays explicit. */
export function refuseRetiredSemanticVersion(version: unknown): never {
	throw new RetiredSemanticFormatError(`Unsupported State Flow semantic metadata version ${String(version)}: legacy contract/working memory is no longer converted since State Flow 1.0.0; open it once with State Flow 0.x to convert it`);
}

/** Build a detached target candidate; publication still belongs to the guarded storage transaction. */
export function prepareSemanticMigration(
	value: unknown, scope: StateScope, sourceVersion: number, historyLimit = MAX_HISTORY_LIMIT, targetModules?: RetainedModules,
): SemanticMigrationCandidate {
	if (sourceVersion === 1 || sourceVersion === 2) refuseRetiredSemanticVersion(sourceVersion);
	if (sourceVersion !== 3 && sourceVersion !== 4) throw new Error("Unsupported State Flow migration source version");
	validatePatch(value);
	if (!isObject(value.checkpoint) || !Array.isArray(value.patches)) throw new Error("Invalid temporal checkpoint/tail envelope");
	if (targetModules !== undefined) validateRetainedModules(targetModules);
	if (sourceVersion === 4) {
		validateRetainedModules(value.modules);
		if (targetModules !== undefined) assertRetainedModules(value.modules, targetModules);
	}
	else if (Object.hasOwn(value, "modules")) throw new Error("Legacy State Flow stream cannot declare modules");
	const translate = (state: unknown): JsonObject => {
		if (sourceVersion !== 4 && targetModules !== undefined && isObject(state)
			&& Object.keys(state).some(key => key.startsWith("x_"))) throw new Error("Legacy State Flow external namespace collision");
		validatePatch(state);
		assertNoRetiredSemanticPlanes(state);
		return structuredClone(state);
	};
	// Preserve envelope fields until strict target validation; malformed input must not be sanitized into acceptance.
	const stream = {
		...structuredClone(value),
		...(targetModules === undefined ? {} : { modules: structuredClone(targetModules) }),
		checkpoint: { ...structuredClone(value.checkpoint), state: translate(value.checkpoint.state) },
		patches: value.patches.map((record) => {
			if (!isObject(record)) throw new Error("Invalid temporal patch envelope");
			return { ...structuredClone(record), patch: translate(record.patch) };
		}),
	};
	validateScopeStream(stream, scope, historyLimit);
	const targetVersion = sourceVersion === 4 || targetModules !== undefined ? 4 : 3;
	return { sourceVersion, targetVersion, requiresConversion: sourceVersion !== targetVersion, stream };
}

function captureMigrationBytes(value: Uint8Array | undefined, label: string): MigrationByteReceipt {
	if (!(value instanceof Uint8Array)) throw new Error(`Incomplete State Flow migration cohort: ${label} bytes are required`);
	const bytes = new Uint8Array(value);
	return { bytes, identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function decodeMigrationText(bytes: Uint8Array, label: string): string {
	try {
		// Do not silently repair invalid UTF-8 or strip a BOM that ordinary JSON decoding would reject.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error(`State Flow migration ${label} is not valid UTF-8`);
	}
}

function parseMigrationJson(source: string, label: string): JsonValue {
	let value: unknown;
	try { value = JSON.parse(source); }
	catch { throw new Error(`State Flow migration ${label} contains invalid JSON`); }
	if (!isJsonValue(value)) throw new Error(`State Flow migration ${label} must contain finite JSON data`);
	return value;
}

/** Decode a complete raw owner cohort before filtering; never load files, normalize authority or publish. */
export function prepareSerializedScopeMigration(
	sources: ScopeMigrationSources, scope: StateScope, expectedCwd?: string, targetModules?: RetainedModules,
): SerializedSemanticMigrationCandidate {
	const basis = {
		checkpoint: captureMigrationBytes(sources.checkpoint, "checkpoint"),
		patches: captureMigrationBytes(sources.patches, "patches"),
		meta: captureMigrationBytes(sources.meta, "metadata"),
	};
	const metaText = decodeMigrationText(basis.meta.bytes, "metadata");
	const metadata = parseMigrationJson(metaText, "metadata");
	if (!isObject(metadata)) throw new Error("Invalid State Flow migration metadata");
	const version = metadata.version;
	if (version === 1 || version === 2) refuseRetiredSemanticVersion(version);
	if (version !== 3 && version !== 4) throw new Error("Unsupported State Flow migration source version");
	if (version === 4) validateRetainedModules(metadata.modules);
	else if (targetModules !== undefined && Object.hasOwn(metadata, "modules")) throw new Error("Legacy State Flow modules metadata collision");
	if (scope === "cwd") {
		if (expectedCwd === undefined) throw new Error("State Flow CWD migration requires its canonical identity");
		if (metadata.owner === undefined) throw new Error("State Flow CWD scope identity is missing");
		if (!isObject(metadata.owner) || Object.keys(metadata.owner).join(",") !== "cwd" || metadata.owner.cwd !== resolve(expectedCwd)) {
			throw new Error("State Flow CWD migration identity mismatch");
		}
	} else if (expectedCwd !== undefined) throw new Error("Only State Flow CWD migration accepts a CWD identity");
	if (Object.hasOwn(metadata, "artifacts")) parseArtifactProvenanceRegistry(metadata.artifacts, "State Flow migration provenance");
	const temporal = metadata.temporal;
	if (!isObject(temporal) || !Object.hasOwn(temporal, "checkpoint") || !Array.isArray(temporal.patches)) {
		throw new Error("Invalid State Flow migration temporal metadata");
	}
	if (!Object.hasOwn(temporal, "revision")) throw new Error("State Flow target migration metadata requires a revision");
	const checkpointText = decodeMigrationText(basis.checkpoint.bytes, "checkpoint");
	const patchesText = decodeMigrationText(basis.patches.bytes, "tail");
	const checkpoint = parseMigrationJson(checkpointText, "checkpoint");
	const patches = patchesText.split(/\r?\n/).flatMap((line, index) => line.trim().length === 0 ? []
		: [parseMigrationJson(line, `tail line ${index + 1}`)]);
	const boundaries = temporal.patches;
	if (boundaries.length !== patches.length) throw new Error("State Flow migration metadata does not match its semantic tail");
	const candidate = prepareSemanticMigration({
		...(version === 4 ? { modules: metadata.modules } : {}),
		revision: temporal.revision,
		checkpoint: { through: temporal.checkpoint, state: checkpoint },
		patches: patches.map((patch, index) => ({ transition: boundaries[index], patch })),
	}, scope, version, MAX_HISTORY_LIMIT, targetModules);
	const target = !candidate.requiresConversion && targetModules === undefined ? { checkpoint: checkpointText, patches: patchesText, meta: metaText } : {
		checkpoint: `${canonicalJson(candidate.stream.checkpoint.state)}\n`,
		patches: candidate.stream.patches.map((record) => `${canonicalJson(record.patch)}\n`).join(""),
		meta: `${canonicalJson({ ...metadata, version: candidate.targetVersion,
			...(candidate.stream.modules === undefined ? {} : { modules: candidate.stream.modules }),
			temporal: { ...temporal, revision: candidate.stream.revision } })}\n`,
	};
	return { ...candidate, basis, target };
}
