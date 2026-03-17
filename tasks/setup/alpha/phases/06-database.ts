import type { PhaseDefinition, PhaseResult, PipelineContext } from "../types";
import { exec } from "../exec";

const PHASE = "06-database";

// Tables expected after init.sql runs via the Docker entrypoint
const EXPECTED_TABLES = ["users", "sessions", "messages", "tasks", "memories"];

export const phase: PhaseDefinition = {
  id: "06-database",
  name: "Database",
  description: "Verify PostgreSQL schema and seed customer data",
  dependencies: ["05-docker-stack"],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    ctx.logger.info(PHASE, "Verifying PostgreSQL schema");

    // List tables via psql \dt
    const dtResult = await exec(
      ctx.target,
      "docker",
      ["compose", "exec", "postgres", "psql", "-U", "hekla", "-c", "\\dt"],
      { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 30_000 },
    );

    if (!dtResult.ok) {
      const msg = `Failed to query PostgreSQL tables: ${dtResult.stderr.slice(0, 300)}`;
      ctx.logger.error(PHASE, msg);
      return {
        id: "06-database",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { tablesFound: [], seeded: false },
        error: msg,
        warnings,
      };
    }

    // Parse table names from \dt output
    // Format: " public | tablename | table | owner"
    const tablesFound: string[] = [];
    for (const line of dtResult.stdout.split("\n")) {
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length >= 2 && parts[0] === "public" && parts[1]) {
        tablesFound.push(parts[1]);
      }
    }

    ctx.logger.info(PHASE, "Tables found", { tablesFound });

    // Validate expected tables exist
    const missingTables = EXPECTED_TABLES.filter((t) => !tablesFound.includes(t));
    if (missingTables.length > 0) {
      const msg = `Schema incomplete — missing tables: ${missingTables.join(", ")}`;
      ctx.logger.error(PHASE, msg);
      return {
        id: "06-database",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: { tablesFound, seeded: false },
        error: msg,
        warnings,
      };
    }

    ctx.logger.info(PHASE, "Schema verified — all expected tables present");

    // Seed customer data if needed
    let seeded = false;

    // Check if users table is empty (seeding only needed on first run)
    const countResult = await exec(
      ctx.target,
      "docker",
      ["compose", "exec", "postgres", "psql", "-U", "hekla", "-t", "-c", "SELECT COUNT(*) FROM users;"],
      { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 15_000 },
    );

    const rowCount = parseInt(countResult.stdout.trim(), 10);
    const isEmpty = countResult.ok && rowCount === 0;

    if (isEmpty) {
      ctx.logger.info(PHASE, "Users table is empty — seeding customer data");

      if (ctx.dryRun) {
        ctx.logger.info(PHASE, "[dry-run] Would seed customer data");
        seeded = false;
      } else {
        // Validate inputs to prevent SQL injection — reject dangerous characters
        const SAFE_PATTERN = /^[\p{L}\p{N}\s.\-]+$/u;
        for (const [field, value] of [
          ["name", ctx.customer.name],
          ["language", ctx.customer.language],
          ["timezone", ctx.customer.timezone],
        ] as const) {
          if (!SAFE_PATTERN.test(value)) {
            const msg = `Invalid characters in customer ${field}: "${value}" — only letters, numbers, spaces, dots, and dashes allowed`;
            ctx.logger.error(PHASE, msg);
            return {
              id: "06-database",
              status: "failed",
              startedAt,
              completedAt: new Date().toISOString(),
              output: { tablesFound, seeded: false },
              error: msg,
              warnings,
            };
          }
        }

        const seedSQL = [
          "INSERT INTO users (name, language, timezone, created_at)",
          `VALUES ('${ctx.customer.name.replace(/'/g, "''")}',`,
          `'${ctx.customer.language.replace(/'/g, "''")}',`,
          `'${ctx.customer.timezone.replace(/'/g, "''")}', NOW())`,
          "ON CONFLICT DO NOTHING;",
        ].join(" ");

        const seedResult = await exec(
          ctx.target,
          "docker",
          ["compose", "exec", "postgres", "psql", "-U", "hekla", "-c", seedSQL],
          { cwd: ctx.customerDir, logger: ctx.logger, phase: PHASE, timeout: 15_000 },
        );

        if (seedResult.ok) {
          ctx.logger.info(PHASE, "Customer data seeded");
          seeded = true;
        } else {
          const msg = `Seeding failed: ${seedResult.stderr.slice(0, 200)}`;
          ctx.logger.warn(PHASE, msg);
          warnings.push(msg);
        }
      }
    } else {
      ctx.logger.info(PHASE, "Users table already has data — skipping seed", { rowCount });
    }

    return {
      id: "06-database",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      output: { tablesFound, seeded },
      warnings,
    };
  },
};
