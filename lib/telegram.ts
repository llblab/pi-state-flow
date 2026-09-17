// Domain: optional pi-telegram presentation adapter for the State Flow main-menu section.
//
// This is a leaf adapter. Core semantics, storage, and inference never depend on it; when
// pi-telegram is absent or its registry is not ready, registration fails open and retries.

export const STATE_FLOW_TELEGRAM_ID = "@llblab/pi-state-flow";

/** Resolve the package export or the compiled sibling-extension layout used in local development. */
export function stateFlowTelegramSectionSpecifiers(moduleUrl = import.meta.url): string[] {
	return [
		"@llblab/pi-telegram/sections",
		new URL("../../../pi-telegram/dist/api/sections.js", moduleUrl).href,
	];
}

export interface StateFlowTelegramSnapshot {
	enabled: boolean;
	step: number;
	bootstrap: boolean;
	startPending: boolean;
}

export type StateFlowTelegramScope = "global" | "cwd" | "session" | "effective";

export interface StateFlowTelegramState {
	artifacts: Record<string, unknown>;
	contract: Record<string, unknown>;
	working: Record<string, unknown>;
	intents: Record<string, unknown>;
	response: string;
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
}

export interface StateFlowTelegramPort {
	snapshot(): StateFlowTelegramSnapshot;
	state(scope: StateFlowTelegramScope): StateFlowTelegramState;
	canStartNow(): boolean;
	start(): StateFlowTelegramControlResult;
	stop(): StateFlowTelegramControlResult;
	deferStart(): void;
	cancelStart(): void;
}

export interface StateFlowTelegramAdapter {
	ensure(): Promise<boolean>;
	dispose(): void;
}

/** Main-menu section label doubles as the live status value: the spiral identity is constant, the value is not. */
export function formatStateFlowSectionLabel(snapshot: StateFlowTelegramSnapshot): string {
	return `🌀 State Flow: ${stateFlowLabelValue(snapshot)}`;
}

/** Shared live value: plain in the button label, monospaced in the submenu state line. */
function stateFlowLabelValue(snapshot: StateFlowTelegramSnapshot): string {
	return snapshot.enabled ? `#${snapshot.step}` : "off";
}

/** Submenu state line: the same identity as the button label, with the live value in monospace. */
function formatStateFlowSectionHeader(snapshot: StateFlowTelegramSnapshot): string {
	return `<b>🌀 State Flow: <code>${stateFlowLabelValue(snapshot)}</code></b>`;
}

/** Short help under the state line: what State Flow is and why its action button exists. */
const STATE_FLOW_SECTION_HELP =
	"Records the latest accepted state after every turn, so a new session resumes from the last committed point.";

/** The submenu header repeats the button's state line; the single action matches the current state. */
export function buildStateFlowSectionView(
	snapshot: StateFlowTelegramSnapshot,
	callbackData: (action: string) => string,
): StateFlowTelegramView {
	const action: StateFlowTelegramButton = snapshot.enabled
		? { text: "⏹ Stop", callback_data: callbackData("stop") }
		: { text: "▶️ Start", callback_data: callbackData("start") };
	return {
		text: [formatStateFlowSectionHeader(snapshot), "", STATE_FLOW_SECTION_HELP].join("\n"),
		parseMode: "html",
		replyMarkup: { inline_keyboard: [
			[action],
			[{ text: "👁 Show state", callback_data: callbackData("show-state") }],
		] },
	};
}

const STATE_FLOW_SCOPE_LABELS: Record<StateFlowTelegramScope, string> = {
	global: "🌐 Global",
	cwd: "📂 CWD",
	session: "💬 Session",
	effective: "🧬 Effective",
};

export function buildStateFlowScopeChooser(callbackData: (action: string, payload?: string) => string): StateFlowTelegramView {
	return {
		text: "<b>👁 Show state:</b>",
		parseMode: "html",
		replyMarkup: { inline_keyboard: [
			...(["global", "cwd", "session", "effective"] as const).map((scope) => [
				{ text: STATE_FLOW_SCOPE_LABELS[scope], callback_data: callbackData("inspect", scope) },
			]),
		] },
	};
}

