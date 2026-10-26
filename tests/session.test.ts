import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { captureScopeSelection, type ScopeSelection } from "../lib/selection.ts";
import { prepareRetainedPolicyMigration } from "../lib/snapshot.ts";
import { OwnedOperationSlot, type OwnedOperation } from "../lib/operation.ts";
import { loadSessionState, writeCwdState, writeGlobalState, nativePolicyMarker } from "./temporal-fixture.ts";
import { emptyState } from "../lib/state.ts";
import { discoverSnapshotData, findBranchPolicy, findPassiveStopBoundary, hasPendingFork, hasPriorConversation, hasUncheckpointedConversation, latestSnapshotData, isNewSession, snapshotDataNewestFirst, SNAPSHOT_ENTRY_TYPE, prepareBranchCheckpointPolicy, captureSelectedNativeMarker, prepareSelectedBranchPolicy, NativeToolRequestCorrelation, SelectedPolicyLifetime, type SelectedBranchPolicyOptions, type SelectedNativeRequestPolicy } from "../lib/session.ts";
import { commitTerminal, harness, start, user } from "./harness.ts";

test("prepared module source guards bind to the original native provider context without revoking accepted tool batches", () => {
	const policy = new SelectedPolicyLifetime(); policy.select({ cwd: resolve("/provider-cwd"), owner: "owner", mode: "active", scopes: ["cwd"] });
	const requests = new NativeToolRequestCorrelation(), controller = new AbortController();
	requests.begin(policy.capture(), controller.signal, () => true, policy.signal);
	let current = true;
	const captured = requests.preparing();
	requests.bindPreparedContext(() => { assert.ok(current, "source obsolete"); });
	captured.revalidate(); current = false; assert.throws(captured.revalidate, /source obsolete/);
	current = true; requests.finalize([{ id: "read", name: "read_state" }]);
	current = false; requests.take("read", "read_state").revalidate();
	requests.end(); assert.throws(captured.revalidate, /native request/);
});

test("checkpoint policy preflight captures legacy defaults once and keeps explicit later policy independent of new defaults", () => {
	const entry = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	const defaults: ["cwd" | "session"] = ["cwd"];
	const original = entry({ mode: "off" });
	const candidate = prepareBranchCheckpointPolicy([original], defaults)!;
	defaults[0] = "session";
	assert.deepEqual(candidate.checkpoint.scopes, ["cwd"]);
	const branch = [original, entry(candidate.checkpoint), { type: "message", message: { role: "user" } }];
	const before = structuredClone(branch);
	const retained = prepareBranchCheckpointPolicy(branch, defaults)!;
	assert.equal(retained.sourceVersion, 2);
	assert.deepEqual(retained.checkpoint.scopes, ["cwd"]);
	assert.deepEqual(branch, before);
	assert.equal(prepareBranchCheckpointPolicy([], defaults), undefined);
	assert.equal(prepareBranchCheckpointPolicy([{ type: "custom", customType: "foreign", data: { version: 99 } }], defaults), undefined);
});

test("checkpoint preflight never falls through a malformed latest owned snapshot to an older wider policy", () => {
	const entry = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	const old = entry({ version: 2, mode: "off", scopes: ["global", "cwd", "session"] });
	for (const data of [undefined, null, { version: 3, mode: "off", scopes: ["cwd"] }, { mode: "off", scopes: ["cwd"] }, { version: 2, mode: "active", scopes: [] }]) {
		assert.throws(() => prepareBranchCheckpointPolicy([old, entry(data)], ["global"]));
	}
	const unreadable = { type: "custom", customType: SNAPSHOT_ENTRY_TYPE, get data() { throw new Error("Owned policy unreadable"); } };
	assert.throws(() => prepareBranchCheckpointPolicy([old, unreadable], ["global"]), /Owned policy unreadable/);
	const foreign = { get type(): string { throw new Error("Unclassifiable foreign entry"); } };
	assert.deepEqual(prepareBranchCheckpointPolicy([old, foreign], ["cwd"])!.checkpoint.scopes, ["global", "cwd", "session"]);
});

