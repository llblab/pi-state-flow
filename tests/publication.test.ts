import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquirePublicationWorkerLease,
	beginPublicationAttempt,
	coalescePublicationTarget,
	confirmPublicationTarget,
	createPublicationQueue,
	failPublicationAttempt,
	loadPublicationQueue,
	parsePublicationQueue,
	parseRemotePublicationPolicyDocument,
	recoverPublicationQueue,
	remotePublicationDestinationKey,
	resolveRemotePublicationPolicy,
	runPublicationWorker,
	savePublicationQueue,
	serializePublicationQueue,
	serializeRemotePublicationPolicyDocument,
	validatePublicationQueue,
} from "../lib/publication.ts";

test("uses responsive turn-end policy for new runtimes and preserves legacy transition behavior", () => {
	assert.deepEqual(resolveRemotePublicationPolicy(undefined, { legacyRuntime: false }), {
		mode: "turn-end", migratedLegacyDefault: false,
	});
	assert.deepEqual(resolveRemotePublicationPolicy(undefined, { legacyRuntime: true }), {
		mode: "transition", migratedLegacyDefault: true,
	});
});

test("accepts explicit off, turn-end, and compatibility transition modes", () => {
	for (const mode of ["off", "turn-end", "transition"] as const) {
		assert.deepEqual(resolveRemotePublicationPolicy(mode, { legacyRuntime: false }), {
			mode, migratedLegacyDefault: false,
		});
	}
	assert.throws(() => resolveRemotePublicationPolicy("async", { legacyRuntime: false }), /off, turn-end, or transition/);
});

test("round-trips strict persisted policy documents and migrates absence by runtime age", () => {
	for (const mode of ["off", "turn-end", "transition"] as const) {
		const policy = resolveRemotePublicationPolicy(mode, { legacyRuntime: false });
		assert.deepEqual(parseRemotePublicationPolicyDocument(
			serializeRemotePublicationPolicyDocument(policy), { legacyRuntime: true },
		), policy);
	}
	assert.deepEqual(parseRemotePublicationPolicyDocument(undefined, { legacyRuntime: true }), {
		mode: "transition", migratedLegacyDefault: true,
	});
	for (const invalid of [null, [], {}, { version: 2, mode: "off" }, { version: 1, mode: "off", extra: true }]) {
		assert.throws(() => parseRemotePublicationPolicyDocument(invalid, { legacyRuntime: false }), /Invalid remote publication policy/);
	}
});

