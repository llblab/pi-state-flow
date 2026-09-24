import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withStorageTransaction } from "../lib/storage.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { commitScopedTransition, stageAtomicScopePatches } from "../lib/transition.ts";
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

test("asynchronous inspection presents the captured revision with its data and revokes obsolete receipts", async () => {
	for (const outcome of ["accept", "revoked", "reject"] as const) {
		const { modules, sections } = fakeModules();
		const { port } = fakePort(snapshot({ enabled: true, revisions: { global: 99, cwd: 99, session: 99 } }));
		const controller = new AbortController();
		const state = { ...emptyState(), working: { observed: "coherent" } };
		const revisions = { global: 1, cwd: 2, session: 3 };
		const inspector = sectionContext("inspect", "effective");
		const adapter = createStateFlowTelegramAdapter({
			load: async () => modules,
			port: { ...port, inspect: async () => {
				assert.deepEqual(inspector.notices, ["Reading State Flow memory"], "acknowledge before storage can wait beyond callback lifetime");
				if (outcome === "reject") throw new Error("Inspection failed at <private&path>");
				if (outcome === "revoked") queueMicrotask(() => controller.abort(new Error("Inspection selection changed")));
				return { state, revisions, signal: controller.signal };
			} },
		});
		await adapter.ensure();
		await sections[0].handleCallback!(inspector.context);
		assert.deepEqual(inspector.notices, ["Reading State Flow memory"], "never answer an expired callback a second time");
		if (outcome === "accept") {
			assert.deepEqual(inspector.richMessages, [renderStateFlowRichState("effective", revisions, state)]);
			assert.equal(inspector.edits.length, 0);
		} else {
			assert.equal(inspector.richMessages.length, 0);
			assert.equal(inspector.edits.length, 1);
			assert.match(inspector.edits[0]!.text, outcome === "revoked" ? /Inspection selection changed/ : /Inspection failed at &lt;private&amp;path&gt;/);
			assert.match(inspector.edits[0]!.text, /\n\nInspection/);
		}
	}
});

for (const action of ["start", "stop"] as const) test(`awaited ${action} controls acknowledge early, escape failures and discard obsolete views`, async () => {
	for (const outcome of ["accept", "reject", "revoked", "navigation", "dispose"] as const) {
		const { modules, sections } = fakeModules();
		const { port } = fakePort(snapshot({ enabled: action === "stop" }));
		const receipt = new AbortController();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const control = sectionContext(action);
		const acknowledgement = action === "stop" ? "Stopping State Flow" : "Starting State Flow";
		const adapter = createStateFlowTelegramAdapter({
			load: async () => modules,
			port: { ...port, inspect: () => ({ state: emptyState(), revisions: port.revisions!() }), [action]: async () => {
				assert.deepEqual(control.notices, [acknowledgement]);
				const result = port[action]();
				await gate;
				if (outcome === "reject") throw new Error("Control failed at <private&path>");
				if (outcome === "revoked") queueMicrotask(() => receipt.abort());
				return { ...result, signal: receipt.signal };
			} },
		});
		await adapter.ensure();
		const pending = sections[0].handleCallback!(control.context);
		await delay(10);
		assert.deepEqual(control.notices, [acknowledgement]);
		assert.equal(control.edits.length, 0);
		if (outcome === "navigation") await sections[0].handleCallback!(sectionContext("show-state").context);
		if (outcome === "dispose") adapter.dispose();
		release();
		await pending;
		assert.deepEqual(control.notices, [acknowledgement], "never answer an expired callback again");
		assert.equal(control.edits.length, outcome === "accept" || outcome === "reject" ? 1 : 0);
		if (outcome === "accept") assert.match(control.edits[0]!.text, /\n\nState Flow (enabled|disabled)$/);
		if (outcome === "reject") assert.match(control.edits[0]!.text, /\n\nControl failed at &lt;private&amp;path&gt;$/);
		adapter.dispose();
	}
});

async function holdInspectionStorage(t: TestContext, root: string) {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withStorageTransaction(root, async () => { enter(); await gate; });
	t.after(async () => { release(); await holder; });
	await entered;
	return async () => { release(); await holder; };
}

