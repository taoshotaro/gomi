import type { ExtractionTask, SourceType } from "../pipeline/types.js";

export interface CapabilityEntry {
  primary: ExtractionTask["executorType"];
  fallback: ExtractionTask["executorType"][];
}

export const CAPABILITY_MATRIX: Record<SourceType, CapabilityEntry> = {
  csv: { primary: "csv", fallback: ["html"] },
  xlsx: { primary: "xlsx", fallback: ["csv"] },
  pdf: { primary: "pdf", fallback: ["image", "html"] },
  image: { primary: "image", fallback: ["html"] },
  html: { primary: "html", fallback: ["api"] },
  api: { primary: "api", fallback: ["html"] },
  unknown: { primary: "html", fallback: ["api"] },
};

