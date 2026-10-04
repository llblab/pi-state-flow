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
import { captureTemporalFileBases, sessionRuntimePaths } from "../lib/durable.ts";
import { emptyState } from "../lib/state.ts";
import { harness } from "./harness.ts";
import { writeGlobalState } from "./storage-fixture.ts";

function snapshot(overrides: Partial<StateFlowTelegramSnapshot> = {}): StateFlowTelegramSnapshot {
	return { mode: "off", step: 0, revisions: { global: 0, cwd: 0, session: 0 }, bootstrap: false, startPending: false, ...overrides };
}

function fakePort(initial: StateFlowTelegramSnapshot, options: { canStartNow?: boolean; startResult?: { ok: boolean; message: string } } = {}) {
	let current = initial;
	const calls: string[] = [];
	const port: StateFlowTelegramPort = {
		snapshot: () => current,
		state: () => ({ artifacts: {}, contract: {}, working: {}, intents: {}, response: "" }),
		revisions: () => current.revisions!,
		canStartNow: () => options.canStartNow ?? true,
		select: (mode) => {
			calls.push(mode);
			const result = mode === "active" && options.startResult ? options.startResult : { ok: true, message: `State Flow ${mode}` };
			if (result.ok) current = { ...current, mode, startPending: false };
			return result;
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
		callbackData: (name: string, payload?: string) => `section:0:${name}${payload ? `:${payload}` : ""}`,
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

test("main-menu section label uses the lowercase mode regardless of revisions or pending work", () => {
	for (const mode of ["off", "passive", "active"] as const) {
		for (const revisions of [undefined, { global: 15, cwd: 8, session: 31 }]) {
			assert.equal(formatStateFlowSectionLabel(snapshot({ mode, revisions, step: 7, bootstrap: true, startPending: true })), `🌀 State Flow: ${mode}`);
		}
	}
});

test("Rich headings distinguish owner revisions from the Effective vector", () => {
	const state = { artifacts: {}, contract: {}, working: {}, intents: {}, response: "" };
	const revisions = { global: 15, cwd: 8, session: 31 };
	const heading = (scope: "global" | "cwd" | "session" | "effective") => renderStateFlowRichState(scope, revisions, state).blocks[0];
	assert.deepEqual(heading("global"), { type: "heading", text: ["🌐 Global: ", { type: "code", text: "#15" }], size: 3 });
	assert.doesNotMatch(JSON.stringify(renderStateFlowRichState("global", revisions, state)), /response/);
	assert.deepEqual(heading("cwd"), { type: "heading", text: ["📂 CWD: ", { type: "code", text: "#8" }], size: 3 });
	assert.deepEqual(heading("session"), { type: "heading", text: ["💬 Session: ", { type: "code", text: "#31" }], size: 3 });
	assert.deepEqual(heading("effective"), { type: "heading", text: ["🧬 Effective: ", { type: "code", text: "g15c8s31" }], size: 3 });
});

test("section view uses capitalized radio modes with one semantic selected marker and direct scope actions", () => {
	const callbackData = (action: string, payload?: string) => `cb:${action}${payload ? `:${payload}` : ""}`;
	for (const mode of ["off", "passive", "active"] as const) {
		const view = buildStateFlowSectionView(snapshot({ mode, revisions: { global: 15, cwd: 8, session: 31 } }), callbackData);
		assert.equal(view.text, [
			`<b>🌀 State Flow:</b> <code>${mode}</code>`,
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
		].join("\n"));
		assert.deepEqual(view.replyMarkup?.inline_keyboard, [[
			{ text: `${mode === "off" ? "🟡" : "⚫️"} Off`, callback_data: "cb:off" },
			{ text: `${mode === "passive" ? "🟣" : "⚫️"} Passive`, callback_data: "cb:passive" },
			{ text: `${mode === "active" ? "🟢" : "⚫️"} Active`, callback_data: "cb:active" },
		], [
			{ text: "🌐 Global", callback_data: "cb:inspect:global" },
			{ text: "📂 CWD", callback_data: "cb:inspect:cwd" },
		], [
			{ text: "💬 Session", callback_data: "cb:inspect:session" },
			{ text: "🧬 Effective", callback_data: "cb:inspect:effective" },
		]]);
		const pending = buildStateFlowSectionView(snapshot({ mode, startPending: true }), callbackData);
		assert.deepEqual(pending, view, "pending work and revision changes do not change the menu");
	}
});

test("direct scope actions open one native Rich state tree and legacy Show state refreshes the flat menu", async () => {
	const state = { artifacts: { "/a": { description: "A" } }, contract: { rule: true }, working: {}, intents: { current: "Validate release" }, response: "Done", lazy: { memory: ["retained"] } };
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot({ mode: "active" }));
	port.state = (scope) => ({ ...state, working: { scope } });
	port.revisions = () => ({ global: 15, cwd: 8, session: 31 });
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const chooser = sectionContext("show-state");
	assert.equal(await sections[0].handleCallback!(chooser.context), "handled");
	const rendered = await sections[0].render(chooser.context);
	assert.deepEqual(chooser.edits[0], rendered, "old keyboards no longer open a nested chooser");
	assert.deepEqual(rendered.replyMarkup?.inline_keyboard.slice(1).map((row) => row.map((button) => button.callback_data)), [
		["section:0:inspect:global", "section:0:inspect:cwd"],
		["section:0:inspect:session", "section:0:inspect:effective"],
	]);
	const inspect = sectionContext("inspect", "effective");
	assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
	assert.deepEqual(inspect.richMessages, [renderStateFlowRichState("effective", { global: 15, cwd: 8, session: 31 }, { ...state, working: { scope: "effective" } })]);
	assert.deepEqual(inspect.richMessages[0]?.blocks.map((block) => block.type), ["heading", "details", "details", "details", "details", "details", "details"]);
	assert.deepEqual(inspect.richMessages[0]?.blocks[0], {
		type: "heading",
		text: ["🧬 Effective: ", { type: "code", text: "g15c8s31" }],
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
		const { port } = fakePort(snapshot({ mode: "active", revisions: { global: 99, cwd: 99, session: 99 } }));
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

for (const action of ["active", "passive", "off"] as const) test(`awaited ${action} controls acknowledge early, escape failures and discard obsolete views`, async () => {
	for (const outcome of ["accept", "reject", "revoked", "navigation", "dispose"] as const) {
		const { modules, sections } = fakeModules();
		const { port } = fakePort(snapshot({ mode: action === "active" ? "off" : "active" }));
		const receipt = new AbortController();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const control = sectionContext(action);
		const acknowledgement = `Switching State Flow to ${action}`;
		const adapter = createStateFlowTelegramAdapter({
			load: async () => modules,
			port: { ...port, inspect: () => ({ state: emptyState(), revisions: port.revisions!() }), select: async (mode) => {
				assert.equal(mode, action);
				assert.deepEqual(control.notices, [acknowledgement]);
				const result = port.select(mode);
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
		if (outcome === "accept") assert.equal(control.edits[0]!.replyMarkup?.inline_keyboard[0].filter(({ text }) => !text.startsWith("⚫️ ")).length, 1);
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

for (const superseded of [false, true]) test(`pre-runtime Telegram Passive reports only its current successful selection (superseded=${superseded})`, async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: "off", telegram: { load: async () => modules } });
	writeGlobalState({ ...emptyState(), working: { retained: "SHARED" } }, h.repositoryRoot);
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const files = () => captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const before = files();
	const release = await holdInspectionStorage(t, h.repositoryRoot);
	const passive = sectionContext("passive");
	let ended = false;
	const selecting = Promise.resolve(sections[0]!.handleCallback!(passive.context)).then(() => { ended = true; });
	await delay(40);
	assert.equal(ended, false);
	assert.deepEqual(passive.notices, ["Switching State Flow to passive"]);
	assert.equal(h.activeTools.includes("patch_state"), true);
	assert.deepEqual(h.entries.at(-1)!.data, { mode: "passive" });
	assert.deepEqual(files(), before);
	if (superseded) await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const entries = structuredClone(h.entries);
	await release();
	await selecting;
	assert.equal(h.activeTools.includes("patch_state"), !superseded);
	assert.deepEqual(files(), before, "selecting Passive must not initialize semantic storage");
	assert.deepEqual(h.entries, entries, "loading shared memory must not duplicate the native mode checkpoint");
	if (superseded) {
		assert.deepEqual(passive.edits, [], "a withdrawn operation must not present success or overwrite the new menu");
		assert.equal(h.handlers.get("context")!({ messages: [] }, h.ctx), undefined);
	} else {
		assert.equal(h.readState(0, "global").working.retained, "SHARED");
		assert.equal(passive.edits.length, 1);
		assert.equal(passive.edits[0]!.replyMarkup?.inline_keyboard[0][1].text, "🟣 Passive");
		assert.doesNotMatch(passive.edits[0]!.text, /\n\nState Flow passive$/);
		assert.doesNotMatch(passive.edits[0]!.text, /superseded|failed/);
	}
});

for (const active of [false, true]) test(`Telegram inspection awaits a current cohort without publication or private leakage (active=${active})`, async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: active ? "active" : "off", telegram: { load: async () => modules } });
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
	if (active) {
		assert.equal(inspect.edits.length, 0);
		assert.equal(inspect.richMessages.length, 1);
		const rendered = JSON.stringify(inspect.richMessages);
		for (const value of ["LATEST-G", "LATEST-C", "g1c1s1", "LOCAL"]) assert.ok(rendered.includes(value), value);
		assert.equal(rendered.includes("FOREIGN-PRIVATE"), false);
	} else {
		assert.equal(inspect.richMessages.length, 0, "shared data cannot prove an unacquired private layer is empty");
		assert.match(inspect.edits[0]!.text, /Current State Flow session memory is unavailable/);
	}
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	assert.deepEqual(h.entries, entries);
});

for (const boundary of ["stop", "off", "session_tree", "session_shutdown"] as const) test(`Telegram inspection withdraws at ${boundary} without presenting a stale owner`, { timeout: 5_000 }, async (t) => {
	let selection: Promise<unknown> | undefined;
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: "active", telegram: { load: async () => modules } });
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
		const stopping = h.commands.get("state-flow-passive")!.handler("", { ...h.ctx, signal: cancellation.signal });
		cancellation.abort();
		await stopping;
	}
	else if (boundary === "off") await h.commands.get("state-flow-off")!.handler("", h.ctx);
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
		await assert.rejects(h.tools.get("patch_state")!.execute("fenced", { session: { working: { unsafe: true } } }, undefined, undefined, h.ctx), /Memory writes paused after mode change/);
	}
});

test("Telegram Off remains responsive without acquiring publication and repeated callbacks are native-inert", { timeout: 5_000 }, async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: "active", telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const before = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot);
	const release = await holdInspectionStorage(t, h.repositoryRoot);
	const publication = t.mock.method(TemporalRuntime.prototype, "withLifecycleTransaction");
	const first = sectionContext("off");
	const stopping = sections[0].handleCallback!(first.context);
	await delay(40);
	assert.deepEqual(first.notices, ["Switching State Flow to off"]);
	assert.equal(first.edits.length, 1);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(sections[0].getLabel!(), "🌀 State Flow: off");
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), h.repositoryRoot), before);
	const repeated = sectionContext("off");
	const repeat = sections[0].handleCallback!(repeated.context);
	await delay(10);
	await release();
	await Promise.all([stopping, repeat]);
	assert.equal(publication.mock.calls.length, 0);
	assert.equal(first.edits.length, 1, "the first native choice was already accepted before the repeat");
	assert.deepEqual(repeated.notices, ["Switching State Flow to off"]);
	assert.match(repeated.edits[0]!.text, /<code>off<\/code>/);
	assert.doesNotMatch(repeated.edits[0]!.text, /\n\nState Flow off$/);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
});

