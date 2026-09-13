# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md).

## 0.10.2 hotfix: Native boundaries and patch robustness

- **Outcome:** Correct runtime friction without weakening State Flow's semantic or durability guarantees: early post-acceptance compaction uses public context-token readiness and retains one complete accepted iteration, while non-terminal `patch_state.final` input degrades to an ordinary scoped update instead of failing. Model-facing guidance remains canonical and teaches only omission or `final:true`; tolerant Boolean normalization is a runtime resilience layer, not another advertised protocol form.
- **Scope gate:** The hotfix stays extension-owned: retain State Flow-initiated early compaction through public Pi APIs, replace byte-based readiness with public context usage, and keep one complete latest iteration after successful shortening. Do not require or modify Pi itself.
- **Compaction failure class:** State Flow previously admitted compaction from `JSON.stringify(activeEntries) >= 80_000`, although serialized bytes do not prove that Pi's configured recent-token suffix leaves a removable prefix. It also retained only the latest accepted assistant response. The hotfix uses public context-token usage with a 24,000-token floor and retains the complete latest accepted user iteration; custom Pi retention settings may still decline safely and permit a later retry.
- **Patch failure class:** The public `patch_state` schema declares `final` as an optional Boolean, but execution rejects every supplied value except literal `true`. A model therefore produced a schema-valid `{ cwd: {...}, final: false }` non-terminal patch during a DEOS Grow Loop run and received `patch_state final must be exactly true when supplied`. The semantic patch was unambiguous and otherwise valid; rejecting it spent another tool turn and diagnostic record solely to enforce omission syntax.
- **Ownership contract:** Pi owns native preparation, configured compaction settings, one prepared branch snapshot, cut-point validity, persistence, lifecycle events, and transcript projection. State Flow owns post-acceptance compaction admission, durable revision/step details, foreign-context protection, generation/leaf fencing, and `patch_state` normalization. The advertised TypeBox schema and model context remain the smallest canonical language; runtime may accept a bounded unambiguous compatibility superset without teaching it to the model.

### Checkpoint A: Token-guided early compaction

- **Acceptance checkpoint:** After an eligible accepted run settles, State Flow initiates its own early native compaction only when public `getContextUsage()` reports enough context. A successful request retains the complete latest accepted user iteration and durable handoff; unknown or short usage remains untouched without invoking Pi.
- [x] **Replace byte readiness:** Removed `STATE_FLOW_COMPACTION_MIN_ACTIVE_BYTES` and the serialized-entry byte gate. The extension now requires at least 24,000 estimated context tokens—a modest margin above Pi's default 20,000-token retained suffix—while preserving enabled, accepted, non-bootstrap, idle, empty-queue, durable-base, generation, and resolution guards.
- [x] **Retain one complete iteration:** The custom compaction boundary now starts at the latest accepted user request, preserving its assistant/tool trajectory and final response instead of retaining only the answer.
- [x] **Keep foreign context safe:** Foreign context-bearing custom entries block shortening only when they precede the retained iteration; entries within the retained iteration remain visible.
- [x] **Keep benign refusal recoverable:** Unknown or sub-threshold usage skips compaction. A native refusal under custom Pi retention settings releases the attempt so later accepted work can retry without affecting state.
- [x] **Documentation and protocol:** Project protocol, architecture, usage guidance, changelog, and tests now describe token readiness and complete-iteration retention. User manual and native threshold/overflow compaction remain Pi-owned.

### Checkpoint B: Quiet non-terminal patch degradation

- **Acceptance checkpoint:** Model-facing contracts expose one canonical rule: omit `final` during ongoing work and set `final:true` only when the iteration may finish. Runtime treats explicit false as benign non-terminal intent and may normalize only unambiguous Boolean-like primitives before schema validation. No non-terminal value suppresses or reverses an existing eligibility latch, creates semantic work, changes transition identity or persistence behavior, or produces an invalid-patch diagnostic merely because no scope accompanied it.
- [x] **Normalize explicit false:** `final:false` now accompanies useful global/CWD/session patches without latching or clearing terminal eligibility; pre-latch and post-latch tests preserve atomic state semantics.
- [x] **Bound tolerant coercion:** `prepareArguments` normalizes only `true`, `false`, `1`, `0`, and case-insensitive trimmed `"true"`/`"false"`. Arrays, objects, null, unknown strings, empty strings, and other numbers remain invalid; raw JavaScript truthiness is not used.
- [x] **Keep false-only inert:** `{final:false}` and normalized false-like-only calls return an acknowledged non-terminal no-op without semantic transition, eligibility, response, publication, or diagnostic. Bare `{}`, empty supplied scopes, unknown fields, null semantic values, and material scope no-ops remain invalid.
- [x] **Keep model guidance canonical:** Tool descriptions, prompt snippets/guidelines, injected context, fallback prompts, `AGENTS.md`, the bundled memory Skill, and user-facing documentation teach only omission during ongoing work and `final:true` for terminal eligibility. Compatibility aliases remain implementation/test knowledge.
- [x] **Reconcile diagnostics:** Invalid-input tests now use genuinely malformed values. Unit and real-Pi regressions prove scoped false/false-like updates are accepted without an invalid-patch record and remain terminal-ineligible until a later `final:true`.

