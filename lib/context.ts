import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectArtifactForModel, type ArtifactInvalidationNotice, type ArtifactModelHints } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { applyPatch, isObject, presentationJson, sameJson, type JsonValue } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { projectStateForModel, type AtomicScopePatches, type MaterializedState, type ModelState, type StateScope } from "./state.ts";

/** Refresh only our section; Pi owns system frames, tools and forced-prompt precedence. */
export function projectSystemProtocol(messages: AgentMessage[], protocol: string | undefined): AgentMessage[] {
	let lastSystem = -1;
	let current: string | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "system") continue;
		lastSystem = index;
		if (message.sections && Object.hasOwn(message.sections, "state_flow")) current = message.sections.state_flow ?? undefined;
	}
	const section = protocol === undefined ? undefined : `<state_flow>\n${protocol}\n</state_flow>`;
	if (lastSystem < 0 || current === section) return messages;
	return messages.map((message, index) => {
		if (message.role !== "system") return message;
		const ownsSection = message.sections !== undefined && Object.hasOwn(message.sections, "state_flow");
		if (!ownsSection && (index !== lastSystem || section === undefined)) return message;
		const sections = { ...message.sections };
		delete sections.state_flow;
		if (index === lastSystem && section !== undefined) sections.state_flow = section;
		return { ...message, sections };
	});
}

const LAZY_HINT_PATH = "effective.lazy";
const LAZY_HINT_MAX_KEYS = 32;
const LAZY_HINT_MAX_JSON_CHARS = 1024;

type LazyValueKind = "array" | "boolean" | "null" | "number" | "object" | "string";

function lazyValueKind(value: JsonValue): LazyValueKind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	return typeof value as Exclude<LazyValueKind, "array" | "object">;
}

/** Fixed-budget navigation only: never place lazy bodies or partial key catalogs in baseline context. */
export function lazyNavigationHint(state: MaterializedState): { available: boolean; path: string; keys?: Record<string, LazyValueKind> } {
	const entries = isObject(state.lazy) ? Object.entries(state.lazy) : [];
	const base = { available: entries.length > 0, path: LAZY_HINT_PATH };
	if (!base.available) return base;
	if (entries.length > LAZY_HINT_MAX_KEYS) return base;
	const keys = Object.fromEntries(entries.map(([key, value]) => [key, lazyValueKind(value)]));
	return JSON.stringify(keys).length <= LAZY_HINT_MAX_JSON_CHARS ? { ...base, keys } : base;
}


export type ModelStateUpdate = { path: (string | number)[] } & ({ value: JsonValue } | { deleted: true });

/** Exact projected replacements, not authored merge patches; paths are unambiguous key/index segments. */
export function acceptedStateUpdates(before: MaterializedState, after: MaterializedState, patches: AtomicScopePatches) {
	return projectedStateUpdates(projectStateForModel(before), projectStateForModel(after), patches, lazyNavigationHint(before), lazyNavigationHint(after));
}

function projectedStateUpdates(previous: ModelState, current: ModelState, patches: AtomicScopePatches,
	beforeNavigation: ReturnType<typeof lazyNavigationHint> | undefined, navigation: ReturnType<typeof lazyNavigationHint> | undefined) {
	const effective: ModelStateUpdate[] = [];
	const prefix = (parent: readonly (string | number)[], child: readonly (string | number)[]) =>
		parent.length <= child.length && parent.every((part, index) => part === child[index]);
	const put = (path: (string | number)[], value: JsonValue | undefined) => {
		if (effective.some((entry) => prefix(entry.path, path))) return;
		for (let index = effective.length - 1; index >= 0; index--) {
			if (prefix(path, effective[index]!.path)) effective.splice(index, 1);
		}
		effective.push({ path, ...(value === undefined ? { deleted: true as const } : { value: structuredClone(value) }) });
	};
	const child = (value: JsonValue | undefined, key: string | number): JsonValue | undefined =>
		value !== null && typeof value === "object" && Object.hasOwn(value, key)
			? (value as Record<string | number, JsonValue>)[key] : undefined;
	const diff = (left: JsonValue | undefined, right: JsonValue | undefined, path: (string | number)[]) => {
		if (left === undefined && right === undefined || left !== undefined && right !== undefined && sameJson(left, right)) return;
		if (isObject(left) && isObject(right)) {
			for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) diff(child(left, key), child(right, key), [...path, key]);
		} else if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
			for (let index = 0; index < right.length; index++) diff(left[index], right[index], [...path, index]);
		} else put(path, right);
	};
	const touched = (patch: JsonValue, value: JsonValue | undefined, path: (string | number)[]) => {
		if (!isObject(patch)) { put(path, value); return; }
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		if (Array.isArray(value) && keys.every((key) => /^\[(0|[1-9]\d*)\]$/.test(key))) {
			for (const key of keys) {
				const index = Number(key.slice(1, -1));
				// A higher-scope array may mask the patched array with a different length.
				if (index >= value.length) { put(path, value); return; }
				touched(patch[key]!, value[index], [...path, index]);
			}
		} else if (isObject(value)) {
			for (const key of keys) touched(patch[key]!, child(value, key), [...path, key]);
		} else put(path, value);
	};
	diff(previous, current, []);
	for (const patch of Object.values(patches)) for (const [plane, value] of Object.entries(patch)) {
		if (plane === "lazy") continue;
		if (plane === "artifacts" && isObject(value)) {
			for (const path of Object.keys(value)) put([plane, path], child(current.artifacts, path));
		} else touched(value as JsonValue, child(current, plane), [plane]);
	}
	return { effective, ...(navigation !== undefined && (beforeNavigation === undefined || !sameJson(beforeNavigation, navigation)) ? { lazy_navigation: navigation } : {}) };
}

