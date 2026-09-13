# Physical fork: session-stream copy

Status: **locally implemented and validated; not released**. [Usage](usage.md#fork-support-and-limits) owns operation and recovery; [BACKLOG.md](../BACKLOG.md) owns the remaining 0.10.0 work.

## Contract

A physical Pi fork creates a new session with a separate copy of the source's session memory. Global and CWD memory remain the existing shared layers, not historical copies for the child.

```text
B.global  = existing shared global
B.cwd     = existing shared CWD
B.session = copy of source session checkpoint + retained patch tail
```

- Resolve the source session stream at the native fork boundary. An earlier selection does not copy the parent's later live private state.
- Copy the session checkpoint, retained tail of up to seven patches and matching session artifact provenance. Preserve replay records and transition identities rather than flattening them into a new materialized-only snapshot.
- Adopt current proven live global/CWD streams and provenance without rewriting or pruning them. They need not equal the selected source revision's older shared layers.
- Give B its own UUID, native session key, config/meta and durable checkpoint. Retain selected enablement/publication policy and any pending bootstrap requirement, but start at step zero without the parent's run specification, validation feedback, publication acknowledgement or process ownership.
- Preserve A's private files, native trace and accepted history. Subsequent B session writes do not modify A's session layer.
- Forking conversation/memory does not clone or roll back project files or tool effects.

This is session inheritance, not an exact historical snapshot of the whole effective state. It adds no historical shared-owner reference or semantic mode.

## History and lifecycle

`TemporalRuntime.prepareFork()` validates the source before any installation and returns a detached inspection snapshot plus a single-use copy operation. Git source inspection is immutable; file-only input is revalidated against its exact complete cohort. Installation captures a fresh live basis, uses existing stream adoption at a new origin, and publishes only the new session cohort under the existing CAS/exclusion rules. An occupied live or current-HEAD namespace is not a fresh target. Forking does not initialize missing shared storage or run migrations.

The checkpoint/tail copy retains replay data, but its length is not B's available hot-history depth. B begins at a new origin with `state[0]`; subsequent accepted transitions build its aligned `state[0..7]` window. Pre-origin records are not newly fabricated child transitions or indexes into independent local-scope clocks.

B's own Git-backed runtime history begins with its first child-owned cohort. A's earlier Git history remains intact under A. Copied Pi checkpoint entries do not become B-owned historical references: selecting one cannot fall through to an older disabled marker and reset B. Select an owned child checkpoint or resume the parent instead.

The adapter handles native `session_start` with reason `fork`, verifies a regular canonical parent header and matching CWD, then records the child checkpoint. A child-owned passive-projection reset prevents copied parent Stop markers from resurfacing after child reload/resume. Disabled sources remain disabled; ordinary activation policy is not overridden.

## Support boundary

- Initial native copying requires a persisted direct-parent locator and a readable temporal source. The parent filename/key, header UUID and selected runtime identity must agree; no arbitrary session search or UUID aliasing occurs.
- Source or publication failure leaves the selected reference intact. Explicit Start can retry an unaccepted copy in that same loaded fork instance after evidence or contention is corrected.
- Cold recovery before the first child checkpoint, startup/CLI paths that do not emit the native fork reason, in-memory parent locators and arbitrary cross-CWD imports are not added by this slice. Existing child-owned checkpoints use normal reload/resume without rereading the parent header.
- Nested copying works only where the selected pointer is owned by the direct parent; inherited pointers to earlier ancestors are not recursively resolved.
- The file backend copies only an available exact current cohort. Expired file references do not authorize copying newer parent data. Legacy Git storage requires its existing explicit migration path rather than migration during fork.
- Uncommitted shared streams, collisions and concurrent modifications retain the existing publication guards; failure does not authorize broadening the fork's writes.

## Evidence

Both supported [SDK stacks](compatibility.md) pass the full suite. Native Git-backed witnesses cover selected private state versus newer parent/shared state, independent child mutation, owned reload/resume, disabled sources, Stop projection fencing, malformed parent identity/CWD and retry, inherited-pointer reset refusal, plus active-push replacement ownership.

`tests/runtime.test.ts` covers an exact seven-record session copy with provenance, unchanged live shared files including unreferenced provenance, detached/single-use preparation, occupied live/HEAD targets, CAS races and file-only source expiration. `tests/continuation.test.ts` checks header-only reading and refusal of non-regular/symlink locators. These are synthetic fixtures, not production-session or arbitrary-host validation.
