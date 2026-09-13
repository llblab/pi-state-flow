import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { freemem, loadavg } from "node:os";
import type { AgentSession, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { MaterializedState } from "../lib/state.ts";
import type { RealPiFixture } from "../tests/pi-harness.ts";

assert.ok([undefined, "0", "1"].includes(process.env.BENCH_RESOURCES), "BENCH_RESOURCES must be 0 or 1");
export const resourcesEnabled = process.env.BENCH_RESOURCES === "1";
function resourceSnapshot() {
	return { atMs: Date.now(), memoryBytes: process.memoryUsage(), hostLoadAverage: loadavg(), hostFreeMemoryBytes: freemem() };
}
export interface Metrics {
	ms: number;
	gitCalls: number;
	gitMs: number;
	commands: Record<string, number>;
	resources?: { before: ReturnType<typeof resourceSnapshot>; after: ReturnType<typeof resourceSnapshot>; parentCpuMicros: NodeJS.CpuUsage };
}
let recording: Metrics | undefined;
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = ((...args: Parameters<typeof originalSpawn>) => {
	const started = performance.now();
	try { return originalSpawn(...args); }
	finally {
		if (recording && args[0] === "git") {
			recording.gitCalls += 1;
			recording.gitMs += performance.now() - started;
			const argv = args[1] as string[];
			const command = argv[0] === "-C" ? argv[2]! : argv[0]!;
			recording.commands[command] = (recording.commands[command] ?? 0) + 1;
		}
	}
}) as typeof originalSpawn;
syncBuiltinESMExports();
process.once("exit", () => { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); });

