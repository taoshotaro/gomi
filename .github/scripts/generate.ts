/**
 * Generates garbage collection data for a city using a multi-step pipeline.
 *
 * Pipeline:
 *   1. DISCOVER  — LLM + web_search/fetch_page tools → find CSV/data URLs and separation page
 *   2. DOWNLOAD  — fetch() CSV/HTML to /tmp/gomi-raw/
 *   3. SCHEDULE  — CSV: LLM writes converter → run it; fallback: LLM extraction
 *   4. SEPARATE  — LLM reads cleaned source text → separation.json
 *   5. VALIDATE  — schema validation, write files, update cities.json
 *
 * Provider config (env vars):
 *   ANTHROPIC_BASE_URL  — API base URL (default: https://api.anthropic.com)
 *   MODEL               — Model name (default: claude-sonnet-4-20250514)
 *   ANTHROPIC_API_KEY    — API key (required)
 *
 * Usage: bun run .github/scripts/generate.ts --city <name_ja> --prefecture <prefecture_ja> [--url <source_url>]
 *
 * City and prefecture IDs are auto-detected by the LLM in the discover step.
 */

import Anthropic from "@anthropic-ai/sdk";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { execSync } from "child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const TMP_DIR = "/tmp/gomi-raw";
const PROMPTS_DIR = join(ROOT, ".github/scripts/prompts");
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";

// ─── CLI ────────────────────────────────────────────────────────────────────

const MAX_FIX_RETRIES_DEFAULT = 3;

interface GenerateArgs {
  city: string;
  prefecture: string;
  url?: string;
  maxFixRetries: number;
}

function parseCliArgs(): GenerateArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      city: { type: "string" },
      prefecture: { type: "string" },
      url: { type: "string" },
      "max-fix-retries": { type: "string" },
    },
  });

  if (!values.city || !values.prefecture) {
    console.error(
      "Usage: bun run generate.ts --city <name_ja> --prefecture <prefecture_ja> [--url <url>] [--max-fix-retries <n>]"
    );
    process.exit(1);
  }

  return {
    city: values.city,
    prefecture: values.prefecture,
    url: values.url,
    maxFixRetries: values["max-fix-retries"]
      ? parseInt(values["max-fix-retries"], 10)
      : MAX_FIX_RETRIES_DEFAULT,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf-8");
}

function extractJson(text: string): unknown {
  // Try fenced JSON blocks first
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) =>
    m[1].trim()
  );
  if (fenced.length > 0) {
    return JSON.parse(fenced[0]);
  }
  // Try raw JSON (find first { ... } block)
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]);
  }
  throw new Error("No JSON found in response");
}

function extractCode(text: string): string {
  const fenced = [
    ...text.matchAll(/```(?:typescript|ts)?\s*\n([\s\S]*?)```/g),
  ].map((m) => m[1].trim());
  if (fenced.length > 0) {
    return fenced[0];
  }
  return text.trim();
}

function getTextFromResponse(
  response: Anthropic.Messages.Message
): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Strip HTML to plain text, preserving table/list structure */
function stripHtmlToText(html: string): string {
  return (
    html
      .replace(/<\/th>/gi, " | ")
      .replace(/<\/td>/gi, " | ")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<h[1-6][^>]*>/gi, "\n## ")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Read first N lines of a CSV for sampling */
function readCsvSample(path: string, maxRows: number): string {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  return lines.slice(0, maxRows + 1).join("\n"); // +1 for header
}

/** Decode content, handling Shift_JIS which is common for Japanese municipal sites */
function decodeContent(buffer: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return utf8.decode(buffer);
  } catch {
    try {
      const sjis = new TextDecoder("shift_jis", { fatal: false });
      return sjis.decode(buffer);
    } catch {
      const lossy = new TextDecoder("utf-8", { fatal: false });
      return lossy.decode(buffer);
    }
  }
}

// ─── Custom tool definitions & execution ────────────────────────────────────

