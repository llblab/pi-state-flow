import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hashArtifactSource, ORDINARY_ARTIFACT_COMPILER } from "../lib/artifact.ts";
import { TemporalRuntime } from "../lib/runtime.ts";
import { resolveGitPushDestination } from "../lib/git.ts";
import { loadPublicationQueue, publicationQueuePath } from "../lib/publication.ts";
import { temporalScopePaths } from "../lib/durable.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { hashSkillSource, SKILL_ARTIFACT_COMPILER } from "../lib/skills.ts";
import {
	cwdScopePaths,
	durablePaths,
	initializeCwdState,
	loadCwdMaterialization,
	loadCwdProvenance,
	loadCwdState,
	loadGlobalMaterialization,
	loadGlobalProvenance,
	loadGlobalState,
	loadSessionMaterialization,
	loadSessionState,
	writeGlobalState,
} from "./temporal-fixture.ts";
import {
	resolvedSnapshot as latestSnapshot,
	realPiFixture,
	nativeSessionKey,
	runGit,
	snapshots,
	type RealPiFixture,
} from "./pi-harness.ts";

function scopedResponses(transitions: Array<{ scope: "session" | "cwd" | "global"; patch: unknown }>, answer: string) {
	return [
		fauxAssistantMessage(
			fauxToolCall("patch_state", { ...Object.fromEntries(transitions.map(({ scope, patch }) => [scope, patch])), final: true }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(answer),
	];
}

function sessionResponses(patch: unknown, answer: string) {
	return scopedResponses([{ scope: "session", patch }], answer);
}

function unchangedResponses(answer: string) {
	return [
		fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage(answer),
	];
}

function durableSession(fixture: RealPiFixture, session: any) {
	return loadSessionState(
		fixture.cwd,
		session.sessionManager.getSessionId(),
		fixture.repositoryRoot,
		nativeSessionKey(session),
	)!;
}

test("real Pi preserves branch-local state through compaction, tree navigation, stop, and restart", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());

	assert.equal(fixture.statuses.at(-1), undefined);
	assert.equal(snapshots(session).length, 0);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	const key = nativeSessionKey(session);
	assert.equal(key, basename(session.sessionManager.getSessionFile()!, ".jsonl"));
	assert.equal(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, key).directory,
		join(fixture.repositoryRoot, `--${fixture.cwd.slice(1).replaceAll("/", "-")}--`, key));
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), "2");
	// turn-end activation commits locally first; the asynchronous worker replicates them afterwards.
	const activationDestination = resolveGitPushDestination(fixture.repositoryRoot)!;
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(publicationQueuePath(activationDestination)); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(runGit(fixture.remote, "rev-list", "--count", "refs/heads/main"), "2");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.deepEqual(latestSnapshot(session).config, { enabled: true });
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ autoStart: true }));
	const nextSession = await fixture.createSession("new");
	assert.equal(latestSnapshot(nextSession).config.enabled, true);
	assert.equal(nextSession.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(nextSession).meta.step, 0);
	nextSession.dispose();

	fixture.faux.setResponses(sessionResponses({
		contract: { constraint: "preserve branch causality" },
		working: { nextCheck: "inspect active branch" },
	}, "Base branch saved."));
	await session.prompt("Create the base checkpoint");
	const base = snapshots(session).at(-1)!;
	assert.equal(latestSnapshot(session, base.data).meta.step, 2);

	fixture.faux.setResponses([fauxAssistantMessage("Compacted State Flow integration history.")]);
	const compacted = await session.compact("Keep the State Flow checkpoint");
	assert.match(compacted.summary, /Compacted State Flow integration history/);
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), true);

	fixture.faux.setResponses(sessionResponses({
		working: { branch: "future", nextCheck: "return to base" },
	}, "Future branch saved."));
	await session.prompt("Advance the future branch");
	await session.prompt("/state-flow-stop");
	const stopped = snapshots(session).at(-1)!;
	assert.equal(latestSnapshot(session, stopped.data).config.enabled, false);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(session, stopped.data).meta.step, 4);
	assert.equal(Object.hasOwn(stopped.data, "state"), false);
	assert.equal(durableSession(fixture, session).working.branch, "future");

	await session.navigateTree(base.id, { summarize: false });
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 2);

	await session.navigateTree(stopped.id, { summarize: false });
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	assert.equal(durableSession(fixture, session).contract.constraint, "preserve branch causality");
	assert.equal(durableSession(fixture, session).working.branch, "future");

	const sessionFile = session.sessionFile!;
	session.dispose();
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	assert.equal(latestSnapshot(restarted).config.enabled, false);
	assert.equal(restarted.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(restarted).meta.step, 4);
	assert.equal(durableSession(fixture, restarted).working.nextCheck, "return to base");
});

test("real Pi can restart an early disabled marker as a new origin while preserving shared streams and later branch history", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-stop");
	const marker = snapshots(session).at(-1)!;
	assert.deepEqual(marker.data, { disabled: true });
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { sharedGlobal: "keep" } } },
		{ scope: "cwd", patch: { working: { sharedCwd: "keep" } } },
		{ scope: "session", patch: { working: { laterPrivate: "keep in cold history" } } },
	], "Later branch"));
	await session.prompt("Save later branch");
	const later = snapshots(session).at(-1)!;
	const shared = ["global", "cwd"].flatMap((scope) => {
		const pair = temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), scope as "global" | "cwd", fixture.repositoryRoot);
		return [pair.checkpoint, pair.patches].map((path) => ({ path, bytes: readFileSync(path) }));
	});
	await session.navigateTree(marker.id, { summarize: false });
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 0);
	assert.deepEqual(fixture.readState(session, 0, "session"), { artifacts: {}, contract: {}, working: {}, response: "" });
	assert.equal(fixture.readState(session).working.sharedGlobal, "keep");
	assert.equal(fixture.readState(session).working.sharedCwd, "keep");
	assert.throws(() => fixture.readState(session, 1), /predates the proven temporal origin/);
	for (const { path, bytes } of shared) assert.deepEqual(readFileSync(path), bytes);
	await session.navigateTree(later.id, { summarize: false });
	assert.equal(fixture.readState(session).working.laterPrivate, "keep in cold history");
});

