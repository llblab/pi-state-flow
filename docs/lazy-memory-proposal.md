# Lazy memory proposal

**Status:** Exploratory design proposal. Not scheduled and not an implementation contract.

## Summary

State Flow currently has one hot semantic state: the effective `global → cwd → session` overlay is projected into every enabled inference. This is appropriate for active commitments, current observations, source-addressed artifacts, and the latest complete answer. It is inefficient for large bodies of potentially useful history that rarely affect the current task.

This proposal explores **lazy memory** as a cold, scope-local knowledge layer. Lazy knowledge should remain durable and discoverable without placing its bodies—or a linearly growing catalog of descriptions—into every model context.

The design is intentionally not closed. A bounded tag index, metadata search, exact read, and explicit promotion form the strongest current candidate, not an implementation commitment. The proposal should preserve room for a smaller or more coherent mechanism if experiments reveal one.

The current candidate interaction is:

1. Bootstrap hints at the shape of available knowledge under a strict budget.
2. The agent performs bounded discovery without loading bodies.
3. Discovery returns lightweight, scope-qualified candidates.
4. The agent reads one exact memory only when its body is likely to help.
5. Any consequence that becomes operationally current is deliberately promoted into ordinary hot State Flow.

In short:

> State Flow separates retained past from active present. Hot state carries what must matter now; lazy state preserves what may matter later; deliberate discovery and promotion bridge them without making the archive part of every thought.

## Design posture

Lazy memory should extend the existing State Flow idea rather than turn State Flow into a conventional memory platform. The goal is not feature parity with vector stores, knowledge graphs, autonomous consolidation systems, or agent-memory taxonomies. The goal is to discover the **smallest complete memory primitive** that preserves State Flow's defining qualities:

- Semantic rather than text-editor mutation.
- Explicit scope and ownership.
- Deterministic, inspectable behavior.
- Bounded model-visible context.
- One causal lineage and one safe publication boundary.
- No provider, embedding, database, or background-model dependency in the core.

A design is more elegant when one primitive explains several behaviors. For example, an exact scoped entry plus guarded semantic patching may be sufficient to explain archival storage, revision, promotion, movement, and deletion. Separate subsystems for each behavior should be added only when one primitive demonstrably cannot preserve the required guarantees.

The proposal therefore distinguishes three layers:

1. **Normative kernel:** the irreducible guarantees lazy memory must preserve.
2. **Candidate interaction:** the current tag/search/read design that makes the kernel usable.
3. **Replaceable policy:** ranking, bootstrap hints, taxonomy advice, and physical indexes that may change without redefining memory semantics.

This separation is important. Tags and freshness are plausible navigation aids; they are not yet proven to be the essence of lazy memory.

## Motivation

Without a cold layer, durable agent memory has an undesirable binary choice:

- Keep historical detail in hot state and pay its context cost on every turn.
- Delete it and lose knowledge that could later prevent repeated investigation or recover an earlier rationale.

A visible catalog does not fully solve this problem. Even if entry bodies are hidden, descriptions and titles still grow linearly, consume attention, create accidental associations, and eventually become another large bootstrap payload. Lazy memory therefore needs both hidden bodies and a hidden catalog, with only a bounded epistemic index projected automatically.

Likely lazy content includes completed incident investigations, superseded plans with durable rationale, large review reports, historical release context, experiment results, and detailed decision records whose current consequences already exist in hot state.

## Retention is not activation

The central architectural tension is not whether an agent should remember much or little. It is whether retained knowledge must become active context merely because it exists.

State Flow should separate two budgets:

- **Retention capacity:** how much durable semantic knowledge the system can preserve and later recover.
- **Activation budget:** how much of that knowledge may enter one operative model context.

These budgets should scale independently. Retention may grow with the lifetime of an agent or project; automatic activation must remain bounded by the needs of the current task. A memory feature is successful when it improves recoverability without proportionally increasing mandatory context.

```text
Durable semantic memory
          │
          ▼
Bounded selective activation
          │
          ▼
Small operative context
          │
          ▼
Fresh agent iteration
```

This makes hot state an explicit **activation frontier** rather than merely the newest storage tier. Content on the hot side is automatically compiled into the next iteration because it can affect current correctness. Content on the lazy side is durable but inert until an agent deliberately discovers and reads it. Reading is temporary activation; promotion is a semantic decision that a distilled consequence now belongs across the frontier.

