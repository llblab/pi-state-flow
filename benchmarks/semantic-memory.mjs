// Domain: opt-in semantic-memory trial orchestration and fixture evidence, never runtime policy or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, StringEnum, Type } from "@earendil-works/pi-ai";
import stateFlowExtension from "../lib/extension.ts";
import { resolveSessionAddress } from "../lib/durable.ts";
import { TemporalRuntime } from "../lib/runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trialDoc = join(root, "docs/semantic-memory-evaluation.md");
const conditions = ["native", "passive", "active"];
const hostSettings = { compaction: { enabled: true, keepRecentTokens: 20000 }, retry: { enabled: false } };
const manifest = { dependencies: ["alpha@1", "beta@2"], credentialEnvironment: [], networkPolicy: "deny", bundledVerifier: "v1" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const identity = (value) => digest(JSON.stringify(value));
const textOf = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function inputs() {
	const prompts = [...readFileSync(trialDoc, "utf8").matchAll(/^> (.+)$/gm)].map((match) => match[1]);
	assert.equal(prompts.length, 4, "the trial document must contain exactly four user prompts");
	return prompts;
}

function sourceIdentity() {
	const paths = ["index.ts", "package.json", "package-lock.json", "benchmarks/semantic-memory.mjs", "docs/semantic-memory-evaluation.md",
		...readdirSync(join(root, "lib")).filter((path) => path.endsWith(".ts")).map((path) => `lib/${path}`)].sort();
	return { digest: identity(paths.map((path) => [path, digest(readFileSync(join(root, path)))])), paths };
}

function fixture() {
	let bundle = null;
	const receipts = [];
	const schemas = {
		inspect_fixture: Type.Object({ target: StringEnum(["manifest", "verifier", "embedded-index", "bundle"]) }, { additionalProperties: false }),
		prepare_bundle: Type.Object({ trustIndex: StringEnum(["default", "embedded"]) }, { additionalProperties: false }),
		validate_bundle: Type.Object({ check: StringEnum(["isolation", "coverage"]) }, { additionalProperties: false }),
	};
	function execute(name, args) {
		if (name === "inspect_fixture") return structuredClone(args.target === "manifest" ? manifest
			: args.target === "verifier" ? { version: "v1", nominalApplicability: "Self-contained bundled verification; verify network assumptions", localIndexOption: "embedded" }
			: args.target === "embedded-index" ? { entries: manifest.dependencies }
			: bundle ?? { prepared: false });
		if (name === "prepare_bundle") {
			bundle = { ...structuredClone(manifest), trustIndex: args.trustIndex };
			return { bundle: structuredClone(bundle), artifact: identity(bundle) };
		}
		const passed = bundle !== null && bundle.trustIndex === "embedded";
		const result = { check: args.check, artifact: bundle === null ? null : identity(bundle), passed,
			evidence: bundle === null ? "No prepared bundle" : passed
				? args.check === "isolation" ? "Embedded index requires no remote request" : "Every fixed dependency has a local index entry"
				: args.check === "isolation" ? "Verifier v1 default configuration requests its trust index remotely" : "Default bundle has no embedded index" };
		receipts.push(result);
		return structuredClone(result);
	}
	function snapshot() {
		const artifact = bundle === null ? null : identity(bundle);
		return { bundle: structuredClone(bundle), artifact, receipts: structuredClone(receipts),
			taskSuccess: artifact !== null && ["isolation", "coverage"].every((check) => receipts.some((receipt) => receipt.artifact === artifact && receipt.check === check && receipt.passed)) };
	}
	return { schemas, execute, snapshot };
}

async function semanticSnapshot(cwd, manager, store) {
	const address = resolveSessionAddress(manager.getSessionFile(), manager.getSessionId(), manager.getHeader()?.timestamp);
	const reader = new TemporalRuntime(cwd, address, store);
	if (!await reader.refreshCurrentMemory()) return null;
	const state = Object.fromEntries(["global", "cwd", "session"].map((scope) => [scope, reader.readView(0, scope)]));
	const bytes = Object.fromEntries(Object.entries(state).map(([scope, value]) => [scope,
		Object.fromEntries(Object.entries(value).map(([plane, body]) => [plane, Buffer.byteLength(JSON.stringify(body))]))]));
	return { state, bytes };
}

// The caller must supply the authorized runtime, model and limits; this function never discovers credentials.
export async function runSemanticTrial({ modelRuntime, model, thinkingLevel, limits, allowLive = false, calibration } = {}) {
	assert.ok(modelRuntime && model && typeof thinkingLevel === "string", "an explicit runtime, model and thinking level are required");
	assert.ok(limits && [limits.requestsPerRun, limits.outputTokensPerRequest, limits.timeoutMs].every(positive), "positive request/output-token/time limits are required");
	assert.ok(limits.timeoutMs <= 2147483647 && limits.outputTokensPerRequest <= model.maxTokens, "limits must fit host timers and model output capacity");
	assert.ok(allowLive === true || calibration, "live inference requires explicit caller authorization");
	if (calibration) assert.equal(model.provider, calibration.faux.getModel().provider, "calibration must use its own faux provider");
	const before = sourceIdentity();
	const prompts = inputs();
	const report = { version: 1, evidenceKind: calibration ? "scripted-calibration" : "live-model-observation", status: "complete",
		source: before, inputsDigest: identity(prompts), node: process.version,
		sdk: Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"].map((name) => [name, JSON.parse(readFileSync(join(root, "node_modules/@earendil-works", name, "package.json"), "utf8")).version])),
		model: { provider: model.provider, id: model.id, api: model.api, snapshot: null }, thinkingLevel, limits: structuredClone(limits),
		order: [...conditions], trialsPerCondition: 1, historyLimit: 7, hostSettings: structuredClone(hostSettings), conditions: [], providerBilledCost: null,
		rubricStatus: "unreviewed", requestAccounting: "SDK stream admissions, not HTTP retry count; serialized context prefix is a proxy" };
	for (const condition of conditions) {
		const directory = mkdtempSync(join(tmpdir(), "state-flow-semantic-trial-"));
		const cwd = join(directory, "workspace"), agentDir = join(directory, "agent"), store = join(directory, "memory"), sessionDir = join(directory, "sessions");
		for (const path of [cwd, agentDir, sessionDir]) mkdirSync(path);
		const task = fixture();
		const result = { condition, status: "complete", fixtureSchemaDigest: identity(task.schemas), runs: [], cleanup: false };
		let session;
		let current;
		try {
			const settings = SettingsManager.inMemory(structuredClone(hostSettings));
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [
					...(condition === "native" ? [] : [{ name: "state-flow-trial", factory: (pi) => stateFlowExtension(pi, { agentDir, repositoryRoot: store, mode: condition, telegram: { load: async () => { throw new Error("Telegram disabled in isolated trial"); } } }) }]),
					{ name: "semantic-trial-fixture", factory(pi) {
						for (const [name, parameters] of Object.entries(task.schemas)) pi.registerTool({ name, label: name, description: `Controlled trial fixture: ${name}`, parameters, executionMode: "sequential",
							async execute(_id, args) { const value = task.execute(name, args); return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; } });
					} },
				],
			});
			await loader.reload();
			assert.equal(loader.getExtensions().errors.length, 0, "isolated extensions must load");
			({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel, resourceLoader: loader, settingsManager: settings,
				sessionManager: SessionManager.create(cwd, sessionDir), sessionStartEvent: { type: "session_start", reason: "new" },
				tools: [...Object.keys(task.schemas), ...(condition === "native" ? [] : ["read_state", "patch_state"])] }));
			await session.bindExtensions({ mode: "json", uiContext: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } } });
			result.tools = session.getActiveToolNames();
			assert.deepEqual([...result.tools].sort(), [...Object.keys(task.schemas), ...(condition === "native" ? [] : ["read_state", "patch_state"])].sort(), "no unrestricted tools may enter the trial");
			const stream = session.agent.streamFunction;
			session.agent.streamFunction = (selected, context, options) => {
				if (++current.requestsAttempted > limits.requestsPerRun) { current.failure = "request-limit"; throw new Error("Semantic trial request limit"); }
				const bytes = Buffer.from(JSON.stringify(context.messages));
				let prefix = 0;
				if (current.previous) while (prefix < Math.min(current.previous.length, bytes.length) && current.previous[prefix] === bytes[prefix]) prefix++;
				current.requests.push({ model: { provider: selected.provider, id: selected.id, api: selected.api }, contextBytes: bytes.length, sharedPrefixBytes: current.previous ? prefix : null,
					systemDigest: identity(context.messages.filter((message) => message.role === "system")),
					toolsDigest: identity(context.tools ?? context.messages.filter((message) => message.role === "system").flatMap((message) => message.tools ?? [])),
					priorUserPromptsVisible: prompts.slice(0, current.run - 1).filter((prompt) => context.messages.some((message) => message.role === "user" && textOf(message) === prompt)).length,
					stateFlowHeads: context.messages.filter((message) => message.role === "user" && /State Flow (runtime context|passive memory|exit handoff)/.test(textOf(message))).length });
				current.previous = bytes;
				return stream(selected, context, { ...options, maxTokens: limits.outputTokensPerRequest });
			};
			session.subscribe((event) => {
				if (!current) return;
				if (event.type === "tool_execution_start") current.calls.push({ id: event.toolCallId, name: event.toolName, args: structuredClone(event.args) });
				if (event.type === "tool_execution_end") current.results.push({ id: event.toolCallId, name: event.toolName, isError: event.isError,
					...(Object.hasOwn(task.schemas, event.toolName) ? { value: structuredClone(event.result.details) } : { noop: event.result.details?.changed === false }) });
				if (["auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end"].includes(event.type)) current.events.push(event.type);
			});
			for (const [index, prompt] of prompts.entries()) {
				current = { run: index + 1, requestsAttempted: 0, requests: [], calls: [], results: [], events: [], failure: null };
				result.runs.push(current);
				if (calibration) calibration.prepare(condition, index);
				const started = performance.now();
				const prior = session.getSessionStats();
				const ownedRun = current;
				let aborting;
				const timer = setTimeout(() => { ownedRun.failure = "timeout"; aborting = session.abort(); }, limits.timeoutMs);
				try { await session.prompt(prompt); } catch { current.failure ??= "prompt-error"; }
				finally { clearTimeout(timer); if (aborting) await aborting; delete current.previous; }
				current.ms = performance.now() - started;
				const terminal = session.messages.at(-1);
				current.stopReason = terminal?.role === "assistant" ? terminal.stopReason : null;
				current.reportedModel = terminal?.role === "assistant" ? { provider: terminal.provider, id: terminal.model } : null;
				if (current.stopReason !== "stop") current.failure ??= "assistant-not-complete";
				current.answer = terminal?.role === "assistant" ? textOf(terminal) : null;
				const stats = session.getSessionStats();
				current.usage = { tokens: Object.fromEntries(Object.keys(stats.tokens).map((key) => [key, stats.tokens[key] - prior.tokens[key]])), sdkEstimatedCost: stats.cost - prior.cost };
				current.fixture = task.snapshot();
				current.semantic = condition === "native" ? null : await semanticSnapshot(cwd, session.sessionManager, store);
				if (current.failure) { result.status = report.status = "incomplete"; break; }
			}
		} catch { result.failure = "setup-or-observation-error"; result.status = report.status = "incomplete"; }
		finally {
			try { if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			catch { result.failure = "shutdown-error"; result.status = report.status = "incomplete"; }
			finally {
				session?.dispose();
				try { rmSync(directory, { recursive: true, force: true }); result.cleanup = !existsSync(directory); }
				catch { result.failure = "cleanup-error"; result.status = report.status = "incomplete"; }
			}
		}
		report.conditions.push(result);
	}
	report.sourceUnchanged = before.digest === sourceIdentity().digest;
	if (!report.sourceUnchanged) report.status = "incomplete";
	return report;
}

