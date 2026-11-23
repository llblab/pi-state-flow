import assert from "node:assert/strict";
import fs, { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { HealExecutionError, healSelectedStore, recoveryIncidentText } from "../lib/healing.ts";
import { nativeDecoderCause } from "../lib/json.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import { UnsupportedLifecycleFormatError } from "../lib/snapshot.ts";
import { PublicationBusyError, withStorageTransaction } from "../lib/storage.ts";
import { readTemporalView } from "../lib/temporal.ts";
import { fixture, selections } from "./current-fixture.ts";

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

const fixedDate = () => new Date("2026-01-02T03:04:05.678Z");
function heal(f: Awaited<ReturnType<typeof fixture>>, selection: ScopeSelection = ALL, signal?: AbortSignal, now = fixedDate, historyLimit = 7, assertCurrent?: () => void) {
	return healSelectedStore({ cwd: f.cwd, sessionId: f.id, sessionKey: f.id, selection, historyLimit, root: f.root, now, assertCurrent }, signal);
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
	for (const scope of ALL) for (const damage of ["malformed JSON", "malformed UTF-8", "incomplete"] as const) {
		const f = await fixture(t);
		const target = temporalScopePaths(f.cwd, f.id, scope, f.root);
		if (damage === "malformed JSON") writeFileSync(target.checkpoint, "{not json");
		else if (damage === "malformed UTF-8") writeFileSync(target.checkpoint, Buffer.from([0xff, 0xfe]));
		else unlinkSync(target.patches);
		const damaged = snapshotFiles(scopeFiles(f, scope));
		const others = snapshotFiles(ALL.filter(owner => owner !== scope).flatMap(owner => scopeFiles(f, owner)).filter(path => !scopeFiles(f, scope).includes(path)));
		const result = await heal(f);
		assert.deepEqual(result.healed.map(item => item.scope), [scope], `${scope}/${damage}`);
		assert.equal(result.lifecycleAbsent, scope === "session");
		if (damage === "malformed JSON") assert.ok(nativeDecoderCause(result.healed[0]!.cause) instanceof SyntaxError);
		if (damage === "malformed UTF-8") assert.equal((nativeDecoderCause(result.healed[0]!.cause) as NodeJS.ErrnoException).code, "ERR_ENCODING_INVALID_ENCODED_DATA");
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

test("a proven private contradiction is independent of damage in a selected shared owner", async t => {
	const f = await fixture(t);
	const runtime = sessionRuntimePaths(f.cwd, f.id, f.root);
	const value = JSON.parse(readFileSync(runtime.runtime, "utf8"));
	value.lineage[1].id = "forged";
	writeFileSync(runtime.runtime, JSON.stringify(value));
	writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).checkpoint, "{corrupt");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const result = await heal(f);
	assert.deepEqual(result.healed.map(item => item.scope).sort(), ["global", "session"]);
	assert.equal(result.lifecycleAbsent, true);
	for (const item of result.healed) {
		const paths = scopeFiles(f, item.scope);
		assertQuarantine(f.root, item.quarantine, before, paths);
		for (const path of paths) before.set(path, undefined);
	}
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
});

test("unhealable failures, cancellation and live writers never quarantine", async t => {
	const f = await fixture(t);
	const cwdPaths = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	const meta = JSON.parse(readFileSync(cwdPaths.meta, "utf8"));
	writeFileSync(cwdPaths.meta, JSON.stringify({ ...meta, owner: { ...meta.owner, cwd: "/foreign/project" } }));
	writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).checkpoint, "{not json");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	await assert.rejects(heal(f), /identity mismatch/);
	assert.deepEqual(snapshotFiles([...before.keys()]), before, "later foreign identity prevents the earlier Global reset");
	assert.equal(existsSync(quarantineDirectory(f.root)), false);
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

test("unexpected and aggregate failures during stored decoding cannot reset an earlier corrupt owner", async t => {
	const f = await fixture(t);
	const marker = '"fault-injected-in-cwd"';
	writeFileSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint, marker);
	writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).checkpoint, "{not json");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const parse = JSON.parse;
	for (const error of [new Error("invalid JSON"), new TypeError("unexpected"), new RangeError("unexpected"), "invalid JSON",
		{ name: "InvalidStateFlowData", code: "ERR_ENCODING_INVALID_ENCODED_DATA", message: "invalid JSON" },
		new AggregateError([]), new AggregateError([new AggregateError([])]), new AggregateError([new SyntaxError("bad JSON"), new TypeError("bug")])]) {
		const spy = t.mock.method(JSON, "parse", (source: string) => { if (source === marker) throw error; return parse(source); });
		try { await assert.rejects(heal(f), cause => cause === error); }
		finally { spy.mock.restore(); }
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
		assert.equal(existsSync(quarantineDirectory(f.root)), false);
	}
	await assert.rejects(heal(f, ALL, undefined, fixedDate, -1), /history limit/);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
	assert.equal(existsSync(quarantineDirectory(f.root)), false);
});

