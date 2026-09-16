import assert from "node:assert/strict";
import test from "node:test";
import {
	createSessionRuntime, emptySnapshot, migrateSnapshot, parsePiCheckpoint, parseSessionRuntime,
	persistableSnapshot, resolveFileSessionRuntime, resolveSessionRuntime, serializeSessionRuntime,
} from "../lib/snapshot.ts";
import { createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";

test("session config/runtime codec separates runtime provenance from semantic state and resolves self explicitly", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = { ...emptySnapshot(true), meta: { step: 3, specification: "Continue" } };
	const runtime = createSessionRuntime(snapshot, "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	const parsed = parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!;
	assert.deepEqual(parsed, runtime);
	assert.deepEqual(resolveSessionRuntime(parsed, "a".repeat(40)).snapshot, {
		config: snapshot.config,
		meta: { ...snapshot.meta, durableBase: "a".repeat(40) },
	});
	const fileRuntime = createSessionRuntime(snapshot, "/project", "session", view.lineage, "files");
	assert.deepEqual(resolveFileSessionRuntime(fileRuntime, `file:${"b".repeat(64)}`).meta.durableBase, `file:${"b".repeat(64)}`);
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
		{ ...runtime, meta: { ...runtime.meta, step: -1 } },
		{ ...runtime, meta: { ...runtime.meta, working: { forged: true } } },
		{ ...runtime, meta: { ...runtime.meta, version: 2 } },
		{ ...runtime, meta: { ...runtime.meta, lineage: [runtime.meta.lineage[0], runtime.meta.lineage[0]] } },
	]) assert.throws(() => parseSessionRuntime(JSON.stringify(candidate.config), JSON.stringify(candidate.meta), "/project", "session"));
});

test("Pi checkpoints admit only exact pointers or the disabled marker", () => {
	for (const revision of ["a".repeat(40), "b".repeat(64), `file:${"c".repeat(64)}`]) {
		assert.deepEqual(parsePiCheckpoint({ revision }), { revision });
	}
	assert.deepEqual(parsePiCheckpoint({ disabled: true }), { disabled: true });
	for (const invalid of [
		{}, { revision: "HEAD" }, { disabled: false }, { revision: "a".repeat(40), enabled: true },
		{ enabled: true, state: emptyState() }, { config: { enabled: true }, meta: { step: 1 } },
	]) assert.throws(() => parsePiCheckpoint(invalid), /checkpoint|Unrecognized/);
});

test("snapshot normalization retains runtime fields but never semantic migration payloads", () => {
	assert.deepEqual(migrateSnapshot({ config: { enabled: true }, meta: { step: 2, specification: "Continue" } }), {
		config: { enabled: true }, meta: { step: 2, specification: "Continue" },
	});
	assert.deepEqual(migrateSnapshot({ enabled: true, step: 2, state: emptyState() }), {
		config: { enabled: false }, meta: { step: 2 },
	});
	assert.deepEqual(persistableSnapshot(emptySnapshot(false)), { disabled: true });
	assert.throws(() => persistableSnapshot(emptySnapshot(true)), /durable runtime revision/);
});
