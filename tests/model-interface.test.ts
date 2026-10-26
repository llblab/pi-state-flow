import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelPatches, canonicalizeModelReferences, projectModelReferences, normalizeModelReadPath, projectModelReadPath, projectModelArtifactTarget, projectModelMissingDeletion } from "../lib/model-interface.ts";
import type { JsonObject } from "../lib/json.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

const owners: [StateScope, ...StateScope[]] = ["global", "cwd", "session"];
const selections: ScopeSelection[] = [["global"], ["cwd"], ["session"], ["global", "cwd"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]];

for (const owner of owners) test(`flat ${owner} patches capture canonical ownership and keep inputs/results detached`, () => {
	const input = JSON.parse('{"intents":{"i":{"$ref":"tactics.release"}},"tactics":{"release":{"nested":{"constructor":1,"__proto__":2,"prototype":3}},"gone":null},"lazy":{"nested":[{"$ref":"lazy.plan[1]"}]}}');
	const original = structuredClone(input), normalized = normalizeModelPatches(input, [owner]);
	assert.deepEqual(Object.keys(normalized), [owner]);
	assert.deepEqual(normalized[owner], {
		intents: { i: { $ref: `${owner}.tactics.release` } },
		tactics: { release: { nested: JSON.parse('{"constructor":1,"__proto__":2,"prototype":3}') }, gone: null },
		lazy: { nested: [{ $ref: `${owner}.lazy.plan[1]` }] },
	});
	assert.deepEqual(input, original);
	(normalized[owner]!.intents!.i as JsonObject).$ref = "changed";
	assert.deepEqual(input, original);
	input.tactics.release.nested.constructor = 999;
	assert.equal(((normalized[owner]!.tactics!.release as JsonObject).nested as JsonObject).constructor, 1);
});

test("special object keys and explicit non-current refs remain detached canonical data", () => {
	const value = JSON.parse('{"__proto__":{"$ref":"lazy.plan"},"constructor":[{"$ref":"session[1].lazy.plan"},{"$ref":"effective.lazy.plan"},{"$ref":"global.lazy.plan"}],"text":"$lazy.plan"}');
	const before = structuredClone(value);
	const canonical = canonicalizeModelReferences(value, ["session"]);
	assert.deepEqual(projectModelReferences(canonical, ["session"]), value);
	assert.deepEqual(canonical, JSON.parse('{"__proto__":{"$ref":"session.lazy.plan"},"constructor":[{"$ref":"session[1].lazy.plan"},{"$ref":"effective.lazy.plan"},{"$ref":"global.lazy.plan"}],"text":"$lazy.plan"}'));
	assert.deepEqual(value, before);
	assert.notEqual(canonical, value);
	assert.notEqual(projectModelReferences(canonical, ["session"]), canonical);
});

test("multi-owner normalization preserves explicit atomic owners and existing reference semantics", () => {
	for (const selected of selections.filter(s => s.length > 1)) {
		const input = Object.fromEntries(selected.map(owner => [owner, { intents: { i: { $ref: `${owner}.tactics.x` }, unscoped: { $ref: "tactics.x" } }, tactics: { x: 1 } }]));
		const normalized = normalizeModelPatches(input, selected);
		assert.deepEqual(normalized, input);
		assert.notEqual(normalized, input);
		for (const owner of selected) assert.notEqual(normalized[owner], input[owner]);
		assert.deepEqual(projectModelReferences(normalized, selected), normalized);
	}
});

test("patch shape is exclusive/nonempty, planes object-only, nested deletion allowed", () => {
	for (const selected of selections) {
		for (const invalid of [null, [], 1, {}, { response: "no" }, { contract: {} }, { working: {} }, { tactics: {}, cwd: { tactics: {} } }]) {
			assert.throws(() => normalizeModelPatches(invalid, selected), JSON.stringify([selected, invalid]));
		}
		const patch = (value: unknown) => selected.length === 1 ? value : { [selected[0]]: value };
		for (const invalid of [{}, { tactics: null }, { intents: [] }, { strategy: 1 }, { lazy: "no" }, { artifacts: true }, { response: {} }, { tactics: {}, unknown: {} }]) assert.throws(() => normalizeModelPatches(patch(invalid), selected));
		assert.deepEqual(normalizeModelPatches(patch({ tactics: { gone: null } }), selected), { [selected[0]]: { tactics: { gone: null } } });
		assert.deepEqual(normalizeModelPatches(patch({ tactics: {} }), selected), { [selected[0]]: { tactics: {} } });
		if (selected.length === 1) assert.throws(() => normalizeModelPatches({ [selected[0]]: { tactics: {} } }, selected));
	}
});

test("rejects mixed/excluded top-level owners before evaluating their supplied payload", () => {
	let touches = 0;
	const foreign = Object.defineProperty({}, "session", { enumerable: true, get() { touches++; throw new Error("EXCLUDED_BODY"); } });
	assert.throws(() => normalizeModelPatches(foreign, ["global", "cwd"]), /participating explicit owners/);
	assert.throws(() => normalizeModelPatches(foreign, ["global"]), /flat semantic planes/);
	const mixed = Object.defineProperty({ tactics: {} }, "global", { enumerable: true, get() { touches++; throw new Error("MIXED_BODY"); } });
	assert.throws(() => normalizeModelPatches(mixed, ["global"]), /flat semantic planes/);
	assert.equal(touches, 0);
});

