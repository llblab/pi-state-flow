import type { ArtifactInvalidationReason } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { ownedTopLevelKeys } from "./ownership.ts";
import { conciseDiagnostic } from "./protocol.ts";
import { isActiveRestorationBlocked, type Snapshot } from "./snapshot.ts";
import { assertScopeStateValues, overlayStates, projectSemanticState, type SemanticState, type ScopeStateValues, type StateScope } from "./state.ts";
import { applyPatch, isObject } from "./json.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";
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
	/** Omission retains all-three compatibility; a subset must be explicit, never inferred from missing data. */
	selection?: ScopeSelection;
	/** Captured policy may request Session while only shared owners are observable. Never a materialization grant. */
	requestedSelection?: ScopeSelection;
	scopeStates: ScopeStateValues;
	/** Legacy overlay override. Explicit selected observations derive only from scopeStates. */
	effectiveState?: SemanticState;
	recent: RecentTransitionWindow;
	historyLimit: number;
	temporal?: { head: TransitionBoundary; historyDepth: number; tailCounts: Partial<Record<StateScope, number>>; revisions: Partial<ScopeRevisions> };
	staleArtifacts: readonly StaleArtifactDiagnostic[];
	durableStateError?: string;
	publicationError?: string;
}

function assertScopeNumbers(values: Partial<ScopeRevisions>, selection: ScopeSelection, label: string): void {
	if (!isObject(values) || Object.keys(values).length !== selection.length
		|| Object.keys(values).some(scope => !selection.includes(scope as StateScope))
		|| selection.some(scope => !Object.hasOwn(values, scope))) throw new Error(`Invalid State Flow selected ${label}`);
	for (const scope of selection) if (!Number.isSafeInteger(values[scope]) || values[scope]! < 0) throw new Error(`Invalid State Flow selected ${label}`);
}

export function formatScopeRevisionVector(revisions: Partial<ScopeRevisions>, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): string {
	const selected = captureScopeSelection(selection);
	assertScopeNumbers(revisions, selected, "revision vector");
	const prefix = { global: "g", cwd: "c", session: "s" };
	return selected.map(scope => `${prefix[scope]}${revisions[scope]}`).join("");
}

export function compactStatus(snapshot: Snapshot, _revisions: Partial<ScopeRevisions>, colorize: Colorize): string | undefined {
	const { mode } = snapshot.config;
	if (mode === "off") return undefined;
	return `${colorize("accent", "state-flow")} ${colorize("dim", isActiveRestorationBlocked(snapshot) ? "active (blocked)" : mode)}`;
}

function countArtifacts(states: ScopeStateValues, scope: StateScope): number {
	return Object.keys(states[scope]!.artifacts ?? {}).length;
}

const STATUS_PLANES = ["intents", "strategy", "tactics", "artifacts", "response", "lazy"] as const;
const encoder = new TextEncoder();

function isPresentPlane(value: unknown): boolean {
	if (value === undefined || value === "") return false;
	return typeof value !== "object" || value === null || Object.keys(value).length > 0;
}

/** Operator-only footprint: serialized plane sizes and intent-owned share of top-level tactics/lazy entries. */
export function scopeMemoryLines(states: ScopeStateValues, selection: ScopeSelection = DEFAULT_SCOPE_SELECTION): string[] {
	const selected = captureScopeSelection(selection);
	assertScopeStateValues(states, selected);
	const lines: string[] = [];
	for (const scope of selected) {
		const state = states[scope] as SemanticState;
		const sizes = STATUS_PLANES.filter((plane) => isPresentPlane(state[plane]))
			.map((plane) => `${plane} ${encoder.encode(JSON.stringify(state[plane])).length} B`);
		if (sizes.length === 0) continue;
		const owned = ownedTopLevelKeys(scope, state);
		const shares = (["tactics", "lazy"] as const).flatMap((plane) => {
			const value = state[plane];
			const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
			return keys.length === 0 ? [] : [`${plane} ${keys.filter((key) => owned[plane].has(key)).length}/${keys.length}`];
		});
		lines.push(`- ${scope}: ${sizes.join(", ")}${shares.length ? `; intent-owned ${shares.join(", ")}` : ""}`);
	}
	return lines.length ? ["Scope memory:", ...lines] : [];
}

