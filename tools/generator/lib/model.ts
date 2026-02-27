import { emitAgentEvent } from "../pipeline/events.js";
import { PipelineError } from "../pipeline/errors.js";

interface ModelCallOptions {
  maxModelMs?: number;
  major?: boolean;
}

export async function runModelText<T>(
  action: string,
  op: () => Promise<T>,
  options: ModelCallOptions = {}
): Promise<T> {
  const startedAt = Date.now();
  const major = options.major ?? true;
  emitAgentEvent({
    level: "info",
    eventType: "model.lifecycle",
    message: "Model call started",
    phase: "start",
    action,
    major,
  });

  try {
    const result = await withModelTimeout(op(), options.maxModelMs, action);
    emitAgentEvent({
      level: "info",
      eventType: "model.lifecycle",
      message: "Model call completed",
      phase: "end",
      action,
      durationMs: Date.now() - startedAt,
      bytes: safeSize(result),
      major,
    });
    return result;
  } catch (error) {
    emitAgentEvent({
      level: "error",
      eventType: "model.lifecycle",
      message: "Model call failed",
      phase: "fail",
      action,
      durationMs: Date.now() - startedAt,
      errorCode: "MODEL_CALL_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      major,
    });
    throw error;
  }
}

async function withModelTimeout<T>(
  promise: Promise<T>,
  maxModelMs: number | undefined,
  action: string
): Promise<T> {
  if (!maxModelMs || maxModelMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new PipelineError(`Model call timed out for ${action} after ${maxModelMs}ms`, {
          code: "MODEL_TIMEOUT",
          retryable: false,
        })
      );
    }, maxModelMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeSize(value: unknown): number | undefined {
  try {
    return JSON.stringify(value).length;
  } catch {
    return undefined;
  }
}
