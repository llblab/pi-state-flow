// Test arguments only: author a valid exact-one-owner call in its actual declared model grammar.
// Never drop a foreign/extra target from an invalid cohort or bypass native validation/admission.
import type { AtomicScopePatches, StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
export function modelPatchArguments(selection: readonly StateScope[], patches: AtomicScopePatches): JsonObject {
	const keys = Object.keys(patches);
	return selection.length === 1 && keys.length === 1 && keys[0] === selection[0]
		? patches[selection[0]!] as JsonObject : patches as JsonObject;
}
