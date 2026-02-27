import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { createModel } from "../lib/ai.js";
import { ensureDir, writeJsonAtomic } from "../lib/json.js";
import { cityStagingDir } from "../lib/paths.js";
import { runDiscoverStep } from "../steps/discover.js";
import { runDownloadStep } from "../steps/download.js";
import { runExtractionPlanStep } from "../steps/extraction-plan.js";
import { runExtractStep } from "../steps/extract.js";
import { runConvertStep } from "../steps/convert.js";
import { runValidateStep } from "../steps/validate.js";
import type { PipelineContext, RuntimeDirs } from "./context.js";
import { BudgetManager } from "./budget.js";
import { initializeEventEmitter } from "./events.js";
import { Logger } from "./logger.js";
import { runStep } from "./step-runner.js";
import { RunStateStore, runStatePath } from "./state.js";
import type { GenerateOptions, OrderedStepName, StepName } from "./types.js";
import { STEP_ORDER } from "./types.js";
import { assertStepInputsAvailable, hydrateArtifactPointers } from "./artifacts.js";
import {
  enforceNativeSkillsStatus,
  preflightNativeSkillsCompatibility,
} from "../skills/native-anthropic.js";

export async function runGenerateCityPipeline(options: GenerateOptions): Promise<void> {
  initializeEventEmitter({
    runId: options.runId,
    format: options.logFormat,
    verbose: options.verbose,
    agentLogs: options.agentLogs,
    redactionPolicy: "strict",
    eventsLogPath: join(options.workDir, "events.log"),
    eventFilePath: options.eventFile || join(options.workDir, "events.jsonl"),
  });

  const logger = new Logger(
    options.runId,
    options.logFormat,
    join(options.workDir, "events.log"),
    options.verbose
  );
  ensureDir(options.workDir);

  const statePath = runStatePath(options.workDir);
  if (options.resume && !existsSync(statePath)) {
    throw new Error(`--resume requested but run-state not found: ${statePath}`);
  }

  const stateStore = RunStateStore.loadOrCreate(options);
  stateStore.ensurePendingForForcedSteps(options.forceSteps);
  const budget = new BudgetManager(options.maxTotalMs, options.maxStepMs);

  const dirs: RuntimeDirs = {
    downloadDir: join(options.workDir, "downloads"),
    stagingDir: join(options.workDir, "staging"),
    summaryPath: join(options.workDir, "summary.json"),
  };

  ensureDir(dirs.downloadDir);

  const runtime = {
    modelId: options.modelId || process.env.MODEL || "glm-4.7",
    baseURL: resolveDefaultBaseURL(
      options.baseUrl || process.env.ANTHROPIC_BASE_URL || process.env.LLM_BASE_URL
    ),
    apiKey: process.env.LLM_API_KEY || "",
    enableSkills: options.enableSkills,
    skillsMode: options.skillsMode,
    strictSkillsCompat: options.strictSkillsCompat,
  } as const;
  const model = createModel(runtime);

  const context: PipelineContext = {
    options,
    logger,
    stateStore,
    model,
    dirs,
    budget,
    runtime,
  };

  if (options.enableSkills && (options.skillsMode === "native" || options.skillsMode === "hybrid")) {
    const status = await preflightNativeSkillsCompatibility(runtime);
    context.skillsStatus = status;
    enforceNativeSkillsStatus({
      status,
      runtime,
    });
  }

  await prepareWorkDirArtifacts(context);
  syncStagingDir(context);

  logger.info("Pipeline start", {
    eventType: "summary",
    model: runtime.modelId,
    baseURLHost: safeHost(runtime.baseURL),
    workDir: options.workDir,
    skipTo: options.skipTo,
    resume: options.resume,
    mode: options.mode,
    stopAfter: options.stopAfter,
    maxTotalMs: options.maxTotalMs,
    maxStepMs: options.maxStepMs,
    maxModelMs: options.maxModelMs,
    discoverMaxSteps: options.discoverMaxSteps,
    discoverMaxRounds: options.discoverMaxRounds,
    discoverMaxCandidates: options.discoverMaxCandidates,
    discoverMaxFetches: options.discoverMaxFetches,
    discoverLinkDepth: options.discoverLinkDepth,
    discoverAllowHosts: options.discoverAllowHosts,
    discoverStopMode: options.discoverStopMode,
    discoverQualityPolicy: options.discoverQualityPolicy,
    discoverTimeoutPolicy: options.discoverTimeoutPolicy,
    discoverToolBudgetPolicy: options.discoverToolBudgetPolicy,
    discoverDomainLockPolicy: options.discoverDomainLockPolicy,
    selectionMode: options.selectionMode,
    selectionTopK: options.selectionTopK,
    selectionMaxModelMs: options.selectionMaxModelMs,
    selectionConfidenceThreshold: options.selectionConfidenceThreshold,
    selectionEvidenceBytes: options.selectionEvidenceBytes,
    cleanupMode: options.cleanupMode,
    cleanupMaxModelMs: options.cleanupMaxModelMs,
    cleanupChunkBytes: options.cleanupChunkBytes,
    cleanupMaxChunks: options.cleanupMaxChunks,
    cleanupMinPassRate: options.cleanupMinPassRate,
    cleanupMaxNoiseRatio: options.cleanupMaxNoiseRatio,
    htmlExtractorMode: options.htmlExtractorMode,
    htmlFollowLinks: options.htmlFollowLinks,
    htmlMaxFollowLinks: options.htmlMaxFollowLinks,
    htmlLinkTypes: options.htmlLinkTypes,
    htmlMinBlockScore: options.htmlMinBlockScore,
    htmlCleanupTimeoutMs: options.htmlCleanupTimeoutMs,
    htmlCleanupRequired: options.htmlCleanupRequired,
    htmlCleanupFailurePolicy: options.htmlCleanupFailurePolicy,
    maxHtmlCleanupCalls: options.maxHtmlCleanupCalls,
    driftThreshold: options.driftThreshold,
    maxConvertFixRetries: options.maxConvertFixRetries,
    allowLlmRecordFallback: options.allowLlmRecordFallback,
    convertEngine: options.convertEngine,
    skillsMode: options.skillsMode,
    enableSkills: options.enableSkills,
    strictSkillsCompat: options.strictSkillsCompat,
  });

  const runDefinition = [
    {
      name: "discover" as const,
      timeoutMs: 4 * 60 * 1000,
      maxAttempts: 3,
      run: runDiscoverStep,
    },
    {
      name: "download" as const,
      timeoutMs: 3 * 60 * 1000,
      maxAttempts: 2,
      run: runDownloadStep,
    },
    {
      name: "extraction-plan" as const,
      timeoutMs: 45 * 1000,
      maxAttempts: 2,
      run: runExtractionPlanStep,
    },
    {
      name: "extract" as const,
      timeoutMs: 90 * 1000,
      maxAttempts: 2,
      run: runExtractStep,
    },
    {
      name: "convert" as const,
      timeoutMs: 90 * 1000,
      maxAttempts: 2,
      run: runConvertStep,
    },
    {
      name: "validate" as const,
      timeoutMs: 5 * 60 * 1000,
      maxAttempts: 1,
      run: runValidateStep,
    },
  ];

  const plannerOnlyTerminalStep: OrderedStepName = "extraction-plan";
  const executorOnlySkipStart: OrderedStepName = "extract";

  for (const step of runDefinition) {
    budget.enforceTotalBudget(step.name);
    await runStep(
      {
        ...step,
        run: async (ctx, signal) => {
          assertStepInputsAvailable(step.name, ctx as PipelineContext);
          await step.run(ctx as PipelineContext, signal);
        },
      },
      context,
      stateStore,
      logger,
      {
      shouldRun: shouldRunStep(
        options.skipTo,
        options.stopAfter,
        step.name,
        options,
        plannerOnlyTerminalStep,
        executorOnlySkipStart
      ),
      force: options.forceSteps.has(step.name),
      }
    );

    if (step.name === "discover") {
      syncStagingDir(context);
    }
  }

  stateStore.markFinished();
  writeJsonAtomic(dirs.summaryPath, {
    runId: options.runId,
    city: options.city,
    prefecture: options.prefecture,
    workDir: options.workDir,
    finishedAt: new Date().toISOString(),
    stepStatuses: stateStore.state.stepStatuses,
    artifacts: stateStore.state.artifacts,
    sources: stateStore.state.sources,
    sourceManifestPath: stateStore.state.sourceManifestPath,
    discoverReportPath: stateStore.state.discoverReportPath,
    extractionPlanPath: stateStore.state.extractionPlanPath,
    executionReportPath: stateStore.state.executionReportPath,
    selectionReportPath: stateStore.state.selectionReportPath,
  });

  logger.info("Pipeline completed", {
    eventType: "summary",
    summaryPath: dirs.summaryPath,
  });
}

