// Domain: optional pi-telegram presentation adapter for the State Flow main-menu section.
//
// This is a leaf adapter. Core semantics, storage, and inference never depend on it; when
// pi-telegram is absent or its registry is not ready, registration fails open and retries.

import { conciseDiagnostic, diagnosticText } from "./protocol.ts";
import type { StateFlowMode } from "./snapshot.ts";
import { formatScopeRevisionVector } from "./status.ts";
import type { ScopeRevisions } from "./temporal.ts";

export const STATE_FLOW_TELEGRAM_ID = "@llblab/pi-state-flow";

/** Resolve the package export or the compiled sibling-extension layout used in local development. */
export function stateFlowTelegramSectionSpecifiers(moduleUrl = import.meta.url): string[] {
	return [
		"@llblab/pi-telegram/sections",
		new URL("../../../pi-telegram/dist/api/sections.js", moduleUrl).href,
	];
}

export interface StateFlowTelegramSnapshot {
	/** The current session's selected mode. */
	mode: StateFlowMode;
	/** Failed Active restoration fences inference without silently selecting an inactive mode. */
	inferenceBlocked?: boolean;
	/** Legacy branch step retained for existing adapter ports; current runtime ports also supply owner revisions. */
	step: number;
	revisions?: ScopeRevisions;
	bootstrap: boolean;
	startPending: boolean;
}

export type StateFlowTelegramScope = "global" | "cwd" | "session" | "effective";

export interface StateFlowTelegramState {
	artifacts?: Record<string, unknown>;
	contract?: Record<string, unknown>;
	working?: Record<string, unknown>;
	intents?: Record<string, unknown>;
	response?: string;
	lazy?: unknown;
}

export type StateFlowTelegramRichText =
	| string
	| StateFlowTelegramRichText[]
	| { type: "bold" | "code"; text: StateFlowTelegramRichText };

export type StateFlowTelegramRichBlock =
	| { type: "heading"; text: StateFlowTelegramRichText; size: 3 }
	| { type: "pre"; text: StateFlowTelegramRichText; language?: string }
	| { type: "details"; summary: StateFlowTelegramRichText; blocks: StateFlowTelegramRichBlock[]; is_open?: true };

export interface StateFlowTelegramRichMessage {
	blocks: StateFlowTelegramRichBlock[];
	skip_entity_detection?: boolean;
}

export interface StateFlowTelegramButton {
	text: string;
	callback_data: string;
}

export interface StateFlowTelegramView {
	text: string;
	parseMode?: "markdown" | "html" | "plain";
	replyMarkup?: { inline_keyboard: StateFlowTelegramButton[][] };
}

export interface StateFlowTelegramSectionContext {
	callbackData(action: string, payload?: string): string;
	edit(view: StateFlowTelegramView): Promise<void>;
	openRich(message: StateFlowTelegramRichMessage): Promise<void>;
	answerCallback(text?: string): Promise<void>;
}

export interface StateFlowTelegramCallbackContext extends StateFlowTelegramSectionContext {
	action: string;
	payload: string;
}

export interface StateFlowTelegramSectionModule {
	registerTelegramSection(section: {
		id: string;
		label: string;
		getLabel?: () => string;
		render: (ctx: StateFlowTelegramSectionContext) => StateFlowTelegramView | Promise<StateFlowTelegramView>;
		handleCallback?: (ctx: StateFlowTelegramCallbackContext) => "handled" | "pass" | Promise<"handled" | "pass">;
	}): () => void;
}

export interface StateFlowTelegramModules {
	sections?: StateFlowTelegramSectionModule;
}

export type StateFlowTelegramLoader = () => Promise<StateFlowTelegramModules>;

export interface StateFlowTelegramControlResult {
	ok: boolean;
	message: string;
	/** A completed control can lose its presentation authority after a mode or selection change. */
	signal?: AbortSignal;
}

export interface StateFlowTelegramInspection {
	state: StateFlowTelegramState;
	revisions: ScopeRevisions;
	/** A selection can revoke a completed observation before the adapter presents it. */
	signal?: AbortSignal;
}

