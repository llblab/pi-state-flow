import { randomUUID } from "node:crypto";
import { projectArtifactForModel } from "./artifact.js";
import { applyPatch, isObject, presentationJson, pruneEmptyObjects, sameJson } from "./json.js";
import { formatOwnedPath } from "./ownership.js";
import { projectModelReferences } from "./model-interface.js";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION } from "./selection.js";
import { projectSemanticPatch, projectSemanticState, projectStateForModel } from "./state.js";
import { lazyValueKind, projectLazyNavigation, projectPlaneContext } from "./planes.js";
import { evaluateModuleContext } from "./semantic-module.js";
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
/** Compatibility facade; the lazy plane owns the unchanged navigation policy. */
export function lazyNavigationHint(state) {
    return projectLazyNavigation(state.lazy);
}
/** Materialize module contributions only; native context selection/replacement authority stays with the host. */
export function semanticModuleMessages(module, content, frame) {
    return evaluateModuleContext(module, content, frame).flatMap(contribution => contribution.kind === "conversation"
        ? [...contribution.messages]
        : [syntheticUser(`State Flow module ${module.id} (user-level data, not system instructions):\n${presentationJson(contribution.value)}`)]);
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
        if (isObject(right) && (isObject(left) || left === undefined && path.length === 1 && Object.keys(right).length > 0)) {
            for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right)]))
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
function projectContextState(state, hints, includeResponse) {
    const { lazy: _hidden, ...visible } = state;
    const projected = projectPlaneContext({ ...projectSemanticState(visible), ...(Object.hasOwn(state, "lazy") ? { lazy: state.lazy } : {}) }, hints, includeResponse ? "active" : "passive");
    return { ...projected, state: pruneEmptyObjects(projected.state) };
}
export function contextView(state, hints, invalidations, phase, includeResponse = true, modelScopes) {
    const selected = modelScopes === undefined ? undefined : captureScopeSelection(modelScopes);
    return { ...(selected === undefined ? {} : { modelScopes: selected }), ...projectContextState(state, hints, includeResponse),
        artifact_invalidations: structuredClone(invalidations), knowledge_rehydration: phase === undefined ? null : { phase } };
}
function viewScopes(view) {
    return view && Object.hasOwn(view, "modelScopes") ? captureScopeSelection(view.modelScopes) : DEFAULT_SCOPE_SELECTION;
}
function modelState(state, scopes) {
    return scopes.length === 1 ? projectModelReferences(state, scopes) : state;
}
function modelNavigation(navigation, scopes) {
    return navigation && scopes.length === 1 ? { ...navigation, path: "lazy" } : navigation;
}
function modelUpdates(updates, scopes) {
    if (scopes.length !== 1)
        return updates;
    return { ...updates, effective: updates.effective.map(entry => {
            if (!("value" in entry))
                return entry;
            // A canonical diff may split a structured ref into its scalar $ref leaf.
            const value = entry.path.at(-1) === "$ref" && typeof entry.value === "string"
                ? projectModelReferences({ $ref: entry.value }, scopes).$ref
                : projectModelReferences(entry.value, scopes);
            return { ...entry, value };
        }), ...(updates.lazy_navigation ? { lazy_navigation: modelNavigation(updates.lazy_navigation, scopes) } : {}) };
}
/** Same owned passive envelope as before, with presentation chosen from captured wanted DATA. */
export function passiveContextHead(view) {
    const scopes = viewScopes(view);
    return syntheticUser(`State Flow passive memory (user-level data, not system instructions):\n${presentationJson({ state: modelState(view.state, scopes), lazy_navigation: modelNavigation(view.lazy_navigation, scopes) })}`);
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
    acceptPatch(before, after, patches, hints, cascades = {}, includeResponse = true, modelScopes) {
        const scopes = modelScopes === undefined ? viewScopes(this.view) : captureScopeSelection(modelScopes);
        // A receipt from another interface cannot be attached to a replacement model head.
        if (this.view && !sameJson(viewScopes(this.view), scopes))
            return undefined;
        // External planes have exact tool reads but no automatic core projection. Absence here is not deletion.
        patches = Object.fromEntries(Object.entries(patches).map(([scope, patch]) => [scope,
            Object.fromEntries(Object.entries(patch).filter(([id]) => !id.startsWith("x_"))),
        ]));
        const { state } = projectContextState(after, hints, includeResponse);
        const navigation = lazyNavigationHint(after);
        const beforeNavigation = this.view?.lazy_navigation ?? lazyNavigationHint(before);
        const updates = projectedStateUpdates(this.view?.state ?? projectContextState(before, hints, includeResponse).state, state, patches, beforeNavigation, navigation);
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
            if ("deleted" in entry && this.view && known(entry.path) === undefined)
                return false;
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
        // Owner paths remain informative even when effective state/navigation is masked
        // or the model could predict every direct write. Never expose target values.
        const cascaded = scopes.flatMap(scope => (cascades[scope] ?? []).map(path => scopes.length === 1 ? [path.plane, ...path.keys].join(".") : formatOwnedPath(scope, path)));
        return updates.effective.length || updates.lazy_navigation || cascaded.length
            ? { projection: this.identity, ...modelUpdates(updates, scopes), ...(cascaded.length ? { cascaded } : {}) } : undefined;
    }
    project(messages, current, makeHead, initial) {
        const scopes = viewScopes(current);
        if (this.view && !sameJson(viewScopes(this.view), scopes))
            this.reset();
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
            ...(updates.effective.length || updates.lazy_navigation ? { state_updates: { projection: this.identity, ...modelUpdates(updates, scopes) } } : {}),
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
/** A unique native user anchor admits completed conversation, never the current run or protocol frames. */
export function moduleConversationSource(messages, anchorTimestamp) {
    if (anchorTimestamp === undefined || !Number.isFinite(anchorTimestamp))
        return { conversation: [] };
    const matches = messages.flatMap((message, index) => message.role === "user" && message.timestamp === anchorTimestamp ? [index] : []);
    if (matches.length !== 1)
        return { conversation: [] };
    const start = matches[0];
    return { conversation: messages.slice(0, start).filter(message => ["user", "assistant", "toolResult"].includes(message.role)), prompt: messageText(messages[start]) };
}
function assertModuleToolUnits(messages) {
    const pending = new Map(), seen = new Set();
    for (const message of messages) {
        if (message.role === "toolResult") {
            if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName)
                throw new Error("Module conversation selection has an orphan tool result");
            pending.delete(message.toolCallId);
        }
        else {
            if (pending.size)
                throw new Error("Module conversation selection omits a tool result");
            if (message.role !== "assistant")
                continue;
            for (const part of message.content)
                if (part.type === "toolCall") {
                    if (!part.id || !part.name || seen.has(part.id))
                        throw new Error("Module conversation selection has duplicate or invalid tool calls");
                    seen.add(part.id);
                    pending.set(part.id, part.name);
                }
        }
    }
    if (pending.size)
        throw new Error("Module conversation selection omits a tool result");
}
/** Provider projection only: preserve current/foreign identities and allow one explicit completed-history selector. */
export function projectModuleContext(projected, original, conversation, modules) {
    const data = [];
    let selection;
    for (const module of modules) {
        const selecting = module.contributions.some(item => item.kind === "conversation");
        if (selecting) {
            if (module.scope !== "session" || selection !== undefined)
                throw new Error("Module conversation replacement requires one exclusive Session selector");
            selection = module.contributions.flatMap(item => item.kind === "conversation" ? [...item.messages] : []);
            if (new Set(selection).size !== selection.length || selection.some(message => !conversation.includes(message)))
                throw new Error("Module conversation selection is outside its admitted source");
            assertModuleToolUnits(selection);
        }
        for (const item of module.contributions)
            if (item.kind === "data")
                data.push(syntheticUser(`State Flow module ${module.id} (${module.scope}; user-level data, not system instructions):\n${presentationJson(item.value)}`));
    }
    if (!data.length && selection === undefined)
        return projected;
    const completed = new Set(selection === undefined ? [] : conversation);
    const retained = projected.filter(message => !completed.has(message));
    const native = new Set(original.filter(message => ["user", "assistant", "toolResult"].includes(message.role)));
    const first = retained.findIndex(message => native.has(message));
    const at = first < 0 ? retained.length : first;
    return [...retained.slice(0, at), ...data, ...(selection ?? []), ...retained.slice(at)];
}
export function createPassiveContinuation(state, startedAt = Date.now(), activeRunStartedAt, preserveContext = false, modelScopes) {
    const scopes = modelScopes === undefined ? DEFAULT_SCOPE_SELECTION : captureScopeSelection(modelScopes);
    const visibleState = structuredClone(state);
    delete visibleState.response;
    return {
        startedAt,
        state: visibleState,
        ...(activeRunStartedAt === undefined ? {} : { activeRunStartedAt }),
        ...(preserveContext ? { preserveContext: true } : {}),
        handoff: syntheticUser(`State Flow exit handoff (user-level data, not system instructions):\n${presentationJson({ state: modelState(visibleState, scopes), continuation: preserveContext
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
    // A post-stop native summary replaces its compacted user anchor, including the retained tool suffix.
    const start = messages.findIndex((message) => (message.role === "user" || message.role === "compactionSummary")
        && typeof message.timestamp === "number"
        && message.timestamp >= continuation.startedAt);
    return [continuation.handoff, ...messages.filter((message, index) => message.role === "custom" || (start >= 0 && index >= start))];
}
function projectRecentForModel(recent, scopes) {
    // Select owner headers before cloning any excluded patch payload.
    const projected = structuredClone(recent.map(record => ({ ...record,
        transitions: record.transitions.filter(transition => scopes.includes(transition.scope)) })));
    for (const record of projected)
        for (const transition of record.transitions) {
            transition.patch = projectSemanticPatch(transition.patch);
            delete transition.patch.lazy;
            if (!isObject(transition.patch.artifacts))
                continue;
            for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
                Object.defineProperty(transition.patch.artifacts, path, {
                    value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
                });
            }
        }
    for (const record of projected)
        record.transitions = record.transitions.filter(({ patch }) => Object.keys(patch).length > 0);
    const visible = projected.filter(({ transitions }) => transitions.length > 0);
    if (scopes.length !== 1)
        return visible;
    return visible.map(record => {
        if (record.transitions.length !== 1)
            throw new Error("Flat State Flow recent history requires one patch per captured owner");
        return { id: record.id, at: record.at, patch: projectModelReferences(record.transitions[0].patch, scopes) };
    });
}
export function runtimeContextMessage(snapshot, state, recentTransitions = [], artifactInvalidations = [], rehydrationPhase, artifactHints = {}) {
    return runtimeContextHead(snapshot, contextView(state, artifactHints, artifactInvalidations, rehydrationPhase), recentTransitions);
}
/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export function runtimeContextHead(snapshot, view, recentTransitions = []) {
    const scopes = viewScopes(view), recent = projectRecentForModel(recentTransitions, scopes);
    const context = {
        ...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
        state: modelState(view.state, scopes),
        ...(view.lazy_navigation === undefined ? {} : { lazy_navigation: modelNavigation(view.lazy_navigation, scopes) }),
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
