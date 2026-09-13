import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve, sep } from "node:path";


export type RemotePublicationMode = "off" | "turn-end" | "transition";

export interface RemotePublicationDestination {
	gitCommonDir: string;
	remote: string;
	ref: string;
}

export interface RemotePublicationPolicy {
	mode: RemotePublicationMode;
	migratedLegacyDefault: boolean;
}

export interface RemotePublicationPolicyDocument {
	version: 1;
	mode: RemotePublicationMode;
}

/** Missing policy on an existing runtime preserves 0.4 synchronous behavior. */
export function resolveRemotePublicationPolicy(
	value: unknown,
	options: { legacyRuntime: boolean },
): RemotePublicationPolicy {
	if (value === undefined) {
		return options.legacyRuntime
			? { mode: "transition", migratedLegacyDefault: true }
			: { mode: "turn-end", migratedLegacyDefault: false };
	}
	if (value !== "off" && value !== "turn-end" && value !== "transition") {
		throw new Error("State Flow remote publication mode must be off, turn-end, or transition");
	}
	return { mode: value, migratedLegacyDefault: false };
}

export function parseRemotePublicationPolicyDocument(
	value: unknown,
	options: { legacyRuntime: boolean },
): RemotePublicationPolicy {
	if (value === undefined) return resolveRemotePublicationPolicy(undefined, options);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid remote publication policy document");
	const document = value as Record<string, unknown>;
	if (Object.keys(document).sort().join(",") !== "mode,version" || document.version !== 1) {
		throw new Error("Invalid remote publication policy document");
	}
	return resolveRemotePublicationPolicy(document.mode, { legacyRuntime: false });
}

export function serializeRemotePublicationPolicyDocument(policy: RemotePublicationPolicy): RemotePublicationPolicyDocument {
	return { version: 1, mode: policy.mode };
}

export function remotePublicationDestinationKey(destination: RemotePublicationDestination): string {
	if (!destination.remote.trim() || destination.remote !== destination.remote.trim()
		|| !destination.ref.trim() || destination.ref !== destination.ref.trim()) {
		throw new Error("Remote publication destination requires non-empty trimmed remote and ref");
	}
	return JSON.stringify([resolve(destination.gitCommonDir), destination.remote, destination.ref]);
}

function isCommit(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}
export type PublicationQueueStatus = "pending" | "pushing" | "failed";
export interface PublicationQueueState {
	version: 1;
	destination: RemotePublicationDestination;
	target: string;
	confirmed?: string;
	status: PublicationQueueStatus;
	attempt: number;
	error?: string;
}
export type CommitAncestor = (ancestor: string, descendant: string) => boolean;

export function createPublicationQueue(destination: RemotePublicationDestination, target: string): PublicationQueueState {
	if (!isCommit(target)) throw new Error("Publication queue target must be an exact commit");
	remotePublicationDestinationKey(destination);
	return { version: 1, destination: structuredClone(destination), target, status: "pending", attempt: 0 };
}

export interface PublicationCoalesceObserver {
	/** Called with the retired record when a journal lineage rewrite orphans its target. */
	onDivergedLineage?: (previous: PublicationQueueState) => void;
}

export function coalescePublicationTarget(state: PublicationQueueState, destination: RemotePublicationDestination, target: string, isAncestor: CommitAncestor, observer?: PublicationCoalesceObserver): PublicationQueueState {
	validatePublicationQueue(state);
	if (!isCommit(target)) throw new Error("Publication queue target must be an exact commit");
	if (remotePublicationDestinationKey(state.destination) !== remotePublicationDestinationKey(destination)) throw new Error("Publication queue destination changed");
	if (target === state.target || isAncestor(target, state.target)) return structuredClone(state);
	const previous = structuredClone(state);
	if (!isAncestor(state.target, target)) {
		// A reset or re-initialized journal rewrites the lineage. The queued commit can never
		// fast-forward the remote again, so retarget the live lineage instead of wedging every
		// later turn-end; the retired commit stays in the local Git object store.
		observer?.onDivergedLineage?.(previous);
		const { confirmed: _confirmed, error: _error, ...live } = previous;
		return { ...live, target, status: "pending", attempt: 0 };
	}
	return { ...previous, target, status: "pending", attempt: 0, error: undefined };
}

export function parsePublicationQueue(content: string): PublicationQueueState {
	let value: unknown;
	try { value = JSON.parse(content); } catch { throw new Error("Invalid publication queue JSON"); }
	validatePublicationQueue(value);
	return structuredClone(value);
}

export function serializePublicationQueue(state: PublicationQueueState): string {
	validatePublicationQueue(state);
	return `${JSON.stringify(state)}\n`;
}

