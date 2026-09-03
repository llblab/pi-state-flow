import assert from "node:assert/strict";
import test from "node:test";
import { hasCompiledSkill, SkillReadTracker, skillPathFromRead } from "../lib/skills.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("recognizes only exact Skill reads", () => {
	assert.equal(skillPathFromRead("read", { path: "/skills/demo/SKILL.md" }), "/skills/demo/SKILL.md");
	assert.equal(skillPathFromRead("bash", { path: "/skills/demo/SKILL.md" }), undefined);
	assert.equal(skillPathFromRead("read", { path: "/skills/demo/README.md" }), undefined);
});

test("requires non-empty source-addressed compilations", () => {
	const source = "/skills/demo/SKILL.md";
	assert.equal(hasCompiledSkill({ compiled_skills: { [source]: { route: "demo" } } }, source), true);
	assert.equal(hasCompiledSkill({ compiled_skills: { [source]: {} } }, source), false);
});

test("tracks the mutable executed Skill path across Pi lifecycle order", () => {
	const tracker = new SkillReadTracker();
	const input = { path: "/skills/requested/SKILL.md" };
	tracker.recordStart("call-1", "read", { ...input });
	tracker.recordCall("call-1", "read", input);
	input.path = "/skills/executed/SKILL.md";
	tracker.recordEnd("call-1", "read", false);
	assert.deepEqual([...tracker.successful], ["/skills/executed/SKILL.md"]);
});

test("discards stale, failed, and mismatched lifecycle records", () => {
	const tracker = new SkillReadTracker();
	tracker.recordStart("reused", "read", { path: "/skills/stale/SKILL.md" });
	tracker.recordCall("reused", "bash", { command: "true" });
	tracker.recordEnd("reused", "read", false);
	tracker.recordCall("failed", "read", { path: "/skills/failed/SKILL.md" });
	tracker.recordEnd("failed", "read", true);
	assert.deepEqual([...tracker.successful], []);
});

test("requires every successful Skill read to compile source-identified contract rules", async () => {
	const h = harness();
	await start(h);
	const source = "/skills/example/SKILL.md";
	const input = { path: source };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({
		toolCallId: "skill-1",
		toolName: "read",
		result: {},
		isError: false,
	}, h.ctx);

	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /Every successfully read Skill must have a non-empty compilation/);
	assert.match(h.entries.at(-1)!.data.validation.error, /\/skills\/example\/SKILL\.md/);

	const compiled = {
		compiled_skills: {
			[source]: {
				routing: "Use the compiled route for current episode operations",
				constraints: ["Do not reread solely for routine activation"],
			},
		},
	};
	const accepted = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment(compiled, {})}\n\nDone` }],
		},
	}, h.ctx);
	assert.equal(accepted.message.content[0].text, "Done");
	h.handlers.get("turn_end")!({ message: accepted.message }, h.ctx);
	assert.deepEqual(h.entries.at(-1)!.data.state.contract, compiled);
});
test("attributes Skill acquisition to mutable tool input in Pi event order", async () => {
	const h = harness();
	await start(h);
	const requested = "/skills/requested/SKILL.md";
	const executed = "/skills/executed/SKILL.md";
	const input = { path: requested };
	h.handlers.get("tool_execution_start")!({
		toolCallId: "skill-1",
		toolName: "read",
		args: { path: requested },
	}, h.ctx);
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	// A later tool_call handler may rewrite the same input before execution.
	input.path = executed;
	h.handlers.get("tool_execution_end")!({
		toolCallId: "skill-1",
		toolName: "read",
		result: {},
		isError: false,
	}, h.ctx);
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{
				type: "text",
				text: `${terminalComment({ compiled_skills: { [requested]: { routing: "wrong source" } } }, {})}\n\nDone`,
			}],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /\/skills\/executed\/SKILL\.md/);
	assert.doesNotMatch(h.entries.at(-1)!.data.validation.error, /\/skills\/requested\/SKILL\.md/);
});
test("retains compatibility with execution-start updates after interception", async () => {
	const h = harness();
	await start(h);
	const requested = "/skills/requested/SKILL.md";
	const executed = "/skills/executed/SKILL.md";
	const input = { path: requested };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_start")!({
		toolCallId: "skill-1",
		toolName: "read",
		args: { path: executed },
	}, h.ctx);
	h.handlers.get("tool_execution_end")!({
		toolCallId: "skill-1",
		toolName: "read",
		result: {},
		isError: false,
	}, h.ctx);
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{
				type: "text",
				text: `${terminalComment({ compiled_skills: { [requested]: { routing: "wrong source" } } }, {})}\n\nDone`,
			}],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /\/skills\/executed\/SKILL\.md/);
	assert.doesNotMatch(h.entries.at(-1)!.data.validation.error, /\/skills\/requested\/SKILL\.md/);
});
test("does not attribute a stale read when lifecycle names disagree", async () => {
	const h = harness();
	await start(h);
	h.handlers.get("tool_execution_start")!({
		toolCallId: "reused-id",
		toolName: "read",
		args: { path: "/skills/stale/SKILL.md" },
	}, h.ctx);
	h.handlers.get("tool_call")!({
		toolCallId: "reused-id",
		toolName: "bash",
		input: { command: "true" },
	}, h.ctx);
	h.handlers.get("tool_execution_end")!({
		toolCallId: "reused-id",
		toolName: "bash",
		result: {},
		isError: false,
	}, h.ctx);
	const result = commitTerminal(h, {}, {}, "No Skill acquired.");
	assert.equal(result.message.content[0].text, "No Skill acquired.");
});
test("discards a stale read when an execution start reuses its id for another tool", async () => {
	const h = harness();
	await start(h);
	h.handlers.get("tool_execution_start")!({
		toolCallId: "reused-id",
		toolName: "read",
		args: { path: "/skills/stale/SKILL.md" },
	}, h.ctx);
	h.handlers.get("tool_execution_start")!({
		toolCallId: "reused-id",
		toolName: "bash",
		args: { command: "true" },
	}, h.ctx);
	// Even a malformed trailing event for the old read must not revive it.
	h.handlers.get("tool_execution_end")!({
		toolCallId: "reused-id",
		toolName: "read",
		result: {},
		isError: false,
	}, h.ctx);
	const result = commitTerminal(h, {}, {}, "No Skill acquired.");
	assert.equal(result.message.content[0].text, "No Skill acquired.");
});
test("falls back to intercepted input when a successful execution omits args", async () => {
	const h = harness();
	await start(h);
	const source = "/skills/fallback/SKILL.md";
	h.handlers.get("tool_call")!({
		toolCallId: "skill-1",
		toolName: "read",
		input: { path: source },
	}, h.ctx);
	h.handlers.get("tool_execution_end")!({
		toolCallId: "skill-1",
		toolName: "read",
		result: {},
		isError: false,
	}, h.ctx);

	const result = commitTerminal(h, {
		compiled_skills: { [source]: { routing: "use intercepted input fallback" } },
	}, {}, "Done");
	assert.equal(result.message.content[0].text, "Done");
});
test("does not require compilation for a failed Skill read", async () => {
	const h = harness();
	await start(h);
	const input = { path: "/skills/example/SKILL.md" };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({
		toolCallId: "skill-1",
		toolName: "read",
		result: {},
		isError: true,
	}, h.ctx);
	const result = commitTerminal(h, {}, {}, "Read failed.");
	assert.equal(result.message.content[0].text, "Read failed.");
});
