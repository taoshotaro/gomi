import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { fetchTextWithLimits, stripHtmlToText } from "./http.js";
import { emitAgentEvent } from "../pipeline/events.js";
import type { ModelRuntimeConfig } from "../pipeline/types.js";

export type ModelConfig = ModelRuntimeConfig;

export interface ToolConfig {
  timeoutMs: number;
  maxDownloadBytes: number;
  allowedHosts?: string[];
  searchCap?: number;
  fetchCap?: number;
  maxQueryDupRatio?: number;
  onWebSearch?: (input: {
    query: string;
    normalizedQuery: string;
    allowed: boolean;
    used: number;
    duplicate: boolean;
    dupRatio: number;
  }) => void;
  onFetchPage?: (input: {
    url: string;
    allowed: boolean;
    used: number;
  }) => void;
}

export function createModel(config: ModelConfig) {
  const provider = createAnthropic({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  emitAgentEvent({
    level: "info",
    eventType: "provider.lifecycle",
    step: "system",
    attempt: 0,
    message: "Model provider initialized",
    phase: "start",
    modelId: config.modelId,
    baseURLHost: safeHost(config.baseURL),
    skillsMode: config.skillsMode,
    enableSkills: config.enableSkills,
    strictSkillsCompat: config.strictSkillsCompat,
  });

  return provider(config.modelId);
}

export function createTools(config: ToolConfig) {
  let searchUsed = 0;
  let fetchUsed = 0;
  const seenQueries = new Set<string>();
  let duplicateQueryCount = 0;

  const webSearchTool = tool({
    description:
      "Search the web for information. Returns list of titles, URLs and snippets.",
    parameters: z.object({
      query: z.string().describe("The search query"),
    }),
    execute: async ({ query }) => {
      const startedAt = Date.now();
      const normalizedQuery = normalizeQuery(query);
      const duplicate = seenQueries.has(normalizedQuery);
      if (duplicate) {
        duplicateQueryCount += 1;
      } else {
        seenQueries.add(normalizedQuery);
      }
      const candidateUsed = searchUsed + 1;
      const dupRatio = candidateUsed > 0 ? duplicateQueryCount / candidateUsed : 0;
      const blockedByDupRatio =
        typeof config.maxQueryDupRatio === "number" && dupRatio > config.maxQueryDupRatio;
      const blockedByCap =
        typeof config.searchCap === "number" && searchUsed >= config.searchCap;
      const allowed = !blockedByCap && !blockedByDupRatio;
      config.onWebSearch?.({
        query,
        normalizedQuery,
        allowed,
        used: candidateUsed,
        duplicate,
        dupRatio,
      });
      if (!allowed) {
        emitAgentEvent({
          level: "warn",
          eventType: "tool.web_search",
          message: "web_search tool blocked by discover policy",
          phase: "fail",
          tool: "web_search",
          query,
          major: false,
          errorCode: blockedByCap ? "SEARCH_CAP_REACHED" : "SEARCH_DUP_RATIO_EXCEEDED",
          dupRatio,
          searchCap: config.searchCap,
        });
        return blockedByCap
          ? "Search blocked: per-round search cap reached."
          : "Search blocked: duplicate query ratio exceeded.";
      }
      searchUsed += 1;
      emitAgentEvent({
        level: "info",
        eventType: "tool.web_search",
        message: "web_search tool start",
        phase: "start",
        tool: "web_search",
        action: "executeWebSearch",
        query,
        major: false,
      });
      const result = await executeWebSearch(query);
      emitAgentEvent({
        level: "info",
        eventType: "tool.web_search",
        message: "web_search tool end",
        phase: "end",
        tool: "web_search",
        durationMs: Date.now() - startedAt,
        bytes: result.length,
        major: false,
      });
      return result;
    },
  });

  const fetchPageTool = tool({
    description:
      "Fetch a web page and return readable text content. Useful for official municipal pages.",
    parameters: z.object({
      url: z.string().url().describe("The URL to fetch"),
      max_length: z.number().int().positive().default(50000).optional(),
    }),
    execute: async ({ url, max_length }) => {
      const startedAt = Date.now();
      const blockedByCap =
        typeof config.fetchCap === "number" && fetchUsed >= config.fetchCap;
      const allowed = !blockedByCap;
      config.onFetchPage?.({
        url,
        allowed,
        used: fetchUsed + 1,
      });
      if (!allowed) {
        emitAgentEvent({
          level: "warn",
          eventType: "tool.fetch_page",
          message: "fetch_page tool blocked by discover policy",
          phase: "fail",
          tool: "fetch_page",
          url,
          major: false,
          errorCode: "FETCH_CAP_REACHED",
          fetchCap: config.fetchCap,
        });
        return "Fetch blocked: per-round fetch cap reached.";
      }
      fetchUsed += 1;
      emitAgentEvent({
        level: "info",
        eventType: "tool.fetch_page",
        message: "fetch_page tool start",
        phase: "start",
        tool: "fetch_page",
        action: "fetchTextWithLimits",
        url,
        major: false,
      });
      const result = await fetchTextWithLimits(url, {
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxDownloadBytes,
        allowedHosts: config.allowedHosts,
        stripHtml: false,
      });

      if (!result.ok) {
        emitAgentEvent({
          level: "warn",
          eventType: "tool.fetch_page",
          message: "fetch_page tool failed",
          phase: "fail",
          tool: "fetch_page",
          durationMs: Date.now() - startedAt,
          errorMessage: result.error,
          major: false,
        });
        return `Fetch failed: ${result.error}`;
      }

      const body = result.body ?? "";
      const limit = max_length ?? 50000;
      const preview = result.contentType?.includes("html")
        ? stripHtmlToText(body).slice(0, Math.min(limit, 3000))
        : body.slice(0, Math.min(limit, 3000));
      const summary = {
        url,
        statusCode: result.status,
        contentType: result.contentType,
        title: extractTitle(body),
        preview,
        topLinks: extractTopLinks(body, url, 10),
      };
      emitAgentEvent({
        level: "info",
        eventType: "tool.fetch_page",
        message: "fetch_page tool end",
        phase: "end",
        tool: "fetch_page",
        durationMs: Date.now() - startedAt,
        bytes: body.length,
        statusCode: result.status,
        major: false,
      });
      return JSON.stringify(summary);
    },
  });

  return {
    web_search: webSearchTool,
    fetch_page: fetchPageTool,
  };
}

function normalizeQuery(query: string): string {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function safeHost(baseURL: string): string {
  try {
    return new URL(baseURL).host.toLowerCase();
  } catch {
    return "invalid-base-url";
  }
}

async function executeWebSearch(query: string): Promise<string> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
      },
    });
    if (!response.ok) {
      return `Search failed with HTTP ${response.status}`;
    }

    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const matches = html.matchAll(
      /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    );

    for (const match of matches) {
      let resultUrl = match[1];
      const uddg = resultUrl.match(/uddg=([^&]+)/);
      if (uddg) {
        resultUrl = decodeURIComponent(uddg[1]);
      }

      results.push({
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        url: resultUrl,
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });

      if (results.length >= 10) {
        break;
      }
    }

    if (results.length === 0) {
      return `No results found for "${query}"`;
    }

    return results
      .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
      .join("\n\n");
  } catch (error) {
    return `Search failed: ${String(error)}`;
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function extractTopLinks(html: string, baseUrl: string, max: number): string[] {
  const out = new Set<string>();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;

  for (const match of html.matchAll(regex)) {
    const href = (match[1] ?? "").trim();
    if (!href || href.startsWith("#") || /^(javascript:|mailto:|tel:)/i.test(href)) {
      continue;
    }

    try {
      out.add(new URL(href, baseUrl).toString());
    } catch {
      // ignore malformed links
    }

    if (out.size >= max) {
      break;
    }
  }

  return [...out];
}
