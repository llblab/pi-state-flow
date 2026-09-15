import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasLegacyStateSources, planLegacyStorageMigration } from "../lib/migration.ts";
import { cwdScopePaths, parseScopeStream, writeOwnedFileUpdates } from "../lib/durable.ts";
import { advanceTemporalState, createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";

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
	writeFileSync(join(directory, "meta.json"), JSON.stringify({ version: 1, identity: { cwd, sessionId: "historical-session" }, future: true }));

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
