import { parseArgs } from "util";
import { defaultWorkDir } from "../lib/paths.js";
import { runGenerateCityPipeline } from "../pipeline/generate-city.js";
import { RunStateMismatchError } from "../pipeline/state.js";
import type { GenerateOptions, OrderedStepName, SourceType, StepName } from "../pipeline/types.js";
import { STEP_ORDER } from "../pipeline/types.js";

const DEFAULT_MAX_FIX_RETRIES = 3;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_MS = 180000;
const DEFAULT_MAX_STEP_MS = 180000;
const DEFAULT_MAX_MODEL_MS = 45000;
const DEFAULT_DISCOVER_MAX_STEPS_FAST = 20;
const DEFAULT_DISCOVER_MAX_STEPS_THOROUGH = 30;
const DEFAULT_DISCOVER_MAX_ROUNDS_FAST = 2;
const DEFAULT_DISCOVER_MAX_ROUNDS_THOROUGH = 3;
const DEFAULT_DISCOVER_MAX_CANDIDATES = 30;
const DEFAULT_DISCOVER_MAX_FETCHES_FAST = 20;
const DEFAULT_DISCOVER_MAX_FETCHES_THOROUGH = 40;
const DEFAULT_DISCOVER_LINK_DEPTH_FAST = 1;
const DEFAULT_DISCOVER_LINK_DEPTH_THOROUGH = 2;
const DEFAULT_DISCOVER_STOP_MODE = "quality";
const DEFAULT_DISCOVER_QUALITY_THRESHOLD_SCHEDULE = 0.82;
const DEFAULT_DISCOVER_QUALITY_THRESHOLD_SEPARATION = 0.78;
const DEFAULT_DISCOVER_REQUIRE_MACHINE_READABLE_SCHEDULE = true;
const DEFAULT_DISCOVER_SCORING_MODE = "evidence-v1";
const DEFAULT_DISCOVER_MIN_COVERAGE_SCHEDULE = 0.75;
const DEFAULT_DISCOVER_MIN_COVERAGE_SEPARATION = 0.7;
const DEFAULT_DISCOVER_MAX_NOISE_RATIO = 0.12;
const DEFAULT_DISCOVER_MIN_CLEANUP_PASS_RATE = 0.85;
const DEFAULT_DISCOVER_FRESHNESS_HALF_LIFE_DAYS = 365;
const DEFAULT_DISCOVER_TIMEOUT_BASE_MS_FAST = 35_000;
const DEFAULT_DISCOVER_TIMEOUT_BASE_MS_THOROUGH = 55_000;
const DEFAULT_DISCOVER_TIMEOUT_STEP_MS = 10_000;
const DEFAULT_DISCOVER_TIMEOUT_MAX_MS_FAST = 90_000;
const DEFAULT_DISCOVER_TIMEOUT_MAX_MS_THOROUGH = 120_000;
const DEFAULT_DISCOVER_TIMEOUT_SOFT_FAIL = true;
const DEFAULT_DISCOVER_SEARCH_CAP = 3;
const DEFAULT_DISCOVER_FETCH_CAP_FAST = 12;
const DEFAULT_DISCOVER_FETCH_CAP_THOROUGH = 20;
const DEFAULT_DISCOVER_SEED_QUERY_COUNT = 3;
const DEFAULT_DISCOVER_REQUIRE_OFFICIAL_DOMAIN = true;
const DEFAULT_DISCOVER_NO_OFFICIAL_DOMAIN_STRATEGY = "fail-fast";
const DEFAULT_DISCOVER_MAX_QUERY_DUP_RATIO = 0.15;
const DEFAULT_DISCOVER_MAX_HOST_SWITCHES = 4;
const DEFAULT_MAX_CONVERT_FIX_RETRIES = 2;
const DEFAULT_SELECTION_TOP_K = 3;
const DEFAULT_SELECTION_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_SELECTION_EVIDENCE_BYTES = 12_000;
const DEFAULT_CLEANUP_MAX_MODEL_MS_FAST = 8_000;
const DEFAULT_CLEANUP_MAX_MODEL_MS_THOROUGH = 15_000;
const DEFAULT_CLEANUP_CHUNK_BYTES = 6_000;
const DEFAULT_CLEANUP_MAX_CHUNKS_FAST = 8;
const DEFAULT_CLEANUP_MAX_CHUNKS_THOROUGH = 16;
const DEFAULT_CLEANUP_MIN_PASS_RATE = 0.9;
const DEFAULT_CLEANUP_MAX_NOISE_RATIO = 0.08;
const DEFAULT_HTML_EXTRACTOR_MODE = "hybrid";
const DEFAULT_HTML_MAX_FOLLOW_LINKS = 2;
const DEFAULT_HTML_MIN_BLOCK_SCORE = 1.8;
const DEFAULT_HTML_LINK_TYPES: SourceType[] = ["html", "csv", "xlsx", "pdf", "api"];
const DEFAULT_HTML_CLEANUP_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_HTML_CLEANUP_CALLS = 2;
const DEFAULT_DRIFT_THRESHOLD = 0.2;

