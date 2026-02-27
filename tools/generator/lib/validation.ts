import Ajv from "ajv";
import addFormats from "ajv-formats";
import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { DATA_DIR, DATA_SCHEMA_DIR, REPO_ROOT } from "./paths.js";
import { readJsonFile } from "./json.js";
import { normalizeFullWidthDigits } from "./csv.js";

export interface ValidationIssue {
  file: string;
  messages: string[];
}

interface CityEntry {
  id: string;
  data_path: string;
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true, strictSchema: true });
  addFormats(ajv);
  return ajv;
}

function loadSchemas(): { scheduleSchema: object; separationSchema: object } {
  return {
    scheduleSchema: readJsonFile<object>(join(DATA_SCHEMA_DIR, "schedule.schema.json")),
    separationSchema: readJsonFile<object>(join(DATA_SCHEMA_DIR, "separation.schema.json")),
  };
}

export function validateCityOutput(cityDir: string): ValidationIssue[] {
  const ajv = createAjv();
  const { scheduleSchema, separationSchema } = loadSchemas();
  const validateSchedule = ajv.compile(scheduleSchema);
  const validateSeparation = ajv.compile(separationSchema);

  const checks: Array<{ file: string; validate: ReturnType<Ajv["compile"]> }> = [
    { file: "schedule.json", validate: validateSchedule },
    { file: "separation.json", validate: validateSeparation },
  ];

  const issues: ValidationIssue[] = [];

  for (const check of checks) {
    const filePath = join(cityDir, check.file);
    if (!existsSync(filePath)) {
      issues.push({ file: check.file, messages: [`${check.file} was not generated`] });
      continue;
    }

    const data = readJsonFile<unknown>(filePath);
    if (!check.validate(data)) {
      issues.push({
        file: check.file,
        messages: (check.validate.errors ?? []).map(
          (err) => `${err.instancePath} ${err.message}`
        ),
      });
    }
  }

  return issues;
}

export function validateSemanticCityOutput(cityDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const schedulePath = join(cityDir, "schedule.json");
  const separationPath = join(cityDir, "separation.json");

  if (existsSync(separationPath)) {
    const separation = readJsonFile<{
      categories?: Array<{ name_ja?: string }>;
    }>(separationPath);
    const bad = (separation.categories ?? [])
      .map((category) => category.name_ja || "")
      .filter((name) => isNoisyCategoryName(name));
    if (bad.length > 0) {
      issues.push({
        file: "separation.json",
        messages: [
          `semantic-noise categories detected: ${bad.slice(0, 5).join(", ")}`,
        ],
      });
    }
  }

  if (existsSync(schedulePath)) {
    const schedule = readJsonFile<{
      areas?: Array<{
        categories?: Array<{ collection_days?: { type?: string } }>;
      }>;
    }>(schedulePath);
    const categories = (schedule.areas ?? []).flatMap((area) => area.categories ?? []);
    if (categories.length > 0) {
      const appointmentCount = categories.filter(
        (category) => category.collection_days?.type === "appointment"
      ).length;
      const appointmentRatio = appointmentCount / categories.length;
      if (appointmentRatio > 0.3) {
        issues.push({
          file: "schedule.json",
          messages: [
            `semantic-low-confidence too many appointment fallbacks (${appointmentCount}/${categories.length})`,
          ],
        });
      }
    }
  }

  return issues;
}

export function validateDriftAgainstExisting(
  stagingCityDir: string,
  existingCityDir: string,
  threshold: number
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!existsSync(existingCityDir)) {
    return issues;
  }

  const oldSchedulePath = join(existingCityDir, "schedule.json");
  const newSchedulePath = join(stagingCityDir, "schedule.json");
  const oldSeparationPath = join(existingCityDir, "separation.json");
  const newSeparationPath = join(stagingCityDir, "separation.json");

  if (existsSync(oldSchedulePath) && existsSync(newSchedulePath)) {
    const oldSchedule = readJsonFile<{
      areas?: Array<{ area_name_ja?: string; categories?: Array<{ name_ja?: string }> }>;
    }>(oldSchedulePath);
    const newSchedule = readJsonFile<{
      areas?: Array<{ area_name_ja?: string; categories?: Array<{ name_ja?: string }> }>;
    }>(newSchedulePath);
    const oldAreas = new Set((oldSchedule.areas ?? []).map((area) => area.area_name_ja || ""));
    const newAreas = new Set((newSchedule.areas ?? []).map((area) => area.area_name_ja || ""));
    const areaOverlap = overlapRatio(oldAreas, newAreas);
    if (1 - areaOverlap > threshold) {
      issues.push({
        file: "schedule.json",
        messages: [
          `drift area overlap too low (${areaOverlap.toFixed(3)}), threshold=${threshold}`,
        ],
      });
    }

    const oldCategoryNames = new Set(
      (oldSchedule.areas ?? []).flatMap((area) =>
        (area.categories ?? []).map((category) => category.name_ja || "")
      )
    );
    const newCategoryNames = new Set(
      (newSchedule.areas ?? []).flatMap((area) =>
        (area.categories ?? []).map((category) => category.name_ja || "")
      )
    );
    const categoryOverlap = overlapRatio(oldCategoryNames, newCategoryNames);
    if (1 - categoryOverlap > threshold) {
      issues.push({
        file: "schedule.json",
        messages: [
          `drift category overlap too low (${categoryOverlap.toFixed(3)}), threshold=${threshold}`,
        ],
      });
    }
  }

  if (existsSync(oldSeparationPath) && existsSync(newSeparationPath)) {
    const oldSeparation = readJsonFile<{
      categories?: Array<{ name_ja?: string }>;
    }>(oldSeparationPath);
    const newSeparation = readJsonFile<{
      categories?: Array<{ name_ja?: string }>;
    }>(newSeparationPath);
    const oldNames = new Set((oldSeparation.categories ?? []).map((category) => category.name_ja || ""));
    const newNames = new Set((newSeparation.categories ?? []).map((category) => category.name_ja || ""));
    const overlap = overlapRatio(oldNames, newNames);
    if (1 - overlap > threshold) {
      issues.push({
        file: "separation.json",
        messages: [
          `drift separation category overlap too low (${overlap.toFixed(3)}), threshold=${threshold}`,
        ],
      });
    }
  }

  return issues;
}

