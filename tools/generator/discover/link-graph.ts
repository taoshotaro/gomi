import type { TargetType } from "../pipeline/types.js";
import { detectSourceType, type CandidateEnrichment } from "./curation.js";

interface LinkExtractOptions {
  baseUrl: string;
  html: string;
  depth: number;
  maxLinks: number;
  targetHints?: TargetType[];
}

const GARBAGE_KEYWORD = /(ごみ|ゴミ|garbage|recycle|資源|収集|分別|品目|出し方)/i;
const DIRECT_DATA_HINT = /(resource|download|dataset|api|opendata|csv|xlsx|json)/i;

export function extractCandidateLinks(options: LinkExtractOptions): CandidateEnrichment[] {
  const out = new Map<string, CandidateEnrichment>();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of options.html.matchAll(anchorRegex)) {
    const href = (match[1] ?? "").trim();
    if (!href || href.startsWith("#") || /^(javascript:|mailto:|tel:)/i.test(href)) {
      continue;
    }

    const resolved = resolveLink(href, options.baseUrl);
    if (!resolved) {
      continue;
    }

    const text = stripTags(match[2] ?? "").trim();
    const signal = `${resolved} ${text}`;
    const type = detectSourceType(resolved);

    let score = 0;
    if (type === "csv" || type === "xlsx" || type === "api") {
      score += 2.2;
    }
    if (type === "pdf") {
      score += 1.1;
    }
    if (type === "html") {
      score += 0.8;
    }
    if (GARBAGE_KEYWORD.test(signal)) {
      score += 1.3;
    }
    if (DIRECT_DATA_HINT.test(signal)) {
      score += 1.2;
    }
    if (/(resource\/[a-f0-9-]{16,}|download|api\/|dataset\/)/i.test(resolved)) {
      score += 1.0;
    }
    if (/(sitemap|privacy|cookie|login|問い合わせ)/i.test(signal)) {
      score -= 1.6;
    }

    if (score < 1) {
      continue;
    }

    if (!out.has(resolved)) {
      out.set(resolved, {
        url: resolved,
        discoveredFrom: options.baseUrl,
        depth: options.depth + 1,
        targetHints: options.targetHints,
        title: text.slice(0, 120),
      });
    }

    if (out.size >= options.maxLinks) {
      break;
    }
  }

  return [...out.values()];
}

function resolveLink(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
