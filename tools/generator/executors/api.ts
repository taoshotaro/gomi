import { readFileSync } from "fs";
import type { ExecutorOutput } from "./types.js";

export function runApiExecutor(sourcePath: string, target: "schedule" | "separation"): ExecutorOutput {
  const raw = readFileSync(sourcePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const normalized = Array.isArray(parsed) ? parsed : [parsed];
  const records = normalized.slice(0, 300).map((item) => {
    const fields: Record<string, string> = {};
    if (item && typeof item === "object") {
      for (const [k, v] of Object.entries(item)) {
        fields[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
    } else {
      fields.value = JSON.stringify(item);
    }
    return { fields };
  });

  return {
    target,
    sourceType: "api",
    sourcePath,
    preview: JSON.stringify(normalized.slice(0, 5), null, 2),
    records,
  };
}

