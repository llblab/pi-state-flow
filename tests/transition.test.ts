import assert from "node:assert/strict";
import test from "node:test";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition, stageSelectedScopePatches, stageSelectedScopedTransition, commitSelectedTransition, type SelectedSemanticBasis } from "../lib/transition.ts";
import { createAcceptedTransition, type AcceptedTransition } from "../lib/history.ts";
import { ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import { advanceTemporalState, createSelectedTemporalState, createTemporalState, readTemporalScopes, readTemporalState, readTemporalView } from "../lib/temporal.ts";
import { captureScopeSelection } from "../lib/selection.ts";
import type { SuccessfulSkillRead } from "../lib/skills.ts";
import type { SuccessfulArtifactRead } from "../lib/acquisition.ts";
import { parseScopeStream, serializeScopeMetadata, serializeScopeStream } from "../lib/durable.ts";
import { emptyState, type AtomicScopePatches, type ScopedSemanticStates, type ScopedStates, type ScopeStateValues, type StateScope } from "../lib/state.ts";
import { loadCwdState, loadGlobalState, loadSessionMaterialization, loadSessionState } from "./temporal-fixture.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { commitScopedTerminal, commitTerminal, harness, start } from "./harness.ts";
import type { StateFlowModule } from "../api/modules.ts";

test("host producer replacements share intent-first staging while immutable model writes remain forbidden", () => {
	const definition: StateFlowModule = { id: "x_archive", apiVersion: 1, schemaVersion: 1, immutable: true,
		validate: (value): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value), context: () => [] };
	const current: SelectedSemanticBasis = { selection: ["cwd"], modules: { cwd: { x_archive: { schemaVersion: 1, immutable: true } } }, states: { cwd: {
		x_archive: { note: "old", obsolete: true }, intents: { old: { $ref: "cwd.lazy.owned" } }, lazy: { owned: { stale: true } }, tactics: { keep: true, legacyEmpty: {} },
	} } };
	const original = structuredClone(current);
	const stage = stageSelectedScopePatches(current, { cwd: { intents: { old: null } } }, [], "basis", [], [definition], [{ scope: "cwd", id: "x_archive", content: { note: "new" } }]);
	assert.deepEqual(stage.nextStates.cwd!.x_archive, { note: "new" }); assert.equal(stage.nextStates.cwd!.lazy, undefined);
	assert.deepEqual(stage.nextStates.cwd!.tactics, { keep: true }); assert.deepEqual(current, original); assert.equal(stage.moduleAdditions, undefined);
	assert.throws(() => stageSelectedScopePatches(current, { cwd: { x_archive: { note: "manual" } } }, [], "basis", [], [definition]), /Immutable/);
	const removed = stageSelectedScopePatches(current, {}, [], "basis", [], [definition], [{ scope: "cwd", id: "x_archive", content: {} }]);
	assert.equal(removed.nextStates.cwd!.x_archive, undefined); assert.deepEqual(current.modules, original.modules);
	assert.deepEqual(removed.nextStates.cwd!.tactics, { keep: true, legacyEmpty: {} }, "a module-only replacement cannot curate unrelated built-in content");
	const fresh = stageSelectedScopePatches({ selection: ["cwd"], states: { cwd: {} } }, {}, [], "basis", [], [definition], [{ scope: "cwd", id: "x_archive", content: { note: "first" } }]);
	assert.deepEqual(fresh.moduleAdditions, { cwd: { x_archive: { schemaVersion: 1, immutable: true } } });
	for (const replacements of [
		[{ scope: "session" as const, id: "x_archive", content: {} }], [{ scope: "cwd" as const, id: "response", content: {} }],
		[{ scope: "cwd" as const, id: "x_archive", content: { stored: null } }],
		[{ scope: "cwd" as const, id: "x_archive", content: {} }, { scope: "cwd" as const, id: "x_archive", content: {} }],
	]) assert.throws(() => stageSelectedScopePatches(current, {}, [], "basis", [], [definition], replacements));
});

test("external model authoring validates complete detached objects and exact retained policy in the single engine", () => {
	let calls = 0;
	const definition: StateFlowModule = { id: "x_notes", apiVersion: 1, schemaVersion: 1, immutable: false,
		validate: (value): value is JsonObject => { calls++; const valid = typeof (value as JsonObject).note === "string"; (value as JsonObject).note = "validator alias"; return valid; },
		context: () => [] };
	const basis: SelectedSemanticBasis = { selection: ["cwd"], states: { cwd: { tactics: { untouched: true } } } };
	const stage = stageSelectedScopePatches(basis, { cwd: { x_notes: { note: "kept", empty: {} } } }, [], "basis", [], [definition]);
	assert.deepEqual(stage.nextStates.cwd!.x_notes, { note: "kept", empty: {} });
	assert.deepEqual(stage.moduleAdditions, { cwd: { x_notes: { schemaVersion: 1, immutable: false } } });
	assert.deepEqual(basis.states.cwd, { tactics: { untouched: true } });
	const retained: SelectedSemanticBasis = { selection: ["cwd"], states: stage.nextStates, modules: stage.moduleAdditions };
	const partial = stageSelectedScopePatches(retained, { cwd: { x_notes: { extra: true } } }, [], "basis", [], [definition]);
	assert.deepEqual(partial.nextStates.cwd!.x_notes, { note: "kept", empty: {}, extra: true });
	assert.equal(partial.moduleAdditions, undefined);
	assert.throws(() => stageSelectedScopePatches(retained, { cwd: { x_notes: { note: 4 } } }, [], "basis", [], [definition]), /Invalid.*module content/);
	const before = calls;
	for (const definitions of [[], [{ ...definition, immutable: true }], [{ ...definition, schemaVersion: 2 }]]) {
		assert.throws(() => stageSelectedScopePatches(retained, { cwd: { x_notes: { note: "refused" } } }, [], "basis", [], definitions), /Unknown|Immutable|Unavailable/);
	}
	assert.equal(calls, before, "missing, immutable and mismatched owners reject before callbacks");
	assert.throws(() => stageSelectedScopePatches(retained, { session: { x_notes: { note: "excluded" } } }, [], "basis", [], [definition]), /excluded/);
	const removed = stageSelectedScopePatches(retained, { cwd: { x_notes: { note: null, empty: null } as unknown as JsonObject } }, [], "basis", [], [definition]);
	assert.equal(removed.nextStates.cwd!.x_notes, undefined);
	assert.equal(removed.moduleAdditions, undefined);
});

test("metadata4 opaque planes survive the single staging engine, folding and exact bounded replay without registrations", () => {
	for (const limit of [0, 1, 7, 100]) for (const scope of ["global", "cwd", "session"] as const) {
		let view = createTemporalState({ global: {}, cwd: {}, session: {} }, `external-${scope}-${limit}`, limit);
		const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
		view.scopes[scope].modules = modules;
		const opaque = JSON.parse('{"empty":{},"slots":[{},[],{"empty":{}}],"__proto__":{"constructor":{}},"a/b~c":{"keep":{},"remove":"old"}}');
		const snapshots = new Map([[0, readTemporalScopes(view, 0, limit)[scope]]]);
		for (let index = 1; index <= limit + 5; index++) {
			let patches;
			if (index === 1) patches = [{ scope, patch: { x_acme_archive: opaque } }];
			else if (index === 2) patches = [{ scope, patch: { x_acme_archive: { "a/b~c": { remove: null, revision: 2 } } } }];
			else if (index === 3) patches = [{ scope, patch: { x_acme_archive: null } }];
			else if (index === 4) patches = [{ scope, patch: { x_acme_archive: opaque } }];
			else {
				const before = readTemporalScopes(view, 0, limit);
				const staged = stageAtomicScopePatches(before, { [scope]: { tactics: { index, discard: {} } } }, [], "opaque-basis");
				assert.deepEqual(staged.nextStates[scope].x_acme_archive, opaque);
				const accepted = createAcceptedTransition(before, staged.nextStates)!;
				assert.equal(Object.hasOwn(accepted.transitions[0]!.patch, "x_acme_archive"), false);
				patches = accepted.transitions;
			}
			view = advanceTemporalState(view, patches, `external-${scope}-${limit}-${index}`, limit);
			snapshots.set(index, readTemporalScopes(view, 0, limit)[scope]);
			if (index > 4 && index < limit) continue;
			const stream = view.scopes[scope], identity = scope === "cwd" ? "/opaque" : undefined;
			const wire = serializeScopeStream(stream, scope, identity);
			const reloaded = parseScopeStream(wire.checkpoint, wire.patches, scope, identity, serializeScopeMetadata(undefined, stream, scope, identity))!;
			assert.deepEqual(reloaded, stream, "descriptor/revision/causal identity and raw replay roundtrip");
			view.scopes[scope] = reloaded;
			for (let offset = 0; offset < view.lineage.length; offset++) {
				assert.deepEqual(readTemporalScopes(view, offset, limit)[scope], snapshots.get(index - offset));
				assert.deepEqual(readTemporalView(view, offset, scope, limit), snapshots.get(index - offset));
			}
			assert.deepEqual(view.scopes[scope].modules, modules);
		}
		for (const immutable of [true, false]) {
			view.scopes[scope].modules!.x_acme_archive!.immutable = immutable;
			assert.throws(() => stageAtomicScopePatches(readTemporalScopes(view, 0, limit), { [scope]: { x_acme_archive: {} } } as never, [], "closed"), /Unknown State Flow patch key/);
		}
	}
});

