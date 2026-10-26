import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseScopeStream } from "../lib/durable.ts";
import { MAX_HISTORY_LIMIT } from "../lib/history.ts";
import { applyPatch, type JsonObject, type JsonValue } from "../lib/json.ts";
import { prepareSemanticMigration, prepareSerializedScopeMigration, translateLegacySemanticObject, type ScopeMigrationFile } from "../lib/migration.ts";
import { assertNoRetiredSemanticPlanes, type StateScope } from "../lib/state.ts";
import { validateTemporalState, type ScopeStream, type TemporalState, type TransitionBoundary } from "../lib/temporal.ts";

const scopes: StateScope[] = ["global", "cwd", "session"];
const origin: TransitionBoundary = { id: "origin", position: 0, parent: null };
const files: ScopeMigrationFile[] = ["checkpoint", "patches", "meta"];
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cwdIdentity = "/migration/project";
type SourceBytes = Record<ScopeMigrationFile, Uint8Array>;

function serializedFixture(scope: StateScope, version = 2): SourceBytes {
	const stream = streamFixture();
	const metadata = {
		version, artifacts: {
			"/registered/source": { sourceHash: `sha256:${"a".repeat(64)}`, sourceFingerprint: { size: 17, mtimeNs: "42" }, compilerRevision: "v1", compiledAt: 12 },
			"/uninterpretable/source": { futureEvidence: [null, "do not normalize"] },
		},
		...(scope === "cwd" ? { owner: { cwd: cwdIdentity } } : {}),
		temporal: { revision: stream.revision, checkpoint: stream.checkpoint.through, patches: stream.patches.map((record) => record.transition), extra: { preserve: true } },
		identity: { id: "opaque-authority", key: "opaque-key" }, lineage: [origin, stream.patches[0]!.transition],
		specification: "$session.contract.requirement", bootstrap: true, foreign: { marker: "$session.working.job", empty: null },
	};
	return {
		checkpoint: encode(` \n${JSON.stringify(stream.checkpoint.state, null, 2)}\r\n`),
		patches: encode(`\r\n  ${JSON.stringify(stream.patches[0]!.patch)}\r\n \r\n`),
		meta: encode(`\n${JSON.stringify(metadata, null, 2)}\n`),
	};
}

function changeMetadata(sources: SourceBytes, change: (metadata: JsonObject) => void): SourceBytes {
	const metadata = JSON.parse(decode(sources.meta)) as JsonObject;
	change(metadata);
	return { ...sources, meta: encode(JSON.stringify(metadata)) };
}

// These are intentionally v1/v2 fixtures, not examples of the target model API.
function streamFixture(): ScopeStream {
	return {
		revision: 1,
		checkpoint: { through: structuredClone(origin), state: {
			contract: { requirement: "offline", nested: { working: "ordinary key" }, empty: {} },
			working: { job: { steps: [{ next: "inspect", ref: { $ref: "session.working.job" } }] } },
			intents: { job: { context: { $ref: "session.working.job" } } },
		} },
		patches: [{ transition: { id: "T1", position: 1, parent: origin.id }, patch: {
			working: { job: { steps: { "[0]": { next: "validate" } } } }, contract: { rejected: "online-only" },
		} }],
	};
}

function materialize(stream: ScopeStream, position: number): JsonObject {
	let state: JsonObject = structuredClone(stream.checkpoint.state);
	for (const record of stream.patches) {
		if (record.transition.position > position) break;
		state = applyPatch(state, record.patch as JsonObject);
	}
	return state;
}

