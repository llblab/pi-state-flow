import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createPassiveContinuation, currentRunTrajectory, passiveContinuationMessages, runtimeContextMessage, withoutPrivateValidation } from "../lib/context.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { startEpisode } from "../lib/episode.ts";
import { emptyState, type MaterializedState } from "../lib/state.ts";
import { commitScopedTerminal, commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

const message = (role: string, text: string, timestamp: number, customType?: string) => ({
	role,
	content: [{ type: "text", text }],
	timestamp,
	...(customType ? { customType } : {}),
}) as any;

test("ordinary context derives compact lineage from cached runtime without Git queries", async () => {
	const h = harness();
	await start(h, "Continue");
	await commitTerminal(h, {}, { verified: true }, "Accepted");
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
		const h = harness({ remotePublication: "off" });
		if (bootstrap) h.entries.push({ type: "message", message: user("Existing request", 1) });
		await start(h, "Current request");
		await h.tools.get("patch_state")!.execute("seed-context", {
			global: { contract: { globalContext: true } },
			cwd: { contract: { cwdContext: true } },
			session: { working: { contextPayload: "x".repeat(bytes) }, artifacts: {
				"/context/source": { description: "Retained route", compilation: { decision: "Keep semantic metadata" } },
			} }, final: true,
		}, undefined, undefined, h.ctx);
		const state = h.readState();
		const snapshot = h.resolveSnapshot();
		assert.equal(snapshot.meta.bootstrap === true, bootstrap);
		const entries = structuredClone(h.entries);
		const persistent = message("custom", "policy", 0, "foreign-policy");
		const old = user("Existing request", 1);
		const current = user("Current request", 2);
		const messages = [persistent, old, current, message("custom", "retry", 3, "state-flow-validation")];
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
		const context = JSON.parse(text.slice(text.indexOf("\n") + 1));
		assert.deepEqual(context.state, state);
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
		const privateFeedback = message("custom", "retry", 1, "state-flow-validation");
		const prefix = [persistent, privateFeedback];
		for (let index = 0; index < pairs; index++) prefix.push(user(`Old request ${index}`, index + 2), message("assistant", `Old answer ${index}`, index + 2));
		const current = user("Current request", 1000);
		const call = toolAssistant("current-read");
		const result = { role: "toolResult", toolCallId: "current-read", toolName: "read", content: [{ type: "text", text: "Current evidence" }], timestamp: 1001 } as AgentMessage;
		const foreign = message("custom", "current policy", 1002, "foreign-current");
		const steering = user("Refinement", 1003);
		const messages: AgentMessage[] = [...prefix, current, call as AgentMessage, result, foreign, privateFeedback, steering];
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

test("projects the current run and persistent non-private custom context", () => {
	const persistent = message("custom", "policy", 1, "policy");
	const privateFeedback = message("custom", "retry", 4, "state-flow-validation");
	const first = user("current", 3);
	const later = user("current", 5);
	const steering = user("refinement", 6);
	const messages = [persistent, user("old", 2), first, privateFeedback, later, steering];
	for (const [specification, anchor, expected, timestamp] of [
		["current", 3, [persistent, first, later, steering], 3],
		["current", undefined, [persistent, later, steering], 5],
		["current", 99, [persistent, later, steering], 5],
		["missing", 3, [persistent, steering], 6],
	] as const) {
		const result = currentRunTrajectory(messages, specification, anchor);
		assert.deepEqual(result.messages, expected);
		assert.equal(result.anchorTimestamp, timestamp);
	}
	const noUser = [privateFeedback, persistent, message("assistant", "retained", 7)];
	assert.deepEqual(currentRunTrajectory(noUser, "missing", undefined), { messages: noUser.slice(1) });
	assert.deepEqual(currentRunTrajectory([], "missing", undefined), { messages: [] });
	assert.deepEqual(currentRunTrajectory([first, user("", 8)], "", undefined), { messages: [user("", 8)], anchorTimestamp: 8 });
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
	assert.throws(() => runtimeContextMessage(startEpisode(false), emptyState()), /requires an active specification/);
});

test("removes only private State Flow validation messages", () => {
	const validation = message("custom", "retry", 1, "state-flow-validation");
	const other = message("custom", "policy", 2, "policy");
	assert.deepEqual(withoutPrivateValidation([validation, other]), [other]);
});

test("passive projection retains the active run, later results, steering, and foreign context without private feedback or completed history", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const active = message("user", "Active request", 10);
	const call = toolAssistant("pending");
	const foreign = message("custom", "Current policy", 11, "foreign-current");
	const feedback = message("custom", "Retired finalization", 12, "state-flow-validation");
	const result = { role: "toolResult", toolCallId: "pending", toolName: "read", content: [{ type: "text", text: "Late result" }], timestamp: 21 } as any;
	const steering = message("user", "Refinement", 22);
	const continuation = createPassiveContinuation(emptyState(), 20, active.timestamp);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, call], continuation), [continuation.handoff, persistent, active, foreign, call]);
	assert.deepEqual(passiveContinuationMessages([...prefix, active, foreign, feedback, call, result, steering], continuation), [continuation.handoff, persistent, active, foreign, call, result, steering]);
	assert.deepEqual(passiveContinuationMessages([persistent, steering], continuation), [continuation.handoff, persistent, steering], "a missing active anchor must not resurrect a completed prefix");
});