const CUSTOM_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for information. Returns a list of search results with titles, URLs, and snippets.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetch a web page and return its text content. Useful for reading official municipal pages, downloading CSV data, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        max_length: {
          type: "number",
          description:
            "Maximum characters to return (default: 50000). Use smaller values for large pages.",
        },
      },
      required: ["url"],
    },
  },
];

async function executeWebSearch(
  query: string
): Promise<string> {
  // Use DuckDuckGo HTML search (no API key needed)
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html = await res.text();

    // Parse DuckDuckGo HTML results
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultMatches = html.matchAll(
      /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    );

    for (const m of resultMatches) {
      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
      let resultUrl = m[1];
      const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        resultUrl = decodeURIComponent(uddgMatch[1]);
      }
      results.push({
        title: m[2].replace(/<[^>]+>/g, "").trim(),
        url: resultUrl,
        snippet: m[3].replace(/<[^>]+>/g, "").trim(),
      });
      if (results.length >= 10) break;
    }

    if (results.length === 0) {
      return `No results found for "${query}"`;
    }

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  } catch (err) {
    return `Search failed: ${err}`;
  }
}

async function executeFetchPage(
  url: string,
  maxLength: number = 50000
): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; gomi-data-collector/1.0)",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return `HTTP ${res.status}: ${res.statusText}`;
    }

    const buffer = await res.arrayBuffer();
    const content = decodeContent(new Uint8Array(buffer));

    // If it looks like CSV/JSON, return raw
    const contentType = res.headers.get("content-type") || "";
    if (
      contentType.includes("csv") ||
      contentType.includes("json") ||
      url.endsWith(".csv") ||
      url.endsWith(".json")
    ) {
      return content.slice(0, maxLength);
    }

    // Otherwise strip HTML
    const text = stripHtmlToText(content);
    return text.slice(0, maxLength);
  } catch (err) {
    return `Fetch failed: ${err}`;
  }
}

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  switch (toolName) {
    case "web_search":
      return executeWebSearch(toolInput.query as string);
    case "fetch_page":
      return executeFetchPage(
        toolInput.url as string,
        (toolInput.max_length as number) || 50000
      );
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── LLM call with tool-use loop ────────────────────────────────────────────

async function callLlm(
  client: Anthropic,
  prompt: string,
  options: {
    tools?: boolean;
    maxToolRounds?: number;
    thinkingBudget?: number;
    maxTokens?: number;
  } = {}
): Promise<string> {
  const {
    tools = false,
    maxToolRounds = 15,
    thinkingBudget = 8000,
    maxTokens = 16000,
  } = options;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  for (let round = 0; round <= maxToolRounds; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: {
        type: "enabled",
        budget_tokens: thinkingBudget,
      },
      messages,
      ...(tools ? { tools: CUSTOM_TOOLS } : {}),
    });

    // If no tool use, return the text
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      return getTextFromResponse(response);
    }

    // Add assistant response to messages
    messages.push({ role: "assistant", content: response.content });

    // Execute tools and add results
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      console.log(`    [tool] ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}`);
      const result = await handleToolCall(
        toolUse.name,
        toolUse.input as Record<string, unknown>
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Exhausted rounds — return whatever text we have
  console.warn("  Warning: max tool rounds reached");
  return getTextFromResponse(
    await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: "enabled", budget_tokens: thinkingBudget },
      messages,
    })
  );
}

// ─── Step 1: DISCOVER ───────────────────────────────────────────────────────

interface DiscoverResult {
  csvUrl: string | null;
  scheduleUrls: string[];
  separationUrls: string[];
  officialUrl: string;
  cityId: string;
  prefectureId: string;
}

