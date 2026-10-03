import assert from "node:assert/strict";
import test from "node:test";
import { OwnedOperationSlot, RenewableLifetime, type OwnedOperation } from "../lib/operation.ts";

interface Entry extends OwnedOperation {
	operation?: Promise<string>;
	label: string;
}

test("owned operation slot supersedes by cancellation and never lets a late owner clear newer work", async () => {
	const slot = new OwnedOperationSlot<Entry>();
	assert.equal(slot.current, undefined);
	assert.equal(slot.cancel(), undefined);
	const first = slot.claim({ controller: new AbortController(), label: "first" });
	assert.equal(slot.owns(first), true);
	let finishFirst!: (value: string) => void;
	const firstOperation = slot.track(first, new Promise<string>((resolve) => { finishFirst = resolve; }));
	assert.equal(first.operation, firstOperation);
	assert.deepEqual(slot.inflight, [firstOperation]);
	assert.equal(slot.cancel(), firstOperation, "cancel returns the owner's operation for optional awaiting");
	assert.equal(first.controller.signal.aborted, true);
	assert.equal(slot.current, undefined);
	const second = slot.claim({ controller: new AbortController(), label: "second" });
	finishFirst("late");
	await firstOperation;
	await Promise.resolve();
	assert.equal(slot.current, second, "a superseded completion cannot release the newer owner");
	assert.deepEqual(slot.inflight, []);
	slot.release(first);
	assert.equal(slot.current, second);
	const operation = slot.track(second, Promise.resolve("done"));
	await operation;
	await Promise.resolve();
	assert.equal(slot.current, undefined, "settlement releases the current owner");
});

test("owned operation slot can keep ownership past settlement and still drains superseded work", async () => {
	const slot = new OwnedOperationSlot<Entry>();
	const kept = slot.claim({ controller: new AbortController(), label: "kept" });
	let finish!: (value: string) => void;
	const pending = slot.track(kept, new Promise<string>((resolve) => { finish = resolve; }), false);
	slot.cancel();
	const next = slot.claim({ controller: new AbortController(), label: "next" });
	assert.deepEqual(slot.inflight, [pending], "superseded work stays drainable");
	finish("done");
	await pending;
	await Promise.resolve();
	assert.deepEqual(slot.inflight, []);
	assert.equal(slot.current, next);
	const settled = slot.claim({ controller: new AbortController(), label: "settled" });
	await slot.track(settled, Promise.reject(new Error("failed")), false).catch(() => undefined);
	await Promise.resolve();
	assert.equal(slot.current, settled, "release stays with the caller when releaseOnSettle is false");
	assert.deepEqual(slot.inflight, []);
});

test("renewable lifetime aborts current holders on renewal and stays ended after shutdown", () => {
	const lifetime = new RenewableLifetime();
	const first = lifetime.signal;
	const reason = new Error("select again");
	lifetime.renew(reason);
	assert.equal(first.aborted, true);
	assert.equal(first.reason, reason);
	assert.equal(lifetime.signal.aborted, false);
	const second = lifetime.signal;
	lifetime.end();
	assert.equal(second.aborted, true);
	assert.equal(lifetime.signal, second, "ending opens no new lifetime");
});
