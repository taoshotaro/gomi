import type {
  DiscoverCandidate,
  DiscoverEvidenceMetrics,
  DiscoverOutputV2,
  DiscoverQualityPolicy,
  DiscoverSelection,
  DiscoverStopMode,
  SourceType,
  TargetType,
} from "../pipeline/types.js";

const UTILITY_PATTERNS = [
  /sitemap/i,
  /privacy/i,
  /cookie/i,
  /policy/i,
  /search/i,
  /login/i,
  /accessibility/i,
  /contact/i,
  /お問い合わせ/i,
  /サイトマップ/i,
  /プライバシー/i,
];

const GARBAGE_KEYWORDS = [
  "ごみ",
  "ゴミ",
  "garbage",
  "recycle",
  "資源",
  "収集",
  "分別",
  "品目",
  "出し方",
];

const SCHEDULE_KEYWORDS = ["収集", "収集日", "曜日", "カレンダー", "schedule", "calendar"];
const SEPARATION_KEYWORDS = ["分別", "品目", "出し方", "recycle", "recycling"];

export interface CandidateEnrichment {
  url: string;
  contentType?: string;
  title?: string;
  preview?: string;
  targetHints?: TargetType[];
  discoveredFrom?: string;
  depth?: number;
  lastModified?: string;
  status?: number;
  bytesRead?: number;
  contentLength?: number;
}

export interface CurationOptions {
  officialDomains: string[];
  cityId: string;
  prefectureId: string;
  officialUrl: string;
  maxCandidates: number;
  qualityPolicy?: DiscoverQualityPolicy;
}

export interface CurationResult {
  output: DiscoverOutputV2;
  rejected: DiscoverCandidate[];
  selectedCandidates: DiscoverCandidate[];
}

export interface DiscoverStopMetrics {
  schedulePrimaryScore?: number;
  separationPrimaryScore?: number;
  schedulePrimaryType?: SourceType;
  separationPrimaryType?: SourceType;
  scheduleTopEvidence?: DiscoverEvidenceMetrics;
  separationTopEvidence?: DiscoverEvidenceMetrics;
}

export interface DiscoverStopDecision {
  ready: boolean;
  reason: string;
  metrics: DiscoverStopMetrics;
  gateFailures: Array<{
    target: TargetType;
    reason: string;
  }>;
}

export function deriveOfficialDomains(officialUrl: string | undefined): string[] {
  const domains = new Set<string>([
    "lg.jp",
    "go.jp",
    "data.go.jp",
    "opendata.metro.tokyo.lg.jp",
    "catalog.data.metro.tokyo.lg.jp",
  ]);

  if (officialUrl) {
    try {
      const host = new URL(officialUrl).hostname.toLowerCase();
      domains.add(host);
      const parts = host.split(".");
      if (parts.length >= 2) {
        domains.add(parts.slice(-2).join("."));
      }
    } catch {
      // ignore invalid URL
    }
  }

  return [...domains];
}

