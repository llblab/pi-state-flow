# Filesystem recovery contract

Recovery distinguishes absent, partial, malformed and unsupported evidence. It never invents history or ownership, restores from Git, or borrows another session’s memory. Ordinary admission refuses invalid evidence without writing. Only [self-healing](#self-healing) can quarantine and reset a corrupt owner.

## Resource rules

### Shared scope files

Global and CWD each own a triple: `checkpoint.json`, `patches.jsonl` and `meta.json`. CWD also proves project identity. All three absent means current empty shared reality for authorized acceptance. Any surviving member, even metadata alone, means the scope is **not** wholly absent. A full valid triple may omit documented semantic fields and optional artifact provenance; missing `meta.json` is loss of replay authority, not missing provenance.

### Session scope and lifecycle files

Session semantics use the same triple; `config.json` and `runtime.json` separately bind the physical session, run fields, lineage and acquisition state. An acquired Session requires the whole private triple, even when Session is excluded and only presence is checked. A valid `unacquired` or `deferred` lifecycle instead requires private absence; that alone grants no acquisition or parent lookup. Private files without their lifecycle, or one surviving lifecycle file, are not a new origin. See [origin and acquisition authority](scope-selection-contract.md#origins-acquisition-and-observation).

### Unsupported layouts and native boundaries

Legacy layouts and envelopes are not replay or conversion inputs. Normal admission does not rewrite them. A reserved `state.json` on an exact owned path may be captured as opaque bytes by a separately admitted quarantine, never decoded as a checkpoint. [Retired scope versions](compatibility.md#canonical-scope-format-admission) and [unsupported Session lifecycle formats](compatibility.md#mode-configuration-compatibility) are not healable.

Pi entries supply session policy and run bookkeeping, not semantic revisions. A missing or expired native boundary never rewinds memory or authorizes empty, historical or foreign values. Attachment and fork use validated current authority; see [fork rules](fork-contract.md).

### Canonical writer lock

- **Authority:** State Flow; file-cohort mutual exclusion.
- **Wholly absent:** Unlocked.
- **Partial or malformed:** Present lock excludes cooperating publishers, including interrupted owners.
- **Allowed repair and writes:** Current owner releases; no opportunistic deletion.

### Repository-root `config.json`

- **Authority:** Operator; optional read-only global configuration.
- **Wholly absent:** Built-in defaults.
- **Partial or malformed:** Present unreadable/malformed/unknown settings fail extension configuration.
- **Allowed repair and writes:** State Flow never creates, rewrites, or stages operator edits; include it in operator-managed copies/versioning.

### Registered artifact source path

- **Authority:** External source owner.
- **Wholly absent:** Exact proven absence permits owning-scope artifact/provenance removal.
- **Partial or malformed:** Relative, symlink, directory, malformed, or unreadable paths disable maintenance locally.
- **Allowed repair and writes:** Never create; semantic removal only for exact proven absence.

### Skill and external artifact sources

- **Authority:** External package/user owner.
- **Wholly absent:** Freshness unavailable unless ownership proves removal semantics.
- **Partial or malformed:** Unsafe/non-regular/unreadable sources disable acquisition locally.
- **Allowed repair and writes:** Never create or fabricate source/provenance.

### Pi State Flow entries

- **Authority:** Pi session log / State Flow entry owner.
- **Wholly absent:** No checkpoint means no recorded branch mode; memory is not affected.
- **Partial or malformed:** Malformed or unsupported envelopes are skipped or fail the dependent mode selection; a checkpoint boundary is never a memory revision to restore.
- **Allowed repair and writes:** Append through Pi entry APIs only; never replace failed selection with passive state.

### Optional diagnostic log

- **Authority:** State Flow logger; outside the canonical repository.
- **Wholly absent:** No diagnostic evidence.
- **Partial or malformed:** I/O failure warns once without changing accepted state.
- **Allowed repair and writes:** Append local JSONL only when opted in; never use it as semantic recovery authority.

## Power-loss durability

**Persistence is optimistic, not power-loss safe.** `lib/durable.ts` writes same-directory temporary files with `writeFileSync`, then replaces owned paths one at a time with `renameSync`.

- There is no file/directory `fsync` barrier. A successful call or subsequent readback proves filesystem-visible bytes, not persistence beyond volatile OS/device caches.
- Guarded rollback handles caught errors while the process is alive. It cannot run after abrupt termination, and several individually atomic replacements are not one crash-atomic cohort.
- A crash may leave mixed old/new files or unavailable evidence. Rollback, cancellation and process-kill tests do not establish power-loss survival.

**Accepted risk.** Loss of recent work after abrupt power loss is an accepted risk. There is no power-loss-safe acknowledgement or at-most-one-patch loss bound: an interrupted multi-file publication can leave incomplete evidence and require operator recovery.

- Do not add a patch journal, temporary recovery store, flush protocol or storage-format redesign for this scenario without a separate design decision.
- Same-directory temporary replacement files are an implementation detail, not a separate patch store.
- Stronger durability would require persistence barriers and a coherent recovery protocol; it is outside the current contract.

**Concurrency guarantees still apply.** Ordinary concurrent publication preserves unrelated current Global/CWD fields, orders overlapping writes by acceptance and protects private Session authority.

- Use one short asynchronously awaited capture/stage/publication exclusion plus CAS. Inference, source acquisition and Git stay outside it.
- Optimism does not authorize replacing a stale whole state, accepting a partial cohort, fabricating empty memory, ignoring a reported write failure or stealing an unavailable lock.
- Optional Git backup and remote synchronization may defer to a later eligible settled turn. Neither every intermediate commit nor immediate remote replication is required.

## Transaction rule

Ordinary writes follow [guarded publication](architecture.md#asynchronous-storage-transaction): capture and classify live files under exclusion, derive and validate an authorized successor, then recheck ownership and CAS before per-file replacement. Install only after acceptance. Rollback preserves detected foreign bytes; there is no kernel-atomic multi-file CAS.

A fresh authored patch can use a wholly absent selected shared scope as empty current reality and materialize its complete triple in the same acceptance. A rejected first patch leaves no separate initialization. Captured replay targeting a removed scope refuses; cached values, old provenance and discarded history are not recovery inputs.

## Self-healing

Only `lib/healing.ts` can remove canonical bytes outside ordinary publication. Pi invokes it after failed acquisition (including pre-runtime shared observation), not as maintenance on healthy stores, in automatic Off handling, or during explicit read-only inspection.

1. Take store exclusion without waiting behind a live writer. Probe the Session lifecycle header and required private presence **before** resetting shared owners. Recognizable unsupported lifecycle evidence (including V1) stops the pass before any owner is touched, even if the accompanying config is missing or malformed.
2. Probe each selected shared owner separately. If lifecycle is valid and the requested selection permits it, validate the complete current cohort. Reset only the owner with a healable failure; a cross-owner lineage contradiction belongs to the Session anchor, not healthy shared files.
3. Copy surviving exact bytes to `<parent-of-store>/<store-name>-quarantine/<time>-<scope>-<digest>.json` (private directory, new file mode 0600). Verify the record by readback **before** removing that owner’s files. Quarantine is manual recovery evidence, not a fallback store.
4. Retry acquisition once when healing made a reset or the lifecycle path admits a visible restart from missing Session memory. Preserve captured policy and independent acquisition/fork checks; a missing file is not permission to create an origin or copy a parent. If no bytes survived, the missing-memory restart can be announced without a quarantine file.
5. Announce every reset to the operator, to the model until a run that saw the notice settles, and to the local diagnostic log independently of `logging`.

Filesystem, lock, cancellation, unavailable-revision and foreign-identity failures are not corruption. Neither are recognized retired semantic formats or unsupported lifecycle formats. Do not bypass these refusals by deleting files or by manufacturing an empty runtime. See [recovery witnesses](temporal-acceptance.md#storage-classification-and-healing).
