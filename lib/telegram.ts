// Domain: optional pi-telegram presentation adapter for the State Flow main-menu section.
//
// This is a leaf adapter. Core semantics, storage, and inference never depend on it; when
// pi-telegram is absent or its registry is not ready, registration fails open and retries.

export const STATE_FLOW_TELEGRAM_ID = "@llblab/pi-state-flow";
const SECTIONS_IMPORT_SPECIFIERS = [
	"@llblab/pi-telegram/sections",
	new URL("../../pi-telegram/api/sections.ts", import.meta.url).href,
];

export interface StateFlowTelegramSnapshot {
	enabled: boolean;
	step: number;
	bootstrap: boolean;
	startPending: boolean;
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
	return snapshot.enabled ? `🌀 State Flow: #${snapshot.step}` : "🌀 State Flow: off";
}

/** Short help under the state line: what State Flow is and why its action button exists. */
const STATE_FLOW_SECTION_HELP =
	"Records the latest accepted state after every turn, so a new session resumes from the last committed point. Start it to keep memory live on this branch, stop it to pause.";

/** The submenu header repeats the button's state line; the single action matches the current state. */
export function buildStateFlowSectionView(
	snapshot: StateFlowTelegramSnapshot,
	callbackData: (action: string) => string,
): StateFlowTelegramView {
	const action: StateFlowTelegramButton = snapshot.enabled
		? { text: "⏹ Stop", callback_data: callbackData("stop") }
		: { text: "▶️ Start", callback_data: callbackData("start") };
	return {
		text: [`<b>${formatStateFlowSectionLabel(snapshot)}</b>`, "", STATE_FLOW_SECTION_HELP].join("\n"),
		parseMode: "html",
		replyMarkup: { inline_keyboard: [[action]] },
	};
}

function buildStateFlowTelegramSection(port: StateFlowTelegramPort) {
	return {
		id: STATE_FLOW_TELEGRAM_ID,
		label: "🌀 State Flow",
		getLabel: () => formatStateFlowSectionLabel(port.snapshot()),
		render: (ctx: StateFlowTelegramSectionContext) =>
			buildStateFlowSectionView(port.snapshot(), (action) => ctx.callbackData(action)),
		handleCallback: async (ctx: StateFlowTelegramCallbackContext) => {
			// cancel/refresh remain routable for keyboards sent by earlier versions; 0.9.4 presents only the state action.
			if (ctx.action !== "start" && ctx.action !== "stop" && ctx.action !== "cancel" && ctx.action !== "refresh") return "pass" as const;
			let notice: string | undefined;
			try {
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
		SECTIONS_IMPORT_SPECIFIERS,
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
