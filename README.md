# Pi State Flow

> Inspired by [SKILL.state](https://arxiv.org/html/2608.26263v2)

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

State Flow exposes a **temporally indexed materialized state** for Pi:

```text
state[0] = now
state[1] = one accepted transition ago
...
state[7] = seven accepted transitions ago

state.global[n]   state.cwd[n]   state.session[n]
          projections at the SAME temporal boundary
```

`patch_state` explicitly advances that stream. Optional Git preserves complete older history for Git-backed transitions; without Git, files retain current state and its proven hot window. State Flow compiles decision-relevant reality; it neither owns Knowledge semantics nor replaces Pi's native tool loop or inspectable session trace.

## Installation

Requirements: Pi `0.84.4–0.84.x` and Node.js `22.19.0` or newer. Git is optional; when installed, it needs a configured commit identity. A remote is optional and operator-owned.

```bash
pi install npm:@llblab/pi-state-flow
# Or:
pi install git:github.com/llblab/pi-state-flow
```

Pi packages execute with full user permissions; review the source before installing. An installed published version may precede this working-tree architecture.

## Configuration

Optional `~/.pi/agent/state-flow.json` (or `state-flow.json` beneath `PI_CODING_AGENT_DIR`):

```json
{
  "directory": "~/.pi/agent/state-flow",
  "autoStart": false
}
```

- `directory`: State storage location; omitted defaults to `state-flow/` beneath Pi's agent directory. Absolute paths, `~`/`~/` and relative paths are supported; relative paths resolve from the configuration directory, not the project CWD.
- `autoStart`: Set to `true` to enable State Flow automatically for genuinely new sessions, including fresh CWDs. Omitted defaults to `false`: manual activation, even when previous CWD materialization exists.

Configuration is read at extension load; edit it and use `/reload` (or restart Pi) before opening a new session. Existing branches retain their stored enablement on resume/tree navigation. `/state-flow-stop` does not rewrite this file or disable automatic mode for later new sessions. Invalid JSON, unknown keys or invalid values fail extension loading rather than silently choosing another directory. A missing file uses defaults and is not generated automatically.

The configuration file stays in Pi's agent directory when state storage moves. A directory override selects a store; it does not migrate old data or Git objects. SDK embedders can set `StateFlowExtensionOptions.agentDir` for the profile, `repositoryRoot` to override the configured state directory, and `knowledgeRoot` independently for Markdown sources.

## Usage and activation

```text
/state-flow-start   # Initialize missing materialization and enable this branch
/state-flow-status  # Inspect runtime, semantic, freshness, and publication diagnostics
/state-flow-stop    # Disable this branch without deleting semantic state
```

A genuinely new session starts in ordinary Pi mode unless `autoStart` is enabled. Manual-mode startup is read-only with respect to storage initialization/migration. Configured automatic start uses the same optional-Git setup as explicit start and can create missing CWD materialization. Each enabled new session gets its own empty session layer and inherits only global/CWD state. It never borrows another session's values. Starting mid-conversation retains the active pre-Flow context for one complete bootstrap run; its terminal handoff must migrate future-relevant context.

Stopping changes the current session/branch configuration, preserves semantic checkpoints and tails, and creates no semantic history step. It does not change the agent-level `autoStart` setting for future new sessions. Resume and `/tree` restore the selected branch's configuration, metadata, and exact temporal lineage, not arbitrary repository `HEAD`. Older revisions are read through Git objects without resetting or checking out the shared worktree.

The compact status is an accent `state-flow` and dim `#<step>`. Detailed status distinguishes runtime config/meta from semantic materialization, reports scope keys, the selected temporal head and runtime revision, available hot offsets, per-scope retained patch tails, artifact counts, stale Markdown reasons, pending publication, and terminal retries. Retained tails may include inherited pre-origin records, so their counts are not the active history depth. It labels global/CWD/session/effective state without dumping source bodies. Failed inspection means unavailable evidence, never a falsely clean count.

## State, scope, and time

Every scope has exactly the same semantic shape:

```json
{
  "artifacts": {},
  "contract": {},
  "working": {},
  "response": "Latest complete user-facing answer"
}
```

- `artifacts`: Source-path-keyed compiled routing metadata and reusable operational knowledge.
- `contract`: Stable requirements, decisions, rejected approaches, and interface commitments.
- `working`: Verified observations, validation, failures, unresolved questions, and exact continuation.
- `response`: The complete answer captured by the runtime, normally in session state; models cannot patch it directly.

Effective state recursively overlays `global → cwd → session`; session wins. Scope is ownership, not instruction authority. Use session for branch/run-local continuation, CWD for project-local reusable state and Skill artifacts, and global for cross-project knowledge. Scope-local deletion reveals lower-scope values, including when reconstructing history.

Each accepted materially effective transition has one opaque identity and explicit parent lineage. Multi-scope patches share that identity. Unchanged scopes have no patch for that boundary and retain their values. Temporal position is not a count of local mutations or a timestamp sort. A branch-local ordinal may order parent-linked identities but cannot replace identity or merge forks.

For example:

```text
Boundary       T181   T182   T183   T184
Global         G      G      G'     G'
CWD            C      C'     C'     C''
Session        S      S'     S''    S'''

At T184:
state[1]         = overlay(G', C', S'')
state.cwd[1]     = C'
state.cwd[2]     = C'
state.global[1]  = G'
```

`state.cwd[1]` is not the preceding CWD patch. Every projection first resolves the same target in the active lineage. Offsets zero through seven are the hot range; offsets before a new or migrated lineage's proven origin are explicitly unavailable until enough transitions exist. Offset eight is outside this read contract even when Git contains older history.

### Lazy historical reads

Normal inference receives current effective `state[0]`, useful compact transition context, the current specification, and the complete current-run trajectory. It does not receive eight full snapshots. History is materialized only on a requested effective or scope read.

The pure accessor is `readTemporalState(view, offset, scope?)` in `lib/temporal.ts`, with scope omitted for effective state. The live adapter exposes the same lazy read semantics to embedders through `StateFlowExtensionOptions.onRuntime`; the callback receives a cached-runtime `read(offset?, scope?)` accessor. The model tool `read_state` accepts optional `offset` (integer 0–7, default 0) and `scope` (`effective`, `global`, `cwd`, or `session`, default `effective`). For example:

```json
{"offset": 1, "scope": "cwd"}
```

It returns one `{offset, scope, boundary, state}` result from cached runtime, with no publication, checkpoint append, or history step. Unavailable pre-origin history is an error, not an empty state. Use it for a concrete historical or scope-specific gap, not routine rereading of current context. Both State Flow tools are active only while the selected branch is enabled; `patch_state` remains the sole mutator and blocks `read_state` siblings at its inference barrier. SDK embedders using an explicit tool allowlist must include `read_state` as well as `patch_state`. The model reasons about state, scope, time, and transitions, not checkpoint folding mechanics.

## Temporal storage

State Flow owns a separate state directory at `~/.pi/agent/state-flow/`, optionally backed by Git. Knowledge remains an independent Markdown source at `~/.pi/agent/knowledge/`. Both defaults follow Pi's configured agent directory (`PI_CODING_AGENT_DIR`); [configuration](#configuration) can select a different state store. Changing the storage root does not redirect Markdown discovery.

```text
state-flow/
├── .git/                 # When Git-backed
├── checkpoint.json
├── patches.jsonl
└── <cwd-key>/
    ├── checkpoint.json
    ├── patches.jsonl
    └── <session-key>/
        ├── checkpoint.json
        ├── patches.jsonl
        ├── config.json
        └── meta.json
```

Explicit `/state-flow-start` creates a missing state directory. With Git available, start initializes an exact-root Git repository when needed, including a populated state directory, without deleting existing files or staging unrelated content. An active file-backed branch must identify its exact current cohort before it can be adopted into Git. If the Git executable is absent, state persists directly to files without repository operations. Git command failures, corruption, or permission errors are not treated as executable absence. Manual-mode startup, status, and branch restoration do not initialize Git; configured automatic start for a new session may do so. The extension creates no GitHub account, external repository, or remote configuration, and does not invent a Git commit identity.

For local debugging after Git-backed initialization:

```bash
git -C ~/.pi/agent/state-flow status --short
git -C ~/.pi/agent/state-flow log --oneline -10
git -C ~/.pi/agent/state-flow show <revision>:checkpoint.json
```

`/state-flow-status` identifies the active scope keys and selected revision. Live files may belong to a later branch; use that selected revision for historical inspection rather than assuming the worktree represents the current Pi branch. State may include private session content; review it before configuring any remote.

All three semantic scopes use one storage model:

```text
current scope = materialize(anchored checkpoint, ordered patch tail)
current effective = overlay(global current, CWD current, session current)
```

The checkpoint is an **older** materialized scope snapshot with an unambiguous `through` boundary. Its envelope is runtime-owned; its `state` contains only the four semantic fields. Each `patches.jsonl` holds at most seven scope-local replay records after that anchor. A record carries the shared transition identity/lineage and an effective semantic patch, including runtime-observed artifact freshness when applicable.

On an eighth scope patch, apply the oldest retained patch into the checkpoint, advance `through`, remove that patch, and append the new one. This deterministically preserves current state and the seven-transition hot window. Sparse scopes may keep older checkpoints; their values are still reconstructed at the same requested effective boundary. Never replay a tail over an already-current snapshot or silently drop an unapplied patch. The implemented `serializeScopeStream`/`parseScopeStream` codec emits deterministic checkpoint/JSONL bytes and validates complete replay input, including semantic results, before acceptance. `publishTemporalStateToGit` writes selected streams from one validated view through exact-output Git publication, rejects omitted changes and stale/wrong-session bases, and leaves unchanged scopes alone. `loadScopeStream` reads the live pair; `loadTemporalRevision` reads regular-file Git objects without moving the worktree. Neither invents missing runtime lineage; callers must supply the lineage belonging to the same revision. Oversized tails, invalid lineage, incomplete pairs, and no-op records are rejected; legacy current-state documents require explicit migration rather than implicit decoding.

Accepted replay cohorts contain an identity and exact scope patches, without an independent timestamp clock or current-state publication DTO. Staging validates both semantic hashes and the active causal-boundary identity. Compact transition context derives directly from the selected lineage; `transitionWindow` retains its per-scope projection budget but never changes the shared temporal target of `state[n]`. Legacy explanatory journals and Pi `recentTransitions` payloads are not semantic recovery inputs.

Live files, or their branch-selected cached representation, serve hot materialization. When available, Git serves complete cold history for committed transitions, durable provenance, explicit historical inspection, and branch restoration; it is not queried to rebuild current state on every inference. There is no second unbounded event store, database, `.state-flow`, `scopes`, or parallel history directory.

### Runtime ownership and Git publication

Session `config.json` owns runtime behavior such as `enabled` and `transitionWindow`. Session `meta.json` owns temporal head/lineage, counters, durable base, Pi branch correlation, pending publication, and migration/version metadata. They are not model-patchable state and do not overlay into effective state. Pi checkpoints bind the selected branch to the corresponding durable runtime/temporal revision. The implemented runtime codec records version, canonical CWD/session identity, bounded active lineage, counters and run metadata, `revision: "self"`, and an unconfirmed publication intent. The self reference resolves to the last commit owning either member of the config/meta pair, so config-only changes advance runtime revision without semantic history, while unrelated commits in the state repository do not change its meaning. The commit hash is supplied during resolution rather than embedded in its own content; the resulting publication target identifies the existing commit to reconcile or retry. Unconfirmed means no durable confirmation is available, not proof that the push failed.

Git-backed Pi checkpoint data is exactly `{"revision":"<full commit hash>"}`; file-only checkpoints use `{"revision":"file:<64 lowercase hex>"}` for an exact current-cohort reference. `{"disabled":true}` denotes an ordinary disabled branch without durable runtime. Configuration, counters, specification, lineage, and semantic state are not copied into these entries. Older config/meta and state-bearing checkpoints remain read-only compatibility input. Invalid immutable pointer targets fall back through the selected branch; transient publication-lock failure instead retains the selected revision for retry. Explicit start on a pre-runtime branch establishes an empty session origin, even if a later branch already created same-session files. Shared streams remain unchanged and the later session state remains recoverable from its Git revision; it is not imported into the new origin. Legacy checkpoint syntax and immutable targets undergo the same fallback checks, while an unanchored legacy semantic payload cannot be silently reduced to an ordinary-disabled marker. Stop on an unproven branch fails visibly instead of turning failed recovery into permission to replace existing runtime; select a valid checkpoint before retrying.

Every materially effective semantic transition, including response-only and session-only changes, immediately publishes affected checkpoint/tail pairs and necessary lineage metadata. In Git mode each accepted cohort gets its own consistent local commit and, when a remote is configured, a push attempt; intermediate patches are not batched until turn end. With no remote configured, Git persistence is intentionally local-only, not a pending publication error. With Git absent, persistence remains file-only and does not report fake commits or pending pushes. Multi-scope changes use one identity and one commit. Config-only changes may persist runtime state but never invent semantic transitions.

Writes use regular non-symlink owned files, same-directory atomic rename, isolated Git indexes, and compare-and-swap against the reconciled base. Cooperating State Flow Git publishers hold a common-Git-directory publication lock through capture, commit, and rollback. Raw bytes own file identity and recovery; non-UTF-8 explanatory journals are not reconstructed from decoded strings. Per-file publication checks catch changed bases. Both semantic and migration publishers retain exact prepared-output receipts: Git commits those bytes, not later worktree contents, and rollback requires the receipt to preserve detected external changes rather than replacing them. Low-level file helpers require caller exclusion; this is not kernel-atomic multi-file CAS against writers ignoring the protocol. An existing publication lock fails before writes and is not silently stolen; reconcile its active or interrupted owner before retrying. Scope keys derive from canonical CWD/Pi session identities with collision-safe hashes and separately verified provenance. Conflicts fail rather than silently selecting another scope or auto-merging semantic state. Unrelated staged and dirty state-repository files remain untouched. With distinct roots, the Knowledge repository's files, index, HEAD, locks, and remote are not used for state publication; keep custom stores separate from sources to retain this isolation.

A local commit accepts the transition. Push failure is pending publication, not a reason to regenerate the answer or repeat semantic state changes. Pending state survives restart; retries push the existing accepted commit. A restored branch reads its recorded revision without moving the shared worktree and must reconcile safely before publication.

### File-only recovery

File-only mode keeps the same scoped materialization, hot temporal window, and separate config/meta. Its Pi checkpoint identifies the store root and exact current file cohort, including runtime metadata, not a Git commit. Restart can restore that pointer while the complete referenced cohort remains available. Old branches or replaced cohorts can be unavailable; current files must not be passed off as the selected past. Unavailable references and publication locks retain the selected pointer rather than falling through to an older disabled marker. A crash between file publication and Pi checkpoint append can leave the previous pointer unavailable: the files remain, but automatic branch restoration cannot assert they belong to that pointer. There is no second unbounded history store, and Git-linked cold recovery still requires Git and its original objects.

If Git becomes available later, explicit start can adopt the selected current file cohort into Git. Adoption preserves semantic state, step, lineage, hot history and exact scope bytes; it changes runtime provenance, not semantic history. It commits the full current cohort rather than inheriting stale or missing HEAD blobs, preserves unrelated staging, and leaves file state recoverable if Git publication fails. A new session can also initialize Git over inherited file-only global/CWD scopes while retaining its own empty session layer. Git cold history begins at adoption and does not fabricate commits for earlier file-only transitions. An already-anchored identical Git cohort can reuse its owner revision.

### Existing stores and migration

Changing the default directory does not import, move, or delete an old Knowledge-backed store. Existing Pi checkpoints name Git revisions: copying only the current checkpoint/tail files cannot preserve their recovery contract. An old session requires its original revision history in the selected repository; unavailable revisions must not be treated as permission to reset the session. Keep the old store intact until an explicit history-preserving relocation is performed, or use a genuinely new Pi session for an independent debug store. An SDK host can explicitly select the old `repositoryRoot` when accessing that history.

The following is an **in-store format migration**, not a cross-repository relocation. Let State Flow perform it; manually renaming files is not a valid conversion.

An existing current `state.json` becomes the initial checkpoint state, anchored at a proven current transition/base, with an empty tail. Its explanatory old journal is not replayed. Migration must preserve exact semantic state and remove obsolete `state.json` ownership only after successful publication, leaving one authoritative format. It must not fabricate seven historical patches. Git retains older evidence; the new hot window grows from the proven migration origin. The explicit internal migration primitive now plans without writes, publishes all converted scope files in one isolated-index commit, and restores exact old bytes after failure when its published files have not concurrently changed; conflicting external bytes remain preserved with an explicit recovery error. It rejects ambiguous dual snapshots and orphaned tails, does not depend on explanatory legacy journal validity, and retains legacy interpretation only for explicit migration. Production no longer exposes the predecessor current-state/journal writers; legacy fixture writers are test-only. Pi initialization now invokes this migration when establishing the temporal runtime, and revision-linked predecessor snapshots have a one-way restoration path. Historical legacy restoration reads only the authoritative current snapshots, not explanatory journals. Cached view and publication basis are installed together after successful initialization/restoration; a transient restore failure preserves the selected revision for explicit start retry and cannot masquerade as a successful state transition. Independent rereview confirmed these three failure-path fixes. Stop also remains harmless in ordinary disabled sessions and retries a failed branch restoration before durably disabling that branch.

## Intermediate barriers and terminal reconciliation

Use `patch_state` only for established future-relevant state whose delayed persistence risks meaningful loss, never scratchpad, narration, routine progress, or speculative churn:

```json
{"scope":"session","patch":{"working":{"verified":"result"}}}
```

```text
LLM(state[0] = Sn)
  → patch_state
  → validate, publish, materialize Sn+1
  → next LLM(state[0] = Sn+1, state[1] = Sn)
  → choose the next action
```

The barrier executes alone. State Flow opts into sequential preflight, inspects Pi's synchronized assistant response, requires exactly one `patch_state` call, and blocks every sibling tool before execution. The next inference sees one rebuilt current-state projection; it must not reconstruct the update itself. Tool calls/results remain current-run causality, not duplicate full-state messages.

Every successful enabled run ends with exactly one terminal reconciliation after zero or more barriers. The model audits and compacts future-relevant state; the runtime captures the finalized answer. If complete semantic state changed, terminal reconciliation enters the same temporal stream. A changed `response` counts as semantic change. If state including response is identical, runtime finalization still completes without a fake patch, identity, or temporal step.

An ordinary non-empty answer without a State Flow marker preserves the three model-owned fields and replaces session `response`. When a model patch is needed, use one top-level transcript-private comment, exactly one separating blank line, and the answer once:

```html
<!-- state_flow {"transitions":[{"scope":"session","patch":{"working":{"verified":true}}}]} -->

Complete user-facing answer
```

Each transition has exactly one unique known scope and an object patch limited to `artifacts`, `contract`, and `working`. Pre-scoped three-field envelopes remain session compatibility shorthand, not a second storage format. Empty object patches preserve values; nested object-key `null` deletes, arrays/primitives replace, and semantic materializations cannot contain `null`, including in arrays. The null prohibition does not cover runtime envelope fields such as an origin's parent.

At `message_end`, validate and strip the comment and stage the cohort against one basis. At `turn_end`, capture the finalized answer after chained handlers, concatenating text blocks without inserted characters, then publish. Missing text or an added tool call enters the same bounded hidden regeneration chain. Explicit malformed, embedded, or duplicate markers never silently become ordinary no-op answers. A complete marker inside a fenced or inline example still counts as a duplicate; when explaining the protocol during enabled operation, use plain JSON without HTML comment delimiters.

Validation retries remain hidden from finalized answers, retain cumulative attempt counts across tool-bearing turns, and stop after three retries. Exhaustion or abort preserves enabled mode and the last accepted state, abandons only transient validation, and lets the next user request rotate normally. Transcript-private is not streaming-confidential: generated envelopes may be visible to streaming/RPC observers. Never put secrets in state.

## Artifact compilation and acquisition

Artifacts use exact source paths as keys. Minimum metadata is:

```json
{"description":"What this source contains and when it is useful","hash":"sha256:<64 lowercase hex characters>","compiler":"artifact-v1"}
```

Descriptions and compiler revisions are non-empty; hashes are canonical lowercase SHA-256. Optional `kind`, `compiled_at`, and `compilation` are validated when present, while unknown JSON metadata remains forward-compatible. Ordinary artifacts need no `kind`. Hash plus compiler revision determines freshness, not `compiled_at`.

Session initialization generically discovers regular lowercase `*.md` beneath the independent canonical Knowledge source root, normally `~/.pi/agent/knowledge` (or `knowledge/` beneath the agent directory selected by `PI_CODING_AGENT_DIR`). This source directory need not be a Git repository. Discovery hashes opaque bytes and retains byte counts without decoding or storing bodies; it skips symlinks and never escapes the root. A missing root means no candidates. Root and nested Markdown are treated alike, without reserved names, frontmatter parsing, validators, templates, or a `save_knowledge` implementation/call. Arbitrary repository files remain independent from State Flow.

New, changed, compiler-stale, malformed, missing-metadata, or explicitly refreshed artifacts enter the runtime-owned `artifact_invalidations` plan. Successful exact-path reads of stale ordinary sources require compact global compiler output at that path; State Flow rejects model-authored hash/compiler fields and attaches the observed source hash plus `artifact-v1`. Removed sources create deterministic global removal transitions without reads or model compilation. Runtime replay records must reproduce accepted compiled state exactly, not store incomplete compiler outputs.

Default compilation is a compact routing description, not raw Markdown or a full-file summary. Preserve uncertainty. Richer `compilation` is for reusable operational semantics. An artifact index is not proof that its body was read or understood.

### Materialized-first policy

Read a source only for a concrete relevant gap not covered by sufficient compilation, an exact-source operation including edits, evidenced invalidation, contradiction/failure reconciliation, explicit request, or bounded maintenance selection. New sessions, routine recall/activation, reassurance, and a description/index alone are not reasons to reread. Changed hashes require reacquisition; prefer the smallest sufficient read. Semantic sufficiency is caller-assessed, not proven by the existence of a compilation field.

Optional `planArtifactMaintenance` selects only otherwise-fresh old artifacts, ranking missing/unparseable timestamps first, then oldest `compiled_at` and path. Defaults admit at most one source and 16 KiB after 30 days. Strict count/byte ceilings can be zero; source bytes conservatively bound tokenizer input. The planner never reads, compiles, or modifies sources. Correctness invalidation takes precedence; explicit full refresh is separate from maintenance budgets and never an automatic startup rebuild.

### Skill compilation

Every successful `SKILL.md` read requires CWD compiler output at the exact executed path at the next barrier or terminal transition, with non-empty `description`, `kind: "skill"`, and a non-empty flexible `compilation` object. Compile applicability, routing, constraints, and failure conditions rather than source text. Runtime attaches the executed byte hash and `skill-artifact-v1`; missing/unhashable/forged freshness or missing compilation fails validation. Refresh replaces the complete old artifact, including obsolete metadata.

Correlation follows finalized mutable `tool_call` arguments with execution-start compatibility fallback. Legacy `contract.compiled_skills` entries migrate into artifacts, preserving behavior and marking unavailable-source fallback hashes unverified. New patches cannot recreate the retired store.

## Handoff quality and external reality

A terminal handoff is decision-relevant memory, not narration. Preserve active constraints, unresolved questions, consequential negative results, and the next discriminating check before compression. Keep user requirements, observations, assistant decisions, and hypotheses distinct. Retain useful source locators, validity conditions, rejection reasons, and reconsideration conditions. Reconcile contradictions with evidence or user clarification; preserve unresolved conflicts as uncertain.

At every handoff audit complete state: merge fragmented facts, compress history into conclusions, reorganize inefficient structure, and delete stale, completed, redundant, or low-value keys without losing active commitments and evidence. Do not invent bookkeeping merely to cause a transition. Structural validators cannot prove semantic usefulness or compilation fidelity; fresh-agent continuation tests provide behavioral evidence.

`working` contains last observations, not live reality. Revalidate volatile facts before consequential actions. After interruption or branch restoration, inspect relevant external effects before repeating operations. A failed commit does not undo tools; restored memory does not restore the workspace. Missing evidence proves neither success nor absence of effects. Preserve uncertainty and the next check rather than adding action ledgers or claiming rollback/exactly-once guarantees.

## Context lifecycle and boundaries

The current run retains its user prompt, assistant/tool trajectory, and persistent/current-run context-bearing custom messages from other extensions. State Flow's separately represented retry feedback is excluded. Completed-run trajectories leave model context only at user-run boundaries; Pi's full trace remains inspectable. Bootstrap retains prior active context for its one complete migration run.

The normative runtime protocol stays turn-stable during tool/retry chains. The current specification rotates on each non-retry user run and stays user-authority text, never interpolated into the system prompt. Synthetic user context repeats it with fallible assistant-produced state; the transport role does not elevate that state into instructions. Image-only specifications may be empty.

State, the active specification, current trajectory, and external full trace have no strict size bound. There are no project schemas, growth-pressure gates, action authorization/observation envelopes, state-byte caps, or total-model-context guarantees. This mode is a poor fit when every new request must reason over complete historical trajectories. Token/cache/latency/success advantages still require controlled benchmarks.

## Architecture and validation

See the [documentation index](docs/README.md) and [twenty temporal acceptance properties](docs/temporal-acceptance.md) for the requirement-to-test map and verification limits.

`index.ts` remains composition/public exports only. Flat independent `lib/` domains own their responsibilities: `temporal` owns anchored streams, folding, active-lineage validation, and lazy historical algebra; `durable` owns exact files; `git` owns revision/CAS publication; `history` owns compact transition records; `state` owns semantic shape/overlay; `transition` coordinates accepted patches; `snapshot`, `session`, `recovery`, and `episode` own runtime/branch lifecycle; `context`, `status`, `terminal`, and `validation` own projection and finalization; artifact domains own discovery/acquisition/compilation/maintenance; `extension` composes Pi integration. `runtime` caches branch-selected streams and their publication basis beneath the Pi adapter; `config` owns read-only agent-level settings independently from branch runtime configuration. Predecessor current-state/journal writers are test-only; production retains explicit migration readers, and Pi checkpoints carry revision pointers.

Each domain has a same-named test, with cross-domain DAG/composition invariants in `tests/invariants.test.ts`. Real Pi SDK scenarios use `tests/pi-harness.ts`; ordinary fixtures use `tests/harness.ts`.

```bash
npm install
npm run validate
```

Validation runs TypeScript checks, automated tests, and an import smoke check. Temporal algebra tests compare all available offsets with independently retained test snapshots through dense/sparse repeated folding, shared transitions, deletion overlays, no-ops, and forks. Temporary-repository tests also cover explicit migration, ten committed sparse transitions with folding and all hot offsets, cold Git scope recovery, and historical symlink rejection. Storage-level tests also prove atomic runtime/semantic publication, config-only stop without semantic history, runtime identity and lineage validation, self-reference resolution across unrelated commits, and exact accepted-commit retry. Real Pi tests also exercise configured automatic activation, temporal barriers and next-inference state, lazy runtime offset-one reads, unchanged shared-stream inheritance, and old-branch stop/resume. The complete twenty-case temporal acceptance audit is documented in the property map; the canonical backlog identifies any subsequent open work.

- [Canonical open work](BACKLOG.md)
- [Delivery history](CHANGELOG.md)
- [Agent/contributor protocol](AGENTS.md)
