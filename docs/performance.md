# Session performance evidence

## Scope

State Flow must complement Pi's session rather than create a competing transcript or lifecycle. Measure long-history cost separately from semantic-state size, native transcript size, optional Git work, and concurrent publishers. Keep branch-selected state, complete inspectable trace, seven-boundary hot history, source provenance, and accepted-publication guarantees as correctness conditions, not performance trade-offs.

The opt-in workload uses the real installed Pi SDK with a deterministic faux provider and isolated in-memory credentials. All evidence files, sessions, state repositories, and local bare remotes used by the workload are synthetic temporary fixtures. It makes no external model or remote-network calls and does not read production conversations or production state. Do not use a live store as benchmark input.

## Running the workload

From the source checkout:

Current executables and workers live in top-level `benchmarks/`; their regression tests remain in `tests/`. See `benchmarks/README.md` in a source checkout; benchmark sources are not shipped in the runtime package. Historical commands and hashes below describe the earlier `tests/benchmark*.ts` layout. For current direct invocations use `benchmarks/benchmark.ts`; relocation changes the path-framed workload fingerprint, not the retained historical results.

```bash
npm run benchmark
```

The default compares ordinary Pi with enabled State Flow through 200 user runs. Each enabled run performs a native read, one semantic `patch_state` with `final:true`, and one changed accepted response: 200 model patches therefore produce 400 semantic transitions. It samples short and long histories, repeats native JSONL open and extension resume independently, and checks accepted state and native tool evidence rather than timing a disabled or failed runtime.

State Flow cases use 8 KiB and 128 KiB fixed semantic payloads. Each native read returns a 4 KiB synthetic body. The payload is supplied only on the first patch; later patches change a counter, so increasing history does not also increase current-state size. Compaction and automatic retries are disabled to expose the inspected paths without adding model-driven summarization or retry noise.

A separate workload coordinates two OS processes through IPC before each publication attempt. Each process owns a distinct session and uses the same `TemporalRuntime` as the extension. It tests same/different CWDs and session/global writes, retains exact failures, and verifies cold restoration and commit counts for accepted writes. It intentionally does not hide contention through automatic retries. This is separate-process storage evidence, not a claim to have tested two full interactive Pi instances.

For a fast correctness smoke:

```bash
BENCH_PATCHES=2 BENCH_SAMPLES=1 BENCH_ROUNDS=2 BENCH_STATE_BYTES=1024 npm run benchmark
```

Optional environment inputs:

- `BENCH_PATCHES`: User runs per native/enabled case; default `200`.
- `BENCH_SAMPLES`: Resume repetitions per history checkpoint; default `3`.
- `BENCH_STATE_BYTES`: Comma-separated positive semantic payload sizes; default `8192,131072`.
- `BENCH_TRANSCRIPT_BYTES`: Payload bytes written after the evidence marker; default `4096`. This is not guaranteed read-output or transcript size: Pi may truncate the result.
- `BENCH_ROUNDS`: Synchronized publication rounds per two-process case; default `10`.
- `BENCH_RESOURCES`: `1` adds phase-bracketing parent memory/CPU and system-load observations; default `0` omits them. Other values are rejected.
- `BENCH_POST_RESUME`: `1` additionally runs an isolated next-inference probe after each history checkpoint, using `BENCH_SAMPLES` fresh-process copies; default `0` leaves the original workload unchanged. This is an internal synthetic-fixture workflow, not a live-store input mode.

Keep runtime and workload inputs unchanged until the workload exits. Report version 2 records the Git source commit, exact runtime-source hash, and a separate hash of benchmark/helpers plus package/lock inputs; either input set changing fails exit. A dirty development tree is identified by its source hash rather than assumed equivalent to HEAD. Resolved Pi/AI package versions, Git version and available parallelism identify this workload's dependencies, not the operator's running Pi process. Hashes cover declared project inputs, not every installed binary or execution-environment influence. Raw output may be redirected to a local temporary log; `BENCH_PHASE` records incremental results and `BENCH_RESULT` contains the final JSON report. Require the complete matching report from a command's full capture plus its actual exit code, not a bounded actor-output tail. Terminal reports are emitted after test-runner settlement while the event loop can still drain pipe output; forced process termination can still leave no complete report.

## Reading the evidence

- `recentRuns`: Wall-clock and synchronous Git subprocess count/time distributions over the most recent at most twenty runs. The command histogram describes the final sampled run.
- `openSession`: Native `SessionManager.open` timing, separately from constructing/binding the runtime.
- `resumeRuntime`: Resource loading, SDK session construction, extension binding, and State Flow restoration timing. The ordinary-Pi case supplies the host baseline.
- `lastContextBytes`, `contextBytesPerRun`, `inferencesPerRun`: Provider-visible message bytes at the final inference, total message bytes over all inferences in that run, and actual inference count. These are JSON bytes, not tokenizer counts, cache hits, or network measurements.
- `nativeEntries`, `nativeFileBytes`: Full native branch/file size before resume, independent from the projected model context.
- `nativeRead`: At each lifecycle checkpoint and inside `postResume`, byte distributions and per-read scalar samples: `sourceFileBytes` is the actual file size, `textBytes` is the delivered text including any truncation notice, `retainedSourceBytes` excludes that notice, and `truncatedBy` is `bytes`, `lines`, or `null`. `truncatedReads` counts truncated samples. These observations are present independently of `BENCH_RESOURCES`; native output must exactly match the current model-facing read content.
- `publishers`: Accepted/failed attempts, wall-clock distributions including both outcomes, and exact normalized errors. Cold restore and commit-count assertions establish retained accepted state; failed attempts are not successful throughput.
- `samples` with `BENCH_RESOURCES=1`: Per-sample wall/Git intervals plus `resources.before`/`after` timestamps, parent `memoryBytes`, system `hostLoadAverage` and free memory, and `parentCpuMicros` delta. Resource observations bracket the wall timer; they still add allocations/work that can affect subsequent measurements. CPU excludes Git-child CPU, memory is point-in-time rather than peak attribution, and system load is a platform-dependent moving average, not process-specific causality or isolation.
- `postResume` with `BENCH_POST_RESUME=1`: Fresh-process native JSONL open, runtime restoration, request-to-first-model-context and complete next-run measurements. Its resources belong to the probe process, not the baseline process. `firstContextBytes` describes the first model-facing context; `baselineUnchanged` is emitted only after native branch/state checks and full repository/trace/source byte-mode fingerprints pass.

Run before and after on the same Node/Pi versions and machine, with the same dependency-resolution graph, workload configuration and comparable background load. Matching package versions alone do not prove shared physical dependency instances; the [compatibility matrix](compatibility.md) describes the tested graphs. Report sample counts and workload identity alongside percentiles. Git subprocess counts are instrumented at the synchronous invocation boundary; they do not include opaque work inside Git, asynchronous replication, or every filesystem operation. Wall time includes measurement overhead and host work. No machine-local timing threshold or faux-model result proves semantic memory quality, real-model cost, TUI responsiveness, or universally faster inference.

## Matched final-candidate controls

The 2026-09-13 A1 → B1 → B2 → A2 series compares the exact original 0.9.6 runtime with the retained candidate, using the same current workload and package inputs. A copies only `index.ts` and `lib/*.ts` from `5af0063b445dac00b0996c3d4fbd72dc12d7e3a4`; B is the unchanged runtime in the [417-test candidate](compatibility.md). Both disposable copies link the same existing Pi/AI/agent-core 0.84.4 dependency graph, including separate root/SDK-local instances and TypeBox 1.3.7. Node 26.8.1, Git 2.55.0, Linux/x64 and sixteen available logical CPUs match. No live installation or production store was changed.

