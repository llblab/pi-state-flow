# State Flow architecture

## Purpose

State Flow is a Pi extension that materializes compact, scoped semantic state across agent runs while preserving Pi's native session trace and tool loop. It is inspired by SKILL.state but uses its own temporal model, storage plane, artifact compiler, and publication lifecycle.

The extension owns durable memory while enabled. Global semantic memory is always available; there are no ownership or global-memory feature switches.

## Composition

`index.ts` is the public export and extension composition boundary. Independent modules under `lib/` own one concern each and are mirrored by tests:

- `state`, `json`: semantic shape, validation, recursive overlay and deletion.
- `temporal`, `history`: causal boundaries, checkpoint/tail folding and hot history.
- `durable`, `storage`, `git`: exact files, CAS publication, Git commits/restoration, and owned push processes.
- `snapshot`, `session`, `runtime`, `recovery`, `episode`: Pi branch/runtime lifecycle.
- `transition`, `terminal`, `context`: inference barriers, turn resolution, passive projection, and response reconciliation.
- `artifact`, `acquisition`, `maintenance`, `skills`, `rehydration`: source routing and compilation.
- `memory`: external promotion records and memory diagnostics.
- `continuation`: native-header discovery, runtime-provenance inspection, deterministic recommendation, and host startup precedence.
- `publication`: remote policy, durable CAS queue/store, cross-process leases, and attempt outcomes.
- `status`, `telegram`, `extension`: operator projection, the optional fail-open pi-telegram presentation adapter, and Pi adapter wiring.

## Semantic state

Every materialized scope has exactly this shape:

```json
{
  "artifacts": {},
  "contract": {},
  "working": {},
  "response": ""
}
```

- `artifacts` maps exact source paths to compiled routing metadata.
- `contract` retains durable requirements, decisions, interfaces and rejected approaches.
- `working` retains verified current facts, unresolved work and exact continuation.
- `response` is the latest complete user-facing answer for the session scope.

Effective state recursively overlays:

```text
global → CWD → session
```

Later scopes win. A scope-local `null` deletion removes only that scope's key and may reveal an inherited value. Scope represents applicability and ownership, never instruction authority.

State Flow is the memory owner while enabled. Cross-project/user/environment knowledge belongs in global state, project-only knowledge in CWD, and branch/run continuation in session. Global availability is not a feature switch and does not authorize secrets, raw history, transient progress, speculative clutter, or unsupported assertions. Explicitly uncertain hypotheses remain eligible only when they can affect an open decision.

## Temporal model

All scopes participate in one active causal lineage. One accepted semantic transition receives one opaque identity shared by every changed scope. Sparse transitions do not create records for unchanged scopes.

Each scope stores:

```text
checkpoint.json + patches.jsonl
```

The checkpoint is an older anchored materialization. The tail contains at most seven effective patches. On overflow, the oldest tail patch folds into the checkpoint before the new patch is appended.

`state[n]`, `state.global[n]`, `state.cwd[n]` and `state.session[n]` resolve the same nth previous causal boundary. They are not independent per-scope patch counters. Pre-origin history is unavailable rather than empty.

A final-only `patch_state({"final":true})` call changes only ephemeral terminal eligibility and creates no identity, commit, or history step. A changed accepted response is runtime-owned semantic state and advances history.

## Pi lifecycle

`patch_state` is the sole mutation tool. It validates any supplied global/CWD/session patches against one causal basis and publishes them as one atomic transition, then acts as an inference barrier. Pi executes no sibling tools from the same assistant response; the next inference sees rematerialized `state[0]`.