test("malformed selection rejects before reading supplied values; no defaults or grants", () => {
	let touches = 0;
	const value = Object.defineProperty({}, "tactics", { enumerable: true, get() { touches++; return {}; } });
	for (const malformed of [[], ["cwd", "cwd"], ["CWD"], ["unknown"], ["session", , "cwd"]]) {
		const selected = malformed as unknown as ScopeSelection; // Intentional malformed DATA admission cases.
		assert.throws(() => normalizeModelPatches(value, selected));
		assert.throws(() => canonicalizeModelReferences(value, selected));
		assert.throws(() => projectModelReferences(value, selected));
		assert.throws(() => normalizeModelReadPath("tactics.x", selected));
	}
	assert.equal(touches, 0);
	// DELIBERATE authority counterexample: pure DATA translation alone cannot bind an old native call.
	assert.deepEqual(normalizeModelPatches({ tactics: { x: 1 } }, ["cwd"]), { cwd: { tactics: { x: 1 } } });
	assert.deepEqual(normalizeModelPatches({ tactics: { x: 1 } }, ["global"]), { global: { tactics: { x: 1 } } });
});

test("reference projection is bidirectional only for same-owner current semantic structured values", () => {
	for (const owner of owners) {
		const other = owners.find(x => x !== owner)!;
		const input = {
			one: { $ref: "tactics.release" }, nested: [{ x: { $ref: "lazy.plan[1].step" } }],
			text: "$tactics.release and $cwd.tactics.release", path: "tactics.release", resource: { $ref: "src/tactics.ts" },
			absolute: { $ref: "/tmp/lazy.txt" }, uri: { $ref: "file:///tmp/tactics" },
			cross: { $ref: `${other}.tactics.release` }, effective: { $ref: "effective.tactics.release" },
			history: { $ref: `${owner}[1].tactics.release` }, patch: { $ref: `${owner}.patches[1]` },
			invalid: { $ref: "tactics.release/bad" }, numeric: { $ref: 4 }, unknown: { $ref: "ordinary.key" },
		};
		const original = structuredClone(input), canonical = canonicalizeModelReferences(input, [owner]) as JsonObject;
		assert.deepEqual(canonical.one, { $ref: `${owner}.tactics.release` });
		assert.deepEqual(canonical.nested, [{ x: { $ref: `${owner}.lazy.plan[1].step` } }]);
		for (const key of Object.keys(input).filter(k => k !== "one" && k !== "nested")) assert.deepEqual(canonical[key], input[key as keyof typeof input]);
		assert.deepEqual(projectModelReferences(canonical, [owner]), original);
		assert.deepEqual(canonicalizeModelReferences(canonical, owners), canonical);
		assert.deepEqual(input, original);
	}
});

test("JSON validation/detachment does not turn invalid values or sparse arrays into data", () => {
	const cycle: JsonObject = {}; cycle.self = cycle;
	for (const invalid of [undefined, NaN, Infinity, () => 1, 1n, cycle, new Date(), new Map(), { [Symbol("key")]: 1 }, { bad: undefined }, [1, , 2]]) {
		assert.throws(() => canonicalizeModelReferences(invalid, ["cwd"]));
		assert.throws(() => projectModelReferences(invalid, ["cwd"]));
		assert.throws(() => normalizeModelPatches({ tactics: { invalid } }, ["cwd"]));
	}
	const value = JSON.parse('{"__proto__":{"$ref":"tactics.x"},"constructor":{"$ref":"lazy.x"},"prototype":null}');
	const projected = canonicalizeModelReferences(value, ["cwd"]) as JsonObject;
	assert.deepEqual(Object.keys(projected), ["__proto__", "constructor", "prototype"]);
	assert.deepEqual(projected.__proto__, { $ref: "cwd.tactics.x" });
	assert.equal(Object.getPrototypeOf(projected), Object.prototype);
	assert.deepEqual(projectModelReferences(projected, ["cwd"]), value);
});

for (const owner of owners) test(`${owner} flat read locators round-trip exact ownership, history, patches and ordinary arrays`, () => {
	const examples = [
		["effective", owner], ["tactics.x", `${owner}.tactics.x`], ["lazy.items[1]", `${owner}.lazy.items[1]`],
		["tactics.patches[1]", `${owner}.tactics.patches[1]`], ["response", `${owner}.response`],
		["effective[1].tactics.items[0]", `${owner}[1].tactics.items[0]`], ["effective[1]", `${owner}[1]`],
		["patches[0]", `${owner}.patches[0]`], ["patches", `${owner}.patches`],
	];
	for (const [flat, canonical] of examples) {
		assert.equal(normalizeModelReadPath(flat!, [owner]), canonical);
		assert.equal(normalizeModelReadPath(canonical!, [owner]), canonical);
		assert.equal(projectModelReadPath(canonical!, [owner]), flat);
	}
	for (const other of owners.filter(x => x !== owner)) assert.throws(() => normalizeModelReadPath(`${other}.tactics.x`, [owner]), /excluded/);
});

