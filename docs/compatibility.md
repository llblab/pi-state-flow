# Compatibility and verification boundaries

## Supported Pi stack

State Flow requires matching `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` packages at `>=0.87.0`. Keep all four on the same release line. The open-ended peer range permits newer SDK releases; it does not certify them.

The repository-local verified stack is Linux/x64, Node 26.8.1, Git 2.55.0 and Pi SDK 0.87.0. Repository validation covers tests, typecheck, build, compiled imports and package dry-run; successful results are bound to the validated source and dependency identities. The release workflow uses Node 24; its result is a separate verification gate.

Tests use isolated stores and scripted providers through the real Pi SDK. They do not certify installed Telegram/TUI reachability, live provider behavior, other operating systems, mixed SDK versions or untested newer SDK releases. Detailed behavioral witnesses live in [temporal acceptance](temporal-acceptance.md); benchmark methodology and source-bound results live in [performance](performance.md).

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

State Flow contributes its protocol through `systemPromptOptions.sections.state_flow` and refreshes only that section at `context_with_system`. Companion sections, native system deltas, tool declarations and non-system message identities remain intact; an explicit foreign forced prompt retains Pi's precedence. Mode changes update the next provider request without requiring another `before_agent_start`.

Native context edits, omitted messages and replaced tool results reach the provider through Pi's canonical context. Raw native trace remains inspectable. Branch selection applies branch-relative edits without rewriting separately owned memory. Retry, length and overflow recovery omit failed attempts from subsequent provider input without accepting them as State Flow responses or advancing semantic history. Edited-context usage accounting must not trigger phantom compaction.

Image resizing, encoding and provider limits remain SDK-owned. Tests exercise prompt images, built-in reads and generic tool results across model-specific resize profiles while preserving historical payloads. State Flow supplies no image pipeline or provider-limit enforcement. Provider strict schemas, cache behavior, diagnostics and other SDK capabilities are not independently certified by State Flow's tests.

Active boundary continuation receives accepted memory even when no new `before_agent_start` occurs. A completed specification is not resurrected. State Flow does not become the owner of the host's continuation scheduler.

## Pre-inference cancellation

On the tested SDK, `before_agent_start` precedes the low-level agent's `prompt`; `ExtensionContext.signal` is undefined there. State Flow captures the specification at that hook without canonical publication. The active `context` hook supplies the operation signal and awaits preparation/maintenance before provider inference.

Pi catches context-hook errors and may otherwise continue inference. State Flow therefore calls public `ctx.abort()` on preparation failure rather than relying on a thrown error as a fence. Native tests prove no provider call before coherent acceptance, cancellation while an independent writer remains held, rollback without draft installation and preservation of uncompiled native input.

Operation signals are not universal. Idle commands and session events can lack them. Do not infer native Abort cancellation from an extension-owned shutdown signal or generalize active-run tests to idle waits.

## Start, Stop and memory restoration

Start activates current same-session authority under awaited exclusion. It rechecks physical identity and initialization permission after waiting, accepts once, then installs policy, memory and checkpoint. Explicit Start does not claim to restore an expired historical boundary. Native tests prove current shared plus local-private memory at the next provider and actual Abort withdrawal for in-run Start with an operation signal.

Stop switches local policy and passive context before waiting for persistence. For accepted memory it publishes lifecycle metadata without rewriting semantic/provenance files. Repeated pending Stops share one acceptance. Selection, shutdown and accepted Start cancel obsolete Stop work; rejected Start does not. Genuine persistence failure retains readable memory and native context while fencing writes until accepted Start.

Start/Stop choose workflow policy, not whether canonical memory exists. Stop does not cancel retained restoration, auto-start initialization or fork copying: passive policy is applied at that operation's acceptance. Cancelling a Start waiter does not cancel independently owned restoration. Selection changes, shutdown and an available native operation signal can revoke obsolete restoration; post-acceptance ancillary failure cannot undo memory.

Native startup and tree handlers await restoration. Tests cover held-store tree/fork selection, exact private state over live shared streams, unchanged parent-private files, cold reopening, failed-Stop recovery and next-provider input without later-branch private values. A public SDK host can observe the child factory result before awaiting extension binding and send Stop or Stop→Start through the child's public `prompt` method while copying waits. This proves that embedding route, not that the installed CLI or Telegram exposes the child before runtime replacement finishes.

Read-only recovery validates current private memory without initializing absent storage or granting patch/lifecycle publication authority. Invalid or expired historical evidence never authorizes newer, empty or unrelated private memory as fallback.

## Settlement cancellation

