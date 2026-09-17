import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasLegacyStateSources, planLegacyStorageMigration } from "../lib/migration.ts";
import { cwdScopePaths, parseScopeStream, writeOwnedFileUpdates } from "../lib/durable.ts";
import { advanceTemporalState, createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";
import { createSessionRuntime, emptySnapshot, serializeSessionRuntime } from "../lib/snapshot.ts";

function fixture(t: { after: (callback: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, cwd: join(root, "project"), session: "test-session" };
}

test("only predecessor temporal envelopes activate migration detection", (t) => {
	const { root, cwd, session } = fixture(t);
	assert.equal(hasLegacyStateSources(cwd, session, root), false);
	writeFileSync(join(root, "state.json"), JSON.stringify(emptyState()));
	assert.equal(hasLegacyStateSources(cwd, session, root), false);
	const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin").scopes.global;
	writeFileSync(join(root, "checkpoint.json"), JSON.stringify(stream.checkpoint));
	writeFileSync(join(root, "patches.jsonl"), "");
	assert.equal(hasLegacyStateSources(cwd, session, root), true);
});

test("migration adds empty intents to 0.14 semantic checkpoints without inferring working fields", (t) => {
	const { root, cwd, session } = fixture(t);
	const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "0.14-origin").scopes.global;
	stream.checkpoint.state.working.next = "possible, not committed";
	const checkpoint = structuredClone(stream.checkpoint.state) as Record<string, unknown>;
	delete checkpoint.intents;
	writeFileSync(join(root, "checkpoint.json"), `${JSON.stringify(checkpoint)}\n`);
	writeFileSync(join(root, "patches.jsonl"), "");
	writeFileSync(join(root, "meta.json"), JSON.stringify({
		version: 1,
		artifacts: {},
		temporal: { checkpoint: stream.checkpoint.through, patches: [] },
	}));
	assert.equal(hasLegacyStateSources(cwd, session, root), true);
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual(plan.scopes, ["global"]);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	const migrated = JSON.parse(readFileSync(join(root, "checkpoint.json"), "utf8"));
	assert.deepEqual(migrated.intents, {});
	assert.equal(migrated.working.next, "possible, not committed");
	assert.equal(hasLegacyStateSources(cwd, session, root), false);
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("migration discovers 0.14 sessions through runtime identity and upgrades their intents", (t) => {
	const { root, cwd, session } = fixture(t);
	const cwdDirectory = cwdScopePaths(cwd, root).directory;
	const key = "2026-09-17T00-00-00-000Z_retained-session";
	const ownedSession = "retained-session";
	const directory = join(cwdDirectory, key);
	mkdirSync(directory, { recursive: true });
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "0.14-session-origin");
	const checkpoint = structuredClone(view.scopes.session.checkpoint.state) as Record<string, unknown>;
	delete checkpoint.intents;
	writeFileSync(join(directory, "checkpoint.json"), `${JSON.stringify(checkpoint)}\n`);
	writeFileSync(join(directory, "patches.jsonl"), "");
	writeFileSync(join(directory, "meta.json"), JSON.stringify({
		version: 1, artifacts: {}, temporal: { checkpoint: view.scopes.session.checkpoint.through, patches: [] },
	}));
	const runtime = createSessionRuntime(emptySnapshot(true), cwd, ownedSession, view.lineage, "unconfirmed");
	const serialized = serializeSessionRuntime(runtime, cwd, ownedSession);
	writeFileSync(join(directory, "config.json"), serialized.config);
	writeFileSync(join(directory, "runtime.json"), serialized.runtime);

	assert.equal(hasLegacyStateSources(cwd, session, root), true);
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.ok(plan.updates.some(({ path }) => path === join(directory, "checkpoint.json")));
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8")).intents, {});
});

test("migration converts complete temporal envelopes, preserves metadata, and is idempotent", (t) => {
	const { root, cwd, session } = fixture(t);
	let view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "legacy-origin");
	view = advanceTemporalState(view, [{ scope: "global", patch: { working: { patch: { nested: true }, transition: "semantic" } } }], "legacy-change");
	const stream = view.scopes.global;
	writeFileSync(join(root, "checkpoint.json"), `${JSON.stringify(stream.checkpoint)}\n`);
	writeFileSync(join(root, "patches.jsonl"), stream.patches.map((record) => `${JSON.stringify(record)}\n`).join(""));
	writeFileSync(join(root, "meta.json"), JSON.stringify({ version: 1, artifacts: {}, future: { retained: [1, 2] } }));
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual(plan.scopes, ["global"]);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "checkpoint.json"), "utf8")), stream.checkpoint.state);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "patches.jsonl"), "utf8")), stream.patches[0]!.patch);
	const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));
	assert.deepEqual(meta.future, { retained: [1, 2] });
	assert.deepEqual(meta.temporal, { checkpoint: stream.checkpoint.through, patches: stream.patches.map((record) => record.transition) });
	assert.deepEqual(parseScopeStream(readFileSync(join(root, "checkpoint.json"), "utf8"), readFileSync(join(root, "patches.jsonl"), "utf8"), "global", undefined, JSON.stringify(meta)), stream);
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("migration discovers every owner-proven predecessor session beneath the configured CWD", (t) => {
	const { root, cwd, session } = fixture(t);
	const otherCwd = join(root, "other-project");
	const otherCwdDirectory = cwdScopePaths(otherCwd, root).directory;
	const cwdStream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "other-cwd-origin").scopes.cwd;
	mkdirSync(otherCwdDirectory, { recursive: true });
	writeFileSync(join(otherCwdDirectory, "checkpoint.json"), `${JSON.stringify({ ...cwdStream.checkpoint, owner: { cwd: otherCwd } })}\n`);
	writeFileSync(join(otherCwdDirectory, "patches.jsonl"), "");
	writeFileSync(join(otherCwdDirectory, "meta.json"), JSON.stringify({ version: 1, artifacts: {} }));
	const historicalKey = "2026-09-11T01-16-49-474Z_historical-session";
	const directory = join(cwdScopePaths(cwd, root).directory, historicalKey);
	mkdirSync(directory, { recursive: true });
	const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "historical-origin").scopes.session;
	writeFileSync(join(directory, "checkpoint.json"), `${JSON.stringify(stream.checkpoint)}\n`);
	writeFileSync(join(directory, "patches.jsonl"), stream.patches.map((record) => `${JSON.stringify(record)}\n`).join(""));
	writeFileSync(join(directory, "config.json"), JSON.stringify({ enabled: true }));
	writeFileSync(join(directory, "meta.json"), JSON.stringify({
		version: 1,
		identity: { cwd, sessionId: "historical-session" },
		lineage: [stream.checkpoint.through],
		step: 1,
		revision: "self",
		publication: "unconfirmed",
		future: true,
	}));

	assert.equal(hasLegacyStateSources(cwd, session, root), true);
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual([...plan.scopes].sort(), ["cwd", "session"]);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	assert.deepEqual(JSON.parse(readFileSync(join(otherCwdDirectory, "checkpoint.json"), "utf8")), cwdStream.checkpoint.state);
	assert.deepEqual(JSON.parse(readFileSync(join(otherCwdDirectory, "meta.json"), "utf8")).owner, { cwd: otherCwd });
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8")), stream.checkpoint.state);
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")).temporal, {
		checkpoint: stream.checkpoint.through,
		patches: [],
	});
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("migration upgrades 0.13 combined session metadata across every owner-proven CWD in one cohort", (t) => {
	const { root, cwd, session } = fixture(t);
	const otherCwd = join(root, "other-project");
	for (const [ownedCwd, key, ownedSession] of [
		[cwd, session, session],
		[otherCwd, "2026-09-13T09-26-25-598Z_other-session", "other-session"],
	] as const) {
		const cwdDirectory = cwdScopePaths(ownedCwd, root).directory;
		const directory = join(cwdDirectory, key);
		mkdirSync(directory, { recursive: true });
		const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, `${ownedSession}-origin`).scopes.session;
		writeFileSync(join(cwdDirectory, "checkpoint.json"), `${JSON.stringify(stream.checkpoint.state)}\n`);
		writeFileSync(join(cwdDirectory, "patches.jsonl"), "");
		writeFileSync(join(cwdDirectory, "meta.json"), JSON.stringify({ owner: { cwd: ownedCwd }, temporal: { checkpoint: stream.checkpoint.through, patches: [] } }));
		writeFileSync(join(directory, "checkpoint.json"), `${JSON.stringify(stream.checkpoint.state)}\n`);
		writeFileSync(join(directory, "patches.jsonl"), "");
		writeFileSync(join(directory, "config.json"), `${JSON.stringify({ enabled: true })}\n`);
		writeFileSync(join(directory, "meta.json"), JSON.stringify({
			version: 1,
			temporal: { checkpoint: stream.checkpoint.through, patches: [] },
			identity: { cwd: ownedCwd, sessionId: ownedSession },
			lineage: [stream.checkpoint.through],
			step: 13,
			revision: "self",
			publication: "unconfirmed",
		}));
	}

	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.equal(plan.updates.filter(({ path }) => path.endsWith("runtime.json")).length, 2);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	for (const [ownedCwd, key] of [
		[cwd, session],
		[otherCwd, "2026-09-13T09-26-25-598Z_other-session"],
	] as const) {
		const directory = join(cwdScopePaths(ownedCwd, root).directory, key);
		assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")), "identity"), false);
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8")).identity.cwd, ownedCwd);
	}
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("migration upgrades 0.13 combined session metadata to the 0.14 meta/runtime contract", (t) => {
	const { root, cwd, session } = fixture(t);
	const directory = join(cwdScopePaths(cwd, root).directory, session);
	mkdirSync(directory, { recursive: true });
	const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "session-origin").scopes.session;
	writeFileSync(join(directory, "checkpoint.json"), `${JSON.stringify(stream.checkpoint.state)}\n`);
	writeFileSync(join(directory, "patches.jsonl"), "");
	writeFileSync(join(directory, "config.json"), `${JSON.stringify({ enabled: true })}\n`);
	writeFileSync(join(directory, "meta.json"), JSON.stringify({
		version: 1,
		artifacts: { "/source.md": { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "test-v1" } },
		temporal: { checkpoint: stream.checkpoint.through, patches: [] },
		identity: { cwd, sessionId: session },
		lineage: [stream.checkpoint.through],
		step: 13,
		specification: "unfinished request",
		revision: "self",
		temporalRevision: "self",
		publication: "unconfirmed",
		futureRuntime: "retained",
		futureScope: { retained: true },
	}));

	assert.equal(hasLegacyStateSources(cwd, session, root), true);
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual(plan.scopes, ["session"]);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
	assert.deepEqual(meta.temporal, { checkpoint: stream.checkpoint.through, patches: [] });
	assert.deepEqual(meta.futureScope, { retained: true });
	assert.ok(meta.artifacts["/source.md"]);
	for (const key of ["identity", "lineage", "step", "specification", "revision", "temporalRevision", "publication"]) {
		assert.equal(Object.hasOwn(meta, key), false);
	}
	const runtime = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8"));
	assert.deepEqual(runtime.identity, { cwd, sessionId: session });
	assert.deepEqual(runtime.lineage, [stream.checkpoint.through]);
	assert.equal(runtime.step, 13);
	assert.equal(runtime.specification, "unfinished request");
	assert.equal(runtime.futureRuntime, "retained");
	assert.equal(Object.hasOwn(runtime, "artifacts"), false);
	assert.equal(Object.hasOwn(runtime, "temporal"), false);
	assert.equal(hasLegacyStateSources(cwd, session, root), false);
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("partial or malformed predecessor envelopes fail before writes", (t) => {
	const { root, cwd, session } = fixture(t);
	writeFileSync(join(root, "patches.jsonl"), "{}\n");
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /no provable checkpoint/);
	rmSync(join(root, "patches.jsonl"));
	writeFileSync(join(root, "checkpoint.json"), "{}\n");
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /incomplete checkpoint\/tail/);
});

test("a stale envelope migration plan cannot overwrite concurrent bytes", (t) => {
	const { root, cwd, session } = fixture(t);
	const stream = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin").scopes.global;
	writeFileSync(join(root, "checkpoint.json"), JSON.stringify(stream.checkpoint));
	writeFileSync(join(root, "patches.jsonl"), "");
	const plan = planLegacyStorageMigration(cwd, session, root);
	writeFileSync(join(root, "checkpoint.json"), "concurrent");
	assert.throws(() => writeOwnedFileUpdates(plan.updates, plan.bases, root), /conflict/);
	assert.equal(readFileSync(join(root, "checkpoint.json"), "utf8"), "concurrent");
});
