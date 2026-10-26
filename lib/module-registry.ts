// Domain: public module registration, native-host ownership and revocable catalog snapshots.
// Excludes: storage, callback evaluation, inference and semantic publication.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "./json.ts";
import type { StateFlowModule } from "./semantic-module.ts";

type SessionManager = ExtensionContext["sessionManager"];
type Definition = StateFlowModule<JsonObject, JsonValue>;
interface Binding {
	readonly manager: SessionManager;
	readonly checkOwner: () => void;
	readonly register: (definition: Definition) => () => void;
	readonly modules: Map<string, Definition>;
	controller: AbortController;
}
interface Bridge { readonly version: 1; readonly hosts: WeakMap<SessionManager, Binding> }
const BRIDGE = Symbol.for("@llblab/pi-state-flow/modules/v1");

function bridge(create = false): Bridge | undefined {
	const globals = globalThis as unknown as Record<symbol, unknown>;
	let value = globals[BRIDGE];
	if (value === undefined && create) globals[BRIDGE] = value = { version: 1, hosts: new WeakMap() } satisfies Bridge;
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("Incompatible State Flow module registration bridge");
	const candidate = value as Partial<Bridge>;
	if (candidate.version !== 1 || !(candidate.hosts instanceof WeakMap)) throw new Error("Incompatible State Flow module registration bridge");
	return candidate as Bridge;
}

function captureDefinition(definition: Definition): Definition {
	if (!definition || typeof definition !== "object") throw new Error("Invalid State Flow module registration");
	const { apiVersion, id, schemaVersion, immutable, validate, context, captureInput, produce } = definition;
	if (apiVersion !== 1) throw new Error("Unsupported State Flow module API version");
	if (typeof id !== "string" || !/^x_[a-z][a-z0-9_]*$/.test(id)) throw new Error("External State Flow module id must match x_[a-z][a-z0-9_]*");
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Invalid State Flow module schema version");
	if (typeof immutable !== "boolean" || typeof validate !== "function" || typeof context !== "function"
		|| (captureInput !== undefined && typeof captureInput !== "function") || (produce !== undefined && typeof produce !== "function")) {
		throw new Error("Invalid State Flow module callbacks or authoring policy");
	}
	// Preserve class/constructor-injected services while capturing policy and callback identities.
	return Object.freeze({ apiVersion, id, schemaVersion, immutable, validate: validate.bind(definition), context: context.bind(definition),
		...(captureInput ? { captureInput: captureInput.bind(definition) } : {}), ...(produce ? { produce: produce.bind(definition) } : {}) });
}

export interface StateFlowModuleCatalog {
	readonly modules: readonly Definition[];
	readonly signal: AbortSignal;
	assertCurrent(): void;
}

/** Registry metadata alone grants no content, source, private or publication authority. */
export function registerStateFlowModule<Content extends JsonObject, Input extends JsonValue>(
	manager: SessionManager, definition: StateFlowModule<Content, Input>,
): () => void {
	const host = bridge()?.hosts.get(manager);
	if (!host) throw new Error("State Flow module host unavailable; load State Flow first and register at session_start");
	return host.register(definition as unknown as Definition);
}

/** One composition-root owner; catalogs are revoked independently of memory mode or storage. */
export class StateFlowModuleHost {
	#binding: Binding | undefined;
	bind(manager: SessionManager, checkOwner: () => void): void {
		checkOwner();
		const hosts = bridge(true)!.hosts;
		const existing = hosts.get(manager);
		if (existing && existing !== this.#binding) throw new Error("State Flow module host already bound to this native session manager");
		this.dispose();
		if (this.#binding || hosts.has(manager)) throw new Error("State Flow module host changed during rebind");
		checkOwner();
		const binding: Binding = { manager, checkOwner, modules: new Map(), controller: new AbortController(), register: definition => this.#register(binding, definition) };
		this.#binding = binding;
		hosts.set(manager, binding);
	}
	#check(binding: Binding): void {
		if (this.#binding !== binding || bridge()?.hosts.get(binding.manager) !== binding) throw new Error("State Flow module host ownership changed");
		binding.checkOwner();
	}
	#changed(binding: Binding): void {
		const previous = binding.controller;
		binding.controller = new AbortController();
		previous.abort(new Error("State Flow module catalog changed"));
	}
	#register(binding: Binding, definition: Definition): () => void {
		this.#check(binding);
		const captured = captureDefinition(definition);
		this.#check(binding);
		if (binding.modules.has(captured.id)) throw new Error(`State Flow module id already registered: ${captured.id}`);
		binding.modules.set(captured.id, captured);
		this.#changed(binding);
		return () => {
			if (this.#binding !== binding || binding.modules.get(captured.id) !== captured) return;
			binding.modules.delete(captured.id);
			this.#changed(binding);
		};
	}
	captureIfBound(): StateFlowModuleCatalog | undefined {
		return this.#binding ? this.capture() : undefined;
	}
	capture(): StateFlowModuleCatalog {
		const binding = this.#binding;
		if (!binding) throw new Error("State Flow module host unavailable");
		this.#check(binding);
		const signal = binding.controller.signal;
		return Object.freeze({ modules: Object.freeze([...binding.modules.values()]), signal, assertCurrent: () => {
			this.#check(binding);
			signal.throwIfAborted();
		} });
	}
	dispose(): void {
		const binding = this.#binding;
		if (!binding) return;
		this.#binding = undefined;
		const hosts = bridge()?.hosts;
		if (hosts?.get(binding.manager) === binding) hosts.delete(binding.manager);
		binding.modules.clear();
		binding.controller.abort(new Error("State Flow module host retired"));
	}
}
