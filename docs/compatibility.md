# Compatibility and verification boundaries

## Supported Pi stack

State Flow requires matching `pi-coding-agent`, `pi-agent-core`, `pi-ai` and `pi-tui` packages at `>=1.0.0`. Keep all four on the same release line. The open-ended peer range permits newer SDK releases; it does not certify them.

**Verified environment:** Linux/x64, Node 26.8.1, Git 2.55.0 and matching Pi SDK 1.0.0 packages.

- Repository validation covers tests, typecheck, build, compiled imports and package dry-run. Results apply to the exact source and dependency identities validated.
- The release workflow uses Node 24; its result is a separate verification gate.
- Tests use isolated stores and scripted providers through the real Pi SDK. They do not certify installed Telegram/TUI reachability, live provider behavior, other operating systems, mixed SDK versions or untested newer SDK releases.

Detailed behavioral witnesses live in [temporal acceptance](temporal-acceptance.md); benchmark methodology and source-bound results live in [performance](performance.md).

## Public host seams

State Flow relies on:

- Awaited session lifecycle events and branch metadata for startup, shutdown, resume, fork and tree navigation.
- Read-only native parent traversal through `getLeafEntry()` and `getEntry(id)`.
- `message_end`, actionable `turn_end`, `agent_before_settle` and `agent_settled` ordering around accepted assistant messages.
- Canonical session context, `ContextEditEntry`, conversation `context` and full `context_with_system` boundaries.
- Public `getContextUsage()`, operation cancellation and native compaction hooks.
- Sequential tool execution and tool-call preflight.
- Session replacement awaiting outgoing shutdown before invalidation.

