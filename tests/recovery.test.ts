import assert from "node:assert/strict";
import test from "node:test";
import { recoverSnapshot } from "../lib/recovery.ts";
import { RevisionUnavailableError, emptySnapshot } from "../lib/snapshot.ts";
import { emptyState } from "../lib/state.ts";

test("recovery skips malformed envelopes and selects the next retained boundary", () => {
	const checkpoint = { boundary: "turn-3", enabled: true, step: 3 };
	const resolved = { ...emptySnapshot(true), meta: { step: 3 } };
	const result = recoverSnapshot([
		{ enabled: true, state: emptyState(), step: 2 },
		{ config: { enabled: true }, meta: { step: 2 } },
		checkpoint,
	], (selected) => {
		assert.deepEqual(selected, checkpoint);
		return resolved;
	});
	assert.deepEqual(result.snapshot, resolved);
	assert.equal(result.skipped.length, 2);
});

test("retained-boundary expiry does not fall through", () => {
	const checkpoint = { boundary: "turn-2", enabled: true, step: 2 };
	const resolved = { ...emptySnapshot(true), meta: { step: 2 } };
	assert.equal(recoverSnapshot([checkpoint], (selected) => {
		assert.deepEqual(selected, checkpoint);
		return resolved;
	}).snapshot, resolved);
	const expired = recoverSnapshot([checkpoint, { disabled: true }], () => {
		throw new RevisionUnavailableError("outside retained temporal window");
	});
	assert.equal(expired.snapshot.config.enabled, false);
	assert.equal(expired.disabledMarker, undefined);
	assert.match(expired.snapshot.meta.validation?.error ?? "", /outside retained temporal window/);
});

test("a selected boundary's storage failure never falls through to an older boundary or disabled marker", () => {
	const selected = { boundary: "selected", enabled: true, step: 2 };
	for (const failure of [new Error("Invalid canonical JSON"), new Error("State Flow runtime scope identity mismatch")]) {
		const attempted: string[] = [];
		const result = recoverSnapshot([selected, { boundary: "older", enabled: true, step: 1 }, { disabled: true }], (checkpoint) => {
			attempted.push(checkpoint.boundary);
			throw failure;
		});
		assert.deepEqual(attempted, [selected.boundary]);
		assert.equal(result.disabledMarker, undefined);
		assert.equal(result.snapshot.config.enabled, false);
		assert.equal(result.snapshot.meta.validation?.error, `Snapshot restoration failed: ${failure.message}`);
	}
});

test("disabled marker remains authoritative after malformed entries", () => {
	const result = recoverSnapshot([{ enabled: true, state: emptyState() }, { disabled: true }]);
	assert.equal(result.snapshot.config.enabled, false);
	assert.equal(result.disabledMarker, true);
	assert.equal(result.skipped.length, 1);
});

test("revision-pointer checkpoints fail closed without falling through", () => {
	const revision = "b".repeat(40);
	const result = recoverSnapshot([{ revision }, { disabled: true }]);
	assert.equal(result.snapshot.config.enabled, false);
	assert.match(result.snapshot.meta.validation?.error ?? "", /revision-pointer checkpoints are unsupported/);
	assert.equal(result.disabledMarker, undefined);
});

test("only unsupported candidates fail closed without semantic recovery", () => {
	const result = recoverSnapshot([
		{ enabled: true, state: emptyState() },
		{ stateBasis: { old: true }, previousStatePatch: { next: true } },
	]);
	assert.equal(result.snapshot.config.enabled, false);
	assert.equal(Object.hasOwn(result.snapshot, "legacySession"), false);
	assert.equal(result.skipped.length, 2);
});
