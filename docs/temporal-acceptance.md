# Temporal acceptance

This is a maintained property-to-test map for the current canonical-file contract, not a second backlog or a substitute for running tests. Paths and quoted test names refer to a source checkout; tests are not shipped in the npm runtime package. Some test labels retain internal Start/Stop terminology: activation uses `/state-flow-active`; inactive scenarios explicitly select Passive or Off according to their tools/context assertions.

## Required properties and witnesses

### 1. Zero patches

- `tests/temporal.test.ts` — “zero patches preserve the initial materialization without fabricating a past” compares current state with the checkpoint and rejects invented prior history.

### 2. One patch

- `tests/temporal.test.ts` — “one patch shifts current to history and reads return detached materializations” checks new current state and the preceding checkpoint state.

### 3. Seven patches

- `tests/temporal.test.ts` — “seven patches and repeated eighth-patch folding preserve every hot state exactly” compares every effective/scoped offset with retained snapshots at seven transitions.

### 4. Eighth-patch folding

- The same test explicitly checks checkpoint advancement through T1, its absorbed value, and the retained T2–T8 tail, alongside every hot offset.

### 5. Repeated folding

- The same test repeats through forty transitions; `tests/storage.test.ts` exercises the persisted canonical representation.

### 6. Sparse scopes share one target

- `tests/temporal.test.ts` — “sparse scope patches use effective boundaries, not each scope's mutation count” reproduces the T181–T184 example.

### 7. CWD indexing is not local-patch indexing

- That sparse test explicitly asserts both CWD offsets 1 and 2 equal C′.
- `tests/extension.test.ts` — “read_state lazily projects all hot historical paths and scopes without publication or Git calls” checks all 32 offset/scope combinations.

### 8. Shared multi-scope identity

- `tests/transition.test.ts` — “publishes one exact multi-scope replay cohort without explanatory windows or current-state DTOs” verifies one identity across changed scope records and exact replay.

### 9. Unchanged scopes stay stable

- The sparse temporal example checks global state at a boundary where only CWD/session change; “true no-ops do not enter history while response-only changes do” also checks that an unchanged session receives no new patch.

### 10. Historical deletion overlay

- `tests/temporal.test.ts` — “mixed sparse changes and deletion overlays match an independent snapshot oracle through compaction” explicitly checks session → CWD → global fallback and retained historical values.

### 11. Barrier shifts current to offset 1

- `tests/integration.test.ts` — “real Pi patch_state barriers rematerialize every scope before the next inference” observes the predecessor immediately after a barrier.

### 12. Next inference sees new current state

- The same real-Pi test reconstructs current state from the frozen head plus matching-projection result/tail replacements after session, CWD, and global barriers.
- “real Pi reads prior scoped state lazily after a barrier and rejects path offset eight without a transition” adds model-tool access to the predecessor.

### 13. No automatic old full-state duplication

- `tests/context.test.ts` — “projects only the latest seven compact accepted transitions” rejects full-state records in transition context.
- The real-Pi barrier test requires exactly one frozen runtime head per inference, with fresh changes in matching-projection tails.
- Explicitly requested history remains ordinary tool-result trajectory, not eager snapshot injection.

### 14. Accepted response changes are transitions

- `tests/extension.test.ts` verifies that an ordinary accepted answer becomes runtime-owned `response` without a finalization patch or fallback inference, and “an empty accepted answer finalizes the run and stores an empty response” proves `""` is accepted after an earlier barrier.
- `tests/transition.test.ts` proves the empty value is an ordinary Session-owned semantic change when it replaces prior text.

### 15. Correct repeats succeed without semantic changes

- “accepts canonical atomic scope patches and correct repeats without another checkpoint” preserves canonical bytes and native checkpoint count on repetition, while still rejecting empty supplied scopes and obsolete finalization-shaped calls.
- Runtime current-head witnesses preserve revisions, lineage and step across identical patches and compilations; a changed accepted response remains a runtime-owned transition.

### 16. Configured hot-history bounds

- `tests/temporal.test.ts` verifies hot-range and unavailable pre-origin boundaries; the real-Pi history-reader test rejects offset eight at the default limit seven without a transition.
- `tests/config.test.ts` exercises materialized and scope patch-history paths at limits 0, 1, 7, and 12, including single-path/one-item batch reads above seven and distinct configured versus actually retained boundaries.

### 17. Memory never depends on the Pi step

- `tests/recovery.test.ts` rejects unsupported checkpoint envelopes without older-pointer or disabled-marker fallback.
- Extension/native tests prove old-step tree navigation, reload and resume keep current memory writable in Active and Passive; unreadable current files block Active visibly, Passive retries acceptance and Off releases inference only, with unchanged canonical bytes.
- Native “real Pi keeps current … memory after old-step tree selection and reload” cases cover passive, active and interrupted work plus the next provider's private-memory input.
- Runtime current-head tests preserve semantics, provenance, revisions, step and available history across old modes, distinguish absent from incomplete private authority, adopt validated foreign shared streams without private leakage or invented history, and reject a concurrent private writer.
- Native pre-runtime and inherited-fork-selection witnesses preserve current owned session memory instead of resetting it or recopying a parent.
- Repeated active Start leaves response reconciliation intact.
- Ordinary conversation with only a pre-runtime mode checkpoint still bootstraps; unaccepted fork identity/CWD repair retries copying the parent's current memory.

### 18. Tree/resume restore branch mode over current memory

