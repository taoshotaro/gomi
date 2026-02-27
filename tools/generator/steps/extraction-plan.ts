import { join } from "path";
import { readJsonFile, writeJsonAtomic } from "../lib/json.js";
import { buildExtractionPlan } from "../planner/plan.js";
import type { SourceManifestEntry } from "../pipeline/types.js";
import type { PipelineContext } from "../pipeline/context.js";

export async function runExtractionPlanStep(
  context: PipelineContext,
  _signal: AbortSignal
): Promise<void> {
  const { stateStore, options, logger } = context;
  const discover = stateStore.state.sources;
  if (!discover) {
    throw new Error("Discover sources are missing before extraction-plan step");
  }
  const sourceManifestPath =
    stateStore.state.sourceManifestPath ?? join(options.workDir, "source-manifest.json");
  const sourceManifest = readJsonFile<SourceManifestEntry[]>(sourceManifestPath);

  stateStore.setStepMessage("extraction-plan", "Building extraction plan from downloaded sources");
  const plan = buildExtractionPlan({
    runId: options.runId,
    discover,
    sourceManifest,
    maxStepMs: options.maxStepMs,
    sourceTypeFilter: options.sourceTypes,
  });
  for (const task of plan.tasks) {
    const skillsHeavy = task.sourceType === "xlsx" || task.sourceType === "pdf" || task.sourceType === "image";
    task.preferredPath =
      options.enableSkills && skillsHeavy && options.skillsMode !== "local" ? "native" : "local";
  }

  if (plan.tasks.length === 0) {
    throw new Error("Planner produced no extraction tasks");
  }

  const path = join(options.workDir, "extraction-plan.json");
  writeJsonAtomic(path, plan);
  stateStore.state.extractionPlanPath = path;
  stateStore.persist();

  for (const task of plan.tasks) {
    logger.info("Extractor selected for source", {
      step: "extraction-plan",
      eventType: "extractor.decision",
      sourceId: task.sourceId,
      sourceType: task.sourceType,
      executorType: task.executorType,
      target: task.target,
      preferredPath: task.preferredPath,
      requiredFeatures: task.requiredFeatures,
    });
  }

  logger.info("Extraction plan generated", {
    step: "extraction-plan",
    eventType: "planner.lifecycle",
    phase: "end",
    sourceCount: plan.sources.length,
    taskCount: plan.tasks.length,
    path,
  });
}
