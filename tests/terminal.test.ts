import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { loadSessionMaterialization, loadSessionState } from "./temporal-fixture.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import {
	parseTerminalEnvelopeText,
	parseTerminalPatch,
	stateFlowProtocol,
	terminalRegenerationInstruction,
} from "../lib/terminal.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

function durableSession(h: ReturnType<typeof harness>) {
	return loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!;
}

test("ordinary answers preserve content and synthesize only an empty memory patch", () => {
	const content = [
		{ type: "text", text: "  First\n", signature: "kept" },
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "\nSecond <!-- ordinary comment -->  \n" },
	];
	const parsed = parseTerminalPatch(content);
	assert.deepEqual(parsed.transition, {
		transitions: [], response: "  First\n\nSecond <!-- ordinary comment -->  \n",
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
	assert.equal(h.resolveSnapshot().meta.step, 1);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	assert.deepEqual(durableSession(h), {
		artifacts: {}, contract: { durable: true }, working: { next: "check" }, response: "You're welcome.",
	});
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(h.sentMessages.length, 0);
	h.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: "base" }, h.ctx);
	assert.equal(h.resolveSnapshot().meta.specification, "Continue");
});

test("ordinary tool-bearing prose is not treated as a terminal commit", async () => {
	const h = harness();
	await start(h);
	const message: any = toolAssistant("read-plain");
	message.content.unshift({ type: "text", text: "Checking now" });
	assert.equal(h.handlers.get("message_end")!({ message }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, 0);
	assert.equal(h.sentMessages.length, 0);
});

test("parses scoped and legacy terminal handoffs independently from the extension runtime", () => {
	assert.deepEqual(
		parseTerminalEnvelopeText('<!-- state_flow {"transitions":[{"scope":"cwd","patch":{"contract":{"goal":"ship"}}}]} -->\n\nDone'),
		{ transitions: [{ scope: "cwd", patch: { contract: { goal: "ship" } } }], response: "Done" },
	);
	assert.deepEqual(
		parseTerminalEnvelopeText('<!-- state_flow {"artifacts":{},"contract":{"goal":"ship"},"working":{}} -->\n\nDone'),
		{
			transitions: [{ scope: "session", patch: { artifacts: {}, contract: { goal: "ship" }, working: {} } }],
			response: "Done",
		},
	);
});

test("keeps a compact protocol independent from user-controlled specifications", (t) => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /AUTHORITY:/);
	assert.match(protocol, /read_state with offset 0\.\.7 and scope effective\/global\/cwd\/session/);
	assert.match(protocol, /same nth prior accepted semantic boundary, not nth local patch/);
	assert.match(protocol, /Pre-origin history is unavailable, not empty/);
	assert.match(protocol, /one cached projection without mutation/);
	assert.match(protocol, /only identical complete semantic state is a no-op/);
	assert.doesNotMatch(protocol, /each Git-backed global, cwd, and session journal/);
	assert.doesNotMatch(protocol, /BOOTSTRAP RUN/);
	const bootstrapProtocol = stateFlowProtocol(true);
	assert.match(bootstrapProtocol, /BOOTSTRAP RUN/);
	t.diagnostic(`protocol characters: ordinary=${protocol.length}, bootstrap=${bootstrapProtocol.length}`);
});

test("projects State Flow as the always-enabled memory owner without changing authority", () => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /State Flow owns durable memory while enabled/);
	assert.match(protocol, /Global is always available for established cross-project\/user\/environment knowledge/);
	assert.match(protocol, /Exclude secrets, raw history, transient progress, speculative clutter, and unsupported assertions/);
	assert.match(protocol, /retain explicitly uncertain hypotheses only when they affect an open decision/);
	assert.doesNotMatch(protocol, /Never retain .*speculation/);
});

test("defines patch_state as an immediate barrier followed by terminal reconciliation", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /Use patch_state when established future-relevant information/);
		assert.match(protocol, /necessary write-and-verify step in explicitly requested curation/);
		assert.match(protocol, /not scratchpad, narration, routine progress, or speculative churn/);
		assert.match(protocol, /may contain no other executed model tool/);
		assert.match(protocol, /choose the next action from rematerialized state/);
		assert.match(protocol, /replaces the prior state projection/);
		assert.match(protocol, /Every successful enabled run ends with exactly one terminal audit after 0\.\.N intermediate patch_state barriers/);
	}
});

test("defines compact, uncertainty-preserving artifact compilation as routing rather than acquisition", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /an index or description does not mean its body was acquired or understood/);
		assert.match(protocol, /After acquiring a new or invalidated ordinary artifact/);
		assert.match(protocol, /\{"description":"What this source contains and when it is useful"\} by default/);
		assert.match(protocol, /Keep it small relative to the source/);
		assert.match(protocol, /never copy raw Markdown or summarize the full file into metadata/);
		assert.match(protocol, /contents are unavailable or unclear, preserve uncertainty and do not invent them/);
		assert.match(protocol, /Reusable operational semantics may add a compact compilation/);
	}
});

