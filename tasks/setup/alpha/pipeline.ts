#!/usr/bin/env bun

import { parseArgs } from "util";
import { allPhases } from "./phases";
import { loadCustomer } from "./customer-parser";
import { detectHardware, detectDirtyState } from "./hardware";
import { createLogger } from "./logger";
import { runPipeline, validateGraph, generatePlan } from "./parallel";
import { loadCheckpoint, clearCheckpoint, restoreFromCheckpoint } from "./state";
import type { CLIOptions, PipelineContext, InferenceMode, ExecutionTarget, PhaseID } from "./types";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: rawValues } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    customer:     { type: "string" },
    mode:         { type: "string" },
    target:       { type: "string" },
    "dry-run":    { type: "boolean", default: false },
    "from-phase": { type: "string" },
    "only-phase": { type: "string" },
    resume:       { type: "boolean", default: false },
    sequential:   { type: "boolean", default: false },
    verbose:      { type: "boolean", default: false },
    help:         { type: "boolean", default: false },
  },
  strict: false, // allow unknown flags
});

// Narrow string-typed values (parseArgs returns string | boolean when strict:false)
const values = {
  customer:     typeof rawValues.customer     === "string" ? rawValues.customer     : undefined,
  mode:         typeof rawValues.mode         === "string" ? rawValues.mode         : undefined,
  target:       typeof rawValues.target       === "string" ? rawValues.target       : undefined,
  "dry-run":    !!rawValues["dry-run"],
  "from-phase": typeof rawValues["from-phase"] === "string" ? rawValues["from-phase"] : undefined,
  "only-phase": typeof rawValues["only-phase"] === "string" ? rawValues["only-phase"] : undefined,
  resume:       !!rawValues.resume,
  sequential:   !!rawValues.sequential,
  verbose:      !!rawValues.verbose,
  help:         !!rawValues.help,
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
HEKLA Setup Pipeline

Usage:
  bun run pipeline.ts --customer <id> --mode <mode> [options]

Options:
  --customer <id>      Customer directory name (e.g., 00-christopher)
  --mode <mode>        Inference mode: local | cloud | hybrid
  --target <url>       Remote target: ssh://user@host:port (default: local)
  --dry-run            Show plan without executing
  --from-phase <id>    Resume from phase (e.g., 05)
  --only-phase <id>    Run single phase (e.g., 03)
  --resume             Resume from last checkpoint
  --sequential         Disable parallel execution
  --verbose            Debug output
  --help               Show this help

Examples:
  bun run pipeline.ts --customer 00-christopher --mode hybrid --dry-run
  bun run pipeline.ts --customer 00-christopher --mode local --only-phase 00
  bun run pipeline.ts --customer 00-christopher --mode cloud --target ssh://hekla@100.1.2.3
  bun run pipeline.ts --customer 00-christopher --mode hybrid --resume
`);
}

if (values.help || !values.customer) {
  printUsage();
  process.exit(values.help ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

function parseTarget(target?: string): ExecutionTarget {
  if (!target) return { type: "local" };

  const match = target.match(/^ssh:\/\/([^@]+)@([^:]+)(?::(\d+))?$/);
  if (!match) {
    console.error(`Invalid target format: ${target}. Expected: ssh://user@host:port`);
    process.exit(1);
  }

  return {
    type: "ssh",
    user: match[1]!,
    host: match[2]!,
    port: parseInt(match[3] ?? "22", 10),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = (values.mode ?? "hybrid") as InferenceMode;
  if (!["local", "cloud", "hybrid"].includes(mode)) {
    console.error(`Invalid mode: ${mode}. Must be: local | cloud | hybrid`);
    process.exit(1);
  }

  const customerName = values.customer!;
  const customerDir = `${import.meta.dir}/customers/${customerName}`;
  const logger = createLogger(customerName, !!values.verbose);

  logger.info("pipeline", `Starting HEKLA setup for ${customerName}`, { mode });

  // Load customer profile and env
  const { profile, env } = await loadCustomer(customerDir);
  logger.info("pipeline", `Loaded customer: ${profile.name}`);

  // Detect hardware and dirty state
  const hardware = await detectHardware();
  const dirtyState = await detectDirtyState(hardware);

  // Build pipeline context
  const ctx: PipelineContext = {
    customer: profile,
    customerEnv: env,
    customerDir,
    hardware,
    dirtyState,
    mode,
    target: parseTarget(values.target),
    dryRun: !!values["dry-run"],
    verbose: !!values.verbose,
    sequential: !!values.sequential,
    results: new Map(),
    logger,
  };

  // ---------------------------------------------------------------------------
  // Resume from checkpoint
  // ---------------------------------------------------------------------------

  if (values.resume) {
    const checkpoint = loadCheckpoint(profile.name);
    if (checkpoint) {
      const restored = restoreFromCheckpoint(checkpoint, ctx, logger);
      logger.info("pipeline", `Resumed from checkpoint: ${restored} phases restored`);
    } else {
      logger.warn("pipeline", "No checkpoint found — starting fresh");
    }
  }

  // ---------------------------------------------------------------------------
  // Phase filtering
  // ---------------------------------------------------------------------------

  let phases = [...allPhases];

  if (values["only-phase"]) {
    const phaseNum = values["only-phase"].padStart(2, "0");
    const directMatches = phases.filter((p) => p.id.startsWith(phaseNum));
    if (directMatches.length === 0) {
      console.error(`Phase not found: ${values["only-phase"]}`);
      process.exit(1);
    }

    // Include all transitive dependencies so the graph is valid
    const needed = new Set<string>();
    function addDeps(id: string): void {
      const phase = allPhases.find((p) => p.id === id);
      if (!phase) return;
      needed.add(id);
      for (const dep of phase.dependencies) addDeps(dep);
    }
    for (const p of directMatches) addDeps(p.id);
    phases = allPhases.filter((p) => needed.has(p.id));
  }

  if (values["from-phase"]) {
    const phaseNum = values["from-phase"].padStart(2, "0");
    const idx = allPhases.findIndex((p) => p.id.startsWith(phaseNum));
    if (idx === -1) {
      console.error(`Phase not found: ${values["from-phase"]}`);
      process.exit(1);
    }
    // Mark earlier phases as already completed so their dependents can run
    for (let i = 0; i < idx; i++) {
      const p = allPhases[i]!;
      ctx.results.set(p.id as PhaseID, {
        id: p.id as PhaseID,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: {},
        warnings: [],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Graph validation
  // ---------------------------------------------------------------------------

  const validation = validateGraph(phases);
  if (!validation.valid) {
    console.error("Phase dependency graph errors:", validation.errors);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Dry-run
  // ---------------------------------------------------------------------------

  if (ctx.dryRun) {
    console.log(generatePlan(phases, ctx));
    logger.info("pipeline", "Dry run complete");
    return;
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  const results = await runPipeline(phases, ctx);

  const passed  = [...results.values()].filter((r) => r.status === "completed").length;
  const failed  = [...results.values()].filter((r) => r.status === "failed").length;
  const skipped = [...results.values()].filter((r) => r.status === "skipped").length;

  logger.info("pipeline", `Pipeline complete: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed === 0) {
    clearCheckpoint(profile.name);
    logger.info("pipeline", "Checkpoint cleared — pipeline completed successfully");
  }

  if (failed > 0) {
    const failedPhases = [...results.entries()]
      .filter(([, r]) => r.status === "failed")
      .map(([id, r]) => `${id}: ${r.error ?? "unknown error"}`);
    logger.error("pipeline", "Failed phases:", { failedPhases });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Pipeline error:", err);
  process.exit(1);
});
