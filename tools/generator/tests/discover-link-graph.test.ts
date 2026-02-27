import { describe, expect, test } from "bun:test";
import { extractCandidateLinks } from "../discover/link-graph.js";

describe("discover link graph", () => {
  test("extracts and resolves relevant links", () => {
    const html = `
      <html>
        <body>
          <a href="/data/schedule.csv">ごみ収集日 CSV</a>
          <a href="/kankyo/bunbetsu.html">分別一覧</a>
          <a href="/privacy.html">プライバシーポリシー</a>
        </body>
      </html>
    `;

    const links = extractCandidateLinks({
      baseUrl: "https://city.example.jp/top/index.html",
      html,
      depth: 0,
      maxLinks: 10,
      targetHints: ["schedule"],
    });

    const urls = links.map((entry) => entry.url);
    expect(urls).toContain("https://city.example.jp/data/schedule.csv");
    expect(urls).toContain("https://city.example.jp/kankyo/bunbetsu.html");
    expect(urls).not.toContain("https://city.example.jp/privacy.html");
    expect(links.every((entry) => (entry.depth ?? 0) === 1)).toBe(true);
  });
});
