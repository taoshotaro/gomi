import { join } from "path";
import { runDiscoverEngine } from "../discover/engine.js";
import { writeJsonAtomic, writeNdjsonAtomic } from "../lib/json.js";
import type { PipelineContext } from "../pipeline/context.js";

export async function runDiscoverStep(
  context: PipelineContext,
  signal: AbortSignal
): Promise<void> {
  const { logger, options, stateStore } = context;

  logger.info("Discovering data sources", { step: "discover" });
  logger.info("Reasoning: running bounded multi-round source discovery", {
    step: "discover",
    eventType: "reasoning",
  });

  stateStore.setStepMessage("discover", "Running discover rounds");
  const result = await runDiscoverEngine(context, signal);

  for (const artifact of result.httpArtifacts) {
    stateStore.addHttpArtifact(artifact);
  }

  stateStore.setSources(result.discover);
  stateStore.setStepMessage("discover", "Persisted discover output v2");

  const reportPath = join(options.workDir, "discover-report.json");
  const candidatesPath = join(options.workDir, "discover-candidates.ndjson");
  const selectedPath = join(options.workDir, "discover-selected.json");

  writeJsonAtomic(reportPath, {
    runId: options.runId,
    city: options.city,
    prefecture: options.prefecture,
    createdAt: new Date().toISOString(),
    rounds: result.rounds,
    stopReason: result.rounds.at(-1)?.decisionReason ?? "unknown",
    stopDiagnostic: mapStopDiagnostic(result.rounds.at(-1)?.decisionReason),
    selected: result.discover.selected,
    selectedPrimary: {
      schedule: result.discover.selected.schedule[0] ?? null,
      separation: result.discover.selected.separation[0] ?? null,
    },
    rejected: result.rejected.map((entry) => ({
      id: entry.id,
      url: entry.url,
      rejectReason: entry.rejectReason,
      score: entry.score,
    })),
    output: result.discover,
  });
  writeNdjsonAtomic(candidatesPath, result.discover.candidates);
  writeJsonAtomic(selectedPath, result.discover.selected);

  stateStore.state.discoverReportPath = reportPath;
  stateStore.persist();

  for (const round of result.rounds) {
    logger.info("Discover round completed", {
      step: "discover",
      eventType: "discover.round",
      round: round.round,
      timeoutMs: round.timeoutMs,
      timedOut: round.timedOut,
      candidates: round.candidateCount,
      accepted: round.acceptedCount,
      rejected: round.rejectedCount,
      coverage: round.coverage,
      missingTargets: round.missingTargets,
      qualityReady: round.qualityReady,
      decisionReason: round.decisionReason,
      stopGateFailures: round.stopGateFailures,
      searchUsed: round.searchUsed,
      fetchUsed: round.fetchUsed,
      domainLocked: round.domainLocked,
      lockedHosts: round.lockedHosts,
      queryDupRatio: round.queryDupRatio,
      hostSwitches: round.hostSwitches,
      budgetExitReason: round.budgetExitReason,
    });
    logger.info("Discover quality snapshot", {
      step: "discover",
      eventType: "discover.quality",
      round: round.round,
      coverage: round.coverage,
      missingTargets: round.missingTargets,
      qualityReady: round.qualityReady,
      decisionReason: round.decisionReason,
      schedulePrimaryScore: round.schedulePrimaryScore,
      separationPrimaryScore: round.separationPrimaryScore,
      schedulePrimaryType: round.schedulePrimaryType,
      separationPrimaryType: round.separationPrimaryType,
      stopGateFailures: round.stopGateFailures,
      scheduleTopEvidence: round.scheduleTopEvidence,
      separationTopEvidence: round.separationTopEvidence,
      searchUsed: round.searchUsed,
      fetchUsed: round.fetchUsed,
      domainLocked: round.domainLocked,
      lockedHosts: round.lockedHosts,
      queryDupRatio: round.queryDupRatio,
      hostSwitches: round.hostSwitches,
      budgetExitReason: round.budgetExitReason,
    });
    logger.info("Discover score snapshot", {
      step: "discover",
      eventType: "discover.score",
      round: round.round,
      schedulePrimaryScore: round.schedulePrimaryScore,
      separationPrimaryScore: round.separationPrimaryScore,
      schedulePrimaryType: round.schedulePrimaryType,
      separationPrimaryType: round.separationPrimaryType,
    });
    logger.info("Discover gate snapshot", {
      step: "discover",
      eventType: "discover.gate",
      round: round.round,
      stopGateFailures: round.stopGateFailures,
    });
  }

  for (const candidate of result.discover.candidates.slice(0, 12)) {
    logger.info("Discover candidate curated", {
      step: "discover",
      eventType: "discover.candidate",
      sourceId: candidate.id,
      sourceType: candidate.type,
      targetHints: candidate.targetHints,
      score: candidate.score,
      url: candidate.url,
      rejected: candidate.rejected,
      rejectReason: candidate.rejectReason,
    });
  }

  logger.info("Discover finalized", {
    step: "discover",
    eventType: "discover.finalize",
    stopReason: result.rounds.at(-1)?.decisionReason ?? "unknown",
    machineReadableSchedule: ["csv", "xlsx", "api"].includes(
      result.discover.candidates.find(
        (entry) => entry.id === result.discover.selected.schedule[0]
      )?.type ?? "unknown"
    ),
    scheduleSelected: result.discover.selected.schedule.length,
    separationSelected: result.discover.selected.separation.length,
    candidateCount: result.discover.candidates.length,
    reportPath,
  });

}

function mapStopDiagnostic(reason: string | undefined): string {
  if (!reason) {
    return "unknown";
  }
  if (reason.includes("timeout")) {
    return "timeout-before-structured-output";
  }
  if (reason.includes("not-machine-readable")) {
    return "machine-readable-schedule-unmet";
  }
  if (reason.includes("no-official-domain")) {
    return "no-official-domain";
  }
  return reason;
}
