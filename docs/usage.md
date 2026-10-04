# Usage and recovery

For the concept and installation, start with the [README](../README.md). This guide covers operating State Flow; the [architecture](architecture.md) owns its internal contracts.

## Session behavior

### Active, passive and configured off

State Flow has three distinct model-facing states. **Active versus passive changes the agent's workflow, not the existence of disk memory.**

- **Active:** Both `read_state` and `patch_state` are available, subject to host restrictions and valid memory authority.
  - Prompts require the agent to consolidate future-relevant results into state before ending an iteration.
  - The final meaningful semantic patch preserves the decisions, outcomes and continuation needed once the completed conversation leaves model projection.
  - The next iteration starts from accepted state and its new input, not from the previous iteration's completed reasoning.
  - The native trace stays inspectable: a clean model context does not mean deleting Pi history.
- **Passive:** Both memory tools are available, existing state is projected into context, and the agent may read or patch it as useful.
  - Ordinary conversation continuity remains: there is no active iteration-ending context reset and no mandatory consolidation pressure.
  - Accepted patches still reach the same canonical store, with the same validation and ownership guarantees.
- **Off:** Neither memory tool is exposed to the model, and State Flow injects no protocol, bootstrap/state context or frozen passive handoff. Stored memory and the native conversation trace are not deleted.

One session-owned `mode` selects these behaviors; there are no separate passive-tool or projection switches. Host restrictions and genuinely unavailable or corrupt memory are fenced independently of the mode.

**Completion is semantic, not ceremonial.** In active mode, necessary final state changes must be accepted before relying on state-only continuation. That does not require:

- an empty `patch_state` when memory is already current;
- an extra model turn;
- a special finalization tool.

Each `patch_state` is an inference barrier, not automatically the end of an iteration. The runtime separately persists the accepted ordinary answer as Session `response` and completes the run.

**Two meanings of “bootstrap”:**

- “Bootstrap from state” means building model context from durable memory.
- The implementation's `meta.bootstrap` is narrower: it marks the one transition run that keeps an existing conversation when active mode is first enabled, so that conversation can be compiled into state. It is not re-entered on every active iteration.

Native compaction is separate from model-context projection; its safety checks and usage threshold still apply.

