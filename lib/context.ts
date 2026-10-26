import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectArtifactForModel, type ArtifactInvalidationNotice, type ArtifactModelHints } from "./artifact.ts";
import type { RecentTransitionWindow } from "./history.ts";
import { applyPatch, isObject, presentationJson, pruneEmptyObjects, sameJson, type JsonObject, type JsonValue } from "./json.ts";
import type { Snapshot } from "./snapshot.ts";
import { formatOwnedPath, type OwnedPath } from "./ownership.ts";
import { projectModelReferences } from "./model-interface.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { projectSemanticPatch, projectSemanticState, projectStateForModel, type AtomicScopePatches, type SemanticState, type StateScope } from "./state.ts";
import { lazyValueKind, projectLazyNavigation, projectPlaneContext } from "./planes.ts";
import { evaluateModuleContext, type EvaluatedModuleContext, type ModuleFrame, type SemanticModule } from "./semantic-module.ts";

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

/** Compatibility facade; the lazy plane owns the unchanged navigation policy. */
export function lazyNavigationHint(state: SemanticState) {
	return projectLazyNavigation(state.lazy);
}

/** Materialize module contributions only; native context selection/replacement authority stays with the host. */
export function semanticModuleMessages<Content extends JsonValue, Input>(module: SemanticModule<Content, Input>, content: unknown, frame: ModuleFrame<Input>): AgentMessage[] {
	return evaluateModuleContext(module, content, frame).flatMap(contribution => contribution.kind === "conversation"
		? [...contribution.messages]
		: [syntheticUser(`State Flow module ${module.id} (user-level data, not system instructions):\n${presentationJson(contribution.value)}`)]);
}


export type ModelStateUpdate = { path: (string | number)[] } & ({ value: JsonValue } | { deleted: true });

/** Exact projected replacements, not authored merge patches; paths are unambiguous key/index segments. */
export function acceptedStateUpdates(before: SemanticState, after: SemanticState, patches: AtomicScopePatches) {
	return projectedStateUpdates(projectStateForModel(before), projectStateForModel(after), patches, lazyNavigationHint(before), lazyNavigationHint(after));
}

function projectedStateUpdates(previous: SemanticState, current: SemanticState, patches: AtomicScopePatches,
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
		if (isObject(right) && (isObject(left) || left === undefined && path.length === 1 && Object.keys(right).length > 0)) {
			for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right)])) diff(child(left, key), child(right, key), [...path, key]);
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
	/** Wanted presentation DATA only; never infer it from available state or use it as authority. */
	modelScopes?: ScopeSelection;
	state: SemanticState;
	lazy_navigation?: ReturnType<typeof lazyNavigationHint>;
	artifact_invalidations: readonly ArtifactInvalidationNotice[];
	knowledge_rehydration: { phase: RehydrationPhase } | null;
}

function projectContextState(state: SemanticState, hints: ArtifactModelHints, includeResponse: boolean) {
	const { lazy: _hidden, ...visible } = state;
	const projected = projectPlaneContext({ ...projectSemanticState(visible), ...(Object.hasOwn(state, "lazy") ? { lazy: state.lazy! } : {}) }, hints, includeResponse ? "active" : "passive");
	return { ...projected, state: pruneEmptyObjects(projected.state) as SemanticState };
}

export function contextView(state: SemanticState, hints: ArtifactModelHints, invalidations: readonly ArtifactInvalidationNotice[], phase?: RehydrationPhase, includeResponse = true, modelScopes?: ScopeSelection): ContextView {
	const selected = modelScopes === undefined ? undefined : captureScopeSelection(modelScopes);
	return { ...(selected === undefined ? {} : { modelScopes: selected }), ...projectContextState(state, hints, includeResponse),
		artifact_invalidations: structuredClone(invalidations), knowledge_rehydration: phase === undefined ? null : { phase } };
}

function viewScopes(view?: ContextView): ScopeSelection {
	return view && Object.hasOwn(view, "modelScopes") ? captureScopeSelection(view.modelScopes) : DEFAULT_SCOPE_SELECTION;
}

function modelState(state: SemanticState, scopes: ScopeSelection): SemanticState {
	return scopes.length === 1 ? projectModelReferences(state, scopes) as SemanticState : state;
}

function modelNavigation(navigation: ContextView["lazy_navigation"], scopes: ScopeSelection) {
	return navigation && scopes.length === 1 ? { ...navigation, path: "lazy" } : navigation;
}

function modelUpdates<T extends { effective: ModelStateUpdate[]; lazy_navigation?: ContextView["lazy_navigation"] }>(updates: T, scopes: ScopeSelection) {
	if (scopes.length !== 1) return updates;
	return { ...updates, effective: updates.effective.map(entry => {
		if (!("value" in entry)) return entry;
		// A canonical diff may split a structured ref into its scalar $ref leaf.
		const value = entry.path.at(-1) === "$ref" && typeof entry.value === "string"
			? (projectModelReferences({ $ref: entry.value }, scopes) as JsonObject).$ref!
			: projectModelReferences(entry.value, scopes);
		return { ...entry, value };
	}), ...(updates.lazy_navigation ? { lazy_navigation: modelNavigation(updates.lazy_navigation, scopes) } : {}) };
}