{
	const order = ["global", "cwd", "session"] as const;
	function basis(selection: readonly StateScope[]): SelectedSemanticBasis {
		return { selection: captureScopeSelection(selection), states: Object.fromEntries(selection.map((scope) => [scope, {
			strategy: { chosen: scope },
			intents: { task: { $ref: `${scope}.lazy.plan` }, cross: { $ref: `${scope === "cwd" ? "session" : "cwd"}.tactics.untouched` } },
			tactics: { marker: scope, untouched: "keep", slots: [{ last: 1 }, {}, []] }, lazy: { plan: ["next"] },
		}])) };
	}

	test("selected staging/commit uses one engine for every subset, preserves sparse cascades and exactly replays all retained offsets", () => {
		for (let mask = 1; mask < 8; mask++) for (const limit of [0, 1, 7, 100]) {
			const current = basis(order.filter((_, bit) => mask & (1 << bit)));
			const before = structuredClone(current.states);
			const temporal = createSelectedTemporalState(current.states, current.selection, "selected-origin", limit);
			const patches: AtomicScopePatches = Object.fromEntries(current.selection.map((scope) => [scope, {
				intents: { task: null }, tactics: { missing: { child: null }, slots: { "[0]": { last: null } }, explicit: {} }, lazy: { plan: ["too late"] },
			}]));
			const stage = stageSelectedScopePatches(current, patches, [], "selected-origin");
			for (const map of [stage.nextStates, stage.cascades, stage.stateHashes, stage.provenanceUpdates]) assert.deepEqual(Object.keys(map), current.selection);
			assert.equal(Object.isFrozen(stage.selection), true);
			assert.deepEqual(current.states, before);
			for (const scope of current.selection) {
				assert.deepEqual(stage.nextStates[scope]!.lazy, { plan: ["too late"] });
				assert.deepEqual(stage.nextStates[scope]!.tactics!.slots, [{}, {}, []]);
				assert.deepEqual(stage.cascades[scope], [{ plane: "lazy", keys: ["plan"] }]);
				assert.equal(stage.nextStates[scope]!.tactics!.untouched, "keep");
			}
			const snapshot = emptySnapshot("active");
			let accepted: AcceptedTransition | undefined;
			assert.equal(commitSelectedTransition(snapshot, current, stage, (cohort) => { accepted = cohort; }, "selected-origin", { finalizeRun: false }), true);
			assert.equal(snapshot.meta.step, 1);
			assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), current.selection);
			for (const { scope, patch } of accepted!.transitions) assert.deepEqual(applyPatch(before[scope]!, patch as JsonObject), current.states[scope]);
			const next = advanceTemporalState(temporal, accepted!.transitions, accepted!.id, limit);
			assert.deepEqual(readTemporalScopes(next, 0, limit), current.states);
			if (limit > 0) assert.deepEqual(readTemporalScopes(next, 1, limit), before);
			assert.equal(readTemporalView(next, 0, undefined, limit).tactics!.marker, current.selection.at(-1));
			assert.equal(commitSelectedTransition(snapshot, current, stage, () => assert.fail("duplicate publication"), "selected-origin"), false);
		}
	});

	test("intent-first cleanup rewrites all owned planes independently of key order and replays exact final state", () => {
		for (let mask = 1; mask < 8; mask++) for (const limit of [0, 1, 7, 100]) for (const intentsFirst of [true, false]) {
			const selection = captureScopeSelection(order.filter((_, bit) => mask & (1 << bit)));
			const current: SelectedSemanticBasis = { selection, states: Object.fromEntries(selection.map(scope => [scope, {
				intents: { done: { refs: ["strategy", "tactics", "lazy"].map(plane => ({ $ref: `${scope}.${plane}.epic` })) } },
				strategy: { epic: { stale: "remove", shared: "old" } },
				tactics: { epic: { stale: "remove" } }, lazy: { epic: { stale: "remove" } },
			}])) };
			const before = structuredClone(current.states);
			const temporal = createSelectedTemporalState(before, selection, "phase-origin", limit);
			const patches: AtomicScopePatches = Object.fromEntries(selection.map(scope => {
				const intents = { done: null };
				const other = { strategy: { epic: { conclusion: "durable" } }, tactics: { epic: { result: "done" } }, lazy: { epic: { archive: "fresh" } } };
				return [scope, intentsFirst ? { intents, ...other } : { ...other, intents }];
			}));
			const stage = stageSelectedScopePatches(current, patches, [], "phase-origin");
			assert.deepEqual(current.states, before);
			for (const scope of selection) {
				assert.deepEqual(stage.nextStates[scope], { strategy: { epic: { conclusion: "durable" } }, tactics: { epic: { result: "done" } }, lazy: { epic: { archive: "fresh" } } });
				assert.deepEqual(stage.cascades[scope]!.map(p => p.plane), ["lazy", "strategy", "tactics"]);
			}
			let accepted: AcceptedTransition | undefined;
			commitSelectedTransition(emptySnapshot("active"), current, stage, value => { accepted = value; }, "phase-origin", { finalizeRun: false });
			assert.ok(accepted);
			for (const { scope, patch } of accepted.transitions) assert.deepEqual(applyPatch(before[scope]!, patch as JsonObject), current.states[scope]);
			const next = advanceTemporalState(temporal, accepted.transitions, accepted.id, limit);
			assert.deepEqual(readTemporalScopes(next, 0, limit), current.states);
			if (limit > 0) assert.deepEqual(readTemporalScopes(next, 1, limit), before);
		}
	});

	test("new and surviving intents protect exact, ancestor and descendant ownership in all three planes", () => {
		for (const plane of ["strategy", "tactics", "lazy"] as const) for (const relation of ["exact", "ancestor", "descendant"] as const) {
			const oldPath = relation === "ancestor" ? "epic.child" : "epic";
			const newPath = relation === "descendant" ? "epic.child" : "epic";
			for (const newIntent of [false, true]) {
				const refs = { $ref: `cwd.${plane}.${newPath}` };
				const current: SelectedSemanticBasis = { selection: ["cwd"], states: { cwd: {
					intents: { done: { $ref: `cwd.${plane}.${oldPath}` }, ...(!newIntent ? { keep: refs } : {}) },
					[plane]: { epic: { child: "preserved", stale: "preserved" } },
				} } };
				const stage = stageSelectedScopePatches(current, { cwd: { [plane]: { epic: { result: "new" } }, intents: { done: null, ...(newIntent ? { keep: refs } : {}) } } }, [], "origin");
				assert.deepEqual(stage.cascades.cwd, []);
				assert.deepEqual(stage.nextStates.cwd![plane], { epic: { child: "preserved", stale: "preserved", result: "new" } });
			}
		}
	});

	test("phase cleanup remains atomic when a later authored plane is invalid", () => {
		const current: SelectedSemanticBasis = { selection: ["global", "cwd"], states: {
			global: { intents: { done: { $ref: "global.strategy.epic" } }, strategy: { epic: { old: true } } },
			cwd: { tactics: { keep: true } },
		} };
		const before = structuredClone(current.states);
		assert.throws(() => stageSelectedScopePatches(current, {
			global: { intents: { done: null }, strategy: { epic: { conclusion: "would replace" } } },
			cwd: { tactics: { invalid: [null] } },
		}, [], "origin"), /Materialized state cannot contain null/);
		assert.deepEqual(current.states, before);
	});

	test("excluded scopes reject atomically before supplied getters or acquisition iterators are observed", () => {
		const current = basis(["cwd"]);
		const original = structuredClone(current.states);
		const unavailable = { *[Symbol.iterator](): Generator<SuccessfulSkillRead> { assert.fail("must not consume acquisitions"); } };
		for (const scope of ["global", "session"] as const) {
			const patches = Object.defineProperty({ cwd: { tactics: { changed: true } } }, scope, { enumerable: true, get: () => assert.fail("excluded patch body") });
			assert.throws(() => stageSelectedScopePatches(current, patches, unavailable, "basis"), /excluded/);
			assert.throws(() => stageSelectedScopedTransition(current, { response: "not captured", transitions: [{ scope, patch: {} }] }, unavailable, "basis"), /excluded/);
		}
		assert.deepEqual(current.states, original);
		const extra = Object.defineProperty({ cwd: {} }, "session", { enumerable: true, get: () => assert.fail("disabled state body") });
		assert.throws(() => stageSelectedScopePatches({ selection: ["cwd"], states: extra }, {}, [], "basis"), /match their owners/);
		for (const values of [{}, { cwd: undefined }, { cwd: null }, Object.create({ cwd: {} }), { cwd: { working: {} } }, { cwd: { tactics: { value: Infinity } } }]) {
			assert.throws(() => stageSelectedScopePatches({ selection: ["cwd"], states: values as ScopeStateValues }, {}, [], "basis"));
		}
		assert.throws(() => stageSelectedScopePatches(current, { cwd: { response: "model response" } } as any, [], "basis"), /Unknown.*patch key/);
	});

	test("only supplied owners normalize; drafts and accepted publication inputs stay detached", () => {
		const current = basis(["global", "cwd"]);
		current.states.global!.tactics!.legacy = {};
		const before = structuredClone(current.states);
		const stage = stageSelectedScopePatches(current, { cwd: { tactics: { explicit: {}, missing: { child: null } } } }, [], "basis");
		assert.deepEqual(stage.nextStates.global, before.global);
		assert.deepEqual(stage.nextStates.cwd, before.cwd);
		stage.nextStates.global!.strategy!.chosen = "mutated draft";
		assert.deepEqual(current.states, before);
		const empty: SelectedSemanticBasis = { selection: ["cwd"], states: { cwd: {} } };
		const noop = stageSelectedScopePatches(empty, { cwd: { tactics: { missing: { child: null }, explicit: {} } } }, [], "basis");
		const snapshot = emptySnapshot("active");
		commitSelectedTransition(snapshot, empty, noop, (accepted) => assert.equal(accepted, undefined), "basis", { finalizeRun: false });
		assert.equal(snapshot.meta.step, 0);
		assert.deepEqual(empty.states, { cwd: {} });
	});

	test("ordinary answer capture is Session-only; excluded Session performs lifecycle completion without storing the answer", () => {
		for (let mask = 1; mask < 8; mask++) {
			const current = basis(order.filter((_, bit) => mask & (1 << bit)));
			const before = structuredClone(current.states);
			const snapshot = emptySnapshot("active");
			snapshot.meta.bootstrap = true;
			snapshot.meta.validation = { attempt: 1, error: "old", instruction: "retry" };
			const stage = stageSelectedScopedTransition(current, { transitions: [], response: "PRIVATE FINAL ANSWER" }, [], "basis");
			if (!current.selection.includes("session")) assert.equal(JSON.stringify(stage).includes("PRIVATE FINAL ANSWER"), false);
			let accepted: AcceptedTransition | undefined;
			let publications = 0;
			commitSelectedTransition(snapshot, current, stage, (cohort) => { accepted = cohort; publications++; }, "basis");
			assert.equal(publications, 1);
			assert.equal(snapshot.meta.bootstrap, false);
			assert.equal(snapshot.meta.validation, undefined);
			if (current.selection.includes("session")) {
				assert.equal(current.states.session!.response, "PRIVATE FINAL ANSWER");
				assert.deepEqual(accepted!.transitions, [{ scope: "session", patch: { response: "PRIVATE FINAL ANSWER" } }]);
				assert.equal(snapshot.meta.step, 1);
			} else {
				assert.deepEqual(current.states, before);
				assert.equal(accepted, undefined);
				assert.equal(snapshot.meta.step, 0);
			}
		}
	});

	test("selected commit refuses changed selection/value/causal basis and never installs a failed publication", () => {
		const current = basis(["cwd"]);
		const before = structuredClone(current);
		const stage = stageSelectedScopePatches(current, { cwd: { tactics: { progress: "new" } } }, [], "basis");
		const snapshot = emptySnapshot("active");
		assert.throws(() => commitSelectedTransition(snapshot, basis(["global"]), stage, () => assert.fail("selection"), "basis"), /selection changed/);
		assert.throws(() => commitSelectedTransition(snapshot, current, stage, () => assert.fail("epoch"), "other-basis"), /causal basis changed/);
		current.states.cwd!.strategy!.chosen = "foreign";
		assert.throws(() => commitSelectedTransition(snapshot, current, stage, () => assert.fail("value"), "basis"), /scope changed/);
		current.states = structuredClone(before.states);
		assert.throws(() => commitSelectedTransition(snapshot, current, stage, () => { throw new Error("publication failed"); }, "basis"), /publication failed/);
		assert.deepEqual(current, before);
		assert.equal(snapshot.meta.step, 0);
		assert.equal(stage.committed, false);
		assert.throws(() => commitScopedTransition(snapshot, { global: {}, cwd: {}, session: {} }, stage as any, () => assert.fail("legacy admission"), "basis"), /selected-cohort commit/);
	});

	test("disabled acquisition metadata is volatile, does not require compilation or read hashes, and cannot relocate registered Skill output", () => {
		const current = basis(["cwd"]);
		let hashReads = 0;
		const disabledSkill: SuccessfulSkillRead = { path: "/registered/SKILL.md", scope: "global", get hash(): string { hashReads++; throw new Error("disabled hash"); } };
		const disabledArtifact: SuccessfulArtifactRead = { path: "/disabled.txt", scope: "global", reason: "source-changed", get sourceFingerprint(): never { throw new Error("disabled fingerprint"); } };
		const stage = stageSelectedScopePatches(current, { cwd: { tactics: { changed: true } } }, [disabledSkill], "basis", [disabledArtifact]);
		assert.deepEqual(stage.provenanceUpdates, { cwd: {} });
		assert.equal(hashReads, 0);
		assert.throws(() => stageSelectedScopePatches(current, { cwd: { artifacts: { [disabledSkill.path]: { description: "Relocated", kind: "skill", compilation: { fact: true } } } } }, [disabledSkill], "basis"), /belongs at global/);
		assert.equal(hashReads, 0);
		const scopedRead: SuccessfulArtifactRead = { path: "/selected.txt", scope: "cwd", reason: "source-changed", sourceFingerprint: { size: 5, mtimeNs: "7" } };
		assert.throws(() => stageSelectedScopePatches(current, {}, [], "basis", [scopedRead]), /requires compiler output/);
		const compiled = stageSelectedScopePatches(current, { cwd: { artifacts: { [scopedRead.path]: { description: "Compiled" } } } }, [], "basis", [scopedRead]);
		assert.ok(compiled.provenanceUpdates.cwd![scopedRead.path]);
		assert.deepEqual(Object.keys(compiled.provenanceUpdates), ["cwd"]);
	});
}

