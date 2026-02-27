import { appendFileSync } from "fs";
import { dirname } from "path";
import { ensureDir } from "../lib/json.js";
import { getTelemetryContext } from "./telemetry-context.js";
import type { AgentEvent, EventType, LogRuntimeConfig } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EmitInput {
  level: LogLevel;
  message: string;
  eventType?: EventType;
  step?: AgentEvent["step"];
  attempt?: number;
  phase?: AgentEvent["phase"];
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

class EventEmitter {
  constructor(private readonly config: LogRuntimeConfig) {}

  emit(input: EmitInput): void {
    const ctx = getTelemetryContext();
    const { level, message, ...rest } = input;
    const baseEvent: AgentEvent = {
      ts: new Date().toISOString(),
      runId: this.config.runId,
      level,
      step: input.step ?? ctx.step,
      attempt: input.attempt ?? ctx.attempt,
      eventType: input.eventType ?? "step.lifecycle",
      message,
      phase: input.phase,
      action: input.action,
      tool: input.tool,
      toolCallId: input.toolCallId,
      durationMs: input.durationMs,
      statusCode: input.statusCode,
      bytes: input.bytes,
      path: input.path,
      retryable: input.retryable,
      errorCode: input.errorCode,
      ...rest,
    };

    const event = redactEvent(baseEvent);

    if (this.config.agentLogs) {
      this.writeTerminal(event);
    }

    if (this.config.eventsLogPath) {
      this.writeFileLine(this.config.eventsLogPath, this.renderPretty(event));
    }

    if (this.config.eventFilePath) {
      this.writeFileLine(this.config.eventFilePath, JSON.stringify(event));
    }
  }

  private writeTerminal(event: AgentEvent): void {
    if (!shouldPrintToTerminal(event, this.config.verbose)) {
      return;
    }

    const line = this.renderTerminalLine(event);

    if (event.level === "error") {
      console.error(line);
      return;
    }
    if (event.level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  private renderTerminalLine(event: AgentEvent): string {
    if (this.config.format === "json") {
      return JSON.stringify(event);
    }
    if (this.config.verbose) {
      return this.renderPretty(event);
    }
    return this.renderCondensed(event);
  }

  renderPretty(event: AgentEvent): string {
    const prefix = `${event.ts} [${event.step}/${event.attempt}] [${event.eventType}]`;
    const extras = Object.entries(event)
      .filter(([key]) =>
        ![
          "ts",
          "runId",
          "level",
          "step",
          "attempt",
          "eventType",
          "message",
        ].includes(key)
      )
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");

    return `${prefix} ${event.message}${extras ? ` ${extras}` : ""}`;
  }

  renderCondensed(event: AgentEvent): string {
    const time = formatShortTime(event.ts);
    const phase = event.phase ? ` ${event.phase}` : "";
    const prefix = `[${time}] ${event.step}#${event.attempt}${phase}`;
    const extras = renderCondensedExtras(event);
    return `${prefix} ${event.message}${extras ? ` ${extras}` : ""}`;
  }

  private writeFileLine(path: string, line: string): void {
    ensureDir(dirname(path));
    appendFileSync(path, `${line}\n`);
  }
}

let globalEmitter: EventEmitter | null = null;

export function initializeEventEmitter(config: LogRuntimeConfig): void {
  globalEmitter = new EventEmitter(config);
}

export function getEventEmitter(): EventEmitter {
  if (!globalEmitter) {
    throw new Error("Event emitter is not initialized");
  }
  return globalEmitter;
}

export function emitAgentEvent(input: EmitInput): void {
  if (!globalEmitter) {
    return;
  }
  globalEmitter.emit(input);
}

const URL_ALLOW_QUERY_KEYS = new Set(["page", "id", "lang"]);

function redactEvent(event: AgentEvent): AgentEvent {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    redacted[key] = redactValue(key, value);
  }
  return redacted as AgentEvent;
}

export function redactEventForTest(event: AgentEvent): AgentEvent {
  return redactEvent(event);
}

export function formatPrettyForTest(event: AgentEvent): string {
  const emitter = new EventEmitter({
    runId: event.runId,
    format: "pretty",
    verbose: true,
    agentLogs: false,
    redactionPolicy: "strict",
  });
  return emitter.renderPretty(event);
}

export function formatCondensedForTest(event: AgentEvent): string {
  const emitter = new EventEmitter({
    runId: event.runId,
    format: "pretty",
    verbose: false,
    agentLogs: false,
    redactionPolicy: "strict",
  });
  return emitter.renderCondensed(event);
}

export function shouldPrintToTerminalForTest(event: AgentEvent, verbose: boolean): boolean {
  return shouldPrintToTerminal(event, verbose);
}

function redactValue(key: string, value: unknown): unknown {
  if (value == null) {
    return value;
  }

  const lowerKey = key.toLowerCase();
  if (isSensitiveKey(lowerKey)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    if (looksLikeUrl(value)) {
      return normalizeUrl(value);
    }
    return truncate(value, 240);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  return (
    key.includes("token") ||
    key.includes("apikey") ||
    key.includes("api_key") ||
    key.includes("secret") ||
    key.includes("password") ||
    key.includes("authorization") ||
    key.includes("cookie") ||
    key.includes("set-cookie")
  );
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const safe = new URL(`${url.protocol}//${url.host}${url.pathname}`);
    for (const [key, val] of url.searchParams.entries()) {
      if (URL_ALLOW_QUERY_KEYS.has(key.toLowerCase())) {
        safe.searchParams.set(key, truncate(val, 40));
      }
    }
    return safe.toString();
  } catch {
    return truncate(value, 240);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...[truncated]`;
}

function shouldPrintToTerminal(event: AgentEvent, verbose: boolean): boolean {
  if (verbose) {
    return true;
  }

  if (event.level === "error") {
    return true;
  }

  if (event.level === "debug") {
    return false;
  }

  if (event.eventType === "state.update" || event.eventType === "file.read" || event.eventType === "file.write") {
    return false;
  }

  if (event.eventType === "http.request") {
    return false;
  }

  if (event.eventType === "http.response") {
    return event.phase === "fail" || event.level === "warn";
  }

  if (event.eventType === "step.lifecycle") {
    if (!event.phase) {
      return true;
    }
    return event.phase === "start" || event.phase === "end" || event.phase === "fail";
  }

  if (event.eventType === "model.lifecycle") {
    if (event.phase === "fail") {
      return true;
    }
    return event.major === true;
  }

  if (event.eventType === "tool.web_search" || event.eventType === "tool.fetch_page") {
    if (event.phase === "fail") {
      return true;
    }
    return event.major === true;
  }

  if (event.eventType === "skills.execution") {
    if (event.phase === "fail") {
      return true;
    }
    return event.major === true;
  }

  if (event.eventType === "source.scored") {
    return false;
  }

  if (event.eventType === "discover.candidate") {
    return false;
  }

  if (
    event.eventType === "discover.round" ||
    event.eventType === "discover.budget" ||
    event.eventType === "discover.domain_lock" ||
    event.eventType === "discover.query_dedupe" ||
    event.eventType === "discover.fetch_focus" ||
    event.eventType === "discover.score" ||
    event.eventType === "discover.gate" ||
    event.eventType === "discover.quality" ||
    event.eventType === "discover.stop" ||
    event.eventType === "discover.timeout.recovered" ||
    event.eventType === "discover.timeout.fatal" ||
    event.eventType === "discover.coverage" ||
    event.eventType === "discover.finalize"
  ) {
    return true;
  }

  if (
    event.eventType === "source.selection" ||
    event.eventType === "source.selection.veto" ||
    event.eventType === "source.selection.fallback" ||
    event.eventType === "cleanup.veto" ||
    event.eventType === "cleanup.summary" ||
    event.eventType === "html.cleanup.skip"
  ) {
    return true;
  }

  if (event.eventType === "cleanup.lifecycle") {
    return event.phase === "start" || event.phase === "end" || event.phase === "fail";
  }

  if (event.eventType === "cleanup.chunk") {
    return false;
  }

  if (event.eventType === "html.cleanup.lifecycle" || event.eventType === "html.cleanup.chunk") {
    return event.phase === "fail";
  }

  return true;
}

function renderCondensedExtras(event: AgentEvent): string {
  const keys: string[] = ["statusCode", "durationMs", "backoffMs", "errorCode", "retryable"];
  const out: string[] = [];
  for (const key of keys) {
    const value = event[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    out.push(`${key}=${JSON.stringify(value)}`);
  }
  return out.join(" ");
}

function formatShortTime(ts: string): string {
  const match = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  if (match) {
    return match[1];
  }
  return ts;
}
