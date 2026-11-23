# Compatibility and verification boundaries

## Supported Pi stack

State Flow requires matching `pi-coding-agent`, `pi-agent-core`, `pi-ai` and `pi-tui` packages at `>=1.0.0`. Keep all four on the same release line. The open-ended peer range permits newer SDK releases; it does not certify them.

**Recorded published-baseline environment:** Linux/x64, Node 26.8.1, Git 2.55.0 and matching Pi SDK 1.0.0 packages.

**0.27.2 local candidate checks:** Linux/x64, Node 22.19.0 and 24.21.0, Git 2.56.0 and matching Pi SDK 1.0.0 packages; see the [0.27.2 release record](../CHANGELOG.md). These are local deterministic checks, not new exact-tag release CI or installed-client certification.

- Repository validation covers tests, typecheck, build, compiled imports and package dry-run. Results apply to the exact source and dependency identities validated.
- The [release workflow](../.github/workflows/release.yml) validates the minimum Node **22.19.0** and the current **26.x** release, then uses Node **26.x** for publishing. The recorded v0.27.1 release passed 1,696 tests per matrix entry at the time; this is historical evidence, not a validation result for later edits.
- Tests use isolated stores and scripted providers through the real Pi SDK. They do not certify installed Telegram/TUI reachability, live provider behavior, other operating systems, mixed SDK versions or untested newer SDK releases.

Detailed behavioral witnesses live in [temporal acceptance](temporal-acceptance.md); benchmark methodology and source-bound results live in [performance](performance.md).

## Tool-name compatibility

Since 0.27.6 the advertised tools are `state_flow_read` and `state_flow_patch`. Explicit legacy `read_state`/`patch_state` calls dispatch through the same read/patch implementation with their exact native call name and ID; historical calls are not rewritten. Legacy declarations are hidden through the public SDK `prepareLoadout` membrane while remaining active for dispatch. This is tool-name compatibility only: no old semantic fields, wrapper grammar, storage formats or conversion rules are reinstated.

- Active and Passive activate both spellings; Off removes both and retained wrappers still reject. Only canonical names contribute prompt guidance and provider declarations.
- Selected-owner/schema refresh applies to both mutation spellings. A schema is not an owner receipt; stale, foreign, consumed or unbound native calls still reject before publication.
- Active counts both mutation spellings as one barrier family: multiple calls, including mixed names, all reject; siblings of a single mutation are blocked. Nested Active mutation rejects under either name. Passive keeps its existing explicit-parent nested-call behavior and no new inference barrier.
- An SDK host's explicit allowlist remains authoritative. Include `state_flow_read` and `state_flow_patch` for new requests, plus `read_state` and `patch_state` when legacy calls must dispatch. State Flow does not widen a host allowlist or rewrite native history to compensate.
- Extension/native-request tests and real source/packed SDK witnesses cover name equivalence, retained reads, no-op history, scope-schema refresh, refusal, nested calls, mixed-name barriers and Off. These are deterministic isolated checks, not installed-client rollout or live-model certification.

## Canonical scope format admission

Core-only canonical scope metadata remains **version 3**, with `strategy` and `tactics` fields. The implemented **version 4** codec additionally retains external object-plane descriptors and opaque values independently of loaded definitions; absent internal `modules` metadata keeps existing v3 output. Since **1.0.0**, retired versions **1/2** are refused explicitly instead of translated, and target-format `contract`/`working` roots stay reserved; nested domain keys remain ordinary JSON. Unsupported versions fail closed. These scope versions are distinct from Session lifecycle and public module API v1. External-root tools, captured Active/Passive context and Active producers shipped in 0.27.0; see the [public module boundary](public-module-contract.md).