function states(): ScopedStates {
	return { global: emptyState(), cwd: emptyState(), session: emptyState() };
}

function snapshot() {
	const result = emptySnapshot("active");
	result.meta.bootstrap = true;
	return result;
}

test("accepted patches prune empty objects scope-locally and replay exact history", () => {
	for (const owner of ["global", "cwd", "session"] as const) {
		const current: ScopedSemanticStates = {
			global: { tactics: { fallback: "global", legacy: {} } },
			cwd: { tactics: { fallback: "cwd", legacy: {} } },
			session: { tactics: { fallback: "session", legacy: {} } },
		};
		current[owner] = {
			intents: { task: { $ref: `${owner}.lazy.chain.leaf` } },
			tactics: { fallback: { last: 1 }, scalar: 1, array: [1], items: [{ last: 1 }, { keep: true }] },
			artifacts: { "/last.txt": { description: "Last" } },
			lazy: { chain: { leaf: "owned" } },
		};
		const before = structuredClone(current);
		const temporal = createTemporalState(current, "origin");
		const stage = stageAtomicScopePatches(current, { [owner]: {
			intents: { task: null }, artifacts: { "/last.txt": null }, strategy: {},
			tactics: {
				fallback: { last: null }, scalar: { missing: null }, array: { missing: null },
				items: { "[0]": { last: null } }, explicit: {}, nested: { empty: {} },
				whole: [{ empty: {} }, {}, []],
				...JSON.parse('{"__proto__":{"child":null}}'),
			},
		} }, [], "origin");
		assert.deepEqual(stage.nextStates[owner], { tactics: { items: [{}, { keep: true }], whole: [{}, {}, []] } });
		for (const other of ["global", "cwd", "session"] as const) if (other !== owner) assert.deepEqual(stage.nextStates[other], before[other]);
		assert.deepEqual(current, before);
		let accepted: AcceptedTransition | undefined;
		const snap = snapshot();
		commitScopedTransition(snap, current, stage, (cohort) => { accepted = cohort; }, "origin", { finalizeRun: false });
		assert.equal(snap.meta.step, 1);
		assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), [owner]);
		assert.deepEqual(applyPatch(before[owner], accepted!.transitions[0]!.patch as JsonObject), current[owner]);
		const next = advanceTemporalState(temporal, accepted!.transitions, accepted!.id);
		assert.deepEqual(readTemporalScopes(next)[owner], current[owner]);
		assert.deepEqual(readTemporalScopes(next, 1), before);
		const repeat = stageAtomicScopePatches(current, { [owner]: { tactics: { explicit: {}, scalar: { missing: null } } } }, [], accepted!.id);
		commitScopedTransition(snap, current, repeat, (cohort) => assert.equal(cohort, undefined), accepted!.id, { finalizeRun: false });
		assert.equal(snap.meta.step, 1);
	}
});

