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

test("diagnostics fail inertly instead of entering an overlapping state repository", async () => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-overlap-log-"));
	writeFileSync(join(root, "state-flow.json"), JSON.stringify({ logging: true }));
	const h = harness({ agentDir: root, repositoryRoot: root });
	await start(h, "Reject an invalid patch");
	await assert.rejects(h.tools.get("patch_state")!.execute(
		"invalid", { unchanged: true, extra: true }, undefined, undefined, h.ctx,
	));
	assert.equal(existsSync(stateFlowLogPath(root)), false);
	assert.equal(h.notifications.filter((message) => /diagnostic path overlaps/.test(message)).length, 1);
});
