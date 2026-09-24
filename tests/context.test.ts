import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { createPassiveContinuation, currentRunTrajectory, lazyNavigationHint, passiveContinuationMessages, projectSystemProtocol, runtimeContextMessage } from "../lib/context.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { completeRun, startEpisode } from "../lib/episode.ts";
import { emptyState, type MaterializedState } from "../lib/state.ts";
import { commitScopedTerminal, commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

const message = (role: string, text: string, timestamp: number, customType?: string) => ({
	role,
	content: [{ type: "text", text }],
	timestamp,
	...(customType ? { customType } : {}),
}) as any;

test("refreshes only owned system protocol without mutating native frames", () => {
	for (const tailProtocol of ["OLD-TAIL", null]) for (const protocol of [undefined, "PASSIVE", "ACTIVE"]) {
		const head = { role: "system" as const, content: "FOREIGN-HEAD", sections: { state_flow: "OLD-HEAD", foreign: "KEEP" }, toolsAdded: [], timestamp: 1 };
		const request = user("USER-DATA", 2);
		const tail = { role: "system" as const, content: "FOREIGN-TAIL", sections: { state_flow: tailProtocol, foreign_tail: "KEEP-TAIL" }, toolsRemoved: [], timestamp: 3 };
		const reply = message("assistant", "UNFINISHED", 4);
		const messages: AgentMessage[] = [head, request, tail, reply];
		const before = structuredClone(messages);
		for (const frame of [head, tail]) { Object.freeze(frame.sections); Object.freeze(frame); }
		Object.freeze(messages);
		const projected = projectSystemProtocol(messages, protocol);
		const current = getCurrentSystemMessage(projected)!;
		assert.equal(current.sections?.state_flow, protocol === undefined ? undefined : `<state_flow>\n${protocol}\n</state_flow>`);
		assert.equal(current.sections?.foreign, "KEEP");
		assert.equal(current.sections?.foreign_tail, "KEEP-TAIL");
		assert.equal(current.content, "FOREIGN-HEAD\n\nFOREIGN-TAIL");
		assert.equal(projected[1], request);
		assert.equal(projected[3], reply);
		assert.deepEqual(projected.map((frame) => [frame.role, frame.timestamp]), messages.map((frame) => [frame.role, frame.timestamp]));
		assert.deepEqual(messages, before);
		assert.equal(projectSystemProtocol(projected, protocol), projected, "unchanged protocol reuses the projection");
		assert.ok(projected[0]?.role === "system" && projected[2]?.role === "system");
		assert.equal(projected[0].toolsAdded, head.toolsAdded);
		assert.equal(projected[2].toolsRemoved, tail.toolsRemoved);
	}
	const conversation = [user("No native system frame", 1)];
	assert.equal(projectSystemProtocol(conversation, "ACTIVE"), conversation, "projection must not invent native system authority");
	const alreadyCurrent: AgentMessage[] = [{ role: "system", content: "", sections: { state_flow: "<state_flow>\nACTIVE\n</state_flow>" }, timestamp: 1 }, user("request", 2), { role: "system", content: "foreign update", timestamp: 3 }];
	assert.equal(projectSystemProtocol(alreadyCurrent, "ACTIVE"), alreadyCurrent, "do not relocate an unchanged section over native deltas");
});

test("ordinary context derives compact lineage from cached runtime without Git queries", async () => {
	const h = harness();
	await start(h, "Continue");
	await commitTerminal(h, {}, { verified: true }, "Accepted");
	await h.beginRun("Continue");
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (() => { throw new Error("Ordinary inference queried a process"); }) as typeof spawn;
	syncBuiltinESMExports();
	try {
		for (let inference = 0; inference < 2; inference++) {
			const projected = h.handlers.get("context")!({ messages: [user("Continue", 1)] });
			const text = projected.messages[0].content[0].text;
			assert.match(text, /recent_transitions/);
			assert.match(text, /"verified":true/);
			assert.equal(h.readState().working.verified, true);
			assert.equal(h.readState(1).working.verified, true);
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
});

test("enabled context projects the complete overlay once in ordinary and bootstrap runs", async (t) => {
	const observations: Array<{ bootstrap: boolean; bytes: number; copies: number }> = [];
	for (const bootstrap of [false, true]) for (const bytes of [8192, 1048576]) {
		const h = harness();
		if (bootstrap) h.entries.push({ type: "message", message: user("Existing request", 1) });
		await start(h, "Current request");
		await h.tools.get("patch_state")!.execute("seed-context", {
			global: { contract: { globalContext: true } },
			cwd: { contract: { cwdContext: true } },
			session: {
				working: { contextPayload: "x".repeat(bytes) },
				intents: { current: { action: "Continue accepted work", detail: { $ref: "session.lazy.plan" } } },
				lazy: { plan: { steps: ["hidden until read"] } },
				artifacts: { "/context/source": { description: "Retained route", compilation: { decision: "Keep semantic metadata" } } },
			},
		}, undefined, undefined, h.ctx);
		const state = h.readState();
		const snapshot = h.resolveSnapshot();
		assert.equal(snapshot.meta.bootstrap === true, bootstrap);
		const entries = structuredClone(h.entries);
		const persistent = message("custom", "policy", 0, "foreign-policy");
		const old = user("Existing request", 1);
		const current = user("Current request", 2);
		const messages = [persistent, old, current];
		const originalMessages = structuredClone(messages);
		const clone = globalThis.structuredClone;
		let copies = 0;
		const observedClone = t.mock.method(globalThis, "structuredClone", <T>(value: T, options?: Parameters<typeof clone>[1]): T => {
			const candidate = value as Partial<MaterializedState> | null | undefined;
			if (candidate?.contract?.globalContext === true && candidate.contract.cwdContext === true
				&& typeof candidate.working?.contextPayload === "string") copies++;
			return clone(value, options);
		});
		let projected;
		try { projected = h.handlers.get("context")!({ messages }); }
		finally { observedClone.mock.restore(); }
		const text = projected.messages[0].content[0].text as string;
		const serialized = text.slice(text.indexOf("\n") + 1);
		const context = JSON.parse(serialized);
		assert.match(serialized, /"state":\{"intents":.*,"contract":.*,"working":.*,"artifacts":.*,"response":/);
		assert.deepEqual(context.state, state);
		assert.deepEqual(context.state.intents.current, { action: "Continue accepted work", detail: { $ref: "session.lazy.plan" } });
		assert.equal(Object.hasOwn(context.state, "lazy"), false);
		assert.deepEqual(projected.messages.slice(1), bootstrap ? [persistent, old, current] : [persistent, current]);
		context.state.working.contextPayload = "caller mutation";
		assert.deepEqual(h.readState(), state);
		assert.deepEqual(h.resolveSnapshot(), snapshot);
		assert.deepEqual(h.entries, entries);
		assert.deepEqual(messages, originalMessages);
		observations.push({ bootstrap, bytes, copies });
	}
	assert.deepEqual(observations, [false, true].flatMap((bootstrap) => [8192, 1048576].map((bytes) => ({ bootstrap, bytes, copies: 1 }))));
});

test("current run trajectory allocates no arrays of discarded ordinary history", () => {
	const observations: Array<{ pairs: number; allocatedLengths: number[]; retained: number }> = [];
	for (const pairs of [0, 200]) {
		const persistent = message("custom", "policy", 0, "foreign-policy");
		const prefix = [persistent];
		for (let index = 0; index < pairs; index++) prefix.push(user(`Old request ${index}`, index + 2), message("assistant", `Old answer ${index}`, index + 2));
		const current = user("Current request", 1000);
		const call = toolAssistant("current-read");
		const result = { role: "toolResult", toolCallId: "current-read", toolName: "read", content: [{ type: "text", text: "Current evidence" }], timestamp: 1001 } as AgentMessage;
		const foreign = message("custom", "current policy", 1002, "foreign-current");
		const steering = user("Refinement", 1003);
		const messages: AgentMessage[] = [...prefix, current, call as AgentMessage, result, foreign, steering];
		const original = structuredClone(messages);
		const allocated: AgentMessage[][] = [];
		// Observe source-derived slice/filter arrays without replacing global Array methods.
		class ObservedMessages extends Array<AgentMessage> {
			constructor(length: number) { super(length); allocated.push(this); }
		}
		Object.defineProperty(messages, "constructor", { value: { [Symbol.species]: ObservedMessages } });
		const trajectory = currentRunTrajectory(messages, "Current request", current.timestamp);
		const expected = [persistent, current, call, result, foreign, steering];
		assert.deepEqual([...trajectory.messages], expected);
		assert.ok(trajectory.messages.every((item, index) => item === expected[index]), "retained native messages must keep identity and order");
		assert.equal(trajectory.anchorTimestamp, current.timestamp);
		assert.deepEqual([...messages], original);
		observations.push({ pairs, allocatedLengths: allocated.map((items) => items.length), retained: expected.length });
	}
	assert.ok(observations.every(({ allocatedLengths, retained }) => allocatedLengths.reduce((sum, length) => sum + length, 0) <= retained), JSON.stringify(observations));
});

test("projects the current run and persistent custom context", () => {
	const persistent = message("custom", "policy", 1, "policy");
	const first = user("current", 3);
	const later = user("current", 5);
	const steering = user("refinement", 6);
	const messages = [persistent, user("old", 2), first, later, steering];
	for (const [specification, anchor, expected, timestamp] of [
		["current", 3, [persistent, first, later, steering], 3],
		["current", undefined, messages, undefined],
		["current", 99, messages, undefined],
		["current", NaN, messages, undefined],
		["current", Infinity, messages, undefined],
		["missing", 3, [persistent, first, later, steering], 3],
		["missing", undefined, messages, undefined],
		["refinement", undefined, [persistent, steering], 6],
	] as const) {
		const result = currentRunTrajectory(messages, specification, anchor);
		assert.deepEqual(result.messages, expected);
		assert.equal(result.anchorTimestamp, timestamp);
	}
	const collision = [persistent, user("old", 2), first, user("Different text at the same timestamp", 3), steering];
	assert.deepEqual(currentRunTrajectory(collision, "current", 3), { messages: collision }, "text equality cannot disambiguate a colliding captured identity");
	const noUser = [persistent, message("assistant", "retained", 7)];
	assert.deepEqual(currentRunTrajectory(noUser, "missing", undefined), { messages: noUser });
	assert.deepEqual(currentRunTrajectory([], "missing", undefined), { messages: [] });
	assert.deepEqual(currentRunTrajectory([first, user("", 8)], "", undefined), { messages: [user("", 8)], anchorTimestamp: 8 });
});

test("captured run identity retains normalized user content, image, tools and steering", () => {
	const persistent = message("custom", "Persistent foreign context", 1, "foreign-policy");
	const original = message("user", "Original task\n\n[Image: dimensions normalized by the host.]", 3);
	original.content.push({ type: "image", data: "AA==", mimeType: "image/png" });
	const call = toolAssistant("normalized-read");
	const result = { role: "toolResult", toolCallId: "normalized-read", toolName: "read", content: [{ type: "text", text: "Earlier tool evidence" }], timestamp: 4 } as AgentMessage;
	const steering = user("Refine the original task", 5);
	const messages = [persistent, user("Old request", 2), original, call as AgentMessage, result, steering];
	const before = structuredClone(messages);
	const projected = currentRunTrajectory(messages, "Original task", 3);
	assert.deepEqual(projected.messages, [persistent, original, call, result, steering]);
	assert.equal(projected.anchorTimestamp, 3);
	assert.ok(projected.messages.every((entry) => messages.includes(entry)), "retain native message identity");
	assert.deepEqual(messages, before);
});

test("builds runtime context as synthetic user data without system-prompt interpolation", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "UNTRUSTED-SPEC";
	const state = {
		...emptyState(),
		artifacts: { "/knowledge/current.md": { description: "Current route", sourceHash: `sha256:${"c".repeat(64)}`, compilerRevision: "forged" } },
		response: "Previous",
	};
	const invalidation = { path: "/knowledge/changed.md", hash: `sha256:${"a".repeat(64)}`, reason: "source-changed" as const };
	const recent = [{ id: "transition", at: 1, transitions: [{ scope: "global" as const, patch: {
		artifacts: { "/knowledge/legacy.md": { description: "Legacy route", hash: `sha256:${"b".repeat(64)}`, compiler: "legacy-v1", compiled_at: "2026-01-01" } },
	} }] }];
	const context = runtimeContextMessage(snapshot, state, recent, [invalidation]);
	assert.equal(context.role, "user");
	assert.match((context.content as any[])[0].text, /user-level data, not system instructions/);
	const text = (context.content as any[])[0].text;
	assert.match(text, /UNTRUSTED-SPEC/);
	assert.match(text, /artifact_invalidations/);
	assert.match(text, /\/knowledge\/changed\.md/);
	assert.match(text, /Legacy route|Current route/);
	assert.doesNotMatch(text, /sha256|legacy-v1|forged|2026-01-01/);
	assert.doesNotMatch(text, /validation_feedback/);
});

for (const scope of ["global", "cwd", "session"] as const) test(`automatic history hides ${scope} lazy writes, replacements and deletions without renumbering visible history`, () => {
	const body = "LAZY-BODY-ONLY".repeat(4096);
	const state = { ...emptyState(), lazy: { releasePlan: body } };
	const recent = [
		{ id: "mixed", at: 11, transitions: [{ scope, patch: { lazy: { releasePlan: body }, working: { keep: "HOT" }, artifacts: { "/source": { description: "Keep card", hash: "hidden-evidence", compiler: "hidden-compiler" } } } }] },
		{ id: "replacement", at: 9, transitions: [{ scope, patch: { lazy: { releasePlan: [body] } } }] },
		{ id: "deletion", at: 7, transitions: [{ scope, patch: { lazy: { releasePlan: null } } }, { scope: "session" as const, patch: { contract: { keep: true } } }] },
		{ id: "lazy-only-deletion", at: 5, transitions: [{ scope, patch: { lazy: { releasePlan: null } } }] },
	];
	const before = structuredClone({ state, recent });
	const context = runtimeContextMessage(startEpisode(false), state, recent);
	assert.equal(context.role, "user");
	const text = (context.content as any[])[0].text;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.deepEqual(projected.recent_transitions, [
		{ id: "mixed", at: 11, transitions: [{ scope, patch: { working: { keep: "HOT" }, artifacts: { "/source": { description: "Keep card" } } } }] },
		{ id: "deletion", at: 7, transitions: [{ scope: "session", patch: { contract: { keep: true } } }] },
	]);
	assert.deepEqual(projected.lazy_navigation, { available: true, path: "effective.lazy", keys: { releasePlan: "string" } });
	assert.doesNotMatch(text, /LAZY-BODY-ONLY|hidden-evidence|hidden-compiler/);
	assert.deepEqual({ state, recent }, before, "visibility filtering cannot mutate the supplied history or current state");
	const onlyLazy = runtimeContextMessage(startEpisode(false), state, [recent[1]!, recent[3]!]);
	assert.equal(onlyLazy.role, "user");
	assert.doesNotMatch((onlyLazy.content as any[])[0].text, /recent_transitions|LAZY-BODY-ONLY/);
});

test("automatic history filtering does not redact previously seen lazy text from specification or response", () => {
	const snapshot = startEpisode(true);
	snapshot.meta.specification = "Already communicated LAZY-BODY";
	const state = { ...emptyState(), response: "Accepted LAZY-BODY", lazy: { body: "LAZY-BODY" } };
	const recent = [{ id: "answer", at: 3, transitions: [{ scope: "session" as const, patch: { response: "Historical LAZY-BODY", lazy: { body: "LAZY-BODY" } } }] }];
	const message = runtimeContextMessage(snapshot, state, recent);
	assert.equal(message.role, "user");
	const text = (message.content as any[])[0].text;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(projected.specification, snapshot.meta.specification);
	assert.equal(projected.state.response, state.response);
	assert.deepEqual(projected.recent_transitions[0].transitions[0].patch, { response: "Historical LAZY-BODY" });
});

test("projects accepted memory without resurrecting a completed specification for boundary continuation", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "Completed original task";
	completeRun(snapshot);
	const state = { ...emptyState(), working: { accepted: true }, response: "Accepted answer", lazy: { detail: "not projected" } };
	const before = structuredClone({ snapshot, state });
	const context = runtimeContextMessage(snapshot, state);
	assert.equal(context.role, "user");
	const text = (context.content as any[])[0].text as string;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(Object.hasOwn(projected, "specification"), false);
	assert.equal(projected.state.working.accepted, true);
	assert.equal(projected.state.response, "Accepted answer");
	assert.equal(Object.hasOwn(projected.state, "lazy"), false);
	assert.doesNotMatch(text, /Completed original task|not projected/);
	assert.deepEqual({ snapshot, state }, before);
	const messages = [user("Earlier request", 1), user("Original run", 2), message("custom", "Boundary continuation", 3, "foreign-continuation")];
	assert.deepEqual(currentRunTrajectory(messages, undefined, undefined).messages, messages, "no specification or native capture must preserve available context");
	assert.deepEqual(currentRunTrajectory(messages, undefined, 2).messages, messages.slice(1), "the native run anchor remains usable without a specification");
});

test("projects bounded lazy navigation without hydrating lazy bodies or partial catalogs", () => {
	const state = { ...emptyState(), lazy: {
		memory: ["private body"], rules: { preserve: true }, enabled: false, count: 3, empty: null,
	} };
	assert.deepEqual(lazyNavigationHint(state), {
		available: true,
		path: "effective.lazy",
		keys: { memory: "array", rules: "object", enabled: "boolean", count: "number", empty: "null" },
	});
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "Navigate";
	const context = runtimeContextMessage(snapshot, state);
	const text = ((context as any).content as any[])[0].text as string;
	const projected = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.deepEqual(projected.lazy_navigation, lazyNavigationHint(state));
	assert.equal(Object.hasOwn(projected.state, "lazy"), false);
	assert.doesNotMatch(text, /private body|preserve/);

	const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]));
	assert.deepEqual(lazyNavigationHint({ ...emptyState(), lazy: tooMany }), {
		available: true, path: "effective.lazy",
	});
	assert.deepEqual(lazyNavigationHint(emptyState()), {
		available: false, path: "effective.lazy",
	});
});