test("normalization can close an emptied intent and preserves lower-scope fallback", () => {
	const current: ScopedSemanticStates = {
		global: { tactics: { draft: "fallback" } }, cwd: {},
		session: { intents: { task: { $ref: "session.tactics.draft" } }, tactics: { draft: "private" } },
	};
	const stage = stageAtomicScopePatches(current, { session: { intents: { task: { $ref: null } } } }, [], "origin");
	assert.deepEqual(stage.nextStates.session, {});
	assert.deepEqual(stage.cascades.session, [{ plane: "tactics", keys: ["draft"] }]);
	assert.equal(readTemporalState(createTemporalState(stage.nextStates, "next")).tactics.draft, "fallback");
	const empty: ScopedSemanticStates = { global: {}, cwd: {}, session: {} };
	const noOp = stageAtomicScopePatches(empty, { session: { tactics: {}, lazy: { empty: {} } } }, [], "origin");
	commitScopedTransition(snapshot(), empty, noOp, (cohort) => assert.equal(cohort, undefined), "origin", { finalizeRun: false });
	assert.deepEqual(empty, { global: {}, cwd: {}, session: {} });
});

test("stages every canonical scope combination as one atomic transition", () => {
	const combinations = [
		["global"],
		["cwd"],
		["session"],
		["global", "cwd"],
		["global", "session"],
		["cwd", "session"],
		["global", "cwd", "session"],
	] as const;
	for (const scopes of combinations) {
		const current = snapshot();
		const state = states();
		const patches: AtomicScopePatches = {};
		for (const scope of scopes) patches[scope] = { tactics: { [scope]: true } };
		const stage = stageAtomicScopePatches(state, patches, [], "origin");
		let accepted: AcceptedTransition | undefined;
		let publications = 0;
		commitScopedTransition(current, state, stage, (cohort) => {
			publications += 1;
			accepted = cohort;
		}, "origin", { finalizeRun: false });
		assert.equal(publications, 1);
		assert.equal(current.meta.step, 1);
		assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), scopes);
		assert.ok(accepted!.id.length > 0);
		for (const scope of scopes) assert.equal(state[scope].tactics[scope], true);
	}
});

test("missing nested deletions are no-ops across scopes, including absent semantic planes", () => {
	for (const populated of [false, true]) {
		const scopeState: ScopedSemanticStates["session"] = populated ? { tactics: { keep: true }, lazy: { keep: true }, intents: { keep: true }, strategy: { keep: true }, artifacts: { "/kept.txt": { description: "Keep" } } } : {};
		const state: ScopedSemanticStates = { global: structuredClone(scopeState), cwd: structuredClone(scopeState), session: structuredClone(scopeState) };
		const before = structuredClone(state);
		const patches: AtomicScopePatches = {};
		for (const scope of ["global", "cwd", "session"] as const) patches[scope] = {
			tactics: { missing: { child: null, nested: { leaf: null } } },
			lazy: { missing: { child: null } },
			intents: { missing: { child: null } },
			strategy: { missing: { child: null } },
			artifacts: { "/missing.txt": { description: null } },
		};
		const current = snapshot();
		const stage = stageAtomicScopePatches(state, patches, [], "origin");
		assert.deepEqual(stage.nextStates, before);
		let publications = 0;
		commitScopedTransition(current, state, stage, (cohort) => { if (cohort) publications++; }, "origin", { finalizeRun: false });
		assert.equal(publications, 0);
		assert.equal(current.meta.step, 0);
		assert.deepEqual(state, before);
	}
});

test("missing deletions do not block another scope's writes and accepted patches replay exactly", () => {
	const state: ScopedSemanticStates = { global: {}, cwd: {}, session: {} };
	const before = structuredClone(state);
	const stage = stageAtomicScopePatches(state, {
		global: { tactics: { missing: { child: null } } },
		cwd: { tactics: { added: { discarded: null, value: 0 } } },
		session: { lazy: { missing: { nested: { leaf: null } } } },
	}, [], "origin");
	let accepted: AcceptedTransition | undefined;
	commitScopedTransition(snapshot(), state, stage, (cohort) => { accepted = cohort; }, "origin", { finalizeRun: false });
	assert.deepEqual(stage.missingDeletions, [
		{ path: "/global/tactics/missing/child", unavailablePath: "/global/tactics" },
		{ path: "/cwd/tactics/added/discarded", unavailablePath: "/cwd/tactics" },
		{ path: "/session/lazy/missing/nested/leaf", unavailablePath: "/session/lazy" },
	]);
	assert.deepEqual(accepted!.transitions, [{ scope: "cwd", patch: { tactics: { added: { value: 0 } } } }]);
	assert.deepEqual(state, { global: {}, cwd: { tactics: { added: { value: 0 } } }, session: {} });
	assert.deepEqual(applyPatch(before.cwd, accepted!.transitions[0]!.patch as JsonObject), state.cwd);
});

for (const owner of ["global", "cwd", "session"] as const) test(`ordinary artifact compilation is bound to its observed ${owner} owner`, () => {
	const current = states();
	for (const scope of ["global", "cwd", "session"] as const) current[scope].tactics.marker = scope;
	const path = "/registered.txt";
	current[owner].artifacts[path] = { description: "Prior value", obsolete: true };
	const before = structuredClone(current);
	const sourceFingerprint = { size: 5, mtimeNs: "10" };
	const read = { path, scope: owner, sourceFingerprint, reason: "source-changed" as const };
	for (const wrong of ["global", "cwd", "session"] as const) {
		if (wrong === owner) continue;
		assert.throws(() => stageAtomicScopePatches(current, { [wrong]: { artifacts: { [path]: { description: "Wrong owner" } } } }, [], "basis", [read]), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(`${owner}.artifacts[${JSON.stringify(path)}]`), error.message);
			return true;
		});
		assert.deepEqual(current, before);
	}
	const stage = stageAtomicScopePatches(current, { [owner]: { artifacts: { [path]: { description: "Refreshed" } } } }, [], "basis", [read]);
	for (const scope of ["global", "cwd", "session"] as const) {
		if (scope === owner) {
			assert.deepEqual(stage.nextStates[scope].artifacts![path], { description: "Refreshed" });
			assert.deepEqual(stage.provenanceUpdates[scope], { [path]: { sourceFingerprint, compilerRevision: ORDINARY_ARTIFACT_COMPILER } });
		} else {
			assert.deepEqual(stage.nextStates[scope], before[scope]);
			assert.deepEqual(stage.provenanceUpdates[scope], {});
		}
	}
	assert.deepEqual(current, before);
});

