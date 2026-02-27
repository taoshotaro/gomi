import { generateObject } from "ai";
import { z } from "zod";
import type { ExecutorOutput, RawRecord } from "../executors/types.js";
import { normalizeFullWidthDigits } from "../lib/csv.js";
import { runModelText } from "../lib/model.js";
import { emitAgentEvent } from "../pipeline/events.js";
import type {
  CleanupCandidateRecord,
  CleanupMetrics,
  CleanupResultRecord,
  SourceType,
  TargetType,
} from "../pipeline/types.js";

export interface CleanupRuntimeInput {
  model: unknown;
  sourceId: string;
  sourceType: SourceType;
  target: TargetType;
  output: ExecutorOutput;
  mode: "deterministic" | "hybrid";
  maxModelMs: number;
  maxChunkBytes: number;
  maxChunks: number;
  minPassRate: number;
  maxNoiseRatio: number;
}

export interface CleanupRuntimeResult {
  status: "applied" | "degraded" | "failed";
  rawRecords: CleanupCandidateRecord[];
  candidateRecords: CleanupCandidateRecord[];
  cleanRecords: CleanupResultRecord[];
  metrics: CleanupMetrics;
  reason?: string;
}

interface LlmCleanupDecision {
  id: string;
  action: "keep" | "drop" | "rename";
  normalizedText?: string;
  confidence: number;
  reasonTags: string[];
}

const cleanupDecisionSchema = z.object({
  decisions: z
    .array(
      z.object({
        id: z.string().min(1),
        action: z.enum(["keep", "drop", "rename"]),
        normalizedText: z.string().optional(),
        confidence: z.number().min(0).max(1).default(0.7),
        reasonTags: z.array(z.string()).max(8).default([]),
      })
    )
    .max(400),
});

const NOISE_PATTERNS = [
  /(トップ|ホーム|サイトマップ|language|cookie|privacy|利用規約|検索|メニュー)/i,
  /(手続き|施設案内|区政情報|問い合わせ|アクセシビリティ|広告)/i,
  /(ページ先頭|本文へ移動|Google Tag|JavaScript)/i,
];

const TARGET_SIGNALS: Record<TargetType, RegExp[]> = {
  schedule: [/収集|曜日|毎週|第[1-5]|可燃|不燃|資源|粗大|ごみ|ゴミ/],
  separation: [/分別|出し方|回収|可燃|不燃|資源|粗大|有害|容器|包装|ごみ|ゴミ/],
};

const SCHEDULE_FIELD_KEYS = ["地区", "地域", "area", "曜日", "収集", "分類", "category", "ごみ", "ゴミ"];
const SEPARATION_FIELD_KEYS = ["分類", "品目", "category", "item", "出し方", "処理", "備考", "ごみ", "ゴミ"];