for (const active of [false, true]) test(`Telegram inspection awaits a current cohort without publication or private leakage (active=${active})`, async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, autoStart: active, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	if (active) await h.tools.get("patch_state")!.execute("private", { session: { working: { private: "LOCAL" } } }, undefined, undefined, h.ctx);
	await new TemporalRuntime(h.ctx.cwd, "peer", h.repositoryRoot).withPatchTransaction((tx) => {
		const stage = stageAtomicScopePatches(tx.states, {
			global: { working: { global: "LATEST-G" } }, cwd: { working: { cwd: "LATEST-C" } }, session: { working: { private: "FOREIGN-PRIVATE" } },
		}, [], tx.causalBasis);
		commitScopedTransition(emptySnapshot(), tx.states, stage, (accepted, next) => tx.publish(next, accepted), tx.causalBasis);
	});
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const entries = structuredClone(h.entries);
	const release = await holdInspectionStorage(t, h.repositoryRoot);
	const inspect = sectionContext("inspect", "effective");
	let ended = false;
	const pending = Promise.resolve(sections[0].handleCallback!(inspect.context)).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	assert.deepEqual(inspect.notices, ["Reading State Flow memory"]);
	assert.equal(inspect.richMessages.length, 0);
	assert.deepEqual(h.entries, entries);
	await release();
	await pending;
	assert.equal(inspect.edits.length, 0);
	assert.equal(inspect.richMessages.length, 1);
	const rendered = JSON.stringify(inspect.richMessages);
	for (const value of ["LATEST-G", "LATEST-C", `G1/C1/S${active ? 1 : 0}`]) assert.ok(rendered.includes(value), value);
	assert.equal(rendered.includes("FOREIGN-PRIVATE"), false);
	assert.equal(rendered.includes("LOCAL"), active);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
});

for (const boundary of ["stop", "session_tree", "session_shutdown"] as const) test(`Telegram inspection withdraws at ${boundary} without presenting a stale owner`, { timeout: 5_000 }, async (t) => {
	let selection: Promise<unknown> | undefined;
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, autoStart: true, passiveTools: true, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdInspectionStorage(t, h.repositoryRoot);
	const inspect = sectionContext("inspect", "effective");
	let ended = false;
	const pending = Promise.resolve(sections[0].handleCallback!(inspect.context)).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	if (boundary === "stop") {
		const cancellation = new AbortController();
		const stopping = h.commands.get("state-flow-stop")!.handler("", { ...h.ctx, signal: cancellation.signal });
		cancellation.abort();
		await stopping;
	}
	else {
		if (boundary === "session_tree") h.ctx.sessionManager.getBranch = () => [];
		selection = Promise.resolve(h.handlers.get(boundary)!({}, h.ctx));
	}
	const entries = structuredClone(h.entries);
	await Promise.race([pending, delay(1_000).then(() => assert.fail("obsolete inspection did not withdraw"))]);
	assert.equal(readFileSync(join(h.repositoryRoot, ".state-flow-publication.lock"), "utf8"), `${process.pid}\n`);
	assert.equal(inspect.richMessages.length, 0);
	if (boundary === "session_shutdown") assert.equal(inspect.edits.length, 0, "a disposed section cannot edit the old menu");
	else assert.match(inspect.edits[0]!.text, /inspection was cancelled; select the scope again/);
	assert.deepEqual(inspect.notices, ["Reading State Flow memory"]);
	await release();
	await selection;
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
	if (boundary === "stop") {
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { unsafe: true } } }, undefined, undefined, h.ctx), /Memory writes paused after Stop/);
	}
});

test("Telegram Stop remains responsive during publication waiting and repeated callbacks share one acceptance", { timeout: 5_000 }, async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, autoStart: true, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdInspectionStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "withLifecycleTransaction");
	const first = sectionContext("stop");
	const stopping = sections[0].handleCallback!(first.context);
	await delay(40);
	assert.deepEqual(first.notices, ["Stopping State Flow"]);
	assert.equal(first.edits.length, 0);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(sections[0].getLabel!(), "🌀 State Flow: off");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	const repeated = sectionContext("stop");
	const repeat = sections[0].handleCallback!(repeated.context);
	await delay(10);
	await release();
	await Promise.all([stopping, repeat]);
	assert.equal(publication.mock.calls.length, 1);
	assert.equal(first.edits.length, 0, "the newer callback owns the resulting view");
	assert.deepEqual(repeated.notices, ["Stopping State Flow"]);
	assert.match(repeated.edits[0]!.text, /<code>off<\/code>/);
	assert.match(repeated.edits[0]!.text, /\n\nState Flow disabled$/);
	assert.equal(h.resolveSnapshot().config.enabled, false);
});