test("stages intent lifecycle updates as ordinary atomic semantic transitions", () => {
	const state = states();
	const selected = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" } } } },
	}, [], "origin");
	assert.deepEqual(selected.nextStates.cwd.intents!.release, {
		action: "Validate release", plan: { $ref: "cwd.lazy.releasePlan" },
	});
	const fulfilled = stageAtomicScopePatches(selected.nextStates, {
		cwd: { intents: { release: null }, tactics: { release: "validated" } },
	}, [], "origin");
	assert.equal(fulfilled.nextStates.cwd.intents, undefined);
	assert.equal(fulfilled.nextStates.cwd.tactics!.release, "validated");
	assert.throws(() => stageAtomicScopePatches(state, {
		cwd: { intents: "invalid" as unknown as JsonObject },
	}, [], "origin"), /field intents must be a JSON object/);
});

test("model-facing intent behavior distinguishes possibilities, commitments, handoffs, supersession, and fulfillment", () => {
	let state: ScopedSemanticStates = states();
	state = stageAtomicScopePatches(state, {
		cwd: { tactics: { possibleAction: "Benchmark later" }, lazy: { plan: { steps: ["validate", "publish"] } } },
	}, [], "origin").nextStates;
	assert.equal(state.cwd.intents, undefined);

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Validate", plan: { $ref: "cwd.lazy.plan" } } } },
	}, [], "origin").nextStates;
	state = stageAtomicScopePatches(state, {
		cwd: { tactics: { implementation: "complete; validation pending" } },
	}, [], "origin").nextStates;
	assert.deepEqual(state.cwd.intents!.release, { action: "Validate", plan: { $ref: "cwd.lazy.plan" } });

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: { action: "Publish after validation", plan: { $ref: "cwd.lazy.plan" } }, rejectedAlternative: null } },
	}, [], "origin").nextStates;
	assert.equal(Object.hasOwn(state.cwd.intents!, "rejectedAlternative"), false);
	assert.equal((state.cwd.intents!.release as JsonObject).action, "Publish after validation");

	state = stageAtomicScopePatches(state, {
		cwd: { intents: { release: null }, tactics: { release: "published" } },
	}, [], "origin").nextStates;
	assert.equal(state.cwd.intents, undefined);
	assert.equal(state.cwd.tactics!.release, "published");
	// Fulfilling the intent deletes the lazy plan it owned by structured reference.
	assert.equal(state.cwd.lazy, undefined);
});

test("deleting an intent clears same-scope strategy/tactics/lazy before other authored operations", () => {
	for (const scope of ["global", "cwd", "session"] as const) {
		let state: ScopedSemanticStates = states();
		for (const other of ["global", "cwd", "session"] as const) state[other] = {
			tactics: { step: other, notes: { a: 1, b: 2 }, kept: true },
			lazy: { plan: ["x"], log: { day: 1 } },
			strategy: { rule: "keep" },
		};
		state = stageAtomicScopePatches(state, { [scope]: { intents: { task: {
			steps: [{ $ref: `${scope}.tactics.step` }, { $ref: `${scope}.tactics.notes.a` }],
			plan: { $ref: `${scope}.lazy.plan` },
			mention: `see $${scope}.tactics.kept`,
			skipped: [
				{ $ref: `${scope}.strategy.rule` }, { $ref: `${scope}.tactics` }, { $ref: `${scope}.lazy.plan[0]` },
				{ $ref: "tactics.kept" }, { $ref: "effective.tactics.kept" }, { $ref: `${scope}[1].tactics.kept` },
				{ $ref: `${scope}.tactics.missing` }, { $ref: `${scope}.intents.task` },
				{ $ref: `${scope === "cwd" ? "session" : "cwd"}.tactics.step` },
			],
		} } } }, [], "origin").nextStates;
		const before = structuredClone(state);
		const stage = stageAtomicScopePatches(state, { [scope]: { intents: { task: null }, tactics: { step: "rewritten" } } }, [], "origin");
		const next = stage.nextStates;
		assert.deepEqual(stage.cascades[scope], [
			{ plane: "lazy", keys: ["plan"] }, { plane: "strategy", keys: ["rule"] }, { plane: "tactics", keys: ["notes", "a"] }, { plane: "tactics", keys: ["step"] },
		]);
		for (const other of ["global", "cwd", "session"] as const) if (other !== scope) assert.deepEqual(stage.cascades[other], []);
		assert.deepEqual(next[scope].tactics, { step: "rewritten", notes: { b: 2 }, kept: true }, scope);
		assert.deepEqual(next[scope].lazy, { log: { day: 1 } }, scope);
		assert.equal(next[scope].strategy, undefined);
		for (const other of ["global", "cwd", "session"] as const) if (other !== scope) assert.deepEqual(next[other], before[other]);
		let accepted: AcceptedTransition | undefined;
		const current = snapshot();
		commitScopedTransition(current, state, stage, (cohort) => { accepted = cohort; }, "origin", { finalizeRun: false });
		assert.equal(current.meta.step, 1);
		// The cascade is stored as explicit deletions in the one accepted record.
		assert.deepEqual(accepted!.transitions, [{ scope, patch: {
			intents: null, strategy: null, tactics: { step: "rewritten", notes: { a: null } }, lazy: { plan: null },
		} }]);
		assert.deepEqual(applyPatch(before[scope], accepted!.transitions[0]!.patch as JsonObject), state[scope]);
	}
});

test("writes after intent cleanup recreate owned paths and keep newly authored targets", () => {
	let state: ScopedSemanticStates = states();
	state.session = { tactics: { draft: { part: 1 } }, lazy: { plan: ["a"] } };
	state = stageAtomicScopePatches(state, { session: { intents: {
		task: { owns: [{ $ref: "session.tactics.draft" }, { $ref: "session.lazy.plan" }, { $ref: "session.tactics.created" }] },
	} } }, [], "origin").nextStates;
	const before = structuredClone(state);
	const stage = stageAtomicScopePatches(state, { session: {
		intents: { task: null },
		tactics: { draft: { part: 2, result: "saved too late" }, created: "new in this patch", kept: "unowned" },
		lazy: { plan: ["b"] },
	} }, [], "origin");
	assert.deepEqual(stage.nextStates.session.tactics, { draft: { part: 2, result: "saved too late" }, created: "new in this patch", kept: "unowned" });
	assert.deepEqual(stage.nextStates.session.lazy, { plan: ["b"] });
	let accepted: AcceptedTransition | undefined;
	commitScopedTransition(snapshot(), state, stage, (cohort) => { accepted = cohort; }, "origin", { finalizeRun: false });
	assert.deepEqual(accepted!.transitions, [{ scope: "session", patch: {
		intents: null, tactics: { draft: { part: 2, result: "saved too late" }, created: "new in this patch", kept: "unowned" }, lazy: { plan: ["b"] },
	} }], "the record stores the net result without replaying cleanup");
	assert.deepEqual(applyPatch(before.session, accepted!.transitions[0]!.patch as JsonObject), state.session);
});

test("ownership cascade keeps shared targets, supports one-patch supersession and ignores intent edits", () => {
	let state: ScopedSemanticStates = states();
	state.cwd = { tactics: { shared: { deep: 1, other: 2 }, solo: 1, edited: 1 }, lazy: { plan: { a: 1 } } };
	state = stageAtomicScopePatches(state, { cwd: { intents: {
		old: { refs: [{ $ref: "cwd.tactics.shared" }, { $ref: "cwd.tactics.solo" }, { $ref: "cwd.lazy.plan" }] },
		descendant: { $ref: "cwd.tactics.shared.deep" },
		edited: { $ref: "cwd.tactics.edited" },
	} } }, [], "origin").nextStates;
	// Editing an intent to drop a reference leaves the target unowned, not deleted.
	state = stageAtomicScopePatches(state, { cwd: { intents: { edited: "no refs" } } }, [], "origin").nextStates;
	assert.equal(state.cwd.tactics!.edited, 1);
	// Supersede in one patch: the replacement keeps lazy.plan; a descendant owner keeps shared.
	state = stageAtomicScopePatches(state, { cwd: { intents: {
		old: null, next: { plan: { $ref: "cwd.lazy.plan.a" } },
	} } }, [], "origin").nextStates;
	assert.deepEqual(state.cwd.tactics, { shared: { deep: 1, other: 2 }, edited: 1 });
	assert.deepEqual(state.cwd.lazy, { plan: { a: 1 } });
	// Repeating a deletion of an absent intent is an ordinary no-op.
	const repeat = stageAtomicScopePatches(state, { cwd: { intents: { old: null } } }, [], "origin");
	assert.deepEqual(repeat.nextStates.cwd, state.cwd);
	assert.deepEqual(repeat.cascades, { global: [], cwd: [], session: [] });
	let published = 0;
	commitScopedTransition(snapshot(), state, repeat, (cohort) => { if (cohort) published += 1; }, "origin", { finalizeRun: false });
	assert.equal(published, 0);
});

