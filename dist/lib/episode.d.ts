import { type InactiveMode, type Snapshot } from "./snapshot.ts";
export declare function startEpisode(bootstrap: boolean): Snapshot;
/** Re-enable a branch checkpoint without discarding its runtime config or provenance. */
export declare function resumeEpisode(snapshot: Snapshot, bootstrap: boolean): Snapshot;
/** Select an inactive mode for only this branch; durable defaults and session history remain intact. */
export declare function deactivateEpisode(snapshot: Snapshot, mode: InactiveMode): Snapshot;
/** Apply one user-run boundary while preserving checkpoint-owned runtime state. */
export declare function prepareRun(snapshot: Snapshot, prompt: string): boolean;
/** Retain the full prompt only while its run remains recoverable and unfinished. */
export declare function completeRun(snapshot: Snapshot): void;
