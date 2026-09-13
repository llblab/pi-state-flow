import assert from "node:assert/strict";
import { copyFileSync, cpSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { measure, prompt, type Metrics } from "./benchmark-session.ts";
import { realPiFixture, resolvedSnapshot } from "../tests/pi-harness.ts";

export interface ResumeProbeResult {
	version: 1;
	stateFlow: boolean;
	counter: number;
	stateBytes: number;
	sessionId: string;
	selectedLeafId: string | null;
	selectedRevision?: string;
	acceptedTransitions: number;
	openSession: Metrics;
	resumeRuntime: Metrics;
	firstInference: Metrics;
	firstContextBytes: number;
	wholeRun: Awaited<ReturnType<typeof prompt>>;
	isolated: true;
}

// Internal worker: only the benchmark's synthetic fixture layout is admitted as clone input.
const input = JSON.parse(process.argv[2]!);
assert.equal(typeof input.root, "string");
assert.equal(dirname(resolve(input.root)), resolve(tmpdir()));
assert.ok(basename(input.root).startsWith("state-flow-real-pi-"));
assert.equal(input.repositoryRoot, join(input.root, "knowledge"));
assert.equal(input.cwd, join(input.root, "project"));
assert.equal(input.source, join(input.cwd, "evidence.txt"));
assert.equal(dirname(input.sessionFile), join(input.root, "sessions"));
assert.equal(typeof input.stateFlow, "boolean");
assert.ok(Number.isSafeInteger(input.counter) && input.counter > 0);
assert.ok(Number.isSafeInteger(input.size) && input.size >= 0);
assert.equal(typeof input.sessionId, "string");
let result: ResumeProbeResult | undefined;

test("isolated first inference after native resume", { timeout: 35_000 }, async (t) => {
	const sourceFileBytes = statSync(input.source).size;
	const fixture = await realPiFixture(t, { stateFlow: input.stateFlow, initializeRepository: false, remotePublication: "off" });
	assert.notEqual(fixture.root, input.root);
	cpSync(input.repositoryRoot, fixture.repositoryRoot, { recursive: true });
	const copiedSession = join(fixture.sessionDir, basename(input.sessionFile));
	copyFileSync(input.sessionFile, copiedSession);
	assert.notEqual(copiedSession, input.sessionFile);
	const opened = await measure(() => SessionManager.open(copiedSession, fixture.sessionDir));
	assert.equal(opened.result.getSessionId(), input.sessionId);
	assert.equal(opened.result.getLeafId(), input.leafId);
	const resumed = await measure(() => fixture.createSessionAt(input.cwd, "resume", opened.result));
	const session = resumed.result;
	t.after(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	assert.equal(session.sessionFile, copiedSession);
	assert.equal(session.sessionManager.getLeafId(), input.leafId);
	let expectedFirstState;
	if (input.stateFlow) {
		assert.ok(session.getActiveToolNames().includes("patch_state"));
		const selected = resolvedSnapshot(session);
		assert.equal(selected.meta.durableBase, input.revision);
		assert.equal(selected.meta.step, input.counter * 2);
		expectedFirstState = fixture.readState(session);
		assert.equal(expectedFirstState.working.counter, input.counter);
		assert.equal(expectedFirstState.response, `Accepted ${input.counter}`);
	} else {
		assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	}
	const run = await prompt(fixture, session, {
		stateFlow: input.stateFlow, counter: input.counter + 1, size: input.size, source: input.source, sourceFileBytes,
		firstInference: true, expectedFirstState,
	});
	assert.ok(run.firstInference && run.firstContextBytes !== undefined);
	assert.ok(run.firstInference.ms <= run.ms);
	assert.ok(run.firstInference.gitCalls <= run.gitCalls);
	assert.equal(session.sessionManager.getSessionId(), input.sessionId);
	assert.equal(session.sessionFile, copiedSession);
	assert.ok(readFileSync(copiedSession, "utf8").includes("BENCH_EVIDENCE"));
	const acceptedTransitions = input.stateFlow ? resolvedSnapshot(session).meta.step - input.counter * 2 : 0;
	assert.equal(acceptedTransitions, input.stateFlow ? 2 : 0);
	result = {
		version: 1, stateFlow: input.stateFlow, counter: input.counter, stateBytes: input.size,
		sessionId: input.sessionId, selectedLeafId: input.leafId, selectedRevision: input.revision,
		acceptedTransitions, openSession: opened.metrics, resumeRuntime: resumed.metrics,
		firstInference: run.firstInference, firstContextBytes: run.firstContextBytes,
		wholeRun: run, isolated: true,
	};
});

process.once("beforeExit", (code) => setImmediate(() => {
	// Settle test-runner status before reporting, while asynchronous pipe output can still drain.
	console.log(`BENCH_PROBE_RESULT ${JSON.stringify({ result, exitCode: process.exitCode || code })}`);
}));
