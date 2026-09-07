import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, type JsonObject } from "../lib/json.ts";
import { emptyState, overlayStates, type ScopedStates, type StateScope } from "../lib/state.ts";
import {
	advanceTemporalState,
	createTemporalState,
	readTemporalState,
	validateTemporalState,
	type TemporalState,
} from "../lib/temporal.ts";
import type { RecentScopePatch } from "../lib/history.ts";

function initial(): ScopedStates {
	return { global: emptyState(), cwd: emptyState(), session: emptyState() };
}

function patch(scope: StateScope, value: number): RecentScopePatch {
	return { scope, patch: { working: { value } } };
}

function expectHistory(view: TemporalState, snapshots: ScopedStates[]): void {
	for (let offset = 0; offset < Math.min(8, snapshots.length); offset++) {
		const expected = snapshots.at(-1 - offset)!;
		assert.deepEqual(readTemporalState(view, offset), overlayStates(expected.global, expected.cwd, expected.session));
		for (const scope of ["global", "cwd", "session"] as const) {
			assert.deepEqual(readTemporalState(view, offset, scope), expected[scope], `${scope}[${offset}]`);
		}
	}
}

test("zero patches preserve the initial materialization without fabricating a past", () => {
	const states = initial();
	states.session.working = { retained: [1, 2], nested: { fact: true } };
	const view = createTemporalState(states, "migration-base");
	expectHistory(view, [states]);
	assert.equal(view.scopes.session.checkpoint.through.id, "migration-base");
	assert.deepEqual(view.scopes.session.patches, []);
	assert.throws(() => readTemporalState(view, 1), /proven temporal origin/);
	states.session.working.retained = [];
	assert.deepEqual(readTemporalState(view).working.retained, [1, 2]);
});

test("one patch shifts current to history and reads return detached materializations", () => {
	const view = createTemporalState(initial(), "base");
	const next = advanceTemporalState(view, [patch("session", 1)], "T1");
	assert.deepEqual(readTemporalState(next, 1), readTemporalState(view));
	assert.deepEqual(readTemporalState(next).working, { value: 1 });
	assert.equal(next.lineage.at(-1)!.parent, "base");
	assert.deepEqual(view.scopes.session.patches, []);
	const returned = readTemporalState(next);
	returned.working.value = 99;
	assert.equal(readTemporalState(next).working.value, 1);
});

