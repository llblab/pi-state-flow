# Lazy state through progressive `read_state`

**Status**: Implemented architecture for the next minor release. Final release validation and publication remain open.

## Thesis

State Flow should add `lazy` as a fifth semantic plane in every scope. Lazy values are ordinary JSON: durable and versioned with the same causal lineage as hot state, but excluded from ordinary baseline hydration.

The model-facing surface remains small:

- `read_state` reads one path or an ordered list of paths using one explicit projection.
- `value` and `patch` return only the requested semantic snapshot or patch; `keys` returns narrowly bounded structural `meta` followed by `keys`.
- `patch_state` remains a recursive semantic patch, not an edit-command language.
- Array index selectors extend ordinary patch addressing; there are no `insert`, `remove`, `move`, or generalized query operations.

> Retention is not activation. Hot state carries what must matter now; lazy state preserves what may matter later; an explicit read activates only the current trajectory.

## Goals

- Preserve large or infrequently needed semantic state without linearly growing baseline context.
- Keep values domain-native: strings remain strings, arrays of strings remain arrays of strings, and objects exist only when the domain needs objects.
- Navigate current, scoped, effective, and retained historical state through one read protocol.
- Make every successful read exact: return everything requested or fail, never silently truncate.
- Keep runtime revision, CAS, and publication mechanics out of model-facing results.
- Preserve one lock/CAS publication cohort and one causal lineage across hot and lazy mutations.

## Non-goals

- Mandatory entry objects, stable IDs, timestamps, or provenance fields inside lazy values.
- A generalized typed query language, free-text search, tags, ranking, or a separate memory subsystem.
- Product-level element limits, pagination, cursors, or partial successful range reads.
- A separate array-edit algebra or mutation tool.
- Automatic promotion of retrieved values into future baseline context.

## Semantic model

Each scope may contain five semantic planes:

```text
global | CWD | session
├── artifacts
├── contract
├── working
├── response (session-owned where applicable)
└── lazy
```

`artifacts`, `contract`, `working`, and `response` remain hot. `lazy` differs only in projection policy:

- It is canonical semantic JSON, validated and versioned with its owning scope.
- It is excluded from the ordinary baseline effective-state body.
- It becomes model-visible only through bounded baseline navigation hints or explicit `read_state` output.
- Reading it does not mutate state, freshness, usage metadata, history, or future context.

Valid lazy values include:

```json
["important thought", "next thought"]
```

```json
{
  "decisions": ["keep one publication barrier"],
  "openQuestions": ["large-value storage layout"]
}
```

```json
42
```

State Flow does not inject IDs, provenance, revisions, range descriptors, or truncation fields into those values.

### Effective lazy overlay

The explicit `effective.lazy` path recursively overlays `global.lazy → cwd.lazy → session.lazy` using the existing scope precedence and conflict semantics. It is read-only as an effective view and is not inserted into ordinary hot baseline state.

Explicit paths such as `global.lazy`, `cwd.lazy`, and `session.lazy` preserve direct ownership access. Deleting a key from an upper scope reveals a lower-scope value exactly as ordinary scope-local deletion does. Hiding an inherited value without changing its owner is not a separate lazy feature.

Active obligations, current constraints, unresolved next actions, and facts required for the next correct action remain hot.

## Progressive `read_state`

### Request shape

`read_state` accepts either one path or an ordered path list:

```json
{
  "path": "cwd.lazy.memory[0..10]",
  "projection": "value"
}
```

```json
{
  "paths": [
    "effective.lazy.rules",
    "cwd.lazy.memory[0..10]",
    "session.working.nextAction"
  ],
  "projection": "value"
}
```

`projection` defaults to `value`. A batch uses one projection for every path, evaluates every path against one captured state view, and returns results in request order. Duplicate paths remain duplicate results. If any path is invalid, the whole read fails; there is no mixed partial result.

The legacy single `path` form remains first-class rather than mere compatibility syntax. Existing `offset`/`scope` input may remain temporarily during migration but cannot combine with `path` or `paths`.

### Response shape

There are three projections:

| Projection | Response shape | Meaning |
| --- | --- | --- |
| `value` | `{ "value": ... }` | Exact selected semantic snapshot |
| `keys` | `{ "meta": ..., "keys": ... }` | Minimal structural facts followed by immediate keys |
| `patch` | `{ "patch": ... }` | Historical semantic patch at the selected boundary |

