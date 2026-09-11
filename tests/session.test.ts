import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionState, writeCwdState, writeGlobalState } from "./temporal-fixture.ts";
import { emptyState } from "../lib/state.ts";
import { discoverSnapshotData, hasPriorConversation, latestSnapshotData, isNewSession, snapshotDataNewestFirst, SNAPSHOT_ENTRY_TYPE } from "../lib/session.ts";
import { commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

test("selects the latest snapshot from the active branch", () => {
	const first = { enabled: true, step: 1 };
	const latest = { enabled: true, step: 2 };
	const branch = [
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: first },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: latest },
	];
	assert.equal(latestSnapshotData(branch), latest);
	assert.deepEqual(snapshotDataNewestFirst(branch), [latest, first]);
});

test("does not leak snapshots across an empty or unrelated branch", () => {
	assert.equal(latestSnapshotData([]), undefined);
	assert.equal(latestSnapshotData([{ type: "custom", customType: "other", data: true }]), undefined);
});

test("detects only model-context conversation roles", () => {
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "user" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "assistant" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "toolResult" } }]), true);
	assert.equal(hasPriorConversation([{ type: "message", message: { role: "bashExecution" } }]), false);
	assert.equal(hasPriorConversation([{ type: "custom", customType: "other" }]), false);
});

test("only genuinely new sessions are eligible for configured automatic activation", () => {
	const prior = [{ type: "message", message: { role: "user" } }];
	assert.equal(isNewSession("new", prior), true);
	assert.equal(isNewSession("startup", []), true);
	assert.equal(isNewSession("startup", prior), false);
	assert.equal(isNewSession("reload", []), false);
	assert.equal(isNewSession("resume", []), false);
	assert.equal(isNewSession("fork", []), false);
});

test("manual defaults ignore existing CWD state while configured new sessions inherit shared materialization", async () => {
	const h = harness({ cwd: "/tmp/state-flow-new-session" });
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.entries.length, 0);

	const global = emptyState();
	global.contract.shared = "global";
	const cwd = emptyState();
	cwd.contract.project = "cwd";
	cwd.working.next = "resume";
	writeGlobalState(global, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, cwd, h.repositoryRoot);
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.entries.length, 0);
	const automatic = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, autoStart: true });
	automatic.handlers.get("session_start")!({ reason: "new" }, automatic.ctx);
	assert.equal(automatic.statuses.at(-1), "<accent>state-flow</accent> <dim>#0</dim>");
	assert.deepEqual(automatic.resolveSnapshot().config, { enabled: true });
	assert.equal(automatic.resolveSnapshot().meta.step, 0);
	assert.deepEqual(automatic.entries.at(-1)!.data, { revision: automatic.resolveSnapshot().meta.durableBase });
	assert.equal(Object.hasOwn(automatic.entries.at(-1)!.data, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), emptyState());
	automatic.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: "base" }, automatic.ctx);
	const projected = automatic.handlers.get("context")!({ messages: [user("Continue", 1)] });
	assert.match(projected.messages[0].content[0].text, /"project":"cwd"/);
	assert.match(projected.messages[0].content[0].text, /"shared":"global"/);
	assert.match(projected.messages[0].content[0].text, /"next":"resume"/);
});

test("two Pi sessions in one CWD persist distinct Git-backed session layers", async () => {
	const first = harness({ cwd: "/tmp/state-flow-shared-cwd", sessionId: "session-a" });
	await start(first);
	await commitTerminal(first, { owner: "session-a" }, { next: "first" });

	const second = harness({
		cwd: first.ctx.cwd,
		repositoryRoot: first.repositoryRoot,
		sessionId: "session-b",
		autoStart: true,
	});
	second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
	assert.deepEqual(loadSessionState(first.ctx.cwd, "session-a", first.repositoryRoot), {
		...emptyState(), contract: { owner: "session-a" }, working: { next: "first" }, response: "Done",
	});
	assert.deepEqual(loadSessionState(first.ctx.cwd, "session-b", first.repositoryRoot), emptyState());
});

test("a stopped branch stays disabled on resume while the global flag enables a later new session", async () => {
	const h = harness({ cwd: "/tmp/state-flow-stopped-branch", autoStart: true });
	await start(h);
	await commitTerminal(h, { branch: "kept" }, { next: "later" });
	await h.commands.get("state-flow-stop")!.handler("", h.ctx);
	const stopped = structuredClone(h.entries.at(-1)!);

	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /config\.enabled=false; branch mode=inactive/);
	assert.match(h.notifications.at(-1)!, /Runtime metadata: step #2/);
	assert.match(h.notifications.at(-1)!, /"branch": "kept"/);

	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "next-session" });
	next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	assert.equal(next.statuses.at(-1), "<accent>state-flow</accent> <dim>#0</dim>");
	assert.notDeepEqual(next.entries.at(-1), stopped);
});

test("publishes a restored older session branch when shared scopes did not diverge", async () => {
	const h = harness({ cwd: "/tmp/state-flow-restored-session" });
	await start(h);
	await commitTerminal(h, {}, { branch: "base" });
	const baseBranch = structuredClone(h.entries);
	await commitTerminal(h, {}, { branch: "abandoned" });
	h.entries.splice(0, h.entries.length, ...baseBranch);
	h.handlers.get("session_tree")!({}, h.ctx);
	await commitTerminal(h, {}, { branch: "restored-next" });
	assert.equal(h.sentMessages.length, 0);
	assert.equal(
		loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.working.branch,
		"restored-next",
	);
});

test("contains hostile branch entries and continues snapshot discovery", () => {
	const hostile = Object.defineProperty({}, "type", {
		get() { throw new Error("hostile entry"); },
	});
	const valid = { enabled: true, step: 2 };
	const discovery = discoverSnapshotData([
		{ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: valid },
		hostile,
	]);
	assert.deepEqual(discovery.candidates, [valid]);
	assert.deepEqual(discovery.errors, ["hostile entry"]);
	assert.doesNotThrow(() => hasPriorConversation([hostile]));
});

test("restores State Flow from the active branch after tree navigation", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, { branch: "abandoned" }, { next: "old" });
	h.entries.splice(0, h.entries.length, {
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			specification: "Branch request",
			state: {
				contract: { branch: "active" },
				working: { next: "new" },
				response: "Branch response",
			},
			step: 4,
		},
	});
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#4</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"branch": "active"/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"branch": "abandoned"/);

	h.entries.splice(0, h.entries.length);
	h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /config\.enabled=false; branch mode=inactive/);
	assert.match(h.notifications.at(-1)!, /Runtime metadata: step #0/);
});
