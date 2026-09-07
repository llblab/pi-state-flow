import type { ArtifactInvalidationReason } from "./artifact.ts";
import { projectRecentTransitionsWithLimit, type RecentTransitionWindow } from "./history.ts";
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

export interface PendingPublicationDiagnostic {
	commit: string;
	error: string;
}

export interface StatusDiagnostics {
	repositoryRoot: string;
	cwdScopeKey: string;
	sessionScopeKey: string;
	scopeStates: ScopedStates;
	recent: RecentTransitionWindow;
	temporal?: { head: TransitionBoundary; historyDepth: number; tailCounts: Record<StateScope, number> };
	staleArtifacts: readonly StaleArtifactDiagnostic[];
	artifactFreshnessError?: string;
	durableStateError?: string;
	pendingPublication?: PendingPublicationDiagnostic;
	retryQueued: boolean;
}

export function compactStatus(snapshot: Snapshot, colorize: Colorize): string | undefined {
	if (!snapshot.config.enabled) return undefined;
	return `${colorize("accent", "state-flow")} ${colorize("dim", `#${snapshot.meta.step}`)}`;
}

function countArtifacts(states: ScopedStates, scope: StateScope): number {
	return Object.keys(states[scope].artifacts).length;
}

function abbreviatedCommit(commit: string): string {
	return commit.length > 12 ? commit.slice(0, 12) : commit;
}

export function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string {
	const projectedRecent = projectRecentTransitionsWithLimit(
		snapshot.config.transitionWindow,
		diagnostics.recent,
	);
	const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
	const materialized = !available ? undefined : {
		global: diagnostics.scopeStates.global,
		cwd: diagnostics.scopeStates.cwd,
		session: diagnostics.scopeStates.session,
		effective: overlayStates(
			diagnostics.scopeStates.global,
			diagnostics.scopeStates.cwd,
			diagnostics.scopeStates.session,
		),
	};
	const stateJson = materialized === undefined ? undefined : JSON.stringify(materialized, null, 2);
	const freshnessError = diagnostics.artifactFreshnessError ?? (available ? undefined : "temporal global artifact registry is unavailable");
	const stale = freshnessError === undefined
		? String(diagnostics.staleArtifacts.length)
		: "unknown";
	const publication = diagnostics.pendingPublication === undefined
		? "idle"
		: `pending ${abbreviatedCommit(diagnostics.pendingPublication.commit)} — ${diagnostics.pendingPublication.error}`;
	const retry = diagnostics.retryQueued
		? `queued (attempt ${snapshot.meta.validation?.attempt ?? 0})`
		: "idle";
	const staleLines = freshnessError !== undefined
		? [`Artifact freshness unavailable: ${freshnessError}`]
		: diagnostics.staleArtifacts.length === 0
			? ["Stale artifacts: none"]
			: [
				"Stale artifacts:",
				...diagnostics.staleArtifacts.map(({ scope, path, reason }) => `- [${scope}] ${path} — ${reason}`),
			];
	const temporal = available ? diagnostics.temporal : undefined;
	const temporalLines = temporal === undefined
		? [`Temporal materialization unavailable: ${diagnostics.durableStateError ?? "no selected branch runtime"}`,
			"Hot history: unavailable; offsets beyond 7 require explicit cold Git inspection",
			"Retained patch tails: unavailable"]
		: [`Temporal head: ${JSON.stringify(temporal.head.id)}; branch-local position ${temporal.head.position}`,
			`Hot history: offsets 0..${temporal.historyDepth}; maximum depth 7`,
			`Retained patch tails: global ${temporal.tailCounts.global}; CWD ${temporal.tailCounts.cwd}; session ${temporal.tailCounts.session}`];
	const artifacts = (scope: StateScope) => available ? countArtifacts(diagnostics.scopeStates, scope) : "unknown";

	return [
		`State Flow diagnostics — config.enabled=${snapshot.config.enabled}; config.transitionWindow=${snapshot.config.transitionWindow}; branch mode=${snapshot.config.enabled ? "active" : "inactive"}`,
		`Repository: ${diagnostics.repositoryRoot}`,
		`Scope keys: CWD ${diagnostics.cwdScopeKey}; session ${diagnostics.sessionScopeKey}`,
		"Session files: config.json owns behavior; meta.json owns lineage and provenance",
		`Runtime metadata: step #${snapshot.meta.step}; active revision ${snapshot.meta.durableBase ?? "none"}; bootstrap ${snapshot.meta.bootstrap === true}; validation attempts ${snapshot.meta.validation?.attempt ?? 0}`,
		...temporalLines,
		`Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; stale ${stale}`,
		available ? `Recent transitions: global ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "global")).length}; CWD ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "cwd")).length}; session ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "session")).length}; active ${projectedRecent.length}` : "Recent transitions: unavailable",
		`Publication: ${publication}`,
		`Terminal retry: ${retry}`,
		...staleLines,
		...(stateJson === undefined
			? ["Materialized states: unavailable (global/CWD/session/effective)"]
			: [`Materialized states (${Buffer.byteLength(stateJson, "utf8")} bytes; global/CWD/session Git-backed, effective overlay):`, "", stateJson]),
	].join("\n");
}