test("staging exposes no cascade for shared targets or one-patch supersession", () => {
	const state = states();
	state.cwd = { ...emptyState(), intents: {
		old: { $ref: "cwd.lazy.plan" }, shared: { $ref: "cwd.lazy.plan.step" },
	}, lazy: { plan: { step: "keep" } } };
	const shared = stageAtomicScopePatches(state, { cwd: { intents: { old: null } } }, [], "origin");
	assert.deepEqual(shared.cascades, { global: [], cwd: [], session: [] });
	assert.deepEqual(shared.nextStates.cwd.lazy, state.cwd.lazy);
	const replacement = stageAtomicScopePatches(state, { cwd: { intents: {
		old: null, shared: null, next: { $ref: "cwd.lazy.plan" },
	} } }, [], "origin");
	assert.deepEqual(replacement.cascades, { global: [], cwd: [], session: [] });
	assert.deepEqual(replacement.nextStates.cwd.lazy, state.cwd.lazy);
});

test("unknown patch keys report the exact quoted key and intent-first allowed fields", () => {
	const current = states();
	const before = structuredClone(current);
	for (const scope of ["global", "cwd", "session"] as const) {
		for (const key of ["contract", "working", "beacon.strategy", "contrcat", "notes", "quoted\"key\n", "response"]) {
			const patch = { [key]: {} };
			const expected = `Unknown State Flow patch key ${JSON.stringify(key)}; expected one of: intents, strategy, tactics, artifacts, lazy`;
			assert.throws(() => stageAtomicScopePatches(current, { [scope]: patch }, [], "origin"), { message: expected });
			assert.throws(() => stageScopedTransition(current, { transitions: [{ scope, patch }], response: "Answer" }, [], "origin"), { message: expected });
			assert.deepEqual(current, before);
		}
		const stage = stageAtomicScopePatches(current, { [scope]: {
			intents: { next: "Verify the release" }, strategy: { project: { rule: true } },
			tactics: { checked: true }, artifacts: {}, lazy: { detail: "On demand" },
		} }, [], "origin");
		assert.deepEqual(stage.nextStates[scope].strategy!.project, { rule: true });
		assert.equal(stage.nextStates[scope].intents!.next, "Verify the release");
	}
});

test("rejects an invalid member without mutating any scope in the atomic cohort", () => {
	const state = states();
	const before = structuredClone(state);
	assert.throws(() => stageAtomicScopePatches(state, {
		global: { tactics: { accepted: true } },
		cwd: { tactics: { invalid: [null] } },
	}, [], "origin"), /Materialized state cannot contain null/);
	assert.deepEqual(state, before);
	assert.throws(() => stageAtomicScopePatches(state, { other: {} } as AtomicScopePatches, [], "origin"), /Unknown atomic State Flow scope/);
});

test("stages indexed array updates atomically across scopes and rejects one invalid index", () => {
	const state = states();
	state.global.tactics.memory = ["global-0", "global-1"];
	state.cwd.tactics.groups = [{ notes: ["cwd-0", "cwd-1"], keep: true }];
	const stage = stageAtomicScopePatches(state, {
		global: { tactics: { memory: { "[1]": "global-updated" } } },
		cwd: { tactics: { groups: { "[0]": { notes: { "[1]": "cwd-updated" } } } } },
	}, [], "origin");
	assert.deepEqual(stage.nextStates.global.tactics!.memory, ["global-0", "global-updated"]);
	assert.deepEqual(stage.nextStates.cwd.tactics!.groups, [{ notes: ["cwd-0", "cwd-updated"], keep: true }]);
	assert.throws(() => stageAtomicScopePatches(state, {
		global: { tactics: { memory: { "[0]": "would-change" } } },
		cwd: { tactics: { groups: { "[1]": { notes: [] } } } },
	}, [], "origin"), /array index \[1\] is out of bounds/);
	assert.deepEqual(state.global.tactics.memory, ["global-0", "global-1"]);
	assert.deepEqual(state.cwd.tactics.groups, [{ notes: ["cwd-0", "cwd-1"], keep: true }]);
});

test("stages object-root lazy planes without hydrating untouched scopes", () => {
	const state = states();
	const stage = stageAtomicScopePatches(state, {
		global: { lazy: { memory: ["first", "second"] } },
		cwd: { lazy: { count: 42 } },
	}, [], "origin");
	assert.deepEqual(stage.nextStates.global.lazy, { memory: ["first", "second"] });
	assert.deepEqual(stage.nextStates.cwd.lazy, { count: 42 });
	assert.deepEqual(stage.nextStates.session.lazy, {});
	for (const lazy of [null, 42, ["invalid"]]) {
		assert.throws(() => stageAtomicScopePatches(state, { session: { lazy } } as any, [], "origin"), /lazy must be a JSON object/);
	}
});

test("publishes one exact multi-scope replay cohort without explanatory windows or current-state DTOs", () => {
	const current = snapshot();
	const state = states();
	const view = createTemporalState(state, "origin");
	const stage = stageScopedTransition(state, {
		transitions: [
			{ scope: "global", patch: { strategy: { shared: true } } },
			{ scope: "cwd", patch: { tactics: { project: "ready" } } },
			{ scope: "session", patch: { tactics: { next: "continue" } } },
		], response: "Done",
	}, [], "origin");
	let accepted: AcceptedTransition | undefined;
	assert.equal(commitScopedTransition(current, state, stage, (cohort) => { accepted = cohort; }, "origin"), true);
	assert.deepEqual(Object.keys(accepted!).sort(), ["id", "transitions"]);
	assert.deepEqual(accepted!.transitions.map(({ scope }) => scope), ["global", "cwd", "session"]);
	const next = advanceTemporalState(view, accepted!.transitions, accepted!.id);
	for (const scope of ["global", "cwd", "session"] as const) {
		assert.deepEqual(readTemporalScopes(next)[scope], state[scope]);
		assert.equal(next.scopes[scope].patches[0]!.transition.id, accepted!.id);
	}
	assert.equal(current.meta.step, 1);
	const noOp = stageScopedTransition(state, { transitions: [{ scope: "global", patch: {} }], response: "Done" }, [], accepted!.id);
	commitScopedTransition(current, state, noOp, (cohort) => assert.equal(cohort, undefined), accepted!.id);
	assert.equal(current.meta.step, 1);
	assert.equal(current.meta.bootstrap, false);
});

test("normalizes artifact replacements and runtime compilation evidence after finalized-response reconciliation", () => {
	const state = states();
	const source = { path: "/knowledge/source.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", scope: "cwd" as const, hash: `sha256:${"c".repeat(64)}` };
	for (const [scope, path] of [["global", source.path], ["cwd", skill.path]] as const) {
		state[scope].artifacts[path] = {
			description: "Old compilation", hash: `sha256:${"a".repeat(64)}`, compiler: "old",
			compiled_at: "2026-01-01", obsolete: { nested: true }, compilation: { stale: true },
		};
	}
	const before = structuredClone(state);
	const view = createTemporalState(before, "origin");
	const stage = stageScopedTransition(state, {
		transitions: [
			{ scope: "global", patch: { artifacts: { [source.path]: { description: "New routing" } } } },
			{ scope: "cwd", patch: { artifacts: { [skill.path]: { description: "New Skill", kind: "skill", compilation: { route: "new" } } } } },
		], response: "Draft",
	}, [skill], "origin", [source]);
	stage.nextStates.session.response = "Final accepted answer";
	let cohort: AcceptedTransition | undefined;
	commitScopedTransition(snapshot(), state, stage, (accepted) => { cohort = accepted; }, "origin");
	for (const { scope, patch } of cohort!.transitions) assert.deepEqual(applyPatch(before[scope], patch as JsonObject), state[scope]);
	const accepted = advanceTemporalState(view, cohort!.transitions, cohort!.id);
	for (const scope of ["global", "cwd", "session"] as const) {
		const identity = scope === "cwd" ? "/project" : undefined;
		const bytes = serializeScopeStream(accepted.scopes[scope], scope, identity);
		accepted.scopes[scope] = parseScopeStream(bytes.checkpoint, bytes.patches, scope, identity,
			serializeScopeMetadata({}, accepted.scopes[scope], scope, identity))!;
		assert.deepEqual(readTemporalScopes(accepted)[scope], state[scope]);
		assert.deepEqual(readTemporalState(accepted, 1, scope), before[scope]);
		assert.equal(accepted.scopes[scope].patches[0]!.transition.id, cohort!.id);
	}
	assert.equal(state.global.artifacts[source.path]!.obsolete, undefined);
	assert.equal(state.global.artifacts[source.path]!.compilation, undefined);
	assert.deepEqual(state.cwd.artifacts[skill.path]!.compilation, { route: "new" });
	assert.equal(readTemporalState(accepted).response, "Final accepted answer");
});

