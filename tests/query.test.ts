import assert from "node:assert/strict";
import test from "node:test";
import { findStateReferenceSources, parseStateReadPath, readProjectedState, readStatePath, type StateReadResult } from "../lib/query.ts";
import { emptyState, type SemanticState } from "../lib/state.ts";
import { advanceTemporalState, adoptSelectedTemporalStreams, constrainTemporalState, createSelectedTemporalState, createTemporalState, selectTemporalState, type SelectedTemporalState } from "../lib/temporal.ts";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";

{
	const owners = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(owners.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
	function fixture(selection: ScopeSelection, limit = 7) {
		const view = createSelectedTemporalState(Object.fromEntries(selection.map(scope => [scope, {
			strategy: { owner: scope }, lazy: { deck: [1, 2, 3], todo: { next: true } },
		}])), selection, "origin", limit);
		return advanceTemporalState(view, selection.map(scope => ({ scope, patch: { tactics: { done: scope }, lazy: { todo: { next: false } } } })), "selected-step", limit);
	}

	test("selected semantic queries compose only exact owners across all subsets and retention windows", () => {
		for (const selection of selections) for (const limit of [0, 1, 7, 100]) {
			const view = fixture(selection, limit);
			assert.deepEqual(readProjectedState(view, ["strategy.owner"], "value", limit), { value: selection.at(-1) });
			for (const scope of selection) {
				assert.deepEqual(readProjectedState(view, [`${scope}.strategy.owner`], "value", limit), { value: scope });
				assert.deepEqual(readProjectedState(view, [`${scope}.lazy.deck[1..3]`], "value", limit), { value: [2, 3] });
				assert.deepEqual(readProjectedState(view, [`${scope}.lazy.deck`], "keys", limit), { meta: { type: "array", length: 3 }, keys: [] });
				if (limit > 0) {
					assert.equal("state" in readStatePath(view, `${scope}[1]`, limit), true);
					const patch = readStatePath(view, `${scope}.patches`, limit);
					assert.equal("patch" in patch && patch.boundary.id, "selected-step");
					assert.deepEqual(readProjectedState(view, [`${scope}.tactics`], "patch", limit), { patch: { done: scope } });
				} else assert.throws(() => readStatePath(view, `${scope}.patches`, limit), /predates retained/);
			}
			if (limit > 0) assert.deepEqual(readProjectedState(view, ["tactics"], "patch", limit), { patch: { done: selection.at(-1) } });
			assert.deepEqual(readProjectedState(view, selection.map(scope => `${scope}.strategy.owner`), "value", limit), { value: selection.length === 1 ? selection[0] : [...selection] });
		}
	});

	test("excluded state, patch, keys and reference-source queries reject before disabled owner getters and never become hints", () => {
		for (const selection of selections.filter(selection => selection.length < 3)) {
			const view = fixture(selection); let reads = 0;
			for (const disabled of owners.filter(owner => !selection.includes(owner))) {
				Object.defineProperty(view.scopes, disabled, { configurable: true, get() { reads++; throw new Error("excluded semantic body must not be observed"); } });
				for (const projection of ["value", "keys", "patch"] as const) {
					assert.throws(() => readProjectedState(view, [`${disabled}.lazy.missing`], projection), /scope is excluded/);
				}
				for (const path of [disabled, `${disabled}[1]`, `${disabled}.patches`, `${disabled}.patches[1]`]) {
					assert.throws(() => readStatePath(view, path), /scope is excluded/);
				}
				assert.throws(() => findStateReferenceSources(view, `${disabled}.lazy.missing`), /scope is excluded/);
				assert.throws(() => readProjectedState(view, [`${selection[0]}.strategy`, `${disabled}.strategy`]), /scope is excluded/);
			}
			assert.equal(reads, 0);
		}
	});

	test("reactive hints inspect only selected source owners and preserve canonical reference ownership", () => {
		for (const selection of selections) {
			const target = `${selection.at(-1)}.lazy.missing`;
			const view = createSelectedTemporalState(Object.fromEntries(selection.map(scope => [scope, {
				intents: { ask: { $ref: target } }, lazy: { known: true }, response: `Do not scan $${target}`,
			}])), selection, "reference-origin");
			let disabledReads = 0;
			for (const scope of owners.filter(scope => !selection.includes(scope))) Object.defineProperty(view.scopes, scope, { get() { disabledReads++; throw new Error("hidden source"); } });
			const refs = findStateReferenceSources(view, target);
			assert.equal(refs.sources.length, selection.length);
			assert.deepEqual(refs.sources.map(source => source.scope).sort(), [...selection].sort());
			assert.equal(refs.sources.every(source => source.form === "structured" && source.path.endsWith(".intents.ask")), true);
			const projected = readProjectedState(view, [target]);
			assert.equal("hint" in projected && projected.hint?.[0]?.type, "dangling-reference");
			assert.equal(disabledReads, 0);
		}
	});

	test("selected patch projection distinguishes folded unavailable deltas from genuinely known no-op boundaries", () => {
		const folded = fixture(["cwd"], 0);
		assert.throws(() => readProjectedState(folded, ["cwd.tactics"], "patch", 0), /patch predates retained/);
		assert.throws(() => readProjectedState(folded, ["tactics"], "patch", 0), /patch predates retained/);
		let full = createTemporalState({ global: {}, cwd: {}, session: {} }, "base");
		full = advanceTemporalState(full, [{ scope: "global", patch: { strategy: { hidden: true } } }], "excluded-step");
		const selected = selectTemporalState(full, ["cwd"]);
		for (const view of [selected, constrainTemporalState(selected, 0)]) {
			const limit = view.lineage.length === 1 ? 0 : 7;
			assert.deepEqual(readProjectedState(view, ["cwd"], "patch", limit), { patch: {} });
			assert.deepEqual(readProjectedState(view, ["effective"], "patch", limit), { patch: {} });
			assert.throws(() => readStatePath(view, "cwd.patches", limit), /predates retained/);
		}
	});

	test("a current-only observation origin grants no invented prior effective history or new semantic patch", () => {
		const source = fixture(["global", "session"]);
		const observation = adoptSelectedTemporalStreams(source.scopes, source.selection, "observation:current");
		assert.deepEqual(readProjectedState(observation, ["strategy.owner"]), { value: "session" });
		assert.deepEqual(readProjectedState(observation, ["effective"], "patch"), { patch: {} });
		assert.deepEqual(readProjectedState(observation, ["session"], "patch"), { patch: {} });
		assert.throws(() => readProjectedState(observation, ["effective[1]"]), /predates the proven temporal origin/);
	});

	test("selected query outputs remain detached and preserve historical null deletion patches", () => {
		let view = createSelectedTemporalState({ cwd: { strategy: { keep: { one: true }, remove: "old" } } }, ["cwd"], "base");
		view = advanceTemporalState(view, [{ scope: "cwd", patch: { strategy: { remove: null } } }], "delete");
		assert.deepEqual(readProjectedState(view, ["cwd.strategy.remove"], "patch"), { patch: null });
		const current = readProjectedState(view, ["strategy"]);
		assert.equal("value" in current, true); if ("value" in current) (current.value as { keep: { one: boolean } }).keep.one = false;
		const patch = readStatePath(view, "cwd.patches"); if ("patch" in patch) (patch.patch as { strategy: { remove: unknown } }).strategy.remove = "mutated";
		assert.deepEqual(readProjectedState(view, ["strategy.keep.one"]), { value: true });
		assert.deepEqual(readProjectedState(view, ["strategy.remove"], "patch"), { patch: null });
	});

	test("effective patch deltas preserve own special keys for creation, update and deletion in selected and legacy views", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) for (const selected of [true, false]) {
			let view = selected ? createSelectedTemporalState({ cwd: { tactics: { retain: "anchor" } } }, ["cwd"], "base")
				: createTemporalState({ global: {}, cwd: { tactics: { retain: "anchor" } }, session: {} }, "base");
			for (const [index, value] of [{ one: true }, { one: false }, null].entries()) {
				const patch = JSON.parse(`{"tactics":{${JSON.stringify(key)}:${JSON.stringify(value)}}}`);
				view = advanceTemporalState(view, [{ scope: "cwd", patch }], `special-${index}`);
				const explicit = readProjectedState(view, ["cwd.tactics"], "patch");
				assert.deepEqual(readProjectedState(view, ["effective.tactics"], "patch"), explicit);
				assert.deepEqual(explicit, { patch: JSON.parse(`{${JSON.stringify(key)}:${JSON.stringify(value)}}`) });
			}
		}
	});

	test("malformed-present selected policy/envelopes never widen to legacy query defaults or fake empty patch success", () => {
		for (const selection of [[], null, ["cwd", "cwd"], ["cwd", "unknown"]]) {
			const view = { ...fixture(["cwd"]), selection } as unknown as SelectedTemporalState;
			assert.throws(() => readProjectedState(view, ["effective"], "patch"), /nonempty unique/);
		}
		const missing = fixture(["cwd"]); delete (missing as unknown as { selection?: ScopeSelection }).selection;
		assert.throws(() => readProjectedState(missing, ["effective"], "patch"), /nonempty unique/);
		const malformed = createSelectedTemporalState({ cwd: {} }, ["cwd"], "base");
		delete malformed.scopes.cwd;
		assert.throws(() => readProjectedState(malformed, ["effective"], "patch"), /owners must match/);
		const extra = createSelectedTemporalState({ cwd: {} }, ["cwd"], "base"); let reads = 0;
		Object.defineProperty(extra.scopes, "session", { enumerable: true, get() { reads++; throw new Error("excluded body"); } });
		assert.throws(() => readProjectedState(extra, ["effective"], "patch"), /owners must match/);
		assert.equal(reads, 0);
	});
}