test("Telegram absent or malformed memory is unavailable, never an invented empty Rich state", async () => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, telegram: { load: async () => modules } });
	rmSync(h.repositoryRoot, { recursive: true });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const missing = sectionContext("inspect", "global");
	await sections[0].handleCallback!(missing.context);
	assert.equal(existsSync(h.repositoryRoot), false);
	assert.equal(missing.richMessages.length, 0);
	assert.match(missing.edits[0]!.text, /temporal runtime is unavailable/);
	writeGlobalState(emptyState(), h.repositoryRoot);
	writeFileSync(join(h.repositoryRoot, "patches.jsonl"), "invalid\n");
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const malformed = sectionContext("inspect", "global");
	await sections[0].handleCallback!(malformed.context);
	assert.equal(malformed.richMessages.length, 0);
	assert.match(malformed.edits[0]!.text, /invalid|Invalid/);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.equal(h.entries.length, 0);
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
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const inspect = sectionContext("inspect", "global");
	assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
	assert.equal(inspect.notices[0], "Reading State Flow memory");
	assert.match(JSON.stringify(inspect.richMessages), /transportObservation/);
	assert.match(JSON.stringify(inspect.richMessages), /available/);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
});

test("Telegram Stop reports local success after CAS failure and keeps accepted cached memory inspectable", async () => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, autoStart: true, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await h.tools.get("patch_state")!.execute("remember", {
		global: { working: { storedGlobal: true } }, cwd: { working: { storedCwd: true } }, session: { working: { storedSession: true } },
	}, undefined, undefined, h.ctx);
	const peer = harness({ initializeRepository: false, repositoryRoot: h.repositoryRoot });
	peer.entries.push(...structuredClone(h.entries));
	await peer.handlers.get("session_start")!({ reason: "resume" }, peer.ctx);
	await peer.tools.get("patch_state")!.execute("peer", { session: { working: { other: true } } }, undefined, undefined, peer.ctx);
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const stop = sectionContext("stop");
	assert.equal(await sections[0].handleCallback!(stop.context), "handled");
	assert.deepEqual(stop.notices, ["Stopping State Flow"]);
	assert.match(stop.edits[0]!.text, /disabled; memory writes paused/);
	assert.equal(h.statuses.at(-1), undefined);
	for (const scope of ["global", "cwd", "session", "effective"]) {
		const inspect = sectionContext("inspect", scope);
		assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
		assert.equal(inspect.notices[0], "Reading State Flow memory");
		assert.match(JSON.stringify(inspect.richMessages), /stored/);
	}
	assert.deepEqual(files(), before);
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

test("callback diagnostics retain long-path causes within Telegram's 200-character limit", async () => {
	const path = `/store/${"long directory/".repeat(40)}.state-flow-publication.lock`;
	for (const action of ["start", "stop", "inspect"]) {
		const { modules, sections } = fakeModules();
		const { port } = fakePort(snapshot());
		const cause = new Error(`EEXIST: file already exists, open '${path}'`);
		const failure = new Error(`State Flow publication lock is unavailable at ${JSON.stringify(path)}`, { cause });
		if (action === "inspect") port.state = () => { throw failure; };
		else if (action === "stop") port.stop = () => { throw failure; };
		else port.start = () => ({ ok: false, message: `State Flow Start failed: ${failure.message}: ${cause.message}` });
		const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
		await adapter.ensure();
		const { context, notices, edits } = sectionContext(action, "session");
		assert.equal(await sections[0].handleCallback!(context), "handled");
		assert.equal(notices.length, 1);
		const text = notices[0]!;
		assert.ok(text.length <= 200 && !text.includes("\n"));
		assert.match(text, /publication lock is unavailable/);
		assert.match(text, /EEXIST: file already exists/);
		assert.match(text, /\.state-flow-publication\.lock/);
		assert.equal(edits.length, 1);
		adapter.dispose();
	}
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
	const { port } = fakePort(snapshot(), { startResult: { ok: false, message: "Selected branch revision is unavailable\n\nRetry after recovery" } });
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const { context, edits, notices } = sectionContext("start");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(notices, ["Selected branch revision is unavailable Retry after recovery"]);
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

test("Start presentation revokes a completed failure when selection changes during callback acknowledgement", async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(0);
	t.mock.method(TemporalRuntime.prototype, "withStartTransaction", async () => { throw new Error("old Start failure"); });
	const control = sectionContext("start");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	control.context.answerCallback = async (notice) => { control.notices.push(notice); await gate; };
	const pending = sections[0]!.handleCallback!(control.context);
	await delay(0);
	assert.match(h.notifications.at(-1)!, /Start failed: old Start failure/);
	await h.handlers.get("session_tree")!({}, h.ctx);
	release();
	assert.equal(await pending, "handled");
	assert.deepEqual(control.notices, ["Starting State Flow"]);
	assert.deepEqual(control.edits, [], "a completed failure belongs to its original selection, not the later menu");
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
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
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
