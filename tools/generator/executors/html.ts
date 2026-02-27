import { readFileSync } from "fs";
import { stripHtmlToText } from "../lib/http.js";
import type {
  ExtractedLinkCandidate,
  ExtractedLinkType,
  ExecutorOutput,
  RawRecord,
} from "./types.js";

export interface HtmlExecutorOptions {
  sourceUrl?: string;
  minBlockScore?: number;
  maxRecords?: number;
  allowedLinkTypes?: Set<ExtractedLinkType>;
}

const NOISE_PATTERNS = [
  /(トップページ|サイトマップ|language|色変更|文字サイズ|検索|Google検索|Google Tag)/i,
  /(手続き・届出|施設案内|区政情報|地域活動|防災|子ども|健康・福祉|観光)/i,
  /(プライバシー|cookie|利用規約|アクセシビリティ|読み上げ|閉じる|メニュー)/i,
];

const TARGET_KEYWORDS: Record<"schedule" | "separation", RegExp[]> = {
  schedule: [
    /(収集|収集日|曜日|日程|カレンダー|第[1-5]|可燃|不燃|資源|粗大|ごみ|ゴミ)/,
    /(地区|地域|町名|エリア|燃やすごみ|燃やさないごみ)/,
  ],
  separation: [
    /(分別|品目|出し方|処理|備考|回収|資源|ごみ|ゴミ)/,
    /(燃やすごみ|可燃ごみ|不燃ごみ|粗大ごみ|有害ごみ|陶器・ガラス・金属ごみ)/,
  ],
};

const ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

export function runHtmlExecutor(
  sourcePath: string,
  target: "schedule" | "separation",
  options: HtmlExecutorOptions = {}
): ExecutorOutput {
  const html = readFileSync(sourcePath, "utf-8");
  const content = selectMainContent(html);
  const headings = extractHeadingAnchors(content);

  const { records: tableRecords, tableCount, rowCount } = extractTableRecords(content, headings, target);
  const {
    records: blockRecords,
    blockCount,
    skippedNoiseBlocks,
  } = extractScoredTextBlocks(content, target, options.minBlockScore ?? defaultMinBlockScore(target));
  const links = extractLinkCandidates(content, target, options.sourceUrl, options.allowedLinkTypes);

  const merged = dedupeRecords(
    tableRecords.length > 0 ? [...tableRecords, ...blockRecords] : [...blockRecords, ...fallbackTextRecords(content)],
    options.maxRecords ?? 2200
  );

  return {
    target,
    sourceType: "html",
    sourcePath,
    preview: merged
      .map((record) => record.fields.line || record.row?.join(" | ") || "")
      .filter(Boolean)
      .slice(0, 120)
      .join("\n"),
    records: merged,
    linkCandidates: links.slice(0, 40),
    diagnostics: {
      parser: "html-structured-v2",
      tableCount,
      tableRowCount: rowCount,
      textBlockCount: blockCount,
      skippedNoiseBlocks,
      linkCandidateCount: links.length,
    },
  };
}

function selectMainContent(html: string): string {
  const sanitized = stripNonContentTags(html);
  const contentDetail = sliceAroundMarker(sanitized, 'id="contents-detail"', 1600, 360_000);
  if (contentDetail) {
    return contentDetail;
  }
  const rsReadThis = sliceAroundMarker(sanitized, 'id="rs_read_this"', 1600, 360_000);
  if (rsReadThis) {
    return rsReadThis;
  }
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(sanitized)?.[1];
  return body ?? sanitized;
}

function stripNonContentTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
}

function sliceAroundMarker(
  input: string,
  marker: string,
  beforeChars: number,
  afterChars: number
): string | null {
  const index = input.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const start = Math.max(0, index - beforeChars);
  const end = Math.min(input.length, index + afterChars);
  return input.slice(start, end);
}

function extractHeadingAnchors(
  html: string
): Array<{ index: number; title: string }> {
  const headings: Array<{ index: number; title: string }> = [];
  const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of html.matchAll(regex)) {
    const title = toText(match[2] ?? "");
    if (!title || isLikelyNoiseText(title)) {
      continue;
    }
    headings.push({
      index: match.index ?? 0,
      title,
    });
  }
  return headings;
}

function extractTableRecords(
  html: string,
  headings: Array<{ index: number; title: string }>,
  target: "schedule" | "separation"
): { records: RawRecord[]; tableCount: number; rowCount: number } {
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  const records: RawRecord[] = [];
  let tableCount = 0;
  let rowCount = 0;

  for (const tableMatch of html.matchAll(tableRegex)) {
    tableCount += 1;
    const tableHtml = tableMatch[1] ?? "";
    const section = nearestHeading(headings, tableMatch.index ?? 0);
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const rowMatch of tableHtml.matchAll(rowRegex)) {
      rowCount += 1;
      const rowHtml = rowMatch[1] ?? "";
      const cells = extractCells(rowHtml);
      if (cells.length === 0 || isHeaderLikeRow(cells) || isNoiseRow(cells)) {
        continue;
      }
      const fields = buildRowFields(cells, section, target);
      records.push({
        fields,
        row: cells,
      });
    }
  }

  return { records, tableCount, rowCount };
}

