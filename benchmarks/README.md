# Benchmarks

Opt-in synthetic performance workloads, separate from the normal test suite and excluded from the published runtime package. Run from the repository root:

```bash
npm run benchmark

# Lifecycle only
node --experimental-strip-types --test --test-name-pattern='^native' benchmarks/benchmark.ts

# Cooperating publishers only
node --experimental-strip-types --test --test-name-pattern='^two-process' benchmarks/benchmark.ts
```

`benchmark.ts` coordinates measurements and reports. `benchmark-session.ts` owns shared workload/metrics; `benchmark-resume.ts` probes copied sessions; `benchmark-writer.ts` runs an IPC-owned publisher. These workloads reuse synthetic fixtures from `tests/`, not production sessions or stores.

Correctness regressions for the benchmark remain in `tests/benchmark.test.ts` and `tests/benchmark-session.test.ts` and run through `npm test`. Typechecking includes this directory.

Configuration uses positive integers unless noted:

- `BENCH_PATCHES`: Completed requests per session (default `200`).
- `BENCH_SAMPLES`: Independent lifecycle samples (default `3`).
- `BENCH_ROUNDS`: Cooperating-publisher rounds (default `10`).
- `BENCH_STATE_BYTES`: Comma-separated positive payload sizes (default `8192,131072`).
- `BENCH_TRANSCRIPT_BYTES`: Synthetic native-read body size (default `4096`).
- `BENCH_RESOURCES`: `1` enables optional resource counters; omitted or `0` disables them.
- `BENCH_POST_RESUME`: `1` enables isolated post-resume probes; omitted or `0` disables them.

Run the opt-in trajectory-dominant prefix probe independently:

```bash
BENCH_PREFIX=1 BENCH_REPORT_PATH=/tmp/state-flow-prefix.json node --experimental-strip-types --test --test-name-pattern=large-trajectory benchmarks/benchmark.ts
```

Its v3 `trajectory` entries cover active mode, ordinary passive memory and the passive Stop handoff. Each entry's `promptPrefixRuns` records six exact native reads before the first patch and two more before the second, using a 20 KiB source body. Inferences include their next `action`, `contextBytes`, `sharedPrefixBytes` and `retainedReadBytes`; completed read and accepted barrier counts are checked outside the provider. Each run's `reconciliationTailBytes` records zero for a predictable session patch and the minimal nonzero tail after an independently injected Global change; both keep the native prefix intact. No prefix-ratio threshold asserts correctness or provider cache hits. Without `BENCH_PREFIX=1` this extra workload is skipped.

These workloads use the source-bound default `historyLimit`. `BENCH_PHASE` and the final `BENCH_RESULT` JSON are emitted on stdout. Set `BENCH_REPORT_PATH` to also write the final JSON report to that exact file (its parent directory must exist); use this file for machine consumption because test runners can split long stdout lines. The report file is overwritten, including for failed workloads that reach final reporting. Version 3 lifecycle entries contain non-overlapping `promptPrefixRuns` for every completed user run up to that checkpoint; post-resume entries contain one per isolated probe. Each run records serialized model-message bytes for every inference, its longest common UTF-8 byte prefix with the preceding inference (`null` for the first), successful `patch_state` barriers, and the JSON-value byte sizes of the current native user text and matching State Flow `specification` (`null` for native Pi). This is a request-shape proxy, not provider cache or token accounting. See the [performance guide](../docs/performance.md) for source identity, measurements and limitations. Moving these files changes path-framed workload fingerprints; earlier reports retain their original paths and hashes and are not relabeled as measurements of this layout.
