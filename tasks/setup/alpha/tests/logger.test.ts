import { test, expect, describe } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { StructuredLogger, createLogger } from "../logger";

// logs/ is relative to the cwd that the logger uses (alpha/).
// Resolve it from this test file's location.
const LOGS_DIR = join(import.meta.dir, "../logs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the most recent log file whose name ends with -<customerName>.jsonl */
function getLatestLogFile(customerName: string): string | undefined {
  if (!existsSync(LOGS_DIR)) return undefined;
  const suffix = `-${customerName}.jsonl`;
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .reverse();
  return files[0] ? join(LOGS_DIR, files[0]) : undefined;
}

/** Parse a JSONL file into an array of objects. */
function readLogLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Close a logger and wait for the underlying WriteStream to flush.
 * fs.WriteStream.end() is async — we must wait for `finish` before reading.
 */
async function closeAndFlush(logger: StructuredLogger): Promise<void> {
  logger.close();
  // Give the Node.js write stream time to flush its buffer.
  await Bun.sleep(50);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StructuredLogger", () => {
  test("createLogger returns a StructuredLogger instance", async () => {
    const logger = createLogger("lg-create", false);
    expect(logger).toBeInstanceOf(StructuredLogger);
    await closeAndFlush(logger);
  });

  test("creates a log file in the logs/ directory", async () => {
    const logger = createLogger("lg-file", false);
    logger.info("test", "hello");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-file");
    expect(file).toBeDefined();
    expect(existsSync(file!)).toBe(true);
  });

  test("log file contains valid JSONL entries", async () => {
    const logger = createLogger("lg-jsonl", false);
    logger.info("phase-x", "a message");
    logger.warn("phase-y", "a warning");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-jsonl");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const infoLine = lines.find((l) => l["level"] === "info");
    expect(infoLine).toBeDefined();
    expect(infoLine?.["phase"]).toBe("phase-x");
    expect(infoLine?.["msg"]).toBe("a message");
    expect(typeof infoLine?.["ts"]).toBe("string");
  });

  test("each JSONL entry has ts, level, phase, msg", async () => {
    const logger = createLogger("lg-fields", false);
    logger.info("my-phase", "test message", { extra: "data" });
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-fields");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    const entry = lines[lines.length - 1]!;
    expect(entry["ts"]).toBeDefined();
    expect(entry["level"]).toBe("info");
    expect(entry["phase"]).toBe("my-phase");
    expect(entry["msg"]).toBe("test message");
    expect(entry["extra"]).toBe("data");
  });

  test("debug messages are NOT written when verbose=false", async () => {
    const logger = createLogger("lg-nodebug", false);
    logger.debug("phase", "this should not appear");
    logger.info("phase", "sentinel");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-nodebug");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    const debugLine = lines.find((l) => l["level"] === "debug");
    expect(debugLine).toBeUndefined();
  });

  test("debug messages ARE written when verbose=true", async () => {
    const logger = createLogger("lg-debug", true);
    logger.debug("phase", "debug message");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-debug");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    const debugLine = lines.find((l) => l["level"] === "debug");
    expect(debugLine).toBeDefined();
    expect(debugLine?.["msg"]).toBe("debug message");
  });

  test("error messages are always written", async () => {
    const logger = createLogger("lg-error", false);
    logger.error("phase", "something failed");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-error");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    const errorLine = lines.find((l) => l["level"] === "error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.["msg"]).toBe("something failed");
  });

  test("warn messages are always written", async () => {
    const logger = createLogger("lg-warn", false);
    logger.warn("phase", "a warning message");
    await closeAndFlush(logger);

    const file = getLatestLogFile("lg-warn");
    expect(file).toBeDefined();
    const lines = readLogLines(file!);
    const warnLine = lines.find((l) => l["level"] === "warn");
    expect(warnLine).toBeDefined();
  });

  test("close() does not throw", () => {
    const logger = createLogger("lg-close", false);
    expect(() => logger.close()).not.toThrow();
  });

  test("calling close() twice does not throw", () => {
    const logger = createLogger("lg-close2", false);
    logger.close();
    expect(() => logger.close()).not.toThrow();
  });
});
