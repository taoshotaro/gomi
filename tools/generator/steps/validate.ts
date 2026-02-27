import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { generateObject, generateText } from "ai";
import { commitStagedCityData, updateCitiesJsonAtomic, type CityEntry } from "../lib/commit.js";
import { extractJsonFromText, readJsonFile, writeJsonAtomic } from "../lib/json.js";
import { runModelText } from "../lib/model.js";
import { DATA_SCHEMA_DIR, cityOutputDir } from "../lib/paths.js";
import { scheduleSchema, separationSchema } from "../lib/schemas.js";
import {
  validateCityOutput,
  validateDriftAgainstExisting,
  validateSemanticCityOutput,
  type ValidationIssue,
} from "../lib/validation.js";
import { ValidationFailure } from "../pipeline/errors.js";
import type { PipelineContext } from "../pipeline/context.js";

export async function runValidateStep(
  context: PipelineContext,
  signal: AbortSignal
): Promise<void> {
  const { logger, options, stateStore, dirs, model } = context;
  const sources = stateStore.state.sources;
  if (!sources) {
    throw new ValidationFailure("Discover sources missing before validate step", undefined, false);
  }
  const finalDir = cityOutputDir(sources.prefectureId, sources.cityId);

  stateStore.setStepMessage("validate", "Validating staged outputs");
  if (!options.allowLlmRecordFallback) {
    const issues = validateCityOutput(dirs.stagingDir);
    if (issues.length > 0) {
      throw new ValidationFailure(
        `Validation failed (auto-fix disabled): ${formatIssues(issues)}`,
        undefined,
        false
      );
    }
    logger.info("Validation passed", { step: "validate", eventType: "validation" });
  } else {
  for (let attempt = 0; attempt <= options.maxFixRetries; attempt++) {
    const issues = validateCityOutput(dirs.stagingDir);
    if (issues.length === 0) {
      if (attempt > 0) {
        logger.info("Validation passed after auto-fix", {
          step: "validate",
          eventType: "validation",
          attempts: attempt,
        });
      } else {
        logger.info("Validation passed", { step: "validate", eventType: "validation" });
      }
      break;
    }

    if (attempt === options.maxFixRetries) {
      throw new ValidationFailure(
        `Validation failed after ${options.maxFixRetries} auto-fix attempts: ${formatIssues(
          issues
        )}`,
        undefined,
        false
      );
    }

    logger.warn("Validation issues found; running auto-fix", {
      step: "validate",
      eventType: "validation",
      issueCount: issues.length,
      attempt: attempt + 1,
    });
    logger.info("Reasoning: schema validation failed; invoking auto-fix loop", {
      step: "validate",
      eventType: "reasoning",
    });
    stateStore.setStepMessage(
      "validate",
      `Auto-fixing ${issues.length} file(s), pass ${attempt + 1}/${options.maxFixRetries}`
    );

    for (const issue of issues) {
      await autoFixFile({
        cityDir: dirs.stagingDir,
        issue,
        model,
        logger,
        signal,
      });
    }
    }
  }

  const semanticIssues = validateSemanticCityOutput(dirs.stagingDir);
  if (semanticIssues.length > 0) {
    const cleanupDiagnosis = summarizeCleanupDiagnosis(options.workDir);
    logger.error("Semantic validation failed", {
      step: "validate",
      eventType: "validation",
      phase: "fail",
      issueCount: semanticIssues.length,
      origin: "cleanup-quality",
      cleanupDiagnosis,
    });
    throw new ValidationFailure(
      `Semantic validation failed (origin=cleanup-quality): ${formatIssues(
        semanticIssues
      )}${cleanupDiagnosis ? `; cleanup=${cleanupDiagnosis}` : ""}`,
      undefined,
      false
    );
  }

  const driftIssues = validateDriftAgainstExisting(dirs.stagingDir, finalDir, options.driftThreshold);
  if (driftIssues.length > 0) {
    const selectionDiagnosis = summarizeSelectionDiagnosis(options.workDir);
    logger.error("Drift validation failed", {
      step: "validate",
      eventType: "validation",
      phase: "fail",
      issueCount: driftIssues.length,
      driftThreshold: options.driftThreshold,
      origin: "selection-or-convert",
      selectionDiagnosis,
    });
    throw new ValidationFailure(
      `Drift validation failed (origin=selection-or-convert): ${formatIssues(
        driftIssues
      )}${selectionDiagnosis ? `; selection=${selectionDiagnosis}` : ""}`,
      undefined,
      false
    );
  }

  stateStore.setStepMessage("validate", `Committing staged files to ${finalDir}`);
  const committed = commitStagedCityData(dirs.stagingDir, finalDir);
  for (const file of committed) {
    stateStore.addOutputPath(file);
  }

  const cityEntry: CityEntry = {
    id: `${sources.prefectureId}/${sources.cityId}`,
    name_ja: options.city,
    prefecture_ja: options.prefecture,
    source_url: sources.officialUrl || options.url || "",
    data_path: `jp/${sources.prefectureId}/${sources.cityId}`,
    last_verified: new Date().toISOString().split("T")[0],
  };

  stateStore.setStepMessage("validate", "Updating data/cities.json");
  await updateCitiesJsonAtomic(cityEntry);
  logger.info("Updated cities.json and committed city data", {
    step: "validate",
    eventType: "validation",
    finalDir,
  });

  writeJsonAtomic(join(options.workDir, "summary.json"), {
    runId: options.runId,
    city: options.city,
    prefecture: options.prefecture,
    finalDir,
    committedFiles: committed,
    sources,
    finishedAt: new Date().toISOString(),
  });
  stateStore.setStepMessage("validate", "Summary written");
}

