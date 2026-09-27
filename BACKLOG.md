# Backlog

Target release: **0.22.0**. Completed implementation outcomes are recorded in [CHANGELOG.md](CHANGELOG.md); current behavior and conservative reconciliation boundaries belong in [architecture](docs/architecture.md).

## 0.22: Remaining delivery gates

- **Operator-owned installed smoke:** After an operator-authorized reload, verify terminal autocomplete exposes Active/Passive/Off and status, Telegram renders one lowercase off | passive | active row with the selected marker and four direct scope-inspection buttons, and current-session mode changes agree across tools/context/status and survive reload. Automated native-SDK and adapter tests do not certify installed UI/font rendering. Do not edit real global defaults or unrelated sessions to perform this check.
- **Release verification:** Version 0.22.0 is prepared in package, lockfile and changelog with explicit release authorization. Require direct-main baseline and npm preflight, a validated committed tree, an exact tag workflow, and published GitHub/npm identity before reporting release completion. Keep companion extensions and unrelated working-tree changes untouched.

## Release boundary

Release publication is owned by `.github/workflows/release.yml`. Verify the exact tag's successful workflow, published GitHub Release and matching npm package before reporting release completion. Installed-instance reload remains a separate operator action.
