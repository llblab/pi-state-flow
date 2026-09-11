# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md). No implementation item remains open for 0.9.0.

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
