import type { PhaseDefinition, PipelineContext, PhaseResult } from "../types";
import { exec } from "../exec";
import { getUserCreateCommand } from "../platform";

const PHASE = "01-user-account";
const AGENT_USER = "hekla-agent";

export const phase: PhaseDefinition = {
  id: "01-user-account",
  name: "User Account",
  description: `Create isolated ${AGENT_USER} system user`,
  dependencies: ["00-preflight"],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    // Check if user already exists
    let userExists = false;
    if (ctx.hardware.os === "win32") {
      const check = await exec(ctx.target, "net", ["user", AGENT_USER], {
        logger: ctx.logger,
        phase: PHASE,
      });
      userExists = check.ok;
    } else {
      // Unix: `id <username>` exits 0 if user exists
      const check = await exec(ctx.target, "id", [AGENT_USER], {
        logger: ctx.logger,
        phase: PHASE,
      });
      userExists = check.ok;
    }

    if (userExists) {
      ctx.logger.info(PHASE, `User "${AGENT_USER}" already exists — skipping creation`);
      return {
        id: "01-user-account",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        output: { created: false, username: AGENT_USER },
      };
    }

    if (ctx.dryRun) {
      const cmd = getUserCreateCommand(AGENT_USER, ctx.hardware);
      ctx.logger.info(PHASE, `[dry-run] Would create user with: ${cmd.join(" ")}`);
      return {
        id: "01-user-account",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        output: { created: false, username: AGENT_USER, dryRun: true },
      };
    }

    const cmd = getUserCreateCommand(AGENT_USER, ctx.hardware);
    ctx.logger.info(PHASE, `Creating system user: ${cmd.join(" ")}`);

    const result = await exec(ctx.target, cmd[0]!, cmd.slice(1), {
      logger: ctx.logger,
      phase: PHASE,
      timeout: 30_000,
    });

    if (!result.ok) {
      return {
        id: "01-user-account",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        error: `Failed to create user "${AGENT_USER}": ${result.stderr}`,
        output: { created: false, username: AGENT_USER },
      };
    }

    ctx.logger.info(PHASE, `User "${AGENT_USER}" created successfully`);

    return {
      id: "01-user-account",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      warnings,
      output: { created: true, username: AGENT_USER },
    };
  },
};
