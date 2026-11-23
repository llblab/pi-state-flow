import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { HealNotice, healSelectedStore, isHealableCorruption } from "../lib/healing.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import { RevisionUnavailableError, UnsupportedLifecycleFormatError } from "../lib/snapshot.ts";
import { PublicationBusyError, withStorageTransaction } from "../lib/storage.ts";
import { fixture } from "./current-fixture.ts";

const ALL = ["global", "cwd", "session"] as const;

function scopeFiles(f: Awaited<ReturnType<typeof fixture>>, scope: (typeof ALL)[number]): string[] {
	const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
	const files = [paths.checkpoint, paths.patches, paths.meta];
	if (scope !== "session") return files;
	const runtime = sessionRuntimePaths(f.cwd, f.id, f.root);
	return [...files, runtime.config, runtime.runtime];
}

function snapshotFiles(paths: readonly string[]): Map<string, Buffer | undefined> {
	return new Map(paths.map(path => [path, existsSync(path) ? readFileSync(path) : undefined]));
}

function quarantineDirectory(root: string): string {
	return resolve(dirname(root), "store-quarantine");
}

function heal(f: Awaited<ReturnType<typeof fixture>>, selection: ScopeSelection = ALL, signal?: AbortSignal) {
	return healSelectedStore({ cwd: f.cwd, sessionId: f.id, sessionKey: f.id, selection, historyLimit: 7, root: f.root,
		now: () => new Date("2026-01-02T03:04:05.678Z") }, signal);
}

test("a healthy selected store is observed without writes or quarantine", async t => {
	const f = await fixture(t);
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const result = await heal(f);
	assert.deepEqual(result, { healed: [], lifecycleAbsent: false });
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
	assert.equal(existsSync(quarantineDirectory(f.root)), false);
});

test("each unreadable owner alone is quarantined byte-exactly and becomes wholly absent", async t => {
	for (const scope of ALL) for (const damage of ["malformed", "incomplete"] as const) {
		const f = await fixture(t);
		const target = temporalScopePaths(f.cwd, f.id, scope, f.root);
		if (damage === "malformed") writeFileSync(target.checkpoint, "{not json");
		else unlinkSync(target.patches);
		const damaged = snapshotFiles(scopeFiles(f, scope));
		const others = snapshotFiles(ALL.filter(owner => owner !== scope).flatMap(owner => scopeFiles(f, owner)).filter(path => !scopeFiles(f, scope).includes(path)));
		const result = await heal(f);
		assert.deepEqual(result.healed.map(item => item.scope), [scope], `${scope}/${damage}`);
		assert.equal(result.lifecycleAbsent, scope === "session");
		for (const path of scopeFiles(f, scope)) assert.equal(existsSync(path), false, `${path} must be removed after quarantine`);
		assert.deepEqual(snapshotFiles([...others.keys()]), others, "healthy owners stay byte-identical");
		const record = JSON.parse(readFileSync(result.healed[0]!.quarantine, "utf8"));
		assert.equal(record.kind, "state-flow-quarantine");
		assert.equal(record.scope, scope);
		const restored = new Map<string, Buffer>(record.files.map((file: { path: string; bytes: string }) => [resolve(f.root, file.path), Buffer.from(file.bytes, "base64")]));
		for (const [path, bytes] of damaged) assert.deepEqual(restored.get(path), bytes, `quarantine keeps ${path}`);
		assert.equal(readdirSync(quarantineDirectory(f.root)).length, 1);
		assert.deepEqual(await heal(f), { healed: [], lifecycleAbsent: scope === "session" }, "healing converges after one pass");
		// Reset shared owners are empty current reality for the retained session lifecycle.
		if (scope !== "session") await f.refresh([...ALL]);
	}
});

test("a cross-owner contradiction resets the private lifecycle anchor, not healthy shared memory", async t => {
	const f = await fixture(t);
	const runtime = sessionRuntimePaths(f.cwd, f.id, f.root);
	const value = JSON.parse(readFileSync(runtime.runtime, "utf8"));
	// Internally valid lifecycle whose lineage no longer matches the owners' accepted transitions.
	assert.equal(value.format, "baseline");
	value.lineage[1].id = "forged";
	writeFileSync(runtime.runtime, JSON.stringify(value));
	const shared = snapshotFiles(["global", "cwd"].flatMap(scope => scopeFiles(f, scope as "global" | "cwd")));
	const result = await heal(f);
	assert.deepEqual(result.healed.map(item => item.scope), ["session"]);
	assert.equal(result.lifecycleAbsent, true);
	assert.deepEqual(snapshotFiles([...shared.keys()]), shared);
});