test("branch policy reads only mode and owner-local native write fences", () => {
	const checkpoint = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	const stop = (data: unknown) => ({ type: "custom", customType: "stop", data });
	const off = checkpoint({ mode: "off", get boundary() { throw new Error("Memory boundary inspected"); } });
	const active = checkpoint({ mode: "active", step: -1 });
	const fence = stop({ owner: "owner", at: 1, mode: "off", persistenceError: "paused" });
	const read = (branch: any[], entryType: string | undefined = "stop") => findBranchPolicy(branch, "owner", entryType, "passive");
	assert.deepEqual(read([active, off]), { mode: "off" });
	assert.deepEqual(read([off, active]), { mode: "active" });
	assert.deepEqual(read([active, fence]), { mode: "off", persistenceError: "paused" });
	assert.deepEqual(read([fence, active]), { mode: "active" });
	assert.deepEqual(findBranchPolicy([active, fence], "owner", undefined, "passive"), { mode: "active" });
	assert.deepEqual(read([active, stop({ owner: "foreign", at: 1, mode: "off", persistenceError: "paused" })]), { mode: "active" });
	assert.equal(read([fence, stop({ owner: "owner", reset: true })]), undefined);
	assert.deepEqual(read([active, fence, stop({ owner: "owner", reset: true })]), { mode: "active" });
	assert.deepEqual(findBranchPolicy([active, fence], undefined, "stop", "passive"), { mode: "off", persistenceError: "paused" });
	assert.deepEqual(read([checkpoint({ enabled: false })]), { mode: "passive" });
	assert.deepEqual(read([checkpoint({ disabled: true })]), { mode: "passive" });
	assert.equal(read([]), undefined);
});

test("pending fork bookkeeping belongs to the child and ends only at its accepted reset", () => {
	const marker = (data: unknown) => ({ type: "custom", customType: "stop", data });
	const pending = marker({ owner: "child", forkPending: true });
	assert.equal(hasPendingFork([], "child", "stop"), false);
	assert.equal(hasPendingFork([pending], "child", "stop"), true);
	assert.equal(hasPendingFork([pending], "other-child", "stop"), false);
	assert.equal(hasPendingFork([pending, marker({ owner: "child", reset: true })], "child", "stop"), false);
	assert.equal(hasPendingFork([pending, marker({ owner: "parent", reset: true })], "child", "stop"), true);
});

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

test("accepted v2 checkpoints bound compiled conversation; policy-only captures and malformed epochs cannot", () => {
	const input = { type: "message", message: { role: "user" } };
	const checkpoint = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	for (let mask = 1; mask < 8; mask++) {
		const scopes = (["global", "cwd", "session"] as const).filter((_, bit) => (mask & (1 << bit)) !== 0);
		const accepted = { version: 2, mode: "active", scopes, boundary: "accepted", step: 2 };
		assert.equal(hasUncheckpointedConversation([input, checkpoint(accepted)]), false);
		assert.equal(hasUncheckpointedConversation([checkpoint(accepted), input]), true);
		for (const data of [{ version: 2, mode: "off", scopes }, { ...accepted, step: -1 }, { ...accepted, scopes: [] }, { ...accepted, version: 99 }]) {
			assert.equal(hasUncheckpointedConversation([input, checkpoint(data)]), true);
		}
		assert.equal(hasUncheckpointedConversation([input, { type: "custom", customType: "state-flow-passive-stop", data: { ...nativePolicyMarker("child", "off"), scopes } }]), true);
	}
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
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker("harness-session", "off")]);

	const global = emptyState();
	global.strategy.shared = "global";
	const cwd = emptyState();
	cwd.strategy.project = "cwd";
	cwd.tactics.next = "resume";
	writeGlobalState(global, h.repositoryRoot);
	writeCwdState(h.ctx.cwd, cwd, h.repositoryRoot);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker("harness-session", "off")]);
	const automatic = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, mode: "active" });
	await automatic.handlers.get("session_start")!({ reason: "new" }, automatic.ctx);
	assert.equal(automatic.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
	assert.deepEqual(automatic.resolveSnapshot().config, { mode: "active" });
	assert.equal(automatic.resolveSnapshot().meta.step, 0);
	const checkpoint = automatic.entries.at(-1)!.data;
	assert.equal(typeof checkpoint.boundary, "string");
	assert.equal(checkpoint.mode, "active");
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
		mode: "active",
	});
	await second.handlers.get("session_start")!({ reason: "new" }, second.ctx);
	assert.deepEqual(loadSessionState(first.ctx.cwd, "session-a", first.repositoryRoot), {
		...emptyState(), strategy: { owner: "session-a" }, tactics: { next: "first" }, response: "Done",
	});
	assert.deepEqual(loadSessionState(first.ctx.cwd, "session-b", first.repositoryRoot), emptyState());
});

