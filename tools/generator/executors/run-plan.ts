import { basename, join } from "path";
import { PipelineError } from "../pipeline/errors.js";
import type {
  CleanupCandidateRecord,
  CleanupMetrics,
  CleanupResultRecord,
  ExecutorResult,
  ExtractionPlan,
  ModelRuntimeConfig,
  SkillsRuntimeStatus,
  SourceDescriptor,
  SourceType,
  SourceQualityScore,
} from "../pipeline/types.js";
import { ensureDir, writeNdjsonAtomic } from "../lib/json.js";
import { emitAgentEvent } from "../pipeline/events.js";
import { runLocalSkillAdapter } from "../skills/local-adapters.js";
import { buildSkillExecutionPlan } from "../skills/registry.js";
import { runNativeAnthropicSkill } from "../skills/native-anthropic.js";
import { runCleanupPhase } from "../extract/cleanup.js";
import { CAPABILITY_MATRIX } from "../planner/capability.js";
import type { ExtractedLinkCandidate, ExtractedLinkType, ExecutorOutput } from "./types.js";

interface RunPlanInput {
  plan: ExtractionPlan;
  artifactsDir: string;
  runtime: ModelRuntimeConfig;
  skillsStatus?: SkillsRuntimeStatus;
  model: unknown;
  cleanup: {
    mode: "deterministic" | "hybrid";
    required: boolean;
    failurePolicy: "skip-source" | "fail-run" | "raw-fallback";
    maxModelMs: number;
    maxChunkBytes: number;
    maxChunks: number;
    minPassRate: number;
    maxNoiseRatio: number;
  };
  html: {
    mode: "deterministic" | "hybrid";
    followLinks: boolean;
    maxFollowLinks: number;
    linkTypes: Set<SourceType>;
    minBlockScore: number;
  };
}

export interface CleanupReport {
  sourceId: string;
  sourceType: ExecutorResult["executorType"];
  target: "schedule" | "separation";
  status: "applied" | "skipped" | "failed" | "degraded";
  reason?: string;
  metrics: CleanupMetrics;
  paths: {
    rawPath: string;
    candidatePath: string;
    cleanPath: string;
  };
}

export interface ExecutionReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  results: ExecutorResult[];
  cleanupReport: CleanupReport[];
}

