import { parseRetainedPiCheckpoint, prepareRetainedPolicyMigration, readCheckpointMode, isStateFlowMode, type InactiveMode, type StateFlowMode, type RetainedPolicyMigrationCandidate } from "./snapshot.ts";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, type ScopeSelection } from "./selection.ts";
import { isJsonValue, isObject } from "./json.ts";
import { isAbsolute, resolve } from "node:path";
import { RenewableLifetime } from "./operation.ts";

export const SNAPSHOT_ENTRY_TYPE = "state-flow-snapshot";

/** Requested native policy, not proof of accepted memory or acquisition permission. */
export interface SelectedNativeRequestPolicy {
	readonly cwd: string;
	readonly owner: string;
	readonly mode: StateFlowMode;
	readonly scopes: ScopeSelection;
}

/** Cancelable pre-provider turn, including Off bookkeeping; not memory/acquisition authority. */
export type NativeContextRequest = Pick<SelectedPolicyRequest, "signal" | "revalidate">;

export interface SelectedPolicyRequest {
	readonly policy: SelectedNativeRequestPolicy;
	readonly signal: AbortSignal;
	/** Synchronous in-memory recheck, suitable for the selected runtime's native-policy port. */
	revalidate(): void;
}

function captureRequestPolicy(value: SelectedNativeRequestPolicy): SelectedNativeRequestPolicy {
	try {
		if (!isObject(value) || Reflect.ownKeys(value).length !== 4
			|| !["cwd", "owner", "mode", "scopes"].every(key => Object.hasOwn(value, key))) throw new Error();
		const { cwd, owner, mode, scopes } = value;
		if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof owner !== "string" || !owner.trim() || !isStateFlowMode(mode)) throw new Error();
		return Object.freeze({ cwd: resolve(cwd), owner, mode, scopes: captureScopeSelection(scopes) });
	} catch {
		throw new Error("Invalid State Flow selected request policy");
	}
}

/** Owns policy-bound cancellation only; no storage, attachment, source acquisition or slot registry. */
export class SelectedPolicyLifetime {
	readonly #lifetime = new RenewableLifetime();
	#policy: SelectedNativeRequestPolicy | undefined;
	#ended = false;

