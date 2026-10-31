# Semantic memory baseline trial

## Status and evidence boundary

**Deferred post-implementation comparison — no live baseline executed.** Following the owner's 2026-10-24 implementation-first direction, this trial no longer gates M1–M5 implementation. Preserve the baseline source and fixed corpus for later comparison, disclose any model/provider drift, and never relabel calibration as model behavior. This run sheet specifies one small reproducible linked-task trial and its oracles. The opt-in [runner](../benchmarks/semantic-memory.mjs) now implements the isolated fixture/measurement mechanics and offline scripted calibration; it is not a live model result or evidence that the proposed semantic names improve quality. [BACKLOG.md](../BACKLOG.md#external-validation-and-evaluation) owns remaining execution and acceptance work.

The existing [performance workloads](performance.md) and [benchmark guide](../benchmarks/README.md) are synthetic transport/performance evidence. The current [semantic handoff evidence](semantic-handoff-contract.md#source-bound-validation-evidence) is an old-name in-memory preservation probe. Neither is a replacement for the model observations defined here.

### Historical M0 local preflight result

The preparation inspected only SDK/tool metadata and repository source, without live canonical-store access:

- Source commit: `4494fee9da8258cdf5f02c42672a0eb9866a512a`, package 0.26.5; runtime/test source unchanged during M0 preparation.
- Node: 26.8.1; repository-local coding-agent, agent-core, AI, and TUI packages: all 1.0.0.
- Current session metadata: provider `openai`, model ID `gpt-6.1-sol`. The offline CLI catalogue includes that identity.
- A credential-free `ModelRuntime` with `InMemoryCredentialStore` and no initial refresh resolved that model as `openai-responses`, context 420,000, maximum output 128,000. Those are catalogue limits, not a trial token budget or measured usage.
- No inherited `OPENAI_API_KEY` was present. This does not establish that the configured profile/provider lacks another usable authentication route.
- No profile credential file was opened/copied, no key/token was printed, no authentication refresh/login was performed, and no live inference request was made by this slice. Catalogue presence is not credential-bearing readiness or provider availability.

Reproducible non-inference metadata checks are `node -v`, repository-local SDK package version inspection, and:

```bash
PI_OFFLINE=1 pi --no-extensions --no-mcp --no-skills --no-context-files --list-models gpt-6.1-sol
```

**Execution gate:** Supply an authorized credential-capable model runtime, or explicitly authorize using the existing configured provider through its normal inference API without exporting credentials. Pin the selected model/provider, reasoning settings, and bounded request/token/time limits before trial execution. Do not scrape/copy profile credentials or invoke auth-print commands to bypass this gate. M0.4 remains open until the live trial and report exist.

## Initial comparison, not a research platform

**Recommended design:** Begin with one repeated-condition trial, four user runs per condition:

1. Native Pi without State Flow.
2. Current State Flow Passive.
3. Current State Flow Active.

This is 12 user inputs, not necessarily 12 model requests: normal tool turns and Active barriers add requests. A first single trial gives a directional baseline and exposes harness mistakes; a few repeated trials are appropriate before quality claims. Do not expand to additional models or tasks just to produce a larger report.

Use the same pinned physical model/provider and reasoning level for all three conditions. Do not silently switch providers when one fails. A provider alias is not an immutable model snapshot: report any actual snapshot identity the provider exposes, or record that it is unavailable. Do not fabricate immutable version provenance from the catalogue name.

The preserved M0 baseline source uses old semantic names with all three scopes. The current runner/calibration follows the Strategy/Tactics API released in 0.27.0; that does not retroactively produce an old-version live baseline. Later comparisons must bind each condition to its actual source/schema digest. Seven-selection and flat-interface mechanics are implemented, but their real-model comparison is unrun. The runner's initial all-three conditions are not a substitute for that separate comparison.

## Isolation and native host setup

Reuse the small public SDK shape in `tests/pi-harness.ts`, not its faux provider or its test-only Git initialization:

- Create one fresh temporary workspace, agent directory, session directory, and State Flow store per condition/trial. No production sessions, memory, workspace files, or Git remotes participate.
- Use explicit `DefaultResourceLoader` settings: no discovered extensions, Skills, context files, prompt templates, themes, or MCP. Load only the unmodified source State Flow factory in Passive/Active conditions and a common fixture/measurement extension in all conditions.
- Keep the native Pi prompt/tool loop and native session manager. Bind extensions and deliver the real shutdown lifecycle before disposing sessions. No manual replacement of `agent.state.messages`, automatic companion continuation, or external transcript summary.
- Disable optional Git backup by using a non-Git temporary store. Credential capability is supplied through the approved model runtime, not by copying credential files into fixture directories.
- Keep native retry/compaction settings equal across conditions, record them, and do not forcibly erase native Pi's history. The small trial should not need threshold compaction; record any actual compaction/retry rather than assuming it did not happen.
- The common fixture tools operate only on in-memory fixture values and return detached results. They do not expose arbitrary filesystem, shell, credential, account, publication, or network operations. This isolates semantic continuity rather than unrestricted software-development competence.
- Native tools and the three State Flow conditions need not have identical tool counts: the two memory tools are the treatment. All non-memory task tools and their semantics must match exactly.
- Each condition begins with the same empty fixture bundle and capability evidence. Never seed State Flow with the answer, carry one condition's memory into another, or let diagnostics reveal the earlier condition's solution.

The runner is a small opt-in temporary SDK harness, not a runtime feature or mandatory test-suite dependency. Its CLI permits only `--calibrate`; the exported `runSemanticTrial` requires a caller-supplied runtime/model, thinking level, positive request/output-token/time limits, and explicit `allowLive: true` for live use. It never discovers credentials. Offline calibration uses `InMemoryCredentialStore`, no model/profile files or refresh, only the faux provider, and an explicit disabled optional Telegram loader. Keep the report's source/input/schema/system digests with the result; prose alone does not prove the approved live route works.

## Concrete controlled fixture

The task is to prepare an offline-verifiable dependency bundle. The verifier and network policy are simulated by deterministic fixture tools, not by accessing a real network or publishing a release. Passing this trial proves the fixture contract, not physical network isolation or production supply-chain security.

All domain data is ordinary JSON. The starting manifest is:

```json
{
  "dependencies": ["alpha@1", "beta@2"],
  "credentialEnvironment": [],
  "networkPolicy": "deny",
  "bundledVerifier": "v1"
}
```

The controlled artifact is a bundle with the same dependencies, verifier v1, no credentials, and `trustIndex` set to `default` or `embedded`. No State Flow-specific fields are added to this artifact.

### Common task tools implemented in the small harness

These names describe fixture tools for the evaluation runner; they are not current State Flow tools or proposed product APIs.

- **`inspect_fixture`** accepts a concrete target: `manifest`, `verifier`, `embedded-index`, or `bundle`. It returns only that target's domain data. Manifest returns the JSON above. Bundle returns the actual current controlled artifact, or an explicit not-prepared result. Verifier returns nominal bundled-verifier applicability and its local-index option; it does not return user commitments, prior reasoning, rejection reasons, or a desired State Flow patch. Embedded-index returns the exact keys `alpha@1` and `beta@2` as available local entries.
- **`prepare_bundle`** accepts only the chosen `trustIndex` enum and constructs/replaces the controlled bundle from the fixed manifest. It cannot change dependencies, network policy, credentials, source requirements, or unrelated state. It returns the actual accepted artifact. This is a fixture action, not a State Flow publication.
- **`validate_bundle`** accepts a named check, `isolation` or `coverage`, and reads the actual bundle. No bundle is an explicit failure. Under `default`, isolation fails with evidence that verifier v1 requests its trust index remotely. Under `embedded`, isolation passes without a remote request. Coverage passes only when every fixed dependency has a local entry for an embedded bundle. Results name what was checked, passed/failed, and the reason; they never return an invented success based on assistant text.

The nominal claim that a bundled verifier should be self-contained is an assumption, not an independently proved fact. The isolation failure supplies the contradiction. The embedded-index capability is available through targeted inspection; do not hide a capability until a prescribed model action occurs or inject a different answer based on condition. All three conditions see identical tool responses for identical fixture state.

The runner records every task call and fixture snapshot after each user run. Verification is independent of assistant claims: an asserted successful check counts only when the corresponding tool result actually passed for the current artifact. A later bundle replacement invalidates earlier validation receipts for the old artifact.

## Fixed user input corpus

Keep these inputs identical across conditions, without mode-specific hints or restating lost information at later runs. Interleave conditions or randomize their order when repeating trials; record the order.

### Run 1 — Establish and retain the accepted approach

> We are preparing a dependency bundle that must verify offline without credentials. The accepted approach is to prepare the bundle with bundled verifier v1 in its default configuration, then validate it in network isolation. We expect the bundled verifier to be self-contained, but that is an assumption to check. Online-only verification was rejected because it cannot meet the offline requirement. Keep the prepare-before-validate dependency. State the chosen plan and what would require reconsideration. Do not prepare or validate the bundle yet.

**Oracle:** The answer preserves the outcome, binding offline/no-credentials requirement, accepted two-phase approach, explicit assumption, rejection reason, and reconsideration condition. No fixture action has occurred. Passive/Active memory use is observed, not prescribed through field names or expected patches.

### Run 2 — Continue the next phase without a recap

> Continue only the preparation phase of the accepted approach. Report actual progress and the next necessary check. Do not run verification yet.

**Oracle:** A bundle is prepared using the accepted default-v1 approach, with fixed dependencies/policy and no credentials. The next phase remains validation. A model that chooses the local-index option proactively must explain why it is revising the accepted default approach; record that deviation rather than forcing an artificial failure or silently changing the fixture. This can be a justified alternative trajectory, not automatically a task failure.

### Run 3 — Inspect contradictory evidence, without premature success

> Proceed with verification. If there is an obstacle, inspect the relevant capability, retain the evidence, and identify a reasoned next step. Do not replace the bundle in this run.

**Oracle for the default trajectory:** Isolation validation fails with the remote-index evidence; the model does not reinterpret that as success or weaken the offline requirement. Targeted verifier/index inspection supports a revised local-index approach. The existing artifact remains unchanged, failed validation remains consequential evidence, and actual revalidation is still pending.

**Alternative trajectory:** If Run 2 legitimately prepared an embedded bundle, score actual isolation/coverage outcomes and retained rationale; do not falsely record an observed contradiction. Such a trial is useful but does not establish strategy-revision behavior. Report that subcase as not exercised and, if needed, run a separately labeled follow-up with a fixed default artifact. Never retrofit a hidden condition-specific fault into the baseline.

### Run 4 — Finish and preserve consequences

> Continue using the accepted approach and accumulated findings. Complete the remaining work if possible, verify the result, and close the completed commitment. Give the durable conclusion and the consequential reason the obsolete alternative was not used.

**Oracle:** The final artifact meets fixed requirements and has current passed isolation/coverage receipts. The answer/state preserves the durable conclusion, requirement, and appropriate negative rationale. Completed intents should close when present. Temporary memory cascades only if the model actually used eligible structured ownership references; do not award a cascade that never existed, or penalize legal unowned tactics merely for being unowned.

No later prompt supplies the embedded-index solution, repeats the offline requirement, restores a lost plan, or prescribes a memory patch. That is essential to measuring continuation rather than compliance with a repeated reminder.

## Measurement and rubric

The harness observes public hooks/results, not private reasoning. Retain final ordinary answers, fixture results, tool names/arguments, accepted semantic snapshots, public usage statistics, and compact request-shape metadata. Native sessions already own the full trace; do not construct a competing transcript or commit raw reasoning/provider payloads.

For every user run record:

- Condition/trial/run index, source and harness/input digest, model/provider/available snapshot, reasoning and sampling settings, limits, tool/schema/protocol identities, mode, all-three selection, and retention.
- Actual fixture artifact identity plus isolation/coverage receipts bound to that artifact; final answer stop reason and any execution failure.
- Model requests, task/read/memory tool counts, rejected/no-op patches, retry/Abort/compaction events, duration, and public token/cost/cache accounting when available. The runner counts SDK stream admissions, not opaque provider HTTP retries; it records SDK estimated cost separately from unavailable provider-billed cost. Unknown fields are `null`/unavailable report metadata, not measured zeroes or stored semantic state.
- Native/provider-visible automatic context boundaries: current-run trajectory retained, completed-run trajectory absent only where actual Active projection excludes it, and matching head/update projection identities.
- Semantic bytes by plane and owner, projected bytes separately, and meaningful repeated source inspections or strategic replacement without changed evidence.

Score each applicable semantic obligation as **met / violated / not exercised / not observable**, with a specific tool result, state/answer location, or trace event as evidence. The runner computes fixture success and records semantic evidence but deliberately leaves `rubricStatus: "unreviewed"`; it does not pretend that string matching can judge plan quality. Do not combine a missing observation with an explicit violation.

- **Verified task success:** Artifact and current validation receipts satisfy independent fixture rules.
- **Commitment retention:** Offline/no-credentials requirement and prepare-before-validate dependency still guide work after Run 1.
- **Plan continuation:** Run 2 advances the accepted next phase rather than rediscovering/replacing it without grounds.
- **Rejection recall:** Online-only/default remote behavior is not silently reused after its relevant rejection/failure evidence.
- **Strategic revision:** A contradiction actually observed at Run 3 is retained and changes the approach while preserving requirements. If no contradiction occurs, mark not exercised.
- **Closure and survivors:** An actually completed commitment closes; durable conclusions survive. Record actual ownership usage separately from its correctness.
- **Rediscovery/churn:** Repeated reads, repeated tests, no-op patches, needless full-plan replacement, and semantic growth are observations. A necessary revalidation after artifact change is not needless repetition.

Flattened one-scope operation and disabled-owner writes cannot be scored against the preserved4494fee/0.26.5 baseline as if implemented there; their installed target mechanics are covered by the later M2/M3 checkpoints, not by this historical baseline. Reserve those cases for M3's comparison, with actual schemas and excluded-owner byte hashes. The historical roadmap also proposed a protocol-composition comparison. M4 ultimately retained existing renderers without changing protocol output, so that decision creates no new experimental treatment or requirement to invent one. Any later cognitive-benefit claim needs separately authorized comparable conditions.

## Compact report shape and interpretation

A report can be one small JSON file plus a concise Markdown interpretation. Include run status, evidence locations/digests, the four-way rubric, costs, deviations, and missing measurements. Keep secrets and raw reasoning out of retained reports. Preserve failed/incomplete trials rather than omit them from comparisons.

A first report must state the trial count and limits explicitly. One trial does not establish significance or universal model behavior. Native Pi retains its natural history; do not erase it to make Active look better. Short-task results may show little difference, and a neutral/negative result remains useful evidence. Serialized longest-prefix bytes are only the existing proxy; provider cache benefit requires real provider accounting.

Do not count a faux/scripted provider, the five-example mapped replay, a dry run, catalogue metadata, or this run sheet as a live result. If a runner crashes or authentication is unavailable, retain an incomplete execution status with its exact cause, not a success score. A model's final “done” cannot override failed task checks.

## Offline calibration and remaining execution boundary

Run the [calibration commands](../benchmarks/README.md#semantic-memory-trial-calibration) from a source checkout. Optional report output uses exclusive file creation; stdout always carries the JSON result and no existing file is overwritten. Source identity covers the runner, this corpus document, package/lockfile, `index.ts`, and all runtime `lib/*.ts` files; before/after equality is checked. No temporary native sessions, reasoning trace, or canonical store is kept after cleanup.

Calibration on the M0 source/SDK stack exercised four native user runs per condition with actual State Flow source and scripted provider messages:

- Native: 11 stream admissions; Passive: 15; Active: 15. All 41 provider calls were faux, and output limits reached the faux provider options.
- All controlled fixture tools actually completed. The default-index isolation check failed as expected, embedded isolation/coverage checks passed for the final artifact, and final fixture success was independently true in all conditions.
- Active's Run 4 admission contained zero prior native user prompts; Native/Passive retained three. Passive had no captured semantic response on every run; Active did. Intent-owned working memory closed without losing requirements, rejection reasons, or the durable conclusion.
- A one-request limit produced `incomplete` reports and nonzero CLI exit while preserving the partial evidence and cleaning temporary stores.
- A deliberately stalled faux response under a 25-ms timeout produced timeout/incomplete results and cleanup in all three conditions. This is a native cancellation calibration, not a claim about remote-provider timeout behavior.
- A scripted model claiming only “Done” completed all four user inputs but produced fixture success `false` in all conditions. This proves that assistant claims do not replace validation receipts.
- An attempted API call without calibration or explicit live authorization rejected before session creation. No implicit real-provider request, credential discovery, or profile write was introduced.

These observations validate harness mechanics only. They are not behavioral rubric scores, live token charges, physical network-isolation proof, or provider cache measurements. The raw public usage fields in faux reports must not be interpreted as live-provider cost evidence.

After functional implementation and deterministic validation, M0.4b requires the authorized credential-capable route and bounded execution settings stated above. Execute comparable baseline/target real-model conditions where reproducible, review the semantic rubric, and retain the compact source-bound report. The canonical backlog retains this deferred remainder separately from 0.27.2 release-local cleanup; missing model observations do not reopen completed runtime implementation. Do not treat calibration or missing baseline observations as completed model evidence or an agent-quality improvement.