test("an Off branch stays Off on resume while the Active default applies to a later new session", async () => {
	const h = harness({ cwd: "/tmp/state-flow-offped-branch", mode: "active" });
	await start(h);
	await commitTerminal(h, { branch: "kept" }, { next: "later" });
	await h.commands.get("state-flow-off")!.handler("", h.ctx);
	const stopped = structuredClone(h.entries.at(-1)!);

	await h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "off");
	assert.doesNotMatch(h.notifications.at(-1)!, /session mode=/);
	assert.match(h.notifications.at(-1)!, /Temporal materialization unavailable/);
	assert.doesNotMatch(h.notifications.at(-1)!, /Runtime metadata|"branch": "kept"/);

	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "next-session", mode: "active" });
	await next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	assert.equal(next.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
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
		loadSessionState(h.ctx.cwd, "harness-session", h.repositoryRoot)!.tactics.branch,
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

test("tree navigation restores the branch mode but keeps current memory", async () => {
	const h = harness();
	await start(h);
	await commitTerminal(h, { branch: "active" }, { next: "new" }, "Branch response");
	const activeBranch = structuredClone(h.entries);
	await commitTerminal(h, { branch: "abandoned" }, { next: "old" });
	h.entries.splice(0, h.entries.length, ...activeBranch);
	await h.handlers.get("session_tree")!({}, h.ctx);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>active</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"branch": "abandoned"/, "memory is the current JSON state, not the branch step's revision");
});

