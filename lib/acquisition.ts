import {
  classifyArtifactCompilationNeed,
  inspectRegisteredArtifactPaths,
  sameArtifactSourceFingerprint,
  type ArtifactInvalidationReason,
  type ArtifactInvalidationRequest,
  type ArtifactSourceFingerprint,
  type ArtifactSourceIdentity,
  ORDINARY_ARTIFACT_COMPILER,
  type ArtifactProvenanceRegistry,
  type ArtifactMetadata,
} from "./artifact.ts";
import { isObject, sameJson, type JsonObject } from "./json.ts";
import { assertScopeStateValues, type AtomicScopePatches, type ScopeStateValues, type StateScope } from "./state.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";

/** Why the caller is considering source-body acquisition. */
export type ArtifactAcquisitionIntent =
	| "routine"
	| "new-session"
	| "relevant-gap"
	| "exact-source"
	| "exact-edit"
	| "contradiction-or-failure"
	| "explicit-request"
	| "maintenance";

export type ArtifactAcquisitionReason =
	| ArtifactInvalidationReason
	| "materialized-gap"
	| "exact-source"
	| "exact-edit"
	| "contradiction-or-failure"
	| "explicit-request"
	| "maintenance";

export type ArtifactAcquisitionDecision =
	| { kind: "use-materialized"; reason: "no-concrete-need" | "materialized-sufficient" }
	| { kind: "read-source"; reason: ArtifactAcquisitionReason };

export interface ArtifactAcquisitionOptions {
	intent: ArtifactAcquisitionIntent;
	/** Caller-assessed semantic sufficiency; only relevant to a concrete relevant gap. */
	materializedSufficient?: boolean;
	explicitRefresh?: boolean;
	/** Runtime-owned compilation evidence retained beside the semantic artifact. */
	provenance?: unknown;
}

/** A successful read correlated to a runtime-observed invalidation candidate. */
export interface SuccessfulArtifactRead extends ArtifactInvalidationRequest {}

interface PendingRead {
	toolName: string;
	args: unknown;
	fingerprint?: ArtifactSourceFingerprint;
	path?: string;
	candidate?: ArtifactInvalidationRequest;
}

function readPath(toolName: unknown, args: unknown): string | undefined {
	return toolName === "read" && isObject(args) && typeof args.path === "string"
		? args.path
		: undefined;
}

/** Correlate successful read-tool executions with the current ordinary artifact invalidation plan. */
export class ArtifactReadTracker {
	readonly successful = new Map<string, SuccessfulArtifactRead>();
	readonly #pending = new Map<string, PendingRead>();
	readonly #candidates = new Map<string, ArtifactInvalidationRequest>();

	#selection = DEFAULT_SCOPE_SELECTION;

	setCandidates(candidates: Iterable<ArtifactInvalidationRequest>, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): void {
		const wanted = captureScopeSelection(selection);
		const next = new Map<string, ArtifactInvalidationRequest>();
		for (const candidate of candidates) {
			if (!wanted.includes(candidate.scope ?? "global")) continue;
			const captured = structuredClone(candidate);
			for (const key of ["scope", "hash", "sourceFingerprint"] as const) if (captured[key] === undefined) delete captured[key];
			next.set(candidate.path, captured);
		}
		if (!sameJson(wanted, this.#selection)) this.clear();
		this.#selection = wanted;
		for (const [path] of this.successful) {
			const previous = this.#candidates.get(path), current = next.get(path);
			if (previous === undefined || current === undefined || !sameJson(previous, current)) this.successful.delete(path);
		}
		this.#candidates.clear();
		for (const [path, candidate] of next) this.#candidates.set(path, candidate);
		for (const [id, pending] of this.#pending) {
			const current = pending.path === undefined ? undefined : next.get(pending.path);
			if (current === undefined || pending.candidate === undefined || !sameJson(current, pending.candidate)) this.#pending.delete(id);
		}
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
		const path = readPath(pending.toolName, pending.args);
		if (path === undefined || path !== pending.path) return;
		const candidate = this.#candidates.get(path);
		if (candidate === undefined || pending.candidate === undefined || pending.fingerprint === undefined || !sameJson(candidate, pending.candidate)) return;
		const observation = inspectRegisteredArtifactPaths([path])[0];
		if (observation?.kind !== "present" || !sameArtifactSourceFingerprint(pending.fingerprint, observation.fingerprint)) return;
		const finalObservation = inspectRegisteredArtifactPaths([path])[0];
		if (finalObservation?.kind !== "present" || !sameArtifactSourceFingerprint(observation.fingerprint, finalObservation.fingerprint)) return;
		this.successful.set(path, structuredClone({ ...candidate, sourceFingerprint: finalObservation.fingerprint }));
	}

	#record(toolCallId: string, toolName: string, args: unknown): void {
		if (toolName !== "read") {
			this.#pending.delete(toolCallId);
			return;
		}
		const path = readPath(toolName, args);
		const observation = path !== undefined && this.#candidates.has(path) ? inspectRegisteredArtifactPaths([path])[0] : undefined;
		this.#pending.set(toolCallId, {
			toolName,
			args, path, candidate: path === undefined ? undefined : this.#candidates.get(path),
			...(observation?.kind === "present" ? { fingerprint: observation.fingerprint } : {}),
		});
	}
}

/**
 * Apply one materialized-first source acquisition policy.
 *
 * Required recompilation always wins. Otherwise routine use and a new session
 * stay on materialized state; only a concrete source need permits rereading.
 */
