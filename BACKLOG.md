# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md).

## Candidate evolution

- [ ] `Lazy memory`: Preserve large historical semantic records outside normal model projection while keeping them discoverable through a bounded, freshness-ranked epistemic index, metadata-only search, and exact scoped reads. Keep active obligations in hot State Flow and route all lazy mutations through the existing causal publication boundary. See [the exploratory proposal](docs/lazy-memory-proposal.md).
  - Status: concept preserved, not scheduled. The write surface, physical layout, ranking policy, and history semantics require implementation experiments before a release contract.
- [ ] `Default passive memory access`: Separate memory availability from the active State Flow episode lifecycle. A normal installation defaults to both passive state bootstrap and `read_state`/`patch_state` tools, while automatic terminal compaction, iteration continuation, and active episode semantics remain gated behind `/state-flow-start`.
  - Configuration: control passive bootstrap and passive tools independently, yielding all four supported combinations: both off, bootstrap only, tools only, or both on (default). Fully off must add no state projection or tools to model context.
  - Passive bootstrap: project existing effective durable state without creating scopes, migrating storage, publishing changes, starting an episode, or promising automatic continuation. Name this separately from active episode/bootstrap semantics.
  - Passive tools: `read_state` remains read-only; an explicit `patch_state` may initialize or migrate the required durable runtime and publish only the requested semantic change, but must not activate terminal compaction or future automatic iterations.
  - Lifecycle: `/state-flow-start` promotes passive access into the existing active episode behavior. `/state-flow-stop` returns to the configured passive combination rather than overriding it globally.
  - Acceptance: cover all four configuration combinations, fresh and existing stores, explicit passive patch publication, unsupported-storage failure, start/stop transitions, tool/context visibility, and proof that passive turns never run terminal compaction.
  - Status: accepted direction, not implemented. Requires a dedicated release contract.
- [ ] `Pi Telegram submenu state analyzer`: Extend the State Flow Telegram section with a read-only analyzer view over the same diagnostics `/state-flow-status` already reports (branch mode, temporal head and hot depth, scope keys, retained tails, artifact freshness, publication). The operator deliberately deferred this beyond the 0.9.0 control surface.
  - Boundary: presentation only. Reuse existing status diagnostics; no new semantic mode, and never mutate state from the analyzer view.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.
