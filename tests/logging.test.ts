import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendStateFlowDiagnostic, projectDiagnosticContent, StateFlowDiagnosticWriter, stateFlowLogPath } from "../lib/logging.ts";
import { harness, start } from "./harness.ts";

test("diagnostics preserve text but not reasoning bodies", () => {
	assert.deepEqual(projectDiagnosticContent([
		{ type: "text", text: "bad patch" },
		{ type: "thinking", thinking: "private" },
	]), [{ type: "text", text: "bad patch" }, { type: "thinking" }]);
});

test("diagnostics append local JSONL records under tmp/pi-state-flow", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-log-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const path = stateFlowLogPath(agentDir);
	assert.equal(path, join(agentDir, "tmp", "pi-state-flow", "logs.jsonl"));
	appendStateFlowDiagnostic(path, { at: "2026-01-01T00:00:00.000Z", sessionId: "s", cwd: "/cwd", category: "invalid-patch", error: "invalid" });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { at: "2026-01-01T00:00:00.000Z", sessionId: "s", cwd: "/cwd", category: "invalid-patch", error: "invalid" });
	assert.equal(existsSync(join(agentDir, "tmp", "state-flow")), false);
});

test("barrier-block diagnostics persist only tool identities and batch names when enabled", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-barrier-log-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = stateFlowLogPath(join(root, "agent"));
	const writer = new StateFlowDiagnosticWriter(true, path, join(root, "repository"), (warning) => assert.fail(warning));
	const names = ["bash", "patch_state"];
	writer.record("s", "/cwd", "Blocked by the patch_state barrier", "barrier-block", {
		tool: "bash", toolCallId: "bash-1", batchToolNames: names,
	});
	names.push("read_state");
	const { at, ...record } = JSON.parse(readFileSync(path, "utf8"));
	assert.match(at, /^\d{4}-\d\d-\d\dT/);
	assert.deepEqual(record, {
		sessionId: "s", cwd: "/cwd", category: "barrier-block", error: "Blocked by the patch_state barrier",
		tool: "bash", toolCallId: "bash-1", batchToolNames: ["bash", "patch_state"],
	});
	const offPath = stateFlowLogPath(join(root, "off"));
	new StateFlowDiagnosticWriter(false, offPath, join(root, "repository"), (warning) => assert.fail(warning))
		.record("s", "/cwd", "blocked", "barrier-block", { tool: "bash", toolCallId: "bash-1", batchToolNames: names });
	assert.equal(existsSync(offPath), false);
});

test("diagnostics refuse symlinked paths without writing through them", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-log-symlink-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const target = join(root, "target");
	writeFileSync(target, "unchanged\n");
	const record = { at: "2026-01-01T00:00:00.000Z", sessionId: "s", cwd: "/cwd", category: "publication-conflict" as const, error: "failed" };
	const directory = join(root, "agent", "tmp", "pi-state-flow");
	mkdirSync(directory, { recursive: true });
	symlinkSync(target, join(directory, "logs.jsonl"));
	assert.throws(() => appendStateFlowDiagnostic(join(directory, "logs.jsonl"), record));
	symlinkSync(directory, join(root, "alias"));
	assert.throws(() => appendStateFlowDiagnostic(join(root, "alias", "new.jsonl"), record), /not a regular directory/);
	assert.equal(readFileSync(target, "utf8"), "unchanged\n");
	assert.equal(existsSync(join(directory, "new.jsonl")), false);
});

test("rejected patch_state diagnostics retain the exact attempted arguments", async () => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-input-log-"));
	mkdirSync(join(root, "state-flow"));
	writeFileSync(join(root, "state-flow", "config.json"), JSON.stringify({ logging: true }));
	const h = harness({ agentDir: root, repositoryRoot: join(root, "state-flow") });
	await start(h, "Reject an invalid patch");
	const attempted = { global: { working: { example: true } }, final: "maybe" };
	await assert.rejects(
		h.tools.get("patch_state")!.execute("attempted", attempted, undefined, undefined, h.ctx),
		/does not accept field final/,
	);
	const record = JSON.parse(readFileSync(stateFlowLogPath(root), "utf8"));
	assert.equal(record.category, "invalid-patch");
	assert.equal(record.tool, "patch_state");
	assert.equal(record.toolCallId, "attempted");
	assert.deepEqual(record.input, attempted);
});

test("diagnostics fail inertly instead of entering an overlapping state repository", async () => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-overlap-log-"));
	writeFileSync(join(root, "config.json"), JSON.stringify({ logging: true }));
	const h = harness({ agentDir: root, repositoryRoot: root });
	await start(h, "Reject an invalid patch");
	await assert.rejects(h.tools.get("patch_state")!.execute(
		"invalid", { extra: true }, undefined, undefined, h.ctx,
	));
	assert.equal(existsSync(stateFlowLogPath(root)), false);
	assert.equal(h.notifications.filter((message) => /diagnostic path overlaps/.test(message)).length, 1);
});
