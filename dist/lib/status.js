import { conciseDiagnostic } from "./protocol.js";
import { overlayStates, projectSemanticState } from "./state.js";
export const STATUS_KEY = "state-flow";
export function formatScopeRevisionVector(revisions) {
    return `g${revisions.global}c${revisions.cwd}s${revisions.session}`;
}
export function compactStatus(snapshot, _revisions, colorize) {
    const { mode } = snapshot.config;
    if (mode === "off")
        return undefined;
    return `${colorize("accent", "state-flow")} ${colorize("dim", mode)}`;
}
function countArtifacts(states, scope) {
    return Object.keys(states[scope].artifacts).length;
}
export function detailedStatus(snapshot, diagnostics) {
    const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
    const materialized = !available ? undefined : diagnostics.effectiveState ?? projectSemanticState(overlayStates(diagnostics.scopeStates.global, diagnostics.scopeStates.cwd, diagnostics.scopeStates.session));
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
    const artifacts = (scope) => countArtifacts(diagnostics.scopeStates, scope);
    const hasArtifacts = available && ["global", "cwd", "session"].some((scope) => artifacts(scope) > 0);
    return [
        `Repository: ${diagnostics.repositoryRoot}`,
        `Scope keys: CWD ${diagnostics.cwdScopeKey}; session ${diagnostics.sessionScopeKey}`,
        ...temporalLines,
        ...(diagnostics.publicationError === undefined ? [] : [`Memory writes paused after mode change: ${conciseDiagnostic(diagnostics.publicationError)}`]),
        ...(hasArtifacts ? [`Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; pending invalidations ${invalidated}`] : []),
        ...invalidationLines,
        ...(stateJson === undefined
            ? ["Effective memory: unavailable"]
            : ["Effective memory:", "", stateJson]),
    ].join("\n");
}