test("unhealable failures, cancellation and live writers never quarantine", async t => {
	const f = await fixture(t);
	const cwdPaths = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	const meta = JSON.parse(readFileSync(cwdPaths.meta, "utf8"));
	writeFileSync(cwdPaths.meta, JSON.stringify({ ...meta, owner: { ...meta.owner, cwd: "/foreign/project" } }));
	const foreign = snapshotFiles(scopeFiles(f, "cwd"));
	await assert.rejects(heal(f), /identity mismatch/);
	assert.deepEqual(snapshotFiles([...foreign.keys()]), foreign, "foreign-owner data is never reset");
	writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).checkpoint, "{not json");
	const reason = new Error("cancelled");
	await assert.rejects(heal(f, ["global"], AbortSignal.abort(reason)), error => error === reason);
	let release!: () => void;
	const gate = new Promise<void>(done => { release = done; });
	let entered!: () => void;
	const held = new Promise<void>(done => { entered = done; });
	const holder = withStorageTransaction(f.root, async () => { entered(); await gate; });
	await held;
	await assert.rejects(heal(f, ["global"]), PublicationBusyError);
	release(); await holder;
	assert.equal(existsSync(quarantineDirectory(f.root)), false);
	assert.deepEqual((await heal(f, ["global"])).healed.map(item => item.scope), ["global"]);
});

test("retired and unrecognized lifecycle formats stop healing before any owner is touched", async t => {
	for (const runtimeHeader of [{ version: 1 }, { format: "future" }, { format: "baseline", version: 2 }]) for (const config of ["absent", "invalid UTF-8"]) {
		const f = await fixture(t);
		const life = sessionRuntimePaths(f.cwd, f.id, f.root);
		if (config === "absent") unlinkSync(life.config);
		else writeFileSync(life.config, Buffer.from([0xff, 0xfe]));
		writeFileSync(life.runtime, JSON.stringify(runtimeHeader));
		writeFileSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint, "corrupt but not authorized for healing");
		const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
		await assert.rejects(heal(f), UnsupportedLifecycleFormatError);
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
		assert.equal(existsSync(quarantineDirectory(f.root)), false);
		assert.equal(existsSync(`${f.root}-migration-backups`), false);
	}
});

test("only semantic decode failures classify as healable corruption", () => {
	assert.equal(isHealableCorruption(new Error("State Flow global checkpoint contains invalid JSON")), true);
	assert.equal(isHealableCorruption(Object.assign(new Error("EACCES"), { code: "EACCES" })), false);
	assert.equal(isHealableCorruption(new RevisionUnavailableError("lock")), false);
	assert.equal(isHealableCorruption(new PublicationBusyError("/lock")), false);
	assert.equal(isHealableCorruption(new DOMException("aborted", "AbortError")), false);
	assert.equal(isHealableCorruption(new Error("State Flow CWD migration identity mismatch")), false);
	assert.equal(isHealableCorruption("not an error"), false);
	assert.equal(isHealableCorruption(new AggregateError([new Error("bad json"), Object.assign(new Error("EIO"), { code: "EIO" })])), false);
});

test("a reset notice reaches the model until a run that saw it settles", () => {
	const notice = new HealNotice();
	notice.settle();
	assert.equal(notice.project(), undefined);
	notice.announce("State Flow self-healed: session reset");
	notice.settle();
	assert.match(notice.project()!, /session reset\. Tell the user/);
	assert.match(notice.project()!, /session reset/);
	notice.settle();
	assert.equal(notice.project(), undefined);
});

test("an absent store needs no healing and reports no lifecycle", async t => {
	const f = await fixture(t);
	const missing = join(f.root, "..", "missing-store");
	assert.deepEqual(await healSelectedStore({ cwd: f.cwd, sessionId: f.id, sessionKey: f.id, selection: [...ALL], historyLimit: 7, root: missing }),
		{ healed: [], lifecycleAbsent: true });
	assert.equal(existsSync(missing), false);
});
