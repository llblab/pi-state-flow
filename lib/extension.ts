import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ArtifactReadTracker } from "./acquisition.ts";
import {
  classifyArtifactCompilationNeed,
  inspectRegisteredArtifactPaths,
  ORDINARY_ARTIFACT_COMPILER,
  sameArtifactSourceFingerprint,
  type ArtifactInvalidationRequest,
} from "./artifact.ts";
import { hasCompactionSizedTranscript, planStateFlowCompaction, shouldRequestStateFlowCompaction, stateFlowCompactionResult, type StateFlowCompactionPlan } from "./compaction.ts";
import { loadStateFlowConfig } from "./config.ts";
import { createPassiveContinuation, currentRunTrajectory, lazyNavigationHint, passiveContinuationMessages, projectSystemProtocol, runtimeContextMessage, syntheticUser, type PassiveContinuation } from "./context.ts";
import { readNativeSessionHeader } from "./continuation.ts";
import {
  cwdScopeKey,
  resolveSessionAddress,
  sessionScopeKey,
  type SessionAddress,
} from "./durable.ts";
import { completeRun, prepareRun, resumeEpisode, startEpisode, stopEpisode } from "./episode.ts";
import { backupCurrentStateFlowFiles } from "./git.ts";
import { projectRecentTransitionsWithLimit } from "./history.ts";
import { isObject, presentationJson, sameJson, type JsonObject } from "./json.ts";
import { StateFlowDiagnosticWriter, stateFlowLogPath, type DiagnosticExtras, type StateFlowDiagnosticCategory } from "./logging.ts";
import { assistantToolCallCount, finalizedAssistantResponse, formatPatchStateArguments, PASSIVE_MEMORY_PROTOCOL, separatedFailure, separatedOutput, stateFlowProtocol } from "./protocol.ts";
import { readProjectedState, readStatePath } from "./query.ts";
import { recoverSnapshot } from "./recovery.ts";
import type { RehydrationPhase } from "./rehydration.ts";
import { SharedScopeRemovalConflictError, TemporalRuntime, type RuntimePublication } from "./runtime.ts";
import { discoverSnapshotData, findAssistantToolBatch, findPassiveStopBoundary, hasPriorConversation, isNewSession, retainsPhysicalSessionProjection, SNAPSHOT_ENTRY_TYPE } from "./session.ts";
import { SkillReadTracker } from "./skills.ts";
import { emptySnapshot, migrationFailure, type Snapshot } from "./snapshot.ts";
import { emptyState, overlayStates, projectStateForModel, type AtomicScopePatches, type MaterializedState, type ModelState, type ScopedStates, type StateScope } from "./state.ts";
import { compactStatus, detailedStatus, STATUS_KEY, type StatusDiagnostics } from "./status.ts";
import { createStateFlowTelegramAdapter, type StateFlowTelegramControlResult, type StateFlowTelegramLoader } from "./telegram.ts";
import { commitScopedTransition, stageAtomicScopePatches, stageScopedTransition, type StagedScopedTransition } from "./transition.ts";

export interface StateFlowExtensionOptions {
	agentDir?: string;
	repositoryRoot?: string;
	onRuntime?: (accessor: { read(offset?: number, scope?: StateScope): ModelState }) => void;
	telegram?: { load?: StateFlowTelegramLoader };
	/** Test/SDK capability override; repository config remains the Pi default. */
	passive?: { bootstrap?: boolean; tools?: boolean };
}

export { formatPatchStateArguments };

export const PATCH_STATE_TOOL_NAME = "patch_state";
export const READ_STATE_TOOL_NAME = "read_state";
const PASSIVE_STOP_ENTRY_TYPE = "state-flow-passive-stop";