export interface StateFlowTelegramPort {
	snapshot(): StateFlowTelegramSnapshot;
	state(scope: StateFlowTelegramScope): StateFlowTelegramState;
	/** Optional additive capability; absent legacy ports retain their branch-step presentation. */
	revisions?(): ScopeRevisions;
	/** Active may need a settled native boundary; inactive modes apply immediately. */
	canStartNow(): boolean;
	/** Select the current session's mode through the same lifecycle owners as the terminal commands. */
	select(mode: StateFlowMode): StateFlowTelegramControlResult;
	deferStart(): void;
	cancelStart(): void;
}

export interface StateFlowTelegramInspectionPort extends Omit<StateFlowTelegramPort, "state" | "revisions" | "select"> {
	inspect(scope: StateFlowTelegramScope): StateFlowTelegramInspection | Promise<StateFlowTelegramInspection>;
	select(mode: StateFlowMode): StateFlowTelegramControlResult | Promise<StateFlowTelegramControlResult>;
}

export interface StateFlowTelegramAdapter {
	ensure(): Promise<boolean>;
	dispose(): void;
}

/** Main-menu section label shows only the current session mode. */
export function formatStateFlowSectionLabel(snapshot: StateFlowTelegramSnapshot): string {
	return `🌀 State Flow: ${snapshot.mode}${snapshot.mode === "active" && snapshot.inferenceBlocked ? " (blocked)" : ""}`;
}

export const STATE_FLOW_MODES = ["off", "passive", "active"] as const satisfies readonly StateFlowMode[];
const STATE_FLOW_MODE_LABELS: Record<StateFlowMode, string> = { off: "Off", passive: "Passive", active: "Active" };
const STATE_FLOW_SELECTED_MARKERS: Record<StateFlowMode, string> = { off: "🟡", passive: "🟣", active: "🟢" };

function isStateFlowModeAction(value: string): value is StateFlowMode {
	return (STATE_FLOW_MODES as readonly string[]).includes(value);
}

function modeReceiptNotice(mode: StateFlowMode, result: StateFlowTelegramControlResult): string | undefined {
	if (result.ok && (result.message === `State Flow ${mode}` || result.message === `State Flow is already ${mode}`)) return undefined;
	return result.message;
}

/** One radio-style mode row followed directly by read-only scope actions. */
export function buildStateFlowSectionView(
	snapshot: StateFlowTelegramSnapshot,
	callbackData: (action: string, payload?: string) => string,
): StateFlowTelegramView {
	const modes: StateFlowTelegramButton[] = STATE_FLOW_MODES.map((mode) => ({
		text: `${mode === snapshot.mode ? STATE_FLOW_SELECTED_MARKERS[mode] : "⚫️"} ${STATE_FLOW_MODE_LABELS[mode]}`,
		callback_data: callbackData(mode),
	}));
	return {
		text: [
			`<b>🌀 State Flow:</b> <code>${snapshot.mode}</code>`,
			...(snapshot.mode === "active" && snapshot.inferenceBlocked ? [
				"",
				"<b>Inference blocked:</b> Active memory restoration failed. Select Active to accept current session memory, or Passive/Off to permit native context.",
			] : []),
			"",
			"<b>Mode</b> — choose a workflow (switching modes never erases stored memory):",
			"",
			"<code>-</code> <code>off</code> (default): regular chat without State Flow memory tools or context.",
			"<code>-</code> <code>passive</code>: regular chat with memory tools; available combined memory enters the agent's context.",
			"<code>-</code> <code>active</code>: same memory access; each completed answer closes a cycle, and the next request starts from saved state, not the full chat.",
			"",
			"<b>Inspect memory</b> — view stored state even in Off:",
			"",
			"<code>-</code> <code>global</code>: memory shared across projects and sessions.",
			"<code>-</code> <code>cwd</code>: memory shared by sessions in this directory.",
			"<code>-</code> <code>session</code>: private memory for this session, kept on resume.",
			"<code>-</code> <code>effective</code>: merged Global, CWD and Session state; the agent can use it when memory is enabled and available.",
		].join("\n"),
		parseMode: "html",
		replyMarkup: { inline_keyboard: [
			modes,
			...([["global", "cwd"], ["session", "effective"]] as const).map((row) => row.map((scope) => ({
				text: STATE_FLOW_SCOPE_LABELS[scope], callback_data: callbackData("inspect", scope),
			}))),
		] },
	};
}

