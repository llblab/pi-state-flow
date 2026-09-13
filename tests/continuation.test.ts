import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	buildContinuationCandidates,
	discoverNativeSessionHeaders,
	inspectStateFlowContinuationProvenance,
	readNativeSessionHeader,
	recommendContinuationFromProvenance,
	resolveContinuationStartup,
	type ContinuationHostContext,
	type ContinuationProjectIdentity,
	type ContinuationSessionCandidate,
} from "../lib/continuation.ts";
import { resolveSessionAddress, sessionRuntimePaths } from "../lib/durable.ts";
import { realPiFixture } from "./pi-harness.ts";

const context: ContinuationHostContext = {
	cwd: "/workspace/project",
	agentDir: "/profile/agent",
	sessionDir: "/profile/sessions/project",
	transport: "local",
};

const identity: ContinuationProjectIdentity = {
	profile: "/profile/agent", cwd: "/workspace/project", gitCommonDir: "/repo/.git",
	worktree: "/workspace/project", branch: "main", transport: "local",
};

function candidate(overrides: Partial<ContinuationSessionCandidate> = {}): ContinuationSessionCandidate {
	return {
		sessionFile: "/sessions/current.jsonl", sessionId: "current",
		lastActivity: "2026-09-08T10:00:00.000Z", reason: "native header and State Flow runtime",
		profile: identity.profile, cwd: identity.cwd, gitCommonDir: identity.gitCommonDir,
		worktree: identity.worktree, branch: identity.branch, transport: identity.transport,
		lifecycle: "open", stateFlow: { enabled: true, restorable: true }, ...overrides,
	};
}

test("recommends only the latest exact identity with enabled restorable State Flow", () => {
	const old = candidate({ sessionFile: "/sessions/old.jsonl", sessionId: "old", lastActivity: "2026-09-08T09:00:00.000Z" });
	const latest = candidate();
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, latest]), {
		action: "resume", sessionFile: latest.sessionFile, sessionId: latest.sessionId, reason: "latest-enabled-state-flow",
	});
});

test("a latest disabled or unrestorable session fails closed without selecting an older candidate", () => {
	const old = candidate({ sessionFile: "/sessions/old.jsonl", sessionId: "old", lastActivity: "2026-09-08T09:00:00.000Z" });
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, candidate({ stateFlow: { enabled: false, restorable: true } })]), {
		action: "new", reason: "last-not-state-flow",
	});
	assert.deepEqual(recommendContinuationFromProvenance(identity, [old, candidate({ stateFlow: { enabled: true, restorable: false } })]), {
		action: "new", reason: "ineligible",
	});
});

test("rejects profile, path, worktree, branch, transport, lifecycle, and opt-out mismatches", () => {
	const mismatches: Partial<ContinuationSessionCandidate>[] = [
		{ profile: "/other/profile" }, { cwd: "/workspace/alias" }, { gitCommonDir: "/other/.git" },
		{ worktree: "/other/worktree" }, { branch: "feature" }, { transport: "telegram" },
		{ lifecycle: "closed" }, { lifecycle: "archived" }, { doNotAutoResume: true },
	];
	for (const mismatch of mismatches) {
		assert.deepEqual(recommendContinuationFromProvenance(identity, [candidate(mismatch)]), { action: "new", reason: "none" });
	}
});

test("equally recent eligible candidates produce an explicit stable choice", () => {
	const a = candidate({ sessionFile: "/sessions/a.jsonl", sessionId: "a" });
	const b = candidate({ sessionFile: "/sessions/b.jsonl", sessionId: "b" });
	assert.deepEqual(recommendContinuationFromProvenance(identity, [b, a]), {
		action: "choose", reason: "ambiguous", candidates: [
		{ sessionFile: a.sessionFile, sessionId: "a", lastActivity: a.lastActivity, reason: "equally recent enabled State Flow session" },
		{ sessionFile: b.sessionFile, sessionId: "b", lastActivity: b.lastActivity, reason: "equally recent enabled State Flow session" },
	],
	});
});

test("consults advisory State Flow discovery only for an ordinary default launch", async () => {
	let calls = 0;
	const recommendation = await resolveContinuationStartup(context, { kind: "default" }, (input) => {
		calls++;
		assert.equal(Object.isFrozen(input), true);
		assert.deepEqual(input, context);
		return { action: "resume", sessionFile: "/sessions/exact.jsonl", sessionId: "session-id", reason: "latest-enabled-state-flow" };
	});
	assert.equal(calls, 1);
	assert.deepEqual(recommendation, {
		action: "resume", sessionFile: "/sessions/exact.jsonl", sessionId: "session-id", reason: "latest-enabled-state-flow",
	});
});

test("explicit new and exact resume remain authoritative without running discovery", async () => {
	const forbidden = () => { throw new Error("discovery must not run"); };
	assert.deepEqual(await resolveContinuationStartup(context, { kind: "new" }, forbidden), {
		action: "new", reason: "explicit-new",
	});
	assert.deepEqual(await resolveContinuationStartup(context, {
		kind: "resume-exact", sessionFile: "/sessions/chosen.jsonl", sessionId: "chosen",
	}, forbidden), {
		action: "resume", sessionFile: "/sessions/chosen.jsonl", sessionId: "chosen", reason: "explicit-resume",
	});
});

test("native picker, continue-recent, and no-session modes bypass State Flow recommendation", async () => {
	const forbidden = () => { throw new Error("discovery must not run"); };
	for (const [intent, mode] of [
		[{ kind: "native-picker" }, "picker"],
		[{ kind: "continue-recent" }, "continue-recent"],
		[{ kind: "no-session" }, "no-session"],
	] as const) {
		assert.deepEqual(await resolveContinuationStartup(context, intent, forbidden), { action: "native", mode });
	}
});

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "state-flow-continuation-discovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	return { root, sessions };
}

