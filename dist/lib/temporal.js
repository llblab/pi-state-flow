import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, validateRecentTransition } from "./history.js";
import { applyPatch, containsNull, isJsonValue, isObject, sameJson } from "./json.js";
import { isMaterializedState, overlayStates } from "./state.js";
const SCOPES = ["global", "cwd", "session"];
function validateHistoryLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_HISTORY_LIMIT) {
        throw new Error(`State Flow history limit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
    }
}
function validateBoundary(boundary) {
    if (!isObject(boundary) || Object.keys(boundary).sort().join(",") !== "id,parent,position"
        || typeof boundary.id !== "string" || boundary.id.trim().length === 0
        || !Number.isSafeInteger(boundary.position) || boundary.position < 0
        || (boundary.parent !== null && (typeof boundary.parent !== "string" || boundary.parent.trim().length === 0))
        || boundary.parent === boundary.id || (boundary.position === 0 && boundary.parent !== null)) {
        throw new Error("Invalid State Flow temporal boundary");
    }
}
function validateState(state) {
    if (!isJsonValue(state) || !isMaterializedState(state) || containsNull(state)) {
        throw new Error("Invalid temporal materialized semantic state");
    }
}
function apply(state, patch) {
    const next = applyPatch(state, patch);
    validateState(next);
    return next;
}
function sameBoundary(left, right) {
    return left.id === right.id && left.position === right.position && left.parent === right.parent;
}
/** Replay validation is shared by disk codecs and active-lineage materialization. */
export function validateScopeStream(value, scope, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    if (!SCOPES.includes(scope))
        throw new Error("Unknown temporal scope");
    if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "checkpoint,patches,revision"
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !isObject(value.checkpoint) || Object.keys(value.checkpoint).sort().join(",") !== "state,through"
        || !Array.isArray(value.patches)) {
        throw new Error("Invalid temporal checkpoint/tail envelope");
    }
    const stream = value;
    validateBoundary(stream.checkpoint.through);
    validateState(stream.checkpoint.state);
    if (stream.patches.length > historyLimit)
        throw new Error(`Temporal scope tail exceeds configured history limit ${historyLimit}`);
    if (stream.revision < stream.patches.length)
        throw new Error("Temporal scope revision predates its retained patch tail");
    let previous = stream.checkpoint.through;
    let state = stream.checkpoint.state;
    const identities = new Set([previous.id]);
    for (const record of stream.patches) {
        if (!isObject(record) || Object.keys(record).sort().join(",") !== "patch,transition") {
            throw new Error("Invalid temporal patch envelope");
        }
        validateBoundary(record.transition);
        if (record.transition.position <= previous.position || identities.has(record.transition.id)) {
            throw new Error("Temporal scope tail is not ordered after its checkpoint");
        }
        if (record.transition.position === previous.position + 1 && record.transition.parent !== previous.id) {
            throw new Error("Disconnected State Flow temporal ancestry");
        }
        validateRecentTransition({ id: record.transition.id, at: 0, transitions: [{ scope, patch: record.patch }] });
        const next = apply(state, record.patch);
        if (sameJson(next, state))
            throw new Error("Temporal scope tail contains a semantic no-op");
        state = next;
        previous = record.transition;
        identities.add(previous.id);
    }
}
export function validateTemporalLineage(value, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    if (!isJsonValue(value) || !Array.isArray(value) || value.length === 0 || value.length > historyLimit + 1) {
        throw new Error(`Temporal lineage must contain between one and ${historyLimit + 1} boundaries`);
    }
    const seen = new Set();
    for (let index = 0; index < value.length; index++) {
        const boundary = value[index];
        validateBoundary(boundary);
        if (seen.has(boundary.id))
            throw new Error("Duplicate State Flow temporal boundary");
        seen.add(boundary.id);
        const previous = value[index - 1];
        if (previous && (boundary.position !== previous.position + 1 || boundary.parent !== previous.id)) {
            throw new Error("Disconnected State Flow temporal lineage");
        }
    }
}
/** Bind one owned stream to its runtime lineage without requiring patches from unrelated scopes. */
export function validateScopeLineage(stream, scope, lineage, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateTemporalLineage(lineage, historyLimit);
    validateScopeStream(stream, scope, historyLimit);
    const oldest = lineage[0];
    const head = lineage.at(-1);
    if (stream.checkpoint.through.position > oldest.position)
        throw new Error("Scope checkpoint is newer than the guaranteed hot boundary");
    const identities = new Map(lineage.map((boundary) => [boundary.id, boundary]));
    for (const boundary of [stream.checkpoint.through, ...stream.patches.map((record) => record.transition)]) {
        if (boundary.position > head.position)
            throw new Error("Temporal scope patch is beyond the active head");
        const identity = identities.get(boundary.id);
        const position = lineage[boundary.position - oldest.position];
        if ((identity && !sameBoundary(identity, boundary)) || (position && !sameBoundary(position, boundary))) {
            throw new Error("Conflicting State Flow temporal lineage");
        }
    }
}
/** Validate one revision-selected cohort. Its older ancestry must be bound by the durable loader. */
export function validateTemporalState(view, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    validateTemporalLineage(view.lineage, historyLimit);
    const oldest = view.lineage[0];
    const identities = new Map();
    const positions = new Map();
    const remember = (boundary) => {
        validateBoundary(boundary);
        const identity = identities.get(boundary.id);
        const position = boundary.position >= oldest.position ? positions.get(boundary.position) : undefined;
        if ((identity && !sameBoundary(identity, boundary)) || (position && !sameBoundary(position, boundary))) {
            throw new Error("Conflicting State Flow temporal lineage");
        }
        identities.set(boundary.id, boundary);
        if (boundary.position >= oldest.position)
            positions.set(boundary.position, boundary);
    };
    for (const boundary of view.lineage)
        remember(boundary);
    const head = view.lineage.at(-1);
    for (const scope of SCOPES) {
        const stream = view.scopes[scope];
        validateScopeStream(stream, scope, historyLimit);
        remember(stream.checkpoint.through);
        if (stream.checkpoint.through.position > oldest.position) {
            throw new Error("Scope checkpoint is newer than the guaranteed hot boundary");
        }
        for (const record of stream.patches) {
            remember(record.transition);
            if (record.transition.position > head.position)
                throw new Error("Temporal scope patch is beyond the active head");
        }
    }
    for (const boundary of identities.values()) {
        const previous = positions.get(boundary.position - 1);
        if (previous && boundary.parent !== previous.id)
            throw new Error("Disconnected State Flow temporal ancestry");
    }
    for (const boundary of view.lineage.slice(1)) {
        if (!SCOPES.some((scope) => view.scopes[scope].patches.some((record) => record.transition.id === boundary.id))) {
            throw new Error("Temporal boundary has no semantic patch");
        }
    }
}
/** Adopt revision-proven inherited streams without rewriting their checkpoints or tails. */
export function adoptTemporalStreams(scopes, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const boundaries = Object.values(scopes).flatMap((stream) => [stream.checkpoint.through, ...stream.patches.map((record) => record.transition)]);
    const origin = { id, position: Math.max(...boundaries.map((boundary) => boundary.position)) + 1, parent: null };
    const view = { lineage: [origin], scopes: structuredClone(scopes) };
    return constrainTemporalState(view, historyLimit);
}
/** New or migrated state starts at a proven current boundary, with no invented past. */
export function createTemporalState(states, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const through = { id, position: 0, parent: null };
    const stream = (scope) => ({
        revision: 0,
        checkpoint: { through: structuredClone(through), state: structuredClone(states[scope]) },
        patches: [],
    });
    const view = { lineage: [through], scopes: { global: stream("global"), cwd: stream("cwd"), session: stream("session") } };
    validateTemporalState(view, historyLimit);
    return view;
}
function scopeAt(stream, boundary) {
    let state = structuredClone(stream.checkpoint.state);
    for (const record of stream.patches) {
        if (record.transition.position > boundary.position)
            break;
        state = apply(state, record.patch);
    }
    return state;
}
/** Fold retained tails to a lower configured limit without inventing history. */
export function constrainTemporalState(view, historyLimit) {
    validateHistoryLimit(historyLimit);
    validateTemporalState(view, MAX_HISTORY_LIMIT);
    const next = structuredClone(view);
    for (const scope of SCOPES) {
        const stream = next.scopes[scope];
        while (stream.patches.length > historyLimit) {
            const folded = stream.patches.shift();
            stream.checkpoint = { through: folded.transition, state: apply(stream.checkpoint.state, folded.patch) };
        }
    }
    next.lineage = next.lineage.slice(-(historyLimit + 1));
    validateTemporalState(next, historyLimit);
    return next;
}
/** Select one scope at a proven retained boundary from its owning runtime lineage. */
export function selectScopeStreamAtBoundary(stream, scope, boundary, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    validateBoundary(boundary);
    validateScopeStream(stream, scope, historyLimit);
    if (boundary.position < stream.checkpoint.through.position) {
        throw new Error("Selected State Flow history boundary predates the retained scope checkpoint");
    }
    const selected = structuredClone(stream);
    const retained = selected.patches.filter(({ transition }) => transition.position <= boundary.position);
    selected.revision -= selected.patches.length - retained.length;
    selected.patches = retained;
    validateScopeStream(selected, scope, historyLimit);
    return selected;
}
/** Select one still-retained causal boundary without consulting an external history store. */
export function selectTemporalStateBoundary(view, boundaryId, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    validateTemporalState(view, historyLimit);
    if (typeof boundaryId !== "string" || boundaryId.trim().length === 0)
        throw new Error("State Flow temporal boundary identity must be non-empty");
    const index = view.lineage.findIndex(({ id }) => id === boundaryId);
    if (index < 0)
        throw new Error("Selected State Flow history boundary is outside the retained temporal window");
    const target = view.lineage[index];
    const selected = structuredClone(view);
    selected.lineage = selected.lineage.slice(0, index + 1);
    for (const scope of SCOPES) {
        const stream = selected.scopes[scope];
        const retained = stream.patches.filter(({ transition }) => transition.position <= target.position);
        stream.revision -= stream.patches.length - retained.length;
        stream.patches = retained;
    }
    validateTemporalState(selected, historyLimit);
    return selected;
}
/** Current independent scope revisions; Effective uses this vector rather than inventing a scalar owner. */
export function temporalScopeRevisions(view) {
    const revisions = {
        global: view.scopes.global.revision,
        cwd: view.scopes.cwd.revision,
        session: view.scopes.session.revision,
    };
    if (Object.values(revisions).some((revision) => !Number.isSafeInteger(revision) || revision < 0)) {
        throw new Error("Invalid State Flow scope revision vector");
    }
    return revisions;
}
/** Lazy scope/effective read at one shared transition boundary, never by local patch count. */
export function readTemporalState(view, offset = 0, scope, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > historyLimit) {
        throw new Error(`State Flow hot-history offset must be an integer from 0 to ${historyLimit}`);
    }
    if (scope !== undefined && !SCOPES.includes(scope))
        throw new Error("Unknown temporal scope");
    validateTemporalState(view, historyLimit);
    const boundary = view.lineage[view.lineage.length - 1 - offset];
    if (!boundary)
        throw new Error("Requested history predates the proven temporal origin");
    if (scope !== undefined)
        return scopeAt(view.scopes[scope], boundary);
    return overlayStates(...SCOPES.map((owner) => scopeAt(view.scopes[owner], boundary)));
}
/** Allocate the identity outside this algebra; only materially effective patches accept it. */
export function advanceTemporalState(view, transitions, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    validateTemporalState(view, historyLimit);
    if (transitions.length === 0)
        return view;
    validateRecentTransition({ id, at: 0, transitions });
    const head = view.lineage.at(-1);
    const changes = transitions.filter(({ scope, patch }) => {
        const current = scopeAt(view.scopes[scope], head);
        return !sameJson(current, apply(current, patch));
    });
    if (changes.length === 0)
        return view;
    const knownIds = new Set(view.lineage.map((boundary) => boundary.id));
    for (const scope of SCOPES) {
        knownIds.add(view.scopes[scope].checkpoint.through.id);
        for (const record of view.scopes[scope].patches)
            knownIds.add(record.transition.id);
    }
    if (knownIds.has(id))
        throw new Error("State Flow transition identity has already been used");
    const boundary = { id, position: head.position + 1, parent: head.id };
    validateBoundary(boundary);
    const next = structuredClone(view);
    for (const { scope, patch } of changes) {
        const stream = next.scopes[scope];
        if (stream.revision >= Number.MAX_SAFE_INTEGER)
            throw new Error(`State Flow ${scope} scope revision is exhausted`);
        stream.revision += 1;
        if (historyLimit === 0) {
            stream.checkpoint = { through: structuredClone(boundary), state: apply(scopeAt(stream, head), patch) };
            stream.patches = [];
            continue;
        }
        while (stream.patches.length >= historyLimit) {
            const folded = stream.patches.shift();
            stream.checkpoint = { through: folded.transition, state: apply(stream.checkpoint.state, folded.patch) };
        }
        stream.patches.push({ transition: structuredClone(boundary), patch: structuredClone(patch) });
    }
    next.lineage = [...next.lineage, boundary].slice(-(historyLimit + 1));
    validateTemporalState(next, historyLimit);
    return next;
}
