import { emptySnapshot } from "./snapshot.js";
export function startEpisode(bootstrap) {
    const snapshot = emptySnapshot(true);
    if (bootstrap)
        snapshot.meta.bootstrap = true;
    return snapshot;
}
/** Re-enable a branch checkpoint without discarding its runtime config or provenance. */
export function resumeEpisode(snapshot, bootstrap) {
    const next = structuredClone(snapshot);
    next.config.enabled = true;
    if (bootstrap)
        next.meta.bootstrap = true;
    return next;
}
/** Disable only this branch; durable defaults and session history remain intact. */
export function stopEpisode(snapshot) {
    const next = structuredClone(snapshot);
    next.config.enabled = false;
    return next;
}
/** Apply one user-run boundary while preserving checkpoint-owned runtime state. */
export function prepareRun(snapshot, prompt) {
    snapshot.meta.specification = prompt;
    snapshot.meta.validation = undefined;
    return true;
}
/** Retain the full prompt only while its run remains recoverable and unfinished. */
export function completeRun(snapshot) {
    delete snapshot.meta.specification;
}
