# State Flow architecture

## Purpose

State Flow is a Pi extension that materializes compact, scoped semantic state across agent runs while preserving Pi's native session trace and tool loop. It is inspired by SKILL.state but uses its own temporal model, storage plane, artifact compiler, and publication lifecycle.

The extension owns durable memory while enabled. Global semantic memory is always available; there are no ownership or global-memory feature switches.

## Composition

`index.ts` is the public export and extension composition boundary. Independent modules under `lib/` own one concern each and are mirrored by tests:

- `state`, `json`: semantic shape, validation, recursive overlay and deletion.
- `temporal`, `history`: causal boundaries, checkpoint/tail folding and hot history.
- `durable`, `storage`, `git`: exact files, CAS publication, Git commits and restoration.
- `snapshot`, `session`, `runtime`, `recovery`, `episode`: Pi branch/runtime lifecycle.
- `transition`, `terminal`, `validation`, `context`: inference barriers and final reconciliation.
- `artifact`, `acquisition`, `maintenance`, `skills`, `rehydration`: source routing and compilation.
- `memory`: external promotion records and memory diagnostics.
- `continuation`: native-header discovery, runtime-provenance inspection, deterministic recommendation, and host startup precedence.
- `publication`: remote policy, durable CAS queue/store, cross-process leases, and asynchronous worker lifecycle.
- `status`, `extension`: operator projection and Pi adapter wiring.

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

True semantic no-ops create no identity, commit or history step. A changed finalized response is semantic state and advances history.

## Pi lifecycle

`patch_state` is the sole mutation tool. It validates and publishes one scope patch immediately, then acts as an inference barrier. Pi executes no sibling tools from the same assistant response; the next inference sees rematerialized `state[0]`.

`read_state` reads one cached effective or scoped projection at offsets zero through seven. It never publishes or advances history.

Every successful enabled run ends with terminal reconciliation. A private `state_flow` comment may provide multi-scope transitions, followed by one blank line and the visible answer. An ordinary answer means an empty model patch but still updates session `response` when changed. Pi's finalized message at `turn_end` is authoritative for response reconciliation.

The current user specification stays at user authority and appears only in synthetic user runtime context. State is fallible assistant-produced data. Completed trajectories leave model context at user-run boundaries, while Pi's full JSONL trace remains inspectable.

## Storage and identity

The default store is `<agentDir>/state-flow`, independent from Markdown discovery at `<agentDir>/knowledge`.

Owned paths are:

```text
checkpoint.json
patches.jsonl
<cwd-key>/checkpoint.json
<cwd-key>/patches.jsonl
<cwd-key>/<session-key>/checkpoint.json
<cwd-key>/<session-key>/patches.jsonl
<cwd-key>/<session-key>/config.json
<cwd-key>/<session-key>/meta.json
```

CWD and session keys mirror Pi's native encoding. The Pi UUID remains authoritative; readable directory keys never replace identity validation.

`config.json` owns branch runtime behavior. `meta.json` owns lineage, counters, identity, publication provenance and remote-publication policy. Pi checkpoints retain only an exact Git revision, an exact `file:<hash>` cohort reference, or a proven ordinary-disabled marker.

All owned writes use same-directory atomic replacement, regular-file and symlink checks, prepared byte receipts and CAS validation. Unrelated files, staging and concurrent bytes are preserved. Rollback restores only bytes still matching the failed publisher's output.

## Optional Git

If Git is unavailable specifically through executable `ENOENT`, State Flow uses file-only persistence. File mode retains exact current materialization and proven hot history but offers no arbitrary cold revisions.

With Git, each effective semantic cohort creates one local commit immediately through an isolated index. Git supplies cold history and exact branch restoration. Runtime `revision: "self"` resolves to the commit that owns the runtime record, never arbitrary `HEAD`. Runtime-only writes may use `temporalRevision` to select older semantic streams without rewinding live shared files.

Installing Git over a file-only store adopts the exact current cohort without fabricating earlier history. Legacy layouts remain read-only historical inputs until explicitly migrated.

## Remote publication

Local acceptance and remote replication are separate.

The persisted `remotePublication` policy is:

- `turn-end`: default for new runtimes; local commits are immediate and the newest turn target is queued.
- `off`: local commits only.
- `transition`: synchronous compatibility behavior for legacy runtimes.

A destination is identified by canonical Git common directory, remote and full ref. Queue files live beneath the Git common directory and are not semantic history.

The queue uses exact commit targets, strict versioned JSON, symlink-safe atomic writes, CAS receipts and exclusive writer locks. A proven descendant may supersede an older target; divergent targets and changed destinations fail closed.

