import type { PhaseID, PhaseDefinition, PhaseResult, PipelineContext } from "./types";
import { saveCheckpoint } from "./state";

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

export function validateGraph(phases: PhaseDefinition[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const ids = new Set(phases.map((p) => p.id));

  // Check for unknown dependency references
  for (const phase of phases) {
    for (const dep of phase.dependencies) {
      if (!ids.has(dep)) {
        errors.push(`Phase "${phase.id}" depends on unknown phase "${dep}"`);
      }
    }
  }

  // Topological sort to detect cycles (Kahn's algorithm)
  const inDegree = new Map<PhaseID, number>();
  const adj = new Map<PhaseID, PhaseID[]>(); // dep -> dependents

  for (const phase of phases) {
    if (!inDegree.has(phase.id)) inDegree.set(phase.id, 0);
    if (!adj.has(phase.id)) adj.set(phase.id, []);
    for (const dep of phase.dependencies) {
      inDegree.set(phase.id, (inDegree.get(phase.id) ?? 0) + 1);
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(phase.id);
    }
  }

  const queue: PhaseID[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited < phases.length) {
    errors.push("Cycle detected in phase dependency graph");
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Ready-phase selection
// ---------------------------------------------------------------------------

export function getReadyPhases(
  phases: PhaseDefinition[],
  completed: Set<PhaseID>,
  running: Set<PhaseID>,
  skipped: Set<PhaseID>
): PhaseDefinition[] {
  const done = new Set([...completed, ...skipped]);
  return phases.filter(
    (p) =>
      !completed.has(p.id) &&
      !running.has(p.id) &&
      !skipped.has(p.id) &&
      p.dependencies.every((dep) => done.has(dep))
  );
}

// ---------------------------------------------------------------------------
// Topological execution order
// ---------------------------------------------------------------------------

export function getExecutionOrder(phases: PhaseDefinition[]): PhaseID[] {
  const ids = new Set(phases.map((p) => p.id));
  const inDegree = new Map<PhaseID, number>();
  const adj = new Map<PhaseID, PhaseID[]>();

  for (const phase of phases) {
    if (!inDegree.has(phase.id)) inDegree.set(phase.id, 0);
    if (!adj.has(phase.id)) adj.set(phase.id, []);
    for (const dep of phase.dependencies) {
      if (!ids.has(dep)) continue;
      inDegree.set(phase.id, (inDegree.get(phase.id) ?? 0) + 1);
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(phase.id);
    }
  }

  const queue: PhaseID[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  // Stable sort so phases at the same level appear in definition order
  queue.sort();

  const order: PhaseID[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    const neighbors = (adj.get(node) ?? []).slice().sort();
    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export async function runPipeline(
  phases: PhaseDefinition[],
  ctx: PipelineContext
): Promise<Map<PhaseID, PhaseResult>> {
  const { valid, errors } = validateGraph(phases);
  if (!valid) {
    throw new Error(`Invalid phase graph:\n${errors.join("\n")}`);
  }

  if (ctx.dryRun) {
    const plan = generatePlan(phases, ctx);
    ctx.logger.info("pipeline", plan);
    return ctx.results;
  }

  const completed = new Set<PhaseID>();
  const running = new Set<PhaseID>();
  const skipped = new Set<PhaseID>();
  let failed = false;

  if (ctx.sequential) {
    // Run one at a time in topological order
    const order = getExecutionOrder(phases);
    const phaseMap = new Map(phases.map((p) => [p.id, p]));

    for (const id of order) {
      if (failed) break;
      const phase = phaseMap.get(id)!;

      if (phase.skipWhen?.(ctx)) {
        ctx.logger.info("pipeline", `Skipping phase ${id} (skipWhen returned true)`);
        skipped.add(id);
        const skippedResult: PhaseResult = {
          id,
          status: "skipped",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          output: {},
          warnings: [],
        };
        ctx.results.set(id, skippedResult);
        continue;
      }

      ctx.logger.info("pipeline", `Starting phase ${id}`);
      running.add(id);

      const result = await phase.run(ctx);
      ctx.results.set(id, result);
      saveCheckpoint(ctx);
      running.delete(id);

      if (result.status === "failed") {
        failed = true;
        ctx.logger.error("pipeline", `Phase ${id} failed: ${result.error ?? "unknown error"}`);
      } else {
        completed.add(id);
        ctx.logger.info("pipeline", `Phase ${id} completed`);
      }
    }
  } else {
    // Parallel execution
    const phaseMap = new Map(phases.map((p) => [p.id, p]));
    // Track in-flight promises so we never call phase.run() twice
    const inFlight = new Map<PhaseID, Promise<void>>();

    while (true) {
      const ready = getReadyPhases(phases, completed, running, skipped);

      // Skip phases flagged by skipWhen
      for (const phase of ready) {
        if (phase.skipWhen?.(ctx)) {
          ctx.logger.info("pipeline", `Skipping phase ${phase.id} (skipWhen returned true)`);
          skipped.add(phase.id);
          ctx.results.set(phase.id, {
            id: phase.id,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            output: {},
            warnings: [],
          });
        }
      }

      // Launch only NEW phases (not already running)
      if (!failed) {
        for (const phase of ready) {
          if (skipped.has(phase.id) || running.has(phase.id)) continue;
          running.add(phase.id);
          ctx.logger.info("pipeline", `Starting phase ${phase.id}`);

          const promise = phase.run(ctx).then((result) => {
            ctx.results.set(phase.id, result);
            saveCheckpoint(ctx);
            running.delete(phase.id);
            inFlight.delete(phase.id);

            if (result.status === "failed") {
              failed = true;
              ctx.logger.error("pipeline", `Phase ${phase.id} failed: ${result.error ?? "unknown error"}`);
            } else {
              completed.add(phase.id);
              ctx.logger.info("pipeline", `Phase ${phase.id} completed`);
            }
          });
          inFlight.set(phase.id, promise);
        }
      }

      // Nothing running and nothing new to start — done
      if (inFlight.size === 0) break;

      // Wait for any one phase to finish, then re-evaluate
      await Promise.race(inFlight.values());
    }

    // Report phases that were never executed due to earlier failure
    if (failed) {
      const notExecuted = phases.filter(
        (p) => !completed.has(p.id) && !running.has(p.id) && !skipped.has(p.id) && !ctx.results.has(p.id),
      );
      if (notExecuted.length > 0) {
        const ids = notExecuted.map((p) => p.id);
        ctx.logger.warn("pipeline", `Phases not executed due to earlier failure: ${ids.join(", ")}`);
      }
    }
  }

  return ctx.results;
}

// ---------------------------------------------------------------------------
// Dry-run plan generator
// ---------------------------------------------------------------------------

export function generatePlan(
  phases: PhaseDefinition[],
  ctx: PipelineContext
): string {
  const { valid, errors } = validateGraph(phases);
  const lines: string[] = [];

  lines.push("=== HEKLA Pipeline Execution Plan (dry-run) ===");
  lines.push(`Sequential: ${ctx.sequential}`);
  lines.push(`Dry-run:    true`);
  lines.push("");

  if (!valid) {
    lines.push("ERROR: Invalid dependency graph:");
    for (const e of errors) lines.push(`  - ${e}`);
    return lines.join("\n");
  }

  const order = getExecutionOrder(phases);
  const phaseMap = new Map(phases.map((p) => [p.id, p]));

  // Group phases into parallel waves
  const waves: PhaseID[][] = [];
  const placed = new Set<PhaseID>();

  for (const id of order) {
    const phase = phaseMap.get(id)!;
    const wave = waves.findIndex((w) =>
      phase.dependencies.every((dep) => w.includes(dep) || placed.has(dep))
    );

    if (ctx.sequential) {
      // Each phase is its own wave in sequential mode
      waves.push([id]);
      placed.add(id);
    } else {
      // Find the earliest wave where all deps are in earlier waves
      let placed_in_wave = false;
      for (let i = 0; i < waves.length; i++) {
        const waveIds = waves[i];
        const allDepsPlaced = phase.dependencies.every((dep) =>
          waves.slice(0, i).some((w) => w.includes(dep))
        );
        if (allDepsPlaced && !waveIds.some((w) => phase.dependencies.includes(w))) {
          // Check none of this wave's deps are in the same wave
          const noDepsInSameWave = !phase.dependencies.some((dep) => waveIds.includes(dep));
          if (noDepsInSameWave) {
            waves[i].push(id);
            placed.add(id);
            placed_in_wave = true;
            break;
          }
        }
      }
      if (!placed_in_wave) {
        waves.push([id]);
        placed.add(id);
      }
    }
  }

  lines.push("Execution waves:");
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    const parallel = wave.length > 1 ? " [parallel]" : "";
    lines.push(`  Wave ${i + 1}${parallel}:`);
    for (const id of wave) {
      const phase = phaseMap.get(id)!;
      const willSkip = phase.skipWhen?.(ctx) ?? false;
      const skipNote = willSkip ? " [SKIP]" : "";
      const deps =
        phase.dependencies.length > 0
          ? ` (deps: ${phase.dependencies.join(", ")})`
          : "";
      lines.push(`    ${id} — ${phase.name}${skipNote}${deps}`);
      lines.push(`      ${phase.description}`);
    }
  }

  lines.push("");
  lines.push(`Total phases: ${phases.length}`);
  const skippedCount = phases.filter((p) => p.skipWhen?.(ctx)).length;
  if (skippedCount > 0) {
    lines.push(`Phases that will be skipped: ${skippedCount}`);
  }

  return lines.join("\n");
}
