import type { ArtifactInvalidationReason } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { ownedTopLevelKeys } from "./ownership.ts";
import { conciseDiagnostic } from "./protocol.ts";
import type { Snapshot } from "./snapshot.ts";
import { overlayStates, projectSemanticState, type SemanticState, type ScopedStates, type StateScope } from "./state.ts";
import type { ScopeRevisions, TransitionBoundary } from "./temporal.ts";

export const STATUS_KEY = "state-flow";

export type Colorize = (color: "accent" | "dim", text: string) => string;

export type StaleArtifactReason = ArtifactInvalidationReason | "source-removed";

export interface StaleArtifactDiagnostic {
	scope: StateScope;
	path: string;
	reason: StaleArtifactReason;
}

export interface StatusDiagnostics {
	repositoryRoot: string;
	cwdScopeKey: string;
	sessionScopeKey: string;
	scopeStates: ScopedStates;
	/** Overlay raw scopes before defaults so absent scalar planes cannot mask lower scopes. */
	effectiveState?: SemanticState;
	recent: RecentTransitionWindow;
	historyLimit: number;
	temporal?: { head: TransitionBoundary; historyDepth: number; tailCounts: Record<StateScope, number>; revisions: ScopeRevisions };
	staleArtifacts: readonly StaleArtifactDiagnostic[];
	durableStateError?: string;
	publicationError?: string;
}

export function formatScopeRevisionVector(revisions: ScopeRevisions): string {
	return `g${revisions.global}c${revisions.cwd}s${revisions.session}`;
}

export function compactStatus(snapshot: Snapshot, _revisions: ScopeRevisions, colorize: Colorize): string | undefined {
	const { mode } = snapshot.config;
	if (mode === "off") return undefined;
	return `${colorize("accent", "state-flow")} ${colorize("dim", mode)}`;
}

function countArtifacts(states: ScopedStates, scope: StateScope): number {
	return Object.keys(states[scope].artifacts).length;
}

const STATUS_PLANES = ["intents", "contract", "working", "artifacts", "response", "lazy"] as const;
const encoder = new TextEncoder();

function isPresentPlane(value: unknown): boolean {
	if (value === undefined || value === "") return false;
	return typeof value !== "object" || value === null || Object.keys(value).length > 0;
}

/** Operator-only footprint: serialized plane sizes and intent-owned share of top-level working/lazy entries. */
export function scopeMemoryLines(states: ScopedStates): string[] {
	const lines: string[] = [];
	for (const scope of ["global", "cwd", "session"] as const) {
		const state = states[scope] as SemanticState;
		const sizes = STATUS_PLANES.filter((plane) => isPresentPlane(state[plane]))
			.map((plane) => `${plane} ${encoder.encode(JSON.stringify(state[plane])).length} B`);
		if (sizes.length === 0) continue;
		const owned = ownedTopLevelKeys(scope, state);
		const shares = (["working", "lazy"] as const).flatMap((plane) => {
			const value = state[plane];
			const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
			return keys.length === 0 ? [] : [`${plane} ${keys.filter((key) => owned[plane].has(key)).length}/${keys.length}`];
		});
		lines.push(`- ${scope}: ${sizes.join(", ")}${shares.length ? `; intent-owned ${shares.join(", ")}` : ""}`);
	}
	return lines.length ? ["Scope memory:", ...lines] : [];
}

export function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string {
	const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
	const materialized = !available ? undefined : diagnostics.effectiveState ?? projectSemanticState(overlayStates(
		diagnostics.scopeStates.global,
		diagnostics.scopeStates.cwd,
		diagnostics.scopeStates.session,
	));
	// Only top-level plane boundaries gain whitespace; nested user JSON stays unchanged.
	const stateJson = materialized === undefined ? undefined : JSON.stringify(materialized, null, 2).replace(/,\n(?=  ")/g, ",\n\n");
	const invalidated = available ? String(diagnostics.staleArtifacts.length) : "unavailable";
	const invalidationLines = diagnostics.staleArtifacts.length === 0
		? []
		: [
			"Pending artifact invalidations:",
			...diagnostics.staleArtifacts.map(({ scope, path, reason }) => `- [${scope}] ${path} — ${reason}`),
		];
	const temporal = available ? diagnostics.temporal : undefined;
	const temporalLines = temporal === undefined
		? [`Temporal materialization unavailable: ${conciseDiagnostic(diagnostics.durableStateError ?? "no selected branch runtime")}`,
			`Hot history: unavailable; configured maximum depth ${diagnostics.historyLimit}`]
		: [`Scope revisions: ${formatScopeRevisionVector(temporal.revisions)}`,
			`Runtime metadata: step #${snapshot.meta.step}${snapshot.meta.bootstrap ? "; bootstrap" : ""}`,
			`Hot history: offsets 0..${temporal.historyDepth}; maximum depth ${diagnostics.historyLimit}`];
	const artifacts = (scope: StateScope) => countArtifacts(diagnostics.scopeStates, scope);
	const hasArtifacts = available && (["global", "cwd", "session"] as const).some((scope) => artifacts(scope) > 0);

	return [
		`Repository: ${diagnostics.repositoryRoot}`,
		`Scope keys: CWD ${diagnostics.cwdScopeKey}; session ${diagnostics.sessionScopeKey}`,
		...temporalLines,
		...(diagnostics.publicationError === undefined ? [] : [`Memory writes paused after mode change: ${conciseDiagnostic(diagnostics.publicationError)}`]),
		...(hasArtifacts ? [`Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; pending invalidations ${invalidated}`] : []),
		...invalidationLines,
		...(available ? scopeMemoryLines(diagnostics.scopeStates) : []),
		...(stateJson === undefined
			? ["Effective memory: unavailable"]
			: ["Effective memory:", "", stateJson]),
	].join("\n");
}
