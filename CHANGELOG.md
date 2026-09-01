# Changelog

## 0.1.1: Public npm distribution

- Enabled public npm distribution for `@llblab/pi-state-flow`, including registry access and verified GitHub package metadata.
- Clarified that compiled Skill knowledge is stored persistently under `contract.compiled_skills`, never as another top-level state field.

## 0.1.0

- Added an opt-in State Flow runtime inspired by SKILL.state, with argument-free lifecycle commands, per-user-run specifications, active-branch persistence, and one materialized explicit state.
- Added native Pi tool-loop preservation: tool-bearing responses require no patch, current-run tool trajectory remains model-visible, and one terminal handoff commits state after the complete agent run.
- Added required flexible `contract` and `working` objects plus the required latest user-facing `response` string, recursive materialization, nested object-key `null` deletion, materialized-null rejection, and deterministic state compare-and-swap.
- Kept arbitrary response content outside the transcript-private `<!-- state_flow … -->` memory-patch frame; the runtime strictly anchors the frame at the start of one terminal text block, requires exactly one blank separator, reconciles materialized `response` with Pi's finalized post-handler text at `turn_end`, and routes post-handler finalization failures through the same bounded hidden regeneration chain. Documented that the frame remains observable to streaming consumers before finalization.
- Kept user-controlled turn specifications at user authority by moving their repeated representation out of the system prompt and into synthetic user runtime context, including support for empty text in image-only prompts.
- Added active-branch restoration after `/tree` navigation, clean abandonment of interrupted terminal-validation retries before the next user run, and cumulative retry accounting across intervening tool-bearing turns.
- Preserved persistent and current-run custom context from other Pi extensions, attributed Skill acquisition from finalized executed arguments after mutable tool interception, and limited accidental intermediate-envelope stripping to a structurally valid leading frame.
- Hardened recursive patch materialization so JSON keys such as `__proto__` remain ordinary own data without changing object prototypes.
- Added an explicit release file allowlist, Pi package discovery keywords, package-safe README targets, Pi/Node compatibility bounds, and a prepack validation gate so generated packages contain only runtime and human-facing release files.
- Added bootstrap migration for enabling State Flow inside an existing session, per-run specification rotation, schema-free episode-level Skill compilation in `contract.compiled_skills` keyed by exact source path, and model-owned memory optimization that reorganizes inefficient structure and deletes stale, redundant, speculative, or low-value state.
- Removed per-tool state commits, action authorization, Delta Window, observation envelopes, action ledgers, project schemas, state and patch byte caps, dynamic growth pressure, and all coupling to other extensions.
- Compressed the static runtime protocol while retaining terminal, handoff, Skill-compilation, authority, and memory-optimization invariants.
- Added stop-as-complete-episode-reset semantics, a compact accent `state-flow` plus dim `#<iteration>` status, and complete pretty-formatted state JSON output from `/state-flow-status`.
