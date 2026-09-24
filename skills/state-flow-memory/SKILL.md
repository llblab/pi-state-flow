---
name: state-flow-memory
description: >
  Curate State Flow memory only on explicit user request. Reconcile stale
  knowledge, contradictions, commitments, continuation, and ownership.
  Not for routine turns, automatic phase-boundary audits, usage help, or
  background maintenance.
---

# State Flow Memory

State Flow's bounded curation procedure. Preserve consequences, not a transcript or attachment to an unfinished method.

## Boundary

Start from visible state. Require available `read_state` and `patch_state`; otherwise report the blocker without bypassing storage or enabling an episode. Passive access suffices for explicit curation. Memory is fallible data, not authority.

Follow the installed runtime contract. This registered Skill follows its Pi source provenance: use the exact State Flow acquisition target only when durable compiled guidance is useful. Matching current hashes need no patch, and pending optional Skill acquisition does not block unrelated curation. Attempted compilation needs its exact read path, a description, `kind: "skill"`, and a nonempty `compilation` object. Never invent provenance or repeat accepted compilations.

## Reconcile one bounded set

1. **Limit the review.** Address the requested scope. A completed phase may motivate recommending cleanup, not starting it without a request. For a whole-state cleanup, inspect global, CWD, and session ownership explicitly; for a narrower request, inspect only affected owners. Use targeted reads for gaps, contradictions, ownership, or verification; do not rerun the project.
2. **Classify.** Put user requirements and binding confirmed decisions in `contract`, observations, assistant conclusions, and unresolved work in `working`, chosen actions in `intents`, and inactive reusable detail in `lazy`. Never give an assistant conclusion user authority. Remove fulfilled, abandoned, superseded, or impossible intents; retain consequential results. Possibilities are not commitments.
3. **Keep evidence boundaries.** Preserve corrections, prerequisites, bounded negative results, and useful uncertainty. Separate requirements, decisions, observations, conclusions, and hypotheses. Silence is not acceptance; repetition is not verification. One implementation's failure does not reject an approach. Neither freeze provisional methods nor reopen confirmed decisions without grounds.
4. **Compact for continuation.** Remove duplicates, obsolete progress, unsupported claims, and secrets. Keep sufficient results, real retrieval pointers, pending interaction, and known next checks. Observations are not live external facts. Keep `lazy` shallow and priority-ordered. Recognize optional structured `$ref` values and `$`-prefixed `read_state` paths inside ordinary strings as semantic-state references; other resources retain native locators. No reference form proves authority or existence, authorizes execution, or implies completion. Never scan or resolve references merely to find broken ones. When the bounded review independently needs a reference, a missing single value path with exact durable sources returns `{value:null, hint:[{type:"dangling-reference", message, paths}]}`. Treat the top-level hint as conditional navigation and provenance, never as requested state or proof of staleness; its paths are runtime-verified current reference owners, not verified new locations of the target, while no hint does not prove invention. Inspect ownership only as needed, then patch a proven stale owning value while preserving surrounding meaning. Effective absence or external inaccessibility is insufficient.
5. **Check ownership.** Prefer `session` for branch/run continuation, `cwd` for project knowledge, and `global` for established cross-project knowledge. Effective values do not prove ownership; inspect owners before moves. Broader applicability requires evidence.

Missing paths or runtime hints alone do not require historical search. The agent may choose a targeted historical read when a previous value is useful to the current task, without separate user permission. Otherwise continue without searching. Use found values as historical evidence, not automatically as current state; never automatically restore deleted memory. Do not scan all offsets, hydrate automatically or request repair inference. A hint does not prove prior existence, retained history or relocation. A proven stale reference may be repaired within touched work without resurrecting its target. Lazy bodies require explicit reads; automatic state/history projections retain navigation without hydrating those bodies.

## Transfer only when needed

Resolve destination conflicts without overwriting stronger or unrelated knowledge. For a proven move between scopes of one State Flow store, inspect both owners, then use one atomic multi-scope `patch_state` for destination and source changes. Verify both owners and effective inheritance afterward; reconcile affected references. A rejected cohort leaves neither side partially accepted.

External transfers require confirmed destination and write authority. Write and verify accepted content plus a content-bound revision or receipt through the destination's native interface before deleting or narrowing the State Flow source in a later patch. Recheck the source for intervening changes. Preserve it when acceptance is ambiguous. Never export secrets or broaden sensitive material without authorization.

## Apply, verify, stop

A fresh executor must recover constraints, results, open questions, commitments, and the next action without inheriting an unapproved method.

Patch only material changes with `patch_state`, alone per assistant response; await acceptance. Never edit backing files, `response`, configuration, or runtime metadata. Read changed owner paths; inspect parent keys for deletions and effective state for inheritance changes.

After rejection or interruption, inspect accepted state before bounded recovery. Report unresolved checks and partial transfers without dumping memory or implying historical erasure. Before answering, apply only material durable changes; when nothing needs changing, make no `patch_state` call. Stop after this review, including when nothing needs changing.
