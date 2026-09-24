import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseScopeStream, resolveSessionAddress, sessionRuntimePaths, temporalScopePaths } from "./durable.ts";
import { MAX_HISTORY_LIMIT } from "./history.ts";
import { diagnosticText } from "./protocol.ts";
import { parseSessionRuntime } from "./snapshot.ts";
import { withStorageTransaction } from "./storage.ts";
import { validateScopeLineage } from "./temporal.ts";

export type ContinuationTransport = "local" | "sdk" | "telegram" | string;

export interface ContinuationHostContext {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	transport: ContinuationTransport;
}

export type ContinuationHostIntent =
	| { kind: "default" }
	| { kind: "new" }
	| { kind: "resume-exact"; sessionFile: string; sessionId: string }
	| { kind: "native-picker" }
	| { kind: "continue-recent" }
	| { kind: "no-session" };

export interface ContinuationCandidateSummary {
	sessionFile: string;
	sessionId: string;
	lastActivity: string;
	reason: string;
}

export type ContinuationRecommendation =
	| { action: "resume"; sessionFile: string; sessionId: string; reason: "latest-enabled-state-flow" }
	| { action: "choose"; candidates: ContinuationCandidateSummary[]; reason: "ambiguous" }
	| { action: "new"; reason: "none" | "last-not-state-flow" | "ineligible" };

export type ContinuationStartupDecision =
	| ContinuationRecommendation
	| { action: "new"; reason: "explicit-new" }
	| { action: "resume"; sessionFile: string; sessionId: string; reason: "explicit-resume" }
	| { action: "native"; mode: "picker" | "continue-recent" | "no-session" };

export interface ContinuationProjectIdentity {
	profile: string;
	cwd: string;
	gitCommonDir?: string;
	worktree?: string;
	branch?: string;
	transport: ContinuationTransport;
}

export interface ContinuationSessionCandidate extends ContinuationCandidateSummary {
	profile: string;
	cwd: string;
	gitCommonDir?: string;
	worktree?: string;
	branch?: string;
	transport: ContinuationTransport;
	lifecycle: "open" | "closed" | "archived";
	doNotAutoResume?: boolean;
	stateFlow: { enabled: boolean; restorable: boolean };
}

export type ContinuationRecommender = (
	context: Readonly<ContinuationHostContext>, signal?: AbortSignal,
) => ContinuationRecommendation | Promise<ContinuationRecommendation>;

/**
 * Preserve host-owned explicit session intent and consult State Flow only for
 * an ordinary default launch. The recommender is a read-only advisory port;
 * opening or claiming a native session remains the host's responsibility.
 */
function sameOptionalIdentity(current: string | undefined, candidate: string | undefined): boolean {
	return current === undefined ? candidate === undefined : candidate === current;
}

function structurallyRelevant(identity: ContinuationProjectIdentity, candidate: ContinuationSessionCandidate): boolean {
	return candidate.profile === identity.profile
		&& candidate.cwd === identity.cwd
		&& candidate.transport === identity.transport
		&& candidate.lifecycle === "open"
		&& candidate.doNotAutoResume !== true
		&& sameOptionalIdentity(identity.gitCommonDir, candidate.gitCommonDir)
		&& sameOptionalIdentity(identity.worktree, candidate.worktree)
		&& sameOptionalIdentity(identity.branch, candidate.branch)
		&& Number.isFinite(Date.parse(candidate.lastActivity));
}

