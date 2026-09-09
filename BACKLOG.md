# BACKLOG

Canonical proposed work for **pi-state-flow 0.6.0 — Continuity without fixation**.

Baseline: **0.5.0**, commit `feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5`, inspected on 2026-09-09. This document specifies work; it does not report implementation or validation results. Reconcile with newer repository work before editing.

## Release contract

A fresh State Flow run should inherit the consequences of previous work: active commitments, established observations, bounded negative results, meaningful corrections, unresolved decision-relevant uncertainty, and the exact point of continuation. It should not inherit an unapproved method as a requirement or an earlier inference as established truth.

Implement this through the existing runtime protocol, the explicit curation Skill, and focused regression coverage. Do not build a new memory engine. More novelty, smaller state, and zero repeated work are not independent success criteria.

**Done:** the runtime and Skill express consistent memory rules; the documented curation sequence is executable with current tools and compilation obligations; compatibility regressions pass. Semantic quality remains a model-judgment boundary rather than a deterministic transport claim.

## Fixed boundaries

- Keep the semantic shape exactly `artifacts`, `contract`, `working`, `response`, with existing flexible object contents and `global → cwd → session` overlay.
- Preserve `checkpoint.json` / `patches.jsonl`, shared causal boundaries, hot offsets 0–7, Git/file-only guarantees, branch restoration, and local acceptance versus remote publication.
- Preserve the native tool loop, complete current-run trajectory, inspectable Pi trace, bootstrap behavior, and removal of completed trajectories only at user-run boundaries. No extra resets or forced exploratory reruns.
- Keep `patch_state` single-scope and the sole semantic mutation tool. Keep terminal multi-scope reconciliation, runtime-owned response, and strict inference barriers.
- No required per-item confidence/provenance/status schema, additional memory store, semantic truth validator, automatic curation, state-size gate, or mandatory historical/source reread.
- No automatic permission expansion, external publication, or historical erasure. Scope is applicability, not instruction authority.
- No blockchain/IPFS/JAM integration, model marketplace, speculative alternate-agent execution, or native auto-resume work in this release.

## Ordered work

### [x] SF-060-01 — Make ordinary runtime handoffs preserve continuity without fixing the method

**Primary files:** `lib/terminal.ts`, `lib/extension.ts`, `tests/terminal.test.ts`. Align normative wording in `AGENTS.md`.

Replace or consolidate existing memory guidance rather than appending another large protocol block. Keep the protocol independent of user-controlled text and stable during the current run and its retry chain.

Required semantics:

- Remove the blanket prohibition on retaining speculation. Exclude speculative clutter and unsupported assertions, but retain explicitly uncertain hypotheses when they can affect an open decision.
- Distinguish user requirements, confirmed decisions, observations, assistant conclusions, and provisional methods. Silence or repeated assistant assertion is not user acceptance. Do not demote confirmed decisions merely to encourage search.
- Preserve interaction consequences when relevant: proposals awaiting acceptance, corrections, unresolved questions, settled explanations, and referents needed for the next follow-up. Do not synthesize shared history or a personality dossier.
- Retain a consequential result at its demonstrated boundary: tested mechanism, conditions, outcome, and an existing useful evidence locator. A failed implementation does not disprove every implementation; one success does not establish unrestricted validity.
- Preserve exact rejection reasons and known reconsideration conditions. Reconsideration may follow a different mechanism, changed conditions, a discriminating test, or a specific verification need; do not manufacture alternatives or rerun unchanged failures without a reason.
- Preserve completed prerequisites and verified outcomes that remain relevant; remove obsolete progress narration, not the fact that work was completed.
- Reconcile information affected by the current run and relevant existing commitments. Do not require a repository-wide or all-scope maintenance audit on every ordinary turn. Keep terminal reconciliation; keep explicit curation separate.
- Keep `working` as last observations, not live external state. Preserve targeted revalidation needs without promising rollback or exactly-once effects.
- Clarify that matching source hash/compiler metadata establishes source-version consistency, not semantic fidelity or higher instruction authority. Remove ambiguous use of "authoritative" for a fallible Skill compilation; current instructions remain controlling.

