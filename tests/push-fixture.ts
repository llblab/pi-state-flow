import childProcess, { type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

export interface PushChild {
	child: ChildProcessWithoutNullStreams;
	ready: Promise<void>;
	closed: Promise<void>;
	requested: { args: string[]; detached: boolean; terminalPrompt?: string; interactive?: string };
}

/** Replace only asynchronous Git push with a real, controllable child; other Git commands stay native. */
export function interceptGitPushes(t: TestContext): PushChild[] {
	const spawn = childProcess.spawn;
	const execFile = childProcess.execFile;
	const kill = process.kill.bind(process);
	const children: PushChild[] = [];
	let closing = false;
	const program = `
		process.on("SIGTERM", () => {});
		process.stdin.resume();
		process.stdin.once("data", data => {
			const code = Number(data.toString());
			if (code) process.stderr.write("synthetic Git push failure\\n");
			process.exit(code);
		});
		process.stdin.once("end", () => process.exit(1));
		process.stderr.write("push-ready\\n");
		setTimeout(() => process.exit(1), 10000);
	`;
	const isPush = (command: unknown, args: unknown): args is string[] => command === "git" && Array.isArray(args) && args[2] === "push";
	function launch(args: string[], options: SpawnOptions = {}): PushChild {
		// The fixture owns a group even for the old execFile path, so failed regressions cannot leak children.
		const child = spawn(process.execPath, ["-e", program], { ...options, detached: process.platform !== "win32", stdio: "pipe" });
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const ready = new Promise<void>((resolve, reject) => {
			let output = "";
			child.stderr.on("data", (chunk) => {
				output += chunk.toString();
				if (output.includes("push-ready\n")) resolve();
			});
			child.once("error", reject);
			child.once("exit", () => { if (!output.includes("push-ready\n")) reject(new Error("Synthetic push exited before readiness")); });
		});
		void ready.catch(() => {});
		const entry = { child, ready, closed, requested: {
			args: [...args], detached: options.detached === true,
			terminalPrompt: options.env?.GIT_TERMINAL_PROMPT, interactive: options.env?.GCM_INTERACTIVE,
		} };
		children.push(entry);
		if (closing) child.stdin.end("1");
		return entry;
	}
	t.mock.method(childProcess, "spawn", ((command: any, args: any, options: any) =>
		isPush(command, args) ? launch(args, options).child : (spawn as any)(command, args, options)) as typeof spawn);
	t.mock.method(childProcess, "execFile", ((command: any, args: any, options: any, callback: any) => {
		if (!isPush(command, args)) return (execFile as any)(command, args, options, callback);
		const entry = launch(args, options);
		entry.child.once("close", (code, signal) => callback(code === 0 ? null : new Error(`Synthetic push ended: ${signal ?? code}`), "", ""));
		return entry.child;
	}) as typeof execFile);
	syncBuiltinESMExports();
	t.after(async () => {
		closing = true;
		for (let pass = 0; pass < 3; pass++) {
			for (const { child } of children) {
				if (child.pid && child.exitCode === null && child.signalCode === null) {
					try { process.platform === "win32" ? child.kill("SIGKILL") : kill(-child.pid, "SIGKILL"); } catch { /* Child already exited. */ }
				}
			}
			await Promise.all(children.map(({ closed }) => closed));
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (children.every(({ child }) => child.exitCode !== null || child.signalCode !== null)) break;
		}
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return children;
}
