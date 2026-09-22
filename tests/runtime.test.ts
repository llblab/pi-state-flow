import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TemporalRuntime } from "../lib/runtime.ts";
import type { ArtifactProvenanceRegistry } from "../lib/artifact.ts";
import { captureTemporalFileBases, sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { writeGlobalState } from "./storage-fixture.ts";
import { emptySnapshot, type Snapshot } from "../lib/snapshot.ts";
import { emptyState, type StateScope } from "../lib/state.ts";
import type { JsonObject } from "../lib/json.ts";
import { createAcceptedTransition } from "../lib/history.ts";
import { validateTemporalState } from "../lib/temporal.ts";
import { commitScopedTransition, stageAtomicScopePatches } from "../lib/transition.ts";
import { harness } from "./harness.ts";
import { loadScopeProvenance } from "./temporal-fixture.ts";

test("runtime keeps native session storage identity paired and detached from caller mutation", () => {
	const address = { id: "session-id", key: "timestamp_session-id" };
	const runtime = new TemporalRuntime("/project", address, "/store");
	address.id = "mutated";
	address.key = "mutated";
	assert.equal(runtime.sessionId, "session-id");
	assert.equal(runtime.sessionKey, "timestamp_session-id");
});

test("passive memory admits global state before a CWD has materialized", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-global-passive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeGlobalState({ ...emptyState(), working: { preference: "global" } }, root);
	const runtime = new TemporalRuntime("/new-project", "new-session", root);
	assert.equal(runtime.loadPassive(), true);
	assert.equal(runtime.read(0, "global").working.preference, "global");
	assert.deepEqual(runtime.read(0, "cwd"), emptyState());
});

for (const operation of ["restore", "fork"] as const) for (const [limit, offset] of [[0, 0], [1, 0], [1, 1], [12, 0]] as const) {
	test(`${operation} applies historyLimit ${limit} to stored tails at selected offset ${offset}`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-retention-change-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot(true);
		parent.initialize(snapshot, true);
		const checkpoints = [parent.retainedCheckpoint(snapshot)];
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		for (let index = 1; index <= 6; index++) {
			const before = parent.states();
			const next = structuredClone(before);
			for (const scope of ["global", "cwd", "session"] as const) {
				next[scope].working.index = index;
				next[scope].artifacts["/unchanged.txt"] = { description: "Stable compilation" };
			}
			snapshot.meta.step++;
			parent.publish(snapshot, true, createAcceptedTransition(before, next), { provenance: {
				global: { "/unchanged.txt": evidence }, cwd: { "/unchanged.txt": evidence }, session: { "/unchanged.txt": evidence },
			} });
			checkpoints.push(parent.retainedCheckpoint(snapshot));
		}
		const beforeFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, operation === "fork" ? "child" : parent.sessionId, root, undefined, limit);
		if (limit < 6) {
			const outside = checkpoints.at(-limit - 2)!;
			assert.ok("boundary" in outside);
			assert.throws(() => operation === "fork"
				? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, outside)
				: selected.prepareBoundaryRestore(outside), /outside the retained temporal window/);
			assert.deepEqual(captureTemporalFileBases(cwd, parent.sessionId, root), beforeFiles);
		}
		const checkpoint = checkpoints.at(-offset - 1)!;
		assert.ok("boundary" in checkpoint);
		const accepted = operation === "fork"
			? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, checkpoint).fork()
			: selected.restoreBoundary(checkpoint);
		assert.equal(accepted.snapshot.meta.step, operation === "fork" ? 0 : checkpoint.step);
		for (const scope of ["global", "cwd", "session"] as const) {
			assert.equal(selected.read(0, scope).working.index, scope === "session" ? 6 - offset : 6);
			assert.deepEqual(selected.artifactProvenance(scope), { "/unchanged.txt": evidence });
			assert.ok(selected.view!.scopes[scope].patches.length <= limit);
			const paths = temporalScopePaths(cwd, selected.sessionId, scope, root);
			assert.ok(readFileSync(paths.patches, "utf8").split("\n").filter(Boolean).length <= limit);
		}
		if (operation === "fork") {
			const directory = temporalScopePaths(cwd, parent.sessionId, "session", root).directory;
			const privateFiles = (files: ReturnType<typeof captureTemporalFileBases>) => files.filter(({ path }) => dirname(path) === directory);
			assert.deepEqual(privateFiles(captureTemporalFileBases(cwd, parent.sessionId, root)), privateFiles(beforeFiles));
		}
		const smallerTails = structuredClone(selected.view!.scopes);
		const ownCheckpoint = selected.retainedCheckpoint(accepted.snapshot);
		assert.ok("boundary" in ownCheckpoint);
		const increased = new TemporalRuntime(cwd, selected.sessionId, root, undefined, 12);
		const resumed = increased.restoreBoundary(ownCheckpoint).snapshot;
		assert.deepEqual(increased.view!.scopes, smallerTails, "raising retention cannot reconstruct folded tails");
		assert.throws(() => increased.read(1), /predates the proven temporal origin/);
		const before = increased.states();
		const next = structuredClone(before);
		next.session.working.next = true;
		resumed.meta.step++;
		increased.publish(resumed, true, createAcceptedTransition(before, next));
		assert.deepEqual(increased.read(1, "session"), before.session);
	});
}