/** Rank already header/provenance-only candidates without transcript content or I/O. */
export function recommendContinuationFromProvenance(
	identity: ContinuationProjectIdentity,
	candidates: readonly ContinuationSessionCandidate[],
): ContinuationRecommendation {
	const relevant = candidates.filter((candidate) => structurallyRelevant(identity, candidate));
	if (relevant.length === 0) return { action: "new", reason: "none" };
	const latestTime = Math.max(...relevant.map(({ lastActivity }) => Date.parse(lastActivity)));
	const latest = relevant.filter(({ lastActivity }) => Date.parse(lastActivity) === latestTime)
		.sort((left, right) => left.sessionFile.localeCompare(right.sessionFile));
	if (latest.length > 1) {
		const resumable = latest.filter(({ stateFlow }) => stateFlow.enabled && stateFlow.restorable);
		if (resumable.length > 1) return { action: "choose", reason: "ambiguous", candidates: resumable.map(({ sessionFile, sessionId, lastActivity }) => ({ sessionFile, sessionId, lastActivity, reason: "equally recent enabled State Flow session" })) };
		if (resumable.length === 1 && latest.every(({ stateFlow }) => stateFlow.enabled && stateFlow.restorable)) {
			const candidate = resumable[0];
			return { action: "resume", sessionFile: candidate.sessionFile, sessionId: candidate.sessionId, reason: "latest-enabled-state-flow" };
		}
		return { action: "new", reason: "ineligible" };
	}
	const candidate = latest[0];
	if (!candidate.stateFlow.enabled) return { action: "new", reason: "last-not-state-flow" };
	if (!candidate.stateFlow.restorable) return { action: "new", reason: "ineligible" };
	return { action: "resume", sessionFile: candidate.sessionFile, sessionId: candidate.sessionId, reason: "latest-enabled-state-flow" };
}

export async function resolveContinuationStartup(
	context: ContinuationHostContext,
	intent: ContinuationHostIntent,
	recommend: ContinuationRecommender,
	signal?: AbortSignal,
): Promise<ContinuationStartupDecision> {
	signal?.throwIfAborted();
	switch (intent.kind) {
		case "new":
			return { action: "new", reason: "explicit-new" };
		case "resume-exact":
			return { action: "resume", sessionFile: intent.sessionFile, sessionId: intent.sessionId, reason: "explicit-resume" };
		case "native-picker":
			return { action: "native", mode: "picker" };
		case "continue-recent":
			return { action: "native", mode: "continue-recent" };
		case "no-session":
			return { action: "native", mode: "no-session" };
		case "default": {
			const recommendation = await recommend(Object.freeze({ ...context }), signal);
			signal?.throwIfAborted();
			return recommendation;
		}
	}
}

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

export interface NativeSessionHeader {
	file: string;
	id: string;
	cwd: string;
	timestamp: string;
	lastActivity: string;
}

export interface ContinuationCandidateProvenance {
	profile: string;
	gitCommonDir?: string;
	worktree?: string;
	branch?: string;
	transport: ContinuationTransport;
	lifecycle: "open" | "closed" | "archived";
	doNotAutoResume?: boolean;
	stateFlow: { enabled: boolean; restorable: boolean };
	reason: string;
}

function readFirstLine(path: string): string {
	if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("Native Pi session header requires a regular canonical file");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Native Pi session header requires a regular file");
		const bytes: number[] = [];
		const byte = Buffer.allocUnsafe(1);
		while (bytes.length <= MAX_SESSION_HEADER_BYTES) {
			const count = readSync(fd, byte, 0, 1, null);
			if (count === 0 || byte[0] === 0x0a) break;
			bytes.push(byte[0]);
		}
		if (bytes.length > MAX_SESSION_HEADER_BYTES) throw new Error("Native Pi session header exceeds the safe discovery limit");
		return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
	} finally {
		closeSync(fd);
	}
}

