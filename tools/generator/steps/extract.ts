import { join } from "path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../lib/json.js";
import { runExtractionPlan } from "../executors/run-plan.js";
import type { ExtractionPlan } from "../pipeline/types.js";
import type { PipelineContext } from "../pipeline/context.js";

export async function runExtractStep(
  context: PipelineContext,
  _signal: AbortSignal
): Promise<void> {
  const { options, stateStore, logger } = context;
  const planPath = stateStore.state.extractionPlanPath || join(options.workDir, "extraction-plan.json");
  const plan = readJsonFile<ExtractionPlan>(planPath);

  stateStore.setStepMessage("extract", "Running extractor tasks");
  const artifactsDir = join(options.workDir, "artifacts");
  ensureDir(artifactsDir);

  const report = await runExtractionPlan({
    plan,
    artifactsDir,
    runtime: context.runtime,
    skillsStatus: context.skillsStatus,
    model: context.model,
    cleanup: {
      mode: options.cleanupMode,
      required: options.htmlCleanupRequired,
      failurePolicy: options.htmlCleanupFailurePolicy,
      maxModelMs: options.cleanupMaxModelMs,
      maxChunkBytes: options.cleanupChunkBytes,
      maxChunks: options.cleanupMaxChunks,
      minPassRate: options.cleanupMinPassRate,
      maxNoiseRatio: options.cleanupMaxNoiseRatio,
    },
    html: {
      mode: options.htmlExtractorMode,
      followLinks: options.htmlFollowLinks,
      maxFollowLinks: options.htmlMaxFollowLinks,
      linkTypes: new Set(options.htmlLinkTypes),
      minBlockScore: options.htmlMinBlockScore,
    },
  });

  const reportPath = join(options.workDir, "execution-report.json");
  const cleanupReportPath = join(options.workDir, "cleanup-report.json");
  writeJsonAtomic(reportPath, report);
  writeJsonAtomic(cleanupReportPath, {
    runId: options.runId,
    createdAt: new Date().toISOString(),
    sources: report.cleanupReport,
  });
  stateStore.state.executionReportPath = reportPath;
  stateStore.persist();

  const failed = report.results.filter((result) => result.status === "failed");
  const skipped = report.results.filter((result) => result.status === "skipped");
  const vetoedSources = report.cleanupReport.filter((entry) => entry.metrics.vetoReasons.length > 0);

  logger.info("Cleanup summary", {
    step: "extract",
    eventType: "cleanup.summary",
    sourceCount: report.cleanupReport.length,
    vetoedSources: vetoedSources.length,
    skippedTasks: skipped.length,
    cleanupReportPath,
  });
  logger.info("Extraction tasks completed", {
    step: "extract",
    eventType: "executor.lifecycle",
    phase: "end",
    totalTasks: report.results.length,
    failedTasks: failed.length,
    skippedTasks: skipped.length,
    reportPath,
  });

  if (failed.length > 0 && options.mode === "fast") {
    throw new Error(
      `Extractor failed in fast mode: ${failed
        .map((entry) => `${entry.sourceId}:${entry.errors.join(",")}`)
        .join("; ")}`
    );
  }
}