test("seven patches and repeated eighth-patch folding preserve every hot state exactly", () => {
	let view = createTemporalState(initial(), "base");
	const snapshots = [initial()];
	for (let index = 1; index <= 40; index++) {
		view = advanceTemporalState(view, [patch("session", index)], `T${index}`);
		const states = structuredClone(snapshots.at(-1)!);
		states.session.working.value = index;
		snapshots.push(states);
		expectHistory(view, snapshots);
		const stream = view.scopes.session;
		assert.equal(stream.patches.length, Math.min(index, 7));
		assert.equal(stream.checkpoint.through.position, Math.max(0, index - 7));
		if (index === 7) assert.deepEqual(stream.checkpoint.state, initial().session);
		if (index === 8) {
			assert.equal(stream.checkpoint.through.id, "T1");
			assert.equal(stream.checkpoint.state.working.value, 1);
			assert.deepEqual(stream.patches.map((record) => record.transition.id), ["T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
		}
	}
});

test("sparse scope patches use effective boundaries, not each scope's mutation count", () => {
	const states = initial();
	states.global.working = { global: "G" };
	states.cwd.working = { cwd: "C" };
	states.session.working = { session: "S" };
	let view = createTemporalState(states, "T181");
	view = advanceTemporalState(view, [
		{ scope: "cwd", patch: { working: { cwd: "C'" } } },
		{ scope: "session", patch: { working: { session: "S'" } } },
	], "T182");
	view = advanceTemporalState(view, [
		{ scope: "global", patch: { working: { global: "G'" } } },
		{ scope: "session", patch: { working: { session: "S''" } } },
	], "T183");
	view = advanceTemporalState(view, [
		{ scope: "cwd", patch: { working: { cwd: "C''" } } },
		{ scope: "session", patch: { working: { session: "S'''" } } },
	], "T184");
	assert.deepEqual(readTemporalState(view, 1).working, { global: "G'", cwd: "C'", session: "S''" });
	assert.deepEqual(readTemporalState(view, 1, "global").working, { global: "G'" });
	assert.deepEqual(readTemporalState(view, 1, "cwd").working, { cwd: "C'" });
	assert.deepEqual(readTemporalState(view, 2, "cwd").working, { cwd: "C'" });
	assert.deepEqual(view.scopes.cwd.patches.at(-1)!.transition, view.scopes.session.patches.at(-1)!.transition);
	assert.equal(view.scopes.global.patches.at(-1)!.transition.id, "T183");
});

test("mixed sparse changes and deletion overlays match an independent snapshot oracle through compaction", () => {
	const states = initial();
	states.global.working = { inherited: { value: "global", stable: true } };
	states.cwd.working = { inherited: { value: "cwd" } };
	states.session.working = { inherited: { value: "session" } };
	let view = createTemporalState(states, "base");
	const snapshots = [states];
	for (let index = 1; index <= 50; index++) {
		const changes: RecentScopePatch[] = [patch("session", index)];
		if (index % 3 === 0) changes.push(patch("cwd", index));
		if (index % 11 === 0) changes.push(patch("global", index));
		if (index === 1) changes[0]!.patch.working!.inherited = { value: null };
		if (index === 3) changes[1]!.patch.working!.inherited = { value: null };
		const expected = structuredClone(snapshots.at(-1)!);
		for (const change of changes) expected[change.scope] = applyPatch(expected[change.scope], change.patch as JsonObject) as ScopedStates[StateScope];
		snapshots.push(expected);
		view = advanceTemporalState(view, changes, `T${index}`);
		expectHistory(view, snapshots);
		if (index === 3) {
			assert.deepEqual(readTemporalState(view).working.inherited, { value: "global", stable: true });
			assert.deepEqual(readTemporalState(view, 1).working.inherited, { value: "cwd", stable: true });
			assert.deepEqual(readTemporalState(view, 3).working.inherited, { value: "session", stable: true });
		}
	}
	assert.ok(view.scopes.global.checkpoint.through.position < view.lineage[0]!.position);
});

test("true no-ops do not enter history while response-only changes do", () => {
	const view = createTemporalState(initial(), "base");
	assert.equal(advanceTemporalState(view, [], "unused"), view);
	assert.equal(advanceTemporalState(view, [{ scope: "cwd", patch: {} }], "unused"), view);
	const next = advanceTemporalState(view, [{ scope: "session", patch: { response: "Done" } }], "answer");
	assert.equal(readTemporalState(next).response, "Done");
	assert.equal(readTemporalState(next, 1).response, "");
	assert.equal(advanceTemporalState(next, [{ scope: "session", patch: { response: "Done" } }], "unused"), next);
	const changed = advanceTemporalState(next, [patch("cwd", 1), { scope: "session", patch: { response: "Done" } }], "cwd-only");
	assert.equal(changed.scopes.session.patches.length, 1);
	assert.equal(changed.lineage.length, 3);
});

test("hot range and unproven pre-migration history are explicit read boundaries", () => {
	const view = createTemporalState(initial(), "base");
	for (const offset of [-1, 8, 1.5, NaN, Infinity]) assert.throws(() => readTemporalState(view, offset), /integer from 0 to 7/);
	assert.throws(() => readTemporalState(view, 7), /proven temporal origin/);
	assert.throws(() => readTemporalState(view, 0, "other" as StateScope), /Unknown temporal scope/);
});

test("fork identity and explicit parent links prevent equal-position branch substitution", () => {
	const base = createTemporalState(initial(), "base");
	const left = advanceTemporalState(base, [patch("cwd", 1)], "left");
	const right = advanceTemporalState(base, [patch("cwd", 2)], "right");
	assert.equal(left.lineage.at(-1)!.position, right.lineage.at(-1)!.position);
	assert.notEqual(left.lineage.at(-1)!.id, right.lineage.at(-1)!.id);
	assert.equal(readTemporalState(left).working.value, 1);
	assert.equal(readTemporalState(right).working.value, 2);
	const mixed = structuredClone(left);
	mixed.scopes.cwd = right.scopes.cwd;
	assert.throws(() => readTemporalState(mixed), /Conflicting.*lineage/);
	const disconnected = structuredClone(left);
	disconnected.lineage.at(-1)!.parent = "unrelated";
	assert.throws(() => validateTemporalState(disconnected), /Disconnected/);
	assert.throws(() => advanceTemporalState(left, [patch("cwd", 3)], "left"), /already been used/);
});

test("invalid semantic tails fail closed rather than being truncated or mutating the basis", () => {
	const base = createTemporalState(initial(), "base");
	assert.throws(() => advanceTemporalState(base, [patch("cwd", 1), patch("cwd", 2)], "duplicate"), /Duplicate/);
	assert.throws(() => advanceTemporalState(base, [{ scope: "session", patch: { working: { invalid: [null] } } }], "null"), /semantic state/);
	assert.throws(() => advanceTemporalState(base, [{ scope: "global", patch: { response: "forged" } }], "response"), /session response/);
	assert.deepEqual(readTemporalState(base), emptyState());
	const next = advanceTemporalState(base, [patch("cwd", 1)], "T1");
	const oversized = structuredClone(next);
	oversized.scopes.cwd.patches = Array(8).fill(next.scopes.cwd.patches[0]);
	assert.throws(() => validateTemporalState(oversized), /exceeds seven/);
	const lost = structuredClone(next);
	lost.scopes.cwd.patches = [];
	assert.throws(() => validateTemporalState(lost), /no semantic patch/);
});
