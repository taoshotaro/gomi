import type { EventType, LogFormat, StepName } from "./types.js";
import { emitAgentEvent, type LogLevel } from "./events.js";

export interface LogMeta {
  step?: StepName | "system";
  attempt?: number;
  eventType?: EventType;
  phase?: "start" | "end" | "fail" | "progress";
  action?: string;
  tool?: string;
  toolCallId?: string;
  durationMs?: number;
  statusCode?: number;
  bytes?: number;
  path?: string;
  retryable?: boolean;
  errorCode?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly runId: string,
    private readonly format: LogFormat,
    private readonly logFilePath?: string,
    private readonly verbose: boolean = false
  ) {
    void this.runId;
    void this.format;
    void this.logFilePath;
    void this.verbose;
  }

  debug(message: string, meta: LogMeta = {}): void {
    this.emit("debug", message, meta);
  }

  info(message: string, meta: LogMeta = {}): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta: LogMeta = {}): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta: LogMeta = {}): void {
    this.emit("error", message, meta);
  }

  private emit(level: LogLevel, message: string, meta: LogMeta): void {
    emitAgentEvent({
      level,
      message,
      eventType: meta.eventType ?? "step.lifecycle",
      ...meta,
    });
  }
}
