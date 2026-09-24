# Backlog

No open implementation items for the 0.19.0 release scope.

Release publication is owned by the version-tag workflow in `.github/workflows/release.yml`; a tag alone is not completion. Verify successful automation, the matching published GitHub Release and npm package before reporting the release complete.

Completed outcomes are recorded in [CHANGELOG.md](CHANGELOG.md). Maintained contracts and acceptance evidence belong to [docs](docs/README.md), including the accepted [persistence limitation](docs/filesystem-recovery.md#power-loss-durability) and [library API compatibility](docs/compatibility.md#state-flow-library-api-compatibility).

Live-host, provider and platform verification limits remain documented in [SDK compatibility](docs/compatibility.md). Production-store conversion and installed-host activation remain separate operator decisions; see [usage and recovery](docs/usage.md).
