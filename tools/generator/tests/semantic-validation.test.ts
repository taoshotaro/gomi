import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateDriftAgainstExisting,
  validateSemanticCityOutput,
} from "../lib/validation.js";

describe("semantic and drift validation", () => {
  test("detects noisy separation category names", () => {
    const cityDir = mkdtempSync(join(tmpdir(), "gomi-semantic-"));
    writeFileSync(
      join(cityDir, "schedule.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          city_name_ja: "品川区",
          source_url: "https://example.com",
          areas: [
            {
              area_id: "a",
              area_name_ja: "大井1丁目",
              categories: [
                {
                  category_id: "burnable",
                  name_ja: "燃やすごみ",
                  collection_days: { type: "weekly", days: ["monday"] },
                },
              ],
            },
          ],
        },
        null,
        2
      )
    );
    writeFileSync(
      join(cityDir, "separation.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          categories: [
            { category_id: "burnable", name_ja: "燃やすごみ" },
            { category_id: "bad", name_ja: "## あ行で始まる資源・ごみ" },
            { category_id: "bad2", name_ja: "80_燃やすごみ" },
          ],
        },
        null,
        2
      )
    );

    const issues = validateSemanticCityOutput(cityDir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.file === "separation.json")).toBe(true);
  });

  test("detects high drift against existing city data", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "gomi-drift-"));
    const existingDir = join(baseDir, "existing");
    const stagingDir = join(baseDir, "staging");
    mkdirSync(existingDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    writeFileSync(
      join(existingDir, "schedule.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          city_name_ja: "品川区",
          source_url: "https://example.com",
          areas: [
            {
              area_id: "a",
              area_name_ja: "A",
              categories: [
                {
                  category_id: "burnable",
                  name_ja: "燃やすごみ",
                  collection_days: { type: "weekly", days: ["monday"] },
                },
              ],
            },
          ],
        },
        null,
        2
      )
    );
    writeFileSync(
      join(existingDir, "separation.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          categories: [{ category_id: "burnable", name_ja: "燃やすごみ" }],
        },
        null,
        2
      )
    );

    writeFileSync(
      join(stagingDir, "schedule.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          city_name_ja: "品川区",
          source_url: "https://example.com",
          areas: [
            {
              area_id: "b",
              area_name_ja: "B",
              categories: [
                {
                  category_id: "recyclable",
                  name_ja: "資源",
                  collection_days: { type: "weekly", days: ["tuesday"] },
                },
              ],
            },
          ],
        },
        null,
        2
      )
    );
    writeFileSync(
      join(stagingDir, "separation.json"),
      JSON.stringify(
        {
          city_id: "tokyo/shinagawa",
          categories: [{ category_id: "recyclable", name_ja: "資源" }],
        },
        null,
        2
      )
    );

    const issues = validateDriftAgainstExisting(stagingDir, existingDir, 0.2);
    expect(issues.length).toBeGreaterThan(0);
  });
});
