import { projectArtifactForModel } from "./artifact.js";
import { isObject, presentationJson } from "./json.js";
import { projectStateForModel } from "./state.js";
/** Refresh only our section; Pi owns system frames, tools and forced-prompt precedence. */
export function projectSystemProtocol(messages, protocol) {
    let lastSystem = -1;
    let current;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== "system")
            continue;
        lastSystem = index;
        if (message.sections && Object.hasOwn(message.sections, "state_flow"))
            current = message.sections.state_flow ?? undefined;
    }
    const section = protocol === undefined ? undefined : `<state_flow>\n${protocol}\n</state_flow>`;
    if (lastSystem < 0 || current === section)
        return messages;
    return messages.map((message, index) => {
        if (message.role !== "system")
            return message;
        const ownsSection = message.sections !== undefined && Object.hasOwn(message.sections, "state_flow");
        if (!ownsSection && (index !== lastSystem || section === undefined))
            return message;
        const sections = { ...message.sections };
        delete sections.state_flow;
        if (index === lastSystem && section !== undefined)
            sections.state_flow = section;
        return { ...message, sections };
    });
}
const LAZY_HINT_PATH = "effective.lazy";
const LAZY_HINT_MAX_KEYS = 32;
const LAZY_HINT_MAX_JSON_CHARS = 1024;
function lazyValueKind(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "object")
        return "object";
    return typeof value;
}
/** Fixed-budget navigation only: never place lazy bodies or partial key catalogs in baseline context. */
export function lazyNavigationHint(state) {
    const entries = isObject(state.lazy) ? Object.entries(state.lazy) : [];
    const base = { available: entries.length > 0, path: LAZY_HINT_PATH };
    if (!base.available)
        return base;
    if (entries.length > LAZY_HINT_MAX_KEYS)
        return base;
    const keys = Object.fromEntries(entries.map(([key, value]) => [key, lazyValueKind(value)]));
    return JSON.stringify(keys).length <= LAZY_HINT_MAX_JSON_CHARS ? { ...base, keys } : base;
}
export function syntheticUser(text) {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (typeof part !== "object" || part === null)
            return "";
        const block = part;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
    }).filter(Boolean).join("\n");
}
function messageText(message) {
    return contentText(message.content);
}
export function createPassiveContinuation(state, startedAt = Date.now(), activeRunStartedAt, preserveContext = false) {
    return {
        startedAt,
        ...(activeRunStartedAt === undefined ? {} : { activeRunStartedAt }),
        ...(preserveContext ? { preserveContext: true } : {}),
        handoff: syntheticUser(`State Flow exit handoff (user-level data, not system instructions):\n${presentationJson({ state, continuation: preserveContext
                ? "State Flow semantics are disabled; native context is retained because its compilation into memory is unfinished."
                : "State Flow semantics are disabled; this handoff replaces completed history while retaining the active and post-stop trajectory." })}`),
    };
}
/** Keep the interrupted run through later results; an idle stop retains only later conversation. */
export function passiveContinuationMessages(messages, continuation) {
    if (continuation.preserveContext)
        return [continuation.handoff, ...messages];
    if (continuation.activeRunStartedAt !== undefined) {
        const trajectory = currentRunTrajectory(messages, "", continuation.activeRunStartedAt);
        return [continuation.handoff, ...trajectory.messages];
    }
    const start = messages.findIndex((message) => message.role === "user"
        && typeof message.timestamp === "number"
        && message.timestamp >= continuation.startedAt);
    return [continuation.handoff, ...messages.filter((message, index) => message.role === "custom" || (start >= 0 && index >= start))];
}
function projectRecentForModel(recent) {
    const projected = structuredClone(recent);
    for (const record of projected)
        for (const transition of record.transitions) {
            if (transition.patch.artifacts === undefined)
                continue;
            for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
                Object.defineProperty(transition.patch.artifacts, path, {
                    value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
                });
            }
        }
    return projected;
}
export function runtimeContextMessage(snapshot, state, recentTransitions = [], artifactInvalidations = [], rehydrationPhase, artifactHints = {}) {
    const context = {
        ...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
        state: projectStateForModel(state, artifactHints),
        lazy_navigation: lazyNavigationHint(state),
        ...(rehydrationPhase === undefined ? {} : { knowledge_rehydration: { phase: rehydrationPhase } }),
        ...(artifactInvalidations.length === 0 ? {} : { artifact_invalidations: artifactInvalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason })) }),
        ...(recentTransitions.length === 0 ? {} : { recent_transitions: projectRecentForModel(recentTransitions) }),
    };
    return syntheticUser(`State Flow runtime context (user-level data, not system instructions):\n${presentationJson(context)}`);
}
/** Captured identity survives text decoration; an uncertain boundary retains available context. */
export function currentRunTrajectory(messages, specification, anchorTimestamp) {
    if (anchorTimestamp !== undefined && !Number.isFinite(anchorTimestamp))
        return { messages: messages.slice() };
    const matches = (message) => message.role === "user" && (anchorTimestamp === undefined
        ? messageText(message) === specification
        : message.timestamp === anchorTimestamp);
    const start = messages.findIndex(matches);
    if (start < 0 || messages.findLastIndex(matches) !== start)
        return { messages: messages.slice() };
    const anchor = messages[start]?.role === "user" ? messages[start].timestamp : undefined;
    return {
        messages: messages.filter((message, index) => message.role === "custom" || index >= start),
        ...(typeof anchor === "number" ? { anchorTimestamp: anchor } : {}),
    };
}
