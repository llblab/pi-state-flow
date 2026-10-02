# Backlog

The **0.24.0** release scope is recorded in [CHANGELOG.md](CHANGELOG.md); this backlog keeps installed-client evidence and later decisions open. Canonical storage, CAS, `historyLimit`, temporal semantics, projection and the model-facing protocol remain unchanged; already retained session modes and explicit global/legacy policies stay authoritative. Current contracts live in [architecture](docs/architecture.md) and [usage](docs/usage.md).

## Carried gates

- **Installed 0.22.0 smoke (operator-owned):** Perform the carried check if it is not yet recorded, only against the exact released 0.22.0 installation; a reload of the modified 0.23.0 candidate cannot certify the old release. After an operator-authorized reload, confirm:
  - terminal autocomplete exposes Active/Passive/Off and status;
  - Telegram shows the single `off | passive | active` row plus the four inspection buttons;
  - current-session mode agrees across tools, context and status, and survives reload.
  Do not edit real global defaults or unrelated sessions.
- **Installed 0.23.0 smoke (operator-owned):** After separately authorized installation/reload, confirm an unconfigured *new* session is Off without semantic writes, retained choices and explicit global modes survive, and Telegram shows one `Off | Passive | Active` radio row with the selected 🟡/🟣/🟢 marker and ⚫️ inactive markers, followed by four direct scope inspections. Isolate test storage; do not use the live store as a fixture. SDK tests alone do not certify installed-client rendering.
- **Installed 0.24.0 smoke (approval/operator-owned):** Local lifecycle, cancellation, background-work and callback/inspection acceptance is complete; real-client behavior remains separate evidence. After separately authorized installation/reload of the exact 0.24.0 release, use a disposable store to check Off attachment and pending-work cancellation, no late memory warnings, current read-only inspections without private placeholders, preserved deferred Passive/Active/fork acquisition, and unchanged terminal/Telegram mode controls. Do not use the live store, treat its reload as evidence for older published releases, or change unrelated operator sessions.

## Deferred beyond 0.24.0 (decision inputs, not commitments)
- **Compaction threshold:** `STATE_FLOW_COMPACTION_MIN_CONTEXT_TOKENS = 24_000` is documented as a margin above Pi's default 20,000-token retained suffix. Make it configurable only if a real workload or non-default Pi retention settings demonstrate a mismatch.
- **Lifecycle complexity review:** Measure how often cooperating-writer waits, Stop fences and fork/restore contention occur in real use before adding further awaited lifecycle layers. Use the result to decide whether any existing layer can be simplified.

## Release boundary

Release publication is owned by `.github/workflows/release.yml`. Align package, lockfile, tag and changelog at the release version, rebuild `dist/` from final sources, and verify the exact tag's successful workflow, published GitHub Release and matching npm package before reporting release completion. Installed-instance reload remains a separate operator action.
