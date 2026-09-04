import assert from "node:assert/strict";
import test from "node:test";
import {
	parseTerminalEnvelopeText,
	parseTerminalPatch,
	stateFlowProtocol,
	terminalRegenerationInstruction,
} from "../lib/terminal.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("ordinary answers preserve content and synthesize only an empty memory patch", () => {
	const content = [
		{ type: "text", text: "  First\n", signature: "kept" },
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "\nSecond <!-- ordinary comment -->  \n" },
	];
	const parsed = parseTerminalPatch(content);
	assert.deepEqual(parsed.patch, {
		contract: {}, working: {}, response: "  First\n\nSecond <!-- ordinary comment -->  \n",
	});
	assert.strictEqual(parsed.responseContent, content);
	for (const blocks of [[], [{ type: "thinking", thinking: "only" }], [{ type: "text", text: " \n" }]]) {
		assert.throws(() => parseTerminalPatch(blocks), /must be non-empty/);
	}
});

test("malformed explicit markers never fall back to ordinary answers", () => {
	for (const text of [
		"<!-- state_flow", "<!-- state_flow invalid -->\n\nDone",
		" <!-- state_flow {} -->\n\nDone", "Example: <!-- state_flow {} -->",
		"<!--\tstate_flow {} -->\n\nDone",
	]) {
		assert.throws(() => parseTerminalPatch([{ type: "text", text }]));
	}
	assert.throws(() => parseTerminalPatch([
		{ type: "text", text: "<!-- state_" }, { type: "text", text: "flow {} -->\n\nDone" },
	]), /exactly one/);
});

test("ordinary terminal answers commit once without retries and rotate the next request", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, { durable: true }, { next: "check" });
	h.handlers.get("before_agent_start")!({ prompt: "Thanks", systemPrompt: "base" }, h.ctx);
	const result = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "You're welcome." }] },
	}, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 1);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.deepEqual(h.entries.at(-1)!.data.state, {
		contract: { durable: true }, working: { next: "check" }, response: "You're welcome.",
	});
	assert.equal(h.entries.at(-1)!.data.step, 2);
	assert.equal(h.sentMessages.length, 0);
	h.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: "base" }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.specification, "Continue");
});

test("ordinary tool-bearing prose is not treated as a terminal commit", async () => {
	const h = harness();
	await start(h);
	const message: any = toolAssistant("read-plain");
	message.content.unshift({ type: "text", text: "Checking now" });
	assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.entries.at(-1)!.data.step, 0);
	assert.equal(h.sentMessages.length, 0);
});

test("parses the terminal handoff independently from the extension runtime", () => {
	assert.deepEqual(
		parseTerminalEnvelopeText('<!-- state_flow {"contract":{"goal":"ship"},"working":{}} -->\n\nDone'),
		{ contract: { goal: "ship" }, working: {}, response: "Done" },
	);
});

test("keeps a compact protocol independent from user-controlled specifications", () => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /AUTHORITY:/);
	assert.doesNotMatch(protocol, /BOOTSTRAP RUN/);
	assert.ok(protocol.length <= 3_700, `protocol exceeded 3,700 characters: ${protocol.length}`);
	const bootstrapProtocol = stateFlowProtocol(true);
	assert.match(bootstrapProtocol, /BOOTSTRAP RUN/);
	assert.ok(bootstrapProtocol.length <= 3_900, `bootstrap protocol exceeded 3,900 characters: ${bootstrapProtocol.length}`);
});

test("requires continuation evidence and reconciliation without imposing memory metadata", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /active constraints, unresolved questions, consequential negative results, and the next discriminating check/);
		assert.match(protocol, /Distinguish observations, user requirements, decisions, and hypotheses/);
		assert.match(protocol, /never promote assistant conclusions to user requirements/);
		assert.match(protocol, /source locators and validity conditions, not metadata on every value/);
		assert.match(protocol, /rejection reasons and reconsideration conditions/);
		assert.match(protocol, /Reconcile contradictions using evidence or user clarification/);
		assert.match(protocol, /unsupported claims must not overwrite established constraints or observations/);
		assert.match(protocol, /retain decision-relevant hypotheses as uncertain/);
	}
});

test("requires targeted reality checks without claiming rollback or routine Skill rereads", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /working records last observations, not a live workspace/);
		assert.match(protocol, /Revalidate volatile facts before consequential actions/);
		assert.match(protocol, /After interruption or branch navigation, inspect relevant external effects before repeating operations/);
		assert.match(protocol, /failed state commits and restored memory do not undo tool effects/);
		assert.match(protocol, /If evidence is unavailable, retain uncertainty and the next check/);
		assert.match(protocol, /never infer success or absence of effects from missing memory/);
		assert.match(protocol, /Revalidation is targeted, not routine Skill rereading/);
	}
});

test("builds a bounded retry instruction without owning retry state", () => {
	assert.match(terminalRegenerationInstruction("invalid envelope"), /^invalid envelope\./);
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
