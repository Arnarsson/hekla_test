import type { PhaseDefinition, PhaseResult } from "../types";
import { exec } from "../exec";

export const phase: PhaseDefinition = {
  id: "08-telegram",
  name: "Telegram Bot",
  description: "Configures the Telegram bot for the customer",
  dependencies: ["04-environment"],

  async run(ctx): Promise<PhaseResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    const output: { configured: boolean; botUsername: string | null; webhookSet: boolean } = {
      configured: false,
      botUsername: null,
      webhookSet: false,
    };

    const token = ctx.customerEnv["BOT_TOKEN"];

    if (!token) {
      const msg = "BOT_TOKEN not set in customer environment — skipping Telegram setup";
      ctx.logger.warn("08-telegram", msg);
      warnings.push(msg);

      return {
        id: "08-telegram",
        status: "skipped",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        warnings,
      };
    }

    // Verify bot token via getMe
    ctx.logger.info("08-telegram", "Verifying bot token via Telegram API");
    const getMeResult = await exec(
      ctx.target,
      "curl",
      ["-sf", `https://api.telegram.org/bot${token}/getMe`],
      { timeout: 15_000, phase: "08-telegram", logger: ctx.logger, retries: 3 }
    );

    if (!getMeResult.ok) {
      const msg = `Telegram getMe failed (exit ${getMeResult.exitCode}): ${getMeResult.stderr.slice(0, 200)}`;
      ctx.logger.error("08-telegram", msg);
      return {
        id: "08-telegram",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        error: msg,
        warnings,
      };
    }

    let getMe: { ok: boolean; result?: { username?: string } };
    try {
      getMe = JSON.parse(getMeResult.stdout);
    } catch {
      const msg = "Failed to parse Telegram getMe response";
      ctx.logger.error("08-telegram", msg, { raw: getMeResult.stdout.slice(0, 200) });
      return {
        id: "08-telegram",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        error: msg,
        warnings,
      };
    }

    if (!getMe.ok) {
      const msg = "Telegram API returned ok=false for getMe";
      ctx.logger.error("08-telegram", msg);
      return {
        id: "08-telegram",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        error: msg,
        warnings,
      };
    }

    output.configured = true;
    output.botUsername = getMe.result?.username ?? null;
    ctx.logger.info("08-telegram", `Bot verified: @${output.botUsername}`);

    // Set webhook if a gateway URL is available
    const gatewayUrl = ctx.customerEnv["GATEWAY_URL"];
    if (gatewayUrl) {
      const webhookUrl = `${gatewayUrl.replace(/\/$/, "")}/webhook/telegram`;
      ctx.logger.info("08-telegram", `Setting webhook to ${webhookUrl}`);

      if (ctx.dryRun) {
        ctx.logger.info("08-telegram", "[dry-run] Would set webhook", { webhookUrl });
        warnings.push(`[dry-run] Webhook would be set to ${webhookUrl}`);
      } else {
        const webhookResult = await exec(
          ctx.target,
          "curl",
          ["-sf", `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`],
          { timeout: 15_000, phase: "08-telegram", logger: ctx.logger, retries: 3 }
        );

        if (webhookResult.ok) {
          output.webhookSet = true;
          ctx.logger.info("08-telegram", "Webhook set successfully");
        } else {
          const msg = `Failed to set webhook: ${webhookResult.stderr.slice(0, 200)}`;
          ctx.logger.warn("08-telegram", msg);
          warnings.push(msg);
        }
      }
    } else {
      ctx.logger.info("08-telegram", "GATEWAY_URL not set — skipping webhook registration");
      warnings.push("GATEWAY_URL not set; webhook not registered");
    }

    return {
      id: "08-telegram",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      output,
      warnings,
    };
  },
};
