import type { ArtifactInvalidationReason } from "./artifact.ts";
import { projectRecentTransitionsWithLimit, type RecentTransitionWindow } from "./history.ts";
import { retainedMemoryScopes } from "./memory.ts";
import type { Snapshot } from "./snapshot.ts";
import { overlayStates, type ScopedStates, type StateScope } from "./state.ts";
import type { TransitionBoundary } from "./temporal.ts";

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
	recent: RecentTransitionWindow;
	historyLimit: number;
	temporal?: { head: TransitionBoundary; historyDepth: number; tailCounts: Record<StateScope, number> };
	staleArtifacts: readonly StaleArtifactDiagnostic[];
	durableStateError?: string;
}

export function compactStatus(snapshot: Snapshot, colorize: Colorize): string | undefined {
	if (!snapshot.config.enabled) return undefined;
	return `${colorize("accent", "state-flow")} ${colorize("dim", `#${snapshot.meta.step}`)}`;
}

function countArtifacts(states: ScopedStates, scope: StateScope): number {
	return Object.keys(states[scope].artifacts).length;
}

export function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string {
	const projectedRecent = projectRecentTransitionsWithLimit(
		diagnostics.historyLimit,
		diagnostics.recent,
	);
	const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
	const materialized = !available ? undefined : overlayStates(
		diagnostics.scopeStates.global,
		diagnostics.scopeStates.cwd,
		diagnostics.scopeStates.session,
	);
	const stateJson = materialized === undefined ? undefined : JSON.stringify(materialized, null, 2);
	const invalidated = available ? String(diagnostics.staleArtifacts.length) : "unavailable";
	const invalidationLines = diagnostics.staleArtifacts.length === 0
		? ["Pending artifact invalidations: none"]
		: [
			"Pending artifact invalidations:",
			...diagnostics.staleArtifacts.map(({ scope, path, reason }) => `- [${scope}] ${path} — ${reason}`),
		];
	const temporal = available ? diagnostics.temporal : undefined;
	const temporalLines = temporal === undefined
		? [`Temporal materialization unavailable: ${diagnostics.durableStateError ?? "no selected branch runtime"}`,
			`Hot history: unavailable; configured maximum depth ${diagnostics.historyLimit}`,
			"Retained patch tails: unavailable"]
		: [`Temporal head: ${JSON.stringify(temporal.head.id)}; branch-local position ${temporal.head.position}`,
			`Hot history: offsets 0..${temporal.historyDepth}; maximum depth ${diagnostics.historyLimit}`,
			`Retained patch tails: global ${temporal.tailCounts.global}; CWD ${temporal.tailCounts.cwd}; session ${temporal.tailCounts.session}`];
	const artifacts = (scope: StateScope) => available ? countArtifacts(diagnostics.scopeStates, scope) : "unknown";
	const memoryScopes = available ? retainedMemoryScopes(diagnostics.scopeStates) : undefined;

	return [
		`State Flow diagnostics — config.enabled=${snapshot.config.enabled}; branch mode=${snapshot.config.enabled ? "active" : "inactive"}`,
		`Repository: ${diagnostics.repositoryRoot}`,
		`Scope keys: CWD ${diagnostics.cwdScopeKey}; session ${diagnostics.sessionScopeKey}`,
		"Session files: config.json owns behavior; runtime.json owns branch recovery; meta.json owns scope provenance",
		`Runtime metadata: step #${snapshot.meta.step}; bootstrap ${snapshot.meta.bootstrap === true}`,
		"Memory: owner state-flow; global retention enabled; global fallback active",
		`Memory-bearing scopes: global ${memoryScopes?.global ?? "unknown"}; CWD ${memoryScopes?.cwd ?? "unknown"}; session ${memoryScopes?.session ?? "unknown"}`,
		...temporalLines,
		`Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; pending invalidations ${invalidated}`,
		available ? `Recent transitions: global ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "global")).length}; CWD ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "cwd")).length}; session ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "session")).length}; active ${projectedRecent.length}` : "Recent transitions: unavailable",
		...invalidationLines,
		...(stateJson === undefined
			? ["Effective memory: unavailable"]
			: [`Effective memory (${Buffer.byteLength(stateJson, "utf8")} JSON bytes; global → CWD → session overlay):`, "", stateJson]),
	].join("\n");
}
