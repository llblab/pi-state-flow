import assert from "node:assert/strict";
import test from "node:test";

import {
	captureLifecycleSnapshot, parseRetainedPiCheckpoint, preRuntimeCheckpoint, readCheckpointMode, retainedBoundaryCheckpoint,
	parseSelectedLifecycle, prepareRetainedPolicyMigration, capturePrivateCausalBasis, UnsupportedLifecycleFormatError,
	parseBaselineLifecycle, serializeBaselineLifecycle,
} from "../lib/snapshot.ts";
import { advanceTemporalState, createTemporalState, restoreSelectedTemporalState, temporalCausalWitnesses } from "../lib/temporal.ts";
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

test("Baseline separates explicit mode and selection from run fields and never decodes an enabled alias", () => {
	const { metadata } = policySources();
	const scopes = captureScopeSelection(["session"]);
	for (const mode of ["active", "passive", "off"] as const) {
		const runtime = { config: { mode, scopes }, meta: { ...metadata, version: 2 as const, privateAcquisition: "acquired" as const } };
		const wire = serializeBaselineLifecycle(runtime, "/project", "session");
		assert.deepEqual(JSON.parse(wire.config), { mode, scopes });
		const parsed = parseSelectedLifecycle(wire.config, wire.runtime, "/project", "session")!;
		assert.equal(parsed.sourceVersion, "baseline");
		assert.deepEqual(parsed.runtime, { ...runtime, meta: { ...runtime.meta, causalWitnesses: [] } });
		for (const enabled of [true, false]) {
			assert.throws(() => parseSelectedLifecycle(JSON.stringify({ enabled, scopes }), wire.runtime, "/project", "session"), /configuration/);
		}
	}
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
	return {
		config: '{"mode":"active"}',
		metadata: { version: 1, identity: { cwd: "/project", sessionId: "session" }, lineage: [{ id: "policy-origin", position: 0, parent: null }],
			step: 4, bootstrap: false, specification: "Keep this run" },
	};
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
		assert.throws(() => parseSelectedLifecycle(fixture.config, JSON.stringify({ ...fixture.metadata, privateCausalBasis: value }), "/project", "session"), UnsupportedLifecycleFormatError);
	}
	const config = JSON.stringify({ mode: "active", scopes: ["cwd"] });
	for (const state of ["unacquired", "deferred"]) {
		assert.throws(() => parseSelectedLifecycle(config, JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition: state, privateCausalBasis: basis }), "/project", "session"), /private causal basis provenance/);
	}
	const raw = { ...fixture.metadata, version: 2, privateAcquisition: "acquired", privateCausalBasis: basis, opaque: { keep: true } };
	const admitted = parseSelectedLifecycle(config, JSON.stringify(raw), "/project", "session")!;
	assert.deepEqual(admitted.runtime.meta.privateCausalBasis, basis);
	assert.deepEqual(admitted.runtime.meta.opaque, { keep: true });
	assert.throws(() => captureLifecycleSnapshot({ config: { mode: "active" }, meta: { step: 0, privateCausalBasis: basis } } as any));
});

function baselineFixture() {
	const states = { global: {}, cwd: {}, session: {} };
	const origin = createTemporalState(states, "origin");
	const privateView = advanceTemporalState(origin, [{ scope: "session", patch: { tactics: { note: "retained privately" } } }], "private");
	const shared = advanceTemporalState(origin, [{ scope: "cwd", patch: { strategy: { rule: "shared" } } }], "shared");
	const config = JSON.stringify({ mode: "active", scopes: ["cwd"] });
	const source = JSON.stringify({
		...policySources().metadata, version: 2, privateAcquisition: "acquired", lineage: shared.lineage,
		causalWitnesses: temporalCausalWitnesses(shared), opaque: { future: [false, "keep"] },
		privateCausalBasis: { lineage: privateView.lineage, causalWitnesses: temporalCausalWitnesses(privateView) },
	});
	const v2 = parseSelectedLifecycle(config, source, "/project", "session")!.runtime;
	return { v2, shared, privateView, wire: serializeBaselineLifecycle(v2, "/project", "session") };
}

test("Baseline stores each boundary once in both proofs and preserves V2 evidence and unknown metadata", () => {
	const { v2, wire } = baselineFixture();
	const raw = JSON.parse(wire.runtime);
	assert.equal(raw.format, "baseline");
	assert.equal(Object.hasOwn(raw, "version"), false);
	assert.equal(Object.hasOwn(raw, "causalWitnesses"), false);
	assert.deepEqual(raw.lineage, [v2.meta.lineage[0], { ...v2.meta.lineage[1], owners: ["cwd"] }]);
	assert.deepEqual(raw.privateCausalBasis, [v2.meta.privateCausalBasis!.lineage[0], { ...v2.meta.privateCausalBasis!.lineage[1], owners: ["session"] }]);
	const decoded = parseBaselineLifecycle(wire.config, wire.runtime, "/project", "session");
	assert.deepEqual(decoded, v2);
	assert.deepEqual(serializeBaselineLifecycle(decoded, "/project", "session"), wire);
	assert.throws(() => serializeBaselineLifecycle({ ...v2, meta: { ...v2.meta, format: "opaque" } }, "/project", "session"), /collides/);
});