test("later-owner I/O failure or cancellation in preflight leaves every owner untouched", async t => {
	for (const fault of ["io", "cancel"] as const) {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		writeFileSync(global.checkpoint, "{corrupt");
		const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
		const failure = Object.assign(new Error(fault), fault === "io" ? { code: "EIO" } : {});
		const operation = new AbortController();
		const open = fs.openSync;
		const spy = t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
			if (args[0] === cwd.checkpoint) {
				if (fault === "io") throw failure;
				operation.abort(failure);
			}
			return open(...args);
		});
		syncBuiltinESMExports();
		try { await assert.rejects(heal(f, ALL, operation.signal), cause => cause === failure); }
		finally { spy.mock.restore(); syncBuiltinESMExports(); }
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
		assert.equal(existsSync(quarantineDirectory(f.root)), false);
	}
});

test("retired, future and mixed semantic headers refuse before decoding any selected body", async t => {
	const f = await fixture(t);
	const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
	const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	const cwdMeta = JSON.parse(readFileSync(cwd.meta, "utf8"));
	const marker = '"must-not-decode-global"';
	writeFileSync(global.checkpoint, marker);
	unlinkSync(cwd.checkpoint);
	writeFileSync(cwd.patches, Buffer.from([0xff]));
	for (const update of [{ version: 99 }, { version: 1 }, { version: 2 }, { version: 3, modules: {} }]) {
		writeFileSync(cwd.meta, JSON.stringify({ ...cwdMeta, ...update }));
		const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
		const parse = JSON.parse;
		const spy = t.mock.method(JSON, "parse", (source: string) => {
			assert.notEqual(source, marker);
			return parse(source);
		});
		try { await assert.rejects(heal(f), /Unsupported State Flow .*metadata version|modules metadata collision/); }
		finally { spy.mock.restore(); }
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
		assert.equal(existsSync(quarantineDirectory(f.root)), false);
	}
});

test("unsupported Global metadata never enters quarantine even when its bodies are damaged", async t => {
	const f = await fixture(t);
	const paths = temporalScopePaths(f.cwd, f.id, "global", f.root);
	writeFileSync(paths.meta, JSON.stringify({ ...JSON.parse(readFileSync(paths.meta, "utf8")), version: 99 }));
	writeFileSync(paths.checkpoint, Buffer.from([0xff, 0xfe]));
	unlinkSync(paths.patches);
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	await assert.rejects(heal(f), /Unsupported State Flow global metadata version/);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
	assert.equal(existsSync(quarantineDirectory(f.root)), false);
});

test("a damaged or missing header cannot prove the supported owner to reset", async t => {
	const f = await fixture(t);
	for (const header of [f.runtimePaths.runtime, ...ALL.map(scope => temporalScopePaths(f.cwd, f.id, scope, f.root).meta)]) {
		const original = readFileSync(header);
		for (const damage of [undefined, Buffer.from("{bad JSON"), Buffer.from([0xff])]) {
			if (damage) writeFileSync(header, damage); else unlinkSync(header);
			const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
			await assert.rejects(heal(f), /cannot prove/);
			assert.deepEqual(snapshotFiles([...before.keys()]), before);
			assert.equal(existsSync(quarantineDirectory(f.root)), false);
			writeFileSync(header, original);
		}
	}
});