export async function runExtractionPlan(input: RunPlanInput): Promise<ExecutionReport> {
  const startedAt = new Date().toISOString();
  const results: ExecutorResult[] = [];
  const cleanupReport: CleanupReport[] = [];
  const sourceById = new Map(input.plan.sources.map((source) => [source.id, source]));
  const sourceUrlIndex = buildSourceUrlIndex(input.plan.sources);
  const allowedLinkTypes = new Set<ExtractedLinkType>(
    [...input.html.linkTypes].filter(isExtractedLinkType)
  );

  for (const task of input.plan.tasks) {
    const source = sourceById.get(task.sourceId);
    if (!source) {
      results.push({
        taskId: task.id,
        sourceId: task.sourceId,
        executorType: task.executorType,
        target: task.target,
        status: "failed",
        recordsExtracted: 0,
        confidence: 0,
        durationMs: 0,
        errors: [`Source not found: ${task.sourceId}`],
      });
      continue;
    }

    const started = Date.now();
    const skillPlan = buildSkillExecutionPlan({
      taskId: task.id,
      target: task.target,
      sourceType: task.sourceType,
      preferredPath: task.preferredPath ?? "local",
      timeoutMs: task.timeoutMs,
    });
    const executionPath = resolveExecutionPath(task.preferredPath ?? "local", input.runtime);

    emitAgentEvent({
      level: "info",
      eventType: "skills.execution",
      step: "extract",
      message: "Executor task started",
      phase: "start",
      action: task.id,
      sourceId: task.sourceId,
      executorType: task.executorType,
      executionPath,
      requiredFeatures: skillPlan.requiredFeatures,
      major: false,
    });

    try {
      let out;
      let executorUsed: ExecutorResult["executorType"];

      if (executionPath === "native") {
        enforceNativePath(input.skillsStatus, input.runtime, task.id);
        out = await runNativeAnthropicSkill(skillPlan);
        executorUsed = task.executorType;
      } else {
        const local = runLocalSkillAdapter({
          task,
          source,
          html: {
            sourceUrl: source.url,
            minBlockScore: input.html.minBlockScore,
            allowedLinkTypes,
          },
        });
        out = local.output;
        executorUsed = local.executorType;
      }

      let normalizedOutput = normalizeExecutorOutput(out, task.target, executorUsed, source.localPath);
      if (executionPath === "local" && executorUsed === "html" && input.html.followLinks) {
        normalizedOutput = expandHtmlOutputViaLinkedSources({
          task,
          source,
          initialOutput: normalizedOutput,
          sourceById,
          sourceUrlIndex,
          allowedLinkTypes,
          maxFollowLinks: input.html.maxFollowLinks,
          minBlockScore: input.html.minBlockScore,
        });
      }
      const sourceArtifactDir = join(input.artifactsDir, task.sourceId, task.target);
      ensureDir(sourceArtifactDir);
      const rawPath = join(sourceArtifactDir, "raw.ndjson");
      const candidatePath = join(sourceArtifactDir, "candidates.ndjson");
      const cleanPath = join(sourceArtifactDir, "clean.ndjson");

      const cleanup = await runCleanupPhase({
        model: input.model,
        sourceId: task.sourceId,
        sourceType: task.sourceType,
        target: task.target,
        output: normalizedOutput,
        mode: input.cleanup.mode,
        maxModelMs: input.cleanup.maxModelMs,
        maxChunkBytes: input.cleanup.maxChunkBytes,
        maxChunks: input.cleanup.maxChunks,
        minPassRate: input.cleanup.minPassRate,
        maxNoiseRatio: input.cleanup.maxNoiseRatio,
      });

      writeNdjsonAtomic(rawPath, cleanup.rawRecords);
      writeNdjsonAtomic(candidatePath, cleanup.candidateRecords);
      writeNdjsonAtomic(cleanPath, cleanup.cleanRecords);

      const cleanupStatus: CleanupReport["status"] =
        cleanup.status === "applied"
          ? "applied"
          : cleanup.status === "degraded"
            ? "degraded"
            : "failed";

      cleanupReport.push({
        sourceId: task.sourceId,
        sourceType: executorUsed,
        target: task.target,
        status: cleanupStatus,
        reason: cleanup.reason,
        metrics: cleanup.metrics,
        paths: {
          rawPath,
          candidatePath,
          cleanPath,
        },
      });

      const gateReasons = cleanup.metrics.vetoReasons;
      const failedCleanup = cleanup.status === "failed" || gateReasons.length > 0;
      if (failedCleanup) {
        const reason = cleanup.reason || gateReasons.join(", ") || "cleanup quality gate failed";
        emitAgentEvent({
          level: "warn",
          eventType: "cleanup.veto",
          step: "extract",
          message: "Source skipped by cleanup gate",
          sourceId: task.sourceId,
          target: task.target,
          reasons: gateReasons,
          reason,
        });

        if (input.cleanup.failurePolicy === "fail-run") {
          throw new PipelineError(reason, {
            code: "CLEANUP_GATE_FAILED",
            retryable: false,
          });
        }

        if (input.cleanup.failurePolicy === "raw-fallback") {
          const fallbackClean = toFallbackCleanRecords(cleanup.candidateRecords);
          writeNdjsonAtomic(cleanPath, fallbackClean);
          const fallbackMetrics = {
            ...cleanup.metrics,
            cleanCount: fallbackClean.length,
            passRate: ratio(fallbackClean.length, Math.max(cleanup.metrics.candidateCount, 1)),
            vetoReasons: [],
          };
          const sourceQuality = computeSourceQuality({
            sourceTrust: source.trustScore,
            executorType: executorUsed,
            target: task.target,
            durationMs: Date.now() - started,
            metrics: fallbackMetrics,
          });
          results.push({
            taskId: task.id,
            sourceId: task.sourceId,
            executorType: executorUsed,
            target: task.target,
            status: "succeeded",
            recordsExtracted: fallbackClean.length,
            confidence: sourceQuality.confidence,
            sourceQuality,
            durationMs: Date.now() - started,
            errors: [],
            outputPath: cleanPath,
            rawPath,
            candidatePath,
            cleanPath,
            executionPath,
            cleanupApplied: false,
            cleanupStatus: "skipped",
            cleanupMetrics: fallbackMetrics,
          });
          continue;
        }

        results.push({
          taskId: task.id,
          sourceId: task.sourceId,
          executorType: executorUsed,
          target: task.target,
          status: "skipped",
          recordsExtracted: cleanup.cleanRecords.length,
          confidence: 0,
          sourceQuality: computeSourceQuality({
            sourceTrust: source.trustScore,
            executorType: executorUsed,
            target: task.target,
            durationMs: Date.now() - started,
            metrics: cleanup.metrics,
          }),
          durationMs: Date.now() - started,
          errors: [reason],
          outputPath: cleanPath,
          rawPath,
          candidatePath,
          cleanPath,
          executionPath,
          cleanupApplied: false,
          cleanupStatus: "failed",
          cleanupMetrics: cleanup.metrics,
          skipReason: reason,
        });
        continue;
      }

      const sourceQuality = computeSourceQuality({
        sourceTrust: source.trustScore,
        executorType: executorUsed,
        target: task.target,
        durationMs: Date.now() - started,
        metrics: cleanup.metrics,
      });

      results.push({
        taskId: task.id,
        sourceId: task.sourceId,
        executorType: executorUsed,
        target: task.target,
        status: "succeeded",
        recordsExtracted: cleanup.cleanRecords.length,
        confidence: sourceQuality.confidence,
        sourceQuality,
        durationMs: Date.now() - started,
        errors: [],
        outputPath: cleanPath,
        rawPath,
        candidatePath,
        cleanPath,
        executionPath,
        cleanupApplied: true,
        cleanupStatus: cleanup.status === "degraded" ? "skipped" : "applied",
        cleanupMetrics: cleanup.metrics,
      });

      emitAgentEvent({
        level: "info",
        eventType: "skills.execution",
        step: "extract",
        message: "Executor task completed",
        phase: "end",
        action: task.id,
        sourceId: task.sourceId,
        executorType: executorUsed,
        durationMs: Date.now() - started,
        records: cleanup.cleanRecords.length,
        executionPath,
        cleanupStatus: cleanup.status,
        major: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        taskId: task.id,
        sourceId: task.sourceId,
        executorType: task.executorType,
        target: task.target,
        status: "failed",
        recordsExtracted: 0,
        confidence: 0,
        durationMs: Date.now() - started,
        errors: [message],
        executionPath,
        cleanupApplied: false,
        cleanupStatus: "failed",
      });
      emitAgentEvent({
        level: "warn",
        eventType: "skills.failure",
        step: "extract",
        message: "Executor task failed",
        phase: "fail",
        action: task.id,
        sourceId: task.sourceId,
        executorType: task.executorType,
        durationMs: Date.now() - started,
        errorMessage: message,
        executionPath,
        major: false,
      });
    }
  }

  return {
    runId: input.plan.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    results: results.sort((a, b) => basename(a.taskId).localeCompare(b.taskId)),
    cleanupReport,
  };
}

