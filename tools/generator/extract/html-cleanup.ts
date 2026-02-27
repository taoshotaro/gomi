import { generateObject } from "ai";
import { z } from "zod";
import type { ExecutorOutput, RawRecord } from "../executors/types.js";
import { runModelText } from "../lib/model.js";
import { emitAgentEvent } from "../pipeline/events.js";

export interface HtmlCleanupInput {
  model: unknown;
  sourceId: string;
  target: "schedule" | "separation";
  output: ExecutorOutput;
  maxChunkBytes: number;
  maxCalls: number;
  timeoutMs: number;
}

export interface HtmlCleanupResult {
  status: "applied" | "failed";
  records: RawRecord[];
  chunksProcessed: number;
  reason?: string;
}

const cleanupSchema = z.object({
  records: z
    .array(
      z.object({
        text: z.string(),
      })
    )
    .max(400),
});

export async function cleanupHtmlOutput(input: HtmlCleanupInput): Promise<HtmlCleanupResult> {
  const rawLines = input.output.records
    .map((record) => record.fields.line || record.row?.join(" ") || "")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isLikelyLayoutNoise(line));

  if (rawLines.length === 0) {
    return {
      status: "failed",
      records: [],
      chunksProcessed: 0,
      reason: "HTML parser produced no usable lines for cleanup",
    };
  }

  const chunks = chunkLines(rawLines, input.maxChunkBytes).slice(0, input.maxCalls);
  const cleanedRecords: RawRecord[] = [];

  emitAgentEvent({
    level: "info",
    step: "extract",
    eventType: "html.cleanup.lifecycle",
    message: "HTML cleanup started",
    phase: "start",
    sourceId: input.sourceId,
    target: input.target,
    chunks: chunks.length,
  });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prompt = buildCleanupPrompt(input.target, chunk.join("\n"));
    emitAgentEvent({
      level: "info",
      step: "extract",
      eventType: "html.cleanup.chunk",
      message: "HTML cleanup chunk started",
      phase: "start",
      sourceId: input.sourceId,
      chunkIndex: i + 1,
      chunkSize: chunk.length,
      major: false,
    });

    const { object } = await runModelText(
      `extract.htmlCleanup.${input.target}.${input.sourceId}.${i + 1}`,
      () =>
        generateObject({
          model: input.model as never,
          prompt,
          schema: cleanupSchema,
          temperature: 0,
          maxRetries: 1,
        }),
      {
        maxModelMs: input.timeoutMs,
        major: false,
      }
    );

    for (const record of object.records) {
      const text = record.text.trim();
      if (!text || isLikelyLayoutNoise(text)) {
        continue;
      }
      cleanedRecords.push({
        fields: { line: text },
      });
    }

    emitAgentEvent({
      level: "info",
      step: "extract",
      eventType: "html.cleanup.chunk",
      message: "HTML cleanup chunk completed",
      phase: "end",
      sourceId: input.sourceId,
      chunkIndex: i + 1,
      produced: cleanedRecords.length,
      major: false,
    });
  }

  if (cleanedRecords.length === 0) {
    emitAgentEvent({
      level: "warn",
      step: "extract",
      eventType: "html.cleanup.lifecycle",
      message: "HTML cleanup produced zero cleaned records",
      phase: "fail",
      sourceId: input.sourceId,
    });
    return {
      status: "failed",
      records: [],
      chunksProcessed: chunks.length,
      reason: "HTML cleanup returned zero cleaned records",
    };
  }

  emitAgentEvent({
    level: "info",
    step: "extract",
    eventType: "html.cleanup.lifecycle",
    message: "HTML cleanup completed",
    phase: "end",
    sourceId: input.sourceId,
    records: cleanedRecords.length,
  });

  return {
    status: "applied",
    records: cleanedRecords,
    chunksProcessed: chunks.length,
  };
}

function buildCleanupPrompt(target: "schedule" | "separation", chunk: string): string {
  const targetHint =
    target === "schedule"
      ? "Keep only garbage collection schedule content: area names, garbage categories, collection day patterns."
      : "Keep only garbage separation content: category names, item names, disposal rules, notes.";

  return `You are cleaning extracted HTML text for municipal garbage data.

Task:
- ${targetHint}
- Remove navigation, headers/footers, search UI text, breadcrumb trails, privacy/site links, and unrelated content.
- Keep short factual lines only.
- Keep Japanese text as-is.

Output format:
- Return JSON object with { "records": [{ "text": "..." }] } only.

Input lines:
${chunk}`;
}

function chunkLines(lines: string[], maxChunkBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, "utf-8") + 1;
    if (current.length > 0 && currentBytes + bytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function isLikelyLayoutNoise(line: string): boolean {
  const text = line.trim();
  if (!text) {
    return true;
  }
  if (text.length <= 1) {
    return true;
  }
  if (/^(トップ|ホーム|サイトマップ|色変更|Language|検索|地図)$/i.test(text)) {
    return true;
  }
  if (/^(手続き|施設案内|区政情報|地域活動|防災|子ども|健康|環境|観光)$/i.test(text)) {
    return true;
  }
  if (/^(http|https):\/\//i.test(text)) {
    return true;
  }
  if (text.includes("©") || text.includes("cookie") || text.includes("Google Tag")) {
    return true;
  }
  return false;
}
