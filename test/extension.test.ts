import assert from "node:assert/strict";
import test from "node:test";
import stateFlowExtension from "../index.ts";

type Handler = (...args: any[]) => any;

function harness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	let registeredTools = 0;
	const pi = {
		registerTool() { registeredTools += 1; },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { sentMessages.push({ message, options }); },
	};
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: "/tmp",
		isProjectTrusted: () => false,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			notify(message: string) { notifications.push(message); },
		},
		sessionManager: { getBranch: () => entries },
	};
	stateFlowExtension(pi as any);
	return { handlers, commands, entries, sentMessages, notifications, statuses, ctx, get registeredTools() { return registeredTools; } };
}

function user(text: string, timestamp: number) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function toolAssistant(id: string, name = "read", args: unknown = { path: "README.md" }) {
	return {
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: Date.now(),
	};
}

function terminalComment(contract: unknown, working: unknown): string {
	return `<!-- state_flow ${JSON.stringify({ contract, working })} -->`;
}

async function start(h: ReturnType<typeof harness>, prompt = "Inspect README") {
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	return h.handlers.get("before_agent_start")!({ prompt, systemPrompt: "base" }, h.ctx);
}

function commitTerminal(h: ReturnType<typeof harness>, contract: unknown, working: unknown, prose = "Done") {
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment(contract, working)}\n\n${prose}` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	return result;
}

test("registers no tools and exposes only argument-free lifecycle commands", () => {
	const h = harness();
	assert.equal(h.registeredTools, 0);
	assert.deepEqual([...h.commands.keys()], ["state-flow-start", "state-flow-stop", "state-flow-status"]);
});

test("migrates an active two-field snapshot by adding an empty response", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Continue",
			state: { contract: { goal: "keep" }, working: { phase: "active" } },
			step: 2,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	const result = commitTerminal(h, {}, {}, "Migrated.");
	assert.equal(result.message.content[0].text, "Migrated.");
	assert.deepEqual(h.entries.at(-1)!.data.state, {
		contract: { goal: "keep" },
		working: { phase: "active" },
		response: "Migrated.",
	});
});

test("keeps existing context for one bootstrap run and commits its terminal handoff", async () => {
	const h = harness();
	h.entries.push({ type: "message", message: user("Existing goal", 1) });
	const protocol = await start(h, "Continue");
	assert.match(protocol.systemPrompt, /BOOTSTRAP RUN/);
	assert.equal(h.handlers.get("context")!({ messages: [user("Existing goal", 1), user("Continue", 2)] }), undefined);
	commitTerminal(h, { goal: "Existing goal" }, { next: "continue" });
	const snapshot = h.entries.at(-1)!.data;
	assert.equal(snapshot.bootstrap, false);
	assert.deepEqual(snapshot.state, {
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
	assert.equal(h.entries.at(-1)!.data.specification, "Second request");
	const projected = h.handlers.get("context")!({
		messages: [user("First request", 1), user("Second request", 2)],
	});
	assert.match(projected.messages[0].content[0].text, /"specification":"Second request"/);
	assert.deepEqual(h.entries.at(-1)!.data.state, {
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

test("lets tool-bearing responses run without comments or intermediate state commits", async () => {
	const h = harness();
	await start(h, "Investigate");
	const beforeEntries = h.entries.length;
	const response = h.handlers.get("message_end")!({ message: toolAssistant("read-1") }, h.ctx);
	assert.equal(response, undefined);
	h.handlers.get("turn_end")!({}, h.ctx);
	assert.equal(h.entries.length, beforeEntries);
	assert.equal(h.entries.at(-1)!.data.step, 0);
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

test("attributes Skill acquisition to finalized execution arguments", async () => {
	const h = harness();
	await start(h);
	const requested = "/skills/requested/SKILL.md";
	const executed = "/skills/executed/SKILL.md";
	const input = { path: requested };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
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

test("does not demand a terminal handoff from an aborted response", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(result, undefined);
	assert.equal(h.sentMessages.length, 0);
	assert.equal(h.entries.at(-1)!.data.step, 0);
});

test("abandons an interrupted validation retry before the next user run", async () => {
	const h = harness();
	await start(h, "Old request");
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "missing handoff" }] },
	}, h.ctx);
	assert.equal(h.sentMessages.length, 1);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);

	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation, undefined);
	const next = h.handlers.get("before_agent_start")!({ prompt: "New request", systemPrompt: "base" }, h.ctx);
	assert.doesNotMatch(next.systemPrompt, /Old request|New request/);
	assert.equal(h.entries.at(-1)!.data.specification, "New request");
});

test("keeps validation attempt accounting across tool-bearing retry turns", async () => {
	const h = harness();
	await start(h);
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "missing handoff" }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	h.handlers.get("message_end")!({ message: toolAssistant("read-during-retry") }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "still missing" }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 2);
});

test("removes abandoned private retry feedback from later bootstrap context", async () => {
	const h = harness();
	h.entries.push({ type: "message", message: user("Pre-Flow context", 1) });
	await start(h, "Old request");
	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "missing handoff" }] },
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

test("strips only a structurally valid accidental intermediate envelope without committing it", async () => {
	const h = harness();
	await start(h);
	const message: any = toolAssistant("read-1");
	message.content.unshift({
		type: "text",
		text: `${terminalComment({ accidental: true }, {})}\n\nPremature response`,
	});
	const result = h.handlers.get("message_end")!({ message }, h.ctx);
	assert.equal(result.message.content.length, 2);
	assert.equal(result.message.content[0].text, "Premature response");
	assert.equal(result.message.content[1].type, "toolCall");
	assert.deepEqual(h.entries.at(-1)!.data.state, { contract: {}, working: {}, response: "" });
});

test("preserves malformed leading State Flow comments in tool-bearing messages", async () => {
	const h = harness();
	await start(h);
	const malformed = "<!-- state_flow not-json -->\n\nQuoted malformed example";
	const message: any = toolAssistant("read-1");
	message.content.unshift({ type: "text", text: malformed });
	const result = h.handlers.get("message_end")!({ message }, h.ctx);
	assert.equal(result, undefined);
	assert.equal(message.content[0].text, malformed);
});

test("preserves quoted State Flow examples inside tool-bearing messages", async () => {
	const h = harness();
	await start(h);
	const quoted = `Quoted example: ${terminalComment({ example: true }, {})}`;
	const message: any = toolAssistant("read-1");
	message.content.unshift({ type: "text", text: quoted });
	const result = h.handlers.get("message_end")!({ message }, h.ctx);
	assert.equal(result, undefined);
	assert.equal(message.content[0].text, quoted);
});

test("commits and hides one useful terminal patch after the tool loop", async () => {
	const h = harness();
	await start(h);
	const result = commitTerminal(
		h,
		{ goal: "Inspect project", compiled_rules: { read_once: true } },
		{ verified: { readme: true }, next: "run tests" },
		"Inspection complete.",
	);
	assert.equal(result.message.content[0].text, "Inspection complete.");
	const snapshot = h.entries.at(-1)!.data;
	assert.equal(snapshot.step, 1);
	assert.deepEqual(snapshot.state, {
		contract: { goal: "Inspect project", compiled_rules: { read_once: true } },
		working: { verified: { readme: true }, next: "run tests" },
		response: "Inspection complete.",
	});
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#1</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /iteration #1;[\s\S]*validation attempts 0\.\n\n\{/);
	assert.match(h.notifications.at(-1)!, /"goal": "Inspect project"/);
	assert.match(h.notifications.at(-1)!, /"next": "run tests"/);
	assert.match(h.notifications.at(-1)!, /"response": "Inspection complete\."/);
});

test("captures the single outside response into materialized state", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nOnly response` }],
		},
	}, h.ctx);
	assert.equal(result.message.content[0].text, "Only response");
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.state.response, "Only response");
});

