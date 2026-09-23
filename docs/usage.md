# Usage and recovery

For the concept and installation, start with the [README](../README.md). This guide covers operating State Flow; the [architecture](architecture.md) owns its internal contracts.

## Session behavior

`/state-flow-start` initializes any missing storage and enables the current Pi branch. No remote is required. Starting mid-conversation retains Pi's active context for one complete bootstrap run, during which the agent must compile future-relevant information into state.

- **New session:** Passive durable memory is available by default without starting an episode. `autoStart` promotes genuinely new sessions into active State Flow; an active new session has its own empty session layer and inherits global/CWD state, never another session's private continuation.
- **Resume:** Restores the selected session's stored enablement, state, and lineage. Agent-level `autoStart` does not override a resumed branch.
- **Tree navigation:** Restores the selected retained private boundary over live shared scopes without checking out or resetting the shared store.
- **Abort inference:** Stops generation while already accepted patches remain durable for continued work and corrected direction in the same session. It does not roll back memory or require immediate remote replication.
- **Native boundary continuation:** A companion may continue through Pi's `turn_end` or `agent_before_settle` boundary without a new user prompt. State Flow keeps projecting current memory and accepted response across those requests and subsequent patches; it does not restore the completed specification or request another turn itself.
- **Stop:** Ends active episode semantics and returns to the configured passive bootstrap/tool combination. For a proven pre-runtime branch, it records only the existing disabled checkpoint in Pi, without creating canonical files or publishing the passive view; later Start or passive patch remains available. For an accepted runtime, it adopts unrelated shared-state changes without semantic/provenance writes or step changes, while same-session conflicts still fail closed. Its frozen handoff uses the accepted view. It does not change passive or automatic-start policy.
- **Continue after Stop:** The same physical session retains a frozen state handoff, any interrupted current request and tool trajectory (including late results), and post-stop conversation. A proven active boundary excludes completed earlier conversation; when native split-turn compaction removed the original request anchor, Stop instead preserves the available summary and tools without reconstructing discarded raw input. Other extensions' custom context survives. Idle Stop still retains only later conversation plus foreign custom context. Reload/resume/tree preserve this projection; new/forked physical sessions do not inherit it. Mid-tool Start and repeated Start/Stop retain the first user event already observed while disabled, so subsequent Stop does not mistake that busy run for idle. Active restart uses the retained projection for one bootstrap run.
- **Completed-history compaction:** After an accepted run settles without queued input, State Flow asks Pi for a native compaction boundary only when public context usage reaches 24,000 tokens. No extra model summary is requested; Pi keeps the complete latest run—from its original request through steering, tools, foreign context and final answer—in active history and retains the complete append-only JSONL/tree. State Flow uses the native first-user anchor, independent of image-normalization hints or later steering; images and earlier tool results remain available to the model. Uncertain projection retains available context without changing that anchor. A missing or ambiguous native anchor skips compaction instead of choosing the last steering message. On resume, native `buildContextEntries()` and TUI rendering omit the older completed prefix. Unknown or smaller usage skips the request, and custom Pi retention settings may still decline it benignly. Foreign custom context in the removed prefix, bootstrap/abort/error, Stop and pending input prevent State Flow-owned shortening; ordinary manual/threshold/overflow compaction remains native and may preserve unfinished work not yet patched into memory.

State Flow does not undo tool effects. After interruption or returning to an older branch, check the relevant workspace or external system before repeating consequential operations. Restored memory is not restored reality.

### Fork support and limits

Native fork replacement copies the source session checkpoint, retained patch tail and matching provenance into the new session's own storage. Global/CWD values and provenance stay current; applying a smaller `historyLimit` may fold shared tails under CAS. An earlier fork selection copies that point's private state, not the parent's later private work. Parent-private data/history remain intact; selected enablement is retained, so a stopped source does not become enabled automatically.

The child starts at step zero and a new temporal origin. Its copied tail obeys the configured retention limit, but pre-origin records are not additional aligned causal boundaries addressable through `effective[n]` or scoped paths. The child's own transitions build its hot window; owned checkpoints support normal reload/resume. Parent Stop projection is not inherited, including after child reload.

