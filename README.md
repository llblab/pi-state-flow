# Pi State Flow

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

**Incremental scoped context/memory compiler for Pi.**

State Flow maintains explicit state across requests and sessions. The agent incrementally compiles requirements, decisions, findings and source knowledge into durable memory rather than carrying every completed exchange into the next request.

Drawing on the explicit-state approach of [SKILL.state](https://arxiv.org/html/2608.26263v2), State Flow combines durable state with Pi's native conversation context. In this hybrid, **state carries continuity between user runs; Pi's native context carries the working trajectory within a run.** The conversation is not reset after each model response or tool call. Pi retains ownership of execution, session navigation and the full inspectable trace.

## How it works

A user run starts with effective memory and a new request. The agent works through Pi's ordinary inference/tool loop, updates memory when useful information changes, and returns an ordinary answer. The next run receives the accepted state and compact recent transitions instead of the completed ordinary conversation history.

```text
Current state + Request
          ↓
Pi's native tool loop
          ↓
Patched state + Answer
          ↓
Updated state
```

Within a run, the available request, intermediate responses, tool results and steering remain in context. A state patch updates memory without discarding that working trajectory. Persistent context-bearing messages from other extensions are preserved as well.

This reduces reliance on repeated model-generated summaries of an accumulating transcript. Retaining the current trajectory also allows prompt-cache reuse while the relevant prefix remains unchanged. Avoiding summary calls and repeated prompt processing can improve responsiveness; the result depends on the model, provider, workload and frequency of state changes, not a fixed latency guarantee.

Native compaction remains available for long runs. State Flow may also request a completed-history boundary without another model summary, retaining the complete latest accepted run. Neither mechanism deletes Pi's append-only session trace. See [lifecycle behavior](docs/usage.md#session-behavior) and [performance evidence](docs/performance.md).

## Installation and activation

Requires **Pi 0.87.0+** and **Node.js 22.19.0+**. See [SDK compatibility](docs/compatibility.md) for tested stacks and verification limits.

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
/state-flow-start
```

Starting in an existing conversation retains its context for one complete bootstrap run so the agent can compile what matters.

- `/state-flow-start`: Enable active state updates and memory-based context projection.
- `/state-flow-status`: Inspect effective state, retained history and known recovery issues without scanning sources or changing state.
- `/state-flow-stop`: End active episode semantics without deleting memory; an interrupted run retains its frozen handoff and available trajectory.

Active mode is **opt-in**. Passive memory projection and the memory tools are enabled by default: existing state can be read or explicitly patched without an active episode or State Flow compaction. Every materially changed owner advances its independent scope revision even in passive mode, without displaying an active-mode status. When active, terminal and Telegram status render the Effective revision vector as `G15/C8/S31`; passive Telegram shows `State Flow: off`. Requested Global, CWD and Session snapshots show their own `#revision`, while Effective shows the vector. Inspection can refresh live shared revisions from other instances without publishing state or advancing a counter. Stop returns to the configured passive behavior. `autoStart` can enable active mode for genuinely new sessions; resumed branches restore their own enablement. See [configuration](docs/usage.md#configuration).

## State model

### Scopes and effective memory

Memory has three ownership scopes:

- `global`: Knowledge and preferences shared across projects.
- `cwd`: Knowledge shared by sessions in the same working directory.
- `session`: State belonging to the current session and its selected branch.

They compose recursively in **global → CWD → session** order. More-specific values override lower-scope values, while object fields merge. Removing a local value can reveal an inherited value again.

The agent receives the **effective view** of this composition, not three unrelated memory dumps. It can read that view or inspect an individual scope when ownership matters. `effective` is a computed view, not a fourth storage scope. Scope precedence does not elevate memory into system-level instructions.

### Semantic planes

Every scope uses the same shape:

- `intents`: Active commitments to future action.
- `contract`: Requirements, decisions, constraints and interface commitments.
- `working`: Observations, results, uncertainties and current continuation.
- `artifacts`: Source-addressed descriptions and compiled knowledge.
- `response`: The exact latest accepted answer, including an empty string, captured by the runtime only in Session. Global and CWD retain an empty structural slot; Effective inherits the Session value.
- `lazy`: Supporting memory available through explicit reads, with its body omitted from baseline model context.

These planes organize ordinary JSON rather than imposing a project-specific schema. The model updates the semantic planes except `response`, which is runtime-owned. Global and CWD revisions are shared by their canonical stores, Session has its own revision, and Effective has no scalar owner: its identity is the `G#/C#/S#` vector. One atomic patch advances each materially changed scope once. Memory remains fallible: storing an observation does not make it current or correct.

Registered Pi Skills may be compiled into source-addressed artifacts when durable guidance is useful. Pi's resource provenance determines ownership: user Skills map to global, project Skills to CWD and temporary Skills to session. A matching source hash needs no update; an uncompiled read remains ordinary volatile context and does not block unrelated patches.

## Incremental updates and history

`patch_state` updates one or more named scopes atomically. Unmentioned values remain unchanged; object patches merge recursively, and `null` deletes an object key rather than becoming stored data.

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

During an active episode, a material patch is an inference barrier: sibling tool calls are blocked, and the next inference sees the accepted effective state. Ordinary completion needs no finalization patch or additional State Flow reasoning loop.

`read_state` provides targeted current and historical access:

```json
{ "paths": ["effective.contract", "cwd.working", "session.intents"] }
```

- `working`: Current effective working memory; unscoped paths are effective aliases.
- `effective[1].working`: Working memory at the preceding accepted transition boundary, when retained.
- `cwd.patches[0]`: The latest retained CWD semantic patch.
- `effective.lazy.memory[0..3]`: A bounded slice of a stored collection.

Historical materializations and scope patch histories use the configurable **`historyLimit`**, from **0 to 100**, with a default of **7**. Materialized offsets refer to accepted semantic transitions, not user messages or an independent counter for each scope. Requested history must still exist in the active lineage; increasing the limit cannot recreate discarded history. Older patches fold into the checkpoint without removing current values.

Array ranges, structural `keys` reads and path-intersected `patch` projections support progressive access without loading whole memory collections. See [progressive memory](docs/lazy-state.md) and [tool contracts](docs/architecture.md#model-tools).

## Persistence, backups and continuity

The default store is `~/.pi/agent/state-flow/`, independent of registered source files. Canonical `checkpoint.json`, `patches.jsonl` and `meta.json` files hold each scope's state, retained changes and metadata; session configuration and runtime identity are stored separately.

**Git backups are optional.** When the store is a configured Git repository, accepted active turns may create versioned backups of State Flow-owned files. If the attached branch has an explicitly configured remote, State Flow then pushes the exact current backup commit there asynchronously and without force. Within one Pi process, only one push per repository can run at a time; overlapping attempts are skipped and a later accepted turn pushes the latest backup. Session shutdown waits for that repository's active push to close or time out. Commit failures warn locally; repeated push failures produce one concise warning until a successful push, with redacted Git detail kept in the local diagnostic log. Neither failure rejects or rolls back accepted memory. Backup needs a Git commit identity, but accepting and persisting state does not. Git history can be inspected separately, but it is not the authority for `read_state` or automatic restoration of expired semantic boundaries.

Resume and tree navigation restore the selected retained session boundary over current shared global/CWD memory. A new session gets its own session layer. Supported native forks copy selected session state into a new owner without changing the parent's private data. Expired, incomplete or contradictory boundaries fail closed rather than silently substituting newer state. See [fork support](docs/usage.md#fork-support-and-limits) and [storage recovery](docs/usage.md#storage-and-recovery).

The canonical storage-format boundary introduced in 0.17 still applies: current versions accept only the canonical store contract and provide no in-place predecessor converter. Preserve existing data and check the [format boundary](docs/usage.md#moving-a-store-and-the-017-format-boundary) before changing versions or moving a store.

## Operational boundaries

State Flow adds memory, not another agent controller. It does not introduce background reasoning, a scheduler, automatic reference hydration or rollback of external tool effects. State and the current trajectory are not size-capped; performance depends on how much useful information the agent retains.

The packaged `state-flow-guide` Skill covers concrete operations and recovery. `state-flow-memory` supports explicitly requested curation, for example: **“Review and clean State Flow state”** Normal handoffs reconcile touched memory; dedicated cleanup is not an automatic audit after each task.

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
