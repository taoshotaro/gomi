import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(THIS_DIR, "../../..");
export const GENERATOR_ROOT = resolve(THIS_DIR, "..");

export const PROMPTS_DIR = join(GENERATOR_ROOT, "prompts");
export const FIXTURES_ROOT = join(GENERATOR_ROOT, "fixtures");

export const DATA_DIR = join(REPO_ROOT, "data");
export const DATA_SCHEMA_DIR = join(DATA_DIR, "_schema");
export const DATA_STAGING_ROOT = join(DATA_DIR, ".staging");

export function defaultWorkDir(runId: string): string {
  return join(REPO_ROOT, ".tmp", "generator-runs", runId);
}

export function cityOutputDir(prefectureId: string, cityId: string): string {
  return join(DATA_DIR, "jp", prefectureId, cityId);
}

export function cityStagingDir(runId: string, prefectureId: string, cityId: string): string {
  return join(DATA_STAGING_ROOT, runId, "jp", prefectureId, cityId);
}
