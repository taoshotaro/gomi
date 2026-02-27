import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { PROMPTS_DIR } from "./paths.js";
import { emitAgentEvent } from "../pipeline/events.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJsonFile<T>(path: string): T {
  emitAgentEvent({
    level: "debug",
    eventType: "file.read",
    message: "Reading JSON file",
    path,
  });
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  emitAgentEvent({
    level: "debug",
    eventType: "file.write",
    message: "Writing JSON file atomically",
    path,
    bytes: JSON.stringify(value).length,
  });
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  emitAgentEvent({
    level: "debug",
    eventType: "file.write",
    message: "Writing text file atomically",
    path,
    bytes: content.length,
  });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

export function writeNdjsonAtomic(path: string, rows: unknown[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  writeTextAtomic(path, content.length > 0 ? `${content}\n` : "");
}

export function readNdjsonFile<T>(path: string): T[] {
  emitAgentEvent({
    level: "debug",
    eventType: "file.read",
    message: "Reading NDJSON file",
    path,
  });
  const text = readFileSync(path, "utf-8");
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

export function loadPrompt(name: string): string {
  const path = join(PROMPTS_DIR, `${name}.md`);
  emitAgentEvent({
    level: "debug",
    eventType: "file.read",
    message: "Loading prompt file",
    path,
  });
  return readFileSync(path, "utf-8");
}

export function extractJsonFromText(text: string): unknown {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  if (fenced.length > 0) {
    return JSON.parse(fenced[0]);
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(match[0]);
}