for (const next of ["passive", "active", "expired"] as const) test(`Off inspection reads current private bytes without acquiring policy or replacing selected history (next=${next})`, async () => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: "active", telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await h.tools.get("patch_state")!.execute("initial", { global: { working: { global: "GLOBAL" } }, cwd: { working: { cwd: "CWD" } }, session: { working: { private: "SELECTED-OLD" } } }, undefined, undefined, h.ctx);
	const peer = new TemporalRuntime(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const peerSnapshot = h.resolveSnapshot();
	await peer.withStartTransaction((current, publish) => { assert.ok(current); publish(current); });
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const advances = next === "expired" ? 9 : 1;
	for (let index = 1; index <= advances; index++) await peer.withPatchTransaction((tx) => {
		const stage = stageAtomicScopePatches(tx.states, { session: { working: { private: `CURRENT-${index}` } } }, [], tx.causalBasis);
		commitScopedTransition(peerSnapshot, tx.states, stage, (accepted, snapshot) => tx.publish(snapshot, accepted), tx.causalBasis);
	});
	const entries = structuredClone(h.entries), files = captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot);
	for (const scope of ["global", "cwd", "session", "effective"]) {
		const inspect = sectionContext("inspect", scope);
		await sections[0].handleCallback!(inspect.context);
		assert.equal(inspect.richMessages.length, 1, scope);
		const rendered = JSON.stringify(inspect.richMessages);
		assert.ok(rendered.includes(scope === "global" ? "GLOBAL" : scope === "cwd" ? "CWD" : `CURRENT-${advances}`));
		assert.equal(rendered.includes("SELECTED-OLD"), false);
		if (scope === "effective") assert.ok(rendered.includes(`g1c1s${advances + 1}`));
		assert.throws(() => h.readState(), /temporal runtime is unavailable/, "operator reads cannot install the model cache");
	}
	assert.equal(h.activeTools.includes("read_state"), false);
	assert.equal(h.handlers.get("context")!({ messages: [] }, h.ctx), undefined);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, "harness-session", h.repositoryRoot), files);
	await h.commands.get(next === "active" ? "state-flow-active" : "state-flow-passive")!.handler("", h.ctx);
	if (next === "expired") await assert.rejects(h.tools.get("read_state")!.execute("expired", { path: "session.working.private" }), /outside the retained temporal window/);
	else assert.equal(h.readState(0, "session").working.private, next === "passive" ? "SELECTED-OLD" : "CURRENT-1");
});

