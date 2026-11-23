# Semantic Layers

State Flow memory carries forward what the next run needs to decide and act. It is not a transcript or an action ledger. Its semantic layers (called *planes* in the runtime and API) differ by purpose, not by priority. Global → CWD → Session precedence applies to scopes, independently of the layer.

This page owns the handoff model and the package-owned module contract. See [model tools](architecture.md#model-tools) for exact read and patch behavior, [scope selection](scope-selection-contract.md) for ownership and participation, and [format admission](compatibility.md#canonical-scope-format-admission) for stored versions and retired formats.

## Handoff

An Active run may end before its wider task does. When the next run starts from memory, a fresh executor should recover the chosen outcome, binding requirements and their source, the accepted approach and why it was chosen, material evidence for or against it, the next useful action, and consequences that must survive completion or abandonment. The [Pi lifecycle](architecture.md#pi-lifecycle) owns bootstrap and context-retention exceptions.

- `intents`: Chosen outcomes or commitments that still apply, not every tool call or discussed possibility.
- `strategy`: Binding requirements, accepted approaches and phases, prerequisites, assumptions, rationale, rejected alternatives, and conditions for reconsideration.
- `tactics`: Verified progress, failed checks, obstacles, relevant uncertainty, and the exact next useful work.
- `artifacts`: [Source-addressed routing and compiled knowledge](architecture.md#artifact-routing), not an assertion that a source was acquired.
- `response`: The runtime-owned latest accepted answer in Active Session; never author it in a memory patch.
- `lazy`: Detail to retrieve explicitly, including temporary material when appropriate; not part of the ordinary baseline context.

Requirements, accepted approaches, and unverified proposals are different facts; neither a field name nor the owner of a scope grants them authority. A Pi Skill describes reusable procedure. Strategy records a particular accepted application; tactics records the circumstances of execution. None requires a fixed task-record schema, schedule, or automatic promotion between scopes.

- Revise an approach when a changed requirement, contradiction, or failed prerequisite warrants it. Preserve obligations that still bind, the negative evidence that motivated the change, and what must be checked next. One faulty implementation is not necessarily a failed strategy.
- Distinguish unchecked, failed, and passed. Stored observations are fallible evidence, not a proof of external effects: revalidate consequential volatile effects before repeating an action.
- Remove fulfilled, abandoned, superseded, or impossible intents after reconciling their consequences. Deletion is not proof of completion. An intent can own temporary material in `strategy`, `tactics`, and `lazy`; preserve durable consequences explicitly in the closing patch. The exact protection, cleanup, and rewrite order belongs to [intent ownership](lazy-state.md#intent-ownership).
- No ceremony is needed if the memory is already right. Passive may use the same handoff model without Active's context replacement; Off exposes neither memory tools nor model memory. Deterministic acceptance checks shape and ownership, not whether the reasoning or factual claims are correct.

### Offline-bundle patch corpus

Five patches form one example, using explicit Session ownership with the default three-owner selection. With only Session selected, omit the `session` wrapper. Nested field names are illustrative, not a schema. No external release is performed by these examples.

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

**2. Preserve the accepted strategy, including the binding requirement and a rejected alternative.**

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

**3. Record the validation failure and the next check, not a transcript.**

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

**4. Revise the method when inspection supports the alternative.** The failed check invalidates the assumption, not the offline requirement. The patch retains the original rejection, phase dependency, and failed-check evidence; revising the method is not proof it works.

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

**5. Close the intent only after both checks pass.** The example assumes independently observed success. The intent owns `session.tactics.release`, not `session.strategy.release`, so closure clears the tactics and merges the strategic conclusion. If the intent also owned the strategy entry, the closing patch would have to rewrite every consequence that must survive. Nothing moves to Global/CWD and no answer is model-patched.

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

## Internal semantic modules

`lib/semantic-module.ts` owns detached evaluation; `lib/planes.ts` binds the six built-in planes. The internal module contract is package-owned, not a loader or grant to register roots, acquire state, replace native context, or publish. The [public module contract](public-module-contract.md) separately owns host registration, external roots and retention, using the same evaluators and acceptance engine.

- `id`: Stable binding and diagnostic identity, not a root reservation or an authority grant.
- `immutable`: The main agent cannot author that plane. An independently authorized writer can still propose content; it is not a storage flag or a historical freeze.
- `validate`: Admits present content and producer candidates. Absence stays absent; canonical artifact admission remains with the artifact/state/transition owners.
- `context`: Synchronous mode-aware contributions from detached input; an empty list contributes nothing.
- `produce?`: Optional synchronous or asynchronous complete-content proposal. `undefined` means no proposal, not deletion or acceptance.

### Context and production

- `evaluateModuleContext` accepts an Active/Passive frame with admitted conversation and module-specific input. It validates closed contribution shapes and finite dense JSON. Conversation indices are safe, in-range, unique and increasing across the plan; they select only admitted user/assistant/tool-result messages, not system or tool-declaration frames. Off does not invoke the evaluator in the normal host path.
- `context.ts::semanticModuleMessages` presents data as user-level data and uses the exact original native objects for conversation selections. The host still owns complete tool-call/result units, foreign and current-run context, placement, deduplication, anchors, compaction and request finality. Valid indices alone do not make a provider-valid standalone conversation.
- `produceModuleContent` detaches inputs and the admitted result, including from any validator-retained argument. The host's original-currency check throws on a stale basis and is checked alongside cancellation before work and after completion/validation. Cancellation does not wait for a producer that ignores its signal; late proposals are not accepted. A fresh transaction token cannot make an old proposal current.
- Source acquisition, inference and asynchronous production stay outside canonical exclusion. Constructor-injected capabilities belong in trusted code, not in the input data. Neither a readonly signature nor detachment is a JavaScript sandbox. These evaluators do not supply discovery, background inference, production archives, or scheduling.

### Built-in bindings and verification

State validation and writable-name selection use the static declarations; only `response` is immutable to the main agent. `intents`, `strategy`, and `tactics` contribute present objects, `artifacts` uses its routing projector and runtime hints, `response` contributes only a nonempty Active answer, and `lazy` contributes bounded structural navigation, not bodies. Exact explicit reads and provenance keep their existing owners. The runtime still captures answers directly, without an artificial producer step. The single [patch engine](architecture.md#model-tools) owns ordered staging and atomic acceptance; each plane is not a separate patch callback.

`tests/semantic-module.test.ts` covers detachment, contributions, cancellation and stale proposals; `tests/planes.test.ts` covers the actual bindings; `tests/context.test.ts` covers the user-data and native-message transport. Synthetic recent-window and archive fixtures demonstrate evaluator behavior, not enabled production features. See [historical semantic evidence](README.md#historical-semantic-evidence) for the original source-bound reports.

## Evaluating the handoff

The [opt-in trial](../benchmarks/semantic-memory-trial.md) compares Native Pi, Passive and Active on the same four linked turns: accept a plan, continue it, examine contradictory evidence, and verify the result before closing the commitment. Fixture receipts establish task success independently of the model's claims; a separate rubric reviews retention, revision and continuation. The five worked patches above illustrate the contract, not what a model has been observed to do.

Deterministic tests and scripted calibration verify mechanics, not model quality, latency, token cost or cache effects. No live comparison has run. The [backlog](../BACKLOG.md#external-validation-and-evaluation) owns the authorization gate and remaining live evaluation.