function expandHtmlOutputViaLinkedSources(input: {
  task: RunPlanInput["plan"]["tasks"][number];
  source: SourceDescriptor;
  initialOutput: ExecutorOutput;
  sourceById: Map<string, SourceDescriptor>;
  sourceUrlIndex: Map<string, string>;
  allowedLinkTypes: Set<ExtractedLinkType>;
  maxFollowLinks: number;
  minBlockScore: number;
}): ExecutorOutput {
  const links = [...(input.initialOutput.linkCandidates ?? [])]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (links.length === 0 || input.maxFollowLinks <= 0) {
    return input.initialOutput;
  }

  const followedSourceIds: string[] = [];
  let mergedRecords = [...input.initialOutput.records];
  let mergedLinks = [...links];

  for (const candidate of links) {
    if (followedSourceIds.length >= input.maxFollowLinks) {
      break;
    }
    if (!input.allowedLinkTypes.has(candidate.type)) {
      continue;
    }

    const linkedSourceId = resolveLinkedSourceId(candidate.url, input.sourceUrlIndex);
    if (!linkedSourceId || linkedSourceId === input.task.sourceId) {
      continue;
    }
    if (followedSourceIds.includes(linkedSourceId)) {
      continue;
    }

    const linkedSource = input.sourceById.get(linkedSourceId);
    if (!linkedSource) {
      continue;
    }
    if (!linkedSource.id.startsWith(`${input.task.target}-`)) {
      continue;
    }

    const linkedTask = {
      ...input.task,
      id: `${input.task.id}:follow:${linkedSource.id}`,
      sourceId: linkedSource.id,
      sourceType: linkedSource.type,
      executorType: CAPABILITY_MATRIX[linkedSource.type].primary,
    };

    emitAgentEvent({
      level: "info",
      eventType: "extractor.decision",
      step: "extract",
      message: "Following linked source from HTML",
      sourceId: input.task.sourceId,
      linkedSourceId,
      linkedSourceType: linkedSource.type,
      url: candidate.url,
      reason: candidate.reasons.join("|"),
      major: false,
    });

    const local = runLocalSkillAdapter({
      task: linkedTask,
      source: linkedSource,
      html: {
        sourceUrl: linkedSource.url,
        minBlockScore: input.minBlockScore,
        allowedLinkTypes: input.allowedLinkTypes,
      },
    });
    const linkedOutput = normalizeExecutorOutput(
      local.output,
      linkedTask.target,
      linkedTask.executorType,
      linkedSource.localPath
    );
    if (linkedOutput.records.length === 0) {
      continue;
    }

    mergedRecords = mergeRecordsWithSource(
      mergedRecords,
      linkedOutput.records,
      linkedSource.id,
      linkedSource.url
    );
    mergedLinks = mergeLinkCandidates(mergedLinks, linkedOutput.linkCandidates ?? []);
    followedSourceIds.push(linkedSource.id);
  }

  if (followedSourceIds.length === 0) {
    return input.initialOutput;
  }

  emitAgentEvent({
    level: "info",
    eventType: "extractor.decision",
    step: "extract",
    message: "HTML link-follow merge completed",
    sourceId: input.task.sourceId,
    followedSourceIds,
    mergedRecords: mergedRecords.length,
    major: false,
  });

  return {
    ...input.initialOutput,
    records: mergedRecords,
    linkCandidates: mergedLinks,
    diagnostics: {
      parser: input.initialOutput.diagnostics?.parser ?? "html-structured-v2",
      tableCount: input.initialOutput.diagnostics?.tableCount ?? 0,
      tableRowCount: input.initialOutput.diagnostics?.tableRowCount ?? 0,
      textBlockCount: input.initialOutput.diagnostics?.textBlockCount ?? 0,
      skippedNoiseBlocks: input.initialOutput.diagnostics?.skippedNoiseBlocks ?? 0,
      linkCandidateCount: mergedLinks.length,
      followedSourceIds,
    },
  };
}