- A runtime SHA-256: `a81ae9db92239f6210efaca46950fe65cc339c899eaaa07746dac3cd12779d94`.
- B runtime SHA-256: `ce820cd33c34c4c882c11fc55e93f3914cfc8dffae57683e32cdcaa70f225cd2`.
- Shared workload SHA-256: `b861fae36798bf76f56f411cc654c70fc948597bb84cc7a422c83f69ba1ca3e9`.

Runtime framing is `index.ts`, then sorted `lib/*.ts`, each path + NUL + bytes + NUL. Workload framing follows the ordered inputs in `workloadSourceHash()` in `tests/benchmark.ts`. Each copy has a synthetic Git HEAD: the emitted source commit alone does not identify the runtime; exact source hashes and the original revision do. Canonical dependency edges and manifest bytes were checked before and after the series, without deduplicating or reinstalling packages.

Each invocation uses this lifecycle-only configuration; isolated agent/Git configuration, in-memory credentials and faux inference remain as described above:

```bash
BENCH_PATCHES=200 BENCH_SAMPLES=3 BENCH_ROUNDS=10 BENCH_STATE_BYTES=8192,131072 \
  BENCH_TRANSCRIPT_BYTES=4096 BENCH_RESOURCES=1 BENCH_POST_RESUME=1 \
  node --experimental-strip-types --test --test-name-pattern='^native' tests/benchmark.ts
```

All four actual commands and complete reports exited zero. Each has six phase records; all 72 copied resume probes preserved their originals. The 48 enabled copies accepted two further transitions only in their copies. Every enabled primary case reached 200 model patches/400 transitions and 1,803 native entries; ordinary controls retained 802 entries. Across A/B, transition/entry counts and exact native-read evidence match: every current read delivered all 4,111 source bytes, without truncation. No publisher workload ran in this block.

### Complete reports and execution conditions

Runs are `state-flow-final-a1`, `state-flow-final-b1`, `state-flow-final-b2` and `state-flow-final-a2`. Full evidence is each Run's `captures/command-001/attempt-001/stdout.log`, not its truncated aggregate preview; stderr is empty. Source/workload guards, phase/report equality and distributions with retained metric samples were independently verified.

| Sample | Command seconds | Capture bytes | SHA-256 |
| --- | ---: | ---: | --- |
| A1 | 623.4 | 323129 | `282a3392fc4839641d9aaf345d5877eb9a70aa0089f622e3208ac30a415b35db` |
| B1 | 485.4 | 322681 | `56c99c5328f73054b83bff17f6d1873b3929e39f5d8381aa401e87085406c25b` |
| B2 | 507.9 | 323000 | `1e520b5ac5b02d05743faf25698efd1e56ecbe9967caede8f487f9fe6752f03e` |
| A2 | 585.2 | 323347 | `a1cf5f73d4818b35e22efb093bdb6e946aae98ee317272f94497222492d57aef` |

Order is counterbalanced, not fixed spacing: gaps between command completion and the next start were 232.6, 92.3 and 80.5 seconds. Sampled one-minute host-load ranges across primary and probe phases were A1 2.01–6.24, B1 2.05–3.58, B2 1.62–3.75 and A2 2.09–6.07. These are moving-average observations, not CPU attribution or proof of isolation. Two invocations per runtime cannot identify a universal effect size or eliminate environmental variation. The whole-command durations also include untimed setup/copy/preservation work; they are not per-session latency estimates.

### Per-invocation phase results

All cells below are milliseconds at **20 / 200 requests**. Values are p50 except the explicit run-p95 column. Each run distribution has twenty requests; every open/restore/probe distribution has three samples. `P` means the history-building process, `C` a fresh copied-session process. First context is always measured in C, from request admission to the first faux callback. Phase medians must not be added.

| Sample | KiB | Run p50 | Run p95 | Restore P | First context |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 8 | 1115.7 / 1373.7 | 1140.8 / 1636.8 | 587.4 / 866.4 | 357.5 / 545.9 |
| B1 | 8 | 1048.1 / 1104.0 | 1194.6 / 1203.9 | 208.6 / 290.0 | 316.6 / 387.4 |
| B2 | 8 | 1132.5 / 1083.7 | 1226.6 / 1188.6 | 275.1 / 237.0 | 355.5 / 327.5 |
| A2 | 8 | 1138.3 / 1165.1 | 1218.5 / 1209.2 | 626.4 / 611.8 | 392.9 / 418.1 |
| A1 | 128 | 1602.8 / 1539.9 | 1803.7 / 1736.4 | 756.0 / 705.0 | 415.3 / 515.6 |
| B1 | 128 | 1077.1 / 1206.2 | 1303.2 / 1341.5 | 284.9 / 301.5 | 297.6 / 347.5 |
| B2 | 128 | 1219.7 / 1108.6 | 1350.6 / 1228.9 | 227.0 / 294.7 | 311.9 / 388.2 |
| A2 | 128 | 1234.7 / 1518.0 | 1309.5 / 1708.3 | 637.8 / 887.1 | 392.5 / 548.8 |

Native JSONL open is separate from runtime construction/restoration. The copied complete next run includes first context and its subsequent tools, patch and accepted answer; it is not just provider startup.

| Sample | KiB | Open P | Open C | Restore C | Next C |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 8 | 0.9 / 13.4 | 2.0 / 8.9 | 533.0 / 683.3 | 1009.1 / 1400.7 |
| B1 | 8 | 0.9 / 12.1 | 2.1 / 9.1 | 207.1 / 257.4 | 879.7 / 983.5 |
| B2 | 8 | 1.0 / 12.4 | 2.1 / 9.8 | 237.9 / 240.8 | 931.6 / 1027.3 |
| A2 | 8 | 2.2 / 6.5 | 2.6 / 10.0 | 548.0 / 598.6 | 1094.8 / 1092.6 |
| A1 | 128 | 1.0 / 7.7 | 2.4 / 8.9 | 600.1 / 709.8 | 1248.2 / 1344.4 |
| B1 | 128 | 1.2 / 13.4 | 2.6 / 9.2 | 213.4 / 276.9 | 883.0 / 1023.7 |
| B2 | 128 | 1.2 / 6.6 | 2.3 / 9.3 | 240.9 / 251.2 | 886.4 / 1070.0 |
| A2 | 128 | 1.0 / 12.6 | 2.3 / 8.9 | 547.2 / 732.5 | 1076.4 / 1416.6 |

Native controls have two rather than three inferences per request and no State Flow Git work. They describe host-history behavior, not an equal-inference alternative to enabled runs:

| Native control | Run p50 | Restore P | Restore C | First context | Next C |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 3.1 / 17.7 | 1.9 / 2.4 | 15.1 / 16.8 | 9.6 / 13.4 | 28.6 / 51.2 |
| B1 | 3.1 / 17.6 | 1.9 / 2.6 | 14.7 / 14.3 | 9.1 / 12.2 | 28.5 / 43.7 |
| B2 | 2.8 / 16.8 | 2.1 / 2.2 | 13.0 / 13.8 | 7.6 / 12.0 | 22.7 / 42.0 |
| A2 | 3.2 / 19.8 | 2.1 / 3.2 | 15.1 / 16.6 | 9.2 / 12.7 | 28.8 / 51.4 |

### Supported conclusions and limits

