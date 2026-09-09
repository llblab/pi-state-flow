import { RECENT_TRANSITION_LIMIT, validateRecentTransition, type RecentScopePatch } from "./history.ts";
import { applyPatch, containsNull, isJsonValue, isObject, sameJson, type JsonObject } from "./json.ts";
import { isMaterializedState, overlayStates, type MaterializedState, type ScopedStates, type StateScope } from "./state.ts";

/** Owns hot temporal algebra; excludes filesystem, Git, identity allocation, and Pi lifecycle. */
export interface TransitionBoundary {
	id: string;
	/** Branch-local order only. Identity and parent links distinguish forks at equal positions. */
	position: number;
	parent: string | null;
}

export interface ScopeCheckpoint {
	through: TransitionBoundary;
	state: MaterializedState;
}

export interface TemporalPatch {
	transition: TransitionBoundary;
	patch: RecentScopePatch["patch"];
}

export interface ScopeStream {
	checkpoint: ScopeCheckpoint;
	patches: TemporalPatch[];
}

export interface TemporalState {
	/** Oldest to newest, including the boundary immediately before the retained transitions. */
	lineage: TransitionBoundary[];
	scopes: Record<StateScope, ScopeStream>;
}

const SCOPES: StateScope[] = ["global", "cwd", "session"];

function validateBoundary(boundary: TransitionBoundary): void {
	if (!isObject(boundary) || Object.keys(boundary).sort().join(",") !== "id,parent,position"
		|| typeof boundary.id !== "string" || boundary.id.trim().length === 0
		|| !Number.isSafeInteger(boundary.position) || boundary.position < 0
		|| (boundary.parent !== null && (typeof boundary.parent !== "string" || boundary.parent.trim().length === 0))
		|| boundary.parent === boundary.id || (boundary.position === 0 && boundary.parent !== null)) {
		throw new Error("Invalid State Flow temporal boundary");
	}
}

function validateState(state: MaterializedState): void {
	if (!isJsonValue(state) || !isMaterializedState(state) || containsNull(state)) {
		throw new Error("Invalid temporal materialized semantic state");
	}
}

function apply(state: MaterializedState, patch: TemporalPatch["patch"]): MaterializedState {
	const next = applyPatch(state, patch as JsonObject) as MaterializedState;
	validateState(next);
	return next;
}

function sameBoundary(left: TransitionBoundary, right: TransitionBoundary): boolean {
	return left.id === right.id && left.position === right.position && left.parent === right.parent;
}

/** Replay validation is shared by disk codecs and active-lineage materialization. */
export function validateScopeStream(value: unknown, scope: StateScope): asserts value is ScopeStream {
	if (!SCOPES.includes(scope)) throw new Error("Unknown temporal scope");
	if (!isJsonValue(value) || !isObject(value) || Object.keys(value).sort().join(",") !== "checkpoint,patches"
		|| !isObject(value.checkpoint) || Object.keys(value.checkpoint).sort().join(",") !== "state,through"
		|| !Array.isArray(value.patches)) {
		throw new Error("Invalid temporal checkpoint/tail envelope");
	}
	const stream = value as unknown as ScopeStream;
	validateBoundary(stream.checkpoint.through);
	validateState(stream.checkpoint.state);
	if (stream.patches.length > RECENT_TRANSITION_LIMIT) throw new Error("Temporal scope tail exceeds seven patches");
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
		if (sameJson(next, state)) throw new Error("Temporal scope tail contains a semantic no-op");
		state = next;
		previous = record.transition;
		identities.add(previous.id);
	}
}

export function validateTemporalLineage(value: unknown): asserts value is TransitionBoundary[] {
	if (!isJsonValue(value) || !Array.isArray(value) || value.length === 0 || value.length > RECENT_TRANSITION_LIMIT + 1) {
		throw new Error("Temporal lineage must contain between one and eight boundaries");
	}
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const boundary = value[index] as unknown as TransitionBoundary;
		validateBoundary(boundary);
		if (seen.has(boundary.id)) throw new Error("Duplicate State Flow temporal boundary");
		seen.add(boundary.id);
		const previous = value[index - 1] as unknown as TransitionBoundary | undefined;
		if (previous && (boundary.position !== previous.position + 1 || boundary.parent !== previous.id)) {
			throw new Error("Disconnected State Flow temporal lineage");
		}
	}
}

