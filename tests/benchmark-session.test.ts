import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { distribution, measure, prompt, type Metrics } from "../benchmarks/benchmark-session.ts";
import { realPiFixture } from "./pi-harness.ts";

test("benchmark checkpoints retain prefix costs and release measurement ownership after failure", async () => {
	let first: Metrics | undefined;
	let late: (() => Metrics) | undefined;
	const observed = await measure((mark) => {
		assert.equal(spawnSync("git", ["--version"]).status, 0);
		first = mark();
		late = mark;
		assert.equal(first.gitCalls, 1);
		assert.equal(first.commands["--version"], 1);
		assert.equal(spawnSync("git", ["--version"]).status, 0);
		return "accepted";
	});
	assert.equal(observed.result, "accepted");
	assert.equal(observed.metrics.gitCalls, 2);
	assert.equal(observed.metrics.commands["--version"], 2);
	assert.equal(first!.gitCalls, 1);
	assert.equal(first!.commands["--version"], 1);
	assert.ok(first!.ms <= observed.metrics.ms);
	assert.throws(() => late!(), /no longer active/);
	await assert.rejects(measure(() => { throw new Error("synthetic operation failure"); }), /synthetic operation failure/);
	const next = await measure(() => "next");
	assert.equal(next.result, "next");
	assert.equal(next.metrics.gitCalls, 0);
	assert.throws(() => distribution([]), /empty measurement/);
});

for (const stateFlow of [false, true]) {
	test(`benchmark native read bytes distinguish complete, byte-truncated and line-truncated output (${stateFlow ? "enabled" : "native"})`, { timeout: 30_000 }, async (t) => {
		const fixture = await realPiFixture(t, { stateFlow, remotePublication: "off" });
		const session = await fixture.createSession();
		t.after(() => session.dispose());
		if (stateFlow) await session.prompt("/state-flow-start");
		const subscribe = session.subscribe.bind(session);
		let activeObservers = 0;
		t.mock.method(session, "subscribe", (listener: Parameters<typeof session.subscribe>[0]) => {
			activeObservers++;
			const unsubscribe = subscribe(listener);
			return () => { activeObservers--; unsubscribe(); };
		});
		const source = join(fixture.cwd, "evidence.txt");
		const cases = [
			{ body: "é".repeat(1000), by: null },
			{ body: "e".repeat(DEFAULT_MAX_BYTES + 1), by: "bytes" },
			{ body: "e\n".repeat(DEFAULT_MAX_LINES + 1), by: "lines" },
			{ body: `${"e".repeat(1023)}\n`.repeat(60), by: "bytes" },
		] as const;
		for (const [index, sample] of cases.entries()) {
			const text = `BENCH_EVIDENCE\n${sample.body}`;
			writeFileSync(source, text);
			const sourceFileBytes = Buffer.byteLength(text);
			const result = await prompt(fixture, session, { stateFlow, counter: index + 1, size: 1024, source, sourceFileBytes });
			assert.equal(activeObservers, 0, "read observation must not leak into the next run");
			assert.equal(result.nativeRead.sourceFileBytes, sourceFileBytes);
			assert.equal(result.nativeRead.truncatedBy, sample.by);
			if (sample.by === null) {
				assert.equal(result.nativeRead.textBytes, sourceFileBytes);
				assert.equal(result.nativeRead.retainedSourceBytes, sourceFileBytes);
			} else {
				assert.ok(result.nativeRead.retainedSourceBytes < sourceFileBytes);
				assert.ok(result.nativeRead.textBytes > result.nativeRead.retainedSourceBytes, "notice bytes are separate from retained source bytes");
			}
			if (index === 1) assert.equal(result.nativeRead.retainedSourceBytes, Buffer.byteLength("BENCH_EVIDENCE"));
			if (index === 2) assert.equal(result.nativeRead.retainedSourceBytes, Buffer.byteLength(text.split("\n").slice(0, DEFAULT_MAX_LINES).join("\n")));
			if (index === 3) assert.ok(result.nativeRead.retainedSourceBytes > DEFAULT_MAX_BYTES / 2 && result.nativeRead.retainedSourceBytes <= DEFAULT_MAX_BYTES);
		}
		if (!stateFlow) {
			const setResponses = fixture.faux.setResponses.bind(fixture.faux);
			const alteredContext = t.mock.method(fixture.faux, "setResponses", (responses: Parameters<typeof setResponses>[0]) => setResponses(responses.map((response, index) => {
				if (index !== 1 || typeof response !== "function") return response;
				const corrupt: FauxResponseFactory = (context, ...rest) => {
					const changed = { ...context, messages: structuredClone(context.messages) };
					const read = changed.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read");
					assert.ok(read?.role === "toolResult");
					read.content = [{ type: "text", text: "BENCH_EVIDENCE\nrewritten model-facing result" }];
					return response(changed, ...rest);
				};
				return corrupt;
			})));
			await assert.rejects(prompt(fixture, session, { stateFlow, counter: 5, size: 1024, source, sourceFileBytes: statSync(source).size }), /model-facing read content/);
			assert.equal(activeObservers, 0);
			alteredContext.mock.restore();
		}
		const failedPrompt = t.mock.method(session, "prompt", async () => { throw new Error("synthetic prompt failure"); });
		await assert.rejects(prompt(fixture, session, { stateFlow, counter: 5, size: 1024, source, sourceFileBytes: 1 }), /synthetic prompt failure/);
		assert.equal(activeObservers, 0, "failed prompts must release their observer too");
		failedPrompt.mock.restore();
	});
}
