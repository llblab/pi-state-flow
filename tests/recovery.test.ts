import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { sessionRuntimePaths, temporalScopePaths } from "../lib/durable.ts";
import { writeGlobalState, writeCwdState, writeSessionState } from "./legacy-fixture.ts";
import { emptyState } from "../lib/state.ts";
import { recoverSnapshot } from "../lib/recovery.ts";
import { RevisionUnavailableError } from "../lib/snapshot.ts";
import { commitTerminal, harness, start, toolAssistant, user } from "./harness.ts";

test("malformed pointer syntax falls back instead of silently selecting ordinary mode", () => {
	const previous = { config: { enabled: true }, meta: { step: 7 } };
	for (const candidate of [undefined, {}, { revision: "HEAD" }, { revision: "a".repeat(41) }, { disabled: false }, { revision: "a".repeat(40), meta: {} },
		{ config: null }, { config: [] }, { config: { enabled: "true" } }, { enabled: null },
		{ config: { enabled: true }, meta: null }, { enabled: true, durableBase: "HEAD" },
		{ config: { enabled: true }, meta: { durableBase: "a".repeat(41) } }]) {
		const recovered = recoverSnapshot([candidate, previous]);
		assert.equal(recovered.skipped.length, 1);
		assert.deepEqual(recovered.snapshot, previous);
	}
});

test("well-shaped pointers with missing or invalid immutable runtime data fall back on the selected branch", async () => {
	const h = harness();
	await start(h, "Selected specification");
	await commitTerminal(h, {}, { selected: "valid" }, "Valid");
	const validBranch = structuredClone(h.entries);
	const paths = sessionRuntimePaths(h.ctx.cwd, "harness-session", h.repositoryRoot);
	const pair = temporalScopePaths(h.ctx.cwd, "harness-session", "session", h.repositoryRoot);
	const originals = new Map([paths.config, paths.meta, pair.checkpoint, pair.patches].map((path) => [path, readFileSync(path)]));
	const git = (...args: string[]) => execFileSync("git", ["-C", h.repositoryRoot, ...args], { encoding: "utf8" }).trim();
	const meta = JSON.parse(originals.get(paths.meta)!.toString());
	const corruptions = [
		() => { rmSync(paths.config); rmSync(paths.meta); },
		() => rmSync(paths.config),
		() => writeFileSync(paths.config, '{"enabled":true,"unexpected":true}'),
		() => writeFileSync(paths.meta, JSON.stringify({ ...meta, identity: { ...meta.identity, sessionId: "other" } })),
		() => writeFileSync(paths.meta, JSON.stringify({ ...meta, version: 2 })),
		() => writeFileSync(paths.meta, JSON.stringify({ ...meta, lineage: [] })),
		() => writeFileSync(pair.patches, "not a replay record\n"),
		() => rmSync(pair.checkpoint),
	];
	for (const corrupt of corruptions) {
		for (const [path, bytes] of originals) writeFileSync(path, bytes);
		corrupt();
		git("add", "-A", "--", pair.directory);
		git("commit", "-m", "invalid immutable pointer target fixture");
		const head = git("rev-parse", "HEAD");
		for (const pointer of [{ revision: head }, { config: { enabled: true }, meta: { step: 999, durableBase: head } }]) {
			h.entries.splice(0, h.entries.length, ...structuredClone(validBranch), { type: "custom", customType: "state-flow-snapshot", data: pointer });
			h.handlers.get("session_tree")!({}, h.ctx);
			assert.equal(h.activeTools.includes("patch_state"), true);
			assert.equal(h.readState().working.selected, "valid");
			assert.match(h.notifications.at(-1)!, /previous valid snapshot/);
			assert.equal(git("rev-parse", "HEAD"), head);
			assert.deepEqual(h.entries.at(-1)!.data, pointer, "raw malformed target evidence remains untouched");
		}
	}
	for (const [path, bytes] of originals) writeFileSync(path, bytes);
	for (const data of [{ revision: "f".repeat(40) }, { config: { enabled: true }, meta: { durableBase: "f".repeat(40) } }]) {
		h.entries.splice(0, h.entries.length, ...validBranch, { type: "custom", customType: "state-flow-snapshot", data });
		h.handlers.get("session_tree")!({}, h.ctx);
		assert.equal(h.readState().working.selected, "valid");
		assert.match(h.notifications.at(-1)!, /previous valid snapshot/);
	}
});

test("a bare pointer to legacy Git snapshots cannot manufacture runtime config or trigger migration", async () => {
	const h = harness();
	writeGlobalState(emptyState(), h.repositoryRoot);
	writeCwdState(h.ctx.cwd, emptyState(), h.repositoryRoot);
	writeSessionState(h.ctx.cwd, "harness-session", { ...emptyState(), working: { legacy: true } }, h.repositoryRoot);
	const git = (...args: string[]) => execFileSync("git", ["-C", h.repositoryRoot, ...args], { encoding: "utf8" }).trim();
	git("add", ".");
	git("commit", "-m", "legacy-only fixture");
	const legacy = git("rev-parse", "HEAD");
	h.entries.push({ type: "custom", customType: "state-flow-snapshot", data: { revision: legacy } });
	h.handlers.get("session_start")!({ reason: "resume" }, h.ctx);
	assert.equal(h.activeTools.includes("patch_state"), false);
	assert.throws(() => h.readState(), /unavailable/);
	assert.equal(git("rev-parse", "HEAD"), legacy);
	assert.match(h.notifications.at(-1)!, /legacy storage requires explicit migration/);
});

