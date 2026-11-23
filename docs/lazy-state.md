# Lazy state through progressive `state_flow_read`

Use `lazy` for durable detail that does not need to be in every request. Keep active obligations, constraints and consequences needed for the next correct action in hot memory. [Model tools](architecture.md#model-tools) owns request grammar, result envelopes, availability and historical addressing; this guide shows how to use them for lazy state.

## What stays out of context

`lazy` is an optional object plane in each participating scope, versioned with the rest of that scope. Its children are ordinary semantic JSON: strings, numbers, booleans, arrays and objects, with no record wrappers, IDs, timestamps or provenance fields. For example, an entry can be `["important thought", "next thought"]`, `42`, or:

```json
{
  "decisions": ["keep one publication barrier"],
  "openQuestions": ["large-value storage layout"]
}
```

An absent plane stays absent on disk. `effective.lazy` follows the ordinary Global → CWD → Session overlay; a scope-local deletion can reveal an inherited value. Use an explicit participating owner path when ownership matters. The effective view is not writable, and hiding inherited data without changing its owner is not a separate lazy feature.

Automatic state and recent-transition projections omit lazy bodies, including lazy writes, replacements and deletions. Empty visible patches or transitions disappear without renumbering history. Already communicated native, user, tool or response text is not redacted.

### Baseline lazy hint

`lazy_navigation` exposes `available` and a read path: `lazy` for one wanted owner, `effective.lazy` for several. It includes a complete immediate `keys` → child-kind map only when there is content, at most 32 visible keys and at most 1,024 characters in the map's canonical JSON. Otherwise `keys` is omitted, not truncated. Legacy empty object branches do not count as content. A separate `keys` read can still inspect the full immediate structure.

### Activation and promotion

An explicit read makes detail available in the current tool-result trajectory, not in future baseline memory. The [State Flow Skill](../skills/state-flow/SKILL.md#use-hot-memory-to-route-lazy-reads) guides task-driven lookup and placement. It confers no authority and changes no semantic freshness, counters or history. When a consequence needs to stay visible, write just that consequence through an ordinary hot patch: a durable decision in `strategy`, current evidence or continuation in `tactics`, or a source-addressed compilation in `artifacts`. Historical support with no current consequence stays lazy.

## Progressive reads

Start with `keys` if the shape is unknown, then read the specific value, item or range. Use `patch` for what changed at a retained boundary. There is no query language, pagination or silent truncation: every successful result contains the full selected value or structure. Host, model-context and transport limits are separate from the semantic read contract.

### `keys`

```json
{
  "path": "effective.lazy",
  "projection": "keys"
}
```

```json
{
  "meta": {
    "type": "object",
    "size": 3
  },
  "keys": {
    "memory": "array",
    "rules": "object",
    "soul": "array"
  }
}
```

Object `size` counts immediate named keys. Scoped paths use the same shape: `effective.lazy.rules` or a participating owner's `lazy.rules` might return `{"meta":{"type":"object","size":2},"keys":{"ranges":"string","publication":"object"}}`. The map contains child kinds, not their values.

Arrays and scalars have no named children. `meta.length` describes arrays and strings; numbers and booleans carry just `type`. Arrays are not expanded into index lists:

```json
{"meta":{"type":"array","length":10000},"keys":[]}
```

```json
{"meta":{"type":"string","length":18420},"keys":[]}
```

```json
{"meta":{"type":"number"},"keys":[]}
```

This closed navigation metadata is unrelated to persisted `meta.json`: it contains no revisions, temporal bounds, provenance, timestamps, cache details or diagnostics. A batch uses parallel `meta` and `keys` arrays in request order (`keys` last):

```json
{
  "meta": [
    {"type": "array", "length": 10000},
    {"type": "object", "size": 2}
  ],
  "keys": [
    [],
    {"ranges": "string", "publication": "object"}
  ]
}
```

### `value`

With CWD participating, request a range of three items:

```json
{"path":"cwd.lazy.memory[0..3]"}
```

```json
{"value":["first thought","second thought","third thought"]}
```

This is one path returning an array under `value`. The `values` field instead corresponds to multiple paths, regardless of the argument spelling. For example, with CWD and Session participating:

```json
{
  "paths": [
    "effective.lazy.rules",
    "cwd.lazy.memory[0..2]",
    "session.tactics.nextAction"
  ],
  "projection": "value"
}
```

With at least two items:

```json
{
  "values": [
    {"ranges": "Ranges are half-open."},
    ["first thought", "second thought"],
    "Implement progressive reads."
  ]
}
```

If the range is out of bounds, the middle slot is an error instead:

```json
{
  "values": [
    {"ranges": "Ranges are half-open."},
    [null, {"code": "invalid_selector"}],
    "Implement progressive reads."
  ]
}
```

Here the middle path failed because `memory` has fewer than two elements. The other results survive; the failing range is never returned as a shorter slice. By contrast, a `keys` or `patch` batch with a path error fails as a whole. See [model tools](architecture.md#model-tools) for confirmed absence, error codes and call-wide errors.

### Array paths and ranges

Array indices are zero-based; `cwd.lazy.memory[4]` selects one item. A half-open range `[start:end]` (also `[start..end]`) selects `start <= i < end` from one array. With ten items, `[0:10]` and `[10:10]` are valid; `[0:15]` and `[11:11]` are not. Negative indices, open-ended ranges, steps, predicates, wildcards and unions are not supported.

`cwd.lazy.memory[10:20]` selects a range; `session[3].lazy.investigation` instead selects a retained temporal boundary before entering `lazy`. Lazy paths use the same object-member grammar as other semantic paths.

### `patch`

```json
{"path":"cwd[3].lazy.memory","projection":"patch"}
```

At that boundary, the result can report an indexed change, a whole-array replacement, no change, or deletion of the object key, respectively:

```json
{"patch":{"[1]":"corrected thought"}}
```

```json
{"patch":["new first thought","new second thought"]}
```

```json
{"patch":{}}
```

```json
{"patch":null}
```

`null` here is patch deletion syntax, not retained data. Unavailable history is an error, not an empty patch; only retained canonical history is addressable, never cold Git history.

## Semantic references

A structured reference is an ordinary JSON object such as `{"$ref":"cwd.lazy.plan"}`. A textual reference is `$` immediately followed by a valid semantic path in prose, such as `$effective.lazy.memory[7]`. File paths, document sections, URIs, artifact locators, Skill identities and agent identities keep their native syntax.

With exactly one wanted owner, eligible current structured refs are anchored before staging: `{"$ref":"lazy.plan"}` becomes `{"$ref":"cwd.lazy.plan"}` for sole CWD. Model presentation projects eligible current same-owner refs back relatively. Historical, `effective`, cross-owner and resource refs, and ordinary text, keep their identities. This translation does not resolve a target, validate its existence, or infer authority, hydration, execution or completion.

Resolve a reference only when it matters to the task, using `state_flow_read` for semantic state or the relevant external tool. For a missing single value read with an exact current reference, the [reactive hint](architecture.md#model-tools) can look like this:

```json
{"value":null,"hint":[{"type":"dangling-reference","message":"The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task.","paths":["cwd.tactics.note"]}]}
```

Here `cwd.tactics.note` holds the reference, not the missing value. Check it only if useful; do not infer that the target moved or search all history to fill the gap.

## Intent ownership

A structured reference anywhere inside an `intents` entry can own an existing object key under `strategy`, `tactics` or `lazy` in its own scope. Thus `{"$ref":"cwd.lazy.plan"}` in `cwd.intents.release` means “delete with me”; a textual `$cwd.lazy.plan` or a structured reference outside `intents` only says “I use this.” Sole-CWD `{"$ref":"lazy.plan"}` is already canonicalized when ownership runs.

On deletion of an intent key, one atomic patch applies these phases regardless of JSON field order:

1. Apply `intents` only.
2. Clear eligible targets of deleted intents unless a final remaining or new same-scope intent references the target, an ancestor or a descendant.
3. Apply the other authored planes, then compile, normalize and publish.

Delete the old intent and reference the same targets from its replacement to preserve them. To retain a distilled consequence instead, rewrite it in the deleting patch at the same or a new path; a cleared target starts fresh without old fields. Editing an intent to drop its reference does not count as deleting the intent; the target remains ordinary unowned state.

The cascade searches only the owning scope's `intents` for references. It silently skips missing targets, other scopes, plane roots, array elements, other planes, historical or `effective` paths, and canonical refs that lack a scope or use invalid member keys (e.g. a key containing spaces, dots or non-Latin letters). It neither validates references nor warns or rejects a patch because of them.

[`state_updates.cascaded`](architecture.md#state_updates-receipts) reports intermediate clears even when a later write recreates a key or an inherited value becomes visible. Example paths are `session.lazy.plans.x` and `session.tactics.draft` with multiple owners, or `lazy.plans.x` and `tactics.draft` with one. Final `effective` entries describe actual accepted values, not removal commands. Later ordinary writes can recreate an intent another shared writer already deleted, including a partial intent. Replay applies accepted net patches without rerunning the cascade; existing refs affect future deletions, not old history. There is no extra archive or age-based cleanup.

## `state_flow_patch` and arrays

To edit existing elements, supply an object whose keys are all canonical `"[N]"` selectors against an array. This example uses the multi-owner form with CWD participating:

```json
{
  "cwd": {
    "lazy": {
      "memory": {
        "[1]": "corrected second thought",
        "[4]": "corrected fifth thought"
      }
    }
  }
}
```

All indices must exist against one captured publication basis; a bad index or indexed `null` rejects the entire patch. At the index, scalar and array values replace; objects use the normal recursive patch rules. Against an object, `"[1]"` is a literal key, distinct from `"1"`. Nested changes use the same addressing:

```json
{
  "cwd": {
    "lazy": {
      "groups": {
        "[0]": {
          "notes": {
            "[1]": "corrected note"
          }
        }
      }
    }
  }
}
```

To add, remove, reorder or shift elements, read the array and replace it with the desired JSON array. There is no separate edit-command language, ID addressing or predicate mutation.

## Storage and verification

Lazy data shares the canonical checkpoints, tails and publication boundary with hot state. Reload, resume and tree navigation attach current memory; fork copying follows the [private-acquisition contract](fork-contract.md). There is no separate lazy store, index or authority. Malformed lazy data is not dropped to manufacture a hot view: dependent reads fail closed and any repair follows the [filesystem recovery contract](filesystem-recovery.md).

See the [acceptance map](temporal-acceptance.md) for projection, ownership and publication witnesses, and the [performance guide](performance.md) for synthetic workloads and their limits.