function extractCells(rowHtml: string): string[] {
  const out: string[] = [];
  const cellRegex = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  for (const cellMatch of rowHtml.matchAll(cellRegex)) {
    const text = toText(cellMatch[1] ?? "");
    if (!text) {
      continue;
    }
    out.push(text);
  }
  return out;
}

function buildRowFields(
  cells: string[],
  section: string | undefined,
  target: "schedule" | "separation"
): Record<string, string> {
  const fields: Record<string, string> = {};
  const lineParts: string[] = [];

  if (section) {
    fields.section = section;
    lineParts.push(`[${section}]`);
  }

  if (target === "separation") {
    const mapped = mapSeparationCells(cells);
    if (mapped.item) {
      fields["品目"] = mapped.item;
      lineParts.push(mapped.item);
    }
    if (mapped.disposal) {
      fields["出し方"] = mapped.disposal;
      fields["分類"] = mapped.disposal;
      lineParts.push(mapped.disposal);
    }
    if (mapped.notes) {
      fields["備考"] = mapped.notes;
      lineParts.push(mapped.notes);
    }
  } else {
    if (cells[0]) {
      fields["地区"] = cells[0];
    }
    if (cells[1]) {
      fields["分類"] = cells[1];
    }
    if (cells[2]) {
      fields["収集曜日"] = cells[2];
      fields["収集日"] = cells[2];
    }
  }

  cells.forEach((cell, index) => {
    fields[`col${index + 1}`] = cell;
    if (!lineParts.includes(cell)) {
      lineParts.push(cell);
    }
  });

  fields.line = normalizeSpace(lineParts.join(" | "));
  return fields;
}

function mapSeparationCells(cells: string[]): {
  item?: string;
  disposal?: string;
  notes?: string;
} {
  let start = 0;
  if (cells[0] && cells[0].length <= 2 && !cells[0].includes("ごみ") && !cells[0].includes("ゴミ")) {
    start = 1;
  }

  const item = cells[start];
  const disposal = cells[start + 1];
  const notes = cells.slice(start + 2).join(" / ");
  return {
    item,
    disposal,
    notes: notes || undefined,
  };
}

function extractScoredTextBlocks(
  html: string,
  target: "schedule" | "separation",
  minBlockScore: number
): { records: RawRecord[]; blockCount: number; skippedNoiseBlocks: number } {
  const records: RawRecord[] = [];
  let blockCount = 0;
  let skippedNoiseBlocks = 0;
  const blockRegex = /<(h2|h3|h4|h5|h6|p|li|dt|dd|caption)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(blockRegex)) {
    blockCount += 1;
    const tag = (match[1] ?? "").toLowerCase();
    const text = toText(match[2] ?? "");
    if (!text) {
      skippedNoiseBlocks += 1;
      continue;
    }
    const score = scoreTextBlock(text, target);
    if (score < minBlockScore || isLikelyNoiseText(text)) {
      skippedNoiseBlocks += 1;
      continue;
    }
    records.push({
      fields: {
        line: text,
        blockTag: tag,
        blockScore: score.toFixed(2),
      },
    });
  }

  return { records, blockCount, skippedNoiseBlocks };
}

function fallbackTextRecords(html: string): RawRecord[] {
  const lines = stripHtmlToText(html)
    .split("\n")
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .filter((line) => !isLikelyNoiseText(line))
    .slice(0, 240);

  return lines.map((line) => ({
    fields: { line },
  }));
}

function scoreTextBlock(text: string, target: "schedule" | "separation"): number {
  let score = 0;
  const normalized = normalizeSpace(text);
  if (normalized.length >= 3 && normalized.length <= 90) {
    score += 0.8;
  } else if (normalized.length > 180) {
    score -= 0.7;
  }
  for (const keyword of TARGET_KEYWORDS[target]) {
    if (keyword.test(normalized)) {
      score += 1.6;
    }
  }
  if (/(一覧|全容|出し方|品目)/.test(normalized)) {
    score += 0.9;
  }
  if (/(https?:\/\/|javascript:|mailto:)/i.test(normalized)) {
    score -= 1.6;
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    score -= 2;
  }
  return score;
}

function extractLinkCandidates(
  html: string,
  target: "schedule" | "separation",
  sourceUrl: string | undefined,
  allowedLinkTypes?: Set<ExtractedLinkType>
): ExtractedLinkCandidate[] {
  const byUrl = new Map<string, ExtractedLinkCandidate>();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = (match[1] ?? "").trim();
    if (!href || href.startsWith("#")) {
      continue;
    }
    if (/^(javascript:|mailto:|tel:)/i.test(href)) {
      continue;
    }
    const resolved = resolveLink(href, sourceUrl);
    if (!resolved) {
      continue;
    }
    const text = toText(match[2] ?? "");
    const type = detectLinkType(resolved);
    if (allowedLinkTypes && !allowedLinkTypes.has(type)) {
      continue;
    }

    const scored = scoreLink(resolved, text, target, type);
    if (scored.score < 1.2) {
      continue;
    }

    const existing = byUrl.get(resolved);
    if (!existing || scored.score > existing.score) {
      byUrl.set(resolved, scored);
    }
  }

  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

