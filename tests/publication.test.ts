import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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

test("queue commit boundaries reject non-string values without coercion or side effects", async (t) => {
	const valid = createPublicationQueue(destination, a);
	const root = mkdtempSync(join(tmpdir(), "state-flow-queue-types-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "queue.json");
	for (const value of [[a], [[a]], { toString: () => a }]) {
		let ancestryCalls = 0;
		const unusedAncestry = () => { ancestryCalls += 1; return true; };
		assert.throws(() => createPublicationQueue(destination, value as any), /exact commit/);
		assert.throws(() => coalescePublicationTarget(valid, destination, value as any, unusedAncestry), /exact commit/);
		assert.throws(() => confirmPublicationTarget(valid, value as any, unusedAncestry), /exact commit/);
		assert.equal(ancestryCalls, 0);
		for (const field of ["target", "confirmed"] as const) {
			const invalid = { ...valid, [field]: value };
			assert.throws(() => validatePublicationQueue(invalid), /Invalid publication queue/);
			assert.throws(() => parsePublicationQueue(JSON.stringify(invalid)), /Invalid publication queue/);
			assert.throws(() => serializePublicationQueue(invalid as any), /Invalid publication queue/);
			writeFileSync(path, JSON.stringify(invalid));
			const bytes = readFileSync(path);
			assert.throws(() => loadPublicationQueue(path), /Invalid publication queue/);
			assert.throws(() => savePublicationQueue(path, valid), /Invalid publication queue/);
			let pushes = 0;
			await assert.rejects(runPublicationWorker(invalid as any, async () => { pushes += 1; }, () => valid, unusedAncestry), /Invalid publication queue/);
			assert.equal(pushes, 0);
			assert.deepEqual(readFileSync(path), bytes);
		}
	}
	assert.deepEqual(parsePublicationQueue(serializePublicationQueue({ ...valid, confirmed: b })), { ...valid, confirmed: b });
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

test("worker leases protect live and malformed owners while recovering a valid dead owner", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-worker-lease-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const queue = join(root, "queue.json");
	const first = acquirePublicationWorkerLease(queue)!;
	assert.ok(first);
	assert.equal(acquirePublicationWorkerLease(queue), undefined);
	const dead = { ...JSON.parse(readFileSync(first.path, "utf8")), pid: 2147483647 };
	first.release();
	const second = acquirePublicationWorkerLease(queue)!;
	first.release();
	assert.equal(JSON.parse(readFileSync(second.path, "utf8")).token, second.token);
	second.release();
	writeFileSync(`${queue}.worker.lock`, JSON.stringify(dead));
	const recovered = acquirePublicationWorkerLease(queue)!;
	assert.ok(recovered);
	recovered.release();
	for (const content of [
		"{broken", JSON.stringify({ pid: dead.pid }), JSON.stringify({ ...dead, version: 2 }),
		JSON.stringify({ ...dead, token: "" }), JSON.stringify({ ...dead, startedAt: "invalid" }),
		JSON.stringify({ ...dead, extra: true }), JSON.stringify({ ...dead, pid: 2147483648 }),
	]) {
		writeFileSync(`${queue}.worker.lock`, content);
		assert.throws(() => acquirePublicationWorkerLease(queue), /malformed/);
		assert.equal(readFileSync(`${queue}.worker.lock`, "utf8"), content);
	}
});

test("two processes cannot both reclaim the same dead worker lease", { timeout: 20_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lease-race-"));
	const queue = join(root, "queue.json");
	const workers: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }> = [];
	t.after(async () => {
		for (const { child } of workers) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			child.stdin.destroy();
		}
		await Promise.all(workers.map(({ closed }) => closed));
		rmSync(root, { recursive: true, force: true });
	});
	function startWorker(mode: "seed" | "claim", owner = 0, pauseAt = "dead") {
		const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./publication-worker.ts", import.meta.url)), queue, mode, String(owner), pauseAt], { stdio: "pipe" });
		let stderr = "";
		child.stderr.on("data", (data) => { stderr += data.toString(); });
		child.on("error", (error) => { stderr += error.message; });
		const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
		workers.push({ child, closed });
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		return {
			child, closed,
			async next() {
				const line = await lines.next();
				assert.equal(line.done, false, `Lease fixture exited before its next event: ${stderr}`);
				return JSON.parse(line.value!);
			},
			proceed() { child.stdin.write("c"); },
		};
	}
	const seedWorker = startWorker("seed");
	const seed = await seedWorker.next();
	assert.equal(seed.granted, true);
	assert.equal(await seedWorker.closed, 0);
	const first = startWorker("claim", seed.pid);
	assert.deepEqual(await first.next(), { event: "observed-dead", pid: first.child.pid, owner: seed.pid });
	const second = startWorker("claim", seed.pid);
	let contender = await second.next();
	assert.ok(contender.event === "observed-dead" || contender.event === "result");
	first.proceed();
	const granted = await first.next();
	assert.equal(granted.granted, true);
	assert.equal(JSON.parse(readFileSync(`${queue}.worker.lock`, "utf8")).token, granted.token);
	if (contender.event === "observed-dead") {
		assert.equal(contender.owner, seed.pid);
		second.proceed();
		contender = await second.next();
	}
	assert.equal(contender.granted, false, `Both contenders received a lease: ${JSON.stringify({ first: granted, second: contender })}`);
	assert.equal(JSON.parse(readFileSync(`${queue}.worker.lock`, "utf8")).token, granted.token);
	assert.equal(await second.closed, 0);
	const liveContender = startWorker("claim", seed.pid);
	assert.equal((await liveContender.next()).granted, false, "a live foreign PID remains protected after the claim gate is released");
	assert.equal(await liveContender.closed, 0);
	first.proceed();
	assert.equal((await first.next()).event, "released");
	assert.equal(await first.closed, 0);
	assert.equal(existsSync(`${queue}.worker.lock`), false);
	// Exclusive creation may legitimately win after dead-record removal, even while its gate is held.
	const nextSeedWorker = startWorker("seed");
	const nextSeed = await nextSeedWorker.next();
	assert.equal(await nextSeedWorker.closed, 0);
	const reclaiming = startWorker("claim", nextSeed.pid, "removed");
	assert.equal((await reclaiming.next()).event, "removed");
	const fresh = startWorker("claim", nextSeed.pid);
	const freshResult = await fresh.next();
	assert.equal(freshResult.granted, true);
	reclaiming.proceed();
	assert.equal((await reclaiming.next()).granted, false);
	assert.equal(await reclaiming.closed, 0);
	assert.equal(JSON.parse(readFileSync(`${queue}.worker.lock`, "utf8")).token, freshResult.token);
	fresh.proceed();
	assert.equal((await fresh.next()).event, "released");
	assert.equal(await fresh.closed, 0);
	assert.equal(existsSync(`${queue}.worker.lock`), false);
	assert.equal(existsSync(`${queue}.lock`), false);
});

test("dead lease reclamation respects the queue writer gate without blocking fresh claims or release", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lease-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const queue = join(root, "queue.json");
	const lease = acquirePublicationWorkerLease(queue)!;
	const dead = JSON.stringify({ ...JSON.parse(readFileSync(lease.path, "utf8")), pid: 2147483647 });
	assert.equal(existsSync(`${queue}.lock`), false, "the claim gate is not held during the push lifetime");
	writeFileSync(`${queue}.lock`, "occupied");
	lease.release();
	assert.equal(existsSync(lease.path), false);
	const fresh = acquirePublicationWorkerLease(queue)!;
	assert.ok(fresh, "exclusive creation already protects a fresh claim");
	fresh.release();
	writeFileSync(lease.path, dead);
	assert.equal(acquirePublicationWorkerLease(queue), undefined);
	assert.equal(readFileSync(lease.path, "utf8"), dead);
	assert.equal(readFileSync(`${queue}.lock`, "utf8"), "occupied");
	rmSync(`${queue}.lock`);
	acquirePublicationWorkerLease(queue)!.release();
});

test("lease acquisition and release preserve symlinks and foreign replacements", (t) => {
	const root = mkdtempSync(join(tmpdir(), "state-flow-lease-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const queue = join(root, "queue.json");
	const lease = acquirePublicationWorkerLease(queue)!;
	const original = readFileSync(lease.path, "utf8");
	const outside = join(root, "outside.json");
	lease.release();
	writeFileSync(outside, JSON.stringify({ ...JSON.parse(original), pid: 2147483647 }));
	symlinkSync(outside, lease.path);
	assert.throws(() => acquirePublicationWorkerLease(queue), /regular file/);
	assert.equal(lstatSync(lease.path).isSymbolicLink(), true);
	writeFileSync(outside, original);
	lease.release();
	assert.equal(lstatSync(lease.path).isSymbolicLink(), true);
	assert.equal(readFileSync(outside, "utf8"), original);
	rmSync(lease.path);
	const replacement = JSON.stringify({ ...JSON.parse(original), pid: 2147483647 });
	writeFileSync(lease.path, replacement);
	lease.release();
	assert.equal(readFileSync(lease.path, "utf8"), replacement, "release cannot act as reclamation of another PID, even with a copied token");
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