async function discover(
  client: Anthropic,
  args: GenerateArgs
): Promise<DiscoverResult> {
  console.log("Step 1: Discovering data sources...");

  let prompt = loadPrompt("discover");
  prompt = prompt
    .replace(/\{\{CITY_NAME_JA\}\}/g, args.city)
    .replace(/\{\{PREFECTURE_JA\}\}/g, args.prefecture)
    .replace(
      /\{\{#if SOURCE_URL\}\}([\s\S]*?)\{\{\/if\}\}/g,
      args.url ? `Start with this official URL: ${args.url}` : ""
    );

  const text = await callLlm(client, prompt, {
    tools: true,
    maxToolRounds: 15,
  });

  const result = extractJson(text) as Record<string, unknown>;

  const cityId = result.city_id as string;
  const prefectureId = result.prefecture_id as string;

  if (!cityId || !prefectureId) {
    throw new Error("LLM did not return city_id or prefecture_id");
  }

  const discovered: DiscoverResult = {
    csvUrl: (result.csv_url as string) || null,
    scheduleUrls: (result.schedule_urls as string[]) || [],
    separationUrls: (result.separation_urls as string[]) || [],
    officialUrl: (result.official_url as string) || args.url || "",
    cityId,
    prefectureId,
  };

  console.log(`  City ID: ${discovered.prefectureId}/${discovered.cityId}`);
  console.log(`  CSV URL: ${discovered.csvUrl || "(none)"}`);
  console.log(`  Schedule pages: ${discovered.scheduleUrls.length}`);
  console.log(`  Separation pages: ${discovered.separationUrls.length}`);
  console.log(`  Official URL: ${discovered.officialUrl}`);

  return discovered;
}

// ─── Step 2: DOWNLOAD ───────────────────────────────────────────────────────

async function downloadAll(
  sources: DiscoverResult,
  tmpDir: string
): Promise<void> {
  console.log("Step 2: Downloading raw data...");
  mkdirSync(tmpDir, { recursive: true });

  const downloads: Array<{ url: string; filename: string }> = [];

  if (sources.csvUrl) {
    downloads.push({ url: sources.csvUrl, filename: "schedule.csv" });
  }

  sources.scheduleUrls.forEach((url, i) => {
    downloads.push({
      url,
      filename: i === 0 ? "schedule.html" : `schedule-${i + 1}.html`,
    });
  });

  sources.separationUrls.forEach((url, i) => {
    downloads.push({
      url,
      filename: i === 0 ? "separation.html" : `separation-${i + 1}.html`,
    });
  });

  for (const { url, filename } of downloads) {
    try {
      console.log(`  Downloading ${filename} from ${url}`);
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; gomi-data-collector/1.0)",
        },
        redirect: "follow",
      });
      if (!res.ok) {
        console.warn(
          `  Warning: ${filename} returned ${res.status}, skipping`
        );
        continue;
      }
      const buffer = await res.arrayBuffer();
      const content = decodeContent(new Uint8Array(buffer));
      writeFileSync(join(tmpDir, filename), content);
      console.log(
        `  Saved ${filename} (${Math.round(content.length / 1024)}KB)`
      );
    } catch (err) {
      console.warn(`  Warning: Failed to download ${filename}: ${err}`);
    }
  }
}

// ─── Step 3: SCHEDULE ───────────────────────────────────────────────────────

async function generateSchedule(
  client: Anthropic,
  sources: DiscoverResult,
  args: GenerateArgs,
  tmpDir: string,
  outDir: string
): Promise<void> {
  console.log("Step 3: Generating schedule data...");

  const scheduleSchemaStr = readFileSync(
    join(ROOT, "data/_schema/schedule.schema.json"),
    "utf-8"
  );

  const csvPath = join(tmpDir, "schedule.csv");

  if (existsSync(csvPath)) {
    console.log("  CSV found — generating converter script...");
    const csvSample = readCsvSample(csvPath, 20);

    let prompt = loadPrompt("convert-schedule");
    prompt = prompt
      .replace("{{SAMPLE_ROWS}}", "20")
      .replace("{{CSV_SAMPLE}}", csvSample)
      .replace("{{SCHEDULE_SCHEMA}}", scheduleSchemaStr)
      .replace(/\{\{PREFECTURE_ID\}\}/g, sources.prefectureId)
      .replace(/\{\{CITY_ID\}\}/g, sources.cityId)
      .replace(/\{\{CITY_NAME_JA\}\}/g, args.city)
      .replace("{{SOURCE_URL}}", sources.officialUrl);

    const code = extractCode(
      await callLlm(client, prompt, {
        maxTokens: 8000,
        thinkingBudget: 6000,
      })
    );

    const converterPath = "/tmp/convert-schedule.ts";
    writeFileSync(converterPath, code);
    console.log("  Running converter script...");

    try {
      execSync(
        `bun run "${converterPath}" "${csvPath}" "${join(outDir, "schedule.json")}"`,
        { stdio: "inherit", timeout: 30000 }
      );
      console.log("  Schedule generated from CSV.");
    } catch {
      console.warn(
        "  Converter script failed, falling back to LLM extraction..."
      );
      await extractScheduleFromSources(
        client,
        sources,
        args,
        tmpDir,
        outDir,
        scheduleSchemaStr
      );
    }
  } else {
    await extractScheduleFromSources(
      client,
      sources,
      args,
      tmpDir,
      outDir,
      scheduleSchemaStr
    );
  }
}