test("read validation keeps temporal and array selectors distinct, aliases narrow and multi-owner explicit", () => {
	for (const selected of selections) {
		for (const invalid of ["", "./tactics.x", "tactics.x/bad", "contract.x", "working.x", "patches[0].tactics", "patches.x", "effective[8]", "effective[9007199254740992]", "effective[1].tactics..x"]) assert.throws(() => normalizeModelReadPath(invalid, selected));
		assert.throws(() => normalizeModelReadPath("effective[1]", selected, 0));
		assert.doesNotThrow(() => normalizeModelReadPath("tactics.items[100]", selected, 0));
		assert.throws(() => normalizeModelReadPath("tactics.x", selected, -1));
		assert.doesNotThrow(() => normalizeModelReadPath("effective[100].tactics.x", selected, 100));
		assert.throws(() => normalizeModelReadPath("effective[101]", selected, 100));
		if (selected.length > 1) {
			assert.equal(normalizeModelReadPath("tactics.items[1]", selected), "tactics.items[1]");
			assert.equal(normalizeModelReadPath("effective[1].tactics.x", selected), "effective[1].tactics.x");
			assert.throws(() => normalizeModelReadPath("patches[0]", selected));
			assert.throws(() => normalizeModelReadPath("effective.patches[0]", selected));
			for (const owner of selected) assert.equal(projectModelReadPath(`${owner}.tactics.x`, selected), `${owner}.tactics.x`);
		}
	}
});

{
	const owners: StateScope[] = ["global", "cwd", "session"];
	const choices = Array.from({ length: 7 }, (_, mask) => owners.filter((_, bit) => (mask + 1) & (1 << bit)) as unknown as ScopeSelection);
	const malformed: unknown[] = [null, [], ["session", "session"], ["foreign"], ["global", "cwd", "session", "global"], new Array(1), "session", {}];
	const paths = ["", "/", "a/b", "a~1b/~0/0", 'a"b\\c\n', "session.artifacts.x", "/global/session", "__proto__", "[0]", "é/雪", "\u0000"];
	for (const scopes of choices) {
		test(`artifact exact opaque targets: ${scopes.join("+")}`, () => {
			for (const owner of owners) for (const path of paths) {
				if (!scopes.includes(owner)) {
					assert.throws(() => projectModelArtifactTarget(owner, path, scopes), /excluded/);
					continue;
				}
				const prefix = scopes.length === 1 ? "" : `${owner}.`;
				const result = projectModelArtifactTarget(owner, path, scopes);
				assert.equal(result, `${prefix}artifacts[${JSON.stringify(path)}]`);
				assert.equal(JSON.parse(result.slice(result.indexOf("[") + 1, -1)), path);
			}
		});

		test(`deletion prefix boundary and detached output: ${scopes.join("+")}`, () => {
			for (const owner of owners) for (const suffix of ["", "/", "/artifacts/a~1b~0c/0", "/tactics/00/~01", "ish/x", "~1/tactics", ".tactics/x"]) {
				const path = `/${owner}${suffix}`;
				const unavailablePath = `/${owner}/artifacts/session~1global/01`;
				const input = { path, unavailablePath };
				const before = structuredClone(input);
				const strip = scopes.length === 1 && owner === scopes[0];
				const expected = strip && (suffix === "" || suffix.startsWith("/")) ? suffix : path;
				const result = projectModelMissingDeletion(input, scopes);
				assert.deepEqual(result, { path: expected, unavailablePath: strip ? "/artifacts/session~1global/01" : unavailablePath });
				assert.notEqual(result, input);
				result.path = "mutated";
				assert.deepEqual(input, before);
			}
			for (const path of ["", "/", "session/tactics", "/session~1tactics/x", "/Session/x", "/effective/0"]) {
				assert.deepEqual(projectModelMissingDeletion({ path, unavailablePath: path }, scopes), { path, unavailablePath: path });
			}
		});

	}

	test("invalid choices reject before deletion bodies and artifact path validation", () => {
		for (const value of [...malformed, undefined]) {
			const scopes = value as ScopeSelection;
			let reads = 0;
			const deletion = { get path(): string { reads++; throw Error("BODY"); }, get unavailablePath(): string { reads++; throw Error("BODY"); } };
			assert.throws(() => projectModelMissingDeletion(deletion, scopes), /scopes must/);
			assert.throws(() => projectModelArtifactTarget("session", null as unknown as string, scopes), /scopes must/);
			assert.equal(reads, 0);
		}
		assert.throws(() => projectModelArtifactTarget("global", null as unknown as string, ["session"]), /excluded/);
		assert.throws(() => projectModelArtifactTarget("session", null as unknown as string, ["session"]), /path must/);
		assert.throws(() => projectModelArtifactTarget("foreign" as StateScope, "x", ["global", "cwd", "session"]), /excluded/);
	});
}