function state(result: StateReadResult) {
	if (!("state" in result)) assert.fail("Expected a state result");
	return result.state;
}

test("explicit current and historical hot reads preserve legacy empty objects", () => {
	const legacy: SemanticState = { tactics: { chain: { empty: {} }, items: [{ empty: {} }, {}] }, intents: {}, lazy: { empty: {} } };
	let view = createTemporalState({ global: legacy, cwd: {}, session: {} }, "origin");
	view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { next: true } } }], "next");
	const before = structuredClone(view);
	assert.deepEqual(readProjectedState(view, ["global.tactics.chain"]), { value: { empty: {} } });
	assert.deepEqual(readProjectedState(view, ["global[1].tactics.chain"]), { value: { empty: {} } });
	assert.deepEqual(readProjectedState(view, ["global[1].tactics.items"]), { value: [{ empty: {} }, {}] });
	assert.deepEqual(readProjectedState(view, ["global[1].intents"]), { value: {} });
	assert.deepEqual(readProjectedState(view, ["global[1].lazy.empty"]), { value: {} });
	assert.deepEqual(view, before);
});

test("optimistic views omit absent and unknown planes across scopes and history, with null for absent value reads", () => {
	let view = createTemporalState({ global: { extra: { ignored: null } }, cwd: {}, session: { response: "" } }, "empty");
	assert.deepEqual(readProjectedState(view, ["effective"]), { value: {} });
	assert.deepEqual(readProjectedState(view, ["effective"], "keys"), { meta: { type: "object", size: 0 }, keys: {} });
	assert.deepEqual(readProjectedState(view, ["session.response", "cwd.lazy", "global.intents"]), { value: [null, null, null] });
	view = advanceTemporalState(view, [
		{ scope: "global", patch: { tactics: { shared: true }, extra: { ignored: [1] } } },
		{ scope: "session", patch: { response: "Answer" } },
	], "answer");
	view = advanceTemporalState(view, [{ scope: "session", patch: { response: "", surplus: "ignored" } }], "empty-answer");
	const before = structuredClone(view);
	assert.deepEqual(readProjectedState(view, ["effective"]), { value: { tactics: { shared: true } } });
	assert.deepEqual(readProjectedState(view, ["session.response"]), { value: null });
	assert.deepEqual(readProjectedState(view, ["session[1].response"]), { value: "Answer" });
	assert.deepEqual(readProjectedState(view, ["effective[2]"]), { value: {} });
	assert.deepEqual(readProjectedState(view, ["effective.response"], "patch"), { patch: null });
	const tail = readStatePath(view, "session.patches");
	assert.ok("patch" in tail);
	assert.deepEqual(tail.patch, { response: null });
	assert.throws(() => readProjectedState(view, ["global.extra"]), /does not exist/);
	assert.deepEqual(view, before, "projection must not normalize or delete stored semantics");
});

