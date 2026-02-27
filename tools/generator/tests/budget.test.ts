import { describe, expect, test } from "bun:test";
import { BudgetManager } from "../pipeline/budget.js";

describe("BudgetManager", () => {
  test("caps step timeout by configured step and remaining total budget", async () => {
    const budget = new BudgetManager(100, 80);
    const first = budget.effectiveStepTimeout(500);
    expect(first).toBeLessThanOrEqual(80);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = budget.effectiveStepTimeout(500);
    expect(second).toBeLessThanOrEqual(first);
  });
});

