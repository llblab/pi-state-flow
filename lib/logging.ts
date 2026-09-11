// Domain: opt-in diagnostic capture for rejected State Flow resolutions.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObject } from "./json.ts";

export type StateFlowDiagnosticCategory = "invalid-patch" | "publication-conflict" | "terminal-pending" | "finalization";

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
