/**
 * Parses a GitHub issue body (from the add-city template) and extracts fields.
 * Usage: bun run .github/scripts/parse-issue.ts <issue-body-file>
 * Output: JSON with { city, prefecture, source_url }
 */

import { readFileSync } from "fs";

interface ParsedIssue {
  city: string;
  prefecture: string;
  source_url: string | null;
}

function parseIssueBody(body: string): ParsedIssue {
  const lines = body.split("\n").map((l) => l.trim());

  let city = "";
  let prefecture = "";
  let sourceUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### 市区町村名") || line.startsWith("### City")) {
      // Next non-empty line is the value
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("###") && lines[j] !== "_No response_") {
          city = lines[j];
          break;
        }
      }
    }

    if (line.startsWith("### 都道府県") || line.startsWith("### Prefecture")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("###") && lines[j] !== "_No response_") {
          prefecture = lines[j];
          break;
        }
      }
    }

    if (line.startsWith("### 公式サイト") || line.startsWith("### Source URL")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("###") && lines[j] !== "_No response_") {
          sourceUrl = lines[j].startsWith("http") ? lines[j] : null;
          break;
        }
      }
    }
  }

  if (!city || !prefecture) {
    throw new Error(
      `Failed to parse issue body. city="${city}", prefecture="${prefecture}"`
    );
  }

  return { city, prefecture, source_url: sourceUrl };
}

// CLI mode
const bodyFile = process.argv[2];
if (!bodyFile) {
  console.error("Usage: bun run parse-issue.ts <issue-body-file>");
  process.exit(1);
}

const body = readFileSync(bodyFile, "utf-8");
const parsed = parseIssueBody(body);
console.log(JSON.stringify(parsed));

export { parseIssueBody, type ParsedIssue };