export async function runCleanupPhase(input: CleanupRuntimeInput): Promise<CleanupRuntimeResult> {
  const rawRecords = buildRawRecords(input);
  const candidateRecords = rawRecords.filter((record) => record.canonicalText.length > 0);
  const deterministic = candidateRecords.map((candidate) =>
    buildDeterministicDecision(candidate, input.target)
  );

  emitAgentEvent({
    level: "info",
    eventType: "cleanup.lifecycle",
    step: "extract",
    message: "Cleanup phase started",
    phase: "start",
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    target: input.target,
    mode: input.mode,
    rawCount: rawRecords.length,
    candidateCount: candidateRecords.length,
  });

  let chunksProcessed = 0;
  let llmChunks = 0;
  let fallbackChunks = 0;
  let degraded = false;

  if (input.mode === "hybrid" && shouldUseLlmCleanup(input.sourceType) && deterministic.length > 0) {
    const reviewable = deterministic.filter((record) =>
      record.flags.includes("ambiguous") || record.flags.includes("layout-like")
    );
    const chunks = chunkByBytes(reviewable, input.maxChunkBytes).slice(0, input.maxChunks);

    for (const [index, chunk] of chunks.entries()) {
      chunksProcessed += 1;
      if (chunk.length === 0) {
        continue;
      }
      emitAgentEvent({
        level: "info",
        eventType: "cleanup.chunk",
        step: "extract",
        message: "Cleanup chunk started",
        phase: "start",
        sourceId: input.sourceId,
        target: input.target,
        chunkIndex: index + 1,
        chunkSize: chunk.length,
        major: false,
      });
      try {
        const decisions = await runLlmCleanupChunk(input, chunk, index + 1);
        llmChunks += 1;
        applyLlmDecisions(deterministic, decisions);
        emitAgentEvent({
          level: "info",
          eventType: "cleanup.chunk",
          step: "extract",
          message: "Cleanup chunk completed",
          phase: "end",
          sourceId: input.sourceId,
          target: input.target,
          chunkIndex: index + 1,
          produced: decisions.length,
          major: false,
        });
      } catch (error) {
        degraded = true;
        fallbackChunks += 1;
        emitAgentEvent({
          level: "warn",
          eventType: "cleanup.chunk",
          step: "extract",
          message: "Cleanup chunk failed; deterministic fallback applied",
          phase: "fail",
          sourceId: input.sourceId,
          target: input.target,
          chunkIndex: index + 1,
          errorMessage: error instanceof Error ? error.message : String(error),
          major: false,
        });
      }
    }
  }

  const finalRecords = deterministic
    .map((record) => normalizeDecisionRecord(record))
    .filter((record) => record.action !== "drop" && record.text.length > 0);
  const deterministicDrops = deterministic.filter((record) => record.action === "drop").length;
  const signalMatches = finalRecords.filter((record) =>
    hasTargetSignal(record.text, record.normalizedFields, input.target)
  ).length;
  const requiredFields = finalRecords.filter((record) =>
    hasRequiredFieldSignal(record.normalizedFields, record.text, input.target)
  ).length;
  const passRate = ratio(finalRecords.length, candidateRecords.length);
  const noiseRatio = ratio(deterministicDrops, Math.max(candidateRecords.length, 1));
  const schemaSignalRate = ratio(signalMatches, Math.max(finalRecords.length, 1));
  const requiredFieldCoverage = ratio(requiredFields, Math.max(finalRecords.length, 1));
  const vetoReasons = evaluateCleanupGate(
    {
      passRate,
      noiseRatio,
      schemaSignalRate,
      cleanCount: finalRecords.length,
    },
    input
  );

  const metrics: CleanupMetrics = {
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    target: input.target,
    rawCount: rawRecords.length,
    candidateCount: candidateRecords.length,
    cleanCount: finalRecords.length,
    droppedCount: Math.max(0, candidateRecords.length - finalRecords.length),
    passRate,
    noiseRatio,
    schemaSignalRate,
    requiredFieldCoverage,
    chunksProcessed,
    llmChunks,
    fallbackChunks,
    deterministicDrops,
    degraded,
    vetoReasons,
  };

  if (vetoReasons.length > 0) {
    emitAgentEvent({
      level: "warn",
      eventType: "cleanup.veto",
      step: "extract",
      message: "Cleanup quality gate vetoed source",
      sourceId: input.sourceId,
      target: input.target,
      reasons: vetoReasons,
      passRate,
      noiseRatio,
      schemaSignalRate,
    });
  }

  emitAgentEvent({
    level: "info",
    eventType: "cleanup.summary",
    step: "extract",
    message: "Cleanup phase finished",
    phase: vetoReasons.length > 0 ? "fail" : "end",
    sourceId: input.sourceId,
    target: input.target,
    cleanCount: finalRecords.length,
    candidateCount: candidateRecords.length,
    passRate,
    noiseRatio,
    schemaSignalRate,
    chunksProcessed,
    llmChunks,
    fallbackChunks,
  });

  if (candidateRecords.length === 0 || finalRecords.length === 0) {
    return {
      status: "failed",
      rawRecords,
      candidateRecords,
      cleanRecords: finalRecords,
      metrics,
      reason:
        candidateRecords.length === 0
          ? "no candidate records after canonicalization"
          : "cleanup produced no clean records",
    };
  }

  if (degraded) {
    return {
      status: "degraded",
      rawRecords,
      candidateRecords,
      cleanRecords: finalRecords,
      metrics,
    };
  }

  return {
    status: "applied",
    rawRecords,
    candidateRecords,
    cleanRecords: finalRecords,
    metrics,
  };
}

export function evaluateCleanupGate(
  metrics: { passRate: number; noiseRatio: number; schemaSignalRate: number; cleanCount: number },
  input: Pick<CleanupRuntimeInput, "target" | "minPassRate" | "maxNoiseRatio">
): string[] {
  const reasons: string[] = [];
  const minSchemaSignalRate = input.target === "schedule" ? 0.18 : 0.2;
  if (metrics.cleanCount < 1) {
    reasons.push("no-clean-records");
  }
  if (metrics.passRate < input.minPassRate) {
    reasons.push(`pass-rate-below-threshold:${metrics.passRate.toFixed(3)}<${input.minPassRate}`);
  }
  if (metrics.noiseRatio > input.maxNoiseRatio) {
    reasons.push(`noise-ratio-above-threshold:${metrics.noiseRatio.toFixed(3)}>${input.maxNoiseRatio}`);
  }
  if (metrics.schemaSignalRate < minSchemaSignalRate) {
    reasons.push(
      `schema-signal-below-threshold:${metrics.schemaSignalRate.toFixed(3)}<${minSchemaSignalRate}`
    );
  }
  return reasons;
}

