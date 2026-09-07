import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionState } from "./temporal-fixture.ts";
import { createSessionRuntime, emptySnapshot, migrateSnapshot, parsePiCheckpoint, parseSessionRuntime, persistableSnapshot, resolveSessionRuntime, serializeSessionRuntime } from "../lib/snapshot.ts";
import { createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";
import { commitTerminal, harness, start, terminalComment, toolAssistant, user } from "./harness.ts";

test("session config/meta codec separates runtime provenance from semantic state and resolves self explicitly", () => {
	const snapshot = emptySnapshot(true);
	snapshot.meta.bootstrap = false;
	snapshot.meta.specification = "Current user specification";
	snapshot.meta.durableBase = "a".repeat(40);
	snapshot.meta.pendingPublication = { commit: "b".repeat(40), error: "Earlier attempt" };
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(snapshot, "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	assert.deepEqual(JSON.parse(sources.config), { enabled: true, transitionWindow: 7 });
	assert.equal(JSON.parse(sources.meta).revision, "self");
	assert.equal(JSON.parse(sources.meta).publication, "unconfirmed");
	assert.equal(JSON.parse(sources.meta).lineage[0].parent, null);
	for (const key of ["state", "artifacts", "contract", "working", "response", "durableBase", "pendingPublication"]) {
		assert.equal(Object.hasOwn(JSON.parse(sources.meta), key), false, key);
	}
	const restored = parseSessionRuntime(sources.config, sources.meta, "/project", "session")!;
	assert.deepEqual(restored, runtime);
	const resolved = resolveSessionRuntime(restored, "c".repeat(40));
	assert.equal(resolved.snapshot.meta.durableBase, "c".repeat(40));
	assert.equal(resolved.publicationTarget, "c".repeat(40));
	assert.equal(resolved.snapshot.meta.pendingPublication, undefined);
	assert.equal(resolved.snapshot.meta.bootstrap, false);
	assert.equal(resolved.snapshot.meta.specification, snapshot.meta.specification);
	assert.deepEqual(resolved.lineage, view.lineage);
	resolved.lineage[0]!.id = "changed-copy";
	assert.equal(runtime.meta.lineage[0]!.id, "origin");
});

test("runtime decoding rejects mismatched identity, malformed lineage, invalid config/counters, and semantic fields", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(emptySnapshot(true), "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	assert.equal(parseSessionRuntime(undefined, undefined, "/project", "session"), undefined);
	assert.throws(() => parseSessionRuntime(undefined, sources.meta, "/project", "session"), /Incomplete/);
	assert.throws(() => parseSessionRuntime("bad", sources.meta, "/project", "session"), /invalid JSON/);
	assert.throws(() => parseSessionRuntime(sources.config, sources.meta, "/other", "session"), /identity mismatch/);
	assert.throws(() => parseSessionRuntime(sources.config, sources.meta, "/project", "other"), /identity mismatch/);
	const invalid = [
		{ ...runtime, config: { enabled: true, transitionWindow: 8 } },
		{ ...runtime, meta: { ...runtime.meta, step: -1 } },
		{ ...runtime, meta: { ...runtime.meta, working: { forged: true } } },
		{ ...runtime, meta: { ...runtime.meta, version: 2 } },
		{ ...runtime, meta: { ...runtime.meta, lineage: [runtime.meta.lineage[0], runtime.meta.lineage[0]] } },
	];
	for (const candidate of invalid) assert.throws(() => parseSessionRuntime(JSON.stringify(candidate.config), JSON.stringify(candidate.meta), "/project", "session"));
	assert.throws(() => resolveSessionRuntime(runtime, "HEAD"), /exact Git revision/);
});

test("migrates legacy two-part snapshots without runtime dependencies", () => {
	assert.deepEqual(migrateSnapshot({
		enabled: true,
		step: 2,
		state: { contract: { goal: "keep" }, working: { next: "continue" } },
	}), {
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 2 },
		legacySession: {
			state: { artifacts: {}, contract: { goal: "keep" }, working: { next: "continue" }, response: "" },
		},
	});
});

test("persists only the exact runtime revision, never legacy state or runtime copies", () => {
	const migrated = migrateSnapshot({
		config: { enabled: true, transitionWindow: 3 },
		meta: { durableBase: "a".repeat(40), step: 2, recentTransitions: [] },
		state: { artifacts: {}, contract: { legacy: true }, working: {}, response: "old" },
	});
	assert.deepEqual(persistableSnapshot(migrated), { revision: "a".repeat(40) });
	assert.deepEqual(persistableSnapshot(emptySnapshot()), { disabled: true });
	assert.throws(() => persistableSnapshot(emptySnapshot(true)), /durable runtime revision/);
	migrated.config.enabled = false;
	delete migrated.meta.durableBase;
	assert.throws(() => persistableSnapshot(migrated), /Legacy semantic state requires migration/);
});

test("checkpoint syntax admits only exact hash pointers or the explicit disabled marker", () => {
	for (const length of [40, 64]) {
		const pointer = { revision: "a".repeat(length) };
		assert.deepEqual(parsePiCheckpoint(pointer), pointer);
	}
	assert.deepEqual(parsePiCheckpoint({ disabled: true }), { disabled: true });
	for (const candidate of [
		null, [], {}, "HEAD", { revision: "HEAD" }, { revision: "a".repeat(39) },
		{ revision: "a".repeat(41) }, { revision: "a".repeat(63) }, { revision: "a".repeat(65) },
		{ revision: "A".repeat(40) }, { revision: " a".repeat(20) }, { revision: 123 },
		{ revision: "a".repeat(40), disabled: true }, { revision: "a".repeat(40), config: {} },
		{ revision: "a".repeat(40), meta: {} }, { disabled: false }, { disabled: true, step: 0 },
	]) assert.throws(() => parsePiCheckpoint(candidate), Error, JSON.stringify(candidate));
});

test("restores a bounded branch-local transition window and defaults legacy snapshots to seven", () => {
	const state = { artifacts: {}, contract: {}, working: {}, response: "" };
	assert.equal(migrateSnapshot({ config: { enabled: true, transitionWindow: 3 }, meta: {}, state }).config.transitionWindow, 3);
	assert.equal(migrateSnapshot({ config: { enabled: true }, meta: {}, state }).config.transitionWindow, 7);
	assert.equal(migrateSnapshot({ config: { enabled: true, transitionWindow: 8 }, meta: {}, state }).config.transitionWindow, 7);
});

test("migrates the retired contract Skill store into source-addressed artifacts without losing behavior", () => {
	const source = "/missing/legacy/SKILL.md";
	const restored = migrateSnapshot({
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 3 },
		state: {
			artifacts: {},
			contract: {
				goal: "keep",
				compiled_skills: { [source]: { routing: "preserve legacy behavior" } },
			},
			working: {},
			response: "Previous",
		},
	});
	const state = restored.legacySession!.state;
	assert.deepEqual(state.contract, { goal: "keep" });
	assert.deepEqual(state.artifacts[source].compilation, { routing: "preserve legacy behavior" });
	assert.equal(state.artifacts[source].kind, "skill");
	assert.equal(state.artifacts[source].compiler, "skill-artifact-v1");
	assert.equal(state.artifacts[source].source_hash_verified, false);
	assert.match(state.artifacts[source].hash, /^sha256:[0-9a-f]{64}$/);
});