### Checkpoint C: Continuous state stewardship

- **Acceptance checkpoint:** State Flow makes memory care part of ordinary model responsibility without creating an automatic background agent, arbitrary maintenance counter, full-state rewrite ritual, or second mutation path. Every handoff curates newly affected state, while explicit project/feature/release phase changes trigger one bounded ownership and obsolescence pass before terminal completion.
- [x] **Strengthen the baseline contract:** The compact runtime protocol, `patch_state` prompt metadata, `AGENTS.md`, and bundled memory Skill now make narrowest-scope placement, touched-branch reconciliation, supersession, and obsolete-progress deletion ordinary responsibilities while keeping detailed migration procedure in the Skill.
- [x] **Define phase-boundary care:** Feature/release/campaign completion, project switches, and active-version changes now require one bounded reconciliation that removes transient prior-work state while retaining still-operative consequences.
- [x] **Make scope movement ordinary:** The runtime contract and Skill define global/CWD/session applicability, targeted scoped reads when effective ownership is unclear, and destination-write/readback/source-delete/readback migration ordering.
- [x] **Bound routine cost:** Ordinary turns curate only touched and obviously stale or mis-scoped visible branches. Full reconciliation is event-driven, with no background loop, arbitrary counter, size trigger, maintenance ledger, timestamp, or score.
- [x] **Align Skill activation:** `state-flow-memory` now covers explicit requests and runtime-required phase boundaries while remaining one bounded, materialized-first, evidence-aware cohort that cannot launch itself or authorize external promotion.
- [x] **Live behavior witness:** A clean temporary Pi 0.85.1 session with the release extension created scoped fixture memory, then a real model moved project-specific campaign state from global to CWD through destination-write/readback/source-delete/readback, removed completed session progress, retained the cross-project rule plus active commitment/uncertainty, and left unrelated state untouched. Durable scope tails verify the claimed movement and deletion.

### Checkpoint D: Integrated hotfix candidate

- **Acceptance checkpoint:** Token-guided early compaction, quiet non-terminal patch degradation, and continuous state stewardship form one coherent release candidate, and validation proves all three without reopening completed 0.10.1 work.
- [x] **Compatibility and versions:** The release preserves the existing public Pi API floor; `getContextUsage()` is present in the 0.84.4 public extension types, the complete suite passes on 0.85.1, and package/lockfile metadata agree on 0.10.2 without a new host capability dependency.
- [x] **Regression validation:** Focused compaction and real-Pi witnesses pass; `npm run validate` passes 446/446 on Pi 0.85.1, context validation reports zero errors, and the 46-file dry-run package includes the renamed protocol and compaction domains. Real-Pi lifecycle coverage proves retained complete-iteration history and skipped short usage; patch/logging tests prove useful `final:false`; the clean real-model witness proves bounded phase-boundary cleanup.
- [ ] **Release follow-through:** After the combined candidate is validated, release the State Flow hotfix through its guarded direct-main/tag automation and update the exact Pi Kit pin and synchronized lock/inventory surfaces.

## Candidate evolution

- [ ] **Read-only global bootstrap layer:** Project the existing global materialization into enabled and non-enabled sessions by default, so even one-shot work starts carrying established cross-project facts, preferences, routing, and conventions. The global scope is the highest-value, lowest-cost half of the memory, while writing carries the protocol and curation tax; making the read side unconditional gives continuity without enabling mutation.
  - Boundary: project the existing durable global materialization only. No writes, transitions, patches, barriers, session/CWD initialization, or temporal-history changes. Model tools and the full protocol remain opt-in behind explicit start, and the bootstrap adds no second semantic mode.
  - Open questions: whether deferred Markdown freshness discovery must run ahead of the first inference, token cost of a stable global prefix, behavior under untrusted project contexts, and naming distinct from the existing bootstrap-run concept.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.
- [ ] **Pi Telegram submenu state analyzer:** Extend the State Flow Telegram section with a read-only analyzer view over the same diagnostics `/state-flow-status` already reports (branch mode, temporal head and hot depth, scope keys, retained tails, artifact freshness, publication). The operator deliberately deferred this beyond the 0.9.0 control surface.
  - Boundary: presentation only. Reuse existing status diagnostics; no new semantic mode, and never mutate state from the analyzer view.
  - Status: candidate, not scheduled. Do not start without a dedicated release contract.

## Deferred host integration

- [ ] **Native default session continuation:** Integrate the existing read-only recommendation, exact-selection, and rehydration contracts before Pi creates `SessionManager`, while preserving explicit new/resume and native-picker precedence, truthful notices, and cross-process session ownership. Pi 0.84.4 exposes no suitable pre-session resolver hook, so this requires upstream support or an SDK/launcher integration. Reverify the host API before taking the item; it is not a release dependency.
