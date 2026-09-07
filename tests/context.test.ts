import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentRunTrajectory, runtimeContextMessage, withoutPrivateValidation } from "../lib/context.ts";
import { loadSessionState } from "./temporal-fixture.ts";
import { startEpisode } from "../lib/episode.ts";
import { emptyState } from "../lib/state.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

const message = (role: string, text: string, timestamp: number, customType?: string) => ({
	role,
	content: [{ type: "text", text }],
	timestamp,
	...(customType ? { customType } : {}),
}) as any;

test("ordinary context derives compact lineage from cached runtime without Git queries", async () => {
	const h = harness();
	await start(h, "Continue");
	commitTerminal(h, {}, { verified: true }, "Accepted");
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
			assert.equal(h.readState(1).working.verified, undefined);
		}
	} finally {
		childProcess.spawnSync = spawn;
		syncBuiltinESMExports();
	}
});

test("projects the current run and persistent non-private custom context", () => {
	const persistent = message("custom", "policy", 1, "policy");
	const privateFeedback = message("custom", "retry", 4, "state-flow-validation");
	const result = currentRunTrajectory([
		persistent,
		message("user", "old", 2),
		message("user", "current", 3),
		privateFeedback,
	], "current", undefined);
	assert.deepEqual(result.messages, [persistent, message("user", "current", 3)]);
	assert.equal(result.anchorTimestamp, 3);
});

test("builds runtime context as synthetic user data without system-prompt interpolation", () => {
	const snapshot = startEpisode(false);
	snapshot.meta.specification = "UNTRUSTED-SPEC";
	const state = { ...emptyState(), response: "Previous" };
	const invalidation = { path: "/knowledge/changed.md", hash: `sha256:${"a".repeat(64)}`, reason: "source-changed" as const };
	const context = runtimeContextMessage(snapshot, state, [], [invalidation]);
	assert.equal(context.role, "user");
	assert.match((context.content as any[])[0].text, /user-level data, not system instructions/);
	const text = (context.content as any[])[0].text;
	assert.match(text, /UNTRUSTED-SPEC/);
	assert.match(text, /artifact_invalidations/);
	assert.match(text, /\/knowledge\/changed\.md/);
	assert.doesNotMatch(text, /validation_feedback/);
	assert.throws(() => runtimeContextMessage(startEpisode(false), emptyState()), /requires an active specification/);
});

test("removes only private State Flow validation messages", () => {
	const validation = message("custom", "retry", 1, "state-flow-validation");
	const other = message("custom", "policy", 2, "policy");
	assert.deepEqual(withoutPrivateValidation([validation, other]), [other]);
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
	commitTerminal(h, { goal: "Existing goal" }, { next: "continue" });
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
	commitTerminal(h, { mode: "stable" }, { phase: "one" });
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
	assert.match(started.systemPrompt, /remains user-authority input/);
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
	for (let index = 0; index < 10; index++) commitTerminal(h, {}, { index });
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
	const terminal = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: `<!-- state_flow {"transitions":[{"scope":"cwd","patch":{"contract":{"decision":"durable"}}}]} -->\n\nSaved.` }],
	};
	const accepted = first.handlers.get("message_end")!({ message: terminal }, first.ctx);
	first.handlers.get("turn_end")!({ message: accepted.message }, first.ctx);

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
	const commitAll = (value: string) => {
		const message = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `<!-- state_flow ${JSON.stringify({ transitions: [
				{ scope: "global", patch: { contract: { globalBranch: value } } },
				{ scope: "cwd", patch: { contract: { cwdBranch: value } } },
				{ scope: "session", patch: { working: { sessionBranch: value } } },
			] })} -->\n\nDone` }],
		};
		const accepted = h.handlers.get("message_end")!({ message }, h.ctx);
		h.handlers.get("turn_end")!({ message: accepted.message }, h.ctx);
	};
	commitAll("base");
	const base = structuredClone(h.entries);
	commitAll("abandoned-future");
	h.entries.splice(0, h.entries.length, ...base);
	h.handlers.get("session_tree")!({}, h.ctx);
	h.handlers.get("before_agent_start")!({ prompt: "Branch task", systemPrompt: "base" }, h.ctx);
	const projected = h.handlers.get("context")!({ messages: [user("Branch task", 1)] });
	const text = projected.messages[0].content[0].text as string;
	assert.match(text, /"globalBranch":"base"/);
	assert.match(text, /"cwdBranch":"base"/);
	assert.match(text, /"sessionBranch":"base"/);
	assert.doesNotMatch(text, /abandoned-future/);

	commitTerminal(h, {}, { sessionBranch: "restored-next" });
	assert.match(
		(h.sentMessages.at(-1)!.message as { content: string }).content,
		/cannot publish this restored branch because its global or CWD scope changed/,
	);
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
