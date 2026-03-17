import type { PhaseDefinition, PhaseResult, PipelineContext } from "../types";
import { exec } from "../exec";
import { pollUntil } from "../poll";

const PHASE = "07-agents";

const AGENT_SERVICES = [
  "gateway",
  "orchestrator",
  "mail-agent",
  "calendar-agent",
  "memory-agent",
] as const;

type AgentName = (typeof AGENT_SERVICES)[number];

interface AgentStatus {
  name: AgentName;
  status: string;
}

const RESTART_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;

async function getServiceStatus(
  ctx: PipelineContext,
  service: AgentName,
): Promise<string> {
  const result = await exec(
    ctx.target,
    "docker",
    ["compose", "ps", service, "--format", "{{.Status}}"],
    { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 15_000 },
  );
  if (!result.ok || !result.stdout.trim()) {
    return "not found";
  }
  return result.stdout.trim().toLowerCase();
}

function isHealthy(status: string): boolean {
  // Docker compose ps statuses: "Up", "Up (healthy)", "running"
  return (
    status.startsWith("up") ||
    status.startsWith("running") ||
    status.includes("healthy")
  );
}

async function waitForHealthy(
  ctx: PipelineContext,
  service: AgentName,
  timeoutMs: number,
): Promise<string> {
  let lastStatus = "unknown";
  await pollUntil(
    async () => {
      lastStatus = await getServiceStatus(ctx, service);
      return isHealthy(lastStatus);
    },
    {
      timeoutMs,
      intervalMs: POLL_INTERVAL_MS,
      label: `${service} health`,
      logger: ctx.logger,
      phase: PHASE,
    },
  );
  return lastStatus;
}

export const phase: PhaseDefinition = {
  id: "07-agents",
  name: "Agents",
  description: "Verify all agent containers are running and healthy",
  dependencies: ["06-database"],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    ctx.logger.info(PHASE, "Checking agent container health", { services: AGENT_SERVICES });

    const agents: AgentStatus[] = [];
    let allHealthy = true;

    for (const service of AGENT_SERVICES) {
      let status = await getServiceStatus(ctx, service);
      ctx.logger.info(PHASE, `${service}: ${status}`);

      if (!isHealthy(status)) {
        ctx.logger.warn(PHASE, `${service} is not healthy — attempting restart`, { status });

        if (!ctx.dryRun) {
          const restartResult = await exec(
            ctx.target,
            "docker",
            ["compose", "restart", service],
            { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 30_000 },
          );

          if (!restartResult.ok) {
            const msg = `Failed to restart ${service}: ${restartResult.stderr.slice(0, 200)}`;
            ctx.logger.error(PHASE, msg);
            warnings.push(msg);
            agents.push({ name: service, status: "restart-failed" });
            allHealthy = false;
            continue;
          }

          ctx.logger.info(PHASE, `${service} restarted — waiting for health (${RESTART_TIMEOUT_MS / 1000}s)`);
          status = await waitForHealthy(ctx, service, RESTART_TIMEOUT_MS);
          ctx.logger.info(PHASE, `${service} post-restart status: ${status}`);
        } else {
          ctx.logger.info(PHASE, `[dry-run] Would restart ${service}`);
        }
      }

      if (!isHealthy(status)) {
        const msg = `${service} remains unhealthy after restart: ${status}`;
        ctx.logger.error(PHASE, msg);
        warnings.push(msg);
        allHealthy = false;
      }

      agents.push({ name: service, status });
    }

    ctx.logger.info(PHASE, "Agent health summary", {
      allHealthy,
      agents: agents.map((a) => `${a.name}=${a.status}`).join(", "),
    });

    return {
      id: "07-agents",
      status: allHealthy ? "completed" : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { agents, allHealthy },
      error: allHealthy ? undefined : "One or more agents are not healthy",
      warnings,
    };
  },
};
