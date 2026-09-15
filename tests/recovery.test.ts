import assert from "node:assert/strict";
import test from "node:test";
import { recoverSnapshot } from "../lib/recovery.ts";
import { RevisionUnavailableError, emptySnapshot } from "../lib/snapshot.ts";
import { emptyState } from "../lib/state.ts";

test("recovery skips unsupported legacy envelopes and selects the next exact pointer", () => {
	const revision = "a".repeat(40);
	const resolved = { ...emptySnapshot(true), meta: { step: 3, durableBase: revision } };
	const result = recoverSnapshot([
		{ enabled: true, state: emptyState(), step: 2 },
		{ config: { enabled: true }, meta: { step: 2 } },
		{ revision },
	], (selected) => {
		assert.equal(selected, revision);
		return resolved;
	});
	assert.deepEqual(result.snapshot, resolved);
	assert.equal(result.skipped.length, 2);
});

test("disabled marker remains authoritative after unsupported entries", () => {
	const result = recoverSnapshot([{ revision: "HEAD" }, { disabled: true }]);
	assert.equal(result.snapshot.config.enabled, false);
	assert.equal(result.disabledMarker, true);
	assert.equal(result.skipped.length, 1);
});

test("an unavailable exact revision preserves selection and does not fall through", () => {
	const revision = "b".repeat(40);
	const result = recoverSnapshot([{ revision }, { disabled: true }], () => {
		throw new RevisionUnavailableError("temporarily unavailable");
	});
	assert.equal(result.snapshot.meta.durableBase, revision);
	assert.match(result.snapshot.meta.validation?.error ?? "", /temporarily unavailable/);
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
