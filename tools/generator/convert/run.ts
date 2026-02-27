import { existsSync } from "fs";
import { join } from "path";
import type { CleanupResultRecord } from "../pipeline/types.js";
import { normalizeFullWidthDigits } from "../lib/csv.js";
import { readJsonFile, readNdjsonFile, writeJsonAtomic } from "../lib/json.js";
import { ValidationFailure } from "../pipeline/errors.js";
import { emitAgentEvent } from "../pipeline/events.js";
import type { PipelineContext } from "../pipeline/context.js";
import type { ConversionPlan, ConversionRunResult, ExtractionPlan } from "../pipeline/types.js";
import type { ExecutionReport } from "../executors/run-plan.js";
import { selectPrimarySources } from "../selection/select.js";

interface ScheduleArea {
  area_id: string;
  area_name_ja: string;
  categories: Array<{
    category_id: string;
    name_ja: string;
    collection_days:
      | { type: "weekly"; days: string[] }
      | { type: "monthly"; pattern: Array<{ week: number; day: string }> }
      | { type: "appointment"; notes_ja: string };
  }>;
}

interface ConvertedSchedule {
  city_id: string;
  city_name_ja: string;
  source_url: string;
  areas: ScheduleArea[];
}

interface ConvertedSeparation {
  city_id: string;
  categories: Array<{
    category_id: string;
    name_ja: string;
  }>;
}

interface CleanInput {
  sourceId: string;
  converterType: string;
  records: CleanupResultRecord[];
}

