# Filesystem recovery contract

State Flow classifies absence separately from partial or malformed evidence. Recovery may derive bytes only from an authoritative surviving cohort or from a semantic default that the owner explicitly permits. It never invents history, ownership, provenance, or external success.

| Resource or cohort | Owner / authority | Total absence | Partial or malformed presence | Allowed repair and writes |
| --- | --- | --- | --- | --- |
| Global `checkpoint.json` + `patches.jsonl` | State Flow; authoritative shared semantics | Untouched publication adopts a fresh empty scope; a targeted patch conflicts | Either half missing, malformed replay, or invalid envelope fails closed | Normal CAS publication may materialize the complete empty pair |
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

## Transaction rule

Every semantic repair follows the ordinary transaction path:

1. Capture the live canonical-file basis under the existing publication lock.
2. Classify each cohort as present, absent, partial, or malformed.
3. Derive only an authorized replacement.
4. Stage the complete canonical cohort.
5. Recheck CAS and ownership.
6. Publish with per-file atomic replacement, conflict-preserving rollback, and then install the accepted runtime state; this is not kernel-atomic multi-file CAS.

A current wholly absent shared scope is newer live reality for an untouched transition dependency. Its replacement begins empty at a fresh reconciliation origin. If the accepted transition targets that missing scope, publication refuses the stale target and requires a later inference against the refreshed basis. Discarded history is unavailable and is never reconstructed or promoted back into current shared memory.
