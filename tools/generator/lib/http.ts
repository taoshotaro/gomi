import { NetworkError } from "../pipeline/errors.js";
import { emitAgentEvent } from "../pipeline/events.js";

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  allowedHosts?: string[];
  stripHtml?: boolean;
}

export interface FetchTextResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  bytesRead: number;
  body?: string;
  error?: string;
  finalUrl?: string;
}

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; gomi-data-collector/2.0)";

export async function fetchTextWithLimits(
  url: string,
  options: FetchTextOptions
): Promise<FetchTextResult> {
  const startedAt = Date.now();
  let finalized = false;
  emitAgentEvent({
    level: "info",
    eventType: "http.request",
    message: "HTTP request start",
    phase: "start",
    action: "GET",
    url,
  });

  validateAllowedHost(url, options.allowedHosts);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? undefined;
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new NetworkError(
        `HTTP ${response.status} ${response.statusText} for ${url}`,
        undefined,
        retryable
      );
    }

    const buffer = await response.arrayBuffer();
    const bytesRead = buffer.byteLength;
    if (bytesRead > options.maxBytes) {
      throw new NetworkError(
        `Response too large for ${url}: ${bytesRead} bytes > ${options.maxBytes} bytes`,
        undefined,
        false
      );
    }

    let body = decodeContent(new Uint8Array(buffer));
    if (options.stripHtml && looksLikeHtml(contentType, url)) {
      body = stripHtmlToText(body);
    }

    emitAgentEvent({
      level: "info",
      eventType: "http.response",
      message: "HTTP request success",
      phase: "end",
      durationMs: Date.now() - startedAt,
      statusCode: response.status,
      bytes: bytesRead,
    });
    finalized = true;

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentLength,
      lastModified,
      bytesRead,
      body,
      finalUrl: response.url,
    };
  } catch (error) {
    if (error instanceof NetworkError) {
      emitAgentEvent({
        level: "warn",
        eventType: "http.response",
        message: "HTTP request failed",
        phase: "fail",
        durationMs: Date.now() - startedAt,
        errorMessage: error.message,
        retryable: error.retryable,
      });
      finalized = true;
      return {
        ok: false,
        error: error.message,
        bytesRead: 0,
      };
    }

    if (error instanceof Error && error.name === "AbortError") {
      emitAgentEvent({
        level: "warn",
        eventType: "http.response",
        message: "HTTP request timed out",
        phase: "fail",
        durationMs: Date.now() - startedAt,
        errorMessage: `Timed out after ${options.timeoutMs}ms`,
      });
      finalized = true;
      return {
        ok: false,
        error: `Timed out after ${options.timeoutMs}ms: ${url}`,
        bytesRead: 0,
      };
    }

    emitAgentEvent({
      level: "warn",
      eventType: "http.response",
      message: "HTTP request failed",
      phase: "fail",
      durationMs: Date.now() - startedAt,
      errorMessage: String(error),
    });
    finalized = true;
    return {
      ok: false,
      error: String(error),
      bytesRead: 0,
    };
  } finally {
    if (!finalized) {
      emitAgentEvent({
        level: "info",
        eventType: "http.response",
        message: "HTTP request end",
        phase: "end",
        durationMs: Date.now() - startedAt,
      });
    }
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function validateAllowedHost(url: string, allowedHosts?: string[]): void {
  if (!allowedHosts || allowedHosts.length === 0) {
    return;
  }

  const host = new URL(url).hostname.toLowerCase();
  const isAllowed = allowedHosts.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });

  if (!isAllowed) {
    throw new NetworkError(
      `Blocked host ${host}. Allowed hosts: ${allowedHosts.join(", ")}`,
      undefined,
      false
    );
  }
}

function decodeContent(buffer: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return utf8.decode(buffer);
  } catch {
    try {
      const sjis = new TextDecoder("shift_jis", { fatal: false });
      return sjis.decode(buffer);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    }
  }
}

function looksLikeHtml(contentType: string | undefined, url: string): boolean {
  if (contentType?.includes("text/html")) {
    return true;
  }
  return /\.html?$/.test(url);
}

export function stripHtmlToText(html: string): string {
  return html
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
    .trim();
}
