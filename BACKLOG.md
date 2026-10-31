# State Flow — Current Work

The completed 0.27.2 Consistency & Simplification outcomes are recorded in [CHANGELOG.md](CHANGELOG.md). No release-local implementation queue remains; the external evidence below is still outstanding.

The semantic rename/migration, seven-scope selection, flat single-owner tools, six built-in bindings and public `./modules` registration shipped in [0.27.0](CHANGELOG.md#0270-semantic-memory-and-scope-selection); wanted-but-unavailable reads were corrected in [0.27.1](CHANGELOG.md#0271-selected-scope-read-diagnostics). Completed milestone queues are not current work. Historical rationale, counterexamples and original verdicts remain in the [indexed contracts](docs/README.md), including the [offline-bundle corpus](docs/semantic-handoff-contract.md#offline-bundle-patch-corpus).

## External validation and evaluation

These remain outstanding separately from release-local 0.27.2 acceptance; neither deterministic success nor absence of live evaluation proves agent-quality improvement.

- [ ] **Live-model semantic-memory comparison — authorization-gated, not run.** Use the [existing corpus, runner and rubric](docs/semantic-memory-evaluation.md), preserved baseline source and actual target digests. Include feasible flat-versus-scoped errors/retries/quality/cost comparisons; disclose provider/model drift and unsupported comparisons. Unblocker: an explicitly authorized normal inference route, pinned model/provider/reasoning and bounded request/token/time limits. Do not scrape/copy credentials or relabel faux calibration as model evidence.
- [ ] **Installed-client compatibility smoke — operator/environment-gated, not established by CI.** With explicit installation/reload authority and an isolated store/session, check the intended TUI/Telegram client's mode controls, captured selection, inspection and unavailable-owner presentation against [compatibility boundaries](docs/compatibility.md). Record exact client/SDK/package identities and observed results; scripted/native fixtures do not certify live reachability, rendering or every newer SDK.

## Scope and authorization limits

- Preserve legacy conversion and retired-root reservations throughout State Flow 0.x, with the settled 1.0.0 cutoff and explicit unsupported-version refusal; see the [migration support policy](docs/semantic-compatibility-decision.md#implementation-direction-and-reserved-names). No converter-removal or new migration task is implied.
- New planes/scopes, changed public module semantics, dynamic loading/sandboxing, background inference, storage formats, speculative performance work and broad redesign remain outside consolidation. They are not dormant implementation promises.
- Live-store conversion and all other release/rollout actions require their normal explicit authorization. Temporary evidence belongs under ignored `temp/`, not a parallel task queue.
