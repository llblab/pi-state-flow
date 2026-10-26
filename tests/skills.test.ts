import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as sourceFacilityFixture from "./source-facility-fixture.ts";
import { stageSelectedScopePatches } from "../lib/transition.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { hashArtifactSource } from "../lib/artifact.ts";
import { loadCwdProvenance, loadCwdState } from "./temporal-fixture.ts";
import {
	hasCompiledSkillArtifact,
	hashSkillSource,
	registeredSkillResolver,
	SKILL_ARTIFACT_COMPILER,
	SkillReadTracker,
} from "../lib/skills.ts";
import { commitTerminal, harness, start } from "./harness.ts";

const skillRoot = mkdtempSync(join(tmpdir(), "pi-state-flow-skills-"));

async function patchCwdArtifacts(h: ReturnType<typeof harness>, artifacts: unknown) {
	return h.tools.get("patch_state")!.execute("compile-skill", { cwd: { artifacts } }, undefined, undefined, h.ctx);
}

function skillFile(name: string, body = `# ${name}\n\nOperational rules.`): string {
	const source = join(skillRoot, name, "SKILL.md");
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, body);
	return source;
}

function compilerOutput(rule = "Use the compiled route for current episode operations") {
	return {
		description: "Operational guidance for a test Skill",
		kind: "skill",
		compilation: { routing: rule, constraints: ["Do not reread solely for routine activation"] },
	};
}

function recordRead(h: ReturnType<typeof harness>, source: string, id = "skill-1", scope: "user" | "project" | "temporary" = "project"): void {
	h.registerSkill(source, scope);
	const input = { path: source };
	h.handlers.get("tool_call")!({ toolCallId: id, toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "read", result: {}, isError: false }, h.ctx);
}

test("discovers distinct operational and memory-curation Skills without diagnostics", () => {
	const root = join(import.meta.dirname, "..", "skills");
	const result = loadSkillsFromDir({ dir: root, source: "package:pi-state-flow" });
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["state-flow-guide", "state-flow-memory"]);
	const guide = result.skills.find((skill) => skill.name === "state-flow-guide")!;
	const memory = result.skills.find((skill) => skill.name === "state-flow-memory")!;
	assert.match(guide.description, /concrete read, patch, inheritance/);
	assert.match(guide.description, /not for memory audits or unsolicited cleanup/);
	const guideBody = readFileSync(guide.filePath, "utf8");
	assert.match(guideBody, /installed runtime protocol and schemas take precedence/);
	assert.match(guideBody, /ordinary completion requires no finalization patch/);
	assert.doesNotMatch(guideBody, /final:true|fallback/);
	assert.match(guideBody, /Missing history is not empty history/);
	assert.match(guideBody, /`\$`-prefixed `read_state` paths inside ordinary strings/);
	assert.match(guideBody, /Neither form proves authority or existence/);
	assert.match(guideBody, /Never scan or resolve references merely to test them/);
	assert.match(guideBody, /\{value:null, hint:\[\{type:"dangling-reference", message, paths\}\]\}/);
	assert.match(guideBody, /top-level diagnostic metadata/);
	assert.match(guideBody, /proves provenance rather than staleness/);
	assert.match(guideBody, /Never edit backing files, `response`, configuration, provenance, or runtime metadata/);
	assert.match(memory.description, /only on explicit user request/);
	assert.doesNotMatch(memory.description, /active State Flow feature/);
	assert.match(memory.description, /Not for routine turns, automatic phase-boundary audits, usage help, or background maintenance/);
	const memoryBody = readFileSync(memory.filePath, "utf8");
	assert.match(memoryBody, /Never give an assistant conclusion user authority/);
	assert.match(memoryBody, /Final remaining\/new same-scope intents protect direct, ancestor and descendant targets/);
	for (const body of [guideBody, memoryBody]) {
		assert.match(body, /Work from intents/);
		assert.match(body, /a textual `\$path` mention only uses it/);
		assert.match(body, /reasons for abandoned work to `strategy` as rejected approaches/);
		assert.match(body, /[Uu]nowned entries remain legal/);
		assert.match(body, /only intent ownership.* has a deletion consequence/);
	}
	assert.match(memoryBody, /Keep `lazy` shallow and priority-ordered/);
	assert.match(memoryBody, /`\$`-prefixed `read_state` paths inside ordinary strings/);
	assert.match(memoryBody, /Never scan or resolve references merely to find broken ones/);
	assert.match(memoryBody, /\{value:null, hint:\[\{type:"dangling-reference", message, paths\}\]\}/);
	assert.match(memoryBody, /top-level hint as conditional navigation and provenance/);
	assert.match(memoryBody, /one atomic multi-scope `patch_state` for destination and source changes/);
	assert.match(memoryBody, /Write and verify accepted content plus a content-bound revision or receipt/);
	assert.match(memoryBody, /before deleting or narrowing the State Flow source in a later patch/);
	assert.match(memoryBody, /Preserve it when acceptance is ambiguous/);
	assert.match(memoryBody, /fresh executor must recover constraints, results, open questions, commitments, and the next action/);
	assert.match(memoryBody, /Stop after this review, including when nothing needs changing/);
});

