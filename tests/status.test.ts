import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import * as observationFixture from "./observation-fixture.ts";
import { retainedMemoryScopes } from "../lib/memory.ts";
import { emptySnapshot } from "../lib/snapshot.ts";
import { compactStatus, detailedStatus, formatScopeRevisionVector, scopeMemoryLines, STATUS_KEY, type StatusDiagnostics } from "../lib/status.ts";
import { emptyState } from "../lib/state.ts";
import { harness, start } from "./harness.ts";
import { nativePolicyMarker } from "./temporal-fixture.ts";

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
			global: { ...emptyState(), strategy: { shared: true } },
			cwd: { ...emptyState(), tactics: { project: true } },
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

test("failed Active is visibly blocked while inactive policies never claim an inference fence", () => {
	const failed = { ...snapshot, meta: { step: 0, validation: { attempt: 0, error: "Expired history", instruction: "Recover" } } };
	const revisions = { global: 0, cwd: 0, session: 0 };
	for (const mode of ["active", "passive", "off"] as const) {
		const selected = { ...failed, config: { mode } };
		assert.equal(compactStatus(selected, revisions, (_color, text) => text), mode === "off" ? undefined : `state-flow ${mode === "active" ? "active (blocked)" : mode}`);
		const output = detailedStatus(selected, diagnostics({ temporal: undefined, durableStateError: "Expired history" }));
		assert.equal(output.includes("Inference blocked:"), mode === "active");
		assert.match(output, new RegExp(`Mode: ${mode}`));
	}
});

test("a passive patch keeps the compact mode stable and exposes revisions only in detailed status", async () => {
	const h = harness({ mode: "passive" });
	await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	await h.tools.get("patch_state")!.execute("passive", { global: { tactics: { passiveCounter: true } } }, undefined, undefined, h.ctx);
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
		strategy: { shared: true },
		tactics: { project: true },
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
		tactics: { items: [{ a: 1, b: 2 }] },
	} }));
	const json = output.split("Effective memory:\n\n")[1];
	assert.equal(json, '{\n  "intents": {\n    "task": {\n      "first": 1,\n      "second": 2\n    }\n  },\n\n  "tactics": {\n    "items": [\n      {\n        "a": 1,\n        "b": 2\n      }\n    ]\n  }\n}');
	assert.deepEqual(JSON.parse(json), { intents: { task: { first: 1, second: 2 } }, tactics: { items: [{ a: 1, b: 2 }] } });
});

test("omits ownership boilerplate without interpreting promotion-shaped user data", () => {
	const output = detailedStatus(snapshot, diagnostics({
		scopeStates: {
			global: { ...emptyState(), tactics: { memory_promotions: { ordinaryUserData: true } } },
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
	assert.doesNotMatch(output, /"artifacts"|"tactics"|Hot history: offsets/);
	assert.equal(execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), before);
	assert.deepEqual(h.entries.map(({ data }) => data), [nativePolicyMarker("harness-session", "off")]);
});

test("status keeps live shared tails and full hot history after old-step tree navigation", async () => {
	const h = harness();
	await start(h);
	let oldEntries: any[] = [];
	for (let n = 1; n <= 8; n++) {
		await h.tools.get("patch_state").execute("global", { global: { tactics: { n } } }, undefined, undefined, h.ctx);
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
	assert.match(h.notifications.at(-1)!, /Hot history: offsets 0\.\.7; maximum depth 7/, "an old Pi step does not discard retained history");
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
			global: { ...emptyState(), strategy: { shared: true } },
			cwd: { ...emptyState(),
				intents: { task: { owns: [{ $ref: "cwd.tactics.draft.part" }, { $ref: "cwd.lazy.plan" }, { $ref: "session.tactics.free" }], uses: "$cwd.tactics.free" } },
				tactics: { draft: { part: 1 }, free: "é" }, lazy: { plan: [1], other: 2 } },
			session: { ...emptyState(), tactics: { free: true }, response: "Done" },
		},
	}));
	const lines = output.split("\n");
	assert.equal('{"draft":{"part":1},"free":"é"}'.length, 31, "sizes count UTF-8 bytes, not UTF-16 units");
	const start = lines.indexOf("Scope memory:");
	assert.ok(start > 0 && start < lines.indexOf("Effective memory:"));
	const cwdState = '{"task":{"owns":[{"$ref":"cwd.tactics.draft.part"},{"$ref":"cwd.lazy.plan"},{"$ref":"session.tactics.free"}],"uses":"$cwd.tactics.free"}}';
	assert.deepEqual(lines.slice(start + 1, start + 4), [
		"- global: strategy 15 B",
		`- cwd: intents ${cwdState.length} B, tactics 32 B, lazy 22 B; intent-owned tactics 1/2, lazy 1/2`,
		"- session: tactics 13 B, response 6 B; intent-owned tactics 0/1",
	]);
	assert.doesNotMatch(detailedStatus(snapshot, diagnostics({ temporal: undefined, durableStateError: "unavailable" })), /Scope memory:/);
	const empty = { ...emptyState() };
	assert.doesNotMatch(detailedStatus(snapshot, diagnostics({ scopeStates: { global: empty, cwd: empty, session: empty } })), /Scope memory:/);
});