test("current-as-zero projection roots resolve state on the shared causal lineage", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { value: "G1" } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { value: "S2" } } }], "T2");
	assert.deepEqual(state(readStatePath(view, "effective")), state(readStatePath(view, "effective[0]")));
	assert.deepEqual(state(readStatePath(view, "global")), state(readStatePath(view, "global[0]")));
	assert.equal(state(readStatePath(view, "effective")).tactics!.value, "S2");
	assert.equal(state(readStatePath(view, "global[1]")).tactics!.value, "G1");
	assert.deepEqual(state(readStatePath(view, "session[1]")).tactics, {});
});

test("scope patch paths index accepted patches for that scope", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { first: true } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { other: true } } }], "T2");
	view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { second: true } } }], "T3");
	const latest = readStatePath(view, "global.patches");
	const latestIndexed = readStatePath(view, "global.patches[0]");
	assert.ok("patch" in latest && "patch" in latestIndexed);
	assert.deepEqual(latest.patch, latestIndexed.patch);
	assert.deepEqual(latest.boundary, latestIndexed.boundary);
	assert.equal(readStatePath(view, "global.patches[0]").boundary.id, "T3");
	assert.equal(readStatePath(view, "global.patches[1]").boundary.id, "T1");
	assert.throws(() => readStatePath(view, "cwd.patches"), /predates retained hot history/);
});