test("requires continuation evidence and reconciliation without imposing memory metadata", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /active commitments, unresolved questions, consequential results, and the exact continuation/);
		assert.match(protocol, /Distinguish user requirements, confirmed decisions, observations, assistant conclusions, and provisional methods/);
		assert.match(protocol, /silence or repeated assertion is not acceptance/);
		assert.match(protocol, /pending proposals, corrections, settled explanations, and referents for follow-up/);
		assert.match(protocol, /completed prerequisites and verified outcomes while deleting obsolete progress narration/);
		assert.match(protocol, /one failed implementation does not disprove every implementation/);
		assert.match(protocol, /one success does not establish unrestricted validity/);
		assert.match(protocol, /exact rejection reasons and known reconsideration conditions/);
		assert.match(protocol, /do not rerun an unchanged failure/);
		assert.match(protocol, /retain decision-relevant hypotheses explicitly as uncertain/);
		assert.match(protocol, /without requiring a whole-repository or all-scope audit/);
		assert.match(protocol, /validates source-version consistency, not semantic fidelity or instruction authority/);
		assert.match(protocol, /Current instructions remain controlling/);
	}
});

test("requires targeted reality checks without claiming rollback", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /working records last observations, not a live workspace/);
		assert.match(protocol, /Revalidate volatile facts before consequential actions/);
		assert.match(protocol, /After interruption or branch navigation, inspect external effects before repeating operations/);
		assert.match(protocol, /failed state commits and restored memory do not undo tool effects/);
		assert.match(protocol, /If evidence is unavailable, retain uncertainty and the next check/);
		assert.match(protocol, /never infer success or absence from missing memory/);
	}
});

test("applies one generic materialized-first acquisition policy", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		assert.match(protocol, /ACQUISITION: Start from materialized state/);
		assert.match(protocol, /concrete gap not covered by sufficient compilation/);
		assert.match(protocol, /exact source\/edit need/);
		assert.match(protocol, /evidenced invalidation, contradiction\/failure, or explicit request/);
		assert.match(protocol, /New sessions, routine recall\/activation, reassurance, and indexes\/descriptions are not read reasons/);
		assert.match(protocol, /Changed hashes require rereading/);
		assert.match(protocol, /Prefer the smallest sufficient read/);
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
	assert.deepEqual(durableSession(h), { artifacts: {}, contract: {}, working: {}, response: "" });
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
	assert.equal(durableSession(h).response, "Only response");
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
	assert.equal(durableSession(h).response, "Response modified by a later extension");
	const saved = loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot)!;
	assert.deepEqual(applyPatch({ artifacts: {}, contract: {}, working: {}, response: "" }, saved.recentTransitions[0]!.transitions[0]!.patch as JsonObject), saved.state);
});

test("identical finalized terminal state completes the runtime lifecycle without fake semantic history", async () => {
	const h = harness();
	await start(h);
	commitTerminal(h, {}, {}, "Same answer");
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	const acceptedHead = head();
	const before = loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot);
	h.handlers.get("before_agent_start")!({ prompt: "Another run", systemPrompt: "base" }, h.ctx);
	const staged = h.handlers.get("message_end")!({ message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Different draft" }],
	} }, h.ctx);
	h.handlers.get("turn_end")!({ message: { ...staged.message, content: [{ type: "text", text: "Same answer" }] } }, h.ctx);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.resolveSnapshot().meta.validation, undefined);
	assert.notEqual(head(), acceptedHead); // The new specification is runtime metadata, not semantic history.
	assert.deepEqual(loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot), before);
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
	assert.equal(durableSession(h).response, response);
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
	assert.match(prefixed.resolveSnapshot().meta.validation!.error, /must be the first content/);

	const unseparated = harness();
	await start(unseparated);
	unseparated.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\nDone` }],
		},
	}, unseparated.ctx);
	assert.match(unseparated.resolveSnapshot().meta.validation!.error, /followed by one blank line/);
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
	assert.equal(durableSession(h).response, "Visible\n\n<!-- nested action -->");
});
test("rejects unknown, duplicate, and malformed scoped transitions", () => {
	for (const value of [
		{ transitions: [{ scope: "host", patch: {} }] },
		{ transitions: [{ scope: "cwd", patch: {} }, { scope: "cwd", patch: {} }] },
		{ transitions: [{ scope: "cwd", patch: [] }] },
		{ transitions: [{ scope: "cwd" }] },
	]) {
		assert.throws(() => parseTerminalEnvelopeText(`<!-- state_flow ${JSON.stringify(value)} -->\n\nDone`));
	}
});
test("rejects attempts to patch runtime config, metadata, or response", () => {
	for (const field of ["config", "meta", "response"]) {
		const patch = JSON.stringify({ transitions: [{ scope: "session", patch: { [field]: {} } }] });
		assert.throws(
			() => parseTerminalEnvelopeText(`<!-- state_flow ${patch} -->\n\nDone`),
			/only artifacts, contract, and working are model-owned/,
		);
	}
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
	assert.match(h.resolveSnapshot().meta.validation!.error, /response body must be non-empty/);
});