export function detailedStatus(snapshot: Snapshot, diagnostics: StatusDiagnostics): string {
	const selection = diagnostics.selection;
	const explicit = selection !== undefined;
	const selected = captureScopeSelection(explicit ? selection : DEFAULT_SCOPE_SELECTION);
	const requested = diagnostics.requestedSelection === undefined ? selected : captureScopeSelection(diagnostics.requestedSelection);
	const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
	if (available) {
		if (selected.some(scope => !requested.includes(scope))) throw new Error("State Flow materialization exceeds requested scopes");
		assertScopeStateValues(diagnostics.scopeStates, selected);
		assertScopeNumbers(diagnostics.temporal!.revisions, selected, "revision vector");
		assertScopeNumbers(diagnostics.temporal!.tailCounts, selected, "tail counts");
	}
	// A selected observation derives its overlay from exact owners, never a stale all-owner override.
	const materialized = !available ? undefined : explicit
		? selected.reduce<SemanticState>((state, scope) => applyPatch(state, projectSemanticState(diagnostics.scopeStates[scope]!)), {})
		: diagnostics.effectiveState ?? projectSemanticState(overlayStates(...selected.map(scope => diagnostics.scopeStates[scope]!)));
	// Only top-level plane boundaries gain whitespace; nested user JSON stays unchanged.
	const stateJson = materialized === undefined ? undefined : JSON.stringify(materialized, null, 2).replace(/,\n(?=  ")/g, ",\n\n");
	const stale = explicit ? !available ? [] : diagnostics.staleArtifacts.flatMap(notice => {
		const scope = notice.scope;
		return selected.includes(scope) ? [{ scope, path: notice.path, reason: notice.reason }] : [];
	}) : diagnostics.staleArtifacts;
	const invalidated = available ? String(stale.length) : "unavailable";
	const invalidationLines = stale.length === 0 ? []
		: ["Pending artifact invalidations:", ...stale.map(({ scope, path, reason }) => `- [${scope}] ${path} — ${reason}`)];
	const temporal = available ? diagnostics.temporal : undefined;
	const temporalLines = temporal === undefined
		? [`Temporal materialization unavailable: ${conciseDiagnostic(diagnostics.durableStateError ?? "no selected branch runtime")}`,
			`Hot history: unavailable; configured maximum depth ${diagnostics.historyLimit}`]
		: [`Scope revisions: ${formatScopeRevisionVector(temporal.revisions, selected)}`,
			`Runtime metadata: step #${snapshot.meta.step}${snapshot.meta.bootstrap ? "; bootstrap" : ""}`,
			`Hot history: offsets 0..${temporal.historyDepth}; maximum depth ${diagnostics.historyLimit}`];
	const artifacts = (scope: StateScope) => countArtifacts(diagnostics.scopeStates, scope);
	const hasArtifacts = available && selected.some((scope) => artifacts(scope) > 0);
	const scopeKeys = [
		...(selected.includes("cwd") ? [`CWD ${diagnostics.cwdScopeKey}`] : []),
		...(selected.includes("session") ? [`session ${diagnostics.sessionScopeKey}`] : []),
	];
	const artifactLabels = { global: "global", cwd: "CWD", session: "session" };

	return [
		`Mode: ${snapshot.config.mode}`,
		...(explicit ? [`Selected scopes: ${requested.join(", ")}`] : []),
		...(available && selected.length !== requested.length ? [`Materialized scopes: ${selected.join(", ")}`] : []),
		...(isActiveRestorationBlocked(snapshot) ? ["Inference blocked: Active memory restoration failed. Use /state-flow-active for current memory or select Passive/Off for native context."] : []),
		`Repository: ${diagnostics.repositoryRoot}`,
		...(scopeKeys.length ? [`Scope keys: ${scopeKeys.join("; ")}`] : []),
		...temporalLines,
		...(diagnostics.publicationError === undefined ? [] : [`Memory writes paused after mode change: ${conciseDiagnostic(diagnostics.publicationError)}`]),
		...(hasArtifacts ? [`Artifacts: ${selected.map(scope => `${artifactLabels[scope]} ${artifacts(scope)}`).join("; ")}; pending invalidations ${invalidated}`] : []),
		...invalidationLines,
		...(available ? scopeMemoryLines(diagnostics.scopeStates, selected) : []),
		...(stateJson === undefined
			? ["Effective memory: unavailable"]
			: ["Effective memory:", "", stateJson]),
	].join("\n");
}