test("path grammar rejects ambiguous, unknown, and out-of-range forms", () => {
	for (const path of ["", "state", "state.effective", "effective.global", "global[1].patches", "global.patches[8]"]) {
		assert.throws(() => parseStateReadPath(path));
	}
	assert.deepEqual(parseStateReadPath("cwd.patches[7]"), { kind: "patch", path: "cwd.patches[7]", offset: 7, scope: "cwd" });
	assert.deepEqual(parseStateReadPath("session[12]", 12), { kind: "state", path: "session[12]", offset: 12, scope: "session" });
	assert.throws(() => parseStateReadPath("session[13]", 12), /integer from 0 to 12/);
	assert.deepEqual(parseStateReadPath("session", 0), { kind: "state", path: "session", offset: 0, scope: "session" });
	assert.throws(() => parseStateReadPath("session[1]", 0), /integer from 0 to 0/);
	assert.throws(() => parseStateReadPath("session", 101), /history limit.*0 to 100/);
});

test("projected reads return pure values, strict ranges, and minimal structural keys", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{
		scope: "cwd",
		patch: { tactics: { memory: ["zero", "one", { nested: true }], rule: "compact", enabled: true } },
	}], "T1");
	assert.deepEqual(readProjectedState(view, ["effective.tactics.memory[0:2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["tactics.memory[0:2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["tactics.memory[0..2]"]), { value: ["zero", "one"] });
	assert.deepEqual(readProjectedState(view, ["tactics.memory[3:3]"]), { value: [] });
	assert.deepEqual(readProjectedState(view, ["tactics"]), readProjectedState(view, ["effective.tactics"]));
	assert.throws(() => readProjectedState(view, ["unknown.memory"]), /requires a semantic path/);
	assert.deepEqual(readProjectedState(view, ["cwd.tactics"], "keys"), {
		meta: { type: "object", size: 3 },
		keys: { memory: "array", rule: "string", enabled: "boolean" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.memory"], "keys"), {
		meta: { type: "array", length: 3 },
		keys: [],
	});
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.rule"], "keys"), {
		meta: { type: "string", length: 7 },
		keys: [],
	});
	assert.throws(() => readProjectedState(view, ["cwd.tactics.memory[0:4]"]), /Range \[0:4\].*length 3/);
	assert.throws(() => readProjectedState(view, ["cwd.tactics.memory[2:1]"]), /Range \[2:1\].*length 3/);
	assert.throws(() => readProjectedState(view, ["cwd.tactics.memory[0.2]"]), /Invalid State Flow read path selector/);
	assert.throws(() => readProjectedState(view, ["cwd.tactics.план"]), /object keys must match \[A-Za-z_\$\]\[A-Za-z0-9_\$-\]\* \(ASCII\)/);
	assert.throws(() => readProjectedState(view, ["cwd.tactics.missing"]), /does not exist/);
});

