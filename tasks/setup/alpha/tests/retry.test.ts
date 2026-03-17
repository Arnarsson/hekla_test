import { test, expect, describe } from "bun:test";
import { withRetry } from "../retry";

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  test("retries on failure and succeeds on Nth attempt", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "recovered";
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("throws after max attempts exhausted", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("permanent");
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
      ),
    ).rejects.toThrow("permanent");
    expect(attempts).toBe(3);
  });

  test("respects shouldRetry predicate — stops early", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("non-retryable");
        },
        {
          maxAttempts: 5,
          baseDelayMs: 10,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("non-retryable");
    expect(attempts).toBe(1);
  });

  test("exponential backoff increases delay", async () => {
    const timestamps: number[] = [];
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          timestamps.push(Date.now());
          attempts++;
          throw new Error("fail");
        },
        { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 5000 },
      ),
    ).rejects.toThrow("fail");

    expect(attempts).toBe(3);
    // Second retry should have a longer delay than first
    // (50 * 2^0 + jitter) vs (50 * 2^1 + jitter)
    // Allow generous tolerance for jitter and scheduling
    const delay1 = timestamps[1]! - timestamps[0]!;
    const delay2 = timestamps[2]! - timestamps[1]!;
    expect(delay1).toBeGreaterThanOrEqual(40); // ~50ms base
    expect(delay2).toBeGreaterThanOrEqual(80); // ~100ms base
  });

  test("delay is capped at maxDelayMs", async () => {
    const timestamps: number[] = [];
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          timestamps.push(Date.now());
          attempts++;
          throw new Error("fail");
        },
        { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 200 },
      ),
    ).rejects.toThrow("fail");

    // All delays should be capped at ~200ms (+ jitter up to 500ms)
    for (let i = 1; i < timestamps.length; i++) {
      const delay = timestamps[i]! - timestamps[i - 1]!;
      expect(delay).toBeLessThan(1000); // max 200 + 500 jitter
    }
  });

  test("logs retries through logger", async () => {
    const logged: string[] = [];
    const logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (_phase: string, msg: string) => { logged.push(msg); },
    };

    await expect(
      withRetry(
        async () => { throw new Error("fail"); },
        { maxAttempts: 2, baseDelayMs: 10, logger, phase: "test", label: "test-op" },
      ),
    ).rejects.toThrow();

    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("test-op");
    expect(logged[0]).toContain("attempt 1/2");
  });
});
