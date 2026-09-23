import assert from "node:assert/strict";
import test from "node:test";
import {
	buildStateFlowSectionView,
	createStateFlowTelegramAdapter,
	formatStateFlowSectionLabel,
	renderStateFlowRichState,
	stateFlowTelegramSectionSpecifiers,
	type StateFlowTelegramCallbackContext,
	type StateFlowTelegramModules,
	type StateFlowTelegramPort,
	type StateFlowTelegramSectionContext,
	type StateFlowTelegramSnapshot,
	type StateFlowTelegramView,
} from "../lib/telegram.ts";
import { captureTemporalFileBases } from "../lib/durable.ts";
import { emptyState } from "../lib/state.ts";
import { harness } from "./harness.ts";
import { writeGlobalState } from "./storage-fixture.ts";

function snapshot(overrides: Partial<StateFlowTelegramSnapshot> = {}): StateFlowTelegramSnapshot {
	return { enabled: false, step: 0, revisions: { global: 0, cwd: 0, session: 0 }, bootstrap: false, startPending: false, ...overrides };
}

function fakePort(initial: StateFlowTelegramSnapshot, options: { canStartNow?: boolean; startResult?: { ok: boolean; message: string } } = {}) {
	let current = initial;
	const calls: string[] = [];
	const port: StateFlowTelegramPort = {
		snapshot: () => current,
		state: () => ({ artifacts: {}, contract: {}, working: {}, intents: {}, response: "" }),
		revisions: () => current.revisions!,
		canStartNow: () => options.canStartNow ?? true,
		start: () => {
			calls.push("start");
			const result = options.startResult ?? { ok: true, message: "State Flow enabled" };
			if (result.ok) current = { ...current, enabled: true, startPending: false };
			return result;
		},
		stop: () => {
			calls.push("stop");
			current = { ...current, enabled: false };
			return { ok: true, message: "State Flow disabled" };
		},
		deferStart: () => {
			calls.push("deferStart");
			current = { ...current, startPending: true };
		},
		cancelStart: () => {
			calls.push("cancelStart");
			current = { ...current, startPending: false };
		},
	};
	return { port, calls, read: () => current };
}

function fakeModules(failingSections = false) {
	type FakeSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: FakeSection[] = [];
	const disposed: string[] = [];
	let sectionAttempts = 0;
	const modules: StateFlowTelegramModules = {
		sections: {
			registerTelegramSection(section) {
				sectionAttempts += 1;
				if (failingSections && sectionAttempts === 1) throw new Error("registry unavailable");
				sections.push(section);
				return () => disposed.push(`section:${section.id}`);
			},
		},
	};
	return { modules, sections, disposed };
}

function sectionContext(action: string, payload = "") {
	const edits: StateFlowTelegramView[] = [];
	const notices: Array<string | undefined> = [];
	const richMessages: unknown[] = [];
	const context = {
		action,
		payload,
		callbackData: (name: string) => `section:0:${name}`,
		edit: async (view: StateFlowTelegramView) => {
			edits.push(view);
		},
		openRich: async (message: unknown) => {
			richMessages.push(message);
		},
		answerCallback: async (text?: string) => {
			notices.push(text);
		},
	} as StateFlowTelegramCallbackContext;
	return { context, edits, notices, richMessages };
}

test("Telegram section discovery covers the package and compiled sibling layouts", () => {
	const compiledUrl = new URL("../dist/lib/telegram.js", import.meta.url).href;
	assert.deepEqual(stateFlowTelegramSectionSpecifiers(compiledUrl), [
		"@llblab/pi-telegram/sections",
		new URL("../../pi-telegram/dist/api/sections.js", import.meta.url).href,
	]);
});

test("section label exposes the effective revision vector only while active mode is enabled", () => {
	assert.equal(formatStateFlowSectionLabel(snapshot()), "🌀 State Flow: off");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, revisions: { global: 15, cwd: 8, session: 31 } })), "🌀 State Flow: G15/C8/S31");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, step: 7, revisions: undefined })), "🌀 State Flow: #7");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, revisions: { global: 15, cwd: 8, session: 31 }, bootstrap: true })), "🌀 State Flow: G15/C8/S31");
	assert.equal(formatStateFlowSectionLabel(snapshot({ revisions: { global: 4, cwd: 3, session: 2 }, startPending: true })), "🌀 State Flow: off");
});