test("intents are hot, historical, scoped, patch-readable, and references remain explicit values", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { intents: { policy: "Finish current projects" } } }], "T1");
	view = advanceTemporalState(view, [{
		scope: "cwd",
		patch: {
			intents: { release: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } } },
			lazy: { releasePlan: { steps: ["validate", "publish"] } },
		},
	}], "T2");
	assert.deepEqual(state(readStatePath(view, "effective")).intents, {
		policy: "Finish current projects",
		release: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release"]), {
		value: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["intents.release"]), {
		value: { action: "Execute accepted plan", plan: { $ref: "cwd.lazy.releasePlan" } },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release"], "keys"), {
		meta: { type: "object", size: 2 }, keys: { action: "string", plan: "object" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd.intents.release.plan"], "patch"), {
		patch: { $ref: "cwd.lazy.releasePlan" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].intents"]), { value: {} });
	assert.deepEqual(readProjectedState(view, ["cwd.lazy.releasePlan"]), {
		value: { steps: ["validate", "publish"] },
	});
});

test("missing reads reactively identify exact durable reference sources without returning diagnostics as state", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{
		scope: "cwd",
		patch: {
			intents: { release: { plan: { $ref: "cwd.lazy.missing" } } },
			tactics: {
				note: "Continue from `$cwd.lazy.missing` when needed.",
				lookalike: "Do not match `$cwd.lazy.missingExtra`.",
			},
		},
	}], "T1");
	assert.deepEqual(findStateReferenceSources(view, "cwd.lazy.missing"), {
		sources: [
			{ scope: "cwd", path: "cwd.intents.release.plan", form: "structured" },
			{ scope: "cwd", path: "cwd.tactics.note", form: "text" },
		],
		truncated: false,
	});
	assert.deepEqual(readProjectedState(view, ["cwd.lazy.missing"]), {
		value: null,
		hint: [{
			type: "dangling-reference",
			message: "The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task.",
			paths: ["cwd.intents.release.plan", "cwd.tactics.note"],
		}],
	});
	assert.throws(
		() => readProjectedState(view, ["cwd.lazy.invented"]),
		(error: unknown) => error instanceof Error && !error.message.includes("hint"),
	);
	assert.throws(() => readProjectedState(view, ["cwd.lazy.missing"], "keys"), /does not exist/);
	assert.throws(() => readProjectedState(view, ["cwd.tactics.note", "cwd.lazy.missing"]), /does not exist/);
});

test("implicit missing paths match explicit effective references", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "session", patch: {
		tactics: { note: "See `$effective.lazy.missing` only if needed." },
	} }], "T1");
	assert.deepEqual(findStateReferenceSources(view, "lazy.missing"), {
		sources: [{ scope: "session", path: "session.tactics.note", form: "text" }],
		truncated: false,
	});
	assert.deepEqual(readProjectedState(view, ["lazy.missing"]), {
		value: null,
		hint: [{
			type: "dangling-reference",
			message: "The requested value is unavailable in the selected state. These current values reference that path, not a verified new location. Use this evidence if relevant to the task.",
			paths: ["session.tactics.note"],
		}],
	});
});