export function beginPublicationAttempt(state: PublicationQueueState): PublicationQueueState {
	validatePublicationQueue(state);
	const { error: _error, ...current } = structuredClone(state);
	return { ...current, status: "pushing", attempt: state.attempt + 1 };
}

export function failPublicationAttempt(state: PublicationQueueState, error: string): PublicationQueueState {
	validatePublicationQueue(state);
	if (state.status !== "pushing" || !error.trim()) throw new Error("Only an active publication attempt can fail with a bounded error");
	return { ...structuredClone(state), status: "failed", error: error.trim().slice(0, 1000) };
}

export function confirmPublicationTarget(state: PublicationQueueState, pushed: string, isAncestor: CommitAncestor): PublicationQueueState | undefined {
	validatePublicationQueue(state);
	if (!isCommit(pushed)) throw new Error("Confirmed publication target must be an exact commit");
	if (pushed === state.target) return undefined;
	if (!isAncestor(pushed, state.target)) throw new Error("Publication confirmation does not cover the queued lineage");
	return { ...structuredClone(state), confirmed: pushed, status: "pending", error: undefined };
}

/** A recovered pushing state is unconfirmed and safely retryable after restart. */
export function recoverPublicationQueue(state: PublicationQueueState): PublicationQueueState {
	validatePublicationQueue(state);
	return state.status === "pushing"
		? { ...structuredClone(state), status: "pending", error: "previous publication attempt ended without confirmation" }
		: structuredClone(state);
}

export function validatePublicationQueue(value: unknown): asserts value is PublicationQueueState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid publication queue document");
	const v = value as Record<string, unknown>;
	if (v.version !== 1 || !isCommit(v.target) || !Number.isSafeInteger(v.attempt) || (v.attempt as number) < 0
		|| (v.status !== "pending" && v.status !== "pushing" && v.status !== "failed")
		|| typeof v.destination !== "object" || v.destination === null) throw new Error("Invalid publication queue document");
	remotePublicationDestinationKey(v.destination as unknown as RemotePublicationDestination);
	if (v.confirmed !== undefined && !isCommit(v.confirmed)) throw new Error("Invalid publication queue document");
	if (v.error !== undefined && (typeof v.error !== "string" || !v.error.trim())) throw new Error("Invalid publication queue document");
	const allowed = new Set(["version", "destination", "target", "confirmed", "status", "attempt", "error"]);
	if (Object.keys(v).some((key) => !allowed.has(key))) throw new Error("Invalid publication queue document");
}

export function publicationQueuePath(destination: RemotePublicationDestination): string {
	const key = remotePublicationDestinationKey(destination);
	const name = createHash("sha256").update(key).digest("hex");
	return resolve(destination.gitCommonDir, "state-flow-publication", `${name}.json`);
}

function assertNoSymlinkAncestors(path: string): void {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let current = root;
	for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = resolve(current, segment);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) break;
		if (stat.isSymbolicLink()) throw new Error("Publication queue path cannot traverse symlink ancestors");
		if (!stat.isDirectory()) throw new Error("Publication queue ancestor must be a directory");
	}
}

export interface PublicationWorkerLease {
	path: string;
	token: string;
	release(): void;
}

interface WorkerLeaseDocument {
	version: 1;
	pid: number;
	token: string;
	startedAt: string;
}

