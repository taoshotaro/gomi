import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { readJsonFile, writeJsonAtomic } from "./json.js";
import { FIXTURES_ROOT } from "./paths.js";
import type { DiscoverOutputV2, SourceManifestEntry } from "../pipeline/types.js";

interface FixtureMeta {
  city: string;
  prefecture: string;
  cityId: string;
  prefectureId: string;
}

export function getFixturesDir(
  explicitDir: string | undefined,
  prefectureId: string,
  cityId: string
): string {
  return explicitDir || join(FIXTURES_ROOT, prefectureId, cityId);
}

export function saveDiscoverFixture(
  fixturesDir: string,
  sources: DiscoverOutputV2,
  city: string,
  prefecture: string
): void {
  mkdirSync(fixturesDir, { recursive: true });
  writeJsonAtomic(join(fixturesDir, "discover-v2.json"), sources);
  writeJsonAtomic(join(fixturesDir, "meta.json"), {
    city,
    prefecture,
    cityId: sources.cityId,
    prefectureId: sources.prefectureId,
  } satisfies FixtureMeta);
  writeJsonAtomic(join(fixturesDir, "source-manifest.json"), []);
}

export function loadDiscoverFixture(fixturesDir: string): DiscoverOutputV2 {
  return readJsonFile<DiscoverOutputV2>(join(fixturesDir, "discover-v2.json"));
}

export function saveSourceManifestFixture(
  fixturesDir: string,
  manifest: SourceManifestEntry[]
): void {
  mkdirSync(fixturesDir, { recursive: true });
  writeJsonAtomic(join(fixturesDir, "source-manifest.json"), manifest);
}

export function loadSourceManifestFixture(fixturesDir: string): SourceManifestEntry[] {
  const path = join(fixturesDir, "source-manifest.json");
  if (!existsSync(path)) {
    return [];
  }
  return readJsonFile<SourceManifestEntry[]>(path);
}

export function saveDownloadFixtures(fixturesDir: string, downloadDir: string): string[] {
  mkdirSync(fixturesDir, { recursive: true });
  const files = readdirSync(downloadDir);
  for (const file of files) {
    copyFileSync(join(downloadDir, file), join(fixturesDir, file));
  }
  return files;
}

export function loadDownloadFixtures(fixturesDir: string, downloadDir: string): string[] {
  mkdirSync(downloadDir, { recursive: true });
  const files = readdirSync(fixturesDir).filter(
    (file) => file !== "discover-v2.json" && file !== "meta.json" && file !== "source-manifest.json"
  );

  for (const file of files) {
    copyFileSync(join(fixturesDir, file), join(downloadDir, file));
  }

  return files;
}

export function resolveFixtureDirByCityPrefecture(
  city: string,
  prefecture: string,
  explicitDir?: string,
  fixturesRoot: string = FIXTURES_ROOT
): string {
  if (explicitDir) {
    return explicitDir;
  }

  if (!existsSync(fixturesRoot)) {
    throw new Error(
      "Fixtures directory does not exist. Run once with --save-fixtures or set --fixtures-dir."
    );
  }

  const cityNorm = normalize(city);
  const prefNorm = normalize(prefecture);

  const matches: string[] = [];

  const prefectureDirs = readdirSync(fixturesRoot);
  for (const prefectureDir of prefectureDirs) {
    const prefPath = join(fixturesRoot, prefectureDir);
    const cityDirs = readdirSync(prefPath);
    for (const cityDir of cityDirs) {
      const fixtureDir = join(prefPath, cityDir);
      const metaPath = join(fixtureDir, "meta.json");
      if (!existsSync(metaPath)) {
        continue;
      }

      const meta = readJsonFile<FixtureMeta>(metaPath);
      if (normalize(meta.city) === cityNorm && normalize(meta.prefecture) === prefNorm) {
        matches.push(fixtureDir);
      }
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple fixture directories match ${prefecture}/${city}: ${matches.join(", ")}. Use --fixtures-dir.`
    );
  }

  throw new Error(
    `No fixture directory matches ${prefecture}/${city}. Run once with --save-fixtures or set --fixtures-dir.`
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