test("positively identified stored replay and module descriptor damage are reset only for selected owners", async t => {
	for (const selection of selections) {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		writeFileSync(global.patches, '{"strategy":{"sequence":{"[2]":true}}}\n');
		writeFileSync(global.checkpoint, '{"strategy":{"sequence":[1]}}\n');
		const meta = JSON.parse(readFileSync(cwd.meta, "utf8"));
		writeFileSync(cwd.meta, JSON.stringify({ ...meta, version: 4, modules: { x_bad: { invalid: true } } }));
		const excludedOrHealthy = ALL.filter(scope => scope === "session" || !selection.includes(scope)).flatMap(scope => scopeFiles(f, scope));
		const before = snapshotFiles(excludedOrHealthy);
		const result = await heal(f, selection);
		assert.deepEqual(result.healed.map(item => item.scope), selection.filter(scope => scope !== "session"));
		assert.deepEqual(snapshotFiles(excludedOrHealthy), before);
		for (const item of result.healed) assert.equal(scopeFiles(f, item.scope as (typeof ALL)[number]).some(existsSync), false);
	}
});

test("mixed v3/v4 recovery preserves independently owned opaque module state without a definition", async t => {
	const f = await fixture(t);
	await f.refresh(ALL, 7, f.owner);
	const descriptor = { x_acme_archive: { schemaVersion: 2, immutable: true } };
	const opaque = { nested: {}, slots: [{}, [false]], text: "opaque" };
	await f.owner.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot,
		{ id: "opaque-module", transitions: [{ scope: "global", patch: { x_acme_archive: opaque } }] },
		undefined, { global: descriptor }), () => {});
	await f.owner.withSelectedPatchTransaction(tx => tx.publish(tx.snapshot,
		{ id: "opaque-successor", transitions: [{ scope: "global", patch: { x_acme_archive: { text: "updated" } } }] }), () => {});
	const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
	const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	assert.equal(JSON.parse(readFileSync(global.meta, "utf8")).version, 4);
	assert.equal(JSON.parse(readFileSync(cwd.meta, "utf8")).version, 3);
	assert.deepEqual(f.owner.readView(1, "global").x_acme_archive, opaque);
	const opaqueFiles = snapshotFiles(scopeFiles(f, "global"));
	const healthy = new Map([...opaqueFiles, ...snapshotFiles(scopeFiles(f, "session"))]);
	writeFileSync(cwd.checkpoint, Buffer.from([0xff]));
	const damage = snapshotFiles(scopeFiles(f, "cwd"));
	const result = await heal(f);
	assert.deepEqual(result.healed.map(item => item.scope), ["cwd"]);
	assertQuarantine(f.root, result.healed[0]!.quarantine, damage, scopeFiles(f, "cwd"));
	assert.deepEqual(snapshotFiles([...healthy.keys()]), healthy);
	const { cohort } = await f.refresh(ALL);
	assert.deepEqual(cohort.view.scopes.global!.modules, descriptor);
	assert.deepEqual(readTemporalView(cohort.view, 0, "global").x_acme_archive, { ...opaque, text: "updated" });
	assert.throws(() => readTemporalView(cohort.view, 1, "global"), /predates the proven temporal origin/);
	assert.deepEqual(snapshotFiles([...opaqueFiles.keys()]), opaqueFiles, "a fresh composed origin keeps the healthy owner's file bytes");
});

test("unsafe ancestor or nonregular paths and reserved predecessors cannot reset any selected owner", async t => {
	for (const fault of ["ancestor symlink", "final symlink", "nonregular", "predecessor"] as const) {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		writeFileSync(global.checkpoint, "{corrupt");
		const original = renameForFault(f, cwd, fault);
		const before = snapshotFiles([...scopeFiles(f, "global"), ...original]);
		await assert.rejects(heal(f), /not a regular|Unsupported State Flow recovery layout/);
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
		assert.equal(existsSync(quarantineDirectory(f.root)), false);
	}
});

