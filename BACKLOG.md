# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md).

## 0.10.0: Session performance and reliability

- **Outcome:** Make State Flow complement Pi's native session lifecycle reliably and efficiently after long histories and while independent instances publish to the same store. The operator reports slowdown after resuming a large session with roughly 200 patches; concurrency is a hypothesis, not an established cause.
- **Evolution:** Treat 0.10.0 as a maturation milestone: deepen reliability, usability, performance, consistency, and explanation of the existing concept. Admit adjacent maintenance only from concrete evidence; do not add features or change the product's core model.
- **Execution:** Prefer inline implementation and review. If subagent delegation becomes necessary, use only the operator-requested "GPT-5.6 Luna" after verifying its exact available identity; no silent substitution. The coordinator owns review and integration. Existing deterministic benchmark processes may finish without launching more model actors.
- **Convergence:** Reproduce and measure first, implement only evidenced corrections, validate each owned slice, then separately review the integrated candidate. Stop when the regressions below pass, before/after workload evidence explains the performance changes, and remaining host or environment limits are explicit. Preserve semantic history, source/runtime ownership, native trace, branch selection, and exact publication/CAS guarantees.
- **Non-goals:** No new semantic mode, state-size cap, database, hidden session replacement, bulk migration, production-store repair, read-only global bootstrap, or Telegram analyzer. Preserve ordinary abort: accepted patches remain available for same-session continuation, with no new immediate remote-enqueue requirement. Test on synthetic sessions and temporary stores; do not inspect or mutate production conversation bodies or state repositories for this work. Publication remains outside preparation scope.

### Release gate

The [nine-invocation measurement series and interpretation](docs/performance.md#measurement-closure) are complete; no measurement is active. `/tmp/state-flow-final-controls-CzaHqM/final-series-receipts.json` binds the actual exits and complete captures. Preserve this evidence and refresh only claims invalidated by an admitted correction; source/workload changes must not silently inherit old timings. Original production slowdown attribution remains unproven, and production-store inspection is not authorized.

The 0.10.0 candidate now includes native completed-history compaction and effective-only status JSON. Full 0.84.4 validation passes 426/426; affected policy/status/native lifecycle tests and typecheck pass on 0.85.1. The operator intentionally aligned package/lock versions to 0.10.0 and explicitly authorized commit, push and release. Release automation/remote CI and published artifacts remain the external acceptance gates.

## Candidate evolution

- [ ] **Read-only global bootstrap layer:** Project the existing global materialization into enabled and non-enabled sessions by default, so even one-shot work starts carrying established cross-project facts, preferences, routing, and conventions. The global scope is the highest-value, lowest-cost half of the memory, while writing carries the protocol and curation tax; making the read side unconditional gives continuity without enabling mutation.
  - Boundary: project the existing durable global materialization only. No writes, transitions, patches, barriers, session/CWD initialization, or temporal-history changes. Model tools and the full protocol remain opt-in behind explicit start, and the bootstrap adds no second semantic mode.
  - Open questions: whether deferred Markdown freshness discovery must run ahead of the first inference, token cost of a stable global prefix, behavior under untrusted project contexts, and naming distinct from the existing bootstrap-run concept.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.
- [ ] **Telegram submenu state analyzer:** Extend the State Flow Telegram section with a read-only analyzer view over the same diagnostics `/state-flow-status` already reports (branch mode, temporal head and hot depth, scope keys, retained tails, artifact freshness, publication). The operator deliberately deferred this beyond the 0.9.0 control surface.
  - Boundary: presentation only. Reuse existing status diagnostics; no new semantic mode, and never mutate state from the analyzer view.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.

## Deferred host integration

- [ ] **Native default session continuation:** Integrate the existing read-only recommendation, exact-selection, and rehydration contracts before Pi creates `SessionManager`, while preserving explicit new/resume and native-picker precedence, truthful notices, and cross-process session ownership. Pi 0.84.4 exposes no suitable pre-session resolver hook, so this requires upstream support or an SDK/launcher integration. Reverify the host API before taking the item; it is not a release dependency.
