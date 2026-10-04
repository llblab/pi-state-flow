# State Flow architecture

## Purpose

State Flow is a Pi extension that materializes compact, scoped semantic state across agent runs while preserving Pi's native session trace and tool loop. It is inspired by SKILL.state but uses its own temporal model, storage plane, artifact compiler and publication lifecycle.

The extension owns durable memory while enabled. Global semantic memory is always available; there are no ownership or global-memory feature switches.

## Composition

`index.ts` is the minimal public export boundary. `lib/extension.ts` is the Pi lifecycle composition root: it wires configuration and domain capabilities into commands, tools, event subscriptions and handlers, and delegates imperative mechanics to their owning modules. Each independent module under `lib/` owns one concern and is mirrored by tests:

- `state`, `json`: semantic shape, validation, recursive overlay and deletion.
- `temporal`, `history`: causal boundaries, checkpoint/tail folding and hot history.
- `durable`, `storage`, `git`: exact canonical files, file-cohort CAS, and optional settled-turn backup, including its due/permitted/cancellation state (`SettledTurnBackup`).
- `snapshot`, `session`, `runtime`, `recovery`, `episode`: Pi branch/runtime lifecycle, branch traversal, and passive-boundary interpretation.
- `transition`, `ownership`, `context`: inference barriers, turn resolution, intent-ownership cascades, passive projection, and response reconciliation.
- `compaction`: completed-history compaction planning and per-request marker state (`StateFlowCompactionRequests`).
- `operation`: `OwnedOperationSlot`, the single-owner cancellation slot used by Start, inactive-mode persistence, branch restoration, inference preparation and response reconciliation; identity-guarded release keeps late completions from clearing newer work. `RenewableLifetime` owns the shared-inspection and memory-tool cancellation lifetimes.
- `artifact`, `acquisition`, `skills`, `rehydration`: source routing and compilation; `ArtifactAcquisitionState` owns the selected branch's invalidation plan, model hints and correlated read candidates.
- `memory`: generic memory-bearing scope diagnostics.
- `continuation`: native-header discovery, runtime-provenance inspection, deterministic recommendation, and host startup precedence.
- `protocol`, `logging`: model/tool presentation and bounded diagnostic persistence.
- `status`, `telegram`, `extension`: operator projection, the optional fail-open pi-telegram presentation adapter, and high-level Pi adapter wiring.

## Semantic state

Runtime views select these documented semantic planes when present. Stored scope objects may omit any of them, and unrelated top-level fields are ignored:

```json
{
  "intents": {},
  "contract": {},
  "working": {},
  "artifacts": {},
  "response": "",
  "lazy": {}
}
```

