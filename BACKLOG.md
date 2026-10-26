# State Flow — Semantic Memory Evolution Backlog

## 1. Executive Summary

State Flow preserves not merely what an agent learned, but the continuity of its intentional activity across independent inference runs. Its next evolution should complete that semantic model without replacing Pi's execution model or expanding the runtime into an agent controller.

This backlog governs the authorized implementation of the semantic-memory roadmap, not a claim that its target behavior already exists. The inspected baseline is package **0.26.5**, local commit **`4494fee`**, with repository-local Pi SDK **1.0.0**. On 2026-10-24 the owner lifted the M0-only restriction and requested Grow Loop execution across M0–M5. Existing M0 contracts and the opt-in calibration runner are retained. Real-model comparison is deferred until functional implementation and deterministic validation; it is not an implementation prerequisite. No live behavioral baseline has run.

### Decision vocabulary

- **Agreed direction:** Supported by the design brief; implementation still requires the preservation and acceptance gates below.
- **Recommended design:** A concrete minimum-complexity proposal for owner review, not an already accepted decision.
- **Open decision:** Competing contracts remain unresolved; the named milestone must settle them before dependent implementation.
- **Deferred exploration:** No present implementation commitment.

| Direction | Status | Intended result |
| --- | --- | --- |
| Plans as first-class semantic memory | Agreed direction | Preserve accepted reasoning outcomes that reconstruct purposeful activity. |
| `contract` → `strategy`; `working` → `tactics` | Locally implemented M1; see completed checkpoint | Preserve commitments, chosen approaches, and operational reality distinctly. |
| Configurable participation of the existing three scopes | Agreed direction | Support all seven nonempty selections independently of execution mode. |
| Equal semantic capability across scopes; precedence is composition | Agreed direction | Never infer authority, truth, or plane eligibility from an owner name. |
| Genuine single-scope flattening | Agreed direction | Remove mandatory scope knowledge from ordinary model operations. |
| Semantic planes as composable cognitive contracts | Agreed direction to investigate | Evaluate compact trusted protocol composition after the core evolution works. |
| Internal protocol composition, with all three core roles retained | Accepted M4 retain/defer decision | Existing plain renderers/shared snippets suffice; no extra descriptor layer earned. |
| New semantic-module API and executable invariant boundary | Accepted M5 explicit deferral | No unmet contract established in the inspected use case; no new manifest, registration hook or API support promise. Existing public APIs remain. |
| Response ownership outside Session | Accepted M2 suppression policy | New answers stay Session-only; exclusion suppresses capture, not lifecycle completion or valid legacy shared reads. |
| Additional scopes/providers and hypothetical planes | Deferred exploration | Do not make them prerequisites. |

The ordered milestones are **M0 semantic contracts and baseline evidence**, **M1 Intents / Strategy / Tactics**, **M2 configurable scopes**, **M3 true single-scope interface**, **M4 composable semantic protocols**, and **M5 extensibility decision**. M0–M3 form the concrete delivery path. M4 is an evidence-gated investigation/refactoring candidate; M5 can legitimately conclude that no extension API is warranted.

## 2. Current Architecture and Verified Baseline

### 2.1 Source-grounded contracts