test("requested curation compiles an acquired Skill with one atomic scope move", async () => {
	const h = harness();
	await start(h);
	const patchState = h.tools.get("patch_state")!;
	const readState = h.tools.get("read_state")!;
	await patchState.execute("seed", {
		global: { strategy: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	const source = skillFile("curation-sequence");
	recordRead(h, source);
	await patchState.execute("independent", {
		session: { tactics: { unrelated: true } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.readState().tactics.unrelated, true);
	await patchState.execute("compile-and-move", {
		global: { strategy: { projectRule: null } },
		cwd: { strategy: { projectRule: "project-only" }, artifacts: { [source]: compilerOutput("Curate one requested cohort") } },
	}, undefined, undefined, h.ctx);
	const owners = await readState.execute("verify-owners", {
		paths: ["global.strategy", "cwd.strategy"],
	}, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(owners.content[0].text).value, [null, { projectRule: "project-only" }]);
	assert.equal(h.readState(1, "global").strategy.projectRule, "project-only");
	assert.equal(h.readState(1, "cwd").strategy.projectRule, undefined);
	assert.deepEqual(h.readState(0, "cwd").artifacts[source], compilerOutput("Curate one requested cohort"));
	const effective = await readState.execute("verify-effective", {
		path: "strategy.projectRule",
	}, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(effective.content[0].text).value, "project-only");
	assert.equal(h.readState(0, "global").strategy.projectRule, undefined);
	const terminal = await commitTerminal(h, {}, {}, "Curation verified.");
	assert.equal(terminal.message.content[0].text, "Curation verified.");
});

test("memory curation can narrow an established value without retaining two authoritative scopes", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state")!.execute("retain-global", {
		global: { strategy: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	await h.tools.get("patch_state")!.execute("narrow", {
		global: { strategy: { projectRule: null } },
		cwd: { strategy: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "global").strategy.projectRule, undefined);
	assert.equal(h.readState(0, "cwd").strategy.projectRule, "project-only");
	assert.equal(h.readState().strategy.projectRule, "project-only");
});

test("requires source-identified non-empty Skill artifact compilations", () => {
	const source = "/skills/demo/SKILL.md";
	const hash = hashArtifactSource("demo");
	assert.equal(hasCompiledSkillArtifact({
		[source]: {
			...compilerOutput(), hash, compiler: SKILL_ARTIFACT_COMPILER,
		},
	}, undefined, source, hash), true);
	assert.equal(hasCompiledSkillArtifact({
		[source]: {
			description: "empty", hash, compiler: SKILL_ARTIFACT_COMPILER, kind: "skill", compilation: {},
		},
	}, undefined, source, hash), false);
});

test("maps only registered Pi Skills from public command source metadata", () => {
	const resolve = registeredSkillResolver("/project", [
		{ source: "skill", sourceInfo: { path: "/user/global/SKILL.md", scope: "user" } },
		{ source: "skill", sourceInfo: { path: ".pi/skills/project/SKILL.md", scope: "project" } },
		{ source: "skill", sourceInfo: { path: "/tmp/one-shot/registered-source.md", scope: "temporary" } },
		{ source: "prompt", sourceInfo: { path: "/not-a-skill/SKILL.md", scope: "user" } },
		{ source: "skill", sourceInfo: { path: "/ambiguous/SKILL.md", scope: "user" } },
		{ source: "skill", sourceInfo: { path: "/ambiguous/SKILL.md", scope: "project" } },
	]);
	assert.deepEqual(resolve("/user/global/SKILL.md"), { path: "/user/global/SKILL.md", scope: "global" });
	assert.deepEqual(resolve(".pi/skills/project/SKILL.md"), { path: "/project/.pi/skills/project/SKILL.md", scope: "cwd" });
	assert.deepEqual(resolve("/tmp/one-shot/registered-source.md"), { path: "/tmp/one-shot/registered-source.md", scope: "session" });
	assert.equal(resolve("/not-a-skill/SKILL.md"), undefined);
	assert.equal(resolve("/unregistered/SKILL.md"), undefined);
	assert.equal(resolve("/ambiguous/SKILL.md"), undefined);
});

test("tracks the mutable executed registered Skill path, scope, and trusted hash", () => {
	const resolve = registeredSkillResolver("/", [{ source: "skill", sourceInfo: { path: "/skills/executed/registered-source.md", scope: "user" } }]);
	const tracker = new SkillReadTracker((source) => hashArtifactSource(`body:${source}`), resolve);
	const input = { path: "/skills/requested/SKILL.md" };
	tracker.recordStart("call-1", "read", { ...input });
	tracker.recordCall("call-1", "read", input);
	input.path = "/skills/executed/registered-source.md";
	tracker.recordEnd("call-1", "read", false);
	assert.deepEqual([...tracker.successful.values()], [{
		path: "/skills/executed/registered-source.md",
		scope: "global",
		hash: hashArtifactSource("body:/skills/executed/registered-source.md"),
	}]);
});

test("retains a registered successful read as a validation failure when source hashing fails", () => {
	const tracker = new SkillReadTracker(() => { throw new Error("source disappeared"); }, () => ({ path: "/skills/vanished/SKILL.md", scope: "session" }));
	tracker.recordCall("failed-hash", "read", { path: "/skills/vanished/SKILL.md" });
	tracker.recordEnd("failed-hash", "read", false);
	assert.deepEqual([...tracker.successful.values()], [{
		path: "/skills/vanished/SKILL.md", scope: "session", error: "source disappeared",
	}]);
});

test("discards unregistered, stale, failed, and mismatched lifecycle records", () => {
	const tracker = new SkillReadTracker(() => hashArtifactSource("body"), () => undefined);
	tracker.recordStart("reused", "read", { path: "/skills/stale/SKILL.md" });
	tracker.recordCall("reused", "bash", { command: "true" });
	tracker.recordEnd("reused", "read", false);
	tracker.recordCall("failed", "read", { path: "/skills/failed/SKILL.md" });
	tracker.recordEnd("failed", "read", true);
	assert.deepEqual([...tracker.successful.values()], []);
});

test("registered Skill acquisition does not block an independent patch and validates attempted compilation", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("required");
	recordRead(h, source);

	await h.tools.get("patch_state")!.execute("independent", { session: { tactics: { accepted: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").tactics.accepted, true);
	await assert.rejects(patchCwdArtifacts(h, { [source]: {} }), (error: unknown) => {
		return error instanceof Error
			&& error.message.includes(`cwd.artifacts[${JSON.stringify(source)}]`)
			&& error.message.includes("description must be non-empty")
			&& error.message.includes('kind must be "skill"')
			&& error.message.includes("compilation object must be non-empty")
			&& !error.message.includes("\n\n");
	});
	await patchCwdArtifacts(h, { [source]: compilerOutput() });
	const artifact = loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source];
	assert.deepEqual(artifact, compilerOutput());
	assert.deepEqual(loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[source], {
		sourceHash: hashSkillSource(source),
		compilerRevision: SKILL_ARTIFACT_COMPILER,
	});
	assert.equal(Object.hasOwn(h.entries.at(-1)!.data, "state"), false);
});

test("attributes Skill acquisition to mutable tool input in Pi event order", async () => {
	const h = harness();
	await start(h);
	const requested = skillFile("requested");
	const executed = skillFile("executed");
	h.registerSkill(executed);
	const input = { path: requested };
	h.handlers.get("tool_execution_start")!({ toolCallId: "skill-1", toolName: "read", args: { path: requested } }, h.ctx);
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	input.path = executed;
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: false }, h.ctx);
	await patchCwdArtifacts(h, { [requested]: compilerOutput("wrong") });
	assert.equal(loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[requested], undefined);
	await patchCwdArtifacts(h, { [executed]: compilerOutput("executed") });
	assert.equal(loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[executed]!.sourceHash, hashSkillSource(executed));
});

for (const [sourceScope, stateScope] of [["user", "global"], ["project", "cwd"], ["temporary", "session"]] as const) {
	test(`registered ${sourceScope} Skill acquisition targets ${stateScope} and matching hash is current`, async () => {
		const h = harness();
		await start(h);
		const source = skillFile(`scope-${sourceScope}`);
		h.registerSkill(source, sourceScope);
		const event = { toolCallId: `read-${sourceScope}`, toolName: "read", input: { path: source }, content: [{ type: "text", text: "Skill body" }], isError: false };
		const first = h.handlers.get("tool_result")!(event, h.ctx);
		assert.match(first.content.at(-1).text, new RegExp(`belongs at ${stateScope}\\.artifacts`));
		assert.match(first.content.at(-1).text, /Unrelated semantic patches do not need to include it/);
		await h.tools.get("patch_state")!.execute(`compile-${sourceScope}`, {
			[stateScope]: { artifacts: { [source]: compilerOutput(`${sourceScope} guidance`) } },
		}, undefined, undefined, h.ctx);
		assert.deepEqual(h.readState(0, stateScope).artifacts[source], compilerOutput(`${sourceScope} guidance`));
		assert.equal(h.handlers.get("tool_result")!(event, h.ctx), undefined, "matching source hash needs no new compilation hint");
		await h.tools.get("patch_state")!.execute(`independent-${sourceScope}`, { session: { tactics: { [sourceScope]: true } } }, undefined, undefined, h.ctx);
	});
}

test("a changed registered owner is reported without silently promoting the old compilation", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("owner-change");
	h.registerSkill(source, "project");
	const event = { toolCallId: "owner-change", toolName: "read", input: { path: source }, content: [{ type: "text", text: "Skill body" }], isError: false };
	h.handlers.get("tool_result")!(event, h.ctx);
	await patchCwdArtifacts(h, { [source]: compilerOutput("project version") });
	h.registerSkill(source, "user");
	const moved = h.handlers.get("tool_result")!(event, h.ctx);
	assert.match(moved.content.at(-1).text, /belongs at global\.artifacts/);
	assert.deepEqual(h.readState(0, "cwd").artifacts[source], compilerOutput("project version"));
	assert.equal(h.readState(0, "global").artifacts[source], undefined);
	await h.tools.get("patch_state")!.execute("move-owner", {
		global: { artifacts: { [source]: compilerOutput("portable version") } },
		cwd: { artifacts: { [source]: null } },
	}, undefined, undefined, h.ctx);
	assert.deepEqual(h.readState(0, "global").artifacts[source], compilerOutput("portable version"));
	assert.equal(h.readState(0, "cwd").artifacts[source], undefined);
});

test("an unregistered SKILL.md read has no acquisition semantics", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("unregistered");
	const result = h.handlers.get("tool_result")!({ toolCallId: "plain", toolName: "read", input: { path: source }, content: [{ type: "text", text: "Ordinary source" }], isError: false }, h.ctx);
	assert.equal(result, undefined);
	await h.tools.get("patch_state")!.execute("unrelated", { session: { tactics: { accepted: true } } }, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "session").tactics.accepted, true);
});

test("ordinary answers may retain a registered Skill read as volatile context", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("plain");
	h.registerSkill(source);
	h.handlers.get("tool_execution_start")!({ toolCallId: "plain", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "plain", toolName: "read", isError: false }, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Used the Skill without durable compilation." }] };
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Used the Skill without durable compilation.");
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source], undefined);
});

test("a pending optional Skill compilation schedules no repair inference", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("pending-answer");
	h.registerSkill(source);
	h.handlers.get("tool_execution_start")!({ toolCallId: "pending", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "pending", toolName: "read", isError: false }, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer with pending compilation." }] };
	h.handlers.get("message_end")!({ message }, h.ctx);
	await h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Answer with pending compilation.");
	assert.equal(h.sentMessages.length, 0, "pending acquisition must not schedule terminal repair");
	assert.equal(h.notifications.some((notice) => /could not reconcile/.test(notice)), false);
});

test("retains compatibility with execution-start updates after interception", async () => {
	const h = harness();
	await start(h);
	const requested = skillFile("compat-requested");
	const executed = skillFile("compat-executed");
	h.registerSkill(executed);
	const input = { path: requested };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_start")!({ toolCallId: "skill-1", toolName: "read", args: { path: executed } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: false }, h.ctx);
	await patchCwdArtifacts(h, { [requested]: compilerOutput("wrong") });
	await patchCwdArtifacts(h, { [executed]: compilerOutput("executed") });
	assert.equal(loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[executed]!.sourceHash, hashSkillSource(executed));
});

test("does not attribute stale reads when lifecycle ids are reused for other tools", async () => {
	const h = harness();
	await start(h);
	const stale = skillFile("stale");
	h.handlers.get("tool_execution_start")!({ toolCallId: "reused-id", toolName: "read", args: { path: stale } }, h.ctx);
	h.handlers.get("tool_call")!({ toolCallId: "reused-id", toolName: "bash", input: { command: "true" } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "reused-id", toolName: "bash", result: {}, isError: false }, h.ctx);
	const result = await commitTerminal(h, {}, {}, "No Skill acquired.");
	assert.equal(result.message.content[0].text, "No Skill acquired.");
});

test("falls back to intercepted input when a successful execution omits args", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("fallback");
	recordRead(h, source);
	const result = await commitTerminal(h, {}, {}, "Done", { [source]: compilerOutput("use intercepted input fallback") });
	assert.equal(result.message.content[0].text, "Done");
});