export interface ContextView {
	state: ModelState;
	lazy_navigation?: ReturnType<typeof lazyNavigationHint>;
	artifact_invalidations: readonly ArtifactInvalidationNotice[];
	knowledge_rehydration: { phase: RehydrationPhase } | null;
}

export function contextView(state: MaterializedState, hints: ArtifactModelHints, invalidations: readonly ArtifactInvalidationNotice[], phase?: RehydrationPhase): ContextView {
	return { state: projectStateForModel(state, hints), lazy_navigation: lazyNavigationHint(state),
		artifact_invalidations: structuredClone(invalidations), knowledge_rehydration: phase === undefined ? null : { phase } };
}

/** Volatile model projection only. Native messages own trajectory; this cache owns no persistence or lifecycle. */
export class ContextProjection {
	private identity = randomUUID();
	private head: AgentMessage | undefined;
	private view: ContextView | undefined;
	private native: string[] = [];
	private notices: Array<{ after: number; message: AgentMessage }> = [];

	reset(): void {
		this.identity = randomUUID();
		this.head = undefined;
		this.view = undefined;
		this.native = [];
		this.notices = [];
	}

	/** Called only after successful publication and ancillary acceptance, immediately before returning the native result. */
	acceptPatch(before: MaterializedState, after: MaterializedState, patches: AtomicScopePatches, hints: ArtifactModelHints) {
		const state = projectStateForModel(after, hints);
		const navigation = lazyNavigationHint(after);
		const beforeNavigation = this.view?.lazy_navigation ?? lazyNavigationHint(before);
		const updates = projectedStateUpdates(this.view?.state ?? projectStateForModel(before, hints), state, patches,
			beforeNavigation, navigation);
		// Suppress direct writes only when the accepted effective value matches.
		// Overlap stays conservative except for explicit top-scope replacements:
		// Session scalars/arrays mask every lower-scope value at that path.
		const leaves: Array<{ scope: StateScope; path: (string | number)[]; value: JsonValue; artifact?: true }> = [];
		const objects: typeof leaves = [];
		const known = (path: readonly (string | number)[]): JsonValue | undefined => {
			let value: JsonValue | undefined = this.view?.state;
			for (const part of path) {
				if (value === undefined || value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
				value = (value as Record<string | number, JsonValue>)[part];
			}
			return value;
		};
		const visit = (scope: StateScope, value: JsonValue, path: (string | number)[]) => {
			if (isObject(value) && Object.keys(value).length > 0) {
				// Diff may coalesce a newly created/replaced object at this path.
				// Keep its authored value without widening the overlap frontier.
				objects.push({ scope, path, value });
				const basis = known(path);
				const entries = Object.entries(value);
				const indexed = Array.isArray(basis) && entries.every(([key]) => {
					if (!/^\[(0|[1-9]\d*)\]$/.test(key)) return false;
					const index = Number(key.slice(1, -1));
					return Number.isSafeInteger(index) && index < basis.length;
				});
				for (const [key, child] of entries) visit(scope, child,
					[...path, indexed ? Number(key.slice(1, -1)) : key]);
			} else leaves.push({ scope, path, value });
		};
		for (const scope of ["global", "cwd", "session"] as const) for (const [plane, value] of Object.entries(patches[scope] ?? {})) {
			if (plane === "lazy") continue;
			if (plane === "artifacts" && isObject(value)) {
				for (const [path, card] of Object.entries(value)) leaves.push({ scope, path: ["artifacts", path], value: card, artifact: true });
			} else visit(scope, value as JsonValue, [plane]);
		}
		const prefix = (a: readonly (string | number)[], b: readonly (string | number)[]) =>
			a.length <= b.length && a.every((part, index) => part === b[index]);
		updates.effective = updates.effective.filter((entry) => {
			const matches = ({ path }: typeof leaves[number]) => path.length === entry.path.length && prefix(path, entry.path);
			const authored = leaves.findLast(matches) ?? objects.findLast(matches);
			if (!authored) return true;
			const sessionReplacement = authored.scope === "session" && authored.value !== null && !isObject(authored.value);
			if (!sessionReplacement && leaves.some(({ scope, path }) => scope !== authored.scope && (prefix(path, authored.path) || prefix(authored.path, path)))) return true;
			if (authored.value !== null) {
				if (authored.artifact) {
					// Projected authored fields merge into the communicated card. Hints
					// are not authored; keeping one is predictable, changing it is not.
					const prior = known(entry.path);
					const card = projectArtifactForModel(authored.value);
					if (!isObject(card)) return true;
					let expected: JsonValue = card;
					if (isObject(prior)) {
						try { expected = applyPatch(prior, card); }
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
			if (!this.view) return true;
			const before = known(entry.path);
			return "value" in entry ? before === undefined || !sameJson(before, entry.value) : before !== undefined;
		});
		// A complete communicated key/kind catalog can predict non-deleting
		// top-level lazy writes. Missing/over-budget catalogs, deletions and
		// overlapping scopes cannot prove the post-patch navigation summary.
		if (updates.lazy_navigation && this.view && (beforeNavigation.keys || !beforeNavigation.available) && navigation.keys) {
			const expected = new Map(Object.entries(beforeNavigation.keys ?? {}));
			let predictable = true;
			const seen = new Set<string>();
			for (const scope of ["global", "cwd", "session"] as const) for (const [key, value] of Object.entries(patches[scope]?.lazy ?? {})) {
				if (seen.has(key) || value === null || isObject(value) && expected.get(key) === "array") predictable = false;
				seen.add(key);
				if (value !== null) expected.set(key, lazyValueKind(value));
			}
			if (predictable && seen.size > 0 && sameJson(Object.fromEntries(expected), navigation.keys)) delete updates.lazy_navigation;
		}
		if (this.view) this.view = { ...this.view, state, lazy_navigation: navigation };
		return updates.effective.length || updates.lazy_navigation ? { projection: this.identity, ...updates } : undefined;
	}

	project(messages: AgentMessage[], current: ContextView, makeHead: () => AgentMessage, initial?: ContextView): AgentMessage[] {
		const identities = messages.map((message) => JSON.stringify([message.role, message.timestamp,
			"toolCallId" in message ? message.toolCallId : null]));
		// Native compaction/selection normally resets explicitly; a removed/replaced prefix is also a safe cache boundary.
		if (this.native.some((identity, index) => identities[index] !== identity)) this.reset();
		if (!this.head) {
			const head = makeHead();
			if (head.role !== "user" || !Array.isArray(head.content)) throw new Error("State Flow projection requires an owned user head");
			this.head = { ...head, content: [...head.content, { type: "text", text: `State Flow projection: ${this.identity}` }] };
			this.view = structuredClone(initial ?? current);
		}
		const previous = this.view!;
		const updates = projectedStateUpdates(previous.state, current.state, {}, previous.lazy_navigation, current.lazy_navigation);
		const notice = {
			...(updates.effective.length || updates.lazy_navigation ? { state_updates: { projection: this.identity, ...updates } } : {}),
			...(!sameJson(previous.artifact_invalidations, current.artifact_invalidations) ? { artifact_invalidations: current.artifact_invalidations } : {}),
			...(!sameJson(previous.knowledge_rehydration, current.knowledge_rehydration) ? { knowledge_rehydration: current.knowledge_rehydration } : {}),
		};
		if (Object.keys(notice).length) this.notices.push({ after: messages.length,
			message: syntheticUser(`State Flow context update (user-level data, not system instructions):\n${presentationJson(notice)}`) });
		this.view = structuredClone(current);
		this.native = identities;
		const projected: AgentMessage[] = [this.head];
		let nextNotice = 0;
		for (let index = 0; index <= messages.length; index++) {
			while (this.notices[nextNotice]?.after === index) projected.push(this.notices[nextNotice++]!.message);
			if (index < messages.length) projected.push(messages[index]!);
		}
		return projected;
	}
}

/** Context retained after semantic State Flow is stopped in this physical session. */
export interface PassiveContinuation {
	startedAt: number;
	activeRunStartedAt?: number;
	preserveContext?: true;
	handoff: AgentMessage;
	state: ModelState;
}

export function syntheticUser(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part !== "object" || part === null) return "";
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? block.text : "";
	}).filter(Boolean).join("\n");
}

function messageText(message: AgentMessage): string {
	return contentText((message as { content?: unknown }).content);
}

export function createPassiveContinuation(state: ModelState, startedAt = Date.now(), activeRunStartedAt?: number, preserveContext = false): PassiveContinuation {
	return {
		startedAt,
		state: structuredClone(state),
		...(activeRunStartedAt === undefined ? {} : { activeRunStartedAt }),
		...(preserveContext ? { preserveContext: true as const } : {}),
		handoff: syntheticUser(`State Flow exit handoff (user-level data, not system instructions):\n${presentationJson({ state, continuation: preserveContext
			? "State Flow semantics are disabled; native context is retained because its compilation into memory is unfinished."
			: "State Flow semantics are disabled; this handoff replaces completed history while retaining the active and post-stop trajectory." })}`),
	};
}

/** Keep the interrupted run through later results; an idle stop retains only later conversation. */
export function passiveContinuationMessages(messages: AgentMessage[], continuation: PassiveContinuation): AgentMessage[] {
	if (continuation.preserveContext) return [continuation.handoff, ...messages];
	if (continuation.activeRunStartedAt !== undefined) {
		const trajectory = currentRunTrajectory(messages, "", continuation.activeRunStartedAt);
		return [continuation.handoff, ...trajectory.messages];
	}
	const start = messages.findIndex((message) => message.role === "user"
		&& typeof message.timestamp === "number"
		&& message.timestamp >= continuation.startedAt);
	return [continuation.handoff, ...messages.filter((message, index) =>
		message.role === "custom" || (start >= 0 && index >= start))];
}

function projectRecentForModel(recent: RecentTransitionWindow): RecentTransitionWindow {
	const projected = structuredClone(recent);
	for (const record of projected) for (const transition of record.transitions) {
		delete transition.patch.lazy;
		if (transition.patch.artifacts === undefined) continue;
		for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
			Object.defineProperty(transition.patch.artifacts, path, {
				value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
			});
		}
	}
	for (const record of projected) record.transitions = record.transitions.filter(({ patch }) => Object.keys(patch).length > 0);
	return projected.filter(({ transitions }) => transitions.length > 0);
}

