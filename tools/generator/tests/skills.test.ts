import { describe, expect, test } from "bun:test";
import { enforceNativeSkillsStatus, preflightNativeSkillsCompatibility } from "../skills/native-anthropic.js";
import type { ModelRuntimeConfig } from "../pipeline/types.js";

function baseRuntime(baseURL: string): ModelRuntimeConfig {
  return {
    modelId: "glm-4.7",
    baseURL,
    apiKey: "test-key",
    enableSkills: true,
    skillsMode: "hybrid",
    strictSkillsCompat: true,
  };
}

describe("native skills preflight", () => {
  test("marks non-anthropic hosts as incompatible", async () => {
    const status = await preflightNativeSkillsCompatibility(
      baseRuntime("https://api.z.ai/api/anthropic")
    );
    expect(status.nativeSkillsSupported).toBe(false);
    expect(status.codeExecutionSupported).toBe(false);
  });

  test("throws when strict compatibility is enabled and unsupported", () => {
    expect(() =>
      enforceNativeSkillsStatus({
        status: {
          nativeSkillsSupported: false,
          codeExecutionSupported: false,
          reason: "unsupported",
        },
        runtime: baseRuntime("https://api.z.ai/api/anthropic"),
      })
    ).toThrow("compatibility check failed");
  });
});