{
	const { scopes, selections, forbidden, diagnostics, memoryJson, withoutFileIO, fixture } = observationFixture;

	test("selected status renders exact sparse owners/revisions across all subsets and modes, with no fabricated defaults", () => {
		for (const selection of selections) for (const mode of ["active", "passive", "off"] as const) {
			const input = diagnostics(selection), before = structuredClone(input);
			const output = withoutFileIO(() => detailedStatus(emptySnapshot(mode), input));
			assert.match(output, new RegExp(`^Selected scopes: ${selection.join(", ")}$`, "m"));
			assert.match(output, new RegExp(`^Scope revisions: ${selection.map(scope => `${scope[0]}4`).join("")}$`, "m"));
			assert.deepEqual(memoryJson(output), { strategy: Object.fromEntries(selection.map(scope => [scope, true])) });
			assert.doesNotMatch(output, /undefined|artifacts|"intents"|"response"|"lazy"/);
			for (const excluded of scopes.filter(scope => !selection.includes(scope))) {
				assert.equal(Object.hasOwn(retainedMemoryScopes(input.scopeStates, selection), excluded), false);
				assert.doesNotMatch(output, new RegExp(`^- ${excluded}:`, "m"));
				if (excluded === "cwd") assert.doesNotMatch(output, /cwd-key/);
				if (excluded === "session") assert.doesNotMatch(output, /session-key/);
			}
			assert.deepEqual(input, before);
			assert.deepEqual(retainedMemoryScopes(input.scopeStates, selection), Object.fromEntries(selection.map(scope => [scope, true])));
			const empty = diagnostics(selection, Object.fromEntries(selection.map(scope => [scope, {}])));
			assert.deepEqual(memoryJson(detailedStatus(emptySnapshot(mode), empty)), {});
			assert.deepEqual(retainedMemoryScopes(empty.scopeStates, selection), Object.fromEntries(selection.map(scope => [scope, false])));
		}
	});

	test("selected status ignores stale full-owner effective overrides and disabled key/notice payload getters", () => {
		for (const selection of selections) {
			const input = diagnostics(selection);
			Object.defineProperty(input, "effectiveState", { get: forbidden });
			if (!selection.includes("cwd")) Object.defineProperty(input, "cwdScopeKey", { get: forbidden });
			if (!selection.includes("session")) Object.defineProperty(input, "sessionScopeKey", { get: forbidden });
			const selected = selection[0];
			input.scopeStates[selected]!.artifacts = { "/selected-source": { description: "Registered only; no body read" } };
			input.staleArtifacts = scopes.map(scope => selection.includes(scope)
				? { scope, path: `/source-${scope}`, reason: "new" }
				: { scope, get path(): never { return forbidden(); }, get reason(): never { return forbidden(); } });
			const output = withoutFileIO(() => detailedStatus(emptySnapshot("active"), input));
			assert.match(output, new RegExp(`Artifacts: .*pending invalidations ${selection.length}`));
			for (const scope of scopes) assert.equal(output.includes(`[${scope}] /source-${scope} — new`), selection.includes(scope));
		}
	});

	test("selected diagnostics refuse missing/extra owners and invalid numbers before any excluded payload is observed", () => {
		const states = { cwd: {}, get global(): never { return forbidden(); } };
		for (const invoke of [() => scopeMemoryLines(states, ["cwd"]), () => retainedMemoryScopes(states, ["cwd"]),
			() => detailedStatus(emptySnapshot("active"), diagnostics(["cwd"], states))]) assert.throws(invoke, /values must match their owners exactly/);
		assert.throws(() => retainedMemoryScopes({ cwd: {} } as any), /values must match/);
		assert.throws(() => scopeMemoryLines({ cwd: {} }), /values must match/);
		assert.throws(() => detailedStatus(emptySnapshot("active"), { ...diagnostics(["cwd"]), selection: undefined }), /values must match/);
		assert.throws(() => retainedMemoryScopes({ cwd: { strategy: null } } as any, ["cwd"]), /Invalid selected/);
		for (const invalid of [{}, { cwd: undefined }, { cwd: -1 }, { cwd: 1.5 }, { cwd: Infinity }, { cwd: NaN }, { cwd: Number.MAX_SAFE_INTEGER + 1 },
			{ cwd: 4, get global(): never { return forbidden(); } }]) {
			assert.throws(() => formatScopeRevisionVector(invalid as any, ["cwd"]), /Invalid State Flow selected revision vector/);
			const input = diagnostics(["cwd"]); input.temporal!.tailCounts = invalid as any;
			assert.throws(() => detailedStatus(emptySnapshot("active"), input), /Invalid State Flow selected tail counts/);
		}
		for (const invalid of [null, [], ["cwd", "cwd"], "cwd"]) assert.throws(() => detailedStatus(emptySnapshot("active"), { ...diagnostics(["global", "cwd", "session"]), selection: invalid as any }), /scopes must be/);
		assert.equal(formatScopeRevisionVector({ cwd: 0 }, ["cwd"]), "c0");
		assert.equal(formatScopeRevisionVector({ global: 7, session: 4 }, ["session", "global"]), "g7s4");
		assert.equal(formatScopeRevisionVector({ global: 1, cwd: 2, session: 3 }), "g1c2s3");
	});

	test("unavailable diagnostics do not observe any semantic/vector/notice body or invent zero history", () => {
		const input = diagnostics(["global"]);
		Object.defineProperties(input, {
			scopeStates: { get: forbidden }, effectiveState: { get: forbidden }, staleArtifacts: { get: forbidden }, recent: { get: forbidden },
			cwdScopeKey: { get: forbidden }, sessionScopeKey: { get: forbidden },
		});
		input.temporal = { get head(): never { return forbidden(); }, get tailCounts(): never { return forbidden(); }, get revisions(): never { return forbidden(); }, get historyDepth(): never { return forbidden(); } };
		input.durableStateError = "Current memory unavailable\nCause retained";
		input.publicationError = "Write fence\nRemains";
		const output = withoutFileIO(() => detailedStatus(emptySnapshot("active"), input));
		assert.match(output, /^Temporal materialization unavailable: Current memory unavailable Cause retained$/m);
		assert.match(output, /^Memory writes paused after mode change: Write fence Remains$/m);
		assert.match(output, /Hot history: unavailable/); assert.match(output, /Effective memory: unavailable/);
		assert.doesNotMatch(output, /Scope revisions:|Artifacts:|Scope memory:|offsets 0/);
	});

	test("compact Off and enabled mode labels remain independent of vector/state observation", () => {
		const unreadable = new Proxy({}, { get: forbidden, ownKeys: forbidden });
		withoutFileIO(() => {
			assert.equal(compactStatus({ config: { mode: "off" }, get meta(): never { return forbidden(); } }, unreadable, forbidden), undefined);
			for (const mode of ["active", "passive"] as const) assert.equal(compactStatus(emptySnapshot(mode), unreadable, (_color, text) => text), `state-flow ${mode}`);
		});
	});

	test("footprints count only selected present planes and same-owner intent targets, preserving shared response compatibility data", () => {
		const states = { cwd: { strategy: { chosen: true }, intents: { task: { $ref: "cwd.lazy.plan" }, foreign: { $ref: "session.lazy.foreign" } },
			tactics: { free: "é" }, lazy: { plan: [1], free: 2 }, response: "retained old shared value" } };
		const output = detailedStatus(emptySnapshot("active"), diagnostics(["cwd"], states));
		assert.match(output, /intent-owned tactics 0\/1, lazy 1\/2/);
		assert.match(output, /tactics 13 B/);
		assert.equal(memoryJson(output).response, "retained old shared value", "observation does not delete/relocate old shared response data or imply new shared authorship");
		assert.deepEqual(retainedMemoryScopes({ cwd: { intents: { only: true }, artifacts: {} } }, ["cwd"]), { cwd: false }, "existing strategy/tactics memory-bearing meaning is unchanged");
	});

	test("diagnostic history uses actual selected lineage, not the number of visible selected recent patches", async t => {
		const f = await fixture(t, ["global", "session"]);
		await f.patch({ global: { strategy: { onlyExcludedLater: true } } });
		await f.runtime.withSelectedCurrentTransaction(["session"], (_snapshot, publish) => publish(), () => {});
		assert.deepEqual(f.runtime.recent(), []);
		const output = withoutFileIO(() => detailedStatus(f.snapshot(), f.observe()));
		assert.match(output, /^Scope revisions: s0$/m); assert.match(output, /Hot history: offsets 0\.\.1/);
		assert.deepEqual(memoryJson(output), {});
	});
}
