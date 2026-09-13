import assert from "node:assert/strict";
import test from "node:test";
import {
	buildStateFlowSectionView,
	createStateFlowTelegramAdapter,
	formatStateFlowSectionLabel,
	type StateFlowTelegramCallbackContext,
	type StateFlowTelegramModules,
	type StateFlowTelegramPort,
	type StateFlowTelegramSectionContext,
	type StateFlowTelegramSnapshot,
	type StateFlowTelegramView,
} from "../lib/telegram.ts";
import { harness } from "./harness.ts";

function snapshot(overrides: Partial<StateFlowTelegramSnapshot> = {}): StateFlowTelegramSnapshot {
	return { enabled: false, step: 0, bootstrap: false, startPending: false, ...overrides };
}

function fakePort(initial: StateFlowTelegramSnapshot, options: { canStartNow?: boolean; startResult?: { ok: boolean; message: string } } = {}) {
	let current = initial;
	const calls: string[] = [];
	const port: StateFlowTelegramPort = {
		snapshot: () => current,
		canStartNow: () => options.canStartNow ?? true,
		start: () => {
			calls.push("start");
			const result = options.startResult ?? { ok: true, message: "State Flow enabled" };
			if (result.ok) current = { ...current, enabled: true, step: 1, startPending: false };
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

function sectionContext(action: string) {
	const edits: StateFlowTelegramView[] = [];
	const notices: Array<string | undefined> = [];
	const context = {
		action,
		payload: "",
		callbackData: (name: string) => `section:0:${name}`,
		edit: async (view: StateFlowTelegramView) => {
			edits.push(view);
		},
		answerCallback: async (text?: string) => {
			notices.push(text);
		},
	} as StateFlowTelegramCallbackContext;
	return { context, edits, notices };
}

test("section label always carries the spiral identity and the live state value", () => {
	assert.equal(formatStateFlowSectionLabel(snapshot()), "🌀 State Flow: off");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, step: 7 })), "🌀 State Flow: #7");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, step: 7, bootstrap: true })), "🌀 State Flow: #7");
	assert.equal(formatStateFlowSectionLabel(snapshot({ startPending: true })), "🌀 State Flow: off");
});

test("section view repeats the state line with one lifecycle button and no refresh or cancel", () => {
	const off = buildStateFlowSectionView(snapshot(), (action) => `cb:${action}`);
	assert.equal(
		off.text,
		"<b>🌀 State Flow: <code>off</code></b>\n\nRecords the latest accepted state after every turn, so a new session resumes from the last committed point.",
	);
	assert.deepEqual(off.replyMarkup?.inline_keyboard, [[{ text: "▶️ Start", callback_data: "cb:start" }]]);
	const on = buildStateFlowSectionView(snapshot({ enabled: true, step: 3 }), (action) => `cb:${action}`);
	assert.match(on.text, /^<b>🌀 State Flow: <code>#3<\/code><\/b>/);
	assert.deepEqual(on.replyMarkup?.inline_keyboard, [[{ text: "⏹ Stop", callback_data: "cb:stop" }]]);
	const pending = buildStateFlowSectionView(snapshot({ startPending: true }), (action) => `cb:${action}`);
	assert.match(pending.text, /^<b>🌀 State Flow: <code>off<\/code><\/b>/);
	assert.deepEqual(pending.replyMarkup?.inline_keyboard, [[{ text: "▶️ Start", callback_data: "cb:start" }]]);
});

test("adapter registers the section once and disposes idempotently", async () => {
	const { modules, sections, disposed } = fakeModules();
	const { port } = fakePort(snapshot({ enabled: true, step: 2 }));
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
	assert.match(edits[0].text, /^<b>🌀 State Flow: <code>#1<\/code><\/b>/);
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
	assert.deepEqual(edits[0].replyMarkup?.inline_keyboard, [[{ text: "▶️ Start", callback_data: "section:0:start" }]]);
});

test("stop routes while legacy cancel/refresh actions stay harmless", async () => {
	const { modules, sections } = fakeModules();
	const { port, calls, read } = fakePort(snapshot({ enabled: true, step: 5 }));
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
	assert.match((await section.render(renderContext)).text, /Records the latest accepted state after every turn/);
	await port.deferStart();
	assert.equal(section.getLabel!(), "🌀 State Flow: off");
});

test("section controls drive the same branch lifecycle as the commands", async () => {
	type RegisteredSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: RegisteredSection[] = [];
	const disposed: string[] = [];
	const h = harness({
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
	const control = (action: string): StateFlowTelegramCallbackContext => ({
		action,
		payload: "",
		callbackData: (name: string) => `section:0:${name}`,
		edit: async () => {},
		answerCallback: async () => {},
	});
	assert.equal(await sections[0].handleCallback!(control("start")), "handled");
	assert.equal(h.resolveSnapshot().config.enabled, true);
	assert.equal(await sections[0].handleCallback!(control("stop")), "handled");
	assert.equal(h.resolveSnapshot().config.enabled, false);
	await h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
	assert.deepEqual(disposed, ["@llblab/pi-state-flow"]);
});
