# State Flow — Current Work

Completed outcomes live in [CHANGELOG.md](CHANGELOG.md); source-bound semantic evidence is indexed under [historical semantic evidence](docs/README.md#historical-semantic-evidence).

## External validation and evaluation

Deterministic acceptance does not establish live model quality or installed-client behavior.

- [ ] **Live-model semantic-memory comparison — authorization-gated, not run.** Offline calibration is working on the selected read-only lifecycle path. Use the unchanged [corpus and rubric](benchmarks/semantic-memory-trial.md#fixed-user-input-corpus). Live execution requires an explicitly authorized normal inference route, pinned model/provider/reasoning and bounded request/token/time limits. Bind comparisons to preserved baseline and actual target digests, report feasible flat/scoped errors, retries, quality and cost, and disclose drift and unsupported comparisons. Never scrape credentials or relabel scripted calibration as model evidence.
- [ ] **Installed-client compatibility smoke — operator/environment-gated, not established by CI.** With explicit installation/reload authority and an isolated store/session, check the intended TUI/Telegram client's mode controls, captured selection, inspection and unavailable-owner presentation against [compatibility boundaries](docs/compatibility.md). Record exact client/SDK/package identities and observed results; scripted/native fixtures do not certify live reachability, rendering or every newer SDK.

## Scope and authorization limits

- Preserve explicit unsupported-version refusal and retired-root reservations; see the [format admission policy](docs/compatibility.md#canonical-scope-format-admission). Neither the Baseline transition nor recovery hardening authorizes a semantic-store converter, downgrade or live-store repair.
- New planes/scopes, changed public module semantics, dynamic loading/sandboxing, background inference, unrelated storage formats, speculative performance work and broad redesign remain outside scope.
- Live-store conversion and all other release/rollout actions require their normal explicit authorization. Temporary evidence belongs under ignored `temp/`, not a parallel task queue.
