import { existsSync } from "fs";
import type {
  DiscoverOutputV2,
  ExtractionPlan,
  ExtractionTask,
  SourceDescriptor,
  SourceManifestEntry,
  SourceType,
  TargetType,
} from "../pipeline/types.js";
import { CAPABILITY_MATRIX } from "./capability.js";
import { requiredFeaturesForSourceType } from "../skills/registry.js";

interface PlanInput {
  runId: string;
  discover: DiscoverOutputV2;
  sourceManifest: SourceManifestEntry[];
  maxStepMs: number;
  sourceTypeFilter?: SourceType[];
}

export function buildExtractionPlan(input: PlanInput): ExtractionPlan {
  const candidateById = new Map(input.discover.candidates.map((candidate) => [candidate.id, candidate]));
  const priorityBySourceTarget = buildPriorityIndex(input.discover.selected);

  const descriptors: SourceDescriptor[] = [];
  const tasks: ExtractionTask[] = [];

  for (const entry of input.sourceManifest) {
    if (entry.status !== "downloaded" || !entry.localPath || !existsSync(entry.localPath)) {
      continue;
    }

    if (input.sourceTypeFilter && input.sourceTypeFilter.length > 0 && !input.sourceTypeFilter.includes(entry.type)) {
      continue;
    }

    const candidate = candidateById.get(entry.sourceId);
    const trustScore = candidate?.officialness ?? 0.6;
    const descriptorPriority = minTargetPriority(entry.sourceId, entry.targetHints, priorityBySourceTarget);

    descriptors.push({
      id: entry.sourceId,
      type: entry.type,
      url: entry.url,
      mime: entry.contentType,
      lastModified: entry.lastModified,
      localPath: entry.localPath,
      priority: descriptorPriority,
      trustScore,
    });

    const targetHints = entry.targetHints.length > 0 ? entry.targetHints : (["schedule", "separation"] as TargetType[]);
    for (const target of targetHints) {
      const capability = CAPABILITY_MATRIX[entry.type];
      const taskPriority = priorityBySourceTarget.get(priorityKey(entry.sourceId, target)) ?? Number.MAX_SAFE_INTEGER;

      tasks.push({
        id: `task-${target}-${entry.sourceId}`,
        sourceId: entry.sourceId,
        sourceType: entry.type,
        executorType: capability.primary,
        target,
        outputSchema: target === "schedule" ? "schedule-raw" : "separation-raw",
        timeoutMs: Math.max(5_000, Math.min(input.maxStepMs, 40_000)),
        fallback: capability.fallback.map((executorType) => ({
          executorType,
          reason: `fallback from ${entry.type}`,
        })),
        requiredFeatures: requiredFeaturesForSourceType(entry.type),
        preferredPath: "local",
        _priority: taskPriority,
      } as ExtractionTask & { _priority: number });
    }
  }

  const sortedTasks = tasks
    .sort((a, b) => {
      const ap = (a as ExtractionTask & { _priority?: number })._priority ?? Number.MAX_SAFE_INTEGER;
      const bp = (b as ExtractionTask & { _priority?: number })._priority ?? Number.MAX_SAFE_INTEGER;
      if (ap !== bp) {
        return ap - bp;
      }
      return a.id.localeCompare(b.id);
    })
    .map((task) => {
      const cleanTask = { ...task } as ExtractionTask & { _priority?: number };
      delete cleanTask._priority;
      return cleanTask as ExtractionTask;
    });

  return {
    version: "2.0.0",
    runId: input.runId,
    createdAt: new Date().toISOString(),
    sources: descriptors.sort((a, b) => a.priority - b.priority),
    tasks: sortedTasks,
    candidateRankings: {
      schedule: [...input.discover.selected.schedule],
      separation: [...input.discover.selected.separation],
    },
  };
}

function buildPriorityIndex(selected: {
  schedule: string[];
  separation: string[];
}): Map<string, number> {
  const map = new Map<string, number>();

  selected.schedule.forEach((sourceId, index) => {
    map.set(priorityKey(sourceId, "schedule"), index + 1);
  });
  selected.separation.forEach((sourceId, index) => {
    map.set(priorityKey(sourceId, "separation"), index + 1);
  });

  return map;
}

function minTargetPriority(
  sourceId: string,
  targets: TargetType[],
  index: Map<string, number>
): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const target of targets) {
    const value = index.get(priorityKey(sourceId, target));
    if (value !== undefined && value < min) {
      min = value;
    }
  }
  return min === Number.MAX_SAFE_INTEGER ? 99_999 : min;
}

function priorityKey(sourceId: string, target: TargetType): string {
  return `${target}:${sourceId}`;
}
