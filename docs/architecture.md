# State Flow architecture

## Purpose

State Flow is a Pi extension that materializes compact, scoped semantic state across agent runs while preserving Pi's native session trace and tool loop. It is inspired by SKILL.state but uses its own temporal model, storage plane, artifact compiler, and publication lifecycle.

The extension owns durable memory while enabled. Global semantic memory is always available; there are no ownership or global-memory feature switches.

## Composition

`index.ts` is the minimal public export boundary. `lib/extension.ts` is the Pi lifecycle composition root: it wires configuration and domain capabilities into commands, tools, event subscriptions, and handlers while delegating imperative mechanics to their owning modules. Independent modules under `lib/` own one concern each and are mirrored by tests:

- `state`, `json`: semantic shape, validation, recursive overlay and deletion.
- `temporal`, `history`: causal boundaries, checkpoint/tail folding and hot history.
- `durable`, `storage`, `git`: exact canonical files, file-cohort CAS, and optional settled-turn backup.
- `snapshot`, `session`, `runtime`, `recovery`, `episode`: Pi branch/runtime lifecycle, branch traversal, and passive-boundary interpretation.
- `transition`, `context`: inference barriers, turn resolution, passive projection, and response reconciliation.
- `artifact`, `acquisition`, `skills`, `rehydration`: source routing and compilation.
- `memory`: generic memory-bearing scope diagnostics.
- `continuation`: native-header discovery, runtime-provenance inspection, deterministic recommendation, and host startup precedence.
- `protocol`, `logging`: model/tool presentation and bounded diagnostic persistence.
- `status`, `telegram`, `extension`: operator projection, the optional fail-open pi-telegram presentation adapter, and high-level Pi adapter wiring.

## Semantic state

Every materialized scope has exactly this shape:

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

- `intents` retains only chosen active commitments.
- `contract` retains durable requirements, decisions, interfaces and rejected approaches.
- `working` retains verified current facts, unresolved work and exact continuation.
- `artifacts` maps exact source paths to compiled routing metadata.
- `response` is owned only by the session scope and stores the exact latest accepted assistant answer, including the empty string. Global and CWD retain the required key as an empty structural placeholder so canonical scopes keep one shape; the effective overlay receives `response` only from Session.
- `lazy` is a required object root for ordinary JSON detail, omitted from baseline model state and read explicitly.

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

The checkpoint is an older anchored materialization. The tail contains at most the configured `historyLimit` effective patches. On overflow, the oldest tail patch folds into the checkpoint before the new patch is appended.

Persisted streams and lineage are validated against the format maximum before applying a newly configured lower limit. Restore/reload/fork accepts only boundaries inside the configured window, then folds excess scope tails during canonical origin acceptance. That representation-only folding preserves selected private state and current shared values/provenance; a fork never rewrites parent-private files. Zero keeps only current checkpoints, and a later increase does not reconstruct discarded records or lineage.

`effective[n]`, `global[n]`, `cwd[n]`, and `session[n]` resolve the same nth previous causal boundary; the history index remains a composed-lineage offset, not a scope revision. Separately, each materially changed owner advances its persisted semantic revision once. Global and CWD counters remain shared across their canonical writers, Session remains private, and Effective is identified by the current `G#/C#/S#` revision vector. The retired top-level `state` segment is rejected; pre-origin history is unavailable rather than empty.

A changed accepted response is runtime-owned, session-only semantic state and advances history. An accepted empty answer becomes `""` and finalizes normally rather than producing a recovery error. Ordinary completion requires no `patch_state` call when durable semantic state is already correct.

## Pi lifecycle

`patch_state` is the sole mutation tool. It validates any supplied global/CWD/session patches against one causal basis and publishes them as one atomic transition, then acts as an inference barrier. Pi executes no sibling tools from the same assistant response; the next inference sees the rematerialized current effective state.

