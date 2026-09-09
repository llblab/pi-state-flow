# BACKLOG

Canonical open work for **pi-state-flow**. [README.md](README.md) explains setup and behavior; [AGENTS.md](AGENTS.md) governs implementation; [CHANGELOG.md](CHANGELOG.md) records completed delivery.

## Open work

No open implementation work remains for **0.5.0**.

## Deferred host integration

- [ ] **Native default session continuation:** Integrate the existing read-only recommendation, exact session selection, and knowledge-bootstrap contracts into Pi before `SessionManager` creation while preserving explicit new/resume precedence, truthful notices, and cross-process session ownership. Blocked on a Pi pre-session resolver hook: Pi 0.84.4 selects or creates `SessionManager` before package resources and extensions load, so `pi-state-flow` cannot safely alter native CLI startup by itself. The [architecture guide](docs/architecture.md#session-continuation) records the host boundary and executable extension-side prerequisites.

## Boundaries

- Preserve unrelated repository work; commits, publication, tags, and release actions require explicit release-flow gates.
- Exercise migrations and backend adoption in temporary repositories, not production Knowledge or state data.
- File-only mode retains current/hot state, not arbitrary cold branches; unavailable exact references never authorize substituting current files for selected history.
- Changing the configured directory selects a store; it does not automatically migrate previous files or Git history.
- Knowledge semantics, automatic semantic branch merging, a second unbounded history store, and eager historical snapshot injection remain excluded.
