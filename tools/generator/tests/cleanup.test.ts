import { describe, expect, test } from "bun:test";
import {
  canonicalizeTextForTest,
  evaluateCleanupGate,
  runCleanupPhase,
} from "../extract/cleanup.js";
import type { ExecutorOutput } from "../executors/types.js";

describe("cleanup canonicalization", () => {
  test("removes numeric prefixes and normalizes whitespace", () => {
    expect(canonicalizeTextForTest(" 80_  燃やすごみ ")).toBe("燃やすごみ");
  });
});

describe("cleanup gate evaluation", () => {
  test("returns expected veto reasons", () => {
    const reasons = evaluateCleanupGate(
      {
        passRate: 0.4,
        noiseRatio: 0.4,
        schemaSignalRate: 0.01,
        cleanCount: 0,
      },
      {
        target: "separation",
        minPassRate: 0.9,
        maxNoiseRatio: 0.08,
      }
    );

    expect(reasons).toContain("no-clean-records");
    expect(reasons.some((reason) => reason.startsWith("pass-rate-below-threshold"))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("noise-ratio-above-threshold"))).toBe(true);
  });
});

describe("cleanup hybrid fallback", () => {
  test("degrades gracefully when model chunk cleanup fails", async () => {
    const output: ExecutorOutput = {
      target: "separation",
      sourceType: "html",
      sourcePath: "/tmp/test.html",
      preview: "",
      records: [
        { fields: { line: "ごみ分別一覧" } },
        { fields: { line: "80_燃やすごみ" } },
        { fields: { line: "トップページ" } },
      ],
    };

    const result = await runCleanupPhase({
      model: {},
      sourceId: "src-1",
      sourceType: "html",
      target: "separation",
      output,
      mode: "hybrid",
      maxModelMs: 100,
      maxChunkBytes: 512,
      maxChunks: 2,
      minPassRate: 0.1,
      maxNoiseRatio: 0.9,
    });

    expect(result.status === "degraded" || result.status === "applied").toBe(true);
    expect(result.metrics.cleanCount).toBeGreaterThan(0);
  });
});

describe("cleanup noise guard", () => {
  test("keeps separation table rows that include section labels with valid fields", async () => {
    const output: ExecutorOutput = {
      target: "separation",
      sourceType: "html",
      sourcePath: "/tmp/test.html",
      preview: "",
      records: [
        {
          fields: {
            line: "[あ行で始まる資源・ごみ] | アイロン | 陶器・ガラス・金属ごみ | なし",
            品目: "アイロン",
            出し方: "陶器・ガラス・金属ごみ",
            分類: "陶器・ガラス・金属ごみ",
          },
        },
      ],
    };

    const result = await runCleanupPhase({
      model: {},
      sourceId: "src-2",
      sourceType: "html",
      target: "separation",
      output,
      mode: "deterministic",
      maxModelMs: 100,
      maxChunkBytes: 512,
      maxChunks: 2,
      minPassRate: 0.9,
      maxNoiseRatio: 0.08,
    });

    expect(result.metrics.cleanCount).toBe(1);
    expect(result.metrics.vetoReasons.length).toBe(0);
  });
});
