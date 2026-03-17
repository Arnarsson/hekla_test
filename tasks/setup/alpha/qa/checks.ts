import { exec } from "../exec";
import type { PipelineContext } from "../types";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Docker containers
// ---------------------------------------------------------------------------

export async function checkDockerContainers(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Docker containers";

  const result = await exec(
    ctx.target,
    "docker",
    ["compose", "ps", "--format", "json"],
    { timeout: 30_000, phase: "qa", logger: ctx.logger }
  );

  if (!result.ok) {
    return { name, passed: false, detail: `docker compose ps failed: ${result.stderr.slice(0, 200)}` };
  }

  // Each line is a JSON object (Docker Compose v2 outputs one JSON per line)
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return { name, passed: false, detail: "No containers found — stack may not be running" };
  }

  const unhealthy: string[] = [];
  for (const line of lines) {
    let svc: { Name?: string; Service?: string; State?: string; Health?: string };
    try {
      svc = JSON.parse(line);
    } catch {
      continue;
    }
    const label = svc.Name ?? svc.Service ?? "unknown";
    const state = (svc.State ?? "").toLowerCase();
    const health = (svc.Health ?? "").toLowerCase();

    const isUp = state === "running";
    const isHealthy = health === "" || health === "healthy";

    if (!isUp || !isHealthy) {
      unhealthy.push(`${label} (state=${state}, health=${health || "n/a"})`);
    }
  }

  if (unhealthy.length > 0) {
    return { name, passed: false, detail: `Unhealthy services: ${unhealthy.join(", ")}` };
  }

  return { name, passed: true, detail: `${lines.length} service(s) up and healthy` };
}

// ---------------------------------------------------------------------------
// Database tables
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = [
  "users",
  "sessions",
  "conversations",
  "messages",
  "agents",
];

export async function checkDatabase(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Database tables";

  const result = await exec(
    ctx.target,
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "hekla", "-c", "\\dt"],
    { timeout: 30_000, phase: "qa", logger: ctx.logger }
  );

  if (!result.ok) {
    return { name, passed: false, detail: `psql failed: ${result.stderr.slice(0, 200)}` };
  }

  const output = result.stdout.toLowerCase();
  const missing = EXPECTED_TABLES.filter((t) => !output.includes(t));

  if (missing.length > 0) {
    return { name, passed: false, detail: `Missing tables: ${missing.join(", ")}` };
  }

  return { name, passed: true, detail: `All expected tables present (${EXPECTED_TABLES.join(", ")})` };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

export async function checkOllama(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Ollama API";

  if (ctx.mode === "cloud") {
    return { name, passed: true, detail: "Skipped — cloud mode, Ollama not required" };
  }

  const result = await exec(
    ctx.target,
    "curl",
    ["-sf", "--max-time", "10", "http://localhost:11434/api/tags"],
    { timeout: 15_000, phase: "qa", logger: ctx.logger }
  );

  if (!result.ok) {
    return { name, passed: false, detail: `Ollama not reachable at :11434 (exit ${result.exitCode})` };
  }

  let body: { models?: unknown[] };
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { name, passed: false, detail: "Ollama returned non-JSON response" };
  }

  const count = body.models?.length ?? 0;
  return { name, passed: true, detail: `Ollama healthy, ${count} model(s) loaded` };
}

// ---------------------------------------------------------------------------
// Gateway health
// ---------------------------------------------------------------------------

