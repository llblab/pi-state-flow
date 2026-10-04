# Backlog

The **0.25.3: Readable Telegram Inspection** hotfix is published (exact-tag workflow, GitHub Release and npm commit verified) and bundled in published Pi Kit 0.27.4; outcomes belong in [CHANGELOG.md](CHANGELOG.md). This backlog retains installed-client gates and deferred decisions. Cascade semantics, canonical storage, stored patch records and lifecycle behaviour remain unchanged.

## Out of scope

- Changing what a cascade deletes, including writes into an owned target made by the closing patch. That stays deleted by design and already appears in the receipt.
- Nested `lazy_navigation`, warnings, validation or rejection of any kind.
- Any reduction of lifecycle state; the tagged-union question stays deferred.

## Carried gates

- **Installed 0.25.3 inspection smoke (operator-owned).** After separately authorized installation/reload, inspect a large nested field: real layout newlines/quotes, separate omitted-character notice and intact genuine JSON string escapes. Use disposable storage; local adapter tests do not certify installed Telegram clients.
- **Installed 0.25.2 smoke (operator-owned).** Disposable store: confirm one patch argument block followed by changed/no-op acknowledgements, compact rows with `showSuccessfulPatches: false`, and visible rejected arguments/errors.
- **Installed 0.25.1 smoke (operator-owned).** Disposable store: close an intent that owns a nested lazy key and confirm the receipt lists it under `cascaded`. May be combined with the open 0.25.0 smoke.
- **Installed 0.22.0, 0.23.0, 0.24.0 and 0.25.0 smokes** remain open as recorded.

## Deferred (decision inputs, not commitments)

- **Closing-patch losses.** In real sessions, look for closing patches that write into a target the same patch cascades. If frequent, revisit the closing sentence in the protocol, not the mechanism.
- Convention uptake, behavioural evaluation, lifecycle real-use measurement, lifecycle tagged union, Skill compilation fidelity and compaction threshold carry over unchanged from the 0.25.0 backlog.

## Release boundary

Installation/reload requires separate authorization and disposable storage. Local validation and publication do not certify installed clients.
