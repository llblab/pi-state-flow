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
import { MAX_FALLBACK_ATTEMPTS } from "../lib/extension.ts";
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

test("discovers the packaged optional memory-curation Skill without diagnostics", () => {
	const root = join(import.meta.dirname, "..", "skills");
	const result = loadSkillsFromDir({ dir: root, source: "package:pi-state-flow" });
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.skills.length, 1);
	assert.equal(result.skills[0].name, "state-flow-memory");
	assert.match(result.skills[0].description, /explicit memory curation.*not for routine turns/);
	const body = readFileSync(result.skills[0].filePath, "utf8");
	assert.match(body, /Use this Skill only for one bounded, explicit maintenance request/);
	assert.match(body, /`reframe`: useful, but expressed with unsupported certainty, authority, or breadth/);
	assert.match(body, /These are audit decisions, not required stored labels/);
	assert.match(body, /fresh executor know what must still hold, what changed, what remains unresolved, and how to continue/);
	assert.match(body, /compile it into its exact-path CWD artifact before acquiring a stale global Markdown source/);
	assert.match(body, /verify it with a separate `read_state`, then delete or narrow the source/);
	assert.match(body, /Do all readback before the terminal answer/);
	assert.match(body, /Simultaneously pending CWD and global acquisitions must be compiled together in one atomic `patch_state` call/);
	assert.match(body, /Write and verify the destination before deleting the source/);
	assert.match(body, /Do not combine destination creation and source deletion merely because multi-scope publication is atomic/);
	assert.match(body, /stored claim of acceptance is not verification/);
	assert.match(body, /Never delete the only accepted copy/);
	assert.match(body, /Removing a secret from active state does not erase prior offsets, Git history, or external copies/);
	assert.match(body, /Report the bounded change, unresolved items, any partial migration/);
	assert.match(body, /Stop after this reconciliation cohort, including when no change is warranted or a blocker remains/);
});

test("curation compiles an acquired Skill before write-verify-delete barriers", async () => {
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
	await patchState.execute("compile", {
		cwd: { artifacts: { [source]: compilerOutput("Curate one requested cohort") } },
	}, undefined, undefined, h.ctx);
	await patchState.execute("after-compilation", {
		session: { working: { unrelated: true } },
	}, undefined, undefined, h.ctx);
	await patchState.execute("destination", {
		cwd: { contract: { projectRule: "project-only" } },
	}, undefined, undefined, h.ctx);
	const destination = await readState.execute("verify-destination", {
		offset: 0, scope: "cwd",
	}, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(destination.content[0].text).state.contract.projectRule, "project-only");
	await patchState.execute("delete-source", {
		global: { contract: { projectRule: null } },
	}, undefined, undefined, h.ctx);
	const effective = await readState.execute("verify-effective", {
		offset: 0, scope: "effective",
	}, undefined, undefined, h.ctx);
	assert.equal(JSON.parse(effective.content[0].text).state.contract.projectRule, "project-only");
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

test("a Skill acquired after terminal eligibility preserves the primary answer and resolves through the fallback", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state")!.execute(
		"early-resolution", { session: { working: { inspected: true } }, final: true }, undefined, undefined, h.ctx,
	);
	const source = skillFile("late-obligation");
	recordRead(h, source);
	const draft = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Too early." }] };
	assert.equal(h.handlers.get("message_end")!({ message: draft }, h.ctx), undefined, "final validation failure preserves the draft");
	h.handlers.get("turn_end")!({ message: draft }, h.ctx);
	assert.equal(h.readState().response, "Too early.");
	await patchCwdArtifacts(h, { [source]: compilerOutput("compiled after the late read") });
	const fallback = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete." }] };
	const suppressed = h.handlers.get("message_end")!({ message: fallback }, h.ctx);
	assert.deepEqual(suppressed.message.content, [], "the fallback turn is suppressed");
	h.handlers.get("turn_end")!({ message: suppressed.message }, h.ctx);
	assert.equal(loadCwdState(h.ctx.cwd, h.repositoryRoot)!.artifacts[source].kind, "skill", "the late Skill compilation is persisted");
	assert.equal(h.readState().response, "Too early.");
});

test("a late Skill obligation that outlives the fallback budget keeps the preserved answer", async () => {
	const h = harness();
	await start(h);
	await h.tools.get("patch_state")!.execute(
		"early-resolution", { session: { working: { inspected: true } }, final: true }, undefined, undefined, h.ctx,
	);
	const source = skillFile("late-exhaustion");
	recordRead(h, source);
	const primary = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Preserved before compilation." }] };
	assert.equal(h.handlers.get("message_end")!({ message: primary }, h.ctx), undefined);
	h.handlers.get("turn_end")!({ message: primary }, h.ctx);
	assert.equal(h.readState().response, "Preserved before compilation.");
	for (let attempt = 1; attempt <= MAX_FALLBACK_ATTEMPTS; attempt++) {
		const fallback = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Fallback ${attempt}.` }] };
		const suppressed = h.handlers.get("message_end")!({ message: fallback }, h.ctx);
		assert.deepEqual(suppressed.message.content, []);
		h.handlers.get("turn_end")!({ message: suppressed.message }, h.ctx);
	}
	assert.equal(h.readState().response, "Preserved before compilation.");
	assert.equal(h.notifications.filter((message) => /no final:true patch arrived after 2 fallback turns/.test(message)).length, 1);
});

test("final-only resolution cannot bypass a successful Skill compilation obligation", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("final-obligation");
	recordRead(h, source);
	await assert.rejects(
		h.tools.get("patch_state")!.execute("final", { final: true }, undefined, undefined, h.ctx),
		/Every successfully read Skill must have a CWD artifact compiler output/,
	);
	await patchCwdArtifacts(h, { [source]: compilerOutput("compiled after rejected final") });
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
	h.handlers.get("before_agent_start")!({ prompt: "Refresh", systemPrompt: "base" }, h.ctx);
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

test("rejects model attempts to forge runtime-owned Skill freshness fields", async () => {
	const h = harness();
	await start(h);
	const source = skillFile("forged");
	recordRead(h, source);
	const forged = { ...compilerOutput(), hash: hashArtifactSource("forged") };
	await assert.rejects(patchCwdArtifacts(h, { [source]: forged }), /cannot set runtime-owned provenance/);
});
