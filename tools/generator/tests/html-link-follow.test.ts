import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runExtractionPlan } from "../executors/run-plan.js";
import type { ExtractionPlan, ModelRuntimeConfig } from "../pipeline/types.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "tokyo", "shinagawa");

describe("html link follow", () => {
  test("expands index html extraction using linked html source", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gomi-html-follow-"));

    const plan: ExtractionPlan = {
      version: "1.0.0",
      runId: "test-html-follow",
      createdAt: new Date().toISOString(),
      sources: [
        {
          id: "separation-html-1",
          type: "html",
          url: "https://www.city.shinagawa.tokyo.jp/PC/kankyo/kankyo-gomi/kankyo-gomi-bunbetsu/index.html",
          localPath: join(FIXTURE_DIR, "separation.html"),
          priority: 1,
          trustScore: 0.8,
        },
        {
          id: "separation-html-2",
          type: "html",
          url: "https://www.city.shinagawa.tokyo.jp/PC/kankyo/kankyo-gomi/gomi-kateigomi/gomi-kateigomi-dashikata/hpg000005617.html",
          localPath: join(FIXTURE_DIR, "separation-2.html"),
          priority: 2,
          trustScore: 0.8,
        },
      ],
      tasks: [
        {
          id: "task-separation-html-1",
          sourceId: "separation-html-1",
          sourceType: "html",
          executorType: "html",
          target: "separation",
          outputSchema: "separation-raw",
          timeoutMs: 20_000,
          fallback: [],
          requiredFeatures: ["document_parse"],
          preferredPath: "local",
        },
      ],
    };

    const runtime: ModelRuntimeConfig = {
      modelId: "glm-4.7",
      baseURL: "https://api.z.ai/api/anthropic/v1",
      apiKey: "",
      enableSkills: false,
      skillsMode: "local",
      strictSkillsCompat: true,
    };

    const report = await runExtractionPlan({
      plan,
      artifactsDir: join(workDir, "artifacts"),
      runtime,
      model: {},
      cleanup: {
        mode: "deterministic",
        required: true,
        failurePolicy: "skip-source",
        maxModelMs: 8_000,
        maxChunkBytes: 6_000,
        maxChunks: 8,
        minPassRate: 0.9,
        maxNoiseRatio: 0.08,
      },
      html: {
        mode: "hybrid",
        followLinks: true,
        maxFollowLinks: 2,
        linkTypes: new Set(["html"]),
        minBlockScore: 1.8,
      },
    });

    const result = report.results.find((entry) => entry.sourceId === "separation-html-1");
    expect(result).toBeDefined();
    expect(result?.status).toBe("succeeded");
    expect(result?.recordsExtracted ?? 0).toBeGreaterThan(200);
  });
});
