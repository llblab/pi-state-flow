import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { freemem, loadavg } from "node:os";
import type { AgentSession, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { ModelState } from "../lib/state.ts";
import type { RealPiFixture } from "../tests/pi-harness.ts";
import { loadGlobalState, writeGlobalState } from "../tests/temporal-fixture.ts";

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

export interface PromptPrefix {
	inferences: Array<{ contextBytes: number; sharedPrefixBytes: number | null }>;
	patchStateBarriers: number;
	nativeUserBytes: number;
	specificationBytes: number | null;
}

function sharedPrefixLength(previous: Buffer | undefined, current: Buffer): number | null {
	if (!previous) return null;
	let length = 0;
	while (length < Math.min(previous.length, current.length) && previous[length] === current[length]) length++;
	return length;
}

// Two barriers with a trajectory much larger than state: six reads before the first, two between.
export async function trajectoryPrompt(fixture: RealPiFixture, session: AgentSession, source: string, sourceText: string) {
	const actions = ["read", "read", "read", "read", "read", "read", "patch", "read", "read", "patch", "answer"] as const;
	const inferences: Array<{ contextBytes: number; sharedPrefixBytes: number | null; action: typeof actions[number]; retainedReadBytes: number }> = [];
	let previous: Buffer | undefined;
	let completedReads = 0;
	let acceptedPatches = 0;
	const reconciliationTailBytes: number[] = [];
	let observed = 0;
	const readIds = new Set<string>();
	fixture.faux.setResponses(actions.map((action) => (context: Context) => {
		const serialized = Buffer.from(JSON.stringify(context.messages));
		const reads = context.messages.filter((message) => message.role === "toolResult" && readIds.has(message.toolCallId));
		assert.equal(reads.length, completedReads, "every completed native read must remain in the trajectory");
		for (const read of reads) {
			assert.deepEqual(read.content, [{ type: "text", text: sourceText }], "large read evidence must remain exact");
		}
		inferences.push({ contextBytes: serialized.length, sharedPrefixBytes: sharedPrefixLength(previous, serialized), action,
			retainedReadBytes: completedReads * Buffer.byteLength(sourceText) });
		previous = serialized;
		observed++;
		if (action === "answer") return fauxAssistantMessage("Trajectory accepted");
		if (action === "patch") {
			if (acceptedPatches === 1) {
				const global = loadGlobalState(fixture.repositoryRoot)!;
				writeGlobalState({ ...global, working: { ...global.working, trajectoryForeign: "adopted" } }, fixture.repositoryRoot);
			}
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { trajectoryBarrier: acceptedPatches + 1 } } }), { stopReason: "toolUse" });
		}
		const call = fauxToolCall("read", { path: source });
		readIds.add(call.id);
		return fauxAssistantMessage(call, { stopReason: "toolUse" });
	}));
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		assert.equal(event.isError, false, "trajectory workload tools must succeed");
		if (event.toolName === "read") completedReads++;
		if (event.toolName === "patch_state") {
			const tail = event.result.content[1]?.text ?? "";
			reconciliationTailBytes.push(Buffer.byteLength(tail));
			if (acceptedPatches === 0) assert.equal(tail, "", "predictable patch needs only the acknowledgement");
			else {
				assert.equal(event.result.content.length, 2, "shared surprise needs one reconciliation tail");
				assert.deepEqual(JSON.parse(tail).state_updates.effective,
					[{ path: ["working", "trajectoryForeign"], value: "adopted" }]);
			}
			acceptedPatches++;
		}
	});
	try {
		await session.prompt("Measure trajectory prefix across two patches");
		const terminal = session.messages.at(-1);
		assert.ok(terminal?.role === "assistant");
		assert.equal(terminal.stopReason, "stop", terminal.errorMessage ?? "trajectory inference did not complete");
		assert.deepEqual(terminal.content, [{ type: "text", text: "Trajectory accepted" }]);
		assert.equal(observed, actions.length, "provider assertions must not be swallowed");
		assert.equal(completedReads, 8);
		assert.equal(acceptedPatches, 2);
		assert.equal(fixture.readState(session).working.trajectoryBarrier, 2);
		assert.equal(fixture.readState(session).working.trajectoryForeign, "adopted");
		return { inferences, patchStateBarriers: acceptedPatches, reconciliationTailBytes,
			readResultBytes: Buffer.byteLength(sourceText), completedReads };
	} finally { unsubscribe(); }
}