test("missing hints expose current reference owners without lazy bodies or historical recovery", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "session", patch: { lazy: {
		target: "HISTORICAL-BODY", owner: { ref: { $ref: "session.lazy.target" }, body: "OWNER-BODY".repeat(4096) },
	} } }], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { lazy: { target: null } } }], "T2");
	const before = structuredClone(view);
	const result = readProjectedState(view, ["session.lazy.target"]);
	assert.ok("value" in result);
	assert.equal(result.value, null);
	assert.deepEqual(result.hint?.[0]?.paths, ["session.lazy.owner.ref"]);
	assert.match(result.hint![0]!.message, /if relevant to the task/);
	assert.doesNotMatch(JSON.stringify(result), /HISTORICAL-BODY|OWNER-BODY|Reconcile|restore|search history/);
	assert.deepEqual(readProjectedState(view, ["session[1].lazy.target"]), { value: "HISTORICAL-BODY" });
	assert.deepEqual(readProjectedState(view, ["session.lazy.target"], "patch"), { patch: null });
	assert.throws(() => readProjectedState(view, ["session.lazy.target"], "keys"), /does not exist/);
	assert.throws(() => readProjectedState(view, ["session.lazy.owner", "session.lazy.target"]), /does not exist/);
	assert.throws(() => readProjectedState(view, ["session[3].lazy.target"]), /predates/);
	assert.deepEqual(view, before);
	view = advanceTemporalState(view, [{ scope: "session", patch: { lazy: { owner: null } } }], "T3");
	assert.throws(() => readProjectedState(view, ["session.lazy.target"]), /does not exist/, "historical owners cannot produce a current hint");
});

test("lazy values remain absent from hot projection and readable through scoped and effective paths", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { lazy: { memory: ["global"], rules: { retained: true } } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "cwd", patch: { lazy: { memory: ["cwd"], rules: { project: true } } } }], "T2");
	view = advanceTemporalState(view, [{ scope: "session", patch: { lazy: { rules: { current: true } } } }], "T3");
	assert.equal(Object.hasOwn(state(readStatePath(view, "effective")), "lazy"), false);
	assert.deepEqual(readProjectedState(view, ["global.lazy.memory"]), { value: ["global"] });
	assert.deepEqual(readProjectedState(view, ["effective.lazy"]), {
		value: { memory: ["cwd"], rules: { retained: true, project: true, current: true } },
	});
	assert.deepEqual(readProjectedState(view, ["lazy.memory"]), { value: ["cwd"] });
	assert.deepEqual(readProjectedState(view, ["effective.lazy.rules"], "keys"), {
		meta: { type: "object", size: 3 },
		keys: { retained: "boolean", project: "boolean", current: "boolean" },
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].lazy.memory"]), { value: ["cwd"] });
});

test("patch projection intersects explicit and effective paths at one historical boundary", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "global", patch: { tactics: { inherited: "G", removed: true } } }], "T1");
	view = advanceTemporalState(view, [{ scope: "cwd", patch: { tactics: { memory: ["zero", "one"], rule: "first" } } }], "T2");
	view = advanceTemporalState(view, [
		{ scope: "global", patch: { tactics: { removed: null } } },
		{ scope: "cwd", patch: { tactics: { memory: ["zero", "corrected"], rule: "second" } } },
	], "T3");
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.memory"], "patch"), { patch: ["zero", "corrected"] });
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.memory[0:1]"], "patch"), { patch: ["zero"] });
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.memory[0..1]"], "patch"), { patch: ["zero"] });
	assert.deepEqual(readProjectedState(view, ["cwd.tactics.missing"], "patch"), { patch: {} });
	assert.deepEqual(readProjectedState(view, ["global.tactics.removed"], "patch"), { patch: null });
	assert.deepEqual(readProjectedState(view, ["effective.tactics.rule", "effective.tactics.removed"], "patch"), {
		patch: ["second", null],
	});
	assert.deepEqual(readProjectedState(view, ["tactics.rule", "tactics.removed"], "patch"), {
		patch: ["second", null],
	});
	assert.deepEqual(readProjectedState(view, ["cwd[1].tactics.rule"], "patch"), { patch: "first" });
});

test("projected path batches preserve order and fail as one read", () => {
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "T0");
	view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { first: "A", second: [1, 2] } } }], "T1");
	assert.deepEqual(readProjectedState(view, ["session.tactics.second[1]", "session.tactics.first"]), { value: [2, "A"] });
	assert.deepEqual(readProjectedState(view, ["session.tactics.second", "session.tactics"], "keys"), {
		meta: [{ type: "array", length: 2 }, { type: "object", size: 2 }],
		keys: [[], { first: "string", second: "array" }],
	});
	assert.throws(() => readProjectedState(view, ["session.tactics.first", "session.tactics.second[2]"]), /outside.*length 2/);
});
