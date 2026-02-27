import { readFileSync } from "fs";
import { parseIssueBody } from "../lib/parse-issue.js";

function main(): void {
  const bodyFile = process.argv[2];
  if (!bodyFile) {
    console.error("Usage: bun run tools/generator/cli/parse-issue.ts <issue-body-file>");
    process.exit(1);
  }

  const body = readFileSync(bodyFile, "utf-8");
  const parsed = parseIssueBody(body);
  console.log(JSON.stringify(parsed));
}

main();
