# Pi SDK compatibility

This matrix records exact tested dependency stacks, not the version of an operator's running Pi process. Package peer ranges admit `^0.84.4 || ^0.85.1`; keep Pi, AI and agent-core on a matching release line. Mixed-version stacks and later releases are not separate test evidence.

## Tested matrix

The compatibility checks use Linux/x64, Node 26.8.1, Git 2.55.0, TypeScript 7.0.2 and Node types 26.4.0.

| Pi / AI / agent-core | SDK's pi-tui / TypeBox | Typecheck / import | Full suite |
| --- | --- | --- | --- |
| 0.84.4 / 0.84.4 / 0.84.4 | 0.84.4 / 1.3.7 | Pass / pass | 417/417 |
| 0.85.1 / 0.85.1 / 0.85.1 | 0.85.1 / 1.3.7 | Pass / pass | 417/417 |

The first row is the repository-local stack. The second used a disposable copy of the same working source, with read-only dependency links to the already installed 0.85.1 SDK and its actual AI/agent-core/pi-tui graph. All commands exited zero for the accepted results. The repository lockfile still resolves 0.84.4; broadening its root peer metadata did not install or upgrade dependencies. No live Pi process, installation, production session or state store was modified.

Both stacks passed `npm run validate` after adding the four [fatal-writer interruption witnesses](temporal-acceptance.md#fatal-writer-interruption). No runtime correction was needed: runtime SHA-256 remains `ce820cd33c34c4c882c11fc55e93f3914cfc8dffae57683e32cdcaa70f225cd2` from the [context-copy correction](performance.md#context-projection-and-trajectory-selection). Sorted `index.ts`, `lib/*.ts` and `tests/*.ts`, framed as path + NUL + bytes + NUL, now yield `1c5fafc1433631fed33177381e925eeeca52827932ba327690f615d2a4db81ba`. Copied/original source, runtime, test and package bytes were checked unchanged through validation, along with both selected dependency-resolution graphs and their manifests. These hashes do not cover every installed binary or environmental influence. The [benchmark workload fingerprint](performance.md) remains `b861fae36798bf76f56f411cc654c70fc948597bb84cc7a422c83f69ba1ca3e9`. Subsequent [matched runtime-performance controls](performance.md#matched-final-candidate-controls) use the 0.84.4 graph only, not a two-SDK timing comparison. The earlier fork/context witnesses remain included; these results do not replace separate integrated-candidate acceptance.

### Post-measurement integrated acceptance

After the nine-invocation performance series, inline review traced accumulated Git/CAS, provenance, worker ownership, fork/recovery, Stop/context and discovery changes against their callers and negative/native witnesses, without a confirmed blocker in that inspected closure. Separate `state-flow-integrated-0844` and `state-flow-integrated-0851` Runs repeated `npm run validate`: each passed 417/417 with no failed, cancelled, skipped or todo tests, plus typecheck and import-check, and actual command exit zero. Full captures are 47,957 and 47,950 bytes. All 78 selected runtime/test/package files and both actual dependency graphs remained unchanged; documentation is separately reviewed rather than represented by that source hash.

The twenty-property map resolves its quoted witnesses; that structural check is not exhaustive semantic proof. Domain validation reports 31 source files/133 acyclic local edges and no reverse entrypoint imports, with 25 existing header warnings. Context validation reports zero errors/five warnings. The package dry run includes 44 files and no tests. This accepts the local candidate within the documented synthetic/Linux/SDK boundaries, not arbitrary-host compatibility, production-incident attribution, publication permission or remote release-CI success. That checkpoint preceded the final compaction/status slice and its intentional 0.10.0 version alignment.

The final slice adds seven compaction policy/race tests and two native lifecycle witnesses, bringing the complete repository-local 0.84.4 suite to 426/426 with typecheck/import-check. On 0.85.1, all affected policy/status and native compaction/tree tests plus typecheck pass; the operator declined a redundant second full-suite repetition after this focused equivalence evidence. Native completed-history compaction preserves full JSONL/tree/state/UUID while shortening active/resumed entries without another model summary; threshold compaction before the first patch remains Pi-owned. Package version is 0.10.0. Remote release CI remains authoritative for the tagged tree.

Matching versions do not imply one physical dependency instance. Before/after resolution walks retain separate root and SDK-local 0.84.4 AI/agent-core copies and three TypeBox 1.3.7 locations in the repository installation. The first row describes that actual graph, not a deduplicated installation. The disposable 0.85.1 copy explicitly shares the SDK's AI/agent-core/pi-tui instances. Record canonical resolution edges as well as versions for comparisons; no dependency installation was changed to force a verifier assumption.

The focused parent-traversal and barrier cohort passed 3/3 on each stack. The earlier 0.85.1 native cohort passed 10/10: large state/answers, selected-tree restoration, quit/reload push ownership, ordinary/bootstrap mid-tool Stop, compaction/tree/restart, scoped barriers, historical reads, and sibling-tool rejection. The full suite includes those witnesses plus benchmark, persistence, provenance, migration and concurrency contracts; tests are available in a source checkout, not the published runtime package.

## Public host seams

Inspect the installed package's `dist/core/` implementations and declarations alongside upstream [SDK documentation](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/sdk.md). Both tested stacks retain these seams:

- `session-manager.js` / `session-manager.d.ts`: Read-only extension context exposes `getLeafEntry()`, `getEntry(id)` and each entry's `parentId`. Both lookups use the native ID map; `getBranch()` instead walks to the root and reverses a newly allocated path. State Flow now uses that public parent traversal for preflight without deleting or replacing native history.
- `agent-session.js`, `_handleAgentEvent()` / `_installAgentToolHooks()`, and agent-core's `agent-loop.js`: `message_end` extension handlers run before session persistence; the awaited event then appends the accepted assistant message before tool preflight. Inspect that synchronized current assistant, not a presumed last persisted assistant inside `message_end`. The native sibling-tool regression is the executable barrier witness.
- `sdk.js` and `extensions/runner.js`, `emitContext()`: Pi connects context transformation to the extension runner, which first `structuredClone`s native messages. State Flow projection runs after that host copy. Reducing extension traversal cannot make total inference work independent of history size.
- `agent-session.js`, `prompt()` / `reload()` / `dispose()`: The system prompt is composed at `before_agent_start`; Stop can change tools/projection but not that already composed prompt for the current run. Reload awaits `session_shutdown` before replacement. Bare disposal invalidates/disconnects without emitting shutdown; use the [embedding contract](architecture.md#embedding).
- `agent-session-runtime.js`, `teardownCurrent()`: Owner-driven new/resume/fork aborts the outgoing session, awaits shutdown, then disposes and creates the replacement. Active-push witnesses now cover new, same-file resume and fork teardown before invalidation, alongside quit and actual reload. Correct teardown does not imply successful fork restoration.
- `sdk.js`, `createAgentSession()`: Session selection precedes default resource/extension loading. No extension-only pre-session resolver seam was established; native default continuation remains an [external integration boundary](architecture.md#session-continuation).

These observations establish the specific seams used here, not compatibility with every Pi UI mode, extension combination, provider or operating system. Native tests use deterministic faux inference, temporary sessions/stores and local remotes. An installed SDK version does not fingerprint a still-running host. Actual-process incident attribution remains unproven; final comparable measurements and integrated acceptance remain in [BACKLOG.md](../BACKLOG.md).

## Native replacement witnesses

`tests/pi-harness.ts` now constructs a public `AgentSessionRuntime` from its existing isolated sessions and coherent CWD-bound services, forwarding complete session-start metadata and binding each replacement. No private host hook or production runtime change was needed. The three `tests/integration.test.ts` replacement witnesses pass on both SDK stacks and require:

- An accepted multi-scope patch and answer to supersede a still-running activation push.
- The exact shutdown reason/target, child exit and a claimable lease at `setBeforeSessionInvalidate()`, before a successor can start.
- Byte-identical outgoing JSONL and session checkpoint/tail/config/meta, the same selected leaf, and exact cold state at the accepted revision.
- An empty private layer plus inherited shared state for configured new sessions, and exact selected state/identity for same-file resume.
- No old-generation relaunch or queue writes after replacement; only a valid successor attempts the exact pending target and acknowledges its controlled child result.

**Native fork replacement now creates a child-owned session copy over current shared memory.** The active-push case forks before the first user request: private state is empty at that selected origin, not the parent's later accepted private work. Current global/CWD state remains visible, and the new child publication target descends from the retained parent target. Native session naming still does not prove the child JSONL is already persisted when its prefix contains no assistant.

Further native witnesses cover nonempty selected private state versus newer parent/shared state, retained native prefix and checkpoint/tail data, owned reload/resume, independent child writes and aligned post-origin history. Disabled sources remain disabled and copied parent Stop projection cannot reappear after child reload. Header UUID/CWD mismatches leave storage and selection unchanged; Start retries the exact source in the same loaded fork when evidence is corrected. Selecting inherited pre-origin pointers is unavailable, not permission to fall through to an older disabled marker and erase child state. That last witness failed with `true !== false` before the targeted ownership-aware recovery correction.

The fork-specific 13-test focused cohort covers these native cases plus runtime copying/CAS/file-expiration and header safety. An initial prefix assertion compared persisted JSON with in-memory objects containing explicit `undefined` fields; it was corrected to compare native persisted entries, without changing runtime behavior. The earlier outgoing-shutdown falsifier failed before invalidation with `null !== 'SIGKILL'`. Controlled push children do not prove external delivery; arbitrary cross-CWD replacement and every UI mode remain outside these witnesses. Ordinary inference abort retains accepted patches for same-session continuation and has no new immediate-enqueue requirement. See [fork support and limits](usage.md#fork-support-and-limits) and the [copy contract](fork-contract.md).

## Isolated validation procedure

Keep the live host and repository dependencies unchanged:

1. Copy the intended current source, including retained uncommitted files and tests, to a fresh temporary directory. Do not substitute baseline `HEAD` for a dirty candidate. Give the copy its own synthetic Git `HEAD` for benchmark source-identity checks; never copy production session/store data.
2. Create a real `node_modules` directory in the copy. Link the existing development dependencies, then link `@earendil-works/pi-coding-agent` to the selected installed SDK and AI/agent-core/pi-tui to the dependencies actually resolved by that SDK. Do not use `--preserve-symlinks` or install into the live package. Verify the SDK and extension resolve the same selected dependency instances.
3. Resolve import-only package manifests with `findPackageJSON(name, pathToFileURL(ownerManifest))`, not `require.resolve(name)`. Record canonical manifest paths, package names/versions and hashes before and after testing. For example, run the following inside the copy:

```bash
node --input-type=module <<'JS'
import { findPackageJSON } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const owner = pathToFileURL(`${process.cwd()}/package.json`);
for (const name of ['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-tui']) {
  const path = realpathSync(findPackageJSON(`@earendil-works/${name}`, owner));
  console.log(path, JSON.parse(readFileSync(path, 'utf8')).version);
}
JS
```

Use a fresh `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `GIT_CONFIG_NOSYSTEM=1` and a temporary `GIT_CONFIG_GLOBAL` containing only a synthetic commit identity and disabled commit signing. Fixtures already supply in-memory credentials, no model-catalog refresh and explicit resource/session roots. Leave fixture-local Git hooks enabled: tests intentionally use temporary `pre-receive`/`post-receive` hooks.

Inside that prepared copy, the compatibility checks are ordinary project commands:

```bash
npm run typecheck
npm run check
node --experimental-strip-types --test \
  --test-name-pattern='tool preflight walks only|patch_state is the only tool|real Pi executes only patch_state|replacement closes its outgoing publisher' \
  tests/extension.test.ts tests/integration.test.ts
npm test
```

`npm run validate` combines typecheck, the full suite and import smoke for subsequent candidates. Retain actual command exits, complete logs and source/dependency identities; a filtered command succeeding does not replace the full suite.

### Rejected setup and correction

The first 0.85.1 full run passed 395/397 because the temporary global Git config incorrectly set `core.hooksPath` to an empty directory. This disabled two fixtures' hooks: prepared receipts no longer observed the synthetic post-push write, and file-to-Git adoption no longer observed the intentionally pending push. The same two failures reproduced on 0.84.4 with that config. Removing only the temporary override made both witnesses pass on both SDKs, followed by 397/397 on 0.85.1. No runtime or test correction was needed; the failed run is not an SDK incompatibility or a successful full-suite result.
