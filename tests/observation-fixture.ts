import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { StatusDiagnostics } from "../lib/status.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";
import type { AtomicScopePatches, ScopeStateValues } from "../lib/state.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { temporalScopeRevisions } from "../lib/temporal.ts";
import { stageSelectedScopePatches, stageSelectedScopedTransition, commitSelectedTransition } from "../lib/transition.ts";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";

const scopes = ["global", "cwd", "session"] as const;
const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
const forbidden = (): never => assert.fail("excluded/unavailable observation was read");
function diagnostics(selection: ScopeSelection, states: ScopeStateValues = Object.fromEntries(selection.map(scope => [scope, { strategy: { [scope]: true } }]))): StatusDiagnostics {
	return { selection, repositoryRoot: "/store", cwdScopeKey: "cwd-key", sessionScopeKey: "session-key",
		scopeStates: states, recent: [], historyLimit: 7, staleArtifacts: [],
		temporal: { head: { id: "origin", parent: null, position: 0 }, historyDepth: 0,
			tailCounts: Object.fromEntries(selection.map(scope => [scope, 0])), revisions: Object.fromEntries(selection.map(scope => [scope, 4])) } };
}
function memoryJson(output: string) { return JSON.parse(output.split("Effective memory:\n\n")[1]!); }
function withoutFileIO<T>(action: () => T): T {
	const open = fs.openSync, read = fs.readFileSync, stat = fs.lstatSync, scan = fs.readdirSync;
	fs.openSync = forbidden; fs.readFileSync = forbidden; fs.lstatSync = forbidden; fs.readdirSync = forbidden; syncBuiltinESMExports();
	try { return action(); }
	finally { fs.openSync = open; fs.readFileSync = read; fs.lstatSync = stat; fs.readdirSync = scan; syncBuiltinESMExports(); }
}

async function fixture(t: TestContext, selection: ScopeSelection, mode: "active" | "passive" = "active") {
	const directory = mkdtempSync(join(tmpdir(), "state-flow-observation-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "store"), cwd = join(directory, "workspace"), id = "owner";
	const runtime = new TemporalRuntime(cwd, id, root); let snapshot = emptySnapshot(mode);
	if (selection.includes("session")) await runtime.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot, historyLimit: 7 }, publish => publish(), undefined, true);
	else await runtime.withSelectedSharedOriginTransaction(selection, snapshot, publish => publish(), undefined, true);
	const patch = async (patches: AtomicScopePatches, response?: string) => runtime.withSelectedPatchTransaction(transaction => {
		const stage = response === undefined ? stageSelectedScopePatches(transaction, patches, [], transaction.causalBasis)
			: stageSelectedScopedTransition(transaction, { transitions: Object.entries(patches).map(([scope, patch]) => ({ scope: scope as typeof scopes[number], patch })), response }, [], transaction.causalBasis);
		commitSelectedTransition(transaction.snapshot, transaction, stage, (accepted, next) => transaction.publish(next, accepted), transaction.causalBasis);
		snapshot = structuredClone(transaction.snapshot); return stage;
	}, () => {});
	const observe = (): StatusDiagnostics => {
		const { selection, states } = runtime.selectedStates(), view = runtime.selectedView()!;
		return { ...diagnostics(selection, states), recent: runtime.recent(), temporal: { head: view.lineage.at(-1)!, historyDepth: view.lineage.length - 1,
			tailCounts: Object.fromEntries(selection.map(scope => [scope, view.scopes[scope]!.patches.length])), revisions: temporalScopeRevisions(view) } };
	};
	return { root, cwd, id, runtime, patch, observe, snapshot: () => snapshot };
}
function body(message: any): string { return message.content.map((block: any) => block.text ?? "").join("\n"); }
function canonicalFiles(f: { root: string; cwd: string; id: string }) {
	const lifecycle = sessionRuntimePaths(f.cwd, f.id, f.root);
	return [lifecycle.config, lifecycle.runtime, ...scopes.flatMap(scope => {
		const paths = temporalScopePaths(f.cwd, f.id, scope, f.root); return [paths.checkpoint, paths.patches, paths.meta];
	})].filter(existsSync).map(path => [path, readFileSync(path)] as const);
}

export { scopes, selections, forbidden, diagnostics, memoryJson, withoutFileIO, fixture, body, canonicalFiles };