test("Rich headings distinguish owner revisions from the Effective vector", () => {
	const state = { artifacts: {}, contract: {}, working: {}, intents: {}, response: "" };
	const revisions = { global: 15, cwd: 8, session: 31 };
	const heading = (scope: "global" | "cwd" | "session" | "effective") => renderStateFlowRichState(scope, revisions, state).blocks[0];
	assert.deepEqual(heading("global"), { type: "heading", text: ["🌐 Global: ", { type: "code", text: "#15" }], size: 3 });
	assert.doesNotMatch(JSON.stringify(renderStateFlowRichState("global", revisions, state)), /response/);
	assert.deepEqual(heading("cwd"), { type: "heading", text: ["📂 CWD: ", { type: "code", text: "#8" }], size: 3 });
	assert.deepEqual(heading("session"), { type: "heading", text: ["💬 Session: ", { type: "code", text: "#31" }], size: 3 });
	assert.deepEqual(heading("effective"), { type: "heading", text: ["🧬 Effective: ", { type: "code", text: "G15/C8/S31" }], size: 3 });
});

test("section view repeats the state line with one lifecycle button and no refresh or cancel", () => {
	const off = buildStateFlowSectionView(snapshot(), (action) => `cb:${action}`);
	assert.equal(
		off.text,
		"<b>🌀 State Flow: <code>off</code></b>\n\nAccepted memory remains visible in active and passive modes. Start or Stop changes episode behavior, not state access.",
	);
	assert.deepEqual(off.replyMarkup?.inline_keyboard, [
		[{ text: "▶️ Start", callback_data: "cb:start" }],
		[{ text: "👁 Show state", callback_data: "cb:show-state" }],
	]);
	const on = buildStateFlowSectionView(snapshot({ enabled: true, revisions: { global: 15, cwd: 8, session: 31 } }), (action) => `cb:${action}`);
	assert.match(on.text, /^<b>🌀 State Flow: <code>G15\/C8\/S31<\/code><\/b>/);
	assert.deepEqual(on.replyMarkup?.inline_keyboard, [
		[{ text: "⏹ Stop", callback_data: "cb:stop" }],
		[{ text: "👁 Show state", callback_data: "cb:show-state" }],
	]);
	const pending = buildStateFlowSectionView(snapshot({ startPending: true }), (action) => `cb:${action}`);
	assert.match(pending.text, /^<b>🌀 State Flow: <code>off<\/code><\/b>/);
	assert.deepEqual(pending.replyMarkup?.inline_keyboard, [
		[{ text: "▶️ Start", callback_data: "cb:start" }],
		[{ text: "👁 Show state", callback_data: "cb:show-state" }],
	]);
});

test("scope chooser opens exactly one selected native Rich state tree", async () => {
	const state = { artifacts: { "/a": { description: "A" } }, contract: { rule: true }, working: {}, intents: { current: "Validate release" }, response: "Done", lazy: { memory: ["retained"] } };
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot({ enabled: true }));
	port.state = (scope) => ({ ...state, working: { scope } });
	port.revisions = () => ({ global: 15, cwd: 8, session: 31 });
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const chooser = sectionContext("show-state");
	assert.equal(await sections[0].handleCallback!(chooser.context), "handled");
	assert.equal(chooser.edits[0].text, "<b>👁 Show state:</b>");
	assert.deepEqual(chooser.edits[0].replyMarkup?.inline_keyboard.map((row) => row.map((button) => button.text)), [
		["🌐 Global"],
		["📂 CWD"],
		["💬 Session"],
		["🧬 Effective"],
	]);
	const inspect = sectionContext("inspect", "effective");
	assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
	assert.deepEqual(inspect.richMessages, [renderStateFlowRichState("effective", { global: 15, cwd: 8, session: 31 }, { ...state, working: { scope: "effective" } })]);
	assert.deepEqual(inspect.richMessages[0]?.blocks.map((block) => block.type), ["heading", "details", "details", "details", "details", "details", "details"]);
	assert.deepEqual(inspect.richMessages[0]?.blocks[0], {
		type: "heading",
		text: ["🧬 Effective: ", { type: "code", text: "G15/C8/S31" }],
		size: 3,
	});
	assert.deepEqual(inspect.richMessages[0]?.blocks.slice(1).map((block) => "summary" in block ? block.summary : undefined), [
		{ type: "code", text: "intents" },
		{ type: "code", text: "contract" },
		{ type: "code", text: "working" },
		{ type: "code", text: "artifacts" },
		{ type: "code", text: "response" },
		{ type: "code", text: "lazy" },
	]);
	assert.deepEqual(inspect.richMessages[0]?.blocks[1], {
		type: "details",
		summary: { type: "code", text: "intents" },
		blocks: [{ type: "pre", language: "json", text: '{\n  "current": "Validate release"\n}' }],
	});
	assert.deepEqual(inspect.richMessages[0]?.blocks[6], {
		type: "details",
		summary: { type: "code", text: "lazy" },
		blocks: [{ type: "pre", language: "json", text: '{\n  "memory": [\n    "retained"\n  ]\n}' }],
	});
	assert.equal(inspect.edits.length, 0);
	const back = sectionContext("back");
	assert.equal(await sections[0].handleCallback!(back.context), "handled");
	assert.match(back.edits[0].text, /^<b>🌀 State Flow:/);
});

