// Domain: visible self-healing of unrecoverable canonical scope cohorts by quarantine and reset to absence.
// Excludes: semantic repair, Git restoration, foreign-owner data, transient I/O failures and Pi lifecycle policy.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { canonicalJson } from "./json.ts";
import { OwnedFilePublicationError, type DurableFileBase } from "./durable.ts";
import { captureScopeSelection, type ScopeSelection } from "./selection.ts";
import { validateHistoryLimit } from "./temporal.ts";
import type { StateScope } from "./state.ts";
import { assertStorageDirectory, withStorageTransaction } from "./storage.ts";

/** Quarantine evidence of an attempt; only an accepted reset makes the scope wholly absent. */
export interface RecoveryEvidence {
	scope: StateScope;
	reason: string;
	cause: Error;
	quarantine: string;
}

/** Healing outcome; `lifecycleAbsent` means this session owns no lifecycle after healing. */
export interface HealResult {
	healed: RecoveryEvidence[];
	lifecycleAbsent: boolean;
}

type HealAttemptOutcome =
	| { effect: "none" | "restored"; evidence: readonly RecoveryEvidence[] }
	| { effect: "incomplete"; evidence: readonly RecoveryEvidence[]; unresolved: readonly { scope: StateScope; paths: readonly string[] }[] }
	| { effect: "reset"; result: HealResult };

/** A later failure cannot erase the captured outcome or authorize another reset. */
export class HealExecutionError extends Error {
	readonly outcome: HealAttemptOutcome;

	constructor(outcome: HealAttemptOutcome, cause: unknown) {
		const status = outcome.effect === "reset" ? "State Flow reset completed; later failure"
			: outcome.effect === "incomplete" ? `State Flow recovery incomplete (${outcome.unresolved.map(item => item.scope).join(", ")})`
				: outcome.effect === "restored" ? "State Flow reset rolled back; original bytes restored" : "State Flow reset made no canonical change";
		super(cause instanceof Error ? `${status}: ${cause.message}` : status, { cause });
		this.outcome = outcome;
	}
}

export interface HealRequest {
	cwd: string;
	sessionId: string;
	sessionKey: string;
	selection: ScopeSelection;
	historyLimit: number;
	root: string;
	/** Current native operation, if the request has a native owner. */
	assertCurrent?: () => void;
	/** Native owner's required pending receipt, after evidence verification and before mutation. */
	recordAttempt?: (evidence: readonly RecoveryEvidence[]) => void;
	/** Wall-clock source for deterministic tests. */
	now?: () => Date;
}

