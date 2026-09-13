# Usage and recovery

For the concept and installation, start with the [README](../README.md). This guide covers operating State Flow; the [architecture](architecture.md) owns its internal contracts.

## Session behavior

`/state-flow-start` initializes any missing storage and enables the current Pi branch. No remote is required. Starting mid-conversation retains Pi's active context for one complete bootstrap run, during which the agent must compile future-relevant information into state.

- **New session:** Ordinary Pi unless `autoStart` is enabled. An enabled new session has its own empty session layer and inherits global/CWD state, never another session's private continuation.
- **Resume:** Restores the selected session's stored enablement, state, and lineage. Agent-level `autoStart` does not override a resumed branch.
- **Tree navigation:** Restores the selected checkpoint and recorded state revision without checking out or resetting the shared store.
- **Abort inference:** Stops generation while already accepted patches remain durable for continued work and corrected direction in the same session. It does not roll back memory or require immediate remote replication.
- **Stop:** Disables semantic tools and updates immediately on the selected branch; ordinary prompt composition resumes with the next user run. It preserves state and does not create a semantic transition or change automatic-start policy for future new sessions.
- **Continue after Stop:** The same physical session retains a frozen state handoff, any interrupted current request and tool trajectory (including late results), and post-stop conversation. Completed earlier conversation stays excluded, while other extensions' custom context survives. Reload/resume/tree preserve this projection; new/forked physical sessions do not inherit it. Active restart uses it for one bootstrap run.
- **Completed-history compaction:** After a sufficiently large accepted run settles without queued input, State Flow asks Pi for a native compaction boundary. No extra model summary is requested; Pi keeps the final accepted answer in active history and retains the complete append-only JSONL/tree. On resume, native `buildContextEntries()` and TUI rendering omit the older completed prefix. Pi may decline small histories. Foreign custom context, bootstrap/fallback/abort/error, Stop and pending input prevent State Flow-owned shortening; ordinary manual/threshold/overflow compaction remains native and may preserve unfinished work not yet patched into memory.

State Flow does not undo tool effects. After interruption or returning to an older branch, check the relevant workspace or external system before repeating consequential operations. Restored memory is not restored reality.

### Fork support and limits

Native fork replacement copies the source session checkpoint, retained patch tail and matching provenance into the new session's own storage. Global/CWD streams and provenance stay current and unchanged. An earlier fork selection copies that point's private state, not the parent's later private work. Parent data/history remain intact; selected enablement is retained, so a stopped source does not become enabled automatically.

The child starts at step zero and a new temporal origin. Its copied tail is preserved, but pre-origin records are not seven past aligned `state[n]` boundaries. The child's own transitions build its hot window; owned checkpoints support normal reload/resume. Parent Stop projection is not inherited, including after child reload.

Initial copying requires a native fork start event, a regular canonical direct-parent session file, matching CWD/identity, a readable temporal source and an unused child namespace. Missing/unsafe evidence or CAS conflicts leave the copy unavailable rather than importing unrelated or newer private state. Explicit Start can retry an unaccepted copy in the same loaded fork after the cause is corrected.

Selecting a copied parent checkpoint through the child's `/tree` does not make it child-owned: State Flow stays disabled without resetting existing child data. Select a child-owned checkpoint or resume the original session. Cold recovery before the first child checkpoint, startup paths lacking the fork event, in-memory parent locators and cross-CWD imports remain outside this slice. File-only copying requires an exact still-available source cohort. See the [contract](fork-contract.md) and [SDK evidence](compatibility.md#native-replacement-witnesses); do not rewrite UUIDs or delete pointers to force recovery.

## Configuration

Optional `state-flow.json` beneath Pi's agent directory, normally `~/.pi/agent/state-flow.json`:

```json
{
  "directory": "~/.pi/agent/state-flow",
  "autoStart": false,
  "logging": false,
  "remotePublication": "turn-end"
}
```

- `directory`: State store. The default is `state-flow/` beneath the agent directory. Absolute paths, `~`/`~/`, and relative paths are accepted; relative paths resolve from the configuration directory, not project CWD.
- `autoStart`: Defaults to `false`. When `true`, genuinely new sessions use the same initialization as explicit Start, including fresh CWDs.
- `logging`: Defaults to `false`. When enabled, records rejected patches and unresolved terminal/fallback diagnostics locally at `tmp/state-flow/logs.jsonl` beneath the agent directory.
- `remotePublication`: New-runtime policy: `turn-end` queues the newest accepted commit for asynchronous push; `off` keeps commits local; `transition` retains synchronous compatibility behavior. Existing branches keep their persisted policy.

