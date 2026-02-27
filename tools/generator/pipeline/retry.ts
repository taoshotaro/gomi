export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 8000;

export function calculateBackoffMs(
  attempt: number,
  baseMs = RETRY_BASE_MS,
  maxMs = RETRY_MAX_MS
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * (exponential / 2));
  return exponential + jitter;
}

export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