export function canonicalizeTextForTest(text: string): string {
  return canonicalizeText(text);
}

function buildRawRecords(input: CleanupRuntimeInput): CleanupCandidateRecord[] {
  const records: CleanupCandidateRecord[] = [];
  for (const [index, record] of input.output.records.entries()) {
    const text = extractRawText(record);
    const normalizedFields = normalizeFields(record.fields ?? {});
    const canonicalText = canonicalizeText(text);
    const flags = classifyFlags(text, canonicalText, input.target);
    records.push({
      id: `${input.sourceId}:${input.target}:${index + 1}`,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      target: input.target,
      sourceRecordIndex: index,
      text,
      canonicalText,
      fields: normalizedFields,
      flags,
    });
  }
  return records;
}

function extractRawText(record: RawRecord): string {
  const line = typeof record.fields.line === "string" ? record.fields.line : "";
  if (line.trim().length > 0) {
    return normalizeValue(line);
  }
  const fieldValues = Object.values(record.fields ?? {})
    .map((value) => normalizeValue(String(value)))
    .filter(Boolean);
  if (fieldValues.length > 0) {
    return fieldValues.join(" | ");
  }
  if (record.row && record.row.length > 0) {
    return record.row.map((value) => normalizeValue(value)).filter(Boolean).join(" | ");
  }
  return "";
}

function normalizeFields(fields: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = normalizeValue(key);
    if (!normalizedKey) {
      continue;
    }
    normalized[normalizedKey] = normalizeValue(value);
  }
  return normalized;
}

