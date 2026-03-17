import type { PhaseDefinition, PhaseResult } from "../types";
import { exec } from "../exec";

export const phase: PhaseDefinition = {
  id: "11-tailscale",
  name: "Tailscale",
  description: "Sets up Tailscale for remote support access",
  dependencies: ["02-dependencies"],

  async run(ctx): Promise<PhaseResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    const output: { connected: boolean; ip: string | null; hostname: string | null } = {
      connected: false,
      ip: null,
      hostname: null,
    };

    // Check current status
    ctx.logger.info("11-tailscale", "Checking Tailscale status");
    const statusResult = await exec(ctx.target, "tailscale", ["status", "--json"], {
      timeout: 15_000,
      phase: "11-tailscale",
      logger: ctx.logger,
    });

    if (statusResult.ok) {
      let status: {
        BackendState?: string;
        Self?: { TailscaleIPs?: string[]; HostName?: string };
      };
      try {
        status = JSON.parse(statusResult.stdout);
      } catch {
        // Fall back to non-JSON status
        status = {};
      }

      const isRunning = status.BackendState === "Running";
      if (isRunning) {
        output.connected = true;
        output.ip = status.Self?.TailscaleIPs?.[0] ?? null;
        output.hostname = status.Self?.HostName ?? null;
        ctx.logger.info("11-tailscale", "Tailscale already connected", {
          ip: output.ip,
          hostname: output.hostname,
        });

        return {
          id: "11-tailscale",
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          output,
          warnings,
        };
      }
    }

    // Not connected — bring it up
    ctx.logger.info("11-tailscale", "Tailscale not connected; running tailscale up");

    if (ctx.dryRun) {
      ctx.logger.info("11-tailscale", "[dry-run] Would run: tailscale up");
      warnings.push("[dry-run] tailscale up skipped");
      return {
        id: "11-tailscale",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        warnings,
      };
    }

    const upResult = await exec(ctx.target, "tailscale", ["up"], {
      timeout: 120_000,
      phase: "11-tailscale",
      logger: ctx.logger,
      retries: 3,
    });

    if (!upResult.ok) {
      const msg = `tailscale up failed (exit ${upResult.exitCode}): ${upResult.stderr.slice(0, 300)}`;
      ctx.logger.error("11-tailscale", msg);

      // Surface any auth URL printed to stderr/stdout for the operator
      const authUrlMatch = (upResult.stdout + upResult.stderr).match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (authUrlMatch) {
        ctx.logger.info("11-tailscale", `[OPERATOR ACTION REQUIRED] Authenticate at: ${authUrlMatch[0]}`);
        console.log(`\n  Tailscale auth URL:\n  ${authUrlMatch[0]}\n`);
        warnings.push(`Operator must authenticate Tailscale: ${authUrlMatch[0]}`);
      }

      return {
        id: "11-tailscale",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        error: msg,
        warnings,
      };
    }

    // Re-query status after connecting
    const statusAfter = await exec(ctx.target, "tailscale", ["status", "--json"], {
      timeout: 15_000,
      phase: "11-tailscale",
      logger: ctx.logger,
    });

    if (statusAfter.ok) {
      try {
        const st: { Self?: { TailscaleIPs?: string[]; HostName?: string } } =
          JSON.parse(statusAfter.stdout);
        output.ip = st.Self?.TailscaleIPs?.[0] ?? null;
        output.hostname = st.Self?.HostName ?? null;
      } catch {
        // best-effort
      }
    }

    output.connected = true;
    ctx.logger.info("11-tailscale", "Tailscale connected", {
      ip: output.ip,
      hostname: output.hostname,
    });

    return {
      id: "11-tailscale",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      output,
      warnings,
    };
  },
};