test("passive projection retains the active run, later results, steering, and foreign context without completed history", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const active = message("user", "Active request", 10);
	const call = toolAssistant("pending");
	const foreign = message("custom", "Current policy", 11, "foreign-current");
	const result = { role: "toolResult", toolCallId: "pending", toolName: "read", content: [{ type: "text", text: "Late result" }], timestamp: 21 } as any;
	const steering = message("user", "Refinement", 22);
	const continuation = createPassiveContinuation(emptyState(), 20, active.timestamp);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, call], continuation), [continuation.handoff, persistent, active, foreign, call]);
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, call, result, steering], continuation), [continuation.handoff, persistent, active, foreign, call, result, steering]);
	assert.deepEqual(passiveContinuationMessages([persistent, steering], continuation), [continuation.handoff, persistent, steering], "an unavailable raw anchor must not reconstruct discarded entries");
});

for (const boundary of ["missing", "ambiguous", "nonfinite"] as const) test(`passive Stop preserves available native context for the ${boundary} active boundary`, () => {
	const persistent = message("custom", "Persistent foreign context", 1, "foreign-policy");
	const summary = { role: "compactionSummary", summary: "Native summary of the split turn", tokensBefore: 6000, timestamp: 15 } as AgentMessage;
	const call = toolAssistant("kept-read") as AgentMessage;
	const result = { role: "toolResult", toolCallId: "kept-read", toolName: "read", content: [{ type: "text", text: "Kept tool evidence" }], timestamp: 16 } as AgentMessage;
	const late = { ...result, toolCallId: "late-read", timestamp: 21 };
	const steering = user("Post-stop refinement", 22);
	const prefix = [persistent, summary, ...(boundary === "ambiguous" ? [user("One user", 10), user("Another user", 10)] : []), call, result];
	const continuation = createPassiveContinuation(emptyState(), 20, boundary === "nonfinite" ? NaN : 10);
	const beforeContinuation = structuredClone(continuation);
	for (const suffix of [[], [late], [late, steering]]) {
		const available = [...prefix, ...suffix];
		const before = structuredClone(available);
		const projected = passiveContinuationMessages(available, continuation);
		assert.deepEqual(projected, [continuation.handoff, ...available]);
		assert.ok(projected.slice(1).every((entry, index) => entry === available[index]), "preserve native message identity and order");
		assert.deepEqual(available, before);
		assert.deepEqual(continuation, beforeContinuation);
	}
});