test("idle and legacy passive cutoffs retain only later conversation plus foreign custom context", () => {
	const persistent = message("custom", "Persistent policy", 1, "foreign-policy");
	const feedback = message("custom", "Retired finalization", 21, "state-flow-validation");
	const later = message("user", "Later request", 22);
	const continuation = createPassiveContinuation(emptyState(), 20);
	const prefix = [persistent, message("user", "Completed request", 2), message("assistant", "Completed answer", 3)];
	assert.deepEqual(passiveContinuationMessages(prefix, continuation), [continuation.handoff, persistent]);
	assert.deepEqual(passiveContinuationMessages([...prefix, later, feedback], continuation), [continuation.handoff, persistent, later]);
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
	assert.equal(h.resolveSnapshot(snapshot).meta.bootstrap, false);
	assert.equal(Object.hasOwn(snapshot, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		contract: { goal: "Existing goal" },
		working: { next: "continue" },
		response: "Done",
	});
});
test("rotates the user-authority turn specification while retaining committed state", async () => {
	const h = harness();
	await start(h, "First request");
	await commitTerminal(h, { mode: "stable" }, { phase: "one" });
	const next = h.handlers.get("before_agent_start")!({ prompt: "Second request", systemPrompt: "base" }, h.ctx);
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
		response: "Done",
	});
});
test("never interpolates user-controlled specification text into the system prompt", async () => {
	const h = harness();
	const prompt = "UNTRUSTED-SPEC-DO-NOT-ELEVATE";
	const started = await start(h, prompt);
	assert.doesNotMatch(started.systemPrompt, /UNTRUSTED-SPEC-DO-NOT-ELEVATE/);
	assert.match(started.systemPrompt, /State Flow is enabled/);
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
	second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
	second.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: "base" }, second.ctx);
	const projected = second.handlers.get("context")!({ messages: [user("Continue", 2)] });
	const text = projected.messages[0].content[0].text as string;
	assert.match(text, /"decision":"durable"/);
	assert.doesNotMatch(text, /"recent_transitions"/); // New session origin proves no prior active transitions.
	assert.throws(() => second.readState(1), /predates the proven temporal origin/);
	assert.equal(projected.messages.some((item: any) => item.content?.[0]?.text === "Persist project decision"), false);
});

test("tree restoration reads all three scopes from the linked revision", async () => {
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
	h.handlers.get("session_tree")!({}, h.ctx);
	h.handlers.get("before_agent_start")!({ prompt: "Branch task", systemPrompt: "base" }, h.ctx);
	const projected = h.handlers.get("context")!({ messages: [user("Branch task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	assert.match(text, /"globalBranch":"base"/);
	assert.match(text, /"cwdBranch":"base"/);
	assert.match(text, /"sessionBranch":"base"/);
	assert.doesNotMatch(text, /abandoned-future/);

	await commitTerminal(h, {}, { sessionBranch: "restored-next" });
	assert.equal(h.resolveSnapshot().meta.validation, undefined);
	assert.doesNotMatch(JSON.stringify(h.sentMessages), /cannot publish/);
	// Untouched shared scopes are adopted from the live basis while the restored session continues.
	h.handlers.get("before_agent_start")!({ prompt: "Branch task", systemPrompt: "base" }, h.ctx);
	const adopted = h.handlers.get("context")!({ messages: [user("Branch task", 2)] });
	const adoptedText = adopted.messages[0].content[0].text as string;
	assert.match(adoptedText, /"globalBranch":"abandoned-future"/);
	assert.match(adoptedText, /"cwdBranch":"abandoned-future"/);
	assert.match(adoptedText, /"sessionBranch":"restored-next"/);
	assert.doesNotMatch(adoptedText, /"sessionBranch":"abandoned-future"/);
});

test("removes abandoned private retry feedback from later bootstrap context", async () => {
	const h = harness();
	h.entries.push({ type: "message", message: user("Pre-Flow context", 1) });
	await start(h, "Old request");
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	h.handlers.get("before_agent_start")!({ prompt: "New request", systemPrompt: "base" }, h.ctx);
	const staleFeedback = {
		role: "custom",
		customType: "state-flow-validation",
		content: "stale retry instruction",
		display: false,
		timestamp: 3,
	};
	const projected = h.handlers.get("context")!({
		messages: [user("Pre-Flow context", 1), user("Old request", 2), staleFeedback, user("New request", 4)],
	});
	assert.equal(projected.messages.includes(staleFeedback), false);
	assert.equal(projected.messages.some((message: any) => message.content === "stale retry instruction"), false);
	assert.equal(projected.messages.some((message: any) => message.content?.[0]?.text === "Pre-Flow context"), true);
});
