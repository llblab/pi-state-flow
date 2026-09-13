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

See the [performance guide](../docs/performance.md) for environment variables, source identity, measurements and limitations. Moving these files changes path-framed workload fingerprints; earlier reports retain their original paths and hashes and are not relabeled as measurements of this layout.
