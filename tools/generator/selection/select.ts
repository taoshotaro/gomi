import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { generateObject } from "ai";
import { z } from "zod";
import { ensureDir, readNdjsonFile, writeJsonAtomic } from "../lib/json.js";
import { runModelText } from "../lib/model.js";
import { PipelineError } from "../pipeline/errors.js";
import { emitAgentEvent } from "../pipeline/events.js";
import type { PipelineContext } from "../pipeline/context.js";
import type {
  CleanupResultRecord,
  ExtractionPlan,
  PrimarySelectionDecision,
  QualityGateSnapshot,
  SourceCandidate,
  SourceQualityScore,
  TargetType,
} from "../pipeline/types.js";
import type { ExecutionReport } from "../executors/run-plan.js";

interface SelectionResult {
  decisions: Record<TargetType, PrimarySelectionDecision>;
  candidates: Record<TargetType, SourceCandidate[]>;
  reportPath: string;
}

const decisionSchema = z.object({
  primarySourceId: z.string(),
  secondarySourceIds: z.array(z.string()).max(5).default([]),
  reason: z.string(),
  rationaleTags: z.array(z.string()).max(8).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

export async function selectPrimarySources(input: {
  context: PipelineContext;
  plan: ExtractionPlan;
  report: ExecutionReport;
}): Promise<SelectionResult> {
  const { context, plan, report } = input;
  const bySource = new Map(plan.sources.map((source) => [source.id, source]));
  const candidates: Record<TargetType, SourceCandidate[]> = {
    schedule: [],
    separation: [],
  };

  const metaByTarget = {
    schedule: new Map<string, CandidateMeta>(),
    separation: new Map<string, CandidateMeta>(),
  };

  for (const result of report.results) {
    if (result.status !== "succeeded" || !result.outputPath) {
      continue;
    }
    const source = bySource.get(result.sourceId);
    if (!source || !existsSync(result.outputPath)) {
      continue;
    }

    const quality =
      result.sourceQuality ??
      buildFallbackScore(
        result.confidence,
        result.recordsExtracted,
        result.cleanupMetrics?.passRate ?? 0,
        result.cleanupMetrics?.noiseRatio ?? 1,
        result.cleanupMetrics?.schemaSignalRate ?? 0,
        result.cleanupMetrics?.requiredFieldCoverage ?? 0
      );
    const gateReasons = evaluateCandidateGate({
      score: quality,
      recordsExtracted: result.recordsExtracted,
      target: result.target,
      context,
    });

    if (gateReasons.length > 0) {
      emitAgentEvent({
        level: "warn",
        step: "convert",
        eventType: "source.selection.veto",
        message: "Source vetoed before ranking by quality gate",
        target: result.target,
        sourceId: result.sourceId,
        reason: gateReasons.join(", "),
      });
      continue;
    }

    const evidencePath = writeCandidateEvidence({
      context,
      sourceId: result.sourceId,
      target: result.target,
      outputPath: result.outputPath,
      evidenceBytes: context.options.selectionEvidenceBytes,
      score: quality,
    });

    const candidate: SourceCandidate = {
      sourceId: result.sourceId,
      sourceType: source.type,
      target: result.target,
      score: quality,
      features: buildFeatures(source.type, result.cleanupApplied, result.cleanupStatus),
      sampleEvidencePath: evidencePath,
    };

    candidates[result.target].push(candidate);
    const rankScore = deterministicSelectionScore(quality);
    metaByTarget[result.target].set(result.sourceId, {
      score: quality,
      recordsExtracted: result.recordsExtracted,
      rankScore,
    });

    emitAgentEvent({
      level: "info",
      step: "convert",
      eventType: "source.scored",
      message: "Source scored for target",
      target: result.target,
      sourceId: result.sourceId,
      sourceType: source.type,
      score: quality,
      confidence: quality.confidence,
      rankScore,
    });
  }

  for (const target of ["schedule", "separation"] as const) {
    candidates[target].sort((a, b) => deterministicSelectionScore(b.score) - deterministicSelectionScore(a.score));
  }

  const decisions: Record<TargetType, PrimarySelectionDecision> = {
    schedule: await chooseTargetPrimary({
      context,
      target: "schedule",
      candidates: candidates.schedule,
      meta: metaByTarget.schedule,
    }),
    separation: await chooseTargetPrimary({
      context,
      target: "separation",
      candidates: candidates.separation,
      meta: metaByTarget.separation,
    }),
  };

  const reportBody = {
    runId: context.options.runId,
    createdAt: new Date().toISOString(),
    mode: context.options.selectionMode,
    topK: context.options.selectionTopK,
    qualityGateSnapshot: buildQualityGateSnapshot(context),
    candidates,
    decisions,
  };
  const reportPath = join(context.options.workDir, "selection-report.json");
  writeJsonAtomic(reportPath, reportBody);

  return {
    decisions,
    candidates,
    reportPath,
  };
}

interface CandidateMeta {
  score: SourceQualityScore;
  recordsExtracted: number;
  rankScore: number;
}

async function chooseTargetPrimary(input: {
  context: PipelineContext;
  target: TargetType;
  candidates: SourceCandidate[];
  meta: Map<string, CandidateMeta>;
}): Promise<PrimarySelectionDecision> {
  const { context, target, candidates, meta } = input;
  if (candidates.length === 0) {
    throw new PipelineError(`No candidates available for ${target} after cleanup quality gates`, {
      code: "NO_SOURCE_CANDIDATE",
      retryable: false,
    });
  }

  const top = candidates.slice(0, Math.max(1, context.options.selectionTopK));
  const gateSnapshot = buildQualityGateSnapshot(context);
  let chosen = deterministicDecision(target, top);
  let llmDecisionTraceId: string | undefined;

  if (context.options.selectionMode === "llm-first" || context.options.selectionMode === "hybrid") {
    try {
      const prompt = buildSelectionPrompt(target, top, context.options.selectionEvidenceBytes);
      const { object } = await runModelText(
        `selection.${target}.generateObject`,
        () =>
          generateObject({
            model: context.model,
            prompt,
            schema: decisionSchema,
            temperature: 0,
            maxRetries: 1,
          }),
        {
          maxModelMs: context.options.selectionMaxModelMs,
          major: false,
        }
      );
      llmDecisionTraceId = `selection-${target}-${Date.now()}`;
      chosen = normalizeDecision(target, top, object, chosen);
    } catch (error) {
      emitAgentEvent({
        level: "warn",
        step: "convert",
        eventType: "source.selection.fallback",
        message: "LLM selection failed; falling back to deterministic ranking",
        target,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let vetoed = false;
  const vetoReasons: string[] = [];
  const queue = [chosen.primarySourceId, ...chosen.secondarySourceIds];
  while (queue.length > 0) {
    const current = queue[0];
    const currentMeta = meta.get(current);
    if (!currentMeta) {
      queue.shift();
      continue;
    }

    if (passesPreflightGate(currentMeta.score, currentMeta.recordsExtracted, context.options.selectionConfidenceThreshold)) {
      const decision: PrimarySelectionDecision = {
        target,
        primarySourceId: current,
        secondarySourceIds: queue.slice(1),
        reason: chosen.reason,
        llmDecisionTraceId,
        vetoed,
        vetoReasons,
        qualityGateSnapshot: gateSnapshot,
      };

      if (vetoed) {
        emitAgentEvent({
          level: "info",
          step: "convert",
          eventType: "source.selection.fallback",
          message: "Using fallback source after veto",
          target,
          sourceId: decision.primarySourceId,
        });
      }

      emitAgentEvent({
        level: "info",
        step: "convert",
        eventType: "source.selection",
        message: "Primary source selected",
        target,
        sourceId: decision.primarySourceId,
        secondarySourceIds: decision.secondarySourceIds,
        confidence: currentMeta.score.confidence,
        reason: decision.reason,
      });

      return decision;
    }

    vetoed = true;
    const reason = `post-rank gate failed for ${current}`;
    vetoReasons.push(reason);
    emitAgentEvent({
      level: "warn",
      step: "convert",
      eventType: "source.selection.veto",
      message: "Primary source vetoed by preflight quality gate",
      target,
      sourceId: current,
      confidence: currentMeta.score.confidence,
      reason,
    });
    queue.shift();
  }

  throw new PipelineError(`No valid source candidate remained after veto for ${target}`, {
    code: "NO_VALID_SOURCE_AFTER_VETO",
    retryable: false,
  });
}

function deterministicDecision(target: TargetType, candidates: SourceCandidate[]): PrimarySelectionDecision {
  const sorted = [...candidates].sort(
    (a, b) => deterministicSelectionScore(b.score) - deterministicSelectionScore(a.score)
  );
  const primary = sorted[0];
  return {
    target,
    primarySourceId: primary.sourceId,
    secondarySourceIds: sorted.slice(1).map((entry) => entry.sourceId),
    reason: "deterministic-score-ranking-with-cleanup-metrics",
  };
}

function normalizeDecision(
  target: TargetType,
  candidates: SourceCandidate[],
  llm: z.infer<typeof decisionSchema>,
  fallback: PrimarySelectionDecision
): PrimarySelectionDecision {
  const allowed = new Set(candidates.map((entry) => entry.sourceId));
  if (!allowed.has(llm.primarySourceId)) {
    return fallback;
  }
  const secondary = llm.secondarySourceIds.filter((id) => allowed.has(id) && id !== llm.primarySourceId);
  return {
    target,
    primarySourceId: llm.primarySourceId,
    secondarySourceIds: secondary,
    reason: llm.reason || fallback.reason,
  };
}

function evaluateCandidateGate(input: {
  score: SourceQualityScore;
  recordsExtracted: number;
  target: TargetType;
  context: PipelineContext;
}): string[] {
  const { score, recordsExtracted, target, context } = input;
  const reasons: string[] = [];
  const minSchemaSignal = target === "schedule" ? 0.18 : 0.2;
  const cleanupPassRate = score.cleanupPassRate ?? score.parseSuccess;
  const noiseRatio = score.noiseRatio ?? score.noisePenalty;
  const schemaSignalRate = score.schemaSignalRate ?? score.schemaCoverage;
  if (recordsExtracted < 1) {
    reasons.push("records=0");
  }
  if (score.confidence < context.options.selectionConfidenceThreshold) {
    reasons.push("confidence-below-threshold");
  }
  if (cleanupPassRate < context.options.cleanupMinPassRate) {
    reasons.push("cleanup-pass-rate-below-threshold");
  }
  if (noiseRatio > context.options.cleanupMaxNoiseRatio) {
    reasons.push("cleanup-noise-ratio-above-threshold");
  }
  if (schemaSignalRate < minSchemaSignal) {
    reasons.push("schema-signal-rate-below-threshold");
  }
  return reasons;
}

function passesPreflightGate(
  score: SourceQualityScore,
  recordsExtracted: number,
  threshold: number
): boolean {
  if (recordsExtracted < 1) {
    return false;
  }
  if (score.confidence < threshold) {
    return false;
  }
  if (score.noisePenalty > 0.55) {
    return false;
  }
  if (score.parseSuccess < 0.05) {
    return false;
  }
  return true;
}

function deterministicSelectionScore(score: SourceQualityScore): number {
  const cleanupPassRate = score.cleanupPassRate ?? score.parseSuccess;
  const noiseRatio = score.noiseRatio ?? score.noisePenalty;
  const schemaSignalRate = score.schemaSignalRate ?? score.schemaCoverage;
  const requiredFieldCoverage = score.requiredFieldCoverage ?? score.schemaCoverage;
  return (
    score.officialness * 0.22 +
    score.parseSuccess * 0.16 +
    score.schemaCoverage * 0.14 +
    (1 - score.noisePenalty) * 0.08 +
    cleanupPassRate * 0.16 +
    (1 - noiseRatio) * 0.1 +
    schemaSignalRate * 0.08 +
    requiredFieldCoverage * 0.04 +
    score.confidence * 0.02
  );
}

function buildQualityGateSnapshot(context: PipelineContext): QualityGateSnapshot {
  return {
    confidenceThreshold: context.options.selectionConfidenceThreshold,
    minPassRate: context.options.cleanupMinPassRate,
    maxNoiseRatio: context.options.cleanupMaxNoiseRatio,
    minSchemaSignalRate: 0.18,
  };
}

function buildSelectionPrompt(
  target: TargetType,
  candidates: SourceCandidate[],
  evidenceBytes: number
): string {
  const body = candidates
    .map((candidate, idx) => {
      const evidence = readEvidence(candidate.sampleEvidencePath, evidenceBytes);
      return `${idx + 1}. sourceId=${candidate.sourceId}, sourceType=${candidate.sourceType}
score=${JSON.stringify(candidate.score)}
features=${candidate.features.join(",")}
evidence:
${evidence}`;
    })
    .join("\n\n---\n\n");

  return `Choose the best primary source for ${target} data conversion.

Rules:
- Prefer structured and clean sources with high cleanup quality metrics.
- Do not choose noisy or low-signal candidates.
- Return only listed source IDs.

Candidates:
${body}`;
}

function writeCandidateEvidence(input: {
  context: PipelineContext;
  sourceId: string;
  target: TargetType;
  outputPath: string;
  evidenceBytes: number;
  score: SourceQualityScore;
}): string {
  const parsed = readCleanupRecords(input.outputPath);
  const sample = parsed.slice(0, 40).map((record) => ({
    id: record.id,
    text: record.text,
    confidence: record.confidence,
    reasonTags: record.reasonTags,
  }));
  const raw = JSON.stringify(
    {
      sourceId: input.sourceId,
      target: input.target,
      score: input.score,
      sample,
    },
    null,
    2
  ).slice(0, input.evidenceBytes);

  const dir = join(input.context.options.workDir, "candidates", input.target);
  ensureDir(dir);
  const path = join(dir, `${input.sourceId}.json`);
  writeJsonAtomic(path, {
    sourceId: input.sourceId,
    target: input.target,
    sample: raw,
  });
  return path;
}

function buildFeatures(
  sourceType: string,
  cleanupApplied?: boolean,
  cleanupStatus?: string
): string[] {
  const features = [`source:${sourceType}`];
  if (cleanupApplied) {
    features.push("cleanup:applied");
  }
  if (cleanupStatus && cleanupStatus !== "not-required") {
    features.push(`cleanup:${cleanupStatus}`);
  }
  return features;
}

function buildFallbackScore(
  confidence: number,
  recordsExtracted: number,
  cleanupPassRate: number,
  noiseRatio: number,
  schemaSignalRate: number,
  requiredFieldCoverage: number
): SourceQualityScore {
  const parseSuccess = Math.max(0, Math.min(1, recordsExtracted / 300));
  return {
    officialness: confidence,
    parseSuccess,
    schemaCoverage: parseSuccess,
    noisePenalty: 1 - parseSuccess,
    cleanupPassRate,
    noiseRatio,
    schemaSignalRate,
    requiredFieldCoverage,
    freshness: 0.6,
    latencyCost: 0.6,
    completeness: parseSuccess,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function readEvidence(path: string, maxBytes: number): string {
  try {
    return readFileSync(path, "utf-8").slice(0, maxBytes);
  } catch {
    return "";
  }
}

function readCleanupRecords(path: string): CleanupResultRecord[] {
  try {
    const parsed = readNdjsonFile<CleanupResultRecord>(path);
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    // Fall through to JSON fallback for backward compatibility.
  }

  try {
    const json = JSON.parse(readFileSync(path, "utf-8")) as {
      records?: Array<{ fields?: Record<string, string>; row?: string[] }>;
    };
    return (json.records ?? []).map((record, index) => {
      const text =
        record.fields?.line ||
        Object.values(record.fields ?? {})
          .map((value) => String(value))
          .join(" | ") ||
        record.row?.join(" | ") ||
        "";
      return {
        id: `legacy:${index + 1}`,
        sourceId: "legacy",
        sourceType: "unknown",
        target: "schedule",
        sourceRecordIndex: index,
        action: "keep",
        text,
        normalizedFields: record.fields ?? { line: text },
        confidence: 0.5,
        reasonTags: ["legacy-fallback"],
        flags: [],
      };
    });
  } catch {
    return [];
  }
}