test("real Pi isolates same-CWD sessions and retains seven patches per scope", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	await first.prompt("/state-flow-start");
	const firstId = first.sessionManager.getSessionId();
	const firstKey = nativeSessionKey(first);
	fixture.faux.setResponses(Array.from({ length: 9 }, (_, index) => scopedResponses([
		{ scope: "global", patch: { working: { globalIndex: index } } },
		{ scope: "cwd", patch: { working: { cwdIndex: index } } },
		{ scope: "session", patch: { working: { owner: "first", sessionIndex: index } } },
	], `Iteration ${index}.`)).flat());
	for (let index = 0; index < 9; index++) await first.prompt(`Iteration ${index}`);

	const sharedPaths = ["checkpoint.json", "patches.jsonl", ...["checkpoint.json", "patches.jsonl"].map((name) => join(cwdScopePaths(fixture.cwd, fixture.repositoryRoot).directory, name))];
	const sharedBefore = sharedPaths.map((path) => readFileSync(path.startsWith("/") ? path : join(fixture.repositoryRoot, path)));
	const second = await fixture.createSession("new");
	t.after(() => second.dispose());
	assert.deepEqual(sharedPaths.map((path) => readFileSync(path.startsWith("/") ? path : join(fixture.repositoryRoot, path))), sharedBefore);
	assert.throws(() => fixture.readState(second, 1), /predates the proven temporal origin/);
	const secondId = second.sessionManager.getSessionId();
	const secondKey = nativeSessionKey(second);
	assert.notEqual(firstId, secondId);
	assert.equal(loadSessionState(fixture.cwd, firstId, fixture.repositoryRoot, firstKey)!.working.owner, "first");
	assert.deepEqual(loadSessionState(fixture.cwd, secondId, fixture.repositoryRoot, secondKey), {
		artifacts: {}, contract: {}, working: {}, response: "",
	});
	for (const [scope, materialization] of [
		["global", loadGlobalMaterialization(fixture.repositoryRoot)],
		["cwd", loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)],
		["session", loadSessionMaterialization(fixture.cwd, firstId, fixture.repositoryRoot, firstKey)],
	] as const) {
		assert.equal(materialization!.recentTransitions.length, 7);
		assert.ok(materialization!.recentTransitions.every(({ transitions }) =>
			transitions.length === 1 && transitions[0]!.scope === scope));
	}
	for (const { data } of snapshots(first)) {
		assert.deepEqual(Object.keys(data), ["revision"]);
		assert.match((data as { revision: string }).revision, /^[0-9a-f]{40}$/);
	}
});

test("real Pi resolution continuation accepts patch_state after an intercepted draft", async (t) => {
	const fixture = await realPiFixture(t, { tokensPerSecond: 2_000 });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");

	fixture.faux.setResponses([
		fauxAssistantMessage("Unresolved draft."),
		...sessionResponses({ working: { accepted: "after-resolution" } }, "Recovered."),
	]);
	await session.prompt("Exercise resolution continuation");
	assert.equal(fixture.faux.state.callCount, 3);
	assert.equal(durableSession(fixture, session).working.accepted, "after-resolution");
	assert.equal(durableSession(fixture, session).response, "Recovered.");
	assert.equal(session.getLastAssistantText(), "Recovered.");
	assert.notEqual(session.getLastAssistantText(), "Unresolved draft.");
});

test("real Pi patch diagnostics are opt-in and accepted answers are not logged", async (t) => {
	const fixture = await realPiFixture(t);
	const logPath = join(fixture.agentDir, "tmp", "state-flow", "logs.jsonl");
	const disabled = await fixture.createSession();
	t.after(() => disabled.dispose());
	await disabled.prompt("/state-flow-start");
	fixture.faux.setResponses(sessionResponses({ working: { disabledRun: "accepted" } }, "No diagnostics."));
	await disabled.prompt("Complete without diagnostics");
	assert.equal(existsSync(logPath), false);

	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ logging: true }));
	const logged = await fixture.createSession();
	t.after(() => logged.dispose());
	await logged.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage("Logged unresolved draft."),
		fauxAssistantMessage(fauxToolCall("patch_state", { final: false }), { stopReason: "toolUse" }),
		...sessionResponses({ working: { loggedRun: "accepted" } }, "Accepted."),
	]);
	await logged.prompt("Recover from invalid patch arguments");
	const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.length, 2);
	assert.equal(records[0].category, "terminal-pending");
	assert.deepEqual(records[0].content, [{ type: "text", text: "Logged unresolved draft." }]);
	assert.equal(records[0].resolutionAttempt, 1);
	assert.equal(records[0].terminalEligible, false);
	assert.equal(records[1].category, "invalid-patch");
	assert.match(records[1].error, /final must be exactly true/);
	assert.deepEqual(records[1].input, { final: false });
	assert.equal(records[1].tool, "patch_state");
	assert.equal(typeof records[1].toolCallId, "string");
	assert.equal(records[1].terminalEligible, false);
	assert.equal(durableSession(fixture, logged).working.loggedRun, "accepted");
	assert.equal(durableSession(fixture, logged).response, "Accepted.");
});

test("real Pi diagnostic write failure leaves resolution and accepted state untouched", async (t) => {
	const fixture = await realPiFixture(t);
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ logging: true }));
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	writeFileSync(join(fixture.agentDir, "tmp"), "blocked");
	const beforeFailure = fixture.notifications.length;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { final: false }), { stopReason: "toolUse" }),
		...sessionResponses({ working: { ioFailureRun: "recovered" } }, "Recovered despite diagnostics."),
	]);
	await session.prompt("Recover while diagnostics cannot be written");
	assert.equal(durableSession(fixture, session).working.ioFailureRun, "recovered");
	const warnings = fixture.notifications.slice(beforeFailure).filter((message) => message.includes("could not write diagnostics"));
	assert.equal(warnings.length, 1);
});