test("unfinished compilation preserves all available native context without mutating or reconstructing messages", () => {
	const native: AgentMessage[] = [
		message("custom", "Foreign policy", 1, "foreign-policy"),
		{ role: "compactionSummary", summary: "Available native summary", tokensBefore: 5000, timestamp: 2 } as AgentMessage,
		user("Uncompiled earlier request", 3),
		message("assistant", "Uncompiled earlier result", 4),
		user("Bootstrap request", 10),
		toolAssistant("pending") as AgentMessage,
	];
	const before = structuredClone(native);
	const continuation = createPassiveContinuation(emptyState(), 20, 10, true);
	const projected = passiveContinuationMessages(native, continuation);
	assert.deepEqual(projected, [continuation.handoff, ...native]);
	assert.ok(projected.slice(1).every((entry, index) => entry === native[index]));
	assert.deepEqual(native, before);
	assert.deepEqual(passiveContinuationMessages([], continuation), [continuation.handoff]);
});

test("idle and legacy passive cutoffs retain only later conversation plus foreign custom context", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const later = message("user", "Later request", 22);
	const continuation = createPassiveContinuation(emptyState(), 20);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages(prefix, continuation), [continuation.handoff, persistent]);
	assert.deepEqual(passiveContinuationMessages([...prefix, later], continuation), [continuation.handoff, persistent, later]);
});

