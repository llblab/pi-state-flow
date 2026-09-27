import { type InactiveMode, type StateFlowMode } from "./snapshot.ts";
export interface StateFlowConfig {
    /** Canonical State Flow repository. SDK callers may still override it explicitly. */
    directory: string;
    /** Default mode for genuinely new sessions only; each session owns its selected mode. */
    mode: StateFlowMode;
    /** Non-active fallback for legacy `enabled:false` evidence and unavailable selections; never serialized. */
    inactiveMode: InactiveMode;
    /** Opt-in local capture of rejected patch attempts and unresolved terminal drafts. */
    logging: boolean;
    /** Show successful patch_state arguments in the interactive tool row. */
    showSuccessfulPatches: boolean;
    historyLimit: number;
}
/** Read the repository-global config once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export declare function loadStateFlowConfig(agentDir?: string, repositoryRoot?: string): StateFlowConfig;
/** Explicit modes never carry a separate passive policy: only Off stays off when inactive. */
export declare function inactiveModeFor(mode: StateFlowMode): InactiveMode;
