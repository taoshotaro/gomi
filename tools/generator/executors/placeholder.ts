import { statSync } from "fs";
import type { ExecutorOutput } from "./types.js";

export function runPlaceholderExecutor(
  sourcePath: string,
  target: "schedule" | "separation",
  sourceType: "xlsx" | "pdf" | "image"
): ExecutorOutput {
  const stats = statSync(sourcePath);
  return {
    target,
    sourceType,
    sourcePath,
    preview: `Binary source (${sourceType}) at ${sourcePath}, size=${stats.size}`,
    records: [],
  };
}