test("restores runtime config, metadata, and semantic state independently", () => {
	const source = {
		config: { enabled: true, transitionWindow: 7 },
		meta: {
			durableBase: "b".repeat(40),
			pendingPublication: { commit: "a".repeat(40), error: "remote unavailable" },
			step: 4,
			specification: "Continue",
			bootstrap: true,
		},
		state: {
			artifacts: {
				"/a.md": {
					description: "A",
					hash: `sha256:${"a".repeat(64)}`,
					compiler: "artifact-v1",
				},
			},
			contract: { goal: "ship" },
			working: {},
			response: "Done",
		},
	};
	const restored = migrateSnapshot(source);
	assert.deepEqual(restored, {
		config: source.config,
		meta: source.meta,
		legacySession: { state: source.state },
	});
	assert.notStrictEqual(restored.config, source.config);
	assert.notStrictEqual(restored.meta, source.meta);
	assert.notStrictEqual(restored.legacySession!.state, source.state);
});

test("discards malformed pending-publication metadata without losing semantic state", () => {
	const restored = migrateSnapshot({
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 2, pendingPublication: { commit: "not-a-commit", error: "" } },
		state: { artifacts: {}, contract: { kept: true }, working: {}, response: "Done" },
	});
	assert.equal(restored.meta.pendingPublication, undefined);
	assert.equal(restored.legacySession!.state.contract.kept, true);
});