/** Same owned passive envelope as before, with presentation chosen from captured wanted DATA. */
export function passiveContextHead(view: ContextView): AgentMessage {
	const scopes = viewScopes(view);
	return syntheticUser(`State Flow passive memory (user-level data, not system instructions):\n${presentationJson({ state: modelState(view.state, scopes), lazy_navigation: modelNavigation(view.lazy_navigation, scopes) })}`);
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
	acceptPatch(before: SemanticState, after: SemanticState, patches: AtomicScopePatches, hints: ArtifactModelHints,
		cascades: Partial<Record<StateScope, readonly OwnedPath[]>> = {}, includeResponse = true, modelScopes?: ScopeSelection) {
		const scopes = modelScopes === undefined ? viewScopes(this.view) : captureScopeSelection(modelScopes);
		// A receipt from another interface cannot be attached to a replacement model head.
		if (this.view && !sameJson(viewScopes(this.view), scopes)) return undefined;
		// External planes have exact tool reads but no automatic core projection. Absence here is not deletion.
		patches = Object.fromEntries(Object.entries(patches).map(([scope, patch]) => [scope,
			Object.fromEntries(Object.entries(patch).filter(([id]) => !id.startsWith("x_"))),
		]));
		const { state } = projectContextState(after, hints, includeResponse);
		const navigation = lazyNavigationHint(after);
		const beforeNavigation = this.view?.lazy_navigation ?? lazyNavigationHint(before);
		const updates = projectedStateUpdates(this.view?.state ?? projectContextState(before, hints, includeResponse).state, state, patches,
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
			if ("deleted" in entry && this.view && known(entry.path) === undefined) return false;
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
		// Owner paths remain informative even when effective state/navigation is masked
		// or the model could predict every direct write. Never expose target values.
		const cascaded = scopes.flatMap(scope => (cascades[scope] ?? []).map(path =>
			scopes.length === 1 ? [path.plane, ...path.keys].join(".") : formatOwnedPath(scope, path)));
		return updates.effective.length || updates.lazy_navigation || cascaded.length
			? { projection: this.identity, ...modelUpdates(updates, scopes), ...(cascaded.length ? { cascaded } : {}) } : undefined;
	}

	project(messages: AgentMessage[], current: ContextView, makeHead: () => AgentMessage, initial?: ContextView): AgentMessage[] {
		const scopes = viewScopes(current);
		if (this.view && !sameJson(viewScopes(this.view), scopes)) this.reset();
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
			...(updates.effective.length || updates.lazy_navigation ? { state_updates: { projection: this.identity, ...modelUpdates(updates, scopes) } } : {}),
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
	state: SemanticState;
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

/** A unique native user anchor admits completed conversation, never the current run or protocol frames. */
export function moduleConversationSource(messages: readonly AgentMessage[], anchorTimestamp: number | undefined): { conversation: readonly AgentMessage[]; prompt?: string } {
	if (anchorTimestamp === undefined || !Number.isFinite(anchorTimestamp)) return { conversation: [] };
	const matches = messages.flatMap((message, index) => message.role === "user" && message.timestamp === anchorTimestamp ? [index] : []);
	if (matches.length !== 1) return { conversation: [] };
	const start = matches[0]!;
	return { conversation: messages.slice(0, start).filter(message => ["user", "assistant", "toolResult"].includes(message.role)), prompt: messageText(messages[start]!) };
}

function assertModuleToolUnits(messages: readonly AgentMessage[]): void {
	const pending = new Map<string, string>(), seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) throw new Error("Module conversation selection has an orphan tool result");
			pending.delete(message.toolCallId);
		} else {
			if (pending.size) throw new Error("Module conversation selection omits a tool result");
			if (message.role !== "assistant") continue;
			for (const part of message.content) if (part.type === "toolCall") {
				if (!part.id || !part.name || seen.has(part.id)) throw new Error("Module conversation selection has duplicate or invalid tool calls");
				seen.add(part.id); pending.set(part.id, part.name);
			}
		}
	}
	if (pending.size) throw new Error("Module conversation selection omits a tool result");
}

export interface ScopedModuleContext {
	id: string;
	scope: StateScope;
	contributions: readonly EvaluatedModuleContext[];
}

