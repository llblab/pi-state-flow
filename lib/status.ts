import type { ArtifactInvalidationReason } from "./artifact.ts";
import { projectRecentTransitionsWithLimit, RECENT_TRANSITION_LIMIT, type RecentTransitionWindow } from "./history.ts";
import { inspectMemoryPromotions, retainedMemoryScopes } from "./memory.ts";
import type { PublicationQueueState } from "./publication.ts";
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
	publicationQueue?: PublicationQueueState;
	publicationQueueError?: string;
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
		RECENT_TRANSITION_LIMIT,
		diagnostics.recent,
	);
	const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
	const materialized = !available ? undefined : overlayStates(
		diagnostics.scopeStates.global,
		diagnostics.scopeStates.cwd,
		diagnostics.scopeStates.session,
	);
	const stateJson = materialized === undefined ? undefined : JSON.stringify(materialized, null, 2);
	const freshnessError = diagnostics.artifactFreshnessError ?? (available ? undefined : "temporal global artifact registry is unavailable");
	const stale = freshnessError === undefined
		? String(diagnostics.staleArtifacts.length)
		: "unknown";
	const publication = diagnostics.pendingPublication === undefined
		? "idle"
		: `pending ${abbreviatedCommit(diagnostics.pendingPublication.commit)} — ${diagnostics.pendingPublication.error}`;
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
	const promotions = available ? inspectMemoryPromotions(diagnostics.scopeStates.global) : [];
	const promotionCounts = Object.fromEntries(["pending", "accepted", "failed", "unknown", "invalid"].map((status) => [status, promotions.filter((entry) => entry.status === status).length]));
	const memoryScopes = available ? retainedMemoryScopes(diagnostics.scopeStates) : undefined;
	const oneLine = (value: string) => value.replace(/\s+/g, " ").slice(0, 240);
	const promotionLines = !available || promotions.length === 0 ? [] : [
		"Memory promotions:",
		...promotions.map((entry) => `- ${oneLine(entry.id)} — ${entry.status}; owner ${oneLine(entry.owner ?? "unavailable")}${entry.pointer ? `; pointer ${oneLine(entry.pointer)}` : ""}${entry.revision ? `; revision ${oneLine(entry.revision)}` : ""}${entry.error ? `; error ${oneLine(entry.error)}` : ""}`),
	];

	return [
		`State Flow diagnostics — config.enabled=${snapshot.config.enabled}; branch mode=${snapshot.config.enabled ? "active" : "inactive"}`,
		`Repository: ${diagnostics.repositoryRoot}`,
		`Scope keys: CWD ${diagnostics.cwdScopeKey}; session ${diagnostics.sessionScopeKey}`,
		"Session files: config.json owns behavior; meta.json owns lineage and provenance",
		`Runtime metadata: step #${snapshot.meta.step}; active revision ${snapshot.meta.durableBase ?? "none"}; bootstrap ${snapshot.meta.bootstrap === true}`,
		`Remote publication policy: ${snapshot.meta.remotePublication?.mode ?? "legacy-transition"}`,
		diagnostics.publicationQueueError !== undefined
			? `Remote queue: unavailable; error ${diagnostics.publicationQueueError}`
			: diagnostics.publicationQueue === undefined
			? "Remote queue: idle"
			: `Remote queue: ${diagnostics.publicationQueue.status}; target ${abbreviatedCommit(diagnostics.publicationQueue.target)}; confirmed ${diagnostics.publicationQueue.confirmed ? abbreviatedCommit(diagnostics.publicationQueue.confirmed) : "none"}; attempt ${diagnostics.publicationQueue.attempt}${diagnostics.publicationQueue.error ? `; error ${diagnostics.publicationQueue.error}` : ""}`,
		"Memory: owner state-flow; global retention enabled; global fallback active",
		`Memory-bearing scopes: global ${memoryScopes?.global ?? "unknown"}; CWD ${memoryScopes?.cwd ?? "unknown"}; session ${memoryScopes?.session ?? "unknown"}`,
		`Promotion status: pending ${promotionCounts.pending}; accepted ${promotionCounts.accepted}; failed ${promotionCounts.failed}; unknown ${promotionCounts.unknown}; invalid ${promotionCounts.invalid}`,
		...promotionLines,
		...temporalLines,
		`Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; stale ${stale}`,
		available ? `Recent transitions: global ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "global")).length}; CWD ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "cwd")).length}; session ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "session")).length}; active ${projectedRecent.length}` : "Recent transitions: unavailable",
		`Publication policy: ${snapshot.meta.remotePublication?.mode ?? "legacy-unresolved"}`,
		`Publication: ${publication}`,
		...staleLines,
		...(stateJson === undefined
			? ["Effective memory: unavailable"]
			: [`Effective memory (${Buffer.byteLength(stateJson, "utf8")} JSON bytes; global → CWD → session overlay):`, "", stateJson]),
	].join("\n");
}