The resulting product model is broader than a memory database:

> State Flow is a semantic context runtime that compiles a bounded operative context from durable state at each iteration boundary.

Lazy memory strengthens that runtime only if it preserves fresh-iteration freedom. Broad automatic retrieval, full-catalog injection, or promotion on read would reconstruct transcript accumulation under a different representation.

This yields a strong monotonicity criterion for design experiments:

- More retained knowledge may increase optional recoverability.
- More retained knowledge must not increase baseline inference context beyond a fixed bootstrap budget.
- More retrieval activity may increase the current trajectory's context.
- Only explicit reconciliation or promotion may increase future hot context.

## Progressive context enrichment

A fresh iteration should begin with a bounded **set and setting**, not a miniature catalog of everything the agent could know. This bootstrap is the agent's current situational frame: who is acting, where, on what, under which active constraints, and through which discovery mechanisms. It should be sufficient to act or to identify the next information need, but not broad enough to predetermine the whole trajectory.

The operative context can then become progressively more specific:

```text
Bounded bootstrap
       │
       ▼
Current set and setting
       │
       ▼
Environmental and task cues
       │
       ▼
Bounded discovery
       │
       ▼
Exact versioned retrieval
       │
       ▼
Optional knowledge or skill activation
       │
       ▼
Action and explicit promotion of durable consequences
```

The environment supplies **retrieval cues** without deciding the answer in advance. A repository can cue project knowledge, an error can cue prior diagnostic evidence, an interface can cue a relevant skill, and a task can justify reading one more specific memory revision. Knowledge is therefore not loaded wholesale; it is progressively manifested as interaction creates evidence of relevance.

The human-memory analogy is useful only as an interaction model, not as an implementation claim. People do not hold every memory and skill in conscious attention simultaneously; situations cue particular recollections and capabilities. State Flow can reproduce the useful property—situated recall under limited attention—while retaining machine-specific guarantees:

- Every source and revision remains addressable.
- Every enrichment step is bounded and inspectable.
- A read enriches only the current trajectory.
- Durable activation requires an explicit frontier crossing.
- Promotion remains reversible through reconciliation.

This creates a trajectory-local rule: discovery may deepen the current context, but it must not silently broaden later iterations. Progressive enrichment preserves both poles of the architecture—durable recoverability and freedom from accumulated history—because the archive contains possibilities while the operative context contains only the presently justified path.

> Memory is not preloaded; it progressively manifests as the agent interacts with its environment.

## Checkpointed agency

The same boundary that limits memory activation should also shape execution. The primary continuity unit is not an indefinitely resident conversation or process; it is a **bounded resumable task slice**. A slice may use rich transient context while it runs, but it should finish by publishing a compact semantic checkpoint from which a fresh iteration can safely continue.

```text
Bounded task slice
       │
       ▼
Action and evidence
       │
       ▼
Semantic checkpoint
       │
       ▼
Process may stop
       │
       ▼
Fresh iteration resumes from current meaning
```

Task decomposition should therefore optimize for **resumability** as well as functional modularity. A useful checkpoint preserves:

- The achieved outcome and surviving evidence.
- Active decisions, constraints, and obligations.
- Decision-relevant uncertainty and validity conditions.
- The exact continuation, when work remains.

It should omit transient reasoning, abandoned paths, duplicate tool output, and chronology that no longer affects the next decision. In this sense, the checkpoint is a sufficient semantic statistic of the prior slice: a fresh executor can recover the relevant situation without replaying the cognitive trajectory that produced it.

This is stronger than similarity retrieval. Vector or metadata search may help rediscover supporting history, but retrieval alone does not define where work safely stops, which obligations must survive, or whether a successor has enough state to proceed. Hot State Flow owns that restart boundary; lazy memory can supply optional historical evidence around it.

The distinction is especially useful for intermittent agents—workers triggered by events, embodied agents that sleep between actions, or blockchain agents whose progress is externally receipted. They do not require continuous process identity. They require continuity of verifiable semantic state:

```text
state N + observation + bounded action + receipt = state N+1
```

> An agent does not need continuity of process. It needs continuity of meaning across resumable iterations.

## Goals