export function decideArtifactAcquisition(
	source: ArtifactSourceIdentity,
	metadata: unknown,
	compiler: string,
	options: ArtifactAcquisitionOptions,
): ArtifactAcquisitionDecision {
	const need = classifyArtifactCompilationNeed(
		source,
		metadata,
		compiler,
		options.explicitRefresh ?? false,
		options.provenance,
	);
	if (need.kind === "requires-compilation") {
		return { kind: "read-source", reason: need.reason };
	}

	switch (options.intent) {
		case "routine":
		case "new-session":
			return { kind: "use-materialized", reason: "no-concrete-need" };
		case "relevant-gap":
			return options.materializedSufficient === true
				? { kind: "use-materialized", reason: "materialized-sufficient" }
				: { kind: "read-source", reason: "materialized-gap" };
		case "exact-source":
			return { kind: "read-source", reason: "exact-source" };
		case "exact-edit":
			return { kind: "read-source", reason: "exact-edit" };
		case "contradiction-or-failure":
			return { kind: "read-source", reason: "contradiction-or-failure" };
		case "explicit-request":
			return { kind: "read-source", reason: "explicit-request" };
		case "maintenance":
			return { kind: "read-source", reason: "maintenance" };
	}
}

export const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";

/**
 * One selected branch's ordinary-artifact acquisition plan: runtime-observed
 * invalidations, their model hints and the read tracker correlated to them.
 * The tracker's candidates always equal the current invalidation plan.
 */
export class ArtifactAcquisitionState {
	readonly reads = new ArtifactReadTracker();
	#invalidations: ArtifactInvalidationRequest[] = [];
	#hints: Record<string, string> = {};
	#selection = DEFAULT_SCOPE_SELECTION;

	get invalidations(): readonly ArtifactInvalidationRequest[] { return this.#invalidations; }
	get hints(): Record<string, string> { return this.#hints; }

	/** Drop the invalidation plan; hints remain until the next refresh. */
	clearInvalidations(): void { this.#setInvalidations([]); }

	/** Forget plan and hints when no memory view is selected. */
	reset(): void {
		this.#hints = {};
		this.#setInvalidations([]);
	}

	/** Re-observe exact registered sources for the selected scope artifacts. */
	refresh(states: ScopeStateValues, provenance: (scope: StateScope) => ArtifactProvenanceRegistry, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): void {
		const wanted = captureScopeSelection(selection);
		assertScopeStateValues(states, wanted);
		const effective = new Map<string, { scope: StateScope; metadata: ArtifactMetadata }>();
		for (const scope of wanted) for (const [path, metadata] of Object.entries(states[scope]!.artifacts ?? {})) effective.set(path, { scope, metadata });
		const paths = [...effective].filter(([, { metadata }]) => metadata.kind !== "skill").map(([path]) => path);
		const observations = new Map(inspectRegisteredArtifactPaths(paths).map((observation) => [observation.path, observation]));
		const hints: Record<string, string> = {};
		const invalidations: ArtifactInvalidationRequest[] = [];
		const registries = new Map<StateScope, ArtifactProvenanceRegistry>();
		for (const path of paths) {
			const { scope, metadata } = effective.get(path)!;
			const observed = observations.get(path);
			if (observed?.kind !== "present") continue;
			if (!registries.has(scope)) registries.set(scope, provenance(scope));
			const need = classifyArtifactCompilationNeed({ path, scope, sourceFingerprint: observed.fingerprint }, metadata, ORDINARY_ARTIFACT_COMPILER, false, registries.get(scope)![path]);
			if (need.kind !== "requires-compilation") continue;
			if (need.reason === "source-changed") hints[path] = SOURCE_CHANGED_HINT;
			invalidations.push({ path, scope, reason: need.reason });
		}
		this.#selection = wanted;
		this.#hints = hints;
		this.#setInvalidations(invalidations.sort((left, right) => left.path.localeCompare(right.path)));
	}

	/** Accepted compilations leave the plan; correlated read evidence is single-use. */
	acceptAcquired(paths: ReadonlySet<string> = new Set(this.reads.successful.keys())): void {
		this.#setInvalidations(this.#invalidations.filter(({ path }) => !paths.has(path)));
		this.reads.clear();
	}

	#setInvalidations(invalidations: ArtifactInvalidationRequest[]): void {
		this.#invalidations = invalidations;
		this.reads.setCandidates(invalidations, this.#selection);
	}
}

/** Exact-path metadata revalidation only; callers acquire source bodies outside canonical exclusion. */
export function validateArtifactReadEvidence(reads: Iterable<SuccessfulArtifactRead>, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): void {
	const wanted = captureScopeSelection(selection);
	for (const read of reads) {
		if (!wanted.includes(read.scope ?? "global")) continue;
		const observed = inspectRegisteredArtifactPaths([read.path])[0];
		if (read.sourceFingerprint === undefined || observed?.kind !== "present" || !sameArtifactSourceFingerprint(read.sourceFingerprint, observed.fingerprint)) {
			throw new Error(`Artifact source changed after acquisition: ${read.path}`);
		}
	}
}

/** Deletion patches for registered artifacts whose exact source is observed missing, in every owning scope. */
export function missingArtifactRemovals(states: ScopeStateValues, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): AtomicScopePatches {
	const wanted = captureScopeSelection(selection);
	assertScopeStateValues(states, wanted);
	const owners = new Map<string, StateScope[]>();
	for (const scope of wanted) for (const path of Object.keys(states[scope]!.artifacts ?? {})) {
		owners.set(path, [...owners.get(path) ?? [], scope]);
	}
	const removals: AtomicScopePatches = {};
	for (const observation of inspectRegisteredArtifactPaths(owners.keys())) {
		if (observation.kind !== "missing") continue;
		for (const scope of owners.get(observation.path) ?? []) {
			const artifacts = (removals[scope]?.artifacts ?? {}) as JsonObject;
			removals[scope] = { ...(removals[scope] ?? {}), artifacts: { ...artifacts, [observation.path]: null } };
		}
	}
	return removals;
}
