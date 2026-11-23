# Scope selection and lifecycle contract

This contract owns selected-scope policy and its authority boundaries. [Usage](usage.md) owns operator syntax and configuration, [architecture](architecture.md) owns the runtime and temporal algebra, the [fork contract](fork-contract.md) owns child copy limits, and [compatibility](compatibility.md) owns package admission.

**Selection is policy, not memory.** Choosing owners decides what may be read, written and projected; only owned acceptance changes canonical data.

## Policy and selection value

### Agreed invariants

- Execution mode, scope participation, and semantic responsibility are independent dimensions. Do not add one mode per selection or assign a semantic plane permanently to a scope.
- Every nonempty selection is valid: `global`, `cwd`, `session`, `global cwd`, `global session`, `cwd session`, `global cwd session`. Compose the selected set in that relative order; input order does not change precedence.
- Scope equality means equal semantic capability, not identical sharing mechanics. Global/CWD remain shared; Session remains private. Precedence is not truth, authority, importance, or permission.
- Disabled owners contribute no ordinary model values, patches, implicit fallbacks, maintenance, or hidden response/provenance writes. Their canonical checkpoint/tail/metadata bytes are not normalized, folded, initialized, moved, or deleted by selection.
- Selection alone advances no semantic revision/step or transition identity and rewrites no history. Explicit acquisition can validate current data and establish authorized lifecycle state; it is not proof of a semantic change.
- Off exposes neither memory tools nor State Flow context. Its automatic lifecycle remains canonically memory-inert, even if selection must be remembered.
- Cancellation before acceptance installs no candidate. Cancellation after acceptance cannot undo accepted memory. Publication remains exact-cohort, lock/CAS guarded, and owned by the existing runtime/storage boundary.

### Current operator policy

#### Parsing