function normalizeValue(value: string): string {
  return normalizeFullWidthDigits(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalizeText(text: string): string {
  let normalized = normalizeValue(text);
  normalized = normalized.replace(/^[0-9０-９]+[\s_\-.:：]+/u, "");
  normalized = normalized.replace(/^[#＊*]+/, "").trim();
  return normalized;
}

function classifyFlags(original: string, canonical: string, target: TargetType): string[] {
  const flags: string[] = [];
  if (!canonical) {
    flags.push("empty");
  }
  if (original !== canonical) {
    flags.push("canonicalized");
  }
  if (isLikelyNoiseLine(canonical, target)) {
    flags.push("noise");
  }
  if (canonical.length > 0 && !hasTargetSignal(canonical, {}, target)) {
    flags.push("ambiguous");
  }
  if (/\|/.test(canonical) || /^- /.test(canonical)) {
    flags.push("layout-like");
  }
  return flags;
}

function buildDeterministicDecision(
  candidate: CleanupCandidateRecord,
  target: TargetType
): CleanupResultRecord {
  let action: CleanupResultRecord["action"] = "keep";
  const reasonTags: string[] = [];
  if (!candidate.canonicalText || isLikelyNoiseLine(candidate.canonicalText, target)) {
    action = "drop";
    reasonTags.push("noise");
  }
  if (candidate.text !== candidate.canonicalText) {
    reasonTags.push("canonicalized");
    if (action === "keep") {
      action = "rename";
    }
  }

  return {
    id: candidate.id,
    sourceId: candidate.sourceId,
    sourceType: candidate.sourceType,
    target: candidate.target,
    sourceRecordIndex: candidate.sourceRecordIndex,
    action,
    text: candidate.canonicalText,
    normalizedFields: {
      ...candidate.fields,
      line: candidate.canonicalText,
    },
    confidence: action === "drop" ? 0.98 : 0.78,
    reasonTags,
    flags: [...candidate.flags],
  };
}

async function runLlmCleanupChunk(
  input: CleanupRuntimeInput,
  records: CleanupResultRecord[],
  chunkIndex: number
): Promise<LlmCleanupDecision[]> {
  const prompt = buildCleanupPrompt(input.target, records);
  const { object } = await runModelText(
    `extract.cleanup.${input.target}.${input.sourceId}.${chunkIndex}`,
    () =>
      generateObject({
        model: input.model as never,
        prompt,
        schema: cleanupDecisionSchema,
        temperature: 0,
        maxRetries: 1,
      }),
    {
      maxModelMs: input.maxModelMs,
      major: false,
    }
  );
  return object.decisions;
}

function buildCleanupPrompt(target: TargetType, records: CleanupResultRecord[]): string {
  const hint =
    target === "schedule"
      ? "Keep only lines relevant to municipal collection schedules: area, category, weekday/monthly pickup expressions."
      : "Keep only lines relevant to garbage separation rules: category/item/disposal guidance.";
  const body = records
    .map((record) => `${record.id}\t${record.text}`)
    .join("\n");

  return `You are a strict municipal data cleanup judge.

Task:
- ${hint}
- For each record id, choose action: keep | drop | rename.
- Use "rename" only when a short deterministic clean text is obvious.
- Never invent facts. Keep Japanese text.
- Keep output concise.

Output JSON:
{
  "decisions": [
    {
      "id": "record-id",
      "action": "keep|drop|rename",
      "normalizedText": "optional when rename",
      "confidence": 0.0-1.0,
      "reasonTags": ["noise|menu|header|valid_schedule|valid_separation|ambiguous"]
    }
  ]
}

Records:
${body}`;
}

function applyLlmDecisions(records: CleanupResultRecord[], decisions: LlmCleanupDecision[]): void {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const record of records) {
    const decision = byId.get(record.id);
    if (!decision) {
      continue;
    }
    record.action = decision.action;
    record.confidence = decision.confidence;
    record.reasonTags = [...new Set([...record.reasonTags, ...decision.reasonTags])];
    if (decision.action === "rename" && decision.normalizedText) {
      const canonical = canonicalizeText(decision.normalizedText);
      if (canonical.length === 0) {
        record.action = "drop";
        record.reasonTags.push("empty-rename");
      } else {
        record.text = canonical;
        record.normalizedFields.line = canonical;
      }
    }
  }
}

function normalizeDecisionRecord(record: CleanupResultRecord): CleanupResultRecord {
  const normalizedText = canonicalizeText(record.text);
  if (!normalizedText) {
    return {
      ...record,
      action: "drop",
      text: "",
      normalizedFields: {
        ...record.normalizedFields,
        line: "",
      },
      reasonTags: [...new Set([...record.reasonTags, "empty-after-normalization"])],
    };
  }
  if (record.action !== "drop" && record.text !== normalizedText) {
    record.action = "rename";
  }
  return {
    ...record,
    text: normalizedText,
    normalizedFields: {
      ...record.normalizedFields,
      line: normalizedText,
    },
  };
}

function chunkByBytes(records: CleanupResultRecord[], maxChunkBytes: number): CleanupResultRecord[][] {
  const chunks: CleanupResultRecord[][] = [];
  let current: CleanupResultRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const next = Buffer.byteLength(record.text, "utf-8") + 40;
    if (current.length > 0 && bytes + next > maxChunkBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += next;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function shouldUseLlmCleanup(sourceType: SourceType): boolean {
  return sourceType === "html" || sourceType === "pdf" || sourceType === "image";
}

function isLikelyNoiseLine(text: string, target: TargetType): boolean {
  if (!text) {
    return true;
  }
  if (text.length <= 1) {
    return true;
  }
  if (/^[0-9０-９]+$/.test(text)) {
    return true;
  }
  if (/^[\-\*・_|:：.。、]+$/.test(text)) {
    return true;
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (target === "separation") {
    const compact = text.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim();
    if (/^(?:[あ-わ]行で始まる資源・ごみ|資源・ごみ品目一覧(?:表)?|一覧ページ|タグ|目次)$/u.test(compact)) {
      return true;
    }
  }
  return false;
}

function hasTargetSignal(text: string, fields: Record<string, string>, target: TargetType): boolean {
  if (TARGET_SIGNALS[target].some((pattern) => pattern.test(text))) {
    return true;
  }
  return Object.entries(fields).some(([key, value]) => {
    const merged = `${key} ${value}`;
    return TARGET_SIGNALS[target].some((pattern) => pattern.test(merged));
  });
}

function hasRequiredFieldSignal(
  fields: Record<string, string>,
  text: string,
  target: TargetType
): boolean {
  const keys = Object.keys(fields);
  const keyHints = target === "schedule" ? SCHEDULE_FIELD_KEYS : SEPARATION_FIELD_KEYS;
  const hasKeyHint = keys.some((key) =>
    keyHints.some((hint) => key.toLowerCase().includes(hint.toLowerCase()))
  );
  if (hasKeyHint) {
    return true;
  }
  if (target === "schedule") {
    return /第[1-5]|[月火水木金土日]|曜日/.test(text);
  }
  return /ごみ|ゴミ|分別|出し方|回収/.test(text);
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}
