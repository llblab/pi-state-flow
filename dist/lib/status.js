import { projectRecentTransitionsWithLimit } from "./history.js";
import { retainedMemoryScopes } from "./memory.js";
import { conciseDiagnostic } from "./protocol.js";
import { overlayStates } from "./state.js";
export const STATUS_KEY = "state-flow";
export function formatScopeRevisionVector(revisions) {
    return `G${revisions.global}/C${revisions.cwd}/S${revisions.session}`;
}
export function compactStatus(snapshot, revisions, colorize) {
    if (!snapshot.config.enabled)
        return undefined;
    return `${colorize("accent", "state-flow")} ${colorize("dim", formatScopeRevisionVector(revisions))}`;
}
function countArtifacts(states, scope) {
    return Object.keys(states[scope].artifacts).length;
}
export function detailedStatus(snapshot, diagnostics) {
    const projectedRecent = projectRecentTransitionsWithLimit(diagnostics.historyLimit, diagnostics.recent);
    const available = diagnostics.temporal !== undefined && diagnostics.durableStateError === undefined;
    const materialized = !available ? undefined : overlayStates(diagnostics.scopeStates.global, diagnostics.scopeStates.cwd, diagnostics.scopeStates.session);
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
        ? [`Temporal materialization unavailable: ${conciseDiagnostic(diagnostics.durableStateError ?? "no selected branch runtime")}`,
            `Hot history: unavailable; configured maximum depth ${diagnostics.historyLimit}`,
            "Retained patch tails: unavailable"]
        : [`Temporal head: ${JSON.stringify(temporal.head.id)}; branch-local position ${temporal.head.position}`,
            `Scope revisions: global #${temporal.revisions.global}; CWD #${temporal.revisions.cwd}; session #${temporal.revisions.session}; effective ${formatScopeRevisionVector(temporal.revisions)}`,
            `Hot history: offsets 0..${temporal.historyDepth}; maximum depth ${diagnostics.historyLimit}`,
            `Retained patch tails: global ${temporal.tailCounts.global}; CWD ${temporal.tailCounts.cwd}; session ${temporal.tailCounts.session}`];
    const artifacts = (scope) => available ? countArtifacts(diagnostics.scopeStates, scope) : "unknown";
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
        ...(diagnostics.publicationError === undefined ? [] : [`Memory writes paused after Stop: ${conciseDiagnostic(diagnostics.publicationError)}`]),
        `Artifacts: global ${artifacts("global")}; CWD ${artifacts("cwd")}; session ${artifacts("session")}; pending invalidations ${invalidated}`,
        available ? `Recent transitions: global ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "global")).length}; CWD ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "cwd")).length}; session ${diagnostics.recent.filter(({ transitions }) => transitions.some(({ scope }) => scope === "session")).length}; active ${projectedRecent.length}` : "Recent transitions: unavailable",
        ...invalidationLines,
        ...(stateJson === undefined
            ? ["Effective memory: unavailable"]
            : [`Effective memory (${Buffer.byteLength(stateJson, "utf8")} JSON bytes; global → CWD → session overlay):`, "", stateJson]),
    ].join("\n");
}
