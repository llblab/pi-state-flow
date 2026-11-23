# Physical fork: current session-memory copy

This page owns fork admission and publication. [Usage](usage.md#fork-support-and-limits) owns operator actions; [scope selection](scope-selection-contract.md#forks) owns captured policy and participation.

## Contract

A physical Pi fork starts with a fresh child UUID and native storage key and inherits the source branch's captured mode and scopes. It never rewinds to the native fork step. When private copy is admitted, the child receives the direct parent's **then-current Session** values, owning revision, retained module descriptors and matching artifact evidence. Selected Global/CWD stay live, with their current values, revisions and provenance. Excluded owners are not relocated or read for convenience.

A new child starts at step zero with its captured bootstrap, not the parent's unfinished specification or validation. Later private acquisition of a deferred child preserves the **child's** existing run fields. The copy itself creates a fresh aligned origin, not a semantic transition or revision increment. Retained owner tails may be copied or folded within `historyLimit`; they do not make earlier aligned child history available. Shared bytes remain unchanged unless accepted retention folding is needed; neither copying nor later child writes change the parent's private files, native trace, project files or tool effects.

Copy the admitted raw artifact registry with its corresponding values, including opaque or malformed entries and the distinction between omitted and explicitly empty. A raw-only change is a CAS conflict even if its parsed meaning is unchanged. Copying grants no source access or maintenance authority.

## Lifecycle and failure

The host first classifies the child, using [header-only lifecycle inspection](scope-selection-contract.md#header-only-lifecycle-inspection) when canonical authority might exist. A captured selection, an opaque native boundary and a lifecycle disposition are data, not copy permission.

- **Off:** Record child-owned native pending-fork policy only. Do not fetch the parent header or canonical store. The marker survives reload and Off until an accepted private copy.
- **New shared-only child:** `withSelectedDeferredForkTransaction` requires explicit fork permission and Active/Passive with Session excluded. It checks for an unoccupied child, accepts only the selected live shared streams and writes a Baseline lifecycle marked `deferred`, with no Session stream. This route has no parent locator or parent I/O. Initial Off, missing permission, Session selection and invalid run fields cannot create an absent root. Persist the native checkpoint without an acquired-private reset.
- **Private admission:** `withSelectedForkCopyTransaction` takes `fork-new` for a wholly absent child lifecycle/private target or `fork-deferred` for an admitted deferred Baseline/V2 child with exact byte/presence dependencies and an unoccupied private target. Session must participate. A deferred lifecycle and child-owned pending marker do not replace independent direct-parent proof. Ordinary `unacquired` is not a deferred source and cannot be copied or initialized as empty on the pending-fork route.
- **Existing child:** Without Session participation, accept only selected child-current memory and keep its pending disposition. Once acquired, the child always uses child-current authority, even after a checkpoint/reset failure, selection change, inherited-tree navigation or cold reopen. It does not reread or recopy the parent; lost acquired files cannot reopen acquisition. Off still defers reading child memory.

### Mode changes while a fork waits

Fork restoration owns its memory operation independently of Start. Passive can change its eventual mode without cancelling the copy or waiting for it to finish. For fresh shared deferral, the optional `modeAtPublication` sampler runs once under exclusion: it changes **only mode**, never scopes, bootstrap or fresh run fields. It cannot supply missing origin permission. Revocation during sampling is checked again before publication; late Off, an invalid result or an exception accepts nothing. The private-copy author likewise samples the latest independently requested Passive mode without replacing child run fields. Explicit Start may separately clear an old specification/validation after it acquires current authority.

Cancelling the Start waiter does not cancel the fork owner. Off, selection, shutdown or an available native Abort can withdraw that owner before acceptance; idle Abort has no signal the host did not supply. Off preserves only native pending policy. Invalid source evidence fails closed without falling back to an older disabled marker or substituting other memory. Explicit Start can retry an unaccepted copy after the source evidence is corrected. A failure after acceptance cannot undo the copy, reset memory or authorize a second copy.

Keep inactive source policy, including a native failed-Stop mode unavailable in canonical config, but inherit neither the parent's write fence nor its passive projection. The child-owned reset prevents inherited Stop markers from resurfacing. Passive exposes both memory tools without Active behavior; Off exposes neither.

## Selected-scope copy boundary

Pi and the library share the selected-origin transaction:

1. Pin a distinct direct-parent session UUID and storage key, not a past boundary. The `prepare` check may read the persisted regular native header **outside** exclusion; require matching UUID/CWD. The `recheck` verifies in-memory host owner, parent and policy after waiting and before publication, without source acquisition.
2. Under the store mutex, validate the child's admitted lifecycle/target before opening parent memory. Read only the parent's config/runtime and Session checkpoint/tail/metadata plus private presence. The parent must have acquired Session under its physical identity. Validate actual replay against applicable lifecycle or retained [private causal proof](scope-selection-contract.md#acquired-private-reselection-proof-boundary); neither missing, malformed nor unacquired/deferred evidence supplies an empty parent. Parent shared/disabled bodies and recursive ancestry are not source inputs.
3. Validate predicted child receipts, then recheck exact parent/child bytes and presence before any required backup and again before publication. Parent evidence is read-only. The callback can publish synchronously once; the normal [CAS and guarded rollback](architecture.md#asynchronous-storage-transaction) apply. Only acceptance installs the child cache. Cache/receipt data does not authorize another acquisition.

## Support boundary

A fork needs the exact persisted direct-parent locator plus valid native and canonical ownership for private acquisition. Do not search sessions or ancestry, guess from paths, accept UUID aliases or in-memory-only locators, cross CWD, use Git or a stale receipt as memory, or convert unsupported storage evidence. See [compatibility](compatibility.md#state-flow-library-api-compatibility) for supported lifecycle formats.

## Evidence

See the [fork acceptance witnesses](temporal-acceptance.md#32-awaited-fork-copies-current-parent-memory-and-preserves-parent-and-child-authority) for deferred and eager copy, raw provenance, cancellation/CAS, cold no-recopy and public SDK next-provider checks. Those fixtures do not establish installed Telegram/TUI reachability.
