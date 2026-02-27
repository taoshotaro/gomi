import { describe, expect, test } from "bun:test";
import { applyQueryPolicy, normalizeQuery } from "../discover/query-policy.js";

describe("discover query policy", () => {
  test("normalizes near-duplicate query variants", () => {
    const a = normalizeQuery("品川区 ごみ収集日 CSV");
    const b = normalizeQuery("CSV  品川区  ごみ収集日");
    expect(a).toBe(b);
  });

  test("dedupes and enforces seed count", () => {
    const result = applyQueryPolicy({
      queries: [
        "品川区 ごみ収集日 CSV",
        "CSV 品川区 ごみ収集日",
        "品川区 ごみ 分別 一覧",
        "品川区 ごみ 収集 曜日",
      ],
      seedCount: 3,
    });

    expect(result.queries.length).toBe(3);
    expect(result.duplicateRatio).toBeGreaterThan(0);
  });
});
