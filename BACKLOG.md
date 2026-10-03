# Backlog

The **0.25.0: Intent-Owned Memory** scope is implemented and locally validated; outcomes are recorded in [CHANGELOG.md](CHANGELOG.md), with package, lockfile and changelog aligned at 0.25.0. This backlog keeps publication, installed-client evidence and later decisions open. Current contracts live in [architecture](docs/architecture.md), [usage](docs/usage.md) and [intent ownership](docs/lazy-state.md#intent-ownership).

## Carried gates

- **0.25.0 publication (approval-gated):** Commit the prepared tree and push the exact `v0.25.0` tag; then verify the tag's successful release workflow, published GitHub Release and matching npm package before reporting release completion.
- **Installed 0.25.0 smoke (operator-owned):** After separately authorized installation/reload, use a disposable store. In `session` and in `cwd`: open an intent with owned `working` and `lazy` entries plus one textual mention, close it, and confirm the owned entries are gone, the mentioned one remains, the receipt lists the deletions and `/state-flow-status` shares update. Then supersede an intent in one patch and confirm its targets survive.
- **Installed 0.22.0 smoke (operator-owned):** Perform the carried check if it is not yet recorded, only against the exact released 0.22.0 installation; a reload of a later candidate cannot certify the old release. After an operator-authorized reload, confirm:
  - terminal autocomplete exposes Active/Passive/Off and status;
  - Telegram shows the single `off | passive | active` row plus the four inspection buttons;
  - current-session mode agrees across tools, context and status, and survives reload.
  Do not edit real global defaults or unrelated sessions.
- **Installed 0.23.0 smoke (operator-owned):** After separately authorized installation/reload, confirm an unconfigured *new* session is Off without semantic writes, retained choices and explicit global modes survive, and Telegram shows one `Off | Passive | Active` radio row with the selected 🟡/🟣/🟢 marker and ⚫️ inactive markers, followed by four direct scope inspections. Isolate test storage; do not use the live store as a fixture. SDK tests alone do not certify installed-client rendering.
- **Installed 0.24.0 smoke (approval/operator-owned):** Local lifecycle, cancellation, background-work and callback/inspection acceptance is complete; real-client behavior remains separate evidence. After separately authorized installation/reload of the exact 0.24.0 release, use a disposable store to check Off attachment and pending-work cancellation, no late memory warnings, current read-only inspections without private placeholders, preserved deferred Passive/Active/fork acquisition, and unchanged terminal/Telegram mode controls. Do not use the live store, treat its reload as evidence for older published releases, or change unrelated operator sessions.

## Deferred beyond 0.25.0 (decision inputs, not commitments)

- **Convention uptake:** After some real use, read the `/state-flow-status` ownership shares; if most `working`/`lazy` entries stay unowned, revisit the protocol wording, not the mechanism.
- **Behavioural evaluation:** Live-model comparison of Active against native compaction on one long cyclic task. Needs a policy decision first; current benchmarks are synthetic and make no model calls.
- **Lifecycle real-use measurement (gated):** The operator install runs with `logging: true` and has no recorded `publication-conflict`, `finalization` or `barrier-block` entries; cooperating-writer waits, Stop fences and fork/restore contention are not instrumented. Removing any awaited layer for rarity first needs a decision to add opt-in counters.
- **Lifecycle state as one tagged union:** The 0.25.0 lifecycle review left 17 closure bindings in `lib/extension.ts`, each a justified selection, run or host fact. Remaining candidates: the seven branch-selection facts (`snapshot`, `runtime`, `branchStartsWithoutRuntime`, `selectedHistoryExpired`, `modePersistenceError`, `forkInitialization`, `deferredBranch`) as one Off-deferred/attached union, and `passiveContinuation`/`bootstrapContinuation` as one continuation slot once their exclusivity is proven. Decide only with a behavioural reason; no further mechanical moves are pending.
- **Skill compilation fidelity:** Hashes detect source change, not a lossy first compilation. Measure before adding anything.
- **Compaction threshold:** `STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS = 24_000` is documented as a margin above Pi's default 20,000-token retained suffix. Make it configurable only if a real workload or non-default Pi retention settings demonstrate a mismatch.

## Release boundary

Release publication is owned by `.github/workflows/release.yml`. Align package, lockfile, tag and changelog at the release version, rebuild `dist/` from final sources, run `npm run validate` and the context validator after context edits, and verify the exact tag's successful workflow, published GitHub Release and matching npm package before reporting release completion. Installed-instance reload remains a separate operator action.
