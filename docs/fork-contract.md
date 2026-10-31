# Physical fork: current session-memory copy

[Usage](usage.md#fork-support-and-limits) owns operation and recovery; [BACKLOG.md](../BACKLOG.md) owns release tracking.

## Contract

A physical Pi fork creates a fresh child identity and inherits the source branch's captured mode and scopes. When Session participates and private acquisition is admitted, it copies its direct parent's **current** canonical Session memory. Off or Session-excluded forks defer private acquisition. State Flow does not depend on the Pi step the fork starts from:

```text
selected child.global/cwd = current live selected shared owners
admitted child.session   = direct-parent Session current head
excluded child.session   = no hidden private semantic stream
```

At private acquisition, the adapter reads Pi's persisted direct-parent header, requires matching CWD and session identity, and admits the parent's current private stream. A Session-excluded child instead accepts selected shared access and child-owned deferred lifecycle proof without reading the parent header/private store. It never consults Git, a storage receipt or an older checkpoint revision.

The child receives:

- its own UUID, native session key, runtime metadata, and fresh lineage origin;
- the parent's current Session materialization, matching artifact provenance and retained module descriptors when private copying is admitted;
- current live selected Global/CWD values and provenance without rewinding them;
- captured `mode` and `scopes`, with fresh step-zero/bootstrap lifecycle and no inherited unfinished specification or validation diagnostic. A later deferred private copy preserves the child's already accepted lifecycle fields.

**What stays unchanged:**

- The parent's private files and native trace remain unchanged. Later child session writes cannot modify the parent's private layer.
- Applying a smaller configured `historyLimit` may fold excess selected shared tails during child acceptance under file-cohort CAS, without changing current shared materialization or provenance. Without retention reduction, the shared files remain unchanged too.
- Forking semantic memory does not clone or roll back project files or tool effects.

**Artifact evidence is current-only, not a historical registry.** Because the child copies the parent's current head, current artifact semantics and their current provenance stay together; shared provenance remains live.

## Lifecycle and failure

**All-owner library copying and acceptance.** The supported `TemporalRuntime.withForkTransaction(source, lifecycle, action, signal?)` contract remains:

1. Pins source identity and the parent's current head boundary before waiting.
2. Selects exact parent authority plus an unoccupied child under one awaited exclusion.
3. Lets the caller recheck native selection/policy and publish its child lifecycle synchronously, once.
4. Revalidates parent evidence before publication and protects the child cohort with CAS. Only accepted memory installs.

Cancellation or rejection cannot initialize an empty child. Failure after acceptance cannot roll it back or authorize another parent copy. Existing child storage, an identity mismatch, missing parent files, malformed storage or a concurrency conflict fails closed.

**Forking while Off:**

- Parent-header acquisition and canonical copying are deferred. Only a child-owned pending-fork marker is appended to the native trace; it carries no semantic authority.
- The marker survives cold extension reload and permits later admitted Session acquisition under explicit Passive/Active policy, copying the parent's then-current private memory subject to the same identity and occupied-target checks. Shared-only enablement retains deferral rather than consuming private-copy authority.
- Accepted initialization resets the marker.

The native adapter composes the selected-scope ports below inside its owned restoration lifetime, rather than routing every fork through the all-owner library transaction. Fresh shared-only deferral publishes child lifecycle plus selected shared access without private copying; eager/deferred private acceptance validates its corresponding source and target before installing memory. Neither route grants idle native Abort a signal the host does not supply.

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

**Before private acquisition:** cold recovery requires child-owned pending-fork authority; an accepted shared-only child additionally retains its validated deferred lifecycle proof. Missing child files alone never authorize a parent copy or recopy.

**Mode and projection:**

- A child-owned passive-projection reset prevents copied parent Stop markers from resurfacing after child reload.
- Inactive sources retain their selected mode, including a same-owner native failed-Stop policy that could not reach canonical config.
- A child inherits neither its parent's write fence nor its passive projection. Parent current memory must be valid, and copying must pass CAS; ordinary activation policy is not overridden.
- Nested forks copy each direct parent's current memory. Ancestry is not recursively reconstructed.

## Internal selected-scope copy boundary

The native [selected-scope contract](scope-selection-contract.md#selected-parent-current-private-copy), shipped in 0.27.0, implements shared-only child deferral and eager/deferred private copy over selected streams. The native adapter must validate persisted direct-parent identity before exclusion and recheck current in-memory child/parent/policy ownership after waiting. The storage owner verifies only parent-current private files/lineage/provenance plus selected live shared inputs, never recursive ancestry or unrelated disabled owners. Parent bytes stay read-only; occupied, malformed, lost-acquired or already-acquired child evidence cannot become empty memory or authorize recopy.

Native `withSelectedDeferredForkTransaction` and `withSelectedForkCopyTransaction` compose the existing origin/current acceptance owner. They return file receipts/sticky authority facts and install the [accepted selected cache](scope-selection-contract.md#accepted-selected-runtime-cache-and-reads) only after durable acceptance; child classification precedes any parent lookup. Public mode-command scope overrides and native pending-marker/selection-lifetime attachment are implemented. The [M2 functional boundary](scope-selection-contract.md#m2-functional-acceptance-boundary) records actual native seven-selection/fork delivery separately from lower backend fixtures.

Copying uses the parent-current materialization and starts one fresh child aligned origin. Retained per-owner tail records may still be copied subject to `historyLimit`; they do not create earlier aligned child materializations. Current-only copying is not a claim that every historical patch byte is absent from child storage.

## Support boundary

Private copying requires a persisted regular direct-parent session file, matching header UUID/CWD, current canonical private/runtime evidence, and an unoccupied child semantic target. A deferred lifecycle-only child must prove its own admitted pending authority; an acquired child uses child-current memory and never recopies. Arbitrary session search, UUID aliases, cross-CWD imports, in-memory-only parent locators, conversion of unsupported storage formats, unlimited history, and Git recovery are unsupported.

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
