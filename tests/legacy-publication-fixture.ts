import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { temporalScopePaths } from "../lib/durable.ts";
import type { JsonObject, JsonValue } from "../lib/json.ts";
import { createSessionRuntime, emptySnapshot } from "../lib/snapshot.ts";
import { captureTemporalFileBase, initializeFileStore, publishTemporalStateToFiles } from "../lib/storage.ts";
import { advanceTemporalState, createTemporalState } from "../lib/temporal.ts";

// Deliberately retain legacy names in the serialized fixtures: these are conversion inputs, not current API examples.
export function fixture(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-migrate-publication-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store"), cwd = join(parent, "project"), sessionId = "migration-session";
	initializeFileStore(root);
	const snapshot = emptySnapshot("active");
	snapshot.meta.step = 2;
	let view = createTemporalState({ global: {}, cwd: {}, session: {} }, "origin");
	view = advanceTemporalState(view, [
		{ scope: "global", patch: { strategy: { requirement: "offline" } } },
		{ scope: "session", patch: { intents: { job: { context: { $ref: "session.tactics.job" } } }, tactics: { job: { next: "validate" } } } },
	], "T1");
	view = advanceTemporalState(view, [{ scope: "session", patch: { tactics: { job: { progress: "prepared" } }, response: "See $global.strategy.requirement" } }], "T2");
	const runtime = createSessionRuntime(snapshot, cwd, sessionId, view.lineage);
	publishTemporalStateToFiles(cwd, sessionId, view, ["global", "cwd", "session"], captureTemporalFileBase(cwd, sessionId, root), root, runtime);
	const legacyReferences = (value: JsonValue): JsonValue => {
		if (typeof value === "string") return value.replaceAll(".tactics", ".working").replaceAll(".strategy", ".contract");
		if (Array.isArray(value)) return value.map(legacyReferences);
		if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, legacyReferences(child)]));
		return value;
	};
	const legacyRoot = (value: JsonObject) => Object.fromEntries(Object.entries(value).map(([key, child]) => [key === "strategy" ? "contract" : key === "tactics" ? "working" : key, legacyReferences(child)]));
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, sessionId, scope, root);
		writeFileSync(paths.checkpoint, ` ${JSON.stringify(legacyRoot(JSON.parse(readFileSync(paths.checkpoint, "utf8"))))}\n`);
		writeFileSync(paths.patches, view.scopes[scope].patches.map(({ patch }) => `${JSON.stringify(legacyRoot(patch as JsonObject))}\n`).join(""));
		const metadata = JSON.parse(readFileSync(paths.meta, "utf8"));
		metadata.version = 2;
		metadata.foreign = { keep: true, address: "$session.working.job" };
		metadata.temporal.extra = { preserve: true };
		metadata.opaqueLifecycle = { identity: "do not reinterpret" };
		metadata.artifacts = { "/opaque": { futureEvidence: "preserve" } };
		writeFileSync(paths.meta, `${JSON.stringify(metadata, null, 2)}\n`);
	}
	writeFileSync(join(root, "unrelated-note"), "must not be discovered or backed up");
	const base = captureTemporalFileBase(cwd, sessionId, root);
	const backupDir = join(parent, "store-migration-backups");
	return { root, cwd, sessionId, view, runtime, snapshot, base, backupDir };
}

export function assertUnchanged(f: ReturnType<typeof fixture>): void {
	for (const file of f.base.files) {
		if (file.bytes !== undefined) assert.deepEqual(readFileSync(file.path), Buffer.from(file.bytes));
		else assert.equal(existsSync(file.path), false);
	}
}
