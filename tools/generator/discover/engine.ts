import { generateText } from "ai";
import { z } from "zod";
import { createTools } from "../lib/ai.js";
import { extractJsonFromText } from "../lib/json.js";
import { fetchTextWithLimits, stripHtmlToText } from "../lib/http.js";
import { runModelText } from "../lib/model.js";
import type { PipelineContext } from "../pipeline/context.js";
import { PipelineError } from "../pipeline/errors.js";
import type { HttpArtifact, DiscoverCandidate, DiscoverOutputV2, SourceType, TargetType } from "../pipeline/types.js";
import {
  curateCandidates,
  deriveOfficialDomains,
  evaluateDiscoverStop,
  type CandidateEnrichment,
} from "./curation.js";
import { extractCandidateLinks } from "./link-graph.js";
import { applyQueryPolicy } from "./query-policy.js";
import { computeDomainLock } from "./domain-lock.js";

const responseSchema = z.object({
  city_id: z.string().optional(),
  prefecture_id: z.string().optional(),
  official_url: z.string().optional(),
  candidate_urls: z
    .array(
      z.union([
        z.string(),
        z.object({
          url: z.string(),
          target: z.enum(["schedule", "separation", "both"]).optional(),
          reason_tags: z.array(z.string()).optional(),
        }),
      ])
    )
    .default([]),
});

export interface DiscoverRoundReport {
  round: number;
  timeoutMs: number;
  timedOut: boolean;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  coverage: {
    schedule: number;
    separation: number;
  };
  missingTargets: TargetType[];
  qualityReady: boolean;
  schedulePrimaryScore?: number;
  separationPrimaryScore?: number;
  schedulePrimaryType?: SourceType;
  separationPrimaryType?: SourceType;
  scheduleTopEvidence?: unknown;
  separationTopEvidence?: unknown;
  stopGateFailures: Array<{ target: TargetType; reason: string }>;
  searchUsed: number;
  fetchUsed: number;
  domainLocked: boolean;
  lockedHosts: string[];
  queryDupRatio: number;
  hostSwitches: number;
  budgetExitReason?: string;
  decisionReason: string;
}

export interface DiscoverEngineResult {
  discover: DiscoverOutputV2;
  rounds: DiscoverRoundReport[];
  rejected: DiscoverCandidate[];
  httpArtifacts: HttpArtifact[];
}