export async function checkGateway(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Gateway /health";

  const result = await exec(
    ctx.target,
    "curl",
    ["-sf", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/health"],
    { timeout: 15_000, phase: "qa", logger: ctx.logger }
  );

  const code = result.stdout.trim();

  if (!result.ok || code !== "200") {
    return { name, passed: false, detail: `Gateway /health returned HTTP ${code || result.exitCode}` };
  }

  return { name, passed: true, detail: "Gateway responding 200 on /health" };
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

export async function checkTelegram(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Telegram bot";

  const token = ctx.customerEnv["BOT_TOKEN"];
  if (!token) {
    return { name, passed: true, detail: "Skipped — BOT_TOKEN not set" };
  }

  const result = await exec(
    ctx.target,
    "curl",
    ["-sf", "--max-time", "10", `https://api.telegram.org/bot${token}/getMe`],
    { timeout: 15_000, phase: "qa", logger: ctx.logger }
  );

  if (!result.ok) {
    return { name, passed: false, detail: `Telegram getMe failed (exit ${result.exitCode})` };
  }

  let body: { ok?: boolean; result?: { username?: string } };
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { name, passed: false, detail: "Telegram returned non-JSON response" };
  }

  if (!body.ok) {
    return { name, passed: false, detail: "Telegram API returned ok=false" };
  }

  return { name, passed: true, detail: `Bot verified: @${body.result?.username ?? "unknown"}` };
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

export async function checkTailscale(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Tailscale";

  const result = await exec(
    ctx.target,
    "tailscale",
    ["status", "--json"],
    { timeout: 15_000, phase: "qa", logger: ctx.logger }
  );

  if (!result.ok) {
    return { name, passed: false, detail: `tailscale status failed (exit ${result.exitCode})` };
  }

  let body: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    body = JSON.parse(result.stdout);
  } catch {
    // Fall back to plain text check
    const connected = result.stdout.toLowerCase().includes("connected");
    return connected
      ? { name, passed: true, detail: "Tailscale connected (plain text)" }
      : { name, passed: false, detail: "Tailscale not connected" };
  }

  const state = body.BackendState ?? "";
  const connected = state === "Running";
  const dnsName = body.Self?.DNSName ?? "";

  if (!connected) {
    return { name, passed: false, detail: `Tailscale backend state: ${state}` };
  }

  return { name, passed: true, detail: `Tailscale connected${dnsName ? ` (${dnsName})` : ""}` };
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

export async function checkScheduledJobs(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Scheduled jobs";
  const scheduler = ctx.hardware.scheduler;

  let result;

  if (scheduler === "launchd") {
    result = await exec(
      ctx.target,
      "launchctl",
      ["list"],
      { timeout: 15_000, phase: "qa", logger: ctx.logger }
    );
  } else if (scheduler === "systemd") {
    result = await exec(
      ctx.target,
      "systemctl",
      ["--user", "list-units", "--no-pager"],
      { timeout: 15_000, phase: "qa", logger: ctx.logger }
    );
  } else {
    // Windows Task Scheduler
    result = await exec(
      ctx.target,
      "schtasks",
      ["/query", "/fo", "LIST"],
      { timeout: 15_000, phase: "qa", logger: ctx.logger }
    );
  }

  if (!result.ok) {
    return { name, passed: false, detail: `Scheduler list command failed (exit ${result.exitCode})` };
  }

  const output = result.stdout.toLowerCase();
  const found = output.includes("hekla");

  if (!found) {
    return { name, passed: false, detail: `No hekla jobs registered in ${scheduler}` };
  }

  const matches = (output.match(/hekla/g) ?? []).length;
  return { name, passed: true, detail: `${matches} hekla job(s) found in ${scheduler}` };
}

// ---------------------------------------------------------------------------
// Dirty state
// ---------------------------------------------------------------------------

export async function checkDirtyState(ctx: PipelineContext): Promise<CheckResult> {
  const name = "Dirty state";
  const issues: string[] = [];

  if (ctx.dirtyState.shadowMindRemnants.length > 0) {
    issues.push(`Shadow Mind remnants: ${ctx.dirtyState.shadowMindRemnants.join(", ")}`);
  }

  if (ctx.dirtyState.staleEnvFiles.length > 0) {
    issues.push(`Stale .env files: ${ctx.dirtyState.staleEnvFiles.join(", ")}`);
  }

  // Check for unexpected hekla/shadow containers that aren't managed by compose
  const psResult = await exec(
    ctx.target,
    "docker",
    ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"],
    { timeout: 15_000, phase: "qa", logger: ctx.logger }
  );

  if (psResult.ok && psResult.stdout) {
    const stale = psResult.stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const containerName = line.split("\t")[0]?.toLowerCase() ?? "";
        const status = line.split("\t")[1]?.toLowerCase() ?? "";
        return (containerName.includes("hekla") || containerName.includes("shadow")) &&
          status.startsWith("exited");
      });

    if (stale.length > 0) {
      issues.push(`Stale containers: ${stale.map((l) => l.split("\t")[0]).join(", ")}`);
    }
  }

  if (issues.length > 0) {
    return { name, passed: false, detail: issues.join("; ") };
  }

  return { name, passed: true, detail: "No remnants or stale containers detected" };
}
