import assert from "node:assert/strict";
import test from "node:test";
import { selectedBoundaryFailure, selectRetainedCheckpoint, waitForRecovery } from "../lib/recovery.ts";
import { emptyState } from "../lib/state.ts";

test("a cancelled recovery join withdraws independently while another caller receives the eventual result", async () => {
	let finish!: (value: string) => void;
	const operation = new Promise<string>((resolve) => { finish = resolve; });
	const controller = new AbortController();
	const reason = new Error("caller cancelled");
	const withdrawn = assert.rejects(waitForRecovery(operation, controller.signal), (error) => error === reason);
	const retained = waitForRecovery(operation, new AbortController().signal);
	controller.abort(reason);
	await withdrawn;
	finish("accepted by its owner");
	assert.equal(await retained, "accepted by its owner");
});

test("recovery joins observe late owner failures even when cancellation precedes admission", async () => {
	let fail!: (error: Error) => void;
	const operation = new Promise<void>((_resolve, reject) => { fail = reject; });
	const reason = new Error("already cancelled");
	await assert.rejects(waitForRecovery(operation, AbortSignal.abort(reason)), (error) => error === reason);
	fail(new Error("late owner failure"));
	await new Promise((resolve) => setImmediate(resolve));
	const failure = new Error("current owner failure");
	await assert.rejects(waitForRecovery(Promise.reject(failure), new AbortController().signal), (error) => error === failure);
});

test("recovery skips malformed envelopes and selects the next retained boundary", () => {
	const checkpoint = { boundary: "turn-3", enabled: true, step: 3 };
	const result = selectRetainedCheckpoint([
		{ enabled: true, state: emptyState(), step: 2 },
		{ config: { enabled: true }, meta: { step: 2 } },
		checkpoint,
		{ boundary: "older", enabled: true, step: 1 },
	]);
	assert.equal(result.kind, "boundary");
	assert.deepEqual(result.kind === "boundary" && result.checkpoint, checkpoint);
	assert.equal(result.skipped.length, 2);
});

test("a selected boundary's resolution failure is final and never names an older candidate", () => {
	// Selection happens before any awaited resolution; its failure cannot fall through to older boundaries or disabled markers.
	const selection = selectRetainedCheckpoint([{ boundary: "selected", enabled: true, step: 2 }, { boundary: "older", enabled: true, step: 1 }, { disabled: true }]);
	assert.deepEqual(selection.kind === "boundary" && selection.checkpoint.boundary, "selected");
	for (const cause of ["Invalid canonical JSON", "outside retained temporal window"]) {
		const failure = selectedBoundaryFailure(cause);
		assert.equal(failure.config.enabled, false);
		assert.equal(failure.meta.validation?.attempt, 0);
		assert.equal(failure.meta.validation?.error, `Snapshot restoration failed: ${cause}`);
	}
});

test("disabled marker remains authoritative after malformed entries", () => {
	const result = selectRetainedCheckpoint([{ enabled: true, state: emptyState() }, { disabled: true }, { boundary: "older", enabled: true, step: 1 }]);
	assert.equal(result.kind, "disabled");
	assert.equal(result.skipped.length, 1);
});

test("revision-pointer checkpoints fail closed without falling through", () => {
	const revision = "b".repeat(40);
	const result = selectRetainedCheckpoint([{ revision }, { disabled: true }]);
	assert.equal(result.kind, "unavailable");
	if (result.kind !== "unavailable") return;
	assert.equal(result.snapshot.config.enabled, false);
	assert.match(result.snapshot.meta.validation?.error ?? "", /revision-pointer checkpoints are unsupported/);
});

test("only unsupported candidates fail closed without semantic recovery", () => {
	const result = selectRetainedCheckpoint([
		{ enabled: true, state: emptyState() },
		{ stateBasis: { old: true }, previousStatePatch: { next: true } },
	]);
	assert.equal(result.kind, "unavailable");
	if (result.kind !== "unavailable") return;
	assert.equal(result.snapshot.config.enabled, false);
	assert.equal(Object.hasOwn(result.snapshot, "legacySession"), false);
	assert.equal(result.skipped.length, 2);
	assert.equal(result.snapshot.meta.validation?.error, result.skipped[0]);
});