The current contracts remain owned by [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [usage](docs/usage.md), [lazy state](docs/lazy-state.md), [temporal acceptance](docs/temporal-acceptance.md), [compatibility](docs/compatibility.md), and [performance](docs/performance.md). This section records only the baseline and seams necessary for this roadmap.

| Verified characteristic | Evidence in the local repository | Consequence for this work |
| --- | --- | --- |
| Active, Passive, and Off are session execution/memory-participation modes. New sessions default to Off. | `lib/config.ts`, `lib/snapshot.ts`, `lib/episode.ts`, `lib/extension.ts`; `tests/config.test.ts`, `tests/extension.test.ts` | Keep mode orthogonal to owner selection. Passive has both tools even before a usable view exists; Off has neither tools nor injected context. |
| Global, CWD, and Session are semantic ownership spaces. | `StateScope` in `lib/state.ts`; paths/identity in `lib/durable.ts` | Keep canonical owner identity and shared/private distinctions. |
| Effective memory overlays `global → cwd → session`. | `readTemporalView` in `lib/temporal.ts`; `tests/state.test.ts` | Selection filters this ordered set; it must not reorder it. |
| Known planes are `intents`, `contract`, `working`, `artifacts`, `response`, and `lazy`. | `lib/state.ts`, `lib/protocol.ts`, `lib/history.ts` | Names participate in validation, serialization, addressing, and public types, not just prose. |
| Model patches are atomic owner-scoped recursive JSON patches. | `lib/extension.ts`, `lib/transition.ts`, `lib/json.ts` | Objects merge; arrays/scalars replace; nested object-key `null` deletes. No stored semantic nulls; supplied scopes must be nonempty. |
| Accepted supplied scopes prune empty object fields/planes; array slots and empty arrays survive. | `lib/transition.ts`, `lib/json.ts`; `tests/transition.test.ts` | Examples and migration must preserve sparse semantics and scope-local fallback, not manufacture `{}` overrides. |
| Reads support targeted current/historical values, structure, patch projections, and ordered all-or-error batches. | `lib/query.ts`, tool registration in `lib/extension.ts`; `tests/query.test.ts` | Unscoped semantic paths already alias current effective memory. Flat reads extend an existing seam; flat writes do not yet exist. |
| Structured references inside intents can own same-scope temporary memory. | `lib/ownership.ts`, staging in `lib/transition.ts`; `tests/ownership.test.ts` | Currently only explicitly scoped `working`/`lazy` object-key targets qualify. Textual mentions never own. |
| Canonical current memory is independent of the selected native Pi step. | `lib/runtime.ts`, `lib/session.ts`, branch attachment in `lib/extension.ts` | Resume/tree attach current same-session files; forks copy parent-current memory into a fresh child owner. Do not reintroduce rewind. |
| Pi owns native conversation trajectory, tool execution, retry, navigation, and compaction. | `lib/context.ts`, lifecycle hooks in `lib/extension.ts`; `tests/integration.test.ts` | Strategy is memory, not an alternative execution graph or transcript. |
| Context heads are frozen; matching-projection updates and stable-position notices reconcile later changes. | `ContextProjection` and `projectSystemProtocol` in `lib/context.ts`; `tests/context.test.ts` | Ordinary semantic patches must not rebuild protocol/prefixes. Provider cache savings are not established by byte-prefix tests alone. |
| Accepted Active answers are runtime-authored Session semantic transitions; Passive omits automatic response context and never captures answers. | `lib/extension.ts`, `lib/transition.ts`, `lib/history.ts`; `tests/extension.test.ts` | Excluding Session requires an explicit completion/capture policy. Models cannot patch response in any scope. |
| Artifacts and Skills have exact-source, exact-owner, runtime-owned provenance. | `lib/artifact.ts`, `lib/acquisition.ts`, `lib/skills.ts`, `lib/rehydration.ts`; corresponding tests | Selection must filter maintenance and acquisition as well as visible cards. Never relocate disabled-owner output. |
| Shared publication adopts the current Global/CWD basis under exclusion. | `withPatchTransaction` in `lib/runtime.ts`, `lib/storage.ts`, `lib/durable.ts` | Preserve lock-serialized acceptance, exact-byte CAS, single-use capabilities, rollback guards, and independent owner revisions. |
| History is bounded causal history, not a per-owner mutation counter or Git restoration mechanism. | `lib/temporal.ts`, `lib/history.ts`, `lib/durable.ts`; corresponding tests | Preserve identities, sparse transitions, exact retained boundaries, and explicit unavailable history. Default retention is 7; supported range is 0–100. |

### 2.2 Important qualifications and discrepancies

1. **Scope selection does not exist today.** `lib/config.ts` rejects unknown settings, including a proposed `scopes` field. Mode-command handlers in `lib/extension.ts` accept `_args` but ignore them. Representative commands below are target behavior, not current support.
2. **All scopes currently participate below presentation.** `TemporalState.scopes` is a fixed three-owner record; readers and validators iterate all three. `TemporalRuntime.publish` and fork-origin publication ordinarily pass all scopes for serialization/provenance handling. Start may fold tails and initialize absent shared pairs. A prompt-only filter would leave hidden writes, validation dependencies, and maintenance behind.
3. **Session lifecycle storage is not the Session semantic plane.** Current load/acceptance requires a Session semantic stream alongside session config/runtime. Allowing shared-only memory requires disentangling those requirements, not inventing hidden Session tactics or bypassing private identity checks.
4. **Flattening is partial only in current reads.** `read_state` already accepts `tactics.next` as an effective alias, and the ordinary head already contains one composite semantic object. `patch_state` still requires outer owners; lazy navigation, recent transitions, cascade receipts, source hints, and protocol still name scopes. `parseOwnedPath` explicitly skips unscoped references.
5. **Sparse compatibility is not rename compatibility.** `selectSemanticFields` filters known top-level fields in checkpoint/tail codecs. Removing `contract`/`working` from that list without version-aware handling would silently discard recognized old memory on later writes. Unknown-field tolerance is not a migration mechanism.
6. **Some lazy-state prose predates current-memory attachment.** Statements about retained-boundary restore/fork in `docs/lazy-state.md` must not override current `lib/runtime.ts`, `lib/extension.ts`, and the current-memory contract in architecture/usage. Future documentation work should reconcile that wording rather than implement historical rewind. Its proposed `keys.meta.sources` description also exceeds the current `lib/query.ts` output, which supplies structural type/size/length only; do not assume source metadata already exists.
7. **“Atomic” has an established boundary.** Cooperative file-cohort acceptance and guarded rollback are not kernel-atomic multi-file publication or power-loss durability. [Filesystem recovery](docs/filesystem-recovery.md) owns that limitation. This roadmap does not add a journal to solve the rename.
8. **Existing evidence is primarily deterministic.** Native-SDK scripted-provider tests establish lifecycle and transport behavior, not unconstrained-model plan quality. The performance guide explicitly avoids current-tree timing claims without a fresh source-bound run. The M1 functional checkpoint below supplies current deterministic suite evidence; no live-model baseline or current-tree performance claim follows from it.

### 2.3 Host API evidence

The repository-local SDK declarations expose `registerCommand(name, { handler(args: string, ctx), getArgumentCompletions? })`. Existing commands can parse whitespace-separated canonical scope identifiers; no shell flags, new terminal subsystem, or additional tool is needed.

`ToolDefinition` has a TypeBox `parameters` schema and an optional `prepareArguments` pre-validation shim. There is no selection-aware schema factory in that interface. The installed loader allows registration after binding and replaces the same extension's tool definition by name, calling its tool refresh path. The installed `dynamic-tools.ts` and `prompt-customizer.ts` examples confirm late registration and structured prompt sections. These APIs are integration seams, not proof that schema replacement or every union schema works correctly on every provider. M3 must test actual declarations, validation, native continuations, and host restrictions on the supported SDK line.

## 3. Architectural Thesis

**Agreed direction — Memory is continuity of agency.** An Active agent starts a new user run with compiled semantic state rather than the complete previous reasoning trajectory, except for the existing one-run bootstrap and conservative context-preservation cases. Factual recall alone is insufficient. The next inference must reconstruct:

- What outcome it has committed to achieve.
- Which approach was accepted, why it was chosen, and why alternatives were rejected.
- Which requirements remain binding, including the source and limits of those commitments.
- How phases and dependencies are expected to achieve the outcome.
- What actually succeeded, failed, or remains uncertain.
- What should happen next, and which observations justify changing the approach.

**A plan is a form of semantic memory.** It retains the actionable result of earlier reasoning about transforming a current situation into a desired future. It is neither a preserved chain of thought nor merely a disposable instruction list. An accepted plan can be a reconstruction anchor: continue the valid approach without rediscovering it at every Active boundary, while remaining able to revise it when evidence changes.

A **Skill** describes reusable procedural competence. A **strategy** is the accepted situational approach using that competence. **Tactics** records actual operational circumstances while executing it. State Flow preserves the latter two; reusable source-derived guidance stays in Pi Skills and their provenance-bound artifact compilations.

Planning, acceptance assessment, action selection, and reasoned revision remain cognitive work of the model under the user's instructions. The runtime preserves, projects, validates, and reconciles the resulting JSON. Making plans first-class memory does not authorize a planner engine, execution DAG, workflow scheduler, daemon, or automatic replanning service.

## 4. Agreed Design Principles

### 4.1 Three orthogonal dimensions

| Dimension | Values | Responsibility |
| --- | --- | --- |
| Execution mode | Active / Passive / Off | How State Flow participates in Pi execution and automatic context. |
| Memory scopes | `global` / `cwd` / `session` | Which canonical ownership spaces participate in semantic operations. |
| Semantic capabilities/modules | Initially Intents / Strategy / Tactics, alongside special facilities | The cognitive purpose and maintenance contract of stored information. |

Conceptually, **selected scopes × enabled semantic capabilities → effective agent memory interface**, subject to execution mode and validated authority. “Enabled capabilities” does not settle a configurable module-selection feature. **Recommended design:** initially keep the same core capabilities everywhere, with no module switches; Off withdraws the whole State Flow interface.

A **scope** is an ownership/applicability space with canonical identity and storage. It is not a knowledge category or an instruction rank. A **semantic plane** is a named region of ordinary JSON with a defined semantic responsibility and maintenance guidance; some planes also have deterministic runtime invariants. A **semantic module** is a possible internal unit packaging a plane's trusted contract, not necessarily a plugin or a new storage object.

### 4.2 Preservation rules

- **Agreed direction:** Every scope can contain intents, strategy, tactics, artifacts, and lazy data. `global.tactics`, `cwd.strategy`, and `session.intents` are all valid. Scope equality concerns semantic capability, not identical sharing/identity mechanics. Response remains a separately evaluated runtime exception.
- **Agreed direction:** Precedence decides overlay conflicts only. It grants no authority, importance, truth, or permission to weaken a user requirement. An unresolved contradiction can require model reconciliation even when one value wins composition.
- **Agreed direction:** Preserve sparse recursive patch semantics, scope-local deletion, no stored nulls, atomic selected-owner cohorts, exact reads, and intent-owned temporary memory.
- **Agreed direction:** Selection never moves, deletes, rewinds, normalizes, or silently replaces another owner's data. A missing selected owner follows normal current-memory validation, not an implicit disabled-scope fallback.
- **Agreed direction:** Preserve Pi-native trajectory/tool execution, fallible-data boundaries, deterministic publication, bounded retained history, source provenance, and cache-friendly frozen heads.
- **Recommended design:** Add policy at existing owning seams before extracting abstractions. Keep `lib/extension.ts` as lifecycle composition, pure semantic/reference logic below it, and storage publication in its existing owners. Avoid cycles and generic shared registries.
- **Agreed direction:** Measure behavioral improvement; a new vocabulary or modularized prompt is not evidence of better agents. Prefer retiring obsolete compatibility over indefinite aliases.

## 5. Semantic Evolution: Intents / Strategy / Tactics

**Status: M1 names/guidance locally implemented.** This is a semantic redesign, not a search-and-replace; unconstrained-model quality remains unmeasured.

| Plane | Question answered | Appropriate content | Common misuse to prevent |
| --- | --- | --- | --- |
| `intents` | What should be achieved? | Chosen outcomes and commitments still worth pursuing. | Every tool call as a task; possibilities or completed work kept active. |
| `strategy` | How have we decided to achieve it, and why? | Accepted hierarchical plans, phases, binding requirements, architectural decisions, dependencies, assumptions, rejected alternatives/reasons, reconsideration conditions, durable principles. | Treating binding constraints as optional speculation; recording an unaccepted proposal as a commitment. |
| `tactics` | What is actually happening? | Verified progress, tool/validation outcomes, obstacles, relevant uncertainty, immediate operational choices and next actions. | Commands-only planning, raw tool chatter, or observations represented as eternally current truth. |

Strategy normally remains stable while valid. A proposal is not an accepted plan. **Recommended design:** express consequential distinctions such as acceptance, requirement source, rationale, assumptions, and evidence using task-appropriate ordinary JSON. No mandatory plan-entry schema, approval flag, phase enum, task IDs, timestamps, or runtime semantic-truth validator is required. Binding means an accepted commitment under applicable instructions, not a new source of system authority.

Tactical evidence can invalidate a strategic assumption; the model then records the evidence and a reasoned revision, preserving still-binding constraints and consequential rejected approaches. Revised strategy changes tactical work. Successful work can satisfy an intent. These are semantic relationships, not automatically executed dependency edges.

**Agreed preservation:** Existing binding `contract` requirements and accepted decisions retain their force when represented in `strategy`; conversion must not recast them as optional proposals or claim a new approval that never occurred. Preserve any recorded uncertainty or proposal status too. The new name changes the cognitive model, not the source or strength of a commitment.

### 5.1 Lifetime and ownership

Fulfilled, abandoned, superseded and impossible intents can be removed. Structured intent refs own eligible **same-scope `strategy`, `tactics` or `lazy` object keys**; textual mentions do not own. The current [lifetime contract](docs/semantic-handoff-contract.md#temporary-memory-lifetime-contract) supersedes the former strategy-exempt/authored-first rule.

- Fixed semantic phases ignore JSON key order: apply intents, clear eligible targets of removed intent keys, then apply remaining authored planes before existing compilation/normalization and atomic publication.
- Final remaining and newly added same-scope intents protect targets they reference directly or through ancestors/descendants. One-patch supersession can retain ownership through the replacement.
- Editing an intent to drop a reference does not itself delete the target. Unowned entries in all three eligible planes remain legal.
- Explicit writes in the closing patch run after cleanup. A cleared same-path target starts fresh without old fields; a new path can hold the lasting conclusion instead. Other unowned paths retain ordinary recursive merge semantics.
- Strategy is eligible too. Preserve still-relevant requirements, accepted approaches, architectural conclusions and rejection reasons by explicitly rewriting a cleared path or recording them at another appropriate unowned path. A plane name alone grants no lifetime exemption.
- Keep existing scope/object-key/root/array/history/source boundaries. Store explicit accepted net patches and replay them without rerunning cascade; no automatic promotion, archive or history rewrite is added.

### 5.2 Coherent target examples

The following are **M1 model-patch examples**, using the implemented target dialect and explicit Session ownership in the current three-scope interface. Field names inside planes are illustrative domain data, not a required schema. The scenario is a release bundle that must remain usable offline; no external release is executed by these examples.

**1. Open a chosen outcome linked to its temporary operational context.**

```json
{
  "session": {
    "intents": {
      "release": {
        "outcome": "Prepare an offline-verifiable release bundle",
        "context": { "$ref": "session.tactics.release" }
      }
    },
    "tactics": {
      "release": { "progress": "Bundle prepared; offline validation pending" }
    }
  }
}
```

**2. Preserve a hierarchical accepted strategy, including binding requirements and rejected alternatives.**

```json
{
  "session": {
    "strategy": {
      "release": {
        "acceptance": "Accepted approach for this release",
        "requirement": "User requires offline verification without credentials",
        "phases": {
          "prepare": { "approach": "Bundle dependencies and a verifier" },
          "validate": {
            "after": "prepare",
            "approach": "Run the bundled verifier in network isolation"
          }
        },
        "decision": "Use bundled verifier v1",
        "rationale": "It is already packaged and expected to be self-contained",
        "rejected": {
          "online_only": "Cannot satisfy the offline requirement"
        },
        "assumption": "Verifier v1 never requires network access",
        "reconsider_if": "A network-isolated validation attempts a connection"
      }
    }
  }
}
```

**3. Record actual progress and validation evidence, not a transcript.**

```json
{
  "session": {
    "tactics": {
      "release": {
        "progress": "Preparation complete; validation blocked",
        "validation": {
          "check": "Network-isolated bundle verification",
          "result": "Failed",
          "evidence": "Verifier v1 attempted to fetch its trust index"
        },
        "uncertainty": "Whether an embedded trust index is sufficient",
        "next": "Inspect the verifier's offline-index interface"
      }
    }
  }
}
```

**4. After inspection establishes the supported alternative, revise strategy with reasons.** The failure invalidates the assumption, not the user's offline requirement. Updating the existing `rejected` object merges rather than discarding `online_only`.

```json
{
  "session": {
    "strategy": {
      "release": {
        "decision": "Bundle an embedded trust index with verifier v1",
        "rationale": "The supported local-index option removes the observed fetch",
        "rejected": {
          "default_v1": "Network-isolated validation proved its default index is remote"
        },
        "assumption": "The bundled index covers every bundle dependency",
        "reconsider_if": "An index-coverage or network-isolation check fails",
        "phases": {
          "prepare": { "approach": "Bundle dependencies, verifier, and trust index" }
        }
      }
    },
    "tactics": {
      "release": {
        "observation": "Exact-source inspection confirmed a supported local-index option",
        "uncertainty": null,
        "next": "Rebuild the bundle; rerun coverage and isolation checks"
      }
    }
  }
}
```

**5. Only after both checks pass, close the intent and retain the durable conclusion.** In this example the intent owns only `session.tactics.release`, not `session.strategy.release`: acceptance records the tactical deletion while the unowned strategy fields receive an ordinary merge and survive. If the intent also owned strategy.release, cleanup would clear it first and the patch would need to explicitly rewrite every consequence that must remain. Empty `intents`/`tactics` planes disappear if they have no other entries.

```json
{
  "session": {
    "strategy": {
      "release": {
        "conclusion": "Coverage and isolation checks passed with the embedded index"
      }
    },
    "intents": { "release": null }
  }
}
```

These conclusions survive intent closure in the same canonical owner; that does not make Session memory cross-session Global knowledge. A proven change of applicability still needs an explicit verified move, never an automatic promotion.

### 5.3 Exact rename impact

| Surface | Required treatment |
| --- | --- |
| `lib/state.ts` | Replace target plane names in sparse/defaulted types, patch types, selectors, projection, and `emptyState`; retain explicit legacy decoding before old names can be filtered out. |
| `lib/ownership.ts` | Change `OwnedPlane`, eligible-plane set, parser expectations, formatting/comments, and `ownedTopLevelKeys` result keys. Preserve object-key eligibility, same-scope checks, recursive extraction, related-path protection, and minimal deterministic cascades. |
| `lib/transition.ts`, `lib/history.ts`, `lib/temporal.ts` | Update validators, replay types, normalized explicit deletions, sparse materialization, response-independent finalization, and the retired `contract.compiled_skills` guard's compatibility treatment. Do not accidentally allow retired Skill storage at `strategy.compiled_skills`. |
| `lib/query.ts` | Update implicit-root grammar, textual-reference candidates, bounded reverse lookup planes, historical addressing, and error messages. Do not rewrite unrelated nested domain keys named `working` or `contract`. |
| `lib/context.ts`, `lib/protocol.ts`, `lib/extension.ts` | Update plane order/descriptions, patch display separators, tool definitions/guidelines, recent-transition rendering, cascade paths, and deletion hints. Preserve projection IDs and conservative effective replacements. |
| `lib/status.ts`, `lib/memory.ts`, `lib/telegram.ts` | Update plane labels, byte/intent-ownership diagnostics, and inspection formatting where applicable; keep these observational. |
| `lib/durable.ts`, `lib/storage.ts`, `lib/runtime.ts`, `lib/snapshot.ts` | Version-aware codecs and publication, scope metadata format fence, session/fork copying, semantic-in-runtime rejection list, and compatibility API behavior. Native lifecycle checkpoints do not embed plane JSON, but their decoders and referenced cohorts must remain compatible. |
| Structured/textual references and history | Translate recognized semantic path segments under an explicit compatibility policy, including retained deletion patches; never blanket-replace prose or re-derive old cascades. |
| `index.ts`, packaged Skills, docs, tests, generated declarations | Coordinate public type/API compatibility and operational instructions. Future implementation rebuilds tracked `dist/`; this planning task does not. |

## 6. Configurable Scope Selection

**Status: Agreed direction.** Every nonempty subset is supported; default selection is all three. Semantic planes are never permanently allocated to particular scopes.

### 6.1 Operator interface and validation

Target mode commands use Pi's existing command-argument string:

```text
/state-flow-active
/state-flow-active session
/state-flow-active cwd
/state-flow-active global
/state-flow-active global cwd
/state-flow-active global session
/state-flow-active cwd session
/state-flow-active global cwd session
/state-flow-passive cwd
/state-flow-off
```

**Operator refinement:** The initial recommendation kept Off argument-free. The [public command contract](docs/scope-selection-contract.md#public-mode-command-scope-overrides) uses one strict token grammar on the three existing mode commands instead: an explicit Off choice is native policy DATA only, with no canonical I/O or private grant. This permits changing participation while remaining Off without fake enabled-mode staging, seven mode variants or an extra selector command; mode-only Off still preserves the last choice. Completion uses the SDK's existing `getArgumentCompletions` seam.

The proposed root configuration is:

```json
{ "mode": "off", "scopes": ["global", "cwd", "session"] }
```

**Recommended design:** Validate a nonempty array of unique exact strings drawn from `global`, `cwd`, `session`; reject duplicates, unknown names, `CWD`, nonstrings, and empty arrays. Command arguments split on whitespace; whitespace-only means no explicit selection. Reject duplicate tokens and unknown syntax atomically, before changing mode/selection. Normalize valid input to the existing relative order regardless of token order. Selection order never becomes precedence configuration. A missing field means all three for backward compatibility. Invalid global configuration continues to fail extension loading, not silently choose another default.

### 6.2 Policy, precedence, and persistence

**Recommended design — Concrete session policy, outside semantic state:**

1. An explicit current-session command selection overrides that session's retained selection and global defaults.
2. Without scope arguments, preserve the session's already established selection across Active, Passive, and Off. Repeating the same mode with a different explicit selection is a real policy change; existing “already active” fast paths must not swallow it.
3. A genuinely new independent session samples the loaded global default. Capture that concrete selection in native policy bookkeeping, even in Off, so later global edits do not unexpectedly alter a retained session. A session with no selection evidence uses the global default until that initial policy is recorded; legacy sessions require this compatibility rule at first upgraded attachment.
4. Store selection alongside mode in session configuration and supported native lifecycle/pre-runtime checkpoints. Extend native Off/deferred-fork and failed-persistence markers so they can carry selection without canonical I/O. Keep semantic checkpoints/tails free of selection metadata.
5. Native branch policy selects mode and selection; canonical files supply current memory. Tree navigation can restore an older branch's selection, never its old semantic contents. Reload/resume retain the recorded selection. Reject conflicting/malformed selection evidence, rather than falling through to a wider default.
6. Forks should inherit the selected source branch's concrete selection as child policy, with a fresh child identity and no shared mutable configuration. Independent `/new` sessions use their own global default. Fork memory acquisition details are gated separately below.
7. Mode-only Telegram controls preserve selection; status must distinguish selected and excluded owners. A seven-combination Telegram chooser is not required for initial delivery.

This is a new contract, not a claim that `SnapshotConfig`, retained-checkpoint parsing, or strict one-key session config already accept scopes. The precise optional field/version encoding and legacy-session sampling point must be resolved in M0/M2. The [M0.3 selection/lifecycle contract](docs/scope-selection-contract.md) supplies the state-by-state acceptance map and proposed policy. Its baseline probe confirms that mode-only extraction can ignore malformed explicit scopes even though strict session/checkpoint codecs reject the new field; selection admission must therefore be explicit, not inferred from a mode read. There is no model-authored configuration patch.

### 6.3 Participation contract

**Agreed direction:** Compose only selected scopes, in relative `global → cwd → session` order. With two scopes, writes still identify their canonical owners and share one atomic accepted cohort. Disabled owners cannot participate through inheritance, implicit default, acquisition side effects, response capture, or fallback.

**Recommended design — One consistent model-access rule:** Disabled scopes are inaccessible to normal `read_state` and `patch_state`, both current and retained-historical. This is stronger and less confusing than merely hiding them from automatic context. A disabled explicit path is a tool error, not an empty result or dangling-reference sentinel. Multi-path reads and mixed-owner writes fail wholly when any requested owner is disabled. Reverse lookup hints search only participating owners; disabled-owner values and owner paths must not leak through hints, recent transitions, lazy navigation, provenance hints, or receipts.

Selection alone must not:

- Delete, initialize, normalize, fold, or rewrite an excluded owner's checkpoint, tail, or provenance metadata.
- Transfer data, change its owner, advance any semantic revision/step, allocate a semantic transition, or rewrite retained identities.
- Insert an empty semantic stand-in for excluded data into staging or composition.
- Recover disabled memory through unscoped reads or references.
- Rewrite Pi's native conversation to pretend previously visible information is forgotten.

Lifecycle config/runtime writes may still be session-owned even with Session semantics excluded: session identity, lineage, run completion, mode, and selection remain lifecycle responsibilities. That permission does not include a hidden Session response/intents/tactics stream. Current all-owner serialization and absent-file initialization must become selected-owner-aware, including the first shared-only patch. Durable private-acquisition provenance must distinguish an intentionally unacquired Session stream from disappearance of already acquired private memory; missing files, current exclusion, or a zero revision alone cannot authorize empty initialization.

**Recommended design — Coherent internal evidence, no invented absence:** A disabled stream may be captured/validated internally only where needed to prove an existing retained cohort or CAS basis; it contributes no semantic values and receives no writes. Current types assume all three streams, so M2 must explicitly represent nonparticipation rather than fill it with `emptyState`. If required causal/identity evidence is corrupt, fail closed with the dependency identified. Selection is not permission to repair it. Whether unrelated disabled-stream corruption can be isolated completely is an open storage-design decision; ordinary selection must never silently reinterpret corruption as an empty owner.

Re-enabling an owner acquires its current canonical state under normal validation and shared-drift reconciliation. Missing shared pairs and incomplete/private evidence keep their documented distinction. Disabled state is retained, not frozen externally: other sessions may legitimately change shared owners while this session excludes them.

### 6.4 History and diagnostics

**Recommended design:** Historical `effective[N]` composes the **currently selected** owners at the original retained causal boundary; it does not restore the selection used when that transition occurred. Owner materializations and patch histories require that owner to be selected. Filter automatic recent-transition content without renumbering identities/positions; a transition with no visible content can disappear from automatic presentation while remaining a causal offset.

A newly re-enabled owner may lack aligned earlier history. Return unavailable history rather than fabricate an overlay or recover discarded offsets. Selection does not rewrite past transitions or create a transition just to align clocks. Existing valid shared drift may require a fresh proven origin, with its normal explicit loss of aligned history; policy selection itself must not manufacture one unnecessarily. Pin this distinction in tests.

Explicit operator-only status/Telegram inspection may inspect excluded owners through disposable validated readers, clearly labeled as excluded from model participation. It must not install model caches, activate scopes, maintain sources, publish, or clear fences. Selection is **not a confidentiality boundary**: native conversation and tool results can still contain earlier selections' information, and Pi retains its own trace.

## 7. Single-Scope Flattening

**Status: Agreed direction; essential behavior, not just formatting.** With exactly one selected owner, effective semantic memory is that owner's sparse state. The model should not need to learn which canonical scope was selected for ordinary reads, writes, references, or continuation.

For `/state-flow-active session`, target calls include:

```json
{
  "intents": {
    "release": {
      "outcome": "Prepare the offline bundle",
      "context": { "$ref": "tactics.release" }
    }
  },
  "tactics": { "release": { "next": "Run isolation validation" } }
}
```

```json
{ "path": "tactics.release" }
```

```json
{ "intents": { "release": null } }
```

The last patch cascades the canonical owner's tactical target under the ordinary same-scope rule. The model never supplies a Session wrapper. The same interface works for only Global or only CWD in either Active or Passive. Off exposes nothing regardless of retained selection.

### 7.1 Normalize at the model boundary

**Recommended design:** Keep one canonical scoped write/reference format internally. Normalize flat patches into the sole selected owner **before staging**. Normalize eligible structured semantic `$ref` paths such as `tactics.release` to that exact owner before storage. Project canonical same-owner references back to flat paths in model-facing values. Never mutate stored values during projection or change low-level ownership parsing to infer an owner from mutable global settings.

This avoids persistent ambiguous unscoped ownership: a reference written in a flat Session view remains Session-owned after Global/CWD are enabled. Conversely, a scoped reference to a different owner must never be stripped and reinterpreted as local. Ordinary non-owning references can remain unresolved when their owner is excluded; existence, truth, hydration, and cross-owner cascade are never inferred.

Boundary conversion must cover all places the model sees or authors semantic paths: structured references nested in arbitrary JSON (including lazy reads), recognized textual `$path` mentions, read selectors/results, cascade and missing-deletion diagnostics, artifact compilation targets, lazy navigation, and recent patch presentation. Resource paths and domain prose remain untouched. Textual references stay non-owning. Flat reverse-lookup diagnostics must recognize the normalized canonical target without broadening the current-only bounded lookup.

**Accepted M3 grammar:** Ordinary current paths are unscoped; `effective[N].tactics.release` addresses materialized history, and a narrowly validated scalar `patches[N]` alias addresses sole-owner retained patches. The [deterministic M3 boundary](docs/single-scope-interface-contract.md#deterministic-m3-checkpoint) owns the installed tool/normalization/history proof. `effective` is a projection concept, not a scope identifier. Do not introduce ambiguous `tactics[1]` as temporal history because it already means an array selector. Canonical explicit paths may remain accepted for selected-owner compatibility, but are not required or taught as the normal flat interface.

### 7.2 Tool schema options

| Option | Benefits | Costs and failure risks | Recommendation |
| --- | --- | --- | --- |
| One stable schema admitting disjoint flat semantic keys or scoped owner keys, plus selection-aware validation | Register the same two tools once; stable declarations across ordinary patches and selection changes; reusable handlers. | Schema describes both structural variants; it cannot alone express the current selection. Must reject mixed shapes and wrong-arity calls and clearly describe the conditional contract. Provider support for alternatives must be tested. | Preferred baseline if real SDK/provider probes show reliable use. |
| Replace the same tool definitions only at accepted selection/arity boundaries | Model sees exactly the applicable field schema and scope names; no extra tools. | Must prove refreshed schemas/descriptions reach the next request, validation uses the same policy, Off/allowlists remain intact, old calls cannot publish, and provider deltas/cache behavior are acceptable. | Bounded fallback if the stable grammar is misleading or measurably fails. |
| Duplicate flat/scoped tool names or per-run registration | Superficially easy separation. | Permanent API duplication, mode/activation drift, stale calls, and needless cache churn. | Reject absent evidence that both simpler options are impossible. |

The stable option should use a closed object schema with explicit known property families and a tested mutually exclusive constraint, or a supported object-union representation. Require at least one supplied patch branch. No opaque `Type.Unknown` whole-input escape hatch and no hidden acceptance of undeclared flat fields. Runtime validation remains authoritative for **one selected owner → flat grammar; two/three → explicitly scoped grammar**, with any short-lived compatibility exception documented and tested. Reject mixed flat/scoped calls atomically.

`prepareArguments` is an available normalization seam, not a way to conceal an unadvertised API: schema-visible input must accurately describe calls the model is expected to make. Do not assume in-place mutation of a schema object refreshes native/provider declarations. Selection-bound replacement, if chosen, is not per-inference registration.

**M3 decision gate:** Prove the preferred schema through actual native dispatch and representative supported provider serialization, then compare flat-interface error/retry rates. If conditional schema instructions still force a one-scope model to reason about all three owners, use the narrow replacement option. No design is accepted on prompt prose alone.

### 7.3 Presentation and publication

Flatten automatic heads, read outputs, bounded navigation, recent patch envelopes, structured-reference displays, ordinary acknowledgements, and cascades consistently. Keep internal/tool-detail/operator provenance explicitly scoped. In a sole-owner receipt, a path such as `tactics.release` is unambiguous within its projection identity; in multi-owner mode retain owner paths. Selection changes reset projection identity, so an old flat receipt cannot target a new sole owner.

Two/three-scope operation retains explicit write ownership, effective composite reads, conflict precedence, scope-local deletion/fallback, and atomic multi-scope publication. Disabled-owner writes never become flat fallbacks. No conversion moves canonical data or rewrites history merely because presentation changed.

## 8. Semantic Plane Modules

**Decision complete: M4 retains current plain renderers/private snippets; M5 defers any NEW semantic-module API, manifest or executable registration.** The criteria below remain evaluated alternatives, not an implementation commitment. A possible semantic module would package a cognitive function, not merely describe a JSON field; the conceptual responsibilities are:

1. **State:** Plane name, semantic purpose, and ordinary JSON responsibility.
2. **Protocol:** Concise trusted guidance on maintaining and using the plane.
3. **Invariants:** Any deterministic shape/transition conditions genuinely requiring enforcement.
4. **Relations:** Explanatory relationships with other planes, not executable triggers by default.

The initial functions are Intents (chosen commitments and closure), Strategy (accepted approaches, constraints, rationale and reconsideration), and Tactics (evidence-grounded operational reality). None requires a separate planner or storage subsystem.

### 8.1 Declarative versus constrained executable contracts

| Criterion | A — Declarative internal descriptors | B — Descriptors plus constrained executable invariants |
| --- | --- | --- |
| Expressiveness | Sufficient for plane purpose, trusted instructions, relationships, and fixed order; shared runtime enforces existing rules. | Can express additional pure validation/transition constraints when demonstrated. |
| Implementation complexity | Small static composition helper; no lifecycle/plugin infrastructure. | Requires precise inputs, ordering, conflict semantics, failure handling, and capability restrictions. |
| Testability | Golden/property tests for fragment order, completeness, compactness, and trust boundaries. | Also needs purity, input-detachment, failure atomicity, determinism, and adversarial cross-plane tests. |
| Determinism | Fixed configuration yields identical protocol; runtime algorithms stay centralized. | Only defensible for synchronous pure deterministic functions with no I/O, time, randomness, inference, or publication. |
| Prompt composition | Core plus fixed fragments inside the existing owned section. | Same prompt seam; executable code must never generate rules from stored values. |
| Backward compatibility | No new stored module envelope or public plugin ABI required. | A new invariant can reject previously valid memory; versioning and admission rules become substantial. |
| Hidden-side-effect risk | Low if relations remain documentation and state remains data. | Higher even with restrictions; rewrite ordering can accidentally become a reaction network. |
| Intent ownership | Retain the proven runtime-owned cross-plane cascade as one deterministic transaction rule. | A pure ownership rule is conceivable, but moving it into hooks solves no current deficiency and risks duplication. |
| Loader/API need | None. Static package-owned descriptors suffice. | Still no need for dynamic loading; an internal function table can test the hypothesis first. |
| Demonstrated problem solved | Can remove duplicate/inconsistent semantic guidance and make cognitive contracts reviewable. Benefit still needs evidence. | No new core-plane behavior currently proves hooks necessary. Reject hooks justified only by the word “plugin.” |

**Accepted disposition:** Retain existing functions and shared trusted snippets; M4 did not earn a descriptor layer. Storage, publication, lifecycle and intent cascade retain their current owners. A future narrow invariant first needs a concrete unmet relation and comparison to one internal staged check; a public seam additionally needs an actual independent consumer. These are falsifiers for a separately justified proposal, not open implementation tasks. M5 authorizes neither external packages nor arbitrary execution.

### 8.2 Trusted protocol composition

**Retained trust boundary:** Keep one package-owned `state_flow` section. The following conceptual content map is not an implemented descriptor array, exact output-order claim or requirement to extract separate fragments; actual composition is owned by the [accepted M4 decision](docs/protocol-composition-decision.md):

```text
Stable core: trust, mode, selected-owner grammar, reads, patches, history, reconciliation, safety
  → Intents fragment
  → Strategy fragment
  → Tactics fragment
  → special-facility guidance: artifacts/provenance, lazy access, applicable response policy
```

Use the existing `before_agent_start` section contribution and `context_with_system` refresh in `lib/extension.ts`/`lib/context.ts`. Do not add one system message per plane, replace foreign sections, override forced-prompt precedence, or synthesize missing system authority. Trusted fragments come from reviewed package code/configuration, never from memory values, artifacts, compiled Skills, or lazy bodies.

Fragments must have one owner per rule and a fixed composition order. Their contents depend only on accepted interface policy (mode, selected scopes/arity, bootstrap, and any future reviewed capability configuration), not on which ordinary keys/planes happen to be populated. Ordinary semantic patches must not alter system instructions, reorder sections, or rebase the frozen head. Selection/mode boundaries may legitimately change protocol; measure those separately from within-run cache stability.

Preserve Passive's distinct obligations: it may benefit from compact semantic definitions without inheriting Active's mandatory consolidation/reset behavior. Existing protocol tests enforce deduplication and a roughly 4.5k-character Active ceiling. Treat that as an existing guard to reassess explicitly with evidence, not permission to append three verbose essays or silently delete important rules to hit a byte count.

### 8.3 What is not initially modularized

- **`response`:** Runtime-owned accepted-answer capture and lifecycle reconciliation, with mode-specific presentation. Not an ordinary user-supplied cognitive module.
- **`artifacts`:** Source-addressed compilation and provenance machinery. A descriptor may document it, but provenance, freshness and exact-owner publication stay runtime responsibilities.
- **`lazy`:** Orthogonal retention/projection facility for ordinary JSON detail, including intent-owned content. Not a new reasoning role or executable retrieval policy.

**Deferred exploration:** A `hypotheses` module could preserve falsifiable assumptions and distilled confirmed conclusions. It illustrates extensibility only; reaching M5 alone does not authorize it, auto-promotions or new plane storage; any such capability needs a separately accepted unmet requirement. Optional module enable/disable controls are a separate future product decision, not required for static protocol composition.

## 9. Cross-Plane Interactions and Runtime Invariants

| Relationship | Primary actor | Required boundary |
| --- | --- | --- |
| Intents provide direction to strategy | Model reasoning | No mandatory intent-plan foreign-key schema. |
| Strategy guides tactical execution | Model reasoning through native Pi tools | No execution edges, scheduler, or tool authorization inferred from state. |
| Tactics supplies contradictory evidence | Model reasoning | Record the observation and reasoned revision; never silently demote a binding requirement. |
| Tactical work satisfies an intent | Model judgment, then ordinary patch | Runtime validates JSON/publication, not whether the real task succeeded. |
| Intent deletion clears owned strategy/tactics/lazy targets | Existing deterministic ownership algorithm | Same-scope only; intents first, cleanup, other authored planes; final remaining/new related-owner protection; explicit accepted net replay. |
| Results outlive an intent | Model reconciliation | Explicitly rewrite a cleared same/new path after cleanup in the same patch, or retain an appropriate unowned path; no hidden transfer or strategy exemption. |

**Agreed preservation:**

- One accepted cohort has one transition identity across materially changed participating owners, and one increment per changed owner's revision. No-ops, reads, mode changes, flattening, and selection alone create no semantic transitions.
- Retained replay uses accepted explicit patches, including cascades and complete compilation replacements, not renewed model judgment or re-derived ownership.
- An Active patch remains an inference barrier; sibling tools do not execute from that response. Existing Passive behavior is not silently strengthened into an Active barrier.
- Frozen heads and matching projection IDs distinguish current replacements from retained old results. Revealed fallbacks, masked writes, shared drift, and cascades remain conservatively reported.
- Exact current/historical reads stay observational and detached. No automatic hydration, historical restoration, reference scanning, semantic repair inference, or whole-store audit.
- Metadata/config/provenance remains outside model-patchable state. Untrusted memory never changes trusted protocol.
- No module can acquire publication authority, choose another scope, schedule inference, or recursively trigger another module's rewrite. If a future invariant is executable, it must operate within one staged transaction and fail the whole candidate before publication.

## 10. Special Cases and Ownership Boundaries

### 10.1 Response when Session is excluded

**Accepted M2 policy: Session-only new-answer capture; suppress when excluded.** Semantic answer writing and accepted run completion are separated through existing lifecycle authority, without a fabricated completion patch. The [M2 functional boundary](docs/scope-selection-contract.md#m2-functional-acceptance-boundary) owns the native proof. The alternatives below record the evaluated choice, not open implementation work.

| Approach | Semantic consistency | Migration/runtime cost | Consequence |
| --- | --- | --- | --- |
| Selected: keep response Session-owned; capture only when Session is selected | Fits exclusion and existing source of accepted answers; no hidden semantic writes. | Smallest format change, but completion must accept config/runtime without a response transition. | Shared-only Active runs do not automatically carry their last answer into the next run. Future-relevant results must already be in strategy/tactics/artifacts. |
| Not selected: relocate accepted-answer storage to agent/session lifecycle outside semantic scopes | Makes latest-answer continuity independent of selected scopes. | New storage/read/history/projection contract, public API migration, fork policy, and compatibility burden. | Risks an effectively hidden fourth memory facility; must decide whether it is semantic memory and how it participates in history. |

**Accepted behavior:** Keep Session ownership and suppress capture while excluded. Complete the run and remove its unfinished specification under the existing accepted lifecycle authority; no Session semantic revision or hidden shared response write. If there is no other semantic change, this is lifecycle-only acceptance. Cancellation before acceptance keeps unfinished lifecycle; after acceptance never roll back. It must still unblock correct settled-turn backup/compaction eligibility without assuming a response transition occurred.

With Session selected, preserve exact post-handler answer capture, including empty-answer clearing semantics. With Session excluded, retained Session response stays untouched and unavailable to model reads/projection. Selecting Session later exposes its last legitimately captured answer, not a manufactured backfill; the answer may be old and remains fallible prior-run data. Passive always excludes automatic response context and never captures a new answer. Native answer text is not redacted. Do not silently treat lifecycle relocation as approved.

Legacy nonempty response values in Global/CWD are a separate compatibility issue: current effective projection can inherit them although new responses are Session-only. Preserve existing readable data until an explicit compatibility decision; do not use this work to invent new Global/CWD response authorship or silently delete legacy values.

### 10.2 Artifacts and registered Skills

**Recommended design:** Filter source observation, missing-source pruning, invalidation hints, read candidates, rehydration, required ordinary-artifact compilation, and provenance updates by selected canonical owner. A disabled owner has no automatic maintenance, including deletion of proven-missing registrations. Its stale card and evidence remain unchanged until explicit re-selection and normal validation.

Registered Skill ownership remains Pi `sourceInfo.scope`: `user → global`, `project → cwd`, `temporary → session`, regardless of filesystem path or current selection. When that owner is excluded, a successful read remains volatile native tool context; suppress an impossible durable compilation request or report that durable compilation requires explicit operator selection. Never redirect it into the sole enabled owner. Preserve rejection of an attempted misowned compilation.

Ordinary artifacts whose disabled-owner invalidation was acquired before a selection change cannot force compilation after that change. Cancel/clear old acquisition evidence; do not keep a deferred durable queue. Freshness checks before/after read and at publication, ordinary `size + mtimeNs` fingerprints, separate Skill hashes, compiler identity, and complete card/evidence replacement remain intact. An enabled lower-owner card may become effective when a masking owner is excluded; re-evaluate its own provenance rather than borrowing the disabled owner's evidence.

### 10.3 Shared-only operation

**Agreed direction:** Selecting Global and CWD without Session is valid. Intents/tactics in those owners are visible to other sessions using the same store. Scope equality does not imply privacy. Explain this consequence in operator receipts/docs; never invent a private Session safety net or implicitly move current work there.

Keep current-head shared patch staging under exclusion. Preserve other writers' unmentioned fields, last-accepted overlap, source/provenance CAS, and private lifecycle identity fences. If one session deletes a shared intent, a later writer can recreate it under existing JSON semantics; no collaborative task coordinator is added. Model reconciliation must account for actual accepted shared drift.

### 10.4 Lifecycle, forks, and stale selections

**Recommended design:** Bind every asynchronous operation to both physical session identity and an immutable selection identity/lifetime. Capture it before waiting; recheck after lock acquisition and immediately before publish/install. Scope changes revoke obsolete patch, preparation, response, attachment/fork, acquisition, inspection, and mode-operation receipts, even for a change away and back to the same set. Already accepted publications remain accepted.

Selection changes rebase model context/protocol once, clear stale acquisitions, and prevent frozen Stop/bootstrap handoffs from injecting newly excluded semantic data. Keep native trajectory and foreign context; selection is not transcript erasure. An old provider response or old flat arguments must never be normalized into a newly selected sole owner. If existing operation signals cannot establish this fence for an already-issued request, reject stale calls and document the boundary rather than guessing their intended owner.

**Accepted M2 deferred-copy policy:** A fork whose Session scope is excluded creates only child lifecycle policy/authority plus selected shared-memory access; do not copy or create hidden child Session semantics. Retain child-owned pending private-copy bookkeeping. If Session is later explicitly enabled, acquire the parent's then-current Session stream into an unused child semantic target once, under exact-source/fresh-child checks. Existing `prepareForkCandidate` rejects any of five occupied child files, so it cannot be reused unchanged: deferred copying needs proof that the existing child config/runtime belongs to this pending fork while its semantic target is still absent. Never overwrite an occupied child semantic stream. Once accepted, future re-selection uses child-current memory and never recopies. Parent absence/corruption is an explicit failure, not empty child memory. The native child lifecycle-only representation, delayed parent-current acquisition, re-enable/private-proof and no-recopy boundaries are accepted in the [M2 functional contract](docs/scope-selection-contract.md#m2-functional-acceptance-boundary), not an open fork design task. Eager hidden copying while excluded is not selected.

Off remains immediately memory-inert: cancel owned memory work, clear semantic caches, persist native mode/selection/deferred-fork bookkeeping only, and never touch canonical state to save a selection. Retain failed-Passive write fences and Active blocked-inference behavior. A selection change must not clear a fence or confer acceptance on a pending candidate. Passive may select local restrictive policy before persistence, but newly enabled memory needs validated acquisition before model use; failed acceptance must be visible, not silently widen back to the previous set.

**Recommended design — Pending selection:** Preserve the existing Off-to-Active rule that mode activation waits for acceptance. When an already Active session changes scopes, withdraw obsolete preparation/inference work and fence new Active provider requests until the requested selection has a validated current view; failure stays visibly blocked rather than projecting the old selection. Passive may retain native inference but must withhold unavailable newly enabled memory and reject dependent tools. Native policy records the requested selection/fence without pretending canonical acceptance succeeded. M2.4 must test restriction, expansion, failed acquisition, and same-mode changes separately.

## 11. Compatibility and Migration

**Agreed direction:** No memory loss, silent old-name filtering, unannounced historical reinterpretation, or indefinite dual semantic model. Existing memory is the starting point, not disposable test data.

### 11.1 Alternatives and guarantees

| Approach | Preserves without rewriting canonical history | Costs and limits |
| --- | --- | --- |
| Version-aware compatibility reader | Original checkpoints/tail bytes, identities, sparse boundaries, deletion markers, and original historical field names can remain intact. A separate normalized view can expose target names. | Every replay boundary needs a known dialect; mixed-version appends need explicit epoch/version metadata. Exact old-name reads and normalized target reads must not be confused. A simple “rename current state” adapter is insufficient. |
| Explicit canonical conversion of each owned checkpoint and retained tail | Can preserve transition IDs, positions/parents, owner revisions, and values modulo a declared path translation. | Rewrites historical syntax; literal old-name JSON/paths cease to be the canonical interface. Needs quiescent writers, a fence, complete-cohort validation, explicit approval, and a backup if original bytes must remain recoverable. |

**Implementation direction:** Implement version admission first as the compatibility/safety boundary, then a one-shot owner-cohort conversion to translated retained semantics, with complete backup and one target-facing API. Convert the retained checkpoint **and every retained replay patch together**, not just the materialized head. Reserve `contract` and `working` as retired root-plane names while the transition exists; reject new-format creation/patches using them, without banning nested ordinary data keys. The [compatibility decision](docs/semantic-compatibility-decision.md#implementation-direction-and-reserved-names) owns detailed translation, settled State Flow0.x/1.0.0 support timing and operational constraints. The prepared0.27.0 candidate retains the implemented converter/reservations; operating it on live stores still requires exact-store authority.

**Historical contract for implementation:** New-name historical reads promise semantic equality under the declared translation, including sparse values, empty branches, recognized references and causal identity; they do not promise the original field spelling. A complete operator backup preserves original bytes outside normal `read_state`. This avoids permanent dual model-facing planes. No acceptance gate may call a translated historical value byte-identical to its predecessor.

### 11.2 Required conversion/reader contract

1. **Canonical current state:** Translate only the recognized top-level semantic planes. Preserve sparse absence, nested ordinary JSON, empty legacy branches for exact reads, arrays, finite values, and no-stored-null rules. Do not run current patch pruning as part of a representation-only reader.
2. **Retained history:** Decode the checkpoint and each patch in its declared dialect before replay. Preserve explicit deletions, record identity/order, alignment with lineage, and revisions. Ownership cascades already recorded as deletions must not run again. Prove translation commutes with replay at every retained boundary. Folding at limits 0/1/7/100 must not invent or lose current values.
3. **Name collisions:** A future `strategy` or `tactics` field may exist as previously ignored top-level data. Detect raw collisions before known-field selection. Reject conflicting dual representations for explicit reconciliation; never merge them by arbitrary precedence or silently discard one. Any support for identical dual values needs a narrowly documented rule.
4. **References:** Translate complete recognized semantic paths in structured `$ref` and deliberate textual `$path` mentions, including scoped/effective/historical targets and reference-owner diagnostics. Preserve same-scope ownership and non-owning text. Do not rewrite ordinary prose, resource paths, nested domain keys, or path-looking data without the semantic marker. Unparseable/ambiguous references need a reported compatibility decision, not an eager store-wide repair scan.
5. **Shared owners:** Global/CWD may have multiple writers and sessions retaining their history. Coordinate upgrade/quiescence and revalidate exact bytes under the existing lock. A per-owner semantic-dialect fence must cause supported older writers to refuse before they can filter out new planes. Existing metadata `version: 2` already means revision-aware provenance; do not overload it casually. Choose a reviewed newer format/fence; a global config key alone cannot protect shared writers. Baseline low-level `parseScopeStream` did not check that version, unlike `parseScopeProvenance`, and metadata serialization could downgrade future input to version 2. M1.1a hardens those current-source entrypoints, but cannot retrofit deployed old binaries. Test each supported old-client API composition and require upgrade/quiescence for clients that cannot be fenced. Do not claim universal refusal from a provenance-reader test alone.
6. **Private owners and forks:** Preserve current Session contents, current provenance, lineage, identity, and current-head fork semantics. Copy/decode the parent's supported dialect into a child-owned supported dialect without rewriting the parent. Pending Off forks remain native-only until authorized acquisition. Account for the selected-scope fork decision separately.
7. **Interrupted publication:** Preflight complete/absent/partial/malformed cohorts; generate detached conversion candidates and validate before publication. Use exact byte receipts/CAS and guarded rollback. Crash interruption can leave incomplete cohorts under existing durability limits: fail closed with preserved evidence and an operator recovery procedure. Do not promise a journal, automatic crash repair, or Git authority.
8. **No semantic transition for representation alone:** Preserve owner revisions/causal identities when values are translated without semantic change. Never fake an authored old-plane deletion/new-plane addition as a new learning event just to migrate. If an operator resolves a real semantic collision, that is a distinct accepted semantic change.
9. **Selection metadata:** Introduce it in config/native lifecycle policy, not semantic planes or historical patches. Legacy absence, strict config decoding, Off markers, pre-runtime choices, mode fences, reload/tree, and fork inheritance all need explicit compatibility witnesses. Selection-only persistence must not trigger conversion or folding of disabled owners.
10. **Public API:** Inventory exported sparse/defaulted state types, patch/history types, query APIs, `TemporalRuntime` methods, fork lifecycle, extension options, and embedding callbacks in `index.ts`. Decide a documented breaking release versus a bounded adapter entrypoint/support window. Keep default-bearing library views separate from sparse model/storage views. Do not leave old fields apparently accepted but silently ignored by new APIs.
11. **Skills and compiled instructions:** Update both packaged Skills and all examples/tool guidance consistently. Existing compiled Skill cards can contain old tool names/plane instructions; preserve source ownership/evidence, detect actual source-version invalidation through the existing hash protocol, and reacquire as needed. Do not fabricate a new matching source hash or promote compiled text into system rules during conversion.
12. **Rollback and retirement:** Before conversion, preserve complete backups of exactly the converted owner cohorts and their required owned lifecycle/config/runtime authority outside canonical authority, and record exact paths, byte identities, source/destination dialects and validation results. Completeness is relative to those conversion/recovery dependencies, not permission to discover every unrelated project/session or scan the whole store. Downgrade after conversion requires that proven backup/conversion route, not running an old writer over new memory. Remove temporary compatibility paths after the reviewed support window, not merely after one test fixture converts.

## 12. Ordered Implementation Backlog

Every task row below is remaining open work. Take one dependency-ready item/cohort, retain its named preservation duties, and return its evidence. Producing a design artifact does not close its later implementation milestone. Each milestone ends at a compiling, reviewable acceptance checkpoint rather than a repository-wide rewrite. This file remains the sole canonical open-work surface. No implementation loop is active. Completed implementation delivery belongs in [CHANGELOG.md](CHANGELOG.md#0270-semantic-memory-and-scope-selection) and its indexed owning contracts. Further implementation requires a new scoped user request; do not run the externally gated model trial or perform staging, commit, push or publication.

**Execution order and convergence:** Implement and deterministically validate M1, M2 and M3, then resolve the earned M4/M5 design/implementation decisions. Perform model-behavior comparisons afterward, without fabricating baseline observations or quality claims. A no-extraction/no-external-API decision can satisfy M4/M5 when the evidence supports it; “all tasks” does not require speculative frameworks. Finish when every required implementation/decision/evaluation item has evidence or a specific external gate. Continue one independently validated cohort at a time; preserve pre-existing work. Publication, live-store conversion, history rewrites and credential operations are not implicit consequences of this implementation authorization.

**Current0.27.0 release boundary:** Version/lock/generated package align at0.27.0. The reported NATIVE-1/PUB-1 corrections have bounded independent acceptance; no local correction row remains open. Latest full gates cover1695cases on each supported Node with145pack files; internal modules and public registration/lifetime each have bounded independent acceptance. Metadata4 codec retention has separate bounded acceptance from both independent risk lenses; public activation/local ordinary-consumer acceptance are now complete under the later direct-only instruction; no new independent activation approval is claimed. Public registration/local acceptance are closed below, not release approval. Actual SOURCE/DIST SDK correction evidence remains valid. The earlier global REQUESTCHANGES report remains historical, not retroactively upgraded; its failures and raw-access limits remain in the original evidence. Scoped follow-up acceptance is not a new global release-ready verdict, exact-release-commit remote CI or publication authorization. Preserve the213pre-existing staged paths; the index is not the prepared release candidate.

**PUBLIC-MODULE — CLOSED: implementation and bounded local end-to-end acceptance.** An ordinary public-only companion adds a real external plane without editing StateFlow source. Pi remains the loader; StateFlow owns admission, current/history persistence and the same intent-first atomic engine. Registration/lifetime and codec/retention retain their separately scoped prior independent approvals. Mutable model tools, detached captured inputs, Active/Passive context and Active-only asynchronous producers are implemented, with narrow immutable producer admission, original source/content/schema/policy/catalog/native/model/reasoning/selection/cancellation fences and accepted-publication finality. Shared frames receive no Session conversation/prompt.

Final actual SDK consumer properties prove mutable/immutable current-only fork from an older native point, unchanged parent semantic-file bytes, retained descriptors, no inherited historical bodies and child reload. Global/CWD/Session/all-three fixtures at historyLimit0/1/7 cross actual folding, preserve every remaining current/historical opaque value while the companion is uninstalled, refuse incompatible definition callbacks/writes for the retained owner, and resume read/write after cold re-registration. Full1695/1695Node22/24, complete SAME2final compiled SDK properties plus earlier SAME16public and SAME7codec properties (overlapping SOURCE/Node),145pack files and public DAG/context/default/index evidence support this bounded local closure. Evidence/limits: `temp/public-acceptance/checkpoint.md`; previous checkpoints are history, not parallel backlogs.

The later user instruction forbids actors/subagents and requires direct execution; final activation audit was therefore inline rather than the earlier actor-review method. No independent activation approval, real-model quality result, fresh installed-package/live-device trial, background archive deployment, working-store conversion/reload, staging/commit/push/tag or publication is claimed or authorized. No local actionable/preparable PUBLIC-MODULE task remains. Separate release/model-quality gates do not authorize continuing this Grow Loop into unrelated work.

**Ownership and authority:** Review freezes ended only after matching ROOT terminal, complete actual report consumption and coordinator post-terminal hash/index verification. Coordinator owns canonical context/integration; new review findings must be presented before unrequested implementation remediation. No commit, staging, push, PR, tag, publication, live-store migration, unrelated new feature, converter retirement or future1.0 plan is authorized. Existing index remains untouched; preparation metadata is unstaged on top. M0.4b real-model evidence remains a separate gate, not a fabricated functional release blocker.

### M0 — Semantic contracts and baseline evidence

**Status:** Only the deferred real-model comparison remains open; owner settled legacy support through State Flow 0.x with a 1.0.0 cutoff. **Objective:** Complete the named residuals without reopening the implemented M1 dialect or fabricating model-quality evidence. **Dependencies:** M2 functional authority and later bounded live evaluation, as specified below.

Owner clarification: State Flow **0.x** retains legacy `contract`/`working` conversion and retired-root reservations; beginning State Flow **1.0.0** that temporary support/reservation window ends, with explicit unsupported-version refusal retained. No separate **1.1** deadline remains. The prepared package **0.27.0** keeps converter/reservations unchanged; no current removal, release or working-store conversion is authorized. The [support policy](docs/semantic-compatibility-decision.md#implementation-direction-and-reserved-names) owns this completed decision.

The [semantic handoff contract](docs/semantic-handoff-contract.md) and [isolated runner](benchmarks/semantic-memory.mjs) complete M0.1/M0.4a preparation, not product migration or model-quality proof. Completed preparation evidence is recorded in [CHANGELOG.md](CHANGELOG.md#0270-semantic-memory-and-scope-selection); remaining work follows.

| Item | Required work and likely owners | Focused falsification/evidence |
| --- | --- | --- |
| M0.4b — Real-model comparison (deferred until functional implementation) | After deterministic implementation checkpoints, run baseline/target conditions where reproducible, review the semantic rubric, and retain the source-bound report. This explicitly retains M3's real flat-versus-scoped task error/retry/quality/cost evidence and any M4 cognitive-benefit claim; SDK/faux byte counts are not substitutes. The preserved baseline commit and fixed corpus support a later comparison; disclose provider/model drift. This item does not gate M1–M5 implementation. | Unblocker: authorized credential-capable runtime (or explicit normal use of the configured provider), pinned model/reasoning and bounded execution limits. Preflight found the current model in the catalogue but no inherited OpenAI key; it did not establish isolated authenticated readiness or inspect/copy profile credentials. |

**Compatibility work:** Determine what is supported before changing readers; inspect temporary sparse/legacy fixtures, never a live store. **Failure modes:** Vocabulary hides lost constraints; a “flat” prompt leaves scoped schema; migration promises incompatible meanings of exactness; disabled Session still required secretly.

**Boundary:** Implement migration code and validate it only on isolated fixtures; do not convert live stores during development. No large evaluation platform. **Completion evidence:** Semantic contract, implemented decision records and affected-surface proof, followed by deferred model results with exact identities/limits. A poor baseline is a valid observation, not a reason to invent success.

### M1 — Intents / Strategy / Tactics

**Functional checkpoint complete:** M1.1–M1.4 have moved to [completed outcomes](CHANGELOG.md#0270-semantic-memory-and-scope-selection) and the [migration/API proof](docs/semantic-compatibility-decision.md#guarded-publication-and-support-boundary). `npm run validate` passed **892 tests**, typecheck, tracked build, import and package checks; M1 source-bound calibration completed **41 faux calls** with the target schema. These prove transport/preservation mechanics, not model cognition. No live store was converted or release published. Converter/name support timing is settled at the State Flow1.0.0 cutoff, with legacy code retained throughout the current0.x release line. Later checkpoints and decisions below own subsequent status; they are not residual M1 blockers.

### M2 — Configurable scopes

**Functional checkpoint complete:** Configured/captured seven-selection integration, strict public scope commands/completions and mode-only Telegram/control acceptance are closed within the reviewed [functional boundary and explicit legacy proof dependencies](docs/scope-selection-contract.md#m2-functional-acceptance-boundary). Completed evidence belongs there and in [CHANGELOG.md](CHANGELOG.md#0270-semantic-memory-and-scope-selection); no M2 child remains open. Flat single-owner model access is M3 below, not an M2 acquisition/selector rewrite.

### M3 — True single-scope interface

**Deterministic FUNCTIONAL checkpoint complete:** Native tools/canonical translation, protocol/Skills, typed runtime outputs and linked native reload/revision/closure/own-boundary replay are accepted within the [reviewed interface boundary](docs/single-scope-interface-contract.md#deterministic-m3-checkpoint). Completed proof/tradeoffs belong there and in CHANGELOG, not an open child list. Real-model flat-versus-scoped task cost/error/quality acceptance remains explicitly M0.4b above; no live result, smaller-prompt claim or working-store rollout follows. The composition/extensibility decisions below do not replace that separately gated evidence.

### M4 — Composable semantic protocols

**Bounded decision complete:** [Retain existing plain renderers/private snippets; defer further extraction](docs/protocol-composition-decision.md). Actual rule/producer/trust map and alternatives found no earned descriptor layer; the credible tiny owner-meaning helper remains a preventive option, not forbidden. Initial documentation REQUESTCHANGES is retained and R1 independently verified. No production behavior changed and no cognitive comparison was run or claimed; any quality/cost benefit assertion remains M0.4b. M5 demand/alternatives remains separate.

### M5 — Extensibility decision

**Bounded decision complete:** [No NEW semantic-module API now; explicit expansion deferral](docs/semantic-extensibility-decision.md). The actual offline-bundle handoff need and supplied-content native analogue were reviewed against current ordinary JSON/Skills/bindings and four alternatives. No unmet module contract was established within this bounded evidence; external demand remains unknown. A credible mandatory atomic cross-field relation could earn a narrow internal check, then an external seam only for an actual independent consumer; no such case is demonstrated here. TypeScript purity is not a host-JavaScript sandbox. Existing public embedding/Telegram APIs remain, but no manifest/loader/registry/plane/hook or feature commitment is created. Actual integrated review APPROVE; no live-model/offline-workflow success, new API or unrun experiment is implied. Reopen only on separately justified evidence, not as an automatic next task.

### Independent work and integration order

Within M0, baseline evaluation, API/source inventory, and semantic-contract drafting can proceed independently and reconcile at its checkpoint. Within M1, protocol/Skill drafting and codec fixtures can be prepared separately, but ownership/query/public API release depends on the settled dialect. M2 policy parsing and special-case test design can proceed in parallel; lifecycle/publication integration waits for the selected-owner representation. M3 schema probes can run independently of projection formatting once the M2 policy contract exists. Do not parallelize conflicting edits to `lib/extension.ts` or release any cohort that exposes mixed semantic names or mismatched schema/runtime policy.

## 13. Evaluation and Acceptance Strategy

### 13.1 Deterministic correctness is one track

Extend existing same-named domain tests and native scripted-provider witnesses; do not replace their oracles with model judgments. Use the [temporal acceptance map](docs/temporal-acceptance.md) for current preservation properties. Add focused witnesses for renamed replay, migration fences, seven selections, selected-owner history, shared-only completion, excluded provenance, flattened schemas/references, and selection cancellation.

Use temporary stores and isolated native sessions. Capture byte hashes, independent revisions, causal IDs, publication/checkpoint counts, provider inputs, and accepted tool results. Native provider assertions need completion sentinels outside callbacks. Contention tests must prove obsolete work withdraws **while the foreign lock is still held**, before release and replacement acceptance. Invalid mixed patches/reads must preserve all accepted bytes and return no partial success.

For retained runtime code changes, use focused tests while developing each item, then one `npm run validate` per integrated checkpoint, plus context/DAG checks and generated/package parity as applicable. Keep generated distribution output aligned with retained implementation; do not regenerate it for documentation-only edits.

### 13.2 Small model-behavior evaluation is a separate track

**Recommended design:** Start with one linked-task scenario in a temporary fixture repository, four to six user runs, and a few repeated trials per condition. Reuse the Pi SDK/session fixture approach and existing benchmark accounting where practical; avoid building a benchmark platform. The offline-bundle scenario in §5 can supply independently verifiable checks and a controlled contradiction. The [M0.4 trial specification](docs/semantic-memory-evaluation.md) fixes a four-run corpus, common deterministic fixture, initial native/Passive/Active conditions, rubric, and credential-safe execution preflight; it explicitly reports that no live baseline has run.

| Run/checkpoint | Required model behavior | Independent oracle |
| --- | --- | --- |
| Establish outcome and approach | Record accepted phased approach, binding offline requirement, and reason online-only was rejected. Do not promote a proposal silently. | Rubric checks semantic contents against the authorized requirement/accepted decision. |
| Resume after a real Active boundary | Continue the next phase without being reminded of the plan or re-reading all sources. | Inspect next action and actual fixture changes; no completed prior trajectory in automatic Active context. |
| Execute and validate | Retain verified progress and consequential failure, not raw command chatter. | Fixture validator fails on a deliberate network dependency; inspect state and external result separately. |
| Contradict an assumption | Revise the approach for a stated evidence-based reason while retaining the binding requirement and rejection rationale. | New fixture validator passes only for an embedded local index; stale default behavior fails. |
| Complete and close | Preserve successful conclusion, remove intent-owned temporary tactics, and leave durable strategy intact. | Canonical owner reads plus actual output validation; history remains observational. |
| Repeat with flat selected memory | Use flat reads/writes/refs and never address a disabled owner. | Tool traces and excluded-owner byte hashes; record rejected attempts as interface failures, not silent success. |

Compare feasible conditions with identical task evidence, model/version, settings, tool availability, and independent test oracles:

- Native Pi without State Flow, using its natural native conversation/compaction behavior.
- Current baseline State Flow Passive and Active.
- New Intents/Strategy/Tactics Passive and Active with default all scopes.
- New single-scope flat Active (initially Session), plus a selected shared-only condition to expose ownership mistakes.

Do not artificially erase native Pi history just to favor State Flow. Record effective context/compaction differences. Use the same model snapshot and token budget where feasible; randomize condition order or disclose order effects. A small repeated trial is a signal, not statistical proof or a universal model claim. An optional short blinded human review can judge rationale quality when exact-string matching would be misleading.

| Metric | Operational definition |
| --- | --- |
| Verified task success | Fixture output passes independent final validation, not merely an assistant completion claim. |
| Commitment retention | Binding requirements and accepted decisions remain recoverable and guide actual behavior at later boundaries. |
| Stale-decision reuse | Count actions that rely on the specifically invalidated default or contradict retained negative evidence. |
| Plan-continuation correctness | The next action advances the accepted phase/dependency without unnecessary reset; justified revision is not penalized. |
| Rediscovery work | Repeated source reads, repeated validation, and re-derivation of already preserved decisions without changed evidence. |
| Model/tool cost | Requests, tokens, tool calls, retries/rejections, elapsed time, and provider charges when available; distinguish barrier turns from useful work. |
| Patch churn | Duplicate/no-op patches, unnecessary strategy replacement, gratuitous intent/task expansion, and avoidable semantic revisions. |
| Semantic growth | Canonical/projected bytes per plane and owner across runs, including lazy storage separately from automatic context. |
| Prompt-cache behavior | Actual provider cache read/write/token accounting when exposed; otherwise report only existing serialized byte-prefix proxies. |

Record source/dependency identities, condition, model/provider, prompt/protocol/schema digest, selection/mode, retention, trial count, failures, and oracle results in one compact report. No raw private reasoning is needed. Following the owner's implementation-first direction, preserve the M0 corpus/baseline source now and perform the M1 semantic-continuity, M3 interface-use and M4 protocol-composition model comparisons after functional implementation. A neutral result should preserve the safety work but block unsupported quality claims and unnecessary abstraction. Existing performance benchmarks remain opt-in, source-bound, and separate from these quality trials.

## 14. Remaining Architectural Gates

M0's sole remaining gate is [M0.4b in the ordered backlog](#12-ordered-implementation-backlog): flat-versus-scoped task error/retry/quality/cost acceptance and any cognitive-benefit claim require explicit route/model/reasoning/budget authorization. D2/R1 support timing is settled: legacy support/reservations through State Flow0.x, cutoff1.0.0; no current compatibility removal. The newly authorized intent-first follow-up above is a separate implementation cohort. Deterministic SDK/data/byte evidence does not discharge live evaluation. No blanket approval stop is imposed on a future separately authorized useful slice.

Former D3–D6 selection capture, excluded evidence/private authority, Session-only response suppression and deferred private fork choices are accepted within the [M2 functional boundary and explicit legacy proof limits](docs/scope-selection-contract.md#m2-functional-acceptance-boundary), not residual native implementation tasks. D7's schema/normalization/history/native gate mechanics are accepted in the [M3 deterministic checkpoint](docs/single-scope-interface-contract.md#deterministic-m3-checkpoint); its real-model portion remains M0.4b. D8/D9 are the accepted [M4 retain/defer](docs/protocol-composition-decision.md) and [M5 no-new-API/explicit expansion-deferral](docs/semantic-extensibility-decision.md) decisions, not dormant mandatory refactors.

**Deferred exploration, not tasks:** Additional scope providers, a fourth scope, cognitive planes such as `hypotheses`, optional-plane controls and external modules remain unapproved capabilities. Reaching a decision milestone or describing a falsifier does not authorize implementation or create a backlog promise. The original baseline in §2 remains historical evidence, not current TODOs.

## 15. Explicit Non-Goals

- No mandatory planner engine, planning daemon, autonomous background agent, scheduler, or automatic replanning service.
- No replacement for Pi's tool loop, native trajectory, continuation ownership, compaction, session tree, or inspectable trace.
- No competing conversation transcript, chain-of-thought store, action ledger, or proof of external effects from memory alone.
- No arbitrary new memory scopes, generic scope-provider framework, or permanent allocation of planes to owner names.
- No assumption that higher overlay precedence implies higher authority, truth, importance, or user permission.
- No automatic semantic moves between scopes, hidden private Session safety net, or relocation of artifact/Skill ownership to an enabled scope.
- No mandatory task/plan schema, workflow execution DAG, generalized event bus, hidden cross-plane reaction network, or automatic strategic revision.
- No mandatory external plugin ecosystem, dynamic package loader, arbitrary module execution or new planes merely because the extensibility decision milestone is reached; expansion needs separately justified unmet demand and approval.
- No violation of sparse recursive JSON patches, no stored semantic nulls, no weakened atomic acceptance/CAS, retained-history/replay guarantees, or current-memory recovery fences.
- No history rewind on native step selection, automatic resurrection of deleted memory, eager reference hydration, store-wide repair scan, or unsolicited curation.
- No untrusted state, source compilation, or lazy content promoted into system instructions.
- No loss of same-scope intent-owned temporary memory, surviving-intent protection, or explicit accepted cascade history.
- No duplication of reusable Pi Skills inside a competing procedural system; strategy remains situational accepted memory.
- No unmeasured claim that renamed planes, larger prompts, flatter interfaces, or modules improve agent quality or provider cache performance.
- No migration that silently discards memory, treats retired names as unknown, invents historical identity, overwrites shared writers, or leaves permanent dual model-facing semantics without demonstrated need.
- No new crash-atomicity/power-loss guarantee, recovery journal, semantic Git authority, durable publication queue, or background worker justified by this roadmap.
- No implicit release/publication, live-store migration or repository-history rewrite. Local source/test/docs changes and regenerated distribution are authorized for implementation; preserve unrelated existing edits. Return the evidence required above and do not turn implementation permission into permission to operate on active user data.