for (const operation of ["restore", "fork"] as const) for (const selection of ["historical", "head"] as const) {
	test(`${operation} keeps only matching artifact provenance at the ${selection} boundary`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-provenance-selection-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const parent = new TemporalRuntime(cwd, "parent", root);
		const snapshot = emptySnapshot(true);
		parent.initialize(snapshot, true);
		const evidence = (version: number) => ({ sourceFingerprint: { size: version, mtimeNs: String(version) }, compilerRevision: "artifact-v1" });
		const before = parent.states();
		const initial = structuredClone(before);
		initial.session.artifacts = {
			"/changed.txt": { description: "Version 1" },
			"/untouched.txt": { description: "Stable semantics" },
			"/returned.txt": { description: "Original semantics" },
			"/removed.txt": { description: "Removed later" },
			"/unproven.txt": { description: "No compilation evidence" },
		};
		for (const scope of ["global", "cwd"] as const) initial[scope].artifacts = { "/shared.txt": { description: "Old shared semantics" } };
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(before, initial), { provenance: {
			global: { "/shared.txt": evidence(1) },
			cwd: { "/shared.txt": evidence(1) },
			session: Object.fromEntries(["/changed.txt", "/untouched.txt", "/returned.txt", "/removed.txt"].map((path) => [path, evidence(1)])),
		} });
		const historical = parent.retainedCheckpoint(snapshot);
		const changed = structuredClone(initial);
		changed.session.artifacts["/changed.txt"] = { description: "Version 2" };
		changed.session.artifacts["/returned.txt"] = { description: "Intermediate semantics" };
		delete changed.session.artifacts["/removed.txt"];
		for (const scope of ["global", "cwd"] as const) changed[scope].artifacts["/shared.txt"] = { description: "Live shared semantics" };
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(initial, changed), { provenance: {
			global: { "/shared.txt": evidence(2) }, cwd: { "/shared.txt": evidence(2) },
			session: { "/changed.txt": evidence(2), "/returned.txt": evidence(2) },
		} });
		const returned = structuredClone(changed);
		returned.session.artifacts["/returned.txt"] = structuredClone(initial.session.artifacts["/returned.txt"]!);
		snapshot.meta.step++;
		parent.publish(snapshot, true, createAcceptedTransition(changed, returned), { provenance: { session: { "/returned.txt": evidence(3) } } });
		// Unchanged accepted semantics can acquire newer evidence without a semantic transition.
		parent.publish(snapshot, false, undefined, { provenance: { session: { "/untouched.txt": evidence(3) } } });
		const checkpoint = selection === "head" ? parent.retainedCheckpoint(snapshot) : historical;
		assert.ok("boundary" in checkpoint);
		const parentFiles = captureTemporalFileBases(cwd, parent.sessionId, root);
		const selected = new TemporalRuntime(cwd, operation === "fork" ? "child" : parent.sessionId, root);
		const accepted = operation === "fork"
			? selected.prepareBoundaryFork({ id: parent.sessionId, key: parent.sessionKey }, checkpoint).fork()
			: selected.restoreBoundary(checkpoint);
		const expected: ArtifactProvenanceRegistry = selection === "head"
			? parent.artifactProvenance("session")
			: { "/untouched.txt": evidence(3) };
		assert.deepEqual(selected.read(0, "session").artifacts, (selection === "head" ? returned : initial).session.artifacts);
		assert.deepEqual(selected.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, "session", root, selected.sessionKey), expected);
		for (const scope of ["global", "cwd"] as const) {
			assert.deepEqual(selected.read(0, scope).artifacts, changed[scope].artifacts);
			assert.deepEqual(selected.artifactProvenance(scope), { "/shared.txt": evidence(2) });
			assert.deepEqual(loadScopeProvenance(cwd, selected.sessionId, scope, root, selected.sessionKey), { "/shared.txt": evidence(2) });
		}
		if (operation === "fork") assert.deepEqual(captureTemporalFileBases(cwd, parent.sessionId, root), parentFiles);
		const meta = temporalScopePaths(cwd, selected.sessionId, "session", root).meta;
		assert.deepEqual(JSON.parse(readFileSync(meta, "utf8")).artifacts, expected);
		const ownCheckpoint = selected.retainedCheckpoint(accepted.snapshot);
		assert.ok("boundary" in ownCheckpoint);
		const reloaded = new TemporalRuntime(cwd, selected.sessionId, root);
		reloaded.restoreBoundary(ownCheckpoint);
		assert.deepEqual(reloaded.artifactProvenance("session"), expected);
		assert.deepEqual(loadScopeProvenance(cwd, reloaded.sessionId, "session", root, reloaded.sessionKey), expected);
	});
}

