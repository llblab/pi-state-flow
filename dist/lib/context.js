import { randomUUID } from "node:crypto";
import { projectArtifactForModel } from "./artifact.js";
import { applyPatch, isObject, presentationJson, sameJson } from "./json.js";
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
/** Exact projected replacements, not authored merge patches; paths are unambiguous key/index segments. */
export function acceptedStateUpdates(before, after, patches) {
    return projectedStateUpdates(projectStateForModel(before), projectStateForModel(after), patches, lazyNavigationHint(before), lazyNavigationHint(after));
}
function projectedStateUpdates(previous, current, patches, beforeNavigation, navigation) {
    const effective = [];
    const prefix = (parent, child) => parent.length <= child.length && parent.every((part, index) => part === child[index]);
    const put = (path, value) => {
        if (effective.some((entry) => prefix(entry.path, path)))
            return;
        for (let index = effective.length - 1; index >= 0; index--) {
            if (prefix(path, effective[index].path))
                effective.splice(index, 1);
        }
        effective.push({ path, ...(value === undefined ? { deleted: true } : { value: structuredClone(value) }) });
    };
    const child = (value, key) => value !== null && typeof value === "object" && Object.hasOwn(value, key)
        ? value[key] : undefined;
    const diff = (left, right, path) => {
        if (left === undefined && right === undefined || left !== undefined && right !== undefined && sameJson(left, right))
            return;
        if (isObject(left) && isObject(right)) {
            for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
                diff(child(left, key), child(right, key), [...path, key]);
        }
        else if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
            for (let index = 0; index < right.length; index++)
                diff(left[index], right[index], [...path, index]);
        }
        else
            put(path, right);
    };
    const touched = (patch, value, path) => {
        if (!isObject(patch)) {
            put(path, value);
            return;
        }
        const keys = Object.keys(patch);
        if (keys.length === 0)
            return;
        if (Array.isArray(value) && keys.every((key) => /^\[(0|[1-9]\d*)\]$/.test(key))) {
            for (const key of keys) {
                const index = Number(key.slice(1, -1));
                // A higher-scope array may mask the patched array with a different length.
                if (index >= value.length) {
                    put(path, value);
                    return;
                }
                touched(patch[key], value[index], [...path, index]);
            }
        }
        else if (isObject(value)) {
            for (const key of keys)
                touched(patch[key], child(value, key), [...path, key]);
        }
        else
            put(path, value);
    };
    diff(previous, current, []);
    for (const patch of Object.values(patches))
        for (const [plane, value] of Object.entries(patch)) {
            if (plane === "lazy")
                continue;
            if (plane === "artifacts" && isObject(value)) {
                for (const path of Object.keys(value))
                    put([plane, path], child(current.artifacts, path));
            }
            else
                touched(value, child(current, plane), [plane]);
        }
    return { effective, ...(navigation !== undefined && (beforeNavigation === undefined || !sameJson(beforeNavigation, navigation)) ? { lazy_navigation: navigation } : {}) };
}
export function contextView(state, hints, invalidations, phase) {
    return { state: projectStateForModel(state, hints), lazy_navigation: lazyNavigationHint(state),
        artifact_invalidations: structuredClone(invalidations), knowledge_rehydration: phase === undefined ? null : { phase } };
}
/** Volatile model projection only. Native messages own trajectory; this cache owns no persistence or lifecycle. */
export class ContextProjection {
    identity = randomUUID();
    head;
    view;
    native = [];
    notices = [];
    reset() {
        this.identity = randomUUID();
        this.head = undefined;
        this.view = undefined;
        this.native = [];
        this.notices = [];
    }
    /** Called only after successful publication and ancillary acceptance, immediately before returning the native result. */
    acceptPatch(before, after, patches, hints) {
        const state = projectStateForModel(after, hints);
        const navigation = lazyNavigationHint(after);
        const beforeNavigation = this.view?.lazy_navigation ?? lazyNavigationHint(before);
        const updates = projectedStateUpdates(this.view?.state ?? projectStateForModel(before, hints), state, patches, beforeNavigation, navigation);
        // Suppress direct writes only when the accepted effective value matches.
        // Overlap stays conservative except for explicit top-scope replacements:
        // Session scalars/arrays mask every lower-scope value at that path.
        const leaves = [];
        const objects = [];
        const known = (path) => {
            let value = this.view?.state;
            for (const part of path) {
                if (value === undefined || value === null || typeof value !== "object" || !Object.hasOwn(value, part))
                    return undefined;
                value = value[part];
            }
            return value;
        };
        const visit = (scope, value, path) => {
            if (isObject(value) && Object.keys(value).length > 0) {
                // Diff may coalesce a newly created/replaced object at this path.
                // Keep its authored value without widening the overlap frontier.
                objects.push({ scope, path, value });
                const basis = known(path);
                const entries = Object.entries(value);
                const indexed = Array.isArray(basis) && entries.every(([key]) => {
                    if (!/^\[(0|[1-9]\d*)\]$/.test(key))
                        return false;
                    const index = Number(key.slice(1, -1));
                    return Number.isSafeInteger(index) && index < basis.length;
                });
                for (const [key, child] of entries)
                    visit(scope, child, [...path, indexed ? Number(key.slice(1, -1)) : key]);
            }
            else
                leaves.push({ scope, path, value });
        };
        for (const scope of ["global", "cwd", "session"])
            for (const [plane, value] of Object.entries(patches[scope] ?? {})) {
                if (plane === "lazy")
                    continue;
                if (plane === "artifacts" && isObject(value)) {
                    for (const [path, card] of Object.entries(value))
                        leaves.push({ scope, path: ["artifacts", path], value: card, artifact: true });
                }
                else
                    visit(scope, value, [plane]);
            }
        const prefix = (a, b) => a.length <= b.length && a.every((part, index) => part === b[index]);
        updates.effective = updates.effective.filter((entry) => {
            const matches = ({ path }) => path.length === entry.path.length && prefix(path, entry.path);
            const authored = leaves.findLast(matches) ?? objects.findLast(matches);
            if (!authored)
                return true;
            const sessionReplacement = authored.scope === "session" && authored.value !== null && !isObject(authored.value);
            if (!sessionReplacement && leaves.some(({ scope, path }) => scope !== authored.scope && (prefix(path, authored.path) || prefix(authored.path, path))))
                return true;
            if (authored.value !== null) {
                if (authored.artifact) {
                    // Projected authored fields merge into the communicated card. Hints
                    // are not authored; keeping one is predictable, changing it is not.
                    const prior = known(entry.path);
                    const card = projectArtifactForModel(authored.value);
                    if (!isObject(card))
                        return true;
                    let expected = card;
                    if (isObject(prior)) {
                        try {
                            expected = applyPatch(prior, card);
                        }
                        catch {
                            // Canonical acceptance already succeeded. A masked effective
                            // array may reject an index valid in the authored scope.
                            return true;
                        }
                    }
                    return !("value" in entry && sameJson(entry.value, expected));
                }
                return !("value" in entry && sameJson(entry.value, authored.value));
            }
            // A deletion cannot predict a fallback from effective state alone. It
            // needs no echo only when the communicated and accepted values coincide.
            if (!this.view)
                return true;
            const before = known(entry.path);
            return "value" in entry ? before === undefined || !sameJson(before, entry.value) : before !== undefined;
        });
        // A complete communicated key/kind catalog can predict non-deleting
        // top-level lazy writes. Missing/over-budget catalogs, deletions and
        // overlapping scopes cannot prove the post-patch navigation summary.
        if (updates.lazy_navigation && this.view && (beforeNavigation.keys || !beforeNavigation.available) && navigation.keys) {
            const expected = new Map(Object.entries(beforeNavigation.keys ?? {}));
            let predictable = true;
            const seen = new Set();
            for (const scope of ["global", "cwd", "session"])
                for (const [key, value] of Object.entries(patches[scope]?.lazy ?? {})) {
                    if (seen.has(key) || value === null || isObject(value) && expected.get(key) === "array")
                        predictable = false;
                    seen.add(key);
                    if (value !== null)
                        expected.set(key, lazyValueKind(value));
                }
            if (predictable && seen.size > 0 && sameJson(Object.fromEntries(expected), navigation.keys))
                delete updates.lazy_navigation;
        }
        if (this.view)
            this.view = { ...this.view, state, lazy_navigation: navigation };
        return updates.effective.length || updates.lazy_navigation ? { projection: this.identity, ...updates } : undefined;
    }
    project(messages, current, makeHead, initial) {
        const identities = messages.map((message) => JSON.stringify([message.role, message.timestamp,
            "toolCallId" in message ? message.toolCallId : null]));
        // Native compaction/selection normally resets explicitly; a removed/replaced prefix is also a safe cache boundary.
        if (this.native.some((identity, index) => identities[index] !== identity))
            this.reset();
        if (!this.head) {
            const head = makeHead();
            if (head.role !== "user" || !Array.isArray(head.content))
                throw new Error("State Flow projection requires an owned user head");
            this.head = { ...head, content: [...head.content, { type: "text", text: `State Flow projection: ${this.identity}` }] };
            this.view = structuredClone(initial ?? current);
        }
        const previous = this.view;
        const updates = projectedStateUpdates(previous.state, current.state, {}, previous.lazy_navigation, current.lazy_navigation);
        const notice = {
            ...(updates.effective.length || updates.lazy_navigation ? { state_updates: { projection: this.identity, ...updates } } : {}),
            ...(!sameJson(previous.artifact_invalidations, current.artifact_invalidations) ? { artifact_invalidations: current.artifact_invalidations } : {}),
            ...(!sameJson(previous.knowledge_rehydration, current.knowledge_rehydration) ? { knowledge_rehydration: current.knowledge_rehydration } : {}),
        };
        if (Object.keys(notice).length)
            this.notices.push({ after: messages.length,
                message: syntheticUser(`State Flow context update (user-level data, not system instructions):\n${presentationJson(notice)}`) });
        this.view = structuredClone(current);
        this.native = identities;
        const projected = [this.head];
        let nextNotice = 0;
        for (let index = 0; index <= messages.length; index++) {
            while (this.notices[nextNotice]?.after === index)
                projected.push(this.notices[nextNotice++].message);
            if (index < messages.length)
                projected.push(messages[index]);
        }
        return projected;
    }
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
        state: structuredClone(state),
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
            delete transition.patch.lazy;
            if (transition.patch.artifacts === undefined)
                continue;
            for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
                Object.defineProperty(transition.patch.artifacts, path, {
                    value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
                });
            }
        }
    for (const record of projected)
        record.transitions = record.transitions.filter(({ patch }) => Object.keys(patch).length > 0);
    return projected.filter(({ transitions }) => transitions.length > 0);
}
export function runtimeContextMessage(snapshot, state, recentTransitions = [], artifactInvalidations = [], rehydrationPhase, artifactHints = {}) {
    return runtimeContextHead(snapshot, contextView(state, artifactHints, artifactInvalidations, rehydrationPhase), recentTransitions);
}
/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export function runtimeContextHead(snapshot, view, recentTransitions = []) {
    const recent = projectRecentForModel(recentTransitions);
    const context = {
        ...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
        state: view.state,
        ...(view.lazy_navigation === undefined ? {} : { lazy_navigation: view.lazy_navigation }),
        ...(view.knowledge_rehydration === null ? {} : { knowledge_rehydration: view.knowledge_rehydration }),
        ...(view.artifact_invalidations.length === 0 ? {} : { artifact_invalidations: view.artifact_invalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason })) }),
        ...(recent.length === 0 ? {} : { recent_transitions: recent }),
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
