import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hasLegacyStateSources, planLegacyStorageMigration } from "../lib/migration.ts";
import { cwdScopePaths, parseScopeStream, sessionScopePaths, writeOwnedFileUpdates } from "../lib/durable.ts";
import { emptyState } from "../lib/state.ts";

function fixture(t: { after: (callback: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, cwd: join(root, "project"), session: "test-session" };
}

test("canonical initialization skips full migration planning unless a predecessor snapshot name exists", (t) => {
	const { root, cwd, session } = fixture(t);
	assert.equal(hasLegacyStateSources(cwd, session, root), false);
	const cwdState = cwdScopePaths(cwd, root).state;
	mkdirSync(dirname(cwdState), { recursive: true });
	writeFileSync(cwdState, JSON.stringify(emptyState()));
	assert.equal(hasLegacyStateSources(cwd, session, root), true);
	rmSync(cwdState);
	const sessionState = sessionScopePaths(cwd, session, root).state;
	mkdirSync(dirname(sessionState), { recursive: true });
	writeFileSync(sessionState, JSON.stringify(emptyState()));
	assert.equal(hasLegacyStateSources(cwd, session, root), true);
});

test("migration anchors exact current materializations and never replays explanatory journals", (t) => {
	const { root, cwd, session } = fixture(t);
	const directories = [root, cwdScopePaths(cwd, root).directory, sessionScopePaths(cwd, session, root).directory];
	const states = directories.map((_, index) => ({ ...emptyState(), working: { counter: index + 10, nested: { keep: [1, 2] } } }));
	for (const [index, directory] of directories.entries()) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "state.json"), JSON.stringify(states[index]));
		writeFileSync(join(directory, "patches.jsonl"), index === 0 ? "malformed explanatory history" : JSON.stringify({ working: { counter: -99 } }));
	}
	const plan = planLegacyStorageMigration(cwd, session, root, "proven-base");
	assert.deepEqual(plan.scopes, ["global", "cwd", "session"]);
	assert.equal(plan.updates.length, 9);
	for (const directory of directories) assert.equal(existsSync(join(directory, "checkpoint.json")), false);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	for (const [index, scope] of (["global", "cwd", "session"] as const).entries()) {
		const directory = directories[index]!;
		const stream = parseScopeStream(readFileSync(join(directory, "checkpoint.json"), "utf8"), readFileSync(join(directory, "patches.jsonl"), "utf8"), scope)!;
		assert.deepEqual(stream.checkpoint.state, states[index]);
		assert.deepEqual(stream.checkpoint.through, { id: "proven-base", position: 0, parent: null });
		assert.deepEqual(stream.patches, []);
		assert.equal(existsSync(join(directory, "state.json")), false);
	}
	assert.deepEqual(planLegacyStorageMigration(cwd, session, root).updates, []);
});

test("migration preserves a provable current snapshot even with missing explanatory history", (t) => {
	const { root, cwd, session } = fixture(t);
	writeFileSync(join(root, "state.json"), JSON.stringify({ ...emptyState(), working: { verified: true } }));
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual(plan.scopes, ["global"]);
	writeOwnedFileUpdates(plan.updates, plan.bases, root);
	assert.equal(readFileSync(join(root, "patches.jsonl"), "utf8"), "");
});

test("migration rejects ambiguous, orphaned, incomplete, invalid, or symlinked input without writes", (t) => {
	const { root, cwd, session } = fixture(t);
	const legacy = join(root, "state.json");
	const checkpoint = join(root, "checkpoint.json");
	const patches = join(root, "patches.jsonl");
	writeFileSync(legacy, JSON.stringify(emptyState()));
	writeFileSync(checkpoint, "{}");
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /both current and checkpoint/);
	rmSync(legacy);
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /incomplete checkpoint\/tail/);
	rmSync(checkpoint);
	writeFileSync(patches, "unproven journal");
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /no provable snapshot/);
	writeFileSync(legacy, JSON.stringify({ ...emptyState(), working: { invalid: null } }));
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /invalid materialized state/);
	rmSync(legacy);
	const outside = join(root, "unrelated.json");
	writeFileSync(outside, JSON.stringify(emptyState()));
	symlinkSync(outside, legacy);
	assert.throws(() => planLegacyStorageMigration(cwd, session, root), /not a regular file/);
	assert.equal(existsSync(checkpoint), false);
	assert.equal(readFileSync(outside, "utf8"), JSON.stringify(emptyState()));
});