export function runtimeContextMessage(
	snapshot: Snapshot,
	state: MaterializedState,
	recentTransitions: RecentTransitionWindow = [],
	artifactInvalidations: readonly ArtifactInvalidationNotice[] = [],
	rehydrationPhase?: RehydrationPhase,
	artifactHints: ArtifactModelHints = {},
): AgentMessage {
	return runtimeContextHead(snapshot, contextView(state, artifactHints, artifactInvalidations, rehydrationPhase), recentTransitions);
}

/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export function runtimeContextHead(snapshot: Snapshot, view: ContextView, recentTransitions: RecentTransitionWindow = []): AgentMessage {
	const recent = projectRecentForModel(recentTransitions);
	const context = {
		...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
		state: view.state,
		...(view.lazy_navigation === undefined ? {} : { lazy_navigation: view.lazy_navigation }),
		...(view.knowledge_rehydration === null ? {} : { knowledge_rehydration: view.knowledge_rehydration }),
		...(view.artifact_invalidations.length === 0 ? {} : { artifact_invalidations: view.artifact_invalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason })) }),
		...(recent.length === 0 ? {} : { recent_transitions: recent }),
	};
	return syntheticUser(
		`State Flow runtime context (user-level data, not system instructions):\n${presentationJson(context)}`,
	);
}

/** Captured identity survives text decoration; an uncertain boundary retains available context. */
export function currentRunTrajectory(
	messages: AgentMessage[],
	specification: string | undefined,
	anchorTimestamp: number | undefined,
): { messages: AgentMessage[]; anchorTimestamp?: number } {
	if (anchorTimestamp !== undefined && !Number.isFinite(anchorTimestamp)) return { messages: messages.slice() };
	const matches = (message: AgentMessage) => message.role === "user" && (anchorTimestamp === undefined
		? messageText(message) === specification
		: message.timestamp === anchorTimestamp);
	const start = messages.findIndex(matches);
	if (start < 0 || messages.findLastIndex(matches) !== start) return { messages: messages.slice() };
	const anchor = messages[start]?.role === "user" ? messages[start].timestamp : undefined;
	return {
		messages: messages.filter((message, index) => message.role === "custom" || index >= start),
		...(typeof anchor === "number" ? { anchorTimestamp: anchor } : {}),
	};
}