test("Telegram can load shared state for inspection when passive model tools are disabled", async () => {
	type RegisteredSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: RegisteredSection[] = [];
	const h = harness({
		passiveBootstrap: false,
		passiveTools: false,
		telegram: { load: async () => ({ sections: { registerTelegramSection(section) { sections.push(section); return () => {}; } } }) },
	});
	writeGlobalState({ ...emptyState(), working: { transportObservation: "available" } }, h.repositoryRoot);
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const inspect = sectionContext("inspect", "global");
	assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
	assert.equal(inspect.notices[0], undefined);
	assert.match(JSON.stringify(inspect.richMessages), /transportObservation/);
	assert.match(JSON.stringify(inspect.richMessages), /available/);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
});

test("Rich state rendering bounds unbounded semantic fields with explicit truncation", () => {
	const message = renderStateFlowRichState("global", { global: 12, cwd: 7, session: 9 }, {
		artifacts: { huge: "x".repeat(40_000) },
		contract: { huge: "y".repeat(40_000) },
		working: { huge: "z".repeat(40_000) },
		intents: { huge: "i".repeat(40_000) },
		response: "r".repeat(40_000),
		lazy: { rules: "l".repeat(40_000), memory: {}, projects: {}, soul: {}, vision: {} },
	});
	const serialized = JSON.stringify(message);
	assert.ok(serialized.length < 32_768);
	assert.equal((serialized.match(/\\"truncated\\": true/g) ?? []).length, 5);
	assert.equal((serialized.match(/omittedChars/g) ?? []).length, 5);
	for (const key of ["rules", "memory", "projects", "soul", "vision"]) {
		assert.match(serialized, new RegExp(`\\\\"${key}\\\\"`));
	}
	for (const hostile of ['"', "\\", "\n", "🌀"]) {
		const hostileMessage = renderStateFlowRichState("effective", { global: 12, cwd: 7, session: 9 }, {
			artifacts: { huge: hostile.repeat(40_000) },
			contract: { huge: hostile.repeat(40_000) },
			working: { huge: hostile.repeat(40_000) },
			intents: { huge: hostile.repeat(40_000) },
			response: hostile.repeat(40_000),
		});
		assert.ok(JSON.stringify(hostileMessage).length < 32_768, JSON.stringify(hostile));
	}
});

test("adapter registers the section once and disposes idempotently", async () => {
	const { modules, sections, disposed } = fakeModules();
	const { port } = fakePort(snapshot({ enabled: true, revisions: { global: 2, cwd: 3, session: 4 } }));
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	assert.equal(await adapter.ensure(), true);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].id, "@llblab/pi-state-flow");
	assert.equal(await adapter.ensure(), true);
	assert.equal(sections.length, 1);
	adapter.dispose();
	assert.deepEqual(disposed, ["section:@llblab/pi-state-flow"]);
	assert.equal(await adapter.ensure(), true);
	assert.equal(sections.length, 2);
});

test("adapter fails open without a transport and retries a not-ready registry", async () => {
	const { modules, sections } = fakeModules(true);
	const { port } = fakePort(snapshot());
	let available = false;
	const adapter = createStateFlowTelegramAdapter({
		port,
		load: async () => {
			if (!available) throw new Error("pi-telegram is absent");
			return modules;
		},
	});
	assert.equal(await adapter.ensure(), false);
	assert.equal(sections.length, 0);
	available = true;
	assert.equal(await adapter.ensure(), false);
	assert.equal(sections.length, 0);
	assert.equal(await adapter.ensure(), true);
	assert.equal(sections.length, 1);
});

test("start applies immediately when idle and edits the refreshed view", async () => {
	const { modules, sections } = fakeModules();
	const { port, calls } = fakePort(snapshot());
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const { context, edits, notices } = sectionContext("start");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(calls, ["start"]);
	assert.deepEqual(notices, ["State Flow enabled"]);
	assert.equal(edits.length, 1);
	assert.match(edits[0].text, /^<b>🌀 State Flow: <code>G0\/C0\/S0<\/code><\/b>/);
});

