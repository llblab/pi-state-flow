import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStateFlowModule, type JsonObject, type StateFlowModule } from "../api/modules.ts";

type Manager = Parameters<typeof registerStateFlowModule>[0];

/** Ordinary companion: public SDK + public StateFlow membrane only, no private host reach-through. */
export function publicNotesCompanion(callbacks: (Pick<StateFlowModule, "captureInput" | "context" | "produce"> & Partial<Pick<StateFlowModule, "immutable">>) | undefined = undefined) {
	const disposers = new WeakMap<Manager, () => void>();
	const calls = { validate: 0, context: 0, produce: 0 };
	const definition: StateFlowModule = {
		id: "x_public_notes", apiVersion: 1, schemaVersion: 1, immutable: callbacks?.immutable ?? false,
		validate(value): value is JsonObject {
			calls.validate++;
			return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonObject).note === "string";
		},
		...(callbacks?.captureInput ? { captureInput: callbacks.captureInput } : {}),
		context: (content, frame) => { calls.context++; return callbacks?.context(content, frame) ?? []; },
		...(callbacks?.produce ? { produce: (content: JsonObject | undefined, frame: Parameters<NonNullable<StateFlowModule["produce"]>>[1], signal: AbortSignal) => { calls.produce++; return callbacks.produce!(content, frame, signal); } } : {}),
	};
	function unregister(manager: Manager): void { disposers.get(manager)?.(); disposers.delete(manager); }
	function register(manager: Manager, overrides: Partial<StateFlowModule> = {}): void {
		unregister(manager);
		disposers.set(manager, registerStateFlowModule(manager, { ...definition, ...overrides }));
	}
	function factory(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => { register(ctx.sessionManager); });
		pi.on("session_shutdown", (_event, ctx) => { unregister(ctx.sessionManager); });
	}
	return { factory, register, unregister, calls };
}