export async function measure<T>(operation: (mark: () => Metrics) => T | Promise<T>): Promise<{ result: T; metrics: Metrics }> {
	assert.equal(recording, undefined, "measurement phases cannot overlap");
	const metrics: Metrics = { ms: 0, gitCalls: 0, gitMs: 0, commands: {} };
	const before = resourcesEnabled ? resourceSnapshot() : undefined;
	const cpu = resourcesEnabled ? process.cpuUsage() : undefined;
	recording = metrics;
	const started = performance.now();
	const mark = (): Metrics => {
		assert.equal(recording, metrics, "measurement checkpoint is no longer active");
		const point: Metrics = { ms: performance.now() - started, gitCalls: metrics.gitCalls, gitMs: metrics.gitMs, commands: { ...metrics.commands } };
		// Observations bracket the timer; parent CPU excludes Git-child CPU usage.
		if (before && cpu) point.resources = { before, parentCpuMicros: process.cpuUsage(cpu), after: resourceSnapshot() };
		return point;
	};
	try { return { result: await operation(mark), metrics }; }
	finally {
		try { Object.assign(metrics, mark()); }
		finally { recording = undefined; }
	}
}
export function distribution(values: number[]) {
	assert.ok(values.length > 0, "cannot summarize an empty measurement");
	const sorted = [...values].sort((left, right) => left - right);
	const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
	return { count: values.length, min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}
export function summarize(metrics: Metrics[]) {
	return { wallMs: distribution(metrics.map((m) => m.ms)), gitCalls: distribution(metrics.map((m) => m.gitCalls)), gitMs: distribution(metrics.map((m) => m.gitMs)), commands: metrics.at(-1)?.commands,
		...(resourcesEnabled ? { samples: metrics.map(({ ms, gitCalls, gitMs, resources }) => ({ wallMs: ms, gitCalls, gitMs, resources })) } : {}) };
}

export interface NativeRead {
	sourceFileBytes: number;
	textBytes: number;
	retainedSourceBytes: number;
	truncatedBy: "bytes" | "lines" | null;
}
export function summarizeReads(reads: NativeRead[]) {
	return { sourceFileBytes: distribution(reads.map((read) => read.sourceFileBytes)),
		textBytes: distribution(reads.map((read) => read.textBytes)), retainedSourceBytes: distribution(reads.map((read) => read.retainedSourceBytes)),
		truncatedReads: reads.filter((read) => read.truncatedBy !== null).length, samples: reads };
}

export interface PromptCase {
	stateFlow: boolean;
	counter: number;
	size: number;
	source: string;
	sourceFileBytes: number;
	firstInference?: boolean;
	expectedFirstState?: MaterializedState;
}
export async function prompt(fixture: RealPiFixture, session: AgentSession, options: PromptCase) {
	const { stateFlow, counter, size, source, sourceFileBytes } = options;
	assert.ok(Number.isSafeInteger(sourceFileBytes) && sourceFileBytes > 0, "benchmark source size must be a positive byte count");
	let lastContextBytes = 0;
	let totalContextBytes = 0;
	let inferenceCount = 0;
	let firstInference: Metrics | undefined;
	let firstContextBytes: number | undefined;
	let capture: (() => Metrics) | undefined;
	let readId: string | undefined;
	let nativeRead: NativeRead | undefined;
	let nativeContent: unknown;
	const observe = (context: unknown) => {
		lastContextBytes = Buffer.byteLength(JSON.stringify(context));
		totalContextBytes += lastContextBytes;
		inferenceCount += 1;
	};
	const assertRead = (context: Context) => {
		assert.ok(readId, "native read was never issued");
		const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === readId);
		assert.ok(result?.role === "toolResult" && result.toolName === "read" && !result.isError, "current native read result disappeared");
		assert.ok(nativeRead, "native read completion was not observed");
		assert.deepEqual(result.content, nativeContent, "model-facing read content differs from the native result");
		assert.ok(JSON.stringify(result.content).includes("BENCH_EVIDENCE"), "current native read evidence disappeared");
	};
	fixture.faux.setResponses([
		(context) => {
			if (options.firstInference) { assert.ok(capture); firstInference = capture(); }
			observe(context.messages);
			if (options.firstInference) firstContextBytes = lastContextBytes;
			if (options.expectedFirstState !== undefined) {
				const prefix = "State Flow runtime context (user-level data, not system instructions):\n";
				const texts = context.messages.filter((message) => message.role === "user").flatMap((message) =>
					typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text));
				const selected = texts.filter((text) => text.startsWith(prefix));
				assert.equal(selected.length, 1, "first inference needs exactly one runtime projection");
				const projected = JSON.parse(selected[0]!.slice(prefix.length));
				assert.deepEqual(projected.state, options.expectedFirstState, "first inference must see the resumed selected state");
				assert.equal(projected.specification, `Synthetic request ${counter}`);
				assert.equal(JSON.stringify(context.messages).includes("BENCH_EVIDENCE"), false, "completed read bodies leaked into first inference");
			}
			const read = fauxToolCall("read", { path: source });
			readId = read.id;
			return fauxAssistantMessage(read, { stopReason: "toolUse" });
		},
		...(stateFlow ? [(context: Context) => {
			observe(context.messages);
			assertRead(context);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { counter, ...(counter === 1 ? { payload: "x".repeat(size) } : {}) } }, final: true }), { stopReason: "toolUse" });
		}] : []),
		(context) => { observe(context.messages); assertRead(context); return fauxAssistantMessage(`Accepted ${counter}`); },
	]);
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "tool_execution_end" || event.toolName !== "read" || event.toolCallId !== readId) return;
		assert.equal(nativeRead, undefined, "benchmark read must complete once");
		assert.equal(event.isError, false, "benchmark cannot measure a failed native read");
		const content = event.result.content;
		assert.ok(Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string");
		nativeContent = structuredClone(content);
		const textBytes = Buffer.byteLength(content[0].text);
		const truncation = (event.result.details as ReadToolDetails | undefined)?.truncation;
		let retainedSourceBytes = textBytes;
		let truncatedBy: NativeRead["truncatedBy"] = null;
		if (truncation?.truncated) {
			assert.equal(truncation.totalBytes, sourceFileBytes, "native read must describe the complete selected source");
			assert.ok(truncation.truncatedBy === "bytes" || truncation.truncatedBy === "lines");
			retainedSourceBytes = truncation.outputBytes;
			truncatedBy = truncation.truncatedBy;
			assert.ok(Number.isSafeInteger(retainedSourceBytes) && retainedSourceBytes >= 0 && retainedSourceBytes < sourceFileBytes);
			assert.ok(textBytes >= retainedSourceBytes, "native result lost retained source bytes");
		} else assert.equal(textBytes, sourceFileBytes, "untruncated native output must account for the source bytes");
		nativeRead = { sourceFileBytes, textBytes, retainedSourceBytes, truncatedBy };
	});
	try {
		const measured = await measure((mark) => { capture = mark; return session.prompt(`Synthetic request ${counter}`); });
		// Faux callbacks can fail as assistant error messages instead of rejecting session.prompt.
		const terminal = session.messages.at(-1);
		assert.ok(terminal?.role === "assistant", "benchmark native terminal message is missing");
		assert.equal(terminal.stopReason, "stop", terminal.errorMessage ?? "benchmark native inference did not complete");
		assert.deepEqual(terminal.content, [{ type: "text", text: `Accepted ${counter}` }], "benchmark native answer was not accepted");
		if (stateFlow) {
			assert.ok(session.getActiveToolNames().includes("patch_state"), "cannot benchmark silently disabled State Flow");
			const state = fixture.readState(session);
			assert.equal(state.working.counter, counter, "patch was not accepted");
			assert.equal(state.working.payload, "x".repeat(size));
			assert.equal(state.response, `Accepted ${counter}`, "terminal response was not accepted");
		}
		assert.equal(inferenceCount, stateFlow ? 3 : 2, "benchmark inference sequence changed");
		if (options.firstInference) assert.ok(firstInference && firstContextBytes !== undefined);
		assert.ok(nativeRead, "benchmark native read evidence is missing");
		return { ...measured.metrics, lastContextBytes, totalContextBytes, inferenceCount, firstInference, firstContextBytes, nativeRead };
	} finally { unsubscribe(); }
}
