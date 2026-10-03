# Pi State Flow

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

**Incremental scoped context/memory compiler for Pi.**

When enabled, State Flow maintains explicit state across requests and sessions. Instead of carrying every completed exchange into the next request, the agent incrementally compiles requirements, decisions, findings and source knowledge into durable memory.

The idea comes from the explicit-state approach of [SKILL.state](https://arxiv.org/html/2608.26263v2), combined with Pi's native conversation context:

- **State carries continuity between user runs.**
- **Pi's native context carries the working trajectory within a run.**

The conversation is not reset after each model response or tool call. Pi keeps ownership of execution, session navigation and the full inspectable trace.

## How it works

In Active mode, each user run starts with the effective memory plus the new request. The agent works through Pi's ordinary inference/tool loop, updates memory when useful information changes, and returns an ordinary answer. The next run receives the accepted state and compact recent transitions instead of the completed conversation history.

```text
Current state + Request
          ↓
Pi's native tool loop
          ↓
Patched state + Answer
          ↓
Updated state
```

What the model sees during a run:

- The request, intermediate responses, tool results and steering stay in context.
- The initial memory head stays byte-stable. Accepted changes arrive in patch results, and changing runtime notices are appended at the tail without moving earlier messages.
- Projection IDs tell current updates apart from retained historical results.
- A state patch neither rewrites the head nor discards the working trajectory.
- Persistent context-bearing messages from other extensions are preserved.

Passive memory uses the same approach across ordinary user turns and rebases only at native or mode boundaries.

Why this helps:

- It reduces reliance on repeated model-generated summaries of a growing transcript.
- Keeping the current trajectory lets prompt caches be reused while the relevant prefix is unchanged.
- Avoiding summary calls and repeated prompt processing can improve responsiveness. The effect depends on the model, provider, workload and how often state changes; there is no fixed latency guarantee.

Native compaction remains available for long runs. State Flow may also request a completed-history boundary without another model summary, keeping the complete latest accepted run. Neither mechanism deletes Pi's append-only session trace. See [lifecycle behavior](docs/usage.md#session-behavior) and [performance evidence](docs/performance.md).

## Installation and activation

Requires **Pi 1.0.0+** and **Node.js 22.19.0+**. See [SDK compatibility](docs/compatibility.md) for tested stacks and verification limits.

From NPM:

```bash
pi install npm:@llblab/pi-state-flow
```

From Git:

```bash
pi install git:github.com/llblab/pi-state-flow
```

Enable active State Flow on the current branch:

```text
/state-flow-active
```

Starting in an existing conversation keeps its context for one complete bootstrap run, so the agent can compile what matters.

Commands:

- `/state-flow-active`: Select the active, state-driven iteration workflow.
- `/state-flow-passive`: Select ordinary conversation with both memory tools and existing-memory projection.
- `/state-flow-off`: Remove both memory tools and all State Flow model context, without deleting memory.
- `/state-flow-status`: Inspect effective state, retained history and known recovery issues without scanning sources or changing state.

New sessions default to **Off**. Choose Passive for ordinary conversation with memory tools, or Active for state-driven episodes. A mode change affects only the current session; the global default applies only to new sessions. See [mode semantics](docs/usage.md#active-passive-and-configured-off), [configuration](docs/usage.md#configuration) and [status and controls](docs/usage.md#status-and-controls).

### Active, passive, off

- `Active`: Memory tools are available, and the agent consolidates necessary final state changes before completing an iteration. Later iterations use accepted state and new input rather than completed prior reasoning.
- `Passive`: Both memory tools are available, and existing state is projected once a validated memory view is available. The agent patches on demand, and ordinary conversation context continues without State Flow's active iteration reset.
- `Off`: The model sees neither memory tool nor any State Flow context, including a frozen passive handoff.
  - Startup, reload and tree attachment do not read or restore memory.
  - Selecting Off cancels pending memory waits and records only native policy/bookmarks.
  - Choosing Passive or Active later acquires memory.
  - Stored memory and Pi's native trace stay intact.

Modes select agent behavior; they do not change disk persistence or fork copying. Final consolidation needs no empty ceremonial patch, and context projection does not delete native history. See [mode semantics and bootstrap terminology](docs/usage.md#active-passive-and-configured-off).

## State model

### Scopes and effective memory

Memory has three ownership scopes:

- `global`: Knowledge and preferences shared across projects.
- `cwd`: Knowledge shared by sessions in the same working directory.
- `session`: State belonging to the current session and its selected branch.

They compose recursively in **global → CWD → session** order:

- More-specific values override broader ones, while object fields merge.
- Removing a local value can reveal an inherited value again.

The agent receives the **effective view** of this composition, not three unrelated memory dumps. It can read that view, or inspect one scope when ownership matters. `effective` is a computed view, not a fourth storage scope. Scope precedence does not turn memory into system-level instructions.

### Semantic planes

Runtime views provide these documented planes:

- `intents`: The queue of chosen actions. Work from intents: a structured `{"$ref"}` inside an intent owns a same-scope `working`/`lazy` key, and deleting the intent deletes what it owns unless another intent still references it. Textual `$path` mentions only use; unowned entries remain legal.
- `contract`: Requirements, decisions, rejected approaches, constraints and interface commitments.
- `working`: Temporary context of those actions: observations, results and uncertainties.
- `artifacts`: Source-addressed descriptions and compiled knowledge.
- `response`: The exact latest accepted answer, including an empty string. The runtime captures it only in Session; Global/CWD receive no newly accepted answers, and stored scopes may omit it entirely. Effective uses the highest-priority nonempty value.
- `lazy`: Supporting memory available through explicit reads; its body is omitted from baseline model context.

Every plane is optional on disk:

- Stored checkpoints and patches may omit any documented plane, including `intents`, `lazy` or `response`.
- Current and historical views assemble only the known fields actually present in the selected scopes; absent fields are not filled in. Empty `response` counts as absent.
- Readers ignore unknown top-level fields, and writers emit only known fields. Nested data inside known planes is unrestricted.
- Reading or starting never rewrites data just to normalize it, and a missing field is not a storage-format error.

These planes organize ordinary JSON; there is no project-specific schema. The model updates every plane except `response`, which is runtime-owned.

Revisions:

- Global and CWD revisions are shared by their canonical stores; Session has its own revision.
- Effective has no single owner: its identity is the `g#c#s#` vector.
- One atomic patch advances each materially changed scope once.

Memory remains fallible: storing an observation does not make it current or correct.

Registered Pi Skills may be compiled into source-addressed artifacts when durable guidance is useful. Pi's resource provenance decides the owner: user Skills map to global, project Skills to CWD and temporary Skills to session. A matching source hash needs no update. An uncompiled read stays ordinary volatile context and does not block unrelated patches.

## Incremental updates and history

`patch_state` updates one or more named scopes atomically:

- It waits cancelably for the store lock, then applies authored Global/CWD patches to the current canonical values, so other writers' untouched fields survive.
- Overlapping assignments follow successful acceptance order. Correct repeats succeed without new semantic revisions.
- Session remains private.
- Object patches merge recursively, and `null` deletes an object key instead of being stored.

```json
{
  "cwd": {
    "contract": { "verification": { "command": "npm test" } }
  },
  "session": {
    "intents": { "verify": { "action": "Run the checks before publishing" } },
    "working": { "checks": "Pending" }
  }
}
```

During an active episode, a material patch is an inference barrier: sibling tool calls are blocked, and the next inference sees the accepted effective state. Ordinary completion needs no finalization patch or extra State Flow reasoning loop.

`read_state` provides targeted current and historical access:

```json
{ "paths": ["effective.contract", "cwd.working", "session.intents"] }
```

- `working`: Current effective working memory; unscoped paths are effective aliases.
- `effective[1].working`: Working memory at the preceding accepted transition boundary, when retained.
- `cwd.patches[0]`: The latest retained CWD semantic patch.
- `effective.lazy.memory[0..3]`: A bounded slice of a stored collection.

How much history is kept:

- Historical materializations and scope patch histories use the configurable **`historyLimit`**, from **0 to 100**, default **7**.
- Offsets count accepted semantic transitions, not user messages or a separate counter per scope.
- Requested history must still exist in the active lineage; raising the limit cannot recreate discarded history.
- Older patches fold into the checkpoint without removing current values.

Array ranges, structural `keys` reads and path-intersected `patch` projections let the agent explore memory without loading whole collections. See [progressive memory](docs/lazy-state.md) and [tool contracts](docs/architecture.md#model-tools).

## Persistence, backups and continuity

The default store is `~/.pi/agent/state-flow/`, independent of registered source files. Each scope keeps its state, retained changes and metadata in canonical `checkpoint.json`, `patches.jsonl` and `meta.json` files. Session configuration and runtime identity are stored separately.

**Persistence is optimistic across abrupt shutdown.**

- Short publication exclusion keeps independent shared fields from cooperating writers; on overlap, the last accepted write wins.
- Per-file atomic replacement does not guarantee power-loss survival or crash-atomic recovery.
- This is an [accepted limitation](docs/filesystem-recovery.md#power-loss-durability), not a release gate; no additional recovery journal or storage format is planned.

**Git backups are optional.** When the store is a configured Git repository:

- Accepted active turns may create versioned backups of State Flow-owned files.
- If the store is busy and Pi provides no cancellable settlement wait, the backup is explicitly deferred. A later accepted turn retries, without changing memory or blocking native Abort.
- If the attached branch has an explicitly configured remote, State Flow then pushes the exact current backup commit there, asynchronously and without force.
- Within one Pi process, at most one push per repository runs at a time. Overlapping attempts are skipped, and a later accepted turn pushes the latest backup.
- Off cancels pending captures and its admitted push, without rolling back accepted state or backup commits; canceled work emits no late memory warnings.
- Shutdown cancels owned pushes and waits for that repository's active push to close or time out.
- Commit failures warn locally. Repeated push failures produce one concise warning until a push succeeds, with redacted Git detail kept in the local diagnostic log. Neither failure rejects or rolls back accepted memory.
- Backup needs a Git commit identity; accepting and persisting state does not.
- Git history can be inspected separately, but it is not the authority for `read_state` or for automatic restoration of expired semantic boundaries.

**Resume, tree navigation and forks:**

- Memory-enabled resume and tree navigation restore the selected retained session boundary over the current shared global/CWD memory. Off defers this acquisition.
- A new session gets its own session layer.
- Supported native forks copy the selected session state into a new owner without changing the parent's private data.
- Expired, incomplete or contradictory boundaries never silently substitute newer private state during restoration.
- Explicit Start is a mode change, not historical restoration. It activates the validated **current** memory of that same session, including private state, even after expired active/passive, interrupted or pre-runtime selections. Available aligned history and revisions survive; unavailable history is not recreated.
- Malformed storage, unsafe fork copying and concurrent writes remain fenced.

See [fork support](docs/usage.md#fork-support-and-limits) and [storage recovery](docs/usage.md#storage-and-recovery).

**For SDK and launcher integrations:**

- [Advisory continuation APIs](docs/architecture.md#session-continuation) inspect provenance and build candidates asynchronously with host cancellation. They neither open native sessions nor install automatic resume.
- Run preparation and missing-artifact maintenance wait cancelably before inference; embeddings can also use the [transaction APIs](docs/architecture.md#asynchronous-storage-transaction).

How mode changes interact with storage:

- Selecting Passive switches local policy/context immediately and awaits runtime-only persistence. Passive keeps independently owned restoration/fork work. If its persistence fails, local policy stays and publication is fenced until an accepted activation.
- Off cancels owned memory waits and saves only native mode/continuation/fork bookkeeping, without validating or rewriting canonical storage. It also cancels restoration/fork work and defers later acquisition.
- Explicit Off inspection may read current stored values through a disposable validated reader. It does not activate memory, install cache or change the selected historical/fork boundary. Missing private authority stays unavailable.
- Active waits for a coherent capture and acceptance; another mode or selection can withdraw its wait.

State Flow accepts only the canonical store contract and provides no in-place format converter. Preserve existing data and check the [format boundary](docs/usage.md#moving-a-store-and-supported-formats) before changing versions or moving a store.

## Operational boundaries

State Flow adds memory, not another agent controller. It does not add background reasoning, a scheduler, automatic reference hydration or rollback of external tool effects. State and the current trajectory are not size-capped; performance depends on how much useful information the agent retains.

The packaged `state-flow-guide` Skill covers concrete operations and recovery. `state-flow-memory` supports explicitly requested curation, for example: **“Review and clean State Flow state”** Normal handoffs reconcile the memory they touch; dedicated cleanup is not an automatic audit after each task.

Treat state, diagnostic logs and backups as private data. Revalidate consequential observations before acting, and verify a transfer's destination before deleting its source. Removing a value from current state does not erase older histories or remote copies.

## Documentation and development

- [Usage and recovery](docs/usage.md) — Configuration, lifecycle, diagnostics and storage operations.
- [Architecture](docs/architecture.md) — Semantic model, temporal boundaries, artifacts and integration contracts.
- [SDK compatibility](docs/compatibility.md) — Tested stacks and verification limits.
- [Performance](docs/performance.md) — Measurements, workload definitions and limits.
- [Acceptance map](docs/temporal-acceptance.md) — Properties tied to concrete tests.
- [Documentation index](docs/README.md) — All maintained guides.

For development, run `npm install` and `npm run validate`. `npm run benchmark` is opt-in and separate from the normal suite; see `benchmarks/README.md` in a source checkout.

Project context: [AGENTS.md](AGENTS.md), [BACKLOG.md](BACKLOG.md), [CHANGELOG.md](CHANGELOG.md).
