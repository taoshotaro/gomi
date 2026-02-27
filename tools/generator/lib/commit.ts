import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { wait } from "../pipeline/retry.js";
import { DATA_DIR } from "./paths.js";

interface CityEntry {
  id: string;
  name_ja: string;
  prefecture_ja: string;
  source_url: string;
  data_path: string;
  last_verified: string;
}

interface CitiesFile {
  version: string;
  cities: CityEntry[];
}

export async function withFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        return await fn();
      } finally {
        closeSync(fd);
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("EEXIST")) {
        throw error;
      }

      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Failed to acquire lock in ${timeoutMs}ms: ${lockPath}`);
      }

      await wait(100);
    }
  }
}

export function commitStagedCityData(stagingDir: string, finalDir: string): string[] {
  mkdirSync(finalDir, { recursive: true });

  const files = ["schedule.json", "separation.json"];
  const committed: string[] = [];

  for (const file of files) {
    const sourcePath = join(stagingDir, file);
    const targetPath = join(finalDir, file);

    if (!existsSync(sourcePath)) {
      throw new Error(`Missing staged file: ${sourcePath}`);
    }

    const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.next-${process.pid}`);
    writeFileSync(tmpPath, readFileSync(sourcePath, "utf-8"));
    renameSync(tmpPath, targetPath);
    committed.push(targetPath);
  }

  return committed;
}

export async function updateCitiesJsonAtomic(entry: CityEntry): Promise<void> {
  const citiesPath = join(DATA_DIR, "cities.json");
  const lockPath = `${citiesPath}.lock`;

  await withFileLock(lockPath, 5000, async () => {
    const parsed: CitiesFile = existsSync(citiesPath)
      ? JSON.parse(readFileSync(citiesPath, "utf-8"))
      : { version: "1.0.0", cities: [] };

    const index = parsed.cities.findIndex((city) => city.id === entry.id);
    if (index >= 0) {
      parsed.cities[index] = entry;
    } else {
      parsed.cities.push(entry);
    }

    const tmpPath = `${citiesPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`);
    renameSync(tmpPath, citiesPath);
  });
}

export type { CityEntry };
