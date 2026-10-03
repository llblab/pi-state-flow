# Backlog

The **0.25.1: Cascade Receipts** scope is implemented; outcomes belong in [CHANGELOG.md](CHANGELOG.md). This backlog retains release and installed-client gates and deferred decisions. Cascade semantics, canonical storage, stored patch records and lifecycle behaviour remain unchanged.

## Out of scope

- Changing what a cascade deletes, including writes into an owned target made by the closing patch. That stays deleted by design and already appears in the receipt.
- Nested `lazy_navigation`, warnings, validation or rejection of any kind.
- Any reduction of lifecycle state; the tagged-union question stays deferred.

## Carried gates

- **Installed 0.25.1 smoke (operator-owned).** Disposable store: close an intent that owns a nested lazy key and confirm the receipt lists it under `cascaded`. May be combined with the open 0.25.0 smoke.
- **Installed 0.22.0, 0.23.0, 0.24.0 and 0.25.0 smokes** remain open as recorded.

## Deferred (decision inputs, not commitments)

- **Closing-patch losses.** In real sessions, look for closing patches that write into a target the same patch cascades. If frequent, revisit the closing sentence in the protocol, not the mechanism.
- Convention uptake, behavioural evaluation, lifecycle real-use measurement, lifecycle tagged union, Skill compilation fidelity and compaction threshold carry over unchanged from the 0.25.0 backlog.

## Release boundary

- **Publication (approval-gated).** After explicit authorization, commit the prepared 0.25.1 package, lockfile, changelog and rebuilt `dist/`, tag the exact commit `v0.25.1`, and push. Verify the exact-tag release workflow, non-draft GitHub Release and matching npm version/commit before closing this gate. Local readiness requires `npm run validate` and the context validator; it does not certify installed clients.
- **Installation/reload (operator-owned).** Requires separate authorization and disposable storage. Grow Loop preparation does not cross publication or live-client gates.