- `tests/integration.test.ts` — “real Pi branch navigation through compaction restores branch modes over current memory” and “real Pi old tree branch stop and resume keep current semantics without rewinding any files”.

### 19. Stop changes policy, not semantic history

- `tests/runtime.test.ts` lifecycle-only witnesses use a separate process to advance global/CWD semantics or provenance, including wider foreign retention, then prove exact semantic/sidecar preservation, unchanged steps, idempotent Stop, and same-session/stale-evidence refusal.
- Native Stop/new-request witnesses verify the accepted shared view reaches handoff/inference without a lifecycle semantic write, while the current-head native witness accepts a shared write racing after inference and retains its actual accepted predecessor.
- Mid-tool Stop tests preserve ordinary/bootstrap trajectories through tree, reload, resume, and restart.
- The native “real Pi retains a native split-turn continuation through late tools” Stop/no-Stop controls actually remove the original user with native threshold compaction, then require summary, paired reads and foreign context in model input.
- The Stop case also checks frozen semantics/step, unchanged trace prefix, tree/reload/cold resume/bootstrap restart, no resurrection of discarded input, and persistent foreign context after the next active run.
- Pure passive-selector tests cover missing, colliding and nonfinite recorded active anchors and explicit preservation of unfinished compilation.
- The native “real Pi repeated Start/Stop preserves uncompiled conversation and its prior boundary” cases cover initial/restarted bootstrap, repeated idle toggles, reload, unchanged native trace, and release after accepted compilation; extension tests cover interrupted idle Stop with and without a captured anchor.
- Completed idle and marker-based cutoffs remain bounded.
- The extension's failed-Stop matrix covers concurrent private writers, invalid lock ownership and malformed runtime files in both inactive modes: the selected mode remains applied, canonical bytes stay unchanged, accepted memory and native conversation survive, and only Passive projects the handoff; reload is read-only, and writes remain fenced until accepted Start or a successful explicit Passive retry; failed retries add no duplicate fence.
- Native “real Pi failed Stop stays passive through late tools, tree, reload and resume” cases verify provider inputs, rejected tool calls, untouched trace prefixes, private memory, current foreign writes, and recovery through explicit Start.
- A native fork witness retains disabled policy without inheriting the parent's fence.
- Session tests bind fence lifetime to owner/reset/accepted-checkpoint evidence; runtime current-head tests prove read-only loading changes no canonical bytes.
- `tests/storage.test.ts` fences lifecycle-only writes to config/runtime files; `tests/extension.test.ts` covers idle and marker-based cutoffs and new/fork boundaries.

### 20. Compact mode, inspectable revisions

- `tests/status.test.ts` proves Active/Passive terminal indicators omit revisions, Off alone hides the indicator, and `/state-flow-status` retains the effective `g#c#s#` vector with blank lines between top-level JSON planes.
- `tests/telegram.test.ts` verifies mode-only section labels, capitalized radio options with one mode-specific selected marker and ⚫️ inactive markers, direct scope buttons, owner Rich headings with `#revision` and Effective with `g#c#s#`.
- Telegram can inspect existing shared memory even in Off without initializing or mutating storage.
- Failure-fenced inspection retains accepted cached memory without overwriting another writer.

### 21. Independent revisions survive folding and foreign writers

- `tests/temporal.test.ts` proves each materially changed scope advances once for sparse and multi-scope cohorts, response-only transitions advance only Session, no-ops advance none, selected retained history restores the matching revision, and folding never resets it.
- `tests/durable.test.ts` covers revision serialization plus the retained-tail baseline for metadata without a revision counter.
- `tests/runtime.test.ts` uses an independent file-backed writer to advance Global, then refreshes the first runtime without file mutation and proves `G1/C0/S1` becomes `G1/C0/S2` after one private Session patch.

### 22. Current-head atomic model publication

- `tests/runtime.test.ts` applies authored independent/overlapping assignments, deletion and arrays to current shared values, preserves another owner's private files, and derives the predecessor/revisions from that basis.
- Compilation witnesses replace complete cards with matching provenance, preserve untouched evidence, accept repeats and refuse orphaned evidence after semantic-pair disappearance.
- Partial/malformed shared evidence and concurrent/unselected private authority stay fenced.
- Fault injection rolls back a mixed publication without installing the candidate's shared adoption or private draft.
- Extension tests reject a first passive patch without publishing empty setup, and recheck acquired-source freshness after lock waiting.
- Native “real Pi awaits foreign publication” cases hold an independent process for over two seconds, verify responsive waiting/cancellation with unchanged canonical bytes, and require the next provider to see accepted current Global/CWD plus its own Session, never the foreign private layer.

### 23. Awaited response acceptance owns its lifecycle

- `tests/extension.test.ts` verifies waiting against current shared memory, one accepted checkpoint without a second publication, rollback without candidate/cache or lifecycle installation, cancellation at Stop/session/tree/shutdown boundaries, shutdown fencing and superseding-answer isolation.
- Native “real Pi awaits response publication” witnesses wait behind an independent writer for over two seconds, then prove later boundary handlers and continuation inference see the accepted response, current Global/CWD and only their own Session.
- Native Abort withdraws the wait without changing canonical bytes, the prior response or unfinished specification, and without requesting a repair inference.

### 24. Awaited inspection is coherent and observational