export async function runConvertArtifacts(
  context: PipelineContext,
  _signal: AbortSignal
): Promise<void> {
  const reportPath =
    context.stateStore.state.executionReportPath ?? join(context.options.workDir, "execution-report.json");
  if (!existsSync(reportPath)) {
    throw new ValidationFailure(`Missing extraction execution report: ${reportPath}`, undefined, false);
  }
  const report = readJsonFile<ExecutionReport>(reportPath);
  const sources = context.stateStore.state.sources;
  if (!sources) {
    throw new ValidationFailure("Discover sources missing before convert step", undefined, false);
  }
  const extractionPlanPath =
    context.stateStore.state.extractionPlanPath ?? join(context.options.workDir, "extraction-plan.json");
  if (!existsSync(extractionPlanPath)) {
    throw new ValidationFailure(`Missing extraction plan: ${extractionPlanPath}`, undefined, false);
  }
  const extractionPlan = readJsonFile<ExtractionPlan>(extractionPlanPath);

  const tasks = report.results
    .filter((result) => result.status === "succeeded" && (result.cleanPath || result.outputPath))
    .map((result) => ({
      id: `convert-${result.taskId}`,
      sourceId: result.sourceId,
      target: result.target,
      converterType: result.executorType,
      inputPath: result.cleanPath || result.outputPath!,
      outputPath: join(context.options.workDir, "converted", `${result.target}.json`),
      timeoutMs: Math.max(5_000, Math.min(context.options.maxStepMs, 60_000)),
    }));

  const conversionPlan: ConversionPlan = {
    runId: context.options.runId,
    createdAt: new Date().toISOString(),
    tasks,
  };
  const conversionPlanPath = join(context.options.workDir, "conversion-plan.json");
  writeJsonAtomic(conversionPlanPath, conversionPlan);
  for (const task of tasks) {
    emitAgentEvent({
      level: "info",
      step: "convert",
      eventType: "converter.script.generated",
      message: "Converter template selected",
      action: task.id,
      sourceId: task.sourceId,
      converterType: task.converterType,
      major: false,
    });
  }

  emitAgentEvent({
    level: "info",
    step: "convert",
    eventType: "convert.lifecycle",
    phase: "start",
    message: "Conversion plan generated",
    tasks: tasks.length,
    path: conversionPlanPath,
  });

  const selection = await selectPrimarySources({
    context,
    plan: extractionPlan,
    report,
  });
  context.stateStore.state.selectionReportPath = selection.reportPath;
  context.stateStore.persist();

  const scheduleInputs = readCleanInputs(
    tasks.filter((task) => task.target === "schedule"),
    selection.decisions.schedule
  );
  const separationInputs = readCleanInputs(
    tasks.filter((task) => task.target === "separation"),
    selection.decisions.separation
  );
  if (scheduleInputs.length === 0) {
    throw new ValidationFailure("No cleaned schedule artifacts available for convert step", undefined, false);
  }
  if (separationInputs.length === 0) {
    throw new ValidationFailure("No cleaned separation artifacts available for convert step", undefined, false);
  }

  let schedule: ConvertedSchedule | null = null;
  let separation: ConvertedSeparation | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= context.options.maxConvertFixRetries; attempt++) {
    const lenient = attempt > 0;
    try {
      emitAgentEvent({
        level: "info",
        step: "convert",
        attempt: attempt + 1,
        eventType: "converter.dryrun",
        phase: "start",
        message: "Running conversion dry-run checks",
        lenient,
      });
      schedule = convertSchedule(scheduleInputs, {
        cityId: `${sources.prefectureId}/${sources.cityId}`,
        cityNameJa: context.options.city,
        sourceUrl: sources.officialUrl || context.options.url || "",
        lenient,
      });
      separation = convertSeparation(separationInputs, {
        cityId: `${sources.prefectureId}/${sources.cityId}`,
      });
      runAcceptanceChecks(schedule, separation);
      emitAgentEvent({
        level: "info",
        step: "convert",
        attempt: attempt + 1,
        eventType: "converter.acceptance",
        phase: "end",
        message: "Conversion dry-run checks passed",
        areas: schedule.areas.length,
        categories: separation.categories.length,
      });
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      emitAgentEvent({
        level: "warn",
        step: "convert",
        attempt: attempt + 1,
        eventType: "converter.dryrun",
        phase: "fail",
        message: "Conversion dry-run failed",
        errorCode: "CONVERT_DRYRUN_FAILED",
        errorMessage: lastError.message,
      });
      if (attempt === context.options.maxConvertFixRetries) {
        throw new ValidationFailure(
          `Convert step failed after ${context.options.maxConvertFixRetries} repair attempts: ${lastError.message}`,
          lastError,
          false
        );
      }
      emitAgentEvent({
        level: "info",
        step: "convert",
        attempt: attempt + 1,
        eventType: "converter.repair",
        message: "Applying deterministic repair strategy for next attempt",
      });
    }
  }

  if (!schedule || !separation) {
    throw new ValidationFailure(
      `Convert step failed: ${lastError?.message ?? "unknown error"}`,
      lastError,
      false
    );
  }

  writeJsonAtomic(join(context.dirs.stagingDir, "schedule.json"), schedule);
  writeJsonAtomic(join(context.dirs.stagingDir, "separation.json"), separation);
  context.stateStore.addOutputPath(join(context.dirs.stagingDir, "schedule.json"));
  context.stateStore.addOutputPath(join(context.dirs.stagingDir, "separation.json"));

  const conversionResults: ConversionRunResult[] = [
    {
      taskId: "convert-schedule",
      sourceId: selection.decisions.schedule.primarySourceId,
      target: "schedule",
      status: "succeeded",
      durationMs: 0,
      checksPassed: ["areas>0", "categories>0"],
      outputStats: {
        areas: schedule.areas.length,
        categories: schedule.areas.reduce((sum, area) => sum + area.categories.length, 0),
      },
      errors: [],
    },
    {
      taskId: "convert-separation",
      sourceId: selection.decisions.separation.primarySourceId,
      target: "separation",
      status: "succeeded",
      durationMs: 0,
      checksPassed: ["categories>0"],
      outputStats: { categories: separation.categories.length },
      errors: [],
    },
  ];
  const conversionReportPath = join(context.options.workDir, "conversion-report.json");
  writeJsonAtomic(conversionReportPath, {
    runId: context.options.runId,
    createdAt: new Date().toISOString(),
    selection,
    results: conversionResults,
  });

  emitAgentEvent({
    level: "info",
    step: "convert",
    eventType: "convert.lifecycle",
    phase: "end",
    message: "Conversion completed",
    path: conversionReportPath,
    areas: schedule.areas.length,
    categories: separation.categories.length,
  });
}