function temporalFixture(count: number, limit = MAX_HISTORY_LIMIT): TemporalState {
	const view: TemporalState = {
		lineage: [structuredClone(origin)],
		scopes: Object.fromEntries(scopes.map((scope): [StateScope, ScopeStream] => [scope, { revision: 0, patches: [], checkpoint: {
			through: structuredClone(origin), state: scope === "session" ? streamFixture().checkpoint.state : {},
		} }])) as Record<StateScope, ScopeStream>,
	};
	for (let index = 1; index <= count; index++) {
		const boundary = { id: `T${index}`, position: index, parent: view.lineage.at(-1)!.id };
		view.lineage.push(boundary);
		for (const scope of scopes) {
			if (scope === "global" && index % 3 !== 0 || scope === "cwd" && index % 5 !== 0) continue;
			const patch: JsonObject = scope === "session" ? {
				working: { job: { count: index, steps: { "[0]": { next: `step-${index}`, ref: null } } } },
				contract: index % 10 === 0 ? null : { accepted: index },
			} : { contract: { owner: scope, latest: index } };
			if (scope === "session" && index === count) {
				patch.intents = { job: null };
				patch.working = { job: null };
				patch.response = "Finished; see $session.contract.accepted";
			}
			view.scopes[scope].revision++;
			view.scopes[scope].patches.push({ transition: structuredClone(boundary), patch });
		}
		if (view.lineage.length > limit + 1) view.lineage.shift();
		for (const stream of Object.values(view.scopes)) {
			if (stream.patches.length <= limit) continue;
			const folded = stream.patches.shift()!;
			stream.checkpoint = { through: folded.transition, state: applyPatch(stream.checkpoint.state, folded.patch as JsonObject) };
		}
	}
	return view;
}

test("legacy translation renames only root planes and preserves sparse values, deletion markers and opaque data", () => {
	const source: JsonObject = {
		contract: { working: "ordinary key", empty: {}, accepted: true, finite: 1.25 },
		working: { rows: [{ contract: "ordinary key" }], remove: null, emptyArray: [] },
		lazy: { data: { $ref: "cwd.contract.accepted" } },
		foreign: { $ref: "session.working.opaque", contract: "not a semantic plane" },
		artifacts: { "/tmp/$working.file": { description: "Use $working.rows", hash: "$session.contract.hash", compiler: "$working.compiler", compiled_at: "$contract.epoch" } },
	};
	const before = structuredClone(source);
	assert.deepEqual(translateLegacySemanticObject(source), {
		strategy: source.contract,
		tactics: source.working,
		lazy: { data: { $ref: "cwd.strategy.accepted" } },
		foreign: source.foreign,
		artifacts: { "/tmp/$working.file": { description: "Use $tactics.rows", hash: "$session.contract.hash", compiler: "$working.compiler", compiled_at: "$contract.epoch" } },
	});
	assert.deepEqual(source, before);
	assert.deepEqual(translateLegacySemanticObject({}), {});
	assert.deepEqual(translateLegacySemanticObject({ contract: null, working: null }), { strategy: null, tactics: null });
	const special = JSON.parse('{"working":{"__proto__":{"$ref":"session.contract.x"}}}') as JsonObject;
	const translated = translateLegacySemanticObject(special);
	assert.equal(Object.hasOwn(translated.tactics as JsonObject, "__proto__"), true);
	assert.equal(Object.getPrototypeOf(translated.tactics), Object.prototype);
});

test("recognized locators translate only their plane position and retain scope, offsets, selectors and token boundaries", () => {
	const paths = new Map([
		["working", "tactics"],
		["contract.bindings", "strategy.bindings"],
		["global.contract.rules.working", "global.strategy.rules.working"],
		["cwd[100].working.rows[01].key", "cwd[100].tactics.rows[01].key"],
		["session.working.rows[0:2]", "session.tactics.rows[0:2]"],
		["effective[2].contract.rows[0..2]", "effective[2].strategy.rows[0..2]"],
		["session.patches[3].working.job", "session.patches[3].tactics.job"],
	]);
	for (const [path, target] of paths) {
		const translated = translateLegacySemanticObject({ lazy: { ref: { $ref: path }, text: `See $${path}; then ($${path})` } });
		assert.deepEqual(translated, { lazy: { ref: { $ref: target }, text: `See $${target}; then ($${target})` } });
	}
});