{
	const order = ["global", "cwd", "session"] as const;
	const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection(order.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
	const checkpoint = (data: unknown) => ({ type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data });
	const marker = (data: unknown) => ({ type: "custom", customType: "native-marker", data });
	const policy = (mode = "active", scopes: readonly string[] = ["cwd"]) => ({ version: 2, mode, scopes, ...(mode === "active" ? { boundary: "accepted", step: 3 } : {}) });
	const local = (mode = "off", scopes: readonly string[] = ["session"]) => ({ version: 2, owner: "child", mode, scopes });
	const options = (scopes: ScopeSelection = ["global", "cwd", "session"]): SelectedBranchPolicyOptions => ({ owner: "child", markerEntryType: "native-marker", defaults: { mode: "off", scopes } });
	const resolve = (branch: unknown[], extra: Partial<SelectedBranchPolicyOptions> = {}) => prepareSelectedBranchPolicy(branch as any[], { ...options(), ...extra });

	test("closed native marker v2 captures all policies and distinct policy/Stop/fork/reset shapes without granting memory", () => {
		for (const scopes of selections) for (const mode of ["active", "passive", "off"] as const) {
			const input = { version: 2, owner: "child", mode, scopes: [...scopes] };
			const captured = captureSelectedNativeMarker(input);
			input.scopes.reverse(); assert.deepEqual(captured.scopes, scopes); assert.equal(Object.isFrozen(captured.scopes), true);
			assert.deepEqual(captureSelectedNativeMarker({ ...input, scopes, forkPending: true }).scopes, scopes);
			assert.deepEqual(captureSelectedNativeMarker({ ...input, scopes, reset: true }).scopes, scopes);
			if (mode !== "active") assert.equal(captureSelectedNativeMarker({ ...input, scopes, at: 20, from: 10, preserveContext: true, persistenceError: "paused", ...(mode === "off" ? { memoryDeferred: true } : {}) }).at, 20);
		}
		for (const invalid of [
			{ owner: "child", reset: true }, { ...local(), scopes: [] }, { ...local(), scopes: ["cwd", "cwd"] },
			{ ...local(), owner: "" }, { ...local(), mode: "unknown" }, { ...local(), state: {} },
			{ ...local(), reset: true, forkPending: true }, { ...local(), reset: true, at: 1 }, { ...local(), at: -1 },
			{ ...local(), at: 1, preserveContext: false }, { ...local(), at: 1, persistenceError: " " },
			{ ...local("active"), at: 1 }, { ...local("passive"), at: 1, memoryDeferred: true },
			{ ...local(), from: 1 }, { ...local(), persistenceError: "no boundary" },
		]) assert.throws(() => captureSelectedNativeMarker(invalid));
		for (const version of [1, 3, "legacy", null]) {
			const future = { version, owner: "child", get mode(): never { return assert.fail("unsupported epoch payload"); } };
			assert.throws(() => captureSelectedNativeMarker(future), /Unsupported.*marker version/);
		}
	});

	test("absence/legacy defaults capture once for every subset; subsequent native capture and mode-only records retain concrete policy", () => {
		for (const scopes of selections) for (const mode of ["active", "passive", "off"] as const) {
			const config = { mode, scopes: [...scopes] as unknown as ScopeSelection };
			const original = prepareSelectedBranchPolicy([], { ...options(scopes), defaults: config });
			assert.equal(original.mode, mode); assert.deepEqual(original.scopes, scopes); assert.equal(original.source, "default");
			assert.equal(original.requiresCapture, true); assert.equal(original.forkPending, false);
			const branch = [marker(original.capture)]; const before = structuredClone(branch);
			const next = resolve(branch, { defaults: { mode: "off", scopes: ["global"] } });
			assert.equal(next.mode, mode); assert.deepEqual(next.scopes, scopes); assert.equal(next.requiresCapture, false);
			const legacyModeOnly = resolve([...branch, checkpoint({ mode: "off" })], { defaults: { mode: "active", scopes: ["global"] } });
			assert.equal(legacyModeOnly.mode, "off"); assert.deepEqual(legacyModeOnly.scopes, scopes); assert.equal(legacyModeOnly.requiresCapture, true);
			assert.deepEqual(branch, before);
		}
		const defaults: ["cwd" | "session"] = ["cwd"];
		const initial = prepareSelectedBranchPolicy([checkpoint({ mode: "off" })], options(defaults)); defaults[0] = "session";
		assert.deepEqual(initial.scopes, ["cwd"]); assert.deepEqual(initial.capture.scopes, ["cwd"]);
	});

	test("chronological branch policy preserves scope choices across legacy mode/Stop/reset operations and explicit v2 overrides", () => {
		const start = checkpoint(policy("active", ["cwd"]));
		const off = marker({ owner: "child", at: 10, mode: "off", memoryDeferred: true });
		const stopped = resolve([start, off]); assert.equal(stopped.mode, "off"); assert.deepEqual(stopped.scopes, ["cwd"]);
		const selected = marker({ ...local("off", ["session"]), at: 11, memoryDeferred: true });
		const beforeReset = resolve([start, selected]); assert.equal(beforeReset.mode, "off"); assert.deepEqual(beforeReset.scopes, ["session"]);
		const legacyReset = resolve([start, selected, marker({ owner: "child", reset: true })]);
		assert.equal(legacyReset.mode, "active"); assert.deepEqual(legacyReset.scopes, ["session"]); assert.equal(legacyReset.requiresCapture, true);
		const accepted = resolve([start, selected, marker({ ...local("passive", ["cwd", "session"]), reset: true })]);
		assert.equal(accepted.mode, "passive"); assert.deepEqual(accepted.scopes, ["cwd", "session"]); assert.equal(accepted.stop, undefined);
		assert.equal(accepted.forkPending, false); assert.equal(accepted.requiresCapture, false);
		const laterCheckpoint = resolve([selected, checkpoint(policy("active", ["global"]))]);
		assert.equal(laterCheckpoint.mode, "active"); assert.deepEqual(laterCheckpoint.scopes, ["global"]);
	});

	test("legacy Stop keeps its cutoff when an old optional run anchor is invalid, while v2 anchors stay strict", () => {
		for (const scopes of selections) for (const owner of [undefined, "child"]) for (const from of [-1, "old-invalid-anchor", 0, 5]) {
			const input = { ...(owner === undefined ? {} : { owner }), at: 10, from };
			const selected = resolve([checkpoint(policy("passive", scopes)), marker(input)]);
			assert.equal(selected.mode, "passive"); assert.deepEqual(selected.scopes, scopes);
			assert.deepEqual(selected.stop, { at: 10, ...(typeof from === "number" && from >= 0 ? { from } : {}) });
			if (typeof from !== "number" || from < 0) assert.throws(() => captureSelectedNativeMarker({ ...local("passive", scopes), at: 10, from }));
		}
	});

	test("local fences survive policy-only capture and Off; accepted checkpoint/reset clears the fence without fabricated context", () => {
		const start = checkpoint(policy());
		const failed = marker({ owner: "child", at: 10, from: 5, preserveContext: true, persistenceError: "writer advanced", mode: "passive" });
		const off = marker({ ...local("off", ["cwd"]), at: 20, memoryDeferred: true });
		const activeChoice = marker(local("active", ["session"]));
		const pending = resolve([start, failed, off, activeChoice]);
		assert.equal(pending.mode, "active"); assert.deepEqual(pending.scopes, ["session"]);
		assert.equal(pending.persistenceError, "writer advanced"); assert.equal(pending.stop!.at, 20);
		assert.equal(pending.capture.at, undefined); assert.equal(pending.capture.reset, undefined);
		const recaptured = resolve([start, failed, off, activeChoice, marker(pending.capture)]);
		assert.equal(recaptured.persistenceError, "writer advanced");
		const policyOnlyCheckpoint = resolve([start, failed, checkpoint(policy("off", ["session"]))]);
		assert.equal(policyOnlyCheckpoint.mode, "off"); assert.equal(policyOnlyCheckpoint.persistenceError, "writer advanced", "policy-only checkpoint cannot certify canonical acceptance");
		const accepted = resolve([start, failed, off, checkpoint({ ...policy("passive", ["session"]), boundary: "new-accepted", step: 4 })]);
		assert.equal(accepted.persistenceError, undefined); assert.equal(accepted.stop!.at, 20);
		assert.equal(accepted.stop!.persistenceError, undefined);
		const reset = resolve([start, failed, marker({ ...local("active", ["cwd"]), reset: true })]);
		assert.equal(reset.persistenceError, undefined); assert.equal(reset.stop, undefined);
		const unowned = resolve([start, marker({ at: 30, from: 20, preserveContext: true, persistenceError: "unowned" })]);
		assert.equal(unowned.mode, "active"); assert.equal(unowned.persistenceError, undefined); assert.equal(unowned.stop!.preserveContext, true);
	});

	test("fresh/cold pending forks inherit source policy without parent reads but never inherit parent fence, context or reset authority", () => {
		const source = [checkpoint(policy("active", ["global", "cwd"])), marker({ ...local("off", ["session"]), owner: "parent", at: 20, memoryDeferred: true, persistenceError: "parent-only fence", forkPending: true })];
		const fork = resolve(source, { fork: true });
		assert.equal(fork.mode, "off"); assert.deepEqual(fork.scopes, ["session"]); assert.equal(fork.forkPending, true);
		assert.equal(fork.persistenceError, undefined); assert.equal(fork.stop, undefined); assert.equal(fork.requiresCapture, true);
		assert.equal(fork.capture.owner, "child"); assert.equal(fork.capture.forkPending, true);
		const child = [...source, marker(fork.capture)];
		const cold = resolve(child, { defaults: { mode: "active", scopes: ["global"] } });
		assert.equal(cold.mode, "off"); assert.deepEqual(cold.scopes, ["session"]); assert.equal(cold.forkPending, true); assert.equal(cold.requiresCapture, false);
		const foreignReset = marker({ ...local("active", ["global"]), owner: "parent", reset: true });
		const stillChild = resolve([...child, foreignReset]); assert.equal(stillChild.forkPending, true); assert.equal(stillChild.mode, "off"); assert.deepEqual(stillChild.scopes, ["session"]);
		const checkpointAlone = resolve([...child, checkpoint(policy("active", ["session"]))]); assert.equal(checkpointAlone.forkPending, true);
		const finished = resolve([...child, marker({ ...local("active", ["session"]), reset: true })]); assert.equal(finished.forkPending, false);
		const legacyCold = resolve([...source, marker({ owner: "child", forkPending: true })]);
		assert.equal(legacyCold.mode, "off"); assert.deepEqual(legacyCold.scopes, ["session"]); assert.equal(legacyCold.requiresCapture, true);
	});

	test("latest malformed owned policy cannot fall back or be repaired by mode-only legacy data; explicit valid v2 policy may replace known malformed policy", () => {
		const wider = checkpoint(policy("active", ["global", "cwd", "session"]));
		const invalid = [undefined, null, { version: 99, mode: "off", scopes: ["session"] }, { version: 2, mode: "active", scopes: [] }, { mode: "off", scopes: ["session"] }, { mode: "active", step: -1 }];
		for (const value of invalid) {
			assert.throws(() => resolve([wider, checkpoint(value)]), /policy is invalid or unsupported/);
			assert.throws(() => resolve([wider, checkpoint(value), checkpoint({ mode: "off" })]), /policy is invalid or unsupported/);
			const repaired = resolve([wider, checkpoint(value), marker(local("off", ["session"]))]);
			assert.equal(repaired.mode, "off"); assert.deepEqual(repaired.scopes, ["session"]);
		}
		for (const value of [{ ...local(), scopes: null }, { owner: "child", at: 1, scopes: ["session"] }, { ...local(), extra: true }]) {
			assert.throws(() => resolve([wider, marker(value)]), /policy is invalid or unsupported/);
			assert.deepEqual(resolve([wider, marker(value), marker(local("off", ["cwd"]))]).scopes, ["cwd"]);
		}
		const secret = "private native payload";
		const unreadable = { type: "custom", customType: SNAPSHOT_ENTRY_TYPE, get data(): never { throw new Error(secret); } };
		assert.throws(() => resolve([wider, unreadable]), error => error instanceof Error && !error.message.includes(secret) && error.cause === undefined);
		const future = { version: 99, owner: "child", get scopes(): never { return assert.fail("future marker payload"); } };
		assert.throws(() => resolve([wider, marker(future)]), /Unsupported.*marker version/);
		assert.deepEqual(resolve([wider, marker(future), marker({ ...local("off", ["session"]), reset: true })]).scopes, ["session"]);
		const unreadableVersion = { get version(): never { throw new Error(secret); } };
		assert.throws(() => prepareRetainedPolicyMigration(unreadableVersion, ["session"]), error => error instanceof Error && !error.message.includes(secret) && error.cause === undefined);
		assert.throws(() => resolve([wider, marker({ ...local(), get version(): never { throw new Error(secret); } })]), error => error instanceof Error && !error.message.includes(secret) && error.cause === undefined);
		const nextEpoch = { version: 99, get boundary(): never { return assert.fail("future snapshot payload"); } };
		assert.throws(() => prepareRetainedPolicyMigration(nextEpoch, ["session"]), /Unsupported.*native policy version/);
		assert.throws(() => resolve([wider, checkpoint(nextEpoch)]), /policy is invalid or unsupported/);
	});

	test("foreign owner payloads and unclassifiable entries are inert; malformed actual local markers stay fail-closed", () => {
		const chosen = checkpoint(policy("active", ["cwd"]));
		const foreign = marker({ owner: "foreign", version: 999, get scopes(): never { return assert.fail("foreign scopes"); }, get persistenceError(): never { return assert.fail("foreign error"); } });
		const hostile = { get type(): never { return assert.fail("unclassifiable identity"); } };
		// Identity classification contains a hostile foreign entry rather than supplying policy from it.
		assert.deepEqual(resolve([chosen, foreign, hostile]).scopes, ["cwd"]);
		assert.throws(() => resolve([chosen, marker({ ...local(), forkPending: false })]), /Invalid.*native policy marker/);
		assert.throws(() => resolve([chosen], { owner: "" }), /policy context/);
		assert.throws(() => resolve([chosen], { markerEntryType: SNAPSHOT_ENTRY_TYPE }), /policy context/);
		assert.throws(() => resolve([chosen], { defaults: { mode: "off", scopes: [] as any } }), /scopes/);
	});

	test("selected native resolution and capture are pure bookkeeping even for Off pending forks and physical write fences", () => {
		const open = fs.openSync, stat = fs.lstatSync, read = fs.readFileSync;
		let io = 0;
		fs.openSync = (() => { io++; return assert.fail("native admission opened a file"); }) as typeof fs.openSync;
		fs.lstatSync = (() => { io++; return assert.fail("native admission observed a path"); }) as typeof fs.lstatSync;
		fs.readFileSync = (() => { io++; return assert.fail("native admission read parent/store data"); }) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			const branch = [checkpoint(policy("active", ["cwd"])), marker({ ...local("off", ["session"]), forkPending: true, at: 10, memoryDeferred: true, persistenceError: "local fence" })];
			const before = structuredClone(branch), result = resolve(branch);
			assert.equal(result.mode, "off"); assert.equal(result.forkPending, true); assert.equal(result.persistenceError, "local fence");
			assert.deepEqual(result.capture.scopes, ["session"]); assert.deepEqual(branch, before); assert.equal(io, 0);
		} finally { fs.openSync = open; fs.lstatSync = stat; fs.readFileSync = read; syncBuiltinESMExports(); }
	});
}