function renameForFault(f: Awaited<ReturnType<typeof fixture>>, cwd: ReturnType<typeof temporalScopePaths>, fault: string): string[] {
	if (fault === "predecessor") {
		const predecessor = join(cwd.directory, "state.json");
		writeFileSync(predecessor, "predecessor bytes");
		return [...scopeFiles(f, "cwd"), predecessor];
	}
	const scope = [...scopeFiles(f, "cwd"), ...scopeFiles(f, "session")];
	const foreign = join(f.root, "..", "foreign");
	if (fault === "ancestor symlink") {
		renameSync(cwd.directory, foreign);
		symlinkSync(foreign, cwd.directory);
		return scope.map(path => `${foreign}${path.slice(cwd.directory.length)}`);
	}
	renameSync(cwd.checkpoint, foreign);
	if (fault === "final symlink") symlinkSync(foreign, cwd.checkpoint);
	else mkdirSync(cwd.checkpoint);
	return scope.map(path => path === cwd.checkpoint ? foreign : path);
}

test("recovery detects changed bytes and appearance of an absent dependency instead of recapturing", async t => {
	for (const mutation of ["replacement", "appearance"] as const) {
		const f = await fixture(t);
		const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		const changed = mutation === "replacement" ? cwd.checkpoint : cwd.patches;
		if (mutation === "replacement") writeFileSync(changed, "{corrupt"); else unlinkSync(changed);
		const retained = ALL.flatMap(scope => scopeFiles(f, scope)).filter(path => path !== changed);
		const before = snapshotFiles(retained);
		await assert.rejects(heal(f, ALL, undefined, () => { writeFileSync(changed, "newer bytes"); return fixedDate(); }), (error: unknown) => {
			assert.ok(error instanceof HealExecutionError);
			assert.equal(error.outcome.effect, "none");
			assert.match(error.message, /conflict|changed concurrently/);
			return true;
		});
		assert.equal(readFileSync(changed, "utf8"), "newer bytes");
		assert.deepEqual(snapshotFiles(retained), before);
	}
});

test("matching quarantine content does not make a nonprivate record acceptable", async t => {
	const f = await fixture(t);
	const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
	writeFileSync(global.checkpoint, "{corrupt");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const first = await heal(f);
	const path = first.healed[0]!.quarantine;
	chmodSync(path, 0o644);
	for (const [file, bytes] of before) if (bytes) writeFileSync(file, bytes);
	await assert.rejects(heal(f), /quarantine record is unsafe/);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
});

test("equal bytes in a replacement directory do not make the captured recovery plan current", async t => {
	const f = await fixture(t);
	const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	const original = join(f.root, "..", "detached-cwd");
	writeFileSync(cwd.checkpoint, "{corrupt");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	await assert.rejects(heal(f, ALL, undefined, () => { renameSync(cwd.directory, original); cpSync(original, cwd.directory, { recursive: true }); return fixedDate(); }),
		/directory identity changed/);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
	assert.equal(readFileSync(join(original, "checkpoint.json"), "utf8"), "{corrupt");
});

async function withRemovalSpy(t: TestContext, remove: (path: string, perform: () => void) => void, run: () => Promise<void>) {
	const rm = fs.rmSync;
	const spy = t.mock.method(fs, "rmSync", (...args: Parameters<typeof rm>) => remove(String(args[0]), () => rm(...args)));
	syncBuiltinESMExports();
	try { await run(); } finally { spy.mock.restore(); syncBuiltinESMExports(); }
}

function assertQuarantine(root: string, path: string, before: ReadonlyMap<string, Buffer | undefined>, files: readonly string[]) {
	const record = JSON.parse(readFileSync(path, "utf8"));
	const captured = new Map<string, Buffer>(record.files.map((file: { path: string; bytes: string }) => [resolve(root, file.path), Buffer.from(file.bytes, "base64")]));
	assert.deepEqual(captured, new Map(files.flatMap(file => before.get(file) === undefined ? [] : [[file, before.get(file)!]])));
}