After terminal acceptance, an asynchronous non-interactive worker pushes the newest target. Queue failure never rolls back semantic state or regenerates an answer. Failed and interrupted attempts remain retryable across restart. Destination-scoped worker leases prevent cross-process overlap, preserve live owners, recover proven-dead owners and use exact release tokens. Confirmation removes only the exact completed target; a newer descendant remains queued.

## Artifact routing

Markdown discovery recursively finds regular lowercase `*.md` beneath the configured Knowledge root, rejects symlinks, hashes opaque bytes and never injects source bodies.

Artifact metadata requires:

```json
{
  "description": "routing summary",
  "hash": "sha256:<source bytes>",
  "compiler": "artifact-v1"
}
```

Compiler output may add arbitrary finite non-null JSON metadata. Known optional fields include `kind`, `compiled_at`, `tags` and `compilation`. Tags are unique trimmed non-empty strings and support deterministic candidate filtering, but never authorize reading.

Freshness depends on source hash and compiler revision. New, changed, compiler-stale, malformed or explicitly refreshed sources become invalidations. Exact successful native Pi reads are correlated with current candidates; stale reads require same-path compiler output before trusted hash/compiler metadata is attached.

Compilation is routing, not a substitute for source text. Full source is read only for a concrete unresolved gap, exact source/edit operation, invalidation, contradiction/failure, explicit request or bounded maintenance. The rehydration planner supports new-bootstrap, resume-bootstrap and later-step phases while limiting read count and source bytes without performing hidden I/O.

Skills are CWD artifacts with stricter compilation: `kind: "skill"` and a non-empty compilation describing applicability, constraints and failure conditions. Their source bodies do not persist in state. Matching source hash and compiler metadata proves source-version consistency, not semantic fidelity, truth, or higher instruction authority.

## Memory curation and promotion

The optional packaged `state-flow-memory` Skill performs bounded explicit audits, scope narrowing, contradiction cleanup and external handoffs. It is not part of ordinary retention or background maintenance. Curation compiles a read Skill at CWD before accumulating global compilation obligations, writes and separately reads a migration destination before source deletion, then verifies the changed scope and effective overlay. Simultaneously pending CWD/global acquisitions use existing terminal multi-scope reconciliation; `patch_state` remains single-scope and separate calls are not atomic migration.

External promotion remains a semantic two-phase handoff, not a memory-owner mode. Optional global `working.memory_promotions` entries record `pending`, `accepted`, `failed` or `unknown` status plus owner. Accepted records additionally require destination pointer and revision. Failed or uncertain promotion preserves the State Flow candidate; the only accepted copy is never deleted.

## Session continuation

The package exposes read-only host contracts that:

- read only native JSONL headers, never transcript bodies;
- inspect exact file/Git State Flow runtime provenance without mutation;
- rank exact profile, CWD, Git common-directory, worktree, branch and transport identity;
- fail closed for stopped, malformed, unavailable or ambiguous candidates;
- preserve explicit new/resume and native picker precedence;
- project new-bootstrap, resume-bootstrap and later-step rehydration phases.

Pi 0.84.4 chooses or creates `SessionManager` before package resources and extensions load. Therefore native default auto-resume cannot be installed safely by this extension alone. The remaining host integration requires an upstream pre-session resolver hook or an SDK/launcher that invokes the advisory resolver before constructing the session.

## Configuration

`state-flow.json` is loaded once per extension load/reload:

```json
{
  "directory": "~/.pi/agent/state-flow",
  "autoStart": false,
  "remotePublication": "turn-end"
}
```

Unknown keys fail loading. State Flow memory ownership and global availability are fixed invariants and have no configuration options.

## Observability

`/state-flow-status` reports branch mode, runtime revision, temporal head/history depth, scope keys, patch tails, artifact freshness, memory-bearing scopes, external-promotion summaries, remote policy/queue state, pending publication and terminal retry state. Unavailable materialization is reported as unavailable, never fabricated as empty. Artifact source bodies are not read for status.

## Validation boundaries

Structural validation proves JSON shape, exact identity, causal lineage, freshness, CAS and publication invariants. A valid state, receipt, source hash, or compiler revision cannot prove semantic importance, truth, sufficient compilation, correct scope, useful curation, or historical deletion. Those remain model-judgment concerns evaluated separately from deterministic transport checks.

The continuity requirement and deterministic evidence map is in [continuity-acceptance.md](continuity-acceptance.md). The executable temporal requirement map is in [temporal-acceptance.md](temporal-acceptance.md). Canonical remaining work is in [BACKLOG.md](../BACKLOG.md), and shipped outcomes belong in [CHANGELOG.md](../CHANGELOG.md).
