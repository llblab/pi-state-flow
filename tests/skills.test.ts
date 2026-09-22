import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { hashArtifactSource } from "../lib/artifact.ts";
import { loadCwdProvenance, loadCwdState } from "./temporal-fixture.ts";
import {
	hasCompiledSkillArtifact,
	hashSkillSource,
	SKILL_ARTIFACT_COMPILER,
	SkillReadTracker,
	skillPathFromRead,
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

function recordRead(h: ReturnType<typeof harness>, source: string, id = "skill-1"): void {
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
	assert.match(memoryBody, /Remove fulfilled, abandoned, superseded, or impossible intents/);
	assert.match(memoryBody, /Keep `lazy` shallow and priority-ordered/);
	assert.match(memoryBody, /`\$`-prefixed `read_state` paths inside ordinary strings/);
	assert.match(memoryBody, /Never scan or resolve references merely to find broken ones/);
	assert.match(memoryBody, /\{value:null, hint:\[\{type:"dangling-reference", message, paths\}\]\}/);
	assert.match(memoryBody, /top-level hint as provenance and reconciliation guidance/);
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
		global: { contract: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	const source = skillFile("curation-sequence");
	recordRead(h, source);
	await assert.rejects(
		patchState.execute("premature", {
			session: { working: { unrelated: true } },
		}, undefined, undefined, h.ctx),
		/newly read Skill must be compiled|successfully read Skill must have a CWD artifact compiler output/,
	);
	assert.equal(h.readState().working.unrelated, undefined);
	await patchState.execute("compile-and-move", {
		global: { contract: { projectRule: null } },
		cwd: { contract: { projectRule: "project-only" }, artifacts: { [source]: compilerOutput("Curate one requested cohort") } },
	}, undefined, undefined, h.ctx);
	const owners = await readState.execute("verify-owners", {
		paths: ["global.contract", "cwd.contract"],
	}, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(owners.content[0].text).value, [{}, { projectRule: "project-only" }]);
	assert.equal(h.readState(1, "global").contract.projectRule, "project-only");
	assert.equal(h.readState(1, "cwd").contract.projectRule, undefined);
	assert.deepEqual(h.readState(0, "cwd").artifacts[source], compilerOutput("Curate one requested cohort"));
	const effective = await readState.execute("verify-effective", {
		path: "contract.projectRule",
	}, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(effective.content[0].text).value, "project-only");
	assert.equal(h.readState(0, "global").contract.projectRule, undefined);
	const terminal = await commitTerminal(h, {}, {}, "Curation verified.");
	assert.equal(terminal.message.content[0].text, "Curation verified.");
});

test("memory curation can narrow an established value without retaining two authoritative scopes", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state")!.execute("retain-global", {
		global: { contract: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	await h.tools.get("patch_state")!.execute("narrow", {
		global: { contract: { projectRule: null } },
		cwd: { contract: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	assert.equal(h.readState(0, "global").contract.projectRule, undefined);
	assert.equal(h.readState(0, "cwd").contract.projectRule, "project-only");
	assert.equal(h.readState().contract.projectRule, "project-only");
});

test("recognizes only exact Skill reads", () => {
	assert.equal(skillPathFromRead("read", { path: "/skills/demo/SKILL.md" }), "/skills/demo/SKILL.md");
	assert.equal(skillPathFromRead("bash", { path: "/skills/demo/SKILL.md" }), undefined);
	assert.equal(skillPathFromRead("read", { path: "/skills/demo/README.md" }), undefined);
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

test("tracks the mutable executed Skill path and trusted hash across Pi lifecycle order", () => {
	const tracker = new SkillReadTracker((source) => hashArtifactSource(`body:${source}`));
	const input = { path: "/skills/requested/SKILL.md" };
	tracker.recordStart("call-1", "read", { ...input });
	tracker.recordCall("call-1", "read", input);
	input.path = "/skills/executed/SKILL.md";
	tracker.recordEnd("call-1", "read", false);
	assert.deepEqual([...tracker.successful.values()], [{
		path: "/skills/executed/SKILL.md",
		hash: hashArtifactSource("body:/skills/executed/SKILL.md"),
	}]);
});

test("retains a successful read as a validation failure when source hashing fails", () => {
	const tracker = new SkillReadTracker(() => { throw new Error("source disappeared"); });
	tracker.recordCall("failed-hash", "read", { path: "/skills/vanished/SKILL.md" });
	tracker.recordEnd("failed-hash", "read", false);
	assert.deepEqual([...tracker.successful.values()], [{
		path: "/skills/vanished/SKILL.md", error: "source disappeared",
	}]);
});

test("discards stale, failed, and mismatched lifecycle records", () => {
	const tracker = new SkillReadTracker(() => hashArtifactSource("body"));
	tracker.recordStart("reused", "read", { path: "/skills/stale/SKILL.md" });
	tracker.recordCall("reused", "bash", { command: "true" });
	tracker.recordEnd("reused", "read", false);
	tracker.recordCall("failed", "read", { path: "/skills/failed/SKILL.md" });
	tracker.recordEnd("failed", "read", true);
	assert.deepEqual([...tracker.successful.values()], []);
});

test("requires every successful Skill read to compile a local source-addressed artifact", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("required");
	recordRead(h, source);

	await assert.rejects(patchCwdArtifacts(h, {}), (error: unknown) => {
		return error instanceof Error && /CWD artifact compiler output/.test(error.message) && error.message.includes(source);
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
	const input = { path: requested };
	h.handlers.get("tool_execution_start")!({ toolCallId: "skill-1", toolName: "read", args: { path: requested } }, h.ctx);
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	input.path = executed;
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: false }, h.ctx);
	await assert.rejects(patchCwdArtifacts(h, { [requested]: compilerOutput("wrong") }), (error: unknown) => {
		return error instanceof Error && error.message.includes(executed) && !error.message.includes(requested);
	});
});

test("ordinary answers cannot bypass missing Skill artifacts", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("plain");
	h.handlers.get("tool_execution_start")!({ toolCallId: "plain", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "plain", toolName: "read", isError: false }, h.ctx);
	await assert.rejects(patchCwdArtifacts(h, {}), (error: unknown) => error instanceof Error && error.message.includes(source));
	assert.equal(h.resolveSnapshot().meta.step, 0);
	await patchCwdArtifacts(h, { [source]: compilerOutput() });
	assert.equal(h.resolveSnapshot().meta.step, 1);
});

test("a pending Skill compilation reports reconciliation failure without a repair inference", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("pending-answer");
	h.handlers.get("tool_execution_start")!({ toolCallId: "pending", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "pending", toolName: "read", isError: false }, h.ctx);
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer with pending compilation." }] };
	h.handlers.get("message_end")!({ message }, h.ctx);
	h.handlers.get("turn_end")!({ message }, h.ctx);
	assert.equal(h.readState().response, "Answer with pending compilation.");
	assert.equal(h.sentMessages.length, 0, "pending acquisition must not schedule terminal repair");
	assert.equal(h.notifications.some((notice) => /could not reconcile/.test(notice)), false);
});

test("retains compatibility with execution-start updates after interception", async () => {
	const h = harness();
	await start(h);
	const requested = skillFile("compat-requested");
	const executed = skillFile("compat-executed");
	const input = { path: requested };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_start")!({ toolCallId: "skill-1", toolName: "read", args: { path: executed } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: false }, h.ctx);
	await assert.rejects(patchCwdArtifacts(h, { [requested]: compilerOutput("wrong") }), (error: unknown) => {
		return error instanceof Error && error.message.includes(executed) && !error.message.includes(requested);
	});
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
	h.beforeAgentStart("Refresh");
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
