import type { Logger } from "./types";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  logger?: Logger;
  phase?: string;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Retry an async operation with exponential backoff + jitter.
 * Delay formula: min(base * 2^attempt + random(0,500), maxDelay)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    label = "operation",
    logger,
    phase = "retry",
    shouldRetry = () => true,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt + 1 >= maxAttempts) break;
      if (!shouldRetry(err, attempt)) break;

      const jitter = Math.random() * 500;
      const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
      const msg = `${label} failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${(delay / 1000).toFixed(1)}s`;

      if (logger) {
        logger.warn(phase, msg, {
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
      }

      await Bun.sleep(delay);
    }
  }

  throw lastError;
}
