import { test, expect, describe } from "bun:test";
import { join } from "path";

const PIPELINE = join(import.meta.dir, "../pipeline.ts");

async function runPipeline(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", PIPELINE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// CLI smoke tests
// ---------------------------------------------------------------------------

describe("pipeline CLI", () => {
  test("--help exits with code 0", async () => {
    const { exitCode, stdout } = await runPipeline(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("HEKLA");
  }, 15_000);

  test("--help output contains usage instructions", async () => {
    const { exitCode, stdout } = await runPipeline(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--customer");
    expect(stdout).toContain("--mode");
  }, 15_000);

  test("missing --customer exits with non-zero code", async () => {
    const { exitCode } = await runPipeline([]);
    expect(exitCode).not.toBe(0);
  }, 15_000);

  test("invalid --mode exits with non-zero code", async () => {
    const { exitCode, stderr } = await runPipeline([
      "--customer", "00-christopher",
      "--mode", "invalid-mode",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("invalid-mode");
  }, 30_000);

  test("--dry-run with valid customer runs without error", async () => {
    const { exitCode } = await runPipeline([
      "--customer", "00-christopher",
      "--mode", "hybrid",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
  }, 30_000);

  test("--dry-run output contains plan header", async () => {
    const { exitCode, stdout } = await runPipeline([
      "--customer", "00-christopher",
      "--mode", "hybrid",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("HEKLA");
  }, 30_000);
});