test("start defers while a run is active and reports a pending intent", async () => {
	const { modules, sections } = fakeModules();
	const { port, calls } = fakePort(snapshot(), { canStartNow: false });
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const { context, edits, notices } = sectionContext("start");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(calls, ["deferStart"]);
	assert.deepEqual(notices, ["State Flow will start after the current turn"]);
	assert.match(edits[0].text, /^<b>🌀 State Flow: <code>off<\/code><\/b>/);
	assert.deepEqual(edits[0].replyMarkup?.inline_keyboard, [
		[{ text: "▶️ Start", callback_data: "section:0:start" }],
		[{ text: "👁 Show state", callback_data: "section:0:show-state" }],
	]);
});

test("stop routes while legacy cancel/refresh actions stay harmless", async () => {
	const { modules, sections } = fakeModules();
	const { port, calls, read } = fakePort(snapshot({ enabled: true, revisions: { global: 5, cwd: 4, session: 3 } }));
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();

	const stop = sectionContext("stop");
	assert.equal(await sections[0].handleCallback!(stop.context), "handled");
	assert.deepEqual(calls, ["stop"]);
	assert.deepEqual(stop.notices, ["State Flow disabled"]);
	assert.equal(read().enabled, false);

	const cancel = sectionContext("cancel");
	assert.equal(await sections[0].handleCallback!(cancel.context), "handled");
	assert.deepEqual(calls, ["stop", "cancelStart"]);
	assert.equal(cancel.notices[0], "Pending start cancelled");

	const refresh = sectionContext("refresh");
	assert.equal(await sections[0].handleCallback!(refresh.context), "handled");
	assert.deepEqual(calls, ["stop", "cancelStart"]);
	assert.deepEqual(refresh.notices, [undefined]);
	assert.equal(refresh.edits.length, 1);

	const unknown = sectionContext("explode");
	assert.equal(await sections[0].handleCallback!(unknown.context), "pass");
	assert.equal(unknown.edits.length, 0);
});

test("start failure surfaces the control message without corrupting the menu", async () => {
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot(), { startResult: { ok: false, message: "Selected branch revision is unavailable" } });
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const { context, edits, notices } = sectionContext("start");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(notices, ["Selected branch revision is unavailable"]);
	assert.match(edits[0].text, /^<b>🌀 State Flow: <code>off<\/code><\/b>/);
});

test("render and dynamic label always read the live snapshot", async () => {
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot());
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const section = sections[0];
	const renderContext = { callbackData: (action: string) => `cb:${action}` } as StateFlowTelegramSectionContext;
	assert.equal(section.getLabel!(), "🌀 State Flow: off");
	assert.match((await section.render(renderContext)).text, /Accepted memory remains visible in active and passive modes/);
	await port.deferStart();
	assert.equal(section.getLabel!(), "🌀 State Flow: off");
});

test("section controls drive the same branch lifecycle as the commands", async () => {
	type RegisteredSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: RegisteredSection[] = [];
	const disposed: string[] = [];
	const h = harness({
		passiveTools: true,
		telegram: {
			load: async () => ({
				sections: {
					registerTelegramSection(section) {
						sections.push(section);
						return () => disposed.push(section.id);
					},
				},
			}),
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sections.length, 1);
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const rich: unknown[] = [];
	const control = (action: string, payload = ""): StateFlowTelegramCallbackContext => ({
		action,
		payload,
		callbackData: (name: string) => `section:0:${name}`,
		edit: async () => {},
		openRich: async (message) => { rich.push(message); },
		answerCallback: async () => {},
	});
	assert.equal(await sections[0].handleCallback!(control("start")), "handled");
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(await sections[0].handleCallback!(control("stop")), "handled");
	assert.equal(h.resolveSnapshot().config.enabled, false);
	await h.tools.get("patch_state")!.execute("passive-telegram", { global: { working: { visibleWhilePassive: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(sections[0].getLabel!(), "🌀 State Flow: off");
	assert.equal(await sections[0].handleCallback!(control("inspect", "global")), "handled");
	assert.equal(await sections[0].handleCallback!(control("inspect", "effective")), "handled");
	assert.equal(rich.length, 2);
	assert.match(JSON.stringify(rich), /visibleWhilePassive/);
	assert.match(JSON.stringify(rich), /#1/);
	assert.match(JSON.stringify(rich), /G1\/C0\/S0/);
	await h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
	assert.deepEqual(disposed, ["@llblab/pi-state-flow"]);
});
