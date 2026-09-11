import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stateFlowExtension from "../index.ts";
import type { StateFlowTelegramLoader, StateFlowTelegramModules } from "../lib/telegram.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadStateFlowConfig } from "../lib/config.ts";
import { resolveCheckpoint } from "./temporal-fixture.ts";
import type { MaterializedState, StateScope } from "../lib/state.ts";
import { resolveSessionAddress } from "../lib/durable.ts";

export type Handler = (...args: any[]) => any;

// Test fixtures must not outlive the process: runaway mkdtemp dirs exhaust the
// default /tmp inode table and later runs fail with ENOSPC.
const fixtureRoots: string[] = [];
process.once("exit", () => {
	for (const root of fixtureRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; exiting must not fail on a stale fixture.
		}
	}
});
function trackFixtureRoot(root: string): string {
	fixtureRoots.push(root);
	return root;
}

export interface HarnessOptions {
	agentDir?: string;
	autoStart?: boolean;
	remotePublication?: "off" | "turn-end" | "transition";
	cwd?: string;
	repositoryRoot?: string;
	knowledgeRoot?: string;
	useDefaultKnowledgeRoot?: boolean;
	useConfiguredDirectory?: boolean;
	initializeRepository?: boolean;
	sessionId?: string;
	sessionFile?: string;
	sessionTimestamp?: string;
	telegram?: { load?: StateFlowTelegramLoader };
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
		isIdle: () => true,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			notify(message: string) { notifications.push(message); },
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => options.sessionId ?? "harness-session",
			getSessionFile: () => options.sessionFile,
			getHeader: () => options.sessionTimestamp === undefined ? null : {
				type: "session", version: 3, id: options.sessionId ?? "harness-session", timestamp: options.sessionTimestamp, cwd: options.cwd ?? "/tmp",
			},
		},
	};
	const fixtureRoot = options.repositoryRoot ?? trackFixtureRoot(mkdtempSync(join(tmpdir(), "state-flow-harness-")));
	const agentDir = options.agentDir ?? (options.useDefaultKnowledgeRoot ? getAgentDir() : join(fixtureRoot, "agent"));
	if (options.autoStart !== undefined || options.remotePublication !== undefined) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "state-flow.json"), JSON.stringify({
			...(options.autoStart === undefined ? {} : { autoStart: options.autoStart }),
			...(options.remotePublication === undefined ? {} : { remotePublication: options.remotePublication }),
		}));
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
			const remote = trackFixtureRoot(mkdtempSync(join(tmpdir(), "state-flow-harness-remote-")));
			execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
			execFileSync("git", ["-C", repositoryRoot, "remote", "add", "origin", remote]);
			execFileSync("git", ["-C", repositoryRoot, "push", "-u", "origin", "main"], { stdio: "ignore" });
		}
	}
	let accessor: { read(offset?: number, scope?: StateScope): MaterializedState };
	stateFlowExtension(pi as any, { agentDir, repositoryRoot: options.useConfiguredDirectory ? undefined : repositoryRoot, knowledgeRoot: options.useDefaultKnowledgeRoot ? undefined : options.knowledgeRoot ?? repositoryRoot, onRuntime: (value) => { accessor = value; }, ...(options.telegram === undefined ? {} : { telegram: options.telegram }) });
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
		resolveSnapshot: (data: unknown = entries.at(-1)?.data) => resolveCheckpoint(data, ctx.cwd, ctx.sessionManager.getSessionId(), repositoryRoot,
			resolveSessionAddress(options.sessionFile, ctx.sessionManager.getSessionId(), options.sessionTimestamp).key),
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

export async function start(h: ReturnType<typeof harness>, prompt = "Inspect README") {
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	return h.handlers.get("before_agent_start")!({ prompt, systemPrompt: "base" }, h.ctx);
}

export async function commitScopedTerminal(
	h: ReturnType<typeof harness>,
	transitions: Array<{ scope: "session" | "cwd" | "global"; patch: unknown }>,
	prose = "Done",
) {
	const input = Object.fromEntries(transitions.map(({ scope, patch }) => [scope, patch]));
	await h.tools.get("patch_state")!.execute("terminal", { ...input, final: true }, undefined, undefined, h.ctx);
	const message = {
		role: "assistant" as const,
		stopReason: "stop",
		content: [{ type: "text", text: prose }],
	};
	const result = h.handlers.get("message_end")!({ message }, h.ctx) ?? { message };
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	return result;
}

export async function commitTerminal(
	h: ReturnType<typeof harness>,
	contract: unknown,
	working: unknown,
	prose = "Done",
	artifacts: unknown = {},
) {
	const transitions: Array<{ scope: "session" | "cwd" | "global"; patch: any }> = [];
	if (typeof artifacts === "object" && artifacts !== null && Object.keys(artifacts).length > 0) {
		transitions.push({ scope: "cwd", patch: { artifacts } });
	}
	const sessionPatch = {
		...(typeof contract === "object" && contract !== null && Object.keys(contract).length > 0 ? { contract } : {}),
		...(typeof working === "object" && working !== null && Object.keys(working).length > 0 ? { working } : {}),
	};
	if (Object.keys(sessionPatch).length > 0) transitions.push({ scope: "session", patch: sessionPatch });
	return await commitScopedTerminal(h, transitions, prose);
}

