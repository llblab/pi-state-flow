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
- [Semantic handoff contract](semantic-handoff-contract.md): M1 meanings and acceptance oracles for Intents / Strategy / Tactics, with historical M0 preservation evidence. Names/guidance are locally implemented, not a live-model quality result; remaining work belongs in [BACKLOG.md](../BACKLOG.md).
- [Semantic compatibility decision](semantic-compatibility-decision.md): One-shot migration direction, temporary retired-name reservations, translation oracle, public API impact, and version-admission hardening. Native v3 Strategy/Tactics, translated legacy reads and guarded backed-up conversion are locally implemented; legacy conversion and root reservations remain through State Flow 0.x, with a settled 1.0.0 cutoff and persistent unsupported-version refusal; the current0.x candidate retains its converter code.
- [Scope selection contract](scope-selection-contract.md): Completed [M2 functional boundary](scope-selection-contract.md#m2-functional-acceptance-boundary): seven-selection capture/native runtime, public controls and mode-only optional presentation, with explicit legacy/private proof and operator-inspection limits. Policy data alone grants no memory.
- [Single-owner model interface](single-scope-interface-contract.md): Reviewed schema/canonical/native flat tools, protocol/Skills and typed runtime outputs; original-request/foreign-provenance counterexamples, deterministic linked-task/identity checkpoint and actual SDK byte measurements. No live model-quality, token/cache/cost or universal-access claim.
- [Public semantic modules](public-module-contract.md): Candidate native-host registration/lifetime membrane and admitted-input contract; metadata4 codec/opaque retention has bounded local acceptance. Mutable external roots now participate in the existing read/patch tools in the local candidate; captured inputs and Active/Passive context now execute with source/native fences; Active producers now commit complete replacements through the same engine; local ordinary-consumer acceptance also covers current-only forks and opaque retention through folding/absence/incompatibility/reload/re-registration in SOURCE and the built SDK. Activation was audited inline, not independently approved or released.
- [Internal semantic modules](semantic-module-contract.md): Executable five-member internal contract, six production bindings, main-agent immutability, Active/Passive contributions and detached asynchronous producer evaluation. No public ABI/loader, new stored planes or automatic background inference.
- [Protocol composition decision](protocol-composition-decision.md): Historical accepted M4 retain/defer decision and producer/trust ownership; the later explicit internal-module request supersedes its no-extraction disposition only within the linked new contract.
- [Semantic extensibility decision](semantic-extensibility-decision.md): Historical accepted M5 no-new-API/expansion-deferral decision, demand/alternatives and atomic-validation countercase. The later internal contract does not establish public manifests, sandboxing, production archives or model-quality claims.
- [Semantic memory evaluation](semantic-memory-evaluation.md): Fixed linked-task trial, controlled fixture, independent rubric, isolation/measurement contract, and credential-safe preflight. Deferred until functional implementation; no live behavioral baseline has run.

## Development policy

- [Agent contract relocation ledger](agent-contract-relocation.md): Audit map from [AGENTS.md](../AGENTS.md) development instructions to their owning contracts and tests. It is provenance evidence, not a user guide or an open-work list.