test("real Pi patch_state barriers rematerialize every scope before the next inference", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");

	function runtime(context: any): any {
		const projections = context.messages
			.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.filter((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.equal(projections.length, 1, "each inference receives exactly one current State Flow projection");
		return JSON.parse(projections[0].slice(projections[0].indexOf("\n") + 1));
	}

	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", {
			session: { working: { sessionCheckpoint: "verified" } },
		}), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(runtime(context).state.working.sessionCheckpoint, "verified");
			assert.equal(fixture.readState(session, 1).working.sessionCheckpoint, undefined);
			assert.equal(fixture.readState(session, 0, "session").working.sessionCheckpoint, "verified");
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				cwd: { contract: { projectDecision: "retained" } },
			}), { stopReason: "toolUse" });
		},
		(context) => {
			const state = runtime(context).state;
			assert.equal(state.working.sessionCheckpoint, "verified");
			assert.equal(state.contract.projectDecision, "retained");
			return fauxAssistantMessage(fauxToolCall("patch_state", {
				global: { contract: { sharedDecision: "retained" } }, final: true,
			}), { stopReason: "toolUse" });
		},
		(context) => {
			const state = runtime(context).state;
			assert.equal(state.working.sessionCheckpoint, "verified");
			assert.equal(state.contract.projectDecision, "retained");
			assert.equal(state.contract.sharedDecision, "retained");
			return fauxAssistantMessage("Barrier run complete.");
		},
	]);
	await session.prompt("Materialize several established checkpoints");
	assert.equal(fixture.faux.state.callCount, 4);
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.equal(durableSession(fixture, session).working.sessionCheckpoint, "verified");
	assert.equal(durableSession(fixture, session).response, "Barrier run complete.");
	assert.equal(fixture.readState(session, 1).response, "");
	assert.throws(() => fixture.readState(session, 8), /0 to 7/);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.contract.projectDecision, "retained");
	assert.equal(loadGlobalState(fixture.repositoryRoot)!.contract.sharedDecision, "retained");
	assert.deepEqual(
		snapshots(session).map(({ data }) => latestSnapshot(session, data).meta.step).filter((step, index, all) => index === 0 || step !== all[index - 1]),
		[0, 1, 2, 3, 4],
	);
	const beforeNoop = loadSessionMaterialization(fixture.cwd, session.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(session));
	fixture.faux.setResponses(unchangedResponses("Barrier run complete."));
	await session.prompt("Confirm the same complete state");
	assert.equal(latestSnapshot(session).meta.step, 4);
	assert.deepEqual(loadSessionMaterialization(fixture.cwd, session.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(session)), beforeNoop);
});

test("real Pi reads prior scoped state lazily after a barrier and rejects offset eight without a transition", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("read_state"), true);
	fixture.faux.setResponses(sessionResponses({ working: { version: "old" } }, "Baseline."));
	await session.prompt("Save the baseline");
	let beforeReads: string;
	let checkpointCount: number;
	function projection(context: any) {
		const messages = context.messages.filter((message: any) => message.content?.[0]?.text?.startsWith("State Flow runtime context"));
		assert.equal(messages.length, 1);
		const text = messages[0].content[0].text;
		return JSON.parse(text.slice(text.indexOf("\n") + 1));
	}
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { version: "new" } }, final: true }), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(projection(context).state.working.version, "new");
			beforeReads = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
			checkpointCount = snapshots(session).length;
			return fauxAssistantMessage(fauxToolCall("read_state", { offset: 1, scope: "session" }, { id: "history-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "history-read") as any;
			assert.equal(result.isError, false);
			assert.match(result.content[0].text, /^\n\{"offset":1/);
			const historical = JSON.parse(result.content[0].text);
			assert.equal(historical.offset, 1);
			assert.equal(historical.scope, "session");
			assert.equal(historical.state.working.version, "old");
			assert.equal(historical.state.response, "Baseline.");
			assert.equal(projection(context).state.working.version, "new");
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeReads);
			assert.equal(snapshots(session).length, checkpointCount);
			assert.equal(latestSnapshot(session).meta.step, 2);
			return fauxAssistantMessage(fauxToolCall("read_state", { offset: 8 }, { id: "unavailable-read" }), { stopReason: "toolUse" });
		},
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "unavailable-read") as any;
			assert.equal(result.isError, true);
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeReads);
			assert.equal(snapshots(session).length, checkpointCount);
			return fauxAssistantMessage("History checked.");
		},
	]);
	await session.prompt("Advance state, then inspect its predecessor");
	assert.equal(latestSnapshot(session).meta.step, 3, "only baseline, barrier and terminal response advance history");
	assert.equal(fixture.readState(session).working.version, "new");
	assert.equal(fixture.readState(session, 1).response, "Baseline.");
	fixture.faux.setResponses([
		(context) => {
			assert.equal(context.messages.some((message: any) => message.role === "toolResult" && message.toolCallId === "history-read"), false);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Next run."),
	]);
	await session.prompt("Begin a separate run without replaying old tool context");
	const retained = session.sessionManager.getEntries().find((entry) => entry.type === "message"
		&& entry.message.role === "toolResult" && entry.message.toolCallId === "history-read");
	assert.ok(retained?.type === "message" && retained.message.role === "toolResult");
	const content = retained.message.content[0];
	assert.ok(content?.type === "text");
	assert.equal(JSON.parse(content.text).state.working.version, "old", "full native trace survives model-context projection");
	const beforeStatus = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await session.prompt("/state-flow-status");
	assert.match(fixture.notifications.at(-1)!, /Hot history: offsets 0\.\.4; maximum depth 7/);
	assert.match(fixture.notifications.at(-1)!, /Retained patch tails: global 0; CWD 0; session 4/);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeStatus);
});

test("real Pi executes only patch_state when a response also proposes a sibling tool", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("read", { path: join(fixture.cwd, "must-not-run.md") }, { id: "blocked-read" }),
			fauxToolCall("read_state", { offset: 0 }, { id: "blocked-history" }),
			fauxToolCall("patch_state", {
				session: { working: { barrier: "accepted" } }, final: true,
			}, { id: "accepted-patch" }),
		], { stopReason: "toolUse" }),
		(context) => {
			const results = context.messages.filter((message: any) => message.role === "toolResult") as any[];
			assert.equal(results.length, 3);
			assert.equal(results[0].toolCallId, "blocked-read");
			assert.equal(results[0].isError, true);
			assert.match(results[0].content[0].text, /patch_state barrier/);
			assert.equal(results[1].toolCallId, "blocked-history");
			assert.equal(results[1].isError, true);
			assert.match(results[1].content[0].text, /patch_state barrier/);
			assert.equal(results[2].toolCallId, "accepted-patch");
			assert.equal(results[2].isError, false);
			assert.match(results[2].content[0].text, /State materialized atomically at session scope/);
			return fauxAssistantMessage("Barrier enforced.");
		},
	]);
	await session.prompt("Patch and then reconsider any other action");
	assert.equal(latestSnapshot(session).meta.step, 2);
	assert.equal(durableSession(fixture, session).working.barrier, "accepted");
	assert.equal(durableSession(fixture, session).response, "Barrier enforced.");
});

test("real Pi keeps a malformed patch_state failure separated from the invocation", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	await session.prompt("/state-flow-start");
	const beforeHead = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	const beforeStep = latestSnapshot(session).meta.step;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { invalid: [null] } } }, { id: "malformed-patch" }), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "malformed-patch") as any;
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /^\nMaterialized state cannot contain null/);
			assert.equal(latestSnapshot(session).meta.step, beforeStep);
			assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), beforeHead);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Malformed patch rejected without state change."),
	]);
	await session.prompt("Attempt a malformed patch");
});