export function curateCandidates(
  seeds: CandidateEnrichment[],
  options: CurationOptions
): CurationResult {
  const byCanonical = new Map<string, DiscoverCandidate>();
  const policy = options.qualityPolicy ?? policyDefaults();

  for (const seed of seeds) {
    const normalizedUrl = normalizeUrl(seed.url);
    if (!normalizedUrl) {
      continue;
    }

    const host = safeHost(normalizedUrl);
    const type = detectSourceType(normalizedUrl, seed.contentType);
    const targetHints = inferTargetHints(normalizedUrl, seed.preview, seed.title, seed.targetHints);

    const officialness = scoreOfficialness(host, options.officialDomains);
    const directness = scoreDirectness(type, normalizedUrl, seed.contentType);
    const relevance = scoreRelevance(normalizedUrl, seed.title, seed.preview, targetHints);
    const evidenceMetrics = buildEvidenceMetrics({
      type,
      title: seed.title,
      preview: seed.preview,
      contentType: seed.contentType,
      lastModified: seed.lastModified,
      officialness,
      directness,
      relevance,
    }, policy);

    const scheduleScore = compositeScoreForTarget("schedule", evidenceMetrics, policy);
    const separationScore = compositeScoreForTarget("separation", evidenceMetrics, policy);
    const score = Math.max(scheduleScore, separationScore);

    const reasons = [
      ...new Set(
        [
          `type=${type}`,
          `officialness=${officialness.toFixed(2)}`,
          `directness=${directness.toFixed(2)}`,
          `relevance=${relevance.toFixed(2)}`,
          `scheduleScore=${scheduleScore.toFixed(2)}`,
          `separationScore=${separationScore.toFixed(2)}`,
          `noiseRatio=${evidenceMetrics.noiseRatio.toFixed(2)}`,
        ].filter(Boolean)
      ),
    ];

    const rejectReason = getRejectReason({
      url: normalizedUrl,
      host,
      officialness,
      relevance,
      type,
      targetHints,
      title: seed.title,
      preview: seed.preview,
    });

    const candidate: DiscoverCandidate = {
      id: sourceIdFromUrl(normalizedUrl),
      url: normalizedUrl,
      type,
      targetHints,
      host,
      depth: Math.max(0, seed.depth ?? 0),
      discoveredFrom: seed.discoveredFrom,
      officialness,
      directness,
      relevance,
      score,
      reasons,
      evidenceMetrics,
      contentType: seed.contentType,
      title: seed.title,
      preview: seed.preview,
      rejected: Boolean(rejectReason),
      rejectReason,
    };

    const existing = byCanonical.get(normalizedUrl);
    if (!existing || candidate.score > existing.score) {
      byCanonical.set(normalizedUrl, candidate);
    }
  }

  const all = [...byCanonical.values()]
    .sort(
      (a, b) =>
        compareCandidatesForTarget("schedule", b, a, policy) ||
        compareCandidatesForTarget("separation", b, a, policy)
    )
    .slice(0, options.maxCandidates);
  const accepted = all.filter((entry) => !entry.rejected);
  const rejected = all.filter((entry) => entry.rejected);
  const selected = selectPerTarget(accepted, policy);

  const output: DiscoverOutputV2 = {
    version: "2.0.0",
    cityId: options.cityId,
    prefectureId: options.prefectureId,
    officialUrl: options.officialUrl,
    officialDomains: options.officialDomains,
    candidates: all,
    selected,
  };

  return {
    output,
    rejected,
    selectedCandidates: accepted.filter((candidate) =>
      selected.schedule.includes(candidate.id) || selected.separation.includes(candidate.id)
    ),
  };
}

export function hasTargetCoverage(selected: DiscoverSelection): boolean {
  return selected.schedule.length > 0 && selected.separation.length > 0;
}

