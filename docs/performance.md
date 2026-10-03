# Session performance evidence

## Scope

State Flow must complement Pi's session rather than create a competing transcript or lifecycle. Measure these costs separately:

- native transcript opening and context construction;
- canonical semantic-state size and retained-tail depth;
- exact registered-artifact count;
- optional settled-turn backup.

Correctness is not a performance trade-off. Current canonical state, bounded retained history, causal-basis checks, the complete Pi trace and direct completion must all remain correct.

Benchmark inputs are synthetic temporary fixtures using the installed Pi SDK, deterministic faux providers and isolated credentials. They make no external model or network calls and must never use a live state store.

This guide describes the current workloads and how to interpret them. It does not claim timings for the current source tree: obtain those by running the benchmark and recording its source and dependency identities.

## Running the workload

```bash
npm run benchmark
```

Executables live in `benchmarks/`; contract tests live in `tests/benchmark.test.ts` and `tests/benchmark-session.test.ts`. See the [benchmark guide](../benchmarks/README.md) for environment variables and report paths.

A fast correctness smoke is:

```bash
BENCH_PATCHES=2 BENCH_SAMPLES=1 BENCH_ROUNDS=2 BENCH_STATE_BYTES=1024 npm run benchmark
```

Treat timings as observations from the named host and source identity, not universal thresholds. Compare runs only when workload fingerprints, dependencies, payloads and validation outcomes match. A failed correctness probe invalidates its timing sample.

To include an isolated post-resume probe:

```bash
BENCH_PATCHES=2 BENCH_SAMPLES=1 BENCH_ROUNDS=2 BENCH_STATE_BYTES=1024 BENCH_POST_RESUME=1 npm run benchmark
```

### Within-run prompt-prefix probe

The report records `promptPrefixRuns` for each State Flow and native Pi user run, without duplicating runs across lifecycle checkpoints. Isolated post-resume probes expose the same per-run metrics.

**Per inference:**

- `contextBytes`: UTF-8 byte length of `JSON.stringify(context.messages)` as seen by the installed faux provider.
- `sharedPrefixBytes`: longest common byte prefix of that serialization and the previous inference **in the same run**; `null` on the first inference.

**Per run:**

- `patchStateBarriers`: successful tool completions.
- `nativeUserBytes` / `specificationBytes`: JSON-serialized string values, excluding their containing message/field frames. `specificationBytes` is `null` for native Pi.

Byte-prefix measurements omit provider framing, tool schemas, tokenization, cache policies and quality. Serialized synthetic-message timestamps can shorten this proxy prefix without proving provider-visible cache churn. Validate fresh state visibility after barriers independently of prefix preservation.

### Trajectory workload

The opt-in `BENCH_PREFIX=1` probe in the [benchmark guide](../benchmarks/README.md) exercises active memory, ordinary passive memory and Stop handoff separately.

Each measured run issues six 20,497-byte native reads, a patch, two more reads and a second patch. Exact read content must stay visible through all eleven inferences. Both patches and terminal completion are checked outside the provider. The report's `trajectory[].promptPrefixRuns` entries retain every inference, not just aggregate ratios.

A warm prefix alone does not prove updated memory reaches the model; freshness has separate native-SDK regressions.

### Frozen-head measurement

Projection freezes whole heads, including timestamps, and delivers accepted values and changing notices at stable tail positions.

- Active completion/new runs, native compaction/selection and mode changes are cache boundaries.
- Passive user turns and patches are not cache boundaries.
- Volatile projection IDs distinguish current updates from retained results after a rebase.

