import type { PhaseDefinition, PipelineContext, PhaseResult } from "../types";
import { exec } from "../exec";
import { getInstallCommand, needsNvidiaToolkit } from "../platform";

const PHASE = "02-dependencies";

interface ToolSpec {
  name: string;
  /** Argv to check if already installed */
  versionCheck: string[];
  /** Package name(s) passed to the platform package manager */
  pkg: string | string[];
  /** Skip this tool entirely when condition is true */
  skip?: (ctx: PipelineContext) => boolean;
}

const TOOLS: ToolSpec[] = [
  {
    name: "docker",
    versionCheck: ["docker", "--version"],
    pkg: "docker",
  },
  {
    name: "ollama",
    versionCheck: ["ollama", "--version"],
    pkg: "ollama",
    skip: (ctx) => ctx.mode === "cloud",
  },
  {
    name: "bun",
    versionCheck: ["bun", "--version"],
    pkg: "bun",
  },
  {
    name: "tailscale",
    versionCheck: ["tailscale", "--version"],
    pkg: "tailscale",
  },
];

export const phase: PhaseDefinition = {
  id: "02-dependencies",
  name: "Dependencies",
  description: "Install Docker, Ollama, Bun, and Tailscale",
  dependencies: ["01-user-account"],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    const installed: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    const hw = ctx.hardware;

    for (const tool of TOOLS) {
      // Conditional skip (e.g. Ollama in cloud mode)
      if (tool.skip?.(ctx)) {
        ctx.logger.info(PHASE, `Skipping ${tool.name} (not needed for mode=${ctx.mode})`);
        skipped.push(tool.name);
        continue;
      }

      // Check if already installed via hardware profile
      const alreadyInstalled =
        tool.name === "docker"    ? hw.existingInstalls.docker    :
        tool.name === "ollama"    ? hw.existingInstalls.ollama    :
        tool.name === "bun"       ? hw.existingInstalls.bun       :
        tool.name === "tailscale" ? hw.existingInstalls.tailscale :
        false;

      if (alreadyInstalled) {
        ctx.logger.info(PHASE, `${tool.name} already installed — skipping`);
        skipped.push(tool.name);
        continue;
      }

      if (ctx.dryRun) {
        const pkgs = Array.isArray(tool.pkg) ? tool.pkg : [tool.pkg];
        for (const pkg of pkgs) {
          const cmd = getInstallCommand(pkg, hw);
          ctx.logger.info(PHASE, `[dry-run] Would install ${tool.name}: ${cmd.join(" ")}`);
        }
        skipped.push(`${tool.name} (dry-run)`);
        continue;
      }

      // Install
      ctx.logger.info(PHASE, `Installing ${tool.name}...`);
      const pkgs = Array.isArray(tool.pkg) ? tool.pkg : [tool.pkg];
      let installOk = true;

      for (const pkg of pkgs) {
        const cmd = getInstallCommand(pkg, hw);
        const result = await exec(ctx.target, cmd[0]!, cmd.slice(1), {
          logger: ctx.logger,
          phase: PHASE,
          timeout: 300_000, // 5 min — packages can be large
          retries: 3,
        });
        if (!result.ok) {
          ctx.logger.error(PHASE, `Failed to install package "${pkg}": ${result.stderr}`);
          installOk = false;
        }
      }

      if (!installOk) {
        failed.push(tool.name);
        continue;
      }

      // Validate with --version check
      const [bin, ...vArgs] = tool.versionCheck;
      const verifyResult = await exec(ctx.target, bin!, vArgs, {
        logger: ctx.logger,
        phase: PHASE,
        timeout: 15_000,
      });

      if (!verifyResult.ok) {
        const msg = `${tool.name} installed but version check failed`;
        ctx.logger.warn(PHASE, msg);
        warnings.push(msg);
        failed.push(tool.name);
      } else {
        ctx.logger.info(
          PHASE,
          `${tool.name} installed: ${verifyResult.stdout.split("\n")[0]}`
        );
        installed.push(tool.name);
      }
    }

    // NVIDIA-specific: install nvidia-container-toolkit if CUDA GPU present
    if (needsNvidiaToolkit(hw) && hw.os === "linux") {
      const toolkitName = "nvidia-container-toolkit";
      const alreadyHaveToolkit = await exec(
        ctx.target,
        "nvidia-container-toolkit",
        ["--version"],
        { logger: ctx.logger, phase: PHASE }
      );

      if (alreadyHaveToolkit.ok) {
        ctx.logger.info(PHASE, `${toolkitName} already installed — skipping`);
        skipped.push(toolkitName);
      } else if (ctx.dryRun) {
        const cmd = getInstallCommand(toolkitName, hw);
        ctx.logger.info(PHASE, `[dry-run] Would install ${toolkitName}: ${cmd.join(" ")}`);
        skipped.push(`${toolkitName} (dry-run)`);
      } else {
        ctx.logger.info(PHASE, `Installing ${toolkitName} for CUDA GPU...`);
        const cmd = getInstallCommand(toolkitName, hw);
        const result = await exec(ctx.target, cmd[0]!, cmd.slice(1), {
          logger: ctx.logger,
          phase: PHASE,
          timeout: 120_000,
        });
        if (result.ok) {
          ctx.logger.info(PHASE, `${toolkitName} installed successfully`);
          installed.push(toolkitName);
        } else {
          const msg = `Failed to install ${toolkitName}: ${result.stderr}`;
          ctx.logger.error(PHASE, msg);
          failed.push(toolkitName);
        }
      }
    }

    ctx.logger.info(PHASE, `Installed: [${installed.join(", ")}]`);
    ctx.logger.info(PHASE, `Skipped:   [${skipped.join(", ")}]`);
    if (failed.length > 0) ctx.logger.error(PHASE, `Failed:    [${failed.join(", ")}]`);

    return {
      id: "02-dependencies",
      status: failed.length > 0 ? "failed" : "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      warnings,
      error: failed.length > 0 ? `Failed to install: ${failed.join(", ")}` : undefined,
      output: { installed, skipped, failed },
    };
  },
};
