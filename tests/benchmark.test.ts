import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import "./git-environment.ts";

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
		const reportPath = join(root, `report-${mutate}.json`);
		const child = spawnSync(process.execPath, [
			...(mutate ? ["--import", "./source-change.mjs"] : []),
			"--test", ...(mutate ? ["--experimental-test-isolation=none"] : []), "--test-name-pattern=native Pi and State Flow", "benchmarks/benchmark.ts",
		], {
			cwd: root,
			// Admit an independent runner instead of inheriting this file's Node test-runner context.
			env: { ...process.env, NODE_TEST_CONTEXT: undefined, BENCH_REPORT_PATH: reportPath, BENCH_PATCHES: "1", BENCH_SAMPLES: "1", BENCH_ROUNDS: "1", BENCH_STATE_BYTES: "8192", BENCH_TRANSCRIPT_BYTES: mutate ? "4096" : "65536", BENCH_RESOURCES: mutate ? "0" : "1", BENCH_POST_RESUME: mutate ? "0" : "1" },
			encoding: "utf8",
			timeout: 25_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.signal, null);
		assert.equal(child.status, mutate ? 1 : 0, child.stdout + child.stderr);
		assert.match(child.stdout, /BENCH_RESULT /);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.version, 3);
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
			assert.equal(entry.promptPrefixRuns.length, 1);
			const run = entry.promptPrefixRuns[0];
			assert.equal(run.userRun, 1);
			assert.equal(run.patchStateBarriers, entry.stateFlow ? 1 : 0);
			assert.equal(run.nativeUserBytes, Buffer.byteLength(JSON.stringify("Synthetic request 1")));
			assert.equal(run.specificationBytes, entry.stateFlow ? run.nativeUserBytes : null);
			assert.equal(run.inferences.length, entry.stateFlow ? 3 : 2);
			assert.ok(run.inferences[0].contextBytes > 0);
			assert.equal(run.inferences[0].sharedPrefixBytes, null);
			for (const [index, inference] of run.inferences.entries()) {
				if (index === 0) continue;
				assert.ok(inference.contextBytes > 0);
				assert.ok(inference.sharedPrefixBytes > 0);
				assert.ok(inference.sharedPrefixBytes <= Math.min(inference.contextBytes, run.inferences[index - 1].contextBytes));
			}
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
				assert.equal(probe.promptPrefixRuns.length, 1);
				assert.equal(probe.promptPrefixRuns[0].inferences.length, entry.stateFlow ? 3 : 2);
				assert.equal(probe.promptPrefixRuns[0].patchStateBarriers, entry.stateFlow ? 1 : 0);
				assert.equal(probe.promptPrefixRuns[0].specificationBytes, entry.stateFlow ? probe.promptPrefixRuns[0].nativeUserBytes : null);
				assert.ok(probe.firstInference.wallMs.p50 <= probe.wholeRun.wallMs.p50);
				assert.ok(probe.firstInference.gitCalls.p50 <= probe.wholeRun.gitCalls.p50);
				if (entry.stateFlow && probe.selectedRevision) assert.equal(probe.firstInference.commands["commit-tree"], 1);
				else assert.equal(probe.firstInference.gitCalls.p50, 0);
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

test("large-trajectory prefix reports retain native read evidence across active and passive barriers", { timeout: 30_000 }, (t) => {
	const root = sourceFixture(t);
	const reportPath = join(root, "prefix-report.json");
	const child = spawnSync(process.execPath, ["--test", "--test-name-pattern=large-trajectory", "benchmarks/benchmark.ts"], {
		cwd: root, encoding: "utf8", timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, NODE_TEST_CONTEXT: undefined, BENCH_PREFIX: "1", BENCH_REPORT_PATH: reportPath },
	});
	assert.equal(child.error, undefined);
	assert.equal(child.signal, null);
	assert.equal(child.status, 0, child.stdout + child.stderr);
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	assert.equal(report.version, 3);
	assert.equal(report.exitCode, 0);
	assert.equal(report.runtimeSourceUnchanged, true);
	assert.equal(report.workloadSourceUnchanged, true);
	assert.equal(report.configuration.prefixWorkload, true);
	assert.deepEqual(report.trajectory.map((entry: { mode: string }) => entry.mode), ["active", "passive", "stop-handoff"]);
	for (const entry of report.trajectory) {
		assert.equal(entry.promptPrefixRuns.length, 1);
		const run = entry.promptPrefixRuns[0];
		assert.equal(run.patchStateBarriers, 2);
		assert.equal(run.completedReads, 8);
		assert.equal(run.readResultBytes, 20 * 1024 + Buffer.byteLength("BENCH_TRAJECTORY\n"));
		assert.deepEqual(run.inferences.map((inference: { action: string }) => inference.action),
			["read", "read", "read", "read", "read", "read", "patch", "read", "read", "patch", "answer"]);
		assert.equal(run.inferences[0].sharedPrefixBytes, null);
		for (let index = 1; index < run.inferences.length; index++) {
			const inference = run.inferences[index];
			assert.ok(inference.sharedPrefixBytes > 0);
			assert.ok(inference.sharedPrefixBytes <= Math.min(inference.contextBytes, run.inferences[index - 1].contextBytes));
			assert.equal(inference.sharedPrefixBytes, run.inferences[index - 1].contextBytes - 1,
				`${entry.mode} preserves the previous serialized message array except its closing bracket`);
		}
		assert.equal(run.inferences[7].retainedReadBytes, 6 * run.readResultBytes);
		assert.equal(run.inferences[10].retainedReadBytes, 8 * run.readResultBytes);
		assert.ok(run.inferences[7].retainedReadBytes > 10 * run.inferences[0].contextBytes,
			"trajectory must dominate the initial state/context size");
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
			env: { ...process.env, NODE_TEST_CONTEXT: undefined, BENCH_REPORT_PATH: join(root, "report.json"), BENCH_PATCHES: "1", BENCH_SAMPLES: "1", BENCH_ROUNDS: "1", BENCH_STATE_BYTES: "8192", BENCH_TRANSCRIPT_BYTES: "4096", BENCH_RESOURCES: "0", BENCH_POST_RESUME: "1" },
		});
		assert.equal(child.error, undefined);
		assert.equal(child.signal, null);
		assert.equal(child.status, 1, child.stdout + child.stderr);
		assert.match(child.stdout + child.stderr, /post-resume probe changed baseline files/);
		assert.match(child.stdout, /BENCH_RESULT /);
		const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
		assert.equal(report.runtimeSourceUnchanged, true);
		assert.equal(report.workloadSourceUnchanged, true);
		assert.equal(report.exitCode, 1);
		assert.equal(report.lifecycle.length, 0);
	});
}
