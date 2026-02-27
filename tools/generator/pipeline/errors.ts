export class PipelineError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(message: string, options: { code: string; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export class NetworkError extends PipelineError {
  constructor(message: string, cause?: unknown, retryable = true) {
    super(message, { code: "NETWORK_ERROR", retryable, cause });
  }
}

export class SchemaError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "SCHEMA_ERROR", retryable: false, cause });
  }
}

export class ExtractionError extends PipelineError {
  constructor(message: string, cause?: unknown, retryable = true) {
    super(message, { code: "EXTRACTION_ERROR", retryable, cause });
  }
}

export class ValidationFailure extends PipelineError {
  constructor(message: string, cause?: unknown, retryable = false) {
    super(message, { code: "VALIDATION_ERROR", retryable, cause });
  }
}

export class StepTimeoutError extends PipelineError {
  constructor(step: string, timeoutMs: number) {
    super(`Step ${step} timed out after ${timeoutMs}ms`, {
      code: "STEP_TIMEOUT",
      retryable: true,
    });
  }
}
