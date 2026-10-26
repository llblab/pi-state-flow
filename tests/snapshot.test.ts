import assert from "node:assert/strict";
import test from "node:test";

import {
	captureLifecycleSnapshot, createSessionRuntime, emptySnapshot, parseRetainedPiCheckpoint, parseSessionRuntime,
	preRuntimeCheckpoint, readCheckpointMode, retainedBoundaryCheckpoint, serializeSessionRuntime,
	prepareSessionPolicyMigration, prepareRetainedPolicyMigration, capturePrivateCausalBasis,
} from "../lib/snapshot.ts";
import { createTemporalState } from "../lib/temporal.ts";
import { emptyState } from "../lib/state.ts";
import { captureScopeSelection } from "../lib/selection.ts";

test("closed lifecycle capture accepts optional undefined in-memory fields but no forged authority or malformed counters", () => {
	const source = { config: { mode: "active" as const }, meta: { step: 1, bootstrap: false, validation: undefined, specification: undefined } };
	const captured = captureLifecycleSnapshot(source);
	assert.deepEqual(captured, { config: { mode: "active" }, meta: { step: 1, bootstrap: false } });
	captured.meta.step = 2;
	assert.equal(source.meta.step, 1);
	for (const value of [
		{ config: { mode: "active", scopes: ["cwd"] }, meta: { step: 0 } },
		{ config: { mode: null }, meta: { step: 0 } },
		{ config: { mode: "active" }, meta: { step: -1 } },
		{ config: { mode: "active" }, meta: { step: 0, privateAcquisition: "unacquired" } },
		{ config: { mode: "active" }, meta: { step: 0, validation: null } },
	]) assert.throws(() => captureLifecycleSnapshot(value as any));
});

test("mode-only policy reads never inspect checkpoint metadata or prove restoration", () => {
	for (const mode of ["active", "passive", "off"] as const) {
		const inspected: PropertyKey[] = [];
		const candidate = new Proxy({ mode }, {
			get(target, key, receiver) {
				inspected.push(key);
				if (key !== "mode") throw new Error(`Memory metadata accessed: ${String(key)}`);
				return Reflect.get(target, key, receiver);
			},
			ownKeys() { throw new Error("Memory metadata enumerated"); },
		});
		assert.equal(readCheckpointMode(candidate), mode);
		assert.ok(inspected.every((key) => key === "mode"));
		// Policy is usable even when the historical checkpoint is unavailable or malformed.
		for (const metadata of [{ boundary: "expired", step: 1 }, { boundary: null, step: -1 }, { revision: "retired" }]) {
			assert.equal(readCheckpointMode({ ...metadata, mode }), mode);
		}
	}
	assert.equal(readCheckpointMode({ mode: "active" }), "active");
	assert.throws(() => parseRetainedPiCheckpoint({ mode: "active" }), /retained-boundary checkpoint/);
});

test("mode-only decoding preserves explicit policies and strict legacy compatibility", () => {
	for (const inactive of ["passive", "off"] as const) {
		assert.equal(readCheckpointMode({ enabled: true }, inactive), "active");
		assert.equal(readCheckpointMode({ enabled: false }, inactive), inactive);
		for (const mode of ["active", "passive", "off"] as const) {
			assert.equal(readCheckpointMode({ mode }, inactive), mode);
			for (const enabled of [true, false, undefined]) {
				assert.equal(readCheckpointMode({ mode, enabled }, inactive), undefined);
			}
		}
		for (const invalid of [undefined, null, [], true, "off", {}, { mode: "on" }, { mode: null }, { enabled: "false" }, { disabled: true }]) {
			assert.equal(readCheckpointMode(invalid, inactive), undefined);
		}
	}
});

test("session config/runtime codec separates runtime provenance from semantic state", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const snapshot = { ...emptySnapshot("active"), meta: { step: 3, specification: "Continue" } };
	const runtime = createSessionRuntime(snapshot, "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	const parsed = parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!;
	assert.deepEqual(parsed, runtime);
});

