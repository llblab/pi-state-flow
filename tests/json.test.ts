import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, canonicalJson, validatePatch } from "../index.ts";
import { sameJson } from "../lib/json.ts";

test("recursively merges patches and applies null deletion", () => {
	const state = { inventory: { a: "item", b: "other" }, attempts: ["x"] };
	const next = applyPatch(state, { inventory: { a: null, c: "new" } });
	assert.deepEqual(next, { inventory: { b: "other", c: "new" }, attempts: ["x"] });
	assert.deepEqual(state, { inventory: { a: "item", b: "other" }, attempts: ["x"] });
});

test("rejects non-object and lossy patches without imposing a size limit", () => {
	assert.throws(() => validatePatch([]), /JSON object/);
	assert.throws(() => validatePatch({ value: Number.POSITIVE_INFINITY }), /finite, acyclic JSON data/);
	const cyclic: any = {};
	cyclic.self = cyclic;
	assert.throws(() => validatePatch(cyclic), /finite, acyclic JSON data/);
	assert.doesNotThrow(() => validatePatch({ value: "x".repeat(1_000_000) }));
});

test("materializes __proto__ as ordinary JSON data without changing object prototypes", () => {
	const patch = JSON.parse('{"__proto__":{"compiled_skills":{"example":"safe"}}}');
	const next = applyPatch({}, patch);
	assert.equal(Object.getPrototypeOf(next), Object.prototype);
	assert.equal(Object.hasOwn(next, "__proto__"), true);
	assert.deepEqual(next.__proto__, { compiled_skills: { example: "safe" } });
	assert.equal(({} as { compiled_skills?: unknown }).compiled_skills, undefined);
});

test("canonical JSON rejects values that JSON.stringify would lose or rewrite", () => {
	assert.throws(() => canonicalJson(undefined), /finite, acyclic JSON data/);
	assert.throws(() => canonicalJson(Number.NaN), /finite, acyclic JSON data/);
	const cyclic: any = {};
	cyclic.self = cyclic;
	assert.throws(() => canonicalJson(cyclic), /finite, acyclic JSON data/);
});

test("orders state keys deterministically and compares semantic JSON without hashing", () => {
	assert.equal(
		canonicalJson({ z: 1, hot: "h", stable: "s", a: 2 }),
		'{"a":2,"hot":"h","stable":"s","z":1}',
	);
	assert.equal(sameJson({ z: 1, nested: { b: 2, a: 1 } }, { nested: { a: 1, b: 2 }, z: 1 }), true);
	assert.equal(sameJson({ nested: [1, 2] }, { nested: [2, 1] }), false);
	assert.equal(sameJson({ value: 0 }, { value: -0 }), true);
	assert.throws(() => sameJson({ value: Number.NaN }, { value: Number.NaN }), /finite, acyclic/);
	const cyclic: any = {};
	cyclic.self = cyclic;
	assert.throws(() => sameJson(cyclic, cyclic), /finite, acyclic/);
});