- **Structural savings reproduce:** Steady runs and complete copied runs use 120 → 87 synchronous Git calls; both restoration paths use 63 → 21, and the first-context prefix uses 46 → 31. Earlier overflow-boundary requests retain their extra calls. Exact reads, accepted answers, selected state and preservation assertions still pass.
- **Long-case medians improve in both B repetitions:** At 200 requests, 8 KiB run medians are 1083.7–1104.0ms for B versus 1165.1–1373.7ms for A; 128 KiB is 1108.6–1206.2ms versus 1518.0–1539.9ms. Both B medians are also below both A medians for primary/copy restoration, first context and complete copied run. These are ranges of observed invocation medians, not confidence intervals or a guaranteed percentage improvement.
- **Short runs are not uniformly faster:** At twenty 8 KiB requests, B2's 1132.5ms p50 exceeds A1's 1115.7ms despite fewer calls. Both B short-case p95 values exceed A1's 1140.8ms. A1/A2 also change materially without code changes: long 8 KiB run p50 is 1373.7 → 1165.1ms, while short 128 KiB is 1602.8 → 1234.7ms. Keep these observations rather than collapsing the controls into one average.
- **No history-independent latency claim:** B1's first-context medians rise 316.6 → 387.4ms and 297.6 → 347.5ms with unchanged 31 calls; B2's 128 KiB case rises 311.9 → 388.2ms. Identical counts do not bound internal Git work, host cloning, allocation or scheduling. These samples do not isolate the cause.
- **Projection and native trace remain distinct:** First resumed enabled contexts are exactly 9694 / 9712 bytes at 8 KiB and 132574 / 132592 at 128 KiB across all four invocations. Native first-context medians grow from about 105 KB to 1.054 MB. Preserving a compact delivered context does not bound semantic state, the full native trace or Pi's pre-projection history clone.
- **Remaining evidence is separate:** This block covers the 4 KiB-read lifecycle comparison only. The larger-read pair and current large-state boundary follow below; the publisher pair also follows. Separate [integrated-candidate acceptance](compatibility.md#post-measurement-integrated-acceptance) is recorded independently. It establishes neither the production incident's cause nor real-provider latency or universal responsiveness.

### Larger delivered history: matched A/B pair

The same source-bound copies and dependency graph subsequently ran one A → B pair with `BENCH_STATE_BYTES=8192` and `BENCH_TRANSCRIPT_BYTES=32768`, retaining 200 requests, three resume samples, resources and copied probes. Each current read delivered exactly 32,783 source bytes without truncation. Both actual commands and reports exited zero; all 24 copied probes preserved originals, and semantic/entry counts matched. This is one invocation per runtime, not another counterbalanced replication series.

Runs `state-flow-final-read-a` and `state-flow-final-read-b` retain complete captures at the same per-Run path described above:

- A: 214,354 bytes, SHA-256 `7936f49e03e2871c91dddd406674a416625fbfa9690cc19baa301d2bdb1d2d93`; command 344.993 seconds.
- B: 214,057 bytes, SHA-256 `a53223c922f9418d0175106bd12630db931da6d0a6d1ce22b64306ca13886cb1`; command 261.071 seconds, starting 57.732 seconds after A completed.

All values are milliseconds, p50 at **20 / 200 requests**, except the explicit run-p95 column. P/C retain their definitions above; raw reports retain resource samples and all distributions.

| Runtime | Run p50 | Run p95 | Open P | Restore P | First context | Next C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 1594.0 / 1715.8 | 1789.0 / 1951.6 | 2.0 / 27.4 | 754.1 / 828.7 | 476.6 / 467.1 | 1246.5 / 1225.3 |
| B | 976.6 / 1201.5 | 1086.0 / 1290.8 | 2.5 / 28.0 | 222.1 / 298.7 | 318.3 / 378.8 | 884.1 / 1078.9 |

Copied restoration p50 is A 709.9 / 638.4ms versus B 218.6 / 262.9ms. Enabled first-context bytes remain exactly 9694 / 9712 for both runtimes, matching the smaller-read controls. Native first-context bytes instead reach approximately 0.679 / 6.789 MB; native run p50 is A 7.0 / 76.3ms and B 7.8 / 78.0ms. Native copied first context at 200 requests is slower in B's invocation, 22.4ms versus 15.5ms, despite neither doing State Flow Git work.

This pair supports lower enabled phase medians for B under the larger delivered history, not a universal causal speedup. B's enabled run and first-context medians still rise between short/long checkpoints despite compact delivered context. Native history processing and JSONL open remain costs; comparison with the earlier 4 KiB-read block is cross-invocation evidence, not isolation of read volume from time/environment. The original incident remains unattributed. The current large-state and publisher measurements follow below.

### Current large-state boundary

The unchanged B copy then ran twelve requests at 8/128/1024 KiB with 4 KiB reads, three resume samples and resources. `state-flow-final-large-b` completed in 90.737 seconds with actual/report exit zero, empty stderr and a complete 175,385-byte capture, SHA-256 `c67774728e296e116ae83ff1e3b997fb3c2a15327a7b4b252e8c22deb3fdd4f5`. Source/dependency guards and recomputed distributions pass. Each enabled case accepted 24 primary transitions; all twelve native/enabled copied probes preserved originals and accepted the expected copy-only continuation.

Values are milliseconds; medians except explicit p95. Run distributions contain twelve samples, resume/probe distributions three. Here run p95 equals the maximum under nearest-rank selection.

| State KiB | Run p50 | Run p95 | Restore P | Restore C | First context | Next C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 1028.8 | 1075.6 | 279.0 | 216.1 | 403.1 | 1067.4 |
| 128 | 1282.8 | 1373.2 | 333.5 | 233.3 | 400.0 | 1079.0 |
| 1024 | 1799.7 | 4062.7 | 401.6 | 288.2 | 470.8 | 1489.7 |

First resumed context grows with state: 9693, 132573 and 1050077 bytes. Primary JSONL open p50 is 1.3, 1.3 and 2.1ms. The native control has 2.5ms run p50 and a 63,257-byte first context. Retain the 1 MiB run's 4062.7ms tail: successful large-state persistence does not make large payloads cheap or impose a byte cap. This is a short boundary run, not a 200-request 1 MiB result or an A/B latency comparison; the earlier original-runtime output-limit failure is correctness evidence, not a timing sample. Resource observations and all phase distributions remain in the full report.

### Cooperating publishers: final A/B pair

The final two invocations selected only `^two-process`, with ten synchronized rounds and `BENCH_POST_RESUME=0`, on the same pinned environment and source copies. Each case makes twenty attempts from two independent OS processes, not two live Pi UIs. Both actual commands/reports exited zero. Assertions bind accepted publications to commit-count increments, cold-restored accepted step counts and selected-scope writer ownership.

- `state-flow-final-publishers-a`: 23.288 seconds, complete 5,119-byte capture, SHA-256 `69c444f40d8d1cabcb827fcaa44fb5f3185ba17666008a67e3077a1bae0b6280`.
- `state-flow-final-publishers-b`: 20.094 seconds, complete 5,076-byte capture, SHA-256 `dcbc4826d6be7d41e9d67b2542ff3adea09c27a2a746beee3913a8a8e0428932`; start 40.435 seconds after A completed.

Both captures have empty stderr. Local fixture initialization pushes only to temporary bare remotes. Configuration, complete phase/report equality, source/dependency guards and accepted/error totals were checked.

| CWD | Scope | Accepted A / B | Lock refusals A / B | Stale-basis refusals A / B |
| --- | --- | ---: | ---: | ---: |
| Same | Session | 10 / 10 | 10 / 10 | 0 / 0 |
| Same | Global | 1 / 2 | 10 / 10 | 9 / 8 |
| Different | Session | 10 / 10 | 10 / 10 | 0 / 0 |
| Different | Global | 1 / 3 | 10 / 10 | 9 / 7 |

Lock diagnostics require reconciliation of the active/interrupted publisher; global stale-basis diagnostics require refreshing or reconciling the target scope. This workload does not refresh a rejected global basis between rounds, so repeated stale refusal is expected rather than evidence of lost accepted writes. A accepted 22/80 and B 25/80; the difference does not prove fairness or improved useful throughput.

Reported mixed-attempt p50/p95 milliseconds are A/B: same-session 3.1/465.9 versus 3.1/348.8; same-global 1.5/44.3 versus 1.8/255.3; different-session 3.1/503.1 versus 2.5/344.8; different-global 2.1/43.9 versus 2.1/266.4. More successful global attempts can increase these mixed tails. Fast refusals dominate medians; they are not successful-publication latency. Publisher reports retain aggregate distributions and diagnostics, **not raw attempt samples or phase resource samples**, despite the shared resources configuration flag. Independent distribution recomputation or resource attribution is therefore not claimed for this block.

### Measurement closure

All nine planned invocations are accepted, sequential and source-bound; the seven lifecycle invocations contain 108 preserved copied probes, excluding six setup probes. Complete captures, actual exits and guards are retained with `/tmp/state-flow-final-controls-CzaHqM/final-series-receipts.json`. Lifecycle distributions were independently recomputed from retained samples; publisher aggregates have the narrower evidence boundary above.

The candidate reduces proven Git/allocation work and shows lower enabled long-case medians in these controls while preserving selected state and accepted continuation. It does not eliminate native history handling, payload cost, timing variability or safe contention refusal. Adverse short-case/tail observations remain. No further runtime correction is justified by these measurements alone; original production slowdown attribution remains unproven. Separate [integrated review/acceptance](compatibility.md#post-measurement-integrated-acceptance), not this measurement closure, governs local candidate readiness; release authorization and remote CI remain separate gates.

The following older datasets retain their own source identities and adverse observations; they are not substituted for this matched final-runtime comparison.

## Measured 0.9.6 baseline

The 2026-09-12 Linux/x64, Node 26.8.1, repository-local Pi 0.84.4 run used `BENCH_STATE_BYTES=8192 BENCH_SAMPLES=3 BENCH_ROUNDS=10 npm run benchmark`, source commit `5af0063b445dac00b0996c3d4fbd72dc12d7e3a4`, and runtime SHA-256 `a81ae9db92239f6210efaca46950fe65cc339c899eaaa07746dac3cd12779d94`. Runtime source remained unchanged; both workload families passed with exit code zero. The globally installed Pi package was 0.85.1, but it was not the SDK used by this baseline.

Run timing percentiles use the most recent twenty runs at each checkpoint. Resume figures are medians of three restorations. All times exclude real-model inference; enabled runs include their additional State Flow barrier and durable commits, so native/enabled wall times describe the operational cost rather than equal numbers of inferences.

| Mode | User runs | Run p50 ms | Run p95 ms | Git calls/run p50 |
| --- | ---: | ---: | ---: | ---: |
| Native Pi | 20 | 3.4 | 15.0 | 0 |
| Native Pi | 200 | 17.1 | 19.8 | 0 |
| State Flow, 8 KiB payload | 20 | 1352.2 | 1523.8 | 120 |
| State Flow, 8 KiB payload | 200 | 1261.2 | 1429.1 | 120 |

At 200 runs, State Flow had 200 model patches, 400 accepted semantic transitions, 1,803 native branch entries, and a 1,460,928-byte native session file. Native JSONL open took 7.1 ms median; runtime construction/restoration took 587.6 ms median and 63 synchronous Git calls. Synchronous Git time per sampled ordinary stateful run had a median of 1,146.1 ms. The final projected message context stayed near 15.3 KB at both history checkpoints; the ordinary-Pi context grew from 104.9 KB to 1,053.7 KB.

A follow-up used a 128 KiB payload with the same runtime hash and all other workload parameters unchanged. Both workload families passed. Stateful run p50 was 1,651.8 ms at twenty runs and 1,391.4 ms at two hundred (p95 1,863.4/1,427.4 ms); the Git-call median remained 120. After two hundred runs, resume took 783.5 ms median and 63 Git calls, while final projected messages occupied 138,137 bytes. The paired native-Pi control took 16.8 ms median per run at the long checkpoint. Independent session publishers again accepted 10/20 attempts for each CWD arrangement, with the other attempts rejected at the lock.

Neither fixed-payload workload reproduces a history-driven State Flow slowdown between twenty and two hundred patches. They expose a large fixed synchronous publication/restoration cost and confirm reduced provider-visible context, without erasing the host's full trace or proving which mechanism caused the operator's incident. The payload-size comparison is observational across separate runs, not an isolated estimate of per-byte cost. Explicit first-inference-after-resume, larger transcript/state boundaries, and installed-host evidence remain separate obligations.

Ten synchronized two-process rounds accepted 10 of 20 independent session writes for both same-CWD and different-CWD cases; the other ten failed at the occupied publication lock. Accepted writes matched committed transition counts and survived cold restoration. Shared-global cases additionally produced named stale-target conflicts (one accepted write in the same-CWD case, two in different CWDs). These intentionally unretried outcomes distinguish lock contention from stale shared-state basis; they establish neither lost accepted writes nor useful concurrent throughput.

## Candidate: single-use selected-revision inspection

After the integrity/lifecycle fixes, a native regression reproduced two reads of every selected Git checkpoint during branch restoration. The candidate now reuses one validated immutable inspection for the matching selected owner, without caching its live publication basis. File-cohort expiry, legacy snapshot fallback and owner redirection retain fresh validation. Native reload/resume checks cover enabled and config-only stopped revisions plus all scoped offsets `0..7`.

A short same-machine comparison used this exact command before and after the restoration change:

```bash
BENCH_PATCHES=2 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192,131072 npm run benchmark
```

Both runs used Linux/x64, Node 26.8.1 and repository-local Pi 0.84.4; both workload families passed with unchanged runtime-source evidence. Before SHA-256: `2ef8c9072dbc25a392a46ed12dcf53808c24f043b5d189be676a48045eb0a40e`. After: `b2988e0350633ac70a0b2620ac34cefabf43f6de218e893c7bb05c77a5776f9a`. Each stateful case contains two model patches/four accepted transitions and three resume samples.

| State payload | Before resume p50 ms | After resume p50 ms | Before Git calls | After Git calls |
| --- | ---: | ---: | ---: | ---: |
| 8 KiB | 533.5 | 319.7 | 63 | 35 |
| 128 KiB | 648.8 | 339.1 | 63 | 35 |

The removed calls are one capability probe, one repository-root query, two commit checks, fourteen tree queries, nine blob reads, and one runtime-owner log query per matching restoration. The operation-count reduction is structural; wall-time medians are small observational samples, not a universal speedup or an explanation of the original incident. Publication/run hot paths and Pi's own transcript handling are not optimized by this change.

### Completed 200-run comparison

The candidate repeated both original workload configurations sequentially on the same Node/Pi versions and machine. Each command and each `BENCH_RESULT` completed with exit code zero; both reported unchanged runtime SHA-256 `b2988e0350633ac70a0b2620ac34cefabf43f6de218e893c7bb05c77a5776f9a`. Each stateful case verified 200 model patches, 400 accepted transitions, selected state and cold restoration. The native control ran separately in each command. The corrected launcher used `env` plus `npm --prefix`; an earlier argv-invalid attempt ran neither workload and supplies no benchmark evidence. Read per-command captures, not only a multi-command Run's final output/status.

All table values are milliseconds. Resume medians have three samples; ordinary-run medians use the final twenty requests.

| Payload | Resume 0.9.6 p50 | Resume candidate p50 | Run 0.9.6 p50 | Run candidate p50 |
| --- | ---: | ---: | ---: | ---: |
| 8 KiB | 587.6 | 443.9 | 1261.2 | 1442.4 |
| 128 KiB | 783.5 | 415.0 | 1391.4 | 1681.4 |

Resume used exactly 35 Git calls in every sample at both twenty and two hundred requests, versus 63 in the baseline. At two hundred requests, candidate resume ranges were 400.5–539.7 ms and 414.7–444.5 ms for 8/128 KiB. The measured resume medians improved by 24.5%/47.0%; these remain observational samples, while removal of 28 invocations is a structural result.

Ordinary runs did **not** improve: their long-checkpoint medians were 14.4%/20.8% slower than baseline, with unchanged 120-call medians and candidate p95 of 1686.0/1903.6 ms. Synchronous Git interval medians also rose, from 1146.1 to 1317.2 ms and from 1242.3 to 1504.9 ms. Candidate run p50 at twenty requests was 1161.9/1694.4 ms, so only the 8 KiB case showed a higher long-checkpoint median. These observations neither isolate an environment effect nor establish a code- or history-caused regression. Keep the timing increase unexplained; the later call-site attribution below does not isolate its cause. Do not dismiss it as noise or infer universally faster sessions from resume alone.

Both long cases retained 1,803 native entries. Final projected messages were 15,252/138,137 bytes, while native controls remained about 1.05 MB; complete stateful trace files were 1,459,702/1,583,597 bytes. Opening those stateful JSONL files through native `SessionManager` took 13.1/7.0 ms median, separate from runtime resume and from first inference after resume, which that comparison did not measure.

Each candidate's same/different-CWD session-publication cases accepted 10/20 attempts; each global-publication case accepted 2/20. Remaining failures were explicit busy-lock or stale-global-target rejections. Accepted-commit counts and cold restoration passed. This preserves the cooperating-publisher distinction, not a claim of improved contention throughput.

## Candidate: operation-local exact-tree reads

A separate call-site diagnostic traced synchronous Git calls during the tenth synthetic native run after nine warm-up requests. It used an 8 KiB fixed payload, a 4 KiB synthetic read payload plus its evidence marker, local-only publication, and the same read → final patch → changed-answer sequence; every request verified its counter and the final snapshot retained twenty accepted transitions. The diagnostic recorded `spawnSync` stacks, not production trace bodies. Before source was the restoration candidate `b2988e0350633ac70a0b2620ac34cefabf43f6de218e893c7bb05c77a5776f9a`; after was `97be80c1d84eebaa3ef26f5137381799e903b15868ade931eaedfd0a35b3941a`. Both diagnostic runs passed.

| Owning path | Before calls | After calls |
| --- | ---: | ---: |
| `loadTemporalRevision`: runtime-only configuration publication proof | 27 | 13 |
| `includeUncommittedCohort`: two semantic publications' selected-file anchoring | 28 | 16 |
| `commitOwnedFiles`: three isolated commits and index synchronization | 47 | 47 |
| Live publication basis and lock/root queries | 18 | 18 |
| Total | 120 | 94 |

The reader now makes one exact-path tree query per inspected revision/cohort rather than one per file, retaining lazy regular-blob checks and content reads. A same-path cache also removes the duplicate session-meta blob read within cold reconstruction. The steady-run reduction is 25 tree queries plus one blob read; no commit, fresh-base acquisition, CAS, or selected-file validation is omitted. The unchanged index family includes ten `hash-object` and ten `update-index` calls. Full selected-file/mode/fallback boundaries and native reload/resume projections have deterministic witnesses in the [acceptance map](temporal-acceptance.md).

The identical three-sample short command above also passed for the new source hash, with unchanged-source and exit-zero evidence. Each enabled case still had two model patches/four accepted transitions. Resume calls fell from 35 to 21 in every sample; 8/128 KiB resume medians were 203.6/228.3 ms, compared with 319.7/339.1 ms before batching. Short ordinary runs used 96 calls rather than 124, with medians of 946.7/1126.3 ms. Before tail overflow, the unchanged session checkpoint cannot short-circuit anchoring, so each semantic publication also reads its old tail; the steady diagnostic therefore has two fewer calls than the two-request workload. Two-round process probes retained accepted state and cold restoration, with session cases accepting 2/4 and global cases 1/4 for both CWD arrangements.

These timings remain small observations, not a full-length comparison or an explanation of the earlier adverse medians. The single diagnostic's aggregate synchronous Git intervals changed from 933.8 to 798.3 ms, but the unchanged 47-call index family itself changed from 333.5 to 387.8 ms. That variation is not an isolated causal result. The earlier 200-request comparison predates tree batching and cannot establish its long-session timing. Native trace ownership, phase boundaries, and performance limitations above remain unchanged.

## Candidate: batched prepared index writes

The next candidate, runtime SHA-256 `423d999762e936233d596b1c6c32f5d56b98d2710d3b198706a88b990368ca83`, keeps each exact prepared content's native `hash-object` call but overlays its resulting object/path record through one NUL-delimited `update-index --index-info` call per commit. Explicit deletions, full-delta staging, final prepared-byte checks, reference CAS, caller-index synchronization and rollback are unchanged. Focused ordinary/literal-path tests first observed eight updates instead of the required one; the retained tests compare every committed byte, rejected partial batches, retry and cleanup, including existing SHA-256 repositories.

The same tenth-run diagnostic verified twenty transitions and 87 synchronous Git calls: 16 anchoring, 13 runtime-only revision proof, 40 isolated commit/index, and 18 live-basis/lock calls. The seven removed calls are exactly the reduction from ten to three index updates across three commits. No additional read, hash, commit, or CAS check was removed.

The identical two-request/three-resume short command passed both payload cases with unchanged-source evidence. Compared with the preceding tree-reader candidate, call counts improved but wall times did not:

| Payload | Run Git calls | Run p50 ms | Resume p50 ms |
| --- | --- | --- | --- |
| 8 KiB | 96 → 89 | 946.7 → 1969.1 | 203.6 → 460.8 |
| 128 KiB | 96 → 89 | 1126.3 → 1994.3 | 228.3 → 544.5 |

Resume still used exactly 21 calls, with no index-update commands in that phase. The single steady diagnostic's aggregate Git interval was 1651.8 ms versus 798.3 ms before, despite fewer invocations; all four caller families increased. A system snapshot about two minutes after the short workload ended showed load averages 7.70/8.58/5.75 on sixteen logical CPUs and active compiler processes. That observation is neither phase-aligned telemetry nor a matched baseline and does not prove why timings changed. Unchanged index-free resume is a useful negative control against a direct explanation confined to the modified index path, not proof that all resource effects are unrelated to the workload.

Both stateful cases retained four accepted transitions, selected state and complete native trace. Two-round process cases retained all accepted commits/cold states: session cases accepted 2/4 in both CWD arrangements; global cases accepted 1/4 for same CWD and 2/4 for different CWDs. Invocation reduction is established; latency improvement, causal attribution of the adverse observations, and the latest full-length comparison are not. Interleaved controls and phase-associated resource evidence are the next discriminating measurement, rather than discarding unfavorable samples or changing unrelated machine processes.

## Controlled short comparison and source drift

A bounded A/B comparison kept the working runtime unchanged and used disposable source checkouts linked to the same installed dependency tree. A reconstructed the exact pre-index-batch runtime hash `97be80c1d84eebaa3ef26f5137381799e903b15868ade931eaedfd0a35b3941a`; B retained `423d999762e936233d596b1c6c32f5d56b98d2710d3b198706a88b990368ca83`. Both ran identical workload hash `b5ebea98e06704d4aa502c3c74cc9aa35c6c74434b00451746a69d77f7462bb1`, Node 26.8.1, Pi/AI 0.84.4 and Git 2.55.0. Source hashes, configuration, command exit, complete reports and correctness assertions were checked for each invocation; no production conversation, state store, dependency installation, or unrelated process was modified.

The sequence was A1 → B1 → B2 → A2, with twelve requests per native/enabled case, both 8/128 KiB payloads and three resume samples. It was counterbalanced order, not fixed spacing: the valid A1 report was retained across a verifier correction for the first overflow boundary. Each stateful case accepted exactly twenty-four transitions. A's calls by request were `96,96,96,95,94…`; B's were exactly seven fewer. The fourth request straddles first tail overflow. All stateful resumes used 21 calls and no index update. These lifecycle-only controls deliberately omitted the separately validated publication contention workload.

From each disposable source checkout, the invocation was:

```bash
BENCH_PATCHES=12 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192,131072 BENCH_RESOURCES=1 \
  node --test --test-name-pattern='native Pi and State Flow' tests/benchmark.ts
```

Times below are milliseconds. Run medians use twelve requests per invocation; resume medians use three samples. Load ranges cover observations during enabled run/open/resume phases, not instantaneous CPU utilization.

| Order | 8 KiB run / resume p50 | 128 KiB run / resume p50 | One-minute load range |
| --- | --- | --- | --- |
| A1 | 881.0 / 206.1 | 1029.4 / 219.7 | 3.49–3.68 |
| B1 | 861.5 / 215.6 | 988.5 / 244.9 | 2.52–2.84 |
| B2 | 973.9 / 186.8 | 1001.5 / 426.6 | 2.71–4.06 |
| A2 | 1817.5 / 490.2 | 2326.7 / 504.3 | 5.42–14.58 |

A2 reproduced a large slowdown **without changing A's runtime or workload source**. Native zero-Git run medians also rose from 2.6 to 7.6 ms between A1/A2. End-of-run parent RSS stayed near 226–227 MiB for 8 KiB and 318 MiB for 128 KiB; heap-used endpoints were likewise close. Parent CPU medians rose from 450.9 to 551.6 ms and from 532.1 to 677.5 ms, less than the wall-time increase. The phase-associated rise in host load supports a changing-resource-conditions explanation, but these observations do not identify a process, scheduler, filesystem, frequency, or GC mechanism.

The large swing is therefore not evidence of an effect exclusive to the index change. Conversely, the changing conditions and small number of independent invocations do not establish a stable latency benefit or causal effect size for batching. Keep the adverse samples: operation-count savings are proved, the original long-session incident remains unisolated, and a controlled full-length comparison is still distinct from these short controls.

`tests/benchmark.test.ts` retains a small deterministic contract check, not a performance threshold: optional samples have phase/resource evidence, resource-off output omits them, runtime/workload identities remain distinct, and changing a workload helper after measurement starts must fail exit even when semantic assertions pass. Both inherited Node test-runner context and complete `BENCH_RESULT` presence are checked so an empty/skipped child cannot masquerade as benchmark success.

## Isolated first inference after resume

`tests/benchmark-session.ts` now owns the shared deterministic read → final patch → accepted-answer workload and phase recorder. A measurement checkpoint freezes its prefix counters before the first faux-provider callback performs observation or produces a response. Current native tool-result identity is checked, not merely the presence of an old evidence string. `tests/benchmark-resume.ts` runs that same workload in a fresh process after copying the benchmark's synthetic Git repository and native JSONL into another fixture. The selected CWD/session identity and revision stay the same; physical state and transcript writes go only to the copy.

Before the first resumed inference, the probe verifies the selected revision/leaf/state. The first model context must contain exactly one State Flow projection with that state and the new request, without completed read bodies. The copied run then verifies paired current-read evidence, its accepted answer and two transitions, or zero transitions for the native control. The parent verifies its original repository—including Git metadata—JSONL, evidence-file bytes/modes, leaf, cached state and resolved snapshot after every probe. Faulted workers that report success and then alter the baseline session or repository still fail the parent workload. These are synthetic copies, not hidden replacement of a production session.

Clone/import setup, identity verification and preservation checks are outside timed phases and can warm filesystem caches. `firstInference` starts at the resumed `session.prompt` and ends at the first model-facing callback, before fake response generation; it is not real provider latency or time to first token. The probe's fresh-process memory differs from the original history-building process. Do not sum phase medians into an end-to-end resume promise.

A twelve-request smoke used the unchanged runtime `423d999762e936233d596b1c6c32f5d56b98d2710d3b198706a88b990368ca83` and workload hash `78990bf5397b3ac61288a9a6311e8454cb2088f708a13b3e378d75c7fe275a3d`, with both hashes verified unchanged at exit:

```bash
BENCH_PATCHES=12 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192,131072 BENCH_RESOURCES=1 BENCH_POST_RESUME=1 \
  node --test --test-name-pattern='native Pi and State Flow' tests/benchmark.ts
```

Every enabled baseline retained exactly twenty-four transitions; each of its three probes accepted two additional transitions only in its copy. All baseline-preservation checks passed. Times below are medians of three fresh-process probes, not a paired latency comparison with the previous same-process resume samples.

| Mode / payload | Probe resume ms | First context ready ms | Resume / first Git calls | First context bytes |
| --- | ---: | ---: | --- | ---: |
| Native Pi | 13.7 | 9.3 | 0 / 0 | 63235 |
| State Flow, 8 KiB | 219.6 | 278.2 | 21 / 31 | 9693 |
| State Flow, 128 KiB | 199.0 | 313.9 | 21 / 31 | 132573 |

The thirty-one first-context calls include the runtime-only configuration publication and its immutable revision proof before model execution: nine `rev-parse`, two `cat-file`, one `ls-tree`, eight `show`, one `log`, one `symbolic-ref`, two `read-tree`, one `add`, two `hash-object`, and one each of `update-index`, `write-tree`, `commit-tree`, `update-ref`. They are separate from the twenty-one restoration calls. First-context synchronous Git medians were 234.6/256.4 ms for 8/128 KiB; complete copied runs used 87 calls and took 812.9/890.6 ms median. This locates substantial fixed work without establishing the operator's original incident cause or history-independent total inference latency.

### Terminal-report correction and partial long-run observations

The first 200-request invocation, `run:state-flow-first-inference-200`, completed its native test and command with exit zero after 562.7 seconds. Its full `captures/command-001/attempt-001/stdout.log` contains 292457 bytes (SHA-256 `295a76cf269ef75b1becb61fee0d6c4cca3b26f133df984a51f571641599354e`). All six incremental phase records parse and their sample distributions agree, but the final `BENCH_RESULT` ends inside a numeric resource field before its source-unchanged flags and exit code. This is truncated benchmark output in the full capture, not merely the actor's bounded display. The initial source header matches the runtime/workload hashes above; final guard fields must not be invented. Retain this as phase-only evidence, not a qualified complete report.

Those complete phase records report 40/400 transitions and 183/1803 native entries at twenty/two hundred requests in each enabled case, unchanged baselines in every probe, and 21/31/87 Git calls for probe restoration/first context/whole copied run. Adverse times remain retained: 8 KiB ordinary-run medians rose from 910.0 to 1036.6 ms, while 128 KiB rose from 1031.3 to 1593.4 ms. Their final-twenty-request one-minute load observations ranged 10.87–13.33 and 14.93–16.82 respectively. First-context medians were 276.2 → 307.1 ms and 314.1 → 303.4 ms; projected first-context bytes were 9694 → 9712 and 132574 → 132592. These are partial-report observations, not isolated history effects, a completed source-guarded comparison, or a reason to discard the slower samples.

A small regression reproduced large `console.log` output being lost from an `exit` listener. Synchronous writes to the nonblocking output pipe instead failed with `EAGAIN`; emitting directly from `beforeExit` could report zero before Node's test runner finalized a failing status. Both benchmark entrypoints now use a one-shot `beforeExit` callback followed by `setImmediate`: runner settlement precedes reporting and asynchronous output can drain before natural exit. The contract test pads both main and probe reports beyond one MiB, checks native isolated and in-process runner paths, and still requires correct failing source-drift/baseline-drift exits. This changes report delivery, not the measured runtime or phase workload.

### Verified 200-request first-inference probe

The repeat, `run:state-flow-first-inference-200-report`, completed in 457.2 seconds with command and report exit zero. Runtime `423d999762e936233d596b1c6c32f5d56b98d2710d3b198706a88b990368ca83` and corrected-report workload `f3f056ce4571fad32e53ebd54fc4fcf0531226e2d729df203db3aefd16fd611f` both remained unchanged. The complete command capture has 292152 bytes, SHA-256 `b3d9118aa164caebec036d815fc9a0903da59de90661fed11b9bbda1d8ac0214`. Its six phase records exactly match the final report; distributions were recomputed from every retained resource sample. The tested stack remains Node 26.8.1, Pi/AI 0.84.4 and Git 2.55.0, not proof of the operator's running host.

```bash
BENCH_PATCHES=200 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192,131072 BENCH_RESOURCES=1 BENCH_POST_RESUME=1 \
  node --test --test-name-pattern='native Pi and State Flow' tests/benchmark.ts
```

Each enabled primary case accepted 200 model patches/400 transitions and retained 1803 native entries. All eighteen fresh-process probes preserved their primary session/store; the twelve enabled copies each accepted two further transitions only inside the copy. Every stateful restoration used 21 Git calls, every first-context prefix 31, and every complete copied run 87 at both history checkpoints. Ordinary runs used `89,89,89,88,87…` before steady state; all final-twenty samples used 87. This invocation deliberately omitted publication contention, so it adds no new concurrent-publisher evidence.

Run medians use twenty requests; each probe median uses three fresh processes. All times are milliseconds and phases remain separate, not additive resume promises.

| Mode | Runs | Run p50 ms | Probe resume ms | First context ms | First context bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native Pi | 20 | 3.2 | 13.9 | 9.8 | 105443 |
| Native Pi | 200 | 17.3 | 14.2 | 13.7 | 1054598 |
| State Flow, 8 KiB | 20 | 927.7 | 200.8 | 289.1 | 9694 |
| State Flow, 8 KiB | 200 | 963.8 | 249.3 | 336.9 | 9712 |
| State Flow, 128 KiB | 20 | 1050.0 | 211.0 | 300.1 | 132574 |
| State Flow, 128 KiB | 200 | 1071.5 | 231.9 | 304.8 | 132592 |

At two hundred requests, first-context synchronous Git medians were 292.8/253.1 ms for 8/128 KiB. Whole copied runs took 921.2/904.8 ms median. Original-process resume medians were 235.6/243.5 ms, separately from native JSONL open at 13.8/7.5 ms. Complete trace sizes were 1460913/1584776 bytes and final-inference contexts 15258/138141 bytes. Initial and first-resumed context lengths do not cap native trace, semantic state or host-side cloning.

The 8 KiB first-context median increased from 289.1 to 336.9 ms despite unchanged call counts; constant invocation counts do not prove constant internal Git, allocation or scheduling work. Final ordinary-run one-minute load observations were 3.63–3.78 and 3.23–3.71 for the two payloads, different from the earlier partial run. The repeat was required to recover complete output, not chosen to replace adverse timings. These are qualified instrumented candidate observations, not a matched latency comparison with the resource-off original baseline or an isolated explanation of the production incident.

## Large-state boundary: implicit Git output limit

A two-request probe with a 1 MiB state payload failed on the otherwise unchanged `423d999762e936233d596b1c6c32f5d56b98d2710d3b198706a88b990368ca83` runtime: the first model patch was accepted, but the runtime response remained empty rather than accepting the native terminal answer. The complete failed report retained workload hash `f3f056ce4571fad32e53ebd54fc4fcf0531226e2d729df203db3aefd16fd611f`, unchanged-source flags and exit one; it is not a timing sample of a successful stateful run. A smaller direct Git regression exposed `spawnSync git ENOBUFS` while reading the committed checkpoint. Its 589824-character Unicode payload occupies 1179648 UTF-8 bytes, demonstrating a byte-buffer limit rather than a semantic string-length rule.

The selected immutable-blob reader now requests unbounded subprocess capture only for its already-selected, regular-file `git show` reads. This removes Node's implicit 1 MiB output ceiling for state/runtime JSON, without changing other Git commands, the 15-second command timeout, mode/path checks, live-base acquisition or CAS. It introduces no semantic size cap and does not promise unlimited machine memory. Tests cover oversized checkpoints, tails, runtime metadata, historical reads and subsequent runtime-only publication; a native witness additionally covers accepted answers, reload, resume, exact selected leaf/revision and a large specification.

The corrected runtime is `d082ee822c6219112ec54a69761ed2cec76133fe29869fb34ee1e1e986d49dcb`; the workload hash is unchanged. The exact failing two-request configuration now passes with four primary transitions and two more only in the copied probe, with an unchanged primary fixture. A further twelve-request comparison used:

```bash
BENCH_PATCHES=12 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192,131072,1048576 BENCH_RESOURCES=1 BENCH_POST_RESUME=1 \
  node --test --test-name-pattern='native Pi and State Flow' tests/benchmark.ts
```

The complete report and all four phase records agree, both source hashes remain unchanged, and the command exits zero. Each enabled case retains twenty-four transitions; all twelve copied probes preserve the original fixtures. Stateful probe restoration/first-context/whole-run counts stay 21/31/87, with ordinary pre-overflow requests retaining their existing 89/88-call costs. The native control uses zero Git calls. Times below are observational medians: twelve primary requests and three fresh-process probes per case, with the same 4 KiB read payload throughout.

| State payload | Run p50 ms | Probe resume ms | First context ms | First context bytes |
| --- | ---: | ---: | ---: | ---: |
| 8 KiB | 942.3 | 212.7 | 301.4 | 9693 |
| 128 KiB | 1010.5 | 221.1 | 338.5 | 132573 |
| 1 MiB | 1596.9 | 257.1 | 323.6 | 1050077 |

The 1 MiB primary-run p95/max was 3884.7 ms, while its Git p95 was 1254.2 ms; the fix restores correctness, not uniformly cheap large-state processing. Its first-context size was 2098230 bytes in the earlier two-request probe, so neither state nor early-run context is capped by the hot-history window. This is short large-state evidence, not a new matched 200-request comparison or an explanation of the production incident.

A separate native-read boundary check also showed why fixture bytes must not be mislabeled as transcript bytes. With the existing two-line fixture shape, source files of 4111, 32783 and 65551 bytes produced 4111, 32783 and 82 text-output bytes respectively. The last output contains only 14 source bytes plus Pi's truncation notice, not a 64 KiB transcript contribution. The explicit accounting below closes that measurement gap; this observation does not alter the 4 KiB read payload used by the state-size comparison above.

## Native-read output accounting

The shared prompt workload now observes the public `tool_execution_end` event for its exact current read id, retains scalar byte/truncation evidence, and verifies that the later model input contains the same native content. Observer ownership ends on both success and failure. Source-file size is obtained outside timed phases; native-result copying and delivery checks are inside the whole-run timer, so the changed workload identity matters for comparisons. Tests cover full UTF-8 output, byte truncation with both a single oversized line and many fitting lines, line-count truncation, and observer cleanup in native and enabled sessions.

A falsifier that rewrote the model-facing result while retaining the marker also exposed faux-provider error conversion: a callback assertion becomes an assistant error message instead of rejecting `session.prompt`. The old native control could count that attempted callback as its final inference. The shared workload now checks the actual native terminal stop reason and exact accepted answer, in addition to State Flow's persisted response. That negative case is rejected instead of becoming a successful timing sample.

Two twelve-request observations kept the 8 KiB state payload and runtime hash `d082ee822c6219112ec54a69761ed2cec76133fe29869fb34ee1e1e986d49dcb` fixed, using workload `a779414576e84ada99206f30d99252429ef7ba14fe35cdcff7722f89f358c8b6`. Both commands, complete reports, all phase records, every read sample, source guards and copied-baseline checks passed. Each enabled case accepted twenty-four primary transitions; copied enabled runs added two only in their own fixtures. The stack remains Node 26.8.1 and Pi/AI 0.84.4.

```bash
BENCH_PATCHES=12 BENCH_SAMPLES=3 BENCH_ROUNDS=2 BENCH_STATE_BYTES=8192 BENCH_TRANSCRIPT_BYTES=32768 BENCH_RESOURCES=1 BENCH_POST_RESUME=1 \
  node --test --test-name-pattern='native Pi and State Flow' tests/benchmark.ts
# Repeat with BENCH_TRANSCRIPT_BYTES=65536, leaving other inputs unchanged.
```

Per-read bytes below agree across native/enabled primary runs and their fresh-process probes. Truncated counts are twelve primary reads and three copied reads per case, not lost State Flow transitions.

| Payload | Actual file bytes | Delivered text bytes | Retained source bytes | Truncated reads |
| --- | ---: | ---: | ---: | --- |
| 32 KiB | 32783 | 32783 | 32783 | 0/12 primary, 0/3 probe |
| 64 KiB | 65551 | 82 | 14 | 12/12 primary, 3/3 probe |

After twelve requests, the native final-inference context was 406854 bytes for the smaller file but only 17310 for the larger truncated file; enabled contexts were 43905/11451 bytes. The first resumed enabled context stayed 9693 bytes in both cases, excluding completed read bodies. Native run medians were 5.2/2.8 ms and enabled medians 904.7/901.8 ms. Enabled first-context medians varied 366.8/522.2 ms despite identical first-context size and 31 Git calls. These are small sequential observations, not an isolated resource effect. The apparently cheaper native workload for the larger file is not superior transcript scaling: it delivered much less content. No host truncation limit or production runtime behavior was changed by this instrumentation.

## Tool-preflight parent traversal

`assistantToolBatch()` previously called native `getBranch()` before searching backwards for the assistant containing the current tool ID. The 2026-09-12 correction replaces that full-path allocation/reversal with public parent lookups from the selected leaf, stopping at the same matching assistant. It adds no batch cache, history cap or host patch. Runtime identity changed from `d082ee822c6219112ec54a69761ed2cec76133fe29869fb34ee1e1e986d49dcb` to `3b9c3d176c270b4a1cae261a4dc3bc5eee48bb9fbd5eca7817485eebf1849ac8`.

The regression uses real in-memory `SessionManager` trees with zero or two hundred synthetic request/answer pairs: four hundred historical messages in the long case, not two hundred State Flow patches or provider invocations. Foreign custom entries and a sibling result separate the leaf from one assistant. A later, initially unselected assistant reuses a call ID but contains two patches. The test switches selection, verifies allowed/blocked calls, observes exact public parent visits and requires the complete native tree to stay unchanged.

| Prior request/answer pairs | Selected case | Before: full-path entries | After: entry lookups |
| --- | --- | ---: | ---: |
| 0 | Four-entry suffix | 4 | 4 |
| 200 | Four-entry suffix | 404 | 4 |
| 0 | Assistant at leaf | 5 | 1 |
| 200 | Assistant at leaf | 405 | 1 |

These columns count different work: the old path was allocated before its reverse search; the new lookups directly find the assistant without constructing that path. Both a blocked sibling and an allowed single patch take the four-entry route; selecting the two-patch assistant rejects it after one lookup. The new test failed against the old implementation with the recorded 4/5/404/405 path sizes, then passed on both [tested SDK stacks](compatibility.md). The native sibling-tool test independently observes three matching start/end pairs, zero branch reads during preflight/execution, and the correct accepted state/answer.

This removes an evidenced history-sized extension allocation, not every history-dependent cost. Missing call IDs still traverse the selected ancestry; current suffix length and assistant content remain uncapped. Pi also clones native messages before extension projection. No new matched wall-time benchmark or production-incident attribution is established by this slice; earlier long-run timing remains bound to its recorded runtime/workload identities.

## Context projection and trajectory selection

The 2026-09-13 correction changes runtime SHA-256 from `ab8f4673179eca1b110057b7e9d298c6d4675916e32bf70952f79ea365391b65` to `ce820cd33c34c4c882c11fc55e93f3914cfc8dffae57683e32cdcaa70f225cd2`. The adapter now passes the raw scope overlay to the runtime-context builder, which alone performs current-state model sanitization. A focused witness first observed two full-overlay clones in each ordinary/bootstrap case with 8 KiB and 1 MiB payloads, then one after the correction. Selected/cached state, native entries, input messages and semantic artifact metadata remain unchanged. The existing standalone builder test still rejects leaked runtime/legacy provenance. A public native `emitContext()` observation independently changed from two marked full-overlay clones to one after each session/CWD/global barrier, while every next inference still sees the correct accepted state.

Current-run selection now filters directly into the retained result instead of slicing and filtering separate prefix/suffix arrays. The fixture retains one persistent foreign custom message plus the current request, paired call/result, current foreign context and steering. Both earlier and current private validation feedback are excluded without changing native-message references, order or input data.

| Historical request-answer pairs | Before derived-array lengths | After derived-array lengths |
| --- | --- | --- |
| 0 | 2, 1, 1, 6, 5 | 6 |
| 200 | 402, 401, 1, 6, 5 | 6 |

These are source-array species observations: five derived arrays containing 15/815 reference slots become one six-entry result. They do not count every JavaScript allocation or copy message bodies; the old final spread and text-anchor helper allocations are outside that counter. Two hundred synthetic request-answer pairs are four hundred historical messages, not two hundred State Flow patches. Separate anchor cases preserve repeated-request selection, stale/missing-anchor fallback, absent users and empty specifications. A read-only comparison against the pre-change function also preserved output selection/order/reference identity and inputs for 93,620 combinations: sequences of up to four messages from eight user/image/tool/custom variants, four specifications and five anchor choices.

That context-only cohort passed five focused checks and complete 413-test validation on both [tested SDK stacks](compatibility.md), with unchanged runtime/test/package inputs. Its benchmark workload was unchanged. The [matched final-candidate controls](#matched-final-candidate-controls) above subsequently measure the complete resulting runtime, not an isolated causal effect of this context change or identification of the original incident. The foreign-custom scan still traverses the prefix; Pi's earlier native-message clone, scope overlay, state size, current trajectory and specification remain separate costs without an unconditional bound.

The release's remaining experiments, fixes, and acceptance gates are owned by [BACKLOG.md](../BACKLOG.md), not by this guide. The [temporal acceptance map](temporal-acceptance.md) owns semantic correctness witnesses.