test("first, middle and last removal failures leave both owners byte-exact and report the filesystem effect", async t => {
	for (const failAt of [1, 2, 6]) {
		const f = await fixture(t);
		const canonical = ALL.flatMap(scope => scopeFiles(f, scope));
		const removed = new Set([...scopeFiles(f, "global"), ...scopeFiles(f, "cwd")]);
		writeFileSync(temporalScopePaths(f.cwd, f.id, "global", f.root).checkpoint, Buffer.from([0xff, 0x00, 0xfe]));
		writeFileSync(temporalScopePaths(f.cwd, f.id, "cwd", f.root).checkpoint, "{corrupt");
		const before = snapshotFiles(canonical);
		const fault = Object.assign(new Error("injected canonical removal failure"), { code: "EIO" });
		let count = 0;
		await withRemovalSpy(t, (path, perform) => {
			if (removed.has(path) && ++count === failAt) throw fault;
			perform();
		}, async () => {
			await assert.rejects(heal(f), (error: unknown) => {
				assert.ok(error instanceof HealExecutionError);
				const outcome = error.outcome;
				assert.equal(outcome.effect, failAt === 1 ? "none" : "restored");
				assert.ok(outcome.effect === "none" || outcome.effect === "restored");
				assert.deepEqual(outcome.evidence.map(item => item.scope), ["global", "cwd"]);
				for (const item of outcome.evidence) assertQuarantine(f.root, item.quarantine, before, scopeFiles(f, item.scope));
				if (failAt === 1) assert.equal(error.cause, fault);
				else { assert.ok(error.cause instanceof AggregateError); assert.equal(error.cause.errors[0], fault); }
				return true;
			});
		});
		assert.equal(count, failAt);
		assert.deepEqual(snapshotFiles(canonical), before);
	}
});

test("a foreign replacement during rollback survives, and the rest of the provisional set is restored", async t => {
	const f = await fixture(t);
	const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
	const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
	writeFileSync(global.checkpoint, Buffer.from([0xff, 0xfe]));
	writeFileSync(cwd.checkpoint, "{corrupt");
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const peer = Buffer.from("foreign replacement");
	await withRemovalSpy(t, (path, perform) => {
		if (path === cwd.patches) {
			writeFileSync(global.checkpoint, peer);
			throw Object.assign(new Error("injected removal fault"), { code: "EIO" });
		}
		perform();
	}, async () => {
		await assert.rejects(heal(f), (error: unknown) => {
			assert.ok(error instanceof HealExecutionError);
			assert.equal(error.outcome.effect, "incomplete");
			assert.deepEqual(error.outcome.unresolved, [{ scope: "global", paths: [global.checkpoint] }]);
			for (const item of error.outcome.evidence) assertQuarantine(f.root, item.quarantine, before, scopeFiles(f, item.scope));
			return true;
		});
	});
	before.set(global.checkpoint, peer);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
});

test("a previously absent file appearing during removal prevents finality and survives rollback", async t => {
	const f = await fixture(t);
	const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
	unlinkSync(global.patches);
	const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
	const peer = Buffer.from("appeared while other paths were removed");
	await withRemovalSpy(t, (path, perform) => {
		perform();
		if (path === global.checkpoint) writeFileSync(global.patches, peer);
	}, async () => {
		await assert.rejects(heal(f), (error: unknown) => {
			assert.ok(error instanceof HealExecutionError);
			assert.equal(error.outcome.effect, "restored");
			assertQuarantine(f.root, error.outcome.evidence[0]!.quarantine, before, scopeFiles(f, "global"));
			return true;
		});
	});
	before.set(global.patches, peer);
	assert.deepEqual(snapshotFiles([...before.keys()]), before);
});

