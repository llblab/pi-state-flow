import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stateFlowExtension from "../index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadStateFlowConfig } from "../lib/config.ts";
import { resolveCheckpoint } from "./temporal-fixture.ts";
import type { MaterializedState, StateScope } from "../lib/state.ts";

export type Handler = (...args: any[]) => any;

export interface HarnessOptions {
	agentDir?: string;
	autoStart?: boolean;
	cwd?: string;
	repositoryRoot?: string;
	knowledgeRoot?: string;
	useDefaultKnowledgeRoot?: boolean;
	useConfiguredDirectory?: boolean;
	initializeRepository?: boolean;
	sessionId?: string;
}

export function harness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash"];
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
			if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
		},
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { sentMessages.push({ message, options }); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
	};
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: options.cwd ?? "/tmp",
		isProjectTrusted: () => false,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			notify(message: string) { notifications.push(message); },
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => options.sessionId ?? "harness-session",
		},
	};
	const fixtureRoot = options.repositoryRoot ?? mkdtempSync(join(tmpdir(), "state-flow-harness-"));
	const agentDir = options.agentDir ?? (options.useDefaultKnowledgeRoot ? getAgentDir() : join(fixtureRoot, "agent"));
	if (options.autoStart !== undefined) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "state-flow.json"), JSON.stringify({ autoStart: options.autoStart }));
	}
	const repositoryRoot = options.useConfiguredDirectory ? loadStateFlowConfig(agentDir).directory : fixtureRoot;
	if (options.initializeRepository !== false) {
		try {
			execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
		} catch {
			execFileSync("git", ["-C", repositoryRoot, "init", "-b", "main"], { stdio: "ignore" });
			execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "State Flow Tests"]);
			execFileSync("git", ["-C", repositoryRoot, "config", "user.email", "state-flow@example.invalid"]);
			execFileSync("git", ["-C", repositoryRoot, "commit", "--allow-empty", "-m", "fixture"]);
		}
		const remotes = execFileSync("git", ["-C", repositoryRoot, "remote"], { encoding: "utf8" }).trim();
		if (remotes.length === 0) {
			const remote = mkdtempSync(join(tmpdir(), "state-flow-harness-remote-"));
			execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
			execFileSync("git", ["-C", repositoryRoot, "remote", "add", "origin", remote]);
			execFileSync("git", ["-C", repositoryRoot, "push", "-u", "origin", "main"], { stdio: "ignore" });
		}
	}
	let accessor: { read(offset?: number, scope?: StateScope): MaterializedState };
	stateFlowExtension(pi as any, { agentDir, repositoryRoot: options.useConfiguredDirectory ? undefined : repositoryRoot, knowledgeRoot: options.useDefaultKnowledgeRoot ? undefined : options.knowledgeRoot ?? repositoryRoot, onRuntime: (value) => { accessor = value; } });
	return {
		handlers,
		commands,
		tools,
		entries,
		sentMessages,
		notifications,
		statuses,
		ctx,
		repositoryRoot,
		agentDir,
		resolveSnapshot: (data: unknown = entries.at(-1)?.data) => resolveCheckpoint(data, ctx.cwd, ctx.sessionManager.getSessionId(), repositoryRoot),
		readState: (offset?: number, scope?: StateScope) => accessor.read(offset, scope),
		get registeredTools() { return tools.size; },
		get activeTools() { return [...activeTools]; },
	};
}

export function user(text: string, timestamp: number) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function toolAssistant(id: string, name = "read", args: unknown = { path: "README.md" }) {
	return {
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: Date.now(),
	};
}

export function scopedTerminalComment(transitions: unknown[]): string {
	return `<!-- state_flow ${JSON.stringify({ transitions })} -->`;
}

export function terminalComment(contract: unknown, working: unknown, artifacts: unknown = {}): string {
	const transitions = [
		{ scope: "session", patch: { contract, working } },
		...(typeof artifacts === "object" && artifacts !== null && Object.keys(artifacts).length > 0
			? [{ scope: "cwd", patch: { artifacts } }]
			: []),
	];
	return scopedTerminalComment(transitions);
}

export async function start(h: ReturnType<typeof harness>, prompt = "Inspect README") {
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	return h.handlers.get("before_agent_start")!({ prompt, systemPrompt: "base" }, h.ctx);
}

export function commitTerminal(
	h: ReturnType<typeof harness>,
	contract: unknown,
	working: unknown,
	prose = "Done",
	artifacts: unknown = {},
) {
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment(contract, working, artifacts)}\n\n${prose}` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	return result;
}