test("session config serializes only the selected mode and decodes legacy enabled read-only", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	for (const mode of ["active", "passive", "off"] as const) {
		const runtime = createSessionRuntime(emptySnapshot(mode), "/project", "session", view.lineage);
		const sources = serializeSessionRuntime(runtime, "/project", "session");
		assert.equal(sources.config, `${JSON.stringify({ mode })}\n`);
		assert.deepEqual(parseSessionRuntime(sources.config, sources.runtime, "/project", "session")!.config, { mode });
	}
	const runtime = serializeSessionRuntime(createSessionRuntime(emptySnapshot("active"), "/project", "session", view.lineage), "/project", "session").runtime;
	assert.deepEqual(parseSessionRuntime(JSON.stringify({ enabled: true }), runtime, "/project", "session")!.config, { mode: "active" });
	assert.notEqual(parseSessionRuntime(JSON.stringify({ enabled: false }), runtime, "/project", "session")!.config.mode, "active");
	for (const invalid of [{}, { mode: "on" }, { mode: "active", enabled: true }, { enabled: "yes" }, { mode: null },
		{ mode: "active", scopes: ["cwd"] }, { mode: "active", scopes: [] }]) {
		assert.throws(() => parseSessionRuntime(JSON.stringify(invalid), runtime, "/project", "session"), /runtime configuration/);
	}
});

test("runtime decoding rejects mismatched identity, malformed lineage, invalid config/counters, and semantic fields", () => {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "origin");
	const runtime = createSessionRuntime(emptySnapshot("active"), "/project", "session", view.lineage);
	const sources = serializeSessionRuntime(runtime, "/project", "session");
	assert.equal(parseSessionRuntime(undefined, undefined, "/project", "session"), undefined);
	assert.throws(() => parseSessionRuntime(undefined, sources.runtime, "/project", "session"), /Incomplete/);
	assert.throws(() => parseSessionRuntime("bad", sources.runtime, "/project", "session"), /invalid JSON/);
	assert.throws(() => parseSessionRuntime(sources.config, sources.runtime, "/other", "session"), /identity mismatch/);
	for (const candidate of [
		{ ...runtime, config: { mode: "active", unexpected: true } },
		{ ...runtime, config: { enabled: true, transitionWindow: 7 } },
		{ ...runtime, meta: { ...runtime.meta, step: -1 } },
		{ ...runtime, meta: { ...runtime.meta, tactics: { forged: true } } },
		{ ...runtime, meta: { ...runtime.meta, version: 2 } },
		{ ...runtime, meta: { ...runtime.meta, lineage: [runtime.meta.lineage[0], runtime.meta.lineage[0]] } },
	]) assert.throws(() => parseSessionRuntime(JSON.stringify(candidate.config), JSON.stringify(candidate.meta), "/project", "session"));
});

test("retained-boundary checkpoints contain only temporal identity and branch lifecycle", () => {
	const snapshot = {
		config: { mode: "active" as const },
		meta: {
			step: 4,
			bootstrap: true as const,
			specification: "Finish the retained run",
		},
	};
	const checkpoint = retainedBoundaryCheckpoint(snapshot, "transition-4");
	assert.deepEqual(checkpoint, {
		boundary: "transition-4", mode: "active", step: 4, bootstrap: true, specification: "Finish the retained run",
	});
	assert.deepEqual(parseRetainedPiCheckpoint(checkpoint), checkpoint);
	for (const mode of ["passive", "off"] as const) {
		assert.deepEqual(preRuntimeCheckpoint(mode), { mode });
		assert.deepEqual(parseRetainedPiCheckpoint({ mode }), { mode });
		// Legacy markers keep the caller's inactive policy; enabled:true alone stays active.
		assert.deepEqual(parseRetainedPiCheckpoint({ disabled: true }, mode), { mode });
		assert.deepEqual(parseRetainedPiCheckpoint({ boundary: "b", enabled: false, step: 1 }, mode), { boundary: "b", mode, step: 1 });
		assert.deepEqual(parseRetainedPiCheckpoint({ boundary: "b", enabled: true, step: 1 }, mode), { boundary: "b", mode: "active", step: 1 });
	}
	assert.throws(() => preRuntimeCheckpoint("active"), /retained semantic boundary/);
	for (const invalid of [
		{}, { mode: "active" }, { disabled: false }, { boundary: "", mode: "active", step: 0 }, { boundary: "b", enabled: "yes", step: 0 },
		{ boundary: "b", mode: "on", step: 0 }, { boundary: "b", mode: "active", enabled: true, step: 0 },
		{ boundary: "b", mode: "active", step: -1 }, { boundary: "b", mode: "active", step: 0, bootstrap: false },
		{ boundary: "b", mode: "active", step: 0, revision: "a".repeat(40) },
	]) assert.throws(() => parseRetainedPiCheckpoint(invalid), /retained-boundary checkpoint/);
});