test("does not require compilation for a failed Skill read", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("failed");
	const input = { path: source };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: true }, h.ctx);
	const result = await commitTerminal(h, {}, {}, "Read failed.");
	assert.equal(result.message.content[0].text, "Read failed.");
});

test("a reread refreshes the runtime-owned source hash and replaces stale compilation metadata", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("changed", "first");
	recordRead(h, source, "first");
	await commitTerminal(h, {}, {}, "First", { [source]: { ...compilerOutput("first"), obsolete: true } });
	const firstHash = loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[source]!.sourceHash;

	writeFileSync(source, "second");
	await h.beginRun("Refresh");
	recordRead(h, source, "second");
	await commitTerminal(h, {}, {}, "Second", { [source]: compilerOutput("second") });
	const refreshed = loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source];
	const refreshedProvenance = loadCwdProvenance(h.ctx.cwd, h.repositoryRoot)[source]!;
	assert.notEqual(refreshedProvenance.sourceHash, firstHash);
	assert.equal(refreshedProvenance.sourceHash, hashSkillSource(source));
	assert.equal(refreshedProvenance.compilerRevision, SKILL_ARTIFACT_COMPILER);
	assert.equal(Object.hasOwn(refreshed, "obsolete"), false);
	assert.equal(refreshed.compilation?.routing, "second");
});

