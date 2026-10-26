import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import type { SelectedSessionAcquisitionRequest, SelectedFilePublication, SelectedFileCohort } from "../lib/storage.ts";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { captureScopeSelection } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

function fixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-acquire-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "owner";
	const runtime = new TemporalRuntime(cwd, id, root);
	const paths = sessionRuntimePaths(cwd, id, root), privatePaths = temporalScopePaths(cwd, id, "session", root);
	const acquire = async (request: SelectedSessionAcquisitionRequest, owner = runtime) => {
		let result: SelectedFilePublication | undefined;
		await owner.withSelectedSessionAcquisitionTransaction(request, (publish) => { result = publish(); }, undefined, true);
		return result!;
	};
	const shared = async (selection: readonly StateScope[] = ["cwd"], snapshot = emptySnapshot("active")) => {
		let base: SelectedFileCohort | undefined;
		await runtime.withSelectedSharedOriginTransaction(captureScopeSelection(selection), snapshot, (publish) => { base = publish().cohort; }, undefined, true);
		return base!;
	};
	return { root, cwd, id, runtime, paths, privatePaths, acquire, shared };
}
function request(selection: readonly StateScope[], snapshot = emptySnapshot("active")): SelectedSessionAcquisitionRequest {
	return { kind: "new", selection: captureScopeSelection(selection), snapshot, historyLimit: 7 };
}

export { fixture, request };
