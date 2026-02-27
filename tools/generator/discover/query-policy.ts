export interface QueryPolicyInput {
  queries: string[];
  seedCount: number;
}

export interface QueryPolicyResult {
  queries: string[];
  duplicateRatio: number;
}

export function applyQueryPolicy(input: QueryPolicyInput): QueryPolicyResult {
  const normalizedSeen = new Set<string>();
  const output: string[] = [];
  let duplicateCount = 0;

  for (const query of input.queries) {
    const normalized = normalizeQuery(query);
    if (!normalized) {
      continue;
    }
    if (normalizedSeen.has(normalized)) {
      duplicateCount += 1;
      continue;
    }
    normalizedSeen.add(normalized);
    output.push(query.trim());
    if (output.length >= input.seedCount) {
      break;
    }
  }

  const total = Math.max(1, output.length + duplicateCount);
  return {
    queries: output,
    duplicateRatio: duplicateCount / total,
  };
}

export function normalizeQuery(query: string): string {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}