test("valid pointer recovery never mistakes durable disabled retry metadata for a migration failure", () => {
	const snapshot = { config: { enabled: false }, meta: {
		step: 7, durableBase: "a".repeat(40), validation: { attempt: 0, error: "retained", instruction: "retry" },
	} };
	const recovered = recoverSnapshot([{ revision: "a".repeat(40) }], () => snapshot);
	assert.deepEqual(recovered, { snapshot, skipped: [] });
});

test("unavailable capabilities or retained file cohorts preserve selection instead of falling back to disabled", () => {
	for (const revision of ["a".repeat(40), `file:${"b".repeat(64)}`]) {
		for (const pointer of [{ revision }, { config: { enabled: true }, meta: { durableBase: revision } }]) {
			const recovered = recoverSnapshot([pointer, { disabled: true }], () => { throw new RevisionUnavailableError("temporarily unavailable"); });
			assert.equal(recovered.snapshot.meta.durableBase, revision);
			assert.equal(recovered.snapshot.config.enabled, false);
			assert.equal(recovered.disabledMarker, undefined);
			assert.deepEqual(recovered.skipped, []);
		}
	}
});

test("restores the newest valid snapshot", () => {
	const latest = {
		enabled: true,
		state: { contract: { version: "latest" }, working: {}, response: "Done" },
		step: 2,
	};
	const result = recoverSnapshot([latest]);
	assert.equal(result.snapshot.legacySession!.state.contract.version, "latest");
	assert.deepEqual(result.skipped, []);
});

test("falls back past malformed newer snapshots without resetting the episode", () => {
	const malformed = {
		enabled: true,
		state: { contract: {}, working: { invalid: Number.NaN }, response: "bad" },
		step: 3,
	};
	const previous = {
		enabled: true,
		state: { contract: { durable: true }, working: { next: "continue" }, response: "Good" },
		step: 2,
	};
	const result = recoverSnapshot([malformed, previous]);
	assert.equal(result.snapshot.config.enabled, true);
	assert.equal(result.snapshot.meta.step, 2);
	assert.deepEqual(result.snapshot.legacySession!.state, { artifacts: {}, ...previous.state });
	assert.deepEqual(result.skipped, ["Restored state contains non-JSON data"]);
});

test("fails closed only when no valid snapshot remains", () => {
	const result = recoverSnapshot([{ enabled: true, state: { contract: {}, working: {}, response: 7 } }]);
	assert.equal(result.snapshot.config.enabled, false);
	assert.equal(result.skipped.length, 1);
	assert.match(result.snapshot.meta.validation?.error ?? "", /invalid materialized-state schema|Legacy state/);
});

test("recovers an older valid active-branch snapshot when the newest is malformed", async () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: { durable: true }, working: { next: "continue" }, response: "Good" },
			step: 2,
		},
	}, {
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: {}, working: { invalid: Number.NaN }, response: "Bad" },
			step: 3,
		},
	});
	h.handlers.get("session_start")!({}, h.ctx);
	assert.match(h.notifications.at(-1)!, /recovered the previous valid snapshot/);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
	await h.commands.get("state-flow-status")!.handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /"durable": true/);
	assert.doesNotMatch(h.notifications.at(-1)!, /"invalid"/);
});
test("recovers through a hostile newer branch entry", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: "state-flow-snapshot",
		data: {
			enabled: true,
			state: { contract: { durable: true }, working: {}, response: "Good" },
			step: 2,
		},
	}, Object.defineProperty({}, "type", {
		get() { throw new Error("hostile newer entry"); },
	}));
	assert.doesNotThrow(() => h.handlers.get("session_start")!({}, h.ctx));
	assert.match(h.notifications.at(-1)!, /recovered the previous valid snapshot/);
	assert.equal(h.statuses.at(-1), "<accent>state-flow</accent> <dim>#2</dim>");
});
test("fails closed when malformed snapshot objects are cyclic or throw during inspection", () => {
	for (const state of [
		(() => {
			const cyclic: any = { contract: {}, working: {}, response: "Previous" };
			cyclic.working.self = cyclic;
			return cyclic;
		})(),
		Object.defineProperty({}, "contract", {
			enumerable: true,
			get() { throw new Error("hostile getter"); },
		}),
	]) {
		const h = harness();
		h.entries.push({
			type: "custom",
			customType: "state-flow-snapshot",
			data: { enabled: true, state, step: 1 },
		});
		assert.doesNotThrow(() => h.handlers.get("session_start")!({}, h.ctx));
		assert.match(h.notifications.at(-1)!, /State Flow restored disabled/);
		assert.equal(h.statuses.at(-1), undefined);
	}

	const hostileBranch = harness();
	hostileBranch.entries.push(Object.defineProperty({}, "type", {
		enumerable: true,
		get() { throw new Error("hostile branch entry"); },
	}));
	assert.doesNotThrow(() => hostileBranch.handlers.get("session_start")!({}, hostileBranch.ctx));
	assert.match(hostileBranch.notifications.at(-1)!, /Snapshot restoration failed: hostile branch entry/);
});
