import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { selectPrimarySources } from "../selection/select.js";
import type { PipelineContext } from "../pipeline/context.js";
import type { ExtractionPlan, GenerateOptions } from "../pipeline/types.js";
import type { ExecutionReport } from "../executors/run-plan.js";

function createOptions(workDir: string): GenerateOptions {
  return {
    city: "品川区",
    prefecture: "東京都",
    runId: "test-selection",
    workDir,
    verbose: false,
    agentLogs: false,
    eventFile: undefined,
    maxFixRetries: 1,
    skipTo: undefined,
    resume: false,
    httpTimeoutMs: 1000,
    maxDownloadBytes: 1024 * 1024,
    mode: "fast",
    stopAfter: undefined,
    maxTotalMs: 120_000,
    maxStepMs: 30_000,
    maxModelMs: 10_000,
    discoverMaxSteps: 20,
    discoverMaxRounds: 2,
    discoverMaxCandidates: 30,
    discoverMaxFetches: 20,
    discoverLinkDepth: 1,
    discoverAllowHosts: undefined,
    discoverStopMode: "quality",
    discoverQualityPolicy: {
      scheduleThreshold: 0.82,
      separationThreshold: 0.78,
      requireMachineReadableSchedule: true,
      scoringMode: "evidence-v1",
      minCoverageSchedule: 0.75,
      minCoverageSeparation: 0.7,
      maxNoiseRatio: 0.12,
      minCleanupPassRate: 0.85,
      freshnessHalfLifeDays: 365,
    },
    discoverTimeoutPolicy: {
      baseMs: 35_000,
      stepMs: 10_000,
      maxMs: 90_000,
      softFail: true,
    },
    discoverToolBudgetPolicy: {
      searchCap: 3,
      fetchCap: 12,
      seedQueryCount: 3,
      maxHostSwitches: 4,
      maxQueryDupRatio: 0.15,
    },
    discoverDomainLockPolicy: {
      requireOfficialDomain: true,
      noOfficialDomainStrategy: "fail-fast",
    },
    selectionMode: "deterministic",
    selectionTopK: 3,
    selectionMaxModelMs: 10_000,
    selectionConfidenceThreshold: 0.7,
    selectionEvidenceBytes: 2_000,
    cleanupMode: "hybrid",
    cleanupMaxModelMs: 8_000,
    cleanupChunkBytes: 6_000,
    cleanupMaxChunks: 8,
    cleanupMinPassRate: 0.9,
    cleanupMaxNoiseRatio: 0.08,
    htmlExtractorMode: "hybrid",
    htmlFollowLinks: true,
    htmlMaxFollowLinks: 2,
    htmlLinkTypes: ["html", "csv", "xlsx", "pdf", "api"],
    htmlMinBlockScore: 1.8,
    htmlCleanupTimeoutMs: 45_000,
    htmlCleanupRequired: true,
    htmlCleanupFailurePolicy: "skip-source",
    maxHtmlCleanupCalls: 2,
    driftThreshold: 0.2,
    maxConvertFixRetries: 1,
    allowLlmRecordFallback: false,
    convertEngine: "template",
    plannerOnly: false,
    executorOnly: false,
    sourceTypes: undefined,
    modelId: undefined,
    baseUrl: undefined,
    enableSkills: false,
    skillsMode: "local",
    strictSkillsCompat: true,
    logFormat: "pretty",
    forceSteps: new Set(),
    url: undefined,
  };
}

function writeExecutorOutput(path: string): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        target: "schedule",
        sourceType: "csv",
        sourcePath: path,
        preview: "sample",
        records: [{ fields: { line: "燃やすごみ 火 金" } }],
      },
      null,
      2
    )
  );
}

