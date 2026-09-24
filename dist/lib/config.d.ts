export interface StateFlowConfig {
    /** Canonical State Flow repository. SDK callers may still override it explicitly. */
    directory: string;
    autoStart: boolean;
    passiveBootstrap: boolean;
    passiveTools: boolean;
    /** Opt-in local capture of rejected patch attempts and unresolved terminal drafts. */
    logging: boolean;
    /** Show successful patch_state arguments in the interactive tool row. */
    showSuccessfulPatches: boolean;
    historyLimit: number;
}
/** Read the repository-global config once at extension load/reload. Missing config uses defaults; invalid config never falls back. */
export declare function loadStateFlowConfig(agentDir?: string, repositoryRoot?: string): StateFlowConfig;
