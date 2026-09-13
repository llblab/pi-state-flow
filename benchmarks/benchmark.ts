import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { TemporalRuntime } from "../lib/runtime.ts";
import { realPiFixture, resolvedSnapshot, runGit, type RealPiFixture } from "../tests/pi-harness.ts";
import { distribution, measure, prompt, resourcesEnabled as resources, summarize, summarizeReads, type Metrics } from "./benchmark-session.ts";
import type { ResumeProbeResult } from "./benchmark-resume.ts";

// Opt-in observational workload. Assertions prove correctness, never a machine-specific timing threshold.
function positive(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
	return value;
}
const patches = positive("BENCH_PATCHES", 200);
const samples = positive("BENCH_SAMPLES", 3);
const rounds = positive("BENCH_ROUNDS", 10);
const transcriptBytes = positive("BENCH_TRANSCRIPT_BYTES", 4096);
assert.ok([undefined, "0", "1"].includes(process.env.BENCH_POST_RESUME), "BENCH_POST_RESUME must be 0 or 1");
const postResume = process.env.BENCH_POST_RESUME === "1";
const sizes = (process.env.BENCH_STATE_BYTES ?? "8192,131072").split(",").map(Number);
assert.ok(sizes.length > 0 && sizes.every((size) => Number.isSafeInteger(size) && size > 0), "BENCH_STATE_BYTES must contain positive integers");
const checkpoints = [...new Set([Math.min(20, patches), patches])];
const repository = fileURLToPath(new URL("../", import.meta.url));
function sourceFilesHash(paths: string[]): string {
	const hash = createHash("sha256");
	for (const path of paths) hash.update(path).update("\0").update(readFileSync(join(repository, path))).update("\0");
	return hash.digest("hex");
}
function runtimeSourceHash(): string {
	return sourceFilesHash(["index.ts", ...readdirSync(join(repository, "lib")).filter((name) => name.endsWith(".ts")).sort().map((name) => `lib/${name}`)]);
}
function workloadSourceHash(): string {
	return sourceFilesHash(["package.json", "package-lock.json", "benchmarks/benchmark.ts", "benchmarks/benchmark-writer.ts",
		"benchmarks/benchmark-session.ts", "benchmarks/benchmark-resume.ts", "tests/pi-harness.ts", "tests/temporal-fixture.ts", "tests/legacy-fixture.ts"]);
}
function packageVersion(name: string): string {
	const path = findPackageJSON(name, import.meta.url);
	assert.ok(path, `Cannot identify benchmark dependency: ${name}`);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(manifest.name, name);
	assert.equal(typeof manifest.version, "string");
	return manifest.version;
}
const sourceHash = runtimeSourceHash();
const workloadHash = workloadSourceHash();
const report: Record<string, unknown> = {
	version: 2,
	node: process.version,
	platform: `${process.platform}/${process.arch}`,
	piVersion: packageVersion("@earendil-works/pi-coding-agent"),
	aiVersion: packageVersion("@earendil-works/pi-ai"),
	gitVersion: runGit(repository, "--version"),
	availableParallelism: availableParallelism(),
	sourceCommit: runGit(repository, "rev-parse", "HEAD"),
	runtimeSourceHash: sourceHash,
	workloadSourceHash: workloadHash,
	configuration: { patches, samples, rounds, transcriptBytes, sizes, resources, postResume },
	limits: "Synthetic faux-model/native-SDK workload; no real inference latency or quality measurement. Timings include instrumentation. Concurrent publishers use the same TemporalRuntime but separate OS processes, not two live Pi UIs. No timing threshold establishes correctness.",
	lifecycle: [],
	publishers: [],
};
function baselineFingerprint(paths: string[]): string {
	const hash = createHash("sha256");
	const visit = (path: string) => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			hash.update(JSON.stringify([path, stat.mode, "directory"])).update("\n");
			for (const name of readdirSync(path).sort()) visit(join(path, name));
		} else {
			assert.ok(stat.isFile() && !stat.isSymbolicLink(), "baseline evidence must be regular fixture files");
			const bytes = createHash("sha256").update(readFileSync(path)).digest("hex");
			hash.update(JSON.stringify([path, stat.mode, bytes])).update("\n");
		}
	};
	for (const path of paths) visit(path);
	return hash.digest("hex");
}