Settings are read once at extension load. After editing, use `/reload` or restart Pi. A missing file uses defaults without creating a configuration file; malformed JSON, unknown keys, or invalid values fail loading rather than silently selecting another store.

`PI_CODING_AGENT_DIR` changes the agent-directory default. Configuration remains in that directory even when `directory` selects another state store. This override does not move data or redirect Knowledge discovery, whose default remains `knowledge/` beneath the agent directory. SDK overrides are documented under [embedding](architecture.md#embedding).

### Diagnostic logging and privacy

Rejected-call records may contain exact attempted arguments and useful draft text, plus the error, tool/call identity, and resolution state. Successful patches are not logged; reasoning bodies are excluded. Logs are not semantic state, scope metadata, Pi checkpoints, or publication input. If the log path overlaps a custom state repository, capture fails closed instead of committing it. A logging failure changes no accepted state and produces at most one local warning.

Logs remain local unless you move them; rotation/deletion is operator-owned. Treat them and state files as private. Removing a secret from current state does not erase older offsets, Git history, native sessions, or remote copies.

## Status and controls

`/state-flow-status` separates runtime configuration/metadata from semantic state. It reports:

- Selected CWD/session keys, step, temporal head, durable revision, and available hot history.
- Per-scope retained patch tails and artifact counts, plus one JSON representation of effective global → CWD → session memory. Individual scope JSON is available through `read_state`, not duplicated in status.
- Discovered Markdown invalidations or unavailable freshness evidence.
- Remote policy, queued/unconfirmed publication, and relevant errors.
- Memory-bearing scopes and external-promotion records, including invalid or incompletely evidenced acceptance.

Tail counts are not history depth: inherited records may predate the active origin. Failed inspection reports unavailable evidence, not invented empty state or a clean freshness count. Status hashes source bytes as needed for freshness diagnostics; it does not dump Markdown bodies.

The terminal indicator is `state-flow #N`. When `pi-telegram` is available, one main-menu section carries the live State Flow status and opens Start/Stop controls. Start requested during a run waits for settlement; Stop currently applies immediately. The adapter is optional and the Pi commands remain available without it. Remaining hardening work is tracked in [BACKLOG.md](../BACKLOG.md).

## Storage and recovery

Use a dedicated directory. State storage and Knowledge Markdown have separate responsibilities:

```text
<agentDir>/state-flow/   accepted state and runtime metadata
<agentDir>/knowledge/    optional Markdown sources for compilation
```

Each scope materializes an anchored `checkpoint.json` plus `patches.jsonl`. Scope `meta.json` holds runtime-owned artifact evidence; the session also has `config.json` and temporal/runtime metadata. CWD/session directories mirror Pi's native naming while validating canonical identities separately. See the [storage contract](architecture.md#storage-and-identity) for the exact layout.

### With Git

Start initializes an exact-root repository when needed, preserving existing contents. Git must have a configured commit identity. A containing ancestor repository is not a substitute. Manual-mode startup/status/restore do not initialize Git; explicit Start and automatic activation of genuinely new sessions may do so.

Every effective semantic transition, including a changed answer, receives an immediate local commit. Each commit includes the complete non-ignored worktree delta before overlaying the prepared State Flow outputs, and synchronizes the visible index to the accepted tree. This is why the store must not be an unrelated working repository. Untracked ignored files remain untouched; State Flow-owned active files stay under its publication/CAS contract.

A remote is optional and operator-owned. State Flow creates no account, hosted repository, credentials, or remote configuration. Remote failure does not undo an accepted local commit or require regenerating an answer; retry targets that existing commit. With no remote, the store is intentionally local-only.

An asynchronous push has a 15-second budget. Pi shutdown, reload and native session replacement cancel owned pushes and wait up to two seconds for cleanup; it leaves unconfirmed targets queued, without advancing semantic history. If child exit cannot be confirmed, a warning reports the retained lease. Do not delete it to force a retry while its owner is still live. A later activation can retry after cleanup; timeouts do not spin an immediate retry loop for the same target. The compatibility `transition` mode keeps its existing synchronous behavior. SDK embedders must deliver the [shutdown event](architecture.md#embedding), not just discard the session object.

Inspect a Git-backed store without modifying it:

```bash
git -C ~/.pi/agent/state-flow status --short
git -C ~/.pi/agent/state-flow log --oneline -10
git -C ~/.pi/agent/state-flow show <selected-revision>:checkpoint.json
```

Use the revision reported for the selected Pi branch. Shared live files may belong to a newer branch, so `HEAD` is not automatically that branch's memory.

### Without Git

Only an absent Git executable selects file-only mode; Git corruption, permission errors, and command failures remain errors. Files retain current materialization and its proven hot history. Their `file:<hash>` checkpoint reference identifies one exact current cohort, not an arbitrary historical snapshot.

Restart can restore that reference while its complete cohort remains available. An older branch or a crash between file publication and Pi checkpoint append can leave a reference unavailable even though newer files exist. State Flow must not pass those newer files off as the selected past. Preserve the store and diagnose the reference rather than resetting it.

If Git becomes available later, explicit Start can adopt the proven current file cohort. It preserves state, step, and hot lineage; Git cold history begins at adoption rather than inventing earlier commits.

### Moving or migrating a store

Changing `directory` selects a location; it does not relocate existing state or history. Git-backed Pi checkpoints require their original commit objects. Copying only current checkpoint/tail files cannot preserve old branch recovery. Keep the original store intact until an explicit history-preserving relocation is complete, or use a genuinely new Pi session for an independent store.

In-store predecessor-format migration is different: legacy current `state.json` snapshots become initial anchored checkpoints with empty tails. Current snapshots, not explanatory journals, are the recovery basis. Successful migration removes obsolete ownership and preserves only proven history. Let the runtime perform supported migration; manually renaming files is not a valid conversion.

Pre-0.4 hashed-path layouts remain readable at their historical revisions and can be adopted into native paths at current HEAD. A missing revision or failed restoration is not permission to import another session or reset existing files.

### Conflicts and interrupted publication

Cooperating writers use publication locks, exact prepared bytes, and compare-and-swap checks. These are not kernel-atomic multi-file transactions against nonparticipating writers. A busy publication lock fails before writes and is not silently stolen; reconcile the active or interrupted owner before retrying. Do not delete locks or state directories merely because an operation is slow.

Fatal process termination during local Git publication can leave attempted worktree files, a private index and publication locks. HEAD may or may not have advanced; a new commit need not have returned success or reached a Pi checkpoint. The [fatal-writer witnesses](temporal-acceptance.md#fatal-writer-interruption) preserve earlier accepted revisions and read-only inspection while new writes and live restore installation remain blocked. A dead PID alone does not establish which effects completed or whether Git children stopped. Before any repair, quiesce all store writers and preserve the complete store, Git/index data and selected Pi references; reconcile the exact interrupted attempt before clearing ownership. No automatic crash repair or power-loss durability is promised.

Worker lease recovery is separate from stealing a publication lock: it accepts only a validated regular-file record whose PID is proven gone, then rechecks ownership under the queue writer lock. Malformed and symlink lease records stay untouched. Upgrade/reload all publishing instances together; older still-running code can bypass the updated reclamation gate.

An untouched shared scope may be adopted from newer proven live state at a fresh origin. A patch that actually changes an advanced shared scope fails with a named conflict instead of silently overwriting it. Rollback restores only bytes still matching that publisher's output and preserves detected external changes. See [performance evidence](performance.md) for measured contention and the [acceptance map](temporal-acceptance.md) for the tested boundaries; the [backlog](../BACKLOG.md) owns remaining release gates.

## Memory and source acquisition

The agent should use sufficient materialized knowledge before rereading files. Read for a concrete gap, exact-source/edit operation, evidenced invalidation, contradiction/failure, explicit request, or bounded maintenance—not simply because a new session began.

Knowledge discovery finds regular lowercase `*.md` beneath its configured root, hashes opaque bytes, and skips symlinks. Only confirmed missing Markdown paths within an available root are pruned; external/non-Markdown artifacts and state under a missing whole root are preserved. An unavailable root makes freshness unknown in status. Successful reads of stale ordinary candidates require same-path global compilation; Skill reads require CWD compilation. The runtime owns provenance: model patches cannot write or delete individual freshness fields, including legacy spellings. Existing legacy entries remain readable and semantically editable. Missing freshness evidence means unknown-but-usable, not proof that a source was acquired.

The optional `state-flow-memory` Skill handles explicit bounded curation and external promotion. It is not a background maintenance loop. Promotion must verify the destination before removing the only accepted source copy. Artifact/compiler details and model-tool contracts belong in the [architecture](architecture.md#artifact-routing).