function calibrationResponses(condition, run) {
	const memory = condition !== "native";
	const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const patch = (value) => tool("patch_state", { session: value });
	const strategy = { requirement: "Offline without credentials", phases: ["prepare", "validate"], decision: "Default bundled verifier v1",
		rejected: { online_only: "Cannot satisfy offline requirement" }, assumption: "Default verifier is self-contained" };
	return [
		[...(memory ? [patch({ intents: { release: { outcome: "Prepare offline bundle", context: { $ref: "session.tactics.release" } } }, strategy: { release: strategy }, tactics: { release: { next: "Prepare default bundle" } } })] : []), fauxAssistantMessage("Accepted: prepare default v1, then validate; offline without credentials; online-only rejected. Reconsider if network isolation fails.")],
		[tool("prepare_bundle", { trustIndex: "default" }), ...(memory ? [patch({ tactics: { release: { progress: "Prepared", next: "Run isolation check" } } })] : []), fauxAssistantMessage("Prepared default bundle. Isolation validation remains pending.")],
		[tool("validate_bundle", { check: "isolation" }), tool("inspect_fixture", { target: "verifier" }), tool("inspect_fixture", { target: "embedded-index" }),
			...(memory ? [patch({ strategy: { release: { decision: "Use embedded index", rejected: { default_v1: "Isolation check observed remote index request" } } }, tactics: { release: { failure: "Remote index request", next: "Prepare embedded bundle and validate" } } })] : []),
			fauxAssistantMessage("Isolation failed: default v1 requests a remote index. Local-index capability supports embedded preparation; offline requirement remains. Revalidation pending.")],
		[tool("prepare_bundle", { trustIndex: "embedded" }), tool("validate_bundle", { check: "isolation" }), tool("validate_bundle", { check: "coverage" }),
			...(memory ? [patch({ strategy: { release: { conclusion: "Embedded isolation and coverage checks passed" } }, intents: { release: null } })] : []),
			fauxAssistantMessage("Embedded bundle passed isolation and coverage without credentials. Default remote index was rejected; commitment complete.")],
	][run];
}