describe("source selection", () => {
  test("selects per-target primary independently", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-selection-"));
    const artifactsDir = join(workDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const scheduleCsvPath = join(artifactsDir, "schedule-csv.json");
    const separationHtmlPath = join(artifactsDir, "separation-html.json");
    writeExecutorOutput(scheduleCsvPath);
    writeExecutorOutput(separationHtmlPath);

    const plan: ExtractionPlan = {
      version: "1.0.0",
      runId: "test-selection",
      createdAt: new Date().toISOString(),
      sources: [
        {
          id: "schedule-csv-1",
          type: "csv",
          url: "https://example.com/schedule.csv",
          localPath: scheduleCsvPath,
          priority: 1,
          trustScore: 0.95,
        },
        {
          id: "separation-html-1",
          type: "html",
          url: "https://example.com/separation.html",
          localPath: separationHtmlPath,
          priority: 2,
          trustScore: 0.8,
        },
      ],
      tasks: [],
    };

    const report: ExecutionReport = {
      runId: "test-selection",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      cleanupReport: [],
      results: [
        {
          taskId: "task-schedule",
          sourceId: "schedule-csv-1",
          executorType: "csv",
          target: "schedule",
          status: "succeeded",
          recordsExtracted: 200,
          confidence: 0.95,
          sourceQuality: {
            officialness: 0.95,
            parseSuccess: 0.95,
            schemaCoverage: 0.9,
            noisePenalty: 0.05,
            cleanupPassRate: 0.96,
            noiseRatio: 0.04,
            schemaSignalRate: 0.9,
            requiredFieldCoverage: 0.9,
            freshness: 0.8,
            latencyCost: 0.8,
            completeness: 0.9,
            confidence: 0.91,
          },
          durationMs: 30,
          errors: [],
          outputPath: scheduleCsvPath,
          executionPath: "local",
        },
        {
          taskId: "task-separation",
          sourceId: "separation-html-1",
          executorType: "html",
          target: "separation",
          status: "succeeded",
          recordsExtracted: 180,
          confidence: 0.85,
          sourceQuality: {
            officialness: 0.8,
            parseSuccess: 0.85,
            schemaCoverage: 0.9,
            noisePenalty: 0.1,
            cleanupPassRate: 0.95,
            noiseRatio: 0.05,
            schemaSignalRate: 0.9,
            requiredFieldCoverage: 0.88,
            freshness: 0.8,
            latencyCost: 0.8,
            completeness: 0.8,
            confidence: 0.82,
          },
          durationMs: 40,
          errors: [],
          outputPath: separationHtmlPath,
          executionPath: "local",
          cleanupApplied: true,
          cleanupStatus: "applied",
        },
      ],
    };

    const context = {
      options: createOptions(workDir),
      model: {},
    } as unknown as PipelineContext;

    const selection = await selectPrimarySources({
      context,
      plan,
      report,
    });

    expect(selection.decisions.schedule.primarySourceId).toBe("schedule-csv-1");
    expect(selection.decisions.separation.primarySourceId).toBe("separation-html-1");
  });

  test("vetoes low-confidence candidate and falls back", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-selection-veto-"));
    const artifactsDir = join(workDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const aPath = join(artifactsDir, "a.json");
    const bPath = join(artifactsDir, "b.json");
    const sepPath = join(artifactsDir, "sep.json");
    writeExecutorOutput(aPath);
    writeExecutorOutput(bPath);
    writeExecutorOutput(sepPath);

    const options = createOptions(workDir);
    options.selectionConfidenceThreshold = 0.7;
    options.selectionMode = "deterministic";

    const plan: ExtractionPlan = {
      version: "1.0.0",
      runId: "test-selection",
      createdAt: new Date().toISOString(),
      sources: [
        { id: "schedule-a", type: "csv", url: "https://a", localPath: aPath, priority: 1, trustScore: 0.9 },
        { id: "schedule-b", type: "csv", url: "https://b", localPath: bPath, priority: 2, trustScore: 0.9 },
        { id: "separation-h", type: "html", url: "https://h", localPath: sepPath, priority: 1, trustScore: 0.8 },
      ],
      tasks: [],
    };
    const report: ExecutionReport = {
      runId: "test-selection",
      startedAt: "",
      finishedAt: "",
      cleanupReport: [],
      results: [
        {
          taskId: "a",
          sourceId: "schedule-a",
          executorType: "csv",
          target: "schedule",
          status: "succeeded",
          recordsExtracted: 200,
          confidence: 0.8,
          sourceQuality: {
            officialness: 0.9,
            parseSuccess: 0.6,
            schemaCoverage: 0.9,
            noisePenalty: 0.9,
            cleanupPassRate: 0.92,
            noiseRatio: 0.82,
            schemaSignalRate: 0.75,
            requiredFieldCoverage: 0.7,
            freshness: 0.7,
            latencyCost: 0.7,
            completeness: 0.7,
            confidence: 0.95,
          },
          durationMs: 10,
          errors: [],
          outputPath: aPath,
          executionPath: "local",
        },
        {
          taskId: "b",
          sourceId: "schedule-b",
          executorType: "csv",
          target: "schedule",
          status: "succeeded",
          recordsExtracted: 200,
          confidence: 0.8,
          sourceQuality: {
            officialness: 0.9,
            parseSuccess: 0.9,
            schemaCoverage: 0.9,
            noisePenalty: 0.05,
            cleanupPassRate: 0.95,
            noiseRatio: 0.04,
            schemaSignalRate: 0.9,
            requiredFieldCoverage: 0.9,
            freshness: 0.7,
            latencyCost: 0.7,
            completeness: 0.7,
            confidence: 0.9,
          },
          durationMs: 10,
          errors: [],
          outputPath: bPath,
          executionPath: "local",
        },
        {
          taskId: "sep",
          sourceId: "separation-h",
          executorType: "html",
          target: "separation",
          status: "succeeded",
          recordsExtracted: 100,
          confidence: 0.8,
          sourceQuality: {
            officialness: 0.8,
            parseSuccess: 0.8,
            schemaCoverage: 0.8,
            noisePenalty: 0.1,
            cleanupPassRate: 0.94,
            noiseRatio: 0.06,
            schemaSignalRate: 0.86,
            requiredFieldCoverage: 0.8,
            freshness: 0.7,
            latencyCost: 0.7,
            completeness: 0.7,
            confidence: 0.8,
          },
          durationMs: 10,
          errors: [],
          outputPath: sepPath,
          executionPath: "local",
        },
      ],
    };
    const context = { options, model: {} } as unknown as PipelineContext;

    const selection = await selectPrimarySources({
      context,
      plan,
      report,
    });

    expect(selection.decisions.schedule.primarySourceId).toBe("schedule-b");
    expect(selection.decisions.schedule.vetoed ?? false).toBe(false);
  });

  test("hybrid mode falls back to deterministic when model selection fails", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-selection-hybrid-"));
    const artifactsDir = join(workDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const schedulePath = join(artifactsDir, "schedule.json");
    const separationPath = join(artifactsDir, "separation.json");
    writeExecutorOutput(schedulePath);
    writeExecutorOutput(separationPath);

    const options = createOptions(workDir);
    options.selectionMode = "hybrid";
    options.selectionTopK = 2;
    options.selectionMaxModelMs = 100;

    const plan: ExtractionPlan = {
      version: "1.0.0",
      runId: "test-selection",
      createdAt: new Date().toISOString(),
      sources: [
        {
          id: "schedule-csv-1",
          type: "csv",
          url: "https://example.com/schedule.csv",
          localPath: schedulePath,
          priority: 1,
          trustScore: 0.95,
        },
        {
          id: "separation-html-1",
          type: "html",
          url: "https://example.com/separation.html",
          localPath: separationPath,
          priority: 1,
          trustScore: 0.8,
        },
      ],
      tasks: [],
    };
    const report: ExecutionReport = {
      runId: "test-selection",
      startedAt: "",
      finishedAt: "",
      cleanupReport: [],
      results: [
        {
          taskId: "schedule",
          sourceId: "schedule-csv-1",
          executorType: "csv",
          target: "schedule",
          status: "succeeded",
          recordsExtracted: 200,
          confidence: 0.95,
          sourceQuality: {
            officialness: 0.95,
            parseSuccess: 0.9,
            schemaCoverage: 0.9,
            noisePenalty: 0.1,
            cleanupPassRate: 0.95,
            noiseRatio: 0.05,
            schemaSignalRate: 0.9,
            requiredFieldCoverage: 0.9,
            freshness: 0.7,
            latencyCost: 0.7,
            completeness: 0.7,
            confidence: 0.9,
          },
          durationMs: 10,
          errors: [],
          outputPath: schedulePath,
          executionPath: "local",
        },
        {
          taskId: "separation",
          sourceId: "separation-html-1",
          executorType: "html",
          target: "separation",
          status: "succeeded",
          recordsExtracted: 100,
          confidence: 0.8,
          sourceQuality: {
            officialness: 0.8,
            parseSuccess: 0.8,
            schemaCoverage: 0.8,
            noisePenalty: 0.1,
            cleanupPassRate: 0.93,
            noiseRatio: 0.07,
            schemaSignalRate: 0.84,
            requiredFieldCoverage: 0.8,
            freshness: 0.7,
            latencyCost: 0.7,
            completeness: 0.7,
            confidence: 0.8,
          },
          durationMs: 10,
          errors: [],
          outputPath: separationPath,
          executionPath: "local",
        },
      ],
    };
    const context = {
      options,
      model: {},
    } as unknown as PipelineContext;

    const selection = await selectPrimarySources({
      context,
      plan,
      report,
    });

    expect(selection.decisions.schedule.primarySourceId).toBe("schedule-csv-1");
    expect(selection.decisions.separation.primarySourceId).toBe("separation-html-1");
  });
});