A single-path request returns one payload. A multi-path request returns positionally aligned arrays under the same projection fields.

`value` deliberately mirrors the effective-state snapshot injected at iteration start: it is semantic state without revision, provenance, range, transport, or storage fields. `patch` likewise contains only the selected semantic patch. Only structural discovery earns `meta`, and `keys` remains the final and most valuable field in that response.

The response does not repeat the requested path or projection and does not return an internal revision. Runtime owns revision selection, locking, CAS, and publication; the model cannot improve correctness by echoing that machinery.

Errors use the normal tool-error channel rather than successful JSON containing an `error` field.

### Path and range model

Every path has an explicit root and addresses:

- `effective` for the current composed overlay or an indexed historical effective root.
- `global`, `cwd`, and `session` for explicit current or historical scopes.
- `lazy` beneath `effective` or an explicit scope.
- Existing retained temporal selectors using accepted-transition semantics.
- Object members and array indices.
- Canonical half-open array ranges `[start:end]`, selecting indices `start <= i < end`; `[start..end]` is an accepted fallback spelling.

Examples:

```text
effective.lazy
effective.working.nextAction
cwd.lazy.memory
cwd.lazy.memory[4]
cwd.lazy.memory[10:20]
session[3].lazy.investigation
```

Indices are zero-based. Negative indices, open-ended ranges, steps, predicates, wildcards, unions, and cross-array expressions are rejected in the first version.

A range must fit entirely within the current array. If an array has length 10, `[0:10]` and `[10:10]` are valid, while `[0:15]` and `[11:11]` fail. The fallback `..` spelling has identical semantics. A successful result always contains exactly the requested range. State Flow never returns a shorter successful range with truncation metadata.

The implementation must reuse or compatibly extend existing member escaping rather than inventing a second object-path language.

## Projections

### `value`

`value` returns the exact selected scalar, object, array, item, or range:

```json
{
  "path": "cwd.lazy.memory[0..3]"
}
```

```json
{
  "value": [
    "first thought",
    "second thought",
    "third thought"
  ]
}
```

A whole-value request returns the whole value. State Flow imposes no semantic element-count limit, pagination, cursor, or silent truncation. Host, model-context, and transport ceilings remain external operational constraints and surface as ordinary failures rather than partial semantic success.

A multi-path value response is positional:

```json
{
  "value": [
    {"ranges": "Ranges are half-open."},
    ["first thought", "second thought"],
    "Implement progressive reads."
  ]
}
```

### `keys`