function mergeRecordsWithSource(
  base: ExecutorOutput["records"],
  incoming: ExecutorOutput["records"],
  sourceId: string,
  sourceUrl: string
): ExecutorOutput["records"] {
  const seen = new Set(
    base
      .map((record) => normalizeLine(record.fields.line || record.row?.join(" | ") || ""))
      .filter(Boolean)
  );
  const merged = [...base];

  for (const record of incoming) {
    const line = normalizeLine(record.fields.line || record.row?.join(" | ") || "");
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    merged.push({
      ...record,
      fields: {
        ...record.fields,
        line,
        source_id: record.fields.source_id || sourceId,
        source_url: record.fields.source_url || sourceUrl,
      },
    });
  }

  return merged;
}

function mergeLinkCandidates(
  left: ExtractedLinkCandidate[],
  right: ExtractedLinkCandidate[]
): ExtractedLinkCandidate[] {
  const out = new Map<string, ExtractedLinkCandidate>();
  for (const candidate of [...left, ...right]) {
    const current = out.get(candidate.url);
    if (!current || candidate.score > current.score) {
      out.set(candidate.url, candidate);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

function buildSourceUrlIndex(sources: SourceDescriptor[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const source of sources) {
    for (const key of sourceUrlKeys(source.url)) {
      if (!index.has(key)) {
        index.set(key, source.id);
      }
    }
  }
  return index;
}

function resolveLinkedSourceId(url: string, sourceUrlIndex: Map<string, string>): string | undefined {
  for (const key of sourceUrlKeys(url)) {
    const id = sourceUrlIndex.get(key);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function sourceUrlKeys(url: string): string[] {
  try {
    const parsed = new URL(url);
    const originPath = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    const href = parsed.toString().replace(/#.*$/, "").toLowerCase();
    return [href, originPath, parsed.pathname.toLowerCase()];
  } catch {
    return [url.toLowerCase()];
  }
}

function normalizeLine(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function isExtractedLinkType(value: SourceType): value is ExtractedLinkType {
  return (
    value === "html" ||
    value === "csv" ||
    value === "xlsx" ||
    value === "pdf" ||
    value === "image" ||
    value === "api" ||
    value === "unknown"
  );
}

function normalizeExecutorOutput(
  output: unknown,
  target: ExecutorOutput["target"],
  sourceType: ExecutorOutput["sourceType"],
  sourcePath: string
): ExecutorOutput {
  if (
    output &&
    typeof output === "object" &&
    "records" in output &&
    Array.isArray((output as { records: unknown[] }).records)
  ) {
    return output as ExecutorOutput;
  }

  return {
    target,
    sourceType,
    sourcePath,
    preview: "",
    records: [],
  };
}

function toFallbackCleanRecords(candidates: CleanupCandidateRecord[]): CleanupResultRecord[] {
  return candidates
    .filter((candidate) => candidate.canonicalText.length > 0)
    .map((candidate) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      sourceType: candidate.sourceType,
      target: candidate.target,
      sourceRecordIndex: candidate.sourceRecordIndex,
      action: "keep",
      text: candidate.canonicalText,
      normalizedFields: {
        ...candidate.fields,
        line: candidate.canonicalText,
      },
      confidence: 0.6,
      reasonTags: ["raw-fallback"],
      flags: candidate.flags,
    }));
}

function resolveExecutionPath(
  preferred: "native" | "local",
  runtime: ModelRuntimeConfig
): "native" | "local" {
  if (!runtime.enableSkills) {
    return "local";
  }
  if (runtime.skillsMode === "local") {
    return "local";
  }
  if (runtime.skillsMode === "native") {
    return "native";
  }
  return preferred;
}

function enforceNativePath(
  status: SkillsRuntimeStatus | undefined,
  runtime: ModelRuntimeConfig,
  taskId: string
): void {
  if (status?.nativeSkillsSupported && status?.codeExecutionSupported) {
    return;
  }
  if (!runtime.strictSkillsCompat) {
    return;
  }
  throw new PipelineError(
    `Native skills execution requested but compatibility preflight failed for ${taskId}`,
    {
      code: "SKILLS_INCOMPATIBLE",
      retryable: false,
    }
  );
}

function computeSourceQuality(input: {
  sourceTrust: number;
  executorType: ExecutorResult["executorType"];
  target: ExecutorResult["target"];
  durationMs: number;
  metrics: CleanupMetrics;
}): SourceQualityScore {
  const parseSuccess = ratio(input.metrics.cleanCount, Math.max(input.metrics.rawCount, 1));
  const schemaCoverage = estimateSchemaCoverage(input.executorType, input.target);
  const noisePenalty = Math.max(
    0,
    Math.min(1, input.metrics.noiseRatio * 0.8 + (1 - input.metrics.passRate) * 0.2)
  );
  const freshness = 0.7;
  const latencyCost = Math.max(0, Math.min(1, 1 - input.durationMs / 60_000));
  const completeness = ratio(input.metrics.cleanCount, 300);

  const confidence =
    input.sourceTrust * 0.2 +
    parseSuccess * 0.16 +
    schemaCoverage * 0.15 +
    (1 - noisePenalty) * 0.1 +
    input.metrics.passRate * 0.14 +
    (1 - input.metrics.noiseRatio) * 0.1 +
    input.metrics.schemaSignalRate * 0.08 +
    input.metrics.requiredFieldCoverage * 0.07;

  return {
    officialness: input.sourceTrust,
    parseSuccess,
    schemaCoverage,
    noisePenalty,
    cleanupPassRate: input.metrics.passRate,
    noiseRatio: input.metrics.noiseRatio,
    schemaSignalRate: input.metrics.schemaSignalRate,
    requiredFieldCoverage: input.metrics.requiredFieldCoverage,
    freshness,
    latencyCost,
    completeness,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function estimateSchemaCoverage(
  executorType: ExecutorResult["executorType"],
  target: ExecutorResult["target"]
): number {
  if (target === "schedule") {
    if (executorType === "api" || executorType === "xlsx" || executorType === "csv") {
      return 0.9;
    }
    if (executorType === "html") {
      return 0.68;
    }
    return 0.5;
  }
  if (executorType === "api" || executorType === "html") {
    return 0.9;
  }
  if (executorType === "csv" || executorType === "xlsx") {
    return 0.58;
  }
  return 0.52;
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}
