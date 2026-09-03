import stateFlowExtension from "../index.ts";

export type Handler = (...args: any[]) => any;

export function harness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	let registeredTools = 0;
	const pi = {
		registerTool() { registeredTools += 1; },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { sentMessages.push({ message, options }); },
	};
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: "/tmp",
		isProjectTrusted: () => false,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			notify(message: string) { notifications.push(message); },
		},
		sessionManager: { getBranch: () => entries },
	};
	stateFlowExtension(pi as any);
	return { handlers, commands, entries, sentMessages, notifications, statuses, ctx, get registeredTools() { return registeredTools; } };
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

export function terminalComment(contract: unknown, working: unknown): string {
	return `<!-- state_flow ${JSON.stringify({ contract, working })} -->`;
}

export async function start(h: ReturnType<typeof harness>, prompt = "Inspect README") {
	await h.commands.get("state-flow-start")!.handler("", h.ctx);
	return h.handlers.get("before_agent_start")!({ prompt, systemPrompt: "base" }, h.ctx);
}

export function commitTerminal(h: ReturnType<typeof harness>, contract: unknown, working: unknown, prose = "Done") {
	const result = h.handlers.get("message_end")!({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${terminalComment(contract, working)}\n\n${prose}` }],
		},
	}, h.ctx);
	h.handlers.get("turn_end")!({ message: result.message }, h.ctx);
	return result;
}

