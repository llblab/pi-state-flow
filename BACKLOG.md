# Backlog

No open implementation items for the 0.21.0 Minimal Reconciliation scope. Completed outcomes are recorded in [CHANGELOG.md](CHANGELOG.md); current behavior and conservative reconciliation boundaries belong in [architecture](docs/architecture.md).

Release publication is owned by `.github/workflows/release.yml`. Verify the exact tag's successful workflow, published GitHub Release and matching npm package before reporting release completion. Installed-instance reload remains a separate operator action.

Canonical storage, revisions, history, CAS and lifecycle formats are unchanged. Structural prefix evidence is described in the [benchmark guide](benchmarks/README.md); it does not claim provider cache-hit, token-cost or latency guarantees.
