import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendStateFlowDiagnostic, projectDiagnosticContent, stateFlowLogPath } from "../lib/logging.ts";
import { harness, start } from "./harness.ts";

test("diagnostics preserve text but not reasoning bodies", () => {
	assert.deepEqual(projectDiagnosticContent([
		{ type: "text", text: "bad patch" },
		{ type: "thinking", thinking: "private" },
	]), [{ type: "text", text: "bad patch" }, { type: "thinking" }]);
});

test("diagnostics append local JSONL records", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "state-flow-log-"));
	const path = stateFlowLogPath(agentDir);
	appendStateFlowDiagnostic(path, { at: "2026-01-01T00:00:00.000Z", sessionId: "s", cwd: "/cwd", category: "invalid-patch", error: "invalid" });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { at: "2026-01-01T00:00:00.000Z", sessionId: "s", cwd: "/cwd", category: "invalid-patch", error: "invalid" });
});

test("rejected patch_state diagnostics retain the exact attempted arguments", async () => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-input-log-"));
	writeFileSync(join(root, "state-flow.json"), JSON.stringify({ logging: true, remotePublication: "off" }));
	const h = harness({ agentDir: root });
	await start(h, "Reject an invalid patch");
	const attempted = { global: { working: { example: true } }, final: false };
	await assert.rejects(
		h.tools.get("patch_state")!.execute("attempted", attempted, undefined, undefined, h.ctx),
		/final must be exactly true/,
	);
	const record = JSON.parse(readFileSync(stateFlowLogPath(root), "utf8"));
	assert.equal(record.category, "invalid-patch");
	assert.equal(record.tool, "patch_state");
	assert.equal(record.toolCallId, "attempted");
	assert.equal(record.terminalEligible, false);
	assert.equal(record.resolutionAttempt, 0);
	assert.deepEqual(record.input, attempted);
});

test("diagnostics fail inertly instead of entering an overlapping state repository", async () => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-overlap-log-"));
	writeFileSync(join(root, "state-flow.json"), JSON.stringify({ logging: true }));
	const h = harness({ agentDir: root, repositoryRoot: root });
	await start(h, "Reject an invalid patch");
	await assert.rejects(h.tools.get("patch_state")!.execute(
		"invalid", { final: true, extra: true }, undefined, undefined, h.ctx,
	));
	assert.equal(existsSync(stateFlowLogPath(root)), false);
	assert.equal(h.notifications.filter((message) => /diagnostic path overlaps/.test(message)).length, 1);
});