test("migration preserves unmarked prose, resources, unsupported locators and invalid structured reference strings", () => {
	const strings = [
		"contract and working are words; session.working.job is unmarked",
		"/tmp/$working.job", "https://host/$session.working.job", "C:\\files\\$contract.rule",
		"$working.job/file", "prefix$working.job", "$$working.job", "$working.jobю",
		"$working.job.", "$working.rows[bad]", "$working.rows[0:]", "$session[101].working.job",
		"$effective.patches[0].working.job", "$session[1].patches[0].working.job",
		"$other.working.job", "$session.lazy.working", "$working.path/contract",
	];
	assert.deepEqual(translateLegacySemanticObject({ lazy: { strings } }), { lazy: { strings } });
	for (const ref of ["$session.working.job", "session.working.job extra", "working.invalid[bad]", "https://host/contract"]) {
		assert.deepEqual(translateLegacySemanticObject({ lazy: { $ref: ref } }), { lazy: { $ref: ref } });
	}
});

test("raw target names reject legacy conversion even without old siblings; retired roots reject target documents", () => {
	for (const plane of ["strategy", "tactics"]) {
		for (const value of [{}, null, "previously ignored"]) {
			assert.throws(() => translateLegacySemanticObject({ [plane]: value }), /Target State Flow semantic plane in legacy format/);
			assert.throws(() => translateLegacySemanticObject({ contract: {}, working: {}, [plane]: value }), /Target State Flow semantic plane in legacy format/);
		}
	}
	for (const plane of ["contract", "working"]) {
		for (const value of [{}, null]) assert.throws(() => assertNoRetiredSemanticPlanes({ [plane]: value }), /Retired State Flow semantic plane/);
	}
	assert.doesNotThrow(() => assertNoRetiredSemanticPlanes({ tactics: { contract: {}, working: {} } }));
});

test("scope candidates are versioned, detached, idempotent and preserve independent revisions and causal identities", () => {
	for (const scope of scopes) for (const version of [1, 2]) {
		const source = streamFixture();
		const before = structuredClone(source);
		const candidate = prepareSemanticMigration(source, scope, version);
		assert.equal(candidate.sourceVersion, version);
		assert.equal(candidate.targetVersion, 3);
		assert.equal(candidate.requiresConversion, true);
		assert.equal(candidate.stream.revision, source.revision);
		assert.deepEqual(candidate.stream.checkpoint.through, source.checkpoint.through);
		assert.deepEqual(candidate.stream.patches.map((record) => record.transition), source.patches.map((record) => record.transition));
		assert.deepEqual(source, before);
		const repeat = prepareSemanticMigration(candidate.stream, scope, candidate.targetVersion);
		assert.equal(repeat.requiresConversion, false);
		assert.deepEqual(repeat.stream, candidate.stream);
		assert.notEqual(repeat.stream, candidate.stream);
		((candidate.stream.checkpoint.state.strategy as JsonObject).nested as JsonObject).working = "mutated";
		candidate.stream.patches[0]!.transition.id = "mutated";
		assert.deepEqual(source, before);
		assert.equal(repeat.stream.patches[0]!.transition.id, "T1");
	}
});

test("translation commutes with recorded replay and aligned effective overlays at retention limits 0, 1, 7 and 100", () => {
	for (const limit of [0, 1, 7, 100]) {
		const source = temporalFixture(limit + 4, limit);
		const converted = Object.fromEntries(scopes.map((scope) => [scope, prepareSemanticMigration(source.scopes[scope], scope, 2, limit).stream])) as Record<StateScope, ScopeStream>;
		validateTemporalState({ lineage: source.lineage, scopes: converted }, limit);
		for (const scope of scopes) {
			assert.equal(converted[scope].revision, source.scopes[scope].revision);
			for (const boundary of [source.scopes[scope].checkpoint.through, ...source.scopes[scope].patches.map((record) => record.transition)]) {
				assert.deepEqual(materialize(converted[scope], boundary.position), translateLegacySemanticObject(materialize(source.scopes[scope], boundary.position)));
			}
		}
		for (const boundary of source.lineage) {
			const overlay = (streams: Record<StateScope, ScopeStream>) => scopes.reduce((state, scope) => applyPatch(state, materialize(streams[scope], boundary.position)), {});
			assert.deepEqual(overlay(converted), translateLegacySemanticObject(overlay(source.scopes)));
		}
		assert.equal(Object.hasOwn(materialize(converted.session, source.lineage.at(-1)!.position), "intents"), true);
		assert.deepEqual(materialize(converted.session, source.lineage.at(-1)!.position).intents, {});
	}
});

