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

## Development policy

- [Agent contract relocation ledger](agent-contract-relocation.md): Audit map from [AGENTS.md](../AGENTS.md) development instructions to their owning contracts and tests. It is provenance evidence, not a user guide or an open-work list.
