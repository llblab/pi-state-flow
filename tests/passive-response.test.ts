import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { realPiFixture } from "./pi-harness.ts";
import { emptyState } from "../lib/state.ts";
import { writeGlobalState } from "./storage-fixture.ts";

function assertPassiveProjection(context: Context) {
	let heads = 0;
	for (const message of context.messages) {
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part.type !== "text") continue;
			if (message.role === "user" && /^State Flow (exit handoff|passive memory|context update) \(/.test(part.text)) {
				const payload = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1));
				if (payload.state) {
					heads++;
					assert.equal(Object.hasOwn(payload.state, "response"), false);
					assert.equal(payload.state.working.seed, true);
				}
				for (const entry of payload.state_updates?.effective ?? []) assert.notEqual(entry.path[0], "response");
			}
			if (message.role === "toolResult" && message.toolName === "patch_state" && part.text.trim().startsWith('{"state_updates"')) {
				for (const entry of JSON.parse(part.text).state_updates.effective) assert.notEqual(entry.path[0], "response");
			}
		}
	}
	assert.ok(heads > 0, "Passive must keep memory, not silently disable projection");
}

for (const entry of ["stop", "reload", "initial"] as const) {
	test(`real Pi Passive omits stored response across barriers and reactivation (${entry})`, async (t) => {
		const fixture = await realPiFixture(t, { initializeRepository: false, mode: entry === "initial" ? "passive" : "active" });
		if (entry === "initial") writeGlobalState({ ...emptyState(), response: "LAST_ACTIVE_RESPONSE", working: { seed: true } }, fixture.repositoryRoot);
		const session = await fixture.createSession("new");
		if (entry !== "initial") {
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { seed: true } } }), { stopReason: "toolUse" }),
				fauxAssistantMessage("LAST_ACTIVE_RESPONSE"),
			]);
			await session.prompt("Seed Active memory");
			await session.prompt("/state-flow-passive");
		}
		assert.equal(fixture.readState(session).response, "LAST_ACTIVE_RESPONSE");
		if (entry === "reload") await session.reload();
		let observed = 0;
		fixture.faux.setResponses([
			(context) => {
				assertPassiveProjection(context); observed++;
				return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { passive: true } } }), { stopReason: "toolUse" });
			},
			(context) => {
				assertPassiveProjection(context); observed++;
				return fauxAssistantMessage(fauxToolCall("read_state", { path: "effective.response" }), { stopReason: "toolUse" });
			},
			(context) => {
				assertPassiveProjection(context); observed++;
				const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read_state");
				assert.ok(result?.role === "toolResult");
				assert.match(JSON.stringify(result.content), /LAST_ACTIVE_RESPONSE/, "explicit exact reads are not redacted");
				return fauxAssistantMessage("Passive answer");
			},
		]);
		await session.prompt("Continue in Passive");
		assert.equal(observed, 3, "provider assertions must not be swallowed");
		const passiveAnswer = session.messages.at(-1);
		assert.ok(passiveAnswer?.role === "assistant");
		assert.deepEqual(passiveAnswer.content, [{ type: "text", text: "Passive answer" }]);
		assert.equal(fixture.readState(session).response, "LAST_ACTIVE_RESPONSE", "projection never deletes canonical response");
		assert.equal(fixture.readState(session).working.passive, true);
		await session.prompt("/state-flow-active");
		let activeObserved = false;
		fixture.faux.setResponses([(context) => {
			const head = context.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "text" && part.text.startsWith("State Flow runtime context")) : [])[0];
			assert.ok(head?.type === "text");
			const payload = JSON.parse(head.text.slice(head.text.indexOf("\n") + 1));
			assert.equal(payload.state.response, "LAST_ACTIVE_RESPONSE");
			activeObserved = true;
			return fauxAssistantMessage("Active again");
		}]);
		await session.prompt("Continue in Active");
		assert.equal(activeObserved, true);
		const activeAnswer = session.messages.at(-1);
		assert.ok(activeAnswer?.role === "assistant");
		assert.deepEqual(activeAnswer.content, [{ type: "text", text: "Active again" }]);
		assert.equal(fixture.readState(session).response, "Active again");
	});
}