- `tests/runtime.test.ts` pauses an independent writer between semantic-tail and metadata publication for over two seconds: shared inspection waits responsively, preserves its cached view, and then reads matching Global/CWD/artifact evidence with its own private layer.
- Cancellation, absent/malformed storage, unchanged reads and competing private authority preserve bytes and history.
- `tests/telegram.test.ts` covers lazy passive and active reads without publication/checkpoints, coupled data/revision receipts, revocation before presentation, Stop/tree/shutdown cancellation, early callback acknowledgement and escaped late errors without a second callback answer.
- Synchronous ports and failed-Stop cached inspection remain supported.

### 25. Coherent backup capture preserves semantic acceptance and Abort

- `tests/git.test.ts` pauses an independent publisher between scope files for over two seconds, then verifies one complete committed inventory including newly created namespaces.
- Cancellation preserves files/HEAD/index and releases only the owned backup mutex; local waiters serialize, replacement ownership survives, and Git branch/head drift after waiting is rejected.
- Existing slow-Git witnesses still observe no Git command under canonical exclusion.
- `tests/episode.test.ts` checks operation cancellation, shutdown draining, later retry and Stop write-fence preservation.
- Native tests require the commit before later settlement handlers, or explicit deferral when the host provides no operation signal.
- `tests/storage.test.ts` distinguishes nonwaiting busy admission from malformed ownership without theft.
- Without a host operation signal, the policy is deferral, not a synthetic-signal cancellation guarantee.

### 26. Advisory startup inspection awaits coherent evidence

- `tests/continuation.test.ts` pauses an independent publisher between private-tail and metadata replacement for over two seconds.
- Inspection and the default-launch recommendation wait; cancellation rejects without suggesting another session or changing bytes/lock ownership.
- After release, eligibility uses the complete accepted cohort.
- Absent/empty stores stay uninitialized; malformed, orphaned, symlinked and invalid-lock evidence stays ineligible.
- Async host callbacks preserve detached native headers and eligibility, cannot override native identity, and cannot return late decisions or inspect more candidates after cancellation.
- Existing native-session, shared-drift and private-lineage witnesses remain applicable; these are advisory APIs, not an installed native startup hook.

### 27. Awaited runtime-only acceptance preserves semantic authority

- `tests/runtime.test.ts` applies both raw and awaited lifecycle publication beside independently advanced Global/CWD state or evidence at limits 0/7, preserving wider stored tails, orphaned provenance, unknown metadata and private values.
- An independent publisher pauses mid-cohort for over two seconds; waiting/cancellation changes no accepted bytes/cache, and the post-wait callback uses current lifecycle input.
- Authority, malformed/partial/absent storage, private races, newer selections, single-use/expired capabilities and rollback remain fenced; correct repeats add no history.
- Native “real Pi context provides a cancellable lifecycle boundary” probes prove acceptance before the provider and actual Abort cancellation without later inference/publication.
- Those embedding probes establish the SDK seam; production preparation is covered separately below.
- No-transition patch publication passes the same wider-history/evidence matrix for complete accepted cohorts; an absence witness distinguishes its normal atomic initialization from the explicit lifecycle-only API, which still refuses missing semantic storage.

### 28. Pre-inference preparation accepts once or stops inference

- Extension witnesses prove capture/no-signal projection is read-only, current-head maintenance shares lifecycle acceptance, reappearing sources survive, duplicate contexts reuse preparation and pre-acceptance failure rolls back both maintenance and metadata.
- Abort, Stop, selection, shutdown and superseded runs preserve newer state/fences; post-acceptance failure cannot replay an old specification.
- Native “real Pi production preparation” holds an independent partial publisher for over two seconds, then proves matching `G2/C2/S2`, source/provenance cleanup and private isolation before the first provider, while the native missing-CWD witness preserves current-empty initialization without resurrection, or actual Abort with no publication/inference after release.
- Native fault injection proves public `ctx.abort()` fences Pi's otherwise fail-open context hook.
- Session/native tests retain uncheckpointed input through reload/Stop/cold resume and interrupted boundary-continuation tool evidence through idle Stop/reload, without inventing a run or reviving a completed specification.

### 29. Awaited Stop preserves immediate policy and accepted authority

- Extension tests cover all inactive-choice pairs: immediate Passive projection or complete Off withdrawal, one runtime-only acceptance of the latest pending choice, current shared adoption with unchanged semantic/provenance bytes, and lifecycle derivation after an intervening same-instance passive patch.
- Operation cancellation keeps the selected inactive mode and fences writes; selection/shutdown/accepted Start withdraw obsolete work without later mutation, while rejected Start leaves Stop pending.
- Publication faults roll back config/runtime without installing shared adoption; native checkpoint faults after acceptance do not roll back or retry writes.
- Native “real Pi off keeps local mode off while awaiting a partial foreign publication without private leakage” holds an independent writer for over two seconds, proves accepted shared/local memory through inspection and verifies that Off injects no shared-memory values or handoff into the next provider request.
- Telegram controls acknowledge early, await results, escape late errors and suppress revoked/navigated/disposed views; synchronous controls remain compatible.

### 30. Awaited Start activates current authority without stale rollback

- Runtime witnesses preserve semantics, provenance, revisions, step and aligned history across old mode/unfinished-work combinations; expired/single-use capabilities, partial private authority, unauthorized absent-root creation, noncooperating private-byte replacement after capture, rollback and no-op acceptance are checked.
- Extension witnesses prove coalescing, no early policy/cache/checkpoint changes, post-wait bootstrap/private-step derivation, Stop/session/tree/shutdown cancellation, physical-owner revalidation and no rollback/replayed checkpoint after acceptance.
- A completed Start failure loses Telegram presentation authority when selection changes during callback acknowledgement.
- Native “real Pi active keeps local mode off while awaiting a partial foreign publication without private leakage” waits over two seconds behind an independent partial writer, then verifies current Global/CWD and local Session in the next provider input.
- Native “real Pi Abort cancels an in-run Start without waiting for the canonical owner or another provider call” uses the actual command and active operation signal: cancellation returns while the store remains held, without changed files/checkpoints, another provider call or late activation.
- Idle/no-signal waits and the separate initial-attachment/fork recovery paths are not certified by that Abort witness.