test("legacy Pi explanatory journals are discarded regardless of validity", () => {
	const recentTransitions = Array.from({ length: 9 }, (_, index) => ({
		id: `snapshot-${index}`,
		at: index,
		transitions: [{ scope: "session", patch: { working: { index } } }],
	}));
	const restored = migrateSnapshot({
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 9, recentTransitions },
		state: { artifacts: {}, contract: {}, working: {}, response: "Done" },
	});
	assert.deepEqual(restored.legacySession, { state: { artifacts: {}, contract: {}, working: {}, response: "Done" } });

	const malformed = migrateSnapshot({
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 1, recentTransitions: [{ invalid: true }] },
		state: { artifacts: {}, contract: {}, working: {}, response: "Done" },
	});
	assert.equal(malformed.config.enabled, true);
	assert.deepEqual(malformed.legacySession, restored.legacySession);
});

test("fails closed on invalid restored artifact metadata", () => {
	const result = migrateSnapshot({
		config: { enabled: true, transitionWindow: 7 },
		meta: { step: 3 },
		state: {
			artifacts: { "/a.md": { description: "Missing hash and compiler" } },
			contract: {},
			working: {},
			response: "old",
		},
	});
	assert.equal(result.config.enabled, false);
	assert.match(result.meta.validation?.error ?? "", /invalid materialized-state schema/);
});

test("fails closed on materialized null", () => {
	const result = migrateSnapshot({
		enabled: true,
		state: { contract: {}, working: { invalid: null }, response: "old" },
	});
	assert.equal(result.config.enabled, false);
	assert.match(result.meta.validation?.error ?? "", /null data/);
});

test("migrates an active two-field snapshot by adding an empty response", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Continue",
			state: { contract: { goal: "keep" }, working: { phase: "active" } },
			step: 2,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	const result = commitTerminal(h, {}, {}, "Migrated.");
	assert.equal(result.message.content[0].text, "Migrated.");
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), {
		artifacts: {},
		contract: { goal: "keep" },
		working: { phase: "active" },
		response: "Migrated.",
	});
});
test("sanitizes malformed snapshot counters and validation feedback on restore", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Continue",
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.NaN,
			validation: { attempt: "many", error: 7, instruction: [] },
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Runtime metadata: step #0;[\s\S]*validation attempts 0/);

	h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, h.ctx);
	assert.equal(h.resolveSnapshot().meta.validation!.attempt, 1);
});
test("bounds restored counters before later increments", async () => {
	const malformed = harness();
	malformed.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.MAX_SAFE_INTEGER,
			validation: {
				attempt: Number.MAX_SAFE_INTEGER,
				error: "old",
				instruction: "old",
			},
		},
	});
	malformed.handlers.get("session_start")!({}, malformed.ctx);
	await malformed.commands.get("state-flow-status")!.handler("", malformed.ctx);
	assert.match(malformed.notifications.at(-1)!, /Runtime metadata: step #0;[\s\S]*validation attempts 0/);
	malformed.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<!-- state_flow invalid -->" }] },
	}, malformed.ctx);
	assert.equal(malformed.resolveSnapshot().meta.validation!.attempt, 1);

	const boundary = harness();
	boundary.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous" },
			step: Number.MAX_SAFE_INTEGER - 1,
		},
	});
	boundary.handlers.get("session_start")!({}, boundary.ctx);
	commitTerminal(boundary, {}, {}, "At boundary.");
	assert.equal(boundary.resolveSnapshot().meta.step, Number.MAX_SAFE_INTEGER);
	commitTerminal(boundary, {}, {}, "Past boundary.");
	assert.equal(boundary.resolveSnapshot().meta.step, Number.MAX_SAFE_INTEGER);
	assert.match(boundary.resolveSnapshot().meta.validation!.error, /iteration counter is exhausted/);
});
test("disables restoration of non-JSON materialized state", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: { score: Number.NaN }, response: "Previous" },
			step: 3,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /restored disabled: Restored state contains non-JSON data/);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /config\.enabled=false; config\.transitionWindow=7; branch mode=inactive/);
	assert.match(h.notifications.at(-1)!, /Runtime metadata: step #3/);
	assert.match(h.notifications.at(-1)!, /Materialized states: unavailable/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"response":/);
});
test("does not reinterpret a malformed materialized state as legacy working memory", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: {}, response: "Previous", unexpected: true },
			step: 2,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /invalid materialized-state schema/);
	assert.equal(h.statuses.at(-1), undefined);
});
