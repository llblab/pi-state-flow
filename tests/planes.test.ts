import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PLANE_NAMES, projectLazyNavigation, projectPlaneContext, SEMANTIC_PLANES } from "../lib/planes.ts";
import { type JsonObject } from "../lib/json.ts";

const names = ["intents", "strategy", "tactics", "artifacts", "response", "lazy"];

test("static six-plane bindings preserve order and main-agent immutability without a registry", () => {
	assert.deepEqual(SEMANTIC_PLANES.map(binding => binding.module.id), names);
	assert.deepEqual(MODEL_PLANE_NAMES, ["intents", "strategy", "tactics", "artifacts", "lazy"]);
	for (const binding of SEMANTIC_PLANES) {
		assert.equal(binding.module.immutable, binding.module.id === "response");
		assert.equal(Object.isFrozen(binding), true); assert.equal(Object.isFrozen(binding.module), true);
		assert.equal(binding.target, binding.module.id === "lazy" ? "lazy_navigation" : "state");
	}
	assert.equal(Object.isFrozen(SEMANTIC_PLANES), true); assert.equal(Object.isFrozen(MODEL_PLANE_NAMES), true);
});

test("present-value admission stays with each real plane rather than a common object-only schema", () => {
	for (const { module } of SEMANTIC_PLANES) {
		assert.equal(module.validate(module.id === "response" ? "" : {}), true);
		assert.equal(module.validate(module.id === "response" ? {} : "not an object"), false);
		assert.equal(module.validate(undefined), false);
	}
	const artifacts = SEMANTIC_PLANES.find(binding => binding.module.id === "artifacts")!.module;
	assert.equal(artifacts.validate({ "/a.md": { description: "valid semantic source" } }), true);
	assert.equal(artifacts.validate({ "/a.md": { description: "", hash: "legacy-observation" } }), true, "projection is not canonical artifact admission");
});

test("mode-aware production bindings preserve sparse values and omit Passive response", () => {
	assert.deepEqual(projectPlaneContext({}), { state: {}, lazy_navigation: { available: false, path: "effective.lazy" } });
	const source = { intents: {}, strategy: { constraint: "retain" }, response: "exact answer", lazy: { plan: { hidden: true } }, extra: { unknown: true } };
	const before = structuredClone(source);
	const active = projectPlaneContext(source), passive = projectPlaneContext(source, {}, "passive");
	assert.deepEqual(active.state, { intents: {}, strategy: { constraint: "retain" }, response: "exact answer" });
	assert.deepEqual(passive.state, { intents: {}, strategy: { constraint: "retain" } });
	assert.deepEqual(active.lazy_navigation, { available: true, path: "effective.lazy", keys: { plan: "object" } });
	assert.deepEqual(passive.lazy_navigation, active.lazy_navigation);
	assert.deepEqual(source, before);
	assert.deepEqual(projectPlaneContext({ response: "" }).state, {});
});

test("artifact module delegates exact existing hints and hides runtime bookkeeping", () => {
	const source = { artifacts: { "/a.md": { description: "A", hash: `sha256:${"a".repeat(64)}`, compiler: "artifact-v1" } } };
	const before = structuredClone(source);
	assert.deepEqual(projectPlaneContext(source, { "/a.md": ["z", "a", "z"], "/missing.md": "ignored" }).state, {
		artifacts: { "/a.md": { description: "A", hint: "a\nz" } },
	});
	assert.deepEqual(source, before);
});

test("lazy context receives structural metadata without cloning hidden content", t => {
	const lazy = { plan: { secret: "HIDDEN_BODY" } }, original = structuredClone;
	let bodyCopies = 0;
	t.mock.method(globalThis, "structuredClone", (value: unknown) => { if (value === lazy || value === lazy.plan) bodyCopies++; return original(value); });
	const projected = projectPlaneContext({ lazy });
	assert.equal(bodyCopies, 0);
	assert.equal(JSON.stringify(projected).includes("HIDDEN_BODY"), false);
	assert.deepEqual(projected.lazy_navigation, { available: true, path: "effective.lazy", keys: { plan: "object" } });
});

test("navigation keeps complete-catalog bounds, empty-object meaning and special keys", () => {
	assert.deepEqual(projectLazyNavigation({ empty: { nested: {} } }), { available: false, path: "effective.lazy" });
	assert.deepEqual(projectLazyNavigation({ array: [], scalar: 1, truth: true, text: "value" }), {
		available: true, path: "effective.lazy", keys: { array: "array", scalar: "number", truth: "boolean", text: "string" },
	});
	assert.equal(Object.keys(projectLazyNavigation(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i]))).keys!).length, 32);
	assert.equal(projectLazyNavigation(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))).keys, undefined);
	assert.equal(projectLazyNavigation({ ["x".repeat(1024)]: true }).keys, undefined);
	const source = JSON.parse('{"__proto__":{"secret":true},"constructor":[1]}') as JsonObject;
	const hint = projectLazyNavigation(source);
	assert.deepEqual(Object.keys(hint.keys!), ["__proto__", "constructor"]);
	assert.equal(Object.hasOwn(hint.keys!, "__proto__"), true);
});