{
	const selections = Array.from({ length: 7 }, (_, mask) => captureScopeSelection((["global", "cwd", "session"] as const).filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0)));
	const policy = (value: Partial<SelectedNativeRequestPolicy> = {}): SelectedNativeRequestPolicy => ({ cwd: resolve("/native/workspace"), owner: "owner", mode: "active", scopes: ["session"], ...value });

	test("selected native request policies capture all subsets and modes; equal choices preserve independent requests", () => {
		for (const scopes of selections) for (const mode of ["off", "passive", "active"] as const) {
			const lifetime = new SelectedPolicyLifetime(), mutable = [...scopes];
			lifetime.select(policy({ mode, scopes: mutable as any }));
			mutable.splice(0); assert.deepEqual(lifetime.policy!.scopes, scopes);
			assert.equal(Object.isFrozen(lifetime.policy), true); assert.equal(Object.isFrozen(lifetime.policy!.scopes), true);
			if (mode === "off") { assert.throws(() => lifetime.capture(), /Off cannot capture/); continue; }
			const a = lifetime.capture(), b = lifetime.capture();
			assert.notEqual(a, b); assert.equal(a.signal, b.signal); assert.equal(Object.isFrozen(a), true);
			lifetime.select(policy({ mode, cwd: "/native/workspace/../workspace", scopes: [...scopes].reverse() as any }));
			a.revalidate(); b.revalidate(); assert.equal(a.signal.aborted, false);
			const slot = new OwnedOperationSlot<OwnedOperation>();
			const owner = slot.claim({ controller: new AbortController() }); slot.release(owner);
			a.revalidate(); b.revalidate(); assert.equal(owner.controller.signal.aborted, false);
		}
	});

	test("invalid policy never revokes current work, and caller data/errors cannot leak through capture", () => {
		const lifetime = new SelectedPolicyLifetime();
		assert.equal(lifetime.policy, undefined); assert.throws(() => lifetime.capture(), /unavailable/);
		lifetime.select(policy()); const request = lifetime.capture();
		const secret = "private malformed source";
		for (const bad of [null, {}, { ...policy(), version: 2 }, { ...policy(), [Symbol("extra")]: true },
			{ ...policy(), cwd: "relative" }, { ...policy(), owner: " " }, { ...policy(), mode: "enabled" },
			{ ...policy(), scopes: [] }, { ...policy(), scopes: ["session", "session"] },
			Object.create(policy()), { ...policy(), get mode(): never { throw new Error(secret); } }]) {
			assert.throws(() => lifetime.select(bad as any), error => error instanceof Error && error.message === "Invalid State Flow selected request policy" && error.cause === undefined);
			request.revalidate(); assert.equal(request.signal.aborted, false);
		}
	});

	test("mode, scope, physical owner and CWD changes revoke immediately, including ABA and same-policy branch invalidation", () => {
		for (const replacement of [policy({ mode: "off" }), policy({ mode: "passive" }), policy({ scopes: ["cwd"] }), policy({ owner: "child" }), policy({ cwd: "/native/other" })]) {
			const lifetime = new SelectedPolicyLifetime(); lifetime.select(policy()); const old = lifetime.capture();
			let cancelled = false; old.signal.addEventListener("abort", () => { cancelled = true; assert.throws(old.revalidate, /no longer current/); });
			lifetime.select(replacement); assert.equal(cancelled, true); assert.equal(old.signal.aborted, true);
			lifetime.select(policy()); const current = lifetime.capture();
			assert.notEqual(current.signal, old.signal); assert.throws(old.revalidate, /no longer current/);
			lifetime.invalidate(); assert.equal(current.signal.aborted, true); assert.throws(current.revalidate, /no longer current/);
			const renewed = lifetime.capture(); lifetime.select(policy()); renewed.revalidate();
		}
	});

	test("synchronous abort listeners see replacement policy/lifetime and cannot reopen shutdown or overwrite reentrant choice", () => {
		const lifetime = new SelectedPolicyLifetime(); lifetime.select(policy()); const a = lifetime.capture();
		let b: ReturnType<SelectedPolicyLifetime["capture"]> | undefined;
		a.signal.addEventListener("abort", () => { b = lifetime.capture(); assert.equal(b.policy.mode, "passive"); lifetime.select(policy({ owner: "child" })); }, { once: true });
		lifetime.select(policy({ mode: "passive" }));
		assert.equal(lifetime.policy!.owner, "child"); assert.equal(b!.signal.aborted, true); assert.throws(b!.revalidate, /no longer current/);
		const current = lifetime.capture(); current.signal.addEventListener("abort", () => {
			assert.equal(lifetime.policy, undefined); assert.throws(() => lifetime.capture(), /unavailable/);
			assert.throws(() => lifetime.select(policy()), /has ended/); lifetime.invalidate();
		}, { once: true });
		lifetime.end(); lifetime.end(); assert.equal(current.signal.aborted, true); assert.throws(current.revalidate, /no longer current/);
	});
}

