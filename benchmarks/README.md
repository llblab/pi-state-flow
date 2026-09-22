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

These workloads use the source-bound default `historyLimit`. `BENCH_PHASE` and the final `BENCH_RESULT` JSON are emitted on stdout; capture stdout if a reusable report is needed. See the [performance guide](../docs/performance.md) for source identity, measurements and limitations. Moving these files changes path-framed workload fingerprints; earlier reports retain their original paths and hashes and are not relabeled as measurements of this layout.