test("finalized response controls no-op identity and step independently of lifecycle completion", () => {
	const current = snapshot();
	current.meta.step = Number.MAX_SAFE_INTEGER;
	const state = states();
	state.session = { response: "Same" } as typeof state.session;
	const stage = stageScopedTransition(state, { transitions: [], response: "Draft" }, [], "origin");
	stage.nextStates.session.response = "Same";
	commitScopedTransition(current, state, stage, (accepted) => assert.equal(accepted, undefined), "origin");
	assert.equal(current.meta.step, Number.MAX_SAFE_INTEGER);
	assert.equal(current.meta.bootstrap, false);
	assert.equal(commitScopedTransition(current, state, stage, () => assert.fail("duplicate publication"), "origin"), false);
	current.meta.step = 0;
	const changed = stageScopedTransition(state, { transitions: [], response: "Same" }, [], "origin");
	changed.nextStates.session.response = "Changed by later handler";
	commitScopedTransition(current, state, changed, (accepted) => assert.deepEqual(accepted!.transitions, [
		{ scope: "session", patch: { response: "Changed by later handler" } },
	]), "origin");
	assert.equal(current.meta.step, 1);
});

test("an empty accepted response remains a session-owned semantic transition", () => {
	const current = snapshot();
	const state = states();
	state.session = { response: "Previous answer" } as typeof state.session;
	const stage = stageScopedTransition(state, { transitions: [], response: "" }, [], "origin");
	commitScopedTransition(current, state, stage, (accepted) => assert.deepEqual(accepted!.transitions, [
		{ scope: "session", patch: { response: "" } },
	]), "origin");
	assert.equal(state.session.response, "");
	assert.equal(current.meta.step, 1);
	assert.equal(current.meta.bootstrap, false);
});

test("intermediate barriers preserve response/bootstrap and failed publication leaves staging retryable", () => {
	const current = snapshot();
	const state = states();
	state.session.response = "Previous answer";
	const before = structuredClone(state);
	const stage = stageAtomicScopePatches(state, { session: { tactics: { checkpoint: "verified" } } }, [], "origin");
	assert.throws(() => commitScopedTransition(current, state, stage, () => { throw new Error("publication failed"); }, "origin"), /publication failed/);
	assert.deepEqual(state, before);
	assert.equal(stage.committed, false);
	assert.equal(current.meta.step, 0);
	assert.equal(commitScopedTransition(current, state, stage, () => {}, "origin", { finalizeRun: false }), true);
	assert.equal(current.meta.bootstrap, true);
	assert.equal(state.session.response, "Previous answer");
	assert.equal(state.session.tactics.checkpoint, "verified");
	assert.equal(current.meta.step, 1);
});

test("staging copies each accepted cold scope once without redundant pre-clones", () => {
	const state = states();
	const scopes = ["global", "cwd", "session"] as const;
	for (const scope of scopes) state[scope].lazy.cold = `COLD-COW-${scope}`;
	const counts = { global: 0, cwd: 0, session: 0 };
	const clone = globalThis.structuredClone;
	globalThis.structuredClone = ((value: unknown, options?: any) => {
		const text = JSON.stringify(value);
		for (const scope of scopes) if (text?.includes(`COLD-COW-${scope}`)) counts[scope]++;
		return clone(value, options);
	}) as typeof structuredClone;
	let stage: ReturnType<typeof stageAtomicScopePatches>;
	try { stage = stageAtomicScopePatches(state, { session: { tactics: { changed: true } } }, [], "origin"); }
	finally { globalThis.structuredClone = clone; }
	assert.deepEqual(counts, { global: 1, cwd: 1, session: 1 });
	for (const scope of scopes) assert.notEqual(stage.nextStates[scope].lazy, state[scope].lazy);
	assert.equal(stage.nextStates.session.tactics!.changed, true);
});

test("rejected mutable drafts remain detached from accepted scopes and caller patches", () => {
	const current = snapshot();
	const state = states();
	state.global.lazy.keep = { value: "accepted" };
	const patch = { session: { tactics: { nested: { value: "authored" } } } };
	const stage = stageAtomicScopePatches(state, patch, [], "origin");
	assert.throws(() => commitScopedTransition(current, state, stage, () => { throw new Error("rejected"); }, "origin"), /rejected/);
	(stage.nextStates.global.lazy!.keep as JsonObject).value = "draft-only";
	patch.session.tactics.nested.value = "caller-only";
	assert.deepEqual(state.global.lazy.keep, { value: "accepted" });
	assert.deepEqual(state.session.tactics, {});
	assert.deepEqual(stage.nextStates.session.tactics!.nested, { value: "authored" });
	assert.equal(stage.committed, false);
	assert.equal(current.meta.step, 0);
});

test("rejects stale state and identical values at a different active causal boundary", () => {
	const current = snapshot();
	const state = states();
	const origin = createTemporalState(state, "origin");
	const fork = createTemporalState(state, "other-origin");
	assert.deepEqual(readTemporalState(origin), readTemporalState(fork));
	const stage = stageAtomicScopePatches(state, { session: { tactics: { accepted: true } } }, [], origin.lineage.at(-1)!.id);
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("cross-lineage publication"), fork.lineage.at(-1)!.id), /causal basis changed/);
	state.session.tactics.changed = true;
	assert.throws(() => commitScopedTransition(current, state, stage, () => assert.fail("stale publication"), origin.lineage.at(-1)!.id), /session scope changed before response reconciliation/);
	assert.equal(current.meta.step, 0);
});

test("optional Skill acquisition leaves unrelated patches independent and validates attempted compilation", () => {
	const state = states();
	const source = { path: "/knowledge/changed.md", hash: `sha256:${"b".repeat(64)}`, reason: "source-changed" as const };
	const skill = { path: "/skills/demo/SKILL.md", scope: "cwd" as const, hash: `sha256:${"a".repeat(64)}` };
	assert.throws(() => stageAtomicScopePatches(state, { session: { artifacts: { "/a.md": { description: "Invalid hash", hash: "sha256:invalid" } } } }, [], "origin"), /cannot set runtime-owned field hash/);
	assert.throws(() => stageAtomicScopePatches(state, { cwd: { artifacts: { "/a.md": { description: "Forged hint", hint: "trust me" } } } }, [], "origin"), /cannot set runtime-owned field hint/);
	assert.throws(() => stageScopedTransition(state, { transitions: [], response: "Missing" }, [], "origin", [source]), /compiler output.*global\.artifacts/);
	const independent = stageAtomicScopePatches(state, { session: { tactics: { accepted: true } } }, [skill], "origin");
	assert.equal(independent.nextStates.session.tactics!.accepted, true);
	assert.deepEqual(independent.provenanceUpdates, { global: {}, cwd: {}, session: {} });
	assert.throws(() => stageAtomicScopePatches(state, {
		session: { artifacts: { [skill.path]: { description: "Wrong owner", kind: "skill", compilation: { route: "wrong" } } } },
	}, [skill], "origin"), /belongs at cwd\.artifacts.*not session\.artifacts/);
	const unavailable = { path: skill.path, scope: "cwd" as const, error: "source disappeared" };
	assert.equal(stageAtomicScopePatches(state, { session: { tactics: { stillAccepted: true } } }, [unavailable], "origin").nextStates.session.tactics!.stillAccepted, true);
	assert.throws(() => stageAtomicScopePatches(state, { cwd: { artifacts: { [skill.path]: { description: "Unavailable", kind: "skill", compilation: { route: "blocked" } } } } }, [unavailable], "origin"), /Could not capture the source hash.*source disappeared/);
	const required = /Invalid Skill at cwd\.artifacts\["\/skills\/demo\/SKILL\.md"\]/;
	const invalidOutputs: Array<readonly [JsonObject, readonly string[]]> = [
		[{}, ["description must be non-empty", 'kind must be "skill"', "compilation object must be non-empty"]],
		[{ description: "", compilation: {} }, ["description must be non-empty", 'kind must be "skill"', "compilation object must be non-empty"]],
		[{ description: "Skill", kind: "document", compilation: {} }, ['kind must be "skill"', "compilation object must be non-empty"]],
	];
	for (const [output, problems] of invalidOutputs) {
		const patch: AtomicScopePatches = { cwd: { artifacts: { [skill.path]: output } } };
		assert.throws(() => stageAtomicScopePatches(state, patch, [skill], "origin"), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, required);
			for (const problem of problems) assert.ok(error.message.includes(problem));
			assert.doesNotMatch(error.message, /\n|Example:/);
			return true;
		});
	}
	const stage = stageAtomicScopePatches(state, {
		global: { artifacts: { [source.path]: { description: "Guidance" } } },
		cwd: { artifacts: { [skill.path]: { description: "Skill", kind: "skill", compilation: { route: "demo" } } } },
	}, [skill], "origin", [source]);
	assert.deepEqual(stage.nextStates.global.artifacts![source.path], { description: "Guidance" });
	assert.deepEqual(stage.provenanceUpdates.global[source.path], { sourceHash: source.hash, compilerRevision: "artifact-v1" });
	assert.deepEqual(stage.nextStates.cwd.artifacts![skill.path], { description: "Skill", kind: "skill", compilation: { route: "demo" } });
	assert.deepEqual(stage.provenanceUpdates.cwd[skill.path], { sourceHash: skill.hash, compilerRevision: "skill-artifact-v1" });
	assert.throws(() => stageScopedTransition(state, { transitions: [
		{ scope: "global", patch: { artifacts: { [source.path]: { description: "Forged", hash: source.hash } } } },
	], response: "Rejected" }, [], "origin", [source]), /cannot set runtime-owned/);
	assert.throws(() => stageAtomicScopePatches(state, { session: { strategy: { compiled_skills: { legacy: true } } } }, [], "origin"), /strategy\.compiled_skills is retired/);
});