test("real Pi reconciles unrelated Knowledge history and contains a simultaneous durable writer", async (t) => {
	const fixture = await realPiFixture(t);
	const first = await fixture.createSession();
	const second = await fixture.createSession();
	t.after(() => first.dispose());
	t.after(() => second.dispose());
	await first.prompt("/state-flow-start");
	await second.prompt("/state-flow-start");

	writeFileSync(join(fixture.repositoryRoot, "independent.md"), "Independent Knowledge history.\n");
	runGit(fixture.repositoryRoot, "add", "independent.md");
	runGit(fixture.repositoryRoot, "commit", "-m", "knowledge: independent advance");
	const knowledgeCommit = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");

	fixture.faux.setResponses(scopedResponses([{
		scope: "cwd",
		patch: { working: { writer: "first" } },
	}], "First writer committed."));
	await first.prompt("Commit after independent Knowledge history");
	const firstCommit = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	assert.equal(runGit(fixture.repositoryRoot, "merge-base", firstCommit, knowledgeCommit), knowledgeCommit);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "first");

	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", {
			cwd: { working: { writer: "second" } },
		}), { stopReason: "toolUse" }),
		...unchangedResponses("Second writer was rejected."),
	]);
	await second.prompt("Attempt a simultaneous durable transition");
	assert.equal(latestSnapshot(second).meta.step, 1);
	assert.equal(latestSnapshot(second).config.enabled, true);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.writer, "first");
	assert.equal(loadCwdMaterialization(fixture.cwd, fixture.repositoryRoot)!.recentTransitions.length, 1);
	const failed = second.sessionManager.getEntries().find((entry: any) => entry.type === "message"
		&& entry.message?.role === "toolResult" && entry.message?.toolName === "patch_state" && entry.message?.isError);
	assert.ok(failed);
});

test("real Pi retries a persisted pending push after restart without duplicating the transition", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	const missingRemote = join(fixture.root, "missing.git");
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", missingRemote);
	fixture.faux.setResponses(scopedResponses([{
		scope: "cwd",
		patch: { working: { publication: "accepted-locally" } },
	}], "Committed locally."));
	await session.prompt("Persist a durable transition");
	const accepted = latestSnapshot(session);
	const pendingCommit = accepted.meta.pendingPublication?.commit;
	assert.ok(pendingCommit);
	assert.equal(accepted.meta.step, 2);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), pendingCommit);
	const sessionFile = session.sessionFile!;
	const countBeforeRestart = runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD");
	session.dispose();

	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", fixture.remote);
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(latestSnapshot(restarted).meta.pendingPublication, undefined);
	assert.equal(latestSnapshot(restarted).meta.step, 2);
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/main"), pendingCommit);
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), countBeforeRestart);
	assert.equal(loadCwdState(fixture.cwd, fixture.repositoryRoot)!.working.publication, "accepted-locally");
});