function policySources() {
	const view = createTemporalState({ global: emptyState(), cwd: emptyState(), session: emptyState() }, "policy-origin");
	const runtime = createSessionRuntime({ config: { mode: "active" }, meta: { step: 4, bootstrap: false, specification: "Keep this run" } }, "/project", "session", view.lineage);
	return { config: JSON.stringify(runtime.config), metadata: runtime.meta };
}

test("private causal basis is closed complete v2 acquired proof, never a legacy collision or caller lifecycle field", () => {
	const fixture = policySources();
	const basis = { lineage: fixture.metadata.lineage, causalWitnesses: [] };
	const captured = capturePrivateCausalBasis(basis);
	assert.deepEqual(captured, basis); assert.notEqual(captured.lineage, basis.lineage);
	const next = { id: "private-step", parent: basis.lineage[0]!.id, position: basis.lineage[0]!.position + 1 };
	for (const bad of [null, [], {}, { ...basis, extra: true }, { ...basis, causalWitnesses: null },
		{ lineage: [...basis.lineage, next], causalWitnesses: [] },
		{ lineage: [...basis.lineage, next], causalWitnesses: [{ transition: next, owners: [] }] }]) {
		assert.throws(() => capturePrivateCausalBasis(bad));
	}
	for (const value of [null, basis, { opaque: "must not be overwritten" }]) {
		assert.throws(() => prepareSessionPolicyMigration(fixture.config, JSON.stringify({ ...fixture.metadata, privateCausalBasis: value }), "/project", "session", ["cwd"]), /Target.*legacy/);
	}
	const config = JSON.stringify({ mode: "active", scopes: ["cwd"] });
	for (const state of ["unacquired", "deferred"]) {
		assert.throws(() => prepareSessionPolicyMigration(config, JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition: state, privateCausalBasis: basis }), "/project", "session", ["cwd"]), /private causal basis provenance/);
	}
	const raw = { ...fixture.metadata, version: 2, privateAcquisition: "acquired", privateCausalBasis: basis, opaque: { keep: true } };
	const admitted = prepareSessionPolicyMigration(config, JSON.stringify(raw), "/project", "session", ["cwd"])!;
	assert.deepEqual(admitted.runtime.meta.privateCausalBasis, basis);
	assert.deepEqual(admitted.runtime.meta.opaque, { keep: true });
	assert.throws(() => captureLifecycleSnapshot({ config: { mode: "active" }, meta: { step: 0, privateCausalBasis: basis } } as any));
});

