import { describe, expect, test } from "bun:test";
import {
  formatCondensedForTest,
  formatPrettyForTest,
  redactEventForTest,
  shouldPrintToTerminalForTest,
} from "../pipeline/events.js";
import type { AgentEvent } from "../pipeline/types.js";

function sampleEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ts: "2026-02-26T00:00:00.000Z",
    runId: "run-1",
    level: "info",
    step: "discover",
    attempt: 1,
    eventType: "http.request",
    message: "HTTP request start",
    ...overrides,
  };
}

describe("event redaction", () => {
  test("redacts secret-like keys and normalizes URLs", () => {
    const redacted = redactEventForTest(
      sampleEvent({
        apiKey: "abc123",
        authorization: "Bearer secret",
        url: "https://example.com/path?token=abc&page=2&id=ok",
      })
    );

    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.url).toBe("https://example.com/path?page=2&id=ok");
  });

  test("truncates long strings", () => {
    const redacted = redactEventForTest(
      sampleEvent({
        message: "x".repeat(500),
      })
    );

    expect((redacted.message as string).includes("[truncated]")).toBe(true);
  });
});

describe("event formatting", () => {
  test("pretty format includes step, attempt, eventType and message", () => {
    const line = formatPrettyForTest(
      sampleEvent({
        eventType: "model.lifecycle",
        message: "Model call completed",
        durationMs: 123,
      })
    );

    expect(line).toContain("[discover/1]");
    expect(line).toContain("[model.lifecycle]");
    expect(line).toContain("Model call completed");
    expect(line).toContain("durationMs=123");
  });

  test("condensed format is compact and includes key extras", () => {
    const line = formatCondensedForTest(
      sampleEvent({
        eventType: "step.lifecycle",
        message: "Step attempt failed",
        phase: "fail",
        durationMs: 987,
        errorCode: "STEP_ERROR",
      })
    );

    expect(line).toContain("[00:00:00]");
    expect(line).toContain("discover#1 fail");
    expect(line).toContain("Step attempt failed");
    expect(line).toContain("durationMs=987");
    expect(line).toContain("errorCode=\"STEP_ERROR\"");
  });
});

describe("terminal filtering", () => {
  test("non-verbose hides state and file noise", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({ eventType: "state.update", message: "Step message updated" }),
        false
      )
    ).toBe(false);

    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({ eventType: "file.write", message: "Writing JSON file atomically" }),
        false
      )
    ).toBe(false);
  });

  test("non-verbose shows step lifecycle and failures", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({ eventType: "step.lifecycle", phase: "start", message: "Step attempt started" }),
        false
      )
    ).toBe(true);

    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({ eventType: "http.response", phase: "fail", level: "warn", message: "HTTP failed" }),
        false
      )
    ).toBe(true);
  });

  test("non-verbose shows only major model/tool lifecycle events", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "model.lifecycle",
          phase: "start",
          message: "Model call started",
          major: false,
        }),
        false
      )
    ).toBe(false);

    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "model.lifecycle",
          phase: "start",
          message: "Model call started",
          major: true,
        }),
        false
      )
    ).toBe(true);
  });

  test("non-verbose shows cleanup lifecycle and hides cleanup chunk detail", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "cleanup.lifecycle",
          phase: "start",
          message: "Cleanup phase started",
        }),
        false
      )
    ).toBe(true);

    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "cleanup.chunk",
          phase: "start",
          message: "Cleanup chunk started",
        }),
        false
      )
    ).toBe(false);
  });

  test("non-verbose shows discover quality/stop events", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "discover.quality",
          message: "Discover quality evaluated",
        }),
        false
      )
    ).toBe(true);

    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({
          eventType: "discover.stop",
          message: "Discover stop condition reached",
        }),
        false
      )
    ).toBe(true);
  });

  test("verbose mode prints everything", () => {
    expect(
      shouldPrintToTerminalForTest(
        sampleEvent({ eventType: "state.update", message: "Step message updated" }),
        true
      )
    ).toBe(true);
  });
});

describe("event schema required fields", () => {
  test("contains all required fields", () => {
    const event = sampleEvent();
    expect(event.ts).toBeDefined();
    expect(event.runId).toBeDefined();
    expect(event.level).toBeDefined();
    expect(event.step).toBeDefined();
    expect(event.attempt).toBeDefined();
    expect(event.eventType).toBeDefined();
    expect(event.message).toBeDefined();
  });
});