for (const operation of ["restore", "fork"] as const) {
	test(`${operation} rejects contradictory session lineage before accepting a new origin`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-session-lineage-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const seed = (id: string) => {
			const runtime = new TemporalRuntime(cwd, id, root);
			const snapshot = emptySnapshot(true);
			runtime.initialize(snapshot, true);
			const before = runtime.states();
			const next = structuredClone(before);
			next.session.working.owner = id;
			snapshot.meta.step++;
			runtime.publish(snapshot, true, createAcceptedTransition(before, next));
			return runtime.retainedCheckpoint(snapshot);
		};
		const checkpoint = seed("a");
		assert.ok("boundary" in checkpoint);
		seed("b");
		const a = temporalScopePaths(cwd, "a", "session", root);
		const b = temporalScopePaths(cwd, "b", "session", root);
		for (const key of ["checkpoint", "patches", "meta"] as const) writeFileSync(a[key], readFileSync(b[key]));
		const selected = new TemporalRuntime(cwd, operation === "restore" ? "a" : "child", root);
		const before = ["a", "b", "child"].map((id) => captureTemporalFileBases(cwd, id, root));
		assert.throws(() => operation === "restore"
			? selected.restoreBoundary(checkpoint)
			: selected.prepareBoundaryFork({ id: "a", key: "a" }, checkpoint).fork(), /Conflicting State Flow temporal lineage/);
		assert.equal(selected.view, undefined, "contradictory state must not become an accepted cache");
		assert.deepEqual(["a", "b", "child"].map((id) => captureTemporalFileBases(cwd, id, root)), before);
	});
}

