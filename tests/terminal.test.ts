import assert from "node:assert/strict";
import test from "node:test";
import {
	parseTerminalEnvelopeText,
	stateFlowProtocol,
	terminalRegenerationInstruction,
} from "../lib/terminal.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

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
	assert.ok(protocol.length <= 2_600, `protocol exceeded 2,600 characters: ${protocol.length}`);
	const bootstrapProtocol = stateFlowProtocol(true);
	assert.match(bootstrapProtocol, /BOOTSTRAP RUN/);
	assert.ok(bootstrapProtocol.length <= 2_800, `bootstrap protocol exceeded 2,800 characters: ${bootstrapProtocol.length}`);
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
