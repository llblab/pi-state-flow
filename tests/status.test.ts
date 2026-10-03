import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { compactStatus, detailedStatus, STATUS_KEY, type StatusDiagnostics } from "../lib/status.ts";
import { emptyState } from "../lib/state.ts";
import { harness, start } from "./harness.ts";

const snapshot = {
	config: { mode: "active" as const },
	meta: { step: 7 },
};
const sessionState = { ...emptyState(), response: "Done" };

function diagnostics(overrides: Partial<StatusDiagnostics> = {}): StatusDiagnostics {
	return {
		repositoryRoot: "/tmp/knowledge",
		cwdScopeKey: "--tmp-project--hash",
		sessionScopeKey: "session-hash",
		scopeStates: {
			global: { ...emptyState(), contract: { shared: true } },
			cwd: { ...emptyState(), working: { project: true } },
			session: sessionState,
		},
		recent: [],
		historyLimit: 7,
		temporal: { head: { id: "origin", position: 7, parent: null }, historyDepth: 0, tailCounts: { global: 1, cwd: 2, session: 0 }, revisions: { global: 15, cwd: 8, session: 31 } },
		staleArtifacts: [],
		...overrides,
	};
}

test("uses one stable status ownership key", () => {
	assert.equal(STATUS_KEY, "state-flow");
});

