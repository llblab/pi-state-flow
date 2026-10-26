import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { captureTemporalFileBases, sessionRuntimePaths } from "../lib/durable.ts";
import { TemporalRuntime, type SelectedRuntimePatchTransaction } from "../lib/runtime.ts";
import type { ScopeSelection } from "../lib/selection.ts";
import { withStorageTransaction } from "../lib/storage.ts";
import { commitSelectedTransition, stageSelectedScopePatches } from "../lib/transition.ts";

const selections: ScopeSelection[] = [["global"], ["cwd"], ["session"], ["global", "cwd"], ["global", "session"], ["cwd", "session"], ["global", "cwd", "session"]];
const run = { config: { mode: "active" as const }, meta: { step: 4, specification: "preserve current task", bootstrap: true as const, validation: { attempt: 2, error: "retained check", instruction: "Retain source validation" } } };
async function fixture(t: TestContext, selection: ScopeSelection = ["cwd"], limit = 7) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-current-author-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd"), id = "owner", seed = new TemporalRuntime(cwd, id, root, undefined, limit);
	if (selection.includes("session")) await seed.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot: run, historyLimit: limit }, publish => publish(), undefined, true);
	else await seed.withSelectedSharedOriginTransaction(selection, run, publish => publish(), undefined, true);
	return { root, cwd, id, seed, cold: new TemporalRuntime(cwd, id, root, undefined, limit), paths: sessionRuntimePaths(cwd, id, root), bytes: () => captureTemporalFileBases(cwd, id, root) };
}
function author(transaction: SelectedRuntimePatchTransaction, target = transaction.selection[0]) {
	const stage = stageSelectedScopePatches(transaction, { [target]: { tactics: { firstCurrentMutation: "owned" } } }, [], transaction.causalBasis);
	const next = structuredClone(transaction.snapshot);
	commitSelectedTransition(next, transaction, stage, (accepted, snapshot) => transaction.publish(snapshot, accepted, stage.provenanceUpdates), transaction.causalBasis, { finalizeRun: false });
	return next;
}
function deadline<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("current author did not withdraw while store held")), 3000); })]).finally(() => clearTimeout(timer));
}
async function hold(t: TestContext, root: string) {
	mkdirSync(root, { recursive: true }); let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	t.after(() => release()); const task = withStorageTransaction(root, async () => { entered(); await gate; }); await ready;
	return async () => { release(); await task; };
}

export { selections, run, fixture, author, deadline, hold };