export async function runDiscoverEngine(
  context: PipelineContext,
  signal: AbortSignal
): Promise<DiscoverEngineResult> {
  const { options, logger } = context;
  const allCandidates = new Map<string, CandidateEnrichment>();
  const fetched = new Set<string>();
  const httpArtifacts: HttpArtifact[] = [];
  const rounds: DiscoverRoundReport[] = [];

  let officialUrl = options.url || "";
  let cityId = "";
  let prefectureId = "";

  let queryPlan = applyQueryPolicy({
    queries: defaultQueries(options.city, options.prefecture),
    seedCount: options.discoverToolBudgetPolicy.seedQueryCount,
  }).queries;

  for (let round = 1; round <= options.discoverMaxRounds; round += 1) {
    const roundTimeoutMs = calculateDiscoverRoundTimeout(
      options.discoverTimeoutPolicy.baseMs,
      options.discoverTimeoutPolicy.stepMs,
      options.discoverTimeoutPolicy.maxMs,
      round
    );
    logger.info("Discover round started", {
      step: "discover",
      eventType: "discover.round",
      phase: "start",
      round,
      timeoutMs: roundTimeoutMs,
      queryCount: queryPlan.length,
      knownCandidates: allCandidates.size,
    });

    let roundOutput: {
      cityId?: string;
      prefectureId?: string;
      officialUrl?: string;
      candidates: CandidateEnrichment[];
      searchUsed: number;
      fetchUsed: number;
      queryDupRatio: number;
      budgetExitReason?: string;
    };
    try {
      roundOutput = await runDiscoverRound({
        context,
        signal,
        round,
        queries: queryPlan,
        previousCandidates: [...allCandidates.values()],
        officialUrl,
        roundTimeoutMs,
      });
    } catch (error) {
      if (!isModelTimeout(error)) {
        throw error;
      }
      const timeoutCurated = curateFromPool(options, allCandidates, cityId, prefectureId, officialUrl);
      const timeoutDecision = evaluateDiscoverStop(
        timeoutCurated.output,
        options.discoverQualityPolicy,
        options.discoverStopMode
      );
      const timeoutMissingTargets = missingTargets(timeoutCurated.output.selected);
      rounds.push(
        buildRoundReport(round, roundTimeoutMs, true, timeoutCurated.output, timeoutDecision, timeoutMissingTargets, {
          searchUsed: 0,
          fetchUsed: 0,
          domainLocked: false,
          lockedHosts: [],
          queryDupRatio: 0,
          hostSwitches: 0,
          budgetExitReason: "timeout-before-structured-output",
        })
      );
      logger.warn("Discover model round timed out", {
        step: "discover",
        eventType: "discover.round",
        phase: "fail",
        round,
        timeoutMs: roundTimeoutMs,
        errorCode: "MODEL_TIMEOUT",
        decisionReason: timeoutDecision.reason,
      });
      logger.info("Discover quality evaluated", {
        step: "discover",
        eventType: "discover.quality",
        round,
        qualityReady: timeoutDecision.ready,
        decisionReason: timeoutDecision.reason,
        schedulePrimaryScore: timeoutDecision.metrics.schedulePrimaryScore,
        separationPrimaryScore: timeoutDecision.metrics.separationPrimaryScore,
        schedulePrimaryType: timeoutDecision.metrics.schedulePrimaryType,
        separationPrimaryType: timeoutDecision.metrics.separationPrimaryType,
        gateFailures: timeoutDecision.gateFailures,
      });
      logger.info("Discover score snapshot", {
        step: "discover",
        eventType: "discover.score",
        round,
        schedulePrimaryScore: timeoutDecision.metrics.schedulePrimaryScore,
        separationPrimaryScore: timeoutDecision.metrics.separationPrimaryScore,
      });
      logger.info("Discover gate evaluation", {
        step: "discover",
        eventType: "discover.gate",
        round,
        gateFailures: timeoutDecision.gateFailures,
      });

      if (options.discoverTimeoutPolicy.softFail && timeoutDecision.ready) {
        logger.warn("Discover timeout recovered from existing curated pool", {
          step: "discover",
          eventType: "discover.timeout.recovered",
          round,
          timeoutMs: roundTimeoutMs,
          decisionReason: timeoutDecision.reason,
        });
        logger.info("Discover stop condition reached", {
          step: "discover",
          eventType: "discover.stop",
          round,
          decisionReason: "timeout-recovered",
        });
        return {
          discover: timeoutCurated.output,
          rounds,
          rejected: timeoutCurated.rejected,
          httpArtifacts,
        };
      }

      if (round >= options.discoverMaxRounds) {
        logger.error("Discover timeout could not be recovered", {
          step: "discover",
          eventType: "discover.timeout.fatal",
          round,
          timeoutMs: roundTimeoutMs,
          decisionReason: timeoutDecision.reason,
          missingTargets: timeoutMissingTargets,
        });
        throw new PipelineError(
          `Discover timed out and did not meet ${options.discoverStopMode} stop policy (reason=${timeoutDecision.reason})`,
          { code: "MODEL_TIMEOUT", retryable: false, cause: error }
        );
      }

      queryPlan = applyQueryPolicy({
        queries: followupQueries(options.city, options.prefecture, timeoutMissingTargets),
        seedCount: options.discoverToolBudgetPolicy.seedQueryCount,
      }).queries;
      continue;
    }

    if (roundOutput.cityId && !cityId) {
      cityId = roundOutput.cityId;
    }
    if (roundOutput.prefectureId && !prefectureId) {
      prefectureId = roundOutput.prefectureId;
    }
    if (roundOutput.officialUrl && !officialUrl) {
      officialUrl = roundOutput.officialUrl;
    }

    const officialDomains = deriveOfficialDomains(officialUrl || options.url);
    const domainLock = computeDomainLock(
      roundOutput.candidates,
      officialDomains,
      options.discoverToolBudgetPolicy.maxHostSwitches
    );
    logger.info("Discover domain lock evaluated", {
      step: "discover",
      eventType: "discover.domain_lock",
      round,
      domainLocked: domainLock.locked,
      lockedHosts: domainLock.lockedHosts,
      hostSwitches: domainLock.hostSwitches,
    });

    if (options.discoverDomainLockPolicy.requireOfficialDomain && !domainLock.locked) {
      if (
        options.discoverDomainLockPolicy.noOfficialDomainStrategy === "emergency-burst" &&
        round < options.discoverMaxRounds
      ) {
        logger.warn("No official domain lock yet; trying emergency burst next round", {
          step: "discover",
          eventType: "discover.domain_lock",
          phase: "fail",
          round,
          decisionReason: "no-official-domain-emergency-burst",
        });
        queryPlan = applyQueryPolicy({
          queries: emergencyQueries(options.city, options.prefecture),
          seedCount: options.discoverToolBudgetPolicy.seedQueryCount,
        }).queries;
        continue;
      }
      throw new PipelineError("Discover failed: no official/open-data domain lock established", {
        code: "DISCOVER_NO_OFFICIAL_DOMAIN",
        retryable: false,
      });
    }

    const allowHosts = domainLock.locked
      ? domainLock.lockedHosts
      : buildLinkAllowHosts(options.discoverAllowHosts, officialDomains);

    const enriched = await enrichCandidates({
      rawCandidates: roundOutput.candidates,
      allCandidates,
      fetched,
      maxFetches: options.discoverMaxFetches,
      currentFetchCount: httpArtifacts.length,
      maxBytes: options.maxDownloadBytes,
      timeoutMs: options.httpTimeoutMs,
      signal,
      maxDepth: options.discoverLinkDepth,
      allowHosts,
      httpArtifacts,
      fetchCap: options.discoverToolBudgetPolicy.fetchCap,
    });

    for (const candidate of enriched.candidates) {
      allCandidates.set(candidate.url, candidate);
    }

    const curated = curateCandidates([...allCandidates.values()], {
      cityId: cityId || fallbackId(options.city, "city"),
      prefectureId: prefectureId || fallbackId(options.prefecture, "pref"),
      officialDomains: deriveOfficialDomains(officialUrl || options.url),
      officialUrl: officialUrl || options.url || "",
      maxCandidates: options.discoverMaxCandidates,
      qualityPolicy: options.discoverQualityPolicy,
    });

    const stopDecision = evaluateDiscoverStop(
      curated.output,
      options.discoverQualityPolicy,
      options.discoverStopMode
    );
    const missingTargetsForRound = missingTargets(curated.output.selected);

    rounds.push(
      buildRoundReport(
        round,
        roundTimeoutMs,
        false,
        curated.output,
        stopDecision,
        missingTargetsForRound,
        {
          searchUsed: roundOutput.searchUsed,
          fetchUsed: roundOutput.fetchUsed + enriched.fetchUsed,
          domainLocked: domainLock.locked,
          lockedHosts: domainLock.lockedHosts,
          queryDupRatio: roundOutput.queryDupRatio,
          hostSwitches: domainLock.hostSwitches,
          budgetExitReason: roundOutput.budgetExitReason ?? enriched.budgetExitReason,
        }
      )
    );
    logger.info("Discover budget snapshot", {
      step: "discover",
      eventType: "discover.budget",
      round,
      searchUsed: roundOutput.searchUsed,
      searchCap: options.discoverToolBudgetPolicy.searchCap,
      fetchUsed: roundOutput.fetchUsed + enriched.fetchUsed,
      fetchCap: options.discoverToolBudgetPolicy.fetchCap,
      queryDupRatio: roundOutput.queryDupRatio,
      budgetExitReason: roundOutput.budgetExitReason ?? enriched.budgetExitReason,
    });
    logger.info("Discover query dedupe snapshot", {
      step: "discover",
      eventType: "discover.query_dedupe",
      round,
      queryDupRatio: roundOutput.queryDupRatio,
      maxQueryDupRatio: options.discoverToolBudgetPolicy.maxQueryDupRatio,
    });
    logger.info("Discover fetch focus snapshot", {
      step: "discover",
      eventType: "discover.fetch_focus",
      round,
      domainLocked: domainLock.locked,
      lockedHosts: domainLock.lockedHosts,
      fetchUsed: roundOutput.fetchUsed + enriched.fetchUsed,
    });

    logger.info("Discover quality evaluated", {
      step: "discover",
      eventType: "discover.quality",
      round,
      qualityReady: stopDecision.ready,
      decisionReason: stopDecision.reason,
      schedulePrimaryScore: stopDecision.metrics.schedulePrimaryScore,
      separationPrimaryScore: stopDecision.metrics.separationPrimaryScore,
      schedulePrimaryType: stopDecision.metrics.schedulePrimaryType,
      separationPrimaryType: stopDecision.metrics.separationPrimaryType,
      missingTargets: missingTargetsForRound,
      gateFailures: stopDecision.gateFailures,
    });
    logger.info("Discover score snapshot", {
      step: "discover",
      eventType: "discover.score",
      round,
      schedulePrimaryScore: stopDecision.metrics.schedulePrimaryScore,
      separationPrimaryScore: stopDecision.metrics.separationPrimaryScore,
      schedulePrimaryType: stopDecision.metrics.schedulePrimaryType,
      separationPrimaryType: stopDecision.metrics.separationPrimaryType,
    });
    logger.info("Discover gate evaluation", {
      step: "discover",
      eventType: "discover.gate",
      round,
      gateFailures: stopDecision.gateFailures,
    });

    if (stopDecision.ready) {
      logger.info("Discover stop condition reached", {
        step: "discover",
        eventType: "discover.stop",
        round,
        decisionReason: stopDecision.reason,
      });
      return {
        discover: curated.output,
        rounds,
        rejected: curated.rejected,
        httpArtifacts,
      };
    }

    queryPlan = applyQueryPolicy({
      queries: followupQueries(options.city, options.prefecture, missingTargetsForRound),
      seedCount: options.discoverToolBudgetPolicy.seedQueryCount,
    }).queries;
  }

  const finalCurated = curateFromPool(options, allCandidates, cityId, prefectureId, officialUrl);
  const finalStopDecision = evaluateDiscoverStop(
    finalCurated.output,
    options.discoverQualityPolicy,
    options.discoverStopMode
  );

  if (!finalStopDecision.ready) {
    const missing = missingTargets(finalCurated.output.selected);
    throw new PipelineError(
      `Discover ${options.discoverStopMode} stop policy not met (reason=${finalStopDecision.reason}, schedule=${finalCurated.output.selected.schedule.length}, separation=${finalCurated.output.selected.separation.length})`,
      { code: "DISCOVER_QUALITY_UNMET", retryable: false, cause: { missing } }
    );
  }

  logger.info("Discover stop condition reached", {
    step: "discover",
    eventType: "discover.stop",
    round: options.discoverMaxRounds,
    decisionReason: finalStopDecision.reason,
  });

  return {
    discover: finalCurated.output,
    rounds,
    rejected: finalCurated.rejected,
    httpArtifacts,
  };
}