{
	function fixture() {
		const policy = new SelectedPolicyLifetime(); policy.select({ cwd: "/native", owner: "owner", mode: "active", scopes: ["session"] });
		const calls = new NativeToolRequestCorrelation(), operation = new AbortController();
		let currentIdentity = true;
		const begin = () => calls.begin(policy.capture(), operation.signal, () => currentIdentity);
		return { policy, calls, operation, begin, move: () => { currentIdentity = false; } };
	}
	test("native request correlation admits only finalized matching IDs once, with explicit nested-parent evidence", () => {
		const f = fixture(); f.begin();
		assert.throws(() => f.calls.check("patch", "patch_state"), /no current/);
		f.calls.finalize([{ id: "patch", name: "patch_state" }, { id: "outer", name: "codemode" }]);
		assert.throws(() => f.calls.check("patch", "read_state"), /no current/);
		assert.throws(() => f.calls.check("unknown", "read_state"), /no current/);
		const request = f.calls.take("patch", "patch_state"); request.revalidate();
		assert.throws(() => f.calls.take("patch", "patch_state"), /already consumed/);
		assert.throws(() => f.calls.nested("outer/1", "read_state", "guessed-parent"), /no current/);
		assert.throws(() => f.calls.nested("outer", "read_state", "outer"), /no current/);
		f.calls.nested("child", "read_state", "outer"); f.calls.nested("child", "read_state", "outer");
		f.calls.take("child", "read_state").revalidate();
		f.calls.end(); assert.equal(request.signal.aborted, true); assert.throws(request.revalidate, /turn has ended/);
		assert.equal(f.calls.has("patch"), false);
	});

	test("native policy ABA, native Abort and physical identity movement revoke already admitted tool leases", () => {
		for (const change of ["policy", "abort", "identity"] as const) {
			const f = fixture(); f.begin(); f.calls.finalize([{ id: "call", name: "read_state" }]); const lease = f.calls.take("call", "read_state");
			if (change === "policy") { const previous = f.policy.policy!; f.policy.select({ ...previous, scopes: ["cwd"] }); f.policy.select(previous); }
			else if (change === "abort") f.operation.abort();
			else f.move();
			assert.throws(lease.revalidate); if (change !== "identity") assert.equal(lease.signal.aborted, true);
		}
	});

	test("overlapping turns, duplicate/finalized assistant batches and Off-origin requests cannot be repaired by guessing current policy", () => {
		const f = fixture(); f.begin(); f.begin(); f.calls.finalize([{ id: "call", name: "patch_state" }]);
		assert.throws(() => f.calls.check("call", "patch_state"), /no current/);
		f.calls.end(); f.begin(); f.calls.finalize([{ id: "call", name: "patch_state" }, { id: "call", name: "read_state" }]);
		assert.throws(() => f.calls.current(), /no current/);
		f.calls.end(); f.begin(); f.calls.finalize([]); f.calls.finalize([{ id: "call", name: "patch_state" }]);
		assert.throws(() => f.calls.current(), /no current/);
		f.calls.end(); f.calls.begin(undefined, f.operation.signal, () => true); f.calls.finalize([{ id: "call", name: "patch_state" }]);
		assert.throws(() => f.calls.current(), /no current/);
		f.calls.end(); f.begin(); f.calls.finalize([{ id: "fresh", name: "read_state" }]); f.calls.take("fresh", "read_state").revalidate();
	});
}

test("native pre-provider lease is stable, phase-bound and includes Off control cancellation without granting memory", () => {
	for (const mode of ["active", "passive", "off"] as const) {
		const policy = new SelectedPolicyLifetime(); policy.select({ cwd: "/native", owner: "owner", mode, scopes: ["cwd"] });
		const turn = new NativeToolRequestCorrelation();
		assert.throws(() => turn.preparing(), /no current native request/);
		turn.begin(mode === "off" ? undefined : policy.capture(), policy.signal, () => true);
		const lease = turn.preparing(); assert.equal(lease, turn.preparing()); lease.revalidate();
		if (mode === "off") assert.throws(() => policy.capture(), /Off cannot capture/);
		turn.finalize([]); assert.throws(lease.revalidate, /no current native request/);
		turn.end(); assert.equal(lease.signal.aborted, true);
		turn.begin(mode === "off" ? undefined : policy.capture(), policy.signal, () => true);
		const old = turn.preparing(); const selected = policy.policy!;
		policy.select({ ...selected, owner: "other" }); policy.select(selected);
		assert.equal(old.signal.aborted, true); assert.throws(old.revalidate, /current/);
	}
});
