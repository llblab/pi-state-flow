import assert from "node:assert/strict";
import test from "node:test";
import { captureScopeSelection, DEFAULT_SCOPE_SELECTION, parseScopeSelectionArguments, scopeSelectionArgumentCompletions } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

test("scope completions replace full prefixes with legal unused-owner tokens only", () => {
	const cases: Array<[string, string[]]> = [
		["", ["global", "cwd", "session"]], ["s", ["session"]], ["cwd", ["cwd"]],
		["cwd ", ["cwd global", "cwd session"]], ["session g", ["session global"]],
		[" \tglobal\tc", ["global cwd"]], ["session cwd ", ["session cwd global"]],
		["global cwd session ", []], ["cwd cwd ", []], ["CWD ", []], ["--cwd", []], ["session cX", []],
	];
	for (const [prefix, expected] of cases) {
		assert.deepEqual(scopeSelectionArgumentCompletions(prefix), expected, prefix);
		for (const value of expected) assert.ok(parseScopeSelectionArguments(value));
	}
});

const order: StateScope[] = ["global", "cwd", "session"];
const selections = Array.from({ length: 7 }, (_, index) => order.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0));
function permutations(values: StateScope[]): StateScope[][] {
	return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, other) => index !== other)).map((rest) => [value, ...rest]));
}

test("every nonempty scope subset and permutation captures canonical immutable overlay order", () => {
	assert.equal(selections.length, 7);
	for (const selection of selections) for (const input of permutations(selection)) {
		const before = [...input];
		const captured = captureScopeSelection(input);
		assert.deepEqual(captured, selection);
		assert.deepEqual(input, before);
		assert.notEqual(captured, input);
		assert.equal(Object.isFrozen(captured), true);
		assert.deepEqual(captureScopeSelection(JSON.parse(JSON.stringify(captured))), captured);
	}
});

test("explicit invalid selections never become absence or a wider fallback", () => {
	const inherited = Object.setPrototypeOf(new Array(1), { 0: "global" });
	const invalid: unknown[] = [
		undefined, null, false, true, 0, "", "global", "global cwd", {}, { scopes: ["global"] },
		[], new Array(1), ["global", , "session"], inherited,
		[undefined], [null], [true], [1], [{}], [["cwd"]],
		[""], ["CWD"], ["Global"], [" session"], ["cwd "], ["effective"], ["none"], ["all"],
		["global", "global"], ["global", "cwd", "global"], ["session", "session"], ["global", "cwd", "session", "global"],
	];
	for (const input of invalid) assert.throws(() => captureScopeSelection(input), /State Flow scopes must be a nonempty unique array/);
});

test("command parsing accepts exactly canonical whitespace-separated scopes in either order", () => {
	for (const selection of selections) for (const input of permutations(selection)) {
		assert.deepEqual(parseScopeSelectionArguments(` \t${input.join(" \n\t")}\r\n`), selection);
	}
	for (const args of ["global global", "cwd session cwd", "CWD", "Session", "all", "none", "effective", "--scopes cwd", "--cwd", "cwd,session", "cwd+session", '"cwd"', '["cwd"]']) {
		assert.throws(() => parseScopeSelectionArguments(args), /State Flow scopes/);
	}
});

test("blank command arguments are absence, while an explicitly empty array is invalid", () => {
	for (const args of ["", " ", "\t\r\n"]) assert.equal(parseScopeSelectionArguments(args), undefined);
	assert.throws(() => captureScopeSelection([]), /State Flow scopes/);
	assert.throws(() => captureScopeSelection(undefined), /State Flow scopes/);
	assert.deepEqual(captureScopeSelection(DEFAULT_SCOPE_SELECTION), order);
	assert.equal(Object.isFrozen(DEFAULT_SCOPE_SELECTION), true);
	assert.throws(() => {
		// @ts-expect-error The published value type must prohibit in-place changes too.
		DEFAULT_SCOPE_SELECTION.push("cwd");
	}, TypeError);
});

test("captured defaults, retained policy and inherited child values do not share mutable selection state", () => {
	const defaults: StateScope[] = ["cwd"];
	const retained = captureScopeSelection(defaults);
	const child = captureScopeSelection(retained);
	defaults.splice(0, defaults.length, "session");
	const independent = captureScopeSelection(defaults);
	assert.deepEqual(retained, ["cwd"]);
	assert.deepEqual(child, ["cwd"]);
	assert.deepEqual(independent, ["session"]);
	assert.notEqual(retained, child);
	assert.notEqual(retained, independent);
	assert.throws(() => {
		// @ts-expect-error A captured owner set is readonly independently of its runtime freeze.
		retained[0] = "global";
	}, TypeError);
	assert.deepEqual(child, ["cwd"]);
	assert.equal(parseScopeSelectionArguments(""), undefined, "mode-only callers must retain their existing captured choice");
});

test("equivalent captures are values, not request lifetime or publication authority", () => {
	const original = captureScopeSelection(["session"]);
	captureScopeSelection(["cwd"]);
	const repeated = captureScopeSelection(["session"]);
	assert.deepEqual(original, repeated);
	assert.notEqual(original, repeated);
	assert.deepEqual(Object.keys(original), ["0"]);
});
