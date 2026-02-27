import { describe, expect, test } from "bun:test";
import { computeDomainLock } from "../discover/domain-lock.js";

describe("discover domain lock", () => {
  test("locks to trusted official/open-data hosts", () => {
    const result = computeDomainLock(
      [
        { url: "https://www.city.shinagawa.tokyo.jp/path" },
        { url: "https://www.city.shinagawa.tokyo.jp/path2" },
        { url: "https://www.opendata.metro.tokyo.lg.jp/file.csv" },
        { url: "https://example.com/other" },
      ],
      ["shinagawa.tokyo.jp", "opendata.metro.tokyo.lg.jp"],
      4
    );

    expect(result.locked).toBe(true);
    expect(result.lockedHosts.some((host) => host.includes("shinagawa.tokyo.jp"))).toBe(true);
  });
});
