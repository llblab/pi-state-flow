import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TemporalRuntime } from "../lib/runtime.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import type { SelectedFilePublication } from "../lib/storage.ts";
import { createSelectedTemporalState, advanceTemporalState } from "../lib/temporal.ts";
import { sessionRuntimePaths, temporalScopePaths, serializeScopeStream, serializeScopeMetadata } from "../lib/durable.ts";
import { captureScopeSelection } from "../lib/selection.ts";

function fixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-selected-origin-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "workspace"), id = "new-owner";
	const runtime = new TemporalRuntime(cwd, id, root);
	return { parent, root, cwd, id, runtime, paths: sessionRuntimePaths(cwd, id, root), privatePaths: temporalScopePaths(cwd, id, "session", root) };
}
function seed(f: ReturnType<typeof fixture>, scope: "global" | "cwd", legacy = false) {
	let view = createSelectedTemporalState({ [scope]: { strategy: { retained: scope } } }, [scope], `seed-${scope}`);
	view = advanceTemporalState(view, [{ scope, patch: { tactics: { step: "before-origin" } } }], `seed-${scope}-patch`);
	const stream = view.scopes[scope]!;
	const wire = serializeScopeStream(stream, scope, scope === "cwd" ? f.cwd : undefined);
	const paths = temporalScopePaths(f.cwd, f.id, scope, f.root);
	mkdirSync(paths.directory, { recursive: true });
	const metadata = { ...JSON.parse(serializeScopeMetadata(undefined, stream, scope, scope === "cwd" ? f.cwd : undefined)), foreign: { keep: true } };
	writeFileSync(paths.checkpoint, legacy ? wire.checkpoint.replace(/"strategy"\s*:/g, '"contract":') : wire.checkpoint);
	writeFileSync(paths.patches, legacy ? wire.patches.replace(/"tactics"\s*:/g, '"working":') : wire.patches);
	writeFileSync(paths.meta, JSON.stringify({ ...metadata, version: legacy ? 2 : 3 }));
	return { paths, original: [paths.checkpoint, paths.patches, paths.meta].map((path) => [path, readFileSync(path)] as const) };
}

async function create(f: ReturnType<typeof fixture>, selection: readonly ("global" | "cwd")[], mode: "active" | "passive" = "active") {
	let accepted: SelectedFilePublication | undefined;
	await f.runtime.withSelectedSharedOriginTransaction(captureScopeSelection(selection), emptySnapshot(mode), (publish) => { accepted = publish(); }, undefined, true);
	return accepted!;
}

export { fixture, seed, create };