async function extractScheduleFromSources(
  client: Anthropic,
  sources: DiscoverResult,
  args: GenerateArgs,
  tmpDir: string,
  outDir: string,
  scheduleSchemaStr: string
): Promise<void> {
  console.log("  No CSV — extracting schedule from HTML/text...");

  const texts: string[] = [];
  const files = readdirSync(tmpDir).filter((f) => f.startsWith("schedule"));
  for (const file of files) {
    if (file.endsWith(".html")) {
      const html = readFileSync(join(tmpDir, file), "utf-8");
      texts.push(stripHtmlToText(html));
    }
  }

  if (texts.length === 0) {
    console.log(
      "  No schedule files downloaded — falling back to tool-assisted extraction..."
    );
    const searchPrompt = `Search for the complete garbage collection schedule for ${args.city} (${args.prefecture}).
Find ALL areas and their collection days. Use web_search to find the official page, then use fetch_page to read it.

city_id = "${sources.prefectureId}/${sources.cityId}"
city_name_ja = "${args.city}"

Target schema:
\`\`\`json
${scheduleSchemaStr}
\`\`\`

Output ONLY valid JSON matching the schema.`;

    const text = await callLlm(client, searchPrompt, {
      tools: true,
      maxToolRounds: 15,
      maxTokens: 16000,
      thinkingBudget: 10000,
    });

    const schedule = extractJson(text);
    writeFileSync(
      join(outDir, "schedule.json"),
      JSON.stringify(schedule, null, 2) + "\n"
    );
    return;
  }

  let cleanedText = texts.join("\n\n---\n\n");
  if (cleanedText.length > 100000) {
    cleanedText = cleanedText.slice(0, 100000) + "\n\n[... truncated]";
  }

  let prompt = loadPrompt("extract-schedule");
  prompt = prompt
    .replace("{{CLEANED_TEXT}}", cleanedText)
    .replace("{{SCHEDULE_SCHEMA}}", scheduleSchemaStr)
    .replace(/\{\{PREFECTURE_ID\}\}/g, sources.prefectureId)
    .replace(/\{\{CITY_ID\}\}/g, sources.cityId)
    .replace(/\{\{CITY_NAME_JA\}\}/g, args.city)
    .replace("{{SOURCE_URL}}", sources.officialUrl);

  const responseText = await callLlm(client, prompt, {
    maxTokens: 16000,
    thinkingBudget: 10000,
  });

  const schedule = extractJson(responseText);
  writeFileSync(
    join(outDir, "schedule.json"),
    JSON.stringify(schedule, null, 2) + "\n"
  );
  console.log("  Schedule extracted from text.");
}

// ─── Step 4: SEPARATION ─────────────────────────────────────────────────────