test("renders only the state-flow name and mode, hiding only off", () => {
	const colorize = (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`;
	const revisions = { global: 15, cwd: 8, session: 31 };
	assert.equal(compactStatus(snapshot, revisions, colorize), "<accent>state-flow</accent> <dim>active</dim>");
	const passive = { ...snapshot, config: { mode: "passive" as const } };
	assert.equal(compactStatus(passive, revisions, colorize), "<accent>state-flow</accent> <dim>passive</dim>");
	assert.equal(compactStatus({ ...snapshot, config: { mode: "off" as const } }, revisions, colorize), undefined);
});

test("a passive patch keeps the compact mode stable and exposes revisions only in detailed status", async () => {
	const h = harness({ mode: "passive" });
	await h.tools.get("patch_state")!.execute("passive", { global: { working: { passiveCounter: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.mode, "passive");
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>passive</dim>");
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Scope revisions: g1c0s0/);
});

test("distinguishes branch diagnostics and renders only effective memory as JSON", () => {
	const output = detailedStatus(snapshot, diagnostics());
	assert.doesNotMatch(output, /session mode=|State Flow diagnostics|Session files:|Memory-bearing scopes:|Memory: owner|Temporal head:|Retained patch tails:|Recent transitions:|Pending artifact invalidations: none/);
	assert.match(output, /Repository: \/tmp\/knowledge/);
	assert.match(output, /Scope keys: CWD --tmp-project--hash; session session-hash/);
	assert.match(output, /^Runtime metadata: step #7$/m);
	assert.doesNotMatch(output, /Remote publication|Remote queue/);
	assert.match(output, /^Scope revisions: g15c8s31$/m);
	assert.match(output, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.doesNotMatch(output, /Artifacts:/);
	const marker = output.match(/Effective memory:\n\n/);
	assert.ok(marker?.index !== undefined);
	const json = output.slice(marker.index + marker[0].length);
	const memory = JSON.parse(json);
	assert.equal(json.split(",\n\n  \"").length, Object.keys(memory).length, "one blank line between every top-level plane");
	assert.deepEqual(memory, {
		artifacts: {},
		contract: { shared: true },
		working: { project: true },
		intents: {},
		response: "Done",
		lazy: {},
	});
	assert.equal(Object.hasOwn(memory, "global"), false);
	assert.equal(Object.hasOwn(memory, "cwd"), false);
	assert.equal(Object.hasOwn(memory, "session"), false);
});

test("blank lines separate only top-level planes, leaving nested JSON intact", () => {
	const output = detailedStatus(snapshot, diagnostics({ effectiveState: {
		intents: { task: { first: 1, second: 2 } },
		working: { items: [{ a: 1, b: 2 }] },
	} }));
	const json = output.split("Effective memory:\n\n")[1];
	assert.equal(json, '{\n  "intents": {\n    "task": {\n      "first": 1,\n      "second": 2\n    }\n  },\n\n  "working": {\n    "items": [\n      {\n        "a": 1,\n        "b": 2\n      }\n    ]\n  }\n}');
	assert.deepEqual(JSON.parse(json), { intents: { task: { first: 1, second: 2 } }, working: { items: [{ a: 1, b: 2 }] } });
});

test("omits ownership boilerplate without interpreting promotion-shaped user data", () => {
	const output = detailedStatus(snapshot, diagnostics({
		scopeStates: {
			global: { ...emptyState(), working: { memory_promotions: { ordinaryUserData: true } } },
			cwd: emptyState(),
			session: sessionState,
		},
	}));
	assert.match(output, /"ordinaryUserData": true/);
	assert.doesNotMatch(output, /Memory: owner|Memory-bearing scopes:|Promotion status|Memory promotions/);
});

test("reports inspectable stale reasons", () => {
	const output = detailedStatus(snapshot, diagnostics({
		staleArtifacts: [
			{ scope: "global", path: "/knowledge/new.md", reason: "new" },
			{ scope: "global", path: "/knowledge/gone.md", reason: "source-removed" },
		],
	}));
	assert.match(output, /^Pending artifact invalidations:$/m);
	assert.match(output, /\[global\] \/knowledge\/new\.md — new/);
	assert.match(output, /\[global\] \/knowledge\/gone\.md — source-removed/);
});

test("a mode-change write fence is not reported as unavailable accepted memory", () => {
	const output = detailedStatus({ ...snapshot, config: { mode: "passive" as const } }, diagnostics({ publicationError: "Writer advanced\nRetry Start" }));
	assert.doesNotMatch(output, /session mode=/);
	assert.match(output, /^Memory writes paused after mode change: Writer advanced Retry Start$/m);
	assert.match(output, /"response": "Done"/);
	assert.doesNotMatch(output, /materialization unavailable|Effective memory: unavailable/);
});

test("unavailable-state status keeps its error reason on one line", () => {
	const output = detailedStatus(snapshot, diagnostics({ temporal: undefined, durableStateError: "First cause\n\nSecond paragraph" }));
	assert.match(output, /^Temporal materialization unavailable: First cause Second paragraph$/m);
	assert.doesNotMatch(output, /First cause\n\nSecond paragraph/);
});

test("status preserves the reason and target of long-path availability and publication failures", () => {
	const path = `/store/${"long directory/".repeat(40)}meta.json`;
	const error = `State Flow provenance file: ${JSON.stringify(path)} contains invalid JSON`;
	for (const unavailable of [false, true]) {
		const output = detailedStatus(snapshot, diagnostics(unavailable
			? { temporal: undefined, durableStateError: error }
			: { publicationError: error }));
		const line = output.split("\n").find((line) => line.startsWith(unavailable ? "Temporal materialization unavailable:" : "Memory writes paused after mode change:"))!;
		assert.match(line, /meta\.json/);
		assert.match(line, /contains invalid JSON$/);
		assert.ok(line.length <= 260);
	}
});

test("unavailable temporal state is not represented as empty materialization or zero history", async () => {
	const h = harness();
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const before = execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	await h.commands.get("state-flow-status").handler("", h.ctx);
	const output = h.notifications.at(-1)!;
	assert.match(output, /Temporal materialization unavailable/);
	assert.match(output, /Hot history: unavailable; configured maximum depth 7/);
	assert.doesNotMatch(output, /cold Git|offsets beyond 7/);
	assert.match(output, /Effective memory: unavailable/);
	assert.doesNotMatch(output, /Retained patch tails:|Artifacts:|Scope revisions:/);
	assert.doesNotMatch(output, /"artifacts"|"working"|Hot history: offsets/);
	assert.equal(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), before);
	assert.deepEqual(h.entries.map(({ data }) => data), [{ mode: "off" }]);
});

test("status distinguishes live shared tails from fresh restored-session depth", async () => {
	const h = harness();
	await start(h);
	let oldEntries: any[] = [];
	for (let n = 1; n <= 8; n++) {
		await h.tools.get("patch_state").execute("global", { global: { working: { n } } }, undefined, undefined, h.ctx);
		if (n === 1) oldEntries = structuredClone(h.entries);
	}
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.7; maximum depth 7/);
	assert.match(h.notifications.at(-1)!, /Scope revisions: g8c0s0/);
	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "new-origin", mode: "active" });
	await next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	await next.commands.get("state-flow-status").handler("", next.ctx);
	assert.match(next.notifications.at(-1)!, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.match(next.notifications.at(-1)!, /Scope revisions: g8c0s0/);
	const files = execFileSync("git", ["-C", h.repositoryRoot, "ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	const bytes = files.map((file) => readFileSync(join(h.repositoryRoot, file)));
	h.ctx.sessionManager.getBranch = () => oldEntries;
	await h.handlers.get("session_tree")!({}, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"n": 8/);
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.[01]; maximum depth 7/);
	for (const [index, file] of files.entries()) assert.deepEqual(readFileSync(join(h.repositoryRoot, file)), bytes[index]);
});

test("the status command neither discovers unregistered files nor reads source bodies", async () => {
	const h = harness();
	const path = join(h.repositoryRoot, "operator-note.md");
	writeFileSync(path, "SECRET SOURCE BODY\n");
	await start(h);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	const output = h.notifications.at(-1)!;
	assert.doesNotMatch(output, /^Artifacts:/m);
	assert.doesNotMatch(output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(output, /SECRET SOURCE BODY/);
});

test("detailed status reports per-scope plane sizes and intent-owned working/lazy shares without model-facing state", () => {
	const output = detailedStatus(snapshot, diagnostics({
		scopeStates: {
			global: { ...emptyState(), contract: { shared: true } },
			cwd: { ...emptyState(),
				intents: { task: { owns: [{ $ref: "cwd.working.draft.part" }, { $ref: "cwd.lazy.plan" }, { $ref: "session.working.free" }], uses: "$cwd.working.free" } },
				working: { draft: { part: 1 }, free: "é" }, lazy: { plan: [1], other: 2 } },
			session: { ...emptyState(), working: { free: true }, response: "Done" },
		},
	}));
	const lines = output.split("\n");
	assert.equal('{"draft":{"part":1},"free":"é"}'.length, 31, "sizes count UTF-8 bytes, not UTF-16 units");
	const start = lines.indexOf("Scope memory:");
	assert.ok(start > 0 && start < lines.indexOf("Effective memory:"));
	const cwdState = '{"task":{"owns":[{"$ref":"cwd.working.draft.part"},{"$ref":"cwd.lazy.plan"},{"$ref":"session.working.free"}],"uses":"$cwd.working.free"}}';
	assert.deepEqual(lines.slice(start + 1, start + 4), [
		"- global: contract 15 B",
		`- cwd: intents ${cwdState.length} B, working 32 B, lazy 22 B; intent-owned working 1/2, lazy 1/2`,
		"- session: working 13 B, response 6 B; intent-owned working 0/1",
	]);
	assert.doesNotMatch(detailedStatus(snapshot, diagnostics({ temporal: undefined, durableStateError: "unavailable" })), /Scope memory:/);
	const empty = { ...emptyState() };
	assert.doesNotMatch(detailedStatus(snapshot, diagnostics({ scopeStates: { global: empty, cwd: empty, session: empty } })), /Scope memory:/);
});
