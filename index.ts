export {
	ArtifactReadTracker,
	decideArtifactAcquisition,
	type ArtifactAcquisitionDecision,
	type ArtifactAcquisitionIntent,
	type ArtifactAcquisitionOptions,
	type ArtifactAcquisitionReason,
	type SuccessfulArtifactRead,
} from "./lib/acquisition.ts";
export {
	classifyArtifactFreshness,
	hashArtifactSource,
	isArtifactHash,
	isArtifactMetadata,
	isArtifactRegistry,
	ORDINARY_ARTIFACT_COMPILER,
	planArtifactInvalidation,
	updateArtifactRegistry,
	validateArtifactMetadata,
	validateArtifactRegistry,
	type ArtifactCompilationUpdate,
	type ArtifactCompilerOutput,
	type ArtifactFreshness,
	type ArtifactInvalidationOptions,
	type ArtifactInvalidationPlan,
	type ArtifactInvalidationReason,
	type ArtifactInvalidationRequest,
	type ArtifactMetadata,
	type ArtifactRegistry,
	type ArtifactSourceIdentity,
} from "./lib/artifact.ts";
export {
	discoverGlobalMarkdownSources,
	getKnowledgeRoot,
	GlobalMarkdownDiscovery,
	type ArtifactSourceCandidate,
	type GlobalMarkdownDiscoveryResult,
} from "./lib/discovery.ts";
export {
	DEFAULT_ARTIFACT_MAINTENANCE_MAX_READS,
	DEFAULT_ARTIFACT_MAINTENANCE_MAX_SOURCE_BYTES,
	DEFAULT_ARTIFACT_MAINTENANCE_MINIMUM_AGE_MS,
	planArtifactMaintenance,
	type ArtifactMaintenanceOptions,
	type ArtifactMaintenancePlan,
	type ArtifactMaintenanceRequest,
} from "./lib/maintenance.ts";
export {
	captureTemporalFileBases,
	cwdScopeKey,
	getDurableRepositoryRoot,
	isStateFlowOwnedPath,
	loadScopeStream,
	parseScopeStream,
	serializeScopeStream,
	sessionScopeKey,
	sessionStorageKey,
	sessionRuntimePaths,
	temporalScopePaths,
	temporalStateFileUpdates,
	type TemporalScopePaths,
	type ScopeStreamSources,
} from "./lib/durable.ts";
export {
	captureTemporalGitBase,
	loadTemporalRevision,
	migrateLegacyStorageToGit,
	publishTemporalStateToGit,
	pushGitCommit,
	type TemporalGitBase,
	type TemporalRevisionLoad,
	type GitPushResult,
} from "./lib/git.ts";
export {
	createAcceptedTransition,
	projectRecentTransitionsWithLimit,
	RECENT_TRANSITION_LIMIT,
	validateRecentTransition,
	type RecentScopePatch,
	type RecentTransition,
	type RecentTransitionWindow,
	type AcceptedTransition,
} from "./lib/history.ts";
export { applyPatch, canonicalJson, hashJson, isObject, validatePatch } from "./lib/json.ts";
export type { JsonObject, JsonValue } from "./lib/json.ts";
export {
	emptyState,
	isMaterializedState,
	isStateDocument,
	overlayStates,
	updateMaterializedArtifacts,
	type MaterializedState,
	type ScopePatch,
	type ScopedPatch,
	type ScopedStates,
	type SemanticTransition,
	type StateDocument,
	type StatePatch,
	type StateScope,
	type TerminalTransition,
} from "./lib/state.ts";
export {
	hasCompiledSkillArtifact,
	hashSkillSource,
	migrateLegacySkillCompilations,
	SKILL_ARTIFACT_COMPILER,
	type SuccessfulSkillRead,
} from "./lib/skills.ts";
export { default, PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME, type StateFlowExtensionOptions } from "./lib/extension.ts";
export { TemporalRuntime } from "./lib/runtime.ts";
export { advanceTemporalState, readTemporalState, type TemporalState } from "./lib/temporal.ts";
