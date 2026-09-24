# Filesystem recovery contract

State Flow classifies absence separately from partial or malformed evidence. Recovery may derive bytes only from an authoritative surviving cohort or from a semantic default that the owner explicitly permits. It never invents history, ownership, provenance, or external success.

| Resource or cohort | Owner / authority | Total absence | Partial or malformed presence | Allowed repair and writes |
| --- | --- | --- | --- | --- |
| Global `checkpoint.json` + `patches.jsonl` | State Flow; authoritative shared semantics | Authored patches use current empty reality; stale precomputed replay refuses it | Either half missing, malformed replay, or invalid envelope fails closed | Normal CAS publication may materialize the complete empty pair |
| CWD `checkpoint.json` + `patches.jsonl` | State Flow; authoritative shared semantics with CWD identity | Same as global; selected values are not resurrected | Same as global; owner mismatch also fails closed | Normal CAS publication may materialize the complete empty pair |
| Session `checkpoint.json` + `patches.jsonl` | State Flow; authoritative private semantics | Fresh lifecycle origin may initialize; an existing selected session requires exact retained authority | Partial or malformed pair fails closed | Fresh initialization or exact retained-boundary recovery only |
| Global/CWD `meta.json` | State Flow; temporal boundaries, CWD identity, and artifact provenance | Missing metadata removes temporal authority and fails closed; only an omitted `artifacts` leaf degrades provenance to `{}` | Malformed metadata or semantic/boundary mismatch fails closed | Normal CAS publication from a complete proven cohort |
| Session `meta.json` | State Flow; session temporal boundaries and artifact provenance | Fresh origin may initialize; selected sessions recover only from exact scope authority | Partial, malformed, or contradictory boundary evidence fails closed | Canonical scope publication from the selected temporal state |
| Session `config.json` + `runtime.json` | State Flow; behavior plus authoritative runtime identity, lineage, and counters | Fresh origin may initialize; selected sessions recover only from exact authority | Partial, malformed, contradictory identity or lineage fails closed | Canonical runtime publication from proven lifecycle/selected state; combined predecessor metadata is unsupported |
| Unsupported predecessor envelopes, `state.json`, hashed layouts, or semantic Pi checkpoints | No current authority | Ignored | Presence never becomes recovery or conversion input | Preserve bytes; operator-managed removal or external conversion only |
| Retained Pi boundary | State Flow/Pi entry; current canonical lineage | Expired or missing boundary is unavailable | Identity, lifecycle, or lineage contradiction fails closed | Select exact retained private history over live shared scopes; never consult Git |
| Canonical writer lock | State Flow; file-cohort mutual exclusion | Unlocked | Present lock excludes cooperating publishers, including interrupted owners | Current owner releases; no opportunistic deletion |
| Repository-root `config.json` | Operator; optional read-only global configuration | Built-in defaults | Present unreadable/malformed/unknown settings fail extension configuration | State Flow never creates, rewrites, or stages operator edits; include it in operator-managed copies/versioning |
| Registered artifact source path | External source owner | Exact proven absence permits owning-scope artifact/provenance removal | Relative, symlink, directory, malformed, or unreadable paths disable maintenance locally | Never create; semantic removal only for exact proven absence |
| Skill and external artifact sources | External package/user owner | Freshness unavailable unless ownership proves removal semantics | Unsafe/non-regular/unreadable sources disable acquisition locally | Never create or fabricate source/provenance |
| Pi State Flow entries | Pi session log / State Flow entry owner | Missing required selected boundary blocks that restore | Malformed or contradictory owner/version/boundary fails the dependent restore | Append through Pi entry APIs only; never replace failed selection with passive state |
| Optional diagnostic log | State Flow logger; outside the canonical repository | No diagnostic evidence | I/O failure warns once without changing accepted state | Append local JSONL only when opted in; never use it as semantic recovery authority |

## Power-loss durability

**Current limitation:** `lib/durable.ts` writes same-directory temporary files with `writeFileSync`, then replaces owned paths one at a time with `renameSync`. There is no file/directory `fsync` barrier. A successful call or subsequent readback proves filesystem-visible bytes, not persistence beyond volatile OS/device caches. Guarded rollback handles caught errors while the process is alive; it cannot run after abrupt termination, and several individually atomic replacements are not one crash-atomic cohort. A crash may leave mixed old/new files or unavailable evidence. Existing rollback and cancellation tests do not establish power-loss survival.

**Selected contract (operator decision, 2026-09-24):** optimistic ordinary-operation persistence is sufficient for this release. Loss of recent work after abrupt power loss is an accepted risk, not a requirement for a new recovery mechanism. Power-loss-safe acknowledgement is removed from the release gates; do not add a patch journal, temporary recovery store, flush protocol or storage-format redesign for that scenario. Existing same-directory temporary replacement files remain an implementation detail, not a new patch store. No at-most-one-patch loss bound is promised: an interrupted multi-file publication can leave incomplete evidence and require operator recovery.

Ordinary concurrent publication still preserves unrelated current Global/CWD fields, orders overlapping writes by acceptance and protects private Session authority. Use one short asynchronously awaited capture/stage/publication exclusion plus CAS; inference, source acquisition and Git stay outside it. Optimism does not authorize replacing a stale whole state, accepting a partial cohort, fabricating empty memory, ignoring a reported write failure or stealing an unavailable lock. Optional Git backup and remote synchronization may defer to a later eligible settled turn; neither every intermediate commit nor immediate remote replication is required.

**Native Pi comparison:** inspection of Pi SDK 0.87.0 `dist/core/session-manager.js` shows `_persist()` appending JSONL with `appendFileSync` and initially writing entries with `writeFileSync`; `_rewriteFile()` writes through an opened file descriptor and closes it. These paths specify no `fsync`, `fdatasync` or `flush: true` barrier. Its `flushed` flag tracks whether the initial in-memory entries were written, not stable-media acknowledgement. This is source evidence for that SDK line, not a power-failure experiment or a guarantee about other versions/filesystems. Stronger durability is technically possible with persistence barriers and a coherent recovery protocol, but is deliberately outside this release scope. Process-kill tests alone would not prove volatile-cache survival.

## Transaction rule

Every semantic repair follows the ordinary transaction path:

1. Capture the live canonical-file basis under the existing publication lock.
2. Classify each cohort as present, absent, partial, or malformed.
3. Derive only an authorized replacement.
4. Stage the complete canonical cohort.
5. Recheck CAS and ownership.
6. Publish with per-file atomic replacement, conflict-preserving rollback, and then install the accepted runtime state; this is not kernel-atomic multi-file CAS.

A wholly absent shared scope is current empty reality, not permission to restore cached cold values or leftover compilation evidence. Authored `patch_state` operations select this basis under the awaited store lock and publish only after complete validation; a rejected first patch never leaves separately published empty initialization. Raw precomputed replay targeting a disappeared selected basis still fails closed. Discarded history is unavailable and is never reconstructed or promoted back into current shared memory.
