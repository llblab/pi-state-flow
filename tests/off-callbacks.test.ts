import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureTemporalFileBases } from "../lib/durable.ts";
import { commitTerminal, harness, start } from "./harness.ts";
import { withoutStoreIO } from "./store-io-spy.ts";

for (const logging of [false, true]) for (const attachment of ["new", "resume", "tree", "warm"] as const) {
	test(`automatic Off callbacks are memory-inert (logging=${logging}, attachment=${attachment})`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-off-callbacks-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent"), repositoryRoot = join(root, "store");
		mkdirSync(repositoryRoot, { recursive: true });
		writeFileSync(join(repositoryRoot, "config.json"), JSON.stringify({ logging }));
		const options = { agentDir, repositoryRoot, initializeRepository: false };
		const source = harness(options);
		await start(source);
		await commitTerminal(source, {}, { private: "ACCEPTED" });
		const path = join(root, "SKILL.md");
		writeFileSync(path, "Source that Off must not hash or inspect");
		source.registerSkill(path);
		const read = { toolCallId: "queued-read", toolName: "read", args: { path }, input: { path }, isError: false };
		source.handlers.get("tool_execution_start")!(read, source.ctx);
		source.handlers.get("tool_call")!(read, source.ctx);
		await source.commands.get("state-flow-off")!.handler("", source.ctx);
		const h = attachment === "warm" ? source : harness({ ...options, ...(attachment === "new" ? { sessionId: "new-owner" } : {}) });
		if (attachment !== "new" && h !== source) h.entries.push(...structuredClone(source.entries));
		h.registerSkill(path);
		const files = captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot);
		const notices = [...h.notifications];
		await withoutStoreIO(t, root, async () => {
			if (attachment === "tree") await h.handlers.get("session_tree")!({}, h.ctx);
			else if (attachment !== "warm") await h.handlers.get("session_start")!({ reason: attachment }, h.ctx);
			const entries = structuredClone(h.entries);
			const sections: Record<string, string> = {};
			h.handlers.get("before_agent_start")!({ prompt: "Ordinary Off chat", systemPromptOptions: { sections } }, h.ctx);
			assert.deepEqual(sections, {});
			const messages = [{ role: "user", content: "Keep native conversation", timestamp: 1 }];
			assert.equal(await h.handlers.get("context")!({ messages }, h.ctx), undefined);
			assert.deepEqual(h.handlers.get("context_with_system")!({ messages }, h.ctx).messages, messages);
			h.handlers.get("tool_execution_start")!(read, h.ctx);
			assert.equal(h.handlers.get("tool_call")!(read, h.ctx), undefined);
			h.handlers.get("tool_execution_end")!(read, h.ctx);
			assert.equal(h.handlers.get("tool_result")!({ ...read, content: [{ type: "text", text: "Read body" }] }, h.ctx), undefined);
			for (const stopReason of ["stop", "aborted", "error", "length", "toolUse"]) {
				const message = { role: "assistant", stopReason, content: [{ type: "text", text: "Ordinary answer" }] };
				h.handlers.get("message_end")!({ message }, h.ctx);
				await h.handlers.get("turn_end")!({ message }, h.ctx);
			}
			await assert.rejects(h.tools.get("read_state")!.execute("queued-memory-read", { path: "session.working.private" }), /tools are off/);
			await assert.rejects(h.tools.get("patch_state")!.execute("queued-memory-patch", { session: { working: { unexpected: true } } }, undefined, undefined, h.ctx), /tools are off/);
			assert.equal(h.handlers.get("session_before_compact")!({ reason: "manual", customInstructions: "ordinary user request" }, h.ctx), undefined);
			h.handlers.get("session_compact")!({}, h.ctx);
			await h.handlers.get("agent_before_settle")!({}, h.ctx);
			await h.handlers.get("agent_settled")!({}, h.ctx);
			assert.deepEqual(h.entries, entries);
			assert.equal(h.compactRequests.length, 0);
			assert.equal(h.activeTools.includes("read_state"), false);
			await h.handlers.get("session_shutdown")!({}, h.ctx);
		});
		assert.deepEqual(h.notifications, notices);
		assert.deepEqual(captureTemporalFileBases(h.ctx.cwd, h.ctx.sessionManager.getSessionId(), repositoryRoot), files);
	});
}