export function evaluateDiscoverStop(
  output: DiscoverOutputV2,
  policy: DiscoverQualityPolicy,
  mode: DiscoverStopMode
): DiscoverStopDecision {
  const schedulePrimary = findCandidate(output, output.selected.schedule[0]);
  const separationPrimary = findCandidate(output, output.selected.separation[0]);
  const gateFailures: DiscoverStopDecision["gateFailures"] = [];

  const metrics: DiscoverStopMetrics = {
    schedulePrimaryScore: schedulePrimary?.score,
    separationPrimaryScore: separationPrimary?.score,
    schedulePrimaryType: schedulePrimary?.type,
    separationPrimaryType: separationPrimary?.type,
    scheduleTopEvidence: schedulePrimary?.evidenceMetrics,
    separationTopEvidence: separationPrimary?.evidenceMetrics,
  };

  if (mode === "coverage") {
    if (hasTargetCoverage(output.selected)) {
      return { ready: true, reason: "coverage-pass", metrics, gateFailures };
    }
    return { ready: false, reason: "coverage-missing-target", metrics, gateFailures };
  }

  if (!schedulePrimary) {
    gateFailures.push({ target: "schedule", reason: "missing-primary" });
    return { ready: false, reason: "quality-missing-schedule-primary", metrics, gateFailures };
  }
  if (!separationPrimary) {
    gateFailures.push({ target: "separation", reason: "missing-primary" });
    return { ready: false, reason: "quality-missing-separation-primary", metrics, gateFailures };
  }

  const scheduleEvidence = schedulePrimary.evidenceMetrics;
  const separationEvidence = separationPrimary.evidenceMetrics;
  if (!scheduleEvidence) {
    gateFailures.push({ target: "schedule", reason: "missing-evidence" });
    return { ready: false, reason: "quality-schedule-missing-evidence", metrics, gateFailures };
  }
  if (!separationEvidence) {
    gateFailures.push({ target: "separation", reason: "missing-evidence" });
    return { ready: false, reason: "quality-separation-missing-evidence", metrics, gateFailures };
  }

  if (schedulePrimary.score < policy.scheduleThreshold) {
    gateFailures.push({ target: "schedule", reason: "score-below-threshold" });
    return { ready: false, reason: "quality-schedule-below-threshold", metrics, gateFailures };
  }
  if (separationPrimary.score < policy.separationThreshold) {
    gateFailures.push({ target: "separation", reason: "score-below-threshold" });
    return { ready: false, reason: "quality-separation-below-threshold", metrics, gateFailures };
  }

  if (scheduleEvidence.coverageSchedule < policy.minCoverageSchedule) {
    gateFailures.push({ target: "schedule", reason: "coverage-below-min" });
    return { ready: false, reason: "quality-schedule-coverage-below-min", metrics, gateFailures };
  }
  if (separationEvidence.coverageSeparation < policy.minCoverageSeparation) {
    gateFailures.push({ target: "separation", reason: "coverage-below-min" });
    return { ready: false, reason: "quality-separation-coverage-below-min", metrics, gateFailures };
  }

  if (scheduleEvidence.cleanupPassRate < policy.minCleanupPassRate) {
    gateFailures.push({ target: "schedule", reason: "cleanup-pass-rate-below-min" });
    return { ready: false, reason: "quality-schedule-cleanup-pass-rate-below-min", metrics, gateFailures };
  }
  if (separationEvidence.cleanupPassRate < policy.minCleanupPassRate) {
    gateFailures.push({ target: "separation", reason: "cleanup-pass-rate-below-min" });
    return { ready: false, reason: "quality-separation-cleanup-pass-rate-below-min", metrics, gateFailures };
  }

  if (scheduleEvidence.noiseRatio > policy.maxNoiseRatio) {
    gateFailures.push({ target: "schedule", reason: "noise-ratio-above-max" });
    return { ready: false, reason: "quality-schedule-noise-ratio-above-max", metrics, gateFailures };
  }
  if (separationEvidence.noiseRatio > policy.maxNoiseRatio) {
    gateFailures.push({ target: "separation", reason: "noise-ratio-above-max" });
    return { ready: false, reason: "quality-separation-noise-ratio-above-max", metrics, gateFailures };
  }

  if (policy.requireMachineReadableSchedule && !["csv", "xlsx", "api"].includes(schedulePrimary.type)) {
    gateFailures.push({ target: "schedule", reason: "not-machine-readable" });
    return { ready: false, reason: "quality-schedule-not-machine-readable", metrics, gateFailures };
  }

  return { ready: true, reason: "quality-pass", metrics, gateFailures };
}

function selectPerTarget(candidates: DiscoverCandidate[], policy: DiscoverQualityPolicy): DiscoverSelection {
  const schedule = candidates
    .filter((candidate) => candidate.targetHints.includes("schedule"))
    .sort((a, b) => compareCandidatesForTarget("schedule", b, a, policy))
    .slice(0, 5)
    .map((candidate) => candidate.id);

  const separation = candidates
    .filter((candidate) => candidate.targetHints.includes("separation"))
    .sort((a, b) => compareCandidatesForTarget("separation", b, a, policy))
    .slice(0, 5)
    .map((candidate) => candidate.id);

  return {
    schedule,
    separation,
  };
}

function compareCandidatesForTarget(
  target: TargetType,
  left: DiscoverCandidate,
  right: DiscoverCandidate,
  policy: DiscoverQualityPolicy
): number {
  const l = left.evidenceMetrics;
  const r = right.evidenceMetrics;
  const leftScore = l ? compositeScoreForTarget(target, l, policy) : 0;
  const rightScore = r ? compositeScoreForTarget(target, r, policy) : 0;
  const scoreDiff = leftScore - rightScore;
  if (Math.abs(scoreDiff) > 0.01) {
    return scoreDiff;
  }
  const leftCoverage = target === "schedule" ? l?.coverageSchedule ?? 0 : l?.coverageSeparation ?? 0;
  const rightCoverage = target === "schedule" ? r?.coverageSchedule ?? 0 : r?.coverageSeparation ?? 0;
  if (leftCoverage !== rightCoverage) {
    return leftCoverage - rightCoverage;
  }
  const leftNoise = l?.noiseRatio ?? 1;
  const rightNoise = r?.noiseRatio ?? 1;
  if (leftNoise !== rightNoise) {
    return rightNoise - leftNoise;
  }
  const leftCleanup = l?.cleanupPassRate ?? 0;
  const rightCleanup = r?.cleanupPassRate ?? 0;
  if (leftCleanup !== rightCleanup) {
    return leftCleanup - rightCleanup;
  }
  const leftFreshness = l?.freshnessScore ?? 0;
  const rightFreshness = r?.freshnessScore ?? 0;
  if (leftFreshness !== rightFreshness) {
    return leftFreshness - rightFreshness;
  }
  if (left.officialness !== right.officialness) {
    return left.officialness - right.officialness;
  }
  return right.url.localeCompare(left.url);
}