test("real Pi incrementally acquires only invalidated global Markdown and attaches trusted freshness", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const unchangedPath = join(fixture.agentDir, "knowledge", "unchanged.md");
	const changedPath = join(fixture.agentDir, "knowledge", "changed.md");
	writeFileSync(unchangedPath, "Unchanged routing guidance.\n");
	writeFileSync(changedPath, "Original routing guidance.\n");
	initializeCwdState(fixture.cwd, fixture.repositoryRoot);
	const metadata = (path: string, description: string) => ({
		description,
		hash: hashArtifactSource(readFileSync(path)),
		compiler: ORDINARY_ARTIFACT_COMPILER,
		compiled_at: "2026-01-01T00:00:00.000Z",
	});
	writeGlobalState({
		artifacts: {
			[unchangedPath]: metadata(unchangedPath, "Stable unchanged guidance"),
			[changedPath]: metadata(changedPath, "Original changed guidance"),
		},
		contract: {}, working: {}, response: "",
	}, fixture.repositoryRoot);
	const globalPaths = durablePaths(fixture.repositoryRoot);
	const cwdPaths = cwdScopePaths(fixture.cwd, fixture.repositoryRoot);
	runGit(
		fixture.repositoryRoot,
		"add",
		globalPaths.globalState,
		globalPaths.globalPatches,
		cwdPaths.state,
		cwdPaths.patches,
	);
	runGit(fixture.repositoryRoot, "commit", "-m", "state-flow: seed artifact registry");
	runGit(fixture.repositoryRoot, "push", "origin", "main");

	const runtime = (context: any) => {
		const text = context.messages
			.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.find((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.ok(text);
		return JSON.parse(text.slice(text.indexOf("\n") + 1));
	};

	let beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).knowledge_rehydration.phase, "new-bootstrap");
			assert.equal(runtime(context).artifact_invalidations, undefined);
			// Legacy embedded provenance is consumed for freshness but stripped from model projection.
			assert.deepEqual(runtime(context).state.artifacts[unchangedPath], { description: "Stable unchanged guidance" });
			assert.deepEqual(runtime(context).state.artifacts[changedPath], { description: "Original changed guidance" });
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Fresh artifacts reused without source acquisition."),
	]);
	const unchangedSession = await fixture.createSession("new");
	await unchangedSession.prompt("Use the materialized artifact index");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);
	unchangedSession.dispose();

	writeFileSync(changedPath, "Changed routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).knowledge_rehydration.phase, "new-bootstrap");
			assert.doesNotMatch(JSON.stringify(context.messages), /Changed routing guidance\./);
			assert.deepEqual(runtime(context).artifact_invalidations, [{
				path: changedPath,
				reason: "source-changed",
			}]);
			return fauxAssistantMessage(fauxToolCall("read", { path: changedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [changedPath]: { description: "Updated routing guidance" } } },
		}], "Changed artifact recompiled."),
	]);
	const changedSession = await fixture.createSession("new");
	await changedSession.prompt("Refresh invalidated artifacts");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	changedSession.dispose();
	const afterSourceChange = loadGlobalState(fixture.repositoryRoot)!;
	assert.deepEqual(afterSourceChange.artifacts[unchangedPath], metadata(unchangedPath, "Stable unchanged guidance"));
	assert.deepEqual(afterSourceChange.artifacts[changedPath], {
		description: "Updated routing guidance",
	});
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], {
		sourceHash: hashArtifactSource("Changed routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});

	const compilerStale = structuredClone(afterSourceChange);
	compilerStale.artifacts[unchangedPath]!.compiler = "artifact-v0";
	const compilerRuntime = new TemporalRuntime(fixture.cwd, changedSession.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(changedSession));
	const compilerSnapshot = compilerRuntime.restore(latestSnapshot(changedSession).meta.durableBase!);
	const compilerStates = compilerRuntime.states();
	const compilerNext = { ...compilerStates, global: compilerStale };
	compilerSnapshot.meta.step += 1;
	compilerRuntime.publish(compilerSnapshot, true, createAcceptedTransition(compilerStates, compilerNext));
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.deepEqual(runtime(context).artifact_invalidations, [{
				path: unchangedPath,
				reason: "compiler-changed",
			}]);
			return fauxAssistantMessage(fauxToolCall("read", { path: unchangedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [unchangedPath]: { description: "Recompiled unchanged guidance" } } },
		}], "Compiler-stale artifact recompiled."),
	]);
	const compilerSession = await fixture.createSession("new");
	t.after(() => compilerSession.dispose());
	await compilerSession.prompt("Apply the current artifact compiler");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	const afterCompilerChange = loadGlobalState(fixture.repositoryRoot)!;
	assert.deepEqual(afterCompilerChange.artifacts[unchangedPath], { description: "Recompiled unchanged guidance" });
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[unchangedPath], {
		sourceHash: hashArtifactSource("Unchanged routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});
	assert.deepEqual(afterCompilerChange.artifacts[changedPath], afterSourceChange.artifacts[changedPath]);

	// A semantically identical recompilation must still persist fresh provenance; otherwise the
	// artifact would re-invalidate forever without any semantic transition to carry the update.
	writeFileSync(changedPath, "Second routing guidance.\n");
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.deepEqual(runtime(context).artifact_invalidations, [{ path: changedPath, reason: "source-changed" }]);
			return fauxAssistantMessage(fauxToolCall("read", { path: changedPath }), { stopReason: "toolUse" });
		},
		...scopedResponses([{
			scope: "global",
			patch: { artifacts: { [changedPath]: { description: "Updated routing guidance" } } },
		}], "Provenance-only recompilation."),
	]);
	const provenanceSession = await fixture.createSession("new");
	t.after(() => provenanceSession.dispose());
	await provenanceSession.prompt("Recompile with unchanged semantics");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 3);
	assert.deepEqual(loadGlobalState(fixture.repositoryRoot)!.artifacts[changedPath], { description: "Updated routing guidance" });
	assert.deepEqual(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], {
		sourceHash: hashArtifactSource("Second routing guidance.\n"),
		compilerRevision: ORDINARY_ARTIFACT_COMPILER,
	});
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Provenance retained without reacquisition."),
	]);
	const provenanceFreshSession = await fixture.createSession("new");
	t.after(() => provenanceFreshSession.dispose());
	await provenanceFreshSession.prompt("Confirm provenance retained");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);

	// Removal is a deterministic runtime observation and needs no source-body read or model-authored compiler output.
	rmSync(changedPath);
	beforeCalls = fixture.faux.state.callCount;
	fixture.faux.setResponses([
		(context) => {
			assert.equal(runtime(context).artifact_invalidations, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Removed artifact no longer projected."),
	]);
	const removalSession = await fixture.createSession("new");
	t.after(() => removalSession.dispose());
	await removalSession.prompt("Continue without the deleted source");
	assert.equal(fixture.faux.state.callCount - beforeCalls, 2);
	assert.equal(loadGlobalState(fixture.repositoryRoot)!.artifacts[changedPath], undefined);
	assert.equal(loadGlobalProvenance(fixture.repositoryRoot)[changedPath], undefined);
});

test("a fresh real Pi agent continues from compact state and a runtime-compiled Skill artifact", async (t) => {
	const fixture = await realPiFixture(t);
	const skill = join(fixture.cwd, "skills", "continuation", "SKILL.md");
	mkdirSync(join(fixture.cwd, "skills", "continuation"), { recursive: true });
	writeFileSync(skill, "# Continuation\n\nPreserve the next discriminating check.\n\nSOURCE-BODY-ONLY-MARKER\n", { flag: "wx" });
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: skill }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("patch_state", {
			cwd: {
				artifacts: {
					[skill]: {
						description: "Continuation rules for evidence-preserving handoffs",
						kind: "skill",
						compilation: {
							routing: "Use for resumed continuation checks",
							constraints: ["Preserve the next discriminating check"],
						},
					},
				},
			},
		}), { stopReason: "toolUse" }),
		...scopedResponses([{
			scope: "session",
			patch: {
				contract: {
					activeConstraint: "never discard unresolved evidence",
					rejectedApproach: { name: "guessing", reconsiderWhen: "new evidence exists" },
				},
				working: {
					unresolved: "whether the resumed source changed",
					nextCheck: "compare the retained source hash",
				},
			},
		}], "Skill compiled."),
	]);
	await session.prompt("OLD-CONVERSATION-MARKER acquire the continuation Skill");
	const compiled = loadCwdState(fixture.cwd, fixture.repositoryRoot)!.artifacts[skill];
	const compiledProvenance = loadCwdProvenance(fixture.cwd, fixture.repositoryRoot)[skill]!;
	assert.equal(compiledProvenance.sourceHash, hashSkillSource(skill));
	assert.equal(compiledProvenance.compilerRevision, SKILL_ARTIFACT_COMPILER);
	assert.equal(compiled.compilation?.routing, "Use for resumed continuation checks");
	const sessionFile = session.sessionFile!;
	session.dispose();

	let observedContext = "";
	fixture.faux.setResponses([
		(context) => {
			observedContext = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Continuation context verified."),
	]);
	const restarted = await fixture.createSession("resume", SessionManager.open(sessionFile, fixture.sessionDir));
	t.after(() => restarted.dispose());
	await restarted.prompt("Continue from retained state");
	assert.match(observedContext, /never discard unresolved evidence/);
	assert.match(observedContext, /guessing/);
	assert.match(observedContext, /whether the resumed source changed/);
	assert.match(observedContext, /compare the retained source hash/);
	assert.match(observedContext, /Continuation rules for evidence-preserving handoffs/);
	assert.match(observedContext, /Use for resumed continuation checks/);
	assert.doesNotMatch(observedContext, new RegExp(compiledProvenance.sourceHash));
	assert.doesNotMatch(observedContext, /SOURCE-BODY-ONLY-MARKER/);
	assert.doesNotMatch(observedContext, /OLD-CONVERSATION-MARKER/);
});

