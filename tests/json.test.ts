import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, canonicalJson, validatePatch } from "../index.ts";
import { presentationJson, sameJson } from "../lib/json.ts";

test("presentation JSON preserves intentional insertion order without relaxing JSON validation", () => {
	assert.equal(presentationJson({ intents: {}, contract: {}, working: {} }), '{"intents":{},"contract":{},"working":{}}');
	assert.throws(() => presentationJson({ invalid: undefined }), /finite, acyclic JSON/);
});

test("recursively merges patches and applies null deletion", () => {
	const state = { inventory: { a: "item", b: "other" }, attempts: ["x"] };
	const next = applyPatch(state, { inventory: { a: null, c: "new" } });
	assert.deepEqual(next, { inventory: { b: "other", c: "new" }, attempts: ["x"] });
	assert.deepEqual(state, { inventory: { a: "item", b: "other" }, attempts: ["x"] });
});

test("public patch results stay detached from basis and caller patch containers", () => {
	const state = { keep: { nested: { value: 0 } }, items: [{ note: "kept" }, { note: "old" }] };
	const patch = { items: { "[1]": { note: "changed" } }, added: { notes: [{ text: "caller" }] } };
	const next = applyPatch(state, patch) as typeof state & { added: { notes: Array<{ text: string }> } };
	next.keep.nested.value = 9;
	next.items[0]!.note = "draft";
	patch.added.notes[0]!.text = "changed outside";
	assert.equal(state.keep.nested.value, 0);
	assert.equal(state.items[0]!.note, "kept");
	assert.equal(next.added.notes[0]!.text, "caller");
	next.added.notes[0]!.text = "changed inside";
	assert.equal(patch.added.notes[0]!.text, "changed outside");
	const prototypeData = applyPatch({}, JSON.parse('{"__proto__":{}}'));
	assert.notEqual(prototypeData.__proto__, Object.prototype, "ordinary prototype-named data cannot borrow the global prototype");
	(prototypeData.__proto__ as { isolated?: boolean }).isolated = true;
	assert.equal(({} as { isolated?: boolean }).isolated, undefined);
	assert.equal(Object.getPrototypeOf(prototypeData), Object.prototype);
});

test("preserves prototype-named merge semantics and signed zero during path copying", () => {
	const next = applyPatch({ value: 0 }, JSON.parse('{"__proto__":{"absent":null},"value":-0}'));
	assert.equal(Object.hasOwn(next, "__proto__"), true);
	assert.deepEqual(next.__proto__, {});
	assert.notEqual(next.__proto__, Object.prototype);
	assert.equal(Object.is(next.value, -0), true);
	const array = applyPatch({ values: [0] }, { values: { "[0]": -0 } });
	assert.equal(Object.is((array.values as number[])[0], -0), true);
});

test("copies cold data once at the public boundary while patching owned paths", () => {
	const state = { cold: { payload: "COLD-COW-MARKER" }, hot: { items: [{ value: 0 }, { value: 1 }] } };
	const clone = globalThis.structuredClone;
	let coldCopies = 0;
	globalThis.structuredClone = ((value: unknown, options?: any) => {
		if (JSON.stringify(value)?.includes("COLD-COW-MARKER")) coldCopies++;
		return clone(value, options);
	}) as typeof structuredClone;
	let next: ReturnType<typeof applyPatch>;
	try { next = applyPatch(state, { cold: {}, hot: { items: { "[1]": { value: 2 } } } }); }
	finally { globalThis.structuredClone = clone; }
	assert.equal(coldCopies, 1, "internal path updates must not repeatedly deep-copy the detached cold subtree");
	assert.deepEqual(next, { cold: { payload: "COLD-COW-MARKER" }, hot: { items: [{ value: 0 }, { value: 2 }] } });
	assert.notEqual(next.cold, state.cold);
});

test("patches existing array indices recursively without adding an edit language", () => {
	const state = {
		memory: ["first", "second", { note: "old", keep: true }, ["nested", { value: "old" }]],
	};
	const next = applyPatch(state, {
		memory: {
			"[1]": "corrected",
			"[2]": { note: "new" },
			"[3]": { "[1]": { value: "new", added: true } },
		},
	});
	assert.deepEqual(next, {
		memory: ["first", "corrected", { note: "new", keep: true }, ["nested", { value: "new", added: true }]],
	});
	assert.deepEqual(state.memory[3], ["nested", { value: "old" }]);
});

test("rejects invalid indexed changes atomically while preserving whole-value replacement", () => {
	const state = { memory: ["first", "second"], nested: { values: [1] } };
	const invalidPatches: Parameters<typeof applyPatch>[1][] = [
		{ memory: { "[2]": "missing" } },
		{ memory: { "[9007199254740992]": "unsafe" } },
		{ memory: { "[0]": null } },
		{ nested: { values: { "[1]": 2 } } },
	];
	for (const patch of invalidPatches) assert.throws(() => applyPatch(state, patch), /array index/);
	assert.deepEqual(state, { memory: ["first", "second"], nested: { values: [1] } });
	assert.deepEqual(applyPatch(state, { memory: { replacement: true } }), {
		memory: { replacement: true }, nested: { values: [1] },
	});
	assert.deepEqual(applyPatch({ record: { "[0]": "ordinary" } }, { record: { "[0]": "updated" } }), {
		record: { "[0]": "updated" },
	});
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
