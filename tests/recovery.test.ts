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
		{ config: { mode: "active" as const }, meta: { step: 2 } },
		checkpoint,
		{ boundary: "older", enabled: true, step: 1 },
	]);
	assert.equal(result.kind, "boundary");
	// Legacy enabled:true stays active; new writes carry only mode.
	assert.deepEqual(result.kind === "boundary" && result.checkpoint, { boundary: "turn-3", mode: "active", step: 3 });
	assert.equal(result.skipped.length, 2);
	const current = selectRetainedCheckpoint([{ boundary: "turn-4", mode: "off", step: 4 }]);
	assert.deepEqual(current.kind === "boundary" && current.checkpoint, { boundary: "turn-4", mode: "off", step: 4 });
	for (const inactiveMode of ["passive", "off"] as const) {
		const legacy = selectRetainedCheckpoint([{ boundary: "stopped", enabled: false, step: 2 }], inactiveMode);
		assert.deepEqual(legacy.kind === "boundary" && legacy.checkpoint, { boundary: "stopped", mode: inactiveMode, step: 2 });
	}
});

test("a selected boundary's resolution failure is final and never names an older candidate", () => {
	// Selection happens before any awaited resolution; its failure cannot fall through to older boundaries or disabled markers.
	const selection = selectRetainedCheckpoint([{ boundary: "selected", enabled: true, step: 2 }, { boundary: "older", enabled: true, step: 1 }, { disabled: true }]);
	assert.deepEqual(selection.kind === "boundary" && selection.checkpoint.boundary, "selected");
	for (const mode of ["active", "passive", "off"] as const) for (const cause of ["Invalid canonical JSON", "outside retained temporal window"]) {
		const failure = selectedBoundaryFailure(cause, mode);
		assert.equal(failure.config.mode, mode, "unavailable memory must not silently change selected policy");
		assert.equal(failure.meta.validation?.attempt, 0);
		assert.equal(failure.meta.validation?.error, `Snapshot restoration failed: ${cause}`);
	}
});

test("pre-runtime mode marker remains authoritative after malformed entries", () => {
	const result = selectRetainedCheckpoint([{ enabled: true, state: emptyState() }, { mode: "off" }, { boundary: "older", enabled: true, step: 1 }]);
	assert.equal(result.kind, "pre-runtime");
	assert.equal(result.kind === "pre-runtime" && result.mode, "off");
	assert.equal(result.skipped.length, 1);
	// A legacy disabled marker keeps the configured inactive policy and never becomes active.
	for (const inactiveMode of ["passive", "off"] as const) {
		const legacy = selectRetainedCheckpoint([{ disabled: true }, { boundary: "older", enabled: true, step: 1 }], inactiveMode);
		assert.deepEqual(legacy.kind === "pre-runtime" && legacy.mode, inactiveMode);
	}
	assert.equal(selectRetainedCheckpoint([{ mode: "active" }]).kind, "unavailable", "an active branch needs a retained boundary");
});

test("revision-pointer checkpoints fail closed without falling through", () => {
	const revision = "b".repeat(40);
	const result = selectRetainedCheckpoint([{ revision }, { disabled: true }]);
	assert.equal(result.kind, "unavailable");
	if (result.kind !== "unavailable") return;
	assert.notEqual(result.snapshot.config.mode, "active");
	assert.match(result.snapshot.meta.validation?.error ?? "", /revision-pointer checkpoints are unsupported/);
});

test("only unsupported candidates fail closed without semantic recovery", () => {
	const result = selectRetainedCheckpoint([
		{ enabled: true, state: emptyState() },
		{ stateBasis: { old: true }, previousStatePatch: { next: true } },
	]);
	assert.equal(result.kind, "unavailable");
	if (result.kind !== "unavailable") return;
	assert.notEqual(result.snapshot.config.mode, "active");
	assert.equal(Object.hasOwn(result.snapshot, "legacySession"), false);
	assert.equal(result.skipped.length, 2);
	assert.equal(result.snapshot.meta.validation?.error, result.skipped[0]);
});