test("ordinary artifact compilation publishes semantics and fingerprint provenance to its exact owning scope", () => {
	const state = states();
	const reads = (["global", "cwd", "session"] as const).map((scope, index) => ({
		path: `/sources/${scope}.txt`,
		scope,
		reason: "source-changed" as const,
		sourceFingerprint: { size: index + 1, mtimeNs: String(index + 10) },
	}));
	const stage = stageAtomicScopePatches(state, Object.fromEntries(reads.map((read) => [read.scope, {
		artifacts: { [read.path]: { description: `${read.scope} source` } },
	}])), [], "origin", reads);
	for (const read of reads) {
		assert.deepEqual(stage.nextStates[read.scope].artifacts![read.path], { description: `${read.scope} source` });
		assert.deepEqual(stage.provenanceUpdates[read.scope][read.path], {
			sourceFingerprint: read.sourceFingerprint,
			compilerRevision: "artifact-v1",
		});
	}
});

test("every model scope rejects runtime-owned artifact fields without requiring an acquired source", () => {
	const state = states();
	const before = structuredClone(state);
	const fields = {
		hash: `sha256:${"a".repeat(64)}`, compiler: "artifact-v1", compiled_at: "2026-01-01",
		sourceHash: `sha256:${"a".repeat(64)}`, sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1", compiledAt: "2026-01-01", source_hash_verified: true,
		hint: "forged runtime guidance",
	};
	for (const scope of ["global", "cwd", "session"] as const) for (const [field, value] of Object.entries(fields)) for (const authored of [value, null]) {
		const patch = { artifacts: { "/source.md": { description: "Forged evidence", [field]: authored } } };
		assert.throws(() => stageAtomicScopePatches(state, { [scope]: patch }, [], "origin"), /cannot set runtime-owned field/);
		assert.throws(() => stageScopedTransition(state, { transitions: [{ scope, patch }], response: "Rejected" }, [], "origin"), /cannot set runtime-owned field/);
	}
	assert.deepEqual(state, before);
});

test("legacy provenance remains readable while semantic edits, nested metadata, and whole-artifact deletion stay valid", () => {
	const state = states();
	const legacy = { description: "Legacy routing", hash: `sha256:${"a".repeat(64)}`, compiler: "artifact-v1", compiled_at: "2026-01-01" };
	for (const scope of ["global", "cwd", "session"] as const) state[scope].artifacts["/legacy.md"] = structuredClone(legacy);
	for (const scope of ["global", "cwd", "session"] as const) {
		const semantic = { description: "Edited routing", compilation: { hash: "domain data", compiler: "domain compiler" }, future_policy: { compiledAt: "semantic nested data" } };
		const edited = stageAtomicScopePatches(state, { [scope]: { artifacts: { "/legacy.md": semantic } } }, [], "origin");
		assert.deepEqual(edited.nextStates[scope].artifacts!["/legacy.md"], { ...legacy, ...semantic });
		assert.deepEqual(edited.provenanceUpdates, { global: {}, cwd: {}, session: {} });
		const deleted = stageAtomicScopePatches(state, { [scope]: { artifacts: { "/legacy.md": null } } }, [], "origin");
		assert.equal(deleted.nextStates[scope].artifacts?.["/legacy.md"], undefined);
		assert.deepEqual(state[scope].artifacts["/legacy.md"], legacy);
	}
});

test("session-only transitions persist only the current temporal session layer", async () => {
	const h = harness({ cwd: "/tmp/state-flow-session-only-transition" });
	await start(h);
	const before = loadCwdState(h.ctx.cwd, h.repositoryRoot);
	await commitTerminal(h, { branch: "only" }, { next: "continue" });
	assert.deepEqual(loadGlobalState(h.repositoryRoot), emptyState());
	assert.deepEqual(loadCwdState(h.ctx.cwd, h.repositoryRoot), before);
	const session = loadSessionMaterialization(h.ctx.cwd, "harness-session", h.repositoryRoot)!;
	assert.deepEqual(session.state, { ...emptyState(), strategy: { branch: "only" }, tactics: { next: "continue" }, response: "Done" });
	assert.deepEqual(session.recentTransitions.map(({ transitions }) => transitions), [
		[{ scope: "session", patch: { strategy: { branch: "only" }, tactics: { next: "continue" } } }],
		[{ scope: "session", patch: { response: "Done" } }],
	]);
});

test("commits global, CWD, and session patches through one atomic model barrier", async () => {
	const h = harness({ cwd: "/tmp/state-flow-scoped-transition" });
	await start(h);
	await commitScopedTerminal(h, [
		{ scope: "global", patch: { strategy: { shared: "all projects" } } },
		{ scope: "cwd", patch: { strategy: { project: "local" } } },
		{ scope: "session", patch: { tactics: { next: "continue" } } },
	], "Scoped.");
	assert.equal(loadGlobalState(h.repositoryRoot)!.strategy.shared, "all projects");
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot)!.strategy.project, "local");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), tactics: { next: "continue" }, response: "Scoped." });
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
});

test("commits and hides one useful terminal patch after the tool loop", async () => {
	const h = harness();
	await start(h);
	const result = await commitTerminal(h, { goal: "Inspect project", compiled_rules: { read_once: true } }, { verified: { readme: true }, next: "run tests" }, "Inspection complete.");
	assert.equal(result.message.content[0].text, "Inspection complete.");
	assert.equal(h.resolveSnapshot().meta.step, 2);
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.equal(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.response, "Inspection complete.");
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"goal": "Inspect project"/);
	assert.match(h.notifications.at(-1)!, /"next": "run tests"/);
});

test("accepts ordinary terminal answers without invented bookkeeping and rejects materialized null", async () => {
	const h = harness();
	const started = await start(h);
	assert.match(started.systemPrompt, /never invent memory changes/i);
	await commitTerminal(h, {}, {}, "Done");
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), { ...emptyState(), response: "Done" });
	await commitTerminal(h, { mode: "test" }, { move: "e2-e4", result: "pending" });
	await commitTerminal(h, {}, { move: null, result: "ok" });
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.tactics, { result: "ok" });
	await assert.rejects(
		h.tools.get("patch_state")!.execute("null", { session: { tactics: { cells: ["pawn", null] } } }, undefined, undefined, h.ctx),
		/Materialized state cannot contain null/,
	);
});