An embedding must deliver the native lifecycle, not merely construct or dispose a session object. Follow the [embedding lifecycle contract](architecture.md#embedding) and await extension binding for every new session.

## Context, tools and provider input

**System prompt.** State Flow contributes protocol through `systemPromptOptions.sections.state_flow` and refreshes only that section at `context_with_system`.

- Companion sections, native system deltas, tool declarations and non-system message identities remain intact.
- An explicit foreign forced prompt retains Pi's precedence.
- Mode changes update the next provider request without requiring another `before_agent_start`.

**Conversation and recovery:**

- Native context edits, omitted messages and replaced tool results reach the provider through Pi's canonical context. Raw native trace remains inspectable.
- Branch selection applies branch-relative edits without rewriting separately owned memory.
- Retry, length and overflow recovery omit failed attempts from subsequent provider input, without accepting them as State Flow responses or advancing semantic history.
- Edited-context usage accounting must not trigger phantom compaction.

**Images and provider limits.** Image resizing, encoding and provider limits remain SDK-owned. Tests exercise prompt images, built-in reads and generic tool results across model-specific resize profiles while preserving historical payloads. State Flow supplies no image pipeline or provider-limit enforcement. Its tests do not independently certify provider strict schemas, cache behavior, diagnostics or other SDK capabilities.

**Continuation.** Active boundary continuation receives accepted memory even without a new `before_agent_start`. A completed specification is not resurrected, and State Flow does not own the host's continuation scheduler.

## Pre-inference cancellation

On the tested SDK, `before_agent_start` precedes the low-level agent's `prompt`; `ExtensionContext.signal` is undefined there.

1. State Flow captures the specification at that hook without canonical publication.
2. The active `context` hook supplies the operation signal and awaits preparation/maintenance before provider inference.
3. If preparation fails, State Flow calls public `ctx.abort()`. Pi catches context-hook errors and may otherwise continue inference, so a thrown error alone is not a fence.

Native tests prove no provider call before coherent acceptance, cancellation while an independent writer remains held, rollback without draft installation and preservation of uncompiled native input. Failed retained Active restoration also aborts live inference before the provider; native witnesses cover expired tree selection/reload and contradictory private lineage without changing canonical bytes. Explicit inactive policy releases that inference fence, not the write fence.

**Signals are not universal.** Idle commands and session events can lack them. Do not infer native Abort cancellation from an extension-owned shutdown signal or generalize active-run tests to idle waits.

## Mode configuration compatibility

**Preferred representation:**

- Global `config.json` accepts `mode: "active" | "passive" | "off"`. It defaults to Off when no mode policy is configured and supplies only the initial policy for new sessions.
- Session `config.json` uses the same key for the concrete retained choice. Commands and Telegram never edit the global default.
- Before semantic initialization, an inactive choice is retained in a native `{mode}` checkpoint instead.

**Other readable representations.** Decoding is read-only; ordinary writers emit only mode, with no eager migration or semantic normalization.

- Without explicit global mode, absence of all flag-based mode settings means Off.
- `autoStart: true` means Active. With any flag-based mode setting present, `passiveBootstrap: false` together with `passiveTools: false` means Off; otherwise the fallback is Passive.
- Explicit global mode overrides valid flags; invalid values still fail validation.
- Session `enabled:true` means Active, and `enabled:false` means non-active.
- Native inactive checkpoints without an explicit mode use the configured inactive fallback, never an Active default.
- Session config and native checkpoints reject mixed `mode`/`enabled` representations, even when apparently consistent, rather than choosing between two stored policies.

To use Passive, select it in the current session or set global `mode: "passive"` for new sessions.

**SDK and Telegram controls.** The extension SDK accepts an optional `mode` default override. Both Telegram port variants use `snapshot.mode` plus `select(mode)`. A stale callback keyboard may refresh the view without selecting a mode. Synchronous enum-based ports are supported; Start/Stop port signatures are not.

## Mode selection and memory restoration

**Start:**

- Activates current same-session authority under awaited exclusion.
- Rechecks physical identity and initialization permission after waiting, accepts once, then installs policy, memory and checkpoint.
- Does not claim to restore an expired historical boundary.
- Native tests prove current shared plus local-private memory at the next provider, and actual Abort withdrawal for in-run Start with an operation signal.

**Passive:**

- Selects local tools/context policy before waiting for persistence.
- For accepted memory, publishes lifecycle metadata without rewriting semantic/provenance files. Pending inactive choices share one acceptance of the latest mode.
- Keeps independently owned retained restoration, Active-default initialization and fork copying; the latest inactive policy is applied at acceptance.
- Read-only recovery preserves an intervening Passive choice and its write fence.
- Selection, shutdown and accepted Start cancel obsolete Stop persistence; rejected Start does not.
- Genuine persistence failure retains readable memory and native context while fencing writes until accepted Start.

**Off:**

- Selects local tools/context policy immediately and injects no State Flow context, including a frozen handoff.
- Cancels owned restoration/fork and persistence waits, clears semantic caches and records native policy only, without canonical publication.
- Keeps the deferred boundary/source bookkeeping for later explicit Passive/Active acquisition.

Modes select workflow policy, not whether canonical memory exists. Cancelling a Start waiter does not cancel independently owned restoration. Selection changes, shutdown and an available native operation signal can revoke obsolete restoration; failure after acceptance cannot undo memory.

**Native restoration evidence.** Startup and tree handlers await restoration. Tests cover held-store tree/fork selection, exact private state over live shared streams, unchanged parent-private files, cold reopening, failed-Stop recovery and next-provider input without later-branch private values.

A public SDK host can observe the child factory result before awaiting extension binding and send Stop or Stop→Start through the child's public `prompt` method while copying waits. This proves that embedding route, not that the installed CLI or Telegram exposes the child before runtime replacement finishes.

**Read-only recovery** validates current private memory without initializing absent storage or granting patch/lifecycle publication authority. Invalid or expired historical evidence never authorizes newer, empty or unrelated private memory as fallback.

## Settlement cancellation

Native `AgentSession.abort()` can withdraw a settlement lock wait only when the host supplies a suitable operation signal. An extension-owned cancellation lifetime is not a substitute for that signal.

**Optional Git backup** remains at `agent_before_settle`:

- It waits for exclusion only when the host supplies a suitable signal. Otherwise contention produces an explicit diagnostic-only deferral to a later eligible turn.
- Malformed or interrupted ownership remains a failure, not permission to steal a lock.
- Git commands run outside canonical exclusion. Shutdown drains owned attempts and pending pushes.
- Backup failure neither rolls back memory, suppresses an answer nor requests repair inference.

This optional-backup policy does not apply to required semantic publication or restoration. The persistence model is [optimistic canonical storage](filesystem-recovery.md#power-loss-durability), not power-loss-safe acknowledgement or crash-atomic multi-file publication. No journal, replacement Abort handler or background publication worker supplies a stronger guarantee.

**State Flow-owned compaction:**

- Requires known sufficient context usage and a proven retained run anchor.
- Preserves the complete accepted run, skips protected foreign context and never requests retain-none shortening. Exact native `codemode-store` custom metadata permits shortening; native tests preserve its branch records and verify `load()` values/deletions through the real Codemode extension after compaction/reload/resume.
- Leaves native manual/threshold/overflow compaction to Pi.
- Awaits native compaction completion or refusal in the settled handler, so deferred companion prompts do not race it.
- Skips compaction when usage is unknown or insufficient; a benign refusal permits a later attempt.

## Telegram adapter

The optional adapter presents one Off | Passive | Active row and uses the same mode-selection and inspection owners as native commands.

- Inspection returns coherent state plus matching revisions, without publication.
- Controls and inspections acknowledge callbacks before waiting, suppress revoked results and escape late failures in the current menu.
- Synchronous mode-selection ports are supported.
- A first Passive selection may install a read-only shared cache without invalidating its own success receipt. Later controls, branch changes and cancellation still revoke obsolete presentation.

Adapter tests establish these contracts with isolated transport fixtures; they are not a live Telegram smoke test. Missing or unready transport remains fail-open and cannot change core memory behavior.

## State Flow library API compatibility

The package root exports `TemporalRuntime`. The Pi registration shim is a separate default-only entrypoint, not the named library API.

**Awaited runtime operations:**

- **Shared inspection — `refreshShared`:** read-only; no initialization or revision advance.
- **Current private recovery — `refreshCurrentMemory`:** read-only; no publication authority.
- **Authored semantic patch — `withPatchTransaction`:** current shared basis and selected private authority; one atomic acceptance.
- **Accepted-runtime lifecycle — `withLifecycleTransaction`:** config/runtime only; cannot initialize or repair semantic storage.
- **Current-head activation — `withStartTransaction`:** origin creation defaults off and requires explicit authorization.
- **Retained restoration — `withRestoreTransaction`:** exact retained private boundary beside current shared streams.
- **Child creation — `withForkTransaction`:** exact parent authority and an unoccupied independent child.

Await completion before consuming results. Transaction callbacks:

1. Recheck caller selection/policy after waiting.
2. Stage and publish synchronously, using their publication capability once within its lifetime.
3. Install host state only after acceptance.

Keep inference, source acquisition and Git outside canonical exclusion. Raw precomputed replay retains its selected-basis guards.

Continuation inspection/candidate building and Git backup also return Promises. Await them rather than treating a Promise as a boolean or accessing a result before completion. Continuation inspection is advisory: it cannot initialize, restore or select a session on the host's behalf.

**Synchronous runtime methods:** `loadPassive`, `prepareBoundaryRestore`, `restoreBoundary`, `acceptRestoredOrigin`, `prepareBoundaryFork` and `initialize`.

- They are supported for library consumers and local tests/benchmarks; production lifecycle wiring uses the awaited APIs.
- They are not signature-compatible substitutes and do not acquire the awaited APIs' cancellation behavior.
- Their presence is not permission to bypass ownership, retained-history or raw-replay checks.

## Validation procedure

Validate another SDK line in an isolated copy so the installed extension, sessions and production store remain unchanged:

1. Copy the complete intended source tree, including retained uncommitted changes when applicable.
2. Install or link matching versions of all four Pi SDK packages and record the resolved dependency graph.
3. Use isolated agent/session directories, synthetic Git identity and fixture data only.
4. Run `npm run validate` and record the exact source/toolchain identity with the result.
5. Inspect the compiled public API through `dist/index.js` and the Pi default registration through `dist/pi-state-flow/index.js`.
6. Compare generated `dist` and packaged Skills with source, and verify package inventory after final documentation edits.

**Evidence limits:**

- Focused tests do not replace the full integration suite.
- Tree-bound evidence can be reused only when its relevant inputs are unchanged.
- Ref-, environment- and external-publication-sensitive checks require their own verification.
- A successful tag push is not release completion: verify the owning workflow, published GitHub Release and exact npm package identity.
