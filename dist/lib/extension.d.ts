import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPatchStateArguments } from "./protocol.ts";
import { type ModelState, type StateScope } from "./state.ts";
import { type StateFlowTelegramLoader } from "./telegram.ts";
export interface StateFlowExtensionOptions {
    agentDir?: string;
    repositoryRoot?: string;
    onRuntime?: (accessor: {
        read(offset?: number, scope?: StateScope): ModelState;
    }) => void;
    telegram?: {
        load?: StateFlowTelegramLoader;
    };
    /** Test/SDK capability override; repository config remains the Pi default. */
    passive?: {
        bootstrap?: boolean;
        tools?: boolean;
    };
}
export { formatPatchStateArguments };
export declare const PATCH_STATE_TOOL_NAME = "patch_state";
export declare const READ_STATE_TOOL_NAME = "read_state";
export default function stateFlowExtension(pi: ExtensionAPI, options?: StateFlowExtensionOptions): void;