export async function calibrateSemanticTrial(limits = { requestsPerRun: 8, outputTokensPerRequest: 2048, timeoutMs: 20000 }) {
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "semantic-memory-calibration" });
	runtime.registerNativeProvider(faux.provider);
	const observedOutputLimits = [];
	const report = await runSemanticTrial({ modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", limits,
		calibration: { faux, prepare(condition, run) { faux.setResponses(calibrationResponses(condition, run).map((response) => (_context, options) => {
			observedOutputLimits.push(options?.maxTokens);
			return response;
		})); } } });
	report.calibration = { providerCalls: faux.state.callCount, outputLimitsForwarded: observedOutputLimits.every((limit) => limit === limits.outputTokensPerRequest) };
	if (report.status === "complete") {
		for (const condition of report.conditions) {
			assert.equal(condition.runs.length, 4);
			assert.equal(condition.cleanup, true);
			assert.equal(condition.runs.at(-1).fixture.taskSuccess, true);
			assert.equal(condition.runs.flatMap((run) => run.requests).length, condition.condition === "native" ? 11 : 15);
			assert.equal(condition.runs[2].fixture.receipts[0].passed, false, "a failed fixture check is valid negative evidence");
			assert.equal(condition.runs[3].requests[0].priorUserPromptsVisible, condition.condition === "active" ? 0 : 3);
			assert.ok(condition.runs.every((run) => run.results.every((result) => !result.isError)), "scripted tools must actually complete");
			if (condition.condition !== "native") {
				const last = condition.runs.at(-1).semantic.state.session;
				assert.equal(last.intents, undefined);
				assert.equal(last.tactics, undefined);
				assert.equal(last.strategy.release.requirement, "Offline without credentials");
				assert.equal(last.strategy.release.rejected.online_only, "Cannot satisfy offline requirement");
				assert.equal(last.strategy.release.rejected.default_v1, "Isolation check observed remote index request");
				assert.equal(last.strategy.release.conclusion, "Embedded isolation and coverage checks passed");
				assert.equal(condition.runs[2].semantic.state.session.tactics.release.failure, "Remote index request");
				for (const run of condition.runs) assert.equal(run.semantic.state.session.response !== undefined, condition.condition === "active");
			}
		}
		assert.equal(faux.state.callCount, 41, "provider assertions alone are not completion proof");
		assert.equal(report.calibration.outputLimitsForwarded, true, "the stream wrapper must forward the output limit");
	}
	return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const args = process.argv.slice(2);
	assert.equal(args.shift(), "--calibrate", "CLI supports only --calibrate; live use requires an authorized caller-supplied SDK runtime");
	let output;
	const limits = { requestsPerRun: 8, outputTokensPerRequest: 2048, timeoutMs: 20000 };
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index], value = args[index + 1];
		assert.ok(value, "each calibration option needs a value");
		if (key === "--report") output = resolve(value);
		else { assert.equal(key, "--request-limit", "unknown calibration option"); limits.requestsPerRun = Number(value); }
	}
	const report = await calibrateSemanticTrial(limits);
	console.log(JSON.stringify(report));
	if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	if (report.status !== "complete") process.exitCode = 1;
}
