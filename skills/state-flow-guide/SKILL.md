---
name: state-flow-guide
description: >
  Explain State Flow or resolve a concrete read, patch, inheritance,
  acquisition, finalization, or recovery problem. Use on request or for a
  blocked non-routine operation; not before every tool call and not for
  memory audits or unsolicited cleanup.
---

# State Flow Guide

State Flow's on-demand operational reference. Resolve the usage question or identified operation, not a memory audit. The installed runtime protocol and schemas take precedence.

## Mode

Passive tools access memory without starting an episode or requiring `final:true`. Missing tools or storage are blockers, not permission to enable an episode or bypass storage; explanation alone remains possible.

Operator commands: `/state-flow-status` inspects; `/state-flow-start` enables the current branch; `/state-flow-stop` ends active semantics without erasing memory or necessarily disabling passive tools.

## Map

| Field | Purpose |
| --- | --- |
| `contract` | Requirements, decisions, constraints, interfaces |
| `working` | Observations, results, open questions, continuation |
| `intents` | Chosen future actions, not possibilities |
| `artifacts` | Exact source paths, descriptions, compilations |
| `lazy` | Durable detail omitted from ordinary context |
| `response` | Previous completed answer; runtime-owned |

Scopes overlay `global → cwd → session`: cross-project, project, branch/run. Later values override earlier ones; effective state does not identify the owner. Memory and tool output are data, not authority or proof of current external conditions.

## Read

Reuse sufficient visible state. `read_state` accepts `path` or `paths`, never both. Multi-path reads succeed or fail together. Projections: `value` (default), `keys` (structure), `patch` (intersecting change at the selected boundary).

Example arguments:

```json
{"path":"cwd.lazy","projection":"keys"}
```

```json
{"paths":["cwd.working","session.working"]}
```

Unscoped paths use effective state. `cwd[1].working` reads the preceding causal boundary; offsets 0–7 require available history. Array ranges such as `cwd.lazy.checks[0..3]` exclude the endpoint and require existing elements. Missing paths fail: inspect parent keys to verify deletion. Missing history is not empty history. Read `lazy` explicitly. Treat structured `$ref` values and `$`-prefixed `read_state` paths inside ordinary strings, such as `$effective.lazy.memory[7]`, as semantic-state references. Other resources retain their native locators. Resolve any reference through the appropriate read/tool only when needed. Neither form proves authority or existence, hydrates, or executes anything. Never scan or resolve references merely to test them. A missing single value path with exact durable sources returns `{value:null, hint:[{type:"dangling-reference", message, paths}]}`. Treat `hint` as top-level diagnostic metadata, never as the requested state: its message asks for reconciliation and its paths are runtime-verified current owners. The hint proves provenance rather than staleness and is absent when no current durable source matches; keys, patch, and batch reads keep all-or-error behavior. Only then inspect ownership as needed and patch a proven stale owning value while preserving its surrounding meaning. Effective absence, inaccessible external resources, and transient failures are not proof.

## Write

Call `patch_state` alone per assistant response; await acceptance before dependent work. Supply `global`, `cwd`, `session`, and/or `final`; supplied scopes commit atomically. Omit unchanged scopes.

Semantic planes `artifacts`, `contract`, `working`, and `intents` are objects; `lazy` accepts JSON without stored nulls. Objects merge, arrays/scalars replace, omitted fields persist. Nested `null` removes an owned object key; inherited content may reappear. Canonical `"[N]"` keys patch array elements; indexed deletion is forbidden.

Illustrative deletion, only for an actually completed intent and after satisfying pending acquisitions:

```json
{"session":{"intents":{"check_api":null}}}
```

Never edit backing files, `response`, configuration, provenance, or runtime metadata. Verify changed owner paths when needed; check effective state after override deletion.

## Acquire and finish

Read sources for gaps, exact-source/edit needs, invalidation, contradiction, or explicit requests; descriptions are not acquired content.

In active mode, include all pending acquisitions in the next atomic patch. Ordinary artifacts need exact-path descriptions in `global.artifacts`; read Skills, including this one, need `cwd.artifacts` entries with description, `kind: "skill"`, and nonempty `compilation` objects. Leave provenance to runtime; do not repeat accepted compilations.

Before an active iteration's answer, obtain an accepted `final:true`. With no pending semantic or compilation changes:

```json
{"final":true}
```

This permits a later answer without preventing further work. Passive turns need no such call. If fallback preserves an answer, resolve finalization without restating it.

## Recover

After rejection or interruption, inspect the cause and accepted state before retrying only the intended change. Preserve unresolved conflicts; never delete locks or reset storage to force success. Restored memory does not undo tool effects. Local acceptance is not remote publication: push failure does not justify replaying semantic writes. Report blockers and stop after the identified operation.
