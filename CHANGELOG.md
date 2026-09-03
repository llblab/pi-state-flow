# Changelog

## 0.2.0: Modular runtime hardening

- Add a task-first README quick start with explicit compatibility, opt-in behavior, one-off trial instructions, and Pi package security guidance.
- Tighten the normative runtime protocol and enforce a regression-tested character budget; omit absent validation feedback from synthetic runtime context instead of serializing a redundant `null`.
- Redistribute lifecycle coverage from the former monolithic extension suite into the corresponding mirrored domain suites, leaving `extension.test.ts` focused on composition and using one shared test harness.
- Split the runtime into independent `json`, `state`, `episode`, `snapshot`, `session`, `recovery`, `status`, `context`, `skills`, `terminal`, `validation`, `transition`, and `extension` modules under `lib/`; isolate explicit episode transitions, active-branch selection and recovery, status rendering, bounded retry decisions, atomic state staging, and compare-and-swap commits; mirror each domain under `tests/`, enforce an acyclic dependency graph with cross-domain invariant tests, and reduce `index.ts` to composition and public exports.
- Register lifecycle commands in the canonical start, status, stop order.
- Centralize synthetic runtime-context construction and private validation-message filtering in the independently tested context domain, keeping user-controlled specifications out of system-prompt composition.
- Keep State Flow enabled and preserve the last committed state when terminal-validation retries are exhausted; only the transient retry chain is abandoned so the next user request can continue reliably.
- Track Skill reads through an independently tested lifecycle correlator in Pi's actual `tool_execution_start` → `tool_call` event order while retaining the mutable intercepted input reference, so later argument rewrites are attributed to the executed path.
- Discard mismatched lifecycle records defensively so a stale or reused tool-call id cannot produce false Skill acquisition.
- Bound restored iteration and validation-attempt counters before incrementing them, reject exhausted live iteration counters explicitly, and cover both safe-integer boundaries so malformed branch metadata cannot corrupt retry accounting or status output.
- Reject restored non-JSON state values such as non-finite numbers before they can break hashing or silently materialize as `null`.
- Fall back past malformed newer checkpoints to the newest valid active-branch snapshot, while still failing closed on cyclic or hostile snapshot objects when no valid checkpoint remains.
- Reject malformed three-field state shapes rather than reinterpreting them as legacy working memory, and contain failures while enumerating hostile branch entries.
- Make canonical serialization and exported patch validation reject lossy or cyclic non-JSON inputs explicitly instead of returning invalid results or silently rewriting values.

## 0.1.5: Skill attribution and state model clarification

- Attribute successful Skill acquisition to finalized `tool_execution_start` arguments, with a tested compatibility fallback to the intercepted `tool_call` input.
- Clarify that the three-field materialized handoff coexists with mutable exogenous project and runtime state that can also shape model behavior.
- Remove the obsolete `/reload` step from the usage instructions.

## 0.1.4: Release verification hotfix

- Kept npm pack lifecycle output out of release inventory JSON so Trusted Publisher releases can complete public verification and GitHub Release creation.

## 0.1.3: Trusted Publisher release automation

- Added immutable-tag GitHub Actions automation that validates the package, publishes and verifies npm through Trusted Publisher with provenance, and creates the matching GitHub Release.

## 0.1.2: Repository identity hotfix

- Aligned GitHub repository, package metadata, installation documentation, and release links under the canonical `llblab/pi-state-flow` identity.

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
