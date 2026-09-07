import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
	captureTemporalFileBases, cwdScopeKey, getDurableRepositoryRoot, isStateFlowOwnedPath,
	loadScopeStream, parseScopeStream, serializeScopeStream, sessionScopeKey,
	temporalScopePaths, temporalStateFileUpdates, writeOwnedFileUpdates, parseStateSource,
} from "../lib/durable.ts";
import { emptyState, type StateScope } from "../lib/state.ts";
import { advanceTemporalState, createTemporalState, readTemporalState, type ScopeStream, type TemporalState } from "../lib/temporal.ts";
import type { RecentScopePatch } from "../lib/history.ts";

function fixture() {
	const repository = mkdtempSync(join(tmpdir(), "state-flow-durable-"));
	return { repository, cleanup: () => rmSync(repository, { recursive: true, force: true }) };
}

function temporalFixture(): TemporalState {
	return createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
}

test("default durable root follows Pi agent-dir resolution without Knowledge coupling", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(getDurableRepositoryRoot(), join(homedir(), ".pi", "agent", "state-flow"));
		process.env.PI_CODING_AGENT_DIR = resolve("custom-agent");
		assert.equal(getDurableRepositoryRoot(), resolve("custom-agent", "state-flow"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("canonical scope hierarchy uses collision-safe CWD/session keys at the dedicated store root", () => {
	assert.equal(getDurableRepositoryRoot("./agent-root"), resolve("./agent-root", "state-flow"));
	const root = resolve("./knowledge");
	const cwd = resolve("./project");
	assert.match(cwdScopeKey(cwd), /^[A-Za-z0-9._-]+-[a-f0-9]{64}$/);
	assert.notEqual(cwdScopeKey(join(root, "a-b", "c")), cwdScopeKey(join(root, "a", "b-c")));
	assert.equal(sessionScopeKey("session-1"), sessionScopeKey("session-1"));
	assert.notEqual(sessionScopeKey("session-1"), sessionScopeKey("session-2"));
	assert.throws(() => sessionScopeKey(""), /non-empty trimmed/);
	assert.throws(() => sessionScopeKey(" session-1"), /non-empty trimmed/);
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, "session", scope, root);
		const directory = scope === "global" ? root : scope === "cwd" ? join(root, cwdScopeKey(cwd)) : join(root, cwdScopeKey(cwd), sessionScopeKey("session"));
		assert.deepEqual(paths, { directory, checkpoint: join(directory, "checkpoint.json"), patches: join(directory, "patches.jsonl") });
		for (const path of [paths.checkpoint, paths.patches, join(directory, "state.json")]) assert.equal(isStateFlowOwnedPath(path, root), true);
		for (const name of ["config.json", "meta.json"]) assert.equal(isStateFlowOwnedPath(join(directory, name), root), scope === "session");
	}
	for (const path of ["notes.md", ".state-flow/global.json", "scopes/state.json", "arbitrary/state.json", "../state.json"]) {
		assert.equal(isStateFlowOwnedPath(join(root, path), root), false, path);
	}
	const session = temporalScopePaths(cwd, "session", "session", root);
	assert.equal(isStateFlowOwnedPath(join(session.directory, "nested", "checkpoint.json"), root), false);
});

test("legacy interpretation reads only a validated current snapshot and returns defensive state", () => {
	assert.equal(parseStateSource(undefined, "state.json"), undefined);
	assert.throws(() => parseStateSource("bad", "state.json"), /invalid JSON/);
	assert.throws(() => parseStateSource(JSON.stringify({ ...emptyState(), working: { invalid: null } }), "state.json"), /invalid materialized state/);
	const source = JSON.stringify({ ...emptyState(), working: { retained: true } });
	const state = parseStateSource(source, "state.json")!;
	state.working.retained = false;
	assert.equal(parseStateSource(source, "state.json")!.working.retained, true);
});

test("canonical writer persists anchored pairs and readers replay only tails with defensive copies", (t) => {
	const { repository, cleanup } = fixture();
	t.after(cleanup);
	const cwd = join(repository, "project");
	const session = "temporal-session";
	const view = advanceTemporalState(temporalFixture(), [{ scope: "session", patch: { response: "Current" } }], "T1");
	const bases = captureTemporalFileBases(cwd, session, repository);
	const updates = temporalStateFileUpdates(cwd, session, view, ["global", "cwd", "session"], repository);
	writeOwnedFileUpdates(updates, bases, repository);
	assert.equal(updates.length, 6);
	for (const scope of ["global", "cwd", "session"] as const) {
		const paths = temporalScopePaths(cwd, session, scope, repository);
		assert.deepEqual(loadScopeStream(cwd, session, scope, repository), view.scopes[scope]);
		assert.equal(readdirSync(paths.directory).includes("state.json"), false);
	}
	const paths = temporalScopePaths(cwd, session, "session", repository);
	assert.equal(JSON.parse(readFileSync(paths.checkpoint, "utf8")).state.response, "");
	const loaded = loadScopeStream(cwd, session, "session", repository)!;
	loaded.patches[0]!.transition.id = "mutated";
	loaded.checkpoint.state.working.mutated = true;
	assert.deepEqual(loadScopeStream(cwd, session, "session", repository), view.scopes.session);
	assert.equal(loadScopeStream(cwd, "other-session", "session", repository), undefined);
	assert.throws(() => temporalStateFileUpdates(cwd, session, view, ["cwd", "cwd"], repository), /Duplicate temporal scope/);
	writeFileSync(join(paths.directory, "state.json"), JSON.stringify(emptyState()));
	assert.throws(() => loadScopeStream(cwd, session, "session", repository), /explicit migration/);
	assert.throws(() => temporalStateFileUpdates(cwd, session, view, ["session"], repository), /explicit migration/);
});

test("canonical reads and file preparation reject symlinks and clean prepared siblings", (t) => {
	const { repository, cleanup } = fixture();
	t.after(cleanup);
	const cwd = join(repository, "project");
	const paths = temporalScopePaths(cwd, "session", "cwd", repository);
	const bases = captureTemporalFileBases(cwd, "session", repository);
	const updates = temporalStateFileUpdates(cwd, "session", temporalFixture(), ["cwd"], repository);
	mkdirSync(paths.directory);
	const outside = join(repository, "outside.jsonl");
	writeFileSync(outside, "");
	symlinkSync(outside, paths.patches);
	assert.throws(() => writeOwnedFileUpdates(updates, bases, repository), /not a regular file/);
	assert.equal(readdirSync(paths.directory).some((name) => name.endsWith(".tmp")), false);
	assert.equal(readFileSync(outside, "utf8"), "");
	assert.throws(() => loadScopeStream(cwd, "session", "cwd", repository), /not a regular file/);
	rmSync(paths.patches);
	symlinkSync(outside, paths.checkpoint);
	assert.throws(() => loadScopeStream(cwd, "session", "cwd", repository), /not a regular file/);
	rmSync(paths.directory, { recursive: true });
	symlinkSync(dirname(outside), paths.directory, "dir");
	assert.throws(() => writeOwnedFileUpdates(updates, bases, repository), /not a regular directory/);
	assert.throws(() => loadScopeStream(cwd, "session", "cwd", repository), /not a regular directory/);
});

test("temporal codec round-trips zero, seven, and repeatedly folded sparse tails at every hot boundary", () => {
	let view = temporalFixture();
	for (let index = 0; index <= 30; index++) {
		if (index > 0) {
			const changes: RecentScopePatch[] = [{ scope: "session", patch: { response: `answer ${index}` } }];
			if (index % 3 === 0) changes.push({ scope: "cwd", patch: { working: { cwd: index } } });
			if (index % 10 === 0) changes.push({ scope: "global", patch: { working: { global: index } } });
			view = advanceTemporalState(view, changes, `T${index}`);
		}
		const restored = structuredClone(view);
		for (const scope of ["global", "cwd", "session"] as const) {
			const sources = serializeScopeStream(view.scopes[scope], scope);
			restored.scopes[scope] = parseScopeStream(sources.checkpoint, sources.patches, scope)!;
			assert.deepEqual(restored.scopes[scope], view.scopes[scope]);
			assert.deepEqual(serializeScopeStream(restored.scopes[scope], scope), sources);
			assert.equal(sources.patches.trim().split("\n").filter(Boolean).length, view.scopes[scope].patches.length);
		}
		for (let offset = 0; offset < view.lineage.length; offset++) {
			assert.deepEqual(readTemporalState(restored, offset), readTemporalState(view, offset));
			for (const scope of ["global", "cwd", "session"] as const) assert.deepEqual(readTemporalState(restored, offset, scope), readTemporalState(view, offset, scope));
		}
		if (index === 8) {
			assert.equal(restored.scopes.session.checkpoint.state.response, "answer 1");
			assert.equal(readTemporalState(restored).response, "answer 8");
			assert.equal(readTemporalState(restored, 7).response, "answer 1");
		}
	}
});

test("checkpoint codec uses deterministic bytes, anchored state, and no redundant current snapshot", () => {
	const view = advanceTemporalState(temporalFixture(), [{ scope: "session", patch: { working: { z: 1, a: 2 }, response: "Done" } }], "T1");
	const first = serializeScopeStream(view.scopes.session, "session");
	const reordered = structuredClone(view.scopes.session);
	reordered.patches[0]!.patch = { response: "Done", working: { a: 2, z: 1 } };
	assert.deepEqual(serializeScopeStream(reordered, "session"), first);
	assert.deepEqual(Object.keys(JSON.parse(first.checkpoint)).sort(), ["state", "through"]);
	assert.equal(JSON.parse(first.checkpoint).through.parent, null);
	assert.equal(JSON.parse(first.checkpoint).state.response, "");
	assert.equal(JSON.parse(first.patches).patch.response, "Done");
	assert.equal(Object.hasOwn(JSON.parse(first.patches), "state"), false);
});

test("temporal codec rejects incomplete, legacy, malformed, oversized, and causally invalid replay inputs", () => {
	const view = advanceTemporalState(temporalFixture(), [{ scope: "session", patch: { response: "Done" } }], "T1");
	const source = serializeScopeStream(view.scopes.session, "session");
	assert.equal(parseScopeStream(undefined, undefined, "session"), undefined);
	assert.throws(() => parseScopeStream(source.checkpoint, undefined, "session"), /incomplete checkpoint\/tail/);
	assert.throws(() => parseScopeStream(undefined, source.patches, "session"), /incomplete checkpoint\/tail/);
	assert.throws(() => parseScopeStream("bad", "", "session"), /checkpoint contains invalid JSON/);
	assert.throws(() => parseScopeStream(source.checkpoint, `${source.patches}bad`, "session"), /line 2/);
	assert.throws(() => parseScopeStream(JSON.stringify(emptyState()), "", "session"), /checkpoint\/tail envelope/);
	assert.throws(() => parseScopeStream(source.checkpoint, source.patches.repeat(8), "session"), /exceeds seven/);
	assert.throws(() => parseScopeStream(source.checkpoint, source.patches.repeat(2), "session"), /not ordered/);
	assert.throws(() => parseScopeStream(source.checkpoint, source.patches, "global"), /session response/);
	const broken = structuredClone(view.scopes.session);
	broken.patches[0]!.transition.parent = "other-branch";
	assert.throws(() => parseScopeStream(source.checkpoint, `${JSON.stringify(broken.patches[0])}\n`, "session"), /Disconnected/);
});

test("temporal codec validates semantic replay instead of merely accepting valid JSON envelopes", () => {
	const view = advanceTemporalState(temporalFixture(), [{ scope: "session", patch: { working: { count: 1 } } }], "T1");
	const malformed: Array<{ mutate: (stream: ScopeStream) => void; error: RegExp }> = [
		{ mutate: (stream) => { stream.checkpoint.state.working.invalid = null; }, error: /semantic state/ },
		{ mutate: (stream) => { stream.patches[0]!.patch = { working: { invalid: [null] } }; }, error: /semantic state/ },
		{ mutate: (stream) => { stream.patches[0]!.patch = {}; }, error: /semantic no-op/ },
		{ mutate: (stream) => { stream.patches[0]!.patch = { artifacts: { source: { description: "incomplete" } } }; }, error: /semantic state/ },
		{ mutate: (stream) => { stream.checkpoint.through.position = -1; }, error: /temporal boundary/ },
	];
	for (const { mutate, error } of malformed) {
		const stream = structuredClone(view.scopes.session);
		mutate(stream);
		assert.throws(() => serializeScopeStream(stream, "session"), error);
		assert.throws(() => parseScopeStream(JSON.stringify(stream.checkpoint), JSON.stringify(stream.patches[0]), "session"), error);
	}
	assert.throws(() => parseScopeStream("{}", "", "unknown" as StateScope), /Unknown temporal scope/);
});
