import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { temporalScopePaths, sessionRuntimePaths } from "../lib/durable.ts";
import { withStorageTransaction, type SelectedFileCohort, type SelectedFilePublication } from "../lib/storage.ts";
import { advanceTemporalState } from "../lib/temporal.ts";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

const scopes = ["global", "cwd", "session"] as const;
const selections: ScopeSelection[] = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(scopes.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
const run = { config: { mode: "active" as const }, meta: { step: 7, bootstrap: true } };

async function fixture(t: TestContext, selection: ScopeSelection = ["global", "cwd", "session"]) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-current-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "cwd"), id = "current";
	const owner = new TemporalRuntime(cwd, id, root);
	let base: SelectedFileCohort | undefined;
	if (selection.includes("session")) await owner.withSelectedSessionAcquisitionTransaction({ kind: "new", selection, snapshot: run, historyLimit: 7 }, publish => { base = publish().cohort; }, undefined, true);
	else await owner.withSelectedSharedOriginTransaction(selection, run, publish => { base = publish().cohort; }, undefined, true);
	await withStorageTransaction(root, transaction => {
		const transition = { id: "first", transitions: selection.map(scope => ({ scope, patch: { strategy: { marker: scope }, artifacts: { "/source.txt": { description: `source-${scope}` } } } })) };
		base = transaction.publishSelected(cwd, id, { view: advanceTemporalState(base!.view, transition.transitions, transition.id), transition, historyLimit: 7 }, base!, root).cohort;
	});
	const runtimePaths = sessionRuntimePaths(cwd, id, root);
	const metadata = JSON.parse(readFileSync(runtimePaths.runtime, "utf8"));
	writeFileSync(runtimePaths.runtime, JSON.stringify({ ...metadata, opaque: { preserve: "lifecycle" } }));
	for (const scope of selection) {
		const paths = temporalScopePaths(cwd, id, scope, root);
		const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
		writeFileSync(paths.meta, JSON.stringify({ ...meta, opaque: { preserve: scope }, artifacts: { "/source.txt": { sourceHash: `sha256:${"a".repeat(64)}`, compilerRevision: "current-v1" } } }));
	}
	const drift = async () => {
		const peer = new TemporalRuntime(cwd, "peer", root);
		let shared: SelectedFileCohort | undefined;
		await peer.withSelectedSharedOriginTransaction(["global", "cwd"], emptySnapshot("active"), publish => { shared = publish().cohort; }, undefined, true);
		await withStorageTransaction(root, transaction => {
			const transition = { id: "live-shared", transitions: ["global", "cwd"].map(scope => ({ scope: scope as StateScope, patch: { strategy: { marker: "live" } } })) };
			transaction.publishSelected(cwd, "peer", { view: advanceTemporalState(shared!.view, transition.transitions, transition.id), transition, historyLimit: 7 }, shared!, root);
		});
	};
	const refresh = async (wanted: ScopeSelection, historyLimit = 7, runtime = new TemporalRuntime(cwd, id, root, undefined, historyLimit)) => {
		let accepted: SelectedFilePublication | undefined;
		await runtime.withSelectedCurrentTransaction(wanted, (current, publish) => {
			assert.deepEqual(current, run); accepted = publish();
		}, () => {});
		return accepted!;
	};
	return { root, cwd, id, owner, base: base!, runtimePaths, drift, refresh };
}

function exactFiles(base: SelectedFileCohort) { return base.basis.files.map(file => [file.path, readFileSync(file.path)] as const); }
function unchanged(files: ReturnType<typeof exactFiles>) { for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes, path); }

export { scopes, selections, run, fixture, unchanged };
