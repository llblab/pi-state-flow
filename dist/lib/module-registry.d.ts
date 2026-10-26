import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "./json.ts";
import type { StateFlowModule } from "./semantic-module.ts";
type SessionManager = ExtensionContext["sessionManager"];
type Definition = StateFlowModule<JsonObject, JsonValue>;
export interface StateFlowModuleCatalog {
    readonly modules: readonly Definition[];
    readonly signal: AbortSignal;
    assertCurrent(): void;
}
/** Registry metadata alone grants no content, source, private or publication authority. */
export declare function registerStateFlowModule<Content extends JsonObject, Input extends JsonValue>(manager: SessionManager, definition: StateFlowModule<Content, Input>): () => void;
/** One composition-root owner; catalogs are revoked independently of memory mode or storage. */
export declare class StateFlowModuleHost {
    #private;
    bind(manager: SessionManager, checkOwner: () => void): void;
    captureIfBound(): StateFlowModuleCatalog | undefined;
    capture(): StateFlowModuleCatalog;
    dispose(): void;
}
export {};