function scoreLink(
  url: string,
  text: string,
  target: "schedule" | "separation",
  type: ExtractedLinkType
): ExtractedLinkCandidate {
  let score = 0;
  const reasons: string[] = [];
  const signal = `${text} ${url}`.toLowerCase();

  if (type === "csv" || type === "xlsx" || type === "api") {
    score += 3;
    reasons.push(`type=${type}`);
  } else if (type === "html") {
    score += 2.2;
    reasons.push("type=html");
  } else if (type === "pdf") {
    score += 1.8;
    reasons.push("type=pdf");
  }

  if (/(ごみ|ゴミ|資源|分別|出し方|収集|品目|一覧|全容|recycle|garbage)/i.test(signal)) {
    score += 2.2;
    reasons.push("keyword=garbage");
  }
  if (target === "schedule" && /(収集|曜日|日程|カレンダー|calendar)/i.test(signal)) {
    score += 1.5;
    reasons.push("target=schedule");
  }
  if (target === "separation" && /(分別|品目|出し方|全容|分類)/i.test(signal)) {
    score += 1.5;
    reasons.push("target=separation");
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(signal))) {
    score -= 3;
    reasons.push("penalty=noise");
  }
  if (/(search|sitemap|privacy|policy|language)/i.test(signal)) {
    score -= 2.4;
    reasons.push("penalty=utility");
  }

  return {
    url,
    text,
    type,
    score: Math.max(0, score),
    reasons,
  };
}

function detectLinkType(url: string): ExtractedLinkType {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".csv")) {
      return "csv";
    }
    if (path.endsWith(".xlsx") || path.endsWith(".xls")) {
      return "xlsx";
    }
    if (path.endsWith(".json") || path.includes("/api/")) {
      return "api";
    }
    if (path.endsWith(".pdf")) {
      return "pdf";
    }
    if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") || path.endsWith(".webp")) {
      return "image";
    }
    if (path.endsWith(".html") || path.endsWith(".htm") || !path.includes(".")) {
      return "html";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function resolveLink(href: string, sourceUrl: string | undefined): string | null {
  if (!sourceUrl) {
    if (/^https?:\/\//i.test(href)) {
      return href;
    }
    return null;
  }
  try {
    return new URL(href, sourceUrl).toString();
  } catch {
    return null;
  }
}

function nearestHeading(
  headings: Array<{ index: number; title: string }>,
  at: number
): string | undefined {
  let selected: string | undefined;
  for (const heading of headings) {
    if (heading.index > at) {
      break;
    }
    selected = heading.title;
  }
  return selected;
}

function isHeaderLikeRow(cells: string[]): boolean {
  if (cells.length === 0) {
    return true;
  }
  const joined = cells.join(" ").replace(/\s+/g, "");
  if (/^(行|品目|分類|出し方|備考|地区|地域|曜日|収集日)+$/.test(joined)) {
    return true;
  }
  return cells.every((cell) => cell.length <= 8 && /(行|品目|分類|出し方|備考|地区|曜日|収集)/.test(cell));
}

function isNoiseRow(cells: string[]): boolean {
  const joined = normalizeSpace(cells.join(" "));
  if (!joined) {
    return true;
  }
  if (joined.length < 2) {
    return true;
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(joined))) {
    return true;
  }
  if (/^(前へ|次へ|閉じる|ページ|一覧|トップ)$/.test(joined)) {
    return true;
  }
  return false;
}

function isLikelyNoiseText(text: string): boolean {
  const normalized = normalizeSpace(text);
  if (!normalized || normalized.length <= 1) {
    return true;
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (/^(前へ|次へ|閉じる|一覧|トップページ)$/u.test(normalized)) {
    return true;
  }
  return false;
}

function dedupeRecords(records: RawRecord[], maxRecords: number): RawRecord[] {
  const out: RawRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const line = normalizeSpace(record.fields.line || record.row?.join(" | ") || "");
    if (!line) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      ...record,
      fields: {
        ...record.fields,
        line,
      },
    });
    if (out.length >= maxRecords) {
      break;
    }
  }
  return out;
}

function toText(input: string): string {
  return normalizeSpace(
    decodeHtmlEntities(
      input
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6]|dt|dd|td|th)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/\n+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&([a-zA-Z0-9#]+);/g, (_full, entity: string) => {
    const direct = ENTITY_MAP[entity];
    if (direct !== undefined) {
      return direct;
    }
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const parsed = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    }
    if (entity.startsWith("#")) {
      const parsed = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    }
    return "";
  });
}

function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, " ").replace(/[　]/g, " ").trim();
}

function defaultMinBlockScore(target: "schedule" | "separation"): number {
  return target === "schedule" ? 1.6 : 1.8;
}