async function runDiscoverRound(input: {
  context: PipelineContext;
  signal: AbortSignal;
  round: number;
  queries: string[];
  previousCandidates: CandidateEnrichment[];
  officialUrl: string;
  roundTimeoutMs: number;
}): Promise<{
  cityId?: string;
  prefectureId?: string;
  officialUrl?: string;
  candidates: CandidateEnrichment[];
  searchUsed: number;
  fetchUsed: number;
  queryDupRatio: number;
  budgetExitReason?: string;
}> {
  const { context, signal, round, queries, previousCandidates, officialUrl, roundTimeoutMs } = input;
  let searchUsed = 0;
  let fetchUsed = 0;
  let queryDupRatio = 0;
  let budgetExitReason: string | undefined;
  const prompt = buildRoundPrompt({
    city: context.options.city,
    prefecture: context.options.prefecture,
    round,
    queries,
    previousCandidates,
    officialUrl,
    searchCap: context.options.discoverToolBudgetPolicy.searchCap,
    fetchCap: context.options.discoverToolBudgetPolicy.fetchCap,
  });

  const tools = createTools({
    timeoutMs: context.options.httpTimeoutMs,
    maxDownloadBytes: context.options.maxDownloadBytes,
    allowedHosts: context.options.discoverAllowHosts,
    searchCap: context.options.discoverToolBudgetPolicy.searchCap,
    fetchCap: context.options.discoverToolBudgetPolicy.fetchCap,
    maxQueryDupRatio: context.options.discoverToolBudgetPolicy.maxQueryDupRatio,
    onWebSearch: ({ allowed, used, dupRatio }) => {
      queryDupRatio = dupRatio;
      if (allowed) {
        searchUsed = Math.max(searchUsed, used);
      } else if (!budgetExitReason) {
        budgetExitReason = used > context.options.discoverToolBudgetPolicy.searchCap
          ? "search-cap-reached"
          : "query-dup-ratio-exceeded";
      }
    },
    onFetchPage: ({ allowed, used }) => {
      if (allowed) {
        fetchUsed = Math.max(fetchUsed, used);
      } else if (!budgetExitReason) {
        budgetExitReason = "fetch-cap-reached";
      }
    },
  });

  const { text } = await runModelText(
    `discover.round.${round}.generateText`,
    () =>
      generateText({
        model: context.model,
        prompt,
        tools,
        maxSteps: Math.max(
          3,
          Math.min(
            context.options.discoverMaxSteps,
            context.options.discoverToolBudgetPolicy.searchCap +
              context.options.discoverToolBudgetPolicy.fetchCap +
              2
          )
        ),
        maxRetries: 2,
        abortSignal: signal,
      }),
    {
      maxModelMs: roundTimeoutMs,
      major: true,
    }
  );

  const parsed = parseRoundResponse(text);
  return {
    cityId: parsed.city_id,
    prefectureId: parsed.prefecture_id,
    officialUrl: parsed.official_url,
    searchUsed,
    fetchUsed,
    queryDupRatio,
    budgetExitReason,
    candidates: parsed.candidate_urls
      .map((entry) => {
        if (typeof entry === "string") {
          return {
            url: entry,
            depth: 0,
          } satisfies CandidateEnrichment;
        }

        const targetHints: TargetType[] =
          entry.target === "both"
            ? ["schedule", "separation"]
            : entry.target
              ? [entry.target]
              : [];

        return {
          url: entry.url,
          targetHints,
          depth: 0,
          title: entry.reason_tags?.join(", "),
        } satisfies CandidateEnrichment;
      })
      .slice(0, context.options.discoverMaxCandidates),
  };
}

