// Domain: opt-in diagnostic capture for rejected State Flow resolutions.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isObject } from "./json.ts";

export type StateFlowDiagnosticCategory = "invalid-patch" | "publication-conflict" | "finalization";

/** Minimal structural block; only ordinary text keeps its exact content. */
export interface StateFlowDiagnosticBlock {
	type: string;
	text?: string;
}

export interface StateFlowDiagnosticRecord {
	at: string;
	sessionId: string;
	cwd: string;
	category: StateFlowDiagnosticCategory;
	error: string;
	content?: StateFlowDiagnosticBlock[];
	/** Rejected tool arguments, captured for reproducible diagnosis. Never reasoning bodies. */
	input?: unknown;
	tool?: string;
	toolCallId?: string;
}

/** Preserve exact text blocks and block boundaries; reasoning bodies are never duplicated. */
export function projectDiagnosticContent(content: unknown): StateFlowDiagnosticBlock[] {
	if (!Array.isArray(content)) return [];
	return content.map((block) => {
		if (!isObject(block) || typeof block.type !== "string") return { type: "unknown" };
		if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
		return { type: block.type };
	});
}

/** Diagnostic JSONL lives beneath the active Pi agent directory, never inside the state repository. */
export function stateFlowLogPath(agentDir: string): string {
	return join(agentDir, "tmp", "state-flow", "logs.jsonl");
}

export function appendStateFlowDiagnostic(path: string, record: StateFlowDiagnosticRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export interface DiagnosticExtras {
	content?: unknown;
	input?: unknown;
	tool?: string;
	toolCallId?: string;
}

/** Own diagnostic path safety, projection, persistence, and one-shot failure reporting. */
export class StateFlowDiagnosticWriter {
	private warningReported = false;
	private readonly enabled: boolean;
	private readonly path: string;
	private readonly repositoryRoot: string;
	private readonly notify: (message: string) => void;

	constructor(enabled: boolean, path: string, repositoryRoot: string, notify: (message: string) => void) {
		this.enabled = enabled;
		this.path = path;
		this.repositoryRoot = repositoryRoot;
		this.notify = notify;
	}

	record(sessionId: string, cwd: string, error: string, category: StateFlowDiagnosticCategory, extras: DiagnosticExtras = {}): void {
		if (!this.enabled) return;
		try {
			const fromRepository = relative(this.repositoryRoot, this.path);
			if (fromRepository === "" || (!isAbsolute(fromRepository) && fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`))) {
				throw new Error("diagnostic path overlaps the State Flow repository");
			}
			appendStateFlowDiagnostic(this.path, {
				at: new Date().toISOString(),
				sessionId,
				cwd: resolve(cwd),
				category,
				error,
				...(extras.content === undefined ? {} : { content: projectDiagnosticContent(extras.content) }),
				...(extras.input === undefined ? {} : { input: extras.input }),
				...(extras.tool === undefined ? {} : { tool: extras.tool }),
				...(extras.toolCallId === undefined ? {} : { toolCallId: extras.toolCallId }),
			});
		} catch (failure) {
			if (this.warningReported) return;
			this.warningReported = true;
			this.notify(`State Flow could not write diagnostics: ${failure instanceof Error ? failure.message : String(failure)}`);
		}
	}
}