function findCandidate(output: DiscoverOutputV2, sourceId: string | undefined): DiscoverCandidate | undefined {
  if (!sourceId) {
    return undefined;
  }
  return output.candidates.find((candidate) => candidate.id === sourceId);
}

function getRejectReason(input: {
  url: string;
  host: string;
  officialness: number;
  relevance: number;
  type: SourceType;
  targetHints: TargetType[];
  title?: string;
  preview?: string;
}): string | undefined {
  const signal = `${input.url} ${input.title ?? ""} ${input.preview ?? ""}`;
  if (UTILITY_PATTERNS.some((pattern) => pattern.test(signal))) {
    return "utility-navigation-page";
  }

  if (input.officialness < 0.25) {
    return "low-trust-host";
  }

  if (input.relevance < 0.2) {
    return "low-relevance";
  }

  if (input.targetHints.length === 0) {
    return "unknown-target";
  }

  if (
    input.targetHints.includes("schedule") &&
    (input.type === "csv" || input.type === "xlsx" || input.type === "api") &&
    scoreDirectness(input.type, input.url, undefined) < 0.7
  ) {
    return "not-direct-machine-readable";
  }

  return undefined;
}

function inferTargetHints(
  url: string,
  preview?: string,
  title?: string,
  provided?: TargetType[]
): TargetType[] {
  const hints = new Set<TargetType>(provided ?? []);
  const signal = `${url} ${title ?? ""} ${preview ?? ""}`.toLowerCase();

  if (SCHEDULE_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    hints.add("schedule");
  }
  if (SEPARATION_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    hints.add("separation");
  }

  if (hints.size === 0 && GARBAGE_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    hints.add("schedule");
    hints.add("separation");
  }

  return [...hints];
}

function scoreOfficialness(host: string, officialDomains: string[]): number {
  if (!host) {
    return 0;
  }
  if (officialDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return 1;
  }
  if (host.endsWith(".lg.jp") || host.endsWith(".go.jp")) {
    return 0.9;
  }
  if (host.includes("opendata") || host.includes("data")) {
    return 0.7;
  }
  return 0.2;
}

function scoreDirectness(type: SourceType, url: string, contentType?: string): number {
  const path = safePath(url);
  if (type === "csv") {
    return path.endsWith(".csv") || contentType?.includes("csv") ? 1 : 0.75;
  }
  if (type === "xlsx") {
    return path.endsWith(".xlsx") || path.endsWith(".xls") ? 0.95 : 0.7;
  }
  if (type === "api") {
    return path.endsWith(".json") || path.includes("/api/") ? 0.92 : 0.65;
  }
  if (type === "pdf") {
    return 0.55;
  }
  if (type === "html") {
    return 0.28;
  }
  if (type === "image") {
    return 0.22;
  }
  return 0.1;
}

function scoreRelevance(url: string, title?: string, preview?: string, targetHints: TargetType[] = []): number {
  const signal = `${url} ${title ?? ""} ${preview ?? ""}`.toLowerCase();
  let score = 0;

  if (GARBAGE_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    score += 0.55;
  }
  if (SCHEDULE_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    score += 0.2;
  }
  if (SEPARATION_KEYWORDS.some((keyword) => signal.includes(keyword.toLowerCase()))) {
    score += 0.2;
  }
  if (targetHints.length === 2) {
    score += 0.05;
  }

  return Math.max(0, Math.min(1, score));
}

function compositeScoreForTarget(
  target: TargetType,
  evidence: DiscoverEvidenceMetrics,
  policy: Pick<DiscoverQualityPolicy, "maxNoiseRatio">
): number {
  const coverage = target === "schedule" ? evidence.coverageSchedule : evidence.coverageSeparation;
  const noisePenalty = 1 - Math.min(1, evidence.noiseRatio / Math.max(0.0001, policy.maxNoiseRatio));
  const cleanupQuality = (evidence.cleanupPassRate + noisePenalty) / 2;
  return (
    coverage * 0.3 +
    cleanupQuality * 0.25 +
    evidence.freshnessScore * 0.15 +
    evidence.parseSuccess * 0.15 +
    evidence.officialness * 0.15
  );
}