async function enrichCandidates(input: {
  rawCandidates: CandidateEnrichment[];
  allCandidates: Map<string, CandidateEnrichment>;
  fetched: Set<string>;
  maxFetches: number;
  currentFetchCount: number;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  maxDepth: number;
  allowHosts: string[];
  httpArtifacts: HttpArtifact[];
  fetchCap: number;
}): Promise<{
  candidates: CandidateEnrichment[];
  fetchUsed: number;
  budgetExitReason?: string;
}> {
  const queue = [...input.rawCandidates];
  const output: CandidateEnrichment[] = [];
  let fetchCount = input.currentFetchCount;
  let fetchUsed = 0;
  let budgetExitReason: string | undefined;

  while (queue.length > 0 && fetchCount < input.maxFetches) {
    if (fetchUsed >= input.fetchCap) {
      budgetExitReason = "fetch-cap-reached";
      break;
    }
    const current = queue.shift()!;
    const canonicalUrl = canonicalizeUrl(current.url);
    if (!canonicalUrl || input.fetched.has(canonicalUrl)) {
      continue;
    }

    input.fetched.add(canonicalUrl);
    fetchCount += 1;
    fetchUsed += 1;

    const result = await fetchTextWithLimits(canonicalUrl, {
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
      signal: input.signal,
      stripHtml: false,
    });

    input.httpArtifacts.push({
      step: "discover",
      url: canonicalUrl,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType: result.contentType,
      lastModified: result.lastModified,
      contentLength: result.contentLength,
      bytesRead: result.bytesRead,
      ok: result.ok,
      error: result.error,
      timestamp: new Date().toISOString(),
    });

    if (!result.ok || !result.body) {
      output.push({
        ...current,
        url: canonicalUrl,
      });
      continue;
    }

    const title = extractTitle(result.body);
    const preview = buildPreview(result.body, result.contentType);
    const enriched: CandidateEnrichment = {
      ...current,
      url: canonicalUrl,
      contentType: result.contentType,
      title,
      preview,
      lastModified: result.lastModified,
      status: result.status,
      bytesRead: result.bytesRead,
      contentLength: result.contentLength,
    };
    output.push(enriched);

    const depth = current.depth ?? 0;
    if (depth >= input.maxDepth || !looksLikeHtml(result.contentType, canonicalUrl)) {
      continue;
    }

    const links = extractCandidateLinks({
      baseUrl: canonicalUrl,
      html: result.body,
      depth,
      maxLinks: 12,
      targetHints: current.targetHints,
    });

    for (const link of links) {
      if (!isAllowedHost(link.url, input.allowHosts)) {
        continue;
      }
      if (input.allCandidates.has(link.url)) {
        continue;
      }
      queue.push(link);
    }
  }

  return {
    candidates: output,
    fetchUsed,
    budgetExitReason,
  };
}