function readWorkerLease(path: string): WorkerLeaseDocument | undefined {
	assertNoSymlinkAncestors(dirname(path));
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return undefined;
	if (!stat.isFile()) throw new Error("Publication worker lease path must be a regular file");
	let descriptor: number;
	try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // A live owner may have released it.
		throw error;
	}
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error("Publication worker lease path must be a regular file");
		const source = readFileSync(descriptor, "utf8");
		let value: unknown;
		try { value = JSON.parse(source); } catch { throw new Error("Publication worker lease is malformed"); }
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Publication worker lease is malformed");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).sort().join(",") !== "pid,startedAt,token,version" || record.version !== 1
			|| !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || (record.pid as number) > 2147483647
			|| typeof record.token !== "string" || !record.token.trim() || record.token !== record.token.trim()
			|| typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) {
			throw new Error("Publication worker lease is malformed");
		}
		return record as unknown as WorkerLeaseDocument;
	} finally {
		closeSync(descriptor);
	}
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function acquirePublicationWorkerLease(queuePath: string): PublicationWorkerLease | undefined {
	const path = `${resolve(queuePath)}.worker.lock`;
	assertNoSymlinkAncestors(dirname(path));
	const token = randomUUID();
	const document = `${JSON.stringify({ version: 1, pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;
	const create = (): PublicationWorkerLease | undefined => {
		try { writeFileSync(path, document, { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
			throw error;
		}
		return { path, token, release() {
			let current: WorkerLeaseDocument | undefined;
			try { current = readWorkerLease(path); } catch { return; }
			// A live owner cannot be reclaimed, so release need not wait for queue writers.
			if (current?.pid === process.pid && current.token === token) rmSync(path, { force: true });
		} };
	};
	const lease = create();
	if (lease) return lease;
	const current = readWorkerLease(path);
	if (!current) return create();
	if (processAlive(current.pid)) return undefined;
	// Only reclamation needs the existing queue writer gate; exclusive creation protects fresh claims.
	const gate = `${resolve(queuePath)}.lock`;
	assertNoSymlinkAncestors(dirname(gate));
	let descriptor: number;
	try { descriptor = openSync(gate, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}
	try {
		const owner = readWorkerLease(path);
		if (owner && processAlive(owner.pid)) return undefined;
		if (owner) rmSync(path, { force: true });
		return create(); // A fresh claimant may win the gap; never remove its replacement.
	} finally {
		closeSync(descriptor);
		rmSync(gate, { force: true });
	}
}

export function loadPublicationQueue(path: string): PublicationQueueState | undefined {
	const target = resolve(path);
	assertNoSymlinkAncestors(dirname(target));
	const stat = lstatSync(target, { throwIfNoEntry: false });
	if (!stat) return undefined;
	if (!stat.isFile()) throw new Error("Publication queue path must be a regular file");
	return parsePublicationQueue(readFileSync(target, "utf8"));
}

export function removePublicationQueue(path: string, expected: PublicationQueueState): void {
	const target = resolve(path);
	assertNoSymlinkAncestors(dirname(target));
	const lock = `${target}.lock`;
	let lockFd: number | undefined;
	try {
		lockFd = openSync(lock, "wx", 0o600);
		const current = loadPublicationQueue(target);
		if (!current || serializePublicationQueue(current) !== serializePublicationQueue(expected)) {
			throw new Error("Publication queue compare-and-swap conflict");
		}
		rmSync(target);
	} finally {
		if (lockFd !== undefined) {
			closeSync(lockFd);
			rmSync(lock, { force: true });
		}
	}
}

export interface PublicationQueueReceipt {
	previous?: PublicationQueueState;
	current: PublicationQueueState;
}

export function savePublicationQueue(path: string, state: PublicationQueueState, expected?: PublicationQueueState): PublicationQueueReceipt {
	const target = resolve(path);
	assertNoSymlinkAncestors(dirname(target));
	mkdirSync(dirname(target), { recursive: true });
	const lock = `${target}.lock`;
	let lockFd: number | undefined;
	try {
		lockFd = openSync(lock, "wx", 0o600);
		const existing = lstatSync(target, { throwIfNoEntry: false });
		if (existing && !existing.isFile()) throw new Error("Publication queue path must be a regular file");
		const previous = existing ? parsePublicationQueue(readFileSync(target, "utf8")) : undefined;
		if (expected !== undefined && (previous === undefined
			|| serializePublicationQueue(previous) !== serializePublicationQueue(expected))) {
			throw new Error("Publication queue compare-and-swap conflict");
		}
		if (expected === undefined && previous !== undefined) throw new Error("Publication queue compare-and-swap requires the current receipt");
		const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
		try {
			writeFileSync(temporary, serializePublicationQueue(state), { flag: "wx", mode: 0o600 });
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { force: true });
		}
		return { ...(previous === undefined ? {} : { previous }), current: structuredClone(state) };
	} finally {
		if (lockFd !== undefined) {
			closeSync(lockFd);
			rmSync(lock, { force: true });
		}
	}
}

export type PublicationPush = (state: Readonly<PublicationQueueState>) => Promise<void>;

export interface PublicationWorkerResult {
	attempted: PublicationQueueState;
	next?: PublicationQueueState;
}

/** Execute one immutable target attempt; persistence/CAS remains the caller's responsibility. */
export async function runPublicationWorker(
	state: PublicationQueueState,
	push: PublicationPush,
	current: () => PublicationQueueState,
	isAncestor: CommitAncestor,
): Promise<PublicationWorkerResult> {
	const attempted = beginPublicationAttempt(state);
	try {
		await push(Object.freeze(structuredClone(attempted)));
		const next = confirmPublicationTarget(current(), attempted.target, isAncestor);
		return { attempted, ...(next === undefined ? {} : { next }) };
	} catch (error) {
		return {
			attempted,
			next: failPublicationAttempt(attempted, error instanceof Error ? error.message : String(error)),
		};
	}
}
