import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerStateFlowModule, type StateFlowModule, type StateFlowModuleFrame } from "../api/modules.ts";
import { StateFlowModuleHost } from "../lib/module-registry.ts";
import { isObject, type JsonObject } from "../lib/json.ts";

const manager = () => Object.create(null) as ExtensionContext["sessionManager"];
const definition = (id = "x_acme_notes"): StateFlowModule => ({
	immutable: false, id, apiVersion: 1, schemaVersion: 1,
	validate: (value): value is JsonObject => isObject(value),
	context: value => value === undefined ? [] : [{ kind: "data", value }],
});
const frame: StateFlowModuleFrame = { mode: "passive", scope: "cwd", conversation: [], input: undefined };

test("public registration requires an exact live host and validates without executing callbacks", t => {
	const key = manager(), host = new StateFlowModuleHost();
	t.after(() => host.dispose());
	assert.throws(() => registerStateFlowModule(key, definition()), /host unavailable/);
	host.bind(key, () => {});
	let called = 0;
	const module = { ...definition(), validate: (_value: unknown): _value is JsonObject => { called++; return true; }, context: () => { called++; return []; } };
	for (const patch of [{ apiVersion: 2 }, { schemaVersion: 0 }, { schemaVersion: Number.NaN }, { schemaVersion: Number.MAX_SAFE_INTEGER + 1 },
		{ immutable: "false" }, { validate: null }, { context: undefined }, { captureInput: true }, { produce: 1 }]) {
		assert.throws(() => registerStateFlowModule(key, { ...module, ...patch } as StateFlowModule));
	}
	for (const id of ["intents", "response", "contract", "working", "x_", "x_Upper", "x_acme/notes", "__proto__"]) {
		assert.throws(() => registerStateFlowModule(key, { ...module, id }), /module id/);
	}
	const before = host.capture();
	const unregister = registerStateFlowModule(key, module);
	assert.equal(called, 0);
	assert.equal(before.signal.aborted, true);
	const current = host.capture();
	assert.deepEqual(current.modules.map(value => value.id), [module.id]);
	assert.throws(() => registerStateFlowModule(key, module), /already registered/);
	assert.equal(current.signal.aborted, false, "rejected registration does not revoke the accepted catalog");
	unregister();
	assert.equal(current.signal.aborted, true);
	assert.deepEqual(host.capture().modules, []);
});

test("host identity isolates native managers and rejects competing ownership without replacing either", t => {
	const first = new StateFlowModuleHost(), second = new StateFlowModuleHost(), a = manager(), b = manager();
	t.after(() => { first.dispose(); second.dispose(); });
	first.bind(a, () => {}); second.bind(b, () => {});
	registerStateFlowModule(a, definition()); registerStateFlowModule(b, definition());
	const firstCatalog = first.capture(), secondCatalog = second.capture();
	assert.throws(() => first.bind(b, () => {}), /already bound/);
	firstCatalog.assertCurrent(); secondCatalog.assertCurrent();
	first.dispose();
	assert.equal(firstCatalog.signal.aborted, true);
	assert.throws(() => firstCatalog.assertCurrent(), /ownership changed/);
	assert.throws(() => registerStateFlowModule(a, definition()), /host unavailable/);
	secondCatalog.assertCurrent();
	assert.throws(() => registerStateFlowModule(b, definition()), /already registered/);
});

test("stale disposers and catalogs cannot revoke equal replacement registrations or rebound hosts", t => {
	const key = manager(), host = new StateFlowModuleHost();
	t.after(() => host.dispose());
	host.bind(key, () => {});
	const removeOld = registerStateFlowModule(key, definition()), old = host.capture();
	removeOld();
	registerStateFlowModule(key, definition());
	const replacement = host.capture();
	removeOld();
	replacement.assertCurrent();
	assert.notEqual(old.modules[0], replacement.modules[0]);
	assert.throws(() => old.assertCurrent(), /catalog changed/);
	host.bind(key, () => {});
	registerStateFlowModule(key, definition());
	const rebound = host.capture();
	removeOld();
	rebound.assertCurrent();
	assert.throws(() => replacement.assertCurrent(), /ownership changed/);
	assert.equal(replacement.signal.aborted, true);
});

test("policy and callback identities are captured without breaking constructor-injected services", t => {
	const key = manager(), host = new StateFlowModuleHost();
	t.after(() => host.dispose());
	host.bind(key, () => {});
	class Notes implements StateFlowModule {
		immutable = true; id = "x_acme_notes"; apiVersion = 1 as const; schemaVersion = 1;
		#body = "constructor service";
		validate(value: unknown): value is JsonObject { return isObject(value); }
		context() { return [{ kind: "data" as const, value: { body: this.#body } }]; }
	}
	const notes = new Notes();
	registerStateFlowModule(key, notes);
	const catalog = host.capture(), captured = catalog.modules[0]!;
	notes.immutable = false; notes.id = "x_other"; notes.schemaVersion = 2; notes.context = () => [];
	assert.equal(captured.id, "x_acme_notes"); assert.equal(captured.immutable, true); assert.equal(captured.schemaVersion, 1);
	assert.equal(Object.isFrozen(captured), true); assert.equal(Object.isFrozen(catalog.modules), true);
	assert.deepEqual(captured.context(undefined, frame), [{ kind: "data", value: { body: "constructor service" } }]);
	catalog.assertCurrent();
});

test("native-owner currentness and reentrant retirement fence obsolete registration", t => {
	const key = manager(), host = new StateFlowModuleHost();
	t.after(() => host.dispose());
	let current = true;
	host.bind(key, () => { if (!current) throw new Error("native owner changed"); });
	const catalog = host.capture();
	current = false;
	assert.throws(() => catalog.assertCurrent(), /native owner changed/);
	assert.throws(() => registerStateFlowModule(key, definition()), /native owner changed/);
	current = true;
	const malicious = { ...definition(), get id() { host.dispose(); return "x_acme_notes"; } };
	assert.throws(() => registerStateFlowModule(key, malicious), /ownership changed/);
	assert.throws(() => registerStateFlowModule(key, definition()), /host unavailable/);
});

test("reentrant host acquisition during cancellation is never overwritten by the retiring owner", t => {
	const key = manager(), old = new StateFlowModuleHost(), replacement = new StateFlowModuleHost();
	t.after(() => { old.dispose(); replacement.dispose(); });
	old.bind(key, () => {});
	old.capture().signal.addEventListener("abort", () => replacement.bind(key, () => {}), { once: true });
	assert.throws(() => old.bind(key, () => {}), /changed during rebind/);
	registerStateFlowModule(key, definition());
	const accepted = replacement.capture();
	old.dispose();
	accepted.assertCurrent();
	assert.equal(accepted.modules.length, 1);
});
