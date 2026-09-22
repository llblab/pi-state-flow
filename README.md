# Pi State Flow

![pi-state-flow banner](https://raw.githubusercontent.com/llblab/pi-state-flow/main/banner.jpg)

**Incremental scoped context/memory compiler for Pi.**

Long-running work needs continuity: what the agent chose to do, which constraints still apply, what it verified, and what remains unresolved. State Flow gives that knowledge an explicit, inspectable home instead of relying only on repeated conversation history.

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

- **Intent first.** Active commitments stay visible alongside constraints, findings and unresolved work.
- **Less completed history in model context.** Active mode replaces completed ordinary exchanges with current memory and compact recent transitions. It preserves the available current-run trajectory and other extensions' persistent custom context.
- **An ordinary finish.** The agent patches memory when something useful changes, then answers normally. No finalization patch or extra State Flow reasoning loop.
- **Files first.** Accepted state persists without Git. Optional Git backup cannot veto or roll back a state update.

Memory is curated knowledge, not proof: an accurately stored observation can still become stale.

## Get started

Requires **Pi 0.87.0+** and **Node.js 22.19.0+**. The open-ended Pi peer range is not a claim that every future SDK version has been tested; see [compatibility](docs/compatibility.md).

```bash
pi install npm:@llblab/pi-state-flow
```

Or install from source with `pi install git:github.com/llblab/pi-state-flow`.

In Pi:

```text
/state-flow-start
```

Then work normally. Starting in an existing conversation preserves its context for one complete bootstrap run so the agent can compile what matters.

- `/state-flow-start` — Enable active memory projection on the current branch.
- `/state-flow-status` — Inspect effective memory, retained history and known recovery issues without scanning artifact sources or changing state.
- `/state-flow-stop` — End active episode semantics without deleting memory. An interrupted run keeps its frozen handoff and available tool trajectory.

**Active mode is opt-in. Passive memory is available by default:** existing memory can be projected and explicitly read or patched without an active episode or State Flow compaction. Stop returns to that configured passive behavior; it does not erase memory or necessarily remove memory tools. Set `autoStart` to promote genuinely new sessions automatically. See [configuration and lifecycle](docs/usage.md#configuration).

## Memory with explicit ownership

Every scope uses the same six planes, in this order:

- **`intents`** — Courses of action actually chosen, not every possible task. Remove them when fulfilled, abandoned or superseded.
- **`contract`** — Durable requirements, decisions, constraints and interface commitments.
- **`working`** — Current observations, verified results, uncertainties and next checks.
- **`artifacts`** — Descriptions and compiled knowledge keyed by exact source path. Refreshes belong to the source's registered scope; Skills belong to CWD.
- **`response`** — The latest complete answer, captured by the runtime rather than authored in a model patch.
- **`lazy`** — Supporting memory available through explicit reads, with its body omitted from ordinary baseline projection.

Ownership overlays **global → CWD → session**:

- **Global:** Reusable cross-project knowledge and preferences.
- **CWD:** Reusable knowledge for this project.
- **Session:** This branch's commitments and continuation.

A scope-local deletion can reveal a lower-scope value again. Scope changes ownership and precedence, not instruction authority. Remembered text never becomes a system instruction.

### Small patches, precise reads

`patch_state` accepts one or more scope patches atomically. For example:

```json
{
  "session": {
    "intents": {
      "verifyRelease": { "action": "Check the release build before publishing" }
    },
    "contract": { "runtime": "Node.js >=22.19.0" },
    "working": { "build": "Not checked yet" }
  }
}
```

The keys immediately inside a scope are `intents`, `contract`, `working`, `artifacts` and `lazy`. Project-specific grouping belongs **inside** those planes, not in keys such as `project.contract`. Unknown-key errors name the actual rejected key and list the permitted fields.

During an active episode, a material patch is an inference barrier: sibling tool calls are blocked, and the next inference receives the accepted memory. Ordinary answers need no bookkeeping patch; `response` is runtime-owned.

`read_state` retrieves only the requested value:

```json
{ "path": "session.intents" }
```

Unscoped paths address effective memory. Explicit scopes, retained boundaries such as `effective[1].working`, array ranges and `keys`/`patch` projections support targeted inspection. The default history window is **7 accepted transitions**, configurable from **0 to 100**; discarded history is unavailable, not reconstructed from Git. See [progressive memory](docs/lazy-state.md) and [tool contracts](docs/architecture.md#model-tools).

## Persistence without a Git dependency

State normally lives under `~/.pi/agent/state-flow/`, independently of registered artifact sources. Each scope's canonical `checkpoint.json`, `patches.jsonl` and `meta.json` own its current state and retained history. Session configuration and runtime metadata remain separate.

**Git is backup, not storage authority.** When the store is already a Git repository, an accepted active turn may produce a best-effort backup. Git backup needs a configured commit identity; canonical state does not. If backup fails, State Flow preserves accepted state and warns the user. It does not fall back between competing storage backends or wait for a remote push.

Resume and tree navigation select the retained session boundary while global/CWD memory stays shared and current. New sessions get their own session layer; supported native forks copy selected session memory into a new owner. Expired or contradictory boundaries fail closed instead of silently substituting newer private state. See [fork limits](docs/usage.md#fork-support-and-limits).

**Upgrading from older storage formats:** 0.17 accepts only its canonical file contract and has no in-place predecessor converter. Preserve your store and read the [format/recovery boundary](docs/usage.md#moving-a-store-and-the-017-format-boundary) before changing versions or locations. A new path does not move existing memory automatically.

## Keep memory useful

Two packaged Skills provide on-demand guidance:

- **`state-flow-guide`** — Concrete questions about reads, patches, scope inheritance, source acquisition and recovery.
- **`state-flow-memory`** — Bounded curation when explicitly requested. Ask: **“Review and clean State Flow state.”**

Normal handoffs reconcile touched memory; dedicated cleanup is not an automatic audit after every task. Preserve consequential uncertainty, verify ownership before removing data, and verify external destination acceptance before deleting a transferred source. Semantic references are navigation hints, not automatic hydration, execution or dependency tracking.

## Where the boundary stays

- **Not a second agent.** No background reasoning, scheduler or replacement for Pi's session controls.
- **Not live workspace truth.** Revalidate consequential observations before acting. Restored memory does not undo external tool effects.
- **Not a token or latency guarantee.** State and the active trajectory are not size-capped; benefits depend on workload and curation. [Performance evidence](docs/performance.md) separates measured copying work from end-to-end cost.
- **Not a transcript replacement.** Pi retains its full inspectable trace. Use ordinary Pi context when the model needs every historical exchange verbatim.
- **Not secret storage.** Memory, diagnostic logs and backups may contain sensitive content. Deletion from current state does not erase older histories or remote copies. Use a dedicated store and review what you retain.

## Documentation and development

- [Usage and recovery](docs/usage.md) — Configuration, lifecycle, diagnostics and safe storage operations.
- [Architecture](docs/architecture.md) — Semantic model, temporal boundaries, artifacts and public integration contracts.
- [SDK compatibility](docs/compatibility.md) — Tested stacks and verification limits.
- [Acceptance map](docs/temporal-acceptance.md) — Properties tied to concrete tests.
- [Documentation index](docs/README.md) — All maintained guides.

For development, run `npm install` and `npm run validate`. The opt-in `npm run benchmark` workload is separate from the normal suite; see `benchmarks/README.md` in a source checkout.

Project context: [AGENTS.md](AGENTS.md), [BACKLOG.md](BACKLOG.md), [CHANGELOG.md](CHANGELOG.md).
