import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, isJsonValue } from "../lib/json.ts";
import { cascadeDeletionPatch, computeIntentCascade, extractOwnedPaths, formatOwnedPath, parseOwnedPath } from "../lib/ownership.ts";

test("only same-scope working/lazy object keys parse as ownership targets", () => {
	assert.deepEqual(parseOwnedPath("cwd", "cwd.working.a.b"), { plane: "working", keys: ["a", "b"] });
	assert.deepEqual(parseOwnedPath("session", "session.lazy.$x-1"), { plane: "lazy", keys: ["$x-1"] });
	for (const ref of [
		"session.working.a", "working.a", "effective.working.a", "cwd[1].working.a", "cwd.patches[0]",
		"cwd.working", "cwd.lazy", "cwd.lazy.plan[0]", "cwd.working.a[0].b", "cwd.contract.a", "cwd.artifacts.a",
		"cwd.response", "cwd.intents.a", "cwd.working..a", "cwd.working.1a", "",
	]) assert.equal(parseOwnedPath("cwd", ref), undefined, ref);
});

test("extracts unique structured references anywhere inside an intent, never textual mentions", () => {
	const paths = extractOwnedPaths("cwd", {
		action: "use $cwd.working.text",
		ref: { $ref: "cwd.working.a" },
		nested: [{ deep: { $ref: "cwd.lazy.plan", note: { $ref: "cwd.working.b" } } }, { $ref: "cwd.working.a" }],
		other: { $ref: 7 },
		cross: { $ref: "global.working.a" },
	});
	assert.deepEqual(paths.map((path) => formatOwnedPath("cwd", path)).sort(), ["cwd.lazy.plan", "cwd.working.a", "cwd.working.b"]);
	assert.deepEqual(extractOwnedPaths("cwd", { $ref: "cwd.working.a" }), [{ plane: "working", keys: ["a"] }]);
	assert.deepEqual(extractOwnedPaths("cwd", "cwd.working.a"), []);
});

test("cascade covers removed intents only, skips shared, related and missing targets, and stays minimal", () => {
	const before = {
		intents: {
			done: [{ $ref: "cwd.working.a" }, { $ref: "cwd.working.a.x" }, { $ref: "cwd.working.shared" }, { $ref: "cwd.working.up.y" },
				{ $ref: "cwd.working.down" }, { $ref: "cwd.working.gone" }, { $ref: "cwd.lazy.plan" }, { $ref: "cwd.working.scalar.k" }],
			edited: { $ref: "cwd.working.edited" },
			keep: [{ $ref: "cwd.working.shared" }, { $ref: "cwd.working.up" }, { $ref: "cwd.working.down.z" }],
		},
		working: { a: { x: 1 }, shared: 1, up: { y: 1 }, down: { z: 1 }, edited: 1, scalar: "k" },
		lazy: { plan: [1] },
	};
	const after = { ...before, intents: { edited: "no refs", keep: before.intents.keep } };
	assert.deepEqual(computeIntentCascade("cwd", before, after), [
		{ plane: "lazy", keys: ["plan"] },
		{ plane: "working", keys: ["a"] },
	]);
	assert.deepEqual(computeIntentCascade("cwd", before, before), []);
	assert.deepEqual(computeIntentCascade("cwd", {}, {}), []);
	assert.deepEqual(computeIntentCascade("global", before, after), []);
});

test("cascade deletion patch is explicit, nested and prototype-safe", () => {
	const patch = cascadeDeletionPatch([
		{ plane: "working", keys: ["a", "b"] },
		{ plane: "working", keys: ["a", "c"] },
		{ plane: "lazy", keys: ["__proto__"] },
	]);
	assert.ok(isJsonValue(patch));
	assert.deepEqual(Object.keys(patch.lazy as object), ["__proto__"]);
	const state = JSON.parse('{"working":{"a":{"b":1,"c":2,"d":3}},"lazy":{"__proto__":1,"keep":2}}');
	assert.deepEqual(JSON.parse(JSON.stringify(applyPatch(state, patch))), { working: { a: { d: 3 } }, lazy: { keep: 2 } });
});
