# Session performance evidence

## Scope

State Flow must complement Pi's session rather than create a competing transcript or lifecycle. Measure native-history cost separately from canonical semantic-state size, retained-tail depth, exact registered-artifact count, and optional settled-turn backup. Correctness—current canonical state, bounded retained history, causal-basis checks, complete Pi trace, and direct completion—is not a performance trade-off.

All benchmark inputs are synthetic temporary fixtures using the installed Pi SDK, deterministic faux providers, and isolated credentials. They make no external model or network calls and must never use a live state store.

## Running the workload

```bash
npm run benchmark
```

Current executables live in `benchmarks/`; contract tests live in `tests/benchmark.test.ts` and `tests/benchmark-session.test.ts`. See the [benchmark guide](../benchmarks/README.md) for environment variables and report paths.

A fast correctness smoke is:

```bash
BENCH_PATCHES=2 BENCH_SAMPLES=1 BENCH_ROUNDS=2 BENCH_STATE_BYTES=1024 npm run benchmark
```

Treat timings as observations from the named host and source identity, not universal thresholds. Compare runs only when workload fingerprints, dependencies, payloads, and validation outcomes match. A failed correctness probe invalidates its timing sample.

### Within-run prompt-prefix probe (0.18.1)

The v3 report records `promptPrefixRuns` for each State Flow and native Pi user run, with no duplication across lifecycle checkpoints. Per inference, `contextBytes` is the UTF-8 byte length of `JSON.stringify(context.messages)` as seen by the installed faux provider; `sharedPrefixBytes` is the longest common byte prefix of that serialization with the previous inference **in the same run**, or `null` on the first inference. Per run, `patchStateBarriers` counts successful tool completions, and `nativeUserBytes` / `specificationBytes` count JSON-serialized *string values*, excluding their containing message/field frames (`specificationBytes` is `null` for native Pi). Isolated post-resume probes expose the same per-run metrics.

A bounded local sample used `BENCH_PATCHES=2 BENCH_SAMPLES=1 BENCH_ROUNDS=2 BENCH_STATE_BYTES=1024 BENCH_POST_RESUME=1 npm run benchmark` on Node 26.8.1 Linux/x64 and Pi/AI 0.87.0. The runtime-source SHA-256 was `0f4eea2394c52c6ac545260cae967a16581b8768a24a8c611c13a389e6df01a9`, workload-source SHA-256 `e9b8158d953d8622776aa075835c4aa95c98855ed5c90e85de05dccae1087e91`, base commit `5f0f688650738d4d0e9850b2529b0273c47121a8` (the measured tree had uncommitted 0.18.1 changes). Both source hashes stayed unchanged during the run and all correctness phases passed. At user run 1, native Pi's second inference shared 2,776 of 2,777 prior serialized bytes; State Flow shared 9,365 of 9,467 at inference 2 and 9,173 with inference 2 at inference 3 (one accepted barrier). In both State Flow runs, the 21-byte serialized `specification` value duplicated the 21-byte current native user string value; native Pi had no projection field. These are synthetic short-run observations, not representative cache-hit rates or timing predictions.

A later 0.19 decision about freezing the projected head must compare compatible workloads and include correctness of fresh state visibility after barriers. Byte-prefix measurements omit provider framing, tool schemas, tokenization, cache policies and quality; this probe does **not** justify changing context projection in 0.18.1.

## Current cost model

- Current semantic projection is proportional to projected state size.
- Retained temporal reads are bounded by configured `historyLimit` (`0..100`, default `7`).
- Canonical publication writes the affected scope/runtime cohort under file CAS and cooperating-writer exclusion; it executes no Git command.
- Registered-artifact maintenance is proportional to already-registered paths and uses metadata-only `size + mtimeNs` inspection. It performs no directory discovery or generic body hashing.
- Optional Git backup runs only after accepted work reaches `agent_before_settle`. Its canonical-lock capture costs are proportional to owned file count and bytes; all Git commands and filters run after that lock is released. The commit remains synchronous within the calling settled-turn callback: independent canonical processes can publish during slow Git, but this is not a host-event-loop latency bound. Remote push runs asynchronously, skips overlapping attempts per repository within one Pi process, and is awaited at session shutdown within its existing timeout and process-group termination behavior. Backup is not an acceptance or recovery authority.
- Native transcript opening, Pi context construction, and foreign custom-context preservation remain Pi/history costs rather than canonical-state storage costs.

Discarded semantic history is unavailable. Git cold reads, revision restoration, queue workers, migration, terminal repair and fallback inference are absent from the current architecture. Remote pushes do exist but are asynchronous and outside these local benchmark workloads; do not count them as measured costs.

## Tool-preflight parent traversal

Tool preflight follows Pi's public parent links from the selected leaf to find the assistant response owning the current tool call. It does not construct the whole branch, but traversal remains proportional to the selected ancestry when no nearby match exists. `tests/extension.test.ts` covers zero and two hundred prior request/answer pairs, foreign custom entries, duplicate call IDs, sibling tools, and unmatched calls while preserving exact selected-branch behavior.

