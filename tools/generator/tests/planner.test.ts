import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { DiscoverOutputV2, SourceManifestEntry } from "../pipeline/types.js";
import { buildExtractionPlan } from "../planner/plan.js";

function createDiscoverOutput(): DiscoverOutputV2 {
  return {
    version: "2.0.0",
    cityId: "shinagawa",
    prefectureId: "tokyo",
    officialUrl: "https://example.jp",
    officialDomains: ["example.jp"],
    candidates: [
      {
        id: "src-schedule-csv",
        url: "https://example.jp/schedule.csv",
        type: "csv",
        targetHints: ["schedule"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 1,
        relevance: 1,
        score: 1,
        reasons: [],
      },
      {
        id: "src-schedule-html",
        url: "https://example.jp/schedule.html",
        type: "html",
        targetHints: ["schedule"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 0.3,
        relevance: 0.8,
        score: 0.8,
        reasons: [],
      },
      {
        id: "src-separation-html",
        url: "https://example.jp/separation.html",
        type: "html",
        targetHints: ["separation"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 0.3,
        relevance: 0.8,
        score: 0.8,
        reasons: [],
      },
    ],
    selected: {
      schedule: ["src-schedule-csv", "src-schedule-html"],
      separation: ["src-separation-html"],
    },
  };
}

describe("buildExtractionPlan", () => {
  test("chooses parser-first executors by source type", () => {
    const dir = mkdtempSync(join(tmpdir(), "gomi-planner-"));
    const csv = join(dir, "src-schedule-csv.csv");
    const html = join(dir, "src-schedule-html.html");
    const sep = join(dir, "src-separation-html.html");
    writeFileSync(csv, "area,mon\nA,yes\n");
    writeFileSync(html, "<html><body>schedule</body></html>");
    writeFileSync(sep, "<html><body>separation</body></html>");

    const manifest: SourceManifestEntry[] = [
      {
        sourceId: "src-schedule-csv",
        url: "https://example.jp/schedule.csv",
        type: "csv",
        targetHints: ["schedule"],
        localPath: csv,
        filename: "src-schedule-csv.csv",
        status: "downloaded",
      },
      {
        sourceId: "src-schedule-html",
        url: "https://example.jp/schedule.html",
        type: "html",
        targetHints: ["schedule"],
        localPath: html,
        filename: "src-schedule-html.html",
        status: "downloaded",
      },
      {
        sourceId: "src-separation-html",
        url: "https://example.jp/separation.html",
        type: "html",
        targetHints: ["separation"],
        localPath: sep,
        filename: "src-separation-html.html",
        status: "downloaded",
      },
    ];

    const plan = buildExtractionPlan({
      runId: "run-1",
      discover: createDiscoverOutput(),
      sourceManifest: manifest,
      maxStepMs: 30_000,
    });

    expect(plan.tasks.length).toBe(3);
    const csvTask = plan.tasks.find((task) => task.sourceType === "csv");
    expect(csvTask?.executorType).toBe("csv");
    const htmlTask = plan.tasks.find((task) => task.sourceId === "src-schedule-html");
    expect(htmlTask?.executorType).toBe("html");
  });

  test("adds required features for xlsx/pdf/image tasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "gomi-planner-features-"));
    const xlsx = join(dir, "src-schedule-xlsx.xlsx");
    const pdf = join(dir, "src-schedule-pdf.pdf");
    const image = join(dir, "src-separation-image.png");
    writeFileSync(xlsx, "xlsx-placeholder");
    writeFileSync(pdf, "pdf-placeholder");
    writeFileSync(image, "image-placeholder");

    const discover = createDiscoverOutput();
    discover.candidates.push(
      {
        id: "src-schedule-xlsx",
        url: "https://example.jp/schedule.xlsx",
        type: "xlsx",
        targetHints: ["schedule"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 0.9,
        relevance: 0.9,
        score: 0.9,
        reasons: [],
      },
      {
        id: "src-schedule-pdf",
        url: "https://example.jp/schedule.pdf",
        type: "pdf",
        targetHints: ["schedule"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 0.6,
        relevance: 0.7,
        score: 0.75,
        reasons: [],
      },
      {
        id: "src-separation-image",
        url: "https://example.jp/separation.png",
        type: "image",
        targetHints: ["separation"],
        host: "example.jp",
        depth: 0,
        officialness: 1,
        directness: 0.5,
        relevance: 0.7,
        score: 0.72,
        reasons: [],
      }
    );
    discover.selected.schedule = ["src-schedule-xlsx", "src-schedule-pdf"];
    discover.selected.separation = ["src-separation-image"];

    const manifest: SourceManifestEntry[] = [
      {
        sourceId: "src-schedule-xlsx",
        url: "https://example.jp/schedule.xlsx",
        type: "xlsx",
        targetHints: ["schedule"],
        localPath: xlsx,
        filename: "src-schedule-xlsx.xlsx",
        status: "downloaded",
      },
      {
        sourceId: "src-schedule-pdf",
        url: "https://example.jp/schedule.pdf",
        type: "pdf",
        targetHints: ["schedule"],
        localPath: pdf,
        filename: "src-schedule-pdf.pdf",
        status: "downloaded",
      },
      {
        sourceId: "src-separation-image",
        url: "https://example.jp/separation.png",
        type: "image",
        targetHints: ["separation"],
        localPath: image,
        filename: "src-separation-image.png",
        status: "downloaded",
      },
    ];

    const plan = buildExtractionPlan({
      runId: "run-2",
      discover,
      sourceManifest: manifest,
      maxStepMs: 30_000,
    });

    const xlsxTask = plan.tasks.find((task) => task.sourceType === "xlsx");
    const pdfTask = plan.tasks.find((task) => task.sourceType === "pdf");
    const imageTask = plan.tasks.find((task) => task.sourceType === "image");
    expect(xlsxTask?.requiredFeatures).toEqual(["document_parse", "code_execution"]);
    expect(pdfTask?.requiredFeatures).toEqual(["document_parse"]);
    expect(imageTask?.requiredFeatures).toEqual(["vision"]);
  });
});