test("keys remote work by canonical common directory, remote, and ref", () => {
	assert.equal(
		remotePublicationDestinationKey({ gitCommonDir: "/repo/worktree/../.git", remote: "origin", ref: "refs/heads/main" }),
		JSON.stringify(["/repo/.git", "origin", "refs/heads/main"]),
	);
	assert.notEqual(
		remotePublicationDestinationKey({ gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" }),
		remotePublicationDestinationKey({ gitCommonDir: "/repo/.git", remote: "backup", ref: "refs/heads/main" }),
	);
	assert.throws(() => remotePublicationDestinationKey({ gitCommonDir: "/repo/.git", remote: " ", ref: "main" }), /non-empty/);
});

const destination = { gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" };
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
const ancestry = new Set([`${a}:${b}`, `${a}:${c}`, `${b}:${c}`]);
const isAncestor = (x: string, y: string) => ancestry.has(`${x}:${y}`);

test("coalesces only same-destination descendants and preserves newest targets", () => {
	const first = createPublicationQueue(destination, a);
	const second = coalescePublicationTarget(first, destination, b, isAncestor);
	assert.equal(second.target, b);
	assert.equal(coalescePublicationTarget(second, destination, a, isAncestor).target, b);
	assert.equal(coalescePublicationTarget(second, destination, b, isAncestor).target, b);
	assert.throws(() => coalescePublicationTarget(second, { ...destination, remote: "backup" }, c, isAncestor), /destination changed/);
});

test("retargets a rewritten journal lineage instead of wedging publication", () => {
	const confirmed = confirmPublicationTarget(
		coalescePublicationTarget(beginPublicationAttempt(createPublicationQueue(destination, a)), destination, b, isAncestor),
		a, isAncestor,
	)!;
	assert.equal(confirmed.confirmed, a);
	const selfHeals: string[] = [];
	const healed = coalescePublicationTarget(confirmed, destination, "d".repeat(40), isAncestor, {
		onDivergedLineage: (previous) => selfHeals.push(previous.target),
	});
	assert.deepEqual(selfHeals, [b]);
	assert.deepEqual(healed, { version: 1, destination: structuredClone(destination), target: "d".repeat(40), status: "pending", attempt: 0 });
});

test("recovers interrupted attempts and confirms only exact covered targets", () => {
	const first = createPublicationQueue(destination, a);
	const pushing = beginPublicationAttempt(first);
	assert.equal(pushing.status, "pushing");
	assert.equal(pushing.attempt, 1);
	assert.deepEqual(recoverPublicationQueue(pushing), {
		...pushing, status: "pending", error: "previous publication attempt ended without confirmation",
	});
	const failed = failPublicationAttempt(pushing, " remote unavailable ");
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "remote unavailable");
	assert.equal(confirmPublicationTarget(pushing, a, isAncestor), undefined);
	const newer = coalescePublicationTarget(pushing, destination, b, isAncestor);
	assert.deepEqual(confirmPublicationTarget(newer, a, isAncestor), {
		...newer, confirmed: a, status: "pending", error: undefined,
	});
	assert.throws(() => confirmPublicationTarget(newer, "d".repeat(40), isAncestor), /does not cover/);
});

test("strict queue documents reject corrupt targets, counters, and unknown fields", () => {
	const valid = createPublicationQueue(destination, a);
	assert.doesNotThrow(() => validatePublicationQueue(valid));
	assert.deepEqual(parsePublicationQueue(serializePublicationQueue(valid)), valid);
	assert.throws(() => parsePublicationQueue("{broken"), /Invalid publication queue JSON/);
	for (const invalid of [{ ...valid, target: "HEAD" }, { ...valid, attempt: -1 }, { ...valid, status: "done" }, { ...valid, extra: true }]) {
		assert.throws(() => validatePublicationQueue(invalid), /Invalid publication queue/);
	}
});

test("atomically persists and reloads a restart-safe queue document", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-queue-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "nested", "queue.json");
	const state = createPublicationQueue({ gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" }, "a".repeat(40));
	assert.equal(loadPublicationQueue(path), undefined);
	savePublicationQueue(path, state);
	assert.deepEqual(loadPublicationQueue(path), state);
	assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
});

test("leases one cross-process worker and recovers only proven dead owners", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-worker-lease-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const queue = join(root, "queue.json");
	const first = acquirePublicationWorkerLease(queue)!;
	assert.ok(first);
	assert.equal(acquirePublicationWorkerLease(queue), undefined);
	first.release();
	const second = acquirePublicationWorkerLease(queue)!;
	second.release();
	writeFileSync(`${queue}.worker.lock`, JSON.stringify({ version: 1, pid: 2147483647, token: "dead" }));
	const recovered = acquirePublicationWorkerLease(queue)!;
	assert.ok(recovered);
	recovered.release();
	writeFileSync(`${queue}.worker.lock`, "{broken");
	assert.throws(() => acquirePublicationWorkerLease(queue), /malformed/);
	assert.equal(readFileSync(`${queue}.worker.lock`, "utf8"), "{broken");
});

test("serializes writers and rejects stale compare-and-swap receipts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-queue-cas-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "queue.json");
	const destination = { gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" };
	const first = createPublicationQueue(destination, "a".repeat(40));
	const second = createPublicationQueue(destination, "b".repeat(40));
	const receipt = savePublicationQueue(path, first);
	assert.deepEqual(receipt.current, first);
	assert.throws(() => savePublicationQueue(path, second), /requires the current receipt/);
	const updated = savePublicationQueue(path, second, first);
	assert.deepEqual(updated.previous, first);
	assert.deepEqual(loadPublicationQueue(path), second);
	assert.throws(() => savePublicationQueue(path, first, first), /compare-and-swap conflict/);
	writeFileSync(`${path}.lock`, "held");
	assert.throws(() => savePublicationQueue(path, first, second), /EEXIST/);
	assert.deepEqual(loadPublicationQueue(path), second);
});

test("rejects symlink ancestors without creating queue files outside the owned path", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-queue-ancestor-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const outside = join(root, "outside");
	const linked = join(root, "linked");
	mkdirSync(outside);
	symlinkSync(outside, linked, "dir");
	const state = createPublicationQueue({ gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" }, "a".repeat(40));
	assert.throws(() => savePublicationQueue(join(linked, "queue.json"), state), /symlink ancestors/);
	assert.equal(existsSync(join(outside, "queue.json")), false);
});

test("rejects symlink queue targets without modifying their destination", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-queue-link-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const destination = join(root, "outside");
	const path = join(root, "queue.json");
	writeFileSync(destination, "untouched");
	symlinkSync(destination, path);
	const state = createPublicationQueue({ gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" }, "a".repeat(40));
	assert.throws(() => savePublicationQueue(path, state), /regular file/);
	assert.equal(readFileSync(destination, "utf8"), "untouched");
});

const workerDestination = { gitCommonDir: "/repo/.git", remote: "origin", ref: "refs/heads/main" };
const workerA = "a".repeat(40), workerB = "b".repeat(40);
const ancestor = (x: string, y: string) => x === workerA && y === workerB;

test("worker starts asynchronously and confirms only after push completion", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	let started = false;
	const run = runPublicationWorker(createPublicationQueue(workerDestination, workerA), async (target) => {
		started = true;
		assert.equal(Object.isFrozen(target), true);
		await blocked;
	}, () => createPublicationQueue(workerDestination, workerA), ancestor);
	await Promise.resolve();
	assert.equal(started, true);
	let settled = false;
	void run.then(() => { settled = true; });
	await Promise.resolve();
	assert.equal(settled, false);
	release();
	assert.deepEqual(await run, { attempted: { ...createPublicationQueue(workerDestination, workerA), status: "pushing", attempt: 1 } });
});

test("successful older push preserves a newer descendant and failures remain retryable", async () => {
	const initial = createPublicationQueue(workerDestination, workerA);
	const newer = coalescePublicationTarget(initial, workerDestination, workerB, ancestor);
	const success = await runPublicationWorker(initial, async () => {}, () => newer, ancestor);
	assert.deepEqual(success.next, { ...newer, confirmed: workerA, status: "pending", error: undefined });
	const failed = await runPublicationWorker(initial, async () => { throw new Error("offline"); }, () => initial, ancestor);
	assert.equal(failed.next?.status, "failed");
	assert.equal(failed.next?.error, "offline");
	assert.equal(failed.next?.target, workerA);
});
