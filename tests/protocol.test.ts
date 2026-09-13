import assert from "node:assert/strict";
import test from "node:test";
import { finalizedAssistantResponse, stateFlowProtocol } from "../lib/protocol.ts";

test("protocol names patch_state as the sole semantic mutation mechanism", () => {
	const protocol = stateFlowProtocol(false);
	assert.match(protocol, /sole model-authored semantic mutation mechanism/);
	assert.match(protocol, /\{"final":true\}/);
	assert.match(protocol, /starts terminal-ineligible/);
	assert.match(protocol, /all supplied scopes are validated and durably accepted as one atomic transition/);
	assert.doesNotMatch(protocol, /unchanged/i);
	assert.doesNotMatch(protocol, /state_flow/);
	assert.doesNotMatch(protocol, /terminal reconciliation/i);
	assert.doesNotMatch(protocol, /final:false|false-like|truthy|falsy/i);
	assert.match(protocol, /every patch as reconciliation rather than append-only notes/);
	assert.match(protocol, /feature\/release\/campaign closes or the active project\/version changes/);
	assert.match(protocol, /destination-verify-source-delete/);
});

test("bootstrap protocol retains the migration obligation through patch_state", () => {
	assert.match(stateFlowProtocol(true), /BOOTSTRAP RUN/);
	assert.match(stateFlowProtocol(true), /through patch_state/);
});

test("final response is ordinary post-handler assistant text without State Flow comment parsing", () => {
	const response = finalizedAssistantResponse({
		role: "assistant",
		content: [{ type: "text", text: "Answer\n<!-- state_flow historical text -->" }],
	} as any);
	assert.equal(response, "Answer\n<!-- state_flow historical text -->");
});

test("final response requires non-empty text and no late tool call", () => {
	assert.throws(() => finalizedAssistantResponse({ role: "assistant", content: [] } as any), /non-empty/);
	assert.throws(() => finalizedAssistantResponse({ role: "assistant", content: [{ type: "toolCall" }] } as any), /tool call/);
});
