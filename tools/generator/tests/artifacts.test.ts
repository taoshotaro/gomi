import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Logger } from "../pipeline/logger.js";
import { RunStateStore } from "../pipeline/state.js";
import { BudgetManager } from "../pipeline/budget.js";
import { writeJsonAtomic } from "../lib/json.js";
import { assertStepInputsAvailable } from "../pipeline/artifacts.js";
import type { DiscoverOutputV2, GenerateOptions } from "../pipeline/types.js";
import type { PipelineContext } from "../pipeline/context.js";

function createOptions(workDir: string): GenerateOptions {
  return {
    city: "品川区",
    prefecture: "東京都",
    runId: "test-artifacts",
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
    selectionMode: "hybrid",
    selectionTopK: 3,
    selectionMaxModelMs: 12_000,
    selectionConfidenceThreshold: 0.7,
    selectionEvidenceBytes: 12_000,
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

function buildContext(workDir: string): PipelineContext {
  const options = createOptions(workDir);
  const store = RunStateStore.loadOrCreate(options);
  mkdirSync(join(workDir, "downloads"), { recursive: true });
  mkdirSync(join(workDir, "staging"), { recursive: true });
  return {
    options,
    logger: new Logger(options.runId, "pretty"),
    stateStore: store,
    model: {} as never,
    dirs: {
      downloadDir: join(workDir, "downloads"),
      stagingDir: join(workDir, "staging"),
      summaryPath: join(workDir, "summary.json"),
    },
    budget: new BudgetManager(options.maxTotalMs, options.maxStepMs),
    runtime: {
      modelId: "GLM-4.7",
      baseURL: "https://api.z.ai/api/anthropic/v1",
      apiKey: "test",
      enableSkills: false,
      skillsMode: "local",
      strictSkillsCompat: true,
    },
  };
}

const SOURCES: DiscoverOutputV2 = {
  version: "2.0.0",
  cityId: "shinagawa",
  prefectureId: "tokyo",
  officialUrl: "https://www.city.shinagawa.tokyo.jp",
  officialDomains: ["shinagawa.tokyo.jp"],
  candidates: [],
  selected: {
    schedule: [],
    separation: [],
  },
};

describe("artifact preconditions", () => {
  test("uses canonical source-manifest path and updates pointer", () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-artifact-check-"));
    const context = buildContext(workDir);
    context.stateStore.setSources(SOURCES);

    const manifestPath = join(workDir, "source-manifest.json");
    writeJsonAtomic(manifestPath, []);

    assertStepInputsAvailable("extraction-plan", context);
    expect(context.stateStore.state.sourceManifestPath).toBe(manifestPath);
  });

  test("fails fast when skipped upstream artifact is missing", () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-artifact-missing-"));
    const context = buildContext(workDir);
    context.stateStore.setSources(SOURCES);

    expect(() => assertStepInputsAvailable("extract", context)).toThrow(
      'Missing required artifact for step "extract"'
    );
  });
});