- Preserve useful historical knowledge without continuously projecting it.
- Let an agent discover relevant memory without already knowing an exact key.
- Keep bootstrap cost bounded as the number and size of entries grow.
- Preserve State Flow's `global`, `cwd`, and `session` ownership model.
- Make retrieval explicit, inspectable, and cheap enough to use naturally.
- Prefer a few durable correctness constraints over a restrictive query language.
- Rank recent knowledge prominently without making old knowledge unreachable.
- Keep hot state authoritative for current work.
- Allow retention capacity to grow independently of the bounded activation budget.
- Make every transition from passive retention to future automatic activation explicit and inspectable.
- Make each completed task slice a truthful restart boundary for a fresh iteration.

## Non-goals

- Replacing `artifacts`, `contract`, `working`, or `response`.
- Moving active obligations, unresolved work, or required next-step context out of bootstrap.
- Automatically converting all old state into lazy entries.
- Requiring embeddings, a vector database, or model-generated summaries for the first version.
- Making retrieved bodies persist in subsequent model contexts automatically.
- Treating freshness as truth, authority, or semantic relevance.
- Defining a general document store outside State Flow's scoped memory responsibility.
- Automatically injecting memories merely because they appear relevant, recent, or frequently used.
- Treating retrieval as implicit promotion into future iterations.
- Preserving a continuous process or transcript when a sufficient semantic checkpoint can carry continuity.

## Conceptual model

Each State Flow scope may own lazy entries in addition to its canonical hot semantic state:

```text
global
├── hot semantic state
└── lazy entries

cwd
├── hot semantic state
└── lazy entries

session
├── hot semantic state
└── lazy entries
```

Lazy entries do **not** participate in the recursive hot-state overlay. Scope remains explicit during discovery and exact reads. This avoids ambiguous shadowing and prevents an entry in a narrower scope from silently changing the meaning of an equally named entry in a wider scope.

A conceptual entry is:

```json
{
  "key": "state-flow-telegram-adapter-incident",
  "description": "Investigation and resolution of compiled Telegram adapter discovery",
  "tags": ["state-flow", "telegram", "incident"],
  "body": {
    "cause": "...",
    "evidence": ["..."],
    "outcome": "..."
  },
  "createdAt": "2026-09-15T00:00:00Z",
  "updatedAt": "2026-09-15T00:00:00Z",
  "revision": 3
}
```

The exact persistence envelope is deliberately unspecified here. Timestamps, revision identity, scope ownership, and indexing metadata should be runtime-owned where they are mechanical provenance; the semantic body and retrieval description are agent-authored content.

## Epistemic bootstrap index

Bootstrap must not expose all entry keys or descriptions. It should expose only a bounded set of normalized tags, counts, and scope availability, for example:

```text
Lazy memory:
global: 38 entries — architecture(8), security(6), release(5)
cwd: 17 entries — state-flow(9), storage(7), incident(4)
session: 2 entries — experiment(2), migration(1)
More tags are available through lazy search.
```

### Freshness ordering

Within the bootstrap budget, tags should be ranked with a recency signal so that recently updated knowledge remains visible. A suitable ranking can combine:

- Most recent matching entry update.
- Number of recently updated matching entries.
- Total matching-entry count.
- Optional task-local relevance when it can be computed without loading bodies.

Freshness is a ranking input, not a hard filter. Old tags must remain discoverable through explicit search, tag listing, or pagination. The runtime should avoid specifying one permanent scoring formula in the public contract; ranking can evolve while deterministic tie-breaking keeps tests and inspection stable.

To prevent noisy churn, `updatedAt` should change only when an entry's semantic content or retrieval metadata changes, not when the entry is merely read or returned in search results. Reads may maintain separate operational usage statistics, but those statistics must not masquerade as semantic freshness.

### Budget

The bootstrap index should have a configured or implementation-owned output budget, not a fixed forever count such as exactly fifty tags. The observable contract is that:

- The payload is bounded independently of total entry count.
- No entry body appears.
- No complete entry catalog appears.
- Omitted tags remain discoverable.
- Counts and scope labels are truthful for the selected temporal state.

A byte or token-oriented budget is preferable to a tag-count limit because tag lengths vary.

## Tags and retrieval metadata

Tags should be controlled enough to limit synonym drift but not governed by a rigid global ontology. A useful convention is two or three facets per entry:

- **Domain:** `state-flow`, `telegram`, `actors`.
- **Concern:** `storage`, `release`, `recovery`, `architecture`.
- **Type or lifecycle:** `incident`, `decision`, `history`, `experiment`.

The runtime should normalize syntax—case, whitespace, length, and duplicate handling—but should not reject useful entries merely because their tags do not fit a predefined enum. Projects and agents need room to introduce vocabulary appropriate to their domain.