export interface PromptCase {
	stateFlow: boolean;
	counter: number;
	size: number;
	source: string;
	sourceFileBytes: number;
	firstInference?: boolean;
	expectedFirstState?: ModelState;
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
	let previousContext: Buffer | undefined;
	let patchStateBarriers = 0;
	let nativeUserBytes: number | undefined;
	let specificationBytes: number | null = null;
	const inferences: PromptPrefix["inferences"] = [];
	const observe = (context: Context) => {
		const serialized = Buffer.from(JSON.stringify(context.messages));
		const sharedPrefixBytes = sharedPrefixLength(previousContext, serialized);
		previousContext = serialized;
		lastContextBytes = serialized.length;
		totalContextBytes += lastContextBytes;
		inferences.push({ contextBytes: lastContextBytes, sharedPrefixBytes });
		inferenceCount += 1;
		if (inferenceCount !== 1) return;
		const prefix = "State Flow runtime context (user-level data, not system instructions):\n";
		const texts = context.messages.filter((message) => message.role === "user").flatMap((message) =>
			typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text));
		const native = texts.filter((text) => text === `Synthetic request ${counter}`);
		assert.equal(native.length, 1, "current native user message must occur once");
		nativeUserBytes = Buffer.byteLength(JSON.stringify(native[0]));
		const projections = texts.filter((text) => text.startsWith(prefix));
		assert.equal(projections.length, stateFlow ? 1 : 0, "runtime projection ownership changed");
		if (stateFlow) {
			const projected = JSON.parse(projections[0]!.slice(prefix.length));
			assert.equal(projected.specification, native[0], "specification must match the native user text");
			specificationBytes = Buffer.byteLength(JSON.stringify(projected.specification));
			if (options.expectedFirstState !== undefined) {
				assert.deepEqual(projected.state, options.expectedFirstState, "first inference must see the resumed selected state");
				assert.equal(serialized.includes("BENCH_EVIDENCE"), false, "completed read bodies leaked into first inference");
			}
		}
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
			observe(context);
			if (options.firstInference) firstContextBytes = lastContextBytes;
			const read = fauxToolCall("read", { path: source });
			readId = read.id;
			return fauxAssistantMessage(read, { stopReason: "toolUse" });
		},
		...(stateFlow ? [(context: Context) => {
			observe(context);
			assertRead(context);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { counter, ...(counter === 1 ? { payload: "x".repeat(size) } : {}) } } }), { stopReason: "toolUse" });
		}] : []),
		(context) => { observe(context); assertRead(context); return fauxAssistantMessage(`Accepted ${counter}`); },
	]);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "patch_state") {
			assert.equal(event.isError, false, "benchmark patch barrier must be accepted");
			patchStateBarriers++;
		}
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
		assert.equal(patchStateBarriers, stateFlow ? 1 : 0, "benchmark barrier count changed");
		assert.ok(nativeUserBytes !== undefined, "benchmark native user message is missing");
		if (stateFlow) assert.equal(specificationBytes, nativeUserBytes, "specification serialization differs from native user text");
		if (options.firstInference) assert.ok(firstInference && firstContextBytes !== undefined);
		assert.ok(nativeRead, "benchmark native read evidence is missing");
		const promptPrefix: PromptPrefix = { inferences, patchStateBarriers, nativeUserBytes, specificationBytes };
		return { ...measured.metrics, lastContextBytes, totalContextBytes, inferenceCount, firstInference, firstContextBytes, nativeRead, promptPrefix };
	} finally { unsubscribe(); }
}