test("explicit metadata4 conversion retains identities and rejects raw legacy external collisions before filtering", () => {
	const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	for (const version of [1, 2, 3]) {
		const source = serializedFixture("session", version);
		if (version === 3) {
			const translated = prepareSerializedScopeMigration(serializedFixture("session", 2), "session");
			for (const key of files) source[key] = encode(translated.target[key]);
		}
		const before = structuredClone(source);
		const baseline = prepareSerializedScopeMigration(source, "session");
		const upgraded = prepareSerializedScopeMigration(source, "session", undefined, modules);
		assert.equal(upgraded.targetVersion, 4);
		assert.equal(upgraded.requiresConversion, true);
		assert.deepEqual(upgraded.stream, { ...baseline.stream, modules });
		assert.deepEqual(parseScopeStream(upgraded.target.checkpoint, upgraded.target.patches, "session", undefined, upgraded.target.meta), upgraded.stream);
		assert.deepEqual(source, before);
		for (const key of ["checkpoint", "patches"] as const) for (const id of ["x_acme_archive", "x_Invalid"]) {
			const collided = structuredClone(source);
			if (key === "checkpoint") collided[key] = encode(JSON.stringify({ ...JSON.parse(decode(source[key])), [id]: { ignoredBefore: {} } }));
			else collided[key] = encode(decode(source[key]).split("\n").map(line => line.trim() ? JSON.stringify({ ...JSON.parse(line), [id]: null }) : line).join("\n"));
			// Legacy observation still ignores these roots; conversion cannot adopt or discard them.
			assert.ok(parseScopeStream(decode(collided.checkpoint), decode(collided.patches), "session", undefined, decode(collided.meta)));
			assert.throws(() => prepareSerializedScopeMigration(collided, "session", undefined, modules), /external namespace collision/);
		}
	}
});

