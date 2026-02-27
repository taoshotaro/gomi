export interface ParsedIssue {
  city: string;
  prefecture: string;
  source_url: string | null;
}

export function parseIssueBody(body: string): ParsedIssue {
  const lines = body.split("\n").map((line) => line.trim());

  let city = "";
  let prefecture = "";
  let sourceUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### 市区町村名") || line.startsWith("### City")) {
      city = readNextValue(lines, i);
    }
    if (line.startsWith("### 都道府県") || line.startsWith("### Prefecture")) {
      prefecture = readNextValue(lines, i);
    }
    if (line.startsWith("### 公式サイト") || line.startsWith("### Source URL")) {
      const value = readNextValue(lines, i);
      sourceUrl = value.startsWith("http") ? value : null;
    }
  }

  if (!city || !prefecture) {
    throw new Error(
      `Failed to parse issue body. city="${city}", prefecture="${prefecture}"`
    );
  }

  return { city, prefecture, source_url: sourceUrl };
}

function readNextValue(lines: string[], start: number): string {
  for (let i = start + 1; i < lines.length; i++) {
    const value = lines[i];
    if (value.length === 0 || value === "_No response_" || value.startsWith("###")) {
      continue;
    }
    return value;
  }
  return "";
}
