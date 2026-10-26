import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime, type ForkLifecycle } from "../lib/runtime.ts";
import type { SelectedFilePublication } from "../lib/storage.ts";
import { temporalScopePaths, sessionRuntimePaths } from "../lib/durable.ts";
import { captureScopeSelection } from "../lib/selection.ts";
import type { StateScope } from "../lib/state.ts";

function fixture(t: TestContext, limit = 7) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-fork-deferred-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "child";
	const runtime = new TemporalRuntime(cwd, id, root, undefined, limit);
	const paths = sessionRuntimePaths(cwd, id, root), privatePaths = temporalScopePaths(cwd, id, "session", root);
	const defer = async (selection: readonly StateScope[] = ["cwd"], lifecycle: ForkLifecycle = { mode: "active" }) => {
		let result: SelectedFilePublication | undefined;
		await runtime.withSelectedDeferredForkTransaction(captureScopeSelection(selection), lifecycle, (publish) => { result = publish(); }, undefined, true);
		return result!;
	};
	return { root, cwd, id, runtime, paths, privatePaths, defer };
}

export { fixture };