	get policy(): SelectedNativeRequestPolicy | undefined { return this.#policy; }

	/** Cancellation only, including Off; unlike capture(), this grants no enabled memory receipt. */
	get signal(): AbortSignal { return this.#lifetime.signal; }

	/** Same captured policy preserves independent owners; a real choice revokes all old requests. */
	select(value: SelectedNativeRequestPolicy): void {
		if (this.#ended) throw new Error("State Flow selected policy lifetime has ended");
		const next = captureRequestPolicy(value), previous = this.#policy;
		if (previous && previous.cwd === next.cwd && previous.owner === next.owner && previous.mode === next.mode
			&& previous.scopes.length === next.scopes.length && previous.scopes.every((scope, index) => scope === next.scopes[index])) return;
		this.#policy = next;
		this.#lifetime.renew(new Error("State Flow selected native policy changed"));
	}

	/** Capture at admission, before any source acquisition, asynchronous wait or queued work. */
	capture(): SelectedPolicyRequest {
		const policy = this.#policy, signal = this.#lifetime.signal;
		if (this.#ended || !policy || signal.aborted) throw new Error("State Flow selected policy lifetime is unavailable");
		if (policy.mode === "off") throw new Error("Off cannot capture State Flow memory requests");
		const revalidate = () => {
			if (this.#ended || this.#policy !== policy || this.#lifetime.signal !== signal || signal.aborted)
				throw new Error("State Flow selected policy request is no longer current");
		};
		return Object.freeze({ policy, signal, revalidate });
	}

	/** Same-policy branch movement/Abort may revoke requests without inventing a different selection. */
	invalidate(): void {
		if (!this.#ended) this.#lifetime.renew(new Error("State Flow selected native request lifetime changed"));
	}

	/** Shutdown cannot be reopened by a late selection or abort listener. */
	end(): void {
		this.#ended = true;
		this.#policy = undefined;
		this.#lifetime.end(new Error("State Flow selected policy lifetime has ended"));
	}
}

/** One SDK turn and its finalized assistant batch; IDs are evidence only within this owned turn. */
export class NativeToolRequestCorrelation {
	#turn: { request?: SelectedPolicyRequest; signal?: AbortSignal; currentIdentity: () => boolean; finalized: boolean; controller: AbortController; prepared?: () => void } | undefined;
	#ambiguous = false;
	#context: NativeContextRequest | undefined;
	#operation: AbortSignal | undefined;
	readonly #calls = new Map<string, { name: string; consumed: boolean; parent?: string }>();

	begin(request: SelectedPolicyRequest | undefined, signal: AbortSignal | undefined, currentIdentity: () => boolean, controlSignal?: AbortSignal): void {
		this.#operation = signal;
		// An overlapping turn has no public request ID to disambiguate its later messages.
		if (this.#turn || this.#ambiguous) { this.end(); this.#ambiguous = true; return; }
		this.#turn = { request, signal: controlSignal ? AbortSignal.any([controlSignal, ...(signal ? [signal] : [])]) : signal, currentIdentity, finalized: false, controller: new AbortController() };
	}

	/** Stable lease from turn_start through provider preparation, before assistant finalization. */
	preparing(): NativeContextRequest {
		const turn = this.#turn;
		const revalidate = () => {
			if (this.#ambiguous || !turn || this.#turn !== turn || turn.finalized || turn.signal?.aborted || !turn.currentIdentity())
				throw new Error("State Flow context has no current native request");
			turn.request?.revalidate();
			turn.prepared?.();
		};
		revalidate();
		return this.#context ??= Object.freeze({
			signal: AbortSignal.any([turn!.controller.signal, ...(turn!.signal ? [turn!.signal] : []), ...(turn!.request ? [turn!.request.signal] : [])]),
			revalidate,
		});
	}

	/** Provider-only revalidation of captured context data; callbacks must neither acquire nor recurse into this request. */
	bindPreparedContext(check: () => void): void {
		this.preparing().revalidate();
		const turn = this.#turn!;
		check();
		if (this.#turn !== turn) throw new Error("State Flow prepared context owner changed");
		turn.prepared = check;
	}

	finalize(calls: readonly { id: string; name: string }[]): void {
		if (!this.#turn || this.#ambiguous) return;
		if (this.#turn.finalized) { this.end(); this.#ambiguous = true; return; }
		this.#turn.finalized = true;
		for (const { id, name } of calls) {
			if (!id || !name || this.#calls.has(id)) { this.end(); this.#ambiguous = true; return; }
			this.#calls.set(id, { name, consumed: false });
		}
	}

	get active(): boolean { return this.#turn !== undefined || this.#ambiguous; }

	/** Identify the ambient model owner; deciding which Abort cause to forward belongs to the native port. */
	ownsOperation(signal: AbortSignal | undefined): boolean { return signal !== undefined && signal === this.#operation; }

	has(id: string): boolean { return this.#calls.has(id); }

	current(): SelectedPolicyRequest {
		const turn = this.#turn;
		if (this.#ambiguous || !turn?.request || !turn.finalized || turn.signal?.aborted || !turn.currentIdentity())
			throw new Error("State Flow tool batch has no current native request");
		turn.request.revalidate();
		return turn.request;
	}

	check(id: string, name: string): SelectedPolicyRequest {
		const request = this.current(), call = this.#calls.get(id);
		if (!call || call.name !== name) throw new Error("State Flow tool batch has no current native request");
		return request;
	}

	/** Only explicit SDK parent evidence, never an ID prefix or branch-history guess. */
	nested(id: string, name: string, parent: string): void {
		const call = this.#calls.get(parent), previous = this.#calls.get(id);
		if (!id || !call || previous && (previous.name !== name || previous.parent !== parent)) throw new Error("State Flow nested tool has no current native parent");
		this.check(parent, call.name);
		if (!previous) this.#calls.set(id, { name, consumed: false, parent });
	}

	take(id: string, name: string): SelectedPolicyRequest {
		const request = this.check(id, name), call = this.#calls.get(id)!;
		if (call.consumed) throw new Error("State Flow native tool admission was already consumed");
		call.consumed = true;
		const turn = this.#turn!;
		return Object.freeze({ policy: request.policy,
			signal: AbortSignal.any([request.signal, turn.controller.signal, ...(turn.signal ? [turn.signal] : [])]),
			revalidate: () => { if (this.#turn !== turn) throw new Error("State Flow native request turn has ended"); this.check(id, name); },
		});
	}

	end(): void {
		const previous = this.#turn;
		this.#turn = undefined;
		this.#ambiguous = false;
		this.#context = undefined;
		this.#calls.clear();
		previous?.controller.abort();
	}
}

interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown };
}

export interface SessionEntryLookup {
	getLeafEntry(): (BranchEntry & { id?: string; parentId?: string | null }) | undefined;
	getEntry(id: string): (BranchEntry & { id?: string; parentId?: string | null }) | undefined;
}

export interface PassiveStopBoundary {
	at: number;
	from?: number;
	preserveContext?: true;
	/** A same-owner failed mode change remains a write fence until a later accepted checkpoint. */
	persistenceError?: string;
	/** The inactive mode selected by that failed change; legacy markers omit it. */
	mode?: InactiveMode;
	/** Native-only Off choice; canonical runtime mode is deliberately not updated. */
	memoryDeferred?: true;
}

export interface SnapshotDiscovery {
	candidates: unknown[];
	errors: string[];
}

/** Enumerate active-branch snapshots newest-first while containing hostile entries. */
export function discoverSnapshotData(branch: readonly BranchEntry[]): SnapshotDiscovery {
	const candidates: unknown[] = [];
	const errors: string[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) candidates.push(entry.data);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { candidates, errors };
}

/** Read native mode policy only; semantic checkpoint validity remains the recovery owner's concern. */
export function findBranchPolicy(
	branch: readonly BranchEntry[], sessionId: string | undefined, stopEntryType: string | undefined, inactiveMode: InactiveMode,
): { mode: StateFlowMode; persistenceError?: string } | undefined {
	let stopReset = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
				const mode = readCheckpointMode(entry.data, inactiveMode);
				if (mode !== undefined) return { mode };
				const data = entry.data as { disabled?: unknown; mode?: unknown; enabled?: unknown } | undefined;
				if (data?.disabled === true && !Object.hasOwn(data, "mode") && !Object.hasOwn(data, "enabled")) return { mode: inactiveMode };
			} else if (stopEntryType !== undefined && entry.customType === stopEntryType) {
				const data = entry.data as PassiveStopBoundary & { owner?: unknown; reset?: unknown } | undefined;
				if (!data || stopReset || (sessionId === undefined ? typeof data.owner !== "string" || !data.owner.trim() : data.owner !== sessionId)) continue;
				if (data.reset === true) { stopReset = true; continue; }
				if (Number.isSafeInteger(data.at) && data.at >= 0 && data.memoryDeferred === true && data.mode === "off") {
					return { mode: "off", ...(typeof data.persistenceError === "string" && data.persistenceError.trim() ? { persistenceError: data.persistenceError } : {}) };
				}
				if (Number.isSafeInteger(data.at) && data.at >= 0 && typeof data.persistenceError === "string" && data.persistenceError.trim()) {
					return { mode: data.mode === "off" || data.mode === "passive" ? data.mode : inactiveMode, persistenceError: data.persistenceError };
				}
			}
		} catch {
			// Malformed native policy cannot prevent another explicit retained choice from being read.
		}
	}
	return undefined;
}

/** Checkpoint-only preflight: no Stop/fork precedence, installation or authority. Invalid owned data cannot fall back. */
export function prepareBranchCheckpointPolicy(
	branch: readonly BranchEntry[], legacySelection: ScopeSelection, inactiveMode: InactiveMode = "passive",
): RetainedPolicyMigrationCandidate | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		let entry: BranchEntry;
		try {
			entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== SNAPSHOT_ENTRY_TYPE) continue;
		} catch {
			// Unclassifiable foreign entries grant no policy authority.
			continue;
		}
		return prepareRetainedPolicyMigration(entry.data, legacySelection, inactiveMode);
	}
	return undefined;
}

/** Native-only policy/bookkeeping. This marker never grants canonical memory or parent-copy authority. */
export interface SelectedNativePolicyMarker {
	version: 2;
	owner: string;
	mode: StateFlowMode;
	scopes: ScopeSelection;
	reset?: true;
	forkPending?: true;
	at?: number;
	from?: number;
	preserveContext?: true;
	persistenceError?: string;
	memoryDeferred?: true;
}

type ParsedNativeMarker = Omit<SelectedNativePolicyMarker, "version" | "owner" | "mode" | "scopes"> & {
	version: "legacy" | 2; owner?: string; mode?: StateFlowMode; scopes?: ScopeSelection;
};

function nativeMarkerVersion(value: Record<string, unknown>): "legacy" | 2 {
	let version: unknown;
	try { if (!Object.hasOwn(value, "version")) return "legacy"; version = value.version; }
	catch { throw new Error("Unreadable State Flow native policy marker version"); }
	if (version !== 2) throw new Error("Unsupported State Flow native policy marker version");
	return 2;
}

function parseNativeMarker(value: unknown): ParsedNativeMarker {
	if (!isObject(value)) throw new Error("Invalid State Flow native policy marker");
	const version = nativeMarkerVersion(value);
	if (version === "legacy" && Object.hasOwn(value, "scopes")) throw new Error("Target policy fields in legacy State Flow native marker");
	const keys = ["version", "owner", "mode", "scopes", "reset", "forkPending", "at", "from", "preserveContext", "persistenceError", "memoryDeferred"];
	if (Object.keys(value).some(key => !keys.includes(key)) || !isJsonValue(value)) throw new Error("Invalid State Flow native policy marker");
	const { owner, mode, reset, forkPending, at, from: rawFrom, preserveContext, persistenceError, memoryDeferred } = value;
	// Legacy Stop treated an invalid optional anchor as absent, retaining the valid cutoff.
	const from = version === "legacy" && (!Number.isSafeInteger(rawFrom) || (rawFrom as number) < 0) ? undefined : rawFrom;
	if ((owner !== undefined && (typeof owner !== "string" || !owner.trim()))
		|| (mode !== undefined && !isStateFlowMode(mode))
		|| (version === 2 && (typeof owner !== "string" || !isStateFlowMode(mode) || !Object.hasOwn(value, "scopes")))
		|| [reset, forkPending, preserveContext, memoryDeferred].some(flag => flag !== undefined && flag !== true)
		|| [at, from].some(time => time !== undefined && (!Number.isSafeInteger(time) || (time as number) < 0))
		|| (persistenceError !== undefined && (typeof persistenceError !== "string" || !persistenceError.trim()))
		|| ((from !== undefined || preserveContext !== undefined || persistenceError !== undefined || memoryDeferred !== undefined) && at === undefined)
		|| (at !== undefined && mode === "active")
		|| (memoryDeferred === true && (mode !== "off" || owner === undefined))
		|| ((reset === true || forkPending === true) && owner === undefined)
		|| (reset === true && (forkPending !== undefined || at !== undefined || from !== undefined || preserveContext !== undefined || persistenceError !== undefined || memoryDeferred !== undefined))
		|| (version === "legacy" && at === undefined && reset !== true && forkPending !== true)
		|| (version === "legacy" && reset === true && mode !== undefined)) throw new Error("Invalid State Flow native policy marker");
	return {
		version, ...(owner === undefined ? {} : { owner: owner as string }), ...(mode === undefined ? {} : { mode: mode as StateFlowMode }),
		...(version === 2 ? { scopes: captureScopeSelection(value.scopes) } : {}),
		...(reset === true ? { reset: true } : {}), ...(forkPending === true ? { forkPending: true } : {}),
		...(at === undefined ? {} : { at: at as number }), ...(from === undefined ? {} : { from: from as number }),
		...(preserveContext === true ? { preserveContext: true } : {}), ...(memoryDeferred === true ? { memoryDeferred: true } : {}),
		...(persistenceError === undefined ? {} : { persistenceError: persistenceError as string }),
	};
}

/** Closed v2 writer value. Legacy records are translated only in branch context, never given a fabricated owner. */
export function captureSelectedNativeMarker(value: unknown): SelectedNativePolicyMarker {
	const marker = parseNativeMarker(value);
	if (marker.version !== 2) throw new Error("Selected State Flow native marker requires version 2");
	return marker as SelectedNativePolicyMarker;
}

export interface SelectedBranchPolicyOptions {
	owner: string;
	markerEntryType: string;
	/** The caller chooses new-session versus inactive fallback mode; absence itself grants no acquisition. */
	defaults: { mode: StateFlowMode; scopes: ScopeSelection };
	inactiveMode?: InactiveMode;
	/** Native fresh-fork fact only; no parent header or store lookup belongs in this resolver. */
	fork?: boolean;
}

export interface SelectedBranchPolicyCandidate {
	mode: StateFlowMode;
	scopes: ScopeSelection;
	source: "default" | "checkpoint" | "marker";
	forkPending: boolean;
	stop?: PassiveStopBoundary;
	persistenceError?: string;
	requiresCapture: boolean;
	/** Policy-only capture preserves fences; only a separately owned acceptance may append reset/checkpoint. */
	capture: SelectedNativePolicyMarker;
}

/** Complete native branch admission only; never read canonical/parent files, attach policy or confer memory authority. */
export function prepareSelectedBranchPolicy(branch: readonly BranchEntry[], options: SelectedBranchPolicyOptions): SelectedBranchPolicyCandidate {
	const { owner, markerEntryType } = options;
	const inactiveMode = options.inactiveMode ?? "passive";
	const fallbackMode = options.defaults?.mode;
	if (typeof owner !== "string" || !owner.trim() || typeof markerEntryType !== "string" || !markerEntryType.trim() || markerEntryType === SNAPSHOT_ENTRY_TYPE
		|| !isStateFlowMode(fallbackMode) || (inactiveMode !== "passive" && inactiveMode !== "off")
		|| (options.fork !== undefined && typeof options.fork !== "boolean")) throw new Error("Invalid State Flow selected branch policy context");
	let mode = fallbackMode, scopes = captureScopeSelection(options.defaults.scopes);
	const classified: Array<{ type: "checkpoint" | "marker"; entry: BranchEntry; index: number }> = [];
	for (let index = 0; index < branch.length; index++) {
		try {
			const entry = branch[index];
			if (entry?.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY_TYPE) classified.push({ type: "checkpoint", entry, index });
			else if (entry.customType === markerEntryType) classified.push({ type: "marker", entry, index });
		} catch { /* Unclassifiable foreign entries supply no policy. */ }
	}
	const data = new Map<number, unknown>(), decoded = new Map<number, ParsedNativeMarker>();
	const read = (record: typeof classified[number]): unknown => {
		if (!data.has(record.index)) {
			try { data.set(record.index, record.entry.data); }
			catch { throw new Error("Unreadable State Flow native policy data"); }
		}
		return data.get(record.index);
	};
	const markerOwner = (value: unknown): unknown => {
		try { return isObject(value) ? value.owner : undefined; }
		catch { throw new Error("Unreadable State Flow native policy owner"); }
	};
	const marker = (record: typeof classified[number]): ParsedNativeMarker => {
		if (!decoded.has(record.index)) decoded.set(record.index, parseNativeMarker(read(record)));
		return decoded.get(record.index)!;
	};
	let forkPending = options.fork === true;
	// A later owned reset/pending record supersedes older fork evidence, not a checkpoint or mode-only choice.
	for (const record of [...classified].reverse()) {
		if (record.type !== "marker") continue;
		const value = read(record);
		if (markerOwner(value) !== owner || !isObject(value)) continue;
		nativeMarkerVersion(value);
		if (!Object.hasOwn(value, "reset") && !Object.hasOwn(value, "forkPending")) continue;
		const selected = marker(record);
		if (selected.reset) { forkPending = false; break; }
		if (selected.forkPending) { forkPending = true; break; }
	}
	const inherit = options.fork === true || forkPending;
	let localSeen = false, policyError = false, requiresCapture = true;
	let source: SelectedBranchPolicyCandidate["source"] = "default";
	let checkpointMode: StateFlowMode | undefined;
	let stop: PassiveStopBoundary | undefined, persistenceError: string | undefined;
	for (const record of classified) {
		if (record.type === "checkpoint") {
			try {
				const selected = prepareRetainedPolicyMigration(read(record), scopes, inactiveMode);
				mode = selected.checkpoint.mode; scopes = selected.checkpoint.scopes; checkpointMode = mode;
				if (selected.sourceVersion === 2) policyError = false;
				requiresCapture = selected.requiresConversion || inherit;
				source = "checkpoint";
				if (Object.hasOwn(selected.checkpoint, "boundary")) persistenceError = undefined;
			} catch { policyError = true; }
			continue;
		}
		const raw = read(record), physicalOwner = markerOwner(raw);
		const local = physicalOwner === owner;
		const inherited = typeof physicalOwner === "string" && physicalOwner.trim() && inherit && !localSeen;
		if (physicalOwner !== undefined && !local && !inherited) continue;
		try {
			const selected = marker(record);
			const policyOwner = local || inherited;
			if (policyOwner) {
				if (selected.version === 2) { scopes = selected.scopes!; mode = selected.mode!; policyError = false; source = "marker"; requiresCapture = !local; }
				else if (selected.reset) { mode = checkpointMode ?? fallbackMode; source = "marker"; requiresCapture = true; }
				else if (selected.memoryDeferred || selected.persistenceError) { mode = selected.memoryDeferred ? "off" : selected.mode ?? inactiveMode; source = "marker"; requiresCapture = true; }
				if (local) localSeen = true;
			}
			if (local && selected.reset) { stop = undefined; persistenceError = undefined; }
			if ((local || physicalOwner === undefined) && selected.at !== undefined) {
				stop = { at: selected.at, ...(selected.from === undefined ? {} : { from: selected.from }),
					...(selected.preserveContext ? { preserveContext: true } : {}), ...(selected.mode === "passive" || selected.mode === "off" ? { mode: selected.mode } : {}),
					...(selected.memoryDeferred ? { memoryDeferred: true } : {}) };
				if (local && selected.persistenceError) persistenceError = selected.persistenceError;
			}
		} catch { if (local || inherited || isObject(raw) && Object.hasOwn(raw, "version")) policyError = true; }
	}
	if (policyError) throw new Error("State Flow selected branch policy is invalid or unsupported");
	scopes = captureScopeSelection(scopes);
	const capture = captureSelectedNativeMarker({ version: 2, owner, mode, scopes, ...(forkPending ? { forkPending: true } : {}) });
	return { mode, scopes, source, forkPending, requiresCapture, capture,
		...(stop === undefined ? {} : { stop: { ...stop, ...(persistenceError === undefined ? {} : { persistenceError }) } }),
		...(persistenceError === undefined ? {} : { persistenceError }) };
}

/** Native policy bookkeeping retains an unacquired fork across extension reloads. */
export function hasPendingFork(branch: readonly BranchEntry[], sessionId: string, entryType: string): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== entryType) continue;
			const data = entry.data as { owner?: unknown; reset?: unknown; forkPending?: unknown } | undefined;
			if (data?.owner !== sessionId) continue;
			if (data.reset === true) return false;
			if (data.forkPending === true) return true;
		} catch {
			// Unrelated native entries grant no fork authority.
		}
	}
	return false;
}

export function snapshotDataNewestFirst(branch: readonly BranchEntry[]): unknown[] {
	return discoverSnapshotData(branch).candidates;
}

export function latestSnapshotData(branch: readonly BranchEntry[]): unknown {
	return snapshotDataNewestFirst(branch)[0];
}

export function hasPriorConversation(branch: readonly BranchEntry[]): boolean {
	for (const entry of branch) {
		try {
			if (entry.type !== "message") continue;
			const role = entry.message?.role;
			if (role === "user" || role === "assistant" || role === "toolResult") return true;
		} catch {
			// A hostile unrelated entry must not prevent explicit episode startup.
		}
	}
	return false;
}

/** Native conversation after the latest valid checkpoint may contain uncompiled work, not a new semantic authority. */
export function hasUncheckpointedConversation(branch: readonly BranchEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		try {
			const entry = branch[index];
			if (entry?.type === "message") {
				const role = entry.message?.role;
				if (role === "user" || role === "assistant" || role === "toolResult") return true;
			}
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
				if (isObject(entry.data) && Object.hasOwn(entry.data, "version")) {
					const retained = prepareRetainedPolicyMigration(entry.data, DEFAULT_SCOPE_SELECTION).checkpoint;
					if (Object.hasOwn(retained, "boundary")) return false;
				} else {
					parseRetainedPiCheckpoint(entry.data);
					return false;
				}
			}
		} catch {
			// Malformed entries cannot prove that pending input was checkpointed.
		}
	}
	return false;
}

/** Auto-start eligibility is session identity/lifecycle, not the presence of CWD materialization. */
export function isNewSession(reason: unknown, branch: readonly BranchEntry[]): boolean {
	if (reason === "new") return true;
	return reason === "startup" && !hasPriorConversation(branch);
}

export function findAssistantToolBatch(session: SessionEntryLookup, toolCallId: string): string[] | undefined {
	for (let cursor = session.getLeafEntry(); cursor; cursor = cursor.parentId ? session.getEntry(cursor.parentId) : undefined) {
		if (cursor.type !== "message" || cursor.message?.role !== "assistant" || !Array.isArray((cursor.message as { content?: unknown }).content)) continue;
		const calls = (cursor.message as { content: unknown[] }).content.filter((block): block is { type: "toolCall"; id: string; name: string } => {
			return typeof block === "object" && block !== null
				&& (block as { type?: unknown }).type === "toolCall"
				&& typeof (block as { id?: unknown }).id === "string"
				&& typeof (block as { name?: unknown }).name === "string";
		});
		if (calls.some(({ id }) => id === toolCallId)) return calls.map(({ name }) => name);
	}
	return undefined;
}

export function findPassiveStopBoundary(branch: readonly BranchEntry[], sessionId: string, entryType: string): PassiveStopBoundary | undefined {
	let checkpointSeen = false;
	for (const entry of [...branch].reverse()) {
		try {
			if (entry?.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
				parseRetainedPiCheckpoint(entry.data);
				checkpointSeen = true;
				continue;
			}
			if (entry.customType !== entryType) continue;
			const { at, from, reset, owner, preserveContext, persistenceError, mode } = (entry.data as { at?: unknown; from?: unknown; reset?: unknown; owner?: unknown; preserveContext?: unknown; persistenceError?: unknown; mode?: unknown } | undefined) ?? {};
			if (reset === true && owner === sessionId) return undefined;
			if (owner !== undefined && owner !== sessionId) continue;
			if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) return {
				at,
				...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
				...(preserveContext === true ? { preserveContext: true } : {}),
				...(!checkpointSeen && owner === sessionId && typeof persistenceError === "string" && persistenceError.trim().length > 0 ? { persistenceError } : {}),
				...(mode === "passive" || mode === "off" ? { mode } : {}),
			};
		} catch {
			// A hostile unrelated branch entry cannot manufacture or suppress a valid marker.
		}
	}
	return undefined;
}

export function retainsPhysicalSessionProjection(reason: unknown): boolean {
	return reason === undefined || reason === "startup" || reason === "reload" || reason === "resume";
}