Tool preflight follows Pi's public `getLeafEntry()` / `getEntry(parentId)` links to the nearest assistant containing the current call ID. It inspects that response's complete tool batch without constructing the whole branch or caching a batch across calls/selections. Foreign custom entries and earlier sibling results remain in the native trace. A missing call ID still searches the selected ancestry and preserves the existing unmatched-call behavior; this is not an unconditional constant-time guarantee. See [measured traversal evidence](performance.md#tool-preflight-parent-traversal).

`read_state` reads one cached effective or scoped projection at offsets zero through seven. It never publishes or advances history.

Every enabled assistant iteration starts terminal-ineligible. Only a successful `patch_state` call containing `final:true` latches eligibility for the next accepted `turn_end`; the call may atomically include global, CWD, and session patches. Eligibility does not stop later reasoning, tools, or patches. If terminal prose arrives before eligibility, State Flow preserves that draft and reconciles it into runtime-owned `response` at `turn_end`, then starts at most two same-run fallback turns whose only purpose is the `final:true` patch. The same path covers an eligible draft whose final validation fails after a later acquisition. Fallback turns never become the response: a successful `final:true` commits its patches and closes resolution with the preserved answer intact, while two failed fallbacks close the iteration with the preserved answer and current state plus one bounded warning and a finalization diagnostic. Failed patch calls do not consume the budget. A following legal patch remains possible, and only an accepted ordinary answer is reconciled into runtime-owned `response` at `turn_end`. State Flow no longer parses `state_flow` or generic HTML comments; historical comments are ordinary text and other extensions retain their own comment handling.

## Lifecycle planes

```text
SEMANTIC STATE       artifacts + contract + working
TURN ELIGIBILITY     false → patch_state(..., final:true) → latched true
CONTEXT PROJECTION   active State Flow projection | passive post-stop handoff
```

Stopping State Flow immediately disables semantic tools and switches projection to a frozen effective-state handoff, the active user-run trajectory if interrupted, and post-stop conversation. Paired tool results arriving after Stop remain visible. Foreign context-bearing custom messages survive; completed earlier conversation and private State Flow validation feedback do not. This projection survives same-physical-session reload, resume, and tree restoration. Active restart uses it for one migration run alongside active runtime context. New and forked physical sessions inherit neither projection. No semantic transition is created.

The existing native passive-stop marker stores the stop timestamp and an optional `from` timestamp identifying the active run's first user message. Transcript bodies remain in Pi's trace rather than being copied into another state store. Idle and legacy markers without that anchor retain only post-stop conversation plus foreign custom context. The system prompt is composed at `before_agent_start`; an already-issued prompt is not rewritten by Stop, and ordinary prompt composition resumes with the next user run.

The current user specification stays at user authority and appears only in synthetic user runtime context. State is fallible assistant-produced data. Completed trajectories leave model context at user-run boundaries, while Pi's full JSONL trace remains inspectable.

After a sufficiently large accepted non-bootstrap run settles with no queued input, State Flow may request a native manual compaction under a generation-private marker. Pi still owns preparation and admits the boundary only when its configured `keepRecentTokens` leaves compactable history. The extension supplies no model-generated summary or state body: it keeps the final accepted assistant entry and records the exact durable revision/step in compaction details. `buildContextEntries()` then omits the older completed prefix for active context and resume rendering while the append-only JSONL/tree remains intact. Small histories, foreign custom context in the proposed prefix, stale selection, Stop/bootstrap/fallback/error/abort and pending input do not produce this boundary. User manual and native threshold/overflow compaction remain unmodified; in-progress work not yet accepted into State Flow stays under Pi's native compaction contract.

The Pi adapter passes its raw cached scope overlay to `runtimeContextMessage`, which owns model sanitization of the current state. It does not pre-project that input. After anchor selection, `currentRunTrajectory` selects retained messages into one array without copying discarded ordinary prefixes: foreign custom messages survive at any position, while ordinary messages survive only from the selected run anchor and State Flow's private feedback is excluded. The necessary foreign-context scan and Pi's earlier native-message clone remain history-dependent. See [context-cost evidence](performance.md#context-projection-and-trajectory-selection).

## Storage and identity

The default store is `<agentDir>/state-flow`, independent from Markdown discovery at `<agentDir>/knowledge`.

Owned paths are:

```text
checkpoint.json
patches.jsonl
meta.json
<cwd-key>/checkpoint.json
<cwd-key>/patches.jsonl
<cwd-key>/meta.json
<cwd-key>/<session-key>/checkpoint.json
<cwd-key>/<session-key>/patches.jsonl
<cwd-key>/<session-key>/config.json
<cwd-key>/<session-key>/meta.json
```

CWD and session keys mirror Pi's native encoding. The Pi UUID remains authoritative; readable directory keys never replace identity validation.

Session `config.json` owns branch runtime behavior. Scope `meta.json` owns runtime artifact provenance for its scope; the session file additionally owns lineage, counters, identity, publication provenance and remote-publication policy. Pi checkpoints retain only an exact Git revision, an exact `file:<hash>` cohort reference, or a proven ordinary-disabled marker.

All owned writes use same-directory atomic replacement, regular-file and symlink checks, prepared byte receipts and CAS validation. Unrelated files and detected concurrent bytes are preserved; Git staging follows the acceptance contract below. Rollback restores only bytes still matching the failed publisher's output.

## Optional Git

If Git is unavailable specifically through executable `ENOENT`, State Flow uses file-only persistence. File mode retains exact current materialization and proven hot history but offers no arbitrary cold revisions.

With Git, each effective semantic cohort creates one local commit immediately through an isolated index that stages the complete non-ignored worktree delta before overlaying the exact prepared State Flow outputs; the caller-visible index is synchronized to the committed tree afterward. Each prepared content is still hashed separately from its supplied bytes, never substituted by mutable worktree reads or filtered staging. Prepared blobs enter the isolated index through one NUL-delimited `update-index --index-info` batch, preserving literal path characters; explicit removals retain their existing path. Any failed batch aborts before reference publication and follows the same exact-output rollback and temporary-index cleanup. Activation returns after local runtime acceptance for normal `turn-end`/`off` policy, skips full predecessor migration planning when the three legacy snapshot names are absent, and defers Markdown discovery until the next enabled inference. State Flow-owned active files keep compare-and-swap protection, and `.gitignore` stays authoritative. Git supplies cold history and exact branch restoration. Runtime `revision: "self"` resolves to the commit that owns the runtime record, never arbitrary `HEAD`. Runtime-only writes may use `temporalRevision` to select older semantic streams and their matching artifact provenance. They update the current session's config/meta without rewriting live shared checkpoints, tails, or provenance.

Branch recovery validates immutable selection before live publication acquisition. `TemporalRuntime.prepareRestore` returns a detached snapshot and an instance-bound, single-use restoration closure. For an exact matching Git owner, that closure reuses the validated cohort and provenance rather than decoding them twice; it still captures the current publication basis under exclusion before installing any runtime fields. Expired file cohorts, legacy snapshot fallbacks, and references redirected to another runtime owner take the fresh-read path. A consumed or failed preparation cannot be replayed, and neither the mutable inspection snapshot nor an old publication basis can become restore authority. This is bounded reuse within one selection, not a cross-session revision cache.

Cold temporal reconstruction and semantic publication anchoring share an operation-local Git reader. One NUL-delimited tree query lists exact owned canonical/fallback paths at the selected immutable revision, with literal path handling independent of inherited pathspec settings. Only actually selected files receive regular-blob mode/uniqueness validation and content reads; unused fallback blobs cannot become authority over canonical files. Repeated reads of the same path reuse that immutable result only within the operation. Selected state/runtime blob reads explicitly bypass Node's implicit 1 MiB subprocess-output budget, which otherwise makes valid large checkpoints/tails/metadata unreadable. Other Git commands retain their ordinary output policy; the 15-second command timeout and normal memory/materialization limits remain. Complete catalog framing, selected-file validation, fresh live bases, and publication CAS remain required; no worktree checkout, semantic byte cap or durable read cache is added.

Publishing from a restored branch reconciles shared state by adoption rather than rejection: an untouched global/CWD scope whose live stream advanced is adopted at a fresh proven origin together with the selected session stream, while a shared scope the accepted transition actually changes must still match its selected basis or fail closed naming that scope. Adoption preserves causal validity, invents no parent links or semantic transitions, never rewinds live shared files, and leaves older lineage available through Git. Publication CAS rejects any change made after the reconciliation capture.

Installing Git over a file-only store adopts the exact current cohort without fabricating earlier history. Legacy layouts remain read-only historical inputs until explicitly migrated.

## Remote publication

Local acceptance and remote replication are separate.

The persisted `remotePublication` policy is:

- `turn-end`: default for new runtimes; local commits are immediate and the newest turn target is queued.
- `off`: local commits only.
- `transition`: synchronous compatibility behavior for legacy runtimes.

A destination is identified by canonical Git common directory, remote and full ref. Queue files live beneath the Git common directory and are not semantic history.

The queue uses exact scalar-string commit targets/confirmations, strict versioned JSON, symlink-safe atomic writes, CAS receipts and exclusive writer locks. Coercible non-string values are rejected at construction, parsing/serialization, coalescing, confirmation, and asynchronous push boundaries, before ancestry or push effects; malformed persisted records remain untouched. A proven descendant may supersede an older target; a journal lineage rewrite retargets the live commit and records the retired target, while changed destinations fail closed.

After accepted response reconciliation, an asynchronous non-interactive worker pushes the newest target. Queue failure never rolls back semantic state or regenerates an answer. Failed and interrupted attempts remain retryable across restart. Destination-scoped worker leases use exclusive creation. Dead-owner reclamation rechecks a fully validated regular-file record and PID liveness under the existing queue writer lock; only an `ESRCH` result permits reclamation. A fresh claim may win the removal/creation gap and must survive. Release requires the current process's PID and exact token, without waiting for queue writers. Malformed and symlink records are preserved; an occupied or interrupted writer gate defers reclamation rather than authorizing lock deletion. Confirmation removes only the exact completed target; a newer descendant remains queued.

`git.pushGitTarget` owns each asynchronous push with the existing 15,000ms Git command budget, ignored stdin/stdout, bounded diagnostic stderr, and non-interactive credentials. Timeout/cancellation sends `SIGKILL` to its POSIX process group while the owned leader is live; Windows terminates the direct child. The child handle remains referenced, and the promise settles only on process/stdio closure or proven spawn failure. A diagnostic pipe outliving its leader is closed on cancellation/deadline rather than extending the wait indefinitely. Helpers that escape or outlive the process group are not a general process-tree containment guarantee.

`extension` owns one abort controller and completion promise per destination worker. `session_shutdown` permanently closes that generation to new launches, cancels its children, and waits at most 2,000ms for the whole cohort. Late results cannot acknowledge/fail the queue or recursively relaunch; only lease cleanup remains allowed. If OS termination is unconfirmed at the wait deadline, emit a warning and keep ownership until actual exit. Filesystem cleanup failures remain fail-closed. A subsequent generation or activation can retry the same durable target once the lease is available. These policies require the owning Pi process and event loop to remain live: abrupt host death, blocked scheduling, and uninterruptible OS I/O are outside the deadline guarantee. Leases identify the Pi worker PID, not an independently supervised child after host death. Synchronous compatibility publication is unchanged.

## Artifact routing

Markdown discovery runs after activation and before its next enabled inference. It recursively finds regular lowercase `*.md` beneath the configured Knowledge root, rejects symlinks, hashes opaque bytes and never injects source bodies. It rechecks retained canonical in-root Markdown paths for proven absence; external, non-Markdown, and symlink paths are outside removal ownership. A missing whole root preserves state and reports unavailable freshness. Status and restart re-derive removals from the retained registry rather than consuming an in-memory event. The generic `planArtifactInvalidation` helper takes explicit `options.removed`; a partial candidate set alone authorizes no deletion.

A model-visible artifact entry requires only a description:

```json
{
  "description": "routing summary",
  "compilation": {}
}
```

Runtime-owned freshness evidence is retained per scope in `meta.json` as `{sourceHash, compilerRevision, compiledAt}`. At artifact-entry level, every model scope patch rejects authored `hash`, `compiler`, `compiled_at`, `sourceHash`, `compilerRevision`, `compiledAt`, and `source_hash_verified` fields, including field-deletion markers, even without a preceding read. Retained legacy evidence stays readable; ordinary semantic edits and whole-artifact deletion remain valid. Compiler output may add other finite non-null JSON metadata; known optional semantic fields include `kind`, `tags` and `compilation`. Tags are unique trimmed non-empty strings and support deterministic candidate filtering, but never authorize reading.

Freshness derives capabilities from available evidence: new sources require compilation, `sourceHash` detects source changes, `compilerRevision` detects compiler changes, and `compiledAt` drives age-based maintenance. Missing provenance degrades to unknown freshness instead of forcing migration; malformed present evidence fails closed only for the capability that depends on it. Exact successful native Pi reads are correlated with current candidates; stale reads require same-path compiler output before provenance is recorded in the same durable cohort.

Compilation is routing, not a substitute for source text. Full source is read only for a concrete unresolved gap, exact source/edit operation, invalidation, contradiction/failure, explicit request or bounded maintenance. The rehydration planner supports new-bootstrap, resume-bootstrap and later-step phases while limiting read count and source bytes without performing hidden I/O.

Skills are CWD artifacts with stricter compilation: `kind: "skill"` and a non-empty compilation describing applicability, constraints and failure conditions. Their source bodies do not persist in state. Matching provenance proves source-version consistency, not semantic fidelity, truth, or higher instruction authority.

## Memory curation and promotion

The optional packaged `state-flow-memory` Skill performs bounded explicit audits, scope narrowing, contradiction cleanup and external handoffs. It is not part of ordinary retention or background maintenance. Curation compiles a read Skill at CWD before accumulating global compilation obligations, writes and separately reads a migration destination before source deletion, then verifies the changed scope and effective overlay. Simultaneously pending CWD/global acquisitions must be compiled together in one atomic `patch_state` call. Destination write, readback, and source deletion remain separate migration steps so accepted-copy verification is not skipped.

External promotion remains a semantic two-phase handoff, not a memory-owner mode. Optional global `working.memory_promotions` entries record `pending`, `accepted`, `failed` or `unknown` status plus owner. Accepted records additionally require destination pointer and revision. Failed or uncertain promotion preserves the State Flow candidate; the only accepted copy is never deleted.

## Session continuation

The package exposes read-only host contracts that:

- read only native JSONL headers, never transcript bodies;
- inspect exact file/Git State Flow runtime provenance without mutation;
- rank exact profile, CWD, Git common-directory, worktree, branch and transport identity;
- fail closed for stopped, malformed, unavailable or ambiguous candidates;
- preserve explicit new/resume and native picker precedence;
- project new-bootstrap, resume-bootstrap and later-step rehydration phases.

Both [tested Pi SDKs](compatibility.md) choose or create `SessionManager` before package resources and extensions load. Therefore native default auto-resume cannot be installed safely by this extension alone. The remaining host integration requires an upstream pre-session resolver hook or an SDK/launcher that invokes the advisory resolver before constructing the session.

## Model tools and embedding

### Model tools

`patch_state` accepts optional fixed `global`, `cwd`, and `session` semantic patches plus optional `final:true`. At least one scope or `final:true` is required. Supplied scopes contain only object-valued `artifacts`, `contract`, and `working`; omitted fields preserve their values, recursive object merge updates them, arrays/primitives replace, and nested object-key `null` deletes. Materialized null, empty supplied scopes, material no-ops, unknown top-level fields, model-authored `response`, and retired grammars are rejected. A final-only call changes ephemeral eligibility, not semantic history.

```json
{"session":{"working":{"next":"Verify the corrected behavior"}},"final":true}
```

`read_state` defaults to effective state at offset zero. It accepts one optional `scope` (`effective`, `global`, `cwd`, or `session`) and integer `offset` from zero to seven, returning `{offset, scope, boundary, state}`. It reads cached selected state without Git queries, publication, checkpoint append, or a semantic step. Pre-origin history is an error, not an empty state.

```json
{"offset":1,"scope":"cwd"}
```

Both tools follow branch enablement and host restrictions. The patch barrier also blocks reader siblings. These tools do not impose project schemas or state-size caps; semantic usefulness, scope choice, and compression remain model responsibilities.

### Embedding

The default extension factory accepts `StateFlowExtensionOptions`: `agentDir` selects the profile, `repositoryRoot` overrides the configured state store, and `knowledgeRoot` independently selects Markdown sources. `onRuntime` receives a cached `read(offset?, scope?)` accessor; omitted scope means effective state. Use it only after runtime initialization/restoration. The pure `readTemporalState(view, offset, scope?)` accessor is exported separately. SDK hosts with an explicit tool allowlist must include both `patch_state` and `read_state` when they want model access.

Honor Pi's `session_shutdown` lifecycle before disposing an embedded session. On both [tested Pi SDKs](compatibility.md), `AgentSession.reload()` emits and awaits shutdown, but bare `AgentSession.dispose()` only invalidates/disconnects the session. `AgentSessionRuntime` owns native new/resume/fork replacement and its asynchronous `dispose()` delivers quit shutdown; rebind each newly created session's extensions. An SDK host instead disposing a standalone `AgentSession` should first `await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`; ordinary Pi lifecycle owners already deliver the event. Without it, the push attempt budget still applies, but early cancellation and generation fencing are not notified.

Native replacement teardown and State Flow adoption are separate responsibilities. On a native fork start, the adapter verifies the direct parent header and selected source revision, then copies only the session stream/provenance into a distinct child owner over current live shared scopes. The child has a fresh origin and its own checkpoint, never a UUID alias or historical shared-state rewind. A child-owned native reset marker fences inherited passive Stop projection across reload. Parent-owned checkpoints selected later cannot fall through to an ordinary-disabled marker and reset child storage. See the [fork contract](fork-contract.md) and [operating limits](usage.md#fork-support-and-limits).

Agent configuration is read once per extension load; session runtime configuration remains branch-selected. See [configuration](usage.md#configuration) for settings and path precedence. Memory ownership while enabled and global availability are invariants, not configuration switches.

## Observability

Status is a projection of the selected runtime and semantic view, not a second store. Missing evidence stays unavailable instead of appearing empty. The optional Telegram leaf adapter reads the same snapshot and calls the same Start/Stop owners; registration is fail-open and disposal belongs to session shutdown. Local diagnostics stay outside semantic state, scope metadata, checkpoints, and publication, and failures cannot change accepted state. Operator-facing fields and privacy boundaries are in [usage](usage.md#status-and-controls).

## Validation boundaries

Structural validation proves JSON shape, exact identity, causal lineage, freshness, CAS and publication invariants. A valid state, receipt, source hash, or compiler revision cannot prove semantic importance, truth, sufficient compilation, correct scope, useful curation, or historical deletion. Those remain model-judgment concerns evaluated separately from deterministic transport checks.

The deterministic continuity and temporal evidence map is in [temporal-acceptance.md](temporal-acceptance.md). Release-scoped open work is in [BACKLOG.md](../BACKLOG.md), and shipped outcomes belong in [CHANGELOG.md](../CHANGELOG.md).
