# State Flow documentation

Start with the [project README](../README.md) for installation and the memory model.

## Operating State Flow

- [Usage and recovery](usage.md): Configure State Flow, choose Active/Passive/Off, inspect memory and recover from storage problems. Includes diagnostics and privacy rules.
- [Lazy state](lazy-state.md): Store ordinary JSON in `lazy` outside baseline context, read it progressively with structural `meta` + `keys`, patch array indices and understand intent ownership.
- [Filesystem recovery](filesystem-recovery.md): What to do when files are missing, incomplete or malformed; which evidence authorizes repair and what durability is promised.
- [Physical fork contract](fork-contract.md): What a child session copies, what stays live, how cancellation works and which forks are supported.

## Integration and verification

- [Architecture](architecture.md): Semantic state, temporal history, Pi lifecycle, storage transactions, artifact acquisition and embedding APIs.
- [SDK compatibility](compatibility.md): Required packages, verified environments, host lifecycle requirements and isolated validation procedures.
- [Session performance](performance.md): Run synthetic benchmarks, interpret their metrics and understand the current cost model. No provider-cache or latency guarantees.
- [Temporal acceptance](temporal-acceptance.md): Find the tests that witness each required property, including cancellation, ownership and replay.
- [Semantic handoff contract](semantic-handoff-contract.md): Current Intents / Strategy / Tactics meanings and ownership, the offline-bundle patch corpus and explicitly historical M0 preservation evidence. Deterministic acceptance is not live-model quality evidence.
- [Semantic compatibility decision](semantic-compatibility-decision.md): Shipped semantic migration/support policy, translation oracle, public API impact and historical writer-fence evidence. Core v3 and external-module v4 share Strategy/Tactics; legacy v1/v2 conversion and retired-root reservations remain through State Flow 0.x, with a 1.0.0 cutoff and persistent unsupported-version refusal.
- [Scope selection contract](scope-selection-contract.md): Completed [M2 functional boundary](scope-selection-contract.md#m2-functional-acceptance-boundary): seven-selection capture/native runtime, public controls and mode-only optional presentation, with explicit legacy/private proof and operator-inspection limits. Policy data alone grants no memory.
- [Single-owner model interface](single-scope-interface-contract.md): Reviewed schema/canonical/native flat tools, protocol/Skills and typed runtime outputs; original-request/foreign-provenance counterexamples, deterministic linked-task/identity checkpoint and actual SDK byte measurements. No live model-quality, token/cache/cost or universal-access claim.
- [Public semantic modules](public-module-contract.md): Published `./modules` API since 0.27.0: native-host registration, trusted callbacks, metadata v4 retention, external-root tools, Active/Passive context and atomic Active producers. Owns public integration and currentness boundaries, not dynamic loading or sandboxing.
- [Internal semantic modules](semantic-module-contract.md): Five-member package-owned contract, six built-in bindings, main-agent immutability and detached context/producer evaluation. Public registration uses the same evaluators under the separate public host contract.
- [Protocol composition decision](protocol-composition-decision.md): Historical accepted M4 retain/defer decision, producer/trust ownership and original review evidence. Later internal/public module work superseded only its bounded no-extraction disposition.
- [Semantic extensibility decision](semantic-extensibility-decision.md): Historical accepted M5 no-new-API decision and atomic-validation countercase. Later explicitly authorized internal/public module work shipped in 0.27.0; no dynamic loader, sandbox, production archive or quality claim follows.
- [Semantic memory evaluation](semantic-memory-evaluation.md): Fixed linked-task trial, controlled fixture, independent rubric, isolation/measurement contract and historical credential-safe preflight. Functional implementation has shipped; live-model comparison remains separately authorization-gated and unrun.

## Development policy

- [Agent contract relocation ledger](agent-contract-relocation.md): Audit map from [AGENTS.md](../AGENTS.md) development instructions to their owning contracts and tests. It is provenance evidence, not a user guide or an open-work list.
