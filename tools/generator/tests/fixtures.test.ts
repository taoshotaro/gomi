import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveFixtureDirByCityPrefecture } from "../lib/fixtures.js";

describe("resolveFixtureDirByCityPrefecture", () => {
  test("returns exact city/prefecture match", () => {
    const root = mkdtempSync(join(tmpdir(), "gomi-fixtures-"));

    const tokyoShinagawa = join(root, "tokyo", "shinagawa");
    mkdirSync(tokyoShinagawa, { recursive: true });
    writeFileSync(
      join(tokyoShinagawa, "meta.json"),
      JSON.stringify({
        city: "品川区",
        prefecture: "東京都",
        cityId: "shinagawa",
        prefectureId: "tokyo",
      })
    );
    writeFileSync(join(tokyoShinagawa, "discover-v2.json"), "{}");

    const tokyoMeguro = join(root, "tokyo", "meguro");
    mkdirSync(tokyoMeguro, { recursive: true });
    writeFileSync(
      join(tokyoMeguro, "meta.json"),
      JSON.stringify({
        city: "目黒区",
        prefecture: "東京都",
        cityId: "meguro",
        prefectureId: "tokyo",
      })
    );
    writeFileSync(join(tokyoMeguro, "discover-v2.json"), "{}");

    const resolved = resolveFixtureDirByCityPrefecture("品川区", "東京都", undefined, root);
    expect(resolved).toBe(tokyoShinagawa);
  });
});
