import path from "path";
import fs from "fs";
import type { PhaseDefinition, PhaseResult, PipelineContext } from "../types";
import { exec } from "../exec";
import { getOllamaUrl } from "../platform";
import { pollUntil } from "../poll";

function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "docker-compose.yml")) || fs.existsSync(path.join(dir, "services"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

const PHASE = "05-docker-stack";

const TEMPLATE_PATH = path.resolve(
  import.meta.dir,
  "../templates/docker-compose.yml.tmpl",
);

const HEALTH_POLL_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 120_000;

// Health check descriptors per service
type HealthCheck = {
  service: string;
  cmd: string;
  args: string[];
};

const HEALTH_CHECKS: HealthCheck[] = [
  { service: "postgres", cmd: "docker", args: ["compose", "exec", "postgres", "pg_isready"] },
  { service: "redis",    cmd: "docker", args: ["compose", "exec", "redis", "redis-cli", "ping"] },
  { service: "gateway",  cmd: "curl",   args: ["-sf", "http://localhost:3000/health"] },
];

function adaptComposeTemplate(
  template: string,
  ctx: PipelineContext,
): { content: string; services: string[] } {
  const { hardware, mode } = ctx;
  let content = template;
  const services: string[] = [];

  const isAppleSilicon = hardware.isAppleSilicon;
  const hasNvidiaGpu = hardware.gpuType === "cuda";
  const isCloudMode = mode === "cloud";

  ctx.logger.debug(PHASE, "Compose adaptations", { isAppleSilicon, hasNvidiaGpu, isCloudMode, mode });

  if (isCloudMode || isAppleSilicon) {
    // Remove Ollama service block: delimited by # begin:ollama / # end:ollama
    content = removeMarkedBlock(content, "ollama");
    ctx.logger.info(PHASE, "Removed Ollama service from compose", {
      reason: isCloudMode ? "cloud mode" : "Apple Silicon (native Ollama)",
    });
  }

  if (!hasNvidiaGpu || isCloudMode) {
    // Remove GPU reservation: delimited by # begin:gpu-reservation / # end:gpu-reservation
    content = removeMarkedBlock(content, "gpu-reservation");
    ctx.logger.info(PHASE, "Removed GPU reservation from compose");
  }

  if (!isCloudMode && !isAppleSilicon && !hasNvidiaGpu) {
    ctx.logger.info(PHASE, "CPU-only mode: Ollama remains in Docker without GPU passthrough");
  }

  // Replace variable placeholders
  const repoRoot = findRepoRoot(ctx.customerDir);
  const ollamaUrl = isCloudMode ? "" : getOllamaUrl(hardware);
  const replacements: Record<string, string> = {
    "{{INIT_SQL_PATH}}": path.resolve(repoRoot, "postgres/init.sql"),
    "{{SERVICES_PATH}}": path.resolve(repoRoot, "services"),
    "{{OLLAMA_URL}}": ollamaUrl,
    "{{INFERENCE_MODE}}": mode,
  };
  for (const [placeholder, value] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, value);
  }

  // Parse service names from adapted YAML (top-level keys under `services:`)
  const serviceMatches = content.matchAll(/^  (\w[\w-]+):\s*$/gm);
  for (const m of serviceMatches) {
    if (m[1]) services.push(m[1]);
  }

  return { content, services };
}

function removeMarkedBlock(content: string, marker: string): string {
  const begin = `# begin:${marker}`;
  const end = `# end:${marker}`;
  const re = new RegExp(
    `[ \\t]*${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}[ \\t]*\\n?`,
    "g",
  );
  return content.replace(re, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pollHealth(
  ctx: PipelineContext,
  composePath: string,
  check: HealthCheck,
  timeoutMs: number,
): Promise<boolean> {
  const composeDir = path.dirname(composePath);

  const ok = await pollUntil(
    async () => {
      const r = await exec(ctx.target, check.cmd, check.args, {
        cwd: composeDir,
        logger: ctx.logger,
        phase: PHASE,
        timeout: 10_000,
      });
      return r.ok;
    },
    {
      timeoutMs,
      intervalMs: HEALTH_POLL_INTERVAL_MS,
      label: `${check.service} health`,
      logger: ctx.logger,
      phase: PHASE,
    },
  );

  if (ok) {
    ctx.logger.info(PHASE, `${check.service} is healthy`);
  }
  return ok;
}

export const phase: PhaseDefinition = {
  id: "05-docker-stack",
  name: "Docker Stack",
  description: "Generate a platform-adapted docker-compose.yml and bring up the stack",
  dependencies: ["02-dependencies", "04-environment"],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    // Load template
    let template: string;
    try {
      template = fs.readFileSync(TEMPLATE_PATH, "utf8");
    } catch {
      const msg = `docker-compose template not found at ${TEMPLATE_PATH}`;
      ctx.logger.error(PHASE, msg);
      return {
        id: "05-docker-stack",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { composePath: null, services: [], healthy: [], unhealthy: [] },
        error: msg,
        warnings,
      };
    }

    ctx.logger.info(PHASE, "Adapting docker-compose template", {
      gpuType: ctx.hardware.gpuType,
      isAppleSilicon: ctx.hardware.isAppleSilicon,
      mode: ctx.mode,
    });

    const { content: adaptedCompose, services } = adaptComposeTemplate(template, ctx);
    const composePath = path.join(ctx.customerDir, "docker-compose.yml");

    // Validate: no unresolved placeholders remain
    const unresolved = adaptedCompose.match(/\{\{[A-Z_]+\}\}/g);
    if (unresolved) {
      const unique = [...new Set(unresolved)];
      const msg = `Unresolved template placeholders: ${unique.join(", ")}`;
      ctx.logger.error(PHASE, msg);
      return {
        id: "05-docker-stack",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { composePath: null, services, healthy: [], unhealthy: [] },
        error: msg,
        warnings,
      };
    }

    if (ctx.dryRun) {
      ctx.logger.info(PHASE, "[dry-run] Would write docker-compose.yml", { composePath, services });
      ctx.logger.debug(PHASE, "[dry-run] Adapted compose content", { content: adaptedCompose });
      ctx.logger.info(PHASE, "[dry-run] Would run: docker compose up -d");
      return {
        id: "05-docker-stack",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { composePath, services, healthy: [], unhealthy: [] },
        warnings,
      };
    }

    // Write adapted compose file
    fs.writeFileSync(composePath, adaptedCompose, "utf8");
    ctx.logger.info(PHASE, "docker-compose.yml written", { composePath, services });

    // Bring up the stack
    ctx.logger.info(PHASE, "Starting Docker stack");
    const upResult = await exec(
      ctx.target,
      "docker",
      ["compose", "-f", composePath, "up", "-d"],
      { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 180_000, retries: 2 },
    );

    if (!upResult.ok) {
      const msg = `docker compose up failed: ${upResult.stderr.slice(0, 400)}`;
      ctx.logger.error(PHASE, msg);
      return {
        id: "05-docker-stack",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { composePath, services, healthy: [], unhealthy: [] },
        error: msg,
        warnings,
      };
    }

    // Health checks — only for services present in the adapted compose
    ctx.logger.info(PHASE, "Waiting for service health checks");
    const healthy: string[] = [];
    const unhealthy: string[] = [];

    const checksToRun = HEALTH_CHECKS.filter(
      (c) => c.service === "gateway" || services.includes(c.service),
    );

    await Promise.all(
      checksToRun.map(async (check) => {
        const ok = await pollHealth(ctx, composePath, check, HEALTH_TIMEOUT_MS);
        if (ok) {
          healthy.push(check.service);
        } else {
          unhealthy.push(check.service);
          warnings.push(
            `Service "${check.service}" did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
          );
        }
      }),
    );

    const allHealthy = unhealthy.length === 0;
    ctx.logger.info(PHASE, "Health check summary", { healthy, unhealthy, allHealthy });

    return {
      id: "05-docker-stack",
      status: allHealthy ? "completed" : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { composePath, services, healthy, unhealthy },
      error: allHealthy ? undefined : `Unhealthy services: ${unhealthy.join(", ")}`,
      warnings,
    };
  },
};