Active, Passive and Off select the session's workflow and model-facing access, not a different storage algorithm. Native Off attachment defers memory acquisition, including creation of a fork's private memory, until Passive or Active is explicitly selected. Once acquired, a fork owns Session state copied from the selected parent boundary and lives independently in its selected mode. See [fork support](#fork-support-and-limits).

### Lifecycle operations

**`/state-flow-active`** activates the current Pi branch over validated current same-session memory, initializing absent storage when safe. No remote is required.

- Starting mid-conversation keeps Pi's active context for one complete bootstrap run, during which the agent must compile future-relevant information into state.
- Repeating Active while already active leaves the in-progress run unchanged.
- On an attached branch, activation waits asynchronously for a coherent canonical cohort; pending repeats share the wait.
- Until acceptance, the existing inactive mode, deferred historical selection and any write fence stay in effect.
- Cancelling a pending Active from Off preserves later acquisition choices. A superseding Passive still selects its retained private boundary rather than newer current memory, and ordinary cancellation creates no write fence.
- Passive, Off or a branch selection can withdraw an obsolete activation. An error after acceptance does not undo accepted memory.

How each lifecycle event behaves:

- **New session:** Adopts the global `mode`, defaulting to Off.
  - An inactive default is recorded once in Pi as `{mode:"off"}` or `{mode:"passive"}`, without creating semantic storage.
  - An Active default initializes a distinct empty Session layer over global/CWD memory, never another session's private continuation.
- **Resume:** Keeps the selected session's mode; later global default changes do not override it.
  - Passive/Active restore state and lineage.
  - Off attaches native policy only, without probing semantic files or emitting recovery warnings.
- **Tree navigation:** In Passive/Active, restores the selected retained private boundary over live shared scopes, without checking out or resetting the shared store. Off defers this acquisition until a mode is explicitly selected.
- **Abort inference:** Stops generation or an outstanding response-publication wait. Already accepted patches stay durable, so work and corrected direction can continue in the same session.
  - Cancellation before response acceptance keeps the previous response and the unfinished run.
  - Cancellation after acceptance never rolls it back.
  - Abort does not require immediate remote replication.
- **Native boundary continuation:** A companion may continue through Pi's `turn_end` or `agent_before_settle` boundary without a new user prompt. State Flow keeps projecting current memory and the accepted response across those requests and later patches. It does not restore the completed specification or request another turn itself.
- **Passive:** `/state-flow-passive` enables both memory tools and projection.
  - A proven pre-runtime branch records only `{mode}` in Pi and loads shared memory read-only.
  - Accepted runtimes persist Passive and adopt unrelated shared drift without semantic/provenance writes or revision/step changes.
  - Pending repeats share one acceptance.
- **Off:** `/state-flow-off` removes memory tools and context, and immediately clears semantic caches.
  - It cancels owned restoration/fork, activation, preparation, response, patch and Passive-persistence waits.
  - It saves only native policy and continuation/fork bookmarks. Existing canonical bytes, including the old stored runtime mode, stay untouched even when malformed or busy.
  - Repeated Off is inert. Already accepted data is preserved, and a later explicit Passive/Active reacquires memory.
  - Global defaults and other sessions remain unchanged.
- **If Passive cannot persist:** Off itself never attempts canonical persistence; this fallback concerns Passive.
  - The selected Passive policy stays applied. Accepted memory and the native conversation stay intact.
  - Pi records the selected mode and a write fence, not a replacement semantic checkpoint. This needs a writable Pi trace and never repairs storage; native fenced policy overrides an older canonical config.
  - Tree/reload/resume in Passive read validated current same-session memory without publishing or restoring an older selection.
  - Off keeps the native policy and the write fence without reading memory, and still exposes no State Flow context or tools; explicit Passive may acquire that read-only current authority later.
  - Newer mode choices survive an in-flight read-only recovery. Repeating the same choice is inert; changing the inactive mode updates only native policy and keeps the fence.
  - Explicit Active clears the fence only after canonical acceptance.
- **Continue in Passive after Active:** The same physical session projects a frozen state handoff, any interrupted current request and tool trajectory (including late results), and the conversation after Stop. Which earlier conversation is kept:
  - Outside an unfinished bootstrap, a proven active boundary excludes completed earlier conversation.
  - If native split-turn compaction removed the original request anchor, Stop keeps the available summary and tools instead, without reconstructing discarded raw input.
  - An unfinished bootstrap keeps all available native context, or the earlier passive boundary it received. Repeated Start/Stop cannot move that boundary past uncompiled conversation.
  - An interrupted run keeps its captured anchor even after Pi becomes idle, and falls back to all available context when that anchor is unknown.
  - Only Stop after a completed idle run keeps just the later conversation plus foreign custom context. Other extensions' custom context survives in every case.
  - Mid-tool Start and repeated Start/Stop keep the first user event already observed while disabled, so a later Stop does not mistake that busy run for idle.
  - Reload/resume/tree preserve this projection; new or forked physical sessions do not inherit it.
  - Active restart uses the retained projection for one bootstrap run. Off keeps this boundary for a later Passive/Active selection but never projects it.
- **Completed-history compaction:** After an accepted run settles without queued input, State Flow asks Pi for a native compaction boundary, but only when public context usage reaches 24,000 tokens. No extra model summary is requested.
  - Pi keeps the complete latest run in active history, from its original request through steering, tools, foreign context and final answer, and keeps the complete append-only JSONL/tree.
  - State Flow uses the native first-user anchor, independent of image-normalization hints or later steering; images and earlier tool results stay available to the model. Uncertain projection keeps available context without changing that anchor.
  - A missing or ambiguous native anchor skips compaction instead of choosing the last steering message.
  - On resume, native `buildContextEntries()` and TUI rendering omit the older completed prefix.
  - Unknown or smaller usage skips the request, and custom Pi retention settings may still decline it benignly.
  - These prevent State Flow-owned shortening: foreign custom context in the prefix that would be removed, bootstrap/abort/error, Stop and pending input.
  - Obsolete or inactive owned requests are canceled before their hook can fall through to a model summary, and a late completion cannot clear a newer request.
  - Ordinary manual/threshold/overflow compaction stays native and may preserve unfinished work not yet patched into memory.

State Flow does not undo tool effects. After an interruption or a return to an older branch, check the relevant workspace or external system before repeating consequential operations. Restored memory is not restored reality.

### Fork support and limits

**What a fork copies.** Memory-enabled native fork replacement copies the source session checkpoint, retained patch tail and matching provenance into the new session's own storage.

- Off records only a child-owned pending-fork policy. Header/store reads and copying wait until an explicit Passive/Active, including after a cold reload.
- Global/CWD values and provenance stay current. Applying a smaller `historyLimit` may fold shared tails under CAS.
- An earlier fork selection copies that point's private state, not the parent's later private work.
- Parent-private data and history stay intact. The selected mode is kept, so an inactive source does not become Active automatically.

**The child's own history.** The child starts at step zero with a new temporal origin.

- Its copied tail obeys the configured retention limit, but pre-origin records are not additional aligned causal boundaries addressable through `effective[n]` or scoped paths.
- The child's own transitions build its hot window, and owned checkpoints support normal reload/resume.
- Parent Stop projection is not inherited, including after a child reload.

**Requirements for the initial copy:** a native fork start event, a regular canonical direct-parent session file, matching CWD/identity, a readable temporal source and an unused child namespace. Missing or unsafe evidence or a CAS conflict leaves the copy unavailable rather than importing unrelated or newer private state. Explicit Start can retry an unaccepted copy in the same loaded fork once the cause is corrected.

**Limits:**

- Selecting a copied parent checkpoint through the child's `/tree` does not make it child-owned: historical restoration stays disabled without resetting existing child data. Instead, select a child-owned checkpoint, resume the original session, or explicitly Start from the validated current child-owned memory. Start does not copy newer parent data.
- Cold recovery before the first child checkpoint requires an Off-deferred pending-fork marker. Otherwise, it and startup paths lacking the fork event remain unsupported.
- In-memory parent locators and cross-CWD imports remain unsupported.
- File-only copying requires an exact still-available source cohort.

See the [contract](fork-contract.md) and the [SDK compatibility boundary](compatibility.md#public-host-seams). Do not rewrite UUIDs or delete pointers to force recovery.

## Configuration

An optional global `config.json` lives at the root of the State Flow repository, normally `~/.pi/agent/state-flow/config.json`:

```json
{
  "mode": "off",
  "logging": false,
  "showSuccessfulPatches": true,
  "historyLimit": 7
}
```

The canonical store is `state-flow/` beneath the agent directory. Keeping configuration inside that repository replaces the separate agent-level `state-flow.json`; SDK embeddings may still provide an explicit repository override.

- `mode`: `"active"`, `"passive"` or `"off"`; defaults to `"off"`. It supplies the default only for genuinely new sessions.
  - Active initializes missing storage when safe.
  - Passive reads existing memory without publishing; its first explicit patch may initialize absent storage without starting an episode or compaction.
  - Off exposes neither memory tools nor State Flow context.
- `logging`: Defaults to `false`. When enabled, rejected patch executions, active barrier blocks, preparation failures and accepted-answer reconciliation failures are recorded locally at `tmp/state-flow/logs.jsonl` beneath the agent directory. Asynchronous Git push failures are recorded there even when this setting is off.
- `showSuccessfulPatches`: Defaults to `true`. In interactive Pi, `patch_state` rows show pretty-printed JSON arguments once in the call, with blank lines between adjacent memory sections; the result shows the acceptance or no-op acknowledgement, never a second patch. Set it to `false` to hide call arguments and keep the compact acknowledgement. Rejected calls retain their arguments and error acknowledgement; State Flow adds no private validation turn.
- `historyLimit`: Defaults to `7` and accepts integers from `0` through `100`. It counts accepted semantic transitions, **not elapsed time or conversation length**, and bounds materialized-history and scope patch-history offsets.
  - Lowering it on reload/restore/fork folds excess tails forward without losing current state; selected boundaries outside the new window become unavailable.
  - Zero keeps only current checkpoints.
  - Raising it affects only future retention and cannot reconstruct discarded history.

**Session configuration.** A session's `config.json` uses the same `mode` key for its concrete choice; commands and Telegram change that session only.

- Before canonical runtime acceptance, Pi's native `{mode}` checkpoint owns the choice instead of a manufactured storage pair.
- Off stays native-only even after an accepted runtime: its mode/bookmark overrides the earlier canonical mode without needing store access or granting semantic authority.
- Edit global defaults manually or through an authorized agent, not through `patch_state`.
- Legacy flag decoding is read-only; see [mode compatibility](compatibility.md#mode-configuration-compatibility).

**Passive model-facing footprint.** When selected, Passive declares both memory tools even with no canonical store. Its system-prompt section and projected memory message appear only after a validated memory view is loaded. New sessions default to Off, which exposes none of these surfaces. With unavailable memory the tools may still reject reads or writes: declared tools do not prove usable storage.

**Loading rules.** Settings are read once at extension load; after editing, use `/reload` or restart Pi. A missing file uses defaults without creating a configuration file. Malformed JSON, unknown keys or invalid values fail loading rather than silently selecting another store.

`PI_CODING_AGENT_DIR` changes both the default State Flow repository and its global configuration location. State Flow has no source-directory or Knowledge-root configuration. SDK repository overrides are documented under [embedding](architecture.md#embedding); an overridden repository owns its own root `config.json`.

### Diagnostic logging and privacy

**What gets recorded:**

- Rejected `patch_state` executions may include the exact attempted arguments and useful draft text, plus the error category and tool/call identity.
- The `barrier-block` category records only the blocked tool name, call id, reason and batch tool names, never sibling arguments or reasoning. Passive has no patch barrier, and with logging off no barrier blocks are recorded.
- Asynchronous push failures keep the available redacted Git error in the log regardless of `logging`. Interactive warnings stay short, appear once per failure streak and reset on success. If logging the push failure is unavailable, one warning shows the available detail instead.
- Successful patches are not logged, and reasoning bodies are excluded.

**What logs are not:** semantic state, scope metadata, Pi checkpoints or publication input. If the log path overlaps a custom state repository, capture fails closed instead of committing it. A logging failure changes no accepted state and produces at most one local warning. Logs stay local unless you move them; rotation and deletion are up to the operator.

**How errors are displayed.** State Flow-authored errors and warnings appear as one compact line:

- Nested and aggregate causes are flattened into transportable text instead of relying on `Error.cause`.
- Long operands are elided with `…` before prose is shortened, so the operation, the exact offending scope, the target basename/suffix and the actionable reason stay visible. Unicode pairs are never split, and prose apostrophes are not mistaken for quoted paths.
- Enabled diagnostic records keep the full target and the rejected input for investigation.
- An explicit Start retry reports its final failure once instead of repeating its startup warning.
- Tool failures keep the required blank line beneath their heading.

Treat logs and state files as private. Removing a secret from current state does not erase older offsets, Git history, native sessions or remote copies.

## Status and controls

`/state-flow-status` separates runtime configuration/metadata from semantic state. It reports:

- Selected CWD/session keys, internal step, effective `g#c#s#` scope-revision vector, and available hot-history depth.
- Known recovery or publication failures, actual artifact counts when nonzero, and pending invalidations. Status does not discover or validate sources.
- A `Scope memory:` block with one line per scope that has content: the UTF-8 byte size of each present nonempty plane and, when `working` or `lazy` has top-level entries, the share owned by an open intent of that scope (for example `- cwd: intents 137 B, working 32 B; intent-owned working 1/2`). It is operator-only: no notice, threshold or model-facing effect.
- One JSON representation of effective global → CWD → session memory, with a blank line between top-level semantic planes. Nested JSON is unchanged; individual scope JSON remains available through `read_state`.

Status omits the already-visible mode and generic ownership/configuration prose. Failed inspection reports unavailable evidence, not invented empty state. Status is observational: it does not read source files, calculate fingerprints, create invalidations or mutate semantic state.

**Revisions and indicators:**

- The terminal indicator is accent `state-flow` plus dim `active` or `passive`; Off hides it.
- Global, CWD and Session own independent semantic revisions. One atomic transition advances each materially changed scope once, including session-only response reconciliation.
- Effective has no scalar counter. It uses the compact lowercase `g#c#s#` revision vector (for example, `g15c8s31`), with no slashes or spaces between counters. The vector appears in `/state-flow-status` and in Telegram's Effective inspection, not in the compact indicators.

### Telegram controls

When `pi-telegram` is available, its main-menu section shows `State Flow: active`, `State Flow: passive` or `State Flow: off`. The adapter is optional; the Pi commands work without it. All Telegram controls use the same lifecycle owners as the terminal commands.

**Mode controls:**

- A horizontal radio row presents `Off | Passive | Active`. The selected option uses 🟡, 🟣 or 🟢 respectively; each inactive option uses ⚫️.
- Telegram Active requested during a run waits for settlement; Passive and Off apply immediately.
- Ordinary successful controls add no redundant mode receipt; diagnostic outcomes stay visible.
- Off exposes neither tool nor State Flow model context.

**Menu layout:**

- The submenu heading shows the current value in monospace.
- The bold Mode heading uses a long dash, a description ending in a colon, and a blank line before its settings-style list. Each line has a monospaced minus and lowercase monospaced mode value, then a plain colon and description.
- The descriptions progress from regular chat with no memory (Off, the new-session default), to ordinary chat with memory tools and an available combined memory view (Passive), to the same memory access with completed answers followed by memory-first continuation (Active). They do not claim a new physical Pi session or disabled native compaction.
- The bold Inspect memory heading follows the same long-dash, description, colon and blank-line pattern. Its four lines use the same monospaced minus/value and plain colon format for `global`, `cwd`, `session` and `effective`, describing the individual scopes and their combined view.
- Four direct Global/CWD/Session/Effective buttons follow without another chooser.

**Memory inspection:**

- Owner-scope Rich snapshots show `#revision`; Effective shows the vector.
- Fields show pretty-printed JSON directly. Large fields show a bounded JSON prefix with a separate truncation notice and omitted-character count, not a JSON-encoded `preview` string. The preview may end mid-value; actual escapes inside JSON string values remain intact. These presentation limits never truncate stored memory or successful `read_state` results.
- During a failed-Passive write fence, memory-enabled inspection uses the accepted cache without a potentially conflicting refresh.
- Otherwise, inspection waits cancelably to load or refresh one coherent shared view, even when passive model tools are disabled. It does not initialize, publish or advance storage.
- Data and displayed revisions come from the same observation; absent or invalid memory stays unavailable.
- Stop, session/tree changes and shutdown cancel obsolete observations.
- The button acknowledges immediately, and a late failure appears in the menu instead of an expired callback popup.

**Inspecting while Off.** Explicit Off inspection reads current stored memory through a disposable reader.

- Session and Effective require validated same-session private authority and cannot show a fabricated empty layer or revision. Shared Global/CWD inspection stays available independently of private failures.
- These reads install no model/runtime cache, change no bytes or mode, clear no write fence, and leave the selected historical/fork boundary intact for a future Passive/Active acquisition.
- Automatic Off callbacks never acquire memory.
- Current stored data does not prove that a selected past boundary is restorable.

Open implementation work is tracked in [BACKLOG.md](../BACKLOG.md).

## Storage and recovery

Use a dedicated directory. State storage and registered artifact sources have separate responsibilities:

```text
<agentDir>/state-flow/   global config, accepted state, and runtime metadata
<any exact registered path>   optional external source owned outside State Flow
```

Files per scope:

- Each scope materializes an anchored semantic-only `checkpoint.json` plus semantic-only lines in `patches.jsonl`.
- Scope `meta.json` holds temporal boundaries, CWD ownership where applicable, and runtime-owned artifact evidence.
- The session additionally uses `config.json` for behavior and `runtime.json` for branch/run recovery metadata. A full prompt is kept there only while its run is unfinished.
- CWD/session directories mirror Pi's native naming, while canonical identities are validated separately.

See the [storage contract](architecture.md#storage-and-identity) for the exact layout.

### Missing, partial, and malformed storage

**Missing fields are fine.** Missing documented fields inside a valid checkpoint or patch are supported.

- Current and historical semantic views include only known fields present in the selected scope or overlay; absent fields and empty responses are omitted. Higher scopes contribute only present values.
- Unknown top-level fields are ignored when reading checkpoints/patches and are not emitted on later writes; nested data within known planes stays intact.
- An explicit `read_state` value query for an absent documented top-level field returns `null`, including an empty or absent `session.response`.
- Reading and Start do not normalize files, advance revisions or require a migration.
- An empty semantic object is different from a missing file or missing ownership metadata.

**Wholly absent shared files.** A checkpoint and its tail are one semantic pair. If both live files of a global or CWD scope disappear, State Flow treats that complete absence as current empty shared reality. An authored `patch_state` applies to that empty basis under exclusion, and normal file-cohort CAS creates the accepted pair without resurrecting cold values or orphaned compilation evidence. Raw precomputed replay still refuses a removed selected target rather than replaying stale normalized changes.

**Corruption fails closed.** These are never replaced:

- exactly one surviving pair member;
- present malformed JSON or unsupported checkpoint envelopes;
- semantic/metadata boundary mismatches and identity contradictions;
- partial session runtime evidence.

A missing or expired private retained boundary is unavailable; State Flow does not substitute Git history or newer private files.

**After a selected-boundary failure:**

- Passive may still expose current global/CWD memory, but never the unavailable historical session layer or permission to publish an empty replacement.
- Historical session reads and every `patch_state` refuse without changing canonical files or appending substitute checkpoints.
- Passive/Off selection stays available and records the native policy/write fence described above. A later reload may expose validated current memory read-only, not the unavailable selected history.
- Status distinguishes a write fence from unavailable materialization.

**Explicit Start uses current memory, not unavailable history.**

- It independently validates the current same-session canonical cohort, preserving private memory, artifact provenance, revisions, step and available aligned history.
- Expired active/passive pointers and unfinished runtime work do not block activation. A pre-runtime selection also keeps current accepted same-session memory instead of resetting it.
- Start bootstraps the conversation available on the selected Pi branch, without resurrecting an old unfinished specification or claiming that expired historical private state was restored.
- Independently advanced shared scopes may require a new temporal origin; unavailable history is never invented.
- Exact-cohort CAS rejects a concurrent writer, and incomplete or corrupt storage stays untouched.
- An unaccepted native fork still retries its exact source rather than inventing child memory.
- When evidence is missing, repair it, select a retained boundary, or open a genuinely new Pi session.

**Artifact evidence and replication:**

- Missing artifact provenance inside an otherwise complete scope `meta.json` means compilation evidence is unavailable, while semantic state stays usable. Removing the whole metadata file also removes temporal authority and fails closed.
- An unavailable registered source path does not prove that durable artifact routing was deleted, and external files are never created.
- State Flow has no durable push queue or publication-worker lease; failed replication is retried only after a later accepted turn.

See the complete [filesystem recovery contract](filesystem-recovery.md).

### Canonical files and optional Git backup

Canonical scope/runtime files own the current materialization and retained hot history, whether or not Git is available. Pi checkpoints identify a retained semantic boundary, not a Git commit or an arbitrary historical snapshot. Restart and branch restoration fail closed when the selected boundary has expired, rather than substituting newer files as the selected past.

**Local backup commit:**

- After an accepted turn has reconciled its response, Pi's final actionable `agent_before_settle` boundary may create one best-effort backup commit when Git is available. The local attempt completes before settlement continues.
- The capture waits cancelably when Pi supplies an operation signal. When that signal is absent at settlement, an occupied backup/storage mutex explicitly defers the backup until a later accepted turn instead of trapping Abort. Deferral neither changes memory nor starts a push.
- Off and shutdown cancel owned pending local attempts. Only cleanup of already-acquired locks/resources may continue; Off admits no new capture.

**Remote push:**

- If the attached branch has an explicitly configured remote/ref, State Flow starts a non-interactive asynchronous push of the exact current commit, without force. Settlement does not wait for the network.
- Within one Pi process, an in-flight push per repository makes overlapping attempts skip; a later accepted turn retries the latest backup, without a durable queue.
- Off terminates only its own admitted push and suppresses canceled reporting; an overlapping caller cannot revoke another owner's push. Normal completion of the agent operation does not revoke independent push ownership.
- Shutdown cancels its own pushes and waits for that repository's in-flight push to close or time out.
- Cancellation never rolls back already accepted local or remote commits.

Commit or push failure is diagnostic-only; repeated push failures warn once per failure streak and stay locally diagnosable. Git availability never changes semantic authority, step or retained lineage.

### Moving a store and supported formats

**Moving a store.** An SDK `repositoryRoot` override or a different `PI_CODING_AGENT_DIR` selects a location; it does not relocate existing state or retained history. Copy the complete canonical store while all writers are quiescent, or use a genuinely new Pi session for an independent store. Copying only current checkpoints, without their tails and metadata, cannot preserve retained boundaries.

**Supported formats.** State Flow accepts only canonical checkpoint/tail files, temporal metadata and the separate session config/runtime contract.

- A canonical scope without a revision counter is readable. Its initial counter uses only the retained semantic tail and is persisted in metadata version 2 on the next owned write, without inventing folded ancestry.
- Version 1 stays readable. Older writers refuse version 2 through the existing provenance-version fence, so cooperating instances should upgrade together.
- Unsupported checkpoint envelopes, combined session metadata, `state.json`, hashed layouts and semantic Pi checkpoint envelopes fail as unsupported, without rewriting existing bytes.
- Canonical semantic objects lacking optional fields, such as `intents` or `lazy`, are valid sparse state and do not cross this boundary.
- There is no in-place converter; external conversion or a fresh store is up to the operator.

### Conflicts and interrupted publication

**Patches.** `patch_state` waits asynchronously for a live cooperating writer, with native cancellation and no ordinary-contention deadline. It then applies authored Global/CWD operations to the current canonical values:

- Unmentioned fields survive.
- Overlapping assignments follow successful acceptance order.
- Correct repeats return `State already current.` without another semantic revision.
- Session stays private; invalid or unavailable evidence and an independently changed private cohort still fail closed.

Do not repeat external actions while memory publication waits.

**Final answers.** Final-answer reconciliation also waits cancelably, then saves the response and the completed-run lifecycle together over current shared memory. Stop, session/tree changes, shutdown and a superseding answer cancel obsolete waits without modifying newer work. A failed or canceled publication leaves the prior response and unfinished run intact; it never requests a repair inference.

**Run preparation.** Run preparation and missing-artifact maintenance wait cancelably before the first enabled inference, accepting current shared memory and lifecycle together. If preparation fails, State Flow aborts that native operation rather than sending a rejected or stale draft to the provider; previously accepted memory stays available. Cancellation can leave the new request without a specification checkpoint, so its native conversation is conservatively preserved through idle Stop/reload. Boundary continuation never replays a completed specification.

**Other waits:**

- Telegram shared inspection also awaits exclusion, read-only.
- Backup capture uses the awaited API too, with the no-signal settlement exception described above.
- Passive selection on an accepted runtime changes local tools/context immediately, then awaits runtime-only persistence; pending repeats share one acceptance. Off cancels that wait and records native policy without acquiring the store. Selection, shutdown or a successful Start cancel obsolete Stop work. An available host operation signal can cancel persistence without restoring an older mode; idle commands do not necessarily have that signal.
- Current-head Start similarly waits before enabling the mode, cancellable by Stop, selection, shutdown and any available native operation signal.
- Startup, tree, auto-start, fork and failed-Stop reload restoration (including Start's initial attachment and fork retry) also await exclusion. Until acceptance, the mode stays in the selected inactive policy and private memory reports the pending selection. Off stays Off; later inactive choices survive read-only recovery without cancelling it.

**Locks.** Interrupted, malformed or unreadable locks are never stolen. Reconcile the owner rather than deleting locks or state directories just because an operation is slow. File-cohort exclusion, exact prepared bytes and compare-and-swap checks are not kernel-atomic multi-file transactions against nonparticipating writers.

**After a crash.** Fatal process termination can leave an incomplete canonical file cohort. Before repairing:

1. Quiesce all store writers.
2. Preserve the complete store plus the selected Pi retained-boundary references.
3. Reconcile the exact files against the last complete checkpoint/tail/metadata cohort.

No automatic crash repair or power-loss durability is promised, and Git backup has no semantic recovery authority.

**Concurrent shared streams.** Independently valid shared streams may require a fresh composed origin, without inventing cross-writer history. Authored patches use that current basis; raw precomputed replay still refuses an advanced target instead of applying stale normalized changes. Rollback restores only bytes that still match that publisher's output and preserves detected external changes. See [performance evidence](performance.md) for measured contention and the [acceptance map](temporal-acceptance.md) for the tested boundaries; the [backlog](../BACKLOG.md) owns open implementation work.

## Lazy navigation and historical reading

Lazy bodies require explicit reads:

- Automatic state and recent-transition projections omit them, including lazy deletions. Bounded `lazy_navigation` can still show the current layer's presence, path and key types.
- Explicit `session.lazy.releasePlan` reads the current value; `session[3].lazy.releasePlan` reads the exact older value only if that causal boundary is still available.
- Filtering automatic visibility does not renumber history or erase already communicated native/user/tool/response text.

**Historical search is task-driven.** A missing path or runtime hint does not by itself require historical search.

- If the old value is unnecessary, continue without searching.
- If it can help the current task, the agent may choose a targeted historical read without separate user permission.
- A found value is historical evidence, not automatically current memory; do not restore deleted data without an independent reason.
- Do not scan all offsets, and do not use repair inference or automatic hydration.

**Dangling-reference hints.** A hint accompanies only an unresolved single value read that has verified current reference sources.

- Its `paths` are the owners of those references, not verified new locations of the requested data.
- It does not prove that the target existed, is still retained or was moved.
- The bounded lookup searches current state only and emits no lazy bodies.
- A proven stale reference may be repaired within touched work, without resurrecting its target.
- Without a match, ordinary missing-path errors remain; keys, patch and batch projections keep their existing contracts.

Intent-owned lazy or working keys disappear when their owning intent is deleted, so a later missing path may be an expected cascade rather than a broken reference. The deletion appears in the accepted `patch_state` receipt and in the scope's retained patch history. See [intent ownership](lazy-state.md#intent-ownership).

Artifact freshness/invalidations and optional Skill acquisition hints keep their exact source/scope targets. Hints expose possibilities and diagnostic evidence; the current task decides whether action is necessary.

## Memory and source acquisition

The agent should use sufficient materialized knowledge before rereading files. It reads for a concrete gap, an exact-source/edit operation, an evidenced invalidation, a contradiction or failure, an explicit request, or bounded maintenance, not simply because a new session began.

**Artifact maintenance:**

- It inspects only exact paths already registered in global, CWD or session state, using `size + mtimeNs`, without directory traversal or generic content hashing.
- Proven-missing paths are pruned from their exact owning scopes. Unavailable, relative, directory and symlink paths are preserved.
- Changed sources keep their artifact value and receive a runtime-only model `hint` until a stable read and same-path compilation update the hidden provenance.
- Model patches cannot author or delete runtime provenance or hints.

**Skills.** Only exact registered Pi Skill reads enter the separate hash protocol. Public Pi source provenance maps user Skills to global, project Skills to CWD and temporary Skills to session. Matching compiled hashes need no update, and an uncompiled read stays volatile without blocking unrelated patches.

**Packaged Skills:**

- `state-flow-guide` answers concrete operational questions about reads, patches, inheritance, acquisition, completion and recovery, without starting cleanup.
- `state-flow-memory` handles explicitly requested bounded curation and externally verified transfers. External transfers use the destination's native receipt and keep the source whenever acceptance is uncertain.
- Feature/release/project boundaries may motivate recommending cleanup, not starting an audit. Ordinary handoffs reconcile touched state; neither Skill is a background maintenance loop.

Artifact/compiler details and model-tool contracts belong in the [architecture](architecture.md#artifact-routing).
