// Domain: public State Flow module registration membrane.
// Registry ownership and semantic publication remain package-private.
export { registerStateFlowModule } from "../lib/module-registry.ts";
export type {
	ModuleContextContribution,
	StateFlowModule,
	StateFlowModuleFrame,
	StateFlowModuleInput,
	StateFlowModuleSource,
} from "../lib/semantic-module.ts";
export type { JsonObject, JsonValue } from "../lib/json.ts";