test("real Pi old tree branch stop and resume preserve selected semantics without rewinding shared files", async (t) => {
	const fixture = await realPiFixture(t);
	const session = await fixture.createSession();
	await session.prompt("/state-flow-start");
	const owned = runGit(fixture.repositoryRoot, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
	assert.equal(owned.length, 8);
	assert.equal(owned.filter((path) => path.endsWith("checkpoint.json")).length, 3);
	assert.equal(owned.filter((path) => path.endsWith("patches.jsonl")).length, 3);
	assert.equal(owned.some((path) => path.endsWith("state.json")), false);
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { branch: "old" } } },
		{ scope: "session", patch: { working: { selected: "old" } } },
	], "Old answer"));
	await session.prompt("Old state");
	const old = snapshots(session).at(-1)!;
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { working: { branch: "new" } } },
		{ scope: "session", patch: { working: { selected: "new" } } },
	], "New answer"));
	await session.prompt("New state");
	const before = owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path)));
	await session.navigateTree(old.id, { summarize: false });
	assert.equal(fixture.readState(session).working.selected, "old");
	await session.prompt("/state-flow-stop");
	const stopped = latestSnapshot(session);
	assert.equal(stopped.meta.step, 2);
	const after = owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path)));
	assert.deepEqual(after, before);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(latestSnapshot(resumed).config.enabled, false);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	let passiveContext = "";
	fixture.faux.setResponses([(context) => {
		passiveContext = JSON.stringify(context.messages);
		return fauxAssistantMessage("Disabled continuation remained ordinary.");
	}]);
	await resumed.prompt("Continue while State Flow is stopped");
	assert.match(passiveContext, /State Flow exit handoff/);
	assert.match(passiveContext, /Continue while State Flow is stopped/);
	assert.doesNotMatch(passiveContext, /Old state|New state/);
	assert.equal(fixture.readState(resumed).working.selected, "old");
	assert.equal(fixture.readState(resumed).working.branch, "old");
	assert.equal(fixture.readState(resumed, 1).response, "");
	assert.deepEqual(owned.filter((path) => !path.endsWith("config.json") && !path.endsWith("meta.json"))
		.map((path) => readFileSync(join(fixture.repositoryRoot, path))), before);
});

test("real Pi persists without Git, resumes its file cohort and adopts Git without a semantic step", async (t) => {
	const fixture = await realPiFixture(t, { initializeRepository: false });
	const spawn = childProcess.spawnSync;
	let probes = 0;
	childProcess.spawnSync = ((command: string, args: string[]) => {
		assert.equal(command, "git");
		assert.deepEqual(args, ["--version"], "no repository operation is permitted without Git");
		probes++;
		return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) };
	}) as unknown as typeof spawn;
	syncBuiltinESMExports();
	t.after(() => { childProcess.spawnSync = spawn; syncBuiltinESMExports(); });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	assert.equal(session.getActiveToolNames().includes("patch_state"), false);
	await session.prompt("/state-flow-start");
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	const fileKey = nativeSessionKey(session);
	assert.equal(existsSync(temporalScopePaths(fixture.cwd, session.sessionManager.getSessionId(), "session", fixture.repositoryRoot, fileKey).directory), true);
	assert.doesNotMatch(fileKey, /-[a-f0-9]{64}$/);
	const current = (context: any) => {
		const texts = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text).filter((text: unknown) => typeof text === "string" && text.startsWith("State Flow runtime context"));
		assert.equal(texts.length, 1);
		return JSON.parse(texts[0].slice(texts[0].indexOf("\n") + 1)).state;
	};
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { cwd: { working: { fileCwd: "visible" } } }), { stopReason: "toolUse" }),
		(context) => {
			assert.equal(current(context).working.fileCwd, "visible");
			assert.equal(fixture.readState(session, 1, "cwd").working.fileCwd, undefined);
			return fauxAssistantMessage(fauxToolCall("patch_state", { session: { working: { fileSession: "visible" } }, final: true }), { stopReason: "toolUse" });
		},
		(context) => {
			assert.equal(current(context).working.fileSession, "visible");
			return fauxAssistantMessage("File-only final answer.");
		},
	]);
	await session.prompt("Persist without Git");
	assert.equal(latestSnapshot(session).meta.step, 3);
	assert.match(latestSnapshot(session).meta.durableBase!, /^file:[0-9a-f]{64}$/);
	assert.equal(latestSnapshot(session).meta.pendingPublication, undefined);
	assert.equal(fixture.readState(session).response, "File-only final answer.");
	assert.equal(fixture.readState(session, 1).response, "");
	const beforeReads = probes;
	fixture.readState(session, 2, "cwd");
	assert.equal(probes, beforeReads);
	const before = [0, 1, 2, 3].map((offset) => fixture.readState(session, offset));
	await session.prompt("/state-flow-stop");
	assert.equal(latestSnapshot(session).config.enabled, false);
	assert.equal(latestSnapshot(session).meta.step, 3);
	assert.equal(existsSync(join(fixture.repositoryRoot, ".git")), false);
	const file = session.sessionFile!;
	session.dispose();
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	assert.equal(resumed.getActiveToolNames().includes("patch_state"), false);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	assert.deepEqual([0, 1, 2, 3].map((offset) => fixture.readState(resumed, offset)), before);
	assert.equal(fixture.notifications.some((message) => /push.*pending|could not initialize/i.test(message)), false);
	childProcess.spawnSync = spawn;
	syncBuiltinESMExports();
	const identity = { GIT_AUTHOR_NAME: "State Flow Tests", GIT_AUTHOR_EMAIL: "state-flow@example.invalid", GIT_COMMITTER_NAME: "State Flow Tests", GIT_COMMITTER_EMAIL: "state-flow@example.invalid" };
	const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
	Object.assign(process.env, identity);
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
	childProcess.execFileSync("git", ["init", "-b", "main", fixture.repositoryRoot], { stdio: "ignore" });
	childProcess.execFileSync("git", ["init", "--bare", fixture.remote], { stdio: "ignore" });
	runGit(fixture.repositoryRoot, "remote", "add", "origin", fixture.remote);
	runGit(fixture.repositoryRoot, "config", "branch.main.remote", "origin");
	runGit(fixture.repositoryRoot, "config", "branch.main.merge", "refs/heads/main");
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	await resumed.prompt("/state-flow-start");
	assert.equal(resumed.getActiveToolNames().includes("patch_state"), true);
	const adopted = latestSnapshot(resumed);
	assert.match(adopted.meta.durableBase!, /^[0-9a-f]{40}$/);
	assert.equal(adopted.meta.step, 3);
	assert.equal(adopted.meta.pendingPublication?.commit, adopted.meta.durableBase);
	assert.equal(runGit(fixture.repositoryRoot, "rev-list", "--count", "HEAD"), "1");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const adoptionQueue = publicationQueuePath(destination);
	assert.ok(loadPublicationQueue(adoptionQueue), "file-to-Git activation queues remote publication instead of waiting for it");
	assert.notEqual(childProcess.spawnSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).status, 0);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(adoptionQueue); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(adoptionQueue), undefined);
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/main"), adopted.meta.durableBase);
	assert.equal(latestSnapshot(resumed).meta.pendingPublication, undefined);
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	assert.deepEqual([0, 1, 2, 3].map((offset) => fixture.readState(resumed, offset)), before);
	const cold = new TemporalRuntime(fixture.cwd, resumed.sessionManager.getSessionId(), fixture.repositoryRoot, nativeSessionKey(resumed));
	cold.restore(adopted.meta.durableBase!);
	assert.deepEqual([0, 1, 2, 3].map((offset) => cold.read(offset)), before);
	// Subsequent semantic publication uses the already configured remote normally.
	fixture.faux.setResponses(unchangedResponses("Git-backed answer."));
	await resumed.prompt("Continue after adoption");
	assert.equal(latestSnapshot(resumed).meta.step, 4);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(adoptionQueue); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await resumed.prompt("/state-flow-status");
	assert.match(fixture.notifications.at(-1)!, /Publication: idle/);
	assert.equal(fixture.readState(resumed).response, "Git-backed answer.");
	assert.equal(runGit(fixture.remote, "rev-parse", "refs/heads/" + runGit(fixture.repositoryRoot, "branch", "--show-current")), latestSnapshot(resumed).meta.durableBase);
});

