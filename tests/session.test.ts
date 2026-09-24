import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionState, writeCwdState, writeGlobalState } from "./temporal-fixture.ts";
import { emptyState } from "../lib/state.ts";
import { discoverSnapshotData, findPassiveStopBoundary, hasPriorConversation, hasUncheckpointedConversation, latestSnapshotData, isNewSession, snapshotDataNewestFirst, SNAPSHOT_ENTRY_TYPE } from "../lib/session.ts";
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

test("passive Stop markers preserve uncompiled context only with explicit evidence and honor fork resets", () => {
	const entry = (data: unknown) => ({ type: "custom", customType: "state-flow-passive-stop", data });
	for (const preserveContext of [true, false, undefined, "true", 1]) {
		const branch = [entry({ at: 20, from: 10, preserveContext })];
		assert.deepEqual(findPassiveStopBoundary(branch, "owner", "state-flow-passive-stop"), {
			at: 20, from: 10, ...(preserveContext === true ? { preserveContext: true } : {}),
		});
		assert.equal(findPassiveStopBoundary([...branch, entry({ reset: true, owner: "owner" })], "owner", "state-flow-passive-stop"), undefined);
	}
});

test("failed Stop fences only its owner until a later supported checkpoint, without losing its context boundary", () => {
	const stop = (data: unknown) => ({ type: "custom", customType: "state-flow-passive-stop", data });
	const checkpoint = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	const data = { at: 20, from: 10, preserveContext: true, owner: "owner", persistenceError: "Writer advanced" };
	const boundary = { at: 20, from: 10, preserveContext: true, persistenceError: "Writer advanced" };
	const read = (entries: unknown[]) => findPassiveStopBoundary(entries as any[], "owner", "state-flow-passive-stop");
	assert.deepEqual(read([stop(data)]), boundary);
	assert.equal(read([stop({ ...data, owner: "parent" })]), undefined);
	assert.deepEqual(read([checkpoint({ disabled: true }), stop(data)]), boundary);
	assert.deepEqual(read([stop(data), checkpoint({ malformed: true })]), boundary);
	for (const accepted of [{ disabled: true }, { boundary: "accepted", enabled: true, step: 2 }]) {
		assert.deepEqual(read([stop(data), checkpoint(accepted)]), { at: 20, from: 10, preserveContext: true });
	}
	assert.equal(read([stop(data), stop({ reset: true, owner: "owner" })]), undefined);
	for (const persistenceError of [undefined, "", " ", false, 1]) {
		assert.deepEqual(read([stop({ ...data, persistenceError })]), { at: 20, from: 10, preserveContext: true });
	}
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

test("only a valid later checkpoint bounds uncheckpointed native conversation", () => {
	const checkpoint = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	assert.equal(hasUncheckpointedConversation([]), false);
	assert.equal(hasUncheckpointedConversation([{ type: "message", message: { role: "bashExecution" } }]), false);
	for (const role of ["user", "assistant", "toolResult"]) {
		const input = { type: "message", message: { role } };
		assert.equal(hasUncheckpointedConversation([input]), true);
		assert.equal(hasUncheckpointedConversation([input, checkpoint({ malformed: true })]), true);
		assert.equal(hasUncheckpointedConversation([input, { get type(): string { throw new Error("hostile entry"); } }]), true);
		for (const accepted of [{ disabled: true }, { boundary: "accepted", enabled: true, step: 2 }]) {
			assert.equal(hasUncheckpointedConversation([input, checkpoint(accepted)]), false);
			assert.equal(hasUncheckpointedConversation([checkpoint(accepted), input]), true);
		}
	}
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
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.entries.length, 0);

	const global = emptyState();
	global.contract.shared = "global";
	const cwd = emptyState();
	cwd.contract.project = "cwd";
	cwd.working.next = "resume";
	writeGlobalState(global, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, cwd, h.repositoryRoot);
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.entries.length, 0);
	const automatic = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, autoStart: true });
	await automatic.handlers.get("session_start")!({ reason: "new" }, automatic.ctx);
	assert.equal(automatic.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C0/S0</dim>");
	assert.deepEqual(automatic.resolveSnapshot().config, { enabled: true });
	assert.equal(automatic.resolveSnapshot().meta.step, 0);
	const checkpoint = automatic.entries.at(-1)!.data;
	assert.equal(typeof checkpoint.boundary, "string");
	assert.equal(checkpoint.enabled, true);
	assert.equal(checkpoint.step, 0);
	assert.equal(Object.hasOwn(automatic.entries.at(-1)!.data, "state"), false);
	assert.deepEqual(loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot), emptyState());
	automatic.beforeAgentStart("Continue");
	const projected = automatic.handlers.get("context")!({ messages: [user("Continue", 1)] });
	assert.match(projected.messages[0].content[0].text, /"project":"cwd"/);
	assert.match(projected.messages[0].content[0].text, /"shared":"global"/);
	assert.match(projected.messages[0].content[0].text, /"next":"resume"/);
});

test("two Pi sessions in one CWD persist distinct canonical session layers", async () => {
	const first = harness({ cwd: "/tmp/state-flow-shared-cwd", sessionId: "session-a" });
	await start(first);
	await commitTerminal(first, { owner: "session-a" }, { next: "first" });

	const second = harness({
		cwd: first.ctx.cwd,
		repositoryRoot: first.repositoryRoot,
		sessionId: "session-b",
		autoStart: true,
	});
	await second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
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

	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /config\.enabled=false; branch mode=inactive/);
	assert.match(h.notifications.at(-1)!, /Runtime metadata: step #2/);
	assert.match(h.notifications.at(-1)!, /"branch": "kept"/);

	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "next-session" });
	await next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	assert.equal(next.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C0/S0</dim>");
	assert.notDeepEqual(next.entries.at(-1), stopped);
});

test("publishes a restored older session branch when shared scopes did not diverge", async () => {
	const h = harness({ cwd: "/tmp/state-flow-restored-session" });
	await start(h);
	await commitTerminal(h, {}, { branch: "base" });
	const baseBranch = structuredClone(h.entries);
	await commitTerminal(h, {}, { branch: "abandoned" });
	h.entries.splice(0, h.entries.length, ...baseBranch);
	await h.handlers.get("session_tree")!({}, h.ctx);
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

test("restores State Flow from a canonical active branch pointer after tree navigation", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, { branch: "active" }, { next: "new" }, "Branch response");
	const activeBranch = structuredClone(h.entries);
	await commitTerminal(h, { branch: "abandoned" }, { next: "old" });
	h.entries.splice(0, h.entries.length, ...activeBranch);
	await h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>G0/C0/S2</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"branch": "active"/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"branch": "abandoned"/);
});