function safeHost(baseURL: string): string {
  try {
    return new URL(baseURL).host.toLowerCase();
  } catch {
    return "invalid-base-url";
  }
}

function resolveDefaultBaseURL(candidate: string | undefined): string {
  const fallback = "https://api.z.ai/api/anthropic/v1";
  if (!candidate) {
    return fallback;
  }
  const trimmed = candidate.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/anthropic")) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

async function prepareWorkDirArtifacts(context: PipelineContext): Promise<void> {
  hydrateArtifactPointers(context);
  const { options, logger, dirs } = context;
  const discoverEnabled = shouldRunStep(
    options.skipTo,
    options.stopAfter,
    "discover",
    options,
    "extraction-plan",
    "extract"
  );
  const downloadEnabled = shouldRunStep(
    options.skipTo,
    options.stopAfter,
    "download",
    options,
    "extraction-plan",
    "extract"
  );

  if (!discoverEnabled) {
    logger.info("Discover step skipped; expecting discover artifacts in work-dir", {
      step: "discover",
      eventType: "validation",
      workDir: options.workDir,
    });
  }
  if (!downloadEnabled && readdirSync(dirs.downloadDir).length === 0) {
    logger.info("Download step skipped with empty downloads directory; downstream steps will validate artifacts strictly", {
      step: "download",
      eventType: "validation",
      workDir: options.workDir,
    });
  }
}

function syncStagingDir(context: PipelineContext): void {
  const sources = context.stateStore.state.sources;
  if (!sources) {
    return;
  }

  context.dirs.stagingDir = cityStagingDir(
    context.options.runId,
    sources.prefectureId,
    sources.cityId
  );

  mkdirSync(context.dirs.stagingDir, { recursive: true });
}

function shouldRunStep(
  skipTo: OrderedStepName | undefined,
  stopAfter: OrderedStepName | undefined,
  step: OrderedStepName,
  options: GenerateOptions,
  plannerOnlyTerminalStep: OrderedStepName,
  executorOnlySkipStart: OrderedStepName
): boolean {
  const skipIndex = skipTo ? STEP_ORDER.indexOf(skipTo) : 0;
  const stopIndex = stopAfter ? STEP_ORDER.indexOf(stopAfter) : STEP_ORDER.length - 1;
  const stepIndex = STEP_ORDER.indexOf(step);
  if (stepIndex > stopIndex) {
    return false;
  }
  if (options.plannerOnly) {
    return (
      stepIndex >= skipIndex &&
      stepIndex <= STEP_ORDER.indexOf(plannerOnlyTerminalStep)
    );
  }
  if (options.executorOnly) {
    return (
      stepIndex >= Math.max(skipIndex, STEP_ORDER.indexOf(executorOnlySkipStart))
    );
  }
  if (!skipTo) {
    return true;
  }
  return stepIndex >= skipIndex;
}