export function readNativeSessionHeader(path: string): NativeSessionHeader {
	const file = resolve(path);
	let value: unknown;
	try {
		value = JSON.parse(readFirstLine(file));
	} catch (error) {
		throw new Error(`Cannot read native Pi session header: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid native Pi session header");
	const header = value as Record<string, unknown>;
	if (header.type !== "session" || typeof header.id !== "string" || header.id.trim().length === 0
		|| typeof header.cwd !== "string" || header.cwd.trim().length === 0
		|| typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) {
		throw new Error("Invalid native Pi session header");
	}
	const stats = statSync(file);
	return { file, id: header.id, cwd: resolve(header.cwd), timestamp: header.timestamp, lastActivity: stats.mtime.toISOString() };
}

export function discoverNativeSessionHeaders(sessionDir: string): { headers: NativeSessionHeader[]; invalid: Array<{ file: string; error: string }> } {
	const headers: NativeSessionHeader[] = [];
	const invalid: Array<{ file: string; error: string }> = [];
	for (const entry of readdirSync(sessionDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const file = join(sessionDir, entry.name);
		try {
			headers.push(readNativeSessionHeader(file));
		} catch (error) {
			invalid.push({ file: resolve(file), error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { headers, invalid };
}

/** Await one exact canonical cohort; never read transcript bodies, initialize, or publish. */
export async function inspectStateFlowContinuationProvenance(
	header: Readonly<NativeSessionHeader>,
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<Pick<ContinuationCandidateProvenance, "stateFlow" | "reason">> {
	signal?.throwIfAborted();
	const selected = { ...header };
	const root = resolve(repositoryRoot);
	const sessionKey = resolveSessionAddress(selected.file, selected.id, selected.timestamp).key;
	const paths = sessionRuntimePaths(selected.cwd, selected.id, root, sessionKey);
	const absent = { stateFlow: { enabled: false, restorable: true }, reason: "no State Flow session runtime" };
	try {
		if (!lstatSync(root, { throwIfNoEntry: false })) return absent;
		const result = await withStorageTransaction(root, (tx) => {
			const files = new Map(tx.capture(selected.cwd, selected.id, root, sessionKey).files.map((file) => [file.path, file.content]));
			const privatePaths = temporalScopePaths(selected.cwd, selected.id, "session", root, sessionKey);
			if ([paths.config, paths.runtime, privatePaths.meta, privatePaths.checkpoint, privatePaths.patches].every((path) => files.get(path) === undefined)) return absent;
			const runtime = parseSessionRuntime(files.get(paths.config), files.get(paths.runtime), selected.cwd, selected.id);
			if (!runtime) throw new Error("incomplete canonical session runtime");
			if (!runtime.config.enabled) return { stateFlow: { enabled: false, restorable: true }, reason: "State Flow stopped on selected runtime" };
			const streams = (["global", "cwd", "session"] as const).map((scope) => {
				const owned = temporalScopePaths(selected.cwd, selected.id, scope, root, sessionKey);
				return parseScopeStream(files.get(owned.checkpoint), files.get(owned.patches), scope,
					scope === "cwd" ? selected.cwd : undefined, files.get(owned.meta));
			});
			if (streams.some((stream) => stream === undefined)) throw new Error("incomplete canonical temporal cohort");
			// Shared streams remain current and independently valid; only the private stream binds to this lineage.
			validateScopeLineage(streams[2]!, "session", runtime.meta.lineage, MAX_HISTORY_LIMIT);
			return { stateFlow: { enabled: true, restorable: true }, reason: "canonical session lineage is valid beside current shared streams" };
		}, signal);
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		signal?.throwIfAborted();
		return { stateFlow: { enabled: true, restorable: false }, reason: `State Flow runtime is ineligible: ${diagnosticText(error)}` };
	}
}

export async function buildContinuationCandidates(
	headers: readonly NativeSessionHeader[],
	inspect: (header: Readonly<NativeSessionHeader>, signal?: AbortSignal) => ContinuationCandidateProvenance | undefined | Promise<ContinuationCandidateProvenance | undefined>,
	signal?: AbortSignal,
): Promise<ContinuationSessionCandidate[]> {
	signal?.throwIfAborted();
	const selected = headers.map((header) => Object.freeze({ ...header }));
	const candidates: ContinuationSessionCandidate[] = [];
	for (const header of selected) {
		signal?.throwIfAborted();
		const provenance = await inspect(header, signal);
		signal?.throwIfAborted();
		if (!provenance) continue;
		candidates.push({
			...provenance,
			stateFlow: { ...provenance.stateFlow },
			sessionFile: header.file,
			sessionId: header.id,
			lastActivity: header.lastActivity,
			cwd: header.cwd,
		});
	}
	return candidates;
}
