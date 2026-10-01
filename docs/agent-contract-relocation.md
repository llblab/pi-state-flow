# Agent contract relocation ledger

This is the source-bound **paragraph-to-owner parity map** for the 8,141-word pre-compaction `AGENTS.md` (SHA-256 `0d328eacc96d6b67c5eb036a51adc27e1dcd24d20bb6695f2fff6d5a3c87737b`; source lines 3–58, based on commit `70baecde` plus the Passive-footprint and `barrier-block` edits). Each `L##` identifies exactly one original bullet/paragraph. Its destination is the current owner of that paragraph's reusable contract; where necessary, a compact root rule or executable witness is also named. The root remains approximately 1,300 words; its 0.23.0 default-mode rule supersedes the original Passive-default clause. This is a reviewed documentation trace, not a claim that prose links alone prove runtime correctness.

## Composition, semantics, and model access

- L03 domain ownership, entrypoint and mirrored tests → [composition](architecture.md#composition), [invariant tests](../tests/invariants.test.ts).
- L04 Active opt-in, former Passive default/conditional projection, Off → [configuration](usage.md#configuration), [mode behavior](usage.md#active-passive-and-configured-off).
- L05 three session-owned mode workflows and global default → [mode behavior](usage.md#active-passive-and-configured-off), [configuration](usage.md#configuration).
- L06 native trace, frozen head, run anchors and foreign context → [Pi lifecycle](architecture.md#pi-lifecycle), [context limits](performance.md#context-projection-and-trajectory-selection), [lifecycle witnesses](temporal-acceptance.md#required-properties-and-witnesses).
- L07 sparse planes, projection, lazy filtering and intents → [semantic state](architecture.md#semantic-state), [model tools](architecture.md#model-tools), [lazy state](lazy-state.md).
- L08 artifact entries and hidden provenance → [artifact routing](architecture.md#artifact-routing).
- L09 exact registered-path observation → [artifact routing](architecture.md#artifact-routing), [source acquisition](usage.md#memory-and-source-acquisition).
- L10 compilation classifier, fingerprints and Skill masking → [artifact routing](architecture.md#artifact-routing).
- L11 stable exact-path acquisition and fork provenance → [artifact routing](architecture.md#artifact-routing), [Git/restore provenance](architecture.md#optional-git-backup), [fork contract](fork-contract.md).
- L12 global config, legacy modes and limits → [configuration](usage.md#configuration), [mode compatibility](compatibility.md#mode-configuration-compatibility).
- L13 session runtime/config/checkpoints and continuation authority → [storage and identity](architecture.md#storage-and-identity), [session continuation](architecture.md#session-continuation), [mode restoration](compatibility.md#mode-selection-and-memory-restoration).
- L14 overlay, scope ownership and Skill routing → [semantic state](architecture.md#semantic-state), [artifact routing](architecture.md#artifact-routing).
- L17 composed historical offsets → [temporal model](architecture.md#temporal-model).
- L18 lazy historical reads and tool availability → [model tools](architecture.md#model-tools), [lazy navigation](usage.md#lazy-navigation-and-historical-reading).
- L27 patch grammar, shared-head staging and private ownership → [model tools](architecture.md#model-tools), [asynchronous transaction](architecture.md#asynchronous-storage-transaction).
- L28 barrier and minimal acceptance receipts → [Pi lifecycle](architecture.md#pi-lifecycle), [tool preflight evidence](performance.md#tool-preflight-parent-traversal).
- L29 accepted-response reconciliation and cancellation → [Pi lifecycle](architecture.md#pi-lifecycle), [session behavior](usage.md#session-behavior).
- L35 omission, empty-scope rejection and response equivalence → [model tools](architecture.md#model-tools), [temporal model](architecture.md#temporal-model).
- L37 public-boundary draft detachment → [storage and identity](architecture.md#storage-and-identity), [COW evidence](performance.md#memory-only-owned-draft-cow).
- L38 recursive patch/null and replay → [model tools](architecture.md#model-tools), [semantic state](architecture.md#semantic-state).
- L39 no project schemas or size/action ledgers → [model tools](architecture.md#model-tools), [operational boundaries](../README.md#operational-boundaries).
- L49 no strict boundedness claim → [operational boundaries](../README.md#operational-boundaries), [performance limits](performance.md#scope).
- L51 tool toggle and Passive read/write boundary → [mode behavior](usage.md#active-passive-and-configured-off), [model tools](architecture.md#model-tools).

## Canonical storage, lifecycle, and backup

- L15 anchored checkpoints/tails and retention folding → [temporal model](architecture.md#temporal-model), [storage and identity](architecture.md#storage-and-identity).
- L16 opaque causal identity, origins and shared drift → [temporal model](architecture.md#temporal-model), [Pi lifecycle](architecture.md#pi-lifecycle).
- L19 canonical layout and identity → [storage and identity](architecture.md#storage-and-identity).
- L20 optimistic durability, optional backup and contention → [power-loss boundary](filesystem-recovery.md#power-loss-durability), [asynchronous transaction](architecture.md#asynchronous-storage-transaction), [optional Git backup](architecture.md#optional-git-backup).
- L21 cohort classification and missing shared pairs → [recovery](usage.md#missing-partial-and-malformed-storage), [transaction rule](filesystem-recovery.md#transaction-rule).
- L22 predecessor formats and no in-place migration → [format boundary](usage.md#moving-a-store-and-the-017-format-boundary), [optional Git backup](architecture.md#optional-git-backup).
- L23 exact-file CAS, awaited transaction and rollback → [asynchronous transaction](architecture.md#asynchronous-storage-transaction), [storage and identity](architecture.md#storage-and-identity), [transaction rule](filesystem-recovery.md#transaction-rule).
- L24 initialization and exact-source fork → [Pi lifecycle](architecture.md#pi-lifecycle), [fork contract](fork-contract.md).
- L25 retained-boundary restore, failed-Stop read-only recovery and selection races → [Pi lifecycle](architecture.md#pi-lifecycle), [mode restoration](compatibility.md#mode-selection-and-memory-restoration).
- L26 independent revisions, backup capture/index/push/shutdown → [temporal model](architecture.md#temporal-model), [optional Git backup](architecture.md#optional-git-backup).
- L40 first active context preparation, abort and specification authority → [Pi lifecycle](architecture.md#pi-lifecycle), [pre-inference cancellation](compatibility.md#pre-inference-cancellation).
- L41 one existing-session bootstrap run → [session behavior](usage.md#session-behavior).
- L42 selected-branch retained-boundary restoration → [Pi lifecycle](architecture.md#pi-lifecycle), [fork contract](fork-contract.md).
- L44 Start/current-head acceptance and Active default → [asynchronous transaction](architecture.md#asynchronous-storage-transaction), [mode behavior](usage.md#active-passive-and-configured-off).
- L45 Passive/Off persistence and frozen Stop handoff → [Pi lifecycle](architecture.md#pi-lifecycle), [mode operations](usage.md#lifecycle-operations), [mode restoration](compatibility.md#mode-selection-and-memory-restoration).
- L46 failed-Stop marker and fence → [storage recovery](usage.md#storage-and-recovery), [Pi lifecycle](architecture.md#pi-lifecycle).
- L47 settled native compaction boundary → [session behavior](usage.md#session-behavior), [SDK settlement](compatibility.md#settlement-cancellation), [lifecycle witnesses](temporal-acceptance.md#required-properties-and-witnesses).

## Operator, agent, and development policy

- L30 terminal handoff plane routing → [operational guidance](architecture.md#operational-guidance-and-memory-curation), [semantic state](architecture.md#semantic-state).
- L31 consequential evidence, semantic references and dangling hints → [model tools](architecture.md#model-tools), [lazy navigation](usage.md#lazy-navigation-and-historical-reading), [memory curation](architecture.md#operational-guidance-and-memory-curation).
- L32 volatile observation and external-effects revalidation → [operational boundaries](../README.md#operational-boundaries), [memory guidance](usage.md#memory-and-source-acquisition).
- L33 registered Skill acquisition → [artifact routing](architecture.md#artifact-routing).
- L34 bounded curation and verified transfers → [operational guidance](architecture.md#operational-guidance-and-memory-curation), [memory Skill](../skills/state-flow-memory/SKILL.md).
- L36 logging categories, privacy and error elision → [diagnostic privacy](usage.md#diagnostic-logging-and-privacy), [barrier contract](architecture.md#pi-lifecycle).
- L43 terminal status and read-only scope inspection → [status and controls](usage.md#status-and-controls), [observability](architecture.md#observability).
- L48 system section, context refresh and foreign prompt precedence → [Pi lifecycle](architecture.md#pi-lifecycle), [host context compatibility](compatibility.md#context-tools-and-provider-input).
- L50 extension-agnostic core and Telegram controls/receipts → [composition](architecture.md#composition), [observability](architecture.md#observability), [Telegram compatibility](compatibility.md#telegram-adapter).
- L52 tag release authority and version alignment → [release workflow](../.github/workflows/release.yml), [release boundary](../BACKLOG.md#release-boundary). Retain the durable no-token constraint in compact `AGENTS.md` until a permanent developer contract owns it.
- L53 opt-in benchmark location and source identity → [benchmark guide](../benchmarks/README.md), [performance validation](performance.md#validation-and-reporting).
- L54 provider callback completion witness → [temporal acceptance](temporal-acceptance.md#required-properties-and-witnesses), [integration tests](../tests/integration.test.ts).
- L55 awaited fixture handlers and withdrawal witness → [temporal acceptance](temporal-acceptance.md#required-properties-and-witnesses), [extension tests](../tests/extension.test.ts).
- L56 tracked `dist/` and build/package parity → [release workflow](../.github/workflows/release.yml), [release invariant tests](../tests/invariants.test.ts). Retain the developer rule in compact `AGENTS.md` unless a durable release guide takes ownership.
- L57 current docs vs delivery history → [documentation index](README.md), compact `AGENTS.md` (durable documentation policy).
- L58 validation order → compact `AGENTS.md` (durable development rule), [validation procedure](compatibility.md#validation-procedure).

## Verification evidence

The map names all 56 source paragraphs exactly once. Each was compared with its destinations; the highest-risk clause groups were checked explicitly: L06/L45 native run anchors and Stop context, L23–L26 CAS/backup/rollback, L28 receipt-elision bounds, L31 reference/epistemic limits, L36 diagnostic privacy, L47 native compaction and L50 callback revocation. An additional exact-code-token audit exposed otherwise easy-to-lose clauses: legacy `{disabled:true}`, in-memory header key derivation, materialization equality, `contract.compiled_skills` rejection, Skill compiler revision, runtime-origin null exception and normalized artifact replay. Those are now stated in architecture; terse `patches[n]` and `{value:null, hint:[...]}` from the source are represented there by the more precise scoped patch path and expanded dangling-reference sentinel. The remaining uniquely durable developer rules, including no live-store fixture edits, stay in the compact root. `tests/invariants.test.ts` is unchanged; native and domain-specific witnesses remain in their named test files. Package, context and domain-DAG validation establish the final checked boundary; they cannot substitute for semantic judgment about future models.