This is a bounded-allocation improvement, not an unconditional constant-time claim.

## Context projection and trajectory selection

`runtimeContextMessage` projects the cached semantic overlay once per context emission. `currentRunTrajectory` allocates one retained-message array rather than arrays for discarded ordinary prefixes. Foreign custom context may require scanning earlier entries, and Pi may clone native messages before the extension runs.

`tests/context.test.ts` exercises small and large semantic payloads, zero and two hundred prior request/answer pairs, repeated requests, stale/missing anchors, foreign custom messages, and post-barrier context emission. These tests assert projection counts and retained identities; they impose no wall-time threshold.

## Memory-only owned-draft COW

The pre-implementation baseline is bound to runtime `72e6dcb846b46015a8967bbd44925d7868fc6e273e1113e839936d0d1cc2581f`; the implemented candidate is `de26b5e229a9128f68d018f3cba1d4ab1fb769f901418aef014e70e3e4758191`. This optimization reduces repeated deep-copy work, not the public detachment or persistence contract.

- `applyPatch` is exported and currently returns a mutable, fully detached result, including untouched branches and incoming patch values. `overlayStates` and temporal reads rely on detached outputs. Preserve that boundary rather than sharing caller-owned mutable objects.
- Previously, staging cloned the full cohort and each scope before `applyPatch`, which recursively deep-cloned touched containers again. The cohort clone was overwritten scope by scope, while empty completion patches re-cloned large untouched planes. Those staging pre-clones and recursive deep clones are now removed.
- Staged responses are intentionally mutable before commit (`tests/transition.test.ts`); artifact/Skill compilation replaces entries in the staged artifact registry. Failed publication must leave accepted scopes untouched. Commit detaches the accepted result again, and the adapter installs detached runtime reads afterward.
- `applyPatch` retains one detached entry basis, then private helpers copy object/array paths only when they change and clone incoming replacements. Mutable caller-owned/accepted scopes are never shared with returned drafts. Inherited objects are detached before their existing merge behavior is applied, preventing prototype borrowing while preserving prototype-named deletion and signed-zero behavior. Public/staged isolation, late response reconciliation, atomic rejection and CAS remain intact; no public freeze/proxy layer is introduced.
- Temporal replay/public readers, provenance, serialization, hashing, storage layout and Git remain outside the first optimization. Revisit only if fresh measurement and safe ownership evidence earn a further change.

Local synthetic artifacts: `/tmp/pi-state-flow-cow-baseline.ts` and `/tmp/pi-state-flow-cow-baseline.json`; probe SHA-256 `093c6924eb77dbc48c0633446410e771590c85e80fd6560b64baa426bb6acb39`. Node 26.8.1, Linux/x64. The probe uses frozen three-scope states with 64 KiB and 512 KiB cold payload targets per scope, five patch shapes, stage/commit phases, two warmups and seven uninstrumented timing samples. The publisher is a no-op: no canonical files, live store or Git are touched. Every output container is checked for detachment, and repeated semantic hashes must agree.

For 512 KiB per scope, the session-leaf case records 31 `structuredClone` calls and 6.06 MiB of serialized clone inputs during staging; stage plus in-memory commit records 36 calls and 7.58 MiB. Observed medians were 6.89 ms and 9.59 ms respectively. Indexed-array, all-scope and response-only cases show the same approximate clone-input volume. Full per-case counts, container visits, timings and semantic hashes are in the report.

The identical probe after implementation (`/tmp/pi-state-flow-cow-after.json`) matches all 18 semantic output hashes and reduces deep-clone input volume/container visits in every row. For the same large session-leaf workload, staging drops to 10 clone calls / 1.52 MiB; stage+commit drops to 15 / 3.03 MiB (approximately 75% and 60% less serialized deep-clone input). Medians were 4.28 ms and 8.23 ms; the isolated public-leaf median instead moved from 0.26 to 0.34 ms, so no universal wall-time improvement is claimed. A separate deterministic comparison (`/tmp/pi-state-flow-cow-equivalence.ts`, report `.json`) matches pre-COW values/errors on 2,005 cases, including 784 rejections, with frozen basis/patch preservation.

These volumes/counts are **deep-cloning work proxies, not allocated heap bytes or total allocation**; new shallow path copies are not counted. Timed samples exclude instrumentation and correctness checks. Neither these observations nor structural sharing establishes a serialization/hash/disk-I/O speedup. Public detachment still requires an entry copy, commit still detaches accepted values, and the full runtime cost model remains broader than this pure staging probe.

## Validation and reporting

A performance report is valid only when it records:

- source/workload fingerprint and dependency stack;
- payload sizes, history lengths, rounds, and samples (these workloads use the default `historyLimit` bound to the recorded runtime source);
- phase-local wall time and relevant resource counters;
- correctness results for final state, transition count, native read evidence, and baseline immutability;
- failure status and released resources for every unsuccessful phase.

Run `npm run validate` before treating benchmark output as release evidence. The [compatibility matrix](compatibility.md) identifies the tested SDK baseline, and the [temporal acceptance map](temporal-acceptance.md) owns behavioral evidence.
