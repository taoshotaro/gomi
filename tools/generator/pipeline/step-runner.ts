import { PipelineError, StepTimeoutError } from "./errors.js";
import { Logger } from "./logger.js";
import { calculateBackoffMs, wait } from "./retry.js";
import { RunStateStore } from "./state.js";
import { runWithTelemetryContext } from "./telemetry-context.js";
import type { StepName } from "./types.js";

const PROGRESS_HEARTBEAT_MS = 15_000;

export interface StepDefinition<TContext> {
  name: StepName;
  timeoutMs: number;
  maxAttempts: number;
  run: (context: TContext, signal: AbortSignal) => Promise<void>;
}

interface RunStepOptions {
  shouldRun: boolean;
  force: boolean;
}

export async function runStep<TContext>(
  step: StepDefinition<TContext>,
  context: TContext,
  store: RunStateStore,
  logger: Logger,
  options: RunStepOptions
): Promise<void> {
  const current = store.state.stepStatuses[step.name];

  if (!options.shouldRun) {
    if (current.status === "pending") {
      store.markStepStatus(step.name, "skipped");
      logger.info("Step skipped by --skip-to", {
        step: step.name,
        eventType: "step.lifecycle",
      });
    } else {
      logger.info("Step left unchanged by --skip-to", {
        step: step.name,
        eventType: "step.lifecycle",
        status: current.status,
      });
    }
    return;
  }

  if (current.status === "succeeded" && !options.force) {
    logger.info("Step already succeeded; no-op", {
      step: step.name,
      eventType: "step.lifecycle",
    });
    return;
  }

  const attemptBase = current.attempts;
  const effectiveTimeoutMs = getEffectiveTimeoutMs(context, step.timeoutMs);
  if (effectiveTimeoutMs <= 0) {
    throw new PipelineError(`No budget remaining before step ${step.name}`, {
      code: "BUDGET_EXCEEDED",
      retryable: false,
    });
  }
  for (let offset = 1; offset <= step.maxAttempts; offset++) {
    const attempt = attemptBase + offset;
    store.markStepAttemptStart(step.name, attempt);
    store.setStepMessage(step.name, `Running attempt ${attempt}`);
    logger.info("Step attempt started", {
      step: step.name,
      attempt,
      eventType: "step.lifecycle",
      phase: "start",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const stepMessage = store.state.stepStatuses[step.name].message;
      logger.debug("Step still running", {
        step: step.name,
        attempt,
        eventType: "step.lifecycle",
        phase: "progress",
        elapsedSec: Math.floor(elapsedMs / 1000),
        action: stepMessage,
      });
    }, PROGRESS_HEARTBEAT_MS);

    try {
      await runWithTelemetryContext({ step: step.name, attempt }, () =>
        step.run(context, controller.signal)
      );
      clearTimeout(timeout);
      clearInterval(heartbeat);
      store.markStepAttemptResult(step.name, attempt, true);
      store.setStepMessage(step.name, "Completed");
      logger.info("Step attempt succeeded", {
        step: step.name,
        attempt,
        eventType: "step.lifecycle",
        phase: "end",
      });
      return;
    } catch (error) {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      const wrapped = normalizeStepError(step.name, effectiveTimeoutMs, error);
      store.markStepAttemptResult(
        step.name,
        attempt,
        false,
        wrapped.code,
        wrapped.message
      );
      store.setStepMessage(step.name, `Attempt ${attempt} failed: ${wrapped.message}`);
      logger.warn("Step attempt failed", {
        step: step.name,
        attempt,
        eventType: "step.lifecycle",
        phase: "fail",
        errorCode: wrapped.code,
        errorMessage: wrapped.message,
      });

      if (offset >= step.maxAttempts || !wrapped.retryable) {
        logger.error("Step exhausted retries", {
          step: step.name,
          attempt,
          eventType: "retry",
          errorCode: wrapped.code,
          errorMessage: wrapped.message,
        });
        throw wrapped;
      }

      const backoffMs = calculateBackoffMs(attempt);
      store.setStepMessage(step.name, `Waiting ${backoffMs}ms before retry`);
      logger.info("Retrying step with backoff", {
        step: step.name,
        attempt,
        eventType: "retry",
        backoffMs,
      });
      await wait(backoffMs);
    }
  }
}

function getEffectiveTimeoutMs<TContext>(context: TContext, configuredMs: number): number {
  const maybeBudget = (context as { budget?: { effectiveStepTimeout: (ms: number) => number } })
    .budget;
  if (!maybeBudget) {
    return configuredMs;
  }
  return maybeBudget.effectiveStepTimeout(configuredMs);
}

function normalizeStepError(
  step: StepName,
  timeoutMs: number,
  error: unknown
): PipelineError {
  if (error instanceof PipelineError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new StepTimeoutError(step, timeoutMs);
  }

  if (error instanceof Error) {
    return new PipelineError(error.message, {
      code: "STEP_ERROR",
      retryable: true,
      cause: error,
    });
  }

  return new PipelineError(String(error), {
    code: "STEP_ERROR",
    retryable: true,
    cause: error,
  });
}
