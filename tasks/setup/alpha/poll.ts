import type { Logger } from "./types";

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  label?: string;
  logger?: Logger;
  phase?: string;
}

/**
 * Poll an async predicate until it returns true or the timeout expires.
 * Returns true if the predicate succeeded, false on timeout.
 */
export async function pollUntil(
  predicate: () => Promise<boolean>,
  opts: PollOptions,
): Promise<boolean> {
  const { timeoutMs, intervalMs, label = "poll", logger, phase = "poll" } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await predicate();
    if (ok) return true;

    logger?.debug(phase, `${label} not ready — retrying in ${(intervalMs / 1000).toFixed(0)}s`);
    await Bun.sleep(intervalMs);
  }

  logger?.error(phase, `${label} timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
  return false;
}
