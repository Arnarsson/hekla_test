import type { PipelineContext } from "../types";
import type { CheckResult } from "./checks";
import * as checks from "./checks";

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export async function runAllChecks(ctx: PipelineContext): Promise<CheckResult[]> {
  const fns = [
    checks.checkDockerContainers,
    checks.checkDatabase,
    checks.checkOllama,
    checks.checkGateway,
    checks.checkTelegram,
    checks.checkTailscale,
    checks.checkScheduledJobs,
    checks.checkDirtyState,
  ];

  // Run sequentially so logs stay in order and each check is independently auditable
  const results: CheckResult[] = [];
  for (const fn of fns) {
    ctx.logger.debug("qa", `Running check: ${fn.name}`);
    const result = await fn(ctx);
    ctx.logger.info("qa", `${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateReport(results: CheckResult[], ctx: PipelineContext): string {
  const date = new Date().toISOString().slice(0, 10);
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  const customerDirName = ctx.customerDir.split("/").pop() ?? ctx.customer.name;

  const lines: string[] = [];

  // Header
  lines.push("=".repeat(60));
  lines.push("HEKLA Setup Verification Report");
  lines.push("=".repeat(60));
  lines.push(`Customer  : ${ctx.customer.name}`);
  lines.push(`Date      : ${date}`);
  lines.push(`Mode      : ${ctx.mode}`);
  lines.push(`Platform  : ${ctx.hardware.os} ${ctx.hardware.arch} (${ctx.hardware.hostname})`);
  lines.push(
    `Target    : ${
      ctx.target.type === "ssh"
        ? `ssh://${ctx.target.user}@${ctx.target.host}:${ctx.target.port}`
        : "local"
    }`
  );
  lines.push("");

  // Check results
  lines.push("Checks");
  lines.push("-".repeat(60));
  for (const r of results) {
    const mark = r.passed ? "[PASS]" : "[FAIL]";
    lines.push(`  ${mark.padEnd(7)} ${r.name}`);
    lines.push(`           ${r.detail}`);
  }
  lines.push("");

  // Summary
  lines.push("Summary");
  lines.push("-".repeat(60));
  lines.push(`  ${passed.length}/${results.length} checks passed`);
  lines.push("");

  // Warnings / failures
  if (failed.length > 0) {
    lines.push("Warnings — action required");
    lines.push("-".repeat(60));
    for (const r of failed) {
      lines.push(`  - ${r.name}: ${r.detail}`);
    }
    lines.push("");
  }

  // Next steps
  lines.push("Next Steps");
  lines.push("-".repeat(60));
  if (failed.length === 0) {
    lines.push("  All checks passed. Hand off to customer:");
    lines.push(`  1. Send welcome message via ${ctx.customer.chatInterface || "chat"}`);
    lines.push("  2. Walk through first interaction with HEKLA");
    lines.push("  3. Confirm scheduled jobs are firing at expected times");
    lines.push("  4. Archive this report in the customer directory");
  } else {
    lines.push("  Resolve the failed checks above, then re-run:");
    lines.push(
      `    bun run pipeline.ts --customer ${customerDirName} --mode ${ctx.mode} --only-phase 12`
    );
    for (const r of failed) {
      lines.push(`  - Fix: ${r.name} — ${r.detail}`);
    }
  }
  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}