/** Exact-byte private record first; storage retains the captured CAS basis and owns removal. */
function quarantineScope(
	request: HealRequest, scope: StateScope, cause: Error, files: readonly DurableFileBase[], at: string,
): { evidence: RecoveryEvidence; verify: () => void } {
	const reason = cause.message;
	const root = resolve(request.root);
	const content = `${canonicalJson({ version: 1, kind: "state-flow-quarantine", at, root, cwd: resolve(request.cwd),
		sessionId: request.sessionId, sessionKey: request.sessionKey, scope, reason,
		files: files.filter(file => file.bytes !== undefined).map(file => ({ path: relative(root, file.path), bytes: Buffer.from(file.bytes!).toString("base64") })) })}\n`;
	const directory = resolve(dirname(root), `${basename(root)}-quarantine`);
	assertStorageDirectory(directory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
		throw new Error("State Flow quarantine directory must be private; canonical files preserved");
	}
	const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const path = resolve(directory, `${at.replace(/[:.]/g, "-")}-${scope}-${digest}.json`);
	try { writeFileSync(path, content, { flag: "wx", mode: 0o600 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	return { evidence: { scope, reason, cause, quarantine: path }, verify: () => {
		assertStorageDirectory(directory);
		const current = lstatSync(directory);
		if (current.dev !== directoryStat.dev || current.ino !== directoryStat.ino || (current.mode & 0o077) !== 0) {
			throw new Error("State Flow quarantine directory changed; canonical files preserved");
		}
		const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(descriptor);
			if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !readFileSync(descriptor).equals(Buffer.from(content))) {
				throw new Error("State Flow quarantine record is unsafe or changed; canonical files preserved");
			}
		} finally { closeSync(descriptor); }
	} };
}

/** Never waits behind a live writer: a busy store is being used, so healing defers to a later attempt. */
export async function healSelectedStore(request: HealRequest, signal?: AbortSignal): Promise<HealResult> {
	signal?.throwIfAborted();
	const selection = captureScopeSelection(request.selection);
	validateHistoryLimit(request.historyLimit);
	const root = resolve(request.root);
	assertStorageDirectory(root);
	if (!lstatSync(root, { throwIfNoEntry: false })) return { healed: [], lifecycleAbsent: true };
	const evidence: RecoveryEvidence[] = [];
	let outcome: HealAttemptOutcome | undefined;
	try {
		return await withStorageTransaction(root, storage => {
			request.assertCurrent?.();
			const plan = storage.prepareSelectedRecovery(request.cwd, request.sessionId, selection, root, request.sessionKey);
			if (!plan.damage.length) return { healed: [], lifecycleAbsent: plan.lifecycleAbsent };
			outcome = { effect: "none", evidence };
			const at = (request.now?.() ?? new Date()).toISOString();
			const records = plan.damage.map(({ scope, cause, files }) => {
				signal?.throwIfAborted();
				const record = quarantineScope({ ...request, root }, scope, cause, files, at);
				evidence.push(record.evidence);
				return record;
			});
			try { plan.reset(() => {
				request.assertCurrent?.();
				for (const record of records) record.verify();
				request.recordAttempt?.(evidence);
				request.assertCurrent?.();
			}); }
			catch (error) {
				if (error instanceof OwnedFilePublicationError) {
					if (error.effect === "incomplete") {
						const paths = new Set(error.unresolvedPaths);
						outcome = { effect: "incomplete", evidence, unresolved: plan.damage.flatMap(({ scope, files }) => {
							const affected = files.filter(file => paths.has(file.path)).map(file => file.path);
							return affected.length ? [{ scope, paths: affected }] : [];
						}) };
					} else if (error.effect === "restored") outcome = { effect: "restored", evidence };
				}
				throw error;
			}
			const result = { healed: evidence, lifecycleAbsent: plan.lifecycleAbsent };
			outcome = { effect: "reset", result };
			return result;
		}, signal, false);
	} catch (error) {
		// The lock wrapper may fail after its callback; the callback's recorded effect is authoritative.
		if (outcome) throw new HealExecutionError(outcome, error);
		throw error;
	}
}

export interface RecoveryIncident {
	id: string;
	scopes: ScopeSelection;
	fact: "attempted" | "none" | "restored" | "incomplete" | "reset" | "missing";
	/** Delivery can end without resolving the filesystem safety evidence. */
	acknowledged?: true;
}

export function unresolvedRecovery(incident: RecoveryIncident): boolean {
	return incident.fact === "attempted" || incident.fact === "incomplete";
}

export function recoveryIncidentText({ scopes, fact }: RecoveryIncident): string {
	const names = scopes.join(", ");
	switch (fact) {
		case "attempted": return `State Flow recovery was attempted for ${names} memory; the result is unconfirmed`;
		case "none": return `State Flow recovery made no canonical changes to ${names} memory`;
		case "restored": return `State Flow recovery could not complete for ${names} memory; its changes were rolled back`;
		case "incomplete": return `State Flow recovery is incomplete for ${names} memory; dependent memory is unavailable`;
		case "reset": return `State Flow self-healed: ${names} memory was unreadable and was reset`;
		case "missing": return "State Flow self-healed: session memory files were missing and session memory restarts empty";
	}
}

export function describeHealedScopes(healed: readonly RecoveryEvidence[]): string {
	return healed.map(item => `${item.scope} memory was unreadable (${item.reason}) and was reset to empty; original bytes quarantined at ${item.quarantine}`).join("; ");
}