function readCleanInputs(
  tasks: Array<{ sourceId: string; converterType: string; inputPath: string }>,
  decision: { primarySourceId: string; secondarySourceIds: string[] }
): CleanInput[] {
  const out: CleanInput[] = [];
  const order = [decision.primarySourceId, ...decision.secondarySourceIds];
  const rank = new Map(order.map((sourceId, index) => [sourceId, index]));
  const sortedTasks = [...tasks].sort((a, b) => {
    const ar = rank.has(a.sourceId) ? rank.get(a.sourceId)! : Number.MAX_SAFE_INTEGER;
    const br = rank.has(b.sourceId) ? rank.get(b.sourceId)! : Number.MAX_SAFE_INTEGER;
    return ar - br;
  });
  for (const task of sortedTasks) {
    if (!rank.has(task.sourceId)) {
      continue;
    }
    if (!existsSync(task.inputPath)) {
      continue;
    }
    const parsed = readNdjsonFile<CleanupResultRecord>(task.inputPath);
    if (parsed.length === 0) {
      continue;
    }
    out.push({
      sourceId: task.sourceId,
      converterType: task.converterType,
      records: parsed,
    });
  }
  return out;
}

function convertSchedule(
  inputs: CleanInput[],
  options: { cityId: string; cityNameJa: string; sourceUrl: string; lenient: boolean }
): ConvertedSchedule {
  const areaMap = new Map<string, ScheduleArea>();
  const areaIdMap = new Map<string, string>();
  const errors: string[] = [];

  for (const input of inputs) {
    for (const record of input.records) {
      const normalizedFields = normalizeFields(record.normalizedFields);
      const line = normalizeFullWidthDigits(record.text || "").trim();

      const categoryName =
        pickFirst(normalizedFields, ["ゴミ分類区分", "ごみ分類区分", "分類", "category", "種別"]) ||
        extractCategoryFromLine(line);
      const areaName =
        pickFirst(normalizedFields, ["地区名", "地域", "area", "エリア", "住所", "町名"]) ||
        extractAreaFromLine(line);
      const dayExpr =
        pickFirst(normalizedFields, ["収集曜日", "曜日", "day", "収集日", "回収日"]) ||
        extractDayFromLine(line);

      if (!categoryName || !areaName || !dayExpr) {
        continue;
      }

      const parsedDays = parseCollectionDays(dayExpr);
      if (!parsedDays && !options.lenient) {
        errors.push(`Unrecognized collection day expression: ${dayExpr} (${areaName} / ${categoryName})`);
        continue;
      }

      const area = getOrCreateArea(areaMap, areaIdMap, areaName);
      const categoryId = mapCategoryId(categoryName, area.categories.length + 1);
      if (area.categories.some((entry) => entry.category_id === categoryId)) {
        continue;
      }
      area.categories.push({
        category_id: categoryId,
        name_ja: categoryName,
        collection_days:
          parsedDays ?? {
            type: "appointment",
            notes_ja: `曜日解析失敗: ${dayExpr}`,
          },
      });
    }
  }

  if (errors.length > 0) {
    throw new ValidationFailure(errors.slice(0, 5).join("; "), undefined, false);
  }

  const areas = [...areaMap.values()].filter((area) => area.categories.length > 0);
  return {
    city_id: options.cityId,
    city_name_ja: options.cityNameJa,
    source_url: options.sourceUrl || "https://example.invalid/source",
    areas,
  };
}

