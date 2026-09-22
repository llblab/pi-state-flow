import assert from "node:assert/strict";
import test from "node:test";
import {
	createSessionRuntime, emptySnapshot, parseRetainedPiCheckpoint, parseSessionRuntime,
	retainedBoundaryCheckpoint, serializeSessionRuntime,
} from "../lib/snapshot.ts";
import { createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";

test("session config/runtime codec separates runtime provenance from semantic state", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = { ...emptySnapshot(true), meta: { step: 3, specification: "Continue" } };
	const runtime = createSessionRuntime(snapshot, "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	const parsed = parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!;
	assert.deepEqual(parsed, runtime);
});

test("runtime decoding rejects mismatched identity, malformed lineage, invalid config/counters, and semantic fields", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(emptySnapshot(true), "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	assert.equal(parseSessionRuntime(undefined, undefined, "/project", "session"), undefined);
	assert.throws(() => parseSessionRuntime(undefined, sources.runtime, "/project", "session"), /Incomplete/);
	assert.throws(() => parseSessionRuntime("bad", sources.runtime, "/project", "session"), /invalid JSON/);
	assert.throws(() => parseSessionRuntime(sources.config, sources.runtime, "/other", "session"), /identity mismatch/);
	for (const candidate of [
		{ ...runtime, config: { enabled: true, unexpected: true } },
		{ ...runtime, config: { enabled: true, transitionWindow: 7 } },
		{ ...runtime, meta: { ...runtime.meta, step: -1 } },
		{ ...runtime, meta: { ...runtime.meta, working: { forged: true } } },
		{ ...runtime, meta: { ...runtime.meta, version: 2 } },
		{ ...runtime, meta: { ...runtime.meta, lineage: [runtime.meta.lineage[0], runtime.meta.lineage[0]] } },
	]) assert.throws(() => parseSessionRuntime(JSON.stringify(candidate.config), JSON.stringify(candidate.meta), "/project", "session"));
});

test("retained-boundary checkpoints contain only temporal identity and branch lifecycle", () => {
	const snapshot = {
		config: { enabled: true },
		meta: {
			step: 4,
			bootstrap: true as const,
			specification: "Finish the retained run",
		},
	};
	const checkpoint = retainedBoundaryCheckpoint(snapshot, "transition-4");
	assert.deepEqual(checkpoint, {
		boundary: "transition-4", enabled: true, step: 4, bootstrap: true, specification: "Finish the retained run",
	});
	assert.deepEqual(parseRetainedPiCheckpoint(checkpoint), checkpoint);
	assert.deepEqual(parseRetainedPiCheckpoint({ disabled: true }), { disabled: true });
	for (const invalid of [
		{}, { boundary: "", enabled: true, step: 0 }, { boundary: "b", enabled: "yes", step: 0 },
		{ boundary: "b", enabled: true, step: -1 }, { boundary: "b", enabled: true, step: 0, bootstrap: false },
		{ boundary: "b", enabled: true, step: 0, revision: "a".repeat(40) },
	]) assert.throws(() => parseRetainedPiCheckpoint(invalid), /retained-boundary checkpoint/);
});
