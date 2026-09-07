import {
	classifyArtifactFreshness,
	type ArtifactInvalidationReason,
	type ArtifactInvalidationRequest,
	type ArtifactSourceIdentity,
} from "./artifact.ts";
import { isObject } from "./json.ts";

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
}

/** A successful read correlated to a runtime-observed invalidation candidate. */
export interface SuccessfulArtifactRead extends ArtifactInvalidationRequest {}

interface PendingRead {
	toolName: string;
	args: unknown;
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

	setCandidates(candidates: Iterable<ArtifactInvalidationRequest>): void {
		this.#candidates.clear();
		for (const candidate of candidates) this.#candidates.set(candidate.path, structuredClone(candidate));
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
		if (path === undefined) return;
		const candidate = this.#candidates.get(path);
		if (candidate !== undefined) this.successful.set(path, structuredClone(candidate));
	}

	#record(toolCallId: string, toolName: string, args: unknown): void {
		if (toolName !== "read") {
			this.#pending.delete(toolCallId);
			return;
		}
		this.#pending.set(toolCallId, { toolName, args });
	}
}

/**
 * Apply one materialized-first source acquisition policy.
 *
 * Freshness invalidation always wins. Otherwise routine use and a new session
 * stay on materialized state; only a concrete source need permits rereading.
 */
export function decideArtifactAcquisition(
	source: ArtifactSourceIdentity,
	metadata: unknown,
	compiler: string,
	options: ArtifactAcquisitionOptions,
): ArtifactAcquisitionDecision {
	const freshness = classifyArtifactFreshness(
		source,
		metadata,
		compiler,
		options.explicitRefresh ?? false,
	);
	if (freshness.kind === "requires-compilation") {
		return { kind: "read-source", reason: freshness.reason };
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
