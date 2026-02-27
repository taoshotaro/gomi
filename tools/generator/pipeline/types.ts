export const STEP_ORDER = [
  "discover",
  "download",
  "extraction-plan",
  "extract",
  "convert",
  "validate",
] as const;

export type OrderedStepName = (typeof STEP_ORDER)[number];
export type StepName = OrderedStepName;
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface StepAttemptRecord {
  attempt: number;
  startedAt: string;
  endedAt?: string;
  status: "running" | "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

export interface StepState {
  status: StepStatus;
  attempts: number;
  message?: string;
  messageUpdatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  history: StepAttemptRecord[];
}

export interface HttpArtifact {
  step: StepName;
  url: string;
  finalUrl?: string;
  filename?: string;
  status?: number;
  contentType?: string;
  lastModified?: string;
  contentLength?: number;
  bytesRead?: number;
  parserHints?: string[];
  ok: boolean;
  error?: string;
  timestamp: string;
}

export interface RunArtifacts {
  downloadedFiles: string[];
  outputPaths: string[];
  http: HttpArtifact[];
}

export type SourceType = "csv" | "xlsx" | "pdf" | "image" | "html" | "api" | "unknown";
export type TargetType = "schedule" | "separation";

export interface DiscoverCandidate {
  id: string;
  url: string;
  type: SourceType;
  targetHints: TargetType[];
  host: string;
  depth: number;
  discoveredFrom?: string;
  officialness: number;
  directness: number;
  relevance: number;
  score: number;
  reasons: string[];
  contentType?: string;
  title?: string;
  preview?: string;
  rejected?: boolean;
  rejectReason?: string;
  evidenceMetrics?: DiscoverEvidenceMetrics;
}

export interface DiscoverEvidenceMetrics {
  coverageSchedule: number;
  coverageSeparation: number;
  noiseRatio: number;
  cleanupPassRate: number;
  freshnessScore: number;
  parseSuccess: number;
  officialness: number;
}

export interface DiscoverSelection {
  schedule: string[];
  separation: string[];
}

export interface DiscoverOutputV2 {
  version: "2.0.0";
  cityId: string;
  prefectureId: string;
  officialUrl: string;
  officialDomains: string[];
  candidates: DiscoverCandidate[];
  selected: DiscoverSelection;
}

export type DiscoverStopMode = "coverage" | "quality";

export interface DiscoverQualityPolicy {
  scheduleThreshold: number;
  separationThreshold: number;
  requireMachineReadableSchedule: boolean;
  scoringMode: "evidence-v1";
  minCoverageSchedule: number;
  minCoverageSeparation: number;
  maxNoiseRatio: number;
  minCleanupPassRate: number;
  freshnessHalfLifeDays: number;
}

export interface DiscoverTimeoutPolicy {
  baseMs: number;
  stepMs: number;
  maxMs: number;
  softFail: boolean;
}

export type DiscoverNoOfficialDomainStrategy = "fail-fast" | "emergency-burst";

export interface DiscoverToolBudgetPolicy {
  searchCap: number;
  fetchCap: number;
  seedQueryCount: number;
  maxHostSwitches: number;
  maxQueryDupRatio: number;
}

export interface DiscoverDomainLockPolicy {
  requireOfficialDomain: boolean;
  noOfficialDomainStrategy: DiscoverNoOfficialDomainStrategy;
}

export interface SourceManifestEntry {
  sourceId: string;
  url: string;
  type: SourceType;
  targetHints: TargetType[];
  localPath: string;
  filename: string;
  status: "downloaded" | "failed";
  finalUrl?: string;
  contentType?: string;
  lastModified?: string;
  contentLength?: number;
  bytesRead?: number;
  error?: string;
}

export interface SourceDescriptor {
  id: string;
  type: SourceType;
  url: string;
  mime?: string;
  lastModified?: string;
  localPath: string;
  priority: number;
  trustScore: number;
}

export interface ExtractionTask {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  executorType: "csv" | "xlsx" | "pdf" | "image" | "html" | "api";
  target: TargetType;
  outputSchema: "schedule-raw" | "separation-raw";
  timeoutMs: number;
  fallback?: Array<{
    executorType: "csv" | "xlsx" | "pdf" | "image" | "html" | "api";
    reason: string;
  }>;
  requiredFeatures?: Array<"document_parse" | "vision" | "code_execution">;
  preferredPath?: "native" | "local";
}

export interface ExtractionPlan {
  version: string;
  runId: string;
  createdAt: string;
  sources: SourceDescriptor[];
  tasks: ExtractionTask[];
  candidateRankings?: Record<TargetType, string[]>;
}

export interface SourceQualityScore {
  officialness: number;
  parseSuccess: number;
  schemaCoverage: number;
  noisePenalty: number;
  cleanupPassRate?: number;
  noiseRatio?: number;
  schemaSignalRate?: number;
  requiredFieldCoverage?: number;
  freshness: number;
  latencyCost: number;
  completeness: number;
  confidence: number;
}

export interface CleanupCandidateRecord {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  sourceRecordIndex: number;
  text: string;
  canonicalText: string;
  fields: Record<string, string>;
  flags: string[];
}

export interface CleanupResultRecord {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  sourceRecordIndex: number;
  action: "keep" | "drop" | "rename";
  text: string;
  normalizedFields: Record<string, string>;
  confidence: number;
  reasonTags: string[];
  flags: string[];
}

export interface CleanupMetrics {
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  rawCount: number;
  candidateCount: number;
  cleanCount: number;
  droppedCount: number;
  passRate: number;
  noiseRatio: number;
  schemaSignalRate: number;
  requiredFieldCoverage: number;
  chunksProcessed: number;
  llmChunks: number;
  fallbackChunks: number;
  deterministicDrops: number;
  degraded: boolean;
  vetoReasons: string[];
}

export interface QualityGateSnapshot {
  confidenceThreshold: number;
  minPassRate: number;
  maxNoiseRatio: number;
  minSchemaSignalRate: number;
}

export interface SourceCandidate {
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  score: SourceQualityScore;
  features: string[];
  sampleEvidencePath: string;
}

export interface PrimarySelectionDecision {
  target: TargetType;
  primarySourceId: string;
  secondarySourceIds: string[];
  reason: string;
  llmDecisionTraceId?: string;
  vetoed?: boolean;
  vetoReasons?: string[];
  qualityGateSnapshot?: QualityGateSnapshot;
}

export interface ExecutorResult {
  taskId: string;
  sourceId: string;
  executorType: "csv" | "xlsx" | "pdf" | "image" | "html" | "api";
  target: TargetType;
  status: "succeeded" | "failed" | "skipped";
  recordsExtracted: number;
  confidence: number;
  sourceQuality?: SourceQualityScore;
  durationMs: number;
  errors: string[];
  outputPath?: string;
  rawPath?: string;
  candidatePath?: string;
  cleanPath?: string;
  executionPath?: "native" | "local";
  cleanupApplied?: boolean;
  cleanupStatus?: "applied" | "skipped" | "not-required" | "failed";
  cleanupMetrics?: CleanupMetrics;
  skipReason?: string;
}

export interface ExtractionArtifact {
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  recordCount: number;
  schemaHints: string[];
  path: string;
  checksum?: string;
}

export interface ConversionTask {
  id: string;
  sourceId: string;
  target: TargetType;
  converterType: "csv" | "xlsx" | "pdf" | "image" | "html" | "api";
  inputPath: string;
  outputPath: string;
  timeoutMs: number;
}

export interface ConversionPlan {
  runId: string;
  createdAt: string;
  tasks: ConversionTask[];
}

export interface ConversionRunResult {
  taskId: string;
  sourceId: string;
  target: TargetType;
  status: "succeeded" | "failed";
  durationMs: number;
  checksPassed: string[];
  outputStats: {
    records?: number;
    categories?: number;
    areas?: number;
  };
  errors: string[];
}

export interface ModelRuntimeConfig {
  modelId: string;
  baseURL: string;
  apiKey: string;
  enableSkills: boolean;
  skillsMode: "native" | "local" | "hybrid";
  strictSkillsCompat: boolean;
}

export interface SkillsRuntimeStatus {
  nativeSkillsSupported: boolean;
  codeExecutionSupported: boolean;
  reason?: string;
}

export interface SkillExecutionPlan {
  taskId: string;
  target: TargetType;
  preferredPath: "native" | "local";
  requiredFeatures: Array<"document_parse" | "vision" | "code_execution">;
  timeoutMs: number;
}

export interface RunState {
  version: string;
  runId: string;
  city: string;
  prefecture: string;
  startedAt: string;
  finishedAt?: string;
  stepStatuses: Record<StepName, StepState>;
  artifacts: RunArtifacts;
  sources?: DiscoverOutputV2;
  sourceManifestPath?: string;
  discoverReportPath?: string;
  extractionPlanPath?: string;
  executionReportPath?: string;
  selectionReportPath?: string;
}

export type LogFormat = "pretty" | "json";
export type EventType =
  | "reasoning"
  | "step.lifecycle"
  | "model.lifecycle"
  | "tool.web_search"
  | "tool.fetch_page"
  | "http.request"
  | "http.response"
  | "file.read"
  | "file.write"
  | "retry"
  | "state.update"
  | "validation"
  | "summary"
  | "planner.lifecycle"
  | "executor.lifecycle"
  | "extractor.decision"
  | "budget.enforced"
  | "provider.lifecycle"
  | "skills.compatibility"
  | "skills.execution"
  | "skills.failure"
  | "convert.lifecycle"
  | "converter.script.generated"
  | "converter.dryrun"
  | "converter.repair"
  | "converter.acceptance"
  | "source.scored"
  | "source.selection"
  | "source.selection.veto"
  | "source.selection.fallback"
  | "cleanup.lifecycle"
  | "cleanup.chunk"
  | "cleanup.veto"
  | "cleanup.summary"
  | "html.cleanup.lifecycle"
  | "html.cleanup.chunk"
  | "html.cleanup.skip"
  | "discover.round"
  | "discover.candidate"
  | "discover.coverage"
  | "discover.score"
  | "discover.gate"
  | "discover.quality"
  | "discover.stop"
  | "discover.budget"
  | "discover.domain_lock"
  | "discover.query_dedupe"
  | "discover.fetch_focus"
  | "discover.timeout.recovered"
  | "discover.timeout.fatal"
  | "discover.finalize";

export type RedactionPolicy = "strict";

export interface AgentEvent {
  ts: string;
  runId: string;
  level: "debug" | "info" | "warn" | "error";
  step: StepName | "system";
  attempt: number;
  eventType: EventType;
  message: string;
  phase?: "start" | "end" | "fail" | "progress";
  action?: string;
  tool?: string;
  toolCallId?: string;
  durationMs?: number;
  statusCode?: number;
  bytes?: number;
  path?: string;
  retryable?: boolean;
  errorCode?: string;
  [key: string]: unknown;
}

export interface LogRuntimeConfig {
  runId: string;
  format: LogFormat;
  verbose: boolean;
  agentLogs: boolean;
  redactionPolicy: RedactionPolicy;
  eventsLogPath?: string;
  eventFilePath?: string;
}

export interface GenerateOptions {
  city: string;
  prefecture: string;
  url?: string;
  runId: string;
  workDir: string;
  verbose: boolean;
  agentLogs: boolean;
  eventFile?: string;
  maxFixRetries: number;
  skipTo?: OrderedStepName;
  resume: boolean;
  httpTimeoutMs: number;
  maxDownloadBytes: number;
  mode: "fast" | "thorough";
  maxTotalMs: number;
  maxStepMs: number;
  maxModelMs: number;
  stopAfter?: OrderedStepName;
  discoverMaxSteps: number;
  discoverMaxRounds: number;
  discoverMaxCandidates: number;
  discoverMaxFetches: number;
  discoverLinkDepth: number;
  discoverAllowHosts?: string[];
  discoverStopMode: DiscoverStopMode;
  discoverQualityPolicy: DiscoverQualityPolicy;
  discoverTimeoutPolicy: DiscoverTimeoutPolicy;
  discoverToolBudgetPolicy: DiscoverToolBudgetPolicy;
  discoverDomainLockPolicy: DiscoverDomainLockPolicy;
  selectionMode: "hybrid" | "deterministic" | "llm-first";
  selectionTopK: number;
  selectionMaxModelMs: number;
  selectionConfidenceThreshold: number;
  selectionEvidenceBytes: number;
  cleanupMode: "deterministic" | "hybrid";
  cleanupMaxModelMs: number;
  cleanupChunkBytes: number;
  cleanupMaxChunks: number;
  cleanupMinPassRate: number;
  cleanupMaxNoiseRatio: number;
  htmlExtractorMode: "deterministic" | "hybrid";
  htmlFollowLinks: boolean;
  htmlMaxFollowLinks: number;
  htmlLinkTypes: SourceType[];
  htmlMinBlockScore: number;
  htmlCleanupTimeoutMs: number;
  htmlCleanupRequired: boolean;
  htmlCleanupFailurePolicy: "skip-source" | "fail-run" | "raw-fallback";
  maxHtmlCleanupCalls: number;
  driftThreshold: number;
  maxConvertFixRetries: number;
  allowLlmRecordFallback: boolean;
  convertEngine: "template" | "llm-template";
  plannerOnly: boolean;
  executorOnly: boolean;
  sourceTypes?: SourceType[];
  modelId?: string;
  baseUrl?: string;
  enableSkills: boolean;
  skillsMode: "native" | "local" | "hybrid";
  strictSkillsCompat: boolean;
  logFormat: LogFormat;
  forceSteps: Set<StepName>;
}
