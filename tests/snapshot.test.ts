import assert from "node:assert/strict";
import test from "node:test";
import {
	createSessionRuntime, emptySnapshot, parseRetainedPiCheckpoint, parseSessionRuntime,
	preRuntimeCheckpoint, retainedBoundaryCheckpoint, serializeSessionRuntime,
} from "../lib/snapshot.ts";
import { createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";

test("session config/runtime codec separates runtime provenance from semantic state", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = { ...emptySnapshot("active"), meta: { step: 3, specification: "Continue" } };
	const runtime = createSessionRuntime(snapshot, "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	const parsed = parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!;
	assert.deepEqual(parsed, runtime);
});

test("session config serializes only the selected mode and decodes legacy enabled read-only", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	for (const mode of ["active", "passive", "off"] as const) {
		const runtime = createSessionRuntime(emptySnapshot(mode), "/project", "session", view.lineage);
		const sources = serializeSessionRuntime(runtime, "/project", "session");
		assert.equal(sources.config, `${JSON.stringify({ mode })}\n`);
		assert.deepEqual(parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!.config, { mode });
	}
	const runtime = serializeSessionRuntime(createSessionRuntime(emptySnapshot("active"), "/project", "session", view.lineage), "/project", "session").runtime;
	assert.deepEqual(parseSessionRuntime(JSON.stringify({ enabled: true }), runtime, "/project", "session")!.config, { mode: "active" });
	assert.notEqual(parseSessionRuntime(JSON.stringify({ enabled: false }), runtime, "/project", "session")!.config.mode, "active");
	for (const invalid of [{}, { mode: "on" }, { mode: "active", enabled: true }, { enabled: "yes" }, { mode: null }]) {
		assert.throws(() => parseSessionRuntime(JSON.stringify(invalid), runtime, "/project", "session"), /runtime configuration/);
	}
});

test("runtime decoding rejects mismatched identity, malformed lineage, invalid config/counters, and semantic fields", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(emptySnapshot("active"), "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	assert.equal(parseSessionRuntime(undefined, undefined, "/project", "session"), undefined);
	assert.throws(() => parseSessionRuntime(undefined, sources.runtime, "/project", "session"), /Incomplete/);
	assert.throws(() => parseSessionRuntime("bad", sources.runtime, "/project", "session"), /invalid JSON/);
	assert.throws(() => parseSessionRuntime(sources.config, sources.runtime, "/other", "session"), /identity mismatch/);
	for (const candidate of [
		{ ...runtime, config: { mode: "active", unexpected: true } },
		{ ...runtime, config: { enabled: true, transitionWindow: 7 } },
		{ ...runtime, meta: { ...runtime.meta, step: -1 } },
		{ ...runtime, meta: { ...runtime.meta, working: { forged: true } } },
		{ ...runtime, meta: { ...runtime.meta, version: 2 } },
		{ ...runtime, meta: { ...runtime.meta, lineage: [runtime.meta.lineage[0], runtime.meta.lineage[0]] } },
	]) assert.throws(() => parseSessionRuntime(JSON.stringify(candidate.config), JSON.stringify(candidate.meta), "/project", "session"));
});

test("retained-boundary checkpoints contain only temporal identity and branch lifecycle", () => {
	const snapshot = {
		config: { mode: "active" as const },
		meta: {
			step: 4,
			bootstrap: true as const,
			specification: "Finish the retained run",
		},
	};
	const checkpoint = retainedBoundaryCheckpoint(snapshot, "transition-4");
	assert.deepEqual(checkpoint, {
		boundary: "transition-4", mode: "active", step: 4, bootstrap: true, specification: "Finish the retained run",
	});
	assert.deepEqual(parseRetainedPiCheckpoint(checkpoint), checkpoint);
	for (const mode of ["passive", "off"] as const) {
		assert.deepEqual(preRuntimeCheckpoint(mode), { mode });
		assert.deepEqual(parseRetainedPiCheckpoint({ mode }), { mode });
		// Legacy markers keep the caller's inactive policy; enabled:true alone stays active.
		assert.deepEqual(parseRetainedPiCheckpoint({ disabled: true }, mode), { mode });
		assert.deepEqual(parseRetainedPiCheckpoint({ boundary: "b", enabled: false, step: 1 }, mode), { boundary: "b", mode, step: 1 });
		assert.deepEqual(parseRetainedPiCheckpoint({ boundary: "b", enabled: true, step: 1 }, mode), { boundary: "b", mode: "active", step: 1 });
	}
	assert.throws(() => preRuntimeCheckpoint("active"), /retained semantic boundary/);
	for (const invalid of [
		{}, { mode: "active" }, { disabled: false }, { boundary: "", mode: "active", step: 0 }, { boundary: "b", enabled: "yes", step: 0 },
		{ boundary: "b", mode: "on", step: 0 }, { boundary: "b", mode: "active", enabled: true, step: 0 },
		{ boundary: "b", mode: "active", step: -1 }, { boundary: "b", mode: "active", step: 0, bootstrap: false },
		{ boundary: "b", mode: "active", step: 0, revision: "a".repeat(40) },
	]) assert.throws(() => parseRetainedPiCheckpoint(invalid), /retained-boundary checkpoint/);
});