### 31. Branch attachment accepts one coherent current cohort

- Attachment uses the current-head Start transaction, whose witnesses cover foreign shared adoption, incomplete private storage, noncooperating private replacement, single-use acceptance and preserved cohorts on publication failure.
- Runtime attach/fork cases reject contradictory session lineage without installing a cache or changing files.
- No empty fallback, invented history or unaccepted cache installation is permitted; there is no boundary-restoration API.
- Native caller cutover evidence is item 35.

### 32. Awaited fork copies current parent memory and preserves parent and child authority

- Runtime fork cases cover limits 0/1/12 from an old step, current artifact provenance and contradictory lineage.
- An independent partial writer held over two seconds proves responsive cancellation, pinned source identity/checkpoint, current shared adoption and private copying without parent/foreign-private changes. The extension pins the parent's current head, so native fork copies never depend on the fork step.
- Competing child acceptances prove post-wait checks.
- Every occupied child file, unsupported storage evidence, invalid/missing parent authority and parent/child byte races refuse publication.
- Fault injection proves rollback/retry; expired/single-use capabilities and post-acceptance checkpoint failure cannot replace accepted child memory.
- Child lifecycle resets step and unfinished specification while retaining selected mode/bootstrap; later child writes leave the parent unchanged.
- Shared unknown metadata and unrelated provenance survive.
- Native fork caller evidence is item 35.

### 33. Awaited current-memory recovery stays read-only

- Awaited loader matrices at limits 0/7 preserve current same-session values, step, revisions and bootstrap beside independently advanced shared streams without inheriting foreign private memory or unfinished specifications.
- No composed history is invented and no canonical files change, even when the in-memory view folds wider tails.
- Recovered caches cannot authorize lifecycle/patch publication.
- An independent partial writer held over two seconds proves cancelable coherent capture; injected cancellation during capture prevents cache installation.
- Missing roots/private authority remain absent, malformed/partial/identity/provenance errors retain the prior cache and bytes.
- Native failed-Stop wiring evidence is item 35.

### 34. Lifecycle fixtures await completion without trapping withdrawal

- Direct startup/tree fixture calls await their handlers before inspecting completed state.
- Preparation, response, Start, Stop and Telegram inspection cancellation families dispatch replacement selection separately, prove the obsolete operation withdraws while storage remains held, then release exclusion and join the replacement.
- Canonical-byte and stale trace/notice assertions remain; UI stability is measured after legitimate replacement completion.
- Item 35 records the resulting native cutover.

### 35. Native branch restoration awaits one owned lifetime

- Extension witnesses hold exclusion across startup, tree, auto-start and failed-Stop reload: mode stays in the selected inactive policy, private reads/patches report the pending selection, and files/checkpoints stay unchanged until acceptance.
- Joined Starts stay inert; bootstrap derived after waiting shares the single runtime write.
- Replacement selection/shutdown withdraw obsolete restoration while storage remains held.
- Stop changes the pending acceptance's policy without revoking its memory operation; mode separation is covered by items 37–38.
- Failed-Stop reload stays read-only and fenced; post-acceptance checkpoint failure warns without rollback or replay.
- Native tree/fork witnesses hold a publisher, then require selected private memory, unchanged parent-private files and matching next-provider input.

### 36. Recovery joins, draining and cache installation retain separate owners

- Start cancellation returns while independently owned restoration still waits; physical identity stays pinned across that join, so a changed owner cannot be activated.
- Recovery-domain tests preserve other joiners and observe late owner failures even after pre-cancellation.
- Shutdown waits for both current and superseded restoration operations, including delayed reader completion.
- Passive reads remain detached when physical CWD changes, and late native cancellation prevents both passive and private recovery cache installation.
- A private patch accepted between passive capture and attachment completion retains its newer cache and canonical bytes.
- These extension/domain witnesses supplement the native cutover probes rather than claiming universal idle Abort support.

### 37. Fork memory creation is independent of active/passive policy

- The extension native-fork/Start-retry × warm/cold × retained/expired matrix holds exclusion while Stop selects passive policy.
- The copy must remain pending rather than be cancelled, including when Stop withdraws its Start waiter.
- After release, retained source memory is accepted once with disabled policy, passive patching changes child-owned memory without enabling the mode, and native trace reopening through `SessionManager.open` preserves that child state.
- Expired source history refuses canonical publication and substitute checkpoints.
- The separate public SDK control/next-provider witness is item 40; installed UI reachability remains unverified.

### 38. Stop cannot manufacture a restoration failure

- Held-store retained-boundary and auto-start fixtures require repeated Stop to return promptly without cancelling memory acceptance, adding an error fence or publishing early.
- Release accepts the selected/initial memory with passive policy, permits passive patches and retains them across reload.
- Stop→Start while waiting activates only after memory acceptance.
- A separate Start-owned attachment witness withdraws the Start waiter without cancelling restoration.
- The native SDK tree witness invokes `/state-flow-passive` during awaited `navigateTree`, then verifies selected private memory, passive tool availability and a successful next-provider patch; selected conversation remains visible and later-branch private memory stays absent.
- This public SDK route is not installed Telegram/TUI reachability certification.

