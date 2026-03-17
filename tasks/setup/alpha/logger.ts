import fs from "fs";
import path from "path";
import type { Logger } from "./types.js";

const ANSI = {
  reset:  "\x1b[0m",
  cyan:   "\x1b[36m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
} as const;

type Level = "debug" | "info" | "warn" | "error";

const COLOR: Record<Level, string> = {
  debug: ANSI.gray,
  info:  ANSI.cyan,
  warn:  ANSI.yellow,
  error: ANSI.red,
};

export class StructuredLogger implements Logger {
  private readonly stream: fs.WriteStream;
  private readonly verbose: boolean;

  constructor(customerName: string, verbose: boolean) {
    this.verbose = verbose;

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFile = path.join("logs", `${ts}-${customerName}.jsonl`);
    fs.mkdirSync("logs", { recursive: true });
    this.stream = fs.createWriteStream(logFile, { flags: "a" });
  }

  info(phase: string, msg: string, data?: Record<string, unknown>): void {
    this.write("info", phase, msg, data);
  }

  warn(phase: string, msg: string, data?: Record<string, unknown>): void {
    this.write("warn", phase, msg, data);
  }

  error(phase: string, msg: string, data?: Record<string, unknown>): void {
    this.write("error", phase, msg, data);
  }

  debug(phase: string, msg: string, data?: Record<string, unknown>): void {
    if (this.verbose) this.write("debug", phase, msg, data);
  }

  close(): void {
    this.stream.end();
  }

  private write(level: Level, phase: string, msg: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const entry = { ts, level, phase, msg, ...data };

    this.stream.write(JSON.stringify(entry) + "\n");

    const color = COLOR[level];
    const label = `[${level.toUpperCase().padEnd(5)}]`;
    const prefix = `${color}${label}${ANSI.reset} ${ANSI.gray}${ts}${ANSI.reset} [${phase}]`;
    process.stdout.write(`${prefix} ${msg}\n`);
  }
}

export function createLogger(customerName: string, verbose: boolean): StructuredLogger {
  return new StructuredLogger(customerName, verbose);
}