test("candidate validation rejects malformed semantic replay, unknown versions and mixed dialects without mutating evidence", () => {
	for (const version of [-1, 0, 5, Number.NaN]) assert.throws(() => prepareSemanticMigration(streamFixture(), "session", version), /Unsupported State Flow migration source version/);
	assert.throws(() => prepareSemanticMigration(streamFixture(), "session", 4), /retained modules/);
	const mutations: Array<(stream: ScopeStream) => void> = [
		(stream) => { stream.revision = 0; },
		(stream) => { (stream as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { (stream.checkpoint as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { (stream.patches[0] as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { stream.patches[0]!.transition.parent = "foreign"; },
		(stream) => { stream.checkpoint.state.contract = { invalid: [null] }; },
		(stream) => { (stream.checkpoint.state as JsonObject).contract = false; },
		(stream) => { stream.patches[0]!.patch.working = { job: { steps: { "[0]": null } } }; },
		(stream) => { stream.patches[0]!.patch.strategy = {}; },
		(stream) => { stream.checkpoint.state.tactics = {}; },
	];
	for (const mutate of mutations) {
		const stream = streamFixture();
		mutate(stream);
		const before = structuredClone(stream);
		assert.throws(() => prepareSemanticMigration(stream, "session", 2));
		assert.deepEqual(stream, before);
	}
	const target = prepareSemanticMigration(streamFixture(), "session", 2).stream;
	for (const value of [17, { invalid: [null] }]) {
		const malformed = structuredClone(target);
		(malformed.checkpoint.state as JsonObject).tactics = value;
		assert.throws(() => prepareSemanticMigration(malformed, "session", 3), /semantic state/);
	}
	const retired = structuredClone(target);
	retired.patches[0]!.patch.working = null;
	assert.throws(() => prepareSemanticMigration(retired, "session", 3), /Retired State Flow semantic plane/);
	assert.throws(() => prepareSemanticMigration(streamFixture(), "session", 2, 0), /tail exceeds/);
	for (const malformed of [null, [], { contract: Number.POSITIVE_INFINITY }]) assert.throws(() => translateLegacySemanticObject(malformed));
});

test("serialized candidates preserve complete metadata and detached exact-byte receipts without normalizing authority", () => {
	for (const scope of scopes) {
		const sources = serializedFixture(scope);
		const before = structuredClone(sources);
		const candidate = prepareSerializedScopeMigration(sources, scope, scope === "cwd" ? cwdIdentity : undefined);
		assert.equal(candidate.sourceVersion, 2);
		assert.equal(candidate.targetVersion, 3);
		assert.equal(candidate.requiresConversion, true);
		assert.deepEqual(JSON.parse(candidate.target.meta), { ...JSON.parse(decode(sources.meta)), version: 3 });
		assert.deepEqual(JSON.parse(candidate.target.checkpoint), translateLegacySemanticObject(JSON.parse(decode(sources.checkpoint))));
		assert.deepEqual(JSON.parse(candidate.target.patches), translateLegacySemanticObject(JSON.parse(decode(sources.patches))));
		for (const file of files) {
			assert.deepEqual(candidate.basis[file].bytes, before[file]);
			assert.equal(candidate.basis[file].identity, `sha256:${createHash("sha256").update(before[file]).digest("hex")}`);
			sources[file][0] = sources[file][0]! ^ 1;
			assert.deepEqual(candidate.basis[file].bytes, before[file]);
		}
		candidate.basis.meta.bytes[0] = 0;
		assert.notEqual(sources.meta[0], 0);
		assert.deepEqual(JSON.parse(candidate.target.meta).identity, { id: "opaque-authority", key: "opaque-key" });
	}
});

test("raw serialized conversion rejects target names before a legacy codec can filter the collision away", () => {
	for (const scope of scopes) for (const file of ["checkpoint", "patches"] as const) for (const version of [1, 2]) {
		const sources = serializedFixture(scope, version);
		const targetName = file === "checkpoint" ? "strategy" : "tactics";
		sources[file] = encode(JSON.stringify({ ...JSON.parse(decode(sources[file])), [targetName]: { mustNotDisappear: true } }));
		const cwd = scope === "cwd" ? cwdIdentity : undefined;
		assert.throws(() => parseScopeStream(decode(sources.checkpoint), decode(sources.patches), scope, cwd, decode(sources.meta)), /Target State Flow semantic plane in legacy format/);
		assert.throws(() => prepareSerializedScopeMigration(sources, scope, cwd), /Target State Flow semantic plane in legacy format/);
	}
});

test("serialized revision fallback credits only retained legacy records and empty tails remain present evidence", () => {
	for (const version of [1, 2]) {
		const source = changeMetadata(serializedFixture("session", version), (metadata) => { delete (metadata.temporal as JsonObject).revision; });
		const candidate = prepareSerializedScopeMigration(source, "session");
		assert.equal(candidate.stream.revision, 1);
		assert.equal(JSON.parse(candidate.target.meta).temporal.revision, 1);
		assert.equal(candidate.stream.patches.length, 1);
	}
	const empty = changeMetadata(serializedFixture("session"), (metadata) => {
		(metadata.temporal as JsonObject).patches = [];
		(metadata.temporal as JsonObject).revision = 0;
	});
	empty.patches = new Uint8Array();
	const candidate = prepareSerializedScopeMigration(empty, "session");
	assert.equal(candidate.target.patches, "");
	assert.equal(candidate.stream.revision, 0);
	assert.equal(candidate.stream.patches.length, 0);
});

test("an already-target serialized cohort is byte-idempotent and admitted by native v3 readers", () => {
	for (const scope of scopes) {
		const cwd = scope === "cwd" ? cwdIdentity : undefined;
		const original = prepareSerializedScopeMigration(serializedFixture(scope), scope, cwd);
		const target = {
			checkpoint: encode(` \r\n${original.target.checkpoint}\n`),
			patches: encode(`\uFEFF\r\n ${original.target.patches.replaceAll("\n", "\r\n")} \r\n`),
			meta: encode(` ${JSON.stringify(JSON.parse(original.target.meta), null, 3)}\r\n`),
		};
		const repeated = prepareSerializedScopeMigration(target, scope, cwd);
		assert.equal(repeated.requiresConversion, false);
		assert.deepEqual(repeated.stream, original.stream);
		for (const file of files) assert.deepEqual(encode(repeated.target[file]), target[file]);
		assert.deepEqual(parseScopeStream(repeated.target.checkpoint, repeated.target.patches, scope, cwd, repeated.target.meta), repeated.stream);
		const missingRevision = changeMetadata(target, (metadata) => { delete (metadata.temporal as JsonObject).revision; });
		assert.throws(() => prepareSerializedScopeMigration(missingRevision, scope, cwd), /requires a revision/);
	}
});

test("partial, malformed, unsupported and lossy-encoding inputs cannot produce a serialized candidate", () => {
	const sources = serializedFixture("session");
	for (let mask = 0; mask < 7; mask++) {
		const partial = Object.fromEntries(files.filter((_file, index) => mask & (1 << index)).map((file) => [file, sources[file]]));
		assert.throws(() => prepareSerializedScopeMigration(partial, "session"), /Incomplete State Flow migration cohort/);
	}
	for (const file of files) {
		assert.throws(() => prepareSerializedScopeMigration({ ...sources, [file]: encode("broken") }, "session"), /invalid JSON/);
		assert.throws(() => prepareSerializedScopeMigration({ ...sources, [file]: encode(`\uFEFF${decode(sources[file]).trim()}`) }, "session"), /invalid JSON/);
		const invalidUtf8 = new Uint8Array([...encode('{"trap":"'), 255, ...encode('"}')]);
		assert.throws(() => prepareSerializedScopeMigration({ ...sources, [file]: invalidUtf8 }, "session"), /not valid UTF-8/);
	}
	const invalidMetadata: Array<(metadata: JsonObject) => void> = [
		(metadata) => { delete metadata.version; },
		(metadata) => { metadata.version = 4; },
		(metadata) => { metadata.version = "2"; },
		(metadata) => { delete metadata.temporal; },
		(metadata) => { (metadata.temporal as JsonObject).patches = []; },
		(metadata) => { (metadata.temporal as JsonObject).revision = "1"; },
		(metadata) => { ((metadata.temporal as JsonObject).patches as JsonObject[])[0]!.parent = "foreign"; },
	];
	for (const change of invalidMetadata) assert.throws(() => prepareSerializedScopeMigration(changeMetadata(sources, change), "session"));
	assert.throws(() => prepareSerializedScopeMigration({ ...sources, checkpoint: encode('{"contract":{"overflow":1e999}}') }, "session"), /finite JSON/);
	assert.throws(() => prepareSerializedScopeMigration({ ...sources, patches: encode(`${decode(sources.patches)}\ninvalid`) }, "session"), /tail line 5/);
});

test("serialized preflight binds canonical CWD identity and preserves uninterpretable provenance without granting authority", () => {
	const cwd = serializedFixture("cwd");
	assert.throws(() => prepareSerializedScopeMigration(cwd, "cwd"), /requires its canonical identity/);
	assert.throws(() => prepareSerializedScopeMigration(cwd, "cwd", "/other/project"), /identity mismatch/);
	const invalidOwners: JsonValue[] = [null, {}, { cwd: cwdIdentity, extra: true }, { cwd: `${cwdIdentity}/.` }];
	for (const owner of invalidOwners) {
		const mismatch = changeMetadata(cwd, (metadata) => { metadata.owner = owner; });
		assert.throws(() => prepareSerializedScopeMigration(mismatch, "cwd", cwdIdentity), /identity mismatch/);
	}
	assert.throws(() => prepareSerializedScopeMigration(serializedFixture("global"), "global", cwdIdentity), /Only State Flow CWD/);
	for (const artifacts of [null, [], { "": {} }]) {
		const invalid = changeMetadata(cwd, (metadata) => { metadata.artifacts = artifacts; });
		assert.throws(() => prepareSerializedScopeMigration(invalid, "cwd", cwdIdentity), /provenance/);
	}
	const candidate = prepareSerializedScopeMigration(cwd, "cwd", cwdIdentity);
	assert.deepEqual(JSON.parse(candidate.target.meta).artifacts["/uninterpretable/source"], { futureEvidence: [null, "do not normalize"] });
	assert.equal(JSON.parse(candidate.target.meta).specification, "$session.contract.requirement");
});