test("Baseline can omit optional metadata and claims but cannot invent selected or private history", () => {
	const { wire, shared, privateView } = baselineFixture();
	const raw = JSON.parse(wire.runtime);
	delete raw.opaque;
	delete raw.lineage[1].owners;
	const parse = () => parseBaselineLifecycle(wire.config, JSON.stringify(raw), "/project", "session");
	const admitted = parse();
	assert.equal(admitted.meta.opaque, undefined);
	assert.deepEqual(admitted.meta.causalWitnesses, []);
	assert.deepEqual(restoreSelectedTemporalState({ cwd: shared.scopes.cwd }, ["cwd"], admitted.meta.lineage, admitted.meta.causalWitnesses).lineage, shared.lineage);
	assert.throws(() => restoreSelectedTemporalState({ global: shared.scopes.global }, ["global"], admitted.meta.lineage, admitted.meta.causalWitnesses), /witness|proof/i);
	const retained = admitted.meta.privateCausalBasis!;
	assert.deepEqual(restoreSelectedTemporalState({ session: privateView.scopes.session }, ["session"], retained.lineage, retained.causalWitnesses).lineage, privateView.lineage);
	delete raw.privateCausalBasis[1].owners;
	assert.throws(parse, /Insufficient.*private causal basis/);
});

test("Baseline refuses mixed formats, anchor claims, malformed evidence and foreign identities", () => {
	const { wire } = baselineFixture();
	const parse = (raw: unknown, cwd = "/project") => parseBaselineLifecycle(wire.config, JSON.stringify(raw), cwd, "session");
	for (const change of [
		(raw: any) => { raw.version = 2; },
		(raw: any) => { raw.format = "future"; },
		(raw: any) => { raw.causalWitnesses = []; },
		(raw: any) => { raw.lineage[0].owners = ["cwd"]; },
		(raw: any) => { raw.lineage[1].owners = ["session", "cwd"]; },
		(raw: any) => { raw.lineage[1].owners = []; },
		(raw: any) => { raw.lineage[1].parent = "other"; },
		(raw: any) => { raw.privateAcquisition = "deferred"; },
	]) {
		const raw = JSON.parse(wire.runtime);
		change(raw);
		assert.throws(() => parse(raw));
	}
	assert.throws(() => parse(JSON.parse(wire.runtime), "/other"), /identity mismatch/);
});

test("selected lifecycle refuses retired V1 even with no config or malformed config", () => {
	const fixture = policySources();
	const source = JSON.stringify(fixture.metadata);
	for (const config of [undefined, fixture.config, "{broken"]) {
		assert.throws(() => parseSelectedLifecycle(config, source, "/project", "session"), (error: unknown) =>
			error instanceof UnsupportedLifecycleFormatError && /V1 is retired.*previous.*release/.test(error.message));
	}
});

test("v2 lifecycle preflight admits all subsets and acquisition claims through the Baseline codec", () => {
	const fixture = policySources();
	const order = ["global", "cwd", "session"];
	for (let mask = 1; mask < 8; mask++) for (const privateAcquisition of ["unacquired", "deferred", "acquired"]) for (const mode of ["off", "passive", "active"]) {
		const scopes = order.filter((_, bit) => mask & (1 << bit));
		const config = JSON.stringify({ mode, scopes: [...scopes].reverse() });
		const runtime = JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition });
		const candidate = parseSelectedLifecycle(config, runtime, "/project", "session")!;
		assert.equal(candidate.sourceVersion, 2);
		assert.deepEqual(candidate.runtime.config, { mode, scopes });
		assert.equal(candidate.runtime.meta.privateAcquisition, privateAcquisition);
		const baseline = serializeBaselineLifecycle(candidate.runtime, "/project", "session");
		assert.deepEqual(parseBaselineLifecycle(baseline.config, baseline.runtime, "/project", "session"),
			{ ...candidate.runtime, meta: { ...candidate.runtime.meta, causalWitnesses: [] } });
	}
});

test("lifecycle preflight rejects partial, unknown, mixed and invalid authority before conversion", () => {
	const fixture = policySources();
	const prepare = (config: string | undefined, meta: string | undefined, cwd = "/project", id = "session") => parseSelectedLifecycle(config, meta, cwd, id);
	const runtime = JSON.stringify({ ...fixture.metadata, version: 2, privateAcquisition: "acquired" });
	const config = JSON.stringify({ mode: "active", scopes: ["cwd"] });
	assert.equal(prepare(undefined, undefined), undefined);
	assert.throws(() => prepare(undefined, runtime), /Incomplete/);
	assert.throws(() => prepare(config, undefined), /Incomplete/);
	assert.throws(() => prepare("{broken", runtime));
	assert.throws(() => prepare(config, "{broken"));
	for (const [settings, meta] of [["private-secret-token", runtime], [config, "private-secret-token"]]) {
		assert.throws(() => prepare(settings, meta), (error: Error) => {
			assert.match(error.message, /session policy contains invalid JSON/);
			assert.doesNotMatch(error.message, /private-secret-token/);
			assert.equal(error.cause, undefined);
			return true;
		});
	}
	for (const version of [undefined, null, 0, 3, "2", true]) {
		assert.throws(() => prepare("{broken", JSON.stringify({ ...fixture.metadata, version })), /Unsupported/);
	}
	assert.throws(() => prepare(config, runtime, "/other"), /identity/);
	assert.throws(() => prepare(config, runtime, "/project", "other"), /identity/);
	for (const fields of [{ step: -1 }, { lineage: [] }, { lineage: [fixture.metadata.lineage[0], fixture.metadata.lineage[0]] }, { strategy: {} }, { tactics: { forged: true } }, { foreign: Infinity }]) {
		const source = JSON.stringify({ ...JSON.parse(runtime), ...fields }).replace('"foreign":null', '"foreign":1e309');
		assert.throws(() => prepare(config, source));
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
