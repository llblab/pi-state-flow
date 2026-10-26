import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, isJsonValue } from "../lib/json.ts";
import { cascadeDeletionPatch, computeIntentCascade, extractOwnedPaths, formatOwnedPath, parseOwnedPath } from "../lib/ownership.ts";

test("only same-scope strategy/tactics/lazy object keys parse as ownership targets", () => {
	assert.deepEqual(parseOwnedPath("cwd", "cwd.strategy.a.b"), { plane: "strategy", keys: ["a", "b"] });
	assert.deepEqual(parseOwnedPath("cwd", "cwd.tactics.a.b"), { plane: "tactics", keys: ["a", "b"] });
	assert.deepEqual(parseOwnedPath("session", "session.lazy.$x-1"), { plane: "lazy", keys: ["$x-1"] });
	for (const ref of [
		"session.tactics.a", "tactics.a", "effective.tactics.a", "cwd[1].tactics.a", "cwd.patches[0]",
		"cwd.tactics", "cwd.lazy", "cwd.lazy.plan[0]", "cwd.tactics.a[0].b", "cwd.strategy", "cwd.strategy.a[0]", "cwd.artifacts.a",
		"cwd.response", "cwd.intents.a", "cwd.tactics..a", "cwd.tactics.1a", "",
	]) assert.equal(parseOwnedPath("cwd", ref), undefined, ref);
});

test("extracts unique structured references anywhere inside an intent, never textual mentions", () => {
	const paths = extractOwnedPaths("cwd", {
		action: "use $cwd.tactics.text",
		ref: { $ref: "cwd.tactics.a" },
		nested: [{ deep: { $ref: "cwd.lazy.plan", note: { $ref: "cwd.tactics.b" } } }, { $ref: "cwd.tactics.a" }],
		other: { $ref: 7 },
		cross: { $ref: "global.tactics.a" },
	});
	assert.deepEqual(paths.map((path) => formatOwnedPath("cwd", path)).sort(), ["cwd.lazy.plan", "cwd.tactics.a", "cwd.tactics.b"]);
	assert.deepEqual(extractOwnedPaths("cwd", { $ref: "cwd.tactics.a" }), [{ plane: "tactics", keys: ["a"] }]);
	assert.deepEqual(extractOwnedPaths("cwd", "cwd.tactics.a"), []);
});

test("cascade covers removed intents only, skips shared, related and missing targets, and stays minimal", () => {
	const before = {
		intents: {
			done: [{ $ref: "cwd.tactics.a" }, { $ref: "cwd.tactics.a.x" }, { $ref: "cwd.tactics.shared" }, { $ref: "cwd.tactics.up.y" },
				{ $ref: "cwd.tactics.down" }, { $ref: "cwd.tactics.gone" }, { $ref: "cwd.lazy.plan" }, { $ref: "cwd.tactics.scalar.k" }],
			edited: { $ref: "cwd.tactics.edited" },
			keep: [{ $ref: "cwd.tactics.shared" }, { $ref: "cwd.tactics.up" }, { $ref: "cwd.tactics.down.z" }],
		},
		tactics: { a: { x: 1 }, shared: 1, up: { y: 1 }, down: { z: 1 }, edited: 1, scalar: "k" },
		lazy: { plan: [1] },
	};
	const after = { ...before, intents: { edited: "no refs", keep: before.intents.keep } };
	assert.deepEqual(computeIntentCascade("cwd", before, after), [
		{ plane: "lazy", keys: ["plan"] },
		{ plane: "tactics", keys: ["a"] },
	]);
	assert.deepEqual(computeIntentCascade("cwd", before, before), []);
	assert.deepEqual(computeIntentCascade("cwd", {}, {}), []);
	assert.deepEqual(computeIntentCascade("global", before, after), []);
});

test("cascade deletion patch is explicit, nested and prototype-safe", () => {
	const patch = cascadeDeletionPatch([
		{ plane: "tactics", keys: ["a", "b"] },
		{ plane: "tactics", keys: ["a", "c"] },
		{ plane: "lazy", keys: ["__proto__"] },
	]);
	assert.ok(isJsonValue(patch));
	assert.deepEqual(Object.keys(patch.lazy as object), ["__proto__"]);
	const state = JSON.parse('{"tactics":{"a":{"b":1,"c":2,"d":3}},"lazy":{"__proto__":1,"keep":2}}');
	assert.deepEqual(JSON.parse(JSON.stringify(applyPatch(state, patch))), { tactics: { a: { d: 3 } }, lazy: { keep: 2 } });
});
