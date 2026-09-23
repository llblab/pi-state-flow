# Pi SDK compatibility

State Flow requires matching Pi SDK packages at `>=0.87.0` without an upper peer-dependency bound. Keep `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` on the same release line.

The peer range permits newer releases so npm does not impose an artificial ceiling. It does not claim that every future SDK release has been tested. Revalidate the public host seams below when adopting a new Pi release line.

## Tested stacks

The current repository-local stack uses Linux/x64, Node 26.8.1, Git 2.55.0, and Pi SDK 0.87.0.

| Pi SDK stack | Validation | Evidence status |
| --- | --- | --- |
| 0.87.0 | Build, typecheck, import, package dry-run; 472/472 tests in each of five ordinary and five `push.negotiate=true` isolated-Git runs | 0.18.1 candidate source-bound acceptance (2026-09-23); not a live-provider or cross-platform claim |
| 0.84.4 | Historical full-suite baseline | Unsupported by State Flow 0.17.0 |
| 0.85.1 | Historical full-suite baseline | Unsupported by State Flow 0.17.0 |

Only exact matching stacks that were actually exercised are test evidence. Mixed SDK versions and untested newer releases are permitted by package metadata but remain unverified.

## Public host seams

State Flow depends on these public Pi SDK behaviors:

- Extension lifecycle events and branch metadata for start, stop, reload, resume, fork, and tree navigation.
- Read-only session parent traversal through `getLeafEntry()` and `getEntry(id)`.
- `message_end`, actionable `turn_end`, `agent_before_settle`, and `agent_settled` ordering around accepted assistant messages.
- Canonical session context, `ContextEditEntry`, ordinary context transformation, and `context_with_system` extension boundaries.
- `getContextUsage()` and native compaction hooks.
- Sequential tool execution and tool-call preflight.
- Session replacement awaiting outgoing shutdown before invalidation.

Compatibility with those seams does not prove every UI mode, provider, operating system, extension combination, or future SDK release.

## Pi 0.87.0 feature applicability