- `intents` is the queue of chosen actions, not a planner, scheduler, task manager or execution loop. An intent may own same-scope `working`/`lazy` keys by structured reference; see [model tools](#model-tools).
- `contract` retains durable requirements, decisions, interfaces and rejected approaches.
- `working` is the temporary working context of those actions: verified current facts, results and uncertainties.
- `artifacts` maps exact source paths to compiled routing metadata.
- `response` is owned only by the session scope and stores the exact latest accepted assistant answer, including the empty string. Global/CWD do not receive newly accepted answers, and stored scopes may omit response entirely. An explicit nonempty Session answer overrides inherited values; an empty or absent response contributes nothing to projection.
- `lazy` is an optional stored object root for ordinary JSON detail. It defaults to `{}` only in internal compatibility views, is omitted from baseline model state and is read explicitly.
  - Automatic recent-transition projection also removes each whole `patch.lazy`, including deletions. Empty scoped patches and transitions disappear, and an empty projected window is omitted.
  - Visible hot patches keep their original identities, order and positions. Canonical history and explicit current/historical reads are unchanged.
  - Bounded lazy navigation stays available without bodies; previously communicated user/tool/response text is not redacted.

Effective state recursively overlays:

```text
global → CWD → session
```

Later scopes win. A scope-local `null` deletion removes only that scope's key and may reveal an inherited value. Scope represents applicability and ownership, never instruction authority.

**Sparse state.** Missing planes are valid sparse semantics, not incomplete storage.

- Checkpoint/tail codecs select only known top-level fields on read and write; unknown fields are neither kept in runtime streams nor carried into later writes. Nested data within known planes stays intact.
- Retained record identities and positions survive even when filtering leaves an empty patch.
- `readTemporalView` selects present known fields at the requested boundary, then overlays scopes without inventing fields.
- Empty and absent responses mean the same for projection; clearing a nonempty response projects as a deletion.
- Explicit reads of absent documented top-level fields return `null`.
- `readTemporalState` and the embedding callback keep default-bearing compatibility views for internal registry consumers. Those defaults never become stored overrides or model context.
- Passive reads and Start do not fill checkpoint fields or create revisions for normalization; missing shared pairs initialize as empty objects.

**Staging and replay.** Authored staging uses raw scope presence and derives runtime-normalized replay from the writes actually accepted, including complete artifact replacement; replay must reproduce accepted state exactly. Each supplied scope (and Session on response reconciliation) recursively omits empty object fields, including explicit `{}` and empty planes, before intent ownership and after cascades/compilation. The scope root remains `{}`; array slots and empty arrays remain, while object fields inside array elements are pruned. Untouched scopes are not normalized. Existing empty branches in a supplied scope become explicit accepted deletions and may advance its revision once; clean repeats create none. Model projection hides legacy empty object fields without changing stored state, exact current/historical reads or replay.

**Validation.** Present documented fields keep usable object/string types, valid artifact entries and the no-stored-null rule; ignored fields may contain arbitrary JSON. Malformed JSON and invalid storage/history authority remain errors.

**Ownership of knowledge.** State Flow is the memory owner while enabled:

- cross-project/user/environment knowledge belongs in global state;
- project-only knowledge belongs in CWD;
- branch/run continuation belongs in session.

Global availability is not a feature switch, and it does not authorize secrets, raw history, transient progress, speculative clutter or unsupported assertions. Explicitly uncertain hypotheses stay eligible only when they can affect an open decision.

## Temporal model

All scopes take part in one active causal lineage:

- One accepted semantic transition receives one opaque identity, shared by every changed scope.
- A branch-local position may order identities but never substitutes for a global counter or merges forks. Origin adoption is not an invented semantic transition or retry loop.
- Sparse transitions create no records for unchanged scopes.

Each scope stores:

```text
checkpoint.json + patches.jsonl
```

**Checkpoint and tail.** The checkpoint is an older anchored materialization. Current scope state is exactly `materialize(checkpoint.json, patches.jsonl, meta.json)` at the selected anchored boundary, and the tail holds at most the configured `historyLimit` effective patches. On overflow, the oldest tail patch folds into the checkpoint before the new patch is appended. Unapplied replay records are never truncated or replayed over an already-current snapshot.

**Changing the limit.** Persisted streams and lineage are validated against the format maximum before a newly configured lower limit is applied.

- Restore/reload/fork accepts only boundaries inside the configured window, then folds excess scope tails during canonical origin acceptance.
- This representation-only folding preserves the selected private state and current shared values/provenance; a fork never rewrites parent-private files.
- Zero keeps only current checkpoints, and a later increase does not reconstruct discarded records or lineage.

**History offsets versus revisions.**

- `effective[n]`, `global[n]`, `cwd[n]` and `session[n]` resolve the same nth previous causal boundary. The history index is a composed-lineage offset, not a scope revision.
- Separately, each materially changed owner advances its persisted semantic revision once. Global and CWD counters are shared across their canonical writers, Session stays private, and Effective is identified by the current `g#c#s#` revision vector.
- The top-level `state` segment is rejected. Pre-origin history is unavailable rather than empty.
- Once enough accepted transitions are proven, offsets zero through the configured `historyLimit` stay addressable at their shared causal boundaries.

**Responses in history.** A changed accepted response is runtime-owned, session-only semantic state and advances history. An accepted empty answer finalizes normally: it clears a previous nonempty response, but creates no transition merely to replace an absent response with `""`. Ordinary completion needs no `patch_state` call when durable semantic state is already correct.

## Pi lifecycle

### `patch_state` acceptance

`patch_state` is the sole mutation tool:

1. It acquires store exclusion before selecting current Global/CWD.
2. It stages the authored operations while preserving private Session ownership.
3. It validates and publishes one atomic cohort. Replay, history and revisions use that actual basis; correct repeats create no semantic transition.
4. It then acts as an inference barrier: Pi executes no sibling tools from the same assistant response, and the next inference sees the rematerialized current effective state.

### `state_updates` receipts

A successful native tool result may include a `state_updates` block, separate from the compact acknowledgement used by interactive rendering. The context domain owns this projection, not storage or the lifecycle composition root.

**Shape.** `effective` entries contain a `path` array of exact object keys/array indices, plus either a replacing `value` or `deleted: true`.

- These are accepted effective values, not authored merge operations: a scope-local deletion can reveal a lower value, and higher scopes can mask an accepted lower-scope write.
- Arrays whose length changed are replaced as a unit; equal-length changes may target indices.
- Indexed-array patch selectors become numeric update paths only against a communicated in-bounds array basis. Object keys with the same spelling are literal.
- Artifact cards use the normal metadata filter, and touched cards replace their whole projected entry.
- Lazy bodies never enter this block; a changed bounded `lazy_navigation` may accompany it.
- An optional `cascaded` array lists owner-scoped paths removed by intent deletion, including nested lazy targets that do not change the top-level navigation. It contains paths only, never values, and is absent when no target cascaded.
- Unrelated unchanged branches are omitted. A result with nothing left to reconcile and no cascade has only the acknowledgement.

**What is always included.** Entries conservatively cover changed scope fallbacks, masked or overlapping multi-scope touches, and projected changes since the last communicated view, including shared refreshes before or during the transaction. `cascaded` lists every target computed during accepted staging, in deterministic per-scope order across Global, CWD and Session. It is never elided as predictable: a receipt with only `cascaded` and an empty `effective` array still reaches the model. The owner path does not imply effective absence; `effective` entries still describe any revealed fallback.

**What may be omitted as predictable:**

- A direct non-null leaf write, when the accepted effective value matches the authored value and no other authored scope touches that path or its ancestors/descendants. Disjoint multi-scope writes are independent.
- An explicit Session scalar/array replacement whose accepted value matches the authored one, even when lower scopes overlap that path. Ambiguous object merges and deletions stay conservative.
- A coalesced object addition/replacement exactly matching the authored object, without suppressing foreign sibling fields.
- A deletion, only when the accepted effective value equals the previously communicated value and no other authored scope overlaps. An effective-only head cannot prove a hidden lower-scope fallback from its own basis, so changed fallbacks stay visible.
- An artifact card replacement or merge, when its projected authored fields applied to an already communicated card exactly match the accepted card after stripping runtime-owned provenance fields. An unchanged, previously communicated hint stays part of that known card; new, removed or changed hints and unexpected semantic drift stay visible.
- A lazy navigation summary (bounded key/kind only, never bodies), when the complete previously communicated catalog and non-deleting top-level writes predict the entire accepted catalog. Deletions, overlapping keys, incomplete catalogs and drift stay conservative.

**Projection IDs.** Each update carries a volatile `projection` ID matching the head's `State Flow projection:` text block. The protocol applies only matching updates: retained native results with older IDs stay historical and cannot override a new head. Within one projection, the latest entry supersedes earlier context only at its path.

### Frozen head and tail notices

`ContextProjection` freezes the whole initial head, including its timestamp, specification and recent transitions. The volatile ID is not a semantic transition identity and enters neither canonical files nor runtime metadata.

- Signal-less inspection before active preparation is accepted uses a disposable projection, so it cannot freeze a stale specification or pre-maintenance state for the live inference.
- Active/bootstrap runs rebase on new input and on accepted completion. A native continuation after completion gets a fresh head without resurrecting the completed specification.
- Passive runs keep their head across ordinary user turns.
- Both modes rebase on mode changes, selection/resume/reload, native compaction and a removed or replaced native prefix. There is no per-patch or size-threshold rebase.

Unreported state changes, changing artifact hints, invalidation lists and the rehydration phase are appended as synthetic tail notices, at the native-message boundary where they first appeared:

- Later inference keeps those exact messages at those positions before new native messages, rather than moving them to the latest tail.
- Empty invalidation lists and a null rehydration envelope explicitly clear earlier notices.
- Accepted patch receipts advance the communicated view; their state deltas are not repeated as synthetic notices.
- Stop handoff uses its captured state as the initial basis, including changes made before its first projection.
- Skill acquisition guidance stays attached to native read results.

The cache owns no persistence, publication authority or continuation scheduler, and does not redact native history.

### Tool preflight and diagnostics

**Preflight.** Tool preflight follows Pi's public `getLeafEntry()` / `getEntry(parentId)` links to the nearest assistant that contains the current call ID, and inspects that response's complete tool batch. It neither constructs the whole branch nor caches a batch across calls or selections. Foreign custom entries and earlier sibling results stay in the native trace. A missing call ID still searches the selected ancestry and keeps the existing unmatched-call behavior, so this is not an unconditional constant-time guarantee. See [measured traversal evidence](performance.md#tool-preflight-parent-traversal).

**Diagnostics.** Opt-in local JSONL diagnostic categories are `invalid-patch`, `publication-conflict`, `finalization` and `barrier-block`.

- Active preflight records each blocked call when a batch has multiple `patch_state` calls or a sibling of its single `patch_state` call.
- A `barrier-block` record holds only the blocked tool name, call id, existing block reason and ordered batch tool names. It captures no sibling arguments, reasoning or draft content.
- Logging off creates no barrier record, and Passive has no barrier.
- Diagnostic persistence is outside canonical state and cannot change the blocking decision.
- Asynchronous Git push failure detail is the separate logging-off exception; see [diagnostic privacy](usage.md#diagnostic-logging-and-privacy).

### Reads, answers and the protocol

`read_state` reads one cached effective or scoped projection, at current index zero or at a retained causal index up to the configured `historyLimit`. It never publishes or advances history.

**Answers.** Before answering, the model uses `patch_state` only when future-relevant durable state must change. The exact accepted ordinary answer is reconciled directly into runtime-owned `response` at `turn_end`, including `""` when the accepted answer is empty.

- There is no terminal eligibility latch, finalization patch, repair inference or fallback budget.
- If required ordinary-artifact compilation prevents reconciliation, State Flow reports the failure without generating another inference. Optional Skill acquisition never blocks unrelated reconciliation.
- State Flow does not parse `state_flow` or generic HTML comments. Historical comments are ordinary text, and other extensions keep their own comment handling.

**Protocol.** The always-injected protocol lists the six planes once, states scope ownership and response finalization once, combines stewardship with handoff rules, and shares provenance ownership across artifacts and Skills. Ordinary and bootstrap modes keep the same read/patch grammar, references, acquisition and safety obligations; bootstrap adds only its reconciliation requirement. This is prose deduplication, not a change to tool semantics, configurable retention or retained Session restoration/fork. `tests/protocol.test.ts` guards the preserved obligations and unique rule ownership.

## Lifecycle planes

```text
SEMANTIC STATE       intents + contract + working + artifacts + response + lazy
MUTATION BARRIER     patch_state(scope patches) → rematerialized next inference
CONTEXT PROJECTION   Active state | Passive memory/handoff | Off: no injection
```

### Passive after Active

Selecting Passive after Active ends episode semantics, enables both memory tools, and switches projection to three parts: a frozen effective-state handoff, the active user-run trajectory if it was interrupted, and the conversation after Stop.

- Paired tool results arriving after Stop stay visible, and foreign context-bearing custom messages survive.
- Outside an unfinished bootstrap, a proven active boundary excludes completed earlier ordinary conversation.
- Stop during bootstrap keeps its incoming context boundary instead of treating uncompiled conversation as completed: an initial bootstrap keeps all available native context, while a restart keeps its earlier passive boundary across repeated toggles.
- Direct completion persists no private validation feedback.
- This projection survives same-physical-session reload, resume and tree restoration. Active restart uses it for one bootstrap run, alongside active runtime context. New and forked physical sessions inherit neither projection.
- Off keeps the boundary for later Passive/Active use but injects neither State Flow context nor tools.
- No semantic transition is created.

### Pre-runtime branches

A proven pre-runtime branch has no accepted runtime to persist. An inactive new-session default or explicit choice appends only `{mode:"off"}` or `{mode:"passive"}` in Pi, without creating canonical files.

- A first explicit choice matching an unretained fallback is recorded; repeating a retained choice is inert.
- Passive may load existing shared memory read-only, but that cache is not runtime publication authority. Installing its own loaded view keeps the control's successful receipt; replacement, selection and cancellation still revoke it.
- Accepted canonical publication, including a later Active or a passive patch, ends the pre-runtime condition. Failed selected-boundary recovery never qualifies for it.

### Explicit Start

Explicit Start independently prepares the validated current same-session canonical cohort, rather than replaying the selected Pi pointer. Active/passive or unfinished runtime metadata and expired/pre-runtime selections neither erase current private memory nor block activation.

**How acceptance works:**

- `withStartTransaction` acquires exclusion before capture and binds private stream identity to the current runtime lineage, with one synchronous, single-use exact-cohort acceptance before installation. Pending repeats share the same operation.
- After waiting, the current branch/physical identity, initialization permission and bootstrap context are rechecked. Stop, selection and shutdown withdraw an obsolete activation.
- Only acceptance enables the new mode, clears Stop fences and cancels older Stop persistence.
- Caches, preparation policy and one native checkpoint install before yielding, without a second persistence call; a later failure cannot roll them back.
- Commands, deferred settled Start and Telegram await completion, and presentation receipts for both success and failure revoke with selection.

**What it preserves:** private values, artifact provenance, independent revisions and step, plus available aligned history within the configured limit. It discards the old unfinished specification.

**Edge cases:**

- Incompatible but independently valid live shared streams require a fresh origin, not invented cross-writer history.
- An empty session origin is allowed only with wholly absent private authority and initialization-safe branch provenance; incomplete or contradictory evidence stays closed.
- Initial physical fork copying still requires its exact-source contract; an already accepted child can activate its own current memory without recopying its parent.
- Repeated Start while already active changes neither the current run nor pending response reconciliation.

### Passive persistence

**Adopting shared drift.** For accepted runtimes, the Pi adapter's lifecycle-only Passive persistence reconciles valid live global/CWD drift before publishing the current session's config/runtime pair.

- Changed shared streams establish a fresh proven origin, not a semantic transition. The runtime adopts their already-advanced owner revisions without incrementing them, while semantic files and all provenance files stay unchanged.
- Cached reads may constrain wider tails left by another writer without rewriting them.
- Same-session file races and explicitly requested stale provenance writes still fail closed under CAS.
- The host refreshes its scope cache after adoption: Stop freezes the accepted view, and new-run registered-artifact maintenance runs against that view before inference.

**Order of operations.** Passive selection immediately applies the selected tools/context policy and disables active response/compaction behavior, before attempting canonical persistence. For accepted runtimes it then:

1. freezes the passive handoff immediately;
2. awaits `withLifecycleTransaction` with Stop-owned cancellation and any available Pi operation signal (pending inactive choices share one acceptance of the latest mode);
3. after acquisition, rechecks the runtime, physical owner and policy, and derives the snapshot from current lifecycle state, including an intervening same-instance passive patch;
4. on successful publication, installs the adopted shared cache, final handoff and native checkpoint before yielding.

Off, session/tree selection, shutdown or an accepted Start revoke obsolete Passive persistence; a failed Start leaves it pending. Shutdown drains the canceled operation. A post-acceptance lifecycle failure never restores old metadata or retries native writes.

**If persistence fails.** Accepted cached memory and all available native context are kept. The existing native passive-stop marker records `owner`, the selected inactive `mode`, `persistenceError` and `preserveContext: true`.

- This is a same-session policy override and write fence, not semantic authority or a substitute checkpoint. No canonical failure is repaired by resetting memory.
- Memory-enabled tree/reload/resume with that pending marker use `TemporalRuntime.refreshCurrentMemory()` to validate and read current memory, without historical restoration or publication; unavailable evidence stays unavailable.
- A later accepted checkpoint supersedes the fence while keeping the context boundary for bootstrap.
- Repeating the same degraded choice is inert; another inactive choice updates only native policy and keeps the fence.
- An in-flight read-only recovery keeps a repeated Passive choice; Off cancels it before further acquisition.
- A successful explicit Start uses the same detached validation path under CAS before clearing the fence.
- Status and inspection distinguish accepted cached/read-only memory from unavailable publication.
- If Pi's own trace is unwritable, the local disablement still happens before the error, but the durable fallback cannot be guaranteed.

### Off

Off uses a separate local owner. It aborts the restore/fork, activation, preparation, response, model-patch and Passive-persistence lifetimes, clears cached semantic views, and records native policy without any canonical transaction.

- A usable cached accepted boundary may be bookmarked read-only in a native Off checkpoint. An unusable cached bookmark never prevents local Off or authorizes replacement memory.
- The owner-local stop marker's `memoryDeferred: true` plus `mode: "off"` selects Off even when the canonical runtime mode is still Active/Passive. When needed, it also keeps continuation timestamps, a carried write fence and an unaccepted fork marker.
- Exact selected-boundary restoration stays separate from current-memory Active. Already accepted canonical bytes are not rolled back.
- Late canceled model patches do not log memory diagnostics.
- Automatic context, Skill/artifact tracking, queued tool failures, settlement and shutdown callbacks stay memory-inert in Off, including with opt-in logging. Only native policy bookkeeping and the release of already-owned protocol resources survive.

### Stop marker and run anchor

The existing native passive-stop marker stores the stop timestamp and an optional `from` timestamp identifying the active run's first user message.

- Native user events are observed independently of State Flow enablement, so activating mid-tool and repeated mode changes keep the actual first-user timestamp. Native user-run preparation and session-start/tree events reset capture; semantic mode changes do not.
- The marker accepts an optional `preserveContext: true` when compilation is unfinished and no narrower incoming boundary is sufficient. With the flag omitted, the ordinary boundary-selection rules apply. This projection flag creates no semantic storage authority.
- Transcript bodies stay in Pi's trace rather than being copied into another state store.

Which boundary Stop keeps:

- A recorded active anchor uses the same conservative selector as active inference. If native compaction removed it, or matching is ambiguous or nonfinite, the available native summary and tool trajectory are kept, without guessing a post-stop boundary or rereading discarded raw entries.
- An interrupted run keeps its captured anchor even after Pi becomes idle. If capture is unavailable, Stop preserves all available context.
- Completed idle runs, and markers without an active anchor or preservation flag, keep only post-stop conversation plus foreign custom context.

The initial system prompt is composed at `before_agent_start`. Stop does not rewrite an already-issued request; the next provider request receives the current owned protocol section, as described below.

### Protocol section and continuations

The current user specification stays at user authority and appears only in synthetic user runtime context. State is fallible assistant-produced data.

**The owned system-prompt section:**

- Active/passive protocol contributes to Pi's native `state_flow` system-prompt section at `before_agent_start`, instead of forcing the entire prompt. Later companion sections and `context_with_system` transformations compose normally; explicit foreign forced prompts keep Pi's documented precedence.
- Native section diffs remove and reinstate the initial protocol across user requests.
- At `context_with_system`, the context domain also refreshes only the owned section from current enablement/bootstrap/passive policy. This covers Stop/Start inside the same tool loop and accepted-boundary continuations.
- An unchanged effective protocol reuses the original array without relocating native deltas. A changed mode preserves foreign sections/content/tools and conversation identity/order, without mutating native frames or creating missing system authority.

**Continuations.** Accepted completion removes the specification, not memory availability. A companion's actionable `turn_end` or `agent_before_settle` continuation can request another inference without `before_agent_start`.

- Every enabled request still gets one current-memory projection, omitting an absent specification and using the captured native anchor when available.
- No synthetic user run, persisted continuation field or State Flow scheduler is created.
- Completed trajectories leave model context at user-run boundaries, while Pi's full JSONL trace stays inspectable.

### Completed-history compaction

**When State Flow asks.** After an accepted non-bootstrap run settles with no queued input, State Flow may request native manual compaction when public `getContextUsage()` reports at least 24,000 tokens. The request uses an extension-private prefix and a fresh per-request marker.

- This token signal is a modest margin above Pi's default 20,000-token retained suffix. Pi still owns preparation and may benignly decline when custom settings leave no compactable prefix.
- The settled handler awaits the native completion/error callbacks before returning. Pi can then dispatch deferred companion prompts after every observer finishes, without racing an in-flight manual compaction. This waits for one existing native operation, without adding a timer, queue or second continuation owner.

**Owned requests.** The `state-flow-boundary:` namespace identifies owned requests even after extension recreation.

- Inactive, missing-plan, completed or superseded owned requests return cancellation, even after transient-plan cleanup, and never fall back to a default model summary.
- Callback completion clears only its own marker's plan; an old callback cannot clear a new request.
- Foreign manual and native threshold/overflow hooks stay untouched.

**What is kept.** The extension supplies no model-generated state body. It forwards the existing `runAnchorTimestamp` to the planner, requires one matching native user entry, and keeps the complete accepted run, including later steering and tools. A missing, ambiguous or unanswered anchor produces no request; the planner never falls back to the nearest user message. Compaction details contain only the retained semantic boundary/step. `buildContextEntries()` then omits the older completed prefix, while the append-only JSONL/tree history stays intact.

**Why no retain-none boundaries.** State Flow does not use retain-none boundary compactions. Completed canonical state omits the exact user prompt, and foreign custom context can legitimately occur inside the latest retained iteration; hiding both would make the projected semantic state a lossy substitute for native context.

**What prevents the boundary:** unknown or smaller usage, foreign custom metadata or native `custom_message` context in the prefix that would be removed, stale selection, Stop/bootstrap/error/abort, and pending input. User manual and native threshold/overflow compaction stay unmodified; unaccepted work stays under Pi's native compaction contract.

### Context view and trajectory

- The Pi adapter passes its raw cached scope overlay to the context domain's `contextView`, which owns model sanitization. The adapter never sanitizes or pre-projects the overlay itself.
- `runtimeContextHead` serializes that already-projected view only when the projection cache needs a new head; `runtimeContextMessage` remains the raw-input convenience builder.
- `currentRunTrajectory` selects a unique captured user timestamp without requiring specification-text equality, because Pi may append image normalization hints after `before_agent_start`. Without a captured timestamp, only a unique exact specification match can select a projected suffix. Missing, nonfinite or ambiguous selection keeps all available context.
- Projection never assigns `runAnchorTimestamp`. Native user events own that lifecycle identity, so a projection fallback cannot become compaction authority.
- With a selected boundary, one retained-message array preserves foreign custom messages at every position and ordinary messages from the original run, including images, tools and steering, without copying discarded ordinary prefixes. The necessary scan and Pi's earlier native-message clone stay history-dependent. See [context-cost evidence](performance.md#context-projection-and-trajectory-selection).

## Storage and identity

The default store is `<agentDir>/state-flow`. Artifact sources are only exact paths already present in semantic state.

Canonical store layout:

```text
config.json
checkpoint.json
patches.jsonl
meta.json
<cwd-key>/checkpoint.json
<cwd-key>/patches.jsonl
<cwd-key>/meta.json
<cwd-key>/<session-key>/checkpoint.json
<cwd-key>/<session-key>/patches.jsonl
<cwd-key>/<session-key>/meta.json
<cwd-key>/<session-key>/config.json
<cwd-key>/<session-key>/runtime.json
```

**Keys.** CWD and session keys mirror Pi's native encoding; when no JSONL basename exists, the in-memory session key derives from `<header timestamp>_<UUID>`. The Pi UUID stays authoritative, and readable directory keys never replace identity validation. Unsafe segments, mismatches and CWD-key ownership collisions are rejected rather than selecting a different scope.

**What each file owns:**

- Root `config.json` is read-only operator configuration. Its `mode` supplies the new-session default (Off when absent and no flag-based mode settings are present). It never takes part in semantic overlay or State Flow-owned staging; include it in operator-managed copies/versioning.
- `checkpoint.json` is only the canonical materialized semantic state, and each nonblank `patches.jsonl` line is only one semantic patch.
- Every scope's `meta.json` symmetrically owns its independent semantic revision, checkpoint/tail boundaries and artifact provenance, with CWD ownership added where applicable.
- Session `config.json` serializes only its concrete `mode` (`active`, `passive`, `off`), independently of later global defaults.
- Session `runtime.json` asymmetrically owns lineage, the internal branch step, session identity, and the full specification only while a run is unfinished. It stores no storage receipt, Git identity, temporal revision pointer, publication mode or push intent.
- Pi checkpoints keep only a semantic boundary plus lifecycle fields, or a proven inactive pre-runtime `{mode}` marker.

**Compatibility rules:**

- Predecessor combined session metadata is unsupported; session `meta.json`, `config.json` and `runtime.json` must already satisfy their canonical ownership contracts.
- Metadata writers replace only their owned leaves and preserve JSON-safe unknown siblings.
- A scope without a revision counter initializes it from the still-retained semantic tail and persists that baseline on its next owned write; folded ancestry is not guessed.
- Revision-aware writes emit scope metadata version 2 and still read version 1. The version fence makes an older writer refuse a scope after its first revision-aware write instead of silently dropping the counter; all cooperating instances should still upgrade together.
- Supported flag-based settings and native `{disabled:true}` markers decode read-only. Mixed session `mode`/`enabled` representations are rejected, and no eager migration runs.
- Revision-pointer checkpoints are unsupported and fail closed without Git restoration.

**In-memory patching.** Patching detaches one basis at its public boundary, then privately path-copies changed object/array containers while sharing untouched nodes only inside that owned draft.

- Incoming replacement values stay detached, and staging makes no redundant cohort/per-scope pre-clones.
- Mutable staged responses and artifact registries stay isolated from accepted scopes, and commit/public temporal reads keep their detachment boundaries.
- This is not cross-version mutable sharing or a new disk generation format; see [copy-work evidence](performance.md#memory-only-owned-draft-cow).

**Writes.** All owned writes use same-directory atomic replacement, regular-file and symlink checks, prepared opaque source-byte receipts and CAS validation. Unrelated files and detected concurrent bytes are preserved, and rollback restores only bytes that still match the failed publisher's output. In-process semantic comparisons use validated structural JSON equality; cryptographic hashes are for compact identities crossing process or persistence boundaries.

### Asynchronous storage transaction

**The primitive.** `lib/storage.ts` supplies `withStorageTransaction(root, callback, signal?, waitForLock = true)`. The root must already exist.

- One `.state-flow-publication.lock` covers every scope in that store.
- The callback receives root-bound `capture` and `publish` operations and keeps exclusion until it finishes, including asynchronous completion. Capture happens after acquisition.
- Publication reuses the validation, exact-byte CAS, receipts and guarded rollback of the synchronous adapter, without reacquiring the lock.
- Borrowed operations expire when the callback completes and cannot address another store.

**Waiting and cancellation:**

- By default, a live PID is waited for asynchronously until release or cancellation. There is no ordinary-contention deadline or automatic lock theft. Only the empty creation-to-PID window has a bounded two-second grace period.
- Malformed, non-regular, unreadable or interrupted ownership fails without repair.
- Recursive acquisition of an actively owned root is an error, not implicit reentrancy. Inherited async context from a completed callback neither confers ownership nor blocks a new transaction.
- Cancellation before acquisition or before publication leaves canonical bytes unchanged. Once a synchronous publication has accepted its cohort, later cancellation does not undo it.
- Cleanup checks lock identity and contents, preserves detected replacement ownership, and keeps both action and release errors when necessary.

**Durability limits.** No process/power-loss crash atomicity or kernel-atomic exclusion against nonparticipating writers is implied, and the writer has no file/directory flush barrier. Optimistic persistence across abrupt shutdown is an [accepted limitation](filesystem-recovery.md#power-loss-durability), not a release gate; no crash-recovery journal or additional storage namespace is planned. Short capture/stage/publication exclusion is still necessary to preserve independent fields between cooperating writers: stale whole-state last-writer-wins replacement would lose unrelated work.

### Runtime transaction APIs

**`TemporalRuntime.withPatchTransaction`** routes `patch_state` through this capability.

- Its synchronous callback receives detached exact sparse scope semantics (without read defaults), their causal basis and provenance, plus one single-use `publish` operation. It cannot access selection or raw storage methods.
- Shared drift is adopted before staging, not used to reject a stale agent. The exact accepted private cohort stays fenced against another physical writer or unselected history.
- A new owner prepares an empty private origin without writing it separately. Validation failure leaves canonical files and accepted caches untouched.
- Compiled cards and evidence publish together, and an absent semantic pair cannot confer orphaned compilation evidence on a new registration.
- Host caches and the accepted native checkpoint update after publication, before yielding.

**`TemporalRuntime.withLifecycleTransaction(action, signal?)`** is the runtime-only counterpart.

- It requires already accepted private authority both before and after waiting; passive reads and unaccepted restore candidates cannot initialize or authorize it.
- Under one exclusion it captures current shared state and calls `action(publish)`. The caller must recheck selection/policy and derive its current lifecycle snapshot before invoking `publish(snapshot)` synchronously, once.
- Only that session's config/runtime may change. Semantic files, scope provenance, scope revision counters and even wider foreign retained tails stay untouched.
- No-op acceptance returns `changed: false` after validating the captured cohort. Failed or canceled publication installs no candidate; cancellation after acceptance cannot undo it.
- The transaction APIs share the candidate/acceptance owner, with no nested lock acquisition or second persistence call.
- The patch transaction's existing `publish` also uses runtime-only acceptance when there is no transition/provenance update and its accepted file cohort is complete. New private authority or wholly absent shared pairs instead require ordinary atomic initialization from the staged current values. Partial or malformed evidence stays rejected. No extra publisher capability or caller-selected storage mode is needed.

**`TemporalRuntime.withStartTransaction(action, signal?, allowCreateOrigin = false)`** supplies `action(currentSnapshot, publish)`.

- It validates the current same-session head instead of requiring the caller's cached private basis; the detached snapshot omits old unfinished specifications.
- Root/private-origin creation is refused by default. When explicitly permitted, wholly absent private authority supplies `undefined`, and the caller must recheck branch permission after waiting before publishing its activated snapshot. Rejected staging never accepts empty setup separately.
- Complete current memory preserves available aligned history, while independently valid shared streams can establish a fresh origin.
- Start uses ordinary origin acceptance, including configured retention folding, not lifecycle-only semantic-byte preservation.
- The synchronous prepared Start API keeps its selected-cohort CAS contract but has no production caller.

**`TemporalRuntime.withRestoreTransaction(checkpoint, action, signal?)`** detaches the retained pointer before waiting, then captures and validates its exact private boundary beside current shared streams under one exclusion.

- `action(selectedSnapshot, publish)` rechecks caller selection/policy after waiting and accepts synchronously, once.
- The candidate stays detached until publication. Expiry, incomplete evidence, cancellation and CAS failure never substitute current-head or empty memory.
- Origin acceptance applies configured retention and causal provenance pruning, as the synchronous restore does.
- Accepted memory is installed before control returns to caller checkpointing; a later failure cannot roll it back.
- Native startup/tree restoration uses it through the extension's owned restoration lifetime.

**`TemporalRuntime.withForkTransaction(source, checkpoint, action, signal?)`** pins the parent identity and boundary before waiting.

- Under one exclusion it selects exact retained parent authority and captures an unoccupied child target.
- The callback receives the child lifecycle (step zero, selected mode/bootstrap, no unfinished specification), rechecks native selection/policy, then publishes synchronously once.
- Parent evidence is revalidated immediately before child publication, and the child's exact file cohort is CAS-protected. Only acceptance installs child memory.
- Parent-private files stay untouched, shared provenance stays live, and configured folding still applies.
- Expired, malformed or occupied selections never become an empty or newer-parent copy.
- Native fork adoption and Start's exact-source retry use it.

### Run preparation and answer reconciliation

**Preparation before the first inference.** Native `before_agent_start` captures the prompt and contributes protocol without touching canonical storage. At the first active `context`, the adapter:

1. combines Pi's operation signal with its preparation lifetime and awaits `withPatchTransaction`;
2. rechecks selection/policy, clones the latest lifecycle snapshot and inspects exact registered paths from the locked states;
3. removes proven-missing registrations and their provenance together with run metadata, in one acceptance. Source reappearance or unavailable metadata does not authorize deletion.

Without removals on a complete accepted cohort, publication preserves semantic/provenance files and wider retained history. Wholly absent shared pairs initialize as current empty reality, without reviving old values or incrementing the step. Caches, revisions and one native checkpoint update before the provider is called; later context requests reuse the completed preparation instead of replaying the specification. Start can request maintenance without inventing a new user run.

**Withdrawal and failure:**

- Stop, session/tree changes, new runs and shutdown withdraw obsolete preparations.
- A failed or canceled acceptance installs no draft or shared adoption; a later failure cannot roll back accepted metadata.
- Pi catches context-hook exceptions and continues, so a failed preparation requests cancellation through public `ctx.abort()` before returning, with an actionable diagnostic and no repair inference.
- Idle/no-signal projections do not publish.
- Native tests prove this [pre-inference cancellation seam](compatibility.md#pre-inference-cancellation), including real Abort while another process is paused mid-publication.

**Unaccepted requests.** An unaccepted request may leave no canonical specification. Native conversation after the latest valid checkpoint is therefore conservative uncompiled-context evidence, not semantic authority. Stop preserves it even at idle, and same-physical-session restoration uses the existing bootstrap flag to keep available context through reload/tree. This also covers interrupted boundary continuation after completion removed the specification. No new persistence format, guessed run anchor or reconstruction of discarded transcript bodies is introduced.

**Answer reconciliation.** Accepted-answer reconciliation also uses `withPatchTransaction`: `turn_end` awaits exclusion, stages the response over the current shared head, and atomically publishes it with a detached completed-run snapshot.

- Only acceptance installs the lifecycle/cache and native checkpoint; there is no second persistence call.
- Its response-owned cancellation is combined with Pi's operation signal. Stop, new runs, session/tree selection, shutdown and superseding answers cancel obsolete waits; an old completion cannot clear a newer pending response or alter its snapshot/UI.
- Failure or cancellation before acceptance leaves accepted memory and the unfinished specification intact.
- Later native boundary handlers and continuation inference observe accepted memory.

### Read-only refresh APIs

**`TemporalRuntime.refreshShared(signal?)`** awaits the same exclusion for read-only shared inspection.

- It captures one complete cohort after acquisition, keeping the selected private file basis or lazily constructing an empty private view when none is selected.
- It never initializes an absent store, publishes or advances a semantic revision.
- Parsing and provenance validation finish before cache installation; rejected or canceled reads keep the prior accepted view.

**`TemporalRuntime.refreshCurrentMemory(signal?)`** supplies an awaited read-only recovery view of current same-session authority.

- It shares current-memory validation with Start, but neither publishes nor accepts write authority: the returned policy is disabled and unfinished specifications are omitted.
- Current private values, step, revisions, bootstrap and provenance stay available beside independently validated shared streams; retention is constrained only in memory.
- Absence returns `undefined` without creation. Malformed evidence or cancellation (including during capture) leaves the prior cache unchanged.
- Lifecycle/patch publication still requires accepted authority or explicit Start.
- Native failed-Stop reload uses it and keeps the write fence.

### Branch attachment and restoration

**Off attachment.** Native `session_start` and `session_tree` first read only mode policy, through `session.findBranchPolicy` and `snapshot.readCheckpointMode`.

- Off attaches without constructing a temporal runtime, resolving semantic boundaries, reading memory or emitting recovery warnings; native mode/write-fence bookkeeping stays available.
- Deferred fork ownership is recorded in a child-owned `forkPending` native marker that survives extension recreation; accepted child initialization resets it.
- Explicit Passive restores the deferred selected boundary (or fenced read-only current authority), while explicit Active keeps the documented current-memory activation after attachment.
- Policy decoding is never proof that a historical boundary is valid.
- Automatic callbacks stay memory-inert in Off; installed-client acceptance gates are tracked separately in [BACKLOG](../BACKLOG.md).

**Memory-enabled restoration.** Memory-enabled native `session_start` and `session_tree`, and explicit acquisition after an Off attachment, await one extension-owned branch restoration.

1. **Synchronous prelude.** It revokes older selection work and pins the session id, file, header timestamp and CWD. It selects active-branch evidence through the recovery domain's pure `selectRetainedCheckpoint`: newer malformed envelopes are skipped, while revision pointers and every failure resolving the selected boundary fail closed.
2. **While waiting,** the mode is the selected inactive policy, and private reads/publication report the pending selection.
3. **Acceptance.** The selected boundary, the exact-source fork, a truly new auto-start origin (`withStartTransaction` with creation authority, rechecking branch evidence after waiting) or failed-Stop read-only recovery then use the awaited runtime API. Bootstrap and policy are derived after waiting and published in that single acceptance.
4. **Installation.** Only the current lifetime installs memory, checkpoint, continuation, tools and UI before yielding; a later native-write failure only warns.

**Interaction with mode choices:**

- A new selection revokes older work; shutdown drains current and superseded restoration operations.
- Passive keeps independently owned restoration, new-session initialization and fork copying, including attachment requested by a now-cancelled Active waiter. Off cancels those owned waits and keeps only native policy/source bookkeeping for later explicit acquisition.
- The pending publisher applies the latest inactive policy inside its single acceptance. Passive can then patch memory without an artificial error fence, while Off exposes no model access. Repeated selections are inert with respect to that acceptance.
- Start joins retained Passive acquisition. After Off, non-fork Active goes directly through one cancellable current-head Start transaction, keeping the deferred native selection and local Off policy until publication.
- A superseding Passive cancels that activation and acquires its original retained private boundary, not the current-memory candidate. Native Abort silently withdraws Active, without inventing a write fence or losing later acquisition choices.
- Accepted activation reconstructs any native continuation from its proven current memory. Exact-source fork acquisition keeps its independent restoration owner.
- Selection changes, shutdown and native operation cancellation still revoke obsolete work. Real validation/publication failures stay unavailable rather than becoming empty memory.
- Start joins pending restoration, owns initial attachment and fork retry without cancelling itself, and is inert when the result is already active. A cancelled Start withdraws its join without cancelling independently owned restoration or Stop persistence.
- Read-only recovery uses detached candidates and rechecks cancellation and physical identity before host installation. Passive attachment cannot overwrite a newer cache established by an intervening patch or inspection.

Six synchronous runtime methods remain supported for library consumers and local tests/benchmarks; production lifecycle wiring uses the awaited APIs. Their contracts and cancellation boundaries are documented in [library API compatibility](compatibility.md#state-flow-library-api-compatibility).

**What stays outside critical sections.** The advisory [continuation-candidate reader](#session-continuation) also awaits coherent capture, and current-head activation on an attached branch uses the awaited Start transaction. Raw precomputed replay keeps its selected-target guard, unlike current-head authored patch staging. Model inference, source acquisition and Git commands do not belong inside a canonical critical section; artifact freshness validation stays part of publication validation.

## Optional Git backup

Canonical files always own semantic persistence, current materialization and retained hot history. Installing Git beside the store does not change authority or enable cold semantic restoration. Retained-boundary restoration selects private session history from the current canonical lineage while global/CWD scopes stay live; expired boundaries fail closed.

**Artifact provenance across restore/fork.** Scope artifact provenance records only current evidence.

- Restore/fork drops session provenance for paths touched by any retained session patch after the selected boundary, including a change-away-and-back or a whole-artifacts-plane deletion. Path existence or equal final values cannot substitute for that causal check.
- Selected artifact semantics stay intact with unavailable evidence until a stable explicit read and compilation.
- Untouched paths, provenance-only refreshes of unchanged semantics, and live shared provenance stay usable.

### Local backup commit

After response reconciliation and Pi's retry/queue processing, `agent_before_settle` may commit the already-accepted State Flow-owned files once.

**Capture:**

- `backupCurrentStateFlowFiles(root, signal?, waitForLock = true)` returns `Promise<string | undefined>` and must be awaited.
- It awaits its own Git mutex and canonical exclusion to inventory the bounded root/CWD/session namespace and capture regular-file bytes, then releases canonical exclusion before every Git command or filter.
- `withFilePublicationLock` owns the shared acquisition/release mechanics: both mutexes keep exact ownership across awaits, refuse recursion, and preserve replacement owners or combined action/cleanup failures.
- The backup mutex spans capture and Git completion; the branch/head is rechecked after waiting.
- It never descends into artifact sources, `.git` or unrelated directory trees.
- A private temporary worktree/index stages the captured snapshot with Git ignore/filter policy preserved. Concurrent writers may advance canonical files without changing that snapshot.

**Cancellation and the settlement boundary:**

- Settlement combines an available Pi operation signal with the extension-owned backup lifetime and awaits the local backup.
- Off or shutdown revoke that lifetime, cancel pending capture and suppress late reporting; only release of already-owned locks/resources may continue. An Off attachment revokes the previous memory-enabled background lifetime too. Shutdown drains its own attempts before waiting for remote pushes.
- When Pi supplies no operation signal at `agent_before_settle`, native Abort cannot cancel a wait there. On such a host the adapter passes `waitForLock = false`: uncontended work proceeds, while live or initializing ownership raises `PublicationBusyError` and produces an explicit backup-deferred notice.
- Invalid or interrupted evidence stays an error, never a successful or partial capture.
- No commit or push follows deferral; a later accepted turn may retry.

This is a narrow optional-backup admission policy, not semantic-write conflict repair or an operator configuration. The operator accepts this best-effort deferral independently of power-loss durability and keeps `agent_before_settle` as the backup boundary. Moving backup to `turn_end`, or extending the SDK solely for settlement waiting, is not planned; backup is not a stronger canonical persistence guarantee. See the [SDK boundary evidence](compatibility.md#settlement-cancellation).

**The caller's index:**

- Only exact backed-up owned paths are synchronized in the caller's index, preserving unrelated staged additions, modifications, deletions, index-only content and worktree edits.
- HEAD-owned paths stay candidates when their deletion is already staged.
- Unchanged trees and unowned-only initial backups are skipped. Failed index synchronization rolls back only the backup ref, never canonical files.
- Failure cannot suppress the answer or trigger another inference.
- Notification-only `agent_settled` performs no backup writes.

### Remote push

After a successful backup attempt, State Flow resolves only the attached branch's explicitly configured remote and destination ref, snapshots the exact current commit, and starts one non-interactive, non-force push outside all backup and canonical locks. Settlement does not await network completion.

- `pushCurrentStateFlowBackup(root, signal?)` and `startStateFlowBackupPush(root, onFailure, onSuccess?, signal?)` accept an optional caller-owned cancellation signal. Overlap refusal does not attach the rejected caller's signal to the existing push.
- The adapter passes its captured backup-lifetime signal, not the completed agent-operation signal.
- Off/shutdown terminate only their admitted process group, keep the in-flight slot until the process closes, and suppress canceled success/failure callbacks.
- Already accepted commits stay intact; cancellation is not remote rollback.
- Failure is diagnostic-only. No queue is persisted, and the next accepted settled turn attempts the latest current backup again.
- A repository without an explicitly configured branch remote stays local-only.

**Canonical authority.** There are no durable push queues, publication workers, leases, retry generations, queue filesystem state or publication-policy metadata. `TemporalRuntime` provides neither Git revision restoration nor immutable-revision fork APIs. All initialization, passive loading, model patches, runtime-only persistence, retained-boundary restoration and retained-boundary forks use canonical files only.

Unsupported checkpoint envelopes, combined session metadata, `state.json`, hashed layouts and semantic Pi checkpoints are unsupported and stay untouched. Missing documented planes, including `intents` and `lazy`, in canonical semantic objects are supported without migration.

## Artifact routing

**Observation.** State Flow never discovers source directories. Before enabled inference, it inspects only exact source paths already registered as artifacts in global, CWD or session state.

- Observation uses regular non-symlink file metadata `{size, mtimeNs}`, without reading bodies. Unregistered files are never observed.
- Proven absence removes the artifact from each owning scope. Unavailable, relative, directory or symlink evidence is non-destructive.

A model-visible artifact entry requires only a non-empty description:

```json
{
  "description": "routing summary",
  "compilation": {}
}
```

**Runtime-owned evidence.** Compilation evidence is kept per scope in `meta.json`. Current ordinary artifacts use `sourceFingerprint: {size, mtimeNs}` plus `compilerRevision`; retained `sourceHash`/`compiledAt` are transitional compatibility evidence.

- At artifact-entry level, every model scope patch rejects authored `hash`, `compiler`, `compiled_at`, `sourceHash`, `sourceFingerprint`, `compilerRevision`, `compiledAt`, `source_hash_verified` and `hint` fields, including field-deletion markers, even without a preceding read.
- Retained embedded evidence stays readable, but its embedded `hash`/`compiler`/`compiled_at` fields are omitted from model projection. Ordinary semantic edits and whole-artifact deletion stay valid.
- Compiler output may add other finite non-null JSON metadata. Known optional semantic fields include `kind`, `tags` and `compilation`. Tags are unique trimmed non-empty strings that support deterministic candidate filtering, but never authorize reading.
- The `contract.compiled_skills` location is rejected. Skill compilations belong only in source-addressed artifacts, with no fabricated source hashes.

**Deciding whether to compile.** The public `classifyArtifactCompilationNeed` owns acquisition/rehydration and ordinary-artifact Pi decisions.

- An observed fingerprint needs matching valid retained fingerprint evidence. Missing or malformed fingerprints, malformed compiler evidence or a changed compiler request compilation, without removing semantics.
- A changed size or signed nanosecond mtime (including pre-epoch dates) keeps the value and adds a runtime-only model `hint`.
- Fingerprint-only decisions ignore unused retained hashes; explicit current-hash observations and the separate Skill hash protocol are still checked.
- Rehydration read plans carry detached fingerprints and optional hashes, never invented identities.

**Routing compilation to its owner:**

- Invalidation notices identify the selected `global`, `cwd` or `session` owner. Guidance and missing-output errors direct compilation to that exact scope/path, without relocating the entry or creating a global copy.
- Successful exact reads require stable fingerprints before and after acquisition and at publication, then publish compiler output and provenance to that owner under scope causal-basis CAS.
- Generic maintenance computes no content hash.
- Effective Skill entries mask lower ordinary entries and keep their separate hash protocol.

**Compilation is routing, not a substitute for source text.** Full source is read only for a concrete unresolved gap, an exact source/edit operation, fingerprint invalidation, a contradiction/failure or an explicit request. The rehydration planner supports new-bootstrap, resume-bootstrap and later-step phases, without hidden directory traversal.

### Skill acquisition

Skill acquisition applies only to exact registered Pi Skills.

- **Ownership.** State Flow resolves identity and ownership through the public `getCommands()` inventory's `sourceInfo.scope`, not file-path conventions: Pi `user`, `project` and `temporary` source scopes map to State Flow `global`, `cwd` and `session`.
- **When nothing is needed.** A successful read with a matching current source hash needs no new compilation. Otherwise the tool result names the exact optional target.
- **Attempted output.** Durable output at the reported scope and path requires a non-empty description, `kind: "skill"` and a non-empty compilation describing applicability, constraints and failure conditions. An omitted output leaves the read volatile and blocks neither unrelated patches nor ordinary completion.
- **Replacement.** The accepted compilation replaces the complete prior Skill card and provenance, storing runtime-owned `sourceHash` and `skill-artifact-v1` `compilerRevision`; obsolete evidence cannot survive a refresh. Source bodies do not persist in state.
- **What provenance proves.** Matching provenance proves source-version consistency, not semantic fidelity, truth or higher instruction authority.

## Operational guidance and memory curation

The packaged Skills deliberately separate two responsibilities:

- `state-flow-guide` is the on-demand operational reference for concrete read, patch, inheritance, acquisition, completion and recovery questions. It does not start memory audits or unsolicited cleanup.
- `state-flow-memory` performs one explicitly requested bounded curation over stale knowledge, commitments, continuation, ownership and external handoffs. Phase completion does not activate an audit.

Curation may persist reusable guidance from a registered Skill at its provenance-derived scope.

**Terminal state is a decision-relevant handoff, not a progress transcript:**

- operational knowledge → source-addressed artifacts;
- confirmed constraints/decisions and rejected approaches → contract;
- observations/failures/uncertainties and exact continuation → working;
- only chosen active commitments → intents.

Distinguish user requirements from assistant conclusions and hypotheses, and keep consequential negative evidence and reconsideration conditions. Do not:

- silently overwrite established constraints when evidence conflicts;
- treat working observations as live external facts;
- infer success or absence of external effects from restored memory. After an interruption, inspect the relevant effects before repeating.

These are model stewardship duties, not deterministic semantic gates.

**Moves:**

- Within one store, a proven scope move inspects both owners, resolves conflicts, and commits destination and source changes through one atomic multi-scope patch, followed by ownership/overlay verification.
- Existing Skill artifacts are not silently moved between scopes. A later registered read identifies the current owner, and explicit curation may move proven reusable content and remove the old owner atomically.
- External transfers use the destination's native interface and receipts; accepted-copy verification precedes source deletion in a later State Flow patch. State Flow defines no promotion registry, status schema, record type or dedicated promotion tool; destination uncertainty simply leaves the source intact.

## Session continuation

The package exposes read-only host contracts that:

- read only native JSONL headers, never transcript bodies;
- Await a coherent canonical runtime/scope cohort without publication;
- rank exact profile, CWD, Git common-directory, worktree, branch and transport identity;
- fail closed for stopped, malformed, unavailable or ambiguous candidates;
- preserve explicit new/resume and native picker precedence;
- project new-bootstrap, resume-bootstrap and later-step rehydration phases.

**Session identity check.** Session checkpoint/tail identities must agree with that session's retained runtime lineage before restore/fork accepts a fresh origin.

- This check permits sparse session changes and inherited pre-origin streams; it does not require a session patch at a shared-only transition.
- Continuation inspection applies the same session check while validating current global/CWD streams independently. Shared writers do not belong to another session's historical clock.
- Neither path repairs a contradictory session cohort or manufactures empty session authority.

**Inspection API.** `inspectStateFlowContinuationProvenance(header, repositoryRoot, signal?)` and `buildContinuationCandidates(headers, inspect, signal?)` return Promises and must be awaited.

- Inspection captures runtime configuration, lineage and all three scope streams under one store exclusion.
- It never creates a missing store, repairs evidence, advances revisions or installs a runtime cache.
- Orphaned private files are incomplete evidence, not an ordinary session with no State Flow runtime.
- Malformed or unavailable evidence returns ineligible provenance with its diagnostic cause; cancellation rejects instead of fabricating an ineligible or new-session decision.

**Candidate building and startup resolution:**

- Candidate building accepts synchronous or asynchronous host inspectors, passes the optional signal through, snapshots the whole native-header list before waiting and detaches returned State Flow eligibility.
- Host metadata cannot override the native file, UUID, CWD or activity identity.
- `resolveContinuationStartup(context, intent, recommend, signal?)` preserves explicit host intent and passes the signal to the default-launch recommender. Both async boundaries reject obsolete results after cancellation, and hosts own that cancellation lifetime.
- These APIs only advise: current-cohort eligibility neither restores a selected historical boundary nor overrides native branch/Stop policy.

**Why there is no auto-resume.** The [tested Pi SDK baseline](compatibility.md) chooses or creates `SessionManager` before package resources and extensions load, so native default auto-resume cannot be installed safely by this extension alone. The remaining host integration requires an upstream pre-session resolver hook, or an SDK/launcher that invokes the advisory resolver before constructing the session.

## Model tools and embedding

### Model tools

**`patch_state` grammar.** It accepts one or more fixed `global`, `cwd` and `session` semantic patches.

- Supplied scopes contain object-valued `artifacts`, `contract`, `working` and `intents`, plus object-valued `lazy` whose nested values are ordinary JSON.
- Recursive object merge updates fields, arrays/primitives replace, and nested object-key `null` deletes, including inside newly created objects. Deletion-only patches through absent ancestors create no empty parents. Accepted supplied scopes recursively omit empty object fields and empty planes: deleting the last child removes its empty ancestors, and explicit `{}` is not a retained value. Nonempty omitted fields persist; an object patch that turns a scalar/array into an empty object removes that field. Cleanup is scope-local and can reveal inherited values; it stops at the scope root and never removes array slots.
- Against an existing array, a nonempty object containing only canonical `"[N]"` keys recursively patches those existing elements (zero-based). Out-of-bounds indices and indexed `null` deletions are rejected atomically; adding/removing elements requires replacing the whole array. Against objects, those keys remain literal object keys.
- Missing authored object-key deletions succeed with nonfatal hints in the acknowledgement, for both unchanged and mixed patches. Each hint gives the owner-scoped target and first unavailable component as escaped JSON Pointers; a non-object ancestor is also unavailable. These hints are presentation-only: no state fields, revisions, history records, automatic path correction or cascade warnings.
- Rejected: materialized null within documented semantic planes, empty supplied scopes, unknown top-level fields, model-authored `response`, and finalization or `{scope, patch}` / `unchanged` grammars. The semantic null rule does not apply to runtime envelopes such as an origin's null parent.
- Correct repeated results succeed as `State already current.` without another semantic revision or history record; avoid gratuitous acknowledgment patches.
- Global/CWD overlap follows successful acceptance order, and unmentioned current fields survive. Session ownership is not a shared-memory merge.

```json
{"session":{"intents":{"next":"Verify the corrected behavior"}}}
```

**Intents and ownership.** `intents` is the hot plane for active commitments, not requirements, observations, alternatives or completed plans. Removing an intent does not remove its consequences; it removes only the state it owns. Intent ownership is the one reference with runtime meaning:

- When a patch deletes an intent key, structured `{"$ref"}` targets found anywhere inside the deleted value, naming an existing object key under `working` or `lazy` of the intent's own scope, are deleted after the authored operations, in the same atomic cohort and revision.
- A target survives while a remaining intent in that scope references it, an ancestor or a descendant, so one patch can supersede an intent by deleting it and re-referencing the same targets.
- Writes to an owned target in the deleting patch are discarded with it. Editing an intent to drop a reference leaves its target unowned.
- Cross-scope, plane-root, array-element, unscoped, `effective`, historical and non-`working`/`lazy` targets, missing targets and textual `$path` mentions are skipped silently. Ownership never rejects, warns about or delays a patch.
- The `ownership` domain computes the cascade by reading only that scope's `intents` plane. The accepted record stores the cascade as explicit deletions, so replay never re-derives it.
- Deleted targets are not archived beyond ordinary retained history.

Full details: [intent ownership](lazy-state.md#intent-ownership).

**Reference forms.** Semantic-state references use either the optional structured `{"$ref":"cwd.lazy.plan"}` convention, or `$` immediately followed by one valid `read_state` path inside ordinary text, for example `$effective.lazy.memory[7]`. The text prefix distinguishes references from incidental path-like prose and leaves a deterministic seam for possible future parsing. Resource paths, document locators, URIs, Skill identities and agent identities keep their native syntax.

- State Flow stores all forms as ordinary JSON and, apart from intent ownership, does not parse or validate targets.
- The agent resolves a relevant locator explicitly, through `read_state` or the appropriate external tool. Presence alone creates no authority, existence proof, dependency, hydration, execution or completion semantics.

**Reactive repair.** The agent never scans or resolves references merely to test them. Only after one requested value path is missing does the query domain perform one bounded reverse lookup over current model-patchable semantic planes for exact structured `$ref` or `$path` matches. When matches exist, `read_state` returns the explicit diagnostic sentinel `{value:null, hint:[{type:"dangling-reference", message, paths}]}`:

- `hint` is a top-level sibling, not state data. Its message describes unavailability conditionally.
- `paths` contains at most three runtime-verified current reference-owner addresses, not verified new locations of the requested data.
- The hint contains no lazy bodies and does not prove prior existence, retention or relocation. The null sentinel is never returned alone for this case.
- Keys, patch and multi-path reads keep all-or-error semantics, while no durable match keeps the ordinary missing-path error.
- A match establishes durable semantic provenance, not staleness; no match does not prove invention. The agent may inspect ownership and patch a proven stale source when useful to the current task, without discarding surrounding meaning or resurrecting its target.

**History is task-driven.** Missing paths or hints alone do not require historical search. The agent may independently choose targeted historical reading when a previous value is useful to the current task; no separate user permission is required. Historical values are evidence, not automatically current state or a reason to restore deleted memory. Runtime never scans history for reference owners, triggers repair inference or hydrates lazy bodies. Effective absence does not establish ownership, and unavailable history, external inaccessibility or a transient read failure does not prove a broken reference.

**`read_state` addressing.** It accepts one unified path.

- `effective == effective[0]` is the current effective materialization; `global == global[0]` (and the CWD/session equivalents) selects that scope at the same composed causal boundary.
- `global.patches == global.patches[0]` reads the latest accepted retained global patch; higher patch indices walk only that scope's retained accepted patches.
- Indices are bounded by the configured `historyLimit`; unavailable pre-origin or pre-tail history is an error.
- Resolver aliases are not literal JSON containers.
- Object keys in paths must match `[A-Za-z_$][A-Za-z0-9_$-]*`. Both tool descriptions and the Skills ask the model to name keys in ASCII (values may use any language), and a non-ASCII key in a read path fails with that grammar in the error.
- Reads stay cached and create no Git query, publication, checkpoint append or semantic step.

```json
{"path":"cwd[1].intents"}
```

```json
{"path":"global.patches[0]"}
```

Unscoped semantic paths such as `intents.next` alias the current effective overlay. `value`, `keys` and `patch` projections plus ordered `paths` batches stay all-or-error.

**Availability and responsibilities:**

- Both tools are exposed in Active/Passive and withdrawn in Off, subject to host restrictions; mode toggles preserve unrelated active tools.
- Passive reads never initialize storage, but an explicit passive patch may initialize absent canonical storage without starting an episode.
- The patch barrier also blocks reader siblings.
- These tools impose no project schemas or state-size caps; semantic usefulness, scope choice and compression stay model responsibilities.
- Ordinary handoffs reconcile touched state. Dedicated cleanup and scope review require an explicit user request, including at feature/release/project boundaries.
- Global keeps established cross-project/user/environment knowledge, CWD owns reusable project truth, and session owns branch/run continuation.
- Intra-store moves use targeted owner reads and one atomic multi-scope patch followed by verification; external moves require verified destination acceptance before source deletion.

### Embedding

**Factory options.** The default extension factory accepts `StateFlowExtensionOptions`:

- `agentDir` selects the profile.
- `repositoryRoot` overrides the configured state store.
- Optional `mode` overrides the new-session default without changing retained session policy.
- `onRuntime` receives a cached `read(offset?, scope?)` accessor; an omitted scope means effective state. Use it only after runtime initialization/restoration.

The pure `readTemporalState(view, offset, scope?)` accessor is exported separately. SDK hosts with an explicit tool allowlist must include both `patch_state` and `read_state` when they want model access.

**Shutdown.** Honor Pi's `session_shutdown` lifecycle before disposing an embedded session.

- On the [tested Pi SDK baseline](compatibility.md), `AgentSession.reload()` emits and awaits shutdown, but bare `AgentSession.dispose()` only invalidates/disconnects the session.
- `AgentSessionRuntime` owns native new/resume/fork replacement, and its asynchronous `dispose()` delivers quit shutdown; rebind each newly created session's extensions.
- An SDK host disposing a standalone `AgentSession` instead should first `await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`. Ordinary Pi lifecycle owners already deliver the event.
- Without shutdown, the adapter's queued Start, compaction-stop flags and optional presentation disposal are not notified.

**Forks.** Native replacement teardown and State Flow adoption are separate responsibilities. On a native fork start, the adapter verifies the direct parent header and the selected retained source boundary, then copies only the session stream/provenance into a distinct child owner over the current live shared scopes.

- The child has a fresh origin and its own checkpoint, never a UUID alias or a historical shared-state rewind.
- A child-owned native reset marker fences inherited passive Stop projection across reload.
- Parent-owned checkpoints selected later cannot fall through to an ordinary-disabled marker and reset child storage.

See the [fork contract](fork-contract.md) and [operating limits](usage.md#fork-support-and-limits).

**Configuration.** Agent configuration is read once per extension load; session runtime configuration stays branch-selected. See [configuration](usage.md#configuration) for settings and path precedence. Memory ownership while enabled and global availability are invariants, not configuration switches.

## Observability

### Telegram port

- The inspection-capable Telegram port accepts synchronous or Promise-returning `select(mode)` results with optional revocation signals. `StateFlowTelegramPort` stays synchronous and remains supported.
- Controls start callback acknowledgement alongside execution, rather than waiting for a network round trip before local Stop. A callback is acknowledged before waiting.
- Final feedback follows completion, uses the current menu, and escapes late failures without answering the callback twice or answering an expired query again.
- Revoked receipts, newer callback navigation and disposal suppress stale view writes; they never roll back canonical acceptance.
- Obsolete start/stop callback keyboards may refresh the current view but never silently select a mode.
- Registration is fail-open, and disposal belongs to session shutdown.

### Status projection

Status is a projection of the selected runtime and semantic view, not a second store.

- Compact terminal status uses accent `state-flow` with dim `active` or `passive`, and is hidden in Off.
- Telegram main-menu status uses `State Flow: active`, `State Flow: passive` or `State Flow: off`.
- `/state-flow-status` keeps the `g#c#s#` vector beside concise diagnostics and blank-line-separated top-level semantic JSON.
- Mode is read directly from the session's selected enum, never derived from a pending patch or separate passive flags.
- Requested Global, CWD and Session Rich snapshots show their independent `#revision`, while Effective shows the vector. Global/CWD Rich views omit the empty structural response placeholder; Session and Effective expose the Session-owned response.
- Missing evidence stays unavailable instead of appearing empty.

**Telegram menu layout.** The optional Telegram leaf adapter shows, in order:

1. the current mode as a monospace value in the submenu heading;
2. matching Mode and Inspect memory headings (a long-dash-separated description ending in a colon), each separated by a blank line from its settings-style monospaced-key list;
3. one radio row `Off | Passive | Active`, where selected Off uses 🟡, Passive 🟣 or Active 🟢, and inactive choices use ⚫️;
4. four direct scope-inspection buttons. Inspection stays available in all three modes.

### Inspection reads

- Inspection may refresh live Global/CWD streams in memory so foreign accepted revisions become visible, but never publishes or increments a revision.
- Memory-enabled inspection keeps its accepted-private/shared-refresh and failed-Passive cache rules.
- Off inspection uses a fresh disposable `TemporalRuntime`. Global/CWD use coherent shared reads; Session/Effective use `refreshCurrentMemory` and reject absent, incomplete or malformed same-session private evidence, rather than manufacturing an empty layer/revision or borrowing foreign private data.
- No reader installs the extension runtime/cache, changes native policy or canonical bytes, clears a carried write fence, acquires an unaccepted fork parent or replaces the selected historical target.
- Expired selected history may coexist with inspectable current stored memory. A later Passive still restores the selected past fail-closed, while Active validates current memory.
- The awaited `StateFlowTelegramInspectionPort` returns a `StateFlowTelegramInspection` containing state and matching revisions, plus an optional revocation signal. A result checks its revocation lifetime and physical owner immediately before presentation.
- Stop, selection changes and shutdown cancel obsolete reads without altering newer memory or clearing write fences.

Local diagnostics stay outside semantic state and cannot change accepted state. Operator-facing fields and privacy boundaries are in [usage](usage.md#status-and-controls).

## Validation boundaries

**What structural validation can and cannot prove.** It proves JSON shape, exact identity, causal lineage, compilation evidence, CAS and publication invariants. A valid state, receipt, source hash or compiler revision cannot prove semantic importance, truth, sufficient compilation, correct scope, useful curation or historical deletion. Those remain model-judgment concerns, evaluated separately from deterministic transport checks.

**Where the evidence and plans live:**

- The deterministic continuity and temporal evidence map is in [temporal-acceptance.md](temporal-acceptance.md).
- Release-scoped open work is in [BACKLOG.md](../BACKLOG.md), and shipped outcomes belong in [CHANGELOG.md](../CHANGELOG.md).

**Release:**

- The exact-tag [release workflow](../.github/workflows/release.yml) owns npm Trusted Publisher publication with provenance, and creates a GitHub Release only after public-package verification. Never substitute a long-lived npm token.
- Keep `dist/` tracked and rebuild it from final sources and package metadata. Git tracking, source/build parity and npm `files` inventory are separate proofs.

**Test-writing rules:**

- Native scripted-provider tests need a completion assertion outside the callback, because Pi can turn an in-provider assertion failure into an assistant error.
- Await startup/tree fixture handlers.
- In contention tests, prove withdrawal while exclusion is still held, before releasing storage and joining the replacement selection.
