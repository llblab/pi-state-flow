# Internal semantic modules

## Status and boundary

The internal implementation has supported-Node validation and bounded independent acceptance. The contract and executors are implemented in `lib/semantic-module.ts`; the existing six planes use static bindings in `lib/planes.ts`. This delivered boundary is package-owned composition, not a public plugin ABI, discovery mechanism or external loader. No new native option, stored root, storage version, `immutable/content` disk envelope or tool grammar was introduced by this cohort. The earlier [M4](protocol-composition-decision.md) and [M5](semantic-extensibility-decision.md) retain/defer decisions describe their original evidence. The user's subsequent public-registration request is separate open work in [BACKLOG](../BACKLOG.md#12-ordered-implementation-backlog), not functionality supplied by this internal contract.

A module participates in context construction. Its identity is not permission to acquire memory, register a stored plane or publish state. The generic contract is not restricted to the six existing names; the current storage/tool binding deliberately is. [BACKLOG](../BACKLOG.md#12-ordered-implementation-backlog) alone owns unfinished public-registration work.

## The five-member contract

```ts
interface SemanticModule<Content extends JsonValue, Input = undefined> {
  readonly immutable: boolean;
  readonly id: string;
  validate(value: unknown): value is Content;
  context(content: Content | undefined, frame: ModuleFrame<Input>):
    readonly ModuleContextContribution[];
  produce?(content: Content | undefined, input: Input, signal: AbortSignal):
    Content | undefined | Promise<Content | undefined>;
}
```

- **`immutable`:** The main agent cannot author that bound plane through `patch_state`. An independently authorized runtime/producer may still propose replacements. This is not frozen historical content or a flag that a model can toggle in its payload. Current bindings freeze the declaration; ordinary domain keys named `immutable` or `content` do not become policy.
- **`id`:** Stable identity for static host binding and diagnostics. It neither reserves a root nor grants native/source/private authority.
- **`validate`:** Admit present module content and producer candidates. Absence stays absent; no defaults are invented. Observation and canonical acceptance are distinct: artifact projection admits retained legacy bookkeeping as an ordinary object, while canonical artifact validation remains in the existing artifact/state/transition owners.
- **`context`:** Synchronous, mode-aware computation from captured data. An empty array contributes nothing. It may return multiple data/conversation contributions; it does not run a publisher or edit native history.
- **`produce`:** Optional synchronous or asynchronous computation proposing complete content. `undefined` means no proposal, not deletion or successful publication. Immutable-to-main-agent modules can have producers. No producer is manufactured for ordinary manually authored planes.

The source types are authoritative. The interface deliberately has no lifecycle-hook catalogue, dependency registry, instruction callback, transaction handle or general host `ctx`.

## Captured input and context contributions

`ModuleFrame<Input>` supplies `mode: "active" | "passive"`, an admitted conversation snapshot and module-specific `input`. Off is rejected by the context executor; normal host Off gates do not invoke modules. Inputs and content are detached before callbacks. Functions/services belong in a reviewed constructor closure, not the input DTO; for example a future archive factory can receive one bounded inference function without a service registry.

```ts
type ModuleContextContribution =
  | { kind: "data"; value: JsonValue }
  | { kind: "conversation"; indices: readonly number[] };
```

`evaluateModuleContext` validates closed contribution shapes and finite dense JSON. Conversation indices must be safe integers, in range, unique and increasing across the complete plan. They select captured user/assistant/tool-result messages, not system/tool-declaration protocol frames. The callback sees a detached snapshot; materialized selections refer to the host's exact original message objects, retaining roles, native IDs and content rather than converting a tool trace to prose.

`context.ts::semanticModuleMessages` is the transport adapter: data becomes a synthetic **user-level data** message; selected conversation messages remain original objects. Neither callback output nor its text becomes system instructions. Trusted package protocol stays under the existing protocol producer and owned-section membrane.

Selection is not authority to replace arbitrary context. The host still owns admitted source ranges, complete tool-call/result units, current-run/foreign-context preservation, duplicate avoidance, placement, compaction, anchors and request finality. The executor does not certify that an arbitrary valid index sequence forms a provider-valid standalone conversation. It does not remove an existing trajectory or install a new native hook.

## Detached producer evaluation

`produceModuleContent(module, content, input, signal, checkCurrent)` captures inputs, awaits the producer and admits a detached candidate. The host's original-currency assertion and cancellation run before work and after completion/validation. `checkCurrent` is a throwing revalidator (`() => void`), not a boolean predicate; the host must throw when its original basis is obsolete. Cancellation returns without waiting for a producer that ignores its signal; late completion cannot escape as an accepted result. Returned data cannot alias the original input, producer result or the validator's retained argument. This is data isolation, not a JavaScript effects sandbox.

The function never installs state, increments revisions, grants a scope or calls a publisher. A future host adapter must bind its captured conversation/content/model/owner/selection basis to the existing synchronous acceptance check. Starting a fresh transaction and borrowing its current token does not make an old candidate current. Reject/recompute policy must be explicit.

Inference, source acquisition and asynchronous production stay outside canonical exclusion. Constructor-injected inference is enough for the contract; no model client, credentials, agent loop, scheduler or actual background inference is added here. A readonly signature cannot prevent ambient JavaScript effects in trusted package code.

## Actual six-plane integration

| Binding | Main-agent immutable | Ordinary context |
| --- | --- | --- |
| `intents` | false | Present semantic object |
| `strategy` | false | Present semantic object |
| `tactics` | false | Present semantic object |
| `artifacts` | false | Existing semantic projector and captured runtime hints |
| `response` | true | Present nonempty answer in Active; omitted in Passive |
| `lazy` | false | Existing complete structural navigation, never its body |

State validation uses the module validators while retaining canonical artifact checks. Model normalization and transition admission derive their writable-name list from the immutable policy, preserving the closed grammar and response refusal before payload interpretation. No arbitrary module ID becomes a writable plane.

`state.ts` hot/model projection and `context.ts` initial views, accepted receipts and later notices use the executable bindings. Sparse absence, empty-response omission, exact read/history distinctions, artifact hints and Passive response exclusion remain unchanged. Lazy projection captures only its bounded structural metadata, not a cloned hidden body. The existing exported lazy-navigation function delegates to its lower plane owner.

The shared transition engine still applies intents, protected cleanup and remaining authored fields in fixed order, then compilation/normalization/validation and one atomic publication. Modules do not become six patch callbacks. Source/Skill provenance, independent revisions, callback-scoped publication, accepted-memory cache installation and accepted-publication finality retain their existing owners. Runtime response capture remains its real authorized writer; it is not artificially routed through an asynchronous producer.

The local dependency direction is `state/context/model-interface/transition -> planes -> semantic-module/artifact -> JSON/platform`. Neither new owner imports state, runtime, storage, extension or the context projector. Each new owner has its same-named test mirror.

## Expressiveness versus implemented features

The contract witnesses exercise a stateless exact recent-window module and an immutable archive producer with constructor-injected fake inference. They prove mode-aware contribution transport, preserved source identities, asynchronous candidate isolation, cancellation and obsolete-completion rejection. They are not dummy production planes and are not described as a working archive.

Not implemented by this boundary: new stored planes/codecs, archive node retention/version history, a selected-model inference adapter, background jobs, automatic raw-context replacement, public loading/registration or a stored envelope migration. Those require their actual storage/lifecycle/authority decisions rather than adding unused hooks now. A future module can use the contract without acquiring those permissions by identity alone.

## Verification

`tests/semantic-module.test.ts` owns contract/input/contribution/producer properties; `tests/planes.test.ts` owns real bindings, immutability and navigation/projection. `tests/context.test.ts` owns user-data transport and exact native-message/tool-identity materialization. Existing state/context/model-interface/transition and native SDK tests retain the prior semantic, publication and lifecycle witnesses.

A finite before/after certificate captures all seven selections' Active/bootstrap/Passive protocols, representative sparse/hot/model/context values and intent-cascade output. Equality is useful default-output evidence, not exhaustive AST/runtime equivalence or model-quality proof. Full supported-Node validation, generated-build parity, package inventory, DAG/context checks and independent post-implementation review are separate acceptance evidence; current results belong in canonical remaining work until actually complete.