const STATE_FLOW_SCOPE_LABELS: Record<StateFlowTelegramScope, string> = {
	global: "🌐 Global",
	cwd: "📂 CWD",
	session: "💬 Session",
	effective: "🧬 Effective",
};

// Budget the transport-serialized text, leaving room for six fields and notices
// below Telegram's 32,768-character Rich message ceiling.
const STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS = 3_000;

function renderStateFlowTelegramField(value: unknown): StateFlowTelegramRichBlock[] {
	const json = JSON.stringify(value, null, 2);
	if (JSON.stringify(json).length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS) {
		return [{ type: "pre", language: "json", text: json }];
	}
	let low = 0;
	let high = Math.min(json.length, STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS);
	while (low <= high) {
		const length = Math.floor((low + high) / 2);
		if (JSON.stringify(json.slice(0, length)).length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS) {
			low = length + 1;
		} else {
			high = length - 1;
		}
	}
	// Do not split a Unicode surrogate pair at the preview boundary.
	if (/[\uD800-\uDBFF]/.test(json.charAt(high - 1))) high -= 1;
	return [
		{ type: "pre", language: "json", text: json.slice(0, high) },
		{ type: "pre", text: `Truncated preview — ${json.length - high} characters omitted.` },
	];
}

export function renderStateFlowRichState(scope: StateFlowTelegramScope, revisions: ScopeRevisions, state: StateFlowTelegramState): StateFlowTelegramRichMessage {
	const fields: Array<keyof StateFlowTelegramState> = scope === "global" || scope === "cwd"
		? ["intents", "contract", "working", "artifacts", "lazy"]
		: ["intents", "contract", "working", "artifacts", "response", "lazy"];
	const revision = scope === "effective"
		? formatScopeRevisionVector(revisions)
		: `#${revisions[scope]}`;
	return {
		blocks: [
			{
				type: "heading",
				text: [`${STATE_FLOW_SCOPE_LABELS[scope]}: `, { type: "code", text: revision }],
				size: 3,
			},
			...fields.filter((field) => state[field] !== undefined && state[field] !== "").map((field) => ({
				type: "details" as const,
				summary: { type: "code" as const, text: field },
				blocks: renderStateFlowTelegramField(state[field]),
			})),
		],
		skip_entity_detection: true,
	};
}

function isStateFlowTelegramScope(value: string): value is StateFlowTelegramScope {
	return value === "global" || value === "cwd" || value === "session" || value === "effective";
}

