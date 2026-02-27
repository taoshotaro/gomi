import { describe, expect, test } from "bun:test";
import { join } from "path";
import { runHtmlExecutor } from "../executors/html.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "tokyo", "shinagawa");

describe("html extractor", () => {
  test("parses table rows from separation master page", () => {
    const fixturePath = join(FIXTURE_DIR, "separation-2.html");
    const output = runHtmlExecutor(fixturePath, "separation", {
      sourceUrl:
        "https://www.city.shinagawa.tokyo.jp/PC/kankyo/kankyo-gomi/gomi-kateigomi/gomi-kateigomi-dashikata/hpg000032874.html",
    });

    expect(output.diagnostics?.tableCount ?? 0).toBeGreaterThan(0);
    expect(output.records.length).toBeGreaterThan(150);

    const sample = output.records.find((record) => (record.fields["品目"] || "").includes("アイロン"));
    expect(sample).toBeDefined();
    expect(sample?.fields["出し方"] || "").toContain("陶器・ガラス・金属ごみ");
  });

  test("surfaces high-signal follow links from index page", () => {
    const fixturePath = join(FIXTURE_DIR, "separation.html");
    const output = runHtmlExecutor(fixturePath, "separation", {
      sourceUrl:
        "https://www.city.shinagawa.tokyo.jp/PC/kankyo/kankyo-gomi/kankyo-gomi-bunbetsu/index.html",
    });

    const links = output.linkCandidates ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((link) => link.url.includes("hpg000005617.html"))).toBe(true);
  });
});