function parseRoundResponse(text: string): z.infer<typeof responseSchema> {
  try {
    const raw = extractJsonFromText(text);
    const parsed = responseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // ignore parse error and fallback to empty payload
  }
  return {
    candidate_urls: [],
  };
}

function defaultQueries(city: string, prefecture: string): string[] {
  return [
    `${city} ごみ収集日 CSV`,
    `${city} オープンデータ ごみ`,
    `${city} ごみ収集カレンダー`,
    `${city} ごみ 分別 一覧`,
    `${prefecture} オープンデータカタログ ごみ`,
  ];
}

function followupQueries(city: string, prefecture: string, missing: TargetType[]): string[] {
  const queries: string[] = [];
  if (missing.includes("schedule")) {
    queries.push(`${city} ごみ収集 曜日 地区`, `${city} garbage schedule open data`);
  }
  if (missing.includes("separation")) {
    queries.push(`${city} ごみ 分別 品目`, `${city} 資源ごみ 出し方`);
  }
  if (queries.length === 0) {
    queries.push(`${city} ${prefecture} ごみ`);
  }
  return queries;
}

function emergencyQueries(city: string, prefecture: string): string[] {
  return [
    `${city} ${prefecture} 公式 ごみ オープンデータ`,
    `site:lg.jp ${city} ごみ CSV`,
    `site:go.jp ${city} ごみ オープンデータ`,
  ];
}

