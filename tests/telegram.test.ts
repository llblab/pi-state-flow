import assert from "node:assert/strict";
import test from "node:test";
import {
	buildStateFlowSectionView,
	createStateFlowTelegramAdapter,
	formatStateFlowSectionLabel,
	formatStateFlowStatusLine,
	type StateFlowTelegramCallbackContext,
	type StateFlowTelegramModules,
	type StateFlowTelegramPort,
	type StateFlowTelegramSectionContext,
	type StateFlowTelegramSnapshot,
	type StateFlowTelegramStatusLine,
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
	const statusProviders: Array<{ id: string; provider: (ctx: { activeModel?: unknown }) => StateFlowTelegramStatusLine | undefined }> = [];
	type FakeSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: FakeSection[] = [];
	const disposed: string[] = [];
	let sectionAttempts = 0;
	const modules: StateFlowTelegramModules = {
		status: {
			registerTelegramStatusLineProvider(provider, options) {
				statusProviders.push({ id: options.id, provider });
				return () => disposed.push(`status:${options.id}`);
			},
		},
		sections: {
			registerTelegramSection(section) {
				sectionAttempts += 1;
				if (failingSections && sectionAttempts === 1) throw new Error("registry unavailable");
				sections.push(section);
				return () => disposed.push(`section:${section.id}`);
			},
		},
	};
	return { modules, statusProviders, sections, disposed };
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

test("status line mirrors the terminal step value and hides while disabled", () => {
	assert.equal(formatStateFlowStatusLine(snapshot()), undefined);
	assert.deepEqual(formatStateFlowStatusLine(snapshot({ enabled: true, step: 34 })), { label: "State Flow", value: "#34" });
	assert.deepEqual(formatStateFlowStatusLine(snapshot({ enabled: true, step: 8, bootstrap: true })), { label: "State Flow", value: "#8" });
	assert.equal(formatStateFlowStatusLine(snapshot({ startPending: true })), undefined);
});

test("section label carries the live step value and no status word", () => {
	assert.equal(formatStateFlowSectionLabel(snapshot()), "⚫️ State Flow");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, step: 7 })), "🌀 State Flow: #7");
	assert.equal(formatStateFlowSectionLabel(snapshot({ enabled: true, step: 7, bootstrap: true })), "🌀 State Flow: #7");
	assert.equal(formatStateFlowSectionLabel(snapshot({ startPending: true })), "⚫️ State Flow");
});

test("section view swaps actions with enablement and pending start", () => {
	const off = buildStateFlowSectionView(snapshot(), (action) => `cb:${action}`);
	assert.deepEqual(off.replyMarkup?.inline_keyboard[0].map(({ text, callback_data }) => [text, callback_data]), [
		["▶️ Start", "cb:start"],
		["🔄 Refresh", "cb:refresh"],
	]);
	const on = buildStateFlowSectionView(snapshot({ enabled: true, step: 3 }), (action) => `cb:${action}`);
	assert.deepEqual(on.replyMarkup?.inline_keyboard[0].map(({ text, callback_data }) => [text, callback_data]), [
		["⏹ Stop", "cb:stop"],
		["🔄 Refresh", "cb:refresh"],
	]);
	assert.match(on.text, /State iteration: <code>#3<\/code>/);
	const pending = buildStateFlowSectionView(snapshot({ startPending: true }), (action) => `cb:${action}`);
	assert.deepEqual(pending.replyMarkup?.inline_keyboard[0].map(({ text, callback_data }) => [text, callback_data]), [
		["✖️ Cancel start", "cb:cancel"],
		["🔄 Refresh", "cb:refresh"],
	]);
	assert.match(pending.text, /pending until the current turn settles/);
});

test("adapter registers both surfaces once and disposes idempotently", async () => {
	const { modules, statusProviders, sections, disposed } = fakeModules();
	const { port } = fakePort(snapshot({ enabled: true, step: 2 }));
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	assert.equal(await adapter.ensure(), true);
	assert.equal(statusProviders.length, 1);
	assert.equal(sections.length, 1);
	assert.equal(statusProviders[0].id, "@llblab/pi-state-flow");
	assert.deepEqual(statusProviders[0].provider({}), { label: "State Flow", value: "#2" });
	assert.equal(await adapter.ensure(), true);
	assert.equal(statusProviders.length, 1);
	assert.equal(sections.length, 1);
	adapter.dispose();
	assert.deepEqual(disposed, ["status:@llblab/pi-state-flow", "section:@llblab/pi-state-flow"]);
	assert.equal(await adapter.ensure(), true);
	assert.equal(statusProviders.length, 2);
	assert.equal(sections.length, 2);
});

test("adapter fails open without a transport and retries a not-ready registry", async () => {
	const { modules, statusProviders, sections } = fakeModules(true);
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
	assert.equal(statusProviders.length, 0);
	available = true;
	assert.equal(await adapter.ensure(), true);
	assert.equal(statusProviders.length, 1);
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
	assert.match(edits[0].text, /Status: <b>enabled<\/b>/);
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
	assert.match(edits[0].replyMarkup!.inline_keyboard[0][0].text, /Cancel start/);
});

test("stop, cancel, and refresh route without inventing state changes", async () => {
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
	assert.match(edits[0].text, /Status: <b>off<\/b>/);
});

test("render and dynamic label always read the live snapshot", async () => {
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot());
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const section = sections[0];
	const renderContext = { callbackData: (action: string) => `cb:${action}` } as StateFlowTelegramSectionContext;
	assert.equal(section.getLabel!(), "⚫️ State Flow");
	assert.match((await section.render(renderContext)).text, /State Flow is disabled on this session branch/);
	await port.deferStart();
	assert.equal(section.getLabel!(), "⚫️ State Flow");
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
	h.handlers.get("session_shutdown")!();
	assert.deepEqual(disposed, ["@llblab/pi-state-flow"]);
});