function convertSeparation(
  inputs: CleanInput[],
  options: { cityId: string }
): ConvertedSeparation {
  const names = new Set<string>();
  const candidateRegex = /(燃やすごみ|可燃ごみ|不燃ごみ|陶器・ガラス・金属ごみ|資源(?:ごみ)?|粗大ごみ|有害ごみ)/g;

  for (const input of inputs) {
    for (const record of input.records) {
      const normalizedFields = normalizeFields(record.normalizedFields);
      const values = new Set<string>([record.text, ...Object.values(normalizedFields)]);
      for (const value of values) {
        const text = String(value || "").trim();
        if (!text) {
          continue;
        }

        if (
          (text.endsWith("ごみ") || text.endsWith("ゴミ") || text.includes("分別")) &&
          text.length <= 40 &&
          !isLikelyNoiseCategory(text)
        ) {
          names.add(cleanCategoryName(text));
        }

        for (const match of text.matchAll(candidateRegex)) {
          const candidate = cleanCategoryName(match[1]);
          if (!isLikelyNoiseCategory(candidate)) {
            names.add(candidate);
          }
        }
      }
    }
  }

  const categories = [...names]
    .map((name) => cleanCategoryName(name))
    .filter((name) => !isLikelyNoiseCategory(name))
    .slice(0, 60)
    .map((name, index) => ({
      category_id: mapCategoryId(name, index + 1),
      name_ja: name,
    }));

  return {
    city_id: options.cityId,
    categories,
  };
}

function normalizeFields(fields: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    normalized[normalizeFullWidthDigits(key).trim()] = normalizeFullWidthDigits(String(value)).trim();
  }
  return normalized;
}

function extractCategoryFromLine(line: string): string | undefined {
  const match = line.match(
    /(燃やすごみ|可燃ごみ|燃えるごみ|不燃ごみ|燃やさないごみ|陶器・ガラス・金属ごみ|資源ごみ|資源|粗大ごみ|有害ごみ)/
  );
  if (!match) {
    return undefined;
  }
  return cleanCategoryName(match[1]);
}

function extractAreaFromLine(line: string): string | undefined {
  const match = line.match(/([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}A-Za-z0-9]+(?:丁目|町|区|市|村))/u);
  return match?.[1]?.trim();
}

function extractDayFromLine(line: string): string | undefined {
  const compact = normalizeFullWidthDigits(line).replace(/\s+/g, "");
  if (/第[1-5]/.test(compact) && /[月火水木金土日]/.test(compact)) {
    return compact;
  }
  const weekly = compact.match(/[月火水木金土日](?:・[月火水木金土日])*/);
  return weekly?.[0];
}