`keys` combines the minimum structural facts needed to navigate with the complete immediate named keys and child kinds:

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
    "size": 3,
    "sources": ["global", "cwd"]
  },
  "keys": {
    "memory": "array",
    "rules": "object",
    "soul": "array"
  }
}
```

For an explicitly scoped object, redundant ownership is omitted:

```json
{
  "meta": {
    "type": "object",
    "size": 2
  },
  "keys": {
    "ranges": "string",
    "publication": "object"
  }
}
```

Arrays and scalars have no named child keys. Their `keys` result stays structurally uniform while `meta` supplies the only useful navigation fact:

```json
{
  "meta": {
    "type": "array",
    "length": 10000
  },
  "keys": []
}
```

```json
{
  "meta": {
    "type": "string",
    "length": 18420
  },
  "keys": []
}
```

```json
{
  "meta": {
    "type": "number"
  },
  "keys": []
}
```

Progressive discovery comes from selecting a deeper path, not from key pagination or enumerating every array index. State Flow does not add `limit`, `cursor`, or `truncated` fields.

The read-level `meta` object is intentionally narrow and unrelated to persisted scope `meta.json` except for the generic word “metadata.” Its closed initial schema contains only:

- `type` always.
- `size` for objects, meaning immediate named-key count.
- `length` for arrays and strings.
- `sources` only when an effective view actually combines or resolves scope ownership.

It never exposes temporal boundaries, runtime identity, revisions, publication state, provenance registries, timestamps, encoded sizes, cache/index details, diagnostics, or arbitrary copied fields from `meta.json`. Adding a metadata field requires evidence that it changes the agent's next read decision; diagnostic convenience alone is insufficient.

A multi-path `keys` response keeps both arrays positional and places `keys` last:

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

### `patch`

`patch` explains change rather than materialized state:

```json
{
  "path": "cwd[3].lazy.memory",
  "projection": "patch"
}
```

An indexed change:

```json
{
  "patch": {
    "[1]": "corrected thought"
  }
}
```

A whole-array replacement:

```json
{
  "patch": [
    "new first thought",
    "new second thought"
  ]
}
```

No change to the selected path at that boundary:

```json
{
  "patch": {}
}
```

Deletion of the selected object key:

```json
{
  "patch": null
}
```

This is unambiguous because empty supplied semantic patches are invalid no-ops, while `null` is patch deletion syntax and cannot be retained semantic state. History before the active origin or outside the retained hot window fails explicitly.

## Baseline lazy hint

Baseline inference receives ordinary hot effective state plus a fixed-shape lazy availability hint. The hint contains navigation only, not lazy bodies, a catalog, pagination state, or per-value metadata.

It may identify:

- Whether effective lazy state exists.
- Its immediate top-level keys and kinds.
- The exact `read_state` path for deeper inspection.

The hint is emitted as `lazy_navigation` with `available` and the exact root `path`. For an object root it includes the complete immediate `keys` → child-kind map only when there are at most 32 keys and its canonical JSON is at most 1,024 characters. Otherwise it omits `keys` entirely rather than presenting a partial catalog. This keeps the hint bounded while `read_state` itself returns every explicitly requested value or key set; omission from the hint never makes lazy state unreachable.

## Activation and promotion

A lazy read enriches only the current tool-result trajectory. It does not:

- Enter ordinary effective baseline state.
- Persist in later baseline inference automatically.
- Become authoritative merely because it was retrieved.
- Update semantic freshness, usage counters, or history.

When a retrieved fact becomes necessary for future correctness, the agent promotes a distilled consequence through an ordinary hot `patch_state` mutation:

- Durable requirement or decision → `contract`.
- Current fact, uncertainty, or continuation → `working`.
- Source-addressed reusable compilation → `artifacts`.
- Historical support with no current consequence → remain under `lazy`.

## `patch_state` and arrays

`patch_state` remains the sole semantic mutation and publication barrier. There is no `edits` array and no operation vocabulary such as `replace`, `insert`, `remove`, or `move`.

Existing recursive semantics continue:

- An object recursively patches an object.
- A scalar replaces the selected scalar/value.
- An array replaces the selected array as a whole.
- `null` deletes an object key and remains invalid as retained semantic state.

Array index selectors extend recursive addressing:

```json
{
  "cwd": {
    "lazy": {
      "memory": {
        "[1]": "corrected second thought",
        "[4]": "corrected fifth thought"
      }
    }
  },
  "final": true
}
```

Normative index behavior:

- `"[N]"` addresses an existing zero-based element of the retained array.
- Every addressed index must exist against the one captured publication basis.
- If any index is invalid, the entire `patch_state` call fails and publishes nothing.
- An indexed scalar or array value is replaced.
- An indexed object receives the ordinary recursive object patch; the materialized element is the resulting replacement value at that index.
- Multiple indexed and object changes in one call share one validation and one lock/CAS publication cohort.
- Index syntax is reserved and distinct from an ordinary object key such as `"1"`.

Nested addressing remains ordinary patch structure:

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
  },
  "final": true
}
```

Local insertion, removal with shifting, movement, predicates, and ID addressing are intentionally absent. A caller that needs structural array changes reads the array, constructs the desired ordinary JSON value, and replaces the array. A richer mutation language is considered only if measured real workloads prove whole-array replacement inadequate.

## Publication and storage

Lazy mutations inherit existing guarantees:

- One accepted transition identity across all changed scopes and planes.
- One lock/CAS publication cohort.
- Atomic hot-plus-lazy multi-scope changes.
- Scope-local deletion and effective revelation semantics.
- Exact revision selection on restore and branch navigation.
- Read-only discovery with no commit, timestamp update, or transition.

The first implementation keeps lazy trees co-located in the existing scope semantic files. A local Git-backed probe with incompressible 1 KiB, 100 KiB, and 1 MiB lazy payloads observed 0.33–0.42 s publication, 0.24–0.30 s cold restoration, and approximately linear loose-store growth; the 1 MiB case occupied about 2.2 MiB including the worktree and loose Git history. This does not justify sharding before real workload evidence. A future path-sharded or content-addressed optimization must expose one logical State Flow revision, preserve symlink and ownership safety, and keep normalized semantic JSON authoritative while indexes and caches remain rebuildable projections.

## Failure semantics

