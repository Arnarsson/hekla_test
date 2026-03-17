import { test, expect, describe } from "bun:test";
import { pollUntil } from "../poll";

describe("pollUntil", () => {
  test("returns true when predicate succeeds immediately", async () => {
    const result = await pollUntil(async () => true, {
      timeoutMs: 1000,
      intervalMs: 50,
    });
    expect(result).toBe(true);
  });

  test("returns true when predicate succeeds on Nth poll", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls++;
        return calls >= 3;
      },
      { timeoutMs: 5000, intervalMs: 20 },
    );
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });

  test("returns false on timeout", async () => {
    const result = await pollUntil(async () => false, {
      timeoutMs: 100,
      intervalMs: 20,
    });
    expect(result).toBe(false);
  });

  test("respects interval between polls", async () => {
    const timestamps: number[] = [];
    await pollUntil(
      async () => {
        timestamps.push(Date.now());
        return timestamps.length >= 3;
      },
      { timeoutMs: 5000, intervalMs: 50 },
    );

    expect(timestamps.length).toBe(3);
    // Gaps between polls should be at least ~50ms (allow for scheduling variance)
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(40);
    expect(gap2).toBeGreaterThanOrEqual(40);
  });

  test("logs timeout through logger", async () => {
    const logged: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (_phase: string, msg: string) => { logged.push(msg); },
      debug: () => {},
    };

    await pollUntil(async () => false, {
      timeoutMs: 50,
      intervalMs: 10,
      label: "test-service",
      logger,
      phase: "test",
    });

    expect(logged.some((m) => m.includes("test-service") && m.includes("timed out"))).toBe(true);
  });

  test("logs debug messages for retries", async () => {
    const debugMsgs: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: (_phase: string, msg: string) => { debugMsgs.push(msg); },
    };

    let calls = 0;
    await pollUntil(
      async () => {
        calls++;
        return calls >= 2;
      },
      {
        timeoutMs: 5000,
        intervalMs: 10,
        label: "my-check",
        logger,
        phase: "test",
      },
    );

    expect(debugMsgs.some((m) => m.includes("my-check"))).toBe(true);
  });
});