test("legacy lifecycle preflight preserves raw evidence, identity and lineage while capturing supplied defaults once", () => {
	const fixture = policySources();
	const metadata = { ...fixture.metadata, foreign: { path: "$session.working.opaque" }, temporal: { opaque: true }, artifacts: { "/legacy": { future: true } } };
	const source = ` ${JSON.stringify(metadata)}\n`;
	const defaults = captureScopeSelection(["cwd"]);
	const candidate = prepareSessionPolicyMigration(fixture.config, source, "/project", "session", defaults)!;
	assert.equal(candidate.sourceVersion, 1);
	assert.equal(candidate.requiresConversion, true);
	assert.deepEqual(candidate.source, { config: fixture.config, runtime: source });
	assert.deepEqual(candidate.runtime.config, { mode: "active", scopes: ["cwd"] });
	assert.deepEqual(candidate.runtime.meta, { ...metadata, version: 2, privateAcquisition: "acquired" });
	assert.notEqual(candidate.runtime.config.scopes, defaults);
	assert.equal(Object.isFrozen(candidate.runtime.config.scopes), true);
	const repeated = prepareSessionPolicyMigration(candidate.target.config, candidate.target.runtime, "/project", "session", captureScopeSelection(["session"]))!;
	assert.equal(repeated.requiresConversion, false);
	assert.deepEqual(repeated.runtime, candidate.runtime);
	assert.deepEqual(repeated.target, candidate.target);
	candidate.runtime.meta.identity.cwd = "/mutated";
	assert.equal(repeated.runtime.meta.identity.cwd, "/project");
	assert.equal(source, candidate.source.runtime);
	const inactive = prepareSessionPolicyMigration('{"enabled":false}', source, "/project", "session", defaults)!;
	assert.equal(inactive.runtime.config.mode, "passive");
});

test("v2 lifecycle preflight admits all subsets and acquisition claims without widening current native readers or writers", () => {
	const fixture = policySources();
	const order = ["global", "cwd", "session"];
	for (let mask = 1; mask < 8; mask++) for (const privateAcquisition of ["unacquired", "deferred", "acquired"]) for (const mode of ["off", "passive", "active"]) {
		const scopes = order.filter((_, bit) => mask & (1 << bit));
		const config = JSON.stringify({ mode, scopes: [...scopes].reverse() });
		const runtime = JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition });
		const candidate = prepareSessionPolicyMigration(config, runtime, "/project", "session", captureScopeSelection(["global"]))!;
		assert.equal(candidate.sourceVersion, 2);
		assert.equal(candidate.requiresConversion, false);
		assert.deepEqual(candidate.runtime.config, { mode, scopes });
		assert.equal(candidate.runtime.meta.privateAcquisition, privateAcquisition);
		assert.throws(() => parseSessionRuntime(candidate.target.config, candidate.target.runtime, "/project", "session"));
		assert.throws(() => serializeSessionRuntime(candidate.runtime as any, "/project", "session"), /Unsupported/);
	}
});

test("lifecycle preflight rejects partial, unknown, mixed and invalid authority before conversion", () => {
	const fixture = policySources();
	const defaults = captureScopeSelection(["cwd"]);
	const prepare = (config: string | undefined, meta: string | undefined, cwd = "/project", id = "session") => prepareSessionPolicyMigration(config, meta, cwd, id, defaults);
	const runtime = JSON.stringify(fixture.metadata);
	assert.equal(prepare(undefined, undefined), undefined);
	assert.throws(() => prepare(undefined, runtime), /Incomplete/);
	assert.throws(() => prepare(fixture.config, undefined), /Incomplete/);
	assert.throws(() => prepare("{broken", runtime));
	assert.throws(() => prepare(fixture.config, "{broken"));
	for (const [config, meta] of [["private-secret-token", runtime], [fixture.config, "private-secret-token"]]) {
		assert.throws(() => prepare(config, meta), (error: Error) => {
			assert.match(error.message, /session policy contains invalid JSON/);
			assert.doesNotMatch(error.message, /private-secret-token/);
			assert.equal(error.cause, undefined);
			return true;
		});
	}
	for (const version of [undefined, null, 0, 3, "2", true]) {
		assert.throws(() => prepare("{broken", JSON.stringify({ ...fixture.metadata, version })), /Unsupported/);
	}
	assert.throws(() => prepare('{"mode":"active","scopes":["cwd"]}', runtime), /Target.*legacy/);
	assert.throws(() => prepare(fixture.config, JSON.stringify({ ...fixture.metadata, privateAcquisition: "acquired" })), /Target.*legacy/);
	assert.throws(() => prepare(fixture.config, JSON.stringify({ ...fixture.metadata, causalWitnesses: [] })), /Target.*legacy/);
	assert.throws(() => prepare(fixture.config, runtime, "/other"), /identity/);
	assert.throws(() => prepare(fixture.config, runtime, "/project", "other"), /identity/);
	for (const fields of [{ step: -1 }, { lineage: [] }, { strategy: {} }, { foreign: Infinity }]) {
		const source = JSON.stringify({ ...fixture.metadata, ...fields }).replace('"foreign":null', '"foreign":1e309');
		assert.throws(() => prepare(fixture.config, source));
	}
	const meta2 = JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition: "acquired" });
	for (const config of [{ mode: "active" }, { mode: "active", scopes: [] }, { mode: "active", scopes: null }, { mode: "active", scopes: ["CWD"] },
		{ mode: "active", scopes: ["cwd", "cwd"] }, { mode: "active", enabled: true, scopes: ["cwd"] }, { mode: "on", scopes: ["cwd"] }, { mode: "active", scopes: ["cwd"], foreign: true }]) {
		assert.throws(() => prepare(JSON.stringify(config), meta2));
	}
	for (const privateAcquisition of [undefined, null, false, "fresh", "Acquired", {}]) {
		assert.throws(() => prepare('{"mode":"off","scopes":["cwd"]}', JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition })), /acquisition/);
	}
});