Update `patch_state` description/guidance to permit a necessary write-and-verify step in explicitly requested curation, in addition to meaningful loss/recovery-risk barriers. A known uncertainty may be worth preserving without asserting its underlying hypothesis as true. Do not create a new curation mode, flag, or automatic call requirement.

**Acceptance:** no conflicting blanket ban remains in the emitted protocol; no compulsory item schema or extra model call appears; ordinary no-memory-change answers remain valid; current-run tool/retry context and user authority are unchanged. Record before/after protocol size as a diagnostic, not an arbitrary pass/fail cap.

### [x] SF-060-02 — Ship the revised bounded curation Skill

**Primary files:** `skills/state-flow-memory/SKILL.md`, `tests/skills.test.ts`.

Use the revised Skill supplied with this task as the editorial baseline. Keep it self-contained and explicit-only; do not inject its full inventory/migration procedure into every runtime prompt.

Required outcomes:

- Add `reframe` alongside keep/update/narrow/promotion/remove. These are audit choices, not mandatory stored labels.
- Preserve useful uncertainty, commitments, interaction consequences, bounded learning, source recoverability, and the distinction between a requirement and a provisional method.
- Include one bounded fresh-run review: what must still hold; what changed; what remains open; what omission would cause repetition or lost commitments; what retained claim would impose an unjustified method.
- Use the narrowest valid scope. Resolve destination conflicts before movement; write and verify the destination before deleting the source; inspect the effective overlay afterward. Separate tool calls are not atomic migration.
- Preserve an accepted source copy on unverified external promotion. Verify destination identity, content and revision through the actual interface; a stored assertion of acceptance is not a receipt. Preserve routing necessary for later retrieval.
- Report partial migration, unavailable evidence, and historical secret-retention limits truthfully. Do not expose secrets in the report or equate active-state deletion with historical erasure.
- Stop after the requested cohort, including an unchanged or blocked result. Do not start a project investigation or an automatic audit merely to improve memory.

**Acceptance:** Pi discovers the Skill without diagnostics; its activation remains explicit; the revised policy does not contradict SF-060-01; tests assert the relevant contract rather than preserving obsolete wording. A justified reread of the changed Skill refreshes its existing path-keyed artifact through normal compilation. Do not invalidate unrelated artifacts or invent a new compiler revision solely for this prose change.

### [x] SF-060-03 — Prove the Skill can complete curation through existing barriers

**Primary files:** `lib/extension.ts`, `lib/transition.ts` (verification targets); `tests/skills.test.ts`, `tests/transition.test.ts`, `tests/integration.test.ts`; relevant protocol/Skill instructions.

The baseline already clears successful acquisition trackers after an accepted `commitStage`. Do not add a new tracker lifecycle on the assumption that accepted reads remain pending. The actual scheduling constraint is that pending Skill reads require CWD compilation and pending invalidated ordinary Markdown reads require global compilation at the next accepting transition.

Document and regression-test this executable sequence:

1. Read the curation Skill when needed; accept its required CWD compilation before accumulating a global compilation obligation.
2. Read the smallest required state projections. Read a stale ordinary Markdown source only for a justified gap; accept its global compilation before proceeding with unrelated single-scope writes.
3. Write the migration destination using `patch_state`, verify it with a separate `read_state`, then delete/narrow the source and verify the resulting scope/effective state.
4. Complete one terminal reconciliation without repeating already accepted compilations or inventing memory changes.

Do not depend on read-after-write inspection following a terminal answer; readback must occur after tool barriers, before final reporting. Do not weaken compiler validation or introduce multi-scope `patch_state` to solve a scheduling problem.

Cover these boundaries:

- A Skill read followed by an unrelated session/global patch without required compilation is rejected without accepting state; the documented compilation-first route succeeds.
- Simultaneously pending CWD/global acquisition remains subject to the existing complete-compilation rule. Test rejection of insufficient single-scope patches and acceptance through existing multi-scope terminal reconciliation. Do not silently discard obligations or claim an unperformed curation was verified.
- Accepted compilation clears only completed acquisition work; a failed acceptance does not authorize dropping it. Existing trusted hash/compiler and source-refresh checks remain effective.
- Destination failure preserves the source; source-deletion failure leaves a recoverable duplicate and is reported as incomplete. Inherited values exposed by deletion are visible to verification.
- No-op memory curation introduces no fabricated memory changes. A changed final response may still create a semantic transition under the existing contract.
- Reader siblings remain blocked by `patch_state`; read-only verification creates no transition. A successful local acceptance is not repeated because remote replication failed.