test("reconciles response state with the finalized message after later handlers", async () => {
	const h = harness();
	await start(h);
	const staged = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nOriginal response` }],
		},
	}, h.ctx);
	const finalized = {
		...staged.message,
		content: [
			{ type: "text", text: "Response modified " },
			{ type: "thinking", thinking: "not user-facing" },
			{ type: "text", text: "by a later extension" },
		],
	};
	h.handlers.get("turn_end")!({ message: finalized }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.state.response, "Response modified by a later extension");
});

test("regenerates when a later handler removes the finalized response", async () => {
	const h = harness();
	await start(h);
	const staged = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nOriginal response` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: { ...staged.message, content: [] } }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	assert.equal(h.entries.at(-1)!.data.step, 0);
	assert.equal(h.sentMessages.length, 1);

	h.handlers.get("message_end")!({ message: toolAssistant("retry-tool") }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.validation.attempt, 1);
	const recovered = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nRecovered response` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: recovered.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 1);
	assert.equal(h.entries.at(-1)!.data.validation, undefined);
	assert.equal(h.entries.at(-1)!.data.state.response, "Recovered response");
});

test("preserves response whitespace exactly while removing only the terminal envelope", async () => {
	const h = harness();
	await start(h);
	const response = "  indented Markdown\n\ntrailing spaces  \n";
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\n${response}` }],
		},
	}, h.ctx);
	assert.equal(result.message.content[0].text, response);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.state.response, response);
});

