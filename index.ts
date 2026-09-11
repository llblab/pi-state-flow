export {
  ArtifactReadTracker,
  decideArtifactAcquisition,
  type ArtifactAcquisitionDecision,
  type ArtifactAcquisitionIntent,
  type ArtifactAcquisitionOptions,
  type ArtifactAcquisitionReason,
  type SuccessfulArtifactRead
} from "./lib/acquisition.ts";
export {
  classifyArtifactFreshness,
  compileArtifact,
  hashArtifactSource,
  isArtifactHash,
  isArtifactMetadata,
  isArtifactRegistry,
  ORDINARY_ARTIFACT_COMPILER,
  parseArtifactProvenanceRegistry,
  planArtifactInvalidation,
  projectArtifactForModel,
  projectArtifactsForModel,
  pruneArtifactProvenance,
  selectArtifactsByTags,
  serializeArtifactProvenanceRegistry,
  updateArtifactProvenance,
  updateArtifactRegistry,
  validateArtifactMetadata,
  validateArtifactRegistry,
  type ArtifactCompilationUpdate,
  type ArtifactCompilerOutput,
  type ArtifactFreshness,
  type ArtifactInvalidationNotice,
  type ArtifactInvalidationOptions,
  type ArtifactInvalidationPlan,
  type ArtifactInvalidationReason,
  type ArtifactInvalidationRequest,
  type ArtifactMetadata,
  type ArtifactProvenance,
  type ArtifactProvenanceRegistry,
  type ArtifactRegistry,
  type ArtifactSourceIdentity,
  type CompiledArtifact
} from "./lib/artifact.ts";
export {
  buildContinuationCandidates,
  discoverNativeSessionHeaders,
  inspectStateFlowContinuationProvenance,
  readNativeSessionHeader,
  recommendContinuationFromProvenance,
  resolveContinuationStartup,
  type ContinuationCandidateProvenance,
  type ContinuationCandidateSummary,
  type ContinuationHostContext,
  type ContinuationHostIntent,
  type ContinuationProjectIdentity,
  type ContinuationRecommendation,
  type ContinuationRecommender,
  type ContinuationSessionCandidate,
  type ContinuationStartupDecision,
  type ContinuationTransport,
  type NativeSessionHeader
} from "./lib/continuation.ts";
export {
  discoverGlobalMarkdownSources,
  getKnowledgeRoot,
  GlobalMarkdownDiscovery,
  type ArtifactSourceCandidate,
  type GlobalMarkdownDiscoveryResult
} from "./lib/discovery.ts";
export {
  captureTemporalFileBases,
  cwdScopeKey,
  getDurableRepositoryRoot,
  isStateFlowOwnedPath,
  loadScopeStream,
  parseScopeProvenance,
  parseScopeStream,
  serializeScopeProvenance,
  serializeScopeStream, sessionRuntimePaths, sessionScopeKey,
  sessionStorageKey, temporalScopePaths,
  temporalStateFileUpdates, type ScopeStreamSources, type TemporalScopePaths
} from "./lib/durable.ts";
export { default, PATCH_STATE_TOOL_NAME, READ_STATE_TOOL_NAME, type StateFlowExtensionOptions } from "./lib/extension.ts";
export {
  captureTemporalGitBase,
  isGitCommitAncestor,
  loadTemporalRevision,
  migrateLegacyStorageToGit,
  publishTemporalStateToGit,
  pushGitCommit,
  resolveGitPushDestination, type GitPushResult, type TemporalGitBase,
  type TemporalRevisionLoad
} from "./lib/git.ts";
export {
  createAcceptedTransition,
  projectRecentTransitionsWithLimit,
  RECENT_TRANSITION_LIMIT,
  validateRecentTransition, type AcceptedTransition, type RecentScopePatch,
  type RecentTransition,
  type RecentTransitionWindow
} from "./lib/history.ts";
export { applyPatch, canonicalJson, hashJson, isObject, validatePatch } from "./lib/json.ts";
export type { JsonObject, JsonValue } from "./lib/json.ts";
export {
  appendStateFlowDiagnostic,
  projectDiagnosticContent,
  stateFlowLogPath,
  type StateFlowDiagnosticBlock,
  type StateFlowDiagnosticCategory,
  type StateFlowDiagnosticRecord
} from "./lib/logging.ts";
export {
  DEFAULT_ARTIFACT_MAINTENANCE_MAX_READS,
  DEFAULT_ARTIFACT_MAINTENANCE_MAX_SOURCE_BYTES,
  DEFAULT_ARTIFACT_MAINTENANCE_MINIMUM_AGE_MS,
  planArtifactMaintenance,
  type ArtifactMaintenanceOptions,
  type ArtifactMaintenancePlan,
  type ArtifactMaintenanceRequest
} from "./lib/maintenance.ts";
export {
  inspectMemoryPromotions, MEMORY_PROMOTION_STATUSES, MEMORY_PROMOTIONS_KEY, retainedMemoryScopes,
  type MemoryPromotionDiagnostic,
  type MemoryPromotionStatus
} from "./lib/memory.ts";
export {
  acquirePublicationWorkerLease,
  beginPublicationAttempt,
  coalescePublicationTarget,
  confirmPublicationTarget,
  createPublicationQueue,
  failPublicationAttempt,
  loadPublicationQueue,
  parsePublicationQueue,
  parseRemotePublicationPolicyDocument,
  publicationQueuePath,
  recoverPublicationQueue,
  remotePublicationDestinationKey,
  removePublicationQueue,
  resolveRemotePublicationPolicy,
  runPublicationWorker,
  savePublicationQueue,
  serializePublicationQueue,
  serializeRemotePublicationPolicyDocument,
  validatePublicationQueue,
  type CommitAncestor,
  type PublicationPush,
  type PublicationQueueReceipt,
  type PublicationQueueState,
  type PublicationQueueStatus,
  type PublicationWorkerLease,
  type PublicationWorkerResult,
  type RemotePublicationDestination,
  type RemotePublicationMode,
  type RemotePublicationPolicy,
  type RemotePublicationPolicyDocument
} from "./lib/publication.ts";
export {
  planKnowledgeRehydration,
  type RehydrationOptions,
  type RehydrationPhase,
  type RehydrationPlan,
  type RehydrationRead,
  type RehydrationRoute
} from "./lib/rehydration.ts";
export { TemporalRuntime } from "./lib/runtime.ts";
export {
  hasCompiledSkillArtifact,
  hashSkillSource,
  migrateLegacySkillCompilations,
  SKILL_ARTIFACT_COMPILER,
  type SuccessfulSkillRead
} from "./lib/skills.ts";
export {
  emptyState,
  isMaterializedState,
  isStateDocument,
  overlayStates,
  projectStateForModel,
  updateMaterializedArtifacts,
  type MaterializedState, type ScopedPatch,
  type ScopedStates, type ScopePatch, type SemanticTransition,
  type StateDocument,
  type StatePatch,
  type StateScope,
  type TerminalTransition
} from "./lib/state.ts";
export { advanceTemporalState, readTemporalState, type TemporalState } from "./lib/temporal.ts";
