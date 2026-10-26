import { captureScopeSelection } from "./selection.js";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, validateRecentTransition } from "./history.js";
import { applyPatch, containsNull, isJsonValue, isObject, sameJson } from "./json.js";
import { validateRetainedModules } from "./semantic-module.js";
import { validateExternalPlanes, emptyState, isSemanticState, overlayStates, projectSemanticState } from "./state.js";
const SCOPES = ["global", "cwd", "session"];
function selected(view) {
    return Object.hasOwn(view, "selection");
}
function owners(view) {
    return selected(view) ? view.selection : SCOPES;
}
function matchesOwnerKeys(value, selection) {
    return isObject(value) && Object.keys(value).sort().join(",") === [...selection].sort().join(",");
}
function streamFor(view, scope) {
    const stream = view.scopes[scope];
    if (!stream)
        throw new Error(`State Flow ${scope} scope is excluded or unavailable`);
    return stream;
}
function validateCohort(view, historyLimit) {
    if (selected(view))
        validateSelectedTemporalState(view, historyLimit);
    else
        validateTemporalState(view, historyLimit);
}
function cloneCohort(view) {
    const next = structuredClone(view);
    if (selected(next))
        next.selection = captureScopeSelection(next.selection);
    return next;
}
function trimCausalBasis(view) {
    if (!selected(view))
        return;
    const retained = new Set(view.lineage.slice(1).map((boundary) => boundary.id));
    view.causalBasis = view.causalBasis.filter((witness) => retained.has(witness.transition.id));
    for (const witness of view.causalBasis)
        witness.owners = captureScopeSelection(witness.owners);
}
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
function validateState(state, location, modules) {
    if (modules !== undefined)
        validateExternalPlanes(state, modules);
    const json = isJsonValue(state);
    const hasNull = json && isObject(state) && [...Object.keys(emptyState()), ...Object.keys(modules ?? {})].some((key) => containsNull(state[key]));
    if (json && isSemanticState(state) && !hasNull)
        return;
    const reason = !json ? "expected finite, acyclic JSON data"
        : !isObject(state) ? "expected a semantic object"
            : hasNull ? "null is not allowed"
                : "invalid semantic fields or artifact metadata";
    throw new Error(`Invalid temporal materialized semantic state${location ? ` in ${location}` : ""}: ${reason}`);
}
function apply(state, patch, location, modules) {
    if (modules !== undefined)
        validateExternalPlanes(patch, modules, true);
    const next = applyPatch(state, patch);
    validateState(next, location, modules);
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
    if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== (Object.hasOwn(value, "modules") ? "checkpoint,modules,patches,revision" : "checkpoint,patches,revision")
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !isObject(value.checkpoint) || Object.keys(value.checkpoint).sort().join(",") !== "state,through"
        || !Array.isArray(value.patches)) {
        throw new Error("Invalid temporal checkpoint/tail envelope");
    }
    const stream = value;
    validateBoundary(stream.checkpoint.through);
    if (Object.hasOwn(stream, "modules"))
        validateRetainedModules(stream.modules);
    validateState(stream.checkpoint.state, `${scope} checkpoint`, stream.modules);
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
        const next = apply(state, record.patch, `${scope} tail`, stream.modules);
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
    const mismatch = scopeLineageMismatch(stream, lineage);
    if (mismatch)
        throw new Error(mismatch);
}
/** Classify live shared drift only after both stream and lineage have passed their own validators. */
export function scopeLineageMatches(stream, scope, lineage, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateTemporalLineage(lineage, historyLimit);
    validateScopeStream(stream, scope, historyLimit);
    return scopeLineageMismatch(stream, lineage) === undefined;
}
function scopeLineageMismatch(stream, lineage) {
    const oldest = lineage[0];
    const head = lineage.at(-1);
    if (stream.checkpoint.through.position > oldest.position)
        return "Scope checkpoint is newer than the guaranteed hot boundary";
    const identities = new Map(lineage.map((boundary) => [boundary.id, boundary]));
    for (const boundary of [stream.checkpoint.through, ...stream.patches.map((record) => record.transition)]) {
        if (boundary.position > head.position)
            return "Temporal scope patch is beyond the active head";
        const identity = identities.get(boundary.id);
        const position = lineage[boundary.position - oldest.position];
        if ((identity && !sameBoundary(identity, boundary)) || (position && !sameBoundary(position, boundary))) {
            return "Conflicting State Flow temporal lineage";
        }
    }
    return undefined;
}
/** Validate one revision-selected cohort. Its older ancestry must be bound by the durable loader. */
export function validateTemporalState(view, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (Object.hasOwn(view, "selection") || Object.hasOwn(view, "causalBasis"))
        throw new Error("Selected temporal state requires selected-cohort admission");
    validateTemporalCohort(view, SCOPES, historyLimit);
}
/** Structural consistency only: storage must additionally bind witnesses to accepted source authority. */
export function validateSelectedTemporalState(view, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (!isObject(view) || Object.keys(view).sort().join(",") !== "causalBasis,lineage,scopes,selection"
        || !isObject(view.scopes) || !Array.isArray(view.causalBasis))
        throw new Error("Invalid selected temporal envelope");
    const selection = captureScopeSelection(view.selection);
    if (!sameJson(selection, view.selection) || Object.keys(view.scopes).sort().join(",") !== [...selection].sort().join(",")) {
        throw new Error("Selected temporal owners must match the canonical selection exactly");
    }
    validateTemporalLineage(view.lineage, historyLimit);
    const boundaries = new Map(view.lineage.slice(1).map((boundary) => [boundary.id, boundary]));
    const witnessed = new Set();
    let position = view.lineage[0].position;
    for (const witness of view.causalBasis) {
        if (!isObject(witness) || Object.keys(witness).sort().join(",") !== "owners,transition")
            throw new Error("Invalid excluded temporal witness");
        validateBoundary(witness.transition);
        const identity = boundaries.get(witness.transition.id);
        const sourceOwners = captureScopeSelection(witness.owners);
        if (!sameJson(sourceOwners, witness.owners) || sourceOwners.some((scope) => selection.includes(scope))
            || !identity || !sameBoundary(identity, witness.transition) || witness.transition.position <= position
            || witnessed.has(identity.id))
            throw new Error("Invalid excluded temporal witness basis");
        witnessed.add(identity.id);
        position = witness.transition.position;
    }
    validateTemporalCohort(view, selection, historyLimit, witnessed);
    if (view.causalBasis.some((witness) => selection.some((scope) => streamFor(view, scope).patches.some((record) => record.transition.id === witness.transition.id)))) {
        throw new Error("Excluded temporal witness duplicates a selected patch");
    }
}
function validateTemporalCohort(view, activeOwners, historyLimit, witnessed = new Set()) {
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
    for (const scope of activeOwners) {
        const stream = streamFor(view, scope);
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
        if (!activeOwners.some((scope) => streamFor(view, scope).patches.some((record) => record.transition.id === boundary.id)) && !witnessed.has(boundary.id)) {
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
/** Restrict a validated value cohort; expanding selection requires separately acquired current streams. */
export function selectTemporalState(source, selection, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateCohort(source, historyLimit);
    const wanted = captureScopeSelection(selection);
    if (wanted.some((scope) => !owners(source).includes(scope)))
        throw new Error("Cannot select an unacquired temporal owner");
    const inherited = new Map(selected(source) ? source.causalBasis.map((witness) => [witness.transition.id, witness]) : []);
    const causalBasis = [];
    for (const boundary of source.lineage.slice(1)) {
        const live = owners(source).filter((scope) => streamFor(source, scope).patches.some((record) => record.transition.id === boundary.id));
        if (live.some((scope) => wanted.includes(scope)))
            continue;
        const evidence = [...new Set([...live, ...(inherited.get(boundary.id)?.owners ?? [])])];
        causalBasis.push({ transition: structuredClone(boundary), owners: captureScopeSelection(evidence) });
    }
    const view = {
        selection: wanted, lineage: structuredClone(source.lineage),
        scopes: Object.fromEntries(wanted.map((scope) => [scope, structuredClone(streamFor(source, scope))])), causalBasis,
    };
    validateSelectedTemporalState(view, historyLimit);
    return view;
}
/** Complete retained witness skeleton, derived from validated semantic records/basis, never from lineage alone. */
export function temporalCausalWitnesses(view, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateCohort(view, historyLimit);
    const inherited = new Map(selected(view) ? view.causalBasis.map((witness) => [witness.transition.id, witness]) : []);
    return view.lineage.slice(1).map((transition) => {
        const live = owners(view).filter((scope) => streamFor(view, scope).patches.some((record) => record.transition.id === transition.id));
        return { transition: structuredClone(transition), owners: captureScopeSelection([...new Set([...live, ...(inherited.get(transition.id)?.owners ?? [])])]) };
    });
}
/** Metadata syntax only; a skeleton is neither semantic replay nor acquisition/publication authority. */
export function captureTemporalWitnesses(lineage, witnesses, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateTemporalLineage(lineage, historyLimit);
    if (!Array.isArray(witnesses))
        throw new Error("Invalid accepted temporal witness array");
    const boundaries = new Map(lineage.slice(1).map((boundary) => [boundary.id, boundary]));
    const admitted = [];
    let position = lineage[0].position;
    for (const witness of witnesses) {
        if (!isObject(witness) || Object.keys(witness).sort().join(",") !== "owners,transition")
            throw new Error("Invalid accepted temporal witness");
        const transition = witness.transition;
        validateBoundary(transition);
        const identity = boundaries.get(transition.id);
        const sourceOwners = captureScopeSelection(witness.owners);
        if (!identity || !sameBoundary(identity, transition) || transition.position <= position || !sameJson(sourceOwners, witness.owners)) {
            throw new Error("Accepted temporal witness does not match its lineage");
        }
        admitted.push({ transition: structuredClone(transition), owners: sourceOwners });
        position = transition.position;
    }
    return admitted;
}
/** Reconstruct selected values from caller-bound accepted evidence; this validates syntax/consistency, not physical authority. */
export function restoreSelectedTemporalState(scopes, selection, lineage, witnesses, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const wanted = captureScopeSelection(selection);
    if (!matchesOwnerKeys(scopes, wanted))
        throw new Error("Selected temporal streams must match their owners exactly");
    validateTemporalLineage(lineage, historyLimit);
    for (const scope of wanted)
        validateScopeLineage(scopes[scope], scope, lineage, historyLimit);
    const skeleton = captureTemporalWitnesses(lineage, witnesses, historyLimit);
    const admitted = new Map(skeleton.map((witness) => [witness.transition.id, witness]));
    for (const witness of skeleton)
        for (const scope of witness.owners.filter((owner) => wanted.includes(owner))) {
            if (!scopes[scope].patches.some((record) => sameBoundary(record.transition, witness.transition)))
                throw new Error("Accepted temporal witness is missing its selected owner patch");
        }
    const causalBasis = [];
    for (const transition of lineage.slice(1)) {
        if (wanted.some((scope) => scopes[scope].patches.some((record) => record.transition.id === transition.id)))
            continue;
        const witness = admitted.get(transition.id);
        if (!witness)
            throw new Error("Temporal boundary has no accepted owner witness");
        causalBasis.push(witness);
    }
    const view = { selection: wanted, lineage: structuredClone([...lineage]), scopes: structuredClone(scopes), causalBasis };
    validateSelectedTemporalState(view, historyLimit);
    return view;
}
/** Explicit selected values at a new origin; this constructor grants no initialization/acquisition permission. */
export function createSelectedTemporalState(states, selection, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const wanted = captureScopeSelection(selection);
    if (!matchesOwnerKeys(states, wanted))
        throw new Error("Selected temporal values must match their owners exactly");
    const through = { id, position: 0, parent: null };
    const view = {
        selection: wanted, lineage: [through], causalBasis: [],
        scopes: Object.fromEntries(wanted.map((scope) => [scope, { revision: 0, checkpoint: { through: structuredClone(through), state: structuredClone(states[scope]) }, patches: [] }])),
    };
    validateSelectedTemporalState(view, historyLimit);
    return view;
}
/** Adopt explicitly admitted selected streams at current values only, without invented aligned history. */
export function adoptSelectedTemporalStreams(scopes, selection, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const wanted = captureScopeSelection(selection);
    if (!matchesOwnerKeys(scopes, wanted))
        throw new Error("Selected temporal streams must match their owners exactly");
    for (const scope of wanted)
        validateScopeStream(scopes[scope], scope, MAX_HISTORY_LIMIT);
    const boundaries = wanted.flatMap((scope) => [scopes[scope].checkpoint.through, ...scopes[scope].patches.map((record) => record.transition)]);
    const origin = { id, position: Math.max(...boundaries.map((boundary) => boundary.position)) + 1, parent: null };
    const view = { selection: wanted, lineage: [origin], scopes: structuredClone(scopes), causalBasis: [] };
    return constrainTemporalState(view, historyLimit);
}
function scopeAt(stream, boundary) {
    let state = structuredClone(stream.checkpoint.state);
    for (const record of stream.patches) {
        if (record.transition.position > boundary.position)
            break;
        state = apply(state, record.patch, undefined, stream.modules);
    }
    return state;
}
/** Fold retained tails to a lower configured limit without inventing history. */
export function constrainTemporalState(view, historyLimit) {
    validateHistoryLimit(historyLimit);
    validateCohort(view, MAX_HISTORY_LIMIT);
    const next = cloneCohort(view);
    for (const scope of owners(next)) {
        const stream = streamFor(next, scope);
        while (stream.patches.length > historyLimit) {
            const folded = stream.patches.shift();
            stream.checkpoint = { through: folded.transition, state: apply(stream.checkpoint.state, folded.patch, undefined, stream.modules) };
        }
    }
    next.lineage = next.lineage.slice(-(historyLimit + 1));
    trimCausalBasis(next);
    validateCohort(next, historyLimit);
    return next;
}
export function temporalScopeRevisions(view) {
    if (selected(view))
        validateSelectedTemporalState(view, MAX_HISTORY_LIMIT);
    const revisions = Object.fromEntries(owners(view).map((scope) => [scope, streamFor(view, scope).revision]));
    if (Object.values(revisions).some((revision) => !Number.isSafeInteger(revision) || revision < 0)) {
        throw new Error("Invalid State Flow scope revision vector");
    }
    return revisions;
}
function readBoundary(view, offset, historyLimit) {
    validateHistoryLimit(historyLimit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > historyLimit) {
        throw new Error(`State Flow hot-history offset must be an integer from 0 to ${historyLimit}`);
    }
    validateCohort(view, historyLimit);
    const boundary = view.lineage[view.lineage.length - 1 - offset];
    if (!boundary)
        throw new Error("Requested history predates the proven temporal origin");
    return boundary;
}
export function readTemporalScopes(view, offset = 0, historyLimit = DEFAULT_HISTORY_LIMIT) {
    const boundary = readBoundary(view, offset, historyLimit);
    return Object.fromEntries(owners(view).map((scope) => [scope, scopeAt(streamFor(view, scope), boundary)]));
}
/** Sparse current/historical view: unknown planes and absent values never become effective data. */
export function readTemporalView(view, offset = 0, scope, historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (scope !== undefined && !SCOPES.includes(scope))
        throw new Error("Unknown temporal scope");
    if (scope !== undefined && !owners(view).includes(scope))
        throw new Error(`State Flow ${scope} scope is excluded`);
    const boundary = readBoundary(view, offset, historyLimit);
    const active = scope === undefined ? owners(view) : [scope];
    return active.reduce((state, owner) => {
        const stream = streamFor(view, owner), raw = scopeAt(stream, boundary);
        const projected = projectSemanticState(raw, stream.modules);
        return applyPatch(state, projected);
    }, {});
}
/** Internal defaulted materialization for consumers that require object registries. */
export function readTemporalState(view, offset = 0, scope, historyLimit = DEFAULT_HISTORY_LIMIT) {
    return overlayStates(readTemporalView(view, offset, scope, historyLimit));
}
/** Allocate the identity outside this algebra; only materially effective patches accept it. */
export function advanceTemporalState(view, transitions, id, historyLimit = DEFAULT_HISTORY_LIMIT) {
    validateHistoryLimit(historyLimit);
    validateCohort(view, historyLimit);
    if (transitions.length === 0)
        return view;
    validateRecentTransition({ id, at: 0, transitions });
    if (transitions.some(({ scope }) => !owners(view).includes(scope)))
        throw new Error("State Flow patch contains an excluded temporal owner");
    const head = view.lineage.at(-1);
    const changes = transitions.filter(({ scope, patch }) => {
        const current = scopeAt(streamFor(view, scope), head);
        return !sameJson(current, apply(current, patch, undefined, streamFor(view, scope).modules));
    });
    if (changes.length === 0)
        return view;
    const knownIds = new Set(view.lineage.map((boundary) => boundary.id));
    for (const scope of owners(view)) {
        knownIds.add(streamFor(view, scope).checkpoint.through.id);
        for (const record of streamFor(view, scope).patches)
            knownIds.add(record.transition.id);
    }
    if (knownIds.has(id))
        throw new Error("State Flow transition identity has already been used");
    const boundary = { id, position: head.position + 1, parent: head.id };
    validateBoundary(boundary);
    const next = cloneCohort(view);
    for (const { scope, patch } of changes) {
        const stream = streamFor(next, scope);
        if (stream.revision >= Number.MAX_SAFE_INTEGER)
            throw new Error(`State Flow ${scope} scope revision is exhausted`);
        stream.revision += 1;
        if (historyLimit === 0) {
            stream.checkpoint = { through: structuredClone(boundary), state: apply(scopeAt(stream, head), patch, undefined, stream.modules) };
            stream.patches = [];
            continue;
        }
        while (stream.patches.length >= historyLimit) {
            const folded = stream.patches.shift();
            stream.checkpoint = { through: folded.transition, state: apply(stream.checkpoint.state, folded.patch, undefined, stream.modules) };
        }
        stream.patches.push({ transition: structuredClone(boundary), patch: structuredClone(patch) });
    }
    next.lineage = [...next.lineage, boundary].slice(-(historyLimit + 1));
    trimCausalBasis(next);
    validateCohort(next, historyLimit);
    return next;
}
