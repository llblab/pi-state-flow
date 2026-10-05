import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getSystemMessageText, type Context } from "@earendil-works/pi-ai";
import { realPiFixture } from "./pi-harness.ts";

for (const mode of ["active", "passive"] as const) {
	test(`real Pi ${mode} sees automatic-response ownership on every new run`, async (t) => {
		const fixture = await realPiFixture(t, { initializeRepository: false, mode });
		const session = await fixture.createSession("new");
		let observed = 0;
		const observe = (context: Context) => {
			const system = getCurrentSystemMessage(context.messages);
			assert.ok(system);
			assert.match(getSystemMessageText(system), /Never patch response in global, cwd or session, including clearing\/deleting it/);
			assert.match(getSystemMessageText(system), /captures your final answer automatically in Active mode/);
			observed++;
		};
		fixture.faux.setResponses([
			(context) => { observe(context); return fauxAssistantMessage(fauxToolCall("patch_state", {
				session: { working: { seed: true } },
			}), { stopReason: "toolUse" }); },
			fauxAssistantMessage("Seeded"),
		]);
		await session.prompt("Seed memory");
		assert.equal(observed, 1, "the initial inference must see patch tool guidance even without passive memory");
		assert.equal(fixture.readState(session).response, mode === "active" ? "Seeded" : "");
		for (let run = 1; run <= 3; run++) {
			fixture.faux.setResponses([(context) => {
				observe(context);
				const protocol = getCurrentSystemMessage(context.messages)!.sections?.state_flow ?? "";
				if (mode === "active") assert.match(protocol, /response: read-only prior answer; never patch it in any scope/);
				else assert.match(protocol, /Never patch response in global, cwd or session/);
				return fauxAssistantMessage(`Answer ${run}`);
			}]);
			await session.prompt(`Iteration ${run}`);
			const terminal = session.messages.at(-1);
			assert.ok(terminal?.role === "assistant");
			assert.equal(terminal.stopReason, "stop", terminal.errorMessage ?? "response policy inference did not complete");
			assert.deepEqual(terminal.content, [{ type: "text", text: `Answer ${run}` }]);
			assert.equal(observed, run + 1, "provider assertions must not be swallowed");
			assert.equal(fixture.readState(session).response, mode === "active" ? `Answer ${run}` : "",
				"only Active mode automatically records answers; Passive response remains runtime-owned");
		}
	});
}