// The complete message serializes each preformatted field one additional time;
// 3,000 leaves safe headroom for worst-case JSON escaping across all four fields.
const STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS = 3_000;

function renderStateFlowTelegramField(value: unknown): string {
	const json = JSON.stringify(value, null, 2);
	if (json.length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS) return json;
	let low = 0;
	let high = json.length;
	let rendered = "";
	while (low <= high) {
		const length = Math.floor((low + high) / 2);
		const candidate = JSON.stringify({
			truncated: true,
			...(value !== null && typeof value === "object" && !Array.isArray(value)
				? { keys: Object.keys(value) }
				: {}),
			preview: json.slice(0, length),
			omittedChars: json.length - length,
		}, null, 2);
		if (candidate.length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS) {
			rendered = candidate;
			low = length + 1;
		} else {
			high = length - 1;
		}
	}
	return rendered;
}

export function renderStateFlowRichState(scope: StateFlowTelegramScope, step: number, state: StateFlowTelegramState): StateFlowTelegramRichMessage {
	const fields = ["artifacts", "contract", "working", "intents", "response", "lazy"] as const;
	return {
		blocks: [
			{
				type: "heading",
				text: [`${STATE_FLOW_SCOPE_LABELS[scope]}: `, { type: "code", text: `#${step}` }],
				size: 3,
			},
			...fields.map((field) => ({
				type: "details" as const,
				summary: { type: "code" as const, text: field },
				blocks: [{ type: "pre" as const, language: "json", text: renderStateFlowTelegramField(state[field] ?? {}) }],
			})),
		],
		skip_entity_detection: true,
	};
}

function isStateFlowTelegramScope(value: string): value is StateFlowTelegramScope {
	return value === "global" || value === "cwd" || value === "session" || value === "effective";
}

function buildStateFlowTelegramSection(port: StateFlowTelegramPort) {
	return {
		id: STATE_FLOW_TELEGRAM_ID,
		label: "🌀 State Flow",
		getLabel: () => formatStateFlowSectionLabel(port.snapshot()),
		render: (ctx: StateFlowTelegramSectionContext) =>
			buildStateFlowSectionView(port.snapshot(), (action) => ctx.callbackData(action)),
		handleCallback: async (ctx: StateFlowTelegramCallbackContext) => {
			// cancel/refresh remain routable for keyboards sent by earlier versions.
			if (ctx.action !== "start" && ctx.action !== "stop" && ctx.action !== "cancel" && ctx.action !== "refresh" && ctx.action !== "show-state" && ctx.action !== "inspect" && ctx.action !== "back") return "pass" as const;
			let notice: string | undefined;
			try {
				if (ctx.action === "show-state") {
					await ctx.answerCallback();
					await ctx.edit(buildStateFlowScopeChooser((action, payload) => ctx.callbackData(action, payload)));
					return "handled" as const;
				}
				if (ctx.action === "inspect") {
					if (!isStateFlowTelegramScope(ctx.payload)) throw new Error("Unknown State Flow scope");
					await ctx.openRich(renderStateFlowRichState(ctx.payload, port.snapshot().step, port.state(ctx.payload)));
					await ctx.answerCallback();
					return "handled" as const;
				}
				if (ctx.action === "start") {
					if (port.canStartNow()) notice = port.start().message;
					else {
						port.deferStart();
						notice = "State Flow will start after the current turn";
					}
				} else if (ctx.action === "stop") {
					notice = port.stop().message;
				} else if (ctx.action === "cancel") {
					port.cancelStart();
					notice = "Pending start cancelled";
				}
			} catch (error) {
				notice = error instanceof Error ? error.message : String(error);
			}
			await ctx.answerCallback(notice);
			await ctx.edit(buildStateFlowSectionView(port.snapshot(), (action) => ctx.callbackData(action)));
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
	port: StateFlowTelegramPort;
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
				const dispose = modules.sections.registerTelegramSection(buildStateFlowTelegramSection(options.port));
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
