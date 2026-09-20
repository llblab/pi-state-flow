# Pi State Flow

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

**Incremental scoped context/memory compiler for Pi.**

Keep decisions, constraints, verified findings, and next steps without sending every completed tool exchange back to the model. State Flow compiles curated context and memory into explicit state; Pi still owns the conversation, the native tool loop, and the complete inspectable trace.

> Inspired by [SKILL.state](https://arxiv.org/html/2608.26263v2).

## The idea

```text
Current state + New request
              ↓
   Pi's native tool loop
              ↓
Updated state + Answer
              ↓
          Next request
```

During a request, the model retains the current tool trajectory. Between requests, State Flow replaces completed ordinary conversation history in model context with the current state and recent transitions. It does not delete Pi's session history.

The agent curates what matters; the extension validates, persists, and projects the accepted state. This is working memory, not automatic proof that a remembered fact is true.

## Quick start

Requires Pi `0.84.4` or newer and Node.js `22.19.0` or newer. There is no declared upper Pi version bound; see the [SDK compatibility matrix](docs/compatibility.md) for exact tested stacks. Git is optional; using it requires a configured commit identity.

From npm:

```bash
pi install npm:@llblab/pi-state-flow
```

From git:

```bash
pi install git:github.com/llblab/pi-state-flow
```

In Pi:

```text
/state-flow-start
```

Continue working normally. The agent receives the state protocol and uses `patch_state` to maintain memory.

- `/state-flow-status`: Inspect the selected state, history, artifact freshness, and publication status.
- `/state-flow-stop`: Disable updates on this branch without deleting retained state.

Active State Flow episodes remain **opt-in**, while passive durable memory bootstrap and tools are available by default. Passive turns never require `final:true`, continue automatically, or trigger State Flow compaction. Starting an active episode in an existing conversation keeps its context for one migration run; set `"autoStart": true` to promote genuinely new sessions automatically. See [configuration](docs/usage.md#configuration).

## What carries forward

The same semantic planes exist at every scope:

- `contract`: Requirements, decisions, constraints, and interface commitments.
- `working`: Observations, results, unresolved questions, and possible next steps.
- `intents`: Courses of action the agent has actually committed to pursue.
- `artifacts`: Source-addressed descriptions and reusable compiled knowledge.
- `response`: The latest complete answer, captured by the runtime.
- `lazy`: Durable, versioned memory omitted from ordinary context until explicitly read.

Memory overlays **global → project CWD → session**. Put reusable cross-project knowledge in global, project knowledge in CWD, and private task continuation in session. Hot planes carry what must matter now; `lazy` retains what may matter later without hydrating its body into every prompt. An intent stays hot only while its course remains chosen and disappears when fulfilled, abandoned, superseded, or impossible. It may refer to supporting detail through a structured `{"$ref":"cwd.lazy.plan"}` value or a `$`-prefixed state path inside ordinary prose, such as `$effective.lazy.memory[7]`. Both remain semantic content interpreted by the agent: State Flow never parses, validates, hydrates, executes, or completes them automatically. The agent never scans references for breakage. Only when current work already follows one and a single value path is missing does State Flow perform a bounded exact reverse lookup. Matching durable sources produce a top-level `{value:null, hint:[...]}` sentinel whose typed hint names runtime-verified current owning paths and asks the agent to reconcile them. Keys, patch, batch, and unmatched reads retain ordinary all-or-error behavior; no match does not prove that the agent invented the path. The agent may then repair or remove a proven stale locator in its owning value.

**Resuming an existing Pi session restores its selected State Flow state and enablement.** A genuinely new session starts with an empty session layer and inherits only shared global/CWD memory; it does not resume another session's private work. Tree navigation follows the selected branch, not whichever state happens to be at Git `HEAD`.

The agent uses `read_state` for exact current or historical paths. Unscoped paths read the effective overlay; `global`, `cwd`, and `session` address ownership directly; `[n]` selects one of up to seven prior accepted transition boundaries. Bounded array ranges and `value`, `keys`, or `patch` projections support progressive reads without hydrating whole lazy collections. Git-backed stores retain older committed history separately.

Two packaged Skills keep guidance proportional: `state-flow-guide` resolves concrete operational questions about reading, patching, inheritance, acquisition, finalization, and recovery; `state-flow-memory` performs one bounded explicit or phase-boundary curation. Neither runs background maintenance.

## Boundaries worth knowing

- `Not a second agent loop`: State Flow adds memory to Pi; it does not run background reasoning or replace session controls.
- `Not a transcript archive in the prompt`: Prefer ordinary Pi when each request needs all historical exchanges verbatim.
- `Not live workspace truth`: Remembered observations can become stale; revalidate consequential facts before acting.
- `Physical forks copy private memory`: Native fork replacement copies the selected session checkpoint/tail into a new owner while retaining current shared memory. The child starts its own history; older parent checkpoints are not child history. See [fork support and limits](docs/usage.md#fork-support-and-limits).
- `Not a token or latency guarantee`: State and the current trajectory are not size-capped. Benefits depend on workload and memory quality; see [performance evidence](docs/performance.md).
- `Use a dedicated store`: By default state lives in `~/.pi/agent/state-flow/`, separately from Knowledge Markdown. Git commits include the store's complete non-ignored worktree delta. Do not point it at an unrelated working repository.
- `Treat memory as private`: State and diagnostic logs may contain session content. Keep secrets out, and review data before configuring a remote. Removing a value does not erase Git history or other copies.

Pi packages run with your user permissions. Without Git, current state and its proven hot history persist to files, but arbitrary older branches may be unavailable. See [storage and recovery](docs/usage.md#storage-and-recovery) before moving stores.

## Read more

- [Usage and recovery](docs/usage.md): Configuration, session behavior, diagnostics, privacy, and storage recovery.
- [Architecture](docs/architecture.md): Semantic state, temporal history, barriers, artifacts, and integration contracts.
- [Performance](docs/performance.md): Reproducible workloads, measured costs, and what the measurements do not prove.
- [Documentation index](docs/README.md): All maintained guides, including the temporal acceptance map.

For development, run `npm install` and `npm run validate`. `npm run benchmark` runs the opt-in synthetic workload in `benchmarks/`, separate from the normal test suite. In a source checkout, see `benchmarks/README.md` for lifecycle/publisher selection.

Project context: [AGENTS.md](AGENTS.md) · [BACKLOG.md](BACKLOG.md) · [CHANGELOG.md](CHANGELOG.md).