/** Validate one revision-selected cohort. Its older ancestry must be bound by the durable loader. */
export function validateTemporalState(view: TemporalState): void {
	validateTemporalLineage(view.lineage);
	const oldest = view.lineage[0]!;
	const identities = new Map<string, TransitionBoundary>();
	const positions = new Map<number, TransitionBoundary>();
	const remember = (boundary: TransitionBoundary): void => {
		validateBoundary(boundary);
		const identity = identities.get(boundary.id);
		const position = boundary.position >= oldest.position ? positions.get(boundary.position) : undefined;
		if ((identity && !sameBoundary(identity, boundary)) || (position && !sameBoundary(position, boundary))) {
			throw new Error("Conflicting State Flow temporal lineage");
		}
		identities.set(boundary.id, boundary);
		if (boundary.position >= oldest.position) positions.set(boundary.position, boundary);
	};
	for (const boundary of view.lineage) remember(boundary);
	const head = view.lineage.at(-1)!;
	for (const scope of SCOPES) {
		const stream = view.scopes[scope];
		validateScopeStream(stream, scope);
		remember(stream.checkpoint.through);
		if (stream.checkpoint.through.position > oldest.position) {
			throw new Error("Scope checkpoint is newer than the guaranteed hot boundary");
		}
		for (const record of stream.patches) {
			remember(record.transition);
			if (record.transition.position > head.position) throw new Error("Temporal scope patch is beyond the active head");
		}
	}
	for (const boundary of identities.values()) {
		const previous = positions.get(boundary.position - 1);
		if (previous && boundary.parent !== previous.id) throw new Error("Disconnected State Flow temporal ancestry");
	}
	for (const boundary of view.lineage.slice(1)) {
		if (!SCOPES.some((scope) => view.scopes[scope].patches.some((record) => record.transition.id === boundary.id))) {
			throw new Error("Temporal boundary has no semantic patch");
		}
	}
}

/** Adopt revision-proven inherited streams without rewriting their checkpoints or tails. */
export function adoptTemporalStreams(scopes: Record<StateScope, ScopeStream>, id: string): TemporalState {
	const boundaries = Object.values(scopes).flatMap((stream) => [stream.checkpoint.through, ...stream.patches.map((record) => record.transition)]);
	const origin: TransitionBoundary = { id, position: Math.max(...boundaries.map((boundary) => boundary.position)) + 1, parent: null };
	const view = { lineage: [origin], scopes: structuredClone(scopes) };
	validateTemporalState(view);
	return view;
}

/** New or migrated state starts at a proven current boundary, with no invented past. */
export function createTemporalState(states: ScopedStates, id: string): TemporalState {
	const through: TransitionBoundary = { id, position: 0, parent: null };
	const stream = (scope: StateScope): ScopeStream => ({
		checkpoint: { through: structuredClone(through), state: structuredClone(states[scope]) },
		patches: [],
	});
	const view: TemporalState = { lineage: [through], scopes: { global: stream("global"), cwd: stream("cwd"), session: stream("session") } };
	validateTemporalState(view);
	return view;
}

function scopeAt(stream: ScopeStream, boundary: TransitionBoundary): MaterializedState {
	let state = structuredClone(stream.checkpoint.state);
	for (const record of stream.patches) {
		if (record.transition.position > boundary.position) break;
		state = apply(state, record.patch);
	}
	return state;
}

/** Lazy scope/effective read at one shared transition boundary, never by local patch count. */
export function readTemporalState(view: TemporalState, offset = 0, scope?: StateScope): MaterializedState {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > RECENT_TRANSITION_LIMIT) {
		throw new Error("State Flow hot-history offset must be an integer from 0 to 7");
	}
	if (scope !== undefined && !SCOPES.includes(scope)) throw new Error("Unknown temporal scope");
	validateTemporalState(view);
	const boundary = view.lineage[view.lineage.length - 1 - offset];
	if (!boundary) throw new Error("Requested history predates the proven temporal origin");
	if (scope !== undefined) return scopeAt(view.scopes[scope], boundary);
	return overlayStates(...SCOPES.map((owner) => scopeAt(view.scopes[owner], boundary)));
}

/** Allocate the identity outside this algebra; only materially effective patches accept it. */
export function advanceTemporalState(
	view: TemporalState,
	transitions: readonly RecentScopePatch[],
	id: string,
): TemporalState {
	validateTemporalState(view);
	if (transitions.length === 0) return view;
	validateRecentTransition({ id, at: 0, transitions });
	const head = view.lineage.at(-1)!;
	const changes = transitions.filter(({ scope, patch }) => {
		const current = scopeAt(view.scopes[scope], head);
		return !sameJson(current, apply(current, patch));
	});
	if (changes.length === 0) return view;
	const knownIds = new Set(view.lineage.map((boundary) => boundary.id));
	for (const scope of SCOPES) {
		knownIds.add(view.scopes[scope].checkpoint.through.id);
		for (const record of view.scopes[scope].patches) knownIds.add(record.transition.id);
	}
	if (knownIds.has(id)) throw new Error("State Flow transition identity has already been used");
	const boundary: TransitionBoundary = { id, position: head.position + 1, parent: head.id };
	validateBoundary(boundary);
	const next = structuredClone(view);
	for (const { scope, patch } of changes) {
		const stream = next.scopes[scope];
		if (stream.patches.length === RECENT_TRANSITION_LIMIT) {
			const folded = stream.patches.shift()!;
			stream.checkpoint = { through: folded.transition, state: apply(stream.checkpoint.state, folded.patch) };
		}
		stream.patches.push({ transition: structuredClone(boundary), patch: structuredClone(patch) });
	}
	next.lineage = [...next.lineage, boundary].slice(-(RECENT_TRANSITION_LIMIT + 1));
	validateTemporalState(next);
	return next;
}
