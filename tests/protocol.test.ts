import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { finalizedAssistantResponse, formatPatchStateArguments, stateFlowProtocol } from "../lib/protocol.ts";

test("protocol names patch_state as the sole semantic mutation mechanism", () => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /sole model-authored semantic mutation mechanism/);
	assert.match(protocol, /Ordinary assistant completion needs no finalization patch/);
	assert.doesNotMatch(protocol, /final:true|terminal-ineligible|fallback turn/);
	assert.match(protocol, /all supplied scopes are validated and durably accepted as one atomic transition/);
	assert.doesNotMatch(protocol, /unchanged/i);
	assert.doesNotMatch(protocol, /terminal reconciliation/i);
	assert.doesNotMatch(protocol, /final:false|false-like|truthy|falsy/i);
	assert.match(protocol, /every patch as reconciliation rather than append-only notes/);
	assert.match(protocol, /cleanup and scope reviews require an explicit user request/);
	assert.doesNotMatch(protocol, /At feature\/release\/campaign or project\/version completion/);
	assert.match(protocol, /one atomic multi-scope patch/);
	assert.match(protocol, /intents: active commitments/);
	assert.match(protocol, /Keep chosen actions/);
	assert.match(protocol, /State refs use .*\$ref.* or `\$cwd\.lazy\.plan` in text/);
	assert.match(protocol, /Resolve only when needed/);
	assert.match(protocol, /If that resolution proves a dangling state ref, fix\/drop it in owning text; never scan for broken refs/);
	for (const bootstrap of [false, true]) {
		const candidate = stateFlowProtocol(bootstrap);
		assert.ok(candidate.length <= 4_000, `${bootstrap ? "bootstrap" : "ordinary"} model protocol grew to ${candidate.length} characters`);
	}
});

test("runtime and Skill guidance preserve reported ordinary and provenance-derived Skill owners", () => {
	for (const bootstrap of [false, true]) {
		const protocol = stateFlowProtocol(bootstrap);
		const artifacts = protocol.split("\n").find((line) => line.startsWith("ARTIFACTS:"))!;
		assert.match(artifacts, /reported scope.*global\/cwd\/session/);
		assert.match(artifacts, /exact path/);
		assert.doesNotMatch(artifacts, /patch global\.artifacts/);
		assert.match(protocol, /source fingerprints/);
		assert.match(protocol, /SKILLS: Registered Skill reads/);
		assert.match(protocol, /user→global, project→cwd, temporary→session/);
		assert.match(protocol, /never blocks patches/);
	}
	const guide = readFileSync(new URL("../skills/state-flow-guide/SKILL.md", import.meta.url), "utf8");
	assert.match(guide, /reported scope/);
	assert.doesNotMatch(guide, /Ordinary artifacts need exact-path descriptions in `global\.artifacts`/);
	assert.match(guide, /one atomic multi-scope patch to relocate/);
	assert.match(guide, /user Skills target global, project Skills target CWD and temporary Skills target session/);
	assert.match(guide, /unrelated semantic patch may proceed/);
	const memory = readFileSync(new URL("../skills/state-flow-memory/SKILL.md", import.meta.url), "utf8");
	assert.match(memory, /only on explicit user request/);
	assert.doesNotMatch(memory, /or once at an active State Flow|phase-boundary curation/);
	assert.match(memory, /one atomic multi-scope `patch_state`/);
	assert.match(memory, /pending optional Skill acquisition does not block unrelated curation/);
	assert.match(memory, /External transfers require confirmed destination and write authority/);
});

test("protocol presents semantic planes in intentional intent-first order", () => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /STATE: \{"intents":\{\},"contract":\{\},"working":\{\},"artifacts":\{\},"response":"latest complete answer","lazy":\{\}\}/);
});

test("successful patch formatting separates intents and lazy sections", () => {
	const formatted = formatPatchStateArguments({ session: { intents: { ship: true }, lazy: { plan: ["test"] } } });
	assert.match(formatted, /"intents": \{/);
	assert.match(formatted, /\n\n    "lazy": \{/);
});

test("bootstrap protocol retains the reconciliation obligation through patch_state", () => {
	assert.match(stateFlowProtocol(true), /BOOTSTRAP RUN/);
	assert.match(stateFlowProtocol(true), /through patch_state/);
});

test("final response concatenates ordinary post-handler assistant text blocks", () => {
	const response = finalizedAssistantResponse({
		role: "assistant",
		content: [{ type: "text", text: "Answer" }, { type: "text", text: " continued." }],
	} as any);
	assert.equal(response, "Answer continued.");
});

test("final response requires non-empty text and no late tool call", () => {
	assert.throws(() => finalizedAssistantResponse({ role: "assistant", content: [] } as any), /non-empty/);
	assert.throws(() => finalizedAssistantResponse({ role: "assistant", content: [{ type: "toolCall" }] } as any), /tool call/);
});