### 39. Native Skill compilation reconciles an independent writer without private leakage

- The Global/CWD × duplicate/competing/invalid matrix runs real Pi acquisition and compiler tool calls while a separate process publishes between the model's source read and its patch.
- Identical compiler output leaves shared checkpoint/tail/provenance bytes, scope revision and runtime step unchanged.
- Different output replaces the complete artifact and matching source-hash/compiler evidence, preserves independent peer fields, and advances the affected revision once.
- The next provider sees adopted shared state and local private memory, never the peer's private sentinel; all five peer-private files remain unchanged.
- An invalid compilation combined with a Session mutation rejects without changing any captured canonical file or accepting the accompanying Session field.
- The peer uses the runtime publication API, not a second provider; these ordered interleavings supplement the separate held-writer cancellation tests.

### 40. A public SDK host can control a child while fork binding awaits memory

- The fixture observes the public `createAgentSession` result before awaiting `bindExtensions`, without private SDK hooks or direct calls to State Flow command handlers.
- During a held-store `runtime.fork`, it calls the child's public `prompt('/state-flow-passive')`; an optional subsequent Start waits for memory acceptance.
- Stop returns while the fork remains pending.
- After release, the child has a distinct identity, selected private memory and the requested passive/active policy.
- Its next provider sees selected rather than later-parent private state, successfully patches child memory and leaves all parent-private files unchanged.
- This certifies the embedding route on the tested SDK, not whether the installed CLI or Telegram exposes that child before its runtime replacement completes.

### 41. Automatic history does not hydrate lazy memory

- Context tests cover large writes, replacements and deletions in Global/CWD/Session, mixed hot/lazy cohorts, empty scoped patches/transitions and omission of an empty window.
- Visible records retain their identities, order and original positions; artifact evidence is still hidden.
- Native SDK active/bootstrap/reload/Stop→Start witnesses keep lazy bodies out of State Flow-owned automatic blocks while retained canonical files still contain them.
- Current tool trajectory and unfinished bootstrap retain previously communicated bodies.
- Semantic files remain byte-identical through projection/preparation, and no hydration or repair inference is added.

### 42. Hints do not create a recovery task

- Query tests preserve single-value hint conditions, current-only reference-owner lookup, no body disclosure and existing keys/patch/batch/unavailable-history behavior.
- Active/passive native witnesses compare exact canonical bytes and checkpoint counts around hints and reads, and require the exact scripted tool and provider-call counts.
- A task that needs no old detail performs no historical read; a task that needs it explicitly reads the exact retained Global/CWD/Session values without separate permission or restoring deleted data.
- Protocol and both Skill tests enforce this permission and boundary.
- Native provider assertions have completion sentinels outside the provider callbacks so a swallowed scripted provider error cannot produce a false pass.
- These are runtime/contract witnesses, not a claim about every model's discretionary behavior.

### 43. Session mode has one owner

- `tests/config.test.ts` and `tests/snapshot.test.ts` cover enum round trips, read-only compatibility decoding, invalid/mixed session policies and pre-runtime mode retention without semantic initialization.
- Native global-default tests prove later defaults affect only new sessions.
- Extension inactive-choice matrices prove coalescing, no semantic revision and last-choice wins.
- Held-store “fenced reload preserves …” cases cover Off with unchanged canonical bytes and retained fence, and Passive joining read-only recovery before accepting current memory and staying writable across reload.
- Telegram “pre-runtime Telegram Passive reports only its current successful selection” proves truthful success after cache installation and suppression of superseded receipts through the real composition port.


### 44. Intent-owned memory

- `tests/ownership.test.ts` proves same-scope object-key eligibility, recursive structured-reference extraction, shared/ancestor/descendant protection, minimal cascade sets and prototype-safe deletion patches. Textual mentions do not own targets.
- `tests/transition.test.ts` checks authored operations before cascading, explicit stored deletions in each scope, one-patch supersession, edit-only behavior and no-op repeats. “writes into owned targets in the same patch that deletes their intent are deleted silently” also covers nested additions and newly created targets.
- `tests/temporal.test.ts` proves replay equality from explicit stored deletions through retained history and checkpoint folding; replay does not re-derive ownership.
- `tests/context.test.ts` requires deleted hot paths and changed lazy navigation in the receipt while the frozen head remains untouched.
- Per-scope native cases in `tests/integration.test.ts` exercise the cascade in both Active and Passive, preserve textual-reference targets and check one revision per patch cohort. Active response reconciliation is a separate Session revision.
- `tests/status.test.ts` checks UTF-8 plane sizes and top-level ownership shares, excludes fabricated empty/unavailable observations and confirms that the fields are operator-facing only.

### 45. Lifecycle state has explicit owners

- `tests/operation.test.ts` checks cancellation, identity-guarded release, superseded-operation draining and renewable lifetimes. A late completion cannot clear a newer owner.
- `tests/acquisition.test.ts` checks that `ArtifactAcquisitionState` keeps invalidations and read candidates synchronized, respects scope precedence and clears accepted acquisition evidence.
- `tests/compaction.test.ts` checks request markers, stale completion and stopped-owner cancellation.
- `tests/git.test.ts` checks settled-turn backup permission, cancellation and push-failure notice ownership.
- `tests/invariants.test.ts` caps mutable composition-root bindings and enforces delegation to the owning domains. These structural guards supplement, not replace, behavioral extension/integration tests.

