import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

function sourceFixture(t: TestContext): string {
	const source = fileURLToPath(new URL("../", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "state-flow-benchmark-contract-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "empty-hooks"));
	for (const path of ["index.ts", "lib", "tests", "benchmarks", "package.json", "package-lock.json"]) {
		cpSync(join(source, path), join(root, path), { recursive: true });
	}
	symlinkSync(join(source, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	execFileSync("git", ["init", "--template=", "-b", "main", root], { stdio: "pipe" });
	execFileSync("git", ["-C", root, "-c", "user.name=Benchmark Tests", "-c", "user.email=benchmark@example.invalid",
		"-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "empty-hooks")}`, "commit", "--allow-empty", "-m", "synthetic source"], { stdio: "pipe" });
	return root;
}

test("benchmark complete reports and optional resources survive pipe backpressure and reject workload drift", { timeout: 60_000 }, (t) => {
	const root = sourceFixture(t);
	// Exceed the output pipe's buffer without a long measured workload; this source change precedes hashing.
	appendFileSync(join(root, "benchmarks", "benchmark.ts"), '\nreport.syntheticPadding = "x".repeat(1024 * 1024);\n');
	appendFileSync(join(root, "benchmarks", "benchmark-resume.ts"), '\nprocess.prependOnceListener("beforeExit", () => Object.assign(result!, { syntheticPadding: "x".repeat(1024 * 1024) }));\n');
	writeFileSync(join(root, "source-change.mjs"), `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const original = process.stdout.write;
let changed = false;
process.stdout.write = function (chunk, ...args) {
	if (!changed && String(chunk).includes("BENCH_PHASE ")) {
		changed = true;
		appendFileSync(join(process.cwd(), "benchmarks/benchmark-writer.ts"), "\\n// Synthetic workload drift after source identity capture.\\n");
	}
	return original.call(this, chunk, ...args);
};
`);
	let workloadHash: string | undefined;
	let runtimeHash: string | undefined;
	for (const mutate of [false, true]) {
		const child = spawnSync(process.execPath, [
			...(mutate ? ["--import", "./source-change.mjs"] : []),
			"--test", ...(mutate ? ["--experimental-test-isolation=none"] : []), "--test-name-pattern=native Pi and State Flow", "benchmarks/benchmark.ts",
		], {
			cwd: root,
			// Admit an independent runner instead of inheriting this file's Node test-runner context.
			env: { ...process.env, NODE_TEST_CONTEXT: undefined, BENCH_PATCHES: "1", BENCH_SAMPLES: "1", BENCH_ROUNDS: "1", BENCH_STATE_BYTES: "8192", BENCH_TRANSCRIPT_BYTES: mutate ? "4096" : "65536", BENCH_RESOURCES: mutate ? "0" : "1", BENCH_POST_RESUME: mutate ? "0" : "1" },
			encoding: "utf8",
			timeout: 25_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.signal, null);
		assert.equal(child.status, mutate ? 1 : 0, child.stderr);
		const match = child.stdout.match(/BENCH_RESULT (\{[^\n]+\})/);
		assert.ok(match, child.stdout + child.stderr);
		const report = JSON.parse(match[1]!);
		assert.equal(report.version, 2);
		assert.equal(report.syntheticPadding, "x".repeat(1024 * 1024));
		assert.equal(report.exitCode, mutate ? 1 : 0);
		assert.equal(report.runtimeSourceUnchanged, true);
		assert.equal(report.workloadSourceUnchanged, !mutate);
		assert.match(report.runtimeSourceHash, /^[0-9a-f]{64}$/);
		assert.match(report.workloadSourceHash, /^[0-9a-f]{64}$/);
		assert.equal(report.runtimeSourceHash, runtimeHash ??= report.runtimeSourceHash);
		assert.equal(report.workloadSourceHash, workloadHash ??= report.workloadSourceHash);
		assert.ok(report.piVersion && report.aiVersion && report.gitVersion);
		assert.equal(report.configuration.transcriptBytes, mutate ? 4096 : 65536);
		assert.equal(report.configuration.resources, !mutate);
		assert.equal(report.configuration.postResume, !mutate);
		assert.equal(report.lifecycle.length, 2);
		assert.equal(report.publishers.length, 0);
		for (const entry of report.lifecycle) {
			assert.equal(entry.acceptedTransitions, entry.stateFlow ? 2 : 0);
			const phases = [entry.recentRuns, entry.openSession, entry.resumeRuntime];
			const reads = [entry.nativeRead];
			if (mutate) assert.equal(entry.postResume, undefined);
			else {
				const probe = entry.postResume;
				assert.equal(probe.execution, "fresh-process clone");
				assert.equal(probe.sampleCount, 1);
				assert.equal(probe.baselineUnchanged, true);
				assert.equal(probe.acceptedTransitionsPerProbe, entry.stateFlow ? 2 : 0);
				assert.ok(probe.selectedLeafId);
				assert.ok(probe.firstContextBytes.p50 > 0);
				assert.ok(probe.firstInference.wallMs.p50 <= probe.wholeRun.wallMs.p50);
				assert.ok(probe.firstInference.gitCalls.p50 <= probe.wholeRun.gitCalls.p50);
				if (entry.stateFlow) {
					assert.ok(probe.selectedRevision);
					assert.equal(probe.firstInference.commands["commit-tree"], 1);
				} else assert.equal(probe.firstInference.gitCalls.p50, 0);
				phases.push(probe.openSession, probe.resumeRuntime, probe.firstInference, probe.wholeRun);
				reads.push(probe.nativeRead);
			}
			for (const read of reads) {
				const sourceFileBytes = (mutate ? 4096 : 65536) + Buffer.byteLength("BENCH_EVIDENCE\n");
				const textBytes = mutate ? sourceFileBytes : 82;
				const retainedSourceBytes = mutate ? sourceFileBytes : 14;
				assert.equal(read.truncatedReads, mutate ? 0 : 1);
				assert.equal(read.sourceFileBytes.p50, sourceFileBytes);
				assert.equal(read.textBytes.p50, textBytes);
				assert.equal(read.retainedSourceBytes.p50, retainedSourceBytes);
				assert.deepEqual(read.samples, [{ sourceFileBytes, textBytes, retainedSourceBytes, truncatedBy: mutate ? null : "bytes" }]);
			}
			for (const phase of phases) {
				if (mutate) { assert.equal(phase.samples, undefined); continue; }
				assert.equal(phase.samples.length, phase.wallMs.count);
				for (const sample of phase.samples) {
					assert.ok(sample.resources.before.memoryBytes.rss > 0);
					assert.ok(sample.resources.after.memoryBytes.heapUsed > 0);
					assert.equal(sample.resources.before.hostLoadAverage.length, 3);
					assert.ok(sample.resources.before.atMs > 0 && sample.resources.after.atMs > 0);
					assert.ok(sample.resources.parentCpuMicros.user >= 0 && sample.resources.parentCpuMicros.system >= 0);
				}
			}
		}
	}
});

for (const target of ["session", "repository"] as const) {
	test(`post-resume probe rejects baseline ${target} drift even after a successful child`, { timeout: 40_000 }, (t) => {
		const root = sourceFixture(t);
		// Only the disposable worker source is faulted; the measured source identity includes this fault.
		appendFileSync(join(root, "benchmarks", "benchmark-resume.ts"), `
import { appendFileSync as corruptBaseline } from "node:fs";
process.once("exit", () => {
	const baseline = JSON.parse(process.argv[2]);
	corruptBaseline(${target === "session" ? "baseline.sessionFile" : "join(baseline.repositoryRoot, 'probe-corruption.txt')"}, "\\n");
});
`);
		const child = spawnSync(process.execPath, ["--test", "--experimental-test-isolation=none", "--test-name-pattern=native Pi and State Flow", "benchmarks/benchmark.ts"], {
			cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, NODE_TEST_CONTEXT: undefined, BENCH_PATCHES: "1", BENCH_SAMPLES: "1", BENCH_ROUNDS: "1", BENCH_STATE_BYTES: "8192", BENCH_TRANSCRIPT_BYTES: "4096", BENCH_RESOURCES: "0", BENCH_POST_RESUME: "1" },
		});
		assert.equal(child.error, undefined);
		assert.equal(child.signal, null);
		assert.equal(child.status, 1, child.stdout + child.stderr);
		assert.match(child.stdout + child.stderr, /post-resume probe changed baseline files/);
		const match = child.stdout.match(/BENCH_RESULT (\{[^\n]+\})/);
		assert.ok(match, child.stdout + child.stderr);
		const report = JSON.parse(match[1]!);
		assert.equal(report.runtimeSourceUnchanged, true);
		assert.equal(report.workloadSourceUnchanged, true);
		assert.equal(report.exitCode, 1);
		assert.equal(report.lifecycle.length, 0);
	});
}
