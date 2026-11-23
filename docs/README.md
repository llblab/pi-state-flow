# State Flow documentation

Start with the [project README](../README.md) for installation and the memory model.

## Operating State Flow

- [Usage and recovery](usage.md): Configure State Flow, choose Active/Passive/Off, inspect memory and recover from storage problems. Includes diagnostics and privacy rules.
- [Lazy state](lazy-state.md): Store ordinary JSON in `lazy` outside baseline context, read it progressively with structural `meta` + `keys`, patch array indices and understand intent ownership.
- [Filesystem recovery](filesystem-recovery.md): What to do when files are missing, incomplete or malformed; which evidence authorizes repair and what durability is promised.
- [Physical fork contract](fork-contract.md): What a child session copies, what stays live, how cancellation works and which forks are supported.

## Integration and verification

- [Architecture](architecture.md): Semantic state, temporal history, Pi lifecycle, storage transactions, artifact acquisition and embedding APIs.
- [SDK compatibility](compatibility.md): Required packages, canonical/legacy tool-name dispatch and host allowlists, verified environments, host lifecycle requirements and isolated validation procedures.
- [Session performance](performance.md): Run synthetic benchmarks, interpret their metrics and understand the current cost model. No provider-cache or latency guarantees.
- [Temporal acceptance](temporal-acceptance.md): Find the tests that witness each required property, including cancellation, ownership and replay.
- [Semantic Layers](semantic-layers.md): What each memory plane is for, five worked handoff patches, and the internal module contract.
- [Scope selection contract](scope-selection-contract.md): [Seven owner combinations](scope-selection-contract.md#functional-acceptance-boundary), lifecycle proof and operator-inspection boundaries. Policy data alone grants no memory.
- [Public semantic modules](public-module-contract.md): Published `./modules` API since 0.27.0: native-host registration, trusted callbacks, metadata v4 retention, external-root tools, Active/Passive context and atomic Active producers. Owns public integration and currentness boundaries, not dynamic loading or sandboxing.

## Rule owners

Each rule has one owning document. Other pages link to it instead of restating it, so a change lands in one place and cannot drift.

| Rule | Owner |
| --- | --- |
| Modes, configuration, commands and operator guidance | [usage.md](usage.md) |
| File classification, self-healing and durability limits | [filesystem-recovery.md](filesystem-recovery.md) |
| Canonical scope format admission, retired versions and required host packages | [compatibility.md](compatibility.md) |
| Memory layers, handoff and internal modules | [semantic-layers.md](semantic-layers.md) |
| Scope selection capture, native policy proof and operator inspection | [scope-selection-contract.md](scope-selection-contract.md) |
| Temporal model, storage transactions, Pi lifecycle, model tools and context | [architecture.md](architecture.md) |
| Fork copy limits | [fork-contract.md](fork-contract.md) |
| Public module registration and retention | [public-module-contract.md](public-module-contract.md) |
| Packaged Skill guidance for the model | [../skills](../skills) |

Release chronology belongs to [CHANGELOG.md](../CHANGELOG.md), never to a rule statement.

## Historical semantic evidence

These are original records, not current instructions or pending work. Release chronology lives in [CHANGELOG.md](../CHANGELOG.md).

- [M0 semantic-memory trial and original calibration record](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/semantic-memory-evaluation.md): Historical environment and scripted evidence, not a live-model result. The [current trial specification](../benchmarks/semantic-memory-trial.md) retains the same prompts and rubric.
- [M0 handoff preservation and original evidence plan](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/semantic-handoff-contract.md#source-bound-validation-evidence): Old-name baseline probe, not a live-model result.
- [M1 migration decision, translation oracle and writer-fence evidence](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/semantic-compatibility-decision.md): Includes the retired 0.x conversion contract; current support is in [format admission](compatibility.md#canonical-scope-format-admission).
- [M2 scope-selection rollout record](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/scope-selection-contract.md): Original staged design, pre-activation probes, raw Active/bootstrap protocol hashes and review results. The all-three-only gate and measurements are historical.
- [M3 single-owner interface and deterministic checkpoint](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/single-scope-interface-contract.md): Original review, SDK serializer and byte measurements, and linked-task fixture results; not live-model evidence.
- [M4 protocol composition decision](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/protocol-composition-decision.md): Original retain/defer review. Later module work superseded its bounded no-extraction disposition.
- [M5 extensibility decision and atomic-validation countercase](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/semantic-extensibility-decision.md): The old no-new-API decision is not a prohibition on the subsequently shipped API.
- [Original internal module contract and verification record](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/semantic-module-contract.md): Fixture and review claims retain their original scope.
- [Agent contract relocation ledger](https://github.com/llblab/pi-state-flow/blob/a19ef008f4557c7037dfd0c8ff88c677b6b386ea/docs/agent-contract-relocation.md): Audit trail for the earlier consolidation of [AGENTS.md](../AGENTS.md), not a source of current rules.
