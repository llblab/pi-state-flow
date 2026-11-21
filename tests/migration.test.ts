import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseScopeStream } from "../lib/durable.ts";
import { type JsonObject, type JsonValue } from "../lib/json.ts";
import { prepareSemanticMigration, prepareSerializedScopeMigration, RetiredSemanticFormatError, type ScopeMigrationFile } from "../lib/migration.ts";
import { assertNoRetiredSemanticPlanes, type StateScope } from "../lib/state.ts";
import type { ScopeStream, TransitionBoundary } from "../lib/temporal.ts";

const scopes: StateScope[] = ["global", "cwd", "session"];
const origin: TransitionBoundary = { id: "origin", position: 0, parent: null };
const files: ScopeMigrationFile[] = ["checkpoint", "patches", "meta"];
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cwdIdentity = "/migration/project";
type SourceBytes = Record<ScopeMigrationFile, Uint8Array>;

function serializedFixture(scope: StateScope, version = 3, stream = streamFixture()): SourceBytes {
	const metadata = {
		version, artifacts: {
			"/registered/source": { sourceHash: `sha256:${"a".repeat(64)}`, sourceFingerprint: { size: 17, mtimeNs: "42" }, compilerRevision: "v1", compiledAt: 12 },
			"/uninterpretable/source": { futureEvidence: [null, "do not normalize"] },
		},
		...(scope === "cwd" ? { owner: { cwd: cwdIdentity } } : {}),
		temporal: { revision: stream.revision, checkpoint: stream.checkpoint.through, patches: stream.patches.map((record) => record.transition), extra: { preserve: true } },
		identity: { id: "opaque-authority", key: "opaque-key" }, lineage: [origin, stream.patches[0]!.transition],
		specification: "$session.strategy.requirement", bootstrap: true, foreign: { marker: "$session.tactics.job", empty: null },
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

function streamFixture(): ScopeStream {
	return {
		revision: 1,
		checkpoint: { through: structuredClone(origin), state: {
			strategy: { requirement: "offline", nested: { tactics: "ordinary key" }, empty: {} },
			tactics: { job: { steps: [{ next: "inspect", ref: { $ref: "session.tactics.job" } }] } },
			intents: { job: { context: { $ref: "session.tactics.job" } } },
		} },
		patches: [{ transition: { id: "T1", position: 1, parent: origin.id }, patch: {
			tactics: { job: { steps: { "[0]": { next: "validate" } } } }, strategy: { rejected: "online-only" },
		} }],
	};
}

/** Pre-1.0.0 dialect, kept only to prove explicit refusal. */
function retiredStreamFixture(): ScopeStream {
	return {
		revision: 1,
		checkpoint: { through: structuredClone(origin), state: { contract: { requirement: "offline" }, working: { job: {} } } },
		patches: [{ transition: { id: "T1", position: 1, parent: origin.id }, patch: { working: { job: { next: "validate" } } } }],
	};
}

test("retired contract/working cohorts are refused explicitly and are never converted", () => {
	for (const version of [1, 2]) {
		for (const scope of scopes) {
			assert.throws(() => prepareSemanticMigration(retiredStreamFixture(), scope, version), RetiredSemanticFormatError);
			const sources = serializedFixture(scope, version, retiredStreamFixture());
			const cwd = scope === "cwd" ? cwdIdentity : undefined;
			assert.throws(() => prepareSerializedScopeMigration(sources, scope, cwd), /no longer converted since State Flow 1\.0\.0; open it once with State Flow 0\.x/);
			assert.throws(() => parseScopeStream(decode(sources.checkpoint), decode(sources.patches), scope, cwd, decode(sources.meta)), RetiredSemanticFormatError);
		}
	}
});

test("retired roots stay reserved in target documents", () => {
	for (const plane of ["contract", "working"]) {
		for (const value of [{}, null]) assert.throws(() => assertNoRetiredSemanticPlanes({ [plane]: value }), /Retired State Flow semantic plane/);
	}
	assert.doesNotThrow(() => assertNoRetiredSemanticPlanes({ tactics: { contract: {}, working: {} } }));
});

test("scope candidates are versioned, detached, idempotent and preserve independent revisions and causal identities", () => {
	for (const scope of scopes) {
		const source = streamFixture();
		const before = structuredClone(source);
		const candidate = prepareSemanticMigration(source, scope, 3);
		assert.equal(candidate.sourceVersion, 3);
		assert.equal(candidate.targetVersion, 3);
		assert.equal(candidate.requiresConversion, false);
		assert.deepEqual(candidate.stream, source);
		assert.notEqual(candidate.stream, source);
		((candidate.stream.checkpoint.state.strategy as JsonObject).nested as JsonObject).tactics = "mutated";
		candidate.stream.patches[0]!.transition.id = "mutated";
		assert.deepEqual(source, before);
	}
});

test("explicit metadata4 conversion retains identities and rejects raw external collisions before filtering", () => {
	const modules = { x_acme_archive: { schemaVersion: 1, immutable: true } };
	const source = serializedFixture("session");
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
		// v3 observation still ignores these roots; conversion cannot adopt or discard them.
		assert.ok(parseScopeStream(decode(collided.checkpoint), decode(collided.patches), "session", undefined, decode(collided.meta)));
		assert.throws(() => prepareSerializedScopeMigration(collided, "session", undefined, modules), /external namespace collision/);
	}
});

test("candidate validation rejects malformed semantic replay, unknown versions and retired roots without mutating evidence", () => {
	for (const version of [-1, 0, 5, Number.NaN]) assert.throws(() => prepareSemanticMigration(streamFixture(), "session", version), /Unsupported State Flow migration source version/);
	assert.throws(() => prepareSemanticMigration(streamFixture(), "session", 4), /retained modules/);
	const mutations: Array<(stream: ScopeStream) => void> = [
		(stream) => { stream.revision = 0; },
		(stream) => { (stream as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { (stream.checkpoint as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { (stream.patches[0] as unknown as JsonObject).foreignEnvelope = true; },
		(stream) => { stream.patches[0]!.transition.parent = "foreign"; },
		(stream) => { (stream.checkpoint.state as JsonObject).tactics = 17; },
		(stream) => { stream.checkpoint.state.tactics = { invalid: [null] }; },
		(stream) => { stream.patches[0]!.patch.working = null; },
		(stream) => { stream.checkpoint.state.contract = {}; },
	];
	for (const mutate of mutations) {
		const stream = streamFixture();
		mutate(stream);
		const before = structuredClone(stream);
		assert.throws(() => prepareSemanticMigration(stream, "session", 3));
		assert.deepEqual(stream, before);
	}
	assert.throws(() => prepareSemanticMigration(streamFixture(), "session", 3, 0), /tail exceeds/);
});

test("serialized candidates preserve complete metadata and detached exact-byte receipts without normalizing authority", () => {
	for (const scope of scopes) {
		const sources = serializedFixture(scope);
		const before = structuredClone(sources);
		const candidate = prepareSerializedScopeMigration(sources, scope, scope === "cwd" ? cwdIdentity : undefined);
		assert.equal(candidate.sourceVersion, 3);
		assert.equal(candidate.requiresConversion, false);
		for (const file of files) assert.equal(candidate.target[file], decode(before[file]));
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

test("empty tails remain present evidence", () => {
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
		(metadata) => { metadata.version = "3"; },
		(metadata) => { delete metadata.temporal; },
		(metadata) => { (metadata.temporal as JsonObject).patches = []; },
		(metadata) => { (metadata.temporal as JsonObject).revision = "1"; },
		(metadata) => { ((metadata.temporal as JsonObject).patches as JsonObject[])[0]!.parent = "foreign"; },
	];
	for (const change of invalidMetadata) assert.throws(() => prepareSerializedScopeMigration(changeMetadata(sources, change), "session"));
	assert.throws(() => prepareSerializedScopeMigration({ ...sources, checkpoint: encode('{"strategy":{"overflow":1e999}}') }, "session"), /finite JSON/);
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
	assert.equal(JSON.parse(candidate.target.meta).specification, "$session.strategy.requirement");
});