function probeAfterResume(fixture: RealPiFixture, session: AgentSession, stateFlow: boolean, counter: number, size: number, source: string) {
	const sessionFile = session.sessionFile!;
	const leafId = session.sessionManager.getLeafId();
	const sessionId = session.sessionManager.getSessionId();
	const selected = stateFlow ? resolvedSnapshot(session) : undefined;
	const state = stateFlow ? fixture.readState(session) : undefined;
	const paths = [fixture.repositoryRoot, sessionFile, source];
	const before = baselineFingerprint(paths);
	const probes: ResumeProbeResult[] = [];
	for (let sample = 0; sample < samples; sample++) {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./benchmark-resume.ts", import.meta.url)), JSON.stringify({
			root: fixture.root, repositoryRoot: fixture.repositoryRoot, cwd: fixture.cwd, source, sessionFile,
			sessionId, leafId, revision: selected?.meta.durableBase, stateFlow, counter, size,
		})], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
		assert.equal(baselineFingerprint(paths), before, "post-resume probe changed baseline files");
		assert.equal(session.sessionManager.getLeafId(), leafId);
		if (stateFlow) {
			assert.deepEqual(fixture.readState(session), state);
			assert.deepEqual(resolvedSnapshot(session), selected);
		}
		assert.equal(child.error, undefined);
		assert.equal(child.signal, null);
		assert.equal(child.status, 0, child.stdout + child.stderr);
		const match = child.stdout.match(/BENCH_PROBE_RESULT (\{[^\n]+\})/);
		assert.ok(match, child.stdout + child.stderr);
		const reply = JSON.parse(match[1]!);
		assert.equal(reply.exitCode, 0);
		const result: ResumeProbeResult = reply.result;
		assert.equal(result.version, 1);
		assert.equal(result.isolated, true);
		assert.equal(result.counter, counter);
		assert.equal(result.stateBytes, size);
		assert.equal(result.stateFlow, stateFlow);
		assert.equal(result.sessionId, sessionId);
		assert.equal(result.selectedLeafId, leafId);
		assert.equal(result.selectedRevision, selected?.meta.durableBase);
		assert.equal(result.acceptedTransitions, stateFlow ? 2 : 0);
		assert.equal(result.wholeRun.inferenceCount, stateFlow ? 3 : 2);
		assert.ok(result.firstContextBytes > 0 && result.firstInference.ms >= 0 && result.firstInference.ms <= result.wholeRun.ms);
		probes.push(result);
	}
	return { execution: "fresh-process clone", sampleCount: probes.length, selectedRevision: selected?.meta.durableBase, selectedLeafId: leafId,
		baselineUnchanged: true, acceptedTransitionsPerProbe: stateFlow ? 2 : 0,
		openSession: summarize(probes.map((probe) => probe.openSession)), resumeRuntime: summarize(probes.map((probe) => probe.resumeRuntime)),
		firstInference: summarize(probes.map((probe) => probe.firstInference)), wholeRun: summarize(probes.map((probe) => probe.wholeRun)),
		firstContextBytes: distribution(probes.map((probe) => probe.firstContextBytes)), nativeRead: summarizeReads(probes.map((probe) => probe.wholeRun.nativeRead)) };
}

test("native Pi and State Flow long-session/resume workload", { timeout: 1_200_000 }, async (t) => {
	for (const stateFlow of [false, true]) for (const size of stateFlow ? sizes : [0]) {
		const fixture = await realPiFixture(t, { stateFlow, remotePublication: "off" });
		let session = await fixture.createSession();
		t.after(() => session.dispose());
		if (stateFlow) await session.prompt("/state-flow-start");
		const source = join(fixture.cwd, "evidence.txt");
		writeFileSync(source, `BENCH_EVIDENCE\n${"e".repeat(transcriptBytes)}`);
		const sourceFileBytes = statSync(source).size;
		const timings: Awaited<ReturnType<typeof prompt>>[] = [];
		for (let counter = 1; counter <= patches; counter++) {
			timings.push(await prompt(fixture, session, { stateFlow, counter, size, source, sourceFileBytes }));
			if (!checkpoints.includes(counter)) continue;
			const sessionFile = session.sessionFile!;
			const entries = session.sessionManager.getBranch().length;
			const acceptedTransitions = stateFlow ? resolvedSnapshot(session).meta.step : 0;
			if (stateFlow) assert.equal(acceptedTransitions, counter * 2, "semantic patch/response transition count changed");
			const recent = timings.slice(-Math.min(20, timings.length));
			const resumes: Metrics[] = [];
			const opens: Metrics[] = [];
			for (let sample = 0; sample < samples; sample++) {
				session.dispose();
				const opened = await measure(() => SessionManager.open(sessionFile, fixture.sessionDir));
				opens.push(opened.metrics);
				const restored = await measure(() => fixture.createSession("resume", opened.result));
				resumes.push(restored.metrics);
				session = restored.result;
				if (stateFlow) {
					assert.ok(session.getActiveToolNames().includes("patch_state"));
					assert.equal(fixture.readState(session).working.counter, counter);
					assert.equal(fixture.readState(session, 1).working.counter, counter);
				}
			}
			const entry = { stateFlow, stateBytes: size, modelPatches: stateFlow ? counter : 0, userRuns: counter, acceptedTransitions, nativeEntries: entries, nativeFileBytes: statSync(sessionFile).size, recentRuns: summarize(recent), openSession: summarize(opens), resumeRuntime: summarize(resumes), lastContextBytes: recent.at(-1)!.lastContextBytes, contextBytesPerRun: recent.at(-1)!.totalContextBytes, inferencesPerRun: recent.at(-1)!.inferenceCount, nativeRead: summarizeReads(recent.map((run) => run.nativeRead)) };
			if (postResume) Object.assign(entry, { postResume: probeAfterResume(fixture, session, stateFlow, counter, size, source) });
			(report.lifecycle as unknown[]).push(entry);
			console.log(`BENCH_PHASE ${JSON.stringify(entry)}`);
		}
		assert.ok(readFileSync(session.sessionFile!, "utf8").includes("BENCH_EVIDENCE"), "full native trace was lost");
	}
});

