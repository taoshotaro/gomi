import { PipelineError } from "../pipeline/errors.js";
import type { ExecutorResult, ExtractionTask, SourceDescriptor } from "../pipeline/types.js";
import { runApiExecutor } from "../executors/api.js";
import { runCsvExecutor } from "../executors/csv.js";
import { runHtmlExecutor, type HtmlExecutorOptions } from "../executors/html.js";
import { runPlaceholderExecutor } from "../executors/placeholder.js";

export function runLocalSkillAdapter(input: {
  task: ExtractionTask;
  source: SourceDescriptor;
  html?: HtmlExecutorOptions;
}): {
  output: unknown;
  executorType: ExecutorResult["executorType"];
} {
  const { task, source } = input;
  if (task.executorType === "csv") {
    return { output: runCsvExecutor(source.localPath, task.target), executorType: "csv" };
  }
  if (task.executorType === "html") {
    return {
      output: runHtmlExecutor(source.localPath, task.target, {
        ...input.html,
        sourceUrl: input.html?.sourceUrl ?? source.url,
      }),
      executorType: "html",
    };
  }
  if (task.executorType === "api") {
    return { output: runApiExecutor(source.localPath, task.target), executorType: "api" };
  }
  if (
    task.executorType === "xlsx" ||
    task.executorType === "pdf" ||
    task.executorType === "image"
  ) {
    return {
      output: runPlaceholderExecutor(source.localPath, task.target, task.executorType),
      executorType: task.executorType,
    };
  }

  throw new PipelineError(`Unsupported local adapter for ${task.executorType}`, {
    code: "LOCAL_ADAPTER_UNSUPPORTED",
    retryable: false,
  });
}