test("stale operation or unverifiable quarantine withholds all canonical removals", async t => {
	for (const fault of ["cancel", "owner", "quarantine readback", "quarantine write"] as const) {
		const f = await fixture(t);
		const global = temporalScopePaths(f.cwd, f.id, "global", f.root);
		const cwd = temporalScopePaths(f.cwd, f.id, "cwd", f.root);
		writeFileSync(global.checkpoint, "{corrupt");
		writeFileSync(cwd.checkpoint, "{corrupt");
		const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
		const controller = new AbortController();
		const write = fs.writeFileSync;
		const failure = new Error(`injected ${fault}`);
		let currentChecks = 0;
		const assertCurrent = () => {
			if (++currentChecks !== 2) return;
			if (fault === "cancel") controller.abort(failure);
			if (fault === "owner") throw failure;
		};
		const spy = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
			if (String(args[0]).startsWith(`${quarantineDirectory(f.root)}/`) && String(args[0]).includes("-cwd-")) {
				if (fault === "quarantine write") throw failure;
				if (fault === "quarantine readback") args[1] = "unverifiable replacement";
			}
			return write(...args);
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(heal(f, ALL, controller.signal, fixedDate, 7, assertCurrent), (error: unknown) => {
				assert.ok(error instanceof HealExecutionError);
				assert.equal(error.outcome.effect, "none");
				assert.equal(error.outcome.evidence.length, fault === "quarantine write" ? 1 : 2);
				if (fault === "quarantine readback") assert.match(error.message, /quarantine record is unsafe or changed/);
				else assert.equal(error.cause, failure);
				return true;
			});
		} finally { spy.mock.restore(); syncBuiltinESMExports(); }
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
	}
});

test("completed reset survives abort at finality or a later lock-release failure", async t => {
	for (const finish of ["late abort", "release failure"] as const) {
		const f = await fixture(t);
		const damaged = scopeFiles(f, "global");
		writeFileSync(damaged[0]!, Buffer.from([0xfe, 0xff]));
		const before = snapshotFiles(ALL.flatMap(scope => scopeFiles(f, scope)));
		const controller = new AbortController();
		const failure = Object.assign(new Error("injected release failure"), { code: "EIO" });
		await withRemovalSpy(t, (path, perform) => {
			if (finish === "release failure" && path === join(f.root, ".state-flow-publication.lock")) throw failure;
			perform();
			if (finish === "late abort" && path === damaged.at(-1)) controller.abort();
		}, async () => {
			if (finish === "late abort") assertQuarantine(f.root, (await heal(f, ALL, controller.signal)).healed[0]!.quarantine, before, damaged);
			else await assert.rejects(heal(f), (error: unknown) => {
				assert.ok(error instanceof HealExecutionError);
				assert.equal(error.cause, failure);
				assert.equal(error.outcome.effect, "reset");
				assert.equal(error.outcome.result.lifecycleAbsent, false);
				assertQuarantine(f.root, error.outcome.result.healed[0]!.quarantine, before, damaged);
				return true;
			});
		});
		for (const path of damaged) before.set(path, undefined);
		assert.deepEqual(snapshotFiles([...before.keys()]), before);
	}
});

test("attempted and incomplete incidents never describe a successful reset", () => {
	const incident = { id: "incident", scopes: ["session"] as ScopeSelection };
	assert.match(recoveryIncidentText({ ...incident, fact: "attempted" }), /attempted.*result is unconfirmed/);
	assert.doesNotMatch(recoveryIncidentText({ ...incident, fact: "incomplete" }), /was reset|restored/);
	assert.match(recoveryIncidentText({ ...incident, fact: "reset" }), /session memory was unreadable and was reset/);
});

test("an absent store needs no healing and reports no lifecycle", async t => {
	const f = await fixture(t);
	const missing = join(f.root, "..", "missing-store");
	assert.deepEqual(await healSelectedStore({ cwd: f.cwd, sessionId: f.id, sessionKey: f.id, selection: [...ALL], historyLimit: 7, root: missing }),
		{ healed: [], lifecycleAbsent: true });
	assert.equal(existsSync(missing), false);
});