interface Reply { ready?: boolean; accepted?: boolean; ms: number; revision?: string; step: number; error?: string }
function reply(child: ChildProcess): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Benchmark writer response timed out")), 30_000);
		const onMessage = (value: Reply) => finish(undefined, value);
		const onExit = (code: number | null) => finish(new Error(`Benchmark writer exited early: ${code}`));
		function finish(error?: Error, value?: Reply) {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", finish);
			if (error) reject(error); else resolve(value!);
		}
		child.once("message", onMessage);
		child.once("exit", onExit);
		child.once("error", finish);
	});
}

test("two-process publication interleavings", { timeout: 180_000 }, async (t) => {
	for (const sameCwd of [true, false]) for (const scope of ["session", "global"] as const) {
		const fixture = await realPiFixture(t, { remotePublication: "off" });
		const writers: Array<{ child: ChildProcess; cwd: string; id: string; revision?: string; accepted: number }> = [];
		for (const id of ["writer-a", "writer-b"]) {
			const cwd = sameCwd ? fixture.cwd : join(fixture.cwd, id);
			const child = fork(new URL("./benchmark-writer.ts", import.meta.url), [fixture.repositoryRoot, cwd, id], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
			t.after(() => { if (child.exitCode === null) child.kill(); });
			assert.equal((await reply(child)).ready, true);
			writers.push({ child, cwd, id, accepted: 0 });
		}
		const initialCommits = Number(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"));
		const results: Reply[] = [];
		for (let round = 1; round <= rounds; round++) {
			const waiting = writers.map(({ child }) => reply(child));
			for (const { child } of writers) child.send({ scope, round });
			const attempts = await Promise.all(waiting);
			for (const [index, result] of attempts.entries()) {
				results.push(result);
				if (result.accepted) { writers[index]!.accepted += 1; writers[index]!.revision = result.revision; }
				else assert.ok(result.error, "failed publication needs attributable evidence");
			}
		}
		for (const writer of writers) {
			const exited = once(writer.child, "exit");
			writer.child.send("stop");
			await exited;
			if (!writer.revision) continue;
			const restored = new TemporalRuntime(writer.cwd, writer.id, fixture.repositoryRoot);
			const snapshot = restored.restore(writer.revision);
			assert.equal(snapshot.meta.step, writer.accepted, "accepted publications lost after cold restore");
			assert.equal(restored.read(0, scope).working.writer, writer.id, "scope/branch ownership changed");
		}
		const accepted = results.filter((r) => r.accepted).length;
		assert.equal(Number(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD")) - initialCommits, accepted, "commit count differs from accepted transitions");
		assert.ok(accepted > 0, "no writer published usable evidence");
		const errors = results.flatMap((result) => result.error ? [result.error.replaceAll(fixture.root, "<fixture>")] : []);
		const entry = { sameCwd, scope, attempts: results.length, accepted, failed: results.length - accepted, wallMs: distribution(results.map((r) => r.ms)), errors: Object.fromEntries([...new Set(errors)].map((error) => [error, errors.filter((value) => value === error).length])) };
		(report.publishers as unknown[]).push(entry);
		console.log(`BENCH_PHASE ${JSON.stringify(entry)}`);
	}
});

process.once("beforeExit", (code) => setImmediate(() => {
	report.runtimeSourceUnchanged = runtimeSourceHash() === sourceHash;
	report.workloadSourceUnchanged = workloadSourceHash() === workloadHash;
	if (!report.runtimeSourceUnchanged || !report.workloadSourceUnchanged) process.exitCode = 1;
	report.exitCode = process.exitCode || code;
	// Let the test runner settle its exit status, then keep the loop alive until pipe output drains.
	console.log(`BENCH_RESULT ${JSON.stringify(report)}`);
}));