export function validateAllData(): { issues: ValidationIssue[]; checkedFiles: string[] } {
  const ajv = createAjv();
  const { scheduleSchema, separationSchema } = loadSchemas();

  const validateSchedule = ajv.compile(scheduleSchema);
  const validateSeparation = ajv.compile(separationSchema);

  const scheduleFiles = findDataFiles(join(DATA_DIR, "jp"), "schedule.json");
  const separationFiles = findDataFiles(join(DATA_DIR, "jp"), "separation.json");

  const issues: ValidationIssue[] = [];
  const checkedFiles: string[] = [];

  for (const file of scheduleFiles) {
    checkedFiles.push(file);
    const data = readJsonFile<unknown>(file);
    if (!validateSchedule(data)) {
      issues.push({
        file: relative(REPO_ROOT, file),
        messages: (validateSchedule.errors ?? []).map(
          (err) => `${err.instancePath} ${err.message}`
        ),
      });
    }
  }

  for (const file of separationFiles) {
    checkedFiles.push(file);
    const data = readJsonFile<unknown>(file);
    if (!validateSeparation(data)) {
      issues.push({
        file: relative(REPO_ROOT, file),
        messages: (validateSeparation.errors ?? []).map(
          (err) => `${err.instancePath} ${err.message}`
        ),
      });
    }
  }

  const consistencyIssues = validateCitiesConsistency();
  issues.push(...consistencyIssues);

  return { issues, checkedFiles };
}

function validateCitiesConsistency(): ValidationIssue[] {
  const citiesPath = join(DATA_DIR, "cities.json");
  if (!existsSync(citiesPath)) {
    return [];
  }

  const cities = readJsonFile<{ cities: CityEntry[] }>(citiesPath);
  const issues: ValidationIssue[] = [];

  for (const city of cities.cities) {
    const cityDir = join(DATA_DIR, city.data_path);
    if (!existsSync(cityDir)) {
      issues.push({
        file: "data/cities.json",
        messages: [`directory missing for ${city.id} (${city.data_path})`],
      });
      continue;
    }

    if (!existsSync(join(cityDir, "schedule.json"))) {
      issues.push({
        file: "data/cities.json",
        messages: [`schedule.json missing for ${city.id}`],
      });
    }

    if (!existsSync(join(cityDir, "separation.json"))) {
      issues.push({
        file: "data/cities.json",
        messages: [`separation.json missing for ${city.id}`],
      });
    }
  }

  return issues;
}

function findDataFiles(
  dir: string,
  filename: string,
  result: string[] = []
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "_schema" && entry.name !== ".staging") {
      findDataFiles(fullPath, filename, result);
      continue;
    }

    if (entry.isFile() && entry.name === filename) {
      result.push(fullPath);
    }
  }
  return result;
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  const normalizedA = new Set([...a].filter(Boolean));
  const normalizedB = new Set([...b].filter(Boolean));
  const intersection = [...normalizedA].filter((entry) => normalizedB.has(entry)).length;
  const denominator = Math.max(normalizedA.size, normalizedB.size, 1);
  return intersection / denominator;
}

function isNoisyCategoryName(name: string): boolean {
  const text = normalizeFullWidthDigits(name).trim().replace(/\s+/g, " ");
  if (!text) {
    return true;
  }
  if (text.length > 34) {
    return true;
  }
  if (/^#+/.test(text)) {
    return true;
  }
  if (
    /(で始まる|もしくは|一覧|検索|ページ|トップ|ホーム|サイトマップ|language|手続き|施設案内|区政情報)/i.test(
      text
    )
  ) {
    return true;
  }
  if (/^[0-9]+[\s_\-.:：]/.test(text)) {
    return true;
  }
  if (/(本文へ移動|目次|メニュー|お問い合わせ|アクセシビリティ)/.test(text)) {
    return true;
  }
  if (/^[\-\*・_]+$/.test(text)) {
    return true;
  }
  return false;
}