On Pi SDK 0.87.0, the agent clears its active run before `agent_before_settle`, so that event has no operation signal. Native `AgentSession.abort()` cannot withdraw an extension's lock wait at this boundary.

Optional Git backup remains at `agent_before_settle`. It waits for exclusion only when the host supplies a suitable signal; otherwise contention produces an explicit diagnostic-only deferral to a later eligible turn. Malformed/interrupted ownership remains a failure, not permission to steal a lock. Git commands run outside canonical exclusion. Shutdown drains owned attempts and pending pushes. Backup failure does not roll back memory, suppress an answer or request repair inference.

This optional-backup policy does not apply to required semantic publication or restoration. The persistence model is [optimistic canonical storage](filesystem-recovery.md#power-loss-durability), not power-loss-safe acknowledgement or crash-atomic multi-file publication. No journal, replacement Abort handler or background publication worker supplies a stronger guarantee.

State Flow-owned compaction requires known sufficient context usage and a proven retained run anchor. It preserves the complete accepted run, skips protected foreign context and never requests retain-none shortening. Native manual/threshold/overflow compaction remains Pi-owned. The settled handler awaits native compaction completion or refusal so deferred companion prompts do not race it. Unknown or insufficient usage skips compaction; a benign refusal permits a later attempt.

## Telegram adapter

The optional adapter uses the same Start/Stop and inspection owners as native commands. Inspection returns coherent state plus matching revisions without publication. Controls and inspections acknowledge callbacks before waiting, suppress revoked results and escape late failures in the current menu. Legacy synchronous presentation ports remain supported.

Adapter tests establish those contracts with isolated transport fixtures. They are not a live Telegram smoke test. Missing or unready transport remains fail-open and cannot change core memory behavior.

## State Flow library API compatibility

The package root exports `TemporalRuntime`. The Pi registration shim is a separate default-only entrypoint, not the named library API.

Use these awaited runtime operations:

| Operation | API | Authority boundary |
| --- | --- | --- |
| Shared inspection | `refreshShared` | Read-only; no initialization or revision advance |
| Current private recovery | `refreshCurrentMemory` | Read-only; no publication authority |
| Authored semantic patch | `withPatchTransaction` | Current shared basis and selected private authority; one atomic acceptance |
| Accepted-runtime lifecycle | `withLifecycleTransaction` | Config/runtime only; cannot initialize or repair semantic storage |
| Current-head activation | `withStartTransaction` | Origin creation defaults off and requires explicit authorization |
| Retained restoration | `withRestoreTransaction` | Exact retained private boundary beside current shared streams |
| Child creation | `withForkTransaction` | Exact parent authority and an unoccupied independent child |

Await completion before consuming results. Transaction callbacks stage and publish synchronously, recheck caller selection/policy after waiting and use their publication capability once within its lifetime. Install host state only after acceptance. Keep inference, source acquisition and Git outside canonical exclusion. Raw precomputed replay retains its selected-basis guards.

Continuation inspection/candidate building and Git backup also return Promises. Callers must await them rather than treating a Promise as a boolean or accessing a result before completion. Continuation inspection is advisory: it cannot initialize, restore or select a session on the host's behalf.

The supported synchronous runtime methods are `loadPassive`, `prepareBoundaryRestore`, `restoreBoundary`, `acceptRestoredOrigin`, `prepareBoundaryFork` and `initialize`. They remain available to library consumers and local tests/benchmarks, but production lifecycle wiring uses the awaited APIs. They are not signature-compatible substitutes and do not acquire the awaited APIs' cancellation behavior. Their presence is not permission to bypass ownership, retained-history or raw-replay checks.

## Validation procedure

Validate another SDK line in an isolated copy so the installed extension, sessions and production store remain unchanged:

1. Copy the complete intended source tree, including retained uncommitted changes when applicable.
2. Install or link matching versions of all four Pi SDK packages and record the resolved dependency graph.
3. Use isolated agent/session directories, synthetic Git identity and fixture data only.
4. Run `npm run validate` and record the exact source/toolchain identity with the result.
5. Inspect the compiled public API through `dist/index.js` and the Pi default registration through `dist/pi-state-flow/index.js`.
6. Compare generated `dist` and packaged Skills with source, and verify package inventory after final documentation edits.

Focused tests do not replace the full integration suite. Tree-bound evidence can be reused only when its relevant inputs are unchanged. Ref-, environment- and external-publication-sensitive checks require their own verification. A successful tag push is not release completion: verify the owning workflow, published GitHub Release and exact npm package identity.
