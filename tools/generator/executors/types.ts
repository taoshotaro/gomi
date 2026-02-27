export interface RawRecord {
  fields: Record<string, string>;
  row?: string[];
}

export type ExtractedLinkType = "html" | "csv" | "xlsx" | "pdf" | "image" | "api" | "unknown";

export interface ExtractedLinkCandidate {
  url: string;
  text: string;
  type: ExtractedLinkType;
  score: number;
  reasons: string[];
}

export interface ExtractionDiagnostics {
  parser: string;
  tableCount: number;
  tableRowCount: number;
  textBlockCount: number;
  skippedNoiseBlocks: number;
  linkCandidateCount: number;
  followedSourceIds?: string[];
}

export interface ExecutorOutput {
  target: "schedule" | "separation";
  sourceType: string;
  sourcePath: string;
  preview: string;
  headers?: string[];
  records: RawRecord[];
  linkCandidates?: ExtractedLinkCandidate[];
  diagnostics?: ExtractionDiagnostics;
}
