import { readFileSync } from "fs";
import { parseCsv } from "../lib/csv.js";
import type { ExecutorOutput } from "./types.js";

export function runCsvExecutor(sourcePath: string, target: "schedule" | "separation"): ExecutorOutput {
  const raw = readFileSync(sourcePath, "utf-8");
  const parsed = parseCsv(raw);
  const records = parsed.rows.slice(0, 300).map((row) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < parsed.headers.length; i++) {
      const key = parsed.headers[i] || `col_${i + 1}`;
      fields[key] = row[i] ?? "";
    }
    return { fields, row };
  });

  return {
    target,
    sourceType: "csv",
    sourcePath,
    headers: parsed.headers,
    preview: JSON.stringify(
      {
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 10),
        rowCount: parsed.rows.length,
      },
      null,
      2
    ),
    records,
  };
}