Initial copying requires a native fork start event, a regular canonical direct-parent session file, matching CWD/identity, a readable temporal source and an unused child namespace. Missing/unsafe evidence or CAS conflicts leave the copy unavailable rather than importing unrelated or newer private state. Explicit Start can retry an unaccepted copy in the same loaded fork after the cause is corrected.

Selecting a copied parent checkpoint through the child's `/tree` does not make it child-owned: State Flow stays disabled without resetting existing child data. Select a child-owned checkpoint or resume the original session. Cold recovery before the first child checkpoint, startup paths lacking the fork event, in-memory parent locators and cross-CWD imports remain outside this slice. File-only copying requires an exact still-available source cohort. See the [contract](fork-contract.md) and [SDK compatibility boundary](compatibility.md#public-host-seams); do not rewrite UUIDs or delete pointers to force recovery.

## Configuration

Optional global `config.json` at the root of the State Flow repository, normally `~/.pi/agent/state-flow/config.json`:

```json
{
  "autoStart": false,
  "passiveBootstrap": true,
  "passiveTools": true,
  "logging": false,
  "showSuccessfulPatches": true,
  "historyLimit": 7
}
```

The canonical store is `state-flow/` beneath the agent directory. Keeping configuration inside that repository removes the separate agent-level `state-flow.json`; SDK embeddings may still provide an explicit repository override.
- `autoStart`: Defaults to `false`. When `true`, genuinely new sessions use the same initialization as explicit Start, including fresh CWDs.
- `passiveBootstrap`: Defaults to `true`. Projects existing effective durable memory into ordinary model context without creating scopes, publishing, or starting an episode.
- `passiveTools`: Defaults to `true`. Exposes `read_state` and `patch_state` outside active episodes. Reads remain side-effect free; the first explicit patch may initialize absent canonical storage but never converts predecessor formats or enables an episode or State Flow compaction.
- `logging`: Defaults to `false`. When enabled, records rejected patches and accepted-answer reconciliation failures locally at `tmp/state-flow/logs.jsonl` beneath the agent directory. Asynchronous Git push failures are recorded there even when this setting is off.
- `showSuccessfulPatches`: Defaults to `true`. In interactive Pi, successful `patch_state` rows show only the applied pretty-printed JSON arguments, with blank lines between adjacent memory sections; set it to `false` to keep only the compact summary. Rejected calls still use ordinary error rendering; State Flow adds no private validation turn.
- `historyLimit`: Defaults to `7` and accepts integers from `0` through `100`. It bounds materialized-history and scope patch-history offsets. Lowering it on reload/restore/fork folds excess tails forward without losing current state; selected boundaries outside the new window are unavailable. Zero retains only current checkpoints. Raising the limit affects only future retention and cannot reconstruct discarded history.

Settings are read once at extension load. After editing, use `/reload` or restart Pi. A missing file uses defaults without creating a configuration file; malformed JSON, unknown keys, or invalid values fail loading rather than silently selecting another store.

