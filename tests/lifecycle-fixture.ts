import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";

const scopes = ["global", "cwd", "session"] as const;
const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));

async function fixture(t: TestContext, selection: ScopeSelection = ["global", "session"], limit = 7) {
	const directory = mkdtempSync(join(tmpdir(), "state-flow-selected-lifecycle-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "store"), cwd = join(directory, "cwd"), id = "owner";
	const runtime = new TemporalRuntime(cwd, id, root, undefined, limit);
	const snapshot = emptySnapshot("active");
	if (selection.includes("session")) await runtime.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot, historyLimit: limit }, p => p(), undefined, true);
	else await runtime.withSelectedSharedOriginTransaction(selection, snapshot, p => p(), undefined, true);
	await runtime.withSelectedPatchTransaction(transaction => {
		const next = structuredClone(transaction.snapshot);
		next.meta = { step: 1, specification: "accepted run", bootstrap: false, validation: { attempt: 1, error: "observed", instruction: "check" } };
		transaction.publish(next, { id: "accepted-step", transitions: selection.map(scope => ({ scope, patch: { strategy: { owner: scope } } })) },
			Object.fromEntries(selection.map(scope => [scope, { "/registered/source": { compilerRevision: `accepted-${scope}` } }])));
	}, () => {});
	return { root, cwd, id, runtime };
}
function files(f: { root: string; cwd: string; id: string }) {
	const life = sessionRuntimePaths(f.cwd, f.id, f.root);
	return [life.config, life.runtime, ...scopes.flatMap(scope => { const p = temporalScopePaths(f.cwd, f.id, scope, f.root); return [p.checkpoint, p.patches, p.meta]; })]
		.filter(path => existsSync(path)).map(path => [path, readFileSync(path)] as const);
}
function unchanged(before: ReturnType<typeof files>) { for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path); }
async function withoutBodies<T>(paths: string[], action: () => Promise<T>): Promise<T> {
	const original = fs.readFileSync;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		assert.equal(paths.includes(String(args[0])), false, `Forbidden semantic body: ${String(args[0])}`);
		return original(...args);
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	try { return await action(); } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

async function legacyLifecycle(t: TestContext) {
	const f = await fixture(t, scopes);
	await f.runtime.withSelectedCurrentTransaction(["cwd"], (_s, publish) => publish(), () => {});
	const life = sessionRuntimePaths(f.cwd, f.id, f.root), metadata = JSON.parse(readFileSync(life.runtime, "utf8"));
	metadata.version = 1; delete metadata.privateAcquisition; delete metadata.causalWitnesses; delete metadata.privateCausalBasis;
	writeFileSync(life.config, JSON.stringify({ mode: "active" })); writeFileSync(life.runtime, JSON.stringify(metadata));
	const before = files(f), bodies = before.map(([path]) => path).filter(path => path !== life.config && path !== life.runtime);
	return { f, before, bodies };
}

export { scopes, selections, fixture, files, unchanged, withoutBodies, legacyLifecycle };
