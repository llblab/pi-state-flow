# State Flow architecture

## Purpose

State Flow is a Pi extension that materializes compact, scoped semantic state across agent runs while preserving Pi's native session trace and tool loop. It is inspired by SKILL.state but uses its own temporal model, storage plane, artifact compiler and publication lifecycle.

The extension owns durable memory while enabled. The native bridge admits all seven nonempty captured selections through one selected runtime; missing configured scopes retains all three. Scope participation is neither an authority ranking nor an acquisition grant. Native policy DATA, accepted storage, model requests and independently owned controls retain distinct proof boundaries. Existing mode commands bind optional scope tokens to these same owners; mode-only Telegram actions preserve the captured choice. See [public command boundary](scope-selection-contract.md#public-mode-command-scope-overrides) and [retained native integration](scope-selection-contract.md#retained-native-seven-selection-integration).

## Composition

`index.ts` is the minimal public export boundary. `lib/extension.ts` is the Pi lifecycle composition root: it wires configuration and domain capabilities into commands, tools, event subscriptions and handlers, and delegates imperative mechanics to their owning modules. Each independent module under `lib/` owns one concern and is mirrored by tests:

- `state`, `json`: semantic shape, validation, recursive overlay and deletion.
- `config`: read-only load-time repository defaults, including immutable configured scope data. [Native capture](scope-selection-contract.md#configured-scope-defaults-and-native-capture) freezes defaults once into branch policy, without itself granting memory authority.
- `selection`: pure immutable nonempty owner selections and command-token parsing. Value capture grants no mode, lifecycle authority, I/O or storage participation by itself; see the [selection boundary](scope-selection-contract.md#internal-value-boundary-and-lifecycle-encoding-direction).
- `temporal`, `history`: causal boundaries, checkpoint/tail folding and hot history. Internal [selected temporal algebra](scope-selection-contract.md#selected-temporal-value-algebra) retains only participating streams and metadata-only excluded-step witnesses; algebra alone grants no native storage/runtime admission.
- `migration`: pure v3/v4 codec and descriptor-upgrade preflight. It validates the complete owner triple, CWD identity, replay and retired-root reservations before selecting semantic fields, returning detached target data and exact-byte evidence. It grants no lifecycle or publication authority; `storage` owns backup and guarded publication. See [format admission](compatibility.md#canonical-scope-format-admission).
- `durable`, `storage`, `git`: canonical codecs and identity, exact file-cohort CAS/exclusion/guarded rollback, and optional settled-turn backup (`SettledTurnBackup`). Selected admission separates semantic bodies from required private/layout evidence; origin/current/fork publication remains explicitly authorized. The [scope contract](scope-selection-contract.md#functional-acceptance-boundary) owns selected/private proof and the admission matrix; the storage and backup sections below own transaction/durability limits.
- `snapshot`, `session`, `runtime`, `recovery`, `episode`: branch/run lifecycle, captured v2 policy, revocable native request receipts and accepted/read-only runtime views. Policy candidates and observation grant no private acquisition or publication. The same selection lifetime binds requests, context, tools and answers across all seven choices; current-memory attachment, private deferral and legacy dependencies follow the [scope contract](scope-selection-contract.md).
- `transition`, `ownership`, `context`: inference barriers, turn resolution, intent-ownership cascades, passive projection, and response reconciliation. Internal [selected semantic staging/commit](scope-selection-contract.md#selected-semantic-staging-and-commit) reuses the same engine without disabled owners; native response/policy composition uses the same seven-selection bridge. Session-excluded completion finalizes lifecycle without a semantic response transition or hidden private owner.
- `semantic-module`, `planes`: detached internal context/producer evaluation and the six static built-in bindings; see the [internal contract](semantic-layers.md#internal-semantic-modules). They do not publish or acquire memory.
- `module-registry`: revocable native-host registration/catalog lifetimes for the published `./modules` entry. The [public contract](public-module-contract.md) owns trusted callback admission, retained external identities and runtime currentness; a catalog is not publication authority.
- `query`: current/historical value projection and shared semantic-locator syntax; parsing alone resolves no target and confers no authority.
- `model-interface`: Detached translation between the [model interface](#model-tools) and canonical patches, locators and references. Owns typed presentation, not native, source or storage authority.
- `compaction`: completed-history compaction planning and per-request marker state (`StateFlowCompactionRequests`).
- `operation`: `OwnedOperationSlot`, the single-owner cancellation slot used by Start, inactive-mode persistence, branch restoration, inference preparation and response reconciliation; identity-guarded release keeps late completions from clearing newer work. `RenewableLifetime` owns the shared-inspection and memory-tool cancellation lifetimes and underpins internal selected policy requests. Slot cancellation/lifetime renewal expose replacement ownership before synchronous abort dispatch so reentrant listeners cannot erase newer work.
- `artifact`, `acquisition`, `skills`, `rehydration`: source routing and compilation; `ArtifactAcquisitionState` owns the selected branch's invalidation plan, model hints and correlated read candidates.
- `memory`: memory-bearing scope diagnostics; explicit selection returns only present selected flags while the legacy no-selection signature retains all-three behavior.
- `continuation`: native-header discovery, runtime-provenance inspection, deterministic recommendation, and host startup precedence.
- `protocol`, `logging`: [Trusted prompt and tool presentation](#protocol-section-and-continuations) and bounded diagnostic persistence.
- `status`, `telegram`, `extension`: observational operator projection, optional fail-open Telegram presentation and native lifecycle composition. Status distinguishes wanted policy from available owners/revisions without fabricated values or acquisition; Telegram mode controls preserve scopes and inspection follows wanted targets. [Usage](usage.md#status-and-controls) owns operator behavior; the [scope acceptance map](scope-selection-contract.md#functional-acceptance-boundary) records proof limits.

Test placement is checked in both directions by `tests/invariants.test.ts`: LIB modules have same-named mirrors, and every suite has an exact production owner or a reasoned cross-domain exception. The benchmark suites mirror `benchmarks/benchmark.ts` and `benchmarks/benchmark-session.ts` rather than being exceptions. The four exception reasons live in the invariant itself. Shared fixture modules may set up, read and assert, but cannot be hidden suites: the source-hygiene check erases TypeScript types before checking literal test-runner/suite dependencies and direct registration forms. This is not an arbitrary-code sandbox or a proof of semantic case ownership; independent organization review remains necessary.

## Semantic state

Runtime views select these built-in semantic planes when present, plus metadata v4-declared external object roots under the [public contract](public-module-contract.md). Stored scope objects may omit any plane; unrelated undeclared roots are not supported semantic fields:

```json
{
  "intents": {},
  "strategy": {},
  "tactics": {},
  "artifacts": {},
  "response": "",
  "lazy": {}
}
```

- `intents`, `strategy`, and `tactics` are the core [handoff planes](semantic-layers.md#handoff). An intent may own same-scope object keys through [structured references](lazy-state.md#intent-ownership).
- `artifacts` maps exact source paths to compiled routing metadata.
- `response` is owned only by the session scope and stores the exact latest accepted assistant answer, including the empty string. Global/CWD do not receive newly accepted answers, and stored scopes may omit response entirely. An explicit nonempty Session answer overrides inherited values; an empty or absent response contributes nothing to Active projection. Automatic Passive context omits the response plane, including frozen Stop handoffs and state-update receipts. Canonical storage, explicit reads and native answer text are unchanged.
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

- Checkpoint/tail codecs apply [format admission](compatibility.md#canonical-scope-format-admission) before interpreting fields. The [public module contract](public-module-contract.md) owns metadata v4 descriptors and opaque retention through missing definitions, unrelated writes, folding and forks. Retention is independent of callback activation.
- Retained record identities and positions survive even when filtering leaves an empty patch.
- `readTemporalView` selects present known fields at the requested boundary, then overlays scopes without inventing fields.
- Empty and absent responses mean the same for Active projection; clearing a nonempty response projects as a deletion. Passive omits the plane regardless of its value.
- Value reads return `null` for proven absence at eligible locators; see the [model-tool contract](#model-tools) for unavailable views and projection-specific results.
- `readTemporalState` and the embedding callback keep default-bearing compatibility views for internal registry consumers. Those defaults never become stored overrides or model context.
- Passive reads never initialize. Start does not fill missing planes or create revisions for normalization; authorized acceptance can initialize a wholly absent selected shared triple.

**Staging and replay.** Authored staging uses raw scope presence and derives runtime-normalized replay from the writes actually accepted, including complete artifact replacement; replay must reproduce accepted state exactly. Each supplied scope (and Session on response reconciliation) recursively omits empty object fields, including explicit `{}` and empty planes, before intent ownership and after cascades/compilation. The scope root remains `{}`; array slots and empty arrays remain, while object fields inside array elements are pruned. Untouched scopes are not normalized. Existing empty branches in a supplied scope become explicit accepted deletions and may advance its revision once; clean repeats create none. Model projection hides legacy empty object fields without changing stored state, exact current/historical reads or replay.

**Validation.** Present documented fields keep usable object/string types, valid artifact entries and the no-stored-null rule; ignored fields may contain arbitrary JSON. Malformed JSON and invalid storage/history authority remain errors.

**Ownership of knowledge.** State Flow is the memory owner while enabled:

- cross-project/user/environment knowledge belongs in global state;
- project-only knowledge belongs in CWD;
- branch/run continuation belongs in session.

Global availability is not a feature switch, and it does not authorize secrets, raw history, transient progress, speculative clutter or unsupported assertions. Explicitly uncertain hypotheses stay eligible only when they can affect an open decision.

## Temporal model

Participating owners share one composed causal lineage:

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
- Separately, each materially changed owner advances its persisted semantic revision once. Global and CWD counters are shared across their canonical writers, Session stays private, and Effective uses the current materialized-owner revision vector in canonical order (for example, `g7c4s2` when all three are present).
- The top-level `state` segment is rejected. Pre-origin history is unavailable rather than empty.
- Once enough accepted transitions are proven, offsets zero through the configured `historyLimit` stay addressable at their shared causal boundaries.

**Responses in history.** A changed accepted response is runtime-owned, session-only semantic state and advances history. An accepted empty answer finalizes normally: it clears a previous nonempty response, but creates no transition merely to replace an absent response with `""`. Ordinary completion needs no `state_flow_patch` call when durable semantic state is already correct.

## Pi lifecycle

### `state_flow_patch` acceptance

`state_flow_read` and `state_flow_patch` are the canonical advertised names. Explicit legacy `read_state`/`patch_state` dispatch uses the same operations with exact original native-name admission; selection/schema refresh, Off activation and the Active mutation barrier cover both spellings. Hidden legacy declarations use the SDK loadout membrane, not history rewriting or a second publication path. See [tool-name compatibility](compatibility.md#tool-name-compatibility) for host allowlists and the bounded evidence.

`state_flow_patch` is the sole mutation tool:

1. It acquires store exclusion before selecting current Global/CWD.
2. Preserving private Session ownership, it applies intents only, clears deleted intents' eligible same-scope strategy/tactics/lazy object-key targets protected by no final remaining/new intent (including ancestor/descendant references), then applies remaining authored planes before existing compilation/normalization. These phases ignore JSON insertion order; rewriting a cleared target creates fresh knowledge without old fields. Unowned entries remain legal.
3. It validates and publishes one atomic cohort. Replay, history and revisions use that actual basis; correct repeats create no semantic transition.
4. It then acts as an inference barrier: Pi executes no sibling tools from the same assistant response, and the next inference sees the rematerialized current effective state.

### Model context presentation

The context domain compares canonical data first and translates only known output fields using the admitted request's captured owner choice. This is presentation, not an authoring or acquisition grant.

- Active/Passive heads, projection-bound updates and new Stop/reload/bootstrap handoffs follow [single-owner reference translation](lazy-state.md#semantic-references). The effective overlay is not flattened again.
- The lazy catalog points to `lazy` for one wanted owner and `effective.lazy` for several; neither exposes lazy bodies. Active recent records keep their accepted `id` and branch-local `at`, omit empty or lazy-only records, and use `{id,at,patch}` for one wanted owner or explicit `transitions` for several. Passive does not gain Active recent history.
- Skill acquisition hints use `artifacts["exact source key"]` for one owner and `owner.artifacts["exact source key"]` for several, quoting the exact opaque path as a JSON string. This is compilation-target syntax, not a read locator. Compiler errors and operator details keep canonical provenance; a foreign owner named in an error is not a patch wrapper or permission to compile there.

### `state_updates` receipts

A successful native tool result may include a `state_updates` block, separate from the compact acknowledgement used by interactive rendering. The context domain owns this projection, not storage or the lifecycle composition root.

**Shape.** `effective` entries contain a `path` array of exact object keys/array indices, plus either a replacing `value` or `deleted: true`.

- These are accepted effective values, not authored merge operations: a scope-local deletion can reveal a lower value, and higher scopes can mask an accepted lower-scope write.
- Arrays whose length changed are replaced as a unit; equal-length changes may target indices.
- Indexed-array patch selectors become numeric update paths only against a communicated in-bounds array basis. Object keys with the same spelling are literal.
- Artifact cards use the normal metadata filter, and touched cards replace their whole projected entry.
- Lazy bodies never enter this block; a changed bounded `lazy_navigation` may accompany it.
- An optional `cascaded` array lists paths cleared in the intermediate ownership phase, relative for one wanted owner and owner-scoped for several, even if remaining authored planes recreate them, including nested lazy targets that do not change the top-level navigation. It contains paths only, never values, and is absent when no target cascaded.
- Unrelated unchanged branches are omitted. A result with nothing left to reconcile and no cascade has only the acknowledgement.

**What is always included.** Entries conservatively cover changed scope fallbacks, masked or overlapping multi-scope touches, and projected changes since the last communicated view, including shared refreshes before or during the transaction. `cascaded` lists every target computed during accepted staging, in deterministic per-scope order across Global, CWD and Session. It is never elided as predictable: a receipt with only `cascaded` and an empty `effective` array still reaches the model. The owner path does not imply final absence; `effective` entries describe actual final values, including authored recreation or revealed fallback. Accepted history stores explicit net patches and never reruns cascade; existing strategy references affect future accepted intent deletions without rewriting history.

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

- Active preflight records each blocked call when a batch has multiple `state_flow_patch` calls or a sibling of its single `state_flow_patch` call.
- A `barrier-block` record holds only the blocked tool name, call id, existing block reason and ordered batch tool names. It captures no sibling arguments, reasoning or draft content.
- Logging off creates no barrier record, and Passive has no barrier.
- Diagnostic persistence is outside canonical state and cannot change the blocking decision.
- Asynchronous Git push failure detail is the separate logging-off exception; see [diagnostic privacy](usage.md#diagnostic-logging-and-privacy).

### Reads, answers and the protocol

`state_flow_read` reads one cached effective or scoped projection, at current index zero or at a retained causal index up to the configured `historyLimit`. It never publishes or advances history.

**Answers.** Before answering, the model uses `state_flow_patch` only when future-relevant durable state must change. The exact accepted ordinary answer is reconciled directly into runtime-owned `response` at `turn_end`, including `""` when the accepted answer is empty.

- There is no terminal eligibility latch, finalization patch, repair inference or fallback budget.
- If required ordinary-artifact compilation prevents reconciliation, State Flow reports the failure without generating another inference. Optional Skill acquisition never blocks unrelated reconciliation.
- State Flow does not parse `state_flow` or generic HTML comments. Historical comments are ordinary text, and other extensions keep their own comment handling.

**Protocol.** The always-injected protocol lists the six planes once, states scope ownership and response finalization once, combines stewardship with handoff rules, and shares provenance ownership across artifacts and Skills. Ordinary and bootstrap modes keep the same read/patch grammar, references, acquisition and safety obligations; bootstrap adds only its reconciliation requirement. This is prose deduplication, not a change to tool semantics, configurable retention or retained Session restoration/fork. `tests/protocol.test.ts` guards the preserved obligations and unique rule ownership.

## Lifecycle planes

```text
SEMANTIC STATE       intents + strategy + tactics + artifacts + response + lazy
MUTATION BARRIER     state_flow_patch(scope patches) → rematerialized next inference
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

- `withSelectedCurrentTransaction` validates existing selected memory under exclusion; first authoring or a fork uses its own explicit origin authority. Each has one synchronous, single-use acceptance before installation. Pending repeats share the same operation.
- After waiting, the current branch/physical identity, initialization permission and bootstrap context are rechecked. Stop, selection and shutdown withdraw an obsolete activation.
- Only acceptance enables the new mode, clears Stop fences and cancels older Stop persistence.
- Caches, preparation policy and one native checkpoint install before yielding, without a second persistence call; a later failure cannot roll them back.
- Commands, deferred settled Start and Telegram await completion, and presentation receipts for both success and failure revoke with selection.

**What it preserves:** private values, artifact provenance, independent revisions and step, plus available aligned history within the configured limit. It discards the old unfinished specification.

**Edge cases:**

- Incompatible but independently valid live shared streams require a fresh origin, not invented cross-writer history.
- An empty session origin is allowed only with wholly absent private authority and initialization-safe branch provenance; incomplete or contradictory evidence stays closed.
- Initial physical fork copying copies the parent's current memory; an already accepted child activates its own current memory without recopying its parent.
- Repeated Start while already active changes neither the current run nor pending response reconciliation.

### Passive persistence

Passive applies local tools/context policy and freezes the approved handoff before any wait, disabling Active response capture and compaction. It preserves independently owned attachment or fork work and records the newer mode without waiting for it; an observer cannot publish a checkpoint. With no runtime, an eligible branch [observes selected shared memory](#pre-runtime-branches) without initialization. Deferred acquisition and real reselection use their own authority checks, not mode-only persistence.

**Mode-only write.** With an accepted runtime, `persistSelectedPassive` captures the cache identity and, under exclusion, rechecks host policy and exact selected bytes/presence. Compare lifecycle bytes before decoding so a replacement cannot widen reads. Derive the update from recaptured run fields and allow writes only to lifecycle files. Semantic files, provenance, run fields, wire format and history stay unchanged; neither shared drift nor missing owners are adopted. An intervening patch that changes the accepted cache supersedes the captured basis. A correct no-op keeps cache identity and existing leases.

Pending repeats share the operation. Off, session/tree selection, shutdown or accepted Start revoke it; failed Start does not. Stop-owned cancellation can combine with a Pi operation signal, when provided. Shutdown drains the canceled wait. After canonical acceptance the host completes its checkpoint and handoff; a later bookkeeping failure does not roll back acceptance or retry native writes.

**Write fence and recovery.** On failure, keep accepted memory and native context. The native passive-stop marker records `owner`, inactive `mode`, `persistenceError` and `preserveContext: true`. It is a same-session policy override and write fence, not a substitute semantic checkpoint. Off carries it without reading memory; if Pi's trace is unwritable, the local mode still applies but durable recording is not guaranteed.

Fenced tree/reload/resume use `refreshSelectedCurrent` without publishing, rewinding, clearing the fence or overriding a newer policy. An explicit Passive retry can join pending read-only recovery and then accept current memory through the same CAS path as Start. Only acceptance and its newer checkpoint supersede the fence, keeping the bootstrap boundary. This separate path may adopt validated shared drift without incrementing its existing revisions. A failed retry adds no duplicate marker. Off cancels further acquisition. See the [mode and fence witnesses](temporal-acceptance.md#19-stop-changes-policy-not-semantic-history).

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
- Completed idle runs, and markers without an active anchor or preservation flag, keep only post-stop conversation plus foreign custom context. A native `compactionSummary` timestamped at or after Stop is also a continuation boundary: its entire available suffix remains visible through later tool turns and user refinements. Pre-stop summaries do not reopen completed history; no discarded raw request is reconstructed.

The initial system prompt is composed at `before_agent_start`. Stop does not rewrite an already-issued request; the next provider request receives the current owned protocol section, as described below.

### Protocol section and continuations

The current user specification stays at user authority and appears only in synthetic user runtime context. State is fallible assistant-produced data.

**Protocol source.** `lib/protocol.ts` renders ordered, package-owned text from validated owner choice and mode/bootstrap policy. Bootstrap adds a notice to the Active template; Passive shares common rules, not Active's reconciliation pressure. Semantic memory, file bodies and module callbacks are not inputs to this system text. Prompt rendering does not execute semantic hooks; Pi remains the loader. Native contributions must first satisfy the [captured request and caller boundary](scope-selection-contract.md#request-lifetime-and-native-correlation).

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

**What prevents the boundary:** unknown or smaller usage, foreign custom metadata or native `custom_message` context in the prefix that would be removed, stale selection, Stop/bootstrap/error/abort, and pending input. The exact native `custom` type `codemode-store` is exempt alongside State Flow metadata: it carries no model context, and Codemode reconstructs its values/deletions from the full append-only branch even after compaction. Unknown types, similarly named types and visible custom messages are not exempt. User manual and native threshold/overflow compaction stay unmodified; unaccepted work stays under Pi's native compaction contract.

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
- Scope metadata v3 declares Strategy/Tactics; implemented v4 additionally carries retained module descriptors, including unavailable/deleted-content slots. Legacy1/2 and explicit upgrades to4 use the same complete-cohort backup/exclusion/CAS boundary; raw external namespace collisions reject. Core-only streams keep v3 output, while v4 writes cannot drop or alter retained schema/policy descriptors. Representation alone changes no revision or causal identity; runtime-only persistence and inspection never upgrade. Quiesce old writers: version refusal cannot retrofit unsafe deployed callers.
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
- The callback receives root-bound observation and acceptance operations and keeps exclusion until it finishes, including asynchronous completion. Capture happens after acquisition.
- Acceptance validates exact-byte and presence dependencies, returns detached receipts and uses guarded rollback without reacquiring the lock.
- Borrowed operations expire when the callback completes and cannot address another store.

**Waiting and cancellation:**

- By default, a live PID is waited for asynchronously until release or cancellation. There is no ordinary-contention deadline or automatic lock theft. Only the empty creation-to-PID window has a bounded two-second grace period.
- Malformed, non-regular, unreadable or interrupted ownership fails without repair.
- Recursive acquisition of an actively owned root is an error, not implicit reentrancy. Inherited async context from a completed callback neither confers ownership nor blocks a new transaction.
- Cancellation before acquisition or before publication leaves canonical bytes unchanged. Once a synchronous publication has accepted its cohort, later cancellation does not undo it.
- Cleanup checks lock identity and contents, preserves detected replacement ownership, and keeps both action and release errors when necessary.

**Durability limits.** No process/power-loss crash atomicity or kernel-atomic exclusion against nonparticipating writers is implied, and the writer has no file/directory flush barrier. Optimistic persistence across abrupt shutdown is an [accepted limitation](filesystem-recovery.md#power-loss-durability), not a release gate; no crash-recovery journal or additional storage namespace is planned. Short capture/stage/publication exclusion is still necessary to preserve independent fields between cooperating writers: stale whole-state last-writer-wins replacement would lose unrelated work.

### Runtime transaction APIs

Both Pi and the package-root `TemporalRuntime` use selected transactions over exact sparse scope semantics. Lifecycle evidence can establish current authority, not permission to acquire or replace it.

- **`withSelectedPatchTransaction`:** A synchronous author receives the locked current selected states, run fields, causal basis and provenance. Ordinary authors may write against that live shared state, even after drift. Explicitly captured targets (for example, asynchronous module producers) are checked before authoring.
- **`TemporalRuntime.publishSelected`:** Detaches replay, run fields and metadata deltas before waiting; it never silently restages them. Targeted shared stream/provenance drift rejects, including provenance-only targets. A wholly removed target raises `SharedScopeRemovalConflictError`; keep the prior cache and publish nothing. Explicit current acceptance can establish empty shared reality for a new authored patch, not recover lost private memory. Independently valid untargeted shared drift/removal may be adopted. Both routes fence exact private/lifecycle dependencies and required presence; partial/malformed evidence fails before authoring or publication.
- **`withSelectedCurrentTransaction`:** Accepts validated same-session authority without relying on an old cache. It preserves provable aligned history within the configured limit or selects a fresh current origin when independent valid streams cannot be aligned. It cannot acquire a previously unacquired Session.
- **First authoring and acquisition:** `withSelectedFirstPatchTransaction` makes origin acceptance and the first semantic change one publication, with explicit creation authority. A previously unacquired Session needs the separate `withSelectedSessionAcquisitionTransaction` path. An occupied, incomplete or contradictory owner never qualifies as a new origin.
- **Mode and fork:** `persistSelectedPassive` is [mode-only](#passive-persistence). Child deferral and parent copying use the [fork contract](fork-contract.md).

Callbacks receive detached inputs and one synchronous publication capability, spent on first attempt even if it fails. Semantic routes check cancellation, captured cache identity and independent host authority before waiting, under exclusion and before publication; a change away and back does not revive old work. Cache identity cannot grant [native request admission](scope-selection-contract.md#request-lifetime-and-native-correlation). Failed publication installs nothing; durable acceptance installs a detached cache before yielding, and later failure cannot undo it. No native bookmark can rewind canonical memory. See [selected staging and publication](scope-selection-contract.md#publication-and-semantic-staging) for replay and provenance validation.

### Run preparation and answer reconciliation

**Preparation before the first inference.** Native `before_agent_start` captures the prompt and contributes protocol without touching canonical storage. At the first active `context`, the adapter:

1. combines Pi's operation signal with its preparation lifetime and awaits `withSelectedPatchTransaction`;
2. rechecks selection/policy, clones the latest lifecycle snapshot and inspects exact registered paths from the locked states;
3. removes proven-missing registrations and their provenance together with run metadata, in one acceptance. Source reappearance or unavailable metadata does not authorize deletion.

Without removals on a complete accepted cohort, publication preserves semantic/provenance files and wider retained history. Authorized acceptance can initialize a [wholly absent shared triple](filesystem-recovery.md#shared-scope-files) without reviving old values or incrementing the step. Caches, revisions and one native checkpoint update before the provider is called; later context requests reuse the completed preparation instead of replaying the specification. Start can request maintenance without inventing a new user run.

**Withdrawal and failure:**

- Stop, session/tree changes, new runs and shutdown withdraw obsolete preparations.
- A failed or canceled acceptance installs no draft or shared adoption; a later failure cannot roll back accepted metadata.
- Pi catches context-hook exceptions and continues, so a failed preparation requests cancellation through public `ctx.abort()` before returning, with an actionable diagnostic and no repair inference.
- Idle/no-signal projections do not publish.
- Native tests prove this [pre-inference cancellation seam](compatibility.md#pre-inference-cancellation), including real Abort while another process is paused mid-publication.

**Unaccepted requests.** An unaccepted request may leave no canonical specification. Native conversation after the latest valid checkpoint is therefore conservative uncompiled-context evidence, not semantic authority. Stop preserves it even at idle, and same-physical-session restoration uses the existing bootstrap flag to keep available context through reload/tree. This also covers interrupted boundary continuation after completion removed the specification. No new persistence format, guessed run anchor or reconstruction of discarded transcript bodies is introduced.

**Answer reconciliation.** Accepted-answer reconciliation also uses `withSelectedPatchTransaction`: `turn_end` awaits exclusion, stages the response over the current shared head, and atomically publishes it with a detached completed-run snapshot.

- Only acceptance installs the lifecycle/cache and native checkpoint; there is no second persistence call.
- Its response-owned cancellation is combined with Pi's operation signal. Stop, new runs, session/tree selection, shutdown and superseding answers cancel obsolete waits; an old completion cannot clear a newer pending response or alter its snapshot/UI.
- Failure or cancellation before acceptance leaves accepted memory and the unfinished specification intact.
- Later native boundary handlers and continuation inference observe accepted memory.

### Read-only refresh APIs

- **`refreshSelectedShared`** observes only present selected Global/CWD owners, without inspecting Session or creating a store.
- **`refreshSelectedCurrent`** validates same-session authority and exact selected memory without publication. It returns detached current run fields, limits retained history in memory and omits shared owners known absent. Excluded bodies are not opened. Failed-Stop reload uses it without clearing the write fence.
- Neither installs an accepted publication basis or substitutes empty values for missing authority. Invalid evidence or cancellation, including during capture, leaves the previous cache unchanged. Cache withdrawal does not discard known ownership or acquisition evidence.

### Branch attachment and restoration

**Off attachment.** Native `session_start` and `session_tree` first read only mode policy, through `session.findBranchPolicy` and `snapshot.readCheckpointMode`.

- Off attaches without constructing a temporal runtime, resolving semantic boundaries, reading memory or emitting recovery warnings; native mode/write-fence bookkeeping stays available.
- Deferred fork ownership is recorded in a child-owned `forkPending` native marker that survives extension recreation; accepted child initialization resets it.
- Explicit Passive or Active accepts validated current same-session memory (a pending fork copies the parent's current memory first); a write fence clears only after that acceptance.
- Automatic callbacks stay memory-inert in Off; installed-client acceptance gates are tracked separately in [BACKLOG](../BACKLOG.md).

**Memory-enabled restoration.** Memory-enabled native `session_start` and `session_tree`, and explicit acquisition after an Off attachment, await one extension-owned branch restoration.

1. **Synchronous prelude.** It revokes older selection work and pins the session id, file, header timestamp and CWD. It reads the branch's newest supported checkpoint through the recovery domain's pure `selectRetainedCheckpoint` only for mode and run lifecycle (unfinished specification, bootstrap); its boundary is never a memory revision to rewind to. Revision pointers and unsupported envelopes fail closed.
2. **While waiting,** the mode is the selected inactive policy, and private reads/publication report the pending selection.
3. **Acceptance.** Same-session attachment uses `withSelectedCurrentTransaction` under the checkpoint's mode. A fork copies the parent's current memory; a genuinely new auto-start uses first authoring with explicit creation permission. Failed-Stop reload uses read-only recovery. Bootstrap and policy are derived after checking branch evidence under the selected lifetime.
4. **Installation.** Only the current lifetime installs memory, checkpoint, continuation, tools and UI before yielding; a later native-write failure only warns.

**Failed Active selection.** Failed current-memory acquisition may attempt [self-healing](filesystem-recovery.md#self-healing) once; only a proved, healable owner can reset visibly. Memory still unavailable after recovery, a failed fork copy or automatic Start failure retains the selected Active mode with unavailable-memory validation. The inference fence is derived from that mode and validation, not an independent flag under an inactive fallback. No Active lifecycle work or fabricated projection runs before validated acceptance; shared reads may remain available. Terminal and Telegram show `active (blocked)` with explicit recovery guidance. The live `context` hook calls public `ctx.abort()` before returning; merely throwing would let Pi continue with native history. Reloading while current memory stays unreadable reconstructs the fence. Accepted Start or accepted explicit Passive releases it; explicit Off permits native context but grants no memory authority. Signal-less inspection does not cancel or clear the fence.

**Interaction with mode choices:**

- A new selection revokes older work; shutdown drains current and superseded restoration operations.
- Passive keeps independently owned restoration, new-session initialization and fork copying, including attachment requested by a now-cancelled Active waiter. Off cancels those owned waits and keeps only native policy/source bookkeeping for later explicit acquisition.
- The pending publisher applies the latest inactive policy inside its single acceptance. Passive can then patch memory without an artificial error fence, while Off exposes no model access. Repeated selections are inert with respect to that acceptance.
- Start joins retained Passive acquisition. After Off, non-fork Active goes directly through one cancellable current-head Start transaction, keeping the deferred native selection and local Off policy until publication.
- A superseding Passive cancels that activation and acquires current memory itself. Native Abort silently withdraws Active, without inventing a write fence or losing later acquisition choices.
- Accepted activation reconstructs any native continuation from its proven current memory. Fork acquisition keeps its independent restoration owner.
- Selection changes, shutdown and native operation cancellation still revoke obsolete work. Real validation/publication failures stay unavailable rather than becoming empty memory.
- Start joins pending restoration, owns initial attachment and fork retry without cancelling itself, and is inert when the result is already active. A cancelled Start withdraws its join without cancelling independently owned restoration or Stop persistence.
- Read-only recovery uses detached candidates and rechecks cancellation and physical identity before host installation. Passive attachment cannot overwrite a newer cache established by an intervening patch or inspection.

**What stays outside critical sections.** The advisory [continuation-candidate reader](#session-continuation) also awaits coherent capture, and current-head activation on an attached branch uses the awaited Start transaction. Raw precomputed replay keeps its selected-target guard, unlike current-head authored patch staging. Model inference, source acquisition and Git commands do not belong inside a canonical critical section; artifact freshness validation stays part of publication validation.

## Optional Git backup

Canonical files always own semantic persistence, current materialization and retained hot history. Installing Git beside the store does not change authority or enable cold semantic restoration. Branch navigation attaches current memory, so artifacts keep their current semantics and current evidence together.

**Artifact provenance across attachment and fork.** Scope artifact provenance records only current evidence. Attachment keeps current semantics with their current evidence, and a fork copies the parent's current session provenance, so no historical pruning is needed.

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

[Unsupported layouts and native boundaries](filesystem-recovery.md#unsupported-layouts-and-native-boundaries) are not canonical input. Missing documented planes, including `intents` and `lazy`, are valid sparse semantics, not a layout change.

## Artifact routing

**Observation.** State Flow never discovers source directories. Before enabled inference, it inspects only exact source paths already registered as artifacts in global, CWD or session state.

- Observation uses regular non-symlink file metadata `{size, mtimeNs}`, without reading bodies. Unregistered files are never observed.
- Proven absence removes the artifact from each selected owning scope. Unavailable, relative, directory or symlink evidence is non-destructive. Invalidation planning overlays selected registrations before observation, so a narrower registration masks a broader path; missing-source maintenance considers each selected owner independently.

A model-visible artifact entry requires only a non-empty description:

```json
{
  "description": "routing summary",
  "compilation": {}
}
```

**Runtime-owned evidence.** Compilation evidence is kept per scope in `meta.json`. Current ordinary artifacts use `sourceFingerprint: {size, mtimeNs}` plus `compilerRevision`; retained `sourceHash`/`compiledAt` are transitional compatibility evidence.

- At artifact-entry level, every model scope patch rejects authored `hash`, `compiler`, `compiled_at`, `sourceHash`, `sourceFingerprint`, `compilerRevision`, `compiledAt`, `source_hash_verified` and `hint` fields, including field-deletion markers, even without a preceding read.
- Retained embedded evidence stays readable, but its embedded `hash`/`compiler`/`compiled_at` fields are omitted from model projection. Ordinary semantic edits and whole-artifact deletion stay valid. An accepted registration deletion removes its interpretable owned registry entry only when all present recognized fields validate. Unbound, empty, opaque or malformed entries remain raw; this is not a metadata cleanup pass.
- Compiler output may add other finite non-null JSON metadata. Known optional semantic fields include `kind`, `tags` and `compilation`. Tags are unique trimmed non-empty strings that support deterministic candidate filtering, but never authorize reading.
- The `strategy.compiled_skills` location is rejected. Skill compilations belong only in source-addressed artifacts, with no fabricated source hashes.

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
- **When nothing is needed.** A successful selected Skill read with a matching current source hash needs no new compilation. Otherwise the tool result names the exact optional target. An independently requested native read of an excluded Skill remains legal; State Flow records only its path and provenance owner, without hashing, hinting or permitting relocation.
- **Attempted output.** Durable output at the reported scope and path requires a non-empty description, `kind: "skill"` and a non-empty compilation describing applicability, constraints and failure conditions. An omitted output leaves the read volatile and blocks neither unrelated patches nor ordinary completion.
- **Replacement.** The accepted compilation replaces the complete prior Skill card and provenance, storing runtime-owned `sourceHash` and `skill-artifact-v1` `compilerRevision`; obsolete evidence cannot survive a refresh. Source bodies do not persist in state.
- **What provenance proves.** Matching provenance proves source-version consistency, not semantic fidelity, truth or higher instruction authority.

## Operational guidance and memory curation

The packaged [State Flow Skill](../skills/state-flow/SKILL.md) is the on-demand reference for operations and recovery. Its separate curation section applies only to an explicitly requested bounded review of stale knowledge, commitments, continuation, ownership or transfers. Phase completion does not activate an audit.

Curation may persist reusable guidance from a registered Skill at its provenance-derived scope.

Curation preserves the [decision-relevant handoff](semantic-layers.md#handoff): reconcile touched branches without replacing requirements with hypotheses or treating retained observations as live external evidence.

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

**`state_flow_patch` grammar.** Captured WANTED participation, not the number of supplied targets or currently available owners, selects the model interface. One owner takes direct semantic planes without an owner wrapper; two/three owners take explicit participating `global`, `cwd` or `session` patches.

**Native admission.** Check the original tool receipt, physical caller/owner, captured policy and cancellation before normalizing arguments. A flat shape does not identify its owner, and Pi can still execute an older wrapper after schema replacement. Normalize a detached patch into the exact captured owner before the same canonical staging engine, not via SDK `prepareArguments`. No declaration or selection grants source, private or publication authority. See [SDK declaration refresh](compatibility.md#patch-tool-declaration-refresh).

- Each supplied canonical owner patch contains object-valued `artifacts`, `strategy`, `tactics`, `intents` and `lazy`; in one-owner model arguments these planes are top-level. Nested values are ordinary JSON.
- Recursive object merge updates fields, arrays/primitives replace, and nested object-key `null` deletes, including inside newly created objects. Deletion-only patches through absent ancestors create no empty parents. Accepted supplied scopes recursively omit empty object fields and empty planes: deleting the last child removes its empty ancestors, and explicit `{}` is not a retained value. Nonempty omitted fields persist; an object patch that turns a scalar/array into an empty object removes that field. Cleanup is scope-local and can reveal inherited values; it stops at the scope root and never removes array slots.
- Against an existing array, a nonempty object containing only canonical `"[N]"` keys recursively patches those existing elements (zero-based). Out-of-bounds indices and indexed `null` deletions are rejected atomically; adding/removing elements requires replacing the whole array. Against objects, those keys remain literal object keys.
- Missing authored object-key deletions succeed with nonfatal hints in the acknowledgement, for both unchanged and mixed patches. Each hint gives the target and first unavailable component as escaped JSON Pointers: relative to the sole owner in text, owner-qualified for multi; result details retain canonical owner-qualified pointers; a non-object ancestor is also unavailable. These hints are presentation-only: no state fields, revisions, history records, automatic path correction or cascade warnings.
- Rejected: materialized null within documented semantic planes, empty patches/supplied scopes, wrong flat/scoped root family, unknown top-level fields, model-authored `response`, and finalization or `{scope, patch}` / `unchanged` grammars. The semantic null rule does not apply to runtime envelopes such as an origin's null parent.
- Correct repeated results succeed as `State already current.` without another semantic revision or history record; avoid gratuitous acknowledgment patches.
- If canonical acceptance succeeds but the native Pi checkpoint fails, the patch result remains successful with a separate warning (`details.warnings` code `native_checkpoint_failed`). The warning does not authorize replay; errors before canonical acceptance still reject the patch.
- Global/CWD overlap follows successful acceptance order, and unmentioned current fields survive. Session ownership is not a shared-memory merge.

For exactly one wanted owner (for example Session):

```json
{"intents":{"next":"Verify the corrected behavior"}}
```

For multiple wanted owners including Session (for example Global+Session), an explicit selected target remains required even when only one is changed:

```json
{"session":{"intents":{"next":"Verify the corrected behavior"}}}
```

**Intents and references.** `intents` keeps active commitments, not requirements, observations, alternatives or completed plans. Removing an intent does not undo its consequences. See [intent ownership](lazy-state.md#intent-ownership) for cleanup of its owned keys and [semantic references](lazy-state.md#semantic-references) for supported forms and single-owner translation.

**Reactive repair.** The agent never scans or resolves references merely to test them. Only after a one-path value read is missing does the query domain perform one bounded reverse lookup over current model-patchable semantic planes for exact structured `$ref` or `$path` matches. When matches exist, `state_flow_read` returns the explicit diagnostic sentinel `{value:null, hint:[{type:"dangling-reference", message, paths}]}`:

- `hint` is a top-level sibling, not state data. Its message describes unavailability conditionally.
- `paths` contains at most three runtime-verified current reference-owner addresses, not verified new locations of the requested data.
- The hint contains no lazy bodies and does not prove prior existence, retention or relocation. The null sentinel is never returned alone for this case.
- Keys, patch and value batches do not perform reverse lookup. A scalar read without a durable match keeps the ordinary missing-path error.
- A match establishes durable semantic provenance, not staleness; no match does not prove invention. The agent may inspect ownership and patch a proven stale source when useful to the current task, without discarding surrounding meaning or resurrecting its target.

**History is task-driven.** Missing paths or hints alone do not require historical search. The agent may independently choose targeted historical reading when a previous value is useful to the current task; no separate user permission is required. Historical values are evidence, not automatically current state or a reason to restore deleted memory. Runtime never scans history for reference owners, triggers repair inference or hydrates lazy bodies. Effective absence does not establish ownership, and unavailable history, external inaccessibility or a transient read failure does not prove a broken reference.

**`state_flow_read` addressing.** Supply exactly one of `path` or `paths`. Both accept a string or a nonempty ordered array of strings, with `value`, `keys` or `patch` projection. The response follows the number of paths, not the spelling or type of the argument. One wanted owner's ordinary flat paths bind that owner; multi-owner flat paths use the effective overlay, even when the available view has only one owner.

- The `value` projection returns `{"value":…}` for one semantic path, even when supplied in a one-element list or when the value itself is an array. For multiple paths it returns `{"values":[...]}` in input order. A missing top-level plane or a current root or built-in plane of a shared owner proven absent by observation returns `null`. Only in `values`, a path error is `[null, {"code":"…"}]` in its slot; a one-path read retains its scalar error and hint behavior. Stored values cannot contain `null`, so the tuple cannot be mistaken for stored data. The codes are `invalid_path`, `scope_excluded`, `scope_unavailable`, `history_unavailable`, `path_not_found`, and `invalid_selector`. Invalid request shape, cancellation, stale policy and failure to validate the read basis reject the call, not individual slots.
- Explicit owner roots require participation. A current `keys` query of an owner root or a built-in top-level plane can report `{"meta":{"type":"absent"},"keys":{}}` when successful observation proved the shared owner absent, or `type: "unavailable"` when Passive has no validated Session view and restoration is not pending. A missing current top-level plane in a validated scope or overlay (built-in or metadata-declared) also reports `absent`. Catalog results grant no authority. Keys and patch batches still fail as a whole on a path error.
- `effective == effective[0]` is the current effective materialization; `global == global[0]` (and the CWD/session equivalents) selects that scope at the same composed causal boundary.
- For selected/available Global, `global.patches == global.patches[0]` reads its latest retained accepted patch; higher patch indices walk only that owner's retained accepted patches. Exactly one wanted owner also admits a single-locator `patches[N]` alias. Scope-patch reads are value-only, not mixed semantic/patch-history batches.
- `effective[N]` selects a retained causal boundary; ordinary nested array `[N]` still indexes an array, not history. With only CWD selected, `effective[1].tactics.items[0]` reads the same value as `cwd[1].tactics.items[0]`.
- Indices are bounded by the configured `historyLimit`; unavailable pre-origin or pre-tail history is an error.
- Resolver aliases are not literal JSON containers.
- Object keys in paths must match `[A-Za-z_$][A-Za-z0-9_$-]*`. Both tool descriptions and the Skills ask the model to name keys in ASCII (values may use any language), and a non-ASCII key in a read path fails with that grammar in the error.
- Reads stay cached and create no Git query, publication, checkpoint append or semantic step.

When CWD participates and its older boundary is retained:

```json
{"path":"cwd[1].intents"}
```

When Global participates and its owner patch is retained:

```json
{"path":"global.patches[0]"}
```

For exactly one wanted owner with retained patch history:

```json
{"path":"patches[0]"}
```

Ordered semantic reads use the same wanted-owner/effective rule:

```json
{"paths":["strategy","tactics"]}
```

A read or projection ID is not a publication capability. A batch preserves duplicate paths and request order against one read basis; it does not echo locators or internal revisions.

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

The pure `readTemporalState(view, offset, scope?)` accessor is exported separately. SDK hosts with an explicit tool allowlist must include both `state_flow_patch` and `state_flow_read` when they want model access.

**Shutdown.** Honor Pi's `session_shutdown` lifecycle before disposing an embedded session.

- On the [tested Pi SDK baseline](compatibility.md), `AgentSession.reload()` emits and awaits shutdown, but bare `AgentSession.dispose()` only invalidates/disconnects the session.
- `AgentSessionRuntime` owns native new/resume/fork replacement, and its asynchronous `dispose()` delivers quit shutdown; rebind each newly created session's extensions.
- An SDK host disposing a standalone `AgentSession` instead should first `await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`. Ordinary Pi lifecycle owners already deliver the event.
- Without shutdown, the adapter's queued Start, compaction-stop flags and optional presentation disposal are not notified.

**Forks.** Native replacement teardown and State Flow adoption are separate responsibilities. The adapter composes selected shared-only deferral or admitted parent-current private copying under the [fork contract](fork-contract.md); Off remains native-only. Captured policy is not source/copy authority, and an acquired child always uses its own current memory rather than recopying a parent or rewinding history. See [operating limits](usage.md#fork-support-and-limits).

**Configuration.** Agent configuration is read once per extension load; session runtime configuration stays branch-selected. See [configuration](usage.md#configuration) for settings and path precedence. Ownership meanings and relative precedence are stable, but participation is a captured validated nonempty subset of Global/CWD/Session; omission defaults to all three, Global is not mandatory. Global defaults and explicit native scope choices remain separate from mode and current/private/source admission; see the [functional scope boundary](scope-selection-contract.md#functional-acceptance-boundary).

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

- Compact terminal status uses accent `state-flow` with dim `active` or `passive`, and is hidden in Off. Failed Active restoration stays visible as `active (blocked)`.
- Telegram main-menu status uses `State Flow: active`, `State Flow: passive` or `State Flow: off`, with the same blocked qualifier for failed Active restoration and an actionable submenu notice.
- `/state-flow-status` reports selected mode and any inference fence explicitly, then keeps the `g#c#s#` vector beside concise diagnostics and blank-line-separated top-level semantic JSON.
- Mode is read directly from the session's selected enum, never derived from a pending patch or separate passive flags.
- Requested Global, CWD and Session Rich snapshots show their independent `#revision`, while Effective shows the vector. Global/CWD Rich views omit the empty structural response placeholder; Session and Effective expose the Session-owned response.
- Missing evidence stays unavailable instead of appearing empty.

**Telegram menu layout.** The optional Telegram leaf adapter shows, in order:

1. the current mode as a monospace value in the submenu heading;
2. matching Mode and Inspect participating memory headings (a long-dash-separated description ending in a colon), with selection-aware settings-style descriptions; the captured participating owners are named only by that Inspect list, with no separate scope-summary or Session-exclusion line;
3. one radio row `Off | Passive | Active`, where selected Off uses 🟣, Passive 🟡 or Active 🟢, and inactive choices use ⚫️;
4. only captured participating owner-inspection buttons, plus Effective for two or three owners. A sole owner is already effective. Inspection stays explicit and available in all three modes; unavailable memory is not invented.

### Inspection reads

- Inspection may refresh live Global/CWD streams in memory so foreign accepted revisions become visible, but never publishes or increments a revision.
- Memory-enabled inspection keeps its accepted-private/shared-refresh and failed-Passive cache rules.
- Off inspection uses a fresh disposable `TemporalRuntime`. A single selected Global/CWD or selected shared-only Effective uses `refreshSelectedShared`; inspections requiring selected Session use `refreshSelectedCurrent` under existing private proof. Effective never widens to excluded owners. Missing/invalid private evidence cannot become an empty layer/revision or foreign private data.
- No reader installs the extension runtime/cache, changes native policy or canonical bytes, clears a carried write fence, acquires an unaccepted fork parent or replaces the selected historical target.
- Branch steps never select a past memory revision; inspection and acquisition always use current stored memory.
- `StateFlowTelegramSnapshot.scopes` supplies detached wanted selection DATA to rendering; omission preserves all-three legacy embedding behavior, while malformed explicit values reject. Buttons/help do not infer scope choice from available revisions or confer memory authority. The awaited `StateFlowTelegramInspectionPort` returns coherent state/revisions and an optional revocation signal. Target eligibility is checked before reader calls, selection is rechecked after acknowledgement/observation, and native inspection also revalidates its lifetime and physical owner before presentation.
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
