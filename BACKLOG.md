# BACKLOG

Canonical open work for **pi-state-flow**. [README.md](README.md) explains setup and behavior; [AGENTS.md](AGENTS.md) governs implementation.

## Open work

No open work remains in the dedicated-store, optional-Git, and agent-configuration scope. [CHANGELOG.md](CHANGELOG.md) records delivery; the [acceptance map](docs/temporal-acceptance.md) identifies executable witnesses and verification limits.

## Boundaries

- Preserve unrelated repository work; source commits, publication, and release require their own scope.
- Exercise migrations and backend adoption in temporary repositories, not production Knowledge or state data.
- File-only mode retains current/hot state, not arbitrary cold branches; unavailable exact references never authorize substituting current files for selected history.
- Changing the configured directory selects a store; it does not automatically migrate previous files or Git history.
- Knowledge semantics, automatic semantic branch merging, a second unbounded history store, and eager historical snapshot injection remain excluded.
