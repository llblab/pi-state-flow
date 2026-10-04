# Filesystem recovery contract

State Flow classifies absence separately from partial or malformed evidence. Recovery may derive bytes only from an authoritative surviving cohort or from a semantic default that the owner explicitly permits. It never invents history, ownership, provenance, or external success.

## Resource rules

### Global `checkpoint.json` + `patches.jsonl`

- **Authority:** State Flow; authoritative shared semantics.
- **Wholly absent:** Authored patches use current empty reality; stale precomputed replay refuses it.
- **Partial or malformed:** Either half missing, malformed replay, or invalid envelope fails closed.
- **Allowed repair and writes:** Normal CAS publication may materialize the complete empty pair.

### CWD `checkpoint.json` + `patches.jsonl`

- **Authority:** State Flow; authoritative shared semantics with CWD identity.
- **Wholly absent:** Same as global; selected values are not resurrected.
- **Partial or malformed:** Same as global; owner mismatch also fails closed.
- **Allowed repair and writes:** Normal CAS publication may materialize the complete empty pair.

### Session `checkpoint.json` + `patches.jsonl`

- **Authority:** State Flow; authoritative private semantics.
- **Wholly absent:** Fresh lifecycle origin may initialize; an existing session with a checkpoint requires its current files.
- **Partial or malformed:** Partial or malformed pair fails closed.
- **Allowed repair and writes:** Fresh initialization or acceptance of validated current memory only.

### Global/CWD `meta.json`

- **Authority:** State Flow; temporal boundaries, CWD identity, and artifact provenance.
- **Wholly absent:** Missing metadata removes temporal authority and fails closed; only an omitted `artifacts` leaf degrades provenance to `{}`.
- **Partial or malformed:** Malformed metadata or semantic/boundary mismatch fails closed.
- **Allowed repair and writes:** Normal CAS publication from a complete proven cohort.

### Session `meta.json`

- **Authority:** State Flow; session temporal boundaries and artifact provenance.
- **Wholly absent:** Fresh origin may initialize; selected sessions recover only from exact scope authority.
- **Partial or malformed:** Partial, malformed, or contradictory boundary evidence fails closed.
- **Allowed repair and writes:** Canonical scope publication from the selected temporal state.

### Session `config.json` + `runtime.json`

- **Authority:** State Flow; behavior plus authoritative runtime identity, lineage, and counters.
- **Wholly absent:** Fresh origin may initialize; selected sessions recover only from exact authority.
- **Partial or malformed:** Partial, malformed, contradictory identity or lineage fails closed.
- **Allowed repair and writes:** Canonical runtime publication from proven lifecycle/selected state; combined session metadata is unsupported.

### Unsupported checkpoint envelopes, `state.json`, hashed layouts, or semantic Pi checkpoints

- **Authority:** No current authority.
- **Wholly absent:** Ignored.
- **Partial or malformed:** Presence never becomes recovery or conversion input.
- **Allowed repair and writes:** Preserve bytes; operator-managed removal or external conversion only.

### Retained Pi boundary

- **Authority:** State Flow/Pi entry; current canonical lineage.
- **Wholly absent:** Expired or missing boundary is unavailable.
- **Partial or malformed:** Identity, lifecycle, or lineage contradiction fails closed.
- **Allowed repair and writes:** Select exact retained private history over live shared scopes; never consult Git.

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

Every semantic repair follows the ordinary transaction path:

1. Capture the live canonical-file basis under the existing publication lock.
2. Classify each cohort as present, absent, partial, or malformed.
3. Derive only an authorized replacement.
4. Stage the complete canonical cohort.
5. Recheck CAS and ownership.
6. Publish with per-file atomic replacement, conflict-preserving rollback, and then install the accepted runtime state; this is not kernel-atomic multi-file CAS.

**A wholly absent shared scope is current empty reality**, not permission to restore cached cold values or leftover compilation evidence.

- Authored `patch_state` operations select this basis under the awaited store lock and publish only after complete validation. A rejected first patch never leaves separately published empty initialization.
- Raw precomputed replay targeting a disappeared selected basis still fails closed.
- Discarded history is unavailable and is never reconstructed or promoted back into current shared memory.