test("rejects terminal envelopes that are not top-level or lack one blank separator", async () => {
	const prefixed = harness();
	await start(prefixed);
	prefixed.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `prefix ${terminalComment({}, {})}\n\nDone` }],
		},
	}, prefixed.ctx);
	assert.match(prefixed.entries.at(-1)!.data.validation.error, /must be the first content/);

	const unseparated = harness();
	await start(unseparated);
	unseparated.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\nDone` }],
		},
	}, unseparated.ctx);
	assert.match(unseparated.entries.at(-1)!.data.validation.error, /followed by one blank line/);
});

test("preserves arbitrary comment text in the outside response", async () => {
	const h = harness();
	await start(h);
	const carrier = `${terminalComment({}, {})}\n\nVisible\n\n<!-- nested action -->`;
	const result = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: carrier }] },
	}, h.ctx);
	assert.equal(result.message.content[0].text, "Visible\n\n<!-- nested action -->");
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.state.response, "Visible\n\n<!-- nested action -->");
});

test("requires both memory patch fields", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: '<!-- state_flow {"working":{}} -->\n\nDone' }],
		},
	}, h.ctx);
	assert.deepEqual(result.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /must contain exactly "contract" and "working"/);
});

test("requires a non-empty response body", async () => {
	const h = harness();
	await start(h);
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\n   ` }],
		},
	}, h.ctx);
	assert.deepEqual(result.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /response body must be non-empty/);
});

test("accepts unchanged contract and working memory when the run produced no durable information", async () => {
	const h = harness();
	const started = await start(h);
	assert.match(started.systemPrompt, /SKILL COMPILATION/);
	assert.match(started.systemPrompt, /After a successful SKILL\.md read/);
	assert.match(started.systemPrompt, /contract\.compiled_skills\[exact read path\]/);
	assert.match(started.systemPrompt, /MUST NOT reread for recall or routine activation/);
	assert.match(started.systemPrompt, /Mere possibility of change is not evidence/);
	assert.match(started.systemPrompt, /MEMORY OPTIMIZATION/);
	assert.match(started.systemPrompt, /Never invent a change; use \{\} when nothing future-relevant changed/);
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nDone` }],
		},
	}, h.ctx);
	assert.equal(result.message.content[0].text, "Done");
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 1);
	assert.deepEqual(h.entries.at(-1)!.data.state, { contract: {}, working: {}, response: "Done" });
});

test("uses nested null as deletion and rejects materialized null data", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { mode: "test" }, { move: "e2-e4", result: "pending" });
	commitTerminal(h, {}, { move: null, result: "ok" });
	assert.deepEqual(h.entries.at(-1)!.data.state, {
		contract: { mode: "test" },
		working: { result: "ok" },
		response: "Done",
	});
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, { cells: ["pawn", null] })}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.entries.at(-1)!.data.validation.error, /Materialized state cannot contain null/);
});

test("regenerates invalid terminal responses and disables after the retry limit", async () => {
	const h = harness();
	await start(h);
	for (let attempt = 0; attempt < 4; attempt++) {
		const rejected = h.handlers.get("message_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "missing handoff" }] },
		}, h.ctx);
		assert.deepEqual(rejected.message.content, []);
		h.handlers.get("turn_end")!({}, h.ctx);
	}
	assert.equal(h.sentMessages.length, 3);
	assert.match(h.notifications.at(-1)!, /disabled after 3 automatic regeneration attempts/);
	assert.equal(h.entries.at(-1)!.data.enabled, false);
});

test("restores State Flow from the active branch after tree navigation", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { branch: "abandoned" }, { next: "old" });
	h.entries.splice(0, h.entries.length, {
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Branch request",
			state: {
				contract: { branch: "active" },
				working: { next: "new" },
				response: "Branch response",
			},
			step: 4,
		},
	});
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#4</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"branch": "active"/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"branch": "abandoned"/);

	h.entries.splice(0, h.entries.length);
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /State Flow disabled; iteration #0/);
});

test("stop disables State Flow and clears the complete episode", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { goal: "x" }, { next: "y" });
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	assert.deepEqual(h.entries.at(-1)!.data, {
		enabled: false,
		state: { contract: {}, working: {}, response: "" },
		step: 0,
	});
	assert.equal(h.statuses.at(-1), undefined);
});