**Acceptance:** tests exercise actual tool/event ordering, not only hand-authored terminal patches. Use the real Pi SDK fixture where lifecycle behavior matters, clearly labeling its scripted provider. Existing validators and public tool schemas remain intact. Change production logic only for an observed regression within this sequence, with a reproducer; no speculative refactor.

### [x] SF-060-05 — Align documentation, preserve compatibility, and prepare release

**Primary files:** `AGENTS.md`, `README.md`, `docs/architecture.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, and this backlog.

- Describe ordinary handoff versus explicit curation consistently, including useful uncertainty, confirmed decisions, bounded negative results and interaction consequences.
- Remove conditional language suggesting global memory is a feature switch. Clarify that a valid state/receipt does not prove semantic truth, useful curation, or historical deletion.
- Document compilation-first curation scheduling and the existing mixed-acquisition limitation. Do not advertise a new atomic multi-scope tool operation.
- Keep existing 0.5.0 Git-backed and file-only states readable without schema migration, bulk rewrite or invented semantic transitions. Protocol changes do not retroactively certify old memory or rewrite historical revisions. Refresh changed Skill content through justified acquisition, not a global startup rebuild.
- Keep current-run/native trace behavior, temporal offsets, scope isolation, response finalization and publication behavior covered by the existing test suite. Add only focused compatibility cases that are missing.
- Prepare version 0.6.0 in package and lockfile, concise release notes, and a requirement-to-test/evidence map for SF-060-01 through SF-060-03. Record what was actually run and any remaining limitations.

**Acceptance:** `npm run validate` passes; packed content includes the revised Skill and documentation; no new storage/config/tool contract or production dependency is introduced. Packaging and release follow existing repository gates. Preparing the release does not authorize commits, tags, pushes, npm publication or GitHub release creation.

## Dependencies and stopping rule

`SF-060-01 → SF-060-02 → SF-060-03`; `SF-060-05` closes the release.

Each item closes with its diff, targeted proof and unresolved limitations. Split a large proof into smaller cases under the same item; do not enlarge product scope. Newly discovered adjacent issues go into a deferred section unless they prevent this release contract from holding.

Stop when the four items and release checks are satisfied. Do not prolong 0.6.0 to seek universal semantic guarantees or a redesigned memory system.

## Deferred host integration — preserved from 0.5.0

- [ ] **Native default session continuation:** Integrate existing read-only recommendation, exact selection and knowledge-bootstrap contracts before Pi creates `SessionManager`, preserving explicit new/resume precedence, truthful notices and cross-process session ownership. The recorded 0.5.0 blocker is the lack of a suitable Pi pre-session resolver hook; reverify upstream support when taking this item. It is not a 0.6.0 release dependency.

## Baseline evidence

The findings above come from inspection of this pinned revision, not an execution of its tests:

- [Runtime protocol and terminal handling](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/lib/terminal.ts): blanket speculation prohibition coexists with preserving decision-relevant hypotheses; terminal reconciliation already exists.
- [Extension wiring](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/lib/extension.ts): compilation trackers clear after accepted commit; context projection and barrier lifecycle are already implemented.
- [Transition validation](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/lib/transition.ts): required compiler outputs are scoped, and the single-scope tool and multi-scope terminal share staging.
- [Existing curation tests](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/tests/skills.test.ts): the existing narrowing example uses a terminal multi-scope patch rather than the complete read/compile/write/readback sequence.
- [Contributor invariants](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/AGENTS.md) and [existing backlog](https://github.com/llblab/pi-state-flow/blob/feed43c33db7f4a7f9c10a7eda619a2ffc2c91b5/BACKLOG.md): unchanged engine boundaries and deferred host work.