async function generateSeparation(
  client: Anthropic,
  sources: DiscoverResult,
  args: GenerateArgs,
  tmpDir: string,
  outDir: string
): Promise<void> {
  console.log("Step 4: Generating separation rules...");

  const separationSchemaStr = readFileSync(
    join(ROOT, "data/_schema/separation.schema.json"),
    "utf-8"
  );

  const texts: string[] = [];
  const files = readdirSync(tmpDir).filter((f) => f.startsWith("separation"));
  for (const file of files) {
    if (file.endsWith(".html")) {
      const html = readFileSync(join(tmpDir, file), "utf-8");
      texts.push(stripHtmlToText(html));
    }
  }

  if (texts.length === 0) {
    console.log(
      "  No separation files downloaded — using tool-assisted extraction..."
    );
    const searchPrompt = `Search for the garbage separation rules for ${args.city} (${args.prefecture}).
Find the official 分別ルール (separation rules) page using web_search, then fetch_page to read it.

city_id = "${sources.prefectureId}/${sources.cityId}"

Target schema:
\`\`\`json
${separationSchemaStr}
\`\`\`

Requirements:
- Include 3-5 keywords per item for search matching
- Include common search terms people would use
- category_id must match common schedule categories (burnable, non-burnable, recyclable, plastic-containers, oversized)
- Output ONLY valid JSON matching the schema.`;

    const text = await callLlm(client, searchPrompt, {
      tools: true,
      maxToolRounds: 15,
      maxTokens: 16000,
      thinkingBudget: 8000,
    });

    const separation = extractJson(text);
    writeFileSync(
      join(outDir, "separation.json"),
      JSON.stringify(separation, null, 2) + "\n"
    );
    return;
  }

  let cleanedText = texts.join("\n\n---\n\n");
  if (cleanedText.length > 100000) {
    cleanedText = cleanedText.slice(0, 100000) + "\n\n[... truncated]";
  }

  let prompt = loadPrompt("extract-separation");
  prompt = prompt
    .replace("{{CLEANED_TEXT}}", cleanedText)
    .replace("{{SEPARATION_SCHEMA}}", separationSchemaStr)
    .replace(/\{\{PREFECTURE_ID\}\}/g, sources.prefectureId)
    .replace(/\{\{CITY_ID\}\}/g, sources.cityId);

  const responseText = await callLlm(client, prompt, {
    maxTokens: 16000,
    thinkingBudget: 8000,
  });

  const separation = extractJson(responseText);
  writeFileSync(
    join(outDir, "separation.json"),
    JSON.stringify(separation, null, 2) + "\n"
  );
  console.log("  Separation rules extracted.");
}

// ─── Step 5: VALIDATE, AUTO-FIX & UPDATE ────────────────────────────────────

interface ValidationError {
  file: string;
  errors: string[];
}

function validateData(outDir: string): ValidationError[] {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  const scheduleSchema = JSON.parse(
    readFileSync(join(ROOT, "data/_schema/schedule.schema.json"), "utf-8")
  );
  const separationSchema = JSON.parse(
    readFileSync(join(ROOT, "data/_schema/separation.schema.json"), "utf-8")
  );

  const results: ValidationError[] = [];

  const checks: Array<{ file: string; schema: object }> = [
    { file: "schedule.json", schema: scheduleSchema },
    { file: "separation.json", schema: separationSchema },
  ];

  for (const { file, schema } of checks) {
    const filePath = join(outDir, file);
    if (!existsSync(filePath)) {
      results.push({ file, errors: [`${file} was not generated`] });
      continue;
    }
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      const errors = (validate.errors ?? []).map(
        (e) => `${e.instancePath} ${e.message}`
      );
      results.push({ file, errors });
    }
  }

  return results;
}

async function autoFixFile(
  client: Anthropic,
  outDir: string,
  error: ValidationError
): Promise<void> {
  const filePath = join(outDir, error.file);
  const data = readFileSync(filePath, "utf-8");

  const schemaFile = error.file === "schedule.json"
    ? "schedule.schema.json"
    : "separation.schema.json";
  const schema = readFileSync(
    join(ROOT, "data/_schema", schemaFile),
    "utf-8"
  );

  // Truncate data if very large to fit context
  const truncatedData = data.length > 80000
    ? data.slice(0, 80000) + "\n... (truncated)"
    : data;

  const prompt = `Fix the following JSON data so it passes schema validation.

## Validation errors

${error.errors.map((e) => `- ${e}`).join("\n")}

## Schema

\`\`\`json
${schema}
\`\`\`

## Current data (${error.file})

\`\`\`json
${truncatedData}
\`\`\`

## Rules

- Fix ONLY the validation errors — do not remove or change valid data
- Preserve all existing areas/categories/items
- Output the complete fixed JSON (not a diff)
- Output ONLY the JSON — no explanation`;

  const text = await callLlm(client, prompt, {
    maxTokens: 16000,
    thinkingBudget: 8000,
  });

  const fixed = extractJson(text);
  writeFileSync(filePath, JSON.stringify(fixed, null, 2) + "\n");
}

