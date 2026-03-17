import type { PhaseDefinition, PhaseResult } from "../types";
import { exec } from "../exec";

export const phase: PhaseDefinition = {
  id: "09-email",
  name: "Email Integration",
  description: "Sets up email accounts and OAuth flows for the customer",
  dependencies: ["04-environment", "06-database"],

  async run(ctx): Promise<PhaseResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    const accounts: { email: string; status: string }[] = [];
    const oauthPending: string[] = [];

    const emailAccounts = ctx.customer.emails;

    if (!emailAccounts || emailAccounts.length === 0) {
      ctx.logger.info("09-email", "No email accounts in customer profile — skipping");
      return {
        id: "09-email",
        status: "skipped",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { accounts, oauthPending },
        warnings,
      };
    }

    for (const account of emailAccounts) {
      ctx.logger.info("09-email", `Processing ${account.email} (${account.provider})`);

      if (account.provider === "gmail") {
        // Gmail requires OAuth — we cannot complete this automatically
        const authUrl =
          ctx.customerEnv[`GMAIL_AUTH_URL_${account.email.toUpperCase().replace(/[@.]/g, "_")}`] ??
          ctx.customerEnv["GMAIL_AUTH_URL"] ??
          null;

        if (authUrl) {
          if (ctx.target.type === "ssh") {
            ctx.logger.info(
              "09-email",
              `[OPERATOR ACTION REQUIRED] Open this URL in a browser to complete Gmail OAuth for ${account.email}:`,
              { url: authUrl }
            );
            console.log(`\n  Gmail OAuth URL for ${account.email}:\n  ${authUrl}\n`);
          } else {
            // Local target — attempt to open browser
            ctx.logger.info("09-email", `Opening browser for Gmail OAuth: ${account.email}`);
            if (!ctx.dryRun) {
              const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
              await exec(ctx.target, openCmd, [authUrl], {
                timeout: 10_000,
                phase: "09-email",
                logger: ctx.logger,
              });
            } else {
              ctx.logger.info("09-email", `[dry-run] Would open: ${authUrl}`);
            }
          }

          oauthPending.push(account.email);
          accounts.push({ email: account.email, status: "oauth-pending" });
        } else {
          const msg = `No auth URL available for ${account.email} — operator must configure Gmail OAuth manually`;
          ctx.logger.warn("09-email", msg);
          warnings.push(msg);
          accounts.push({ email: account.email, status: "no-auth-url" });
        }
      } else if (account.provider === "m365" || account.provider === "microsoft") {
        // M365 uses email forwarding setup
        ctx.logger.info(
          "09-email",
          `[OPERATOR ACTION REQUIRED] Configure forwarding for M365 account ${account.email}:`,
          {
            instructions: [
              "1. Sign in to Outlook / Microsoft 365 admin portal",
              "2. Go to Mail > Forwarding",
              `3. Forward all mail to the HEKLA ingest address from customer env (HEKLA_INGEST_EMAIL)`,
              "4. Confirm forwarding is active before proceeding",
            ].join("\n"),
          }
        );
        console.log(
          `\n  [M365 Forwarding] ${account.email}:\n` +
          `  1. Sign in to Microsoft 365 admin portal\n` +
          `  2. Navigate to Mail > Forwarding\n` +
          `  3. Forward all mail to: ${ctx.customerEnv["HEKLA_INGEST_EMAIL"] ?? "<HEKLA_INGEST_EMAIL>"}\n` +
          `  4. Confirm forwarding before continuing\n`
        );
        accounts.push({ email: account.email, status: "forwarding-instructions-shown" });
        warnings.push(`M365 forwarding for ${account.email} requires manual operator setup`);
      } else {
        const msg = `Unknown email provider "${account.provider}" for ${account.email} — skipping`;
        ctx.logger.warn("09-email", msg);
        warnings.push(msg);
        accounts.push({ email: account.email, status: "unsupported-provider" });
      }
    }

    const allFailed = accounts.every(
      (a) => a.status === "no-auth-url" || a.status === "unsupported-provider"
    );

    return {
      id: "09-email",
      status: allFailed && accounts.length > 0 ? "failed" : "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { accounts, oauthPending },
      warnings,
    };
  },
};
