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

`TemporalRuntime.withForkTransaction(source, checkpoint, action, signal?)` pins source identity/boundary before waiting and selects exact parent authority plus an unoccupied child under one awaited exclusion. The caller rechecks native selection/policy and publishes its child lifecycle synchronously once. Parent evidence is revalidated before publication, the child cohort is CAS-protected, and only accepted memory installs. Cancellation or rejection cannot initialize an empty child; post-acceptance failure cannot roll it back or authorize another parent copy. Existing child storage, identity mismatch, missing parent files, malformed storage, concurrency conflict, or an expired boundary fails closed.

Native fork adoption and Start's exact-source retry use this transaction inside the extension's owned restoration lifetime; the synchronous `prepareBoundaryFork()` adapter remains public only until consumer cleanup. Both paths publish the fresh child origin before any runtime-only lifecycle write. Native evidence holds a publisher across fork adoption; it does not certify idle native Abort.

A failed or expired selection never substitutes the parent's current/newer private state and never falls through to an older disabled marker. In the same live extension instance, explicit Start may retry the unaccepted fork after missing identity or storage evidence is corrected. Stop does not cancel an in-flight fork or its Start-owned retry: it selects passive child policy, which is applied inside the existing fork acceptance. Cancelling the Start waiter does not cancel that independently owned copy. After acceptance, configured passive tools can patch child memory without enabling active behavior; ordinary cold reopening loads that child-owned state. Selection, shutdown, native Abort, invalid source evidence and expired history still can prevent acceptance. Recovery of forks abandoned before this correction is not certified; missing child files never authorize a parent recopy. Once child storage has been accepted, explicit Start can activate its validated current child-owned memory even after selecting an inherited parent checkpoint; this neither restores parent history nor copies newer parent data. Child-owned checkpoints subsequently use ordinary retained-boundary reload/resume without rereading the parent header.

A child-owned passive-projection reset prevents copied parent Stop markers from resurfacing after child reload. Disabled sources remain disabled, including a same-owner native failed-Stop policy that could not reach canonical config. A child inherits neither that parent's write fence nor its passive projection; source history must still be provable and copying must pass CAS. Ordinary activation policy is not overridden. Nested forks require each direct parent boundary to remain retained; ancestry is not recursively reconstructed.

## Support boundary

Supported copying requires a persisted regular parent session file, matching header UUID/CWD, current canonical scope/runtime files, and an available retained boundary. Arbitrary session search, UUID aliases, cross-CWD imports, in-memory-only parent locators, predecessor conversion, unlimited history, and Git recovery are unsupported.

## Evidence

Native integration tests cover retained private selection versus newer parent/shared state, fresh child origin, independent child mutation, child reload/resume, disabled sources, Stop projection fencing, malformed parent identity/CWD, retry, and expired-boundary refusal. Runtime tests cover single-use preparation, canonical child publication, live shared ownership, artifact provenance, occupied child storage, and retention reduction/increase without parent-private mutation or reconstructed history. Awaited runtime witnesses additionally hold an independent partial writer for over two seconds, cancel waiting copies, mutate admitted locators, expire source history during waiting, race parent/child bytes, serialize competing child acceptances, reject every occupied child file, roll back injected publication failure and retain accepted memory after checkpoint failure. Shared unknown metadata and unrelated provenance remain intact. Continuation tests cover header-only reading and refusal of non-regular or symlinked locators. The extension mode matrix holds storage across native fork selection or Start-owned fork retry. Stop returns with passive policy while the copy remains pending; release permits selected memory to be accepted with disabled policy. Passive patching and subsequent cold header/trace reopening through `SessionManager.open` retain independent child memory. Expired parent history still refuses without canonical writes or replacement checkpoints. These are isolated extension fixtures. A separate native SDK fixture observes the child through the public session factory before awaiting extension binding, sends Stop and optionally Start through the child's public `prompt` method while fork copying waits, and checks the requested mode, independent private state and next-provider patch after release. No private SDK hook or direct State Flow handler invocation is used. This proves a supported embedding route, not installed Telegram/TUI reachability before the child replaces the current runtime session.