for (const fault of ["missing", "malformed", "pending-fork"] as const) test(`Off private/Effective inspection rejects unproven current memory (fault=${fault})`, async () => {
	const { modules, sections } = fakeModules();
	const source = harness({ initializeRepository: false, mode: "active" });
	await source.handlers.get("session_start")!({ reason: "new" }, source.ctx);
	await source.tools.get("patch_state")!.execute("parent", { global: { working: { shared: "SHARED" } }, session: { working: { private: "FOREIGN-PRIVATE" } } }, undefined, undefined, source.ctx);
	const id = fault === "malformed" ? "harness-session" : "unacquired-child";
	const h = harness({ initializeRepository: false, cwd: source.ctx.cwd, repositoryRoot: source.repositoryRoot, sessionId: id, telegram: { load: async () => modules } });
	if (fault === "malformed") writeFileSync(sessionRuntimePaths(h.ctx.cwd, id, h.repositoryRoot).runtime, "malformed runtime");
	if (fault === "pending-fork") h.entries.push({ type: "custom", customType: "state-flow-passive-stop", data: { owner: id, memoryDeferred: true, mode: "off", forkPending: true } });
	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const files = captureTemporalFileBases(h.ctx.cwd, id, h.repositoryRoot), entries = structuredClone(h.entries);
	for (const scope of ["session", "effective"]) {
		const inspect = sectionContext("inspect", scope);
		await sections[0].handleCallback!(inspect.context);
		assert.equal(inspect.richMessages.length, 0);
		assert.equal(inspect.edits.length, 1);
		assert.doesNotMatch(JSON.stringify(inspect.edits), /FOREIGN-PRIVATE/);
	}
	const shared = sectionContext("inspect", "global");
	await sections[0].handleCallback!(shared.context);
	assert.match(JSON.stringify(shared.richMessages), /SHARED/);
	assert.throws(() => h.readState(), /temporal runtime is unavailable/);
	assert.deepEqual(h.entries, entries);
	assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, id, h.repositoryRoot), files);
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
	assert.deepEqual(h.entries.map(({ data }) => data), [{ mode: "off" }]);
});

