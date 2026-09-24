import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { compactStatus, detailedStatus, STATUS_KEY, type StatusDiagnostics } from "../lib/status.ts";
import { emptyState } from "../lib/state.ts";
import { harness, start } from "./harness.ts";

const snapshot = {
	config: { enabled: true },
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

test("renders the effective revision vector only while active mode is enabled", () => {
	const colorize = (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`;
	const revisions = { global: 15, cwd: 8, session: 31 };
	assert.equal(compactStatus(snapshot, revisions, colorize), "<accent>state-flow</accent> <dim>G15/C8/S31</dim>");
	assert.equal(compactStatus({ ...snapshot, config: { enabled: false } }, revisions, colorize), undefined);
});

test("a passive patch advances semantic history without rendering active status", async () => {
	const h = harness({ passiveTools: true });
	await h.tools.get("patch_state")!.execute("passive", { global: { working: { passiveCounter: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.resolveSnapshot().config.enabled, false);
	assert.equal(h.resolveSnapshot().meta.step, 1);
	assert.equal(h.statuses.at(-1), undefined);
});

test("distinguishes branch diagnostics and renders only effective memory as JSON", () => {
	const output = detailedStatus(snapshot, diagnostics());
	assert.match(output, /^State Flow diagnostics — config\.enabled=true; branch mode=active/);
	assert.match(output, /Repository: \/tmp\/knowledge/);
	assert.match(output, /Scope keys: CWD --tmp-project--hash; session session-hash/);
	assert.match(output, /Session files: config\.json owns behavior; runtime\.json owns branch recovery; meta\.json owns scope provenance/);
	assert.match(output, /Runtime metadata: step #7; bootstrap false/);
	assert.doesNotMatch(output, /Remote publication|Remote queue/);
	assert.match(output, /Temporal head: "origin"; branch-local position 7/);
	assert.match(output, /Scope revisions: global #15; CWD #8; session #31; effective G15\/C8\/S31/);
	assert.match(output, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.match(output, /Retained patch tails: global 1; CWD 2; session 0/);
	assert.match(output, /Artifacts: global 0; CWD 0; session 0; pending invalidations 0/);
	assert.match(output, /Recent transitions: global 0; CWD 0; session 0; active 0/);
	const marker = output.match(/Effective memory \(\d+ JSON bytes; global → CWD → session overlay\):\n\n/);
	assert.ok(marker?.index !== undefined);
	const memory = JSON.parse(output.slice(marker.index + marker[0].length));
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

test("summarizes memory ownership without interpreting promotion-shaped user data", () => {
	const output = detailedStatus(snapshot, diagnostics({
		scopeStates: {
			global: { ...emptyState(), working: { memory_promotions: { ordinaryUserData: true } } },
			cwd: emptyState(),
			session: sessionState,
		},
	}));
	assert.match(output, /Memory: owner state-flow; global retention enabled; global fallback active/);
	assert.match(output, /Memory-bearing scopes: global true; CWD false; session false/);
	assert.doesNotMatch(output, /Promotion status|Memory promotions/);
});

test("reports inspectable stale reasons", () => {
	const output = detailedStatus(snapshot, diagnostics({
		staleArtifacts: [
			{ scope: "global", path: "/knowledge/new.md", reason: "new" },
			{ scope: "global", path: "/knowledge/gone.md", reason: "source-removed" },
		],
	}));
	assert.match(output, /pending invalidations 2/);
	assert.match(output, /\[global\] \/knowledge\/new\.md — new/);
	assert.match(output, /\[global\] \/knowledge\/gone\.md — source-removed/);
});

test("a Stop write fence is not reported as unavailable accepted memory", () => {
	const output = detailedStatus({ ...snapshot, config: { enabled: false } }, diagnostics({ publicationError: "Writer advanced\nRetry Start" }));
	assert.match(output, /branch mode=inactive/);
	assert.match(output, /^Memory writes paused after Stop: Writer advanced Retry Start$/m);
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
		const line = output.split("\n").find((line) => line.startsWith(unavailable ? "Temporal materialization unavailable:" : "Memory writes paused after Stop:"))!;
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
	assert.match(output, /Retained patch tails: unavailable/);
	assert.match(output, /Artifacts: global unknown; CWD unknown; session unknown; pending invalidations unavailable/);
	assert.doesNotMatch(output, /"artifacts"|"working"|Hot history: offsets/);
	assert.equal(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), before);
	assert.equal(h.entries.length, 0);
});

test("status distinguishes live shared tails from fresh restored-session depth", async () => {
	const h = harness();
	await start(h);
	const heads: string[] = [];
	let oldEntries: any[] = [];
	for (let n = 1; n <= 8; n++) {
		await h.tools.get("patch_state").execute("global", { global: { working: { n } } }, undefined, undefined, h.ctx);
		const read = await h.tools.get("read_state").execute("head", { path: "global.patches[0]" }, undefined);
		heads.push(read.details.transitionId);
		if (n === 1) oldEntries = structuredClone(h.entries);
	}
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.7; maximum depth 7/);
	assert.match(h.notifications.at(-1)!, /Retained patch tails: global 7; CWD 0; session 0/);
	assert.ok(h.notifications.at(-1)!.includes(`Temporal head: "${heads.at(-1)}"`));
	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "new-origin", autoStart: true });
	await next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	await next.commands.get("state-flow-status").handler("", next.ctx);
	assert.match(next.notifications.at(-1)!, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.match(next.notifications.at(-1)!, /Retained patch tails: global 7; CWD 0; session 0/);
	assert.match(next.notifications.at(-1)!, /Recent transitions: global 0; CWD 0; session 0; active 0/);
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
	assert.match(output, /Artifacts: global 0; CWD 0; session 0; pending invalidations 0/);
	assert.doesNotMatch(output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(output, /SECRET SOURCE BODY/);
});
