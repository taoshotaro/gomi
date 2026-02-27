import type { SkillExecutionPlan, SourceType } from "../pipeline/types.js";

export function buildSkillExecutionPlan(input: {
  taskId: string;
  target: "schedule" | "separation";
  sourceType: SourceType;
  preferredPath: "native" | "local";
  timeoutMs: number;
}): SkillExecutionPlan {
  return {
    taskId: input.taskId,
    target: input.target,
    preferredPath: input.preferredPath,
    requiredFeatures: requiredFeaturesForSourceType(input.sourceType),
    timeoutMs: input.timeoutMs,
  };
}

export function requiredFeaturesForSourceType(
  sourceType: SourceType
): SkillExecutionPlan["requiredFeatures"] {
  if (sourceType === "xlsx") {
    return ["document_parse", "code_execution"];
  }
  if (sourceType === "pdf") {
    return ["document_parse"];
  }
  if (sourceType === "image") {
    return ["vision"];
  }
  return [];
}

