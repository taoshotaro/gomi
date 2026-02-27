import { join } from "path";
import { fetchTextWithLimits } from "../lib/http.js";
import { ensureDir, writeJsonAtomic, writeTextAtomic } from "../lib/json.js";
import { ExtractionError } from "../pipeline/errors.js";
import type { DiscoverCandidate, SourceManifestEntry } from "../pipeline/types.js";
import type { PipelineContext } from "../pipeline/context.js";

interface DownloadTarget {
  sourceId: string;
  url: string;
  filename: string;
  candidate: DiscoverCandidate;
}

export async function runDownloadStep(
  context: PipelineContext,
  signal: AbortSignal
): Promise<void> {
  const { logger, options, stateStore, dirs } = context;
  const sources = stateStore.state.sources;

  if (!sources) {
    throw new ExtractionError("Discover output is missing before download step", undefined, false);
  }

  ensureDir(dirs.downloadDir);

  stateStore.setStepMessage("download", "Preparing selected source downloads");
  const targets = buildTargets(sources.candidates, sources.selected);
  if (targets.length === 0) {
    throw new ExtractionError("No selected source IDs available for download", undefined, false);
  }

  const manifest: SourceManifestEntry[] = [];
  let successes = 0;

  for (const target of targets) {
    stateStore.setStepMessage("download", `Downloading ${target.filename} from ${target.url}`);

    const result = await fetchTextWithLimits(target.url, {
      timeoutMs: options.httpTimeoutMs,
      maxBytes: options.maxDownloadBytes,
      signal,
      stripHtml: false,
    });

    stateStore.addHttpArtifact({
      step: "download",
      url: target.url,
      finalUrl: result.finalUrl,
      filename: target.filename,
      status: result.status,
      contentType: result.contentType,
      lastModified: result.lastModified,
      contentLength: result.contentLength,
      bytesRead: result.bytesRead,
      parserHints: [target.candidate.type],
      ok: result.ok,
      error: result.error,
      timestamp: new Date().toISOString(),
    });

    if (!result.ok || !result.body) {
      manifest.push({
        sourceId: target.sourceId,
        url: target.url,
        type: target.candidate.type,
        targetHints: target.candidate.targetHints,
        localPath: "",
        filename: target.filename,
        status: "failed",
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        lastModified: result.lastModified,
        contentLength: result.contentLength,
        bytesRead: result.bytesRead,
        error: result.error,
      });
      logger.warn("Download target failed", {
        step: "download",
        sourceId: target.sourceId,
        url: target.url,
        filename: target.filename,
        error: result.error,
      });
      continue;
    }

    const outputPath = join(dirs.downloadDir, target.filename);
    writeTextAtomic(outputPath, result.body);
    stateStore.addDownloadedFile(outputPath);
    successes += 1;

    manifest.push({
      sourceId: target.sourceId,
      url: target.url,
      type: target.candidate.type,
      targetHints: target.candidate.targetHints,
      localPath: outputPath,
      filename: target.filename,
      status: "downloaded",
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      lastModified: result.lastModified,
      contentLength: result.contentLength,
      bytesRead: result.bytesRead,
    });

    logger.info("Downloaded source file", {
      step: "download",
      sourceId: target.sourceId,
      filename: target.filename,
      bytes: result.bytesRead,
    });
  }

  if (successes === 0) {
    throw new ExtractionError("All selected source downloads failed", undefined, true);
  }

  const manifestPath = join(options.workDir, "source-manifest.json");
  writeJsonAtomic(manifestPath, manifest);
  stateStore.state.sourceManifestPath = manifestPath;
  stateStore.persist();
}

function buildTargets(
  candidates: DiscoverCandidate[],
  selected: { schedule: string[]; separation: string[] }
): DownloadTarget[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = [...new Set([...selected.schedule, ...selected.separation])];
  const out: DownloadTarget[] = [];

  for (const sourceId of selectedIds) {
    const candidate = byId.get(sourceId);
    if (!candidate) {
      continue;
    }

    out.push({
      sourceId,
      url: candidate.url,
      filename: `${sourceId}.${inferExtension(candidate.url, candidate.type)}`,
      candidate,
    });
  }

  return out;
}

function inferExtension(url: string, type: DiscoverCandidate["type"]): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch {
    // fall through
  }

  switch (type) {
    case "csv":
      return "csv";
    case "xlsx":
      return "xlsx";
    case "pdf":
      return "pdf";
    case "image":
      return "png";
    case "api":
      return "json";
    case "html":
      return "html";
    default:
      return "txt";
  }
}