export default function stateFlowExtension(pi: ExtensionAPI, options: StateFlowExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const loadedConfig = loadStateFlowConfig(agentDir, options.repositoryRoot);
	const config = {
		...loadedConfig,
		passiveBootstrap: options.passive?.bootstrap ?? loadedConfig.passiveBootstrap,
		passiveTools: options.passive?.tools ?? loadedConfig.passiveTools,
	};
	let snapshot: Snapshot = emptySnapshot();
	let scopeStates: ScopedStates = { global: emptyState(), cwd: emptyState(), session: emptyState() };
	let branchHasSnapshot = false;
	let branchStartsWithoutRuntime = false;
	let forkInitialization = false;
	let responseAwaitingReconciliation = false;
	let completedRunAccepted = false;
	let turnAcceptedForBackup = false;
	let compactionPlan: StateFlowCompactionPlan | undefined;
	let compactionInFlight = false;
	let compactionStopped = false;
	const compactionMarker = `state-flow-boundary:${randomUUID()}`;
	let passiveContinuation: PassiveContinuation | undefined;
	let bootstrapContinuation: PassiveContinuation | undefined;
	let artifactRefreshPending = false;
	let runAnchorTimestamp: number | undefined;
	let runtime: TemporalRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let rehydrationPhase: RehydrationPhase | undefined;
	const repositoryRoot = resolve(options.repositoryRoot ?? config.directory);
	const diagnosticWriter = new StateFlowDiagnosticWriter(config.logging, stateFlowLogPath(agentDir), repositoryRoot, (message) => activeContext?.ui.notify(message, "warning"));
	let backupPending = false;
	const skillReads = new SkillReadTracker();
	const artifactReads = new ArtifactReadTracker();
	let artifactInvalidations: ArtifactInvalidationRequest[] = [];
	let artifactHints: Record<string, string> = {};
	const SOURCE_CHANGED_HINT = "Source changed since this artifact was compiled. Read and recompile it before relying on it.";
	let telegramStartPending = false;

	function sessionAddress(ctx: ExtensionContext): SessionAddress {
		return resolveSessionAddress(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp);
	}

	function createRuntime(ctx: ExtensionContext): TemporalRuntime {
		return new TemporalRuntime(ctx.cwd, sessionAddress(ctx), repositoryRoot, undefined, config.historyLimit);
	}

	function projectModelState(state: MaterializedState): ModelState {
		return projectStateForModel(state, artifactHints);
	}

	function assertSelectedBranchAvailable(): void {
		if (snapshot.meta.validation?.attempt === 0) {
			throw new Error(`State Flow selected branch is unavailable: ${snapshot.meta.validation.error}. Restore its canonical files and retry /state-flow-start, or select a retained boundary.`);
		}
	}

	options.onRuntime?.({ read: (offset, scope) => {
		if (scope === "session") assertSelectedBranchAvailable();
		if (!runtime) throw new Error("State Flow temporal runtime is unavailable");
		return projectModelState(runtime.read(offset, scope));
	} });

	function persist(): void {
		assertSelectedBranchAvailable();
		const previousView = runtime?.view;
		const publication = !branchStartsWithoutRuntime && runtime?.view ? runtime.publish(snapshot, false, undefined) : undefined;
		if (runtime?.view !== previousView) installScopeStates();
		if (publication && activeContext) recordPublication(publication, activeContext);
		const checkpoint = branchStartsWithoutRuntime ? { disabled: true } : runtime?.retainedCheckpoint(snapshot) ?? { disabled: true };
		if ("disabled" in checkpoint && !branchStartsWithoutRuntime) {
			throw new Error("State Flow cannot checkpoint an unproven branch as ordinary disabled; restore a valid checkpoint first");
		}
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, checkpoint);
		if ("boundary" in checkpoint) branchStartsWithoutRuntime = false;
	}

	function updateUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, compactStatus(snapshot, (color, text) => ctx.ui.theme.fg(color, text)));
	}

	function clearRunTransient(): void {
		responseAwaitingReconciliation = false;
		completedRunAccepted = false;
		turnAcceptedForBackup = false;
		compactionPlan = undefined;
		compactionInFlight = false;
		skillReads.clear();
		artifactReads.clear();
	}

	function deferArtifactRefresh(): void {
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = true;
	}

	function refreshArtifactHints(): void {
		if (!runtime?.view) {
			artifactHints = {};
			artifactInvalidations = [];
			artifactReads.setCandidates([]);
			return;
		}
		const paths = new Set<string>();
		for (const scope of ["global", "cwd", "session"] as const) for (const path of Object.keys(scopeStates[scope].artifacts)) paths.add(path);
		const observations = new Map(inspectRegisteredArtifactPaths(paths).map((observation) => [observation.path, observation]));
		const nextHints: Record<string, string> = {};
		const nextInvalidations = new Map<string, ArtifactInvalidationRequest>();
		for (const scope of ["global", "cwd", "session"] as const) {
			const provenance = runtime.artifactProvenance(scope);
			for (const [path, metadata] of Object.entries(scopeStates[scope].artifacts)) {
				delete nextHints[path];
				nextInvalidations.delete(path);
				if (metadata.kind === "skill") continue;
				const observed = observations.get(path);
				if (observed?.kind !== "present") continue;
				const need = classifyArtifactCompilationNeed({ path, scope, sourceFingerprint: observed.fingerprint }, metadata, ORDINARY_ARTIFACT_COMPILER, false, provenance[path]);
				if (need.kind !== "requires-compilation") continue;
				if (need.reason === "source-changed") nextHints[path] = SOURCE_CHANGED_HINT;
				nextInvalidations.set(path, { path, scope, reason: need.reason });
			}
		}
		artifactHints = nextHints;
		artifactInvalidations = [...nextInvalidations.values()].sort((left, right) => left.path.localeCompare(right.path));
		artifactReads.setCandidates(artifactInvalidations);
	}

	function removeMissingRegisteredArtifacts(ctx: ExtensionContext): void {
		if (!snapshot.config.enabled || !runtime?.view) return;
		const owners = new Map<string, StateScope[]>();
		for (const scope of ["global", "cwd", "session"] as const) for (const path of Object.keys(scopeStates[scope].artifacts)) {
			owners.set(path, [...owners.get(path) ?? [], scope]);
		}
		const removals: AtomicScopePatches = {};
		for (const observation of inspectRegisteredArtifactPaths(owners.keys())) {
			if (observation.kind !== "missing") continue;
			for (const scope of owners.get(observation.path) ?? []) {
				const artifacts = (removals[scope]?.artifacts ?? {}) as JsonObject;
				removals[scope] = { ...(removals[scope] ?? {}), artifacts: { ...artifacts, [observation.path]: null } };
			}
		}
		if (Object.keys(removals).length > 0) {
			const stage = stageAtomicScopePatches(scopeStates, removals, [], runtime.causalBasis());
			commitStage(stage, ctx, false);
		}
		refreshArtifactHints();
	}


	function installScopeStates(): void {
		scopeStates = runtime?.view ? runtime.states() : { global: emptyState(), cwd: emptyState(), session: emptyState() };
	}

	function passiveToolsAvailable(): boolean {
		return snapshot.config.enabled || config.passiveTools;
	}

	function syncStateFlowTools(): void {
		const active = pi.getActiveTools();
		const owned = [PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME];
		const available = passiveToolsAvailable();
		if (owned.every((name) => active.includes(name) === available)) return;
		pi.setActiveTools(available
			? [...new Set([...active, ...owned])]
			: active.filter((name) => !owned.includes(name)));
	}

	function recordPublication(_publication: RuntimePublication, _ctx: ExtensionContext): void {
		// A passive view is not runtime authority; only accepted canonical publication establishes it.
		branchStartsWithoutRuntime = false;
		backupPending = true;
	}

	/** Record accepted lifecycle persistence; Git backup is scheduled only after an accepted turn settles. */
	function recordPolicyPublication(publication: RuntimePublication | undefined, ctx: ExtensionContext): void {
		if (publication) recordPublication(publication, ctx);
	}

	function commitStage(stage: StagedScopedTransition, ctx: ExtensionContext, finalizeRun: boolean): boolean {
		const acquiredArtifactPaths = new Set(artifactReads.successful.keys());
		let committed: boolean;
		try {
			committed = commitScopedTransition(snapshot, scopeStates, stage, (accepted, nextSnapshot) => {
				if (!runtime?.view) throw new Error("Temporal State Flow runtime is unavailable; reload before publishing");
				const publication = runtime.publish(nextSnapshot, accepted !== undefined, accepted, {
					provenance: stage.provenanceUpdates,
				});
				if (publication) recordPublication(publication, ctx);
			}, runtime!.causalBasis(), { finalizeRun });
		} catch (error) {
			if (error instanceof SharedScopeRemovalConflictError) installScopeStates();
			throw error;
		}
		if (!committed) return false;
		installScopeStates();
		artifactInvalidations = artifactInvalidations.filter(({ path }) => !acquiredArtifactPaths.has(path));
		artifactReads.setCandidates(artifactInvalidations);
		skillReads.clear();
		artifactReads.clear();
		persist();
		return true;
	}


	function currentRehydrationPhase(): RehydrationPhase | undefined {
		return rehydrationPhase;
	}

	function statusDiagnostics(ctx: ExtensionContext): StatusDiagnostics {
		const cwd = ctx.cwd;
		const diagnosticStates = scopeStates;
		const view = runtime?.view;
		const diagnosticRecent = runtime?.recent() ?? [];
		const durableStateError = snapshot.meta.validation?.attempt === 0 ? snapshot.meta.validation.error
			: view ? undefined : "no temporal runtime is selected on this branch";

		const staleArtifacts: StatusDiagnostics["staleArtifacts"] = durableStateError === undefined
			? artifactInvalidations.map(({ path, scope, reason }) => ({ scope: scope ?? "global", path, reason }))
			: [];
		const session = sessionAddress(ctx);
		return {
			repositoryRoot,
			cwdScopeKey: cwdScopeKey(cwd),
			sessionScopeKey: sessionScopeKey(session.key),
			scopeStates: diagnosticStates,
			recent: diagnosticRecent,
			historyLimit: config.historyLimit,
			...(view === undefined ? {} : { temporal: {
				head: structuredClone(view.lineage.at(-1)!),
				historyDepth: view.lineage.length - 1,
				tailCounts: { global: view.scopes.global.patches.length, cwd: view.scopes.cwd.patches.length, session: view.scopes.session.patches.length },
			} }),
			staleArtifacts,
			...(durableStateError === undefined ? {} : { durableStateError }),
		};
	}

	function forkSource(ctx: ExtensionContext): SessionAddress {
		const file = ctx.sessionManager.getHeader()?.parentSession;
		if (typeof file !== "string" || !isAbsolute(file)) throw new Error("State Flow fork requires a persisted native parent session");
		const parent = readNativeSessionHeader(file);
		if (parent.cwd !== resolve(ctx.cwd)) throw new Error("State Flow fork parent CWD identity mismatch");
		return resolveSessionAddress(parent.file, parent.id, parent.timestamp);
	}

	function restoreActiveBranch(ctx: ExtensionContext, sessionStartReason?: unknown): void {
		clearRunTransient();
		passiveContinuation = undefined;
		bootstrapContinuation = undefined;
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = false;
		telegramStartPending = false;
		activeContext = ctx;
		const session = sessionAddress(ctx);
		runtime = new TemporalRuntime(ctx.cwd, session, repositoryRoot, undefined, config.historyLimit);
		installScopeStates();
		branchHasSnapshot = false;
		branchStartsWithoutRuntime = false;
		forkInitialization = sessionStartReason === "fork";
		try {
			const branch = ctx.sessionManager.getBranch();
			const discovery = discoverSnapshotData(branch);
			let restoreSelected: (() => Snapshot) | undefined;
			const recovery = recoverSnapshot(discovery.candidates, (checkpoint) => {
				if (forkInitialization) {
					const prepared = runtime!.prepareBoundaryFork(forkSource(ctx), checkpoint);
					restoreSelected = () => {
						const accepted = prepared.fork();
						snapshot = accepted.snapshot;
						recordPolicyPublication(accepted.publication, ctx);
						pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, { reset: true, owner: ctx.sessionManager.getSessionId() });
						forkInitialization = false;
						return snapshot;
					};
					return prepared.snapshot;
				}
				const prepared = runtime!.prepareBoundaryRestore(checkpoint);
				restoreSelected = () => {
					const restored = prepared.restore();
					const publication = runtime!.acceptRestoredOrigin(restored);
					recordPolicyPublication(publication, ctx);
					return restored;
				};
				return prepared.snapshot;
			});
			branchStartsWithoutRuntime = recovery.disabledMarker === true
				|| (discovery.candidates.length === 0 && discovery.errors.length === 0);
			const skipped = discovery.errors.length + recovery.skipped.length;
			branchHasSnapshot = recovery.skipped.length < discovery.candidates.length;
			if (discovery.candidates.length === 0 && discovery.errors.length > 0) {
				snapshot = migrationFailure({}, `Snapshot restoration failed: ${discovery.errors[0]}`);
			} else if (discovery.candidates.length > 0) {
				snapshot = recovery.snapshot;
				if (branchHasSnapshot && restoreSelected) {
					snapshot = restoreSelected();
					persist();
				} else if (branchHasSnapshot && snapshot.config.enabled) {
					const publication = runtime.initialize(snapshot, true);
					recordPolicyPublication(publication, ctx);
				}
				installScopeStates();
			} else if (config.autoStart && isNewSession(sessionStartReason, branch)) {
				snapshot = startEpisode(hasPriorConversation(branch));
				runtime.prepare();
				const initialization = runtime.initialize(snapshot, true);
				recordPolicyPublication(initialization, ctx);
				if (!runtime.view) snapshot = emptySnapshot();
				installScopeStates();
				if (snapshot.config.enabled) {
					branchHasSnapshot = true;
					persist();
				}
			} else {
				snapshot = emptySnapshot();
				installScopeStates();
			}
			if (snapshot.config.enabled && skipped > 0) {
				ctx.ui.notify(`State Flow recovered the previous valid snapshot after skipping ${skipped} malformed newer snapshot(s).`, "warning");
			}
		} catch (error) {
			const failure = migrationFailure({}, `Snapshot restoration failed: ${error instanceof Error ? error.message : String(error)}`);
			snapshot = {
				...snapshot,
				config: { ...snapshot.config, enabled: false },
				meta: { ...snapshot.meta, validation: failure.meta.validation },
			};
		}
		if (!snapshot.config.enabled && snapshot.meta.validation?.attempt === 0) {
			// A failed acceptance may have installed a prepared view; only shared passive reads may survive.
			runtime = createRuntime(ctx);
			installScopeStates();
			ctx.ui.notify(`State Flow restored disabled: ${snapshot.meta.validation.error}`, "error");
		}
		if (retainsPhysicalSessionProjection(sessionStartReason) && runtime?.view) {
			const boundary = findPassiveStopBoundary(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), PASSIVE_STOP_ENTRY_TYPE);
			if (boundary !== undefined) {
				const continuation = createPassiveContinuation(
					projectModelState(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
					boundary.at,
					boundary.from,
				);
				if (!snapshot.config.enabled) passiveContinuation = continuation;
				else if (snapshot.meta.bootstrap) bootstrapContinuation = continuation;
			}
		}
		if (!snapshot.config.enabled && (config.passiveBootstrap || config.passiveTools) && !runtime?.view) {
			try {
				runtime?.loadPassive();
				installScopeStates();
			} catch (error) {
				ctx.ui.notify(`State Flow passive memory is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		if (snapshot.config.enabled) deferArtifactRefresh();
		syncStateFlowTools();
		updateUi(ctx);
	}

	function recordDiagnostic(error: string, category: StateFlowDiagnosticCategory, ctx: ExtensionContext, extras: DiagnosticExtras = {}): void {
		diagnosticWriter.record(sessionAddress(ctx).id, ctx.cwd, error, category, extras);
	}

	pi.registerTool({
		name: READ_STATE_TOOL_NAME,
		label: "Read State",
		description: "Read exact State Flow values or historical semantic patches with one path or an ordered path list. Unscoped semantic paths read the effective overlay; effective makes that overlay explicit, while global, cwd, and session select ownership. Array selectors support zero-based indices and half-open [start..end] ranges. Projection value returns semantic data; keys returns minimal structure; patch intersects the selected path at its boundary.",
		promptSnippet: "Read exact state values, structures, or historical semantic patches",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "One semantic path; unscoped paths use effective, explicit roots may use effective/global/cwd/session and historical [N], and arrays support half-open [start..end] ranges" })),
			paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Ordered query paths evaluated as one all-or-error read" })),
			projection: Type.Optional(StringEnum(["value", "keys", "patch"] as const, { description: "Value snapshot by default, structural keys with minimal meta, or the selected historical semantic patch" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal) {
			try {
				type ReadDetails = { path?: string; paths?: string[]; projection?: string; transitionId?: string };
				if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
				if (signal?.aborted) throw new Error("State Flow read was aborted");
				if (!runtime?.view) throw new Error("State Flow temporal runtime is unavailable");
				if (params.path === undefined && params.paths === undefined) throw new Error("read_state requires path or paths");
				if (params.path !== undefined && params.paths !== undefined) throw new Error("read_state accepts path or paths, not both");
				{
					const paths = params.paths ?? [params.path!];
					if (paths.some((path) => /^session(?:\.|\[|$)/.test(path))) assertSelectedBranchAvailable();
					if (paths.length === 1 && /^(?:global|cwd|session)\.patches(?:\[\d+\])?$/.test(paths[0]!)) {
						if (params.projection !== undefined && params.projection !== "value") throw new Error("Scope patch paths support only the value projection");
						const result = readStatePath(runtime.view, paths[0]!, config.historyLimit);
						if (!("patch" in result)) throw new Error("Expected a scope patch path");
						return {
							content: [{ type: "text", text: `\n${JSON.stringify({ patch: result.patch })}` }],
							details: { path: paths[0], transitionId: result.boundary.id } as ReadDetails,
						};
					}
					const result = readProjectedState(runtime.view, paths, params.projection, config.historyLimit);
					return {
						content: [{ type: "text", text: `\n${JSON.stringify(result)}` }],
						details: { ...(params.path === undefined ? { paths } : { path: params.path }), projection: params.projection ?? "value" } as ReadDetails,
					};
				}
			} catch (error) {
				throw separatedFailure(error);
			}
		},
	});

	pi.registerTool({
		name: PATCH_STATE_TOOL_NAME,
		label: "Patch State",
		description: "The sole State Flow semantic mutation protocol. Supply one or more global, cwd, or session patches; all supplied scopes commit atomically. This call must be the only State Flow barrier in its assistant response.",
		promptSnippet: "Atomically patch one or more global/cwd/session scopes",
		promptGuidelines: [
			"Use patch_state only for material durable semantic changes; ordinary answers need no finalization call.",
			"Use patch_state as reconciliation, not append-only notes: place new knowledge at the narrowest valid scope and remove superseded or completed state from touched branches.",
			"Call patch_state alone in an assistant response; after its acknowledgement, further reasoning, tools, and later patch_state calls remain allowed.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			global: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional global semantic patch" })),
			cwd: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional project semantic patch" })),
			session: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional session semantic patch" })),
		}, { additionalProperties: false }),
		renderResult(result, { isPartial }, theme, context) {
			const text = result.content.find((block) => block.type === "text")?.text ?? "";
			if (context.isError) return new Text(separatedOutput(text), 0, 0);
			if (isPartial || !config.showSuccessfulPatches) return new Text(text, 0, 0);
			return new Text(separatedOutput(theme.fg("dim", formatPatchStateArguments(context.args))), 0, 0);
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (!passiveToolsAvailable()) throw new Error("State Flow tools are disabled by configuration");
				assertSelectedBranchAvailable();
				if (signal?.aborted) throw new Error("State Flow patch was aborted before materialization");
				if (!isObject(params)) throw new Error("patch_state requires an object");
				const allowed = new Set(["global", "cwd", "session"]);
				for (const key of Object.keys(params)) {
					if (!allowed.has(key)) throw new Error(`patch_state does not accept field ${key}`);
				}
				const patches: AtomicScopePatches = {};
				for (const scope of ["global", "cwd", "session"] as const) {
					if (!Object.hasOwn(params, scope)) continue;
					const patch = params[scope];
					if (!isObject(patch)) throw new Error(`patch_state ${scope} must be a semantic patch object`);
					if (Object.keys(patch).length === 0) throw new Error(`patch_state ${scope} cannot be empty; omit it when unchanged`);
					patches[scope] = patch;
				}
				const scopes = Object.keys(patches) as StateScope[];
				if (scopes.length === 0) throw new Error("patch_state requires at least one materially changed scope patch");
				if (!runtime?.view) {
					runtime ??= createRuntime(ctx);
					runtime.prepare();
					const publication = runtime.initialize(snapshot, true, undefined, true);
					recordPolicyPublication(publication, ctx);
					installScopeStates();
					branchHasSnapshot = true;
				}
				installScopeStates();
				for (const acquired of artifactReads.successful.values()) {
					const observation = inspectRegisteredArtifactPaths([acquired.path])[0];
					if (acquired.sourceFingerprint === undefined || observation?.kind !== "present"
						|| !sameArtifactSourceFingerprint(acquired.sourceFingerprint, observation.fingerprint)) {
						throw new Error(`Artifact source changed after acquisition: ${acquired.path}`);
					}
				}
				const stage = stageAtomicScopePatches(scopeStates, patches, skillReads.successful.values(), runtime.causalBasis(), artifactReads.successful.values());
				const semanticChange = (["global", "cwd", "session"] as const).some((scope) => !sameJson(scopeStates[scope], stage.nextStates[scope]));
				const provenanceChange = Object.values(stage.provenanceUpdates).some((updates) => Object.keys(updates).length > 0);
				if (!semanticChange && !provenanceChange) throw new Error("patch_state scope patches must materially update state or required provenance");
				commitStage(stage, ctx, false);
				updateUi(ctx);
				return { content: [{ type: "text", text: `\nState materialized atomically at ${scopes.join("+")} scope${scopes.length === 1 ? "" : "s"}.` }], details: { scopes, step: snapshot.meta.step } };
			} catch (error) {
				let attempted: unknown;
				try { attempted = structuredClone(params); } catch { attempted = undefined; }
				recordDiagnostic(error instanceof Error ? error.message : String(error), /concurrently|advanced/.test(String(error)) ? "publication-conflict" : "invalid-patch", ctx, {
					input: attempted,
					tool: PATCH_STATE_TOOL_NAME,
					toolCallId,
				});
				throw separatedFailure(error);
			}
		},
	});

	function startStateFlow(ctx: ExtensionContext): StateFlowTelegramControlResult {
		if (!activeContext) restoreActiveBranch(ctx);
		telegramStartPending = false;
		const previousSnapshot = structuredClone(snapshot);
		const previousPassiveContinuation = passiveContinuation;
		const previousBootstrapContinuation = bootstrapContinuation;
		const previousArtifactRefreshPending = artifactRefreshPending;
		const previousArtifactInvalidations = structuredClone(artifactInvalidations);
		try {
			if (!branchStartsWithoutRuntime && (!runtime?.view || snapshot.meta.validation?.attempt === 0)) {
				const retryFork = forkInitialization;
				restoreActiveBranch(ctx, retryFork ? "fork" : undefined);
			}
			assertSelectedBranchAvailable();
			if (!runtime?.view && !branchStartsWithoutRuntime) throw new Error("Selected State Flow boundary is unavailable; restore its canonical files before starting State Flow");
			const branch = ctx.sessionManager.getBranch();
			activeContext = ctx;
			runtime ??= createRuntime(ctx);
			if (branchStartsWithoutRuntime) runtime.prepare();
			const bootstrap = (!branchHasSnapshot || !snapshot.config.enabled)
				&& (hasPriorConversation(branch) || previousPassiveContinuation !== undefined);
			const existingBranch = branchHasSnapshot;
			snapshot = existingBranch
				? resumeEpisode(snapshot, bootstrap)
				: startEpisode(bootstrap);
			branchHasSnapshot = true;
			// Activation reasserts the selected session stream as a complete cohort. A resumed
			// branch may have no reusable temporal revision after an extension upgrade; a
			// runtime-only write would then reject its selected session as an omitted change.
			const publication = runtime.view
				? runtime.publish(snapshot, true)
				: runtime.initialize(snapshot, true, undefined, branchStartsWithoutRuntime);
			recordPolicyPublication(publication, ctx);
			installScopeStates();
			clearRunTransient();
			passiveContinuation = undefined;
			bootstrapContinuation = snapshot.meta.bootstrap
				? previousPassiveContinuation ?? previousBootstrapContinuation
				: undefined;
			deferArtifactRefresh();
			syncStateFlowTools();
			persist();
			updateUi(ctx);
			ctx.ui.notify(
				snapshot.meta.bootstrap
					? "State Flow enabled. The next complete agent run will migrate active context into state."
					: "State Flow enabled. The next prompt starts a stateful agent run.",
				"info",
			);
			return { ok: true, message: "State Flow enabled" };
		} catch (error) {
			snapshot = previousSnapshot;
			passiveContinuation = previousPassiveContinuation;
			bootstrapContinuation = previousBootstrapContinuation;
			artifactRefreshPending = previousArtifactRefreshPending;
			artifactInvalidations = previousArtifactInvalidations;
			artifactReads.setCandidates(artifactInvalidations);
			syncStateFlowTools();
			const message = `State Flow could not initialize CWD state: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(message, "error");
			return { ok: false, message };
		}
	}

	pi.registerCommand("state-flow-start", {
		description: "Start State Flow mode",
		handler: async (_args, ctx) => {
			startStateFlow(ctx);
		},
	});

	pi.registerCommand("state-flow-status", {
		description: "Show State Flow runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(detailedStatus(snapshot, statusDiagnostics(ctx)), "info");
		},
	});

	function stopStateFlow(ctx: ExtensionContext): StateFlowTelegramControlResult {
		if (!activeContext) restoreActiveBranch(ctx);
		assertSelectedBranchAvailable();
		telegramStartPending = false;
		const current = snapshot;
		const stoppedAt = Date.now();
		const stopped = stopEpisode(current);
		const publication = !branchStartsWithoutRuntime && runtime?.view ? runtime.publish(stopped) : undefined;
		installScopeStates();
		// Freeze the accepted shared adoption, not the pre-publication cache.
		const exitHandoff = current.config.enabled && runtime?.view
			? createPassiveContinuation(
				projectModelState(overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)),
				stoppedAt,
				ctx.isIdle() ? undefined : runAnchorTimestamp,
			)
			: undefined;
		const retainedHandoff = exitHandoff ?? (!current.config.enabled ? passiveContinuation : undefined);
		snapshot = stopped;
		recordPolicyPublication(publication, ctx);
		branchHasSnapshot = true;
		clearRunTransient();
		passiveContinuation = retainedHandoff;
		bootstrapContinuation = undefined;
		artifactInvalidations = [];
		artifactReads.setCandidates([]);
		artifactRefreshPending = false;
		if (exitHandoff) pi.appendEntry(PASSIVE_STOP_ENTRY_TYPE, {
			at: stoppedAt,
			...(exitHandoff.activeRunStartedAt === undefined ? {} : { from: exitHandoff.activeRunStartedAt }),
		});
		syncStateFlowTools();
		persist();
		updateUi(ctx);
		return { ok: true, message: "State Flow disabled" };
	}

	pi.registerCommand("state-flow-stop", {
		description: "Stop State Flow on the current session branch",
		handler: async (_args, ctx) => {
			stopStateFlow(ctx);
		},
	});

	const telegram = createStateFlowTelegramAdapter({
		...(options.telegram?.load === undefined ? {} : { load: options.telegram.load }),
		port: {
			snapshot: () => ({
				enabled: snapshot.config.enabled,
				step: snapshot.meta.step,
				bootstrap: snapshot.meta.bootstrap === true,
				startPending: telegramStartPending,
			}),
			state: (scope) => {
				if (scope === "session") assertSelectedBranchAvailable();
				const selected = scope === "effective"
					? overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session)
					: scopeStates[scope];
				return { ...projectModelState(selected), lazy: structuredClone(selected.lazy) };
			},
			canStartNow: () => activeContext === undefined || activeContext.isIdle(),
			start: () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				return startStateFlow(activeContext);
			},
			stop: () => {
				if (!activeContext) throw new Error("State Flow is not attached to an active session yet");
				try {
					return stopStateFlow(activeContext);
				} catch (error) {
					return { ok: false, message: error instanceof Error ? error.message : String(error) };
				}
			},
			deferStart: () => {
				telegramStartPending = true;
			},
			cancelStart: () => {
				telegramStartPending = false;
			},
		},
	});
	void telegram.ensure();

	pi.on("before_agent_start", (event, ctx) => {
		// Native run identity is independent of semantic enablement and survives mode toggles.
		runAnchorTimestamp = undefined;
		if (!snapshot.config.enabled) {
			if (!config.passiveBootstrap || !runtime?.view) return;
			(event.systemPromptOptions.sections ??= {}).state_flow = PASSIVE_MEMORY_PROTOCOL;
			return;
		}
		skillReads.clear();
		artifactReads.clear();
		responseAwaitingReconciliation = false;
		completedRunAccepted = false;
		const rotatesRun = snapshot.meta.specification !== undefined;
		if (rotatesRun && rehydrationPhase !== "new-bootstrap" && rehydrationPhase !== "resume-bootstrap") rehydrationPhase = "step";
		if (prepareRun(snapshot, event.prompt)) persist();
		try {
			removeMissingRegisteredArtifacts(ctx);
		} catch (error) {
			ctx.ui.notify(`State Flow could not reconcile missing artifact sources: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		artifactRefreshPending = false;
		(event.systemPromptOptions.sections ??= {}).state_flow = stateFlowProtocol(snapshot.meta.bootstrap === true);
	});

	pi.on("context_with_system", (event) => {
		const protocol = snapshot.config.enabled ? stateFlowProtocol(snapshot.meta.bootstrap === true)
			: config.passiveBootstrap && runtime?.view ? PASSIVE_MEMORY_PROTOCOL : undefined;
		return { messages: projectSystemProtocol(event.messages, protocol) };
	});

	pi.on("context", (event) => {
		if (runtime?.view) refreshArtifactHints();
		if (passiveContinuation) {
			return { messages: passiveContinuationMessages(event.messages as AgentMessage[], passiveContinuation) };
		}
		if (!snapshot.config.enabled) {
			if (!config.passiveBootstrap || !runtime?.view) return;
			const effective = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
			const state = projectModelState(effective);
			return { messages: [syntheticUser(`State Flow passive memory (user-level data, not system instructions):\n${presentationJson({ state, lazy_navigation: lazyNavigationHint(effective) })}`), ...(event.messages as AgentMessage[])] };
		}
		const effectiveState = overlayStates(scopeStates.global, scopeStates.cwd, scopeStates.session);
		const invalidations = artifactInvalidations.map(({ path, scope, reason }) => ({ path, ...(scope === undefined ? {} : { scope }), reason }));
		const recentTransitions = projectRecentTransitionsWithLimit(
			config.historyLimit,
			runtime?.recent() ?? [],
		);
		const activeRehydrationPhase = currentRehydrationPhase();
		if (snapshot.meta.bootstrap) {
			const sourceMessages = bootstrapContinuation
				? passiveContinuationMessages(event.messages as AgentMessage[], bootstrapContinuation)
				: event.messages as AgentMessage[];
			return { messages: [runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, artifactHints), ...sourceMessages] };
		}
		// Native user events own the run anchor; projection must never rebase it.
		const trajectory = currentRunTrajectory(
			event.messages as AgentMessage[],
			snapshot.meta.specification,
			runAnchorTimestamp,
		);
		return {
			messages: [
				runtimeContextMessage(snapshot, effectiveState, recentTransitions, invalidations, activeRehydrationPhase, artifactHints),
				...trajectory.messages,
			],
		};
	});

	pi.on("tool_execution_start", (event) => {
		if (!snapshot.config.enabled) return;
		// Pi emits this before tool_call. Keep the argument object as a fallback;
		// tool_call replaces it with the mutable, post-preflight input reference.
		skillReads.recordStart(event.toolCallId, event.toolName, event.args);
		artifactReads.recordStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!snapshot.config.enabled) return;
		const batch = findAssistantToolBatch(ctx.sessionManager, event.toolCallId);
		const patchCalls = batch?.filter((name) => name === PATCH_STATE_TOOL_NAME).length ?? 0;
		if (patchCalls > 0) {
			if (patchCalls !== 1) {
				return {
					block: true,
					reason: "A State Flow barrier response must contain exactly one patch_state call",
				};
			}
			if (event.toolName !== PATCH_STATE_TOOL_NAME) {
				return {
					block: true,
					reason: "Blocked by the patch_state barrier; reconsider this action after State Flow rematerializes context",
				};
			}
		}
		skillReads.recordCall(event.toolCallId, event.toolName, event.input);
		artifactReads.recordCall(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_execution_end", (event) => {
		if (!snapshot.config.enabled) return;
		skillReads.recordEnd(event.toolCallId, event.toolName, event.isError);
		artifactReads.recordEnd(event.toolCallId, event.toolName, event.isError);
	});

	pi.on("message_end", (event, ctx): any => {
		// Observe actual user events even while disabled; Start/Stop cannot invent or erase them.
		if (event.message.role === "user" && runAnchorTimestamp === undefined) runAnchorTimestamp = event.message.timestamp;
		if (!snapshot.config.enabled) return;
		if (event.message.role !== "assistant") return;
		const message = event.message as unknown as { role: "assistant"; stopReason?: string; content?: unknown };
		if (message.stopReason === "aborted" || assistantToolCallCount(message.content) > 0 || message.stopReason === "toolUse") {
			responseAwaitingReconciliation = false;
			return;
		}
		if (message.stopReason === "length" || message.stopReason === "error") {
			responseAwaitingReconciliation = false;
			recordDiagnostic(`Assistant response ended with ${message.stopReason}`, "finalization", ctx, { content: message.content });
			return;
		}
		responseAwaitingReconciliation = true;
	});

	pi.on("turn_end", (event, ctx) => {
		const wasBootstrap = snapshot.meta.bootstrap === true;
		if (!snapshot.config.enabled || !responseAwaitingReconciliation) {
			updateUi(ctx);
			return;
		}
		let responseCommitted = false;
		const specification = snapshot.meta.specification;
		try {
			const response = finalizedAssistantResponse(event.message);
			const stage = stageScopedTransition(scopeStates, { transitions: [], response }, [], runtime!.causalBasis());
			completeRun(snapshot);
			commitStage(stage, ctx, true);
			responseCommitted = true;
			bootstrapContinuation = undefined;
			rehydrationPhase = "step";
			completedRunAccepted = !wasBootstrap;
			turnAcceptedForBackup = true;
		} catch (error) {
			if (!responseCommitted && specification !== undefined) snapshot.meta.specification = specification;
			recordDiagnostic(error instanceof Error ? error.message : String(error), "finalization", ctx);
			ctx.ui.notify(responseCommitted
				? `State Flow accepted the final response; a post-acceptance lifecycle update failed: ${error instanceof Error ? error.message : String(error)}`
				: `State Flow could not reconcile the final response: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			responseAwaitingReconciliation = false;
		}
		updateUi(ctx);
	});

	pi.on("session_before_compact", (event) => {
		if (!compactionPlan) return;
		if (compactionStopped && event.reason === "manual" && event.customInstructions === compactionMarker) return { cancel: true };
		const result = stateFlowCompactionResult(compactionPlan, compactionMarker, event);
		if (result === undefined || "cancel" in result) return result;
		return { compaction: result };
	});

	pi.on("agent_before_settle", (_event, ctx) => {
		if (!turnAcceptedForBackup) return;
		turnAcceptedForBackup = false;
		if (!backupPending) return;
		backupPending = false;
		try {
			if (existsSync(join(repositoryRoot, ".git"))) backupCurrentStateFlowFiles(repositoryRoot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recordDiagnostic(message, "publication-conflict", ctx);
			ctx.ui.notify(`State Flow accepted canonical state; Git backup failed: ${message}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (telegramStartPending && !snapshot.config.enabled) {
			telegramStartPending = false;
			startStateFlow(ctx);
		}
		if (!completedRunAccepted || compactionStopped || !snapshot.config.enabled || snapshot.meta.bootstrap
			|| compactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !runtime?.view
			|| !shouldRequestStateFlowCompaction(ctx.getContextUsage())) return;
		completedRunAccepted = false;
		const entries = ctx.sessionManager.buildContextEntries();
		if (!hasCompactionSizedTranscript(entries)) return;
		const plan = planStateFlowCompaction(entries, runtime.causalBasis(), snapshot.meta.step, runAnchorTimestamp);
		if (!plan) return;
		compactionPlan = plan;
		compactionInFlight = true;
		// Pi dispatches deferred companion prompts after all settled handlers return.
		await new Promise<void>((resolve) => {
			const finished = () => { compactionPlan = undefined; compactionInFlight = false; resolve(); };
			ctx.compact({ customInstructions: compactionMarker, onComplete: finished, onError: finished });
		});
	});

	pi.on("session_start", (event, ctx) => {
		runAnchorTimestamp = undefined;
		rehydrationPhase = event.reason === "resume" ? "resume-bootstrap" : "new-bootstrap";
		restoreActiveBranch(ctx, event.reason);
		updateUi(ctx);
		void telegram.ensure();
	});
	pi.on("session_tree", (_event, ctx) => {
		runAnchorTimestamp = undefined;
		restoreActiveBranch(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		telegramStartPending = false;
		compactionStopped = true;
		completedRunAccepted = false;
		telegram.dispose();
	});
}
