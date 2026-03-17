import type { PhaseDefinition, PipelineContext, PhaseResult } from "../types";
import { detectHardware, detectDirtyState } from "../hardware";
import { suggestInferenceMode } from "../config";

const PHASE = "00-preflight";

export const phase: PhaseDefinition = {
  id: "00-preflight",
  name: "Preflight",
  description: "Detect hardware, dirty state, and recommend inference mode",
  dependencies: [],

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    ctx.logger.info(PHASE, "Starting hardware detection");
    const hw = await detectHardware();

    ctx.logger.info(PHASE, "Checking for dirty state");
    const dirtyState = await detectDirtyState(hw);

    const modeResult = suggestInferenceMode(hw);

    // Store on context for downstream phases
    (ctx as PipelineContext & { hardware: typeof hw }).hardware = hw;
    (ctx as PipelineContext & { dirtyState: typeof dirtyState }).dirtyState = dirtyState;

    // Disk warning: <20 GB free
    const diskFreeGB = hw.diskFree / 1024;
    if (diskFreeGB < 20) {
      const msg = `Low disk space: ${diskFreeGB.toFixed(1)} GB free (recommend >= 20 GB)`;
      warnings.push(msg);
      ctx.logger.warn(PHASE, msg, { diskFreeGB });
    }

    // RAM warning: <8 GB
    const ramGB = hw.totalRam / 1024;
    if (ramGB < 8) {
      const msg = `Low RAM: ${ramGB.toFixed(1)} GB (recommend >= 8 GB)`;
      warnings.push(msg);
      ctx.logger.warn(PHASE, msg, { ramGB });
    }

    // Dirty state warnings
    const dirtyItems: string[] = [];
    if (dirtyState.oldOllama) dirtyItems.push("existing Ollama install with models");
    if (dirtyState.oldDockerContainers.length > 0)
      dirtyItems.push(`Docker containers: ${dirtyState.oldDockerContainers.join(", ")}`);
    if (dirtyState.utmVMs.length > 0)
      dirtyItems.push(`UTM VMs: ${dirtyState.utmVMs.join(", ")}`);
    if (dirtyState.shadowMindRemnants.length > 0)
      dirtyItems.push(`Shadow Mind remnants: ${dirtyState.shadowMindRemnants.join(", ")}`);
    if (dirtyState.oldConfigs.length > 0)
      dirtyItems.push(`Old configs: ${dirtyState.oldConfigs.join(", ")}`);
    if (dirtyState.staleEnvFiles.length > 0)
      dirtyItems.push(`Stale .env files: ${dirtyState.staleEnvFiles.join(", ")}`);

    if (dirtyItems.length > 0) {
      const msg = `Dirty state detected: ${dirtyItems.length} item(s) found`;
      warnings.push(msg);
      ctx.logger.warn(PHASE, msg, { dirtyItems });
    }

    // Human-readable summary
    ctx.logger.info(PHASE, "--- Hardware Summary ---");
    ctx.logger.info(PHASE, `Host:     ${hw.hostname} (${hw.username})`);
    ctx.logger.info(PHASE, `OS:       ${hw.os} ${hw.arch}`);
    ctx.logger.info(PHASE, `CPU:      ${hw.cpuModel}`);
    ctx.logger.info(PHASE, `RAM:      ${ramGB.toFixed(1)} GB`);
    ctx.logger.info(PHASE, `GPU:      ${hw.gpuType} / ${(hw.gpuVram / 1024).toFixed(1)} GB VRAM`);
    ctx.logger.info(PHASE, `Disk:     ${diskFreeGB.toFixed(1)} GB free`);
    ctx.logger.info(PHASE, `Pkg mgr: ${hw.pkgManager}`);
    ctx.logger.info(PHASE, `Apple Silicon: ${hw.isAppleSilicon}`);
    ctx.logger.info(PHASE, `DGX Spark:     ${hw.isDGXSpark}`);
    ctx.logger.info(PHASE, "--- Mode Recommendation ---");
    ctx.logger.info(PHASE, `Recommended: ${modeResult.recommended}`);
    ctx.logger.info(PHASE, `Reason:      ${modeResult.reason}`);
    for (const alt of modeResult.alternatives) {
      ctx.logger.info(PHASE, `Alternative: ${alt.mode} — ${alt.reason}`);
    }
    if (dirtyItems.length > 0) {
      ctx.logger.info(PHASE, "--- Dirty State Items ---");
      for (const item of dirtyItems) {
        ctx.logger.warn(PHASE, `  * ${item}`);
      }
    }

    return {
      id: "00-preflight",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      warnings,
      output: {
        hardware: {
          hostname: hw.hostname,
          os: hw.os,
          arch: hw.arch,
          cpuModel: hw.cpuModel,
          ramGB: parseFloat(ramGB.toFixed(1)),
          gpuType: hw.gpuType,
          gpuVramGB: parseFloat((hw.gpuVram / 1024).toFixed(1)),
          diskFreeGB: parseFloat(diskFreeGB.toFixed(1)),
          pkgManager: hw.pkgManager,
          isAppleSilicon: hw.isAppleSilicon,
          isDGXSpark: hw.isDGXSpark,
          existingInstalls: hw.existingInstalls,
        },
        dirtyState: {
          items: dirtyItems,
          details: dirtyState,
        },
        modeRecommendation: modeResult,
      },
    };
  },
};
