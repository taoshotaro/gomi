import type { CandidateEnrichment } from "./curation.js";

export interface DomainLockResult {
  locked: boolean;
  lockedHosts: string[];
  hostSwitches: number;
}

export function computeDomainLock(
  candidates: CandidateEnrichment[],
  officialDomains: string[],
  maxHostSwitches: number
): DomainLockResult {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const host = safeHost(candidate.url);
    if (!host) {
      continue;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .map(([host, count]) => ({ host, score: trustScore(host, officialDomains) * 10 + count }))
    .sort((a, b) => b.score - a.score);

  const lockedHosts = ranked
    .filter((entry) => trustScore(entry.host, officialDomains) >= 0.7)
    .slice(0, Math.max(1, maxHostSwitches))
    .map((entry) => entry.host);

  const uniqueHosts = new Set(candidates.map((candidate) => safeHost(candidate.url)).filter(Boolean));
  const hostSwitches = Math.max(0, uniqueHosts.size - 1);

  return {
    locked: lockedHosts.length > 0,
    lockedHosts,
    hostSwitches,
  };
}

function trustScore(host: string, officialDomains: string[]): number {
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

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