A maintenance path may suggest merges for obvious synonyms such as `release`, `releases`, and `publishing`. It should not silently rewrite semantics or require central taxonomy administration before an entry can be stored.

Descriptions are retrieval metadata, not miniatures of the body. They should be short enough for bounded search cards and specific enough to distinguish similarly tagged entries.

## Retrieval interface

The public interface should support broad agent intent while enforcing bounded output. Names below are illustrative:

```text
search_lazy(
  query="compiled adapter discovery",
  tags=["telegram", "incident"],
  scopes=["cwd", "global"],
  sort="relevance_freshness",
  limit=5,
  cursor=null
)
```

Search should allow:

- One tag, several tags, free text, or a combination.
- Explicit scope selection or a documented default scope set.
- AND-style tag intersection by default, with an explicit way to request broader matching if justified.
- Freshness, relevance, or key ordering without exposing an implementation-specific scoring formula.
- Small bounded result sets with cursors when more results exist.
- Exact-key lookup without first searching when the agent already knows the key.

Two tags are a good agent heuristic, not a system requirement. A one-tag query should succeed when useful; if it matches too broadly, the tool can return a bounded sample plus refinement metadata rather than rejecting the request. This preserves agent freedom while controlling context growth.

A result card might contain:

```json
{
  "scope": "cwd",
  "key": "state-flow-telegram-adapter-incident",
  "description": "Investigation and resolution of compiled Telegram adapter discovery",
  "tags": ["state-flow", "telegram", "incident"],
  "updatedAt": "2026-09-15T00:00:00Z",
  "approximateSize": 18400,
  "revision": 3
}
```

Search never returns bodies. Exact read does:

```text
read_lazy(scope="cwd", key="state-flow-telegram-adapter-incident")
```

Exact reads should return one entry revision and its metadata. Broad reads such as `read_lazy(scope="cwd")` must not hydrate an entire scope.

## Activation and promotion

A retrieved body belongs to the current tool-result trajectory. It is not automatically projected into future turns and does not become authoritative merely because it was retrieved.

If retrieval reveals a fact required for current correctness, the agent should promote a distilled consequence into the appropriate hot location:

- Active invariant or confirmed decision → `contract`.
- Current observation, unresolved work, or exact continuation → `working`.
- Source-addressed reusable compilation → `artifacts`.
- Historical detail with no current consequence → remain lazy.

This explicit promotion boundary prevents lazy memory from becoming a hidden source of active obligations.

## Writes, updates, and deletion

The semantic mutation model should remain singular and auditable. Two implementation shapes remain viable:

1. Extend `patch_state` with a separately validated lazy operation section.
2. Add a dedicated lazy mutation tool that still enters the same State Flow barrier, lineage, lock, and CAS publication path.

The decision should be made during implementation design after measuring schema clarity and barrier behavior. A dedicated tool must not become a second unconstrained semantic writer; extending `patch_state` must not cause lazy bodies to appear in normal patch rendering or hot materialization.

Whichever surface is selected, the system needs explicit operations for:

- Create with a unique key in one scope.
- Replace or patch an entry with revision/CAS protection.
- Retag or revise retrieval metadata.
- Delete one exact scoped key.
- Optionally move an entry through an explicit create-then-delete transaction rather than implicit shadowing.

Key collisions across scopes are legal because scope is part of identity. A collision within one scope requires explicit replace intent or an expected revision. Deletion must not reveal or mutate an entry from another scope implicitly.

## Temporal and storage semantics

Lazy memory should inherit State Flow's causal and durability guarantees rather than introduce an unrelated database:

- A lazy mutation is attributable to one accepted transition identity.
- Multi-scope hot and lazy changes, if admitted together, publish atomically through the existing lock/CAS boundary.
- Historical reads identify an exact lazy revision when supported.
- Branch restore selects lazy state from the same proven State Flow revision as hot state.
- Git-backed and file-only modes preserve the same logical semantics within their documented history limits.
- Search and exact read are read-only: they do not publish, advance semantic history, or refresh semantic timestamps.

The physical layout should be designed after workload measurement. Large bodies likely warrant content-addressed or per-entry files rather than embedding every body in scope checkpoint/tail files. The storage design must still preserve exact ownership, symlink safety, atomic replacement, migration classification, and complete-cohort publication rules.

## Minimal system constraints

