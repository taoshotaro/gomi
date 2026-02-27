import { PipelineError } from "./errors.js";
import { emitAgentEvent } from "./events.js";

export class BudgetManager {
  private readonly startedAt = Date.now();

  constructor(
    private readonly maxTotalMs: number,
    private readonly maxStepMs: number
  ) {}

  remainingTotalMs(): number {
    const used = Date.now() - this.startedAt;
    return Math.max(0, this.maxTotalMs - used);
  }

  effectiveStepTimeout(configuredStepMs: number): number {
    const bounded = Math.min(configuredStepMs, this.maxStepMs);
    return Math.min(bounded, this.remainingTotalMs());
  }

  enforceTotalBudget(where: string): void {
    if (this.remainingTotalMs() <= 0) {
      emitAgentEvent({
        level: "error",
        eventType: "budget.enforced",
        message: "Total runtime budget exceeded",
        step: "system",
        attempt: 0,
        action: where,
      });
      throw new PipelineError(`Total budget exceeded before ${where}`, {
        code: "BUDGET_EXCEEDED",
        retryable: false,
      });
    }
  }
}
