# Physical fork: retained session-stream copy

Status: **locally implemented and validated; not released**. [Usage](usage.md#fork-support-and-limits) owns operation and recovery; [BACKLOG.md](../BACKLOG.md) owns release tracking.

## Contract

A physical Pi fork creates a fresh child session from a retained boundary in its direct parent's canonical session lineage:

```text
child.global  = current live global
child.cwd     = current live CWD
child.session = parent session selected at retained boundary
```

The adapter reads Pi's persisted direct-parent header, requires matching CWD and session identity, and selects the boundary only if it remains in the parent's retained canonical lineage. It never consults Git, a storage receipt, an older checkpoint entry, or the parent's newer private state.

The child receives:

- its own UUID, native session key, runtime metadata, and fresh lineage origin;
- the selected parent session materialization and matching artifact provenance;
- current live global/CWD values and provenance without rewinding them;
- selected enablement and bootstrap lifecycle state, with step reset to zero and no inherited unfinished specification or validation diagnostic.

The parent's private files and native trace remain unchanged. Later child session writes cannot modify the parent's private layer. Applying a smaller configured `historyLimit` may fold excess shared tails during child acceptance under file-cohort CAS, without changing current shared materialization or provenance. Without retention reduction, the shared files remain unchanged too. Forking semantic memory does not clone or roll back project files or tool effects.

Artifact provenance is current-only, not a historical registry. Any retained parent session patch touching an artifact after the selected boundary makes its current provenance unproven for that selection, even if a later patch restores an equal value. The child keeps the selected artifact semantics but omits that provenance until explicit reacquisition and compilation. Untouched artifact paths retain their evidence, including provenance-only refreshes of unchanged semantics; shared provenance remains live.

## Lifecycle and failure

`TemporalRuntime.prepareBoundaryFork()` prepares a detached, single-use copy from current canonical files. Acceptance publishes the fresh child origin before any runtime-only lifecycle write. Existing child storage, identity mismatch, missing parent files, malformed storage, concurrency conflict, or an expired boundary fails closed.

A failed or expired selection never substitutes the parent's current/newer private state and never falls through to an older disabled marker. Explicit Start may retry the same unaccepted fork after missing identity or storage evidence is corrected. Child-owned checkpoints subsequently use ordinary retained-boundary reload/resume without rereading the parent header.

A child-owned passive-projection reset prevents copied parent Stop markers from resurfacing after child reload. Disabled sources remain disabled; ordinary activation policy is not overridden. Nested forks require each direct parent boundary to remain retained; ancestry is not recursively reconstructed.

## Support boundary

Supported copying requires a persisted regular parent session file, matching header UUID/CWD, current canonical scope/runtime files, and an available retained boundary. Arbitrary session search, UUID aliases, cross-CWD imports, in-memory-only parent locators, predecessor conversion, unlimited history, and Git recovery are unsupported.

## Evidence

Native integration tests cover retained private selection versus newer parent/shared state, fresh child origin, independent child mutation, child reload/resume, disabled sources, Stop projection fencing, malformed parent identity/CWD, retry, and expired-boundary refusal. Runtime tests cover single-use preparation, canonical child publication, live shared ownership, artifact provenance, occupied child storage, and retention reduction/increase without parent-private mutation or reconstructed history. Continuation tests cover header-only reading and refusal of non-regular or symlinked locators.