async function autoFixFile(input: {
  cityDir: string;
  issue: ValidationIssue;
  model: PipelineContext["model"];
  logger: PipelineContext["logger"];
  signal: AbortSignal;
}): Promise<void> {
  const filePath = join(input.cityDir, input.issue.file);
  if (!existsSync(filePath)) {
    throw new ValidationFailure(`Cannot auto-fix missing file: ${filePath}`, undefined, false);
  }

  const raw = readFileSync(filePath, "utf-8");
  const schemaFile = input.issue.file === "schedule.json" ? "schedule.schema.json" : "separation.schema.json";
  const schemaText = readFileSync(join(DATA_SCHEMA_DIR, schemaFile), "utf-8");
  const truncated = raw.length > 80_000 ? `${raw.slice(0, 80_000)}\n... (truncated)` : raw;

  const prompt = `Fix this JSON so it passes schema validation.

Validation errors:
${input.issue.messages.map((message) => `- ${message}`).join("\n")}

Schema:
\`\`\`json
${schemaText}
\`\`\`

Current JSON:
\`\`\`json
${truncated}
\`\`\`

Rules:
- Fix only the listed validation errors
- Preserve existing valid data
- Output only the complete fixed JSON.`;

  try {
    let fixed: unknown;
    if (input.issue.file === "schedule.json") {
      const { object } = await runModelText("validate.generateObject.schedule", () =>
        generateObject({
          model: input.model,
          prompt,
          schema: scheduleSchema,
          maxRetries: 3,
          abortSignal: input.signal,
        })
      , {
        maxModelMs: 45_000,
      });
      fixed = object;
    } else {
      const { object } = await runModelText("validate.generateObject.separation", () =>
        generateObject({
          model: input.model,
          prompt,
          schema: separationSchema,
          maxRetries: 3,
          abortSignal: input.signal,
        })
      , {
        maxModelMs: 45_000,
      });
      fixed = object;
    }

    writeJsonAtomic(filePath, fixed);
    return;
  } catch {
    input.logger.info("Reasoning: structured auto-fix failed; using text fallback", {
      step: "validate",
      eventType: "reasoning",
    });
    const { text } = await runModelText("validate.generateText.fallback", () =>
      generateText({
        model: input.model,
        prompt,
        maxRetries: 3,
        abortSignal: input.signal,
      })
    , {
      maxModelMs: 45_000,
    });
    writeJsonAtomic(filePath, extractJsonFromText(text));
  }
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.file}: ${issue.messages.join(" | ")}`)
    .join("; ");
}

function summarizeCleanupDiagnosis(workDir: string): string | undefined {
  const path = join(workDir, "cleanup-report.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const report = readJsonFile<{
      sources?: Array<{ sourceId?: string; target?: string; metrics?: { vetoReasons?: string[] } }>;
    }>(path);
    const vetoed = (report.sources ?? []).filter((entry) => (entry.metrics?.vetoReasons ?? []).length > 0);
    if (vetoed.length === 0) {
      return undefined;
    }
    const first = vetoed[0];
    const reason = first.metrics?.vetoReasons?.[0];
    return `${vetoed.length} vetoed source-target(s), first=${first.sourceId}/${first.target}${reason ? `:${reason}` : ""}`;
  } catch {
    return undefined;
  }
}

function summarizeSelectionDiagnosis(workDir: string): string | undefined {
  const path = join(workDir, "selection-report.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const report = readJsonFile<{
      decisions?: Record<string, { primarySourceId?: string; vetoReasons?: string[] }>;
    }>(path);
    const decisions = report.decisions ?? {};
    const parts = Object.entries(decisions).map(([target, decision]) => {
      const veto = decision.vetoReasons?.length ? ` veto=${decision.vetoReasons[0]}` : "";
      return `${target}:${decision.primarySourceId || "none"}${veto}`;
    });
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join(", ");
  } catch {
    return undefined;
  }
}
