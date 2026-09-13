# Pi State Flow

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

**Working memory for Pi, carried with the session.**

Keep decisions, constraints, verified findings, and next steps without sending every completed tool exchange back to the model. State Flow lets the agent maintain explicit state; Pi still owns the conversation, the native tool loop, and the complete inspectable trace.

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

Requires Pi `0.84.4–0.84.x` or `0.85.1–0.85.x` and Node.js `22.19.0` or newer. See the [SDK compatibility matrix](docs/compatibility.md) for exact tested stacks. Git is optional; using it requires a configured commit identity.

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

State Flow is **opt-in**. Starting in an existing conversation keeps its active context for one migration run. To enable genuinely new sessions automatically, set `"autoStart": true` in the optional [configuration](docs/usage.md#configuration).

With `pi-telegram` installed, its main menu also exposes the same Start/Stop controls.

## What carries forward

The same four fields exist at every scope:

- `contract`: Requirements, decisions, constraints, and interface commitments.
- `working`: Observations, results, unresolved questions, and what to do next.
- `artifacts`: Source-addressed descriptions and reusable compiled knowledge.
- `response`: The latest complete answer, captured by the runtime.

Memory overlays **global → project CWD → session**. Put reusable cross-project knowledge in global, project knowledge in CWD, and private task continuation in session.

**Resuming an existing Pi session restores its selected State Flow state and enablement.** A genuinely new session starts with an empty session layer and inherits only shared global/CWD memory; it does not resume another session's private work. Tree navigation follows the selected branch, not whichever state happens to be at Git `HEAD`.

The agent can inspect `state[0]` through `state[7]`: now and up to seven prior accepted transitions. Every scope is read at the same causal boundary. Git-backed stores retain older committed history separately.

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
