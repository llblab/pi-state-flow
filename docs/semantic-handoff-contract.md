# Semantic handoff contract

## Status and authority

**Current semantic contract, shipped in 0.27.0; no live-model quality claim.** Runtime fields, tools, ownership and callbacks use `intents`, `strategy`, and `tactics`. Declared legacy `contract`/`working` data translates under the [migration contract](semantic-compatibility-decision.md). Scope selection and flat tools are delivered under their [scope](scope-selection-contract.md) and [model-interface](single-scope-interface-contract.md) contracts; internal/public modules have their own indexed boundaries. [BACKLOG.md](../BACKLOG.md) owns only outstanding work. The original M0 preservation evidence below remains bound to its old-name baseline.

This contract defines the semantic handoff responsibilities. It distinguishes model responsibilities from deterministic acceptance. It does not claim that any unconstrained model already follows these rules, or that new names improve task performance.

Historical M0 baseline for the source-bound evidence below: package 0.26.5, source commit `4494fee9da8258cdf5f02c42672a0eb9866a512a`, repository-local matching Pi SDK 1.0.0. No source or test changes were needed for this slice.

## Purpose and reconstruction boundary

An Active run can finish while the wider intentional activity remains unfinished. The next user run normally receives compiled semantic state rather than the completed reasoning trajectory. Native bootstrap and conservative context-retention exceptions remain governed by the [architecture](architecture.md#pi-lifecycle), not this design artifact.

The handoff must allow a fresh executor to recover:

1. The chosen outcome and its continuing applicability.
2. Binding requirements and the source and limits of accepted commitments.
3. The accepted approach, phases, prerequisites, important rationale, and rejected alternatives.
4. Verified progress, negative evidence, obstacles, and decision-relevant uncertainty.
5. The next useful action and evidence that would justify revising the approach.
6. Consequences that must survive completion, abandonment, or supersession of the current intent.

A plan is memory of an actionable reasoning outcome, not a transcript of reasoning. Continuing a valid accepted approach should not require rediscovering why it was chosen. Nevertheless, memory is fallible evidence, not proof that external conditions or tool effects are unchanged.

A Pi Skill supplies reusable procedural competence. Strategy preserves a particular accepted application of competence to a situation. Tactics preserves the actual circumstances of executing it. No competing Skill system, planner engine, workflow scheduler, or second execution loop is implied.

## Semantic responsibilities

### Intents: chosen outcomes

**Agreed direction:** An intent expresses an outcome the agent has chosen or committed to achieve, not every anticipated tool call. It may be a small string or task-appropriate JSON. There is no required task-manager schema, identifier format, timestamp, status enum, phase graph, or success predicate enforced by runtime.

- Keep active chosen commitments explicit when they are needed for continuation.
- Do not record a possibility as an adopted intent merely because it was discussed.
- Remove fulfilled, abandoned, superseded, or impossible intents when their consequences have been reconciled.
- Do not infer completion from intent deletion: the runtime cannot verify that the outcome occurred.
- Permit multiple intents to share temporary memory, and permit unowned tactical content.

### Strategy: accepted approaches and governing commitments

**Agreed direction:** Strategy holds how the agent has decided to achieve an outcome, including binding constraints, accepted plans and phases, important assumptions, dependencies, architectural decisions, rejected approaches and reasons, and reconsideration conditions. It is not limited to speculative planning.

A useful strategy lets a fresh executor distinguish three semantic facts without imposing a record schema:

- **Requirement:** What remains binding, and under whose applicable instruction or accepted contract.
- **Accepted approach:** What the agent has committed to use while it remains valid, with consequential reasons.
- **Proposal/assumption:** What is not yet accepted or not yet verified, including what would change that status.

A JSON field named `acceptance` is an illustrative representation, not proof of user approval. Acceptance is grounded in the actual task instructions and decisions; do not invent a user approval event or treat assistant conclusions as higher-authority requirements. Existing binding `contract` data must not become optional simply because its plane is renamed.

Continue an accepted approach while it remains applicable. A concrete contradiction, changed requirement, invalidated prerequisite, or evidenced failure can justify revision. Preserve still-binding constraints and consequential negative evidence when changing methods. One faulty implementation does not by itself disprove an entire approach.

### Tactics: operational memory

**Agreed direction:** Tactics holds what is actually happening: verified progress and tool outcomes, failures, obstacles, relevant uncertainty, immediate operational choices, and exact next work. It is neither a commands-only plan nor append-only tool chatter.

- Record observations separately from predictions and assumptions when the distinction affects action.
- Retain sufficient evidence to explain a strategic revision without copying raw tool output.
- Distinguish “not yet checked,” “check failed,” and “check passed”; absence of a failure entry is not success.
- Revalidate consequential volatile effects before repeating actions after interruption or restoration.
- Remove superseded temporary progress from touched branches while preserving material corrections and rejection reasons.

The runtime does not judge whether a claimed observation is true or important. Deterministic JSON acceptance and model evidence quality are different proof obligations.

## Model reconciliation contract

**Agreed direction:** Intents give direction; strategy guides execution; tactics supplies operational evidence. These relationships are enacted by reasoning over shared state through Pi's ordinary tools.

A useful handoff is not a prescribed patch sequence. The model may plan, inspect, act, and revise in any task-appropriate order, provided future-relevant memory is accepted before relying on Active state-only continuation. If the required memory is already correct, completion needs no patch.

For a consequential strategic revision, preserve enough information to answer:

1. Which observation or changed instruction invalidated the former assumption/approach?
2. Which requirement remains binding?
3. What revised approach is now accepted, why, and what remains uncertain?
4. What next operational work follows from the revision?

Do not install an automatic rule that tactical failure rewrites strategy. The model must decide whether the failure is strategic, implementation-specific, transient, or still inconclusive. Do not silently replace a binding user requirement to make a failing validation appear successful.

## Temporary-memory lifetime contract

**Current lifetime rule:** Structured intent references own eligible same-scope `strategy`, `tactics` and `lazy` object keys. Apply intents, clear targets not protected by final remaining/new intents, then apply other authored planes; this intentional change supersedes the former strategy-ineligible/authored-first policy. Retained history replays explicit net patches, not a recomputed cascade.

1. Apply only authored intents and their supplied-scope empty-object normalization, independent of JSON insertion order.
2. Identify intent keys present before staging but absent afterward. This includes an intent removed by pruning its last child, not just an explicit top-level `null`.
3. Extract structured `$ref` targets anywhere in each removed intent value.
4. Consider only existing object-key targets under same-scope strategy, tactics or lazy content, using the supported ASCII path grammar.
5. Retain any target referenced by a final remaining or newly added same-scope intent, including a reference to an ancestor or descendant.
6. Clear the remaining minimal targets, then apply remaining authored planes before existing compilation/normalization and atomic publication. Same-path rewrites create fresh knowledge without old fields.
7. Store the actual net result as explicit accepted patches; retained replay never reruns cascade. Existing strategy refs own future accepted intent deletions only, without rewriting old history. `cascaded` lists intermediate cleared paths even if recreated; final effective values govern.

This does not confer dependency, hydration, existence, execution, completion, or instruction authority on references.

### Boundaries that must survive

- A textual `$path` mention is non-owning. Structured references outside intents are also non-owning.
- Cross-scope, effective, historical, plane-root, array-element, missing, and non-strategy/non-tactics/non-lazy targets are silently ineligible for cascading. They must not reject, warn about, or delay an ordinary patch.
- Editing an intent to drop a reference leaves its former target unowned; it is not intent deletion.
- One-patch supersession can delete the old intent while a replacement protects the same target.
- Writing to a cleared target in the closing patch recreates it after cleanup, without retaining old fields.
- A cascade is scope-local. Deleting a local tactical value can reveal an inherited value at the same effective path.
- Strategy cascades too. Preserve durable results, accepted decisions, rejection reasons and still-relevant plans by explicitly rewriting them at the same or a new appropriate path in the closing patch.
- Lazy content can itself be temporary; no semantic plane is an automatic safe haven from ownership cleanup.
- Consequential survivors can be saved at an unowned appropriate path in the same atomic patch. This is model-authored reconciliation, not runtime promotion, archiving, or movement between scopes.

Canonical stored ownership references remain explicitly scoped. With exactly one wanted owner, the implemented [model boundary](single-scope-interface-contract.md) anchors eligible relative structured references to that captured owner before ownership/cascade processing, and projects them relatively on output. This translation grants no acquisition or publication authority.

## Patch, mode, and trust constraints

This contract inherits [model-tool semantics](architecture.md#model-tools); it does not define a second patch language.

- Planes remain optional object roots; their domain content remains ordinary JSON.
- Object patches merge, arrays/scalars replace, omitted nonempty fields persist, and object-key `null` deletes. Accepted supplied scopes prune empty object branches; array slots and empty arrays survive.
- No materialized semantic nulls, model-authored response/config/provenance, or empty acknowledgement-only scope patches.
- One atomic cohort produces explicit accepted changes. No-op repeats produce no new semantic transition. An Active patch remains an inference barrier; Passive does not gain a new barrier by implication.
- Active preserves necessary handoff memory before completed prior trajectory leaves normal projection. Passive can use the same semantic distinctions on demand without mandatory consolidation or a State Flow iteration reset. Off exposes no State Flow model context or tools.
- Global, CWD, and Session can all carry the three core semantic functions. Later overlay precedence is composition, never evidence of greater truth or instruction authority. The [scope contract](scope-selection-contract.md) owns configurable participation, independently of these semantic meanings.
- References and state values are data. Package-reviewed trusted protocol may explain the planes, but ordinary memory, artifact compilations, or lazy values cannot alter system instructions.
- Runtime publication, source provenance, response capture, native lifecycle ownership, and frozen-head reconciliation retain their established independent owners. The semantic relationship is not a module callback or hidden event network.

## Acceptance map

The IDs below name contracts/oracles, not new runtime record types. The table retains the original M0 evidence plan: its milestone/future references describe that checkpoint, not pending implementation. Current deterministic renamed/native witnesses are recorded in the [migration](semantic-compatibility-decision.md#source-bound-m1-validation), [scope](scope-selection-contract.md#m2-functional-acceptance-boundary) and [model-interface](single-scope-interface-contract.md#deterministic-m3-checkpoint) contracts. Live-model semantic acceptance remains unrun.

| ID | Obligation and falsification scenario | Evidence owner |
| --- | --- | --- |
| SH-1 | Resume an accepted phased approach after an Active boundary without losing the binding requirement, rejected alternative, prerequisite, or next action. Fails if the model rediscovers or replaces a still-valid approach without grounds. | Current protocol/Skills provide stewardship guidance; M0.4 behavioral baseline and M1 native/model comparison prove use. |
| SH-2 | Preserve proposal versus acceptance and requirement versus observation distinctions. Fails if storage location alone upgrades a hypothesis into a commitment or weakens an existing requirement. | Model rubric over authorized task evidence; runtime shape tests cannot establish acceptance or authority. |
| SH-3 | Retain failed-check evidence while revising an invalidated assumption. Fails if a partial strategy patch loses the original requirement, prior rejection, or unaffected phase dependency. | Five-example mapped replay below; future M1 model continuation evaluation. |
| SH-4 | Close an intent while explicitly rewriting durable consequences; clear owned strategy/tactics/lazy targets before remaining authored writes. Fails if old fields survive a cleared-target rewrite or another remaining/new intent loses its protected target. | `tests/ownership.test.ts`, `tests/transition.test.ts`, mapped example 5; future M1 native cascade receipt. |
| SH-5 | Preserve same-scope shared/related-target protection, supersession, and edit-only behavior. Fails if another surviving intent loses its referenced target, text gains ownership, or cross-scope memory cascades. | `tests/ownership.test.ts` and `tests/transition.test.ts`; future M1 renamed references. |
| SH-6 | Preserve sparse state, no-stored-null rules, detachment, explicit accepted cascade deletions, and exact retained replay. Fails if staging changes inputs, creates stored empty defaults, or replay needs to derive ownership again. | `tests/state.test.ts`, `tests/transition.test.ts`, `tests/temporal.test.ts`; future M1 codec/migration oracle. |
| SH-7 | Preserve the frozen-prefix, trust, scope, response, and provenance boundaries while using the new semantic guidance. Fails if a memory patch changes system rules, relocates source ownership, or introduces a finalization inference. | Current `tests/protocol.test.ts`, `tests/context.test.ts`, response/Skill/native test families; M1–M4 integration checkpoints. |

### Offline-bundle patch corpus

The following are **M1 model-patch examples**, using the implemented target dialect and explicit Session ownership with the default three-owner selection. A sole-owner selection instead uses the flat interface described in the [model-interface contract](single-scope-interface-contract.md). Field names inside planes are illustrative domain data, not a required schema. The scenario is a release bundle that must remain usable offline; no external release is executed by these examples.

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

### Five-example review exercise and answer key

The five JSON patches in the [offline-bundle corpus above](#offline-bundle-patch-corpus), relocated from the published v0.27.1 backlog, form one sequential example, not five unrelated snapshots. A reviewer should be able to reconstruct the following without the original design conversation:

1. **Open outcome:** Prepare an offline-verifiable release bundle. The intent owns `session.tactics.release` through a structured reference. No claim of final validation success exists.
2. **Accepted strategy:** Offline verification without credentials remains the user's binding requirement. Preparation precedes network-isolated validation. Bundled verifier v1 is the accepted approach; its self-containment is an assumption. Online-only verification was rejected because it cannot satisfy the requirement.
3. **Contradictory observation:** Isolated validation failed because the verifier attempted to fetch a trust index. Whether an embedded index suffices is unresolved; inspecting the offline-index interface is the next useful action. Do not close the intent.
4. **Reasoned revision:** Source inspection supports the local-index option. Accept an embedded trust index, preserve the offline requirement, original online-only rejection and validation dependency, and retain why default v1 was rejected. Delete only the resolved uncertainty. Previous failed validation remains recorded; a revised approach is not a passed revalidation.
5. **Closure after verification:** The example's precondition supplies successful coverage and isolation checks. Preserve that conclusion in strategy, remove the release intent, and cascade its tactical context. The remaining strategy retains the requirement, revised decision, phases, and both rejection reasons in Session. Nothing moves to Global/CWD and no answer is model-patched.

The fifth precondition is a semantic claim supplied by the scenario. A deterministic patch probe cannot establish that those external checks actually ran. M0.4 must use independently verifiable task evidence before rewarding a model for making that claim.

## Source-bound validation evidence

M0.1 checked the example against existing mechanisms without implementing the rename:

- Extracted the five JSON patches from the then-current backlog section (the corpus is now retained above).
- Mapped only the scope-root plane names `strategy → contract`, `tactics → working`, and corresponding scoped structured-reference plane segments. Did not rewrite arbitrary prose/domain keys, change source files, or persist a converter.
- Staged and committed each mapped patch entirely in memory with `stageAtomicScopePatches` / `commitScopedTransition`, no acquired sources and no run finalization; replayed the actual accepted records with `advanceTemporalState`.
- Asserted staging detachment, unchanged Global/CWD, binding-requirement retention, both rejection reasons, surviving phase dependency, retained failed-check evidence after revision, deletion of only resolved uncertainty, and absence of authored response.
- Asserted one closing cascade, disappearance of empty intent/tactical planes, retained strategic conclusion, and an explicit accepted tactical deletion. Re-read all six materializations: the origin and each of five accepted boundaries.
- Result: five material transitions, Session revisions 1–5, Global/CWD revisions 0, one cascade only at closure, and all six retained materializations equal their captured snapshots. No live canonical store was read or written by this probe.

Historical focused-source command (not validation of the current cascade contract):

```bash
node --experimental-strip-types --test tests/state.test.ts tests/ownership.test.ts tests/transition.test.ts tests/temporal.test.ts tests/protocol.test.ts
```

Result for the source identity above: **76 passed, 0 failed**. These tests covered the then-current old-name semantics; that historical result neither certified the later rename nor substitutes for M0.4 real-model baseline evidence. The in-memory example probe did not exercise disk CAS, migration, provider schemas, new selection policy, or flat-reference conversion.

## Historical handoff and current limits

The original M0.1 handoff required M0.2 compatibility decisions and M0.3 selection/private/response/fork decisions before their dependent implementation. Those obligations were subsequently met under the linked migration and scope contracts; flat paths and internal/public modules also shipped in 0.27.0. They are not unresolved prerequisites.

Real-model evaluation remains separate and unrun; the [evaluation contract](semantic-memory-evaluation.md) owns its corpus, rubric and execution gate, while [BACKLOG.md](../BACKLOG.md) owns remaining action. Dynamic loading, background scheduling and new cognitive planes were not delivered by these milestones.

The superseded development roadmap is preserved at [the published v0.27.1 source](https://github.com/llblab/pi-state-flow/blob/f9128d9eaa2b94133d992f51f80f16aec0d43653/BACKLOG.md). Its baseline observations, execution instructions and review statuses are historical evidence, not current normative policy. The corpus above and the indexed owning contracts retain the useful semantic rationale and acceptance counterexamples without keeping completed queues active.
