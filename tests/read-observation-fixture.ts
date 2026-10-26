import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

const shared: ScopeSelection[] = [["global"], ["cwd"], ["global", "cwd"]];
const all = ["global", "cwd", "session"] as const;
async function fixture(t: TestContext, present: ScopeSelection = ["global", "cwd"], limit = 7) {
	const directory = mkdtempSync(join(tmpdir(), "state-flow-shared-observation-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "store"), cwd = join(directory, "cwd"), id = "producer";
	const producer = new TemporalRuntime(cwd, id, root, undefined, limit);
	if (present.includes("session")) await producer.withSelectedSessionAcquisitionTransaction({ kind: "new", selection: present, snapshot: emptySnapshot("active"), historyLimit: limit }, p => p(), undefined, true);
	else await producer.withSelectedSharedOriginTransaction(present, emptySnapshot("active"), p => p(), undefined, true);
	await producer.withSelectedPatchTransaction(transaction => transaction.publish(transaction.snapshot, {
		id: "source-step", transitions: present.map(scope => ({ scope, patch: { strategy: { owner: scope }, lazy: { privateBody: scope }, artifacts: { "/unobserved-source": { description: "route" } } } })),
	}), () => {});
	await producer.publishSelected(producer.selectedSnapshot(), undefined, () => {}, {
		provenance: Object.fromEntries(present.map(scope => [scope, { "/unobserved-source": { compilerRevision: `evidence-${scope}` } }])),
	});
	return { root, cwd, id, producer, observer: new TemporalRuntime(cwd, "reader", root, undefined, limit) };
}
function cohortFiles(f: { root: string; cwd: string; id: string }) {
	const life = sessionRuntimePaths(f.cwd, f.id, f.root);
	return [life.config, life.runtime, ...all.flatMap(scope => { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; })]
		.filter(path => existsSync(path)).map(path => [path, readFileSync(path)] as const);
}
function unchanged(files: ReturnType<typeof cohortFiles>) { for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes, path); }
function bodies(f: { root: string; cwd: string; id: string }, scope: StateScope) { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; }
async function forbid<T>(paths: string[], action: () => Promise<T>): Promise<T> {
	const read = fs.readFileSync, open = fs.openSync, stat = fs.lstatSync;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { assert.equal(paths.includes(String(args[0])), false, `Forbidden read: ${String(args[0])}`); return read(...args); }) as typeof fs.readFileSync;
	fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { assert.equal(paths.includes(String(args[0])), false, `Forbidden open: ${String(args[0])}`); return open(...args); }) as typeof fs.openSync;
	fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => { assert.equal(String(args[0]) === "/unobserved-source", false, "Source observation is not canonical inspection"); return stat(...args); }) as typeof fs.lstatSync;
	syncBuiltinESMExports();
	try { return await action(); } finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
}

export { shared, all, fixture, cohortFiles, unchanged, bodies, forbid };
