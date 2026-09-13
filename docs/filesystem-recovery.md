# Filesystem recovery contract

State Flow classifies absence separately from partial or malformed evidence. Recovery may derive bytes only from an authoritative surviving cohort or from a semantic default that the owner explicitly permits. It never invents history, ownership, provenance, or external success.

| Resource or cohort | Owner / authority | Total absence | Partial or malformed presence | Allowed repair and writes |
| --- | --- | --- | --- | --- |
| Global `checkpoint.json` + `patches.jsonl` | State Flow; authoritative shared semantics | Untouched publication adopts a fresh empty scope; a targeted patch conflicts | Either half missing, malformed replay, or invalid envelope fails closed | Normal CAS publication may materialize the complete empty pair |
| CWD `checkpoint.json` + `patches.jsonl` | State Flow; authoritative shared semantics with CWD identity | Same as global; selected values are not resurrected | Same as global; owner mismatch also fails closed | Normal CAS publication may materialize the complete empty pair |
| Session `checkpoint.json` + `patches.jsonl` | State Flow; authoritative private semantics | Fresh lifecycle origin may initialize; an existing selected session requires exact retained authority | Partial or malformed pair fails closed | Fresh initialization or exact selected-revision recovery only |
| Global/CWD `meta.json` | State Flow; derived artifact provenance | Provenance unavailable (`{}`); semantics remain usable | Malformed present evidence disables the dependent provenance operation | Rebuild only from fresh trusted acquisition evidence through publication |
| Session `config.json` + `meta.json` | State Flow; authoritative runtime identity, lineage and session provenance | Fresh origin may initialize; selected sessions recover only from exact authority | Partial, malformed, contradictory identity, lineage, or revision fails closed | Canonical runtime publication from proven lifecycle/selected state |
| Legacy `state.json` and legacy tails | State Flow migration input; authoritative only after codec validation | No migration input | Mixed legacy/canonical, orphan tail, malformed bytes, or identity ambiguity fails closed | Existing one-way migration machinery only |
| Selected Git revision blobs/modes | Git object database; immutable cold authority | A required blob/revision is unavailable | Mode, owner, hash, or cohort contradiction fails closed | Read-only reconstruction; never checkout/reset the live worktree |
| File-only revision pointer/cohort | State Flow/Pi entry; current exact authority only | No cold history can be invented | Any identity mismatch or incomplete retained cohort fails closed | Exact current cohort only; normal locked publication writes repairs |
| Publication queue | State Flow; operational effect intent | Empty queue / no pending publication | Malformed or contradictory bytes are preserved and publication fails locally | CAS save/remove and atomic temporary rename only |
| Worker lease | State Flow; operational ownership | Unclaimed | Malformed/foreign live evidence is preserved; live owner excludes peers | Existing dead-process reclamation protocol only |
| Publication locks | State Flow; mutual exclusion | Unlocked | Present lock excludes publishers, including interrupted owners | Current owner releases; no opportunistic deletion |
| Temporary queue files / isolated Git index | Creating State Flow operation; transient | No pending preparation | Unknown surviving files grant no authority | Creating operation cleans its own temporary path; fatal residue is not adopted |
| Extension `state-flow.json` | Operator; optional external configuration | Built-in defaults | Present unreadable/malformed/unknown settings fail extension configuration | State Flow never creates or rewrites it |
| Knowledge root and Markdown | External Knowledge owner | Freshness unavailable; durable semantic state remains | Unsafe paths or malformed/unreadable sources disable acquisition locally | Never create; semantic removal only under existing confirmed ownership rules |
| Skill and external artifact sources | External package/user owner | Freshness unavailable unless ownership proves removal semantics | Unsafe/non-regular/unreadable sources disable acquisition locally | Never create or fabricate source/provenance |
| Pi State Flow entries and diagnostics | Pi session log / State Flow entry owner | Missing optional diagnostics provide no evidence; missing required selected pointer blocks that restore | Malformed or contradictory owner/version/pointer fails the dependent restore | Append through Pi entry APIs only; no standalone diagnostics file exists |

## Transaction rule

Every semantic repair follows the ordinary transaction path:

1. Capture the live Git or file basis under the existing publication lock.
2. Classify each cohort as present, absent, partial, or malformed.
3. Derive only an authorized replacement.
4. Stage the complete canonical cohort.
5. Recheck CAS and ownership.
6. Atomically publish and install the resulting runtime state.

A current wholly absent shared scope is newer live reality for an untouched transition dependency. Its replacement begins empty at a fresh reconciliation origin. If the accepted transition targets that missing scope, publication refuses the stale target and requires a later inference against the refreshed basis. Cold Git history remains inspectable but is never silently promoted back into current shared memory.
