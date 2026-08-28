import { ProtocolHttpError } from './errors';

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Shared retryability predicate (dogfood T1 D2): exposed so streaming paths
 * that self-manage a narrow "connection window" retry loop (see
 * `generateTextStream`) classify failures identically to `withRetry`.
 */
export function isRetryableProtocolError(err: unknown): boolean {
  if (err instanceof ProtocolHttpError) {
    return RETRYABLE_STATUS_CODES.has(err.status);
  }
  if (err instanceof TypeError && err.message.includes('fetch')) return true;
  if (err instanceof Error && err.name === 'ConnectTimeoutError') return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  // Dogfood T1 D2 (#50): fail fast — 2 attempts with sub-second base backoff.
  // These defaults are shared by the Anthropic text / image / embedding /
  // rerank paths alike (all quick-fail semantics), so they all shift together.
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelay = opts.baseDelayMs ?? 800;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      if (opts.signal?.aborted) break;
      if (!isRetryableProtocolError(err)) break;

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