test("real Pi derives an in-memory session directory from the native header timestamp and UUID", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const manager = SessionManager.inMemory(fixture.cwd);
	const session = await fixture.createSession("new", manager);
	t.after(() => session.dispose());
	assert.equal(manager.getSessionFile(), undefined);
	const header = manager.getHeader()!;
	const key = `${header.timestamp.replace(/[:.]/g, "-")}_${manager.getSessionId()}`;
	assert.equal(nativeSessionKey(session), key);
	const directory = temporalScopePaths(fixture.cwd, manager.getSessionId(), "session", fixture.repositoryRoot, key).directory;
	assert.equal(existsSync(join(directory, "checkpoint.json")), true);
	assert.equal(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")).identity.sessionId, manager.getSessionId());
});

test("real Pi baseline memory crosses CWDs while project memory remains scoped", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	fixture.faux.setResponses(scopedResponses([
		{ scope: "global", patch: { contract: { preference: "compact" } } },
		{ scope: "cwd", patch: { contract: { projectRule: "local-only" } } },
	], "Memory retained."));
	await first.prompt("Retain the established cross-project preference and project-only rule");
	assert.equal(fixture.readState(first, 0, "global").contract.preference, "compact");
	assert.equal(fixture.readState(first, 0, "cwd").contract.projectRule, "local-only");

	const otherCwd = join(fixture.root, "other-project");
	const second = await fixture.createSessionAt(otherCwd, "new");
	t.after(() => second.dispose());
	assert.equal(fixture.readState(second, 0, "global").contract.preference, "compact");
	assert.equal(fixture.readState(second, 0, "cwd").contract.projectRule, undefined);
	assert.deepEqual(fixture.readState(second, 0, "session"), { artifacts: {}, contract: {}, working: {}, response: "" });
});

test("real Pi preserves failed external promotion and recovers proven destination pointers", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	t.after(() => first.dispose());
	fixture.faux.setResponses(scopedResponses([{
		scope: "global",
		patch: { working: {
			durableCandidate: { preference: "compact" },
			memory_promotions: { preference: {
				status: "failed", owner: "knowledge", pointer: "MEMORY.md#preference", error: "write rejected",
			} },
		} },
	}], "Promotion remains recoverable."));
	await first.prompt("Attempt the external handoff without losing the accepted copy");

	const recovery = await fixture.createSessionAt(join(fixture.root, "promotion-recovery"), "new");
	t.after(() => recovery.dispose());
	assert.deepEqual(fixture.readState(recovery, 0, "global").working.durableCandidate, { preference: "compact" });
	assert.deepEqual((fixture.readState(recovery, 0, "global").working.memory_promotions as any).preference, {
		status: "failed", owner: "knowledge", pointer: "MEMORY.md#preference", error: "write rejected",
	});

	fixture.faux.setResponses(scopedResponses([{
		scope: "global",
		patch: { working: {
			durableCandidate: null,
			memory_promotions: { preference: {
				status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "accepted-revision", error: null,
			} },
		} },
	}], "External acceptance proven."));
	await recovery.prompt("Finalize only after proving destination acceptance");

	const verified = await fixture.createSessionAt(join(fixture.root, "promotion-verified"), "new");
	t.after(() => verified.dispose());
	const global = fixture.readState(verified, 0, "global");
	assert.equal(global.working.durableCandidate, undefined);
	assert.deepEqual((global.working.memory_promotions as any).preference, {
		status: "accepted", owner: "knowledge", pointer: "MEMORY.md#preference", revision: "accepted-revision",
	});
});

test("real Pi turn-end policy queues the newest local target without pushing inline", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	fixture.faux.setResponses(unchangedResponses("Queued after local acceptance."));
	await session.prompt("Accept locally and queue remote publication");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queue = loadPublicationQueue(publicationQueuePath(destination));
	assert.ok(queue);
	assert.equal(queue.target, runGit(fixture.repositoryRoot, "rev-parse", "HEAD"));
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(publicationQueuePath(destination)); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), runGit(fixture.repositoryRoot, "rev-parse", "HEAD"));
});

test("real Pi concurrent sessions preserve a newer queued descendant while an older push is active", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	const second = await fixture.createSession("new");
	t.after(() => { first.dispose(); second.dispose(); });
	writeFileSync(join(fixture.remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	fixture.faux.setResponses([
		...unchangedResponses("First local target."),
		...unchangedResponses("Second local target."),
	]);
	await first.prompt("Publish the older target");
	const older = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	await second.prompt("Publish the newer target while the first worker is active");
	const newer = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	assert.notEqual(newer, older);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const path = publicationQueuePath(destination);
	assert.equal(loadPublicationQueue(path)?.target, newer);
	for (let attempt = 0; attempt < 60 && loadPublicationQueue(path); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(loadPublicationQueue(path), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), newer);
});

test("real Pi turn-end activation accepts locally without an inline remote push", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "turn-end" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	// An unreachable remote surfaces as a synchronous pending push whenever activation publishes inline.
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", join(fixture.root, "unreachable.git"));
	await session.prompt("/state-flow-start");
	const snapshot = latestSnapshot(session);
	assert.equal(snapshot.config.enabled, true);
	assert.equal(fixture.notifications.some((message) => /push is pending/.test(message)), false);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queue = loadPublicationQueue(publicationQueuePath(destination));
	assert.ok(queue, "the activation commit is queued for the asynchronous worker");
	assert.match(queue.target, /^[0-9a-f]{40,64}$/);
});