test("Telegram can load shared state for inspection when passive model tools are disabled", async () => {
	type RegisteredSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: RegisteredSection[] = [];
	const h = harness({
		mode: "off",
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

test("Telegram Passive reports local success after CAS failure and keeps accepted cached memory inspectable", async () => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, mode: "active", telegram: { load: async () => modules } });
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
	const stop = sectionContext("passive");
	assert.equal(await sections[0].handleCallback!(stop.context), "handled");
	assert.deepEqual(stop.notices, ["Switching State Flow to passive"]);
	assert.match(stop.edits[0]!.text, /passive; memory writes paused/);
	assert.match(h.statuses.at(-1)!, /passive/);
	for (const scope of ["global", "cwd", "session", "effective"]) {
		const inspect = sectionContext("inspect", scope);
		assert.equal(await sections[0].handleCallback!(inspect.context), "handled");
		assert.equal(inspect.notices[0], "Reading State Flow memory");
		assert.match(JSON.stringify(inspect.richMessages), /stored/);
	}
	assert.deepEqual(files(), before);
});

test("Rich state inspection omits absent fields and empty responses instead of inventing placeholders", () => {
	const revisions = { global: 0, cwd: 0, session: 0 };
	for (const state of [{}, { response: "" }]) {
		assert.equal(renderStateFlowRichState("session", revisions, state).blocks.length, 1);
	}
	const visible = renderStateFlowRichState("effective", revisions, { working: { present: true }, response: "" });
	assert.equal(visible.blocks.length, 2);
	assert.match(JSON.stringify(visible), /present/);
	assert.doesNotMatch(JSON.stringify(visible), /response|artifacts|lazy/);
});

test("Rich inspection renders JSON once and keeps truncation notices outside the preview", () => {
	const revisions = { global: 1, cwd: 2, session: 3 };
	const values = [
		{ note: 'Real newline:\nQuote: " and backslash: \\ 🌀' },
		{ telegramBacklog: { plan: ["Проверить состояние"], detail: "long ".repeat(2_000) } },
		Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`key${index}`, true])),
		...['"', "\\", "\n", "🌀"].flatMap((char) => [char.repeat(900), char.repeat(40_000)]),
	];
	for (const value of values) {
		const state = { lazy: value };
		const before = structuredClone(state);
		const message = renderStateFlowRichState("effective", revisions, state);
		const field = message.blocks[1]!;
		assert.equal(field.type, "details");
		if (field.type !== "details") throw new Error("Expected details");
		const preview = field.blocks[0]!;
		assert.equal(preview.type, "pre");
		if (preview.type !== "pre" || typeof preview.text !== "string") throw new Error("Expected literal pre text");
		const json = JSON.stringify(value, null, 2);
		assert.ok(preview.text.length > 0);
		assert.equal(preview.text, json.slice(0, preview.text.length));
		assert.ok(JSON.stringify(preview.text).length <= 3_000);
		assert.doesNotMatch(preview.text, /[\uD800-\uDBFF]$/);
		if (preview.text.length === json.length) {
			assert.deepEqual(JSON.parse(preview.text), value);
			assert.equal(field.blocks.length, 1);
		} else {
			assert.deepEqual(field.blocks[1], {
				type: "pre", text: `Truncated preview — ${json.length - preview.text.length} characters omitted.`,
			});
			assert.equal(field.blocks.length, 2);
		}
		assert.deepEqual(state, before);
	}
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
	assert.equal((serialized.match(/Truncated preview — \d+ characters omitted\./g) ?? []).length, 5);
	assert.doesNotMatch(serialized, /omittedChars|\\"preview\\"/);
	assert.ok(serialized.includes('\\"rules\\"'));
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
	const { port } = fakePort(snapshot({ mode: "active", revisions: { global: 2, cwd: 3, session: 4 } }));
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
	const { context, edits, notices } = sectionContext("active");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(calls, ["active"]);
	assert.deepEqual(notices, [undefined]);
	assert.equal(edits.length, 1);
	assert.match(edits[0].text, /^<b>🌀 State Flow:<\/b>/);
	assert.equal(edits[0].replyMarkup?.inline_keyboard[0][2].text, "🟢 Active");
});

