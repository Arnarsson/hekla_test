import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { PipelineContext, PhaseID, PhaseResult, InferenceMode, Logger } from "./types";

export interface Checkpoint {
  customer: string;
  mode: InferenceMode;
  startedAt: string;
  hardwareFingerprint: string;
  phases: Record<string, PhaseResult>;
}

const LOGS_DIR = "logs";

function checkpointPath(customerName: string): string {
  return path.join(LOGS_DIR, `${customerName}-checkpoint.json`);
}

function completedPath(customerName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(LOGS_DIR, `${customerName}-completed-${ts}.json`);
}

/**
 * Generate a hardware fingerprint from stable machine identifiers.
 * Used to warn if resuming on different hardware.
 */
export function hardwareFingerprint(ctx: PipelineContext): string {
  const data = [
    ctx.hardware.hostname,
    ctx.hardware.os,
    ctx.hardware.arch,
    ctx.hardware.gpuType,
  ].join("|");
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Persist current pipeline state to a checkpoint file.
 */
export function saveCheckpoint(ctx: PipelineContext): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const phases: Record<string, PhaseResult> = {};
  for (const [id, result] of ctx.results) {
    phases[id] = result;
  }

  const checkpoint: Checkpoint = {
    customer: ctx.customer.name,
    mode: ctx.mode,
    startedAt: new Date().toISOString(),
    hardwareFingerprint: hardwareFingerprint(ctx),
    phases,
  };

  fs.writeFileSync(checkpointPath(ctx.customer.name), JSON.stringify(checkpoint, null, 2), "utf8");
}

/**
 * Load a checkpoint for a customer. Returns null if no checkpoint exists.
 */
export function loadCheckpoint(customerName: string): Checkpoint | null {
  const filePath = checkpointPath(customerName);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * Archive the checkpoint on successful completion.
 */
export function clearCheckpoint(customerName: string): void {
  const src = checkpointPath(customerName);
  if (!fs.existsSync(src)) return;

  const dest = completedPath(customerName);
  fs.renameSync(src, dest);
}

/**
 * Restore completed phase results from a checkpoint into the pipeline context.
 * Returns the number of phases restored. Warns if hardware fingerprint changed.
 */
export function restoreFromCheckpoint(
  checkpoint: Checkpoint,
  ctx: PipelineContext,
  logger?: Logger,
): number {
  // Hardware mismatch check
  const currentFp = hardwareFingerprint(ctx);
  if (checkpoint.hardwareFingerprint !== currentFp) {
    logger?.warn(
      "resume",
      `Hardware fingerprint changed since checkpoint (was ${checkpoint.hardwareFingerprint}, now ${currentFp}). ` +
      `Results from previous run may not be valid on different hardware.`,
    );
  }

  // Mode mismatch check
  if (checkpoint.mode !== ctx.mode) {
    logger?.warn(
      "resume",
      `Inference mode changed since checkpoint (was ${checkpoint.mode}, now ${ctx.mode}). ` +
      `Some completed phases may need re-running.`,
    );
  }

  let restored = 0;
  for (const [id, result] of Object.entries(checkpoint.phases)) {
    if (result.status === "completed" || result.status === "skipped") {
      ctx.results.set(id as PhaseID, result);
      restored++;
    }
    // Don't restore failed/running phases — they need re-execution
  }

  return restored;
}