test("real Pi off activation stays local without queue or remote attempt", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "off" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	await session.prompt("/state-flow-start");
	assert.equal(latestSnapshot(session).config.enabled, true);
	assert.equal(fixture.notifications.some((message) => /push is pending/.test(message)), false);
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
});

test("real Pi transition activation preserves synchronous legacy publication", async (t) => {
	const fixture = await realPiFixture(t, { remotePublication: "transition" });
	const session = await fixture.createSession();
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	await session.prompt("/state-flow-start");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.notEqual(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
});

test("real Pi off policy accepts locally without queue or remote attempt", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, remotePublication: "off" });
	const session = await fixture.createSession("new");
	t.after(() => session.dispose());
	const remoteBefore = childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
	fixture.faux.setResponses(unchangedResponses("Local-only by policy."));
	await session.prompt("Accept without remote replication");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	assert.equal(loadPublicationQueue(publicationQueuePath(destination)), undefined);
	assert.equal(childProcess.execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), remoteBefore);
	assert.equal(fixture.readState(session).response, "Local-only by policy.");
});

test("real Pi retries a failed durable queue after restart without duplicating local state", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const session = await fixture.createSession("new");
	const file = session.sessionManager.getSessionFile()!;
	const missing = join(fixture.root, "replacement-remote.git");
	runGit(fixture.repositoryRoot, "remote", "set-url", "origin", missing);
	fixture.faux.setResponses(unchangedResponses("Locally durable while offline."));
	await session.prompt("Accept while remote publication is unavailable");
	const destination = resolveGitPushDestination(fixture.repositoryRoot)!;
	const queuePath = publicationQueuePath(destination);
	for (let attempt = 0; attempt < 40 && loadPublicationQueue(queuePath)?.status !== "failed"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const failed = loadPublicationQueue(queuePath);
	assert.equal(failed?.status, "failed");
	assert.match(failed?.error ?? "", /git|repository|remote|exit/i);
	const head = runGit(fixture.repositoryRoot, "rev-parse", "HEAD");
	const step = latestSnapshot(session).meta.step;
	session.dispose();

	childProcess.execFileSync("git", ["init", "--bare", missing], { stdio: "ignore" });
	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	for (let attempt = 0; attempt < 60 && loadPublicationQueue(queuePath); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(loadPublicationQueue(queuePath), undefined);
	assert.equal(runGit(fixture.repositoryRoot, "rev-parse", "HEAD"), head);
	assert.equal(latestSnapshot(resumed).meta.step, step);
	assert.equal(fixture.readState(resumed).response, "Locally durable while offline.");
	assert.equal(childProcess.execFileSync("git", ["--git-dir", missing, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), head);
});

test("real Pi projects resume bootstrap once and then uses step rehydration", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true });
	const first = await fixture.createSession("new");
	fixture.faux.setResponses(unchangedResponses("Continuation established."));
	await first.prompt("Establish a resumable session");
	const file = first.sessionManager.getSessionFile()!;
	first.dispose();

	const resumed = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => resumed.dispose());
	const phase = (context: any) => {
		const text = context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
			.map((block: any) => block.text)
			.find((value: unknown) => typeof value === "string" && value.startsWith("State Flow runtime context"));
		assert.ok(text);
		return JSON.parse(text.slice(text.indexOf("\n") + 1)).knowledge_rehydration.phase;
	};
	fixture.faux.setResponses([
		(context) => {
			assert.equal(phase(context), "resume-bootstrap");
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Resume bootstrap remained materialized-first."),
	]);
	await resumed.prompt("Resume the exact continuation");
	fixture.faux.setResponses([
		(context) => {
			assert.equal(phase(context), "step");
			return fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Later step used the same bounded route."),
	]);
	await resumed.prompt("Continue with a later step");
});

test("real Pi auto-start follows agent configuration without overriding resumed branch mode", async (t) => {
	const fixture = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const path = process.env.PATH;
	process.env.PATH = fixture.root;
	t.after(() => { process.env.PATH = path; });
	const session = await fixture.createSession("startup");
	t.after(() => session.dispose());
	assert.equal(session.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(session).meta.step, 0);
	assert.equal(existsSync(join(fixture.repositoryRoot, ".git")), false);
	fixture.faux.setResponses(unchangedResponses("Automatically persisted."));
	await session.prompt("Use automatic mode");
	await session.prompt("/state-flow-stop");
	const file = session.sessionFile!;
	session.dispose();
	const stopped = await fixture.createSession("resume", SessionManager.open(file, fixture.sessionDir));
	t.after(() => stopped.dispose());
	assert.equal(stopped.getActiveToolNames().includes("patch_state"), false);
	assert.equal(fixture.readState(stopped).response, "Automatically persisted.");
	const next = await fixture.createSession("new");
	assert.equal(next.getActiveToolNames().includes("patch_state"), true);
	assert.equal(fixture.readState(next).response, "");
	fixture.faux.setResponses(unchangedResponses("Second automatic session."));
	await next.prompt("Persist the second session");
	const enabledFile = next.sessionFile!;
	assert.equal(existsSync(enabledFile), true);
	next.dispose();
	writeFileSync(join(fixture.agentDir, "state-flow.json"), JSON.stringify({ autoStart: false }));
	const manual = await fixture.createSession("new");
	t.after(() => manual.dispose());
	assert.equal(manual.getActiveToolNames().includes("patch_state"), false);
	assert.equal(snapshots(manual).length, 0);
	const enabled = await fixture.createSession("resume", SessionManager.open(enabledFile, fixture.sessionDir));
	t.after(() => enabled.dispose());
	assert.equal(enabled.getActiveToolNames().includes("patch_state"), true);
	assert.equal(latestSnapshot(enabled).config.enabled, true);
	assert.deepEqual(JSON.parse(readFileSync(join(fixture.agentDir, "state-flow.json"), "utf8")), { autoStart: false });
});
