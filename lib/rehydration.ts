import {
	decideArtifactAcquisition,
	type ArtifactAcquisitionIntent,
	type ArtifactAcquisitionReason,
} from "./acquisition.ts";
import type { ArtifactSourceIdentity } from "./artifact.ts";
import type { StateScope } from "./state.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";

export type RehydrationPhase = "resume-bootstrap" | "new-bootstrap" | "step";

export interface RehydrationRoute {
	scope: StateScope;
	source: ArtifactSourceIdentity;
	metadata: unknown;
	/** Runtime-owned compilation evidence retained beside the semantic artifact. */
	provenance?: unknown;
	compiler: string;
	intent: ArtifactAcquisitionIntent;
	materializedSufficient?: boolean;
	explicitRefresh?: boolean;
	sourceBytes?: number;
}

export interface RehydrationRead extends ArtifactSourceIdentity {
	scope: StateScope;
	reason: ArtifactAcquisitionReason;
}

export interface RehydrationPlan {
	reads: RehydrationRead[];
	materialized: string[];
	deferred: Array<{ path: string; reason: "new-session-scope" | "read-count-limit" | "source-byte-limit" }>;
}

export interface RehydrationOptions {
	/** Legacy callers default to all owners; selected callers must pass their captured concrete policy. */
	selection?: ScopeSelection;
	maxReads?: number;
	maxSourceBytes?: number;
}

/** Plan visible reads only; this function never reads, compiles, mutates, or publishes sources. */
export function planKnowledgeRehydration(
	phase: RehydrationPhase,
	routes: readonly RehydrationRoute[],
	options: RehydrationOptions = {},
): RehydrationPlan {
	const selection = captureScopeSelection(options.selection ?? DEFAULT_SCOPE_SELECTION);
	const selected = routes.filter(route => {
		if (!DEFAULT_SCOPE_SELECTION.includes(route.scope)) throw new Error("Unknown State Flow rehydration owner");
		return selection.includes(route.scope);
	});
	const maxReads = Math.max(0, Math.floor(options.maxReads ?? 1));
	const maxSourceBytes = Math.max(0, Math.floor(options.maxSourceBytes ?? 64 * 1024));
	const reads: RehydrationRead[] = [];
	const materialized: string[] = [];
	const deferred: RehydrationPlan["deferred"] = [];
	let sourceBytes = 0;
	for (const route of [...selected].sort((left, right) => left.source.path.localeCompare(right.source.path))) {
		if (route.source.scope !== undefined && route.source.scope !== route.scope) throw new Error("State Flow rehydration source owner does not match its route");
		if (phase === "new-bootstrap" && route.scope === "session") {
			deferred.push({ path: route.source.path, reason: "new-session-scope" });
			continue;
		}
		const decision = decideArtifactAcquisition(route.source, route.metadata, route.compiler, {
			intent: route.intent,
			...(route.materializedSufficient === undefined ? {} : { materializedSufficient: route.materializedSufficient }),
			...(route.explicitRefresh === undefined ? {} : { explicitRefresh: route.explicitRefresh }),
			...(route.provenance === undefined ? {} : { provenance: route.provenance }),
		});
		if (decision.kind === "use-materialized") {
			materialized.push(route.source.path);
			continue;
		}
		if (reads.length >= maxReads) {
			deferred.push({ path: route.source.path, reason: "read-count-limit" });
			continue;
		}
		const bytes = route.sourceBytes ?? 0;
		if (sourceBytes + bytes > maxSourceBytes) {
			deferred.push({ path: route.source.path, reason: "source-byte-limit" });
			continue;
		}
		sourceBytes += bytes;
		reads.push({
			scope: route.scope, path: route.source.path, reason: decision.reason,
			...(route.source.hash === undefined ? {} : { hash: route.source.hash }),
			...(route.source.sourceFingerprint === undefined ? {} : { sourceFingerprint: structuredClone(route.source.sourceFingerprint) }),
		});
	}
	return { reads, materialized, deferred };
}
