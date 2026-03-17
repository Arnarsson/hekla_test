import type { PhaseDefinition, PhaseResult } from "../types";
import { runAllChecks, generateReport } from "../qa/runner";

export const phase: PhaseDefinition = {
  id: "12-final-qa",
  name: "Final QA",
  description: "Comprehensive smoke tests and setup report generation",
  dependencies: [
    "00-preflight",
    "01-user-account",
    "02-dependencies",
    "03-ollama-model",
    "04-environment",
    "05-docker-stack",
    "06-database",
    "07-agents",
    "08-telegram",
    "09-email",
    "10-scheduling",
    "11-tailscale",
  ],

  async run(ctx): Promise<PhaseResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    ctx.logger.info("12-final-qa", "Running QA suite");
    const checks = await runAllChecks(ctx);

    const allPassed = checks.every((c) => c.passed);
    const passCount = checks.filter((c) => c.passed).length;

    ctx.logger.info("12-final-qa", `QA complete: ${passCount}/${checks.length} checks passed`);

    const report = generateReport(checks, ctx);

    // Persist report to logs/
    const safeCustomer = ctx.customer.name.toLowerCase().replace(/\s+/g, "-");
    const reportTxtPath = `logs/${safeCustomer}-setup-report.txt`;
    const reportJsonPath = `logs/${safeCustomer}-setup-report.json`;

    try {
      await Bun.write(reportTxtPath, report);
      await Bun.write(
        reportJsonPath,
        JSON.stringify(
          {
            customer: ctx.customer.name,
            date: new Date().toISOString(),
            mode: ctx.mode,
            target: ctx.target,
            dryRun: ctx.dryRun,
            checks,
            allPassed,
            phases: Object.fromEntries(
              [...ctx.results.entries()].map(([id, r]) => [
                id,
                { status: r.status, warnings: r.warnings },
              ])
            ),
          },
          null,
          2
        )
      );
      ctx.logger.info("12-final-qa", `Report written: ${reportTxtPath}, ${reportJsonPath}`);
    } catch (err) {
      const msg = `Failed to write report: ${err instanceof Error ? err.message : String(err)}`;
      ctx.logger.warn("12-final-qa", msg);
      warnings.push(msg);
    }

    console.log("\n" + report + "\n");

    return {
      id: "12-final-qa",
      status: allPassed ? "completed" : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { checks, report, allPassed },
      warnings,
    };
  },
};