## Additional preservation boundaries

- `tests/continuation.test.ts` independently advances global/CWD at limits 0/7, then proves read-only eligibility agrees with actual restore and preserves the session layer, including shared-only transitions.
  - `tests/temporal.test.ts` covers sparse/inherited session lineage, conflicting checkpoint/tail identities and parents, future patches, and immutable inputs.
  - The runtime restore/fork contradiction witnesses preserve source/target files rather than accepting a new origin over mixed session files.
  - The native “real Pi refuses contradictory session files without passive substitution and retries the repaired selection” witness retains shared access, fences private access and publication, permits local Stop without a substitute checkpoint, and succeeds after exact-source repair.
  - These are synthetic integrity tests, not evidence of spontaneous cross-session leakage.
- `tests/extension.test.ts` distinguishes pre-runtime Stop from accepted-runtime Stop in inactive modes: global-only and shared storage remain unchanged, repeated selection/reload retain the native `{mode}` marker, and subsequent Start/passive patch establishes a retained session boundary.
  - Malformed/incomplete scope files remain unavailable; Stop does not repair CWD-only storage, while explicit Start may initialize its wholly absent global scope.
  - The native “real Pi Stop preserves a global-only passive branch through reload, patch, and Start” witness checks the same lifecycle without Git.
  - `tests/invariants.test.ts` rejects the unsupported Skill converter in both package and domain exports; existing Skill/transition witnesses preserve real source hashing, hashing failure, and unsupported-field rejection.
- `tests/durable.test.ts` and `tests/storage.test.ts` cover canonical-format rejection, owned regular files, raw-byte rollback, prepared-output receipts, stale/omitted-scope CAS, literal paths, malformed cohorts, and shared-writer exclusion.
- `tests/git.test.ts` proves settled backup preserves unrelated staged/index-only/worktree data, already-staged owned deletions, Git ignore/filter policy, literal paths, and opaque bytes.
  - Controlled Git pauses before/after snapshot capture allow an independent canonical writer to advance and create a new scope; the commit must match exactly one captured cohort, never mixed live bytes.
  - Every observed Git command runs outside the backup's canonical lock.
  - Namespace/type witnesses exclude unrelated traversal and refuse non-regular sources.
  - No-op/unowned-only initial backups skip; Git/index failures preserve canonical acceptance and caller data.
  - `tests/episode.test.ts` proves one diagnostic-only attempt at `agent_before_settle`, without answer changes or an automatic retry.
- `tests/integration.test.ts` native new/resume/fork witnesses preserve canonical files and retained boundaries.
  - Fork witnesses cover selected private state over current shared layers, fresh child ownership, reload/resume, disabled-source fencing, identity/CWD refusal, retry, and expired-boundary refusal.
  - `tests/runtime.test.ts` restore/fork provenance witnesses preserve current-head, untouched-path, and shared evidence while discarding evidence for later-changed private artifacts, including change-away-and-back.
  - The test-only provenance reader is checked against nonempty canonical `meta.json` evidence in every scope before and after reload; native restore/fork tests verify missing-evidence invalidation, explicit recompilation, parent preservation, and provenance across reload.
- `tests/recovery.test.ts` and `tests/runtime.test.ts` distinguish malformed checkpoints from expired retained boundaries, prevent fallthrough or newer-state substitution, and require detached single-use restoration followed by canonical origin acceptance.
- `tests/extension.test.ts` — “tool preflight walks only the selected native suffix for matching calls, without rebuilding a branch” uses real in-memory `SessionManager` trees with zero/two hundred prior request-answer pairs, intervening custom/results, and a later unselected assistant reusing a call ID.
  - It requires exact parent visits, no full-branch construction, preserved sibling/duplicate-patch rejection and unchanged complete native entries.
  - The native sibling-tool witness in `tests/integration.test.ts` separately observes all three start/end events and requires zero branch reads during preflight/execution while accepting the correct state/answer.
- `tests/context.test.ts` proves whole-head identity, stable-position changing/cleared notices, drift since the last communicated view, no redundant post-receipt notices, and reset identity fencing.
  - Native “real Pi bootstrap/passive keeps a byte-stable head” witnesses repeated barriers, active completion rebasing and passive cross-turn continuity.
  - “real Pi passive reload distinguishes retained old receipts from the refreshed head” keeps old native results while requiring a different projection ID and the newly adopted shared value.
  - The trajectory benchmark's contract test requires every continuation prefix to equal the entire preceding serialized array minus its closing bracket in active, passive and Stop-handoff modes; this is not provider cache accounting.
- `tests/context.test.ts` — “enabled context projects the complete overlay once in ordinary and bootstrap runs” counts one full-overlay clone at 8 KiB and 1 MiB while preserving selected/cached state, native entries, input messages and artifact semantics.
  - “current run trajectory allocates no arrays of discarded ordinary history” observes source-derived arrays after zero/two hundred historical request-answer pairs while preserving foreign context, current tools, steering, reference identity and order.
  - Anchor tests prefer captured identity over normalized text, retain images/tools/steering, and preserve available context on missing/nonfinite/colliding identities or ambiguous specification matches; unique text fallback remains projection-only.
  - The native barrier witness separately counts one marked full-overlay clone per post-barrier `emitContext()` invocation; it still requires each next inference to see all accepted scope changes.
