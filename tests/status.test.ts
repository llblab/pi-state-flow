import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveGitPushDestination } from "../lib/git.ts";
import { publicationQueuePath } from "../lib/publication.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type StatusDiagnostics } from "../lib/status.ts";
import { emptyState } from "../lib/state.ts";
import { harness, start } from "./harness.ts";

const snapshot = {
	config: { enabled: true },
	meta: { step: 7, durableBase: "abcdef1234567890" },
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
		temporal: { head: { id: "origin", position: 7, parent: null }, historyDepth: 0, tailCounts: { global: 1, cwd: 2, session: 0 } },
		staleArtifacts: [],
		...overrides,
	};
}

test("uses one stable status ownership key", () => {
	assert.equal(STATUS_KEY, "state-flow");
});

test("renders compact status only while enabled", () => {
	const colorize = (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`;
	assert.equal(compactStatus(snapshot, colorize), "<accent>state-flow</accent> <dim>#7</dim>");
	assert.equal(compactStatus({ ...snapshot, config: { enabled: false } }, colorize), undefined);
});

test("distinguishes branch, durable scopes, session state, and the effective overlay", () => {
	const output = detailedStatus(snapshot, diagnostics());
	assert.match(output, /^State Flow diagnostics — config\.enabled=true; branch mode=active/);
	assert.match(output, /Repository: \/tmp\/knowledge/);
	assert.match(output, /Scope keys: CWD --tmp-project--hash; session session-hash/);
	assert.match(output, /Session files: config\.json owns behavior; meta\.json owns lineage and provenance/);
	assert.match(output, /Runtime metadata: step #7; active revision abcdef1234567890/);
	assert.match(output, /Remote publication policy: legacy-transition/);
	assert.match(output, /Remote queue: idle/);
	assert.match(output, /Temporal head: "origin"; branch-local position 7/);
	assert.match(output, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.match(output, /Retained patch tails: global 1; CWD 2; session 0/);
	assert.match(output, /Artifacts: global 0; CWD 0; session 0; stale 0/);
	assert.match(output, /Recent transitions: global 0; CWD 0; session 0; active 0/);
	assert.match(output, /Publication: idle/);
	assert.match(output, /Materialized states \(\d+ bytes; global\/CWD\/session Git-backed, effective overlay\):\n\n\{/);
	assert.match(output, /"shared": true/);
	assert.match(output, /"project": true/);
	assert.match(output, /"response": "Done"/);
});

test("summarizes memory ownership, scopes, and promotion recovery without requiring an external schema", () => {
	const output = detailedStatus(snapshot, diagnostics({
		scopeStates: {
			global: { ...emptyState(), working: { durableCandidate: "retained", memory_promotions: {
				preference: { status: "failed", owner: "knowledge", pointer: "MEMORY.md#preference", error: "write rejected" },
				accepted: { status: "accepted", owner: "knowledge", pointer: "MEMORY.md#accepted", revision: "abc123" },
			} } },
			cwd: emptyState(),
			session: sessionState,
		},
	}));
	assert.match(output, /Memory: owner state-flow; global retention enabled; global fallback active/);
	assert.match(output, /Memory-bearing scopes: global true; CWD false; session false/);
	assert.match(output, /Promotion status: pending 0; accepted 1; failed 1; unknown 0; invalid 0/);
	assert.match(output, /preference — failed; owner knowledge; pointer MEMORY\.md#preference; error write rejected/);
	assert.match(output, /accepted — accepted; owner knowledge; pointer MEMORY\.md#accepted; revision abc123/);
});

test("reports malformed durable queue state as unavailable rather than idle", () => {
	const output = detailedStatus(snapshot, diagnostics({ publicationQueueError: "Invalid publication queue JSON" }));
	assert.match(output, /Remote queue: unavailable; error Invalid publication queue JSON/);
	assert.doesNotMatch(output, /Remote queue: idle/);
});

test("reports durable remote queue target, confirmation, attempts, and bounded failure", () => {
	const output = detailedStatus(snapshot, diagnostics({
		publicationQueue: {
			version: 1,
			destination: { gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" },
			target: "a".repeat(40), confirmed: "b".repeat(40), status: "failed", attempt: 2, error: "offline",
		},
	}));
	assert.match(output, /Remote queue: failed; target a{12}; confirmed b{12}; attempt 2; error offline/);
});

test("reports inspectable stale reasons and pending publication", () => {
	const output = detailedStatus(snapshot, diagnostics({
		staleArtifacts: [
			{ scope: "global", path: "/knowledge/new.md", reason: "new" },
			{ scope: "global", path: "/knowledge/gone.md", reason: "source-removed" },
		],
		pendingPublication: { commit: "1234567890abcdef", error: "remote unavailable" },
	}));
	assert.match(output, /stale 2/);
	assert.match(output, /\[global\] \/knowledge\/new\.md — new/);
	assert.match(output, /\[global\] \/knowledge\/gone\.md — source-removed/);
	assert.match(output, /Publication: pending 1234567890ab — remote unavailable/);
});

test("does not report an unknown freshness result as zero stale artifacts", () => {
	const output = detailedStatus(snapshot, diagnostics({
		artifactFreshnessError: "knowledge root unavailable",
	}));
	assert.match(output, /stale unknown/);
	assert.match(output, /Artifact freshness unavailable: knowledge root unavailable/);
});

test("status command exposes malformed queue persistence without starting a worker", async () => {
	const h = harness();
	await start(h);
	const destination = resolveGitPushDestination(h.repositoryRoot)!;
	const path = publicationQueuePath(destination);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{broken\n");
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Remote queue: unavailable; error Invalid publication queue JSON/);
});

test("unavailable temporal state is not represented as empty materialization or zero history", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const before = execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	await h.commands.get("state-flow-status").handler("", h.ctx);
	const output = h.notifications.at(-1)!;
	assert.match(output, /Temporal materialization unavailable/);
	assert.match(output, /Hot history: unavailable/);
	assert.match(output, /Retained patch tails: unavailable/);
	assert.match(output, /Artifacts: global unknown; CWD unknown; session unknown; stale unknown/);
	assert.match(output, /Materialized states: unavailable \(global\/CWD\/session\/effective\)/);
	assert.doesNotMatch(output, /"artifacts"|"working"|Hot history: offsets/);
	assert.equal(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), before);
	assert.equal(h.entries.length, 0);
});

test("status distinguishes retained shared tails from new-origin depth and restores selected head diagnostics", async () => {
	const h = harness();
	await start(h);
	const heads: string[] = [];
	let oldEntries: any[] = [];
	for (let n = 1; n <= 8; n++) {
		await h.tools.get("patch_state").execute("global", { global: { working: { n } } }, undefined, undefined, h.ctx);
		const read = await h.tools.get("read_state").execute("head", {}, undefined);
		heads.push(JSON.parse(read.content[0].text).boundary.id);
		if (n === 1) oldEntries = structuredClone(h.entries);
	}
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.7; maximum depth 7/);
	assert.match(h.notifications.at(-1)!, /Retained patch tails: global 7; CWD 0; session 0/);
	assert.ok(h.notifications.at(-1)!.includes(`Temporal head: "${heads.at(-1)}"`));
	const next = harness({ cwd: h.ctx.cwd, repositoryRoot: h.repositoryRoot, sessionId: "new-origin", autoStart: true });
	next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
	await next.commands.get("state-flow-status").handler("", next.ctx);
	assert.match(next.notifications.at(-1)!, /Hot history: offsets 0\.\.0; maximum depth 7/);
	assert.match(next.notifications.at(-1)!, /Retained patch tails: global 7; CWD 0; session 0/);
	assert.match(next.notifications.at(-1)!, /Recent transitions: global 0; CWD 0; session 0; active 0/);
	const files = execFileSync("git", ["-C", h.repositoryRoot, "ls-files"], { encoding: "utf8" }).trim().split("\n");
	const bytes = files.map((file) => readFileSync(join(h.repositoryRoot, file)));
	h.ctx.sessionManager.getBranch = () => oldEntries;
	h.handlers.get("session_tree")!({}, h.ctx);
	await h.commands.get("state-flow-status").handler("", h.ctx);
	assert.ok(h.notifications.at(-1)!.includes(`Temporal head: "${heads[0]}"`));
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.1; maximum depth 7/);
	for (const [index, file] of files.entries()) assert.deepEqual(readFileSync(join(h.repositoryRoot, file)), bytes[index]);
});

test("the status command classifies discovered global sources without dumping their bodies", async () => {
	const h = harness();
	const path = join(h.repositoryRoot, "operator-note.md");
	writeFileSync(path, "SECRET SOURCE BODY\n");
	await start(h);
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	const output = h.notifications.at(-1)!;
	assert.match(output, /Artifacts: global 0; CWD 0; session 0; stale 1/);
	assert.match(output, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — new`));
	assert.doesNotMatch(output, /SECRET SOURCE BODY/);
});
