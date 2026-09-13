# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md).

## 0.10.1: Filesystem self-healing and graceful degradation

- **Outcome:** Treat safely interpretable absence as recoverable or optional while keeping partial, malformed, contradictory, and authority-losing evidence fail-closed at the smallest affected capability. [`docs/filesystem-recovery.md`](docs/filesystem-recovery.md) owns the durable cohort classification.
- **Accepted candidate:** Shared Git/file repair, exact session authority, provenance/external degradation, operational persistence, concurrent CAS and native Pi response/reload/resume witnesses are complete. A focused release review found and corrected repeated stale-target refusal; the runtime now refreshes the empty basis after one conflict and accepts a later patch through ordinary publication.
- **Validation:** The complete 0.84.4 repository profile passes 442/442 with typecheck/import-check. On the supported 0.85.1 stack, all 16 affected codec/runtime witnesses, the real Pi lifecycle witness and typecheck pass. Package 0.10.1 contains 46 files including the recovery guide and excludes tests/benchmarks; context/DAG validation report zero errors.
- [ ] **Release gate:** Commit, push, tag, npm/GitHub publication, and any Pi Kit pin update require separate explicit release authorization.

## Candidate evolution

- [ ] **Read-only global bootstrap layer:** Project the existing global materialization into enabled and non-enabled sessions by default, so even one-shot work starts carrying established cross-project facts, preferences, routing, and conventions. The global scope is the highest-value, lowest-cost half of the memory, while writing carries the protocol and curation tax; making the read side unconditional gives continuity without enabling mutation.
  - Boundary: project the existing durable global materialization only. No writes, transitions, patches, barriers, session/CWD initialization, or temporal-history changes. Model tools and the full protocol remain opt-in behind explicit start, and the bootstrap adds no second semantic mode.
  - Open questions: whether deferred Markdown freshness discovery must run ahead of the first inference, token cost of a stable global prefix, behavior under untrusted project contexts, and naming distinct from the existing bootstrap-run concept.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.
- [ ] **Pi Telegram submenu state analyzer:** Extend the State Flow Telegram section with a read-only analyzer view over the same diagnostics `/state-flow-status` already reports (branch mode, temporal head and hot depth, scope keys, retained tails, artifact freshness, publication). The operator deliberately deferred this beyond the 0.9.0 control surface.
  - Boundary: presentation only. Reuse existing status diagnostics; no new semantic mode, and never mutate state from the analyzer view.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.

## Deferred host integration

- [ ] **Native default session continuation:** Integrate the existing read-only recommendation, exact-selection, and rehydration contracts before Pi creates `SessionManager`, while preserving explicit new/resume and native-picker precedence, truthful notices, and cross-process session ownership. Pi 0.84.4 exposes no suitable pre-session resolver hook, so this requires upstream support or an SDK/launcher integration. Reverify the host API before taking the item; it is not a release dependency.