test("rejects model attempts to forge runtime-owned Skill provenance fields", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("forged");
	recordRead(h, source);
	const forged = { ...compilerOutput(), hash: hashArtifactSource("forged") };
	await assert.rejects(patchCwdArtifacts(h, { [source]: forged }), /cannot set runtime-owned field/);
});

{
	const { scopes, selections, fixture } = sourceFacilityFixture;

	test("registered Skill ownership survives disabled reads without hashing or compilation obligation; selection changes revoke pending and successful evidence", (t) => {
		const f = fixture(t);
		const resolver = registeredSkillResolver(f.directory, scopes.map(scope => ({ source: "skill", sourceInfo: { path: f.paths[scope], scope: scope === "global" ? "user" : scope === "cwd" ? "project" : "temporary" } })));
		for (const selection of selections) {
			const hashed: string[] = [];
			const tracker = new SkillReadTracker(path => { hashed.push(path); return hashSkillSource(path); }, resolver, selection);
			for (const scope of scopes) {
				const read = tracker.recordResult("read", { path: f.paths[scope] }, false)!;
				assert.equal(read.scope, scope);
				assert.equal(read.hash, selection.includes(scope) ? hashArtifactSource(readFileSync(f.paths[scope])) : undefined);
				assert.equal(read.error, undefined);
			}
			assert.deepEqual(hashed.sort(), selection.map(scope => f.paths[scope]).sort());
			const disabled = scopes.find(scope => !selection.includes(scope));
			if (disabled) {
				const values = { selection, states: Object.fromEntries(selection.map(scope => [scope, {}])) };
				stageSelectedScopePatches(values, {}, tracker.successful.values(), "owned");
				const owner = selection[0];
				assert.throws(() => stageSelectedScopePatches(values, { [owner]: { artifacts: { [f.paths[disabled]]: { description: "Relocation", kind: "skill", compilation: { rule: "forged owner" } } } } }, tracker.successful.values(), "owned"), /belongs at/);
			}
		}
		const tracker = new SkillReadTracker(hashSkillSource, resolver, ["cwd"]);
		tracker.recordStart("old", "read", { path: f.paths.cwd }); tracker.select(["global"]); tracker.select(["cwd"]);
		tracker.recordEnd("old", "read", false); assert.equal(tracker.successful.size, 0);
		tracker.recordResult("read", { path: f.paths.cwd }, false); tracker.select(["session"]); assert.equal(tracker.successful.size, 0);
		assert.throws(() => tracker.select([] as any), /scopes/);
		tracker.select(["cwd"]); tracker.recordResult("read", { path: f.paths.cwd }, false);
		const compilation = { cwd: { artifacts: { [f.paths.cwd]: { description: "Compile Skill", compilation: { rule: "fixture" } } } } };
		tracker.validateCompilations(compilation);
		writeFileSync(f.paths.cwd, "source changed after successful read");
		tracker.validateCompilations({});
		assert.throws(() => tracker.validateCompilations(compilation), /changed after acquisition/);
		const disabledPatch = Object.defineProperty({}, "global", { enumerable: true, get: () => assert.fail("disabled compiler body") });
		assert.throws(() => tracker.validateCompilations(disabledPatch), /compilation owner is excluded/);
	});

	test("Skill hashing admits regular stable source bytes only; unavailable/symlink/changed identities become failed selected evidence, never deletion", (t) => {
		const f = fixture(t), link = join(f.sources, "skill-link.txt"); symlinkSync(f.paths.cwd, link);
		assert.equal(hashSkillSource(f.paths.cwd), hashArtifactSource(readFileSync(f.paths.cwd)));
		assert.throws(() => hashSkillSource(link), /regular non-symlink/);
		assert.throws(() => hashSkillSource(f.sources), /regular non-symlink/);
		const read = fs.readFileSync; let changed = false;
		fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
			const result = (read as any)(path, ...args);
			if (typeof path === "number" && !changed) { changed = true; writeFileSync(f.paths.cwd, "source changed during hashing"); }
			return result;
		}) as typeof fs.readFileSync; syncBuiltinESMExports();
		try { assert.throws(() => hashSkillSource(f.paths.cwd), /changed during identity capture/); }
		finally { fs.readFileSync = read; syncBuiltinESMExports(); }
		assert.equal(changed, true);
		const tracker = new SkillReadTracker(hashSkillSource, () => ({ path: link, scope: "cwd" }), ["cwd"]);
		const failed = tracker.recordResult("read", { path: link }, false)!;
		assert.equal(failed.hash, undefined); assert.ok(failed.error);
	});
}
