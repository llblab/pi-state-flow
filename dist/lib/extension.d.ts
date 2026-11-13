import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPatchStateArguments } from "./protocol.ts";
import { type StateFlowMode } from "./snapshot.ts";
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
    /** Test/SDK override of the default mode for new sessions; repository config remains the Pi default. */
    mode?: StateFlowMode;
}
export { formatPatchStateArguments };
export declare const PATCH_STATE_TOOL_NAME = "state_flow_patch";
export declare const READ_STATE_TOOL_NAME = "state_flow_read";
export default function stateFlowExtension(pi: ExtensionAPI, options?: StateFlowExtensionOptions): void;