test("a stale migration plan cannot overwrite concurrent bytes and cleans prepared files", (t) => {
	const { root, cwd, session } = fixture(t);
	const legacy = join(root, "state.json");
	writeFileSync(legacy, JSON.stringify(emptyState()));
	const plan = planLegacyStorageMigration(cwd, session, root);
	const concurrent = JSON.stringify({ ...emptyState(), working: { otherWriter: true } });
	writeFileSync(legacy, concurrent);
	assert.throws(() => writeOwnedFileUpdates(plan.updates, plan.bases, root), /conflict/);
	assert.equal(readFileSync(legacy, "utf8"), concurrent);
	assert.equal(existsSync(join(root, "checkpoint.json")), false);
	assert.equal(existsSync(join(root, "patches.jsonl")), false);
});

test("migration does not admit another session or arbitrary repository files", (t) => {
	const { root, cwd, session } = fixture(t);
	const other = sessionScopePaths(cwd, "other-session", root).state;
	mkdirSync(dirname(other), { recursive: true });
	writeFileSync(other, JSON.stringify(emptyState()));
	writeFileSync(join(root, "notes.md"), "Independent Knowledge");
	const plan = planLegacyStorageMigration(cwd, session, root);
	assert.deepEqual(plan.updates, []);
	assert.equal(plan.bases.some(({ path }) => path === other), false);
	assert.throws(() => writeOwnedFileUpdates([{ path: join(root, "notes.md") }], [], root), /non-State Flow path/);
	assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "Independent Knowledge");
});

test("migration detects edits after preparation without deleting concurrent state or corrupting rollback bytes", (t) => {
	const { root, cwd, session } = fixture(t);
	const legacy = join(root, "state.json");
	const checkpoint = join(root, "checkpoint.json");
	const patches = join(root, "patches.jsonl");
	const oldJournal = Buffer.from([0xff, 0xfe, 0x0a]);
	writeFileSync(legacy, JSON.stringify(emptyState()));
	writeFileSync(patches, oldJournal);
	const plan = planLegacyStorageMigration(cwd, session, root);
	const concurrent = JSON.stringify({ ...emptyState(), working: { concurrent: true } });
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		if (!injected && to === checkpoint) {
			injected = true;
			writeFileSync(legacy, concurrent);
		}
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeOwnedFileUpdates(plan.updates, plan.bases, root), /file conflict/);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.equal(readFileSync(legacy, "utf8"), concurrent);
	assert.deepEqual(readFileSync(patches), oldJournal);
	assert.equal(existsSync(checkpoint), false);
});

test("rollback preserves a concurrently replaced published file and reports the unresolved conflict", (t) => {
	const { root, cwd, session } = fixture(t);
	const legacy = join(root, "state.json");
	const checkpoint = join(root, "checkpoint.json");
	writeFileSync(legacy, JSON.stringify(emptyState()));
	const plan = planLegacyStorageMigration(cwd, session, root);
	const rename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		rename(from, to);
		if (!injected && to === checkpoint) {
			injected = true;
			writeFileSync(legacy, "concurrent legacy bytes");
			writeFileSync(checkpoint, "concurrent checkpoint bytes");
		}
	};
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeOwnedFileUpdates(plan.updates, plan.bases, root), /publication and rollback failed/);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.equal(readFileSync(legacy, "utf8"), "concurrent legacy bytes");
	assert.equal(readFileSync(checkpoint, "utf8"), "concurrent checkpoint bytes");
});
