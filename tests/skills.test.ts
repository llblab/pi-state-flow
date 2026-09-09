import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { hashArtifactSource } from "../lib/artifact.ts";
import { loadCwdState } from "./temporal-fixture.ts";
import {
	hasCompiledSkillArtifact,
	hashSkillSource,
	SKILL_ARTIFACT_COMPILER,
	SkillReadTracker,
	skillPathFromRead,
} from "../lib/skills.ts";
import { commitTerminal, harness, scopedTerminalComment, start, terminalComment } from "./harness.ts";

const skillRoot = mkdtempSync(join(tmpdir(), "pi-state-flow-skills-"));

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

test("discovers the packaged optional memory-curation Skill without diagnostics", () => {
	const root = join(import.meta.dirname, "..", "skills");
	const result = loadSkillsFromDir({ dir: root, source: "package:pi-state-flow" });
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.skills.length, 1);
	assert.equal(result.skills[0].name, "state-flow-memory");
	assert.match(result.skills[0].description, /explicit memory curation.*not for routine turns/);
	const body = readFileSync(result.skills[0].filePath, "utf8");
	assert.match(body, /Never delete the only accepted copy/);
	assert.match(body, /Stop after one bounded reconciliation cohort/);
});

test("memory curation can narrow an established value without retaining two authoritative scopes", async () => {
	const h = harness();
	await start(h);
	const retain = h.handlers.get("message_end")!({
		message: {
			role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: `${scopedTerminalComment([
				{ scope: "global", patch: { contract: { projectRule: "project-only" } } },
			])}\n\nRetained for review.` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: retain.message }, h.ctx);
	const narrowed = h.handlers.get("message_end")!({
		message: {
			role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: `${scopedTerminalComment([
				{ scope: "global", patch: { contract: { projectRule: null } } },
				{ scope: "cwd", patch: { contract: { projectRule: "project-only" } } },
			])}\n\nNarrowed to this project.` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: narrowed.message }, h.ctx);
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
	}, source, hash), true);
	assert.equal(hasCompiledSkillArtifact({
		[source]: {
			description: "empty", hash, compiler: SKILL_ARTIFACT_COMPILER, kind: "skill", compilation: {},
		},
	}, source, hash), false);
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

	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {})}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.resolveSnapshot().meta.validation!.error, /CWD artifact compiler output/);
	assert.ok(h.resolveSnapshot().meta.validation!.error.includes(source));

	const accepted = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {}, { [source]: compilerOutput() })}\n\nDone` }],
		},
	}, h.ctx);
	assert.equal(accepted.message.content[0].text, "Done");
	h.handlers.get("turn_end")!({ message: accepted.message }, h.ctx);
	const artifact = loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source];
	assert.deepEqual(artifact, {
		...compilerOutput(),
		hash: hashSkillSource(source),
		compiler: SKILL_ARTIFACT_COMPILER,
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
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {}, { [requested]: compilerOutput("wrong") })}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.ok(h.resolveSnapshot().meta.validation!.error.includes(executed));
	assert.equal(h.resolveSnapshot().meta.validation!.error.includes(requested), false);
});

test("ordinary answers cannot bypass missing Skill artifacts", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("plain");
	h.handlers.get("tool_execution_start")!({ toolCallId: "plain", toolName: "read", args: { path: source } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "plain", toolName: "read", isError: false }, h.ctx);
	const rejected = h.handlers.get("message_end")!({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.ok(h.resolveSnapshot().meta.validation!.error.includes(source));
	assert.equal(h.resolveSnapshot().meta.step, 0);
	commitTerminal(h, {}, {}, "Done", { [source]: compilerOutput() });
	assert.equal(h.resolveSnapshot().meta.step, 1);
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
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {}, { [requested]: compilerOutput("wrong") })}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.ok(h.resolveSnapshot().meta.validation!.error.includes(executed));
	assert.equal(h.resolveSnapshot().meta.validation!.error.includes(requested), false);
});

test("does not attribute stale reads when lifecycle ids are reused for other tools", async () => {
	const h = harness();
	await start(h);
	const stale = skillFile("stale");
	h.handlers.get("tool_execution_start")!({ toolCallId: "reused-id", toolName: "read", args: { path: stale } }, h.ctx);
	h.handlers.get("tool_call")!({ toolCallId: "reused-id", toolName: "bash", input: { command: "true" } }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "reused-id", toolName: "bash", result: {}, isError: false }, h.ctx);
	const result = commitTerminal(h, {}, {}, "No Skill acquired.");
	assert.equal(result.message.content[0].text, "No Skill acquired.");
});

test("falls back to intercepted input when a successful execution omits args", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("fallback");
	recordRead(h, source);
	const result = commitTerminal(h, {}, {}, "Done", { [source]: compilerOutput("use intercepted input fallback") });
	assert.equal(result.message.content[0].text, "Done");
});

test("does not require compilation for a failed Skill read", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("failed");
	const input = { path: source };
	h.handlers.get("tool_call")!({ toolCallId: "skill-1", toolName: "read", input }, h.ctx);
	h.handlers.get("tool_execution_end")!({ toolCallId: "skill-1", toolName: "read", result: {}, isError: true }, h.ctx);
	const result = commitTerminal(h, {}, {}, "Read failed.");
	assert.equal(result.message.content[0].text, "Read failed.");
});

test("a reread refreshes the runtime-owned source hash and replaces stale compilation metadata", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("changed", "first");
	recordRead(h, source, "first");
	commitTerminal(h, {}, {}, "First", { [source]: { ...compilerOutput("first"), obsolete: true } });
	const firstHash = loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source].hash;

	writeFileSync(source, "second");
	h.handlers.get("before_agent_start")!({ prompt: "Refresh", systemPrompt: "base" }, h.ctx);
	recordRead(h, source, "second");
	commitTerminal(h, {}, {}, "Second", { [source]: compilerOutput("second") });
	const refreshed = loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source];
	assert.notEqual(refreshed.hash, firstHash);
	assert.equal(refreshed.hash, hashSkillSource(source));
	assert.equal(Object.hasOwn(refreshed, "obsolete"), false);
	assert.equal(refreshed.compilation?.routing, "second");
});

test("rejects model attempts to forge runtime-owned Skill freshness fields", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("forged");
	recordRead(h, source);
	const forged = { ...compilerOutput(), hash: hashArtifactSource("forged") };
	const rejected = h.handlers.get("message_end")!({
		message: {
			role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment({}, {}, { [source]: forged })}\n\nDone` }],
		},
	}, h.ctx);
	assert.deepEqual(rejected.message.content, []);
	assert.match(h.resolveSnapshot().meta.validation!.error, /cannot set runtime-owned hash or compiler/);
});