/** Provider projection only: preserve current/foreign identities and allow one explicit completed-history selector. */
export function projectModuleContext(projected: AgentMessage[], original: readonly AgentMessage[], conversation: readonly AgentMessage[], modules: readonly ScopedModuleContext[]): AgentMessage[] {
	const data: AgentMessage[] = [];
	let selection: readonly AgentMessage[] | undefined;
	for (const module of modules) {
		const selecting = module.contributions.some(item => item.kind === "conversation");
		if (selecting) {
			if (module.scope !== "session" || selection !== undefined) throw new Error("Module conversation replacement requires one exclusive Session selector");
			selection = module.contributions.flatMap(item => item.kind === "conversation" ? [...item.messages] : []);
			if (new Set(selection).size !== selection.length || selection.some(message => !conversation.includes(message))) throw new Error("Module conversation selection is outside its admitted source");
			assertModuleToolUnits(selection);
		}
		for (const item of module.contributions) if (item.kind === "data") data.push(syntheticUser(`State Flow module ${module.id} (${module.scope}; user-level data, not system instructions):\n${presentationJson(item.value)}`));
	}
	if (!data.length && selection === undefined) return projected;
	const completed = new Set(selection === undefined ? [] : conversation);
	const retained = projected.filter(message => !completed.has(message));
	const native = new Set(original.filter(message => ["user", "assistant", "toolResult"].includes(message.role)));
	const first = retained.findIndex(message => native.has(message));
	const at = first < 0 ? retained.length : first;
	return [...retained.slice(0, at), ...data, ...(selection ?? []), ...retained.slice(at)];
}

export function createPassiveContinuation(state: SemanticState, startedAt = Date.now(), activeRunStartedAt?: number, preserveContext = false, modelScopes?: ScopeSelection): PassiveContinuation {
	const scopes = modelScopes === undefined ? DEFAULT_SCOPE_SELECTION : captureScopeSelection(modelScopes);
	const visibleState = structuredClone(state);
	delete visibleState.response;
	return {
		startedAt,
		state: visibleState,
		...(activeRunStartedAt === undefined ? {} : { activeRunStartedAt }),
		...(preserveContext ? { preserveContext: true as const } : {}),
		handoff: syntheticUser(`State Flow exit handoff (user-level data, not system instructions):\n${presentationJson({ state: modelState(visibleState, scopes), continuation: preserveContext
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
	// A post-stop native summary replaces its compacted user anchor, including the retained tool suffix.
	const start = messages.findIndex((message) => (message.role === "user" || message.role === "compactionSummary")
		&& typeof message.timestamp === "number"
		&& message.timestamp >= continuation.startedAt);
	return [continuation.handoff, ...messages.filter((message, index) =>
		message.role === "custom" || (start >= 0 && index >= start))];
}

function projectRecentForModel(recent: RecentTransitionWindow, scopes: ScopeSelection) {
	// Select owner headers before cloning any excluded patch payload.
	const projected = structuredClone(recent.map(record => ({ ...record,
		transitions: record.transitions.filter(transition => scopes.includes(transition.scope)) })));

	for (const record of projected) for (const transition of record.transitions) {
		transition.patch = projectSemanticPatch(transition.patch as JsonObject);
		delete transition.patch.lazy;
		if (!isObject(transition.patch.artifacts)) continue;
		for (const [path, entry] of Object.entries(transition.patch.artifacts)) {
			Object.defineProperty(transition.patch.artifacts, path, {
				value: projectArtifactForModel(entry), enumerable: true, configurable: true, writable: true,
			});
		}
	}
	for (const record of projected) record.transitions = record.transitions.filter(({ patch }) => Object.keys(patch).length > 0);
	const visible = projected.filter(({ transitions }) => transitions.length > 0);
	if (scopes.length !== 1) return visible;
	return visible.map(record => {
		if (record.transitions.length !== 1) throw new Error("Flat State Flow recent history requires one patch per captured owner");
		return { id: record.id, at: record.at, patch: projectModelReferences(record.transitions[0]!.patch, scopes) };
	});
}

export function runtimeContextMessage(
	snapshot: Snapshot,
	state: SemanticState,
	recentTransitions: RecentTransitionWindow = [],
	artifactInvalidations: readonly ArtifactInvalidationNotice[] = [],
	rehydrationPhase?: RehydrationPhase,
	artifactHints: ArtifactModelHints = {},
): AgentMessage {
	return runtimeContextHead(snapshot, contextView(state, artifactHints, artifactInvalidations, rehydrationPhase), recentTransitions);
}

/** Render a view already projected by this domain without cloning the full semantic overlay twice. */
export function runtimeContextHead(snapshot: Snapshot, view: ContextView, recentTransitions: RecentTransitionWindow = []): AgentMessage {
	const scopes = viewScopes(view), recent = projectRecentForModel(recentTransitions, scopes);
	const context = {
		...(snapshot.meta.specification === undefined ? {} : { specification: snapshot.meta.specification }),
		state: modelState(view.state, scopes),
		...(view.lazy_navigation === undefined ? {} : { lazy_navigation: modelNavigation(view.lazy_navigation, scopes) }),
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
