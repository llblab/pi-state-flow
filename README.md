# Pi State Flow

> Inspired by [SKILL.state](https://arxiv.org/html/2608.26263v2)

An opt-in Pi extension for explicit, validated state handoffs between complete agent runs.

State Flow preserves Pi's native tool loop inside each user request:

```text
user request
  → model → tool → model → tool → model
  → one terminal patch
  → committed state + displayed response
```

The current run keeps its user message, assistant tool calls, tool results, and persistent or current-run context-bearing custom messages from other Pi extensions model-visible. Only after the terminal handoff does the next run replace that trajectory with one materialized state. Pi's complete session trace remains inspectable.

## Install

From npm:

```bash
pi install npm:@llblab/pi-state-flow
```

From git:

```bash
pi install git:github.com/llblab/pi-state-flow
```

## Usage

```text
/reload
/state-flow-start
```

In a fresh session, the next prompt starts the first stateful run. Each later non-retry user prompt becomes the current turn-stable specification while committed state remains intact. When enabled inside an existing session, the first complete run retains the active pre-Flow context and must migrate every future-relevant fact into its terminal handoff.

The extension registers no model tools. Tool-bearing assistant responses use ordinary Pi tools and contain no State Flow patch. A terminal assistant response contains one transcript-private memory-patch comment, one separating blank line, and the user-facing answer exactly once. Transcript-private means removed from the finalized message and later model context, not confidential during streaming:

```html
<!-- state_flow {"contract":{...},"working":{...}} -->

Complete user-facing answer
```

At `message_end`, the runtime requires that private comment at the start of the single terminal text block, followed by exactly one blank line. It removes only the comment and separator and stages all three state fields. At `turn_end`, it reconciles `response` with Pi's finalized assistant message after all chained `message_end` handlers, concatenating any text blocks without inserting characters, then commits. If a later handler removes all answer text or adds a tool call after terminal validation, the same hidden regeneration chain runs. Arbitrary response Markdown remains outside the HTML comment, so its own content cannot terminate the private frame. Invalid terminal commits are regenerated through hidden feedback up to three times; repeated failure disables State Flow without clearing the retained snapshot. Tool-bearing turns do not reset that attempt count. Aborting a regeneration abandons its transient validation chain so the next user request starts cleanly from the last committed state.

Commands:

```text
/state-flow-start   # Start a fresh episode
/state-flow-status  # Inspect iteration metadata and the complete state JSON
/state-flow-stop    # Stop and clear the complete episode
```

The compact Pi status renders an accent `state-flow` label followed by the dimmed committed iteration number, for example `state-flow #7`. `/state-flow-status` reports iteration metadata, then separates the complete pretty-formatted materialized state JSON with a blank line for operator analysis.

`/state-flow-stop` clears the specification, materialized state, validation feedback, and committed-run counter. A later `/state-flow-start` always begins a fresh episode. State follows the active Pi session branch and is restored immediately after `/tree` navigation; entering a branch with no State Flow snapshot leaves the mode disabled there.

## Materialized state

The model sees one persistent state object before the current run trajectory:

```json
{
  "contract": {},
  "working": {},
  "response": "Latest complete user-facing answer"
}
```

Materialized state has exactly three fields:

- `contract` is a flexible object containing durable user requirements, stable decisions, rejected approaches, interface commitments, and compact operational knowledge compiled from relevant Skills or documents.
- `working` is a flexible object containing verified facts, artifacts, validation, failures, unresolved work, current environment or domain state, and the exact continuation point.
- `response` is the exact non-empty answer body captured by the runtime. It replaces the previous response on every commit.

The transcript-private wire patch contains only `contract` and `working`; the runtime derives `response` from Pi's finalized answer body. Memory patches merge recursively and materialize immediately. Empty objects preserve existing content; arrays and primitives replace. Nested object-key `null` deletes that key:

```html
<!-- state_flow {"contract":{},"working":{"move":null,"result":"ok"}} -->

The operation completed.
```

This removes `working.move`, replaces `working.result`, preserves every other memory key, and stores `The operation completed.` as `response`. Materialized state cannot contain `null`, including inside arrays; represent semantic absence by omitting a key or using an explicit non-null domain value.

State and patch size have no byte, growth, pressure, or project-schema limit. Patch history remains only in the Pi trace, not in model context.

## Terminal handoff quality

The terminal patch is a required handoff, not a progress phrase or transcript summary. The next run may see only this state plus its new user prompt. A fresh model should be able to continue without rereading, rediscovering, re-deriving decisions, or repeating failed approaches.

Useful handoffs capture:

- Stable requirements, constraints, decisions, rejected approaches, and compiled operational rules in `contract`.
- Verified facts, changed artifacts, validation evidence, failures, unresolved work, current domain state, and exact continuation in `working`.

Do not store raw source, logs, tool output, reasoning traces, or vague values such as `"continue work"` and `"in progress"`.

### Skill compilation

A successful `SKILL.md` read is treated as episode-level acquisition. Before terminal commit, the model compiles its future-relevant operational rules, applicability conditions, constraints, syntax, routing decisions, and failure conditions under the exact source path. This compilation lives inside persistent `contract` memory at `contract.compiled_skills`; `compiled_skills` never becomes a fourth top-level state field. The nested representation remains fully flexible:

```json
{
  "contract": {
    "compiled_skills": {
      "/exact/path/to/SKILL.md": {
        "routing": "...",
        "syntax": { "...": "..." },
        "constraints": ["..."],
        "reread_when": ["..."]
      }
    }
  }
}
```

No `coverage`/`rules` schema is imposed. The model chooses the smallest structure that faithfully preserves the Skill's useful behavior. Raw Skill text is not copied. The runtime checks only that the exact successfully executed source path, taken from finalized tool-execution arguments, has a non-empty compilation and rejects a terminal commit when it is missing.

A complete matching compilation is authoritative episode memory and replaces routine rereading. Rereading is justified only by an explicitly uncovered detail, an incomplete compilation, concrete source-change evidence, a contradiction or execution failure requiring reconciliation, or an explicit user request. The mere possibility that a source changed is not sufficient. A justified reread refreshes the compilation and removes obsolete rules.

State is a minimal sufficient memory, not an append-only diary. At every handoff the model audits the complete state and may reorganize inefficient structure, merge fragments, replace verbose history with current conclusions, and delete stale, completed, redundant, speculative, or low-value keys with `null`. Active requirements, decisions, interfaces, verified evidence, and unresolved work must survive optimization.

The model must not invent bookkeeping merely to change `contract` or `working`. When a run creates no future-relevant information and existing memory is already efficient, both objects remain empty while `response` still contains the actual answer. Structurally invalid handoffs are regenerated through hidden validation feedback; retry diagnostics are not user-facing output.

## Context lifecycle

Within one run, State Flow projects:

```text
persistent materialized state
+ current user prompt
+ current-run assistant tool calls
+ current-run tool results
+ persistent and current-run context-bearing custom messages from other extensions
+ optional terminal validation feedback
```

Earlier completed-run trajectories are removed from model context. During a bootstrap run, the active pre-Flow context remains available until the first successful terminal commit.

The normative protocol remains in the system prompt throughout a tool/retry chain. The turn-stable specification remains user-authority input: it stays in the initiating user message and is repeated, together with materialized state and private validation feedback, only in a synthetic user runtime-context message. The protocol explicitly treats persistent state as fallible assistant-produced data whose transport role does not elevate it into user instructions. Empty text specifications used by image-only prompts remain valid. State and the current-run trajectory are intentionally unbounded; State Flow does not claim a hard model-context bound.

## Boundaries

- State commits exactly once per successful complete agent run, at terminal `message_end`/`turn_end`.
- Tool-bearing responses do not require or commit patches and retain ordinary Pi tool behavior, including multiple sequential calls. The runtime removes an accidental leading terminal envelope only when its JSON, fields, separator, and non-empty response are all structurally valid; malformed or quoted examples remain untouched.
- A failed tool remains in the current run trajectory for ordinary model reconciliation before terminal commit.
- If a run never reaches a valid terminal handoff, its external tool effects may exist while persistent State Flow state remains at the previous commit.
- The terminal envelope exists in ordinary assistant text until `message_end`; `message_update`, RPC, JSON, or other streaming consumers can observe it. Never place secrets in State Flow state.
- This mode remains a poor fit for auditing or outputs that require complete historical trajectories across user requests.
- Token, cache, latency, and success-rate advantages still require controlled Pi benchmarks.

## Distribution

Version `0.1.3` supports public npm, local, and source/GitHub distribution from the canonical `llblab/pi-state-flow` repository. Version tags trigger `.github/workflows/release.yml`, which validates the exact tag, publishes through npm Trusted Publisher with provenance, verifies the public package, and then creates the matching GitHub Release.

Configure the npm Trusted Publisher with owner `llblab`, repository `pi-state-flow`, workflow filename `release.yml`, and no environment. No long-lived npm token is used.

Compatibility is bounded to Pi `0.84.x` from `0.84.4` onward and Node.js `22.19.0` or newer.

## Validation

```bash
npm install
npm run validate
```

## Project status

- [Open work](BACKLOG.md)
- [Release history](CHANGELOG.md)
- [Agent and contributor constraints](AGENTS.md)