function buildRoundPrompt(input: {
  city: string;
  prefecture: string;
  round: number;
  queries: string[];
  previousCandidates: CandidateEnrichment[];
  officialUrl: string;
  searchCap: number;
  fetchCap: number;
}): string {
  const previous = input.previousCandidates
    .slice(0, 12)
    .map((candidate) => `- ${candidate.url}`)
    .join("\n");

  return `You are discovering official garbage data sources for ${input.city} (${input.prefecture}).

Round: ${input.round}
${input.officialUrl ? `Known official URL: ${input.officialUrl}` : ""}

Use tools (web_search + fetch_page) and return JSON only.

Required JSON schema:
{
  "city_id": "romanized-kebab-case city id",
  "prefecture_id": "romanized-kebab-case prefecture id",
  "official_url": "official garbage top page URL",
  "candidate_urls": [
    {"url": "https://...", "target": "schedule|separation|both", "reason_tags": ["short-tag"]}
  ]
}

Constraints:
- Use at most ${input.searchCap} web_search calls in this round.
- After seed searches, spend effort on fetch_page and in-site navigation (up to ${input.fetchCap} fetches).
- Avoid repeated synonymous queries.
- Prefer official or official-open-data hosts
- Include direct machine-readable schedule assets when available (csv/xlsx/json/api)
- Include separation pages with detailed item/category content
- Exclude utility pages (sitemap/privacy/search/login)
- Candidate URL count <= 20

Queries to consider:
${input.queries.map((query) => `- ${query}`).join("\n")}

Previously seen candidates:
${previous || "- none"}
`;
}

function canonicalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildLinkAllowHosts(explicit: string[] | undefined, officialDomains: string[]): string[] {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return officialDomains;
}

function isAllowedHost(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) {
    return true;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.some((entry) => {
      const normalized = entry.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function buildPreview(body: string, contentType?: string): string {
  if (looksLikeHtml(contentType, "")) {
    return stripHtmlToText(body).slice(0, 1200);
  }
  return body.slice(0, 1200);
}

function looksLikeHtml(contentType: string | undefined, url: string): boolean {
  return contentType?.includes("html") || /\.html?$/.test(url);
}

function fallbackId(input: string, prefix: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (ascii) {
    return ascii;
  }
  return `${prefix}-${Math.abs(stableHash(input)).toString(16).slice(0, 6)}`;
}

function missingTargets(selected: { schedule: string[]; separation: string[] }): TargetType[] {
  const missing: TargetType[] = [];
  if (selected.schedule.length === 0) {
    missing.push("schedule");
  }
  if (selected.separation.length === 0) {
    missing.push("separation");
  }
  return missing;
}

function curateFromPool(
  options: PipelineContext["options"],
  allCandidates: Map<string, CandidateEnrichment>,
  cityId: string,
  prefectureId: string,
  officialUrl: string
) {
  return curateCandidates([...allCandidates.values()], {
    cityId: cityId || fallbackId(options.city, "city"),
    prefectureId: prefectureId || fallbackId(options.prefecture, "pref"),
    officialDomains: deriveOfficialDomains(officialUrl || options.url),
    officialUrl: officialUrl || options.url || "",
    maxCandidates: options.discoverMaxCandidates,
    qualityPolicy: options.discoverQualityPolicy,
  });
}

function buildRoundReport(
  round: number,
  timeoutMs: number,
  timedOut: boolean,
  output: DiscoverOutputV2,
  decision: ReturnType<typeof evaluateDiscoverStop>,
  missing: TargetType[],
  telemetry: {
    searchUsed: number;
    fetchUsed: number;
    domainLocked: boolean;
    lockedHosts: string[];
    queryDupRatio: number;
    hostSwitches: number;
    budgetExitReason?: string;
  }
): DiscoverRoundReport {
  return {
    round,
    timeoutMs,
    timedOut,
    candidateCount: output.candidates.length,
    acceptedCount: output.candidates.filter((entry) => !entry.rejected).length,
    rejectedCount: output.candidates.filter((entry) => entry.rejected).length,
    coverage: {
      schedule: output.selected.schedule.length,
      separation: output.selected.separation.length,
    },
    missingTargets: missing,
    qualityReady: decision.ready,
    schedulePrimaryScore: decision.metrics.schedulePrimaryScore,
    separationPrimaryScore: decision.metrics.separationPrimaryScore,
    schedulePrimaryType: decision.metrics.schedulePrimaryType,
    separationPrimaryType: decision.metrics.separationPrimaryType,
    scheduleTopEvidence: decision.metrics.scheduleTopEvidence,
    separationTopEvidence: decision.metrics.separationTopEvidence,
    stopGateFailures: decision.gateFailures,
    searchUsed: telemetry.searchUsed,
    fetchUsed: telemetry.fetchUsed,
    domainLocked: telemetry.domainLocked,
    lockedHosts: telemetry.lockedHosts,
    queryDupRatio: telemetry.queryDupRatio,
    hostSwitches: telemetry.hostSwitches,
    budgetExitReason: telemetry.budgetExitReason,
    decisionReason: decision.reason,
  };
}

function isModelTimeout(error: unknown): boolean {
  return error instanceof PipelineError && error.code === "MODEL_TIMEOUT";
}

export function calculateDiscoverRoundTimeout(
  baseMs: number,
  stepMs: number,
  maxMs: number,
  round: number
): number {
  if (round <= 1) {
    return Math.min(baseMs, maxMs);
  }
  const timeout = baseMs + (round - 1) * stepMs;
  return Math.min(timeout, maxMs);
}

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash;
}
