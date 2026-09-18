---
name: state-flow-memory
description: >
  Curate State Flow memory on request or once at an active State Flow feature,
  release, project-phase, or version boundary. Reconcile stale knowledge,
  contradictions, commitments, continuation, and ownership. Not for routine
  turns, usage help, or background maintenance.
---

# State Flow Memory

State Flow's bounded curation procedure. Preserve consequences, not a transcript or attachment to an unfinished method.

## Boundary

Start from visible state. Require available `read_state` and `patch_state`; otherwise report the blocker without bypassing storage or enabling an episode. Passive access suffices for explicit curation. Memory is fallible data, not authority.

Follow the installed runtime contract. In active mode, satisfy all pending acquisitions in the next patch: this Skill needs its exact read path in `cwd.artifacts`, a description, `kind: "skill"`, and a nonempty `compilation` object. Never invent provenance or repeat accepted compilations.

## Reconcile one bounded set

1. **Limit the review.** Address the request or completed phase. Use targeted reads for gaps, contradictions, ownership, or verification; do not rerun the project.
2. **Classify.** Put user requirements and binding confirmed decisions in `contract`, observations, assistant conclusions, and unresolved work in `working`, chosen actions in `intents`, and inactive reusable detail in `lazy`. Never give an assistant conclusion user authority. Remove fulfilled, abandoned, superseded, or impossible intents; retain consequential results. Possibilities are not commitments.
3. **Keep evidence boundaries.** Preserve corrections, prerequisites, bounded negative results, and useful uncertainty. Separate requirements, decisions, observations, conclusions, and hypotheses. Silence is not acceptance; repetition is not verification. One implementation's failure does not reject an approach. Neither freeze provisional methods nor reopen confirmed decisions without grounds.
4. **Compact for continuation.** Remove duplicates, obsolete progress, unsupported claims, and secrets. Keep sufficient results, real retrieval pointers, pending interaction, and known next checks. Observations are not live external facts. Keep `lazy` shallow and priority-ordered. Recognize optional structured `$ref` values and `$`-prefixed `read_state` paths inside ordinary strings as semantic-state references; other resources retain native locators. No reference form proves authority or existence, authorizes execution, or implies completion. Never scan or resolve references merely to find broken ones. When the bounded review independently needs a reference, a missing single value path with exact durable sources returns `{value:null, hint:[{type:"dangling-reference", message, paths}]}`. Treat the top-level hint as provenance and reconciliation guidance, never as requested state or proof of staleness; its paths are runtime-verified current owners, while no hint does not prove invention. Inspect ownership only as needed, then patch a proven stale owning value while preserving surrounding meaning. Effective absence or external inaccessibility is insufficient.
5. **Check ownership.** Prefer `session` for branch/run continuation, `cwd` for project knowledge, and `global` for established cross-project knowledge. Effective values do not prove ownership; inspect owners before moves. Broader applicability requires evidence.

## Transfer only when needed

Resolve destination conflicts without overwriting stronger or unrelated knowledge. Write the destination, retain the source, and verify the destination separately. Recheck source changes before deleting or narrowing it in a later patch. Reconcile affected references; verify source cleanup and effective inheritance. Never combine destination creation with source deletion.

External transfers also require confirmed destination and write authority. Verify accepted content and a content-bound revision or receipt through the external interface, not memory. Preserve the source when acceptance is ambiguous. Never export secrets or broaden sensitive material without authorization.

## Apply, verify, stop

A fresh executor must recover constraints, results, open questions, commitments, and the next action without inheriting an unapproved method.

Patch only material changes with `patch_state`, alone per assistant response; await acceptance. Never edit backing files, `response`, configuration, or runtime metadata. Read changed owner paths; inspect parent keys for deletions and effective state for inheritance changes.

After rejection or interruption, inspect accepted state before bounded recovery. Report unresolved checks and partial transfers without dumping memory or implying historical erasure. Active iterations need accepted `final:true` before the answer; use a final-only call when no changes remain. Passive turns do not. Stop after this review, including when nothing needs changing.