function writeSession(path: string, id: string, cwd: string, body = "{not valid transcript json") {
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-08T10:00:00.000Z", cwd })}\n${body}\n`);
}

test("reads only the native header contract and does not parse transcript bodies", (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "one.jsonl");
	writeSession(file, "one", f.root);
	const before = readFileSync(file);
	const header = readNativeSessionHeader(file);
	assert.equal(header.id, "one");
	assert.equal(header.cwd, f.root);
	assert.deepEqual(readFileSync(file), before);
});

test("native header reads reject non-regular files and symlinked parent locators", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "parent.jsonl");
	writeSession(file, "parent", f.root);
	const before = readFileSync(file);
	const alias = join(f.root, "alias.jsonl");
	const directory = join(f.root, "alias-dir");
	symlinkSync(file, alias);
	symlinkSync(f.sessions, directory, "dir");
	for (const path of [f.sessions, alias, join(directory, "parent.jsonl")]) assert.throws(() => readNativeSessionHeader(path), /regular canonical file/);
	const fifo = join(f.sessions, "fifo.jsonl");
	execFileSync("mkfifo", [fifo]);
	assert.throws(() => readNativeSessionHeader(fifo), /regular canonical file/);
	assert.deepEqual(readFileSync(file), before);
});

test("discovers deterministic JSONL headers, isolates malformed files, and mutates no bytes", (t) => {
	const f = fixture(t);
	writeSession(join(f.sessions, "b.jsonl"), "b", f.root);
	writeSession(join(f.sessions, "a.jsonl"), "a", f.root);
	writeFileSync(join(f.sessions, "broken.jsonl"), "not-json\nprivate transcript");
	writeFileSync(join(f.sessions, "ignored.txt"), "ignored");
	const before = new Map(["a.jsonl", "b.jsonl", "broken.jsonl", "ignored.txt"].map((name) => {
		const path = join(f.sessions, name);
		return [name, { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }];
	}));
	const result = discoverNativeSessionHeaders(f.sessions);
	assert.deepEqual(result.headers.map(({ id }) => id), ["a", "b"]);
	assert.deepEqual(result.invalid.map(({ file }) => file), [join(f.sessions, "broken.jsonl")]);
	for (const [name, snapshot] of before) {
		const path = join(f.sessions, name);
		assert.deepEqual(readFileSync(path), snapshot.bytes);
		assert.equal(statSync(path).mtimeMs, snapshot.mtime);
	}
});

test("inspects exact Git-backed State Flow provenance without changing repository state", async (t) => {
	const f = await realPiFixture(t, { autoStart: true });
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Git provenance established."),
	]);
	await session.prompt("Establish continuation provenance");
	const header = readNativeSessionHeader(session.sessionManager.getSessionFile()!);
	const beforeHead = execFileSync("git", ["-C", f.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	const beforeStatus = execFileSync("git", ["-C", f.repositoryRoot, "status", "--porcelain=v1"], { encoding: "utf8" });
	const result = inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(result.stateFlow, { enabled: true, restorable: true });
	assert.match(result.reason, /exact Git runtime/);
	assert.equal(execFileSync("git", ["-C", f.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }), beforeHead);
	assert.equal(execFileSync("git", ["-C", f.repositoryRoot, "status", "--porcelain=v1"], { encoding: "utf8" }), beforeStatus);
});

test("inspects exact file-only provenance and fails malformed runtime closed", async (t) => {
	const f = await realPiFixture(t, { autoStart: true, initializeRepository: false });
	const originalPath = process.env.PATH;
	process.env.PATH = f.root;
	const session = await f.createSession("new");
	t.after(() => session.dispose());
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("patch_state", { final: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("File provenance established."),
		]);
		await session.prompt("Establish file continuation provenance");
	} finally {
		process.env.PATH = originalPath;
	}
	const header = readNativeSessionHeader(session.sessionManager.getSessionFile()!);
	const good = inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(good.stateFlow, { enabled: true, restorable: true });
	assert.match(good.reason, /exact file-only runtime cohort/);
	const address = resolveSessionAddress(header.file, header.id, header.timestamp);
	const meta = sessionRuntimePaths(header.cwd, header.id, f.repositoryRoot, address.key).meta;
	writeFileSync(meta, "{broken\n");
	const brokenBytes = readFileSync(meta);
	const broken = inspectStateFlowContinuationProvenance(header, f.repositoryRoot);
	assert.deepEqual(broken.stateFlow, { enabled: true, restorable: false });
	assert.match(broken.reason, /ineligible/);
	assert.deepEqual(readFileSync(meta), brokenBytes);
});

test("combines frozen headers with host-owned lifecycle and State Flow provenance", (t) => {
	const f = fixture(t);
	const file = join(f.sessions, "candidate.jsonl");
	writeSession(file, "candidate", f.root);
	const { headers } = discoverNativeSessionHeaders(f.sessions);
	const candidates = buildContinuationCandidates(headers, (header) => {
		assert.equal(Object.isFrozen(header), true);
		return {
			profile: "/profile", gitCommonDir: "/repo/.git", worktree: f.root, branch: "main",
			transport: "local", lifecycle: "open", stateFlow: { enabled: true, restorable: true },
			reason: "validated header and exact State Flow cohort",
		};
	});
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].sessionFile, file);
	assert.equal(candidates[0].sessionId, "candidate");
	assert.equal(candidates[0].stateFlow.restorable, true);
});