function parseCliArgs(): GenerateOptions {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      city: { type: "string" },
      prefecture: { type: "string" },
      url: { type: "string" },
      "max-fix-retries": { type: "string" },
      "skip-to": { type: "string" },
      "run-id": { type: "string" },
      "work-dir": { type: "string" },
      resume: { type: "boolean" },
      verbose: { type: "boolean" },
      "agent-logs": { type: "boolean" },
      "event-file": { type: "string" },
      "http-timeout-ms": { type: "string" },
      "max-download-bytes": { type: "string" },
      mode: { type: "string" },
      "stop-after": { type: "string" },
      "max-total-ms": { type: "string" },
      "max-step-ms": { type: "string" },
      "max-model-ms": { type: "string" },
      "discover-max-steps": { type: "string" },
      "discover-max-rounds": { type: "string" },
      "discover-max-candidates": { type: "string" },
      "discover-max-fetches": { type: "string" },
      "discover-link-depth": { type: "string" },
      "discover-allow-hosts": { type: "string" },
      "discover-stop-mode": { type: "string" },
      "discover-quality-threshold-schedule": { type: "string" },
      "discover-quality-threshold-separation": { type: "string" },
      "discover-require-machine-readable-schedule": { type: "boolean" },
      "discover-scoring-mode": { type: "string" },
      "discover-min-coverage-schedule": { type: "string" },
      "discover-min-coverage-separation": { type: "string" },
      "discover-max-noise-ratio": { type: "string" },
      "discover-min-cleanup-pass-rate": { type: "string" },
      "discover-freshness-half-life-days": { type: "string" },
      "discover-timeout-base-ms": { type: "string" },
      "discover-timeout-step-ms": { type: "string" },
      "discover-timeout-max-ms": { type: "string" },
      "discover-timeout-soft-fail": { type: "boolean" },
      "discover-search-cap": { type: "string" },
      "discover-fetch-cap": { type: "string" },
      "discover-seed-query-count": { type: "string" },
      "discover-require-official-domain": { type: "boolean" },
      "discover-no-official-domain-strategy": { type: "string" },
      "discover-max-query-dup-ratio": { type: "string" },
      "discover-max-host-switches": { type: "string" },
      "selection-mode": { type: "string" },
      "selection-top-k": { type: "string" },
      "selection-max-model-ms": { type: "string" },
      "selection-confidence-threshold": { type: "string" },
      "selection-evidence-bytes": { type: "string" },
      "cleanup-mode": { type: "string" },
      "cleanup-max-model-ms": { type: "string" },
      "cleanup-chunk-bytes": { type: "string" },
      "cleanup-max-chunks": { type: "string" },
      "cleanup-min-pass-rate": { type: "string" },
      "cleanup-max-noise-ratio": { type: "string" },
      "html-extractor-mode": { type: "string" },
      "html-follow-links": { type: "boolean" },
      "html-max-follow-links": { type: "string" },
      "html-link-types": { type: "string" },
      "html-min-block-score": { type: "string" },
      "html-cleanup-timeout-ms": { type: "string" },
      "html-cleanup-required": { type: "boolean" },
      "html-cleanup-failure-policy": { type: "string" },
      "max-html-cleanup-calls": { type: "string" },
      "drift-threshold": { type: "string" },
      "max-convert-fix-retries": { type: "string" },
      "allow-llm-record-fallback": { type: "boolean" },
      "convert-engine": { type: "string" },
      "planner-only": { type: "boolean" },
      "executor-only": { type: "boolean" },
      "source-types": { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "enable-skills": { type: "boolean" },
      "skills-mode": { type: "string" },
      "strict-skills-compat": { type: "boolean" },
      "log-format": { type: "string" },
      "force-step": { type: "string", multiple: true },
    },
  });

  const values = parsed.values;

  if (!values.city || !values.prefecture) {
    console.error(
      "Usage: bun run tools/generator/cli/generate-city.ts --city <name_ja> --prefecture <prefecture_ja> [--url <url>] [--skip-to <step>] [--stop-after <step>] [--mode fast|thorough] [--discover-max-steps <n>] [--discover-max-rounds <n>] [--discover-max-candidates <n>] [--discover-max-fetches <n>] [--discover-link-depth <n>] [--discover-allow-hosts host1,host2] [--discover-stop-mode coverage|quality] [--discover-quality-threshold-schedule <0..1>] [--discover-quality-threshold-separation <0..1>] [--discover-require-machine-readable-schedule] [--discover-scoring-mode evidence-v1] [--discover-min-coverage-schedule <0..1>] [--discover-min-coverage-separation <0..1>] [--discover-max-noise-ratio <0..1>] [--discover-min-cleanup-pass-rate <0..1>] [--discover-freshness-half-life-days <n>] [--discover-timeout-base-ms <ms>] [--discover-timeout-step-ms <ms>] [--discover-timeout-max-ms <ms>] [--discover-timeout-soft-fail] [--discover-search-cap <n>] [--discover-fetch-cap <n>] [--discover-seed-query-count <n>] [--discover-require-official-domain] [--discover-no-official-domain-strategy fail-fast|emergency-burst] [--discover-max-query-dup-ratio <0..1>] [--discover-max-host-switches <n>] [--selection-mode hybrid|deterministic|llm-first] [--selection-top-k <n>] [--selection-max-model-ms <ms>] [--cleanup-mode deterministic|hybrid] [--cleanup-max-model-ms <ms>] [--cleanup-chunk-bytes <n>] [--cleanup-max-chunks <n>] [--cleanup-min-pass-rate <0..1>] [--cleanup-max-noise-ratio <0..1>] [--html-extractor-mode deterministic|hybrid] [--html-follow-links] [--html-max-follow-links <n>] [--html-link-types html,csv,xlsx,pdf,api] [--html-min-block-score <n>] [--model <id>] [--base-url <url>] [--enable-skills] [--skills-mode native|local|hybrid] [--strict-skills-compat true|false] [--planner-only] [--executor-only] [--resume] [--verbose] [--agent-logs] [--event-file <path>]"
    );
    process.exit(1);
  }

  const skipToRaw = values["skip-to"] as string | undefined;
  const stopAfterRaw = values["stop-after"] as string | undefined;
  const orderedSteps = STEP_ORDER as readonly string[];
  if (skipToRaw && !orderedSteps.includes(skipToRaw)) {
    const skipTo = skipToRaw;
    console.error(`Invalid --skip-to value: ${skipTo}. Valid steps: ${STEP_ORDER.join(", ")}`);
    process.exit(1);
  }
  const skipTo = skipToRaw as OrderedStepName | undefined;
  if (stopAfterRaw && !orderedSteps.includes(stopAfterRaw)) {
    console.error(
      `Invalid --stop-after value: ${stopAfterRaw}. Valid steps: ${STEP_ORDER.join(", ")}`
    );
    process.exit(1);
  }
  const stopAfter = stopAfterRaw as OrderedStepName | undefined;
  if (skipTo && stopAfter) {
    const skipIndex = orderedSteps.indexOf(skipTo);
    const stopIndex = orderedSteps.indexOf(stopAfter);
    if (skipIndex > stopIndex) {
      console.error("--skip-to must be before or equal to --stop-after");
      process.exit(1);
    }
  }

  if (skipTo === "discover") {
    console.error("--skip-to discover is a no-op. Omit --skip-to for full pipeline.");
    process.exit(1);
  }

  const mode = values.mode === "thorough" ? "thorough" : "fast";
  const defaultDiscoverMaxSteps =
    mode === "thorough" ? DEFAULT_DISCOVER_MAX_STEPS_THOROUGH : DEFAULT_DISCOVER_MAX_STEPS_FAST;
  const defaultDiscoverMaxRounds =
    mode === "thorough" ? DEFAULT_DISCOVER_MAX_ROUNDS_THOROUGH : DEFAULT_DISCOVER_MAX_ROUNDS_FAST;
  const defaultDiscoverMaxFetches =
    mode === "thorough" ? DEFAULT_DISCOVER_MAX_FETCHES_THOROUGH : DEFAULT_DISCOVER_MAX_FETCHES_FAST;
  const defaultDiscoverLinkDepth =
    mode === "thorough" ? DEFAULT_DISCOVER_LINK_DEPTH_THOROUGH : DEFAULT_DISCOVER_LINK_DEPTH_FAST;
  const defaultDiscoverTimeoutBaseMs = mode === "thorough"
    ? DEFAULT_DISCOVER_TIMEOUT_BASE_MS_THOROUGH
    : DEFAULT_DISCOVER_TIMEOUT_BASE_MS_FAST;
  const defaultDiscoverTimeoutMaxMs = mode === "thorough"
    ? DEFAULT_DISCOVER_TIMEOUT_MAX_MS_THOROUGH
    : DEFAULT_DISCOVER_TIMEOUT_MAX_MS_FAST;
  const defaultDiscoverFetchCap = mode === "thorough"
    ? DEFAULT_DISCOVER_FETCH_CAP_THOROUGH
    : DEFAULT_DISCOVER_FETCH_CAP_FAST;
  const selectionMode = values["selection-mode"] === "deterministic"
    ? "deterministic"
    : values["selection-mode"] === "llm-first"
      ? "llm-first"
      : "hybrid";
  const cleanupMode = values["cleanup-mode"] === "deterministic" ? "deterministic" : "hybrid";
  const htmlExtractorMode = values["html-extractor-mode"] === "deterministic"
    ? "deterministic"
    : DEFAULT_HTML_EXTRACTOR_MODE;
  const defaultSelectionMaxModelMs = mode === "thorough" ? 25_000 : 12_000;
  const defaultCleanupMaxModelMs =
    mode === "thorough" ? DEFAULT_CLEANUP_MAX_MODEL_MS_THOROUGH : DEFAULT_CLEANUP_MAX_MODEL_MS_FAST;
  const defaultCleanupMaxChunks =
    mode === "thorough" ? DEFAULT_CLEANUP_MAX_CHUNKS_THOROUGH : DEFAULT_CLEANUP_MAX_CHUNKS_FAST;
  const htmlCleanupFailurePolicy = values["html-cleanup-failure-policy"] === "fail-run"
    ? "fail-run"
    : values["html-cleanup-failure-policy"] === "raw-fallback"
      ? "raw-fallback"
      : "skip-source";
  const convertEngine = values["convert-engine"] === "template" ? "template" : "llm-template";
  const selectionTopK = values["selection-top-k"]
    ? Number.parseInt(values["selection-top-k"], 10)
    : DEFAULT_SELECTION_TOP_K;
  const selectionMaxModelMs = values["selection-max-model-ms"]
    ? Number.parseInt(values["selection-max-model-ms"], 10)
    : defaultSelectionMaxModelMs;
  const selectionConfidenceThreshold = values["selection-confidence-threshold"]
    ? Number.parseFloat(values["selection-confidence-threshold"])
    : DEFAULT_SELECTION_CONFIDENCE_THRESHOLD;
  const selectionEvidenceBytes = values["selection-evidence-bytes"]
    ? Number.parseInt(values["selection-evidence-bytes"], 10)
    : DEFAULT_SELECTION_EVIDENCE_BYTES;
  const discoverMaxSteps = values["discover-max-steps"]
    ? Number.parseInt(values["discover-max-steps"], 10)
    : defaultDiscoverMaxSteps;
  const discoverMaxRounds = values["discover-max-rounds"]
    ? Number.parseInt(values["discover-max-rounds"], 10)
    : defaultDiscoverMaxRounds;
  const discoverMaxCandidates = values["discover-max-candidates"]
    ? Number.parseInt(values["discover-max-candidates"], 10)
    : DEFAULT_DISCOVER_MAX_CANDIDATES;
  const discoverMaxFetches = values["discover-max-fetches"]
    ? Number.parseInt(values["discover-max-fetches"], 10)
    : defaultDiscoverMaxFetches;
  const discoverLinkDepth = values["discover-link-depth"]
    ? Number.parseInt(values["discover-link-depth"], 10)
    : defaultDiscoverLinkDepth;
  const discoverAllowHosts = values["discover-allow-hosts"]
    ? values["discover-allow-hosts"]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;
  const discoverStopMode = values["discover-stop-mode"] === "coverage"
    ? "coverage"
    : DEFAULT_DISCOVER_STOP_MODE;
  const discoverQualityThresholdSchedule = values["discover-quality-threshold-schedule"]
    ? Number.parseFloat(values["discover-quality-threshold-schedule"])
    : DEFAULT_DISCOVER_QUALITY_THRESHOLD_SCHEDULE;
  const discoverQualityThresholdSeparation = values["discover-quality-threshold-separation"]
    ? Number.parseFloat(values["discover-quality-threshold-separation"])
    : DEFAULT_DISCOVER_QUALITY_THRESHOLD_SEPARATION;
  const discoverRequireMachineReadableSchedule =
    values["discover-require-machine-readable-schedule"] ??
    DEFAULT_DISCOVER_REQUIRE_MACHINE_READABLE_SCHEDULE;
  const discoverScoringMode = values["discover-scoring-mode"] === "evidence-v1"
    ? "evidence-v1"
    : DEFAULT_DISCOVER_SCORING_MODE;
  const discoverMinCoverageSchedule = values["discover-min-coverage-schedule"]
    ? Number.parseFloat(values["discover-min-coverage-schedule"])
    : DEFAULT_DISCOVER_MIN_COVERAGE_SCHEDULE;
  const discoverMinCoverageSeparation = values["discover-min-coverage-separation"]
    ? Number.parseFloat(values["discover-min-coverage-separation"])
    : DEFAULT_DISCOVER_MIN_COVERAGE_SEPARATION;
  const discoverMaxNoiseRatio = values["discover-max-noise-ratio"]
    ? Number.parseFloat(values["discover-max-noise-ratio"])
    : DEFAULT_DISCOVER_MAX_NOISE_RATIO;
  const discoverMinCleanupPassRate = values["discover-min-cleanup-pass-rate"]
    ? Number.parseFloat(values["discover-min-cleanup-pass-rate"])
    : DEFAULT_DISCOVER_MIN_CLEANUP_PASS_RATE;
  const discoverFreshnessHalfLifeDays = values["discover-freshness-half-life-days"]
    ? Number.parseInt(values["discover-freshness-half-life-days"], 10)
    : DEFAULT_DISCOVER_FRESHNESS_HALF_LIFE_DAYS;
  const discoverTimeoutBaseMs = values["discover-timeout-base-ms"]
    ? Number.parseInt(values["discover-timeout-base-ms"], 10)
    : defaultDiscoverTimeoutBaseMs;
  const discoverTimeoutStepMs = values["discover-timeout-step-ms"]
    ? Number.parseInt(values["discover-timeout-step-ms"], 10)
    : DEFAULT_DISCOVER_TIMEOUT_STEP_MS;
  const discoverTimeoutMaxMs = values["discover-timeout-max-ms"]
    ? Number.parseInt(values["discover-timeout-max-ms"], 10)
    : defaultDiscoverTimeoutMaxMs;
  const discoverTimeoutSoftFail = values["discover-timeout-soft-fail"] ??
    DEFAULT_DISCOVER_TIMEOUT_SOFT_FAIL;
  const discoverSearchCap = values["discover-search-cap"]
    ? Number.parseInt(values["discover-search-cap"], 10)
    : DEFAULT_DISCOVER_SEARCH_CAP;
  const discoverFetchCap = values["discover-fetch-cap"]
    ? Number.parseInt(values["discover-fetch-cap"], 10)
    : defaultDiscoverFetchCap;
  const discoverSeedQueryCount = values["discover-seed-query-count"]
    ? Number.parseInt(values["discover-seed-query-count"], 10)
    : DEFAULT_DISCOVER_SEED_QUERY_COUNT;
  const discoverRequireOfficialDomain = values["discover-require-official-domain"] ??
    DEFAULT_DISCOVER_REQUIRE_OFFICIAL_DOMAIN;
  const discoverNoOfficialDomainStrategy = values["discover-no-official-domain-strategy"] === "emergency-burst"
    ? "emergency-burst"
    : DEFAULT_DISCOVER_NO_OFFICIAL_DOMAIN_STRATEGY;
  const discoverMaxQueryDupRatio = values["discover-max-query-dup-ratio"]
    ? Number.parseFloat(values["discover-max-query-dup-ratio"])
    : DEFAULT_DISCOVER_MAX_QUERY_DUP_RATIO;
  const discoverMaxHostSwitches = values["discover-max-host-switches"]
    ? Number.parseInt(values["discover-max-host-switches"], 10)
    : DEFAULT_DISCOVER_MAX_HOST_SWITCHES;
  const cleanupMaxModelMs = values["cleanup-max-model-ms"]
    ? Number.parseInt(values["cleanup-max-model-ms"], 10)
    : defaultCleanupMaxModelMs;
  const cleanupChunkBytes = values["cleanup-chunk-bytes"]
    ? Number.parseInt(values["cleanup-chunk-bytes"], 10)
    : DEFAULT_CLEANUP_CHUNK_BYTES;
  const cleanupMaxChunks = values["cleanup-max-chunks"]
    ? Number.parseInt(values["cleanup-max-chunks"], 10)
    : defaultCleanupMaxChunks;
  const cleanupMinPassRate = values["cleanup-min-pass-rate"]
    ? Number.parseFloat(values["cleanup-min-pass-rate"])
    : DEFAULT_CLEANUP_MIN_PASS_RATE;
  const cleanupMaxNoiseRatio = values["cleanup-max-noise-ratio"]
    ? Number.parseFloat(values["cleanup-max-noise-ratio"])
    : DEFAULT_CLEANUP_MAX_NOISE_RATIO;
  const htmlMaxFollowLinks = values["html-max-follow-links"]
    ? Number.parseInt(values["html-max-follow-links"], 10)
    : DEFAULT_HTML_MAX_FOLLOW_LINKS;
  const htmlMinBlockScore = values["html-min-block-score"]
    ? Number.parseFloat(values["html-min-block-score"])
    : DEFAULT_HTML_MIN_BLOCK_SCORE;
  const htmlLinkTypes = values["html-link-types"]
    ? values["html-link-types"]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : DEFAULT_HTML_LINK_TYPES;
  const htmlCleanupTimeoutMs = values["html-cleanup-timeout-ms"]
    ? Number.parseInt(values["html-cleanup-timeout-ms"], 10)
    : DEFAULT_HTML_CLEANUP_TIMEOUT_MS;
  const maxHtmlCleanupCalls = values["max-html-cleanup-calls"]
    ? Number.parseInt(values["max-html-cleanup-calls"], 10)
    : DEFAULT_MAX_HTML_CLEANUP_CALLS;
  const driftThreshold = values["drift-threshold"]
    ? Number.parseFloat(values["drift-threshold"])
    : DEFAULT_DRIFT_THRESHOLD;
  if (!Number.isFinite(selectionTopK) || selectionTopK < 1) {
    console.error("--selection-top-k must be an integer >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(selectionMaxModelMs) || selectionMaxModelMs < 1) {
    console.error("--selection-max-model-ms must be a positive integer");
    process.exit(1);
  }
  if (
    !Number.isFinite(selectionConfidenceThreshold) ||
    selectionConfidenceThreshold < 0 ||
    selectionConfidenceThreshold > 1
  ) {
    console.error("--selection-confidence-threshold must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(selectionEvidenceBytes) || selectionEvidenceBytes < 512) {
    console.error("--selection-evidence-bytes must be >= 512");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxSteps) || discoverMaxSteps < 1) {
    console.error("--discover-max-steps must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxRounds) || discoverMaxRounds < 1) {
    console.error("--discover-max-rounds must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxCandidates) || discoverMaxCandidates < 1) {
    console.error("--discover-max-candidates must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxFetches) || discoverMaxFetches < 1) {
    console.error("--discover-max-fetches must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverLinkDepth) || discoverLinkDepth < 0) {
    console.error("--discover-link-depth must be >= 0");
    process.exit(1);
  }
  if (
    !Number.isFinite(discoverQualityThresholdSchedule) ||
    discoverQualityThresholdSchedule < 0 ||
    discoverQualityThresholdSchedule > 1
  ) {
    console.error("--discover-quality-threshold-schedule must be between 0 and 1");
    process.exit(1);
  }
  if (
    !Number.isFinite(discoverQualityThresholdSeparation) ||
    discoverQualityThresholdSeparation < 0 ||
    discoverQualityThresholdSeparation > 1
  ) {
    console.error("--discover-quality-threshold-separation must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMinCoverageSchedule) || discoverMinCoverageSchedule < 0 || discoverMinCoverageSchedule > 1) {
    console.error("--discover-min-coverage-schedule must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMinCoverageSeparation) || discoverMinCoverageSeparation < 0 || discoverMinCoverageSeparation > 1) {
    console.error("--discover-min-coverage-separation must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxNoiseRatio) || discoverMaxNoiseRatio < 0 || discoverMaxNoiseRatio > 1) {
    console.error("--discover-max-noise-ratio must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMinCleanupPassRate) || discoverMinCleanupPassRate < 0 || discoverMinCleanupPassRate > 1) {
    console.error("--discover-min-cleanup-pass-rate must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverFreshnessHalfLifeDays) || discoverFreshnessHalfLifeDays < 1) {
    console.error("--discover-freshness-half-life-days must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverTimeoutBaseMs) || discoverTimeoutBaseMs < 1_000) {
    console.error("--discover-timeout-base-ms must be >= 1000");
    process.exit(1);
  }
  if (!Number.isFinite(discoverTimeoutStepMs) || discoverTimeoutStepMs < 0) {
    console.error("--discover-timeout-step-ms must be >= 0");
    process.exit(1);
  }
  if (!Number.isFinite(discoverTimeoutMaxMs) || discoverTimeoutMaxMs < 1_000) {
    console.error("--discover-timeout-max-ms must be >= 1000");
    process.exit(1);
  }
  if (discoverTimeoutMaxMs < discoverTimeoutBaseMs) {
    console.error("--discover-timeout-max-ms must be >= --discover-timeout-base-ms");
    process.exit(1);
  }
  if (!Number.isFinite(discoverSearchCap) || discoverSearchCap < 1) {
    console.error("--discover-search-cap must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverFetchCap) || discoverFetchCap < 1) {
    console.error("--discover-fetch-cap must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverSeedQueryCount) || discoverSeedQueryCount < 1) {
    console.error("--discover-seed-query-count must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxQueryDupRatio) || discoverMaxQueryDupRatio < 0 || discoverMaxQueryDupRatio > 1) {
    console.error("--discover-max-query-dup-ratio must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(discoverMaxHostSwitches) || discoverMaxHostSwitches < 1) {
    console.error("--discover-max-host-switches must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(cleanupMaxModelMs) || cleanupMaxModelMs < 1_000) {
    console.error("--cleanup-max-model-ms must be >= 1000");
    process.exit(1);
  }
  if (!Number.isFinite(cleanupChunkBytes) || cleanupChunkBytes < 512) {
    console.error("--cleanup-chunk-bytes must be >= 512");
    process.exit(1);
  }
  if (!Number.isFinite(cleanupMaxChunks) || cleanupMaxChunks < 1) {
    console.error("--cleanup-max-chunks must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(cleanupMinPassRate) || cleanupMinPassRate < 0 || cleanupMinPassRate > 1) {
    console.error("--cleanup-min-pass-rate must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(cleanupMaxNoiseRatio) || cleanupMaxNoiseRatio < 0 || cleanupMaxNoiseRatio > 1) {
    console.error("--cleanup-max-noise-ratio must be between 0 and 1");
    process.exit(1);
  }
  if (!Number.isFinite(htmlMaxFollowLinks) || htmlMaxFollowLinks < 0) {
    console.error("--html-max-follow-links must be >= 0");
    process.exit(1);
  }
  if (!Number.isFinite(htmlMinBlockScore) || htmlMinBlockScore < 0) {
    console.error("--html-min-block-score must be >= 0");
    process.exit(1);
  }
  if (!Number.isFinite(htmlCleanupTimeoutMs) || htmlCleanupTimeoutMs < 1_000) {
    console.error("--html-cleanup-timeout-ms must be >= 1000");
    process.exit(1);
  }
  if (!Number.isFinite(maxHtmlCleanupCalls) || maxHtmlCleanupCalls < 1) {
    console.error("--max-html-cleanup-calls must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(driftThreshold) || driftThreshold < 0 || driftThreshold > 1) {
    console.error("--drift-threshold must be between 0 and 1");
    process.exit(1);
  }
  const skillsMode = values["skills-mode"] === "native"
    ? "native"
    : values["skills-mode"] === "local"
      ? "local"
      : "hybrid";

  const sourceTypes = values["source-types"]
    ? values["source-types"]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

  const normalizedSourceTypes = sourceTypes as SourceType[] | undefined;
  const allowedSourceTypes = new Set<SourceType>([
    "csv",
    "xlsx",
    "pdf",
    "image",
    "html",
    "api",
    "unknown",
  ]);
  if (normalizedSourceTypes) {
    for (const sourceType of normalizedSourceTypes) {
      if (!allowedSourceTypes.has(sourceType)) {
        console.error(
          `Invalid --source-types entry: ${sourceType}. Allowed: ${[...allowedSourceTypes].join(", ")}`
        );
        process.exit(1);
      }
    }
  }
  const normalizedHtmlLinkTypes = htmlLinkTypes as SourceType[];
  if (normalizedHtmlLinkTypes.length === 0) {
    console.error("--html-link-types must include at least one source type");
    process.exit(1);
  }
  for (const sourceType of normalizedHtmlLinkTypes) {
    if (!allowedSourceTypes.has(sourceType)) {
      console.error(
        `Invalid --html-link-types entry: ${sourceType}. Allowed: ${[...allowedSourceTypes].join(", ")}`
      );
      process.exit(1);
    }
  }

  const logFormat = values["log-format"] === "json" ? "json" : "pretty";
  const runId = values["run-id"] || createRunId(values.city, values.prefecture);

  const forceSteps = new Set<StepName>();
  const requestedForce = values["force-step"]
    ? Array.isArray(values["force-step"])
      ? values["force-step"]
      : [values["force-step"]]
    : [];

  for (const entry of requestedForce) {
    if (!orderedSteps.includes(entry)) {
      console.error(`Invalid --force-step value: ${entry}`);
      process.exit(1);
    }
    forceSteps.add(entry as OrderedStepName);
  }

  return {
    city: values.city,
    prefecture: values.prefecture,
    url: values.url,
    runId,
    workDir: values["work-dir"] || defaultWorkDir(runId),
    verbose: values.verbose ?? false,
    agentLogs: values["agent-logs"] ?? true,
    eventFile: values["event-file"],
    maxFixRetries: values["max-fix-retries"]
      ? Number.parseInt(values["max-fix-retries"], 10)
      : DEFAULT_MAX_FIX_RETRIES,
    skipTo,
    resume: values.resume ?? false,
    httpTimeoutMs: values["http-timeout-ms"]
      ? Number.parseInt(values["http-timeout-ms"], 10)
      : DEFAULT_HTTP_TIMEOUT_MS,
    maxDownloadBytes: values["max-download-bytes"]
      ? Number.parseInt(values["max-download-bytes"], 10)
      : DEFAULT_MAX_DOWNLOAD_BYTES,
    mode,
    stopAfter,
    maxTotalMs: values["max-total-ms"]
      ? Number.parseInt(values["max-total-ms"], 10)
      : DEFAULT_MAX_TOTAL_MS,
    maxStepMs: values["max-step-ms"]
      ? Number.parseInt(values["max-step-ms"], 10)
      : DEFAULT_MAX_STEP_MS,
    maxModelMs: values["max-model-ms"]
      ? Number.parseInt(values["max-model-ms"], 10)
      : DEFAULT_MAX_MODEL_MS,
    discoverMaxSteps,
    discoverMaxRounds,
    discoverMaxCandidates,
    discoverMaxFetches,
    discoverLinkDepth,
    discoverAllowHosts,
    discoverStopMode,
    discoverQualityPolicy: {
      scheduleThreshold: discoverQualityThresholdSchedule,
      separationThreshold: discoverQualityThresholdSeparation,
      requireMachineReadableSchedule: discoverRequireMachineReadableSchedule,
      scoringMode: discoverScoringMode,
      minCoverageSchedule: discoverMinCoverageSchedule,
      minCoverageSeparation: discoverMinCoverageSeparation,
      maxNoiseRatio: discoverMaxNoiseRatio,
      minCleanupPassRate: discoverMinCleanupPassRate,
      freshnessHalfLifeDays: discoverFreshnessHalfLifeDays,
    },
    discoverTimeoutPolicy: {
      baseMs: discoverTimeoutBaseMs,
      stepMs: discoverTimeoutStepMs,
      maxMs: discoverTimeoutMaxMs,
      softFail: discoverTimeoutSoftFail,
    },
    discoverToolBudgetPolicy: {
      searchCap: discoverSearchCap,
      fetchCap: discoverFetchCap,
      seedQueryCount: discoverSeedQueryCount,
      maxHostSwitches: discoverMaxHostSwitches,
      maxQueryDupRatio: discoverMaxQueryDupRatio,
    },
    discoverDomainLockPolicy: {
      requireOfficialDomain: discoverRequireOfficialDomain,
      noOfficialDomainStrategy: discoverNoOfficialDomainStrategy,
    },
    selectionMode,
    selectionTopK,
    selectionMaxModelMs,
    selectionConfidenceThreshold,
    selectionEvidenceBytes,
    cleanupMode,
    cleanupMaxModelMs,
    cleanupChunkBytes,
    cleanupMaxChunks,
    cleanupMinPassRate,
    cleanupMaxNoiseRatio,
    htmlExtractorMode,
    htmlFollowLinks: values["html-follow-links"] ?? true,
    htmlMaxFollowLinks,
    htmlLinkTypes: normalizedHtmlLinkTypes,
    htmlMinBlockScore,
    htmlCleanupTimeoutMs,
    htmlCleanupRequired: values["html-cleanup-required"] ?? true,
    htmlCleanupFailurePolicy,
    maxHtmlCleanupCalls,
    driftThreshold,
    maxConvertFixRetries: values["max-convert-fix-retries"]
      ? Number.parseInt(values["max-convert-fix-retries"], 10)
      : DEFAULT_MAX_CONVERT_FIX_RETRIES,
    allowLlmRecordFallback: values["allow-llm-record-fallback"] ?? false,
    convertEngine,
    plannerOnly: values["planner-only"] ?? false,
    executorOnly: values["executor-only"] ?? false,
    sourceTypes: normalizedSourceTypes,
    modelId: values.model,
    baseUrl: values["base-url"],
    enableSkills: values["enable-skills"] ?? false,
    skillsMode,
    strictSkillsCompat: values["strict-skills-compat"] ?? true,
    logFormat,
    forceSteps,
  };
}

function createRunId(city: string, prefecture: string): string {
  const now = new Date().toISOString().replace(/[.:]/g, "-");
  return `${toSlug(prefecture)}-${toSlug(city)}-${now}`;
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function main(): Promise<void> {
  const options = parseCliArgs();
  await runGenerateCityPipeline(options);
}

main().catch((error) => {
  if (error instanceof RunStateMismatchError) {
    console.error("Generation failed: run-state conflict in work directory.");
    console.error(`- state: ${error.statePath}`);
    console.error(
      `- existing runId: ${error.existing.runId} (${error.existing.prefecture} ${error.existing.city})`
    );
    console.error(
      `- requested runId: ${error.requested.runId} (${error.requested.prefecture} ${error.requested.city})`
    );
    console.error("\nHow to proceed:");
    console.error(
      `1) Reuse existing run-id:\n   --run-id "${error.existing.runId}"`
    );
    console.error("2) Use a new work-dir:\n   --work-dir /tmp/gomi-full-2");
    console.error(`3) Reset this work-dir state:\n   rm -f "${error.statePath}"`);
    process.exit(1);
  }
  console.error("Generation failed:", error);
  process.exit(1);
});
