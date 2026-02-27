import { validateAllData } from "../lib/validation.js";
import { relative } from "path";
import { REPO_ROOT } from "../lib/paths.js";

function main(): void {
  const { issues, checkedFiles } = validateAllData();

  const issueByFile = new Map<string, string[]>();
  for (const issue of issues) {
    const existing = issueByFile.get(issue.file) ?? [];
    issueByFile.set(issue.file, [...existing, ...issue.messages]);
  }

  for (const file of checkedFiles) {
    const relPath = relative(REPO_ROOT, file);
    if (issueByFile.has(relPath)) {
      continue;
    }
    console.log(`OK   ${relPath}`);
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`FAIL ${issue.file}`);
      for (const message of issue.messages) {
        console.error(`  ${message}`);
      }
    }
    console.error("\nValidation failed.");
    process.exit(1);
  }

  console.log("OK   cities.json consistency check");
  console.log("\nAll validations passed.");
}

main();