function cleanCategoryName(name: string): string {
  return normalizeFullWidthDigits(name)
    .replace(/^[0-9０-９]+[\s_\-.:：]+/u, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyNoiseCategory(name: string): boolean {
  const text = cleanCategoryName(name);
  if (!text) {
    return true;
  }
  if (text.length > 34) {
    return true;
  }
  if (/^#+/.test(text)) {
    return true;
  }
  if (/^[0-9０-９]+[\s_\-.:：]/u.test(text)) {
    return true;
  }
  if (
    /(で始まる|もしくは|一覧|検索|ページ|トップ|ホーム|サイトマップ|Language|手続き|施設案内|区政情報|目次|本文へ移動)/.test(
      text
    )
  ) {
    return true;
  }
  if (/^[\-*・]+$/.test(text)) {
    return true;
  }
  return false;
}

function runAcceptanceChecks(schedule: ConvertedSchedule, separation: ConvertedSeparation): void {
  if (!schedule.areas.length) {
    throw new ValidationFailure("Schedule conversion produced zero areas", undefined, false);
  }
  for (const area of schedule.areas) {
    if (!area.categories.length) {
      throw new ValidationFailure(`Area ${area.area_name_ja} has no categories`, undefined, false);
    }
  }
  if (!separation.categories.length) {
    throw new ValidationFailure("Separation conversion produced zero categories", undefined, false);
  }
}

function getOrCreateArea(
  areaMap: Map<string, ScheduleArea>,
  areaIdMap: Map<string, string>,
  areaName: string
): ScheduleArea {
  const existing = areaMap.get(areaName);
  if (existing) {
    return existing;
  }
  const areaId = areaIdMap.get(areaName) || buildAreaId(areaName, areaIdMap.size + 1);
  areaIdMap.set(areaName, areaId);
  const area: ScheduleArea = {
    area_id: areaId,
    area_name_ja: areaName,
    categories: [],
  };
  areaMap.set(areaName, area);
  return area;
}

function buildAreaId(name: string, index: number): string {
  const normalized = normalizeFullWidthDigits(name)
    .replace(/丁目/g, "-chome")
    .replace(/番地?/g, "-")
    .replace(/[（）()]/g, " ")
    .replace(/\s+/g, "-")
    .toLowerCase();
  const ascii = normalized
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `area-${index}`;
}

function mapCategoryId(name: string, index: number): string {
  const normalized = name.replace(/\s+/g, "");
  const dictionary: Record<string, string> = {
    "燃やすごみ": "burnable",
    "可燃ごみ": "burnable",
    "燃えるごみ": "burnable",
    "不燃ごみ": "non-burnable",
    "燃やさないごみ": "non-burnable",
    "陶器・ガラス・金属ごみ": "ceramics-glass-metal",
    "資源": "recyclable",
    "資源ごみ": "recyclable",
    "粗大ごみ": "oversized",
    "有害ごみ": "hazardous",
  };
  if (dictionary[normalized]) {
    return dictionary[normalized];
  }
  const ascii = normalized
    .toLowerCase()
    .replace(/[^a-z-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `category-${indexToLetters(index)}`;
}

function pickFirst(fields: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (fields[key]) {
      return fields[key];
    }
  }
  return undefined;
}

function parseCollectionDays(
  input: string
):
  | { type: "weekly"; days: string[] }
  | { type: "monthly"; pattern: Array<{ week: number; day: string }> }
  | null {
  const text = normalizeFullWidthDigits(input).replace(/\s+/g, "");
  const dayMap: Record<string, string> = {
    月: "monday",
    火: "tuesday",
    水: "wednesday",
    木: "thursday",
    金: "friday",
    土: "saturday",
    日: "sunday",
  };

  const monthlyPairs: Array<{ week: number; day: string }> = [];
  for (const match of text.matchAll(/第([1-5])([月火水木金土日])/g)) {
    const week = Number.parseInt(match[1], 10);
    const day = dayMap[match[2]];
    if (day) {
      monthlyPairs.push({ week, day });
    }
  }
  for (const match of text.matchAll(/第([1-5](?:・[1-5])+)([月火水木金土日])/g)) {
    const weeks = match[1].split("・").map((entry) => Number.parseInt(entry, 10));
    const day = dayMap[match[2]];
    if (day) {
      for (const week of weeks) {
        monthlyPairs.push({ week, day });
      }
    }
  }
  if (monthlyPairs.length > 0) {
    const deduped = dedupeMonthly(monthlyPairs);
    return { type: "monthly", pattern: deduped };
  }

  const weeklyDays: string[] = [];
  for (const match of text.matchAll(/[月火水木金土日]/g)) {
    const day = dayMap[match[0]];
    if (day) {
      weeklyDays.push(day);
    }
  }
  if (weeklyDays.length > 0) {
    return { type: "weekly", days: [...new Set(weeklyDays)] };
  }

  return null;
}

export function parseCollectionDaysForTest(
  input: string
):
  | { type: "weekly"; days: string[] }
  | { type: "monthly"; pattern: Array<{ week: number; day: string }> }
  | null {
  return parseCollectionDays(input);
}

function dedupeMonthly(input: Array<{ week: number; day: string }>): Array<{ week: number; day: string }> {
  const seen = new Set<string>();
  const out: Array<{ week: number; day: string }> = [];
  for (const entry of input) {
    const key = `${entry.week}:${entry.day}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function indexToLetters(index: number): string {
  let value = Math.max(1, index);
  let out = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}
