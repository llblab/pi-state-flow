# Semantic evolution compatibility decision brief

## Status and scope

**M1 target dialect and guarded migration locally implemented; not released or exercised on active stores.** On 2026-10-24 the owner requested the complete roadmap implementation and proposed a one-shot migration with temporary retired-name reservations. This supersedes the earlier approval-only stop, not the data-preservation proofs. [BACKLOG.md](../BACKLOG.md#11-compatibility-and-migration) owns remaining work. The [current compatibility guide](compatibility.md) describes retained runtime behavior; the [semantic handoff contract](semantic-handoff-contract.md) defines target meanings. No active store conversion is authorized by this document.

Evidence baseline: package 0.26.5, commit `4494fee9da8258cdf5f02c42672a0eb9866a512a`, matching repository-local Pi SDK 1.0.0. Only repository code and synthetic in-memory values were inspected. No active store, external consumer, or production session was inventoried or converted.

## Implementation direction and reserved names

- **Owner direction:** Use a one-time `contract → strategy`, `working → tactics` migration rather than permanent dual model-facing planes. Temporarily reserve the retired names at the owner-root plane position; new-format creation/patches must explicitly reject them. Do not reserve ordinary nested data keys or blanket-rewrite prose.
- **Implementation choice:** Prefer design B below: translate current and every retained boundary into one target dialect, preserve causal identities/owner revisions, and retain complete pre-conversion backup bytes outside canonical authority. Historical tools then promise translated semantic equality, not the original field spelling. Original-name model aliases are not the default public API. Prove the oracle before enabling publication.
- **Admission before interpretation:** Select a decoder using explicit supported metadata versions before selecting known fields. Reject unknown versions before read acceptance or metadata rewrite; never interpret an unknown future dialect as empty legacy state. Known v1/v2 unknown metadata siblings remain preservable; they are not evidence of a new semantic dialect.
- **One-time and recoverable:** Produce a detached, collision-checked conversion candidate, translate recognized semantic references, validate all retained replay boundaries, and publish checkpoint/tail/metadata together using existing exclusion/CAS/rollback. The accepted target version makes repeat acquisition idempotent. Ordinary inspection and history reads do not become migration writes; source discovery alone grants no publication authority.
- **Fail closed:** Reject coexisting old/new root names for explicit reconciliation, unsupported versions, malformed replay, partial evidence and occupied/conflicting destinations. Do not silently merge or destroy evidence. Already-recorded ownership cascades do not run a second time.
- **Retirement insight:** Removing the temporary converter does not remove version admission. An unsupported old store must fail explicitly after retirement, not be reinterpreted as newly available user-defined planes.
- **Settled support timing:** These are State Flow package versions. Throughout **0.x**, retain legacy `contract`/`working` conversion and reserve those retired owner-root names. Beginning **1.0.0**, that temporary legacy support and reservation window ends; explicit unsupported-version refusal remains. There is no separate **1.1** deadline. The prepared **0.27.0** candidate keeps its converter and reservations unchanged. This policy does not authorize immediate code removal, release, working-store conversion or automatic registration of new planes. Package release numbers are not persisted schema identifiers.
- **Operational boundary:** Version checks in this checkout cannot retrofit already-deployed old low-level callers. Upgrade/quiesce unsupported writers before converting shared cohorts; development only exercises temporary stores. No implicit active-store conversion, downgrade or release publication.

## Pure conversion boundary

`lib/migration.ts` owns the temporary, side-effect-free conversion candidate. `prepareSemanticMigration` requires an explicit source metadata version: 1/2 translate to candidate version **3**, while an already-target v3 candidate is validated/detached without another conversion. V3 is the current canonical scope identifier, independent of State Flow package SemVer and Pi SDK versions; native readers normalize supported legacy input into this one target dialect. This module is not exported from the package root and grants no file/publication authority.

- Root `contract`/`working` become `strategy`/`tactics`; sparse absence, empty legacy branches, patch deletion markers, arrays, ordinary nested keys and opaque unknown root data remain intact. Any target root name in declared legacy data rejects, even without an old sibling. Target candidates reject retired roots in checkpoints and patches, including deletion attempts.
- Recognized exact structured `$ref` locators and deliberate textual `$path` tokens translate only the plane position. Scope, historical selectors, array/range spelling and ownership classification remain unchanged. The query domain supplies shared selector syntax validation without target lookup. Unsupported/unparseable locators, unmarked prose and resource paths stay unchanged; no reference is hydrated or granted authority.
- Artifact registry keys and retained embedded `hash`/`compiler`/`compiled_at` evidence stay opaque. Eligible semantic description/compilation references may translate, but provenance is not a semantic-reference namespace. Hidden provenance metadata is outside this stream candidate and is preserved unchanged by the serialized preflight below.
- Candidate construction validates replay, preserves every transition identity/parent/position and owner revision, and returns detached data. It does not normalize empties, invent a transition, rerun ownership cascades, fold history or write a store.
- Legacy objects translate before target semantic validation, with extra envelope fields retained until strict validation. The temporary reverse-validation bridge is removed. Malformed legacy/target fixtures ensure that conversion cannot sanitize an invalid envelope into acceptance.

`tests/migration.test.ts` proves root reservation/collision handling, locator boundaries and opaque provenance, candidate detachment/idempotence, every retained owner boundary and aligned effective overlay at limits 0/1/7/100, and malformed replay refusal. These are deterministic conversion proofs, not interruption/CAS/backup tests or a live-model evaluation.

## Serialized owner-cohort preflight

`prepareSerializedScopeMigration` takes captured byte arrays for **all three** checkpoint/tail/metadata files, the owner scope and, for CWD, its expected canonical identity. It decodes the declared version before semantic interpretation, preserves raw roots until collision checks, validates local replay, and returns target strings plus detached `basis` byte receipts with SHA-256 identities compatible with the existing CAS convention. Empty tail bytes are present evidence; a missing file or wholly absent cohort is not migration authority and rejects instead of fabricating a new store.

- Source bytes are copied before interpretation. Strict UTF-8 decoding rejects invalid bytes rather than replacing them with the Unicode replacement character; JSON documents are not silently BOM-stripped. Tail blank-line handling remains compatible with the existing JSONL decoder. These receipts describe the caller-supplied bytes, not independently observed files or a publication capability.
- Supported legacy versions 1/2 produce canonical target v3 strings. If legacy revision metadata is absent, credit only the retained tail count, matching existing legacy decoding; discarded revisions/history are not reconstructed. Target v3 requires an explicit revision.
- An already-target v3 cohort validates and returns **byte-identical** target contents, including noncanonical whitespace and JSONL blank lines, rather than rewriting on every open. Native v3 readers admit this target directly; legacy reads return translated semantics without publishing.
- Metadata values change only at the declared format version and, when absent in legacy input, the inferred revision; legacy whitespace/property order may canonicalize. Preserve temporal boundaries, unknown siblings, extra temporal data, CWD owner, opaque identity/lineage/lifecycle values and original provenance registry data. Do not run the normal metadata serializer, which can remove legacy Session authority fields or normalize provenance. Uninterpretable provenance entries remain uninterpretable; preserving them is not new source-hash or compilation evidence.
- CWD requires an explicit expected identity and an exact canonical owner match; non-CWD calls cannot borrow a CWD identity. Provenance registry framing is validated using its owning parser without substituting that parser's normalized output for raw evidence. Partial/malformed cohorts, unsupported versions, mismatched record counts, invalid replay and raw old/target collisions fail closed.

The serialized tests require both preflight and the integrated native decoder to reject target-name collisions in declared legacy bytes; the baseline filtering defect is no longer accepted behavior. They also cover all incomplete-file subsets, exact-byte hashes/detachment, metadata/provenance preservation, legacy revision fallback, empty tails, byte-idempotent v3, UTF-8/BOM/finite-JSON boundaries and CWD identity admission.

**Remaining integration boundary:** This function performs no I/O, backup, lock acquisition, CAS, rollback or cache installation. Local stream validation does not prove Session ownership or composed lineage: native header/config/runtime authority and regular-file/path evidence remain the existing lifecycle/storage owners' responsibility. Bind receipts to the exact owned paths, preserve complete backups of the converted owner cohorts and required owned lifecycle/config/runtime authority outside canonical authority, revalidate under exclusion and prove conflict/interruption refusal before publication. This does not authorize discovering unrelated projects/sessions or scanning the entire store. The integrated M1 runtime uses only `strategy`/`tactics` across types, ownership, tools, query, Skills and callbacks. A returned preflight candidate alone still grants no publication authority.

## Guarded publication and support boundary

`storage.planTemporalPublication` identifies legacy owners even when their normalized semantic stream is unchanged. The existing synchronous, single-use publication capability validates the complete Session runtime/identity/lineage cohort, checks the current exact-byte basis under store exclusion, and decodes the planned target cohort before any canonical write. A pure format change creates no learning transition or owner revision. Runtime-only mode persistence and read-only inspection do not convert.

Before publishing a legacy-to-v3 update, storage creates and verifies `<parent>/<store-name>-migration-backups/<sha256>.json` outside canonical authority. The private manifest identifies converted scopes and updated paths alongside the captured transaction basis, original Base64 bytes/identities, missing entries and owner/runtime identity parameters; no unrelated session/project is discovered. Backup creation failure aborts before canonical writes. Completed backups survive rollback and exact retries reuse them. Existing guarded rollback preserves foreign concurrent output; this adds no power-loss, kernel-atomic or automatic recovery guarantee. See [operator backup guidance](usage.md#moving-a-store-and-supported-formats).

The legacy-publication groups in `tests/runtime.test.ts` and `tests/storage.test.ts` prove observational legacy reads, converted history/revision equality, exact complete backup contents, opaque metadata preservation, one-time backup creation, backup failure, injected publication failure/retry, stale CAS refusal, cancellation while a foreign lock is still held, and private-identity/partial-cohort refusal. Semantic consumers require valid UTF-8, but opaque capture/rollback deliberately retains arbitrary original bytes. Direct string codecs reject lone UTF-16 surrogates before lossy UTF-8 encoding; escaped JSON values (including surrogate values) and valid Unicode pairs retain their exact meaning. A raw backup is evidence, not a fallback store or permission to overwrite later data.

**Public API change:** Existing exported type/function names remain where applicable, but semantic fields, schemas, callbacks and read paths use only `strategy`/`tactics`. Old model/SDK root writes reject; no permanent aliases or old-field type views are added. Historical reads expose translated semantics, not original names. Scope versions 1/2 are migration inputs, version 3 is the target, and unknown versions fail closed. This is an unreleased breaking semantic API/storage change: upgrade/quiesce cooperating consumers before deploying it. Already-deployed unsafe low-level callers remain unsupported concurrent writers; no universal retrofit fence is claimed.

### Source-bound M1 validation

`npm run validate` completed with **892 tests, 0 failures**, typecheck, tracked compilation, extension import and 122-file dry-run package checks. Focused migration/publication witnesses cover source CAS, cancellation under held exclusion, backup/privacy failure, rollback/retry, omitted-owner byte stability, private authority, metadata siblings and retained histories. No active store was read or converted for this work.

The updated isolated SDK calibration completed **41 faux calls** (Native 11, Passive 15, Active 15), all fixtures cleaned, with output limits forwarded. Input/source digest: `4ca8b5d7ff28a7ab031e8f51fc888987a5401badd356a9fb2c7b9b150af53fd2`. At Run 4, Active saw zero prior user prompts versus three in Native/Passive; retained target-schema strategy contained phases, binding requirement, rejected alternatives and the durable conclusion after intent/tactical closure. This is scripted preservation/transport evidence, not model-quality, billing or cache-performance evidence. Live comparison remains deferred.

## What must remain exact

**Agreed preservation:** Rename compatibility cannot silently discard known old planes, weaken existing commitments, change canonical ownership, invent causal history, or replace malformed evidence with empty state.

“Exact historical read” needs a representation qualifier before a writer design can be approved:

- **Original representation:** The known semantic JSON at the requested original boundary, including old plane names, original reference strings, sparse absence, and legacy empty branches. This is not the original file's whitespace or property-order bytes; model projections already have documented filtering.
- **Translated representation:** The entire requested value at that same boundary after a declared, deterministic old-name-to-new-name translation. This can preserve semantic information and identity without being identical original JSON.
- **Raw backup bytes:** An operator copy of complete canonical files before conversion. Such a copy can support manual rollback but is not automatically addressable by `read_state`.

An index is still a causal offset, not a schema version or scope revision. Declaring translated history “exact” must never imply original field names remain readable, discarded history has returned, or the old JSON bytes are unchanged.

**D1 implementation choice:** Ordinary target-dialect historical tools will promise translated representation. Original bytes remain recoverable from a separate complete backup, not a permanent original-name model API. This is a declared contract change, not a claim that renamed JSON is literally unchanged. Its replay/ref/collision proof remains required in M1.

## Compared designs

### A. Version-aware legacy history and a normalized current interface

Keep original owner checkpoints/tails and decode a declared dialect before materialization. A target-facing projection can expose strategy/tactics without canonical rewriting.

- Preserves original bytes and potentially original-name historical access.
- Requires a named representation boundary so raw and normalized views cannot be confused.
- Once target-dialect writes append, checkpoint/tail records require unambiguous dialect/epoch identification, including mixed epochs and folding. Merely checking which keys happen to occur is not enough.
- Risks two long-lived model-facing representations and indefinite old path aliases if the compatibility boundary is not bounded.

This is justified if literal original-name historical access is a supported product requirement. It is not justified only to avoid deciding what “exact” means.

### B. Explicit canonical owner-cohort conversion

Decode old checkpoint and every retained patch, translate them together, and publish a target-dialect checkpoint/tail/metadata cohort. Preserve semantic transition identities, independent revisions, and boundary alignment. Subsequent tools use one target dialect.

- Simpler steady-state semantics, replay, and model guidance.
- Rewrites retained syntax and recognized references; old-name history queries are no longer the normal interface.
- Requires raw collision detection, reviewed writer fences, all cooperating writers upgraded/quiesced, exact-cohort CAS, rollback/recovery procedure, and a complete pre-conversion backup.
- Does not by itself justify a new transition or revision: representation conversion is not a new learned fact.

**Selected implementation direction:** Prepare version admission as the safety boundary, then implement B with the translation oracle and publication constraints below. Keep A as the documented alternative, not a second parallel implementation. If evidence exposes an unsupported preservation requirement, revise the contract explicitly rather than silently broadening the migration.

## Translation contract and oracle

Define a partial translation `T` on a fully decoded, supported owner cohort. It is undefined on ambiguous raw plane collisions or unsupported/malformed authority. The candidate must not become accepted when `T` is undefined.

For every retained boundary and valid accepted patch `P`, the core oracle is:

```text
T(apply(S, P)) = apply(T(S), T(P))
```

The equation concerns sparse semantic values in the chosen dialect, including supported reference translation. It excludes current model-only pruning and lazy/provenance visibility filtering; test those projections separately. It must hold for checkpoint replay, explicit top-level plane deletions, nested deletions, arrays, whole-card replacements, and already-recorded ownership cascades.

### Recommended translation rules

1. Translate only recognized owner-root planes `contract → strategy` and `working → tactics`, including their deletion markers in replay patches. Preserve all other known planes and nested domain keys.
2. Preserve absent fields, empty legacy branches, arrays/array slots, scalar values, and null-as-patch-deletion. No new stored semantic null, fabricated default object, or normalization-only revision.
3. Inspect raw checkpoint and each tail record before known-field selection. If target names already coexist with old names, reject for explicit reconciliation even when a generic old reader would ignore the target names. Do not merge by precedence or silently decide that previously ignored data is disposable. An identical-dual-value shortcut is not needed initially.
4. Translate a structured `$ref` only when its entire value is a recognized semantic locator containing a retired plane segment in the plane position. Translate intentional textual `$path` tokens using the same path grammar and token boundaries, never blanket string replacement. Preserve resources, artifact source paths, nested domain keys, and unmarked prose.
5. Preserve unparseable reference-like ordinary data verbatim unless a concrete ambiguity requires operator reconciliation. Do not make previously legal ordinary JSON invalid simply because its text resembles an unsupported reference. Conversion diagnostics are not a runtime reference audit or automatic repair policy.
6. Keep scope identities and temporal/index/range selectors unchanged. Cross-owner references remain cross-owner, textual references remain non-owning, and target existence or authority is never inferred. The same translation applies to eligible ownership references before and after conversion; old explicit cascade deletions never run again.
7. A normalized reader may decode different supported owner dialects during a quiesced rollout, but each individual checkpoint/tail/metadata cohort must have one proven dialect contract. Do not infer dialect from field absence in sparse state. A translated reference uses logical target-plane names even if its referenced owner has not yet converted; the normalized reader must resolve that owner's declared representation, not move its data.
8. Preserve current artifact source evidence and owner identity. Rewriting a reference does not create a new source hash or prove compilation fidelity. Old instructional prose in compiled cards is not eligible for blanket rewriting: current trusted tool guidance remains authoritative, and a concrete operational gap may justify targeted optional reacquisition through the existing source protocol.

Required equalities include `T(materialize_old(boundary)) = materialize_new(boundary)`, unchanged transition IDs/parents/positions, unchanged independent owner revisions, and equivalent effective overlay at every retained aligned boundary. Original-representation equality is a different promise and is possible only under design A or an explicitly preserved original reader.

## Writer-fence finding

### Verified baseline call-path behavior

The inspected `4494fee` baseline did not have one universal format-admission check:

- `lib/durable.ts::classifyScopeStream` / `parseScopeStream` reads temporal metadata and applies `selectSemanticFields` to checkpoint/tail JSON. It does not check the metadata `version` before selecting fields.
- `lib/durable.ts::parseScopeProvenance` accepts only metadata versions 1 and 2. Normal runtime loading also invokes it, so an unsupported metadata version is rejected on those full loading paths.
- `lib/durable.ts::serializeScopeMetadata` parses JSON-safe existing metadata and emits `version: 2`; it is not a generic unknown-version rejection boundary.
- `index.ts` exports `parseScopeStream`, `serializeScopeStream`, `loadScopeStream`, and other low-level codec functions in addition to `TemporalRuntime`. Their format admission cannot be inferred from the full runtime's behavior.
- Publication planning and final cohort decoding in `lib/storage.ts` have additional checks. Whether a particular old API caller reaches them depends on the caller; a provenance-reader test alone does not prove every exported read/write composition is fenced.

An in-memory probe used synthetic metadata version 3 with otherwise valid temporal boundaries and demonstrated all four distinctions:

1. The old stream parser accepted the metadata and returned only old known planes.
2. A checkpoint containing only proposed strategy/tactics planes decoded to an empty semantic checkpoint under the old parser.
3. The provenance parser rejected that same metadata version.
4. Direct metadata serialization of the parsed old stream emitted version 2.

These observations are not evidence that the installed extension emits or accepts a new semantic format in ordinary operation. They establish that **“bump metadata version and all old callers refuse” is too broad a compatibility claim**. The probe performed no disk publication.

### Current admission hardening

Native `classifyScopeStream` (and therefore `parseScopeStream`/`loadScopeStream`) admits declared v1/v2/v3 before interpreting semantic fields. Legacy input translates before target validation; v3 retired roots reject. `serializeScopeMetadata` refuses unsupported/missing versions on nonempty input, emits v3 and preserves opaque temporal siblings. The provenance reader shares the same supported-version predicate. A semantic stream requires complete temporal evidence; empty metadata is not permission to synthesize history.

`tests/durable.test.ts` covers all three owners, supported versions, metadata siblings, invalid/future/missing versions, direct codec paths, serializer refusal and unchanged fixture bytes. An isolated baseline-source probe at `4494fee9da8258cdf5f02c42672a0eb9866a512a` additionally exercised real target v3 bytes on matching SDK 1.0.0: missing/empty provenance, unknown metadata siblings and sparse checkpoint state. The old low-level decoder admitted and filtered target fields, and its serializer would downgrade to v2. The complete old `refreshCurrentMemory`, `loadPassive` and `withStartTransaction` compositions all refused through provenance-version admission, before cache installation or publisher callback; canonical byte revisions remained unchanged. This proves those compositions, not every historical consumer. No live data or inference was used.

### Required admission and rollout policy

- Use reviewed scope metadata v3 for the target dialect; do not overload version 2 or rely on an ignored additive `semanticVersion` key.
- Require the new implementation to admit the dialect before known-plane filtering, replay, provenance interpretation, and every supported serialization/publication entrypoint. Refuse unsupported or contradictory dialect evidence before it can become an apparently empty valid scope.
- Validate old-client refusal on each supported old runtime/codec composition against synthetic target-format fixtures. Record which older clients cannot be fenced by their existing behavior. New code cannot retroactively fix an already shipped low-level parser.
- Quiesce and upgrade all cooperating store writers before conversion. If any legacy caller can still reinterpret or overwrite target semantics, it is not a supported mixed-version writer and must be removed/upgraded before conversion. Do not claim protection against arbitrary/nonparticipating writers.
- Do not insert invalid old-plane sentinel values, materialized nulls, duplicated semantic aliases, or new hidden memory just to trip an older validator.
- An owner-format fence must survive unknown metadata siblings, sparse state, absent provenance registries, and the first target write. Off, inspection and runtime-only mode persistence cannot convert. An accepted owned Start transaction can; a UI receipt or pure policy choice alone grants no publication authority.

**Supported boundary:** Upgrade/quiesce all cooperating writers; unsafe low-level mixed-version clients are not supported. If a deployment requires coexistence with one, do not convert that store without a separately reviewed bridge/representation. Broad implementation authorization does not authorize exact-store rollout. Legacy conversion and retired-root reservations remain supported throughout State Flow 0.x; their temporary support window ends at State Flow 1.0.0, while explicit unsupported-version refusal remains. The prepared0.27.0 candidate keeps its converter/reservations unchanged; no immediate removal, release or working-store conversion is authorized.

## Public API impact inventory

This is the local exported surface, not an inventory of external users. Absence of in-repository callers does not prove a public export has no consumers.

| Export group | Verified surface and impact |
| --- | --- |
| Semantic types/defaults | `MaterializedState`, `SemanticState`, `StateDocument`, `ScopedStates`, `ScopedSemanticStates`, `StatePatch`, `ScopePatch`, `AtomicScopePatches`, `ScopedPatch`, `SemanticTransition`, `TerminalTransition`; `emptyState`, validators, overlay/projection and artifact-update helpers. Plane-name changes affect TypeScript and runtime values; defaulted views remain distinct from sparse semantics. |
| History/temporal values | `RecentScopePatch`, accepted/recent transitions/windows, `TemporalState` and nested stream shapes; `createAcceptedTransition`, validators, advance/read/revision accessors. Typed paths and patch values change; IDs and offsets must not. |
| Durable codecs | `ScopeStreamSources`, `TemporalScopePaths`, `parseScopeStream`, `loadScopeStream`, `serializeScopeStream`, `serializeScopeProvenance`, path/capture/update helpers. Separate version admission from field selection; do not let old-name callers silently discard data. |
| Runtime methods | Exported `TemporalRuntime`, its `read`/`readView`/`states` values, constructor/default retention, patch/lifecycle/Start/fork transaction contracts, public synchronous methods, raw publication, and provenance accessors. Preserve publication ownership/detachment while documenting value-type changes. |
| Query/tool interface | `parseStateReadPath`, `readStatePath`, query/result types, model tool descriptions/schema/guidelines and emitted receipts. Old native tool-result strings remain historical text; new invocation paths must reject retired grammar actionably rather than read a missing plane silently. |
| Embedding/default factory | `StateFlowExtensionOptions` and its `onRuntime` callback expose default-bearing `ModelState` values transitively even though `ModelState` is not separately re-exported by name. Rebuilt declarations must match actual callback values. |
| Operational guidance | Both packaged Skills, documentation, examples, status/Telegram inspection, and compiled Skill cards can contain old plane names or path syntax. Update trusted/package guidance consistently; preserve source provenance and do not rewrite arbitrary retained prose. |
| Scope/transport identities | `StateScope`, session addresses, artifact ownership and Telegram scope selectors need no semantic rename. Future selection is an additive policy question, not permission to change canonical owner identity. |

**Recommended design for D2:** Use a documented breaking public contract boundary for the semantic rename, with a supported legacy-data reader and explicit operator conversion. Avoid permanent dual old/new object properties or model-facing aliases. If actual consumer evidence requires a bounded adapter, specify its exact export, accepted dialect, failure behavior, and retirement condition separately; do not make all new types ambiguous by default. Do not choose a release number or publish anything in M0.

## Publication and recovery boundary

The conversion unit is one proven owner checkpoint/tail/metadata cohort, plus any actually required session runtime metadata in the existing exact-cohort transaction. Do not invent a whole-store kernel-atomic transaction, new journal, or new semantic transition to make representation conversion look atomic.

A reviewed M1 implementation must distinguish:

- **Before acceptance:** Validate all raw authority and collisions, produce detached candidates, verify every retained replay boundary, acquire the existing exclusion, recheck exact bytes/identity and approved writer policy, and publish once. Rejection/cancellation changes no accepted bytes or caches.
- **After acceptance:** Install the proven candidate and preserve accepted values; a later UI/native checkpoint failure cannot undo it or rerun an already accepted conversion.
- **Crash/partial publication:** Preserve incomplete evidence and fail closed under the current optimistic durability limit. Quiesce writers and reconcile exact cohorts manually; no automatic Git restoration or fabricated empty scope.
- **Downgrade:** Restore a proven complete compatible backup through a separately authorized recovery operation. Do not run an old writer over new owner files, nor promise that a backup can be combined with unrelated later shared writes without reconciliation.

Global/CWD are shared across independent sessions; private Session state and fork copies retain their identities. Native Pi checkpoints carry lifecycle/boundary evidence rather than semantic plane JSON. Reader changes must not turn an old native checkpoint into a memory rewind or require rewriting Pi's append-only history merely to rename a plane.

## Acceptance and current evidence

M1's acceptance map must include the following failure partitions, not only happy-path conversion:

- Sparse checkpoints and retained deletions; legacy empty branches and arrays; history limits 0, 1, 7, and 100; no semantic revision for representation alone.
- Raw dual-plane collisions before filtering, malformed authority, future dialect, and unknown unrelated metadata siblings.
- Recognized structured/textual references, invalid reference-like ordinary data, cross-owner/non-owning references, and explicit old cascade deletions.
- Every supported read/write entrypoint, especially low-level codecs and synchronous library calls; no proof by inference from the full runtime alone.
- Shared competing writers, exact-byte drift while waiting, private identity contradiction, fork copy, rejected publication, interrupted cohort, and downgrade refusal.
- Original versus translated historical reads under the approved D1 contract; a backup must not count as a model-history API.

Focused baseline command:

```bash
node --experimental-strip-types --test tests/durable.test.ts tests/snapshot.test.ts tests/query.test.ts
```

Result on the source identity above: **34 passed, 0 failed**. Together with the synthetic admission probe, this supports the current evidence map. It does not prove target-version admission, migration, crash consistency, safe coexistence with arbitrary older clients, or a new public API.

**Current status, superseding the original M0.2 gate:** M1's translated-history, supported-writer, target API and guarded publication decisions are implemented with the proof boundaries recorded above; the34-test paragraph is historical M0 baseline evidence, not their sole current validation. The owner settled temporary legacy conversion/reservations through State Flow0.x with a cutoff beginning1.0.0 and explicit unsupported-version refusal retained. The prepared0.27.0 candidate keeps its converter/reservations unchanged. No retirement-policy approval, transition plan or compatibility-removal task remains for this release; real-model evaluation is separately M0.4b in [BACKLOG](../BACKLOG.md#12-ordered-implementation-backlog). Writer quiescence, exact-cohort backup/private authority and separate authorization for release or working-store conversion remain mandatory.
