import type { PhaseDefinition, PhaseResult } from "../types";
import { exec } from "../exec";
import { getSchedulerPaths } from "../platform";

interface ScheduledJob {
  name: string;
  schedule: string;
  loaded: boolean;
}

async function jobExists(
  ctx: import("../types").PipelineContext,
  scheduler: import("../types").Scheduler,
  name: string,
): Promise<boolean> {
  let result;
  if (scheduler === "launchd") {
    result = await exec(ctx.target, "launchctl", ["list"], {
      timeout: 15_000, phase: "10-scheduling", logger: ctx.logger,
    });
    return result.ok && result.stdout.includes(name);
  }
  if (scheduler === "systemd") {
    result = await exec(ctx.target, "systemctl", ["--user", "is-enabled", `${name}.timer`], {
      timeout: 15_000, phase: "10-scheduling", logger: ctx.logger,
    });
    return result.ok;
  }
  if (scheduler === "taskschd") {
    result = await exec(ctx.target, "schtasks", ["/query", "/tn", name], {
      timeout: 15_000, phase: "10-scheduling", logger: ctx.logger,
    });
    return result.ok;
  }
  return false;
}

export const phase: PhaseDefinition = {
  id: "10-scheduling",
  name: "Scheduling",
  description: "Sets up platform-native scheduled jobs for briefings, health checks, and auto-start",
  dependencies: ["07-agents", "08-telegram"],

  async run(ctx): Promise<PhaseResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    const jobs: ScheduledJob[] = [];

    const scheduler = ctx.hardware.scheduler;
    const { dir } = getSchedulerPaths(ctx.hardware);

    const briefingTime = ctx.customerEnv["BRIEFING_TIME"] ?? "7:00";
    const [briefingHour, briefingMinute] = briefingTime.split(":").map(Number);

    const jobDefs = [
      {
        name: "hekla-morning-briefing",
        label: "Morning briefing",
        schedule: `daily at ${briefingTime}`,
        cronMinute: briefingMinute ?? 0,
        cronHour: briefingHour ?? 7,
        command: ["bun", "run", "briefing.ts"],
      },
      {
        name: "hekla-health-check",
        label: "Health check",
        schedule: "every 5 minutes",
        cronMinute: -1, // every 5 min
        cronHour: -1,
        command: ["bun", "run", "health-check.ts"],
      },
      {
        name: "hekla-autostart",
        label: "Auto-start on boot",
        schedule: "on boot",
        cronMinute: -1,
        cronHour: -1,
        command: ["docker", "compose", "up", "-d"],
      },
    ];

    if (ctx.dryRun) {
      ctx.logger.info("10-scheduling", `[dry-run] Would configure ${scheduler} jobs in ${dir}`);
      for (const job of jobDefs) {
        ctx.logger.info("10-scheduling", `[dry-run] Would schedule: ${job.label} (${job.schedule})`);
        jobs.push({ name: job.name, schedule: job.schedule, loaded: false });
        warnings.push(`[dry-run] Would schedule ${job.label}`);
      }
      return {
        id: "10-scheduling",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { scheduler, jobs },
        warnings,
      };
    }

    // Ensure scheduler directory exists (not applicable for taskschd)
    if (scheduler !== "taskschd") {
      await exec(ctx.target, "mkdir", ["-p", dir], {
        phase: "10-scheduling",
        logger: ctx.logger,
      });
    }

    for (const job of jobDefs) {
      let loaded = false;

      // Idempotency: check if job already exists before creating
      const exists = await jobExists(ctx, scheduler, job.name);
      if (exists) {
        ctx.logger.info("10-scheduling", `${job.name} already registered — skipping`);
        jobs.push({ name: job.name, schedule: job.schedule, loaded: true });
        continue;
      }

      try {
        if (scheduler === "launchd") {
          const plistPath = `${dir}/${job.name}.plist`;
          const plistContent = buildLaunchdPlist(job.name, job.command, job.cronHour, job.cronMinute);

          await Bun.write(plistPath, plistContent);
          ctx.logger.info("10-scheduling", `Written plist: ${plistPath}`);

          const loadResult = await exec(ctx.target, "launchctl", ["load", plistPath], {
            timeout: 15_000,
            phase: "10-scheduling",
            logger: ctx.logger,
          });

          if (loadResult.ok) {
            loaded = true;
            ctx.logger.info("10-scheduling", `Loaded: ${job.name}`);
          } else {
            const msg = `launchctl load failed for ${job.name}: ${loadResult.stderr.slice(0, 200)}`;
            ctx.logger.warn("10-scheduling", msg);
            warnings.push(msg);
          }
        } else if (scheduler === "systemd") {
          const unitPath = `${dir}/${job.name}.service`;
          const timerPath = `${dir}/${job.name}.timer`;

          await Bun.write(unitPath, buildSystemdService(job.name, job.command));
          await Bun.write(timerPath, buildSystemdTimer(job.name, job.cronHour, job.cronMinute));
          ctx.logger.info("10-scheduling", `Written unit: ${unitPath}`);

          // daemon-reload then enable timer
          await exec(ctx.target, "systemctl", ["--user", "daemon-reload"], {
            timeout: 15_000,
            phase: "10-scheduling",
            logger: ctx.logger,
          });

          const enableResult = await exec(
            ctx.target,
            "systemctl",
            ["--user", "enable", "--now", `${job.name}.timer`],
            { timeout: 15_000, phase: "10-scheduling", logger: ctx.logger }
          );

          if (enableResult.ok) {
            loaded = true;
            ctx.logger.info("10-scheduling", `Enabled timer: ${job.name}`);
          } else {
            const msg = `systemctl enable failed for ${job.name}: ${enableResult.stderr.slice(0, 200)}`;
            ctx.logger.warn("10-scheduling", msg);
            warnings.push(msg);
          }
        } else if (scheduler === "taskschd") {
          // Windows Task Scheduler
          const [cmd, ...args] = job.command;
          const taskCmd = [cmd, ...args].join(" ");
          const schedule = job.name === "hekla-autostart"
            ? ["/sc", "ONLOGON"]
            : job.cronMinute === -1
              ? ["/sc", "MINUTE", "/mo", "5"]
              : ["/sc", "DAILY", "/st", `${String(job.cronHour ?? 7).padStart(2, "0")}:${String(job.cronMinute ?? 0).padStart(2, "0")}`];

          const createResult = await exec(
            ctx.target,
            "schtasks",
            ["/create", "/f", "/tn", job.name, ...schedule, "/tr", taskCmd],
            { timeout: 30_000, phase: "10-scheduling", logger: ctx.logger }
          );

          if (createResult.ok) {
            loaded = true;
            ctx.logger.info("10-scheduling", `Scheduled task created: ${job.name}`);
          } else {
            const msg = `schtasks create failed for ${job.name}: ${createResult.stderr.slice(0, 200)}`;
            ctx.logger.warn("10-scheduling", msg);
            warnings.push(msg);
          }
        }
      } catch (err) {
        const msg = `Exception scheduling ${job.name}: ${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error("10-scheduling", msg);
        warnings.push(msg);
      }

      jobs.push({ name: job.name, schedule: job.schedule, loaded });
    }

    const anyLoaded = jobs.some((j) => j.loaded);

    return {
      id: "10-scheduling",
      status: anyLoaded ? "completed" : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { scheduler, jobs },
      warnings,
    };
  },
};

function buildLaunchdPlist(label: string, command: string[], hour: number, minute: number): string {
  const [prog, ...args] = command;
  const argItems = [prog, ...args].map((a) => `    <string>${a}</string>`).join("\n");

  // Health check: every 5 min = StartInterval 300; autostart = RunAtLoad; others = StartCalendarInterval
  let scheduleXml: string;
  if (label === "hekla-health-check") {
    scheduleXml = "  <key>StartInterval</key>\n  <integer>300</integer>";
  } else if (label === "hekla-autostart") {
    scheduleXml = "  <key>RunAtLoad</key>\n  <true/>";
  } else {
    scheduleXml =
      "  <key>StartCalendarInterval</key>\n" +
      "  <dict>\n" +
      `    <key>Hour</key><integer>${hour}</integer>\n` +
      `    <key>Minute</key><integer>${minute}</integer>\n` +
      "  </dict>";
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argItems}
  </array>
${scheduleXml}
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.err</string>
</dict>
</plist>
`;
}

function buildSystemdService(name: string, command: string[]): string {
  const [exec, ...args] = command;
  const execStart = [exec, ...args].join(" ");
  return `[Unit]
Description=HEKLA ${name}
After=network.target

[Service]
Type=oneshot
ExecStart=${execStart}

[Install]
WantedBy=default.target
`;
}

function buildSystemdTimer(name: string, hour: number, minute: number): string {
  let onCalendar: string;
  if (name === "hekla-health-check") {
    onCalendar = "*:0/5"; // every 5 minutes
  } else if (name === "hekla-autostart") {
    onCalendar = ""; // use OnBootSec instead
  } else {
    onCalendar = `*-*-* ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  const scheduleEntry =
    name === "hekla-autostart"
      ? "OnBootSec=30s"
      : `OnCalendar=${onCalendar}\nPersistent=true`;

  return `[Unit]
Description=Timer for HEKLA ${name}

[Timer]
${scheduleEntry}

[Install]
WantedBy=timers.target
`;
}