The feature should have a deliberately small normative core:

1. **Hot-state safety:** Active obligations and required continuation context must remain in ordinary State Flow.
2. **Bounded bootstrap:** Bootstrap cost must not grow linearly with entry count or body size.
3. **Bounded discovery:** Search returns metadata-only cards under a strict output limit; bodies require exact reads.
4. **Explicit scope:** Search results and reads always identify owning scope; no silent cross-scope shadowing.
5. **Explicit activation:** Reading lazy memory affects only the current trajectory until the agent promotes a consequence.
6. **Causal durability:** Mutations use State Flow's existing lineage, lock, CAS, and publication guarantees.
7. **Truthful freshness:** Semantic freshness changes on semantic or retrieval-metadata edits, never on reads; freshness ranks but does not erase old knowledge.
8. **Agent query freedom:** Agents may combine free text, one or more tags, scopes, ordering, and pagination; the runtime bounds output rather than prescribing one mandatory query shape.

Everything else—including ranking weights, taxonomy suggestions, physical indexing, and the exact write surface—should remain evolvable unless implementation evidence requires a stronger contract.

### Activation invariants

The retention/activation boundary adds four cross-cutting invariants:

1. **Retention-context independence:** growing the archive cannot grow baseline model-visible context beyond the configured bootstrap budget.
2. **No activation by side effect:** search, reads, ranking, and usage accounting cannot silently alter future bootstrap state.
3. **Explicit frontier crossing:** only a visible promotion or ordinary hot-state patch can make a lazy consequence automatically active in later iterations.
4. **Reconciliation symmetry:** promotion must not be one-way accumulation; obsolete hot consequences can be archived, superseded, or removed without deleting their recoverable lazy history.

## Failure and recovery behavior

- An unavailable index should fail the lazy capability without corrupting or hiding hot state.
- Malformed entry metadata or bodies should fail closed for the affected entry and report its scoped key.
- Partial index evidence must not authorize deletion or reconstruction of entries.
- Search-index rebuilds must derive from authoritative retained entries and create no semantic transition when only mechanical index data changes.
- A stale search result followed by an updated or deleted exact entry should produce an explicit revision mismatch or not-found result, never silently return another scope's entry.
- Lazy capability failure must not prevent ordinary `read_state` or `patch_state` operations unless they are part of the same atomic mutation cohort.

## Privacy and context discipline

Lazy memory is durable storage, not private scratch space. It should follow the same operator-visible storage and repository expectations as State Flow. Search cards can themselves contain sensitive descriptions or tags, so bootstrap and search output must be treated as model-visible context.

The feature should avoid storing raw conversation transcripts by default. Entries should be intentional semantic records with enough provenance to judge their relevance and age. Secrets and credentials remain inappropriate for semantic memory.

## Candidate validation slice

The first build should be treated as a falsifiable design experiment, not as a commitment to the current interface. A defensible validation slice would include:

- Scope-local entries with key, description, tags, body, semantic timestamps, and revision.
- A bounded freshness-ranked bootstrap tag index with per-scope counts.
- Metadata-only search over normalized key, description, and tags.
- Exact scoped read of one entry.
- Explicit create/update/delete with revision protection through the State Flow publication path.
- Deterministic fallback ordering and cursor pagination.
- Regressions proving bootstrap and search output remain bounded as entry count and body size grow.
- Documentation teaching promotion to hot state and prohibiting active obligations in lazy memory.

This slice does not need embeddings, semantic vector retrieval, automatic archival, usage-based self-rewriting, or a global taxonomy registry. If bounded metadata discovery is not good enough, the result should identify the missing capability before a richer retrieval mechanism is admitted.

## Competing minimal designs

Before fixing the public contract, implementation experiments should compare at least these kernels:

### A. Exact archive with optional hints

Entries are addressed only by `scope + key`. Bootstrap may expose a tiny recent or manually pinned hint set, but there is no general search contract. This is the smallest system and the easiest to reason about; its weakness is discoverability when the key has been forgotten.

### B. Metadata catalog with bounded search

Entries have keys, short descriptions, and normalized tags. Search returns cards; exact read returns one body. This is the current leading candidate because it adds discovery without embeddings or body hydration. Its risks are metadata drift, taxonomy maintenance, and premature commitment to ranking policy.

### C. Structured tree with partial reads