test("native policy candidates preserve lifecycle and freeze explicit selection without treating it as boundary authority", () => {
	const defaults = captureScopeSelection(["cwd"]);
	for (const legacy of [{ mode: "off" }, { mode: "passive" }, { disabled: true }, { boundary: "expired-but-opaque", mode: "active", step: 3, bootstrap: true, specification: "Keep" }]) {
		const before = structuredClone(legacy);
		const candidate = prepareRetainedPolicyMigration(legacy, defaults, "off");
		assert.equal(candidate.sourceVersion, "legacy");
		assert.equal(candidate.requiresConversion, true);
		assert.deepEqual(candidate.checkpoint, { ...parseRetainedPiCheckpoint(legacy, "off"), version: 2, scopes: ["cwd"] });
		assert.deepEqual(legacy, before);
		assert.equal(Object.isFrozen(candidate.checkpoint.scopes), true);
		const retained = prepareRetainedPolicyMigration(candidate.checkpoint, captureScopeSelection(["session"]));
		assert.equal(retained.requiresConversion, false);
		assert.deepEqual(retained.checkpoint, candidate.checkpoint);
		assert.throws(() => parseRetainedPiCheckpoint(candidate.checkpoint));
	}
	const input = { version: 2, mode: "passive", scopes: ["session", "global"] };
	const candidate = prepareRetainedPolicyMigration(input, defaults);
	input.scopes.splice(0);
	assert.deepEqual(candidate.checkpoint.scopes, ["global", "session"]);
});

test("native policy candidates refuse missing, malformed, future and mixed evidence rather than mode-only fallback", () => {
	const defaults = captureScopeSelection(["global"]);
	for (const value of [null, [], true, {}, { mode: "active" }, { mode: "off", scopes: ["cwd"] },
		{ version: 2, mode: "off" }, { version: 2, mode: "off", scopes: [] }, { version: 2, mode: "off", scopes: ["cwd", "cwd"] },
		{ version: 2, enabled: false, scopes: ["cwd"] }, { version: 2, disabled: true, scopes: ["cwd"] },
		{ version: 2, mode: "off", scopes: ["cwd"], state: {} }, { version: 2, mode: "active", scopes: ["cwd"] },
		{ version: 2, mode: "active", scopes: ["cwd"], boundary: "b", step: -1 }]) {
		assert.throws(() => prepareRetainedPolicyMigration(value, defaults));
	}
	for (const version of [1, 3, null, "2", "legacy", true]) {
		assert.throws(() => prepareRetainedPolicyMigration({ version, mode: "off", scopes: ["cwd"] }, defaults), /Unsupported/);
	}
	assert.equal(readCheckpointMode({ version: 2, mode: "active", scopes: [] }), "active", "the old extractor is intentionally not full policy validation");
});