test("callback diagnostics retain long-path causes within Telegram's 200-character limit", async () => {
	const path = `/store/${"long directory/".repeat(40)}.state-flow-publication.lock`;
	for (const action of ["active", "off", "inspect"]) {
		const { modules, sections } = fakeModules();
		const { port } = fakePort(snapshot());
		const cause = new Error(`EEXIST: file already exists, open '${path}'`);
		const failure = new Error(`State Flow publication lock is unavailable at ${JSON.stringify(path)}`, { cause });
		if (action === "inspect") port.state = () => { throw failure; };
		else if (action === "off") port.select = () => { throw failure; };
		else port.select = () => ({ ok: false, message: `State Flow activation failed: ${failure.message}: ${cause.message}` });
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
	const { context, edits, notices } = sectionContext("active");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(calls, ["deferStart"]);
	assert.deepEqual(notices, ["State Flow will become active after the current turn"]);
	assert.match(edits[0].text, /^<b>🌀 State Flow:<\/b>/);
	assert.deepEqual(edits[0].replyMarkup?.inline_keyboard[0], [
		{ text: "🟡 Off", callback_data: "section:0:off" }, { text: "⚫️ Passive", callback_data: "section:0:passive" }, { text: "⚫️ Active", callback_data: "section:0:active" },
	]);
});

test("off routes while legacy start/stop/cancel/refresh actions stay harmless", async () => {
	const { modules, sections } = fakeModules();
	const { port, calls, read } = fakePort(snapshot({ mode: "active", revisions: { global: 5, cwd: 4, session: 3 } }));
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();

	const stop = sectionContext("off");
	assert.equal(await sections[0].handleCallback!(stop.context), "handled");
	assert.deepEqual(calls, ["off"]);
	assert.deepEqual(stop.notices, [undefined]);
	assert.equal(read().mode, "off");
	for (const action of ["start", "stop"]) {
		assert.equal(await sections[0].handleCallback!(sectionContext(action).context), "handled");
		assert.deepEqual(calls, ["off"], "obsolete callbacks must not silently select another mode");
	}

	const cancel = sectionContext("cancel");
	assert.equal(await sections[0].handleCallback!(cancel.context), "handled");
	assert.deepEqual(calls, ["off", "cancelStart"]);
	assert.equal(cancel.notices[0], "Pending start cancelled");

	const refresh = sectionContext("refresh");
	assert.equal(await sections[0].handleCallback!(refresh.context), "handled");
	assert.deepEqual(calls, ["off", "cancelStart"]);
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
	const { context, edits, notices } = sectionContext("active");
	assert.equal(await sections[0].handleCallback!(context), "handled");
	assert.deepEqual(notices, ["Selected branch revision is unavailable Retry after recovery"]);
	assert.match(edits[0].text, /^<b>🌀 State Flow:<\/b>/);
	assert.equal(edits[0].replyMarkup?.inline_keyboard[0][0].text, "🟡 Off");
});

test("render and dynamic label always read the live snapshot", async () => {
	const { modules, sections } = fakeModules();
	const { port } = fakePort(snapshot());
	const adapter = createStateFlowTelegramAdapter({ port, load: async () => modules });
	await adapter.ensure();
	const section = sections[0];
	const renderContext = { callbackData: (action: string) => `cb:${action}` } as StateFlowTelegramSectionContext;
	assert.equal(section.getLabel!(), "🌀 State Flow: off");
	assert.equal((await section.render(renderContext)).replyMarkup?.inline_keyboard[0][0].text, "🟡 Off");
	await port.deferStart();
	assert.equal(section.getLabel!(), "🌀 State Flow: off");
});

test("Start presentation revokes a completed failure when selection changes during callback acknowledgement", async (t) => {
	const { modules, sections } = fakeModules();
	const h = harness({ initializeRepository: false, telegram: { load: async () => modules } });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await delay(0);
	t.mock.method(TemporalRuntime.prototype, "withStartTransaction", async () => { throw new Error("old Start failure"); });
	const control = sectionContext("active");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	control.context.answerCallback = async (notice) => { control.notices.push(notice); await gate; };
	const pending = sections[0]!.handleCallback!(control.context);
	await delay(0);
	assert.match(h.notifications.at(-1)!, /activation failed: old Start failure/);
	await h.handlers.get("session_tree")!({}, h.ctx);
	release();
	assert.equal(await pending, "handled");
	assert.deepEqual(control.notices, ["Switching State Flow to active"]);
	assert.deepEqual(control.edits, [], "a completed failure belongs to its original selection, not the later menu");
});

test("section controls drive the same branch lifecycle as the commands", async () => {
	type RegisteredSection = Parameters<NonNullable<StateFlowTelegramModules["sections"]>["registerTelegramSection"]>[0];
	const sections: RegisteredSection[] = [];
	const disposed: string[] = [];
	const h = harness({
		mode: "passive",
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
	assert.equal(await sections[0].handleCallback!(control("active")), "handled");
	assert.equal(h.resolveSnapshot().config.mode, "active");
	assert.equal(sections[0].getLabel!(), "🌀 State Flow: active");
	assert.equal(await sections[0].handleCallback!(control("passive")), "handled");
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	await h.tools.get("patch_state")!.execute("passive-telegram", { global: { working: { visibleWhilePassive: true } } }, undefined, undefined, h.ctx);
	assert.notEqual(h.resolveSnapshot().config.mode, "active");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(sections[0].getLabel!(), "🌀 State Flow: passive");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>passive</dim>");
	assert.equal(await sections[0].handleCallback!(control("inspect", "global")), "handled");
	assert.equal(await sections[0].handleCallback!(control("inspect", "effective")), "handled");
	assert.equal(rich.length, 2);
	assert.match(JSON.stringify(rich), /visibleWhilePassive/);
	assert.match(JSON.stringify(rich), /#1/);
	assert.match(JSON.stringify(rich), /g1c0s0/);
	await h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
	assert.deepEqual(disposed, ["@llblab/pi-state-flow"]);
});