Existing exported names use Strategy/Tactics fields, callbacks, schemas and paths, not old-field aliases. Quiesce unsupported writers: current version checks cannot retrofit already-deployed unsafe low-level callers. See [operator recovery](usage.md#moving-a-store-and-supported-formats) for preparation with a prior 0.x release and exact-byte backup rules.

Current descriptor and supported lifecycle upgrades require owned semantic acceptance; inspection and runtime-only mode persistence cannot publish them. The serialized scope preflight rejects invalid UTF-8 and preserves exact bytes of an already-target cohort when no descriptor change is requested. A detached preflight result is not filesystem, private-session, or publication authority. Opaque backup and rollback preserve original bytes without admitting them as semantic state. [Filesystem recovery](filesystem-recovery.md#self-healing) does not widen admission or provide another conversion route.

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

### Patch tool declaration refresh

Keep the patch tool name when refreshing its declaration. Cache the desired parameter shape on the unregistered definition template and pass Pi a fresh copy for each registration; `getAllTools()` can omit host-denied tools and is not a registration cache. For built-in planes, only flat↔multi changes alter the shape; mode-only and same-arity changes do not. Host binding and public module registration can also refresh declarations: flat schemas include the registered mutable roots, while read parameters stay structurally stable. [Native admission](architecture.md#model-tools) still checks the original request, including when Pi executes an older wrapper.

The local SDK probes in `tests/pi-compatibility.test.ts` explain why the patch tool does not advertise one union of both grammars. OpenAI Responses and Google preserve the tested alternatives; ordinary non-strict Anthropic Messages drops the top-level object's exclusivity rules and loses the field vocabulary altogether for an object-root union. Separate flat/scoped object shapes retain their applicable fields on all three paths, but do not restore constraints the adapter drops. Native validation remains authoritative. These captured requests test local serialization, not remote acceptance, constrained sampling or model quality.

## Pre-inference cancellation

On the tested SDK, `before_agent_start` precedes the low-level agent's `prompt`; `ExtensionContext.signal` is undefined there.

1. State Flow captures the specification at that hook without canonical publication.
2. The active `context` hook supplies the operation signal and awaits preparation/maintenance before provider inference.
3. If preparation fails, State Flow calls public `ctx.abort()`. Pi catches context-hook errors and may otherwise continue inference, so a thrown error alone is not a fence.

Native tests prove no provider call before coherent acceptance, cancellation while an independent writer remains held, rollback without draft installation and preservation of uncompiled native input. Unreadable current Active memory also aborts live inference before the provider; native witnesses cover contradictory private lineage and malformed runtime files without changing canonical bytes, while old-step tree selection/reload is not a failure. Pending or failed Active attachment retains Active policy and exposes `active (blocked)` in terminal/Telegram; the fence is derived from selected mode plus unavailable-memory validation. Active controls retry current-memory acceptance rather than claiming it is already active. Explicit Passive accepts validated current memory and releases both fences; explicit Off releases only the inference fence.

**Signals are not universal.** Idle commands and session events can lack them. Do not infer native Abort cancellation from an extension-owned shutdown signal or generalize active-run tests to idle waits.

## Mode configuration compatibility

**Preferred representation:**

- Global `config.json` accepts `mode: "active" | "passive" | "off"`, defaulting to Off, and a nonempty unique `scopes` array, defaulting to all three owners. These are initial defaults, not overrides of captured branch policy.
- Selected Session configuration stores concrete `{mode, scopes}`. New selected origins write Baseline runtime metadata; readable numeric V2 stays V2 through observation, no-op scope writes and mode-only persistence. Native v2 policy records remain a separate Pi bookkeeping format, not semantic storage. Mode-only actions preserve captured scopes.
- [Usage](usage.md#lifecycle-operations) defines wanted, available and excluded owners and the 0.27.1 diagnostic. A wanted unacquired Session is unavailable, not excluded; inspection/observation never acquires it. [Scope selection](scope-selection-contract.md#functional-acceptance-boundary) owns legacy proof, deferred forks and request-lifetime requirements.

**Baseline wire format.** Selected admission refuses retired lifecycle V1 and unknown formats without resetting or converting them. Use a previous compatible release for a V1 session. The package-root runtime and Pi use this same admission path.

**Compact lifecycle proof.** The runtime header uses `format: "baseline"`. Each lineage entry stores its boundary once and may carry the canonical owner claim beside it; the retained private basis uses the same encoding. Missing optional owner claims are not inferred from a boundary ID. Actual selected replay must substantiate any required claim, and retained private proof must still be complete. Unknown ancillary lifecycle metadata is preserved. An owned acceptance that publishes a material semantic/provenance change or acquires an existing V2 origin can convert V2 only with the complete admitted source basis, verified exact-byte backup and CAS; failed publication preserves canonical bytes. Global/CWD/Session semantic metadata versions are independent.

**Legacy readable mode representations.** The following are compatibility inputs, not alternative current policy formats. Decoding is read-only. Malformed explicit scope evidence rejects rather than falling through to a wider mode-only fallback.

- Without explicit global mode, absence of all flag-based mode settings means Off.
- `autoStart: true` means Active. With any flag-based mode setting present, `passiveBootstrap: false` together with `passiveTools: false` means Off; otherwise the fallback is Passive.
- Explicit global mode overrides valid flags; invalid values still fail validation.
- Legacy native checkpoints can decode `enabled:true` as Active and `enabled:false` as the configured inactive fallback. Legacy inactive checkpoints without explicit mode never default to Active.
- Native checkpoints reject mixed `mode`/`enabled` evidence. Baseline and numeric V2 canonical config require explicit `mode` and `scopes`, not an `enabled` alias.

To use Passive, select it in the current session or set global `mode: "passive"` for new sessions.

**SDK and Telegram controls.** The extension SDK accepts an optional `mode` default override. Both Telegram port variants use `snapshot.mode` plus `select(mode)` and preserve captured scopes. Optional `snapshot.scopes` supplies participation; legacy omission means all three, while malformed explicit scopes reject. The optional additive `snapshot.inferenceBlocked` diagnostic marks failed Active restoration; legacy ports may omit it. A stale callback keyboard may refresh the view without selecting a mode. Synchronous enum-based ports are supported; Start/Stop port signatures are not.

## Mode selection and memory restoration

**Start:**

- Activates current same-session authority under awaited exclusion.
- Rechecks physical identity and initialization permission after waiting, accepts once, then installs policy, memory and checkpoint.
- Uses current memory; branch checkpoints never select a past revision.
- Native tests prove current shared plus local-private memory at the next provider, and actual Abort withdrawal for in-run Start with an operation signal.

**Passive:** [Local policy, mode-only persistence and fenced recovery](architecture.md#passive-persistence) are separate. A host must not interpret local control success or a readable view as publication authority. Independently owned attachment, Active-default initialization and fork copy can still finish under the latest requested inactive policy.

**Off:**

- Selects local tools/context policy immediately and injects no State Flow context, including a frozen handoff.
- Cancels owned restoration/fork and persistence waits, clears semantic caches and records native policy only, without canonical publication.
- Keeps the deferred boundary/source bookkeeping for later explicit Passive/Active acquisition.

Modes select workflow policy, not whether canonical memory exists. Cancelling a Start waiter does not cancel independently owned restoration. Selection changes, shutdown and an available native operation signal can revoke obsolete restoration; failure after acceptance cannot undo memory.

**Native attachment evidence.** Startup and tree handlers await attachment. Tests cover held-store tree/fork selection, current private state over live shared streams after old-step navigation, fork copies of the parent's current memory, unchanged parent-private files, cold reopening, failed-Stop recovery and next-provider input with current private values.

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

The optional adapter presents one Off | Passive | Active row and uses the same mode-selection and inspection owners as native commands. It is not a scope chooser: only wanted owners receive inspection buttons, and Effective is offered only for two or three wanted owners. Inspections read validated available memory without acquiring missing owners or clearing fences.

- Inspection returns coherent state plus matching revisions, without publication.
- Controls and inspections acknowledge callbacks before waiting, suppress revoked results and escape late failures in the current menu.
- Synchronous mode-selection ports are supported.
- Passive acceptance returns its current presentation receipt after any internal restoration or lifetime renewal, including existing-memory reacquisition after Off and write-fence recovery. The adapter preserves that accepted receipt, so the first click refreshes the button in both busy and idle sessions. Pre-runtime shared-cache loading also retains its receipt. Later controls, branch changes and shutdown still revoke obsolete presentation, including a change away and back to the same mode while callback acknowledgement waits.

Adapter tests establish these contracts with isolated transport fixtures; they are not a live Telegram smoke test. Missing or unready transport remains fail-open and cannot change core memory behavior.

## State Flow library API compatibility

The package root exports `TemporalRuntime`. The Pi registration shim is a separate default-only entrypoint. Both use the same selected Baseline lifecycle. The former V1 methods are removed; these are replacements by intent, not signature-compatible aliases:

- **Observe:** `refreshSelectedShared` or `refreshSelectedCurrent`; neither grants publication authority.
- **Accept the current head / activate an existing owner:** `withSelectedCurrentTransaction`.
- **Author over accepted memory:** `withSelectedPatchTransaction`.
- **Replay against the accepted selected basis:** `publishSelected`.
- **Persist Passive over exactly accepted bytes:** `persistSelectedPassive`.
- **Create a new origin with its first patch:** `withSelectedFirstPatchTransaction`, with explicit creation permission.
- **Acquire Session or copy a parent's current Session:** `withSelectedSessionAcquisitionTransaction` or `withSelectedForkCopyTransaction`, with independent authority.

Pass the exact nonempty selection to operations that take one (use `["global", "cwd", "session"]` only when all three participate). The host must recheck the authority it owns after waiting. Stage and publish synchronously using the callback's capability once, and install host state only after acceptance. Keep inference, source acquisition and Git outside exclusion. See [transaction contracts](architecture.md#runtime-transaction-apis).

Use `selectedView()` for accepted memory, `observedSelectedView()` for a read-only observation, and `selectedStates()` for exact present owners. `clearCache()` withdraws cache-dependent access and leases; it does not forget known private acquisition or allow a new origin. Memory never rewinds to a native checkpoint.

Continuation inspection/candidate building and Git backup also return Promises. Continuation inspection is advisory: it cannot initialize, restore or select a session on the host's behalf.

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
