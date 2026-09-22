# State Flow documentation

- [Usage and recovery](usage.md): Configuration, new/resumed sessions, Start/Stop, diagnostics, privacy, and storage recovery.
- [Architecture](architecture.md): Semantic state, temporal algebra, Pi lifecycle, storage, publication, artifacts, and embedding contracts.
- [Lazy state](lazy-state.md): Implemented ordinary-JSON lazy planes, an effective-by-default `lazy` read path, pure state/patch snapshots, narrow structural `meta` + `keys`, and recursive indexed array patches.
- [Filesystem recovery](filesystem-recovery.md): Cohort-wide absence, partial-presence, malformed-evidence, repair-authority, and transaction rules.
- [Temporal acceptance](temporal-acceptance.md): Required temporal properties and their executable witnesses.
- [SDK compatibility](compatibility.md): Tested dependency stacks, public lifecycle seams, isolated validation, and host limits.
- [Physical fork contract](fork-contract.md): Session-stream copying, live shared memory, child ownership/origin, and tested support boundaries.
- [Session performance](performance.md): Reproducible native-Pi/stateful workloads, long-session resume measurements, two-process publication probes, and evidence limits.