test("stopping an ordinary disabled session is harmless and does not initialize or publish storage", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
	const head = () => execFileSync("git", ["-C", h.repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = head();
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	await h.commands.get("state-flow-stop").handler("", h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.deepEqual(h.entries.at(-1).data, { disabled: true });
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.equal(head(), before);
	assert.equal(existsSync(join(h.repositoryRoot, "checkpoint.json")), false);
	assert.throws(() => h.readState(), /runtime is unavailable/);
});

test("runtime causal basis rejects staged work after accepted history returns to identical values", () => {
	const h = harness();
	const runtime = new TemporalRuntime(h.ctx.cwd, "causal-stage", h.repositoryRoot);
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	const initial = runtime.states();
	const initialBasis = runtime.causalBasis();
	const originPosition = runtime.view!.lineage.at(-1)!.position;
	const stage = stageAtomicScopePatches(initial, { session: { intents: { stale: "Must not publish" } } }, [], initialBasis);
	const changed = structuredClone(initial);
	changed.session.intents.temporary = "Advance and remove";
	snapshot.meta.step = 1;
	runtime.publish(snapshot, true, createAcceptedTransition(initial, changed, "z-first"));
	snapshot.meta.step = 2;
	runtime.publish(snapshot, true, createAcceptedTransition(changed, initial, "a-second"));
	assert.deepEqual(runtime.states(), initial);
	assert.notEqual(runtime.causalBasis(), initialBasis);
	assert.throws(() => commitScopedTransition(snapshot, runtime.states(), stage, () => assert.fail("stale publication"), runtime.causalBasis()), /causal basis changed/);
	assert.deepEqual(runtime.recent().map(({ id, at }) => ({ id, at })), [{ id: "z-first", at: originPosition + 1 }, { id: "a-second", at: originPosition + 2 }]);
	const projected = runtime.recent();
	projected[0]!.transitions[0]!.patch.intents!.temporary = "mutated";
	assert.equal(runtime.recent()[0]!.transitions[0]!.patch.intents!.temporary, "Advance and remove");
	assert.equal(runtime.read(1).intents.temporary, "Advance and remove");
	assert.equal(snapshot.meta.step, 2);
});


test("ordinary startup needs no existing Git repository and creates no storage", () => {
	const h = harness();
	const absent = join(h.repositoryRoot, "absent");
	const runtime = new TemporalRuntime(h.ctx.cwd, "ordinary", absent);
	assert.equal(runtime.initialize(emptySnapshot(), false), undefined);
	assert.equal(runtime.view, undefined);
	assert.equal(existsSync(absent), false);
});



// --- Shared-scope drift reconciliation ---

function publishScopedPatch(
	runtime: TemporalRuntime,
	snapshot: Snapshot,
	scope: StateScope,
	working: JsonObject,
	id: string,
) {
	const before = runtime.states();
	const after = structuredClone(before);
	after[scope].working = { ...after[scope].working, ...structuredClone(working) };
	snapshot.meta.step += 1;
	return runtime.publish(snapshot, true, createAcceptedTransition(before, after, id));
}

for (const scope of ["global", "cwd"] as const) for (const write of ["session", "provenance", "target"] as const) {
	test(`first passive ${write} publication reconciles or fences foreign ${scope} drift`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-passive-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "extensions");
		const otherScope = scope === "global" ? "cwd" : "global";
		const source = join(root, "source.txt");
		const a = new TemporalRuntime(cwd, "session-a", root);
		const aSnapshot = emptySnapshot(true);
		a.initialize(aSnapshot, true);
		const seed = a.states();
		const seeded = structuredClone(seed);
		seeded[otherScope].artifacts[source] = { description: "Known source" };
		seeded.session.working.private = "session-a only";
		a.publish(aSnapshot, true, createAcceptedTransition(seed, seeded));
		const b = new TemporalRuntime(cwd, "session-b", root);
		const snapshot = emptySnapshot();
		assert.equal(b.loadPassive(), true);
		publishScopedPatch(a, aSnapshot, scope, { neighbor: "accepted" }, "foreign-shared-update");
		const winnerFiles = captureTemporalFileBases(cwd, a.sessionId, root);
		const beforeFiles = captureTemporalFileBases(cwd, b.sessionId, root);
		const before = b.states();
		const evidence = { sourceFingerprint: { size: 2, mtimeNs: "2" }, compilerRevision: "artifact-v1" };
		const stage = stageAtomicScopePatches(before, {
			[write === "target" ? scope : "session"]: { working: { mine: "accepted" } },
		}, [], b.causalBasis());
		const publish = () => write === "provenance"
			? b.publish(snapshot, false, undefined, { provenance: { [otherScope]: { [source]: evidence } } })
			: commitScopedTransition(snapshot, before, stage, (accepted, next) => {
				b.publish(next, accepted !== undefined, accepted);
			}, b.causalBasis(), { finalizeRun: false });
		if (write === "target") {
			assert.throws(publish, new RegExp(`cannot publish the ${scope === "cwd" ? "CWD" : scope} patch`));
			assert.deepEqual(captureTemporalFileBases(cwd, b.sessionId, root), beforeFiles);
			assert.deepEqual(b.states(), before);
			assert.equal(snapshot.meta.step, 0);
			return;
		}
		assert.ok(publish());
		assert.equal(snapshot.config.enabled, false);
		assert.equal(b.read(0, scope).working.neighbor, "accepted");
		assert.equal(b.read(0, "session").working.private, undefined);
		if (write === "session") {
			assert.equal(b.read(0, "session").working.mine, "accepted");
			assert.equal(snapshot.meta.step, 1);
		} else {
			assert.deepEqual(b.artifactProvenance(otherScope)[source], evidence);
			assert.equal(snapshot.meta.step, 0);
		}
		const protectedPaths = temporalScopePaths(cwd, a.sessionId, scope, root);
		const privatePaths = sessionRuntimePaths(cwd, a.sessionId, root);
		const protectedFiles = (files: typeof winnerFiles) => files.filter(({ path }) =>
			path.startsWith(`${dirname(privatePaths.runtime)}/`) || Object.values(protectedPaths).includes(path));
		assert.deepEqual(protectedFiles(captureTemporalFileBases(cwd, a.sessionId, root)), protectedFiles(winnerFiles));
		const checkpoint = b.retainedCheckpoint(snapshot);
		assert.ok("boundary" in checkpoint);
		const restored = new TemporalRuntime(cwd, b.sessionId, root);
		restored.prepareBoundaryRestore(checkpoint).restore();
		assert.deepEqual(restored.states(), b.states());
		assert.deepEqual(restored.artifactProvenance(otherScope), b.artifactProvenance(otherScope));
	});
}

