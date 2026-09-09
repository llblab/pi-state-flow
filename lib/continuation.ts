import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadScopeStream, resolveSessionAddress, sessionRuntimePaths } from "./durable.ts";
import { loadTemporalRevision } from "./git.ts";
import { parseSessionRuntime } from "./snapshot.ts";
import { validateTemporalState } from "./temporal.ts";

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
	context: Readonly<ContinuationHostContext>,
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
): Promise<ContinuationStartupDecision> {
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
		case "default":
			return recommend(Object.freeze({ ...context }));
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
	const fd = openSync(path, "r");
	try {
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

function readRegular(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	if (!lstatSync(path).isFile()) throw new Error("State Flow continuation provenance must be a regular file");
	return readFileSync(path, "utf8");
}

/** Inspect only exact current runtime provenance; never initialize, migrate, lock, checkout, or publish. */
export function inspectStateFlowContinuationProvenance(
	header: NativeSessionHeader,
	repositoryRoot: string,
): Pick<ContinuationCandidateProvenance, "stateFlow" | "reason"> {
	const sessionKey = resolveSessionAddress(header.file, header.id, header.timestamp).key;
	const paths = sessionRuntimePaths(header.cwd, header.id, repositoryRoot, sessionKey);
	try {
		const config = readRegular(paths.config);
		const meta = readRegular(paths.meta);
		if (config === undefined && meta === undefined) {
			return { stateFlow: { enabled: false, restorable: true }, reason: "no State Flow session runtime" };
		}
		const runtime = parseSessionRuntime(config, meta, header.cwd, header.id);
		if (!runtime) return { stateFlow: { enabled: false, restorable: true }, reason: "no State Flow session runtime" };
		if (!runtime.config.enabled) return { stateFlow: { enabled: false, restorable: true }, reason: "State Flow stopped on selected runtime" };
		if (runtime.meta.publication === "files") {
			const global = loadScopeStream(header.cwd, header.id, "global", repositoryRoot, sessionKey);
			const cwd = loadScopeStream(header.cwd, header.id, "cwd", repositoryRoot, sessionKey);
			const session = loadScopeStream(header.cwd, header.id, "session", repositoryRoot, sessionKey);
			if (!global || !cwd || !session) throw new Error("incomplete file-only temporal cohort");
			validateTemporalState({ lineage: runtime.meta.lineage, scopes: { global, cwd, session } });
			return { stateFlow: { enabled: true, restorable: true }, reason: "exact file-only runtime cohort is restorable" };
		}
		const runtimePath = relative(resolve(repositoryRoot), paths.meta);
		if (runtimePath.startsWith("..")) throw new Error("runtime provenance escapes repository");
		const owner = execFileSync("git", ["-C", repositoryRoot, "log", "-1", "--format=%H", "--", runtimePath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		if (!owner) throw new Error("runtime owner commit is unavailable");
		const restored = loadTemporalRevision(header.cwd, header.id, repositoryRoot, owner, sessionKey);
		if (!restored.runtime || !restored.runtime.document.config.enabled) throw new Error("selected Git runtime is not enabled");
		return { stateFlow: { enabled: true, restorable: true }, reason: `exact Git runtime ${owner.slice(0, 12)} is restorable` };
	} catch (error) {
		return { stateFlow: { enabled: true, restorable: false }, reason: `State Flow runtime is ineligible: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function buildContinuationCandidates(
	headers: readonly NativeSessionHeader[],
	inspect: (header: Readonly<NativeSessionHeader>) => ContinuationCandidateProvenance | undefined,
): ContinuationSessionCandidate[] {
	const candidates: ContinuationSessionCandidate[] = [];
	for (const header of headers) {
		const provenance = inspect(Object.freeze({ ...header }));
		if (!provenance) continue;
		candidates.push({
			sessionFile: header.file,
			sessionId: header.id,
			lastActivity: header.lastActivity,
			cwd: header.cwd,
			...provenance,
		});
	}
	return candidates;
}