function buildEvidenceMetrics(
  input: {
    type: SourceType;
    title?: string;
    preview?: string;
    contentType?: string;
    lastModified?: string;
    officialness: number;
    directness: number;
    relevance: number;
  },
  policy: DiscoverQualityPolicy
): DiscoverEvidenceMetrics {
  const signal = `${input.title ?? ""} ${input.preview ?? ""}`.toLowerCase();
  const hasAreaSignal = /地区|エリア|町|丁目|一覧|list/.test(signal) ? 1 : 0;
  const hasDaySignal = /曜日|月曜|火曜|水曜|木曜|金曜|土曜|日曜|週|隔週|毎月|collection/.test(signal) ? 1 : 0;
  const hasCategorySignal = /分別|品目|カテゴリ|可燃|不燃|資源|recycle/.test(signal) ? 1 : 0;
  const coverageSchedule = clamp01(0.45 * hasAreaSignal + 0.55 * hasDaySignal + input.relevance * 0.2);
  const coverageSeparation = clamp01(0.6 * hasCategorySignal + 0.2 * hasAreaSignal + input.relevance * 0.2);
  const noiseRatio = estimateNoiseRatio(signal);
  const cleanupPassRate = clamp01(1 - noiseRatio * 0.8);
  const parseSuccess = estimateParseSuccess(input.type, input.contentType, input.directness);
  const freshnessScore = estimateFreshnessScore(input.lastModified, policy.freshnessHalfLifeDays);
  return {
    coverageSchedule,
    coverageSeparation,
    noiseRatio,
    cleanupPassRate,
    freshnessScore,
    parseSuccess,
    officialness: input.officialness,
  };
}

function estimateNoiseRatio(signal: string): number {
  const utilityHits = UTILITY_PATTERNS.filter((pattern) => pattern.test(signal)).length;
  const navHits = /(menu|breadcrumb|サイト内検索|戻る|トップページ)/.test(signal) ? 1 : 0;
  return clamp01(utilityHits * 0.12 + navHits * 0.1);
}

function estimateParseSuccess(type: SourceType, contentType: string | undefined, directness: number): number {
  if (type === "csv" || type === "xlsx" || type === "api") {
    return clamp01(0.9 + directness * 0.1);
  }
  if (type === "html") {
    return contentType?.includes("html") ? 0.75 : 0.6;
  }
  if (type === "pdf") {
    return 0.5;
  }
  if (type === "image") {
    return 0.35;
  }
  return 0.4;
}

function estimateFreshnessScore(lastModified: string | undefined, halfLifeDays: number): number {
  if (!lastModified) {
    return 0.5;
  }
  const parsed = Date.parse(lastModified);
  if (Number.isNaN(parsed)) {
    return 0.5;
  }
  const ageMs = Date.now() - parsed;
  if (ageMs <= 0) {
    return 1;
  }
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const lambda = Math.log(2) / Math.max(1, halfLifeDays);
  return clamp01(Math.exp(-lambda * ageDays));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function detectSourceType(url: string, contentType?: string): SourceType {
  const path = safePath(url);
  if (path.endsWith(".csv") || contentType?.includes("csv")) {
    return "csv";
  }
  if (path.endsWith(".xlsx") || path.endsWith(".xls")) {
    return "xlsx";
  }
  if (path.endsWith(".pdf") || contentType?.includes("pdf")) {
    return "pdf";
  }
  if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") || path.endsWith(".webp")) {
    return "image";
  }
  if (path.endsWith(".json") || path.includes("/api/") || contentType?.includes("json")) {
    return "api";
  }
  if (path.endsWith(".html") || path.endsWith(".htm") || contentType?.includes("html")) {
    return "html";
  }
  return "unknown";
}

function sourceIdFromUrl(url: string): string {
  const hash = stableHash(url).slice(0, 10);
  return `src-${hash}`;
}

function stableHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function policyDefaults(): DiscoverQualityPolicy {
  return {
    scheduleThreshold: 0.82,
    separationThreshold: 0.78,
    requireMachineReadableSchedule: true,
    scoringMode: "evidence-v1",
    minCoverageSchedule: 0.75,
    minCoverageSeparation: 0.7,
    maxNoiseRatio: 0.12,
    minCleanupPassRate: 0.85,
    freshnessHalfLifeDays: 365,
  };
}