function updateCitiesJson(
  sources: DiscoverResult,
  args: GenerateArgs,
  outDir: string
): void {
  const schedulePath = join(outDir, "schedule.json");
  const separationPath = join(outDir, "separation.json");

  const schedule = JSON.parse(readFileSync(schedulePath, "utf-8"));
  const areas = (schedule as { areas?: unknown[] }).areas;
  console.log(`  Schedule: ${areas?.length ?? 0} areas`);

  const separation = JSON.parse(readFileSync(separationPath, "utf-8"));
  const categories = (separation as { categories?: unknown[] }).categories;
  console.log(`  Separation: ${categories?.length ?? 0} categories`);

  const citiesPath = join(ROOT, "data/cities.json");
  const cities = existsSync(citiesPath)
    ? JSON.parse(readFileSync(citiesPath, "utf-8"))
    : { version: "1.0.0", cities: [] };

  const fullCityId = `${sources.prefectureId}/${sources.cityId}`;
  const existing = cities.cities.findIndex(
    (c: { id: string }) => c.id === fullCityId
  );
  const entry = {
    id: fullCityId,
    name_ja: args.city,
    prefecture_ja: args.prefecture,
    source_url: sources.officialUrl || args.url || "",
    data_path: `jp/${sources.prefectureId}/${sources.cityId}`,
    last_verified: new Date().toISOString().split("T")[0],
  };

  if (existing >= 0) {
    cities.cities[existing] = entry;
  } else {
    cities.cities.push(entry);
  }

  writeFileSync(citiesPath, JSON.stringify(cities, null, 2) + "\n");
  console.log("  Updated cities.json");
  console.log(`  Output: ${outDir}/`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseCliArgs();

  // Provider config via env vars — works with Anthropic, z.ai, or any compatible API
  const client = new Anthropic();

  console.log(`\nGenerating garbage data for ${args.city} (${args.prefecture})`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  API: ${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}\n`);

  const sources = await discover(client, args);
  await downloadAll(sources, TMP_DIR);

  const outDir = join(ROOT, "data/jp", sources.prefectureId, sources.cityId);
  mkdirSync(outDir, { recursive: true });

  await generateSchedule(client, sources, args, TMP_DIR, outDir);
  await generateSeparation(client, sources, args, TMP_DIR, outDir);

  // Validate with auto-fix retry loop
  console.log("Step 5: Validating generated data...");
  for (let attempt = 0; attempt <= args.maxFixRetries; attempt++) {
    const errors = validateData(outDir);

    if (errors.length === 0) {
      if (attempt > 0) {
        console.log(`  Validation passed after ${attempt} auto-fix attempt(s).`);
      } else {
        console.log("  Validation passed.");
      }
      break;
    }

    if (attempt === args.maxFixRetries) {
      for (const err of errors) {
        console.error(`  FAIL ${err.file}:`);
        for (const msg of err.errors) {
          console.error(`    ${msg}`);
        }
      }
      throw new Error(
        `Validation failed after ${args.maxFixRetries} auto-fix attempt(s)`
      );
    }

    console.log(
      `  Validation errors found — auto-fix attempt ${attempt + 1}/${args.maxFixRetries}...`
    );
    for (const err of errors) {
      console.log(`    Fixing ${err.file} (${err.errors.length} error(s))...`);
      await autoFixFile(client, outDir, err);
    }
  }

  updateCitiesJson(sources, args, outDir);
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
