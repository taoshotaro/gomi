import { PipelineError } from "../pipeline/errors.js";
import { emitAgentEvent } from "../pipeline/events.js";
import type {
  ModelRuntimeConfig,
  SkillExecutionPlan,
  SkillsRuntimeStatus,
} from "../pipeline/types.js";

export async function preflightNativeSkillsCompatibility(
  runtime: ModelRuntimeConfig
): Promise<SkillsRuntimeStatus> {
  const baseURLHost = safeHost(runtime.baseURL);
  emitAgentEvent({
    level: "info",
    eventType: "skills.compatibility",
    step: "system",
    attempt: 0,
    message: "Running native skills compatibility preflight",
    phase: "start",
    baseURLHost,
    modelId: runtime.modelId,
    skillsMode: runtime.skillsMode,
    strictSkillsCompat: runtime.strictSkillsCompat,
  });

  const isLikelyAnthropicFirstParty = baseURLHost.includes("anthropic.com");
  const status: SkillsRuntimeStatus = {
    nativeSkillsSupported: isLikelyAnthropicFirstParty,
    codeExecutionSupported: isLikelyAnthropicFirstParty,
    reason: isLikelyAnthropicFirstParty
      ? "First-party Anthropic endpoint detected"
      : "Non-Anthropic host; native skills compatibility is not guaranteed",
  };

  emitAgentEvent({
    level: status.nativeSkillsSupported ? "info" : "warn",
    eventType: "skills.compatibility",
    step: "system",
    attempt: 0,
    message: "Native skills compatibility preflight completed",
    phase: "end",
    nativeSkillsSupported: status.nativeSkillsSupported,
    codeExecutionSupported: status.codeExecutionSupported,
    reason: status.reason,
    baseURLHost,
  });

  return status;
}

export async function runNativeAnthropicSkill(
  _plan: SkillExecutionPlan
): Promise<never> {
  throw new PipelineError(
    "Native Anthropic Skills execution is not wired yet in this repository runtime",
    { code: "NATIVE_SKILLS_NOT_IMPLEMENTED", retryable: false }
  );
}

export function enforceNativeSkillsStatus(input: {
  status: SkillsRuntimeStatus;
  runtime: ModelRuntimeConfig;
}): void {
  if (input.status.nativeSkillsSupported && input.status.codeExecutionSupported) {
    return;
  }

  if (!input.runtime.strictSkillsCompat) {
    return;
  }

  const message = `Native skills compatibility check failed: ${input.status.reason ?? "unknown reason"}. Use --skills-mode local or switch endpoint/model.`;
  emitAgentEvent({
    level: "error",
    eventType: "skills.failure",
    step: "system",
    attempt: 0,
    message,
    strictSkillsCompat: input.runtime.strictSkillsCompat,
    skillsMode: input.runtime.skillsMode,
  });
  throw new PipelineError(message, { code: "SKILLS_INCOMPATIBLE", retryable: false });
}

function safeHost(baseURL: string): string {
  try {
    return new URL(baseURL).host.toLowerCase();
  } catch {
    return "invalid-base-url";
  }
}