function buildStateFlowTelegramSection(port: StateFlowTelegramPort | StateFlowTelegramInspectionPort, isActive: () => boolean) {
	let interaction = 0;
	return {
		id: STATE_FLOW_TELEGRAM_ID,
		label: "🌀 State Flow",
		getLabel: () => formatStateFlowSectionLabel(port.snapshot()),
		render: (ctx: StateFlowTelegramSectionContext) =>
			buildStateFlowSectionView(port.snapshot(), (action, payload) => ctx.callbackData(action, payload)),
		handleCallback: async (ctx: StateFlowTelegramCallbackContext) => {
			// Keyboards sent by earlier versions re-render (start/stop/refresh) or withdraw deferral (cancel); they change no mode.
			const legacy = ctx.action === "start" || ctx.action === "stop" || ctx.action === "cancel" || ctx.action === "refresh";
			if (!isStateFlowModeAction(ctx.action) && !legacy && ctx.action !== "show-state" && ctx.action !== "inspect" && ctx.action !== "back") return "pass" as const;
			const request = ++interaction;
			let notice: string | undefined;
			let acknowledged = false;
			try {
				if (ctx.action === "inspect") {
					if (!isStateFlowTelegramScope(ctx.payload)) throw new Error("Unknown State Flow scope");
					let observation: StateFlowTelegramInspection;
					if ("inspect" in port) {
						await ctx.answerCallback("Reading State Flow memory");
						acknowledged = true;
						observation = await port.inspect(ctx.payload);
					} else {
						const state = port.state(ctx.payload);
						const live = port.snapshot();
						observation = { state, revisions: port.revisions?.() ?? live.revisions ?? { global: live.step, cwd: live.step, session: live.step } };
					}
					observation.signal?.throwIfAborted();
					if (request !== interaction || !isActive()) return "handled" as const;
					await ctx.openRich(renderStateFlowRichState(ctx.payload, observation.revisions, observation.state));
					if (!acknowledged) await ctx.answerCallback();
					return "handled" as const;
				}
				const mode = isStateFlowModeAction(ctx.action) && (ctx.action !== "active" || port.canStartNow()) ? ctx.action : undefined;
				if (mode) {
					if ("inspect" in port) {
						acknowledged = true;
						// Apply the control immediately and acknowledge in parallel; neither promise can reject unobserved.
						const [, result] = await Promise.all([
							ctx.answerCallback(`Switching State Flow to ${mode}`),
							Promise.resolve().then(() => port.select(mode)),
						]);
						if (result.signal?.aborted) return "handled" as const;
						notice = modeReceiptNotice(mode, result);
					} else notice = modeReceiptNotice(mode, port.select(mode));
				} else if (ctx.action === "active") {
					port.deferStart();
					notice = "State Flow will become active after the current turn";
				} else if (ctx.action === "cancel") {
					port.cancelStart();
					notice = "Pending start cancelled";
				}
			} catch (error) {
				notice = diagnosticText(error);
			}
			if (request !== interaction || !isActive()) return "handled" as const;
			const summary = notice === undefined ? undefined : conciseDiagnostic(notice, 200);
			const view = buildStateFlowSectionView(port.snapshot(), (action, payload) => ctx.callbackData(action, payload));
			if (acknowledged && summary !== undefined) {
				// Callback queries can expire during storage waits; retain errors in the existing menu instead.
				view.text += `\n\n${summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`;
			} else if (!acknowledged) await ctx.answerCallback(summary);
			await ctx.edit(view);
			return "handled" as const;
		},
	};
}

async function importTelegramModule<TModule>(
	specifiers: readonly string[],
	guard: (module: unknown) => module is TModule,
): Promise<TModule | undefined> {
	for (const specifier of specifiers) {
		try {
			const imported = await import(specifier);
			if (guard(imported)) return imported;
		} catch {
			// pi-telegram is optional; its absence only disables the Telegram surface.
		}
	}
	return undefined;
}

/** Default loader; injectable so tests and embedded hosts can control transport presence. */
export async function loadStateFlowTelegramModules(): Promise<StateFlowTelegramModules> {
	const sections = await importTelegramModule<StateFlowTelegramSectionModule>(
		stateFlowTelegramSectionSpecifiers(),
		(module): module is StateFlowTelegramSectionModule =>
			typeof (module as StateFlowTelegramSectionModule | undefined)?.registerTelegramSection === "function",
	);
	return { ...(sections === undefined ? {} : { sections }) };
}

export function createStateFlowTelegramAdapter(options: {
	port: StateFlowTelegramPort | StateFlowTelegramInspectionPort;
	load?: StateFlowTelegramLoader;
}): StateFlowTelegramAdapter {
	const load = options.load ?? loadStateFlowTelegramModules;
	let generation = 0;
	let sectionRegistered = false;
	let registration: Promise<boolean> | undefined;
	const disposers: Array<() => void> = [];

	const register = async (): Promise<boolean> => {
		const epoch = generation;
		let modules: StateFlowTelegramModules;
		try {
			modules = await load();
		} catch {
			return false;
		}
		// A shutdown during loading must not leave a registration behind.
		if (epoch !== generation) return false;
		if (!sectionRegistered && modules.sections) {
			try {
				const dispose = modules.sections.registerTelegramSection(buildStateFlowTelegramSection(options.port, () => epoch === generation));
				if (epoch === generation) {
					disposers.push(dispose);
					sectionRegistered = true;
				} else {
					dispose();
				}
			} catch {
				// Registry not initialized yet; the next ensure retries.
			}
		}
		return sectionRegistered;
	};

	return {
		async ensure(): Promise<boolean> {
			if (sectionRegistered) return true;
			registration ??= register().finally(() => {
				registration = undefined;
			});
			return registration;
		},
		dispose(): void {
			generation += 1;
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					// Disposal is best-effort; pi-telegram owns its registry lifetime.
				}
			}
			sectionRegistered = false;
		},
	};
}
