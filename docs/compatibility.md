# Pi SDK compatibility

State Flow requires matching Pi SDK packages at `>=0.84.4` without an upper peer-dependency bound. Keep `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` on the same release line.

The peer range permits newer releases so npm does not impose an artificial ceiling. It does not claim that every future SDK release has been tested. Revalidate the public host seams below when adopting a new Pi release line.

## Tested stacks

The current repository-local stack uses Linux/x64, Node 26.8.1, Git 2.55.0, and Pi SDK 0.84.4.

| Pi SDK stack | Validation | Evidence status |
| --- | --- | --- |
| 0.84.4 | Build, typecheck, import, package dry-run, 445/445 tests | Current full-suite baseline |
| 0.85.1 | Build, typecheck, import, full suite | Earlier compatibility baseline; not rerun for every later State Flow change |

Only exact matching stacks that were actually exercised are test evidence. Mixed SDK versions and untested newer releases are permitted by package metadata but remain unverified.

## Public host seams

State Flow depends on these public Pi SDK behaviors:

- Extension lifecycle events and branch metadata for start, stop, reload, resume, fork, and tree navigation.
- Read-only session parent traversal through `getLeafEntry()` and `getEntry(id)`.
- `message_end` and `turn_end` ordering before accepted assistant messages are reconciled.
- Context transformation through the extension runner.
- `getContextUsage()` and native compaction hooks.
- Sequential tool execution and tool-call preflight.
- Session replacement awaiting outgoing shutdown before invalidation.

Compatibility with those seams does not prove every UI mode, provider, operating system, extension combination, or future SDK release.

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