Use the existing `registerCommand` argument string on Active, Passive and Off. Split whitespace-separated canonical tokens, reject duplicates/unknown spellings and mixed invented flag syntax before changing either mode or selection, and normalize order. Whitespace-only arguments mean no new explicit selection. This refines the initial argument-free-Off recommendation: explicit Off scopes are only native policy DATA, remain canonically I/O-inert and allow participation changes without entering an enabled mode. Mode-only Off still preserves selection; no new command, acquisition grant or global-default mutation is added.
Global configuration accepts a nonempty unique array under `scopes`; missing means all three. Invalid global JSON/keys/values still fail loading. Commands and Telegram do not edit global defaults. A mode-only Telegram action preserves the concrete current selection; a seven-combination chooser is not required.
**Installed boundary:** Global `scopes` supplies any nonempty selection for first native capture; enabled participation then uses the selected bridge and its independent origin/current/private/fork authorities. Capture is still only policy DATA. Missing scopes retains all three; mode-only controls preserve the captured choice. Optional scope tokens and SDK argument completion are now bound to the existing commands; see the current [public command boundary](#public-mode-command-scope-overrides). A settings chooser is not required.
#### Default and branch precedence

**Implemented D3 policy:**
1. A command with valid explicit scopes proposes that concrete selection for the current session branch.
2. Without arguments, retain the already established branch/session selection, across mode changes and Off. A same-mode command with different scopes is not an “already active” no-op.
3. A genuinely new independent session samples the loaded global default and records that concrete policy in Pi. Later default edits affect later new sessions, not recorded sessions.
4. A legacy session without any scope evidence samples the currently loaded global default once at its first upgraded attachment. Record it as native policy without eagerly creating or converting semantic storage. Do not treat absence and a malformed explicit selection as equivalent.
5. Native branch policy chooses mode and selection; current canonical files choose memory. Tree navigation can select a branch's earlier policy but must not rewind its memory. Same-session reload/resume preserves that policy.
6. A fork inherits its source branch's concrete policy into a fresh child owner. It is not an independent `/new` default, and it cannot share a mutable selection object with its parent.
7. Canonical session config mirrors accepted lifecycle policy when memory-enabled acceptance is allowed. A newer owner-local native Off/deferred/failure marker overrides older canonical policy without becoming semantic authority.
The selected D3 direction is concrete capture at the first upgraded/new native attachment, after validating branch policy and before canonical acquisition. It is not a permanent coupling to live global defaults. Native persistence, precedence and malformed-policy fencing have their retained integration witnesses below; the internal value tests alone do not establish them.

## Lifecycle encoding and preflight

### Internal value boundary and lifecycle encoding direction

`lib/selection.ts` now owns the immutable nonempty `ScopeSelection` value, its explicit array decoder and whitespace-token parser. It depends only on the existing scope identity type, not on mode, SDK, filesystem, temporal history or publication. It is not exported from the package root. Global configuration reuses this decoder for captured native choices; mode commands now bind this exact parser and pure unused-owner prefix completions. The retained native bridge admits all seven selections without making the decoder a publication or private-acquisition capability.
- `captureScopeSelection(value)` rejects missing, empty, duplicate, noncanonical, sparse or inherited-index input; it returns a detached frozen array ordered `global → cwd → session`. Every one of the seven nonempty sets has the same semantic eligibility.
- `parseScopeSelectionArguments(args)` returns no explicit selection for blank input, not all scopes. A mode-only caller must preserve its established choice. Invalid tokens throw before the caller may change policy.
- `DEFAULT_SCOPE_SELECTION` is the all-three fallback for an absent global setting only. An explicit `undefined`, `null` or `[]` is not absence. The config owner distinguishes a missing property from a malformed present property before calling the decoder.
- A legacy native session with no explicit selection evidence samples the loaded default once; that may be a subset. This differs from saying every legacy session must use all three. Captured values survive later default edits, and child values must detach from parent inputs.
- A scope value carries no mode, causal identity, acquisition proof or request epoch. Equal sets after changing away and back cannot revive an older operation; request/operation ownership remains a separate integration obligation.
**Lifecycle format:** Selected canonical config contains `{mode, scopes}`. Runtime metadata uses Baseline or a readable numeric V2 predecessor. Native v2 policy records are a separate Pi bookkeeping format. The lifecycle header's `privateAcquisition` is `unacquired`, `deferred`, or `acquired`. A label is not proof of a valid private stream or direct parent; copy and publication still require physical identity, replay and exact CAS.

### Detached policy and lifecycle preflight

`lib/snapshot.ts::parseSelectedLifecycle` accepts the config/runtime pair and expected physical identity, and normalizes Baseline and V2 into one lifecycle value. It does not need fallback scopes. A recognized retired V1 or unknown format refuses before semantic acquisition; it is not corruption. Both absent files mean absence, never new origin authority. Partial or malformed supported evidence cannot install policy, cache, or publication permission.

`prepareRetainedPolicyMigration` in the same domain validates unversioned legacy or explicit-v2 native checkpoint values, including pre-runtime inactive forms. V2 requires mode/scopes and refuses legacy `enabled`/`disabled` aliases; unversioned scopes and unknown explicit versions refuse. A prepared native v2 checkpoint preserves its concrete selection when decoded with later defaults. Its boundary token remains opaque lifecycle evidence, not a memory rewind or restoration capability.
`lib/session.ts::prepareBranchCheckpointPolicy` considers snapshot entries only. The latest recognized owned snapshot must validate; malformed/unreadable data cannot silently fall through to an older wider selection. Foreign/unclassifiable records grant no policy. This checkpoint-only helper remains separate from the complete resolver below and is not wired into existing attachment. Current `findBranchPolicy` and mode-only extraction remain legacy behavior until integration.
Runtime JSON errors expose fixed diagnostics without raw payload snippets or nested parser causes. Candidate preparation neither installs policy/cache nor reads parent/private memory, advances a revision, acquires a stream, backs up files or publishes. Those obligations remain with selected-owner runtime/storage and the owning native lifecycle operations.

### Complete native policy and marker admission

`session.ts::prepareSelectedBranchPolicy` now combines v2/legacy snapshots with native policy/Stop/fence/reset and child-owned pending-fork evidence. Its explicit context supplies the physical owner, the marker entry type, a caller-chosen new-session/inactive fallback mode and loaded scope default; the resolver never infers independent-session origin permission from absence. It returns detached concrete mode/scopes, pending-child status, the native continuation boundary, any physical-owner persistence fence and an optional-needed v2 **policy-only capture value**. It does not append entries, install native policy, inspect a parent header/store or confer semantic acquisition authority.
`captureSelectedNativeMarker` validates a closed version-2 marker with required `owner`, `mode` and canonical nonempty `scopes`. Policy-only and pending-fork forms may carry any mode without semantic fields. Stop forms carry safe nonnegative `at`/optional `from`, inactive mode and optional preserve-context/persistence-error fields; `memoryDeferred` requires Off. Reset is a distinct flag combination carrying explicit mode/scopes, with no Stop/pending payload. Unknown epochs, aliases/extra roots, malformed flags, incomplete policy and legacy raw `scopes` collisions reject. Actual unversioned legacy writer shapes remain readable; malformed fields that old permissive readers happened to ignore are not a supported way to invent a new selection. Checkpoint and marker epoch checks precede payload interpretation; unreadable native identity/version/data produces fixed diagnostics without payload-bearing causes.
Policy is folded in branch chronology. Legacy mode-only checkpoints/Stop choices retain an already captured concrete selection instead of resampling later loaded defaults. With no prior scope evidence, the supplied scope default is captured into the returned v2 native value; appending that value is the later adapter's obligation and makes subsequent default edits irrelevant. Explicit v2 policy replaces earlier valid scope choices. Latest malformed/unsupported owned policy never falls through to an older wider selection. A later **explicit valid v2 policy** can supersede known malformed policy; a later scope-less legacy choice cannot repair tainted selection evidence by sampling a default. Unknown pending-fork epochs require a later understood owned reset/pending disposition, not a policy-only scope choice.
Physical-owner write fences, continuation boundaries and fork bookkeeping remain distinct from requested mode/scopes. A later policy-only marker or pre-runtime policy-only checkpoint cannot certify canonical acceptance or clear an older write fence; a supported boundary-backed checkpoint or owned reset can. A newer Stop/Off choice without an error also does not erase an existing fence. Legacy reset cancels older Stop mode overrides using the last checkpoint/caller fallback mode while preserving captured scopes; new v2 reset carries its complete explicit resulting policy. This prevents a mode-only reset from widening memory participation. `capture` deliberately contains no reset/error/boundary claim, so freezing a selected policy cannot itself acknowledge canonical recovery.
Fresh native fork context or surviving child-owned pending evidence permits inheritance of source-branch mode/scopes **only before child-owned bookkeeping takes over**. Parent/foreign fences, continuation and resets never become the child's physical authority. A checkpoint alone cannot clear child pending-copy facts; only the child's understood reset does. Returned pending/capture values are bookkeeping, never proof of a direct parent, private target absence or permission to copy/acquire. The existing fork/storage acceptance must still independently revalidate those facts. Foreign-owner payloads are filtered before scope/error interpretation in ordinary same-session resolution, and Off/pending-fork admission performs no canonical or parent-file I/O.

## Request lifetime and native correlation

### Selected policy-bound request lifetime

`SelectedPolicyLifetime` owns detached, closed `{cwd, owner, mode, scopes}` policy. CWD is absolute and normalized lexically, without source or filesystem lookup; owner is opaque. Malformed, inherited, missing or extra fields refuse without exposing payload data. Capture an enabled policy receipt before source acquisition, inference or queueing. It carries a frozen policy, cancellation signal and synchronous recheck, not canonical, origin, fork or publication authority. The caller must still bind its runtime and separate operation permission.

Equal canonical choices retain the lifetime. A different choice, same-policy native invalidation or shutdown revokes earlier receipts; changing away and back cannot revive them. Off ends memory captures but still supplies control cancellation. The adapter owns native policy and cache clearing. Revoking one concern does not cancel another concern or renew the policy. Because Abort listeners run synchronously, the slot withdraws its old owner, and a renewed lifetime installs its new controller, **before** aborting the old signal. Identity-guarded release/drain cannot overwrite a reentrant choice or reopen shutdown.

### Native turn and tool-batch request correlation

At SDK `turn_start`, bind the captured policy, physical identity and actual operation to one native turn. `NativeToolRequestCorrelation` accepts names and IDs from its awaited finalized assistant `message_end`, not partial message identities, timestamps, payloads or transport IDs. Unknown, duplicate, overlapping, unfinalized, mismatched or consumed admission fails closed; each tool execution spends one matching receipt. A refused original ID cannot be reused, but an independently valid sibling or fresh ID can proceed. Recheck turn, operation, owner and policy before reading arguments or publishing; turn end drains the map. Raw host calls require actual owned context and are separate only when there is neither an operation signal nor a live native model request.

Nested admission uses the SDK's explicit `parentToolCallId` chain, with matching parent/name across notices, never prefix guessing or history search. Active nested patches cannot prove the sole-mutation barrier; fresh Passive nested patches use ordinary atomic publication. Canonical and [legacy tool names](compatibility.md#tool-name-compatibility) share this admission. Stale patch calls cannot assert a barrier over foreign siblings; ordinary foreign tools and native trace remain Pi-owned. Revoked source-read callbacks cannot update newer acquisition evidence.

### Native query caller and runtime binding

A tool-ID receipt alone does not prove caller or cache ownership. Before arguments, projection, source work or staging, bind caller, captured policy, attached address and cache to the same native ID, CWD and storage key. File-backed keys follow the `.jsonl` basename stem; only in-memory identity reconstructs its key from the immutable timestamp and native ID. Context object identity is not required, but missing context cannot borrow the ambient owner. These are storage-address and request checks, not host authentication.

Authorized same-owner reads can use validated observed memory without publication, private acquisition or disk polling. A Passive write fence does not block such a read, and reading does not clear it.

### Native context and preparation request admission

The phase-bound context lease starts at turn start and ends at assistant finalization. It remains distinct from acquisition; an Off-origin operation cannot borrow a later Active request. Contribution hooks admit owner/address/runtime and original operation before reading prompt, view or frozen handoff. `before_agent_start` is capture-only. A foreign callback contributes nothing and cannot abort the rightful operation or rewrite its messages.

Active preparation binds its actual caller and **once-captured** operation signal across storage waits. A changed lazy signal getter, owner or file cannot publish the old specification or perform its maintenance. `context_with_system` rechecks the rightful request and preparation after conversation handlers; optional `before_provider_request` checks again without touching payloads or credentials. These are public checkpoints, not a firewall beyond the last supported hook. An unaccepted preparation fences only its original operation through public Abort, never a newer request or fallback inference.

Explicit controls and restoration retain their own cancellation. Only an Abort **issued by the stale-request guard** is not forwarded to a newer independent control that shares the ambient signal; real user Abort still withdraws its owned wait. Idle projections are observational. Fresh Off requests remain native-only without canonical/source reads, and later Abort never rolls back accepted preparation or mode publication.

### Native response callback ownership

Check physical owner and operation before assistant/user events can finalize a batch, observe the run anchor, claim/cancel an answer or end a turn. Foreign `message_end` and `turn_end` cannot spend rightful work. Active reconciles the actual finalized answer from `turn_end`, including post-handler changes and empty clearing. Recheck capture and end contexts against the **captured operation signal** and physical identity across publication waits, including after the turn table ends; replacing signal A with live B is not authority. Stale completions do not publish or report stale diagnostics. The [response contract](architecture.md#run-preparation-and-answer-reconciliation) owns the accepted effect.

See [native request witnesses](temporal-acceptance.md#native-request-ownership-and-correlation) for SDK sequencing, injections and proof limits.

## Read surface

### Selected observational diagnostics and projector admission

Status separates **requested** from **materialized** owners. Explicit `StatusDiagnostics.selection` requires exactly those sparse state keys and nonnegative safe-integer revisions/tail counts for an available view; null/malformed selection refuses. Omission retains all-three compatibility and its optional overlay override, never infers a subset. Explicit status ignores that override. It reports only selected keys, counts, footprints and revision components (`c4`, `g7s4`), using lineage depth, not the number of visible patches. Excluded notices are filtered before path/reason access; unavailable observations read no semantic/vector/notice bodies and fabricate no head, JSON or zero revision. Footprints show present plane sizes and same-owner intent-owned tactics/lazy shares; memory-bearing flags still mean strategy/tactics.

Compact Off status returns without inspecting memory, metadata or colors. Detailed status renders supplied observations but cannot load or authorize memory. [Operator inspection](usage.md#status-and-controls) owns disposable reads, Effective availability and stale Telegram callbacks.

The [context projector](architecture.md#model-context-presentation) receives one admitted effective view, selected-only recent patches and ancillary evidence, not a second selection engine. Project through `projectStateForModel` before freezing a handoff; never pass a raw lazy-bearing overlay. A changed selection revokes old contributions and rebuilds projection from newly admitted values. Projection cannot authorize a cache or filter one supplied under the wrong policy.

### Selected temporal value algebra

`SelectedTemporalState` holds canonical selection, exactly its streams, retained lineage and metadata-only `causalBasis`. It has no excluded placeholders, values or revisions. `selectTemporalState` validates the source, restricts it and preserves causal identities and owner revisions; it cannot expand by inventing streams. Pure projection of a full cohort still validates that source, so it does not prove disabled-body independence at the storage boundary. Advancement/folding touch only selected streams.

An excluded-only boundary carries its exact transition triple and a nonempty canonical owner witness set derived from real source patch identities or validated prior witnesses. This is sufficient proof, not necessarily the whole write set. No private value or patch body travels with it. Missing proof, incorrect position/parent, selected-owner, duplicate/redundant or projection-token claims refuse. Folding trims witnesses outside the hot window without changing revisions.

`createSelectedTemporalState` needs explicit values for exactly the selected owners. `adoptSelectedTemporalStreams` takes validated current streams and preserves their values/revisions at one fresh origin, without invented aligned past. These algebra operations grant no I/O, origin, maintenance or publication authority.

### Read-only selected-cohort durable admission

`loadSelectedFileCohort` delegates to cancellable callback-scoped `prepareSelected`. It does not initialize, convert, publish, back up or install an accepted cache. Absent lifecycle/private authority is not a new-origin grant. Partial or orphan evidence refuses. The [admission matrix and proof dependencies](#explicit-proof-dependencies-and-inspection-exception) govern which bodies and regular-file/layout presence may be checked. Reserved `state.json` is a presence-only refusal probe, not a write target.

Baseline and V2 feed the same replay validator: a claimed selected owner needs its real patch; an excluded-only step needs an admitted witness. Optional claims can be absent only where replay already supplies proof. Byte/presence and physical identity checks do not authenticate writers. `SelectedFileCohort.basis` binds captured bytes, while `presence` binds existence/type. Recapture compares both and the selection, not unrelated excluded bytes; a receipt grants neither a native lifetime nor acquisition permission.

### Accepted selected runtime cache and reads

Only durable acceptance installs a detached accepted cohort; prepared/observed data and returned receipts are not installers. An abandoned, cancelled or refused operation leaves the accepted cache intact; later failure cannot undo accepted memory. [Observation ports](#selected-read-only-observation-ports) use a separate cache variant.

- `read` returns default-bearing materializations, `readView` sparse values. Defaults are never stored overrides. `selectedStates` returns exact present owners and frozen selection; `selectedView` returns the detached accepted temporal view, not file receipts.
- `artifactProvenance` returns detached evidence only for an admitted owner. `causalBasis` identifies the readable lineage, not publication authority. `recent()` lists only actual selected patches; excluded-only witnesses still occupy history offsets.
- Cached reads do not poll disk or maintain sources. `clearCache()` withdraws reads and cache-bound leases without I/O, retaining sticky session/private authority. An accepted current-head operation, not a returned receipt or weaker observation, can reload that cache.

### Selected semantic query admission

The [model-tool contract](architecture.md#model-tools) owns paths, projections, batch errors and the distinction between confirmed absence and unavailable memory. Selected ownership is explicit; malformed/missing selection cannot widen a selected envelope to all three. Excluded locators fail before owner-body access, even in history or a value-batch error slot; an excluded patch owner rejects the atomic request. No hint, recent patch, lazy navigation, acquisition notice, cascade or receipt exposes excluded values or diagnostic owners. Stored cross-owner references remain data, not lookup, hydration or relocation rights. Reactive reverse lookup is bounded, structured-before-text and limited to current selected roots; it scans no other history, parents or source bodies.

History overlays the **current selection at the original proven boundary**, not the former selection. A required unavailable owner makes the effective historical read unavailable, never partial or substituted with current values. Patch projection distinguishes a proven excluded-only/no-op step from a folded or unprovable delta. Without a retained predecessor, refuse a delta for a changed selected owner; do not guess `{}`. Own-property-safe delta construction retains keys such as `__proto__`, `constructor` and `prototype`. Re-enabling reads current authority; fresh origin adoption may lose earlier aligned offsets, never recreate them.

Scope selection constrains new memory contributions, not confidentiality: Pi's already-retained conversation, tools and foreign context are not erased. See [selected read witnesses](temporal-acceptance.md#selected-read-and-projection-witnesses).

### Selected model protocol and grammar boundary

Active/bootstrap and Passive guidance derive from the **captured** policy, not later defaults or the possibly smaller materialized view. They name participating read/patch targets, exact-owner artifact routes and reference examples. Without Session, deliver the ordinary answer without capture, backfill or relocation; admitted legacy shared responses remain read-only. The packaged [State Flow Skill](../skills/state-flow/SKILL.md) follows the same boundaries.

Tool declarations describe grammar; runtime admission determines participation and authority. A schema name, example or source-owner mapping cannot authorize an excluded owner. Generic argument/result shapes live in the [model-tool contract](architecture.md#model-tools).

## Publication and semantic staging

See [runtime transaction APIs](architecture.md#runtime-transaction-apis) for live authoring versus captured replay, and the [storage transaction](architecture.md#asynchronous-storage-transaction) for exclusion, exact CAS and guarded rollback. [Publication witnesses](temporal-acceptance.md#22-current-head-atomic-model-publication) map both layers to tests.

### Guarded selected-cohort publication

`StorageTransaction.publishSelected` (or `publishSelectedTemporalStateToFiles` in a fresh transaction) recaptures the existing basis and independently derives the allowed successor by folding and optionally replaying one accepted transition. A supplied `view` must match it exactly; invented values, transitions or witnesses and even excluded-owner no-ops refuse before backup or writes. Neither entrypoint grants origin, acquisition or copy authority. Current-session acceptance uses the same successor planner without trusting candidate values.

The optional lifecycle input is limited to mode and run fields (`step`, `specification`, `bootstrap`, `validation`), not source identity, selection, acquisition or history claims. Preserve opaque admitted metadata and private authority; derive lineage and witnesses from replay. Predicted receipts must decode to the exact successor **and** matching provenance before publication. Excluded owner files remain byte-identical. Only owned acceptance can perform a descriptor or lifecycle upgrade under the [exact-byte backup rules](usage.md#moving-a-store-and-supported-formats); [mode-only Passive](#accepted-selected-lifecycle-ports) is not that path.

### Selected semantic staging and commit

`stageSelectedScopePatches` and `stageSelectedScopedTransition` reuse one intent-first engine. Their `SelectedSemanticBasis` has exact nonempty acquired owner keys and valid finite semantic JSON. Refuse excluded patches before getters or acquisition iterables, including no-ops. Stage only selected state, hashes, cascades and provenance with detached canonical selection; do not normalize untouched owners. The [intent-ownership rules](lazy-state.md#intent-ownership) and [native response ownership](#native-response-callback-ownership) still apply: no new shared response, no model-authored response, and shared-only completion can finalize run fields without a semantic step.

`commitSelectedTransition` checks selection, causal basis and state hashes, then derives canonical-order replay from final staged values only. Install state and mark committed only after synchronous acceptance; a repeated successful commit never republishes. The legacy in-memory commit refuses selected stages.

### Selected semantic transactions and provenance publication

[Artifact routing](architecture.md#artifact-routing) owns source admission and maintenance. Staging does no source I/O. Excluded successful reads create no compilation obligation and their hash/fingerprint is not inspected; a known source owner still prevents relocation into another scope. Valid selected provenance updates publish with the semantic/lifecycle cohort, not in a second write.

`SelectedProvenanceUpdates` refuses excluded keys before getters and invalid/nonfinite evidence before writes. Merge deltas into the raw admitted registry, not a reserialized filtered projection. A removed registration retires its associated interpretable evidence; unrelated, unbound or opaque entries survive even if their keys resemble known fields. A provenance-only acceptance does not rewrite checkpoint/tail or advance owner revision or semantic step. File acceptance does not authenticate source freshness.

## Origins, acquisition and observation

Every origin or acceptance uses the same [store exclusion and guarded publication](architecture.md#asynchronous-storage-transaction). Captured selection, snapshots and source receipts are data, not permission. The host independently admits the operation and rechecks ownership after waiting; only one synchronous publication is allowed inside its callback. Only acceptance installs the detached cache; native policy is installed by the host. Closed run-field capture omits undefined optional fields (including finalized `validation`), not null counters/mode, malformed values, extra authority fields or caller-injected scopes.

### Explicit new shared-only origins

`withSelectedSharedOriginTransaction` requires genuinely new-session authority, Active/Passive and a shared-only selection. Missing permission, invalid mode/run fields or Session selection fail before creating an absent root. It checks the lifecycle pair and private file/layout **presence** before adopting selected shared streams; any surviving lifecycle/private evidence refuses a new origin. It does not read private bodies. Known lifecycle or acquisition survives cache clearing as a denial fact; a cold caller cannot reconstruct erased authority from absence.

For each selected shared owner, validate its complete checkpoint/tail/metadata triple or prove all three absent. Only an authorized absent owner starts empty at revision zero. Live values, revisions and provenance survive adoption to a fresh current origin, with allowed retention folding and no invented older aligned history. Excluded owners are not maintained. The new Baseline lifecycle is `unacquired`, with no Session files. If an authorized scope upgrade needs backup, include exact original bytes and separate presence dependencies; a failed write keeps the verified backup reusable regardless of the fresh origin UUID.

### Selected first-authoring origin routing

`withSelectedFirstPatchTransaction` captures selection before waiting and stages against an unpersisted origin: `shared-new` without Session, `new` with Session. The existing compiler/staging and ownership rules apply. Origin, lifecycle and the first accepted change publish together; a rejected draft leaves no empty persisted owner. An authorized no-op may accept lifecycle without a semantic transition, step or revision. The inner publisher expires even on callback failure; a late call cannot write bytes, install cache or mark a stage committed. A failure after acceptance cannot undo it.

### Explicit first Session acquisition

`withSelectedSessionAcquisitionTransaction` requires explicit permission, Active/Passive and Session participation. There are two independent-session cases:

- **`new`:** Both lifecycle and private semantics must be wholly absent, not lost or partially present.
- **`unacquired`:** Require admitted Baseline or V2, an exact recaptured byte/presence basis and unchanged source run fields at acquisition admission. Preserve physical identity and opaque metadata. A missing store, occupied/symbolic target, stale basis, orphan/partial evidence, `deferred` or `acquired` (including lost private files) refuses. Pending parent copy follows the [fork contract](fork-contract.md), not empty acquisition.

Acquisition itself creates an empty Session at revision zero, with no mutation. Only selected shared streams initialize or adopt, and no earlier aligned past is invented. Predicted receipts must reflect the new private presence before acceptance; ordinary replay cannot change acquisition claims. Acquiring an existing V2 origin writes Baseline with an exact-source backup and CAS.

In Pi, explicit Start may acquire a proven `unacquired` source; ordinary Active attachment cannot. Start preserves step and clears the old specification/validation through its normal activation authoring. An admitted first `state_flow_patch` can acquire and apply its patch in one publication instead, preserving source run fields except for the accepted change. The original request and physical caller/policy, not header data or arguments, grant tool admission. A native checkpoint failure after acceptance cannot justify replay.

### Selected current-session acceptance

`prepareSelectedCurrent` is a candidate, not a receipt. `acceptSelectedCurrent` recaptures exact selection/byte/presence dependencies under exclusion and derives its successor from canonical files, not caller-modified candidate values or identity. Missing stores remain absent; there is no parent lookup, new session or private acquisition on this path.

Validate streams, lineage and witnesses before testing alignment. A complete aligned selection preserves proven history within the requested retention limit. Independently valid shared drift or a newly selected wholly absent shared triple may require a fresh current origin; preserve current sparse values, revisions and opaque provenance, without inventing history or advancing a semantic revision. Partial triples, malformed/foreign evidence and failed private proof cannot use that route as fallback. Repeated aligned acceptance is byte-idempotent. Replay and current acceptance share the successor planner, including receipt validation, CAS and the exact backup for material V2 conversion.

`withSelectedCurrentTransaction` captures selection/history policy, rechecks host policy before waiting, under exclusion and before publication, and reads current lifecycle under the lock. The callback gets detached run fields, a lifecycle-only publisher and a third `SelectedRuntimePatchTransaction`. The two publishers share one use on the same basis and expire on callback return or throw. A shared-only owner can accept current memory and its first patch together without a separate origin. The author may update owned run fields; Off cannot accept memory.

### Acquired-private reselection proof boundary

`privateCausalBasis` is optional **causal proof only**, not values, locators, hashes or permission. V2 carries `{lineage, causalWitnesses}`; Baseline attaches claims to lineage boundaries. The proof is closed and acquired-only; every retained non-anchor step needs complete witnesses. Missing or malformed proof is not a default empty basis. Unknown ancillary metadata, including opaque `temporal`, is not repurposed; syntactic validation is not writer authentication.

- **Excluding acquired Session:** Retain the source lifecycle proof before accepting the requested, possibly realigned view. Do not open private bodies to construct proof; acquired presence is still mandatory. Insufficient proof refuses before writes.
- **While excluded:** Carry that proof through shared replay, folding and run acceptance. Mode-only Passive cannot mint, retire or repair it.
- **Re-enabling:** Validate real private replay/witnesses against the applicable retained basis before reconciling live shared streams. When source policy already selects Session, validate its active lineage instead of falling back to retained proof. An older separated source without proof can proceed only if private replay still matches current lineage. Presence, standalone parsing, Git and native bookmarks cannot recover a diverged proof.
- **After validation:** Only successful Session acceptance can retire redundant proof, after its target receipts validate. Observation cannot retire it. [Parent-current copy](fork-contract.md#selected-scope-copy-boundary) uses the same private admission under source CAS but never inherits the parent's proof as child identity.

### Accepted selected lifecycle ports

`selectedSnapshot()` returns detached accepted run fields and canonical mode. `retainedSelectedCheckpoint(mode?)` binds them to the accepted boundary and scopes in native v2; its optional mode is I/O-free bookkeeping, not authority or a substitute for a pre-runtime marker. Neither works from an observed cache.

[`persistSelectedPassive`](architecture.md#passive-persistence) requires an accepted cache and writes mode only. Use [current acceptance](#selected-current-session-acceptance), not this port, to adopt validated shared drift.

### Selected read-only observation ports

- **`refreshSelectedShared`:** Observe a nonempty selected Global/CWD subset at a volatile current-only origin. Validate exact present triples, including CWD identity; refuse partial, unsupported or symbolic evidence. CWD does not need Global. Do not inspect Session/lifecycle or excluded/source bodies.
- **`refreshSelectedCurrent`:** Validate current lifecycle and selected bodies, including required acquired-private presence even if excluded. Selected Session requires acquired proof. Proven aligned history remains available; valid drift may be observed current-only without publishing that origin. Omit planned empty shared owners when their files are proven absent. The result describes source run fields and mode, not installed native authority.

Both retain a detached observed view, never the accepted cache needed for checkpointing or publication. Capture cache identity before waiting and recheck the request before capture/install; cancellation, same-policy invalidation or supersession leaves prior data but does not reauthorize its projection. Accepted memory cannot be downgraded into observation. Neither path writes, clears a fence, acquires a parent/Session or repairs files. Off invokes neither automatically; explicit inspection uses a disposable validated reader.

Native Passive may observe selected shared memory before Session acquisition on a pre-runtime branch or a validated `unacquired` expansion. This is not fallback after failed acquired/deferred/fenced proof. Sample the current independently requested mode after reading the header; Off cancels. Header and shared reads are not one acceptance; Session-only may have no view. Existing shared files can reach the first provider after entry/reload; a later disk change needs fresh observation, not a turn-time poll. A later patch receipt is not proof of earlier provider visibility.

See the [origin and observation witnesses](temporal-acceptance.md#origin-acquisition-and-observation) for proof boundaries.

### Header-only lifecycle inspection

`inspectSelectedLifecycle` returns detached stored selection, private acquisition disposition and filtered source run fields. It validates the lifecycle pair and private presence under the store mutex without opening semantic bodies, changing bytes, creating a root or installing a cache. A missing pair is distinct from malformed, partial, foreign or unsupported evidence. Cancellation or changed host ownership withdraws the inspection. A successful observation establishes only denial facts: known lifecycle/private authority later lost or downgraded cannot be treated as an empty origin. The boolean current-authority check uses the same admission. None of these values is a checkpoint, publication or acquisition capability.

## Forks

The [fork contract](fork-contract.md) owns child deferral, direct-parent copy, cancellation and no-recopy rules. Scope selection determines which owners participate; it does not authorize acquisition. The same [admission matrix](#functional-acceptance-boundary) applies to fresh and restored child policy.

## Native integration

### Configured scope defaults and native capture

`config.ts` validates `scopes` with the shared selection decoder. A missing property means all three; malformed present values fail with a fixed diagnostic, not the input payload. New and first-upgraded native attachment capture a concrete owner-bound v2 policy **before** memory acquisition. A failed acquisition cannot cause a later reload to resample wider defaults. Capture installs no cache, clears no write fence and grants no origin permission. An Off fork inherits the source branch choice in detached child-owned bookkeeping without reading the parent header.

The native adapter uses the same selected runtime for every captured set. If retained policy requires Active and its admission fails, recovery may classify the newest understood mode header without evaluating record getters or admitting semantic data. An older Active record cannot outrank a later understood Off mode because its bookmark is unusable. Unaccepted explicit Start is different: it cannot replace the previous lifecycle or poison independent Passive work. Legacy Stop still treats an invalid optional `from` as absent when `at` is valid; v2 does not inherit that leniency.

### Public mode-command scope overrides

The three [mode commands](usage.md#lifecycle-operations) accept optional canonical owner tokens. The entire input validates before side effects; completion offers unused owners for the full prefix. A blank or canonically equal choice uses the mode-only route and does not revoke independently owned same-scope work. A genuine reselection revokes old work and uses the existing owned restoration/activation route; Off records native policy only and cannot append an old-selection checkpoint as new acceptance. Native tree attachment is a superseding event even if the resulting set equals the old one.

[Passive persistence and recovery](architecture.md#passive-persistence) govern equal-policy repeats and pending attachment; neither policy DATA nor requested scopes imply materialized memory.

### Canonical continuation provenance inspection

The known-header advisor reads config/runtime first, pins those bytes through read-only selected admission, and cannot activate a session. The early byte check prevents a changed lifecycle version from widening inspection. The [lifecycle proof dependencies](#explicit-proof-dependencies-and-inspection-exception) still apply. It neither inspects native Off/Stop policy or transcripts nor initializes, converts or publishes; cancellation does not become a fallback recommendation. Native startup intent remains with the host.

### Selected source attribution

Native callbacks check the original tool ID/name/lifetime and physical caller before source input, tracking, hints or barrier attribution. The raw idle-host path requires no active request/operation signal. A foreign completion cannot consume valid evidence; compiler admission precedes any rehash. The policy selection binds request and Skill tracking even on an unchanged tool loadout. Ordinary planning uses available validated owners, while locked missing-source maintenance uses its transaction's selected set. [Artifact routing](architecture.md#artifact-routing) owns exact-path, exclusion and provenance rules.

Native rehydration emits phase metadata only. The pure planner filters excluded routes before reading fields, sorting or allocating budget; it does not execute source reads or publish.

### Retained native-seven-selection integration

The native adapter supports all seven selections for Active and Passive, including public scope arguments and mode-only Telegram actions. Core, fork, source/Skill, cancellation and shared-peer SDK witnesses are indexed in [temporal acceptance](temporal-acceptance.md#native-seven-selection-integration). Earlier experiments with an all-three-only guard, policy-DATA test adapters and candidate builds are [historical evidence](README.md#historical-semantic-evidence), not current admission gates.

## Authority and acceptance

### Functional acceptance boundary

Requested mode and scopes are policy DATA. They are distinct from the values actually available for projection, the accepted physical lifecycle/causal basis, the private acquisition disposition, and the request or operation lifetime. A branch can ask for Session without acquiring it. An observed view grants no source access, private acquisition or publication; status never pads missing owners with empty values or zero revisions.

The table lists **semantic bodies eligible for ordinary Baseline or lifecycle-V2 admission**, not a promise that they exist or are already accepted. The proof dependencies below govern stricter cases.

| Wanted selection | Eligible shared bodies | Session boundary |
| --- | --- | --- |
| `global` | Global | Excluded |
| `cwd` | CWD; no Global body needed | Excluded |
| `global cwd` | Global and CWD | Excluded |
| `session` | None | Prove current private authority or admit explicit acquisition |
| `global session` | Global | Same private proof |
| `cwd session` | CWD; no Global body needed | Same private proof |
| `global cwd session` | Global and CWD | Same private proof |

- **Off:** Automatic callbacks keep only native policy, continuation and pending-fork bookkeeping. They do not acquire memory or expose State Flow tools/context. Withdrawal cancels owned pending work without undoing accepted bytes. Explicit inspection is separate.
- **Passive:** Both tools are declared subject to host permissions; context requires a validated view. Independently admitted shared observation can expose just the available shared owners while Session remains unacquired. It neither initializes files nor grants private/fork authority. An explicit admitted patch can establish authorized ownership; observation cannot clear a write fence.
- **Active:** New admission or a real selection change needs coherent current acceptance before inference. A pending Off→Active proposal does not install Active or memory; an unavailable retained Active policy stays visibly blocked rather than sending native history or an old wider view. New responses are captured only for participating Session; shared-only completion finalizes the run without a hidden response write. Re-enabling Session shows the last genuinely captured response, not a backfill; Passive omits response from automatic context and native text is not redacted.
- **Reload, tree and fork:** Accept current same-session memory, not the Pi-step bookmark. A genuinely new child without selected Session defers its private copy. Later authorized acquisition requires its proven direct parent and current private bytes; an acquired child always uses its own state. Missing proof does not become a fresh origin or authorize ancestry scans.
- **Reads and writes:** Use [model tools](architecture.md#model-tools) for flat versus scoped forms and errors. Excluded bodies, provenance and source routes do not become model data or writable targets. History uses the current selection at the proven boundary; if a selected owner cannot materialize there, do not substitute current data or return a partial overlay. The [publication contract](architecture.md#asynchronous-storage-transaction) governs atomic writes and exact CAS. Changing mode or selection alone advances no semantic identity or revision; accepted memory survives subsequent cancellation or ancillary bookkeeping failures.
- **Lifetime:** Canonically equal choices preserve independently owned work; changing away and back does not revive it. Original tool/operation, physical owner and captured policy checks govern publication and projection, not the current schema or projection ID. A foreign source callback skips State Flow attribution rather than banning the native read. See [artifact routing](architecture.md#artifact-routing) for exact source, fingerprint and hash rules.

### Explicit proof dependencies and inspection exception

- **Retired lifecycle V1:** Selected admission refuses before reading semantic owner bodies. Neither automatic healing nor empty/new origin initialization is allowed. Use a previous compatible State Flow release to access that session. Pi and the library share this refusal.
- **Baseline and lifecycle V2:** Ordinary selected admission opens selected bodies and provenance plus config/runtime. Excluded acquired Session still requires regular-file/path-chain presence of its private triple, not body reads; unacquired and deferred targets require absence. The lifecycle-owned private causal basis binds retained private authority across exclusion. Neither header observation, missing files, a zero revision nor a mode change can mint that proof. Required malformed, partial or foreign evidence fails closed; visible recovery is separately governed by [filesystem recovery](filesystem-recovery.md).
- **Explicit operator inspection:** Telegram follows the wanted selection, not sparse availability. Effective is offered only for two or three owners and reads that selection. Session/current proof requirements still apply when inspection requests private memory. Disposable Off reads publish or install nothing, clear no fence and acquire no private memory. No automatic Off access or confidentiality guarantee follows.
- **Unsupported formats:** The [current format policy](compatibility.md#canonical-scope-format-admission) governs retired scope versions, unsupported writers and conversion prerequisites.

### Current scope-aware presentation

`StateFlowTelegramSnapshot.scopes` carries detached wanted DATA; an omitted legacy embedding field keeps all-three presentation, while malformed explicit DATA rejects. Mode buttons preserve selection; there is no scope chooser. The SDK/adapter tests cover selected presentation and callback lifetimes, not real Telegram delivery, rendered devices, universal filesystem nonaccess or live model quality. See [public scope controls and mode-only Telegram](temporal-acceptance.md#public-scope-controls-and-mode-only-telegram) for the test map.