Tool preflight follows Pi's public `getLeafEntry()` / `getEntry(parentId)` links to the nearest assistant containing the current call ID. It inspects that response's complete tool batch without constructing the whole branch or caching a batch across calls/selections. Foreign custom entries and earlier sibling results remain in the native trace. A missing call ID still searches the selected ancestry and preserves the existing unmatched-call behavior; this is not an unconditional constant-time guarantee. See [measured traversal evidence](performance.md#tool-preflight-parent-traversal).

`read_state` reads one cached effective or scoped projection at current index zero or a retained causal index through the configured `historyLimit`. It never publishes or advances history.

Before answering, the model uses `patch_state` only when future-relevant durable state must change. The exact accepted ordinary answer is reconciled directly into runtime-owned `response` at `turn_end`, including `""` when the accepted answer is empty; no terminal eligibility latch, finalization patch, repair inference, or fallback budget exists. If required ordinary-artifact compilation prevents reconciliation, State Flow reports the failure without generating another inference. Optional Skill acquisition never blocks unrelated reconciliation. State Flow does not parse `state_flow` or generic HTML comments; historical comments are ordinary text and other extensions retain their own comment handling.

## Lifecycle planes

```text
SEMANTIC STATE       intents + contract + working + artifacts + response + lazy
MUTATION BARRIER     patch_state(scope patches) → rematerialized next inference
CONTEXT PROJECTION   active State Flow projection | passive post-stop handoff
```

Stopping State Flow ends active episode semantics, restores the configured passive tool policy, and switches projection to a frozen effective-state handoff, the active user-run trajectory if interrupted, and post-stop conversation. Paired tool results arriving after Stop remain visible. Foreign context-bearing custom messages survive; a proven active boundary excludes completed earlier ordinary conversation. Direct completion persists no private validation feedback. This projection survives same-physical-session reload, resume, and tree restoration. Active restart uses it for one bootstrap run alongside active runtime context. New and forked physical sessions inherit neither projection. No semantic transition is created.

A proven pre-runtime branch has no accepted runtime to persist: Stop appends State Flow's existing `{disabled:true}` checkpoint in Pi without creating canonical files. Its cached passive view remains readable under the configured policy, but is not runtime authority. Accepted canonical publication, including a later Start or passive patch, ends this pre-runtime condition; failed selected-boundary recovery never qualifies for it.

Lifecycle-only persistence for accepted runtimes reconciles valid live global/CWD drift before publishing the current session's config/runtime pair. Changed shared streams establish a fresh proven origin, not a semantic transition; the runtime adopts their already-advanced owner revisions without incrementing them, while semantic files and all provenance files remain unchanged. Cached reads may constrain wider tails left by another writer without rewriting them. Same-session file races and explicitly requested stale provenance writes still fail closed under CAS. The host refreshes its scope cache after adoption: Stop freezes the accepted view, and new-run registered-artifact maintenance runs against that view before inference.

The existing native passive-stop marker stores the stop timestamp and an optional `from` timestamp identifying the active run's first user message. Native user events are observed independently of State Flow enablement, so starting mid-tool and repeated Start/Stop retain the actual first-user timestamp. Native user-run preparation and session-start/tree events reset capture; semantic mode changes do not. No new marker field, stored format or projection-derived lifecycle authority is introduced. Transcript bodies remain in Pi's trace rather than being copied into another state store. A recorded active anchor uses the same conservative selector as active inference: if native compaction removed it, or matching is ambiguous/nonfinite, retain the available native summary and tool trajectory without guessing a post-stop boundary or rereading discarded raw entries. Idle and legacy markers without an active anchor still retain only post-stop conversation plus foreign custom context. The initial system prompt is composed at `before_agent_start`; Stop does not rewrite an already-issued request, while the next provider request receives the current owned protocol section as described below.

The current user specification stays at user authority and appears only in synthetic user runtime context. State is fallible assistant-produced data. Active/passive protocol contributes to Pi's native `state_flow` system-prompt section at `before_agent_start`, rather than forcing the entire prompt. Later companion sections and `context_with_system` transformations compose normally; explicit foreign forced prompts retain Pi's documented precedence. Native section diffs remove/reinstate the initial protocol across user requests. At `context_with_system`, the context domain also refreshes only the owned section from current enablement/bootstrap/passive policy, covering Stop/Start inside the same tool loop and accepted-boundary continuations. Unchanged effective protocol reuses the original array without relocating native deltas; a changed mode preserves foreign sections/content/tools and conversation identity/order without mutating native frames or creating missing system authority. Accepted completion removes the specification, not memory availability: a companion's actionable `turn_end` or `agent_before_settle` continuation can request another inference without `before_agent_start`. Every enabled request still gets one current-memory projection, omitting an absent specification and using the captured native anchor when available; no synthetic user run, persisted continuation field or State Flow scheduler is created. Completed trajectories leave model context at user-run boundaries, while Pi's full JSONL trace remains inspectable.

After an accepted non-bootstrap run settles with no queued input, State Flow may request native manual compaction under a generation-private marker when public `getContextUsage()` reports at least 24,000 tokens. The settled handler awaits native completion/error callbacks before returning, so Pi can dispatch deferred companion prompts after every observer finishes without racing an in-flight manual compaction. This waits for one existing native operation, without adding a timer, queue or second continuation owner. This token signal provides a modest margin above Pi's default 20,000-token retained suffix; Pi still owns preparation and may benignly decline when custom settings leave no compactable prefix. The extension supplies no model-generated state body: it forwards the existing `runAnchorTimestamp` to the planner, requires one matching native user entry, and keeps the complete accepted run including later steering and tools. A missing, ambiguous, or unanswered anchor produces no request; the planner never falls back to the nearest user message. Compaction details still contain only the retained semantic boundary/step. `buildContextEntries()` then omits the older completed prefix while append-only JSONL/tree history remains intact.

Pi 0.87 supports retain-none boundary compactions, but State Flow intentionally does not use them. Completed canonical state omits the exact user prompt, and foreign custom context can legitimately occur inside the latest retained iteration; hiding both would make the projected semantic state a lossy substitute for native context. Unknown or smaller usage, foreign custom metadata or native `custom_message` context in the removed prefix, stale selection, Stop/bootstrap/error/abort, and pending input do not produce this boundary. User manual and native threshold/overflow compaction remain unmodified; unaccepted work stays under Pi's native compaction contract.

The Pi adapter passes its raw cached scope overlay to `runtimeContextMessage`, which owns model sanitization of the current state. It does not pre-project that input. `currentRunTrajectory` selects a unique captured user timestamp without requiring specification-text equality: Pi may append image normalization hints after `before_agent_start`. Without a captured timestamp, only a unique exact specification match can select a projected suffix. Missing, nonfinite, or ambiguous selection retains all available context. Projection never assigns `runAnchorTimestamp`; native user events own that lifecycle identity, so a projection fallback cannot become compaction authority. With a selected boundary, one retained-message array preserves foreign custom messages at every position and ordinary messages from the original run, including images, tools and steering, without copying discarded ordinary prefixes. The necessary scan and Pi's earlier native-message clone remain history-dependent. See [context-cost evidence](performance.md#context-projection-and-trajectory-selection).

## Storage and identity

The default store is `<agentDir>/state-flow`; artifact sources are only exact paths already present in semantic state.

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

CWD and session keys mirror Pi's native encoding. The Pi UUID remains authoritative; readable directory keys never replace identity validation.

Root `config.json` is the read-only operator configuration shared by every session in the repository; it never participates in semantic overlay or State Flow-owned staging. Include operator configuration in operator-managed copies/versioning. `checkpoint.json` is only the canonical materialized semantic state, and each nonblank `patches.jsonl` line is only one semantic patch. Every scope's `meta.json` symmetrically owns its independent semantic revision, checkpoint/tail boundaries and artifact provenance, with CWD ownership added where applicable. Session `config.json` owns behavior; session `runtime.json` asymmetrically owns lineage, the internal branch step, session identity, and the full specification only while a run is unfinished. Predecessor combined session metadata is unsupported; session `meta.json`, `config.json`, and `runtime.json` must already satisfy their canonical ownership contracts. Metadata writers replace only their owned leaves and preserve JSON-safe unknown siblings. A pre-revision 0.17 scope initializes its counter from the still-retained semantic tail and persists that baseline on its next owned write; folded ancestry is not guessed. Revision-aware writes emit scope metadata version 2 while continuing to read version 1. The version fence makes an older writer refuse a scope after its first revision-aware write instead of silently dropping the counter; all cooperating instances should still upgrade together. Pi checkpoints retain only a semantic boundary plus lifecycle fields, or a proven ordinary-disabled marker. Revision-pointer checkpoints are unsupported and fail closed without Git restoration.

In-memory patching detaches one basis at its public boundary, then privately path-copies changed object/array containers while sharing untouched nodes only inside that owned draft. Incoming replacement values remain detached; staging no longer makes redundant cohort/per-scope pre-clones. Mutable staged responses and artifact registries stay isolated from accepted scopes, and commit/public temporal reads retain their detachment boundaries. This is not cross-version mutable sharing or a new disk generation format; see [copy-work evidence](performance.md#memory-only-owned-draft-cow).

All owned writes use same-directory atomic replacement, regular-file and symlink checks, prepared byte receipts and CAS validation. Unrelated files and detected concurrent bytes are preserved. Rollback restores only bytes still matching the failed publisher's output.

## Optional Git backup

Canonical files always own semantic persistence, current materialization, and retained hot history. Installing Git beside the store does not change authority or enable cold semantic restoration. Retained-boundary restoration selects private session history from the current canonical lineage while global/CWD scopes remain live; expired boundaries fail closed.

Scope artifact provenance records only current evidence. Restore/fork drops session provenance for paths touched by any retained session patch after the selected boundary, including a change-away-and-back; path existence or equal final values cannot substitute for that causal check. Selected artifact semantics remain intact with unavailable evidence until a stable explicit read and compilation. Untouched paths, provenance-only refreshes of unchanged semantics, and live shared provenance remain usable.

After response reconciliation and Pi's retry/queue processing, `agent_before_settle` may commit the already-accepted State Flow-owned files once. Backup acquires its own Git mutex, briefly takes canonical publication exclusion to inventory the bounded root/CWD/session namespace and capture regular-file bytes, then releases canonical exclusion before every Git command or filter. It never descends into artifact sources, `.git`, or unrelated directory trees. A private temporary worktree/index stages the captured snapshot with Git ignore/filter policy preserved; concurrent writers may advance canonical files without changing that snapshot.

Only exact backed-up owned paths are synchronized in the caller's index, preserving unrelated staged additions, modifications, deletions, index-only content, and worktree edits. HEAD-owned paths remain candidates when their deletion is already staged. Unchanged trees and unowned-only initial backups are skipped; failed index synchronization rolls back only the backup ref, never canonical files. Failure cannot suppress the answer or trigger another inference. Notification-only `agent_settled` does not perform backup writes.

After a successful backup attempt, State Flow resolves only the attached branch's explicitly configured remote and destination ref, snapshots the exact current commit, and starts one non-interactive, non-force push outside all backup and canonical locks. Settlement does not await network completion. Failure is diagnostic-only; no queue is persisted, and the next accepted settled turn attempts the latest current backup again. A repository without an explicitly configured branch remote remains local-only.

Durable push queues, publication workers, leases, retry generations, queue filesystem state, and publication-policy metadata remain absent. Git revision restore, immutable-revision fork APIs, and the legacy semantic Git backend have been removed from `TemporalRuntime`; all initialization, passive loading, model patches, runtime-only persistence, retained-boundary restoration, and retained-boundary forks use canonical files only.

Predecessor checkpoint envelopes, combined session metadata, pre-intents checkpoints, `state.json`, hashed layouts, and semantic Pi checkpoints are unsupported and remain untouched.

## Artifact routing

State Flow never discovers source directories. Before enabled inference it inspects only exact source paths already registered as artifacts in global, CWD, or session state. Observation uses regular non-symlink file metadata `{size, mtimeNs}` without reading bodies. Proven absence removes the artifact from each owning scope; unavailable, relative, directory, or symlink evidence is non-destructive. Unregistered files are never observed.

A model-visible artifact entry requires only a description:

```json
{
  "description": "routing summary",
  "compilation": {}
}
```

Runtime-owned compilation evidence is retained per scope in `meta.json`; current ordinary artifacts use `sourceFingerprint: {size, mtimeNs}` plus `compilerRevision`, while retained `sourceHash`/`compiledAt` are transitional compatibility evidence. At artifact-entry level, every model scope patch rejects authored `hash`, `compiler`, `compiled_at`, `sourceHash`, `sourceFingerprint`, `compilerRevision`, `compiledAt`, `source_hash_verified`, and `hint` fields, including field-deletion markers, even without a preceding read. Retained legacy evidence stays readable; ordinary semantic edits and whole-artifact deletion remain valid. Compiler output may add other finite non-null JSON metadata; known optional semantic fields include `kind`, `tags` and `compilation`. Tags are unique trimmed non-empty strings and support deterministic candidate filtering, but never authorize reading.

The public `classifyArtifactCompilationNeed` owns acquisition/rehydration and ordinary-artifact Pi decisions. An observed fingerprint needs matching valid retained fingerprint evidence; missing/malformed fingerprints, malformed compiler evidence, or a changed compiler request compilation without removing semantics. Changed size or signed nanosecond mtime (including pre-epoch dates) preserves the value and adds a runtime-only model `hint`. Fingerprint-only decisions ignore unused legacy hashes; explicit current-hash observations and the separate Skill hash protocol remain checked. Rehydration read plans carry detached fingerprints and optional hashes, never invented identities.

Invalidation notices identify the selected `global`, `cwd`, or `session` owner. Guidance and missing-output errors direct compilation to that exact scope/path, without relocating the entry or creating a global copy. Successful exact reads require stable fingerprints before/after acquisition and at publication, then publish compiler output and provenance to that owner under scope causal-basis CAS. Generic maintenance computes no content hash. Effective Skill entries mask lower ordinary entries and retain their separate hash protocol.

Compilation is routing, not a substitute for source text. Full source is read only for a concrete unresolved gap, exact source/edit operation, fingerprint invalidation, contradiction/failure, or explicit request. The rehydration planner supports new-bootstrap, resume-bootstrap and later-step phases without hidden directory traversal.

Skill acquisition applies only to exact registered Pi Skills. State Flow resolves identity and ownership through the public slash-command inventory rather than file-path conventions: Pi `user`, `project` and `temporary` source scopes map to State Flow `global`, `cwd` and `session`. A successful read with matching current source hash needs no new compilation. Otherwise the tool result names the exact optional target. Attempted durable output requires `kind: "skill"` and a non-empty compilation describing applicability, constraints and failure conditions; an omitted output leaves the read volatile and does not block unrelated patches or ordinary completion. Source bodies do not persist in state. Matching provenance proves source-version consistency, not semantic fidelity, truth, or higher instruction authority.

## Operational guidance and memory curation

The packaged Skills deliberately separate two responsibilities. `state-flow-guide` is the on-demand operational reference for concrete read, patch, inheritance, acquisition, completion, and recovery questions; it does not initiate memory audits or unsolicited cleanup. `state-flow-memory` performs one explicitly requested bounded curation over stale knowledge, commitments, continuation, ownership, and external handoffs; phase completion does not activate an audit.

Curation may persist reusable guidance from a registered Skill at its provenance-derived scope. Within one store, a proven scope move inspects both owners, resolves conflicts, and commits destination/source changes through one atomic multi-scope patch, followed by ownership/overlay verification. Existing Skill artifacts written under the former CWD-only policy are not silently promoted: a later registered read identifies the current owner, while explicit curation may move proven reusable content and remove the old owner atomically.

External transfers use the destination's native interface and receipts; accepted-copy verification precedes source deletion in a later State Flow patch. State Flow defines no promotion registry, status schema, record type, or dedicated promotion tool; destination uncertainty simply leaves the source intact.

## Session continuation

The package exposes read-only host contracts that:

- read only native JSONL headers, never transcript bodies;
- inspect canonical-file State Flow runtime provenance without mutation;
- rank exact profile, CWD, Git common-directory, worktree, branch and transport identity;
- fail closed for stopped, malformed, unavailable or ambiguous candidates;
- preserve explicit new/resume and native picker precedence;
- project new-bootstrap, resume-bootstrap and later-step rehydration phases.

Session checkpoint/tail identities must agree with that session's retained runtime lineage before restore/fork accepts a fresh origin. This check permits sparse session changes and inherited pre-origin streams; it does not require a session patch at a shared-only transition. Continuation inspection applies the same session check while validating current global/CWD streams independently. Shared writers do not belong to another session's historical clock. Neither path repairs a contradictory session cohort or manufactures empty session authority.

The [tested Pi SDK baseline](compatibility.md) chooses or creates `SessionManager` before package resources and extensions load. Therefore native default auto-resume cannot be installed safely by this extension alone. The remaining host integration requires an upstream pre-session resolver hook or an SDK/launcher that invokes the advisory resolver before constructing the session.

## Model tools and embedding

### Model tools

`patch_state` accepts one or more fixed `global`, `cwd`, and `session` semantic patches. Supplied scopes contain object-valued `artifacts`, `contract`, `working`, and `intents`, plus object-valued `lazy` whose nested values are ordinary JSON; omitted fields preserve their values, recursive object merge updates them, arrays/primitives replace, and nested object-key `null` deletes. Materialized null, empty supplied scopes, material no-ops, unknown top-level fields, model-authored `response`, and retired finalization or patch grammars are rejected.

```json
{"session":{"intents":{"next":"Verify the corrected behavior"}}}
```

`intents` is the hot plane for active commitments, not requirements, observations, alternatives, or completed plans. Removing an intent does not remove its consequences or any referenced state. Semantic-state references use either the optional structured `{"$ref":"cwd.lazy.plan"}` convention or `$` immediately followed by one valid `read_state` path inside ordinary text, for example `$effective.lazy.memory[7]`. The text prefix distinguishes references from incidental path-like prose and leaves a deterministic seam for possible future parsing. Resource paths, document locators, URIs, Skill identities, and agent identities retain their native syntax. State Flow stores all forms as ordinary JSON and currently does not parse or validate targets. The agent resolves a relevant locator explicitly through `read_state` or the appropriate external tool; presence alone creates no authority, existence proof, dependency, hydration, execution, or completion semantics. Reference repair is reactive: the agent never scans or resolves references merely to test them. Only after one requested value path is missing does the query domain perform one bounded reverse lookup over current model-patchable semantic planes for exact structured `$ref` or `$path` matches. When matches exist, `read_state` returns the explicit diagnostic sentinel `{value:null, hint:[{type:"dangling-reference", message, paths}]}`. `hint` is a top-level sibling rather than state data; its message asks for reconciliation and `paths` contains at most three runtime-verified current owning addresses. The null sentinel is never returned alone for this case. Keys, patch, and multi-path reads keep all-or-error semantics, while no durable match retains the ordinary missing-path error. A match establishes durable semantic provenance, not staleness; no match does not prove invention. The agent may then inspect ownership and patch a proven stale source without discarding surrounding meaning. Effective absence does not establish ownership, and unavailable history, external inaccessibility, or transient read failure does not prove a broken reference.

`read_state` accepts one unified path. `effective == effective[0]` is the current effective materialization; `global == global[0]` (and CWD/session equivalents) selects that scope at the same composed causal boundary. `global.patches == global.patches[0]` reads the latest accepted retained global patch, with higher patch indices walking only that scope's retained accepted patches. Indices are bounded by the configured `historyLimit`; unavailable pre-origin or pre-tail history is an error. Resolver aliases are not literal JSON containers. Reads stay cached and create no Git query, publication, checkpoint append, or semantic step.

```json
{"path":"cwd[1].intents"}
```

```json
{"path":"global.patches[0]"}
```

Unscoped semantic paths such as `intents.next` alias the current effective overlay. `value`, `keys`, and `patch` projections plus ordered `paths` batches remain all-or-error.

Both tools follow branch enablement and host restrictions. The patch barrier also blocks reader siblings. These tools do not impose project schemas or state-size caps; semantic usefulness, scope choice, and compression remain model responsibilities. Ordinary handoffs reconcile touched state. Dedicated cleanup and scope review require an explicit user request, including at feature/release/project boundaries. Global retains established cross-project/user/environment knowledge, CWD owns reusable project truth, and session owns branch/run continuation. Intra-store moves use targeted owner reads and one atomic multi-scope patch followed by verification; external moves require verified destination acceptance before source deletion.

### Embedding

The default extension factory accepts `StateFlowExtensionOptions`: `agentDir` selects the profile and `repositoryRoot` overrides the configured state store. `onRuntime` receives a cached `read(offset?, scope?)` accessor; omitted scope means effective state. Use it only after runtime initialization/restoration. The pure `readTemporalState(view, offset, scope?)` accessor is exported separately. SDK hosts with an explicit tool allowlist must include both `patch_state` and `read_state` when they want model access.

Honor Pi's `session_shutdown` lifecycle before disposing an embedded session. On the [tested Pi SDK baseline](compatibility.md), `AgentSession.reload()` emits and awaits shutdown, but bare `AgentSession.dispose()` only invalidates/disconnects the session. `AgentSessionRuntime` owns native new/resume/fork replacement and its asynchronous `dispose()` delivers quit shutdown; rebind each newly created session's extensions. An SDK host instead disposing a standalone `AgentSession` should first `await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`; ordinary Pi lifecycle owners already deliver the event. Without shutdown, the adapter's queued Start, compaction-stop flags, and optional presentation disposal are not notified.

Native replacement teardown and State Flow adoption are separate responsibilities. On a native fork start, the adapter verifies the direct parent header and selected retained source boundary, then copies only the session stream/provenance into a distinct child owner over current live shared scopes. The child has a fresh origin and its own checkpoint, never a UUID alias or historical shared-state rewind. A child-owned native reset marker fences inherited passive Stop projection across reload. Parent-owned checkpoints selected later cannot fall through to an ordinary-disabled marker and reset child storage. See the [fork contract](fork-contract.md) and [operating limits](usage.md#fork-support-and-limits).

Agent configuration is read once per extension load; session runtime configuration remains branch-selected. See [configuration](usage.md#configuration) for settings and path precedence. Memory ownership while enabled and global availability are invariants, not configuration switches.

## Observability

Status is a projection of the selected runtime and semantic view, not a second store. Compact terminal and Telegram main-menu status render `G#/C#/S#` only while active; passive Telegram renders `State Flow: off`. Requested Global, CWD and Session Rich snapshots show their independent `#revision`, while Effective shows the vector. Global/CWD Rich views omit the empty structural response placeholder; Session and Effective expose the Session-owned response. Missing evidence stays unavailable instead of appearing empty. The optional Telegram leaf adapter calls the same Start/Stop owners, and its inspectors remain available in either mode. Inspection may refresh live Global/CWD streams in memory so foreign accepted revisions become visible, but never publishes or increments a revision. If model-facing passive access is disabled and no runtime is selected, inspection may lazily load existing canonical shared state under the same read-only rule. Registration is fail-open and disposal belongs to session shutdown. Local diagnostics stay outside semantic state and cannot change accepted state. Operator-facing fields and privacy boundaries are in [usage](usage.md#status-and-controls).

## Validation boundaries

Structural validation proves JSON shape, exact identity, causal lineage, compilation evidence, CAS and publication invariants. A valid state, receipt, source hash, or compiler revision cannot prove semantic importance, truth, sufficient compilation, correct scope, useful curation, or historical deletion. Those remain model-judgment concerns evaluated separately from deterministic transport checks.

The deterministic continuity and temporal evidence map is in [temporal-acceptance.md](temporal-acceptance.md). Release-scoped open work is in [BACKLOG.md](../BACKLOG.md), and shipped outcomes belong in [CHANGELOG.md](../CHANGELOG.md).