- `tests/compaction.test.ts` owns State Flow's completed-run compaction policy: captured run-anchor retention across steering/tools, missing/ambiguous/unfinished-anchor refusal, large-history eligibility, generation-owned invocation, foreign `custom`/`custom_message` prefix refusal, queued-work exclusion, stale selection, benign preparation refusal and shutdown fencing.
  - Its harness emits native user `message_end` and checks that repeated projection plus steering cannot promote missing, ambiguous or unobserved anchors into compaction authority.
  - The native “real Pi compaction retains the original run through steering, tool results, and foreign context” cases actually compact plaintext and SDK-normalized image requests with two steering messages, a successful read/patch, and persisted custom context; image/read-result evidence reaches later model calls, exact message ids survive reload, the trace prefix stays byte-identical, and no model summary is requested.
  - The short “real Pi retains a normalized image and read evidence through steering without compaction” controls check State Flow enabled/disabled parity before any compaction.
  - Existing native witnesses cover ordinary compaction/cold resume and leave threshold compaction after partial tool work native.
- `tests/integration.test.ts` — “real Pi boundary continuation keeps accepted State Flow memory” exercises actual companion `turn_end` and `agent_before_settle` draft entries and continuation.
  - Each next provider input has one freshly rebased head after accepted completion and matching-projection updates after a continued patch, the accepted response and current tool declarations.
  - There is only one `before_agent_start`, no restored specification in runtime checkpoints or model projection, exactly one requested continuation and correct final response/step.
  - The pure “projects accepted memory without resurrecting a completed specification for boundary continuation” witness preserves source state, omits lazy bodies, and keeps available context when both specification and native capture are absent.
- `tests/integration.test.ts` — “real Pi context edits remain canonical through tools, tree selection and reload” proves native user-content replacement, assistant/custom-message omission and live tool-result replacement reach provider input without resurrecting raw history. Selecting an unedited branch restores its native view without overwriting accepted semantic files; selecting the edited branch and reloading preserves its edits and independent memory. Raw JSONL stays append-only.
- `tests/integration.test.ts` — “real Pi structured prompt composes with context hooks” covers active, passive, disabled and explicit foreign-force modes. Conversation hooks exclude systems; full-system hooks receive them; companion before-run and per-request sections plus actual tool declarations survive. User specifications remain outside system authority. Stop/Start on subsequent user requests removes/reinstates the owned section once.
- `tests/integration.test.ts` — “real Pi preserves native run identity across mode toggles” covers initially enabled, mid-tool Start and repeated Start/Stop with explicit Active/Passive/Off selections.
  - Actual provider inputs retain original user/read evidence but not the preceding disabled request; persisted Stop markers name the observed native user, and fixture reload preserves trajectory, frozen state and raw trace prefix.
  - `tests/compaction.test.ts` — “native session boundaries invalidate observed run capture without projection reacquisition” pairs session-start/tree resets with an admitted unchanged-run control.
  - Run identity remains native rather than guessed; an independent optional Stop-marker flag preserves uncompiled bootstrap context without changing the captured anchor.
- `tests/integration.test.ts` — “real Pi refreshes protocol within the same run” covers mid-read Stop, passive Stop, mid-read Start and accepted-boundary Stop/continuation.
  - The next provider request has current protocol/tools, foreign context and tool evidence, no elevated specification and only one user-run preparation; response reconciliation follows the actual mode and earlier native system frames remain intact.
  - `tests/context.test.ts` — “refreshes only owned system protocol without mutating native frames” covers old/replaced/deleted sections, foreign content/tools, conversation identity/order, frozen inputs, absent-frame non-synthesis and unchanged-delta no-ops.