See [projection semantics](architecture.md#pi-lifecycle) for ownership and limits.

Regression tests assert prefix equality independently of exact host timestamps and IDs. Separate native tests prove accepted-state freshness, repeated barriers, passive cross-turn stability and bootstrap rebasing. Measure prefix retention with the trajectory workload; it is not provider cache accounting, a latency estimate, a token-cost estimate or a quality guarantee.

## Current cost model

- **Semantic projection:** proportional to projected state size.
- **Temporal reads:** bounded by configured `historyLimit` (`0..100`, default `7`).
- **Canonical publication:** writes the affected scope/runtime cohort under file CAS and cooperating-writer exclusion; executes no Git command.
- **Run preparation:** awaits one current-head transaction at the first active `context`. Later requests in the same run reuse completed preparation.
  - Registered-artifact maintenance is proportional to already-registered paths and uses metadata-only `size + mtimeNs` inspection inside that acceptance.
  - No-change preparation on a complete cohort writes only runtime metadata, without folding wider scope tails.
  - No directory discovery or generic body hashing occurs.
- **Optional Git backup:** runs only after accepted work reaches `agent_before_settle`.
  - Canonical-lock capture costs are proportional to owned file count and bytes. All Git commands and filters run after that lock is released.
  - Lock waiting is asynchronous/cancelable when a host operation signal exists. Otherwise optional backup defers on contention; see [settlement cancellation](compatibility.md#settlement-cancellation).
  - Git subprocesses remain synchronous after capture. Independent canonical processes can publish during slow Git, but this is not a host-event-loop latency bound.
  - Remote push runs asynchronously, skips overlapping attempts per repository within one Pi process, and is awaited at session shutdown within its timeout and process-group termination behavior.
  - Backup is neither acceptance nor recovery authority.
- **Native transcript and context:** opening, Pi context construction and foreign custom-context preservation remain Pi/history costs, not canonical-state storage costs.

Discarded semantic history is unavailable. Git cold reads, revision restoration, queue workers, in-place format conversion, terminal repair and fallback inference are absent. Remote pushes exist but are asynchronous and outside these local benchmark workloads; do not count them as measured costs.

## Tool-preflight parent traversal

Tool preflight follows Pi's public parent links from the selected leaf to find the assistant response owning the current tool call.

- It does not construct the whole branch.
- Traversal remains proportional to the selected ancestry when no nearby match exists.
- `tests/extension.test.ts` covers zero and two hundred prior request/answer pairs, foreign custom entries, duplicate call IDs, sibling tools and unmatched calls, while preserving exact selected-branch behavior.

This limits allocation; it is not an unconditional constant-time claim.

## Context projection and trajectory selection

The context domain projects the cached semantic overlay once per context emission to compare current state with its last communicated view.

- It serializes the complete head only at a projection boundary. Later synthetic notices retain their original native-message positions.
- Projection caching targets request-prefix stability, not constant-time state processing. View copies/diffs remain state-dependent, and notices accumulate until a natural reset, without a size threshold.
- `currentRunTrajectory` allocates one retained-message array, not arrays for discarded ordinary prefixes.
- Foreign custom context may require scanning earlier entries, and Pi may clone native messages before the extension runs.

`tests/context.test.ts` exercises small and large semantic payloads, zero and two hundred prior request/answer pairs, repeated requests, stale/missing anchors, foreign custom messages and post-barrier context emission. These tests assert projection counts and retained identities; they impose no wall-time threshold.

## Memory-only owned-draft COW

Private copy-on-write limits repeated deep-copy work without changing public detachment or persistence guarantees.

**Public boundaries:**

- Exported `applyPatch` returns a mutable, fully detached result, including untouched branches and incoming patch values. `overlayStates` and temporal reads rely on detached outputs. Never share caller-owned mutable objects across that boundary.
- Staged responses are intentionally mutable before commit (`tests/transition.test.ts`). Artifact/Skill compilation replaces entries in the staged artifact registry.
- Failed publication must leave accepted scopes untouched. Commit detaches the accepted result again; the adapter then installs detached runtime reads.

**Private draft:**

- `applyPatch` retains one detached entry basis. Private helpers copy object/array paths only when they change and clone incoming replacements.
- Mutable caller-owned/accepted scopes are never shared with returned drafts.
- Inherited objects are detached before their merge behavior is applied, preventing prototype borrowing while preserving prototype-named deletion and signed-zero behavior.
- Public/staged isolation, late response reconciliation, atomic rejection and CAS remain intact. There is no public freeze/proxy layer.

**Measurement boundaries.** Temporal replay/public readers, provenance, serialization, hashing, storage layout and Git have their own costs. Change them only when fresh measurements and safe ownership evidence justify it.

Deep-clone counts, serialized clone-input volume and container visits are **deep-cloning work proxies, not allocated heap bytes or total allocation**. They omit new shallow path copies. Timed samples must exclude instrumentation and correctness checks. Neither these counters nor structural sharing establishes a serialization/hash/disk-I/O speedup. Public detachment still requires an entry copy, commit still detaches accepted values, and full runtime cost is broader than a pure staging probe.

## Validation and reporting

A performance report is valid only when it records:

- source/workload fingerprint and dependency stack;
- payload sizes, history lengths, rounds and samples, with the actual `historyLimit`;
- phase-local wall time and relevant resource counters;
- correctness results for final state, transition count, native read evidence and baseline immutability;
- failure status and released resources for every unsuccessful phase.

Run `npm run validate` before treating benchmark output as release evidence. The [compatibility matrix](compatibility.md) identifies the tested SDK baseline, and the [temporal acceptance map](temporal-acceptance.md) owns behavioral evidence.