`PI_CODING_AGENT_DIR` changes both the default State Flow repository and its global configuration location. State Flow has no source-directory or Knowledge-root configuration. SDK repository overrides are documented under [embedding](architecture.md#embedding); an overridden repository owns its own root `config.json`.

### Diagnostic logging and privacy

Rejected-call records may contain exact attempted arguments and useful draft text, plus the error category and tool/call identity. Asynchronous push failures retain the available redacted Git error there regardless of `logging`; interactive warnings stay short and appear once per failure streak, then reset on success. If logging the push failure is unavailable, one warning exposes the available detail instead. Successful patches are not logged; reasoning bodies are excluded. Logs are not semantic state, scope metadata, Pi checkpoints, or publication input. If the log path overlaps a custom state repository, capture fails closed instead of committing it. A logging failure changes no accepted state and produces at most one local warning.

Logs remain local unless you move them; rotation/deletion is operator-owned. Treat them and state files as private. Removing a secret from current state does not erase older offsets, Git history, native sessions, or remote copies.

## Status and controls

`/state-flow-status` separates runtime configuration/metadata from semantic state. It reports:

- Selected CWD/session keys, internal step, independent scope revisions, temporal head, recovery failures, and available hot history.
- Per-scope retained patch tails and artifact counts, plus one JSON representation of effective global → CWD → session memory. Individual scope JSON is available through `read_state`, not duplicated in status.
- Already-known runtime hints or pending artifact invalidations; status does not discover or validate sources.
- Memory-bearing scopes. Promotion-shaped values receive no special interpretation.

Tail counts are not history depth: inherited records may predate the active origin. Failed inspection reports unavailable evidence, not invented empty state. Status is observational: it does not read source files, calculate fingerprints, create invalidations, or mutate semantic state.

The terminal indicator is `state-flow G15/C8/S31` only in active mode. Global, CWD and Session own independent semantic revisions; one atomic transition advances each materially changed scope once, including session-only response reconciliation. Effective has no scalar counter and uses the `G#/C#/S#` revision vector. When `pi-telegram` is available, its main-menu section shows that vector only while active and `State Flow: off` while passive. Requested owner-scope Rich snapshots show `#revision`; Effective shows the vector. Telegram inspection may lazily load or refresh live shared state from other instances even when passive model tools are disabled, but it does not initialize, publish, or advance storage. Start requested during a run waits for settlement; Stop currently applies immediately. The adapter is optional and the Pi commands remain available without it. Open implementation work is tracked in [BACKLOG.md](../BACKLOG.md).

## Storage and recovery

Use a dedicated directory. State storage and registered artifact sources have separate responsibilities:

```text
<agentDir>/state-flow/   global config, accepted state, and runtime metadata
<any exact registered path>   optional external source owned outside State Flow
```

Each scope materializes an anchored semantic-only `checkpoint.json` plus semantic-only lines in `patches.jsonl`. Scope `meta.json` holds temporal boundaries, CWD ownership where applicable, and runtime-owned artifact evidence. The session additionally uses `config.json` for behavior and `runtime.json` for branch/run recovery metadata; a full prompt is retained there only while its run is unfinished. CWD/session directories mirror Pi's native naming while validating canonical identities separately. See the [storage contract](architecture.md#storage-and-identity) for the exact layout.

### Missing, partial, and malformed storage

A checkpoint and tail are one semantic pair. If both live files for an untouched global or CWD scope disappear, State Flow treats that complete absence as current empty shared reality during the next accepted publication. It creates a fresh canonical pair through normal file-cohort exclusion and CAS; no cold Git value is resurrected. A patch targeting the disappeared scope is rejected once as stale so a later inference can work from the actual empty basis.

Exactly one surviving pair member is corruption and fails closed. Present malformed JSON, incomplete predecessor envelopes, semantic/metadata boundary mismatches, identity contradictions, and partial session runtime evidence also remain fail-closed and are not replaced. A missing or expired private retained boundary is unavailable; State Flow does not substitute Git history or newer private files.

After a selected-boundary failure, configured passive access may still expose current global/CWD memory, but it never grants access to the unavailable session layer or permission to publish an empty replacement. Session reads, every `patch_state`, and Stop refuse without changing canonical files or appending substitute checkpoints. Status retains the restoration error even when shared reads work. Start retries the original selection; repair its missing or invalid evidence, select a still-retained boundary, or use a genuinely new Pi session instead of forcing a reset.

Missing artifact provenance inside an otherwise complete scope `meta.json` means compilation evidence is unavailable while semantic state remains usable; removing the whole metadata file also removes temporal authority and fails closed. An unavailable registered source path does not prove that durable artifact routing was deleted, and external files are never created. State Flow has no durable push queue or publication-worker lease; failed replication is attempted again only after a later accepted turn. See the complete [filesystem recovery contract](filesystem-recovery.md).

### Canonical files and optional Git backup

Canonical scope/runtime files own current materialization and retained hot history regardless of Git availability. Pi checkpoints identify a retained semantic boundary, not a Git commit or arbitrary historical snapshot. Restart and branch restoration fail closed when the selected boundary has expired rather than substituting newer files as the selected past.

After an accepted turn has reconciled its response, Pi 0.87's final actionable `agent_before_settle` boundary may create one best-effort backup commit when Git is available. If the attached branch has an explicitly configured remote/ref, State Flow starts a non-interactive asynchronous push of the exact current commit without force. Settlement does not wait for the network. Within one Pi process, an in-flight push per repository skips overlapping attempts; a later accepted turn retries the latest backup without a durable queue. Session shutdown waits for that repository's in-flight push to close or time out, suppressing push-failure reporting after shutdown begins. Commit or push failure is diagnostic-only; repeated push failures warn once per failure streak and remain locally diagnosable. Git availability never changes semantic authority, step, or retained lineage.

### Moving a store and the 0.17 format boundary

An SDK `repositoryRoot` override or a different `PI_CODING_AGENT_DIR` selects a location; it does not relocate existing state or retained history. Copy the complete canonical store while all writers are quiescent, or use a genuinely new Pi session for an independent store. Copying only current checkpoints without their tails and metadata cannot preserve retained boundaries.

Starting with 0.17, State Flow accepts only its canonical checkpoint/tail, temporal metadata, and separate session config/runtime contract; that boundary still applies to current versions. A canonical 0.17 scope written before independent revisions remains readable: its initial counter uses only the retained semantic tail and is persisted in metadata version 2 on the next owned write, without inventing folded ancestry. Version 1 remains readable; older writers refuse version 2 through the existing provenance-version fence, so cooperating instances should upgrade together. Predecessor checkpoint envelopes, combined session metadata, pre-intents checkpoints, `state.json`, hashed layouts, and semantic Pi checkpoint envelopes fail as unsupported without rewriting existing bytes. State Flow does not provide an in-place converter; external conversion or a fresh store is operator-owned.

### Conflicts and interrupted publication

Cooperating canonical writers use file-cohort exclusion, exact prepared bytes, and compare-and-swap checks. These are not kernel-atomic multi-file transactions against nonparticipating writers. A busy writer lock fails before writes and is not silently stolen; reconcile the active or interrupted owner before retrying. Do not delete locks or state directories merely because an operation is slow.

Fatal process termination can leave an incomplete canonical file cohort. Before repair, quiesce all store writers and preserve the complete store plus selected Pi retained-boundary references. Reconcile exact files against the last complete checkpoint/tail/metadata cohort; no automatic crash repair or power-loss durability is promised. Git backup has no semantic recovery authority.

An untouched shared scope may be adopted from newer proven live state at a fresh origin. A patch that actually changes an advanced shared scope fails with a named conflict instead of silently overwriting it. Rollback restores only bytes still matching that publisher's output and preserves detected external changes. See [performance evidence](performance.md) for measured contention and the [acceptance map](temporal-acceptance.md) for the tested boundaries; the [backlog](../BACKLOG.md) owns open implementation work.

## Memory and source acquisition

The agent should use sufficient materialized knowledge before rereading files. Read for a concrete gap, exact-source/edit operation, evidenced invalidation, contradiction/failure, explicit request, or bounded maintenance—not simply because a new session began.

Artifact maintenance inspects only exact paths already registered in global, CWD, or session state, using `size + mtimeNs` without directory traversal or generic content hashing. Proven-missing paths are pruned from their exact owning scopes; unavailable, relative, directory, and symlink paths are preserved. Changed sources keep their artifact value and receive a runtime-only model `hint` until a stable read and same-path compilation updates hidden provenance. Only exact registered Pi Skill reads enter the separate hash protocol. Public Pi source provenance maps user Skills to global, project Skills to CWD and temporary Skills to session; matching compiled hashes require no update, and an uncompiled read remains volatile without blocking unrelated patches. Model patches cannot author or delete runtime provenance or hints.

The packaged `state-flow-guide` Skill answers concrete operational questions about reads, patches, inheritance, acquisition, completion, and recovery without initiating cleanup. The separate `state-flow-memory` Skill handles explicitly requested bounded curation and externally verified transfers. Feature/release/project boundaries may motivate recommending cleanup, not starting an audit. Ordinary handoffs reconcile touched state; neither Skill is a background maintenance loop. External transfers use the destination's native receipt and preserve the source whenever acceptance is uncertain. Artifact/compiler details and model-tool contracts belong in the [architecture](architecture.md#artifact-routing).