- A nonexistent path, wrong target kind, malformed selector, or out-of-bounds index/range is a tool error.
- One invalid member of a path batch fails the entire read before returning partial success.
- One invalid indexed patch fails the entire mutation before publication.
- A malformed lazy subtree fails closed at the smallest affected path and reports that path.
- Missing or corrupt optional indexes cannot make canonical lazy JSON disappear.
- Read failures create no semantic transition and do not affect ordinary hot state.
- Mechanical index rebuilds create no semantic transition.

## Normative invariants

1. **Ordinary JSON**: Lazy values contain domain semantics, never mandatory State Flow record wrappers.
2. **Semantic snapshots**: `value` contains only the selected state snapshot and `patch` only the selected semantic patch; `keys` alone adds closed structural `meta` before `keys`.
3. **Exact success**: A successful read returns everything requested; it never truncates or paginates silently.
4. **Runtime-owned concurrency**: Revisions, locks, and CAS remain internal unless explicitly needed for diagnostics.
5. **Hot-state safety**: Anything required for the next correct action remains hot.
6. **Retention/activation independence**: Growing lazy state does not hydrate its body into baseline context.
7. **One read protocol**: Current values, effective lazy values, structure, metadata, and retained patches share one address model.
8. **No activation by side effect**: Reads cannot change future inference context.
9. **Explicit frontier crossing**: Only a visible hot-state patch promotes a lazy consequence.
10. **Patch remains patch**: Array indices extend recursive addressing without introducing an edit-command language.
11. **Index safety**: Array indices are interpreted only against one captured basis under lock/CAS.
12. **Failure isolation**: Lazy corruption or unavailable indexes do not damage valid hot state.

## Validation contract

Before release, implementation evidence must prove:

- Lazy bodies do not enter ordinary baseline effective state.
- Baseline lazy navigation remains bounded as lazy body size grows.
- Single and ordered multi-path reads preserve exact request order and one captured state view.
- A failing path produces no partial batch result.
- Every projection returns exactly its matching top-level key.
- `value` returns complete selected values and exact valid ranges without product pagination or truncation.
- Out-of-bounds indices and ranges fail, including batch and boundary cases.
- `keys` returns minimal closed-schema `meta` followed by complete immediate named-key structure without descendant values or array-index enumeration.
- Read-level `meta` cannot leak or copy persisted `meta.json`, runtime revision, temporal, publication, provenance, cache, or diagnostic fields.
- `patch` selects the same causal boundary as existing historical reads and distinguishes no-change from deletion.
- `effective.lazy` follows global → CWD → session overlay while explicit scope paths preserve ownership.
- Reads create no semantic transition, Git commit, publication, freshness update, or future activation.
- Whole-array replacement and indexed scalar, array, object, nested, multi-index, and stale-basis patches remain atomic.
- Restore, fork, file-only, and Git-backed paths select lazy state from the same owning State Flow revision.
- Corrupt lazy data or optional indexes do not damage ordinary hot State Flow.
- Legacy stores and legacy `read_state` inputs either migrate deterministically or fail actionably.

## Remaining evolution decisions

- Exact member escaping beyond the current strict grammar for names containing separators or brackets.
- A measured real-workload threshold that would justify replacing the initial co-located semantic layout.
- Cold Git-history access beyond retained hot history.

These decisions cannot introduce mandatory record objects, default metadata envelopes, pagination, typed queries, search, ranking, or a second mutation language without a new design decision.

## Next minor release sequence

1. Extend the existing path parser with canonical escaping, ordered batches, strict indices, and half-open ranges.
2. Implement semantic-snapshot `value`, structural `meta` + `keys`, and semantic `patch` reads over current hot state first.
3. Add indexed recursive array patching through the existing lock/CAS barrier.
4. Add `lazy` to scope validation, persistence, history, restore, and explicit scoped reads.
5. Add the read-only `effective.lazy` overlay and bounded baseline navigation hint.
6. Add migration, corruption, stale-basis, restore, fork, file-only, Git-backed, and concurrency coverage.
7. Measure repository growth, publication latency, restoration latency, and package/store size before selecting any sharded layout.
8. Update runtime protocol and user documentation, run full validation, and release through the repository's guarded minor-release flow.

The stopping rule is conceptual economy: ordinary JSON, one effective lazy overlay, pure state and patch snapshots, one narrow structural `meta` + `keys` projection, recursive patches with indexed array addressing, and one mutation/publication barrier.
