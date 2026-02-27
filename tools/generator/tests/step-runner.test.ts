import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Logger } from "../pipeline/logger.js";
import { RunStateStore } from "../pipeline/state.js";
import { runStep } from "../pipeline/step-runner.js";
import type { GenerateOptions } from "../pipeline/types.js";

function createOptions(workDir: string): GenerateOptions {
  return {
    city: "品川区",
    prefecture: "東京都",
    runId: "test-run",
    workDir,
    verbose: false,
    agentLogs: false,
    eventFile: undefined,
    maxFixRetries: 1,
    resume: false,
    httpTimeoutMs: 1000,
    maxDownloadBytes: 1024,
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
    skillsMode: "hybrid",
    strictSkillsCompat: true,
    logFormat: "pretty",
    forceSteps: new Set(),
  };
}

describe("runStep", () => {
  test("retries and succeeds", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-step-runner-"));
    const store = RunStateStore.loadOrCreate(createOptions(workDir));
    const logger = new Logger("test-run", "pretty");

    let attempts = 0;
    await runStep(
      {
        name: "discover",
        timeoutMs: 200,
        maxAttempts: 2,
        run: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("first fail");
          }
        },
      },
      {},
      store,
      logger,
      { shouldRun: true, force: false }
    );

    expect(attempts).toBe(2);
    expect(store.state.stepStatuses.discover.status).toBe("succeeded");
    expect(store.state.stepStatuses.discover.attempts).toBe(2);
  });

  test("times out and fails", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-step-runner-timeout-"));
    const store = RunStateStore.loadOrCreate(createOptions(workDir));
    const logger = new Logger("test-run", "pretty");

    await expect(
      runStep(
        {
          name: "download",
          timeoutMs: 20,
          maxAttempts: 1,
          run: async (_ctx, signal) => {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 100);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true }
              );
            });
          },
        },
        {},
        store,
        logger,
        { shouldRun: true, force: false }
      )
    ).rejects.toThrow("timed out");

    expect(store.state.stepStatuses.download.status).toBe("failed");
  });
});