test("first passive publication still fences another writer of the same private session", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-passive-private-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "extensions");
	new TemporalRuntime(cwd, "seed", root).initialize(emptySnapshot(), true);
	const passive = new TemporalRuntime(cwd, "same-session", root);
	passive.loadPassive();
	const competing = new TemporalRuntime(cwd, passive.sessionId, root);
	competing.initialize(emptySnapshot(), true);
	const files = captureTemporalFileBases(cwd, passive.sessionId, root);
	assert.throws(() => publishScopedPatch(passive, emptySnapshot(), "session", { stale: true }, "stale-private"), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(cwd, passive.sessionId, root), files);
});

function removeSharedPair(root: string, cwd: string, scope: "global" | "cwd"): void {
	const paths = temporalScopePaths(cwd, "session-a", scope, root);
	rmSync(paths.checkpoint);
	rmSync(paths.patches);
}











for (const scope of ["global", "cwd"] as const) for (const historyLimit of [0, 7]) for (const drift of ["state", "provenance"] as const) {
	test(`lifecycle-only publication adopts ${scope} ${drift} drift at limit ${historyLimit} without touching semantic files`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "state-flow-lifecycle-drift-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const a = new TemporalRuntime(cwd, "session-a", root, undefined, historyLimit);
		const snapshot = emptySnapshot(true);
		a.initialize(snapshot, true);
		const source = join(root, "registered.txt");
		const evidence = { sourceFingerprint: { size: 1, mtimeNs: "1" }, compilerRevision: "artifact-v1" };
		const before = a.states();
		const seeded = structuredClone(before);
		seeded[scope].artifacts[source] = { description: "Registered compilation" };
		seeded.session.working.private = "retained";
		snapshot.meta.step++;
		a.publish(snapshot, true, createAcceptedTransition(before, seeded), { provenance: { [scope]: { [source]: evidence } } });
		const privateState = a.read(0, "session");
		const previousHead = a.causalBasis();
		// The independent publisher deliberately retains a wider tail than a current-only reader.
		execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import { TemporalRuntime } from ${JSON.stringify(new URL("../lib/runtime.ts", import.meta.url).href)};
			import { emptySnapshot } from ${JSON.stringify(new URL("../lib/snapshot.ts", import.meta.url).href)};
			import { createAcceptedTransition } from ${JSON.stringify(new URL("../lib/history.ts", import.meta.url).href)};
			const { cwd, root, scope, drift, source, evidence } = JSON.parse(process.argv[1]);
			const b = new TemporalRuntime(cwd, "session-b", root);
			const snapshot = emptySnapshot(true);
			b.initialize(snapshot, true);
			const before = b.states();
			const next = structuredClone(before);
			if (drift === "state") { next[scope].working.foreign = "accepted"; snapshot.meta.step++; }
			b.publish(snapshot, drift === "state", drift === "state" ? createAcceptedTransition(before, next) : undefined,
				{ provenance: { [scope]: { [source]: { ...evidence, sourceFingerprint: { size: 2, mtimeNs: "2" } } } } });
		`, JSON.stringify({ cwd, root, scope, drift, source, evidence })], { stdio: "pipe" });
		const meta = temporalScopePaths(cwd, a.sessionId, scope, root).meta;
		const document = JSON.parse(readFileSync(meta, "utf8"));
		document.artifacts["/orphaned-evidence.txt"] = evidence;
		document.external = { preserved: true };
		writeFileSync(meta, `${JSON.stringify(document, null, 2)}\n`);
		const runtimePaths = sessionRuntimePaths(cwd, a.sessionId, root);
		const protectedFiles = () => captureTemporalFileBases(cwd, a.sessionId, root)
			.filter(({ path }) => path !== runtimePaths.config && path !== runtimePaths.runtime);
		const retained = protectedFiles();
		if (drift === "provenance") {
			assert.throws(() => a.publish(snapshot, false, undefined, { provenance: { [scope]: { [source]: evidence } } }), /cannot publish the (global|CWD) patch/);
			assert.deepEqual(protectedFiles(), retained, "explicit stale provenance writes are not lifecycle-only");
		}
		const stopped = structuredClone(snapshot);
		stopped.config.enabled = false;
		assert.equal(a.publish(stopped)?.changed, true);
		assert.equal(JSON.parse(readFileSync(runtimePaths.config, "utf8")).enabled, false);
		assert.equal(JSON.parse(readFileSync(runtimePaths.runtime, "utf8")).step, snapshot.meta.step);
		assert.deepEqual(protectedFiles(), retained);
		assert.deepEqual(a.read(0, "session"), privateState);
		assert.deepEqual(a.artifactProvenance(scope), document.artifacts, "Stop must not prune unrelated evidence");
		if (drift === "state") {
			assert.equal(a.read(0, scope).working.foreign, "accepted");
			assert.notEqual(a.causalBasis(), previousHead);
			assert.equal(a.view!.lineage.length, 1);
			assert.equal(a.view!.lineage[0]!.parent, null, "shared adoption is an origin, not a semantic transition");
		} else assert.equal(a.causalBasis(), previousHead);
		const stoppedFiles = captureTemporalFileBases(cwd, a.sessionId, root);
		assert.equal(a.publish(stopped), undefined, "unchanged lifecycle persistence must not fabricate another origin");
		assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), stoppedFiles);
		const restarted = structuredClone(stopped);
		restarted.config.enabled = true;
		restarted.meta.specification = "Next request";
		assert.equal(a.publish(restarted)?.changed, true);
		assert.deepEqual(protectedFiles(), retained);
		assert.equal(restarted.meta.step, snapshot.meta.step);
	});
}

for (const conflict of ["private-state", "runtime-metadata"] as const) test(`lifecycle-only publication refuses concurrent ${conflict} from the same session`, (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-private-conflict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const a = new TemporalRuntime(cwd, "session-a", root);
	const snapshot = emptySnapshot(true);
	a.initialize(snapshot, true);
	const checkpoint = a.retainedCheckpoint(snapshot);
	assert.ok("boundary" in checkpoint);
	const other = new TemporalRuntime(cwd, a.sessionId, root);
	const current = other.restoreBoundary(checkpoint).snapshot;
	if (conflict === "private-state") publishScopedPatch(other, current, "session", { other: "accepted" }, "competing-private-write");
	else {
		current.meta.specification = "Competing request";
		other.publish(current);
	}
	const files = captureTemporalFileBases(cwd, a.sessionId, root);
	const cached = structuredClone(a.view);
	const stopped = structuredClone(snapshot);
	stopped.config.enabled = false;
	assert.throws(() => a.publish(stopped), /base or scope identity changed concurrently/);
	assert.deepEqual(captureTemporalFileBases(cwd, a.sessionId, root), files);
	assert.deepEqual(a.view, cached);
});

test("file-backed publication reconciles an untouched shared scope advanced by another session", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-file-drift-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; });
	const a = new TemporalRuntime(cwd, "session-a", root);
	a.prepare();
	const snapshot = emptySnapshot(true);
	a.initialize(snapshot, true);
	publishScopedPatch(a, snapshot, "session", { sessionA: "retained" }, "a-file-seed");
	const b = new TemporalRuntime(cwd, "session-b", root);
	b.prepare();
	b.initialize(emptySnapshot(true), true);
	publishScopedPatch(b, emptySnapshot(true), "global", { globalAdvanced: "file" }, "b-file-advance");
	const publication = publishScopedPatch(a, snapshot, "session", { sessionPatch: "applied" }, "a-file-drift")!;
	assert.ok(publication.revision);
	validateTemporalState(a.view!);
	assert.equal(a.read().working.globalAdvanced, "file");
	assert.equal(a.read().working.sessionA, "retained");
	assert.equal(a.read().working.sessionPatch, "applied");
});

test("file-backed publication repairs a wholly absent untouched CWD pair without resurrecting it", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "state-flow-file-absence-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "store");
	const cwd = join(parent, "project");
	const path = process.env.PATH;
	process.env.PATH = parent;
	t.after(() => { process.env.PATH = path; });
	const runtime = new TemporalRuntime(cwd, "session-a", root);
	runtime.prepare();
	const snapshot = emptySnapshot(true);
	runtime.initialize(snapshot, true);
	publishScopedPatch(runtime, snapshot, "cwd", { must_not_resurrect: "old-file-value" }, "file-cwd-seed");
	removeSharedPair(root, cwd, "cwd");
	const publication = publishScopedPatch(runtime, snapshot, "session", { sessionPatch: "applied" }, "file-cwd-repair")!;
	assert.ok(publication.revision);
	assert.equal(runtime.read(0, "cwd").working.must_not_resurrect, undefined);
	assert.equal(runtime.read().working.sessionPatch, "applied");
	const paths = temporalScopePaths(cwd, "session-a", "cwd", root);
	assert.equal(existsSync(paths.checkpoint), true);
	assert.equal(existsSync(paths.patches), true);
});
