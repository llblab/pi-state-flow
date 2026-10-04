# Physical fork: current session-memory copy

[Usage](usage.md#fork-support-and-limits) owns operation and recovery; [BACKLOG.md](../BACKLOG.md) owns release tracking.

## Contract

A physical Pi fork creates a fresh child session from its direct parent's **current** canonical session memory. State Flow does not depend on the Pi step the fork starts from:

```text
child.global  = current live global
child.cwd     = current live CWD
child.session = parent session current head
```

The adapter reads Pi's persisted direct-parent header, requires matching CWD and session identity, reads the parent's current memory and uses its head as the copied boundary. It never consults Git, a storage receipt or an older checkpoint revision.

The child receives:

- its own UUID, native session key, runtime metadata, and fresh lineage origin;
- the parent's current session materialization and matching artifact provenance;
- current live global/CWD values and provenance without rewinding them;
- selected `mode` and bootstrap lifecycle state, with step reset to zero and no inherited unfinished specification or validation diagnostic.

**What stays unchanged:**

- The parent's private files and native trace remain unchanged. Later child session writes cannot modify the parent's private layer.
- Applying a smaller configured `historyLimit` may fold excess shared tails during child acceptance under file-cohort CAS, without changing current shared materialization or provenance. Without retention reduction, the shared files remain unchanged too.
- Forking semantic memory does not clone or roll back project files or tool effects.

**Artifact evidence is current-only, not a historical registry.** Because the child copies the parent's current head, current artifact semantics and their current provenance stay together; shared provenance remains live.

## Lifecycle and failure

**Copying and acceptance.** `TemporalRuntime.withForkTransaction(source, lifecycle, action, signal?)`:

1. Pins source identity and the parent's current head boundary before waiting.
2. Selects exact parent authority plus an unoccupied child under one awaited exclusion.
3. Lets the caller recheck native selection/policy and publish its child lifecycle synchronously, once.
4. Revalidates parent evidence before publication and protects the child cohort with CAS. Only accepted memory installs.

Cancellation or rejection cannot initialize an empty child. Failure after acceptance cannot roll it back or authorize another parent copy. Existing child storage, an identity mismatch, missing parent files, malformed storage or a concurrency conflict fails closed.

**Forking while Off:**

- Parent-header acquisition and canonical copying are deferred. Only a child-owned pending-fork marker is appended to the native trace; it carries no semantic authority.
- The marker survives cold extension reload and permits later explicit Passive/Active acquisition, which copies the parent's then-current memory subject to the same identity and occupied-child checks.
- Accepted initialization resets the marker.

Memory-enabled native fork adoption and Start's fork retry use this transaction inside the extension's owned restoration lifetime. It publishes the fresh child origin before any runtime-only lifecycle write. Native evidence holds a publisher across fork adoption; it does not certify idle native Abort.

**Retry and cancellation:**

- A failed copy never substitutes empty or foreign memory and never falls through to an older disabled marker.
- In the same live extension instance, explicit Start may retry the unaccepted fork after missing identity or storage evidence is corrected.
- Passive selection retains an in-flight fork or its activation-owned retry and applies Passive inside that existing acceptance.
- Off aborts the owned copy/retry before acceptance and records child-owned native Off/pending-fork policy without publishing memory. A later explicit Passive/Active request copies the parent's current memory.
- Cancelling the Start waiter does not cancel that independently owned copy.
- Off, selection, shutdown, native Abort and invalid source evidence can prevent acceptance.

**After acceptance:**

- Passive exposes both tools for child memory without active episode behavior; Off exposes neither.
- Ordinary memory-enabled cold reopening loads that child-owned state; Off defers loading it.
- Navigating to an inherited parent step keeps current child-owned memory; it neither rewinds nor recopies parent data.
- Child-owned checkpoints use ordinary current-memory reload/resume without rereading the parent header.

**Before the first child-owned checkpoint:** cold recovery requires the explicit Off-deferred pending marker. Missing child files alone never authorize a parent recopy.

**Mode and projection:**

- A child-owned passive-projection reset prevents copied parent Stop markers from resurfacing after child reload.
- Inactive sources retain their selected mode, including a same-owner native failed-Stop policy that could not reach canonical config.
- A child inherits neither its parent's write fence nor its passive projection. Parent current memory must be valid, and copying must pass CAS; ordinary activation policy is not overridden.
- Nested forks copy each direct parent's current memory. Ancestry is not recursively reconstructed.

## Support boundary

Supported copying requires a persisted regular parent session file, matching header UUID/CWD, current canonical scope/runtime files, and an available retained boundary. Arbitrary session search, UUID aliases, cross-CWD imports, in-memory-only parent locators, conversion of unsupported storage formats, unlimited history, and Git recovery are unsupported.

## Evidence

**Native integration tests** cover retained private selection versus newer parent/shared state, fresh child origin, independent child mutation, child reload/resume, disabled sources, Stop projection fencing, malformed parent identity/CWD, retry and expired-boundary refusal.

**Runtime tests** cover single-use preparation, canonical child publication, live shared ownership, artifact provenance, occupied child storage and retention reduction/increase without parent-private mutation or reconstructed history.

**Awaited runtime witnesses** also:

- hold an independent partial writer for over two seconds and cancel waiting copies;
- mutate admitted locators and expire source history during waiting;
- race parent/child bytes and serialize competing child acceptances;
- reject every occupied child file;
- roll back injected publication failure and retain accepted memory after checkpoint failure;
- preserve shared unknown metadata and unrelated provenance.

**Continuation tests** cover header-only reading and refusal of non-regular or symlinked locators.

**The extension mode matrix** holds storage across native fork selection or Start-owned fork retry. Stop returns with passive policy while the copy remains pending; release permits selected memory to be accepted with disabled policy. Passive patching and subsequent cold header/trace reopening through `SessionManager.open` retain independent child memory. Expired parent history still refuses without canonical writes or replacement checkpoints. These are isolated extension fixtures.

**A separate native SDK fixture** observes the child through the public session factory before awaiting extension binding. It sends Stop and optionally Start through the child's public `prompt` method while fork copying waits, then checks the requested mode, independent private state and next-provider patch after release. No private SDK hook or direct State Flow handler invocation is used.

These tests prove a supported embedding route, not installed Telegram/TUI reachability before the child replaces the current runtime session.
