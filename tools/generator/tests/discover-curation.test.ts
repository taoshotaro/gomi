import { describe, expect, test } from "bun:test";
import {
  curateCandidates,
  detectSourceType,
  deriveOfficialDomains,
  evaluateDiscoverStop,
  hasTargetCoverage,
} from "../discover/curation.js";
import { calculateDiscoverRoundTimeout } from "../discover/engine.js";

describe("discover curation", () => {
  test("detects source types from URL/content type", () => {
    expect(detectSourceType("https://example.jp/a.csv")).toBe("csv");
    expect(detectSourceType("https://example.jp/a", "application/json")).toBe("api");
    expect(detectSourceType("https://example.jp/a.pdf")).toBe("pdf");
    expect(detectSourceType("https://example.jp/a.html")).toBe("html");
  });

  test("rejects utility pages and low trust candidates", () => {
    const curated = curateCandidates(
      [
        {
          url: "https://www.city.example.lg.jp/gomi/schedule.csv",
          title: "ごみ収集日 CSV",
          preview: "ごみ 収集 曜日",
          targetHints: ["schedule"],
          depth: 0,
        },
        {
          url: "https://www.city.example.lg.jp/sitemap.html",
          title: "サイトマップ",
          preview: "サイトマップ",
          targetHints: ["schedule"],
          depth: 0,
        },
        {
          url: "https://random.example.com/page.html",
          title: "blog",
          preview: "unrelated",
          targetHints: ["separation"],
          depth: 0,
        },
      ],
      {
        cityId: "shinagawa",
        prefectureId: "tokyo",
        officialDomains: deriveOfficialDomains("https://www.city.example.lg.jp/gomi"),
        officialUrl: "https://www.city.example.lg.jp/gomi",
        maxCandidates: 20,
      }
    );

    const rejected = curated.rejected.map((entry) => entry.rejectReason);
    expect(rejected).toContain("utility-navigation-page");
    expect(rejected).toContain("low-trust-host");

    expect(curated.output.selected.schedule.length).toBeGreaterThan(0);
  });

  test("coverage requires both schedule and separation", () => {
    expect(hasTargetCoverage({ schedule: ["a"], separation: ["b"] })).toBe(true);
    expect(hasTargetCoverage({ schedule: ["a"], separation: [] })).toBe(false);
  });

  test("quality stop requires thresholds and machine-readable schedule", () => {
    const curated = curateCandidates(
      [
        {
          url: "https://www.city.example.lg.jp/gomi/schedule.csv",
          title: "ごみ収集日 CSV",
          preview: "ごみ 収集 曜日",
          targetHints: ["schedule"],
        },
        {
          url: "https://www.city.example.lg.jp/gomi/separation.html",
          title: "ごみ分別一覧",
          preview: "分別 品目",
          targetHints: ["separation"],
        },
      ],
      {
        cityId: "shinagawa",
        prefectureId: "tokyo",
        officialDomains: deriveOfficialDomains("https://www.city.example.lg.jp/gomi"),
        officialUrl: "https://www.city.example.lg.jp/gomi",
        maxCandidates: 20,
      }
    );
    const decision = evaluateDiscoverStop(
      curated.output,
      {
        scheduleThreshold: 0.5,
        separationThreshold: 0.5,
        requireMachineReadableSchedule: true,
        scoringMode: "evidence-v1",
        minCoverageSchedule: 0.1,
        minCoverageSeparation: 0.1,
        maxNoiseRatio: 0.9,
        minCleanupPassRate: 0.1,
        freshnessHalfLifeDays: 365,
      },
      "quality"
    );
    expect(decision.ready).toBe(true);
    expect(decision.reason).toBe("quality-pass");
    expect(decision.metrics.schedulePrimaryType).toBe("csv");
  });

  test("quality stop fails when schedule primary is html and machine-readable is required", () => {
    const curated = curateCandidates(
      [
        {
          url: "https://www.city.example.lg.jp/gomi/schedule.html",
          title: "ごみ収集カレンダー",
          preview: "ごみ 収集 曜日",
          targetHints: ["schedule"],
        },
        {
          url: "https://www.city.example.lg.jp/gomi/separation.html",
          title: "ごみ分別一覧",
          preview: "分別 品目",
          targetHints: ["separation"],
        },
      ],
      {
        cityId: "shinagawa",
        prefectureId: "tokyo",
        officialDomains: deriveOfficialDomains("https://www.city.example.lg.jp/gomi"),
        officialUrl: "https://www.city.example.lg.jp/gomi",
        maxCandidates: 20,
      }
    );
    const decision = evaluateDiscoverStop(
      curated.output,
      {
        scheduleThreshold: 0.5,
        separationThreshold: 0.5,
        requireMachineReadableSchedule: true,
        scoringMode: "evidence-v1",
        minCoverageSchedule: 0.1,
        minCoverageSeparation: 0.1,
        maxNoiseRatio: 0.9,
        minCleanupPassRate: 0.1,
        freshnessHalfLifeDays: 365,
      },
      "quality"
    );
    expect(decision.ready).toBe(false);
    expect(decision.reason).toBe("quality-schedule-not-machine-readable");
  });
});

describe("discover timeout policy", () => {
  test("calculates bounded adaptive timeout per round", () => {
    expect(calculateDiscoverRoundTimeout(35_000, 10_000, 90_000, 1)).toBe(35_000);
    expect(calculateDiscoverRoundTimeout(35_000, 10_000, 90_000, 2)).toBe(45_000);
    expect(calculateDiscoverRoundTimeout(35_000, 10_000, 50_000, 3)).toBe(50_000);
  });
});