test("keeps existing context for one bootstrap run and commits its terminal handoff", async () => {
	const h = harness();
	h.entries.push({ type: "message", message: user("Existing goal", 1) });
	const protocol = await start(h, "Continue");
	assert.match(protocol.systemPrompt, /BOOTSTRAP RUN/);
	const projected = h.handlers.get("context")!({ messages: [user("Existing goal", 1), user("Continue", 2)] });
	assert.equal(projected.messages.length, 3);
	assert.match(projected.messages[0].content[0].text, /State Flow runtime context/);
	assert.equal(projected.messages[1].content[0].text, "Existing goal");
	assert.equal(projected.messages[2].content[0].text, "Continue");
	await commitTerminal(h, { goal: "Existing goal" }, { next: "continue" });
	const snapshot = h.entries.at(-1)!.data;
	assert.notEqual(h.resolveSnapshot(snapshot).meta.bootstrap, true);
	assert.equal(Object.hasOwn(snapshot, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		contract: { goal: "Existing goal" },
		working: { next: "continue" },
		intents: {},
		response: "Done",
		lazy: {},
	});
});
test("rotates the user-authority turn specification while retaining committed state", async () => {
	const h = harness();
	await start(h, "First request");
	await commitTerminal(h, { mode: "stable" }, { phase: "one" });
	const next = await h.beginRun("Second request");
	assert.doesNotMatch(next.systemPrompt, /First request|Second request/);
	assert.equal(h.resolveSnapshot().meta.specification, "Second request");
	const projected = h.handlers.get("context")!({
		messages: [user("First request", 1), user("Second request", 2)],
	});
	assert.match(projected.messages[0].content[0].text, /"specification":"Second request"/);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		contract: { mode: "stable" },
		working: { phase: "one" },
		intents: {},
		response: "Done",
		lazy: {},
	});
});
test("never interpolates user-controlled specification text into the system prompt", async () => {
	const h = harness();
	const prompt = "UNTRUSTED-SPEC-DO-NOT-ELEVATE";
	const started = await start(h, prompt);
	assert.equal(started.handlerResult, undefined, "protocol sections must not force the entire native prompt");
	assert.doesNotMatch(started.systemPrompt, /UNTRUSTED-SPEC-DO-NOT-ELEVATE/);
	assert.match(started.systemPromptOptions.sections.state_flow!, /State Flow is enabled/);
	const projected = h.handlers.get("context")!({ messages: [user(prompt, 1)] });
	assert.match(projected.messages[0].content[0].text, /UNTRUSTED-SPEC-DO-NOT-ELEVATE/);
});
test("supports an empty text specification for image-only prompts", async () => {
	const h = harness();
	await start(h, "");
	const projected = h.handlers.get("context")!({ messages: [user("Old text request", 1), user("", 2)] });
	assert.equal(projected.messages.length, 2);
	assert.match(projected.messages[0].content[0].text, /"specification":""/);
	assert.equal(projected.messages[1].content[0].text, "");
});
test("preserves the current run trajectory, steering, and custom extension context", async () => {
	const h = harness();
	await start(h, "Current task");
	const oldUser = user("Old task", 1);
	const currentUser = user("Current task", 2);
	const first = h.handlers.get("context")!({ messages: [oldUser, currentUser] });
	assert.equal(first.messages.length, 2);
	assert.match(first.messages[0].content[0].text, /State Flow runtime context/);
	assert.equal(first.messages[1].content[0].text, "Current task");

	const assistant = toolAssistant("read-1");
	const toolResult = {
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "Useful evidence" }],
		isError: false,
		timestamp: 3,
	};
	const steeringUser = {
		role: "user",
		content: [{ type: "text", text: "Steering refinement" }],
		timestamp: 5,
	};
	const persistentCustom = {
		role: "custom",
		customType: "persistent-policy",
		content: "Persistent extension policy",
		display: false,
		timestamp: 0,
	};
	const custom = {
		role: "custom",
		customType: "authority-gate",
		content: "DENY operation",
		display: false,
		timestamp: 4,
	};
	const second = h.handlers.get("context")!({
		messages: [persistentCustom, oldUser, currentUser, custom, assistant, steeringUser, toolResult],
	});
	assert.equal(second.messages.length, 7);
	assert.equal(second.messages[1].content, "Persistent extension policy");
	assert.equal(second.messages[2].content[0].text, "Current task");
	assert.equal(second.messages[3].content, "DENY operation");
	assert.equal(second.messages[4].content[0].type, "toolCall");
	assert.equal(second.messages[5].content[0].text, "Steering refinement");
	assert.equal(second.messages[6].content[0].text, "Useful evidence");
	assert.equal(second.messages.some((message: any) => message.content?.[0]?.text === "Old task"), false);
});
test("projects only the latest seven compact accepted transitions", async () => {
	const h = harness();
	await start(h, "Current task");
	for (let index = 0; index < 10; index++) await commitTerminal(h, {}, { index });
	await h.beginRun("Current task");
	const projected = h.handlers.get("context")!({ messages: [user("Current task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	const runtime = JSON.parse(text.slice(text.indexOf("\n") + 1));
	assert.equal(runtime.recent_transitions.length, 7);
	assert.deepEqual(
		runtime.recent_transitions.map((transition: any) => transition.transitions[0].patch.working.index),
		[3, 4, 5, 6, 7, 8, 9],
	);
	assert.equal(runtime.recent_transitions.some((transition: any) => Object.hasOwn(transition, "state")), false);
});

test("new sessions project durable causality without old conversation trajectories", async (t) => {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "state-flow-context-durable-"));
	t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
	const cwd = join(repositoryRoot, "project");
	const first = harness({ cwd, repositoryRoot });
	await start(first, "Persist project decision");
	await commitScopedTerminal(first, [{ scope: "cwd", patch: { contract: { decision: "durable" } } }], "Saved.");

	const second = harness({ cwd, repositoryRoot, sessionId: "second-session", autoStart: true });
	await second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
	await second.beginRun("Continue");
	const projected = second.handlers.get("context")!({ messages: [user("Continue", 2)] });
	const text = projected.messages[0].content[0].text as string;
	assert.match(text, /"decision":"durable"/);
	assert.doesNotMatch(text, /"recent_transitions"/); // New session origin proves no prior active transitions.
	assert.throws(() => second.readState(1), /predates the proven temporal origin/);
	assert.equal(projected.messages.some((item: any) => item.content?.[0]?.text === "Persist project decision"), false);
});

test("tree restoration selects private state while shared scopes remain proven or live", async () => {
	const h = harness();
	await start(h, "Branch task");
	const commitAll = (value: string) => commitScopedTerminal(h, [
		{ scope: "global", patch: { contract: { globalBranch: value } } },
		{ scope: "cwd", patch: { contract: { cwdBranch: value } } },
		{ scope: "session", patch: { working: { sessionBranch: value } } },
	]);
	await commitAll("base");
	const base = structuredClone(h.entries);
	await commitAll("abandoned-future");
	h.entries.splice(0, h.entries.length, ...base);
	await h.handlers.get("session_tree")!({}, h.ctx);
	await h.beginRun("Branch task");
	const projected = h.handlers.get("context")!({ messages: [user("Branch task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	const sharedSelected = text.includes('"globalBranch":"base"') && text.includes('"cwdBranch":"base"');
	const sharedLive = text.includes('"globalBranch":"abandoned-future"') && text.includes('"cwdBranch":"abandoned-future"');
	assert.equal(sharedSelected || sharedLive, true);
	assert.match(text, /"sessionBranch":"base"/);
	assert.doesNotMatch(text, /"sessionBranch":"abandoned-future"/);

	await commitTerminal(h, {}, { sessionBranch: "restored-next" });
	assert.equal(h.resolveSnapshot().meta.validation, undefined);
	assert.doesNotMatch(JSON.stringify(h.sentMessages), /cannot publish/);
	// Untouched shared scopes are adopted from the live basis while the restored session continues.
	await h.beginRun("Branch task");
	const adopted = h.handlers.get("context")!({ messages: [user("Branch task", 2)] });
	const adoptedText = adopted.messages[0].content[0].text as string;
	assert.match(adoptedText, /"globalBranch":"abandoned-future"/);
	assert.match(adoptedText, /"cwdBranch":"abandoned-future"/);
	assert.match(adoptedText, /"sessionBranch":"restored-next"/);
	assert.doesNotMatch(adoptedText, /"sessionBranch":"abandoned-future"/);
});