This inventory follows the [tagged release](https://github.com/earendil-works/pi/releases/tag/v0.87.0), its linked [extension contract](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/extensions.md), [session format](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/session-format.md) and [image limits](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/models.md#image-input-limits). It separates extension-owned behavior from inherited SDK behavior. The scoped 0.87 applicability pass is complete for the pinned scripted SDK stack; this is not a release, live-provider or cross-platform readiness claim. Open implementation work belongs to [BACKLOG.md](../BACKLOG.md).

- **Actionable `turn_end` / `agent_before_settle` — adapted and native-tested.** A companion can append context-bearing drafts and request continuation without another `before_agent_start`. State Flow now projects accepted memory on every enabled request even after completion removed `specification`; it neither resurrects that prompt nor creates a second continuation owner. The native boundary-continuation pair checks actual event fields, accepted state/response before and after another patch, model-visible tool declarations, retained runtime checkpoints, one user-run preparation and the exact provider-call count.
- **Canonical `SessionManager` and `ContextEditEntry` — native-tested without an extra projection owner.** Native user replacement, assistant/custom-message omission and tool-result replacement inside the tool loop reach the provider correctly. Tree selection applies only branch-relative edits; fixture reload preserves the edited projection. Raw trace bytes remain intact and selecting a pre-runtime branch does not overwrite accepted semantic files. State Flow neither assigns `agent.state.messages` as history authority nor reconstructs omitted raw entries; trajectory edits do not authorize rewriting separately owned semantic memory. Pi retains ownership of string-replacement normalization, protection of unseen boundary input and edited-usage freshness; no alternative transcript or accounting implementation is added.
- **Conversation `context` versus full `context_with_system` — adapted and native-tested.** State Flow supplies protocol via `before_agent_start.systemPromptOptions.sections.state_flow`, no longer forcing the entire prompt. Companion before-run sections and full-system additions now survive active/passive requests and tools; conversation hooks exclude systems while full-system hooks include them. Tests inspect model-visible declarations and read evidence, not just scripted execution. Explicit foreign forced prompts still override per-request system additions by Pi's contract. Native section diffs remove/reinstate State Flow's protocol on subsequent user requests after Stop/Start.
- **Mid-tool protocol-mode refresh — adapted and native-tested.** The next request after mid-read Stop, passive Stop, mid-read Start or accepted-boundary Stop/continuation now receives current protocol without another user-run preparation. `context_with_system` projects only the owned section; it keeps source frames immutable, conversation identities/order, foreign sections/content/tools and explicit forced-prompt precedence. Unchanged effective protocol is a no-op, including native later system deltas. No missing system frame, lifecycle field, controller or State Flow persistence format is invented. Retained red-to-green tests supersede the earlier defect-only diagnostic.
- **Deferred work from `agent_settled` — adapted and native-tested.** State Flow awaits its admitted native compaction's completion/error callback before returning from the settled handler. Fire-and-forget compaction previously overlapped Pi's deferred companion prompt dispatch and rejected that prompt. Native low-pressure, admitted-compaction and explicit-refusal cases now complete all settled observers before one follow-up starts, with correct memory/step and no lost or duplicate inference. Existing eligibility/leaf/generation/shutdown guards remain; backup stays at `agent_before_settle`. No new timer, queue or continuation owner is introduced.
- **Retain-none compaction — deliberately unused for State Flow-owned shortening.** Canonical memory is not a lossless replacement for the original request, images, tools or foreign custom context. Owned compaction therefore retains the complete accepted run; ordinary native manual/threshold/overflow compaction stays Pi-owned. R12/R14 native witnesses cover normalized images, steering and split-turn Stop continuation without trace rewriting.
- **Persisted retry/length/overflow omissions and edited-context accounting — inherited SDK behavior, now native-tested.** Retryable error, recoverable length and explicit overflow keep failed attempts raw while persisting omission edits; recovery and reload exclude them. Native split-turn recovery uses two summary requests within one compaction and one coding continuation. Failed attempts/summaries never advance State Flow response or semantic step. Separate accounting coverage replaces a large source message, observes reduced native usage without changing raw trace/memory, and rules out phantom recovery/compaction from stale provider counts. These are scripted SDK witnesses, not live-provider guarantees.
- **Per-model image resize profiles — SDK-owned and native-tested.** Real wide/tall PNG payloads exercise `inputLimits.images.resize` on prompt images, built-in image reads and generic tool-result images. Native model selection changes bounds from 1800×1200 to 900×600: new payloads use the smaller profile while historical user/read/generic-tool payloads remain byte-identical through later provider inputs and fixture reload. Disabled and bootstrap-enabled State Flow controls pass, alongside normalized-image steering/compaction and actual prompt/tool declarations after owned compaction. No State Flow image pipeline is introduced. Pi 0.87 describes other hard image/request-limit fields as metadata; codec byte/quality settings and provider enforcement remain upstream-owned, not independently live-provider/cross-platform certified here.
- **Removed `shouldStopAfterTurn` and changed runner/event shapes — no direct low-level migration required.** State Flow registers typed extension handlers rather than configuring an Agent termination option or calling `ExtensionRunner.emit("turn_end")`. Native SDK fixtures dispatch through Pi's `finishTurn`/`emitBoundary` implementation; the new companion tests exercise required boundary fields and draft persistence.
- **Other release fixes — inherited or outside this extension's ownership.** GIF-prefixed text detection belongs to built-in `read`; provider strict-schema defaults, cache-warming timing and crash diagnostics belong to Pi. Offline `/bug` upload behavior and prompt-template frontmatter diagnostics do not require State Flow features. No duplicate image pipeline, HTTP adapter, diagnostics service or cache scheduler is introduced. This classification is not a live-provider or cross-platform verification claim.

## Validation procedure

Validate another Pi SDK line in an isolated copy so the live extension, sessions, and runtime store remain unchanged:

1. Copy the complete candidate source, including retained uncommitted changes, into a temporary directory.
2. Install or link one matching version of `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui`.
3. Confirm all four packages resolve to the intended release line.
4. Use isolated Pi agent/session directories and synthetic Git identity; do not copy production session or State Flow data.
5. Run:

```bash
npm run validate
```

A successful focused test does not replace the full suite. Record the exact dependency graph and command exit for any compatibility claim.

For compiled public-API checks, follow `package.json.exports["."].default` (`dist/index.js`). Pi loads the separate `pi.extensions` entry (`dist/pi-state-flow/index.js`), a default-only registration shim: importing it proves extension loadability, not the presence or absence of named library exports. Check both surfaces and compare packaged Skills with their source. Documentation-only changes may reuse source-bound build/test/benchmark evidence when its actual inputs remain identical; refresh the package inventory after the final documentation edits.
