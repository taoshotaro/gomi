import { describe, expect, test } from "bun:test";
import { createModel } from "../lib/ai.js";

describe("createModel", () => {
  test("creates anthropic provider model with custom baseURL", () => {
    const model = createModel({
      modelId: "glm-4.7",
      baseURL: "https://api.z.ai/api/anthropic",
      apiKey: "test-key",
      enableSkills: false,
      skillsMode: "hybrid",
      strictSkillsCompat: true,
    });
    expect(model).toBeTruthy();
  });
});