- `tests/integration.test.ts` — “real Pi recovery omits failed attempts without accepting them” checks retry/length/overflow through actual SDK dispatch: durable omission edits, raw trace preservation, unchanged accepted response/step until successful recovery, native split-turn summaries and fixture reload. “real Pi edited-context accounting discards stale provider usage” checks reduced native usage after replacement and one subsequent inference without phantom compaction.
- `tests/integration.test.ts` — “real Pi settled dispatch preserves deferred companion work” covers low pressure, real owned compaction and explicit compaction refusal. The native completion/error callback finishes before settled dispatch returns; all companion observers precede exactly one deferred request, which sees accepted memory and reconciles the expected response/step. The admitted case verifies an actual State Flow-owned compaction rather than relying only on a token estimate.
- `tests/integration.test.ts` — “real Pi applies image profiles only to newly admitted images” compares actual PNG payload dimensions for wide/tall prompt images, built-in image reads and generic tool-result images under two native model profiles. Switching to smaller bounds preserves prior user/read/tool payload bytes through later provider inputs and reload, with disabled/enabled controls and detached caller images. The settled-dispatch witness also inspects actual system prompt and tool declarations after owned compaction, not just scripted execution.
- `tests/json.test.ts` and `tests/transition.test.ts` characterize detached public results and rejected mutable drafts, prototype-named merge isolation, signed zero and single-copy cold-data boundaries. Existing artifact replacement, failed publication, replay/fork and late-response tests remain applicable. The [performance guide](performance.md#memory-only-owned-draft-cow) explains copy-work metrics and public detachment guarantees; these are not persistence-format or end-to-end speed claims.
- `tests/context.test.ts` and `tests/extension.test.ts` prohibit process queries during ordinary context/history reads. `tests/transition.test.ts` rejects stale staging even when semantic values coincide across different causal boundaries.
- `tests/status.test.ts` distinguishes selected temporal history depth from retained per-scope tails and unavailable materialization from an empty state.
- `tests/artifact.test.ts` and extension/native integration witnesses prove exact registered-path inspection, `size + mtimeNs` evidence, non-destructive unavailable/symlink handling, owning-scope removal, runtime-only changed-source hints, and stable-read acceptance without directory discovery.
  - The native newly-adopted-artifact witness proves run preparation refreshes live shared state before proven-missing maintenance and the first inference.
  - Artifact/acquisition/rehydration tests and “real Pi ordinary artifact invalidations share the public fingerprint classifier” cover equal/changed/missing/malformed fingerprints, pre-epoch timestamps, compiler invalidation, detached read plans, retained-hash handling, and effective Skill masking while preserving Skill hashing.
- `tests/protocol.test.ts` covers long/spaced/Windows/Unicode operands, exact scopes and basenames, trailing causes, prose apostrophes, nested/aggregate/cyclic causes, repeated compaction and malformed escaped quotes.
  - Native “real Pi transports actionable long-path diagnostics and accepts an exact-target correction” cases cover all three scopes: rejection preserves canonical bytes, the next provider receives the same actionable error text despite empty `toolResult.details`, a corrected patch uses the original target, and opt-in logs retain full attempted input/path/call identity.
  - The nested-publication native witness separately proves textual cause delivery.
  - Extension lifecycle tests preserve filenames, `EEXIST`, one failed-Start notice and fenced-write recovery guidance under long spaced store paths; status and Telegram tests preserve causes/targets within their display budgets.
  - `tests/episode.test.ts` retains the Git operation and missing-identity reason without undoing accepted memory.
  - Tool failures keep heading separation.
- Runtime/Skill guidance names the reported artifact owner. Registered-Skill unit and native witnesses use Pi's public command source metadata to map user/project/temporary Skills to global/CWD/session, ignore unregistered `SKILL.md` reads, skip matching hashes, permit unrelated patches while compilation remains optional, retain strict attempted-output validation, and publish source-hash provenance to the exact reported owner.
- `tests/transition.test.ts` rejects authored provenance fields and field deletions in every scope through both staging entrypoints, without requiring a preceding read; edits to retained semantic entries and whole-artifact deletion remain valid. The native “real Pi rejects no-read provenance forgery atomically and accepts a corrected model patch” witness proves whole-cohort rejection and recovery, while existing artifact/Skill tests preserve runtime-owned compilation evidence and compatibility decoding.
- `tests/storage.test.ts` covers exact file-cohort references, file CAS/rollback, and shared writer exclusion.
  - The asynchronous transaction witnesses pause an independent writer between tail and metadata renames for over two seconds: the waiting process remains responsive and captures the complete accepted receipt only after release.
  - Local waiters, cancellation before acquisition/publication, interrupted/malformed/empty locks, root/lifetime binding, active recursive refusal, deferred work after context expiry, rollback and replaced-owner preservation are separately checked.
  - The current-head and response witnesses above additionally prove awaited model patch/finalization integration; runtime startup/recovery and exact restoration/fork cutover, including Start's initial attachment and unaccepted-fork paths, are covered by items 35–40.
  - Current-head Start and accepted-runtime Stop are covered above; optional settlement backup uses the selected no-signal deferral rather than an upstream release gate.
  - `tests/runtime.test.ts` and native Pi lifecycle tests cover retained-boundary restart, immediate barriers, finalized response, config-only stop, and unavailable-reference provenance.
  - Canonical files supply current state and bounded hot history; arbitrary cold revision recovery is unsupported.
- `tests/runtime.test.ts` covers fork after lowering `historyLimit` to 0/1; native integration proves reload keeps current state and exactly the retained window, parent-private fork files remain unchanged, and later increases do not reconstruct discarded history.
  - `tests/config.test.ts` covers optional agent configuration, path precedence/expansion, invalid input, load-time caching and read-only behavior.
  - Session tests and native Pi distinguish configured new-session auto-start from branch-mode resume/tree/stop over current memory.
  - `tests/extension.test.ts` proves registered artifacts are reconciled only at enabled inference boundaries.
  - The global default is Off without a configured mode; CWD materialization alone never grants Active mode.

## Validation and limits

Run `npm run validate` in the source checkout; the [SDK compatibility matrix](compatibility.md) identifies tested dependency stacks and isolated host-validation procedures. Run context/DAG validation and `npm pack --dry-run --ignore-scripts` for documentation, dependency direction, and package inventory after an applicable full validation.

Benchmark contracts in `tests/benchmark.test.ts` and `tests/benchmark-session.test.ts` separately verify source-drift rejection, oversized terminal-report delivery with correct failure status, optional phase resources, immutable prefix counters, release after measurement failure, and isolated post-resume probes. Probes check selected model projection and exact delivery of the current native read content; workers that mutate baseline JSONL or repository files after reporting success are rejected. Native-read witnesses distinguish full UTF-8, byte-truncated and line-truncated output, retain source-versus-notice byte counts and release observers after success/failure. A rewritten model-facing read that becomes a faux assistant error must fail the native terminal check, not be counted as a successful run. These correctness tests impose no wall-time performance threshold. The [performance guide](performance.md) defines current workloads, metrics and evidence limits.

Real-Pi tests use the actual Pi SDK and native tool loop with a deterministic faux model and temporary Git repositories. They do not prove that an unconstrained model always follows the memory protocol, nor do they inspect/repair production stores or publish the real repository. Complete native trace remains available; normal model projection retains only the required active context. Cooperative locking and conflict preservation are not kernel-atomic multi-file transactions against nonparticipating writers. Test counts do not establish exhaustive coverage of every possible lifecycle interleaving.
