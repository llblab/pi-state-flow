# BACKLOG

Completed release work belongs in [CHANGELOG.md](CHANGELOG.md). No implementation item remains open for 0.7.0.

## Deferred host integration

- [ ] **Native default session continuation:** Integrate the existing read-only recommendation, exact-selection, and rehydration contracts before Pi creates `SessionManager`, while preserving explicit new/resume and native-picker precedence, truthful notices, and cross-process session ownership. Pi 0.84.4 exposes no suitable pre-session resolver hook, so this requires upstream support or an SDK/launcher integration. Reverify the host API before taking the item; it is not a 0.7.0 release dependency.
