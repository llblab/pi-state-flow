import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import stateFlowExtension from "../index.ts";
import type { MaterializedState, StateScope } from "../lib/state.ts";
import type { PiCheckpoint, Snapshot } from "../lib/snapshot.ts";
import { resolveCheckpoint } from "./temporal-fixture.ts";

const checkpointRoots = new WeakMap<AgentSession, string>();
import { SNAPSHOT_ENTRY_TYPE } from "../lib/session.ts";

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

export interface RealPiFixture {
	root: string;
	repositoryRoot: string;
	remote: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	faux: FauxProviderHandle;
	modelRuntime: ModelRuntime;
	notifications: string[];
	statuses: Array<string | undefined>;
	readState(session: AgentSession, offset?: number, scope?: StateScope): MaterializedState;
	createSession(reason?: "startup" | "new" | "resume", manager?: SessionManager): Promise<AgentSession>;
}

export async function realPiFixture(t: TestContext, options: { tokensPerSecond?: number; initializeRepository?: boolean; autoStart?: boolean } = {}): Promise<RealPiFixture> {
	const root = mkdtempSync(join(tmpdir(), "state-flow-real-pi-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = join(root, "knowledge");
	const remote = join(root, "remote.git");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const path of [repositoryRoot, cwd, agentDir, join(agentDir, "knowledge"), sessionDir]) mkdirSync(path, { recursive: true });
	if (options.autoStart !== undefined) writeFileSync(join(agentDir, "state-flow.json"), JSON.stringify({ autoStart: options.autoStart }));
	if (options.initializeRepository !== false) {
		execFileSync("git", ["init", "-b", "main", repositoryRoot], { stdio: "ignore" });
		git(repositoryRoot, "config", "user.name", "State Flow Integration Tests");
		git(repositoryRoot, "config", "user.email", "state-flow@example.invalid");
		git(repositoryRoot, "commit", "--allow-empty", "-m", "fixture");
		execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "-u", "origin", "main");
	}

	const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({
		provider: `state-flow-integration-${process.pid}-${Math.random().toString(16).slice(2)}`,
		...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const accessors = new Map<string, { read(offset?: number, scope?: StateScope): MaterializedState }>();

	async function createSession(
		reason: "startup" | "new" | "resume" = "startup",
		manager = SessionManager.create(cwd, sessionDir),
	): Promise<AgentSession> {
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false, keepRecentTokens: 1 },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [{
				name: "state-flow-integration",
				factory: (pi) => stateFlowExtension(pi, { agentDir, repositoryRoot, knowledgeRoot: join(agentDir, "knowledge"), onRuntime: (accessor) => accessors.set(manager.getSessionId(), accessor) }),
			}],
		});
		await resourceLoader.reload();
		if (resourceLoader.getExtensions().errors.length > 0) {
			throw new Error(`Could not load State Flow integration extension: ${JSON.stringify(resourceLoader.getExtensions().errors)}`);
		}
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager: manager,
			sessionStartEvent: { type: "session_start", reason },
			tools: ["read", "patch_state", "read_state"],
		});
		await session.bindExtensions({
			mode: "json",
			uiContext: {
				notify(message: string) { notifications.push(message); },
				setStatus(_key: string, value: string | undefined) { statuses.push(value); },
				theme: { fg: (_color: string, text: string) => text },
			} as any,
		});
		checkpointRoots.set(session, repositoryRoot);
		return session;
	}

	return {
		root,
		repositoryRoot,
		remote,
		cwd,
		agentDir,
		sessionDir,
		faux,
		modelRuntime,
		notifications,
		statuses,
		createSession,
		readState: (session, offset, scope) => accessors.get(session.sessionManager.getSessionId())!.read(offset, scope),
	};
}

export function snapshots(session: AgentSession): Array<{ id: string; data: PiCheckpoint }> {
	return session.sessionManager.getBranch()
		.filter((entry): entry is any => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE)
		.map((entry: any) => ({ id: entry.id, data: entry.data as PiCheckpoint }));
}

export function resolvedSnapshot(session: AgentSession, data: unknown = snapshots(session).at(-1)?.data): Snapshot {
	const root = checkpointRoots.get(session);
	if (!root) throw new Error("Missing test checkpoint repository");
	return resolveCheckpoint(data, session.sessionManager.getCwd(), session.sessionManager.getSessionId(), root);
}

export function scopedTerminal(transitions: unknown[], answer: string): string {
	return `<!-- state_flow ${JSON.stringify({ transitions })} -->\n\n${answer}`;
}

export function runGit(repository: string, ...args: string[]): string {
	return git(repository, ...args);
}
