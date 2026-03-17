import type { ExecutionTarget, Logger } from "./types";
import { withRetry } from "./retry";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export async function exec(
  target: ExecutionTarget,
  cmd: string,
  args: string[],
  opts?: {
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    logger?: Logger;
    phase?: string;
    retries?: number;
  }
): Promise<ExecResult> {
  if (opts?.retries && opts.retries > 1) {
    try {
      return await withRetry(() => execOnce(target, cmd, args, opts), {
        maxAttempts: opts.retries,
        label: `${cmd} ${args[0] ?? ""}`.trim(),
        logger: opts.logger,
        phase: opts.phase,
        shouldRetry: (err) => {
          // Retry on ExecRetryError (non-zero exit), not on unexpected errors
          return err instanceof ExecRetryError;
        },
      });
    } catch (err) {
      // All retries exhausted — return the last failed result instead of throwing
      if (err instanceof ExecRetryError) return err.result;
      throw err;
    }
  }
  return execOnce(target, cmd, args, opts);
}

class ExecRetryError extends Error {
  constructor(public result: ExecResult) {
    super(`Command failed with exit code ${result.exitCode}`);
  }
}

async function execOnce(
  target: ExecutionTarget,
  cmd: string,
  args: string[],
  opts?: {
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    logger?: Logger;
    phase?: string;
    retries?: number;
  }
): Promise<ExecResult> {
  const timeout = opts?.timeout ?? 120_000;
  const phase = opts?.phase ?? "exec";
  const logger = opts?.logger;

  let argv: string[];

  if (target.type === "local") {
    argv = [cmd, ...args];
  } else {
    // SSH: collapse cmd + args into a single quoted shell string
    const remote = [cmd, ...args].map(shellQuote).join(" ");
    argv = [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-p", String(target.port),
      `${target.user}@${target.host}`,
      remote,
    ];
  }

  logger?.debug(phase, `$ ${argv.join(" ")}`, { cwd: opts?.cwd });

  const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  };

  if (opts?.env) spawnOpts.env = { ...process.env, ...opts.env } as Record<string, string>;
  if (opts?.cwd) spawnOpts.cwd = opts.cwd;

  const proc = Bun.spawn(argv, spawnOpts);

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout)
  );

  let stdout = "";
  let stderr = "";
  let exitCode = 1;

  try {
    const [stdoutText, stderrText] = await Promise.race([
      Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]),
      timer,
    ]);

    stdout = stdoutText;
    stderr = stderrText;
    exitCode = await proc.exited;
  } catch (err) {
    proc.kill();
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(phase, msg);
    return { exitCode: 1, stdout: "", stderr: msg, ok: false };
  }

  const ok = exitCode === 0;

  if (!ok) {
    logger?.debug(phase, `exit ${exitCode}`, { stderr: stderr.slice(0, 200) });
    // When called via retry wrapper, throw so withRetry can catch and retry
    if (opts?.retries && opts.retries > 1) {
      throw new ExecRetryError({ exitCode, stdout, stderr, ok });
    }
  }

  return { exitCode, stdout, stderr, ok };
}

// Wrap a string in single quotes, escaping any embedded single quotes.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