Lazy memory is one scope-local typed tree rather than a catalog of document-like entries. Discovery navigates known branches and exact reads can select subtrees. This may align most closely with semantic patching and reduce duplicated entry schemas, but it risks deep-tree coupling, unstable paths, and poor discovery across distant branches.

### D. Append-only records with derived views

The durable primitive is an immutable semantic record; catalogs, tags, and current entry views are derived indexes. This offers strong lineage and recovery, but may duplicate State Flow's existing history machinery and make ordinary updates unnecessarily indirect.

The preferred design should be selected by invariants and measured agent behavior, not by familiarity. A hybrid is justified only if its extra concept pays for itself across multiple use cases.

## Acceptance properties

Before implementation can be considered complete, evidence should establish at least:

- Ten entries and ten thousand entries produce bootstrap output within the same configured budget class.
- Adding very large bodies does not increase bootstrap or search-card body projection.
- Freshly updated matching tags rank ahead of stale peers under the default order, with deterministic ties.
- Old entries remain reachable through explicit query and pagination.
- One-tag, multi-tag, free-text, and exact-key retrieval work without unbounded output.
- Search never returns an entry body; exact read returns only the requested scoped entry.
- Same-key entries in different scopes remain independently addressable.
- Read/search cause no transition, timestamp update, Git commit, or publication.
- Create/update/delete obey revision checks and existing atomic publication behavior.
- Restore, fork, hot-history, file-only, and Git-backed paths select lazy data consistently with the owning State Flow revision.
- Index corruption or absence does not damage authoritative entries or ordinary hot State Flow.
- Retrieved content disappears from later inference unless retained by ordinary trajectory or explicitly promoted.
- Baseline projected tokens remain within the same budget class as retained entry count grows by orders of magnitude.
- A read-heavy workload does not silently enlarge later bootstrap context or mutate the activation frontier.
- Promotion receipts identify the lazy source revision and exact hot destination; later reconciliation can remove the hot consequence without destroying archival history.

## Open design questions

- Is an entry catalog actually the minimal durable abstraction, or would a structured tree, exact archive, or immutable-record model compose better with semantic patches?
- What is the least automatic bootstrap signal that still lets an agent discover forgotten knowledge naturally?
- Are tags durable semantic structure, replaceable index data, or merely one optional query projection?
- Can one generic scoped read/search operation serve hot history, artifacts, and lazy memory without erasing their ownership boundaries?
- Should mutation extend `patch_state` or use a dedicated barrier-compatible lazy tool?
- What compact on-disk layout best preserves atomic publication without rewriting large bodies?
- Should the bootstrap budget be configured globally, derived from host context budget, or implementation-owned?
- Which freshness signal best balances newest-update recency against frequently active domains?
- Should search support explicit OR/NOT tag expressions in the first version, or only a broad-match mode?
- How much historical lazy state belongs in the existing seven-transition hot read window?
- Should an optional maintenance operation suggest tag merges and archival candidates without mutating them?
- What is the smallest truthful representation of the activation frontier, and can it remain identical to ordinary hot State Flow rather than becoming another subsystem?
- Should archive and promotion be symmetric first-class transactions, or can ordinary guarded patches express both without losing provenance?
- How should experiments measure omission risk alongside token savings so that a smaller active context is not mistaken for a better one?

These questions should be resolved from implementation experiments and measured workloads. They do not block preserving the proposal now.

## Recommended design sequence

1. Write the normative kernel as implementation-independent invariants and test every candidate against it.
2. Prototype exact archive, metadata catalog, and structured-tree shapes in temporary stores; include adversarial growth and forgotten-key tasks.
3. Measure not only retrieval success, but conceptual surface: number of primitives, mutation cases, metadata obligations, failure modes, context cost, omission rate, and unnecessary-activation rate.
4. Choose entry identity, mutation surface, and physical ownership together; do not stabilize public grammar while these concepts disagree.
5. Implement exact read and the smallest discovery mechanism that experiments show is necessary.
6. Add causal publication, restore, migration, and failure-path coverage through existing State Flow storage contracts.
7. Add automatic bootstrap hints only if they materially improve discovery without creating a second hot catalog.
8. Admit richer relevance only after a concrete retrieval failure survives better keys, metadata, and deterministic search.

The stopping rule is architectural, not feature-count based: stop when the system reliably preserves, discovers, reads, promotes, and forgets scoped knowledge with a small set of mutually reinforcing primitives. If the prototype requires many special cases, return to the model rather than polishing the interface.
